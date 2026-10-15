// Copyright 2026 faxcorp, Apache-2.0
#include "Modules/ModuleManager.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Components/SceneComponent.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/Actor.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "InterchangeGenericAssetsPipeline.h"
#include "InterchangeGenericAssetsPipelineSharedSettings.h"
#include "InterchangeGenericMaterialPipeline.h"
#include "InterchangeGenericMeshPipeline.h"
#include "InterchangeManager.h"
#include "InterchangeSourceData.h"
#include "Landscape.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "ObjectTools.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "ToolMenus.h"
#include "TopoTopoStream.h"
#include "TopoTopoAssetFolderPipeline.h"
#include "TopoTopoLandscapeImport.h"
#include "TopoTopoTileInstances.h"
#include "UObject/StrongObjectPtr.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SWindow.h"
#include "Widgets/Text/STextBlock.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "Misc/ScopeExit.h"
#endif

#define LOCTEXT_NAMESPACE "TopoTopoPCGEditor"
DEFINE_LOG_CATEGORY_STATIC(LogTopoTopoImport, Log, All);

namespace TopoTopoImport
{
struct FOptions
{
    FString Directory;
    FString Destination = TEXT("/Game/TopoTopo/PluginDemo");
    bool bLandscape = false;
    bool bLayers = true;
    bool bMaterial = true;
    bool bExpandedObjects = true;
};

static bool ReadJSON(const FString& File, TSharedPtr<FJsonObject>& Out, FString& Error)
{
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *File) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Out) || !Out)
    {
        Error = FString::Printf(TEXT("Cannot read JSON object: %s"), *File);
        return false;
    }
    return true;
}

static bool BundleFile(const FString& Directory, const FString& Relative, FString& Out, FString& Error)
{
    Out = FPaths::ConvertRelativePathToFull(Directory, Relative);
    FPaths::NormalizeFilename(Out);
    FPaths::CollapseRelativeDirectories(Out);
    if (!FPaths::IsRelative(Relative) || !FPaths::IsUnderDirectory(Out, Directory) || !FPaths::FileExists(Out))
    {
        Error = FString::Printf(TEXT("Missing file or path outside bundle: %s"), *Relative);
        return false;
    }
    return true;
}

bool ImportGLB(const FString& File, const FString& Folder, const FString& PrototypeName,
    TArray<UStaticMesh*>& OutMeshes, FString& Error)
{
    UInterchangeGenericAssetsPipeline* Template = LoadObject<UInterchangeGenericAssetsPipeline>(nullptr,
        TEXT("/Interchange/Pipelines/DefaultGLTFAssetsPipeline.DefaultGLTFAssetsPipeline"));
    if (!Template)
    {
        Error = TEXT("Interchange's DefaultGLTFAssetsPipeline is unavailable. Enable Interchange Framework and restart.");
        return false;
    }
    TStrongObjectPtr<UInterchangeGenericAssetsPipeline> Pipeline(DuplicateObject(Template, GetTransientPackage()));
    Pipeline->bUseSourceNameForAsset = !PrototypeName.IsEmpty();
    Pipeline->AssetName = PrototypeName;
    Pipeline->bSceneNameSubFolder = false;
    Pipeline->bAssetTypeSubFolders = false;
    Pipeline->CommonMeshesProperties->bBakeMeshes = true;
    Pipeline->MeshPipeline->bImportStaticMeshes = true;
    Pipeline->MeshPipeline->CombineStaticMeshesBehavior = EInterchangeCombineStaticMeshesBehavior::DoNotCombine;
    Pipeline->MaterialPipeline->bImportMaterials = true;
    FImportAssetParameters Parameters;
    Parameters.bIsAutomated = true;
    Parameters.bReplaceExisting = false;
    Parameters.OverridePipelines.Add(FSoftObjectPath(Pipeline.Get()));
    // The second native glTF pipeline maps glTF materials to the engine's material templates.
    Parameters.OverridePipelines.Add(FSoftObjectPath(TEXT("/Interchange/Pipelines/DefaultGLTFPipeline.DefaultGLTFPipeline")));
    // Last: materials and textures into sub-folders, so none can take a prototype mesh's name.
    TStrongObjectPtr<UTopoTopoAssetFolderPipeline> Folders(NewObject<UTopoTopoAssetFolderPipeline>(GetTransientPackage()));
    Parameters.OverridePipelines.Add(FSoftObjectPath(Folders.Get()));
    TStrongObjectPtr<UInterchangeSourceData> Source(UInterchangeManager::CreateSourceData(File));
    TArray<UObject*> Imported;
    if (!UInterchangeManager::GetInterchangeManager().ImportAsset(Folder, Source.Get(), Parameters, Imported))
    {
        Error = TEXT("Interchange import failed: ") + File + TEXT(". See the Interchange log; any completed assets remain unsaved.");
        return false;
    }
    for (UObject* Object : Imported)
    {
        if (UStaticMesh* Mesh = Cast<UStaticMesh>(Object)) { OutMeshes.Add(Mesh); }
    }
    if (OutMeshes.IsEmpty())
    {
        Error = TEXT("Interchange produced no Static Mesh assets for ") + File;
        return false;
    }
    return true;
}

static UHierarchicalInstancedStaticMeshComponent* AddInstances(AActor* Actor, UStaticMesh* Mesh, const FString& Name,
    const TArray<FTransform>& Transforms)
{
    UHierarchicalInstancedStaticMeshComponent* Component = NewObject<UHierarchicalInstancedStaticMeshComponent>(Actor,
        MakeUniqueObjectName(Actor, UHierarchicalInstancedStaticMeshComponent::StaticClass(), FName(*ObjectTools::SanitizeObjectName(Name))), RF_Transactional);
    Actor->AddInstanceComponent(Component);
    Component->SetupAttachment(Actor->GetRootComponent());
    Component->SetStaticMesh(Mesh);
    Component->SetMobility(EComponentMobility::Static);
    Component->RegisterComponent();
    Component->AddInstances(Transforms, false, true);
    return Component;
}

static bool Run(FOptions Options, FString& Message)
{
    if (!GEditor || GEditor->PlayWorld)
    {
        Message = TEXT("Import requires an editor level outside Play/Simulate mode.");
        return false;
    }
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World) { Message = TEXT("Open an editor level before importing."); return false; }
    Options.Directory = TopoTopoStream::ResolveFilePath(Options.Directory);
    FPaths::NormalizeDirectoryName(Options.Directory);
    while (Options.Destination.EndsWith(TEXT("/"))) { Options.Destination.LeftChopInline(1); }
    if (!FPaths::DirectoryExists(Options.Directory) || !Options.Destination.StartsWith(TEXT("/Game/TopoTopo/")) ||
        !FPackageName::IsValidLongPackageName(Options.Destination))
    {
        Message = TEXT("Choose an existing bundle directory and a destination below /Game/TopoTopo/<set>.");
        return false;
    }
    FAssetRegistryModule& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
    TArray<FAssetData> ExistingAssets;
    Registry.Get().GetAssetsByPath(FName(*Options.Destination), ExistingAssets, true);
    if (!ExistingAssets.IsEmpty())
    {
        Message = TEXT("Destination contains assets. Choose an empty set folder; this action does not overwrite or delete previous imports.");
        return false;
    }
    FTopoTopoStreamOptions StreamOptions;
    StreamOptions.MeshFolder = Options.Destination / TEXT("Meshes");
    bool bTiledBundle = false;
    bool bHasInstances = true;
    const FString ManifestPath = Options.Directory / TEXT("landscape.json");
    if (FPaths::FileExists(ManifestPath))
    {
        TSharedPtr<FJsonObject> Manifest;
        if (!ReadJSON(ManifestPath, Manifest, Message)) { return false; }
        bTiledBundle = Manifest->HasField(TEXT("tiles"));
        bHasInstances = !Manifest->HasTypedField<EJson::Null>(TEXT("instances"));
    }
    FTopoTopoStream Stream;
    if (bHasInstances && !TopoTopoStream::LoadFile(Options.Directory / TEXT("instances.csv"), StreamOptions, Stream, Message)) { return false; }
    for (const FString& Warning : Stream.Warnings) { UE_LOG(LogTopoTopoImport, Warning, TEXT("%s"), *Warning); }
    TMap<FString, TArray<FTransform>> Transforms;
    for (const FTopoTopoStreamRow& Row : Stream.Rows)
    {
        const FTopoTopoAttributeValue* Mesh = Row.Attributes.Find(TEXT("Mesh"));
        if (!Mesh || Mesh->StringValue.IsEmpty()) { Message = TEXT("Every instance row requires a Mesh name."); return false; }
        Transforms.FindOrAdd(Mesh->StringValue).Add(Row.Transform);
    }
    TMap<FString, FString> PrototypeFiles;
    const FString Sidecar = Options.Directory / TEXT("instances.meshes.json");
    if (FPaths::FileExists(Sidecar))
    {
        TSharedPtr<FJsonObject> Root;
        if (!ReadJSON(Sidecar, Root, Message)) { return false; }
        const TArray<TSharedPtr<FJsonValue>>* Meshes = nullptr;
        if (!Root->TryGetArrayField(TEXT("meshes"), Meshes)) { Message = TEXT("Sidecar has no meshes array."); return false; }
        for (const TSharedPtr<FJsonValue>& Value : *Meshes)
        {
            const TSharedPtr<FJsonObject>* Mesh = nullptr;
            FString Name, Relative, File;
            if (!Value->TryGetObject(Mesh) || !(*Mesh)->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty() ||
                !(*Mesh)->TryGetStringField(TEXT("file"), Relative) || !BundleFile(Options.Directory, Relative, File, Message))
            {
                if (Message.IsEmpty()) { Message = TEXT("Invalid instance mesh sidecar entry."); }
                return false;
            }
            if (PrototypeFiles.Contains(Name)) { Message = TEXT("Duplicate mesh name in sidecar: ") + Name; return false; }
            if (!FPaths::GetExtension(File).Equals(TEXT("glb"), ESearchCase::IgnoreCase)) { Message = TEXT("Prototype must be a GLB: ") + File; return false; }
            PrototypeFiles.Add(Name, File);
        }
    }
    else
    {
        TArray<FString> Files;
        IFileManager::Get().FindFiles(Files, *(Options.Directory / TEXT("meshes/*.glb")), true, false);
        Files.Sort();
        for (const FString& File : Files) { PrototypeFiles.Add(FPaths::GetBaseFilename(File), Options.Directory / TEXT("meshes") / File); }
    }
    for (const TPair<FString, TArray<FTransform>>& Pair : Transforms)
    {
        if (!PrototypeFiles.Contains(Pair.Key)) { Message = TEXT("No prototype GLB for Mesh '") + Pair.Key + TEXT("'."); return false; }
    }
    FLandscapeData LandscapeData;
    if ((Options.bLandscape || bTiledBundle) &&
        !ReadLandscape(Options.Directory, LandscapeData, Message, Options.bLayers, Options.bLandscape)) { return false; }
    for (const TPair<FString, FString>& Pair : PrototypeFiles)
    {
        const FString Name = ObjectTools::SanitizeObjectName(Pair.Key);
        StreamOptions.MeshMapping.Add(Pair.Key, FSoftObjectPath(StreamOptions.MeshFolder / Name + TEXT(".") + Name));
    }
    TArray<FTileInstances> TileInstances;
    if (bTiledBundle && !ReadTileInstances(LandscapeData, StreamOptions, Stream, TileInstances, Message)) { return false; }
    TArray<FString> Names;
    PrototypeFiles.GetKeys(Names);
    Names.Sort();
    TSet<FName> SanitizedNames;
    for (const FString& Name : Names)
    {
        const FString Sanitized = ObjectTools::SanitizeObjectName(Name);
        if (Sanitized.IsEmpty() || SanitizedNames.Contains(FName(*Sanitized))) { Message = TEXT("Prototype names collide after Unreal sanitization."); return false; }
        SanitizedNames.Add(FName(*Sanitized));
    }
    TMap<FString, UStaticMesh*> Prototypes;
    for (const FString& Name : Names)
    {
        TArray<UStaticMesh*> Meshes;
        if (!ImportGLB(PrototypeFiles[Name], StreamOptions.MeshFolder, ObjectTools::SanitizeObjectName(Name), Meshes, Message)) { return false; }
        if (Meshes.Num() != 1) { Message = TEXT("Prototype '") + Name + TEXT("' produced multiple meshes. Export each prototype as a single named mesh before importing."); return false; }
        if (Meshes[0]->GetName() != ObjectTools::SanitizeObjectName(Name))
        {
            Message = TEXT("Interchange changed the prototype name for '") + Name + TEXT("' to '") + Meshes[0]->GetName() + TEXT("'. Cannot establish a predictable Mesh mapping; inspect the unsaved imported assets.");
            return false;
        }
        Prototypes.Add(Name, Meshes[0]);
        UE_LOG(LogTopoTopoImport, Display, TEXT("Mesh mapping: %s -> %s"), *Name, *Meshes[0]->GetPathName());
    }
    TArray<UStaticMesh*> ExpandedMeshes;
    const FString Expanded = Options.Directory / TEXT("objects_expanded.glb");
    if (Options.bExpandedObjects && FPaths::FileExists(Expanded) &&
        !ImportGLB(Expanded, Options.Destination / TEXT("Objects"), FString(), ExpandedMeshes, Message)) { return false; }
    if (!ExpandedMeshes.IsEmpty())
    {
        TSet<FName> ExpandedNames;
        for (const UStaticMesh* Mesh : ExpandedMeshes) { ExpandedNames.Add(Mesh->GetFName()); }
        for (const TPair<FString, TArray<FTransform>>& Pair : Transforms)
        {
            if (!ExpandedNames.Contains(FName(*ObjectTools::SanitizeObjectName(Pair.Key))))
            {
                Message = TEXT("Expanded GLB did not retain mesh name '") + Pair.Key + TEXT("'. Import stopped before placing actors to avoid duplicated instances. Inspect imported assets or retry in a new folder with objects=0.");
                return false;
            }
        }
    }
    const FScopedTransaction Transaction(LOCTEXT("ImportTransaction", "Import TopoTopo scene"));
    World->Modify();
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = RF_Transactional;
    Spawn.OverrideLevel = World->GetCurrentLevel();
    AActor* Actor = World->SpawnActor<AActor>(FVector::ZeroVector, FRotator::ZeroRotator, Spawn);
    if (!Actor) { Message = TEXT("Failed to create instance actor; imported assets remain unsaved."); return false; }
    Actor->SetActorLabel(TEXT("TopoTopo_") + FPaths::GetCleanFilename(Options.Destination));
    USceneComponent* Root = NewObject<USceneComponent>(Actor, TEXT("Root"), RF_Transactional);
    Actor->SetRootComponent(Root);
    Actor->AddInstanceComponent(Root);
    Root->SetMobility(EComponentMobility::Static);
    Root->RegisterComponent();
    int32 InstanceCount = 0;
    int32 InstanceGroupCount = 0;
    if (bTiledBundle)
    {
        for (const FTileInstances& Tile : TileInstances)
        {
            AActor* TileActor = SpawnTileInstances(World, Tile, Prototypes, Actor->GetActorLabel(), false, Message);
            if (!TileActor) { return false; }
            InstanceCount += Tile.Stream.Rows.Num();
            TArray<UHierarchicalInstancedStaticMeshComponent*> Components;
            TileActor->GetComponents(Components);
            InstanceGroupCount += Components.Num();
        }
    }
    else
    {
        for (const FString& Name : Names)
        {
            if (const TArray<FTransform>* Instances = Transforms.Find(Name))
            {
                AddInstances(Actor, Prototypes[Name], Name, *Instances);
                InstanceCount += Instances->Num();
                ++InstanceGroupCount;
            }
        }
    }
    int32 ObjectCount = 0;
    for (UStaticMesh* Mesh : ExpandedMeshes)
    {
        // Expanded per-name trees/rocks are reference meshes. Only place names absent from the stream (e.g. road).
        if (!SanitizedNames.Contains(Mesh->GetFName()))
        {
            AddInstances(Actor, Mesh, Mesh->GetName(), {FTransform::Identity});
            ++ObjectCount;
        }
    }
    if (Options.bLandscape)
    {
        ALandscape* Landscape = ImportLandscape(World, LandscapeData, Options.Destination, Options.bMaterial, false, Message);
        if (!Landscape) { return false; }
        Landscape->SetActorLabel(Actor->GetActorLabel() + TEXT("_Landscape"));
    }
    Actor->MarkPackageDirty();
    GEditor->SelectNone(false, true);
    GEditor->SelectActor(Actor, true, true);
    GEditor->RedrawLevelEditingViewports();
    Message = FString::Printf(TEXT("Imported %d instances in %d mesh groups, %d ordinary objects%s into %s. Assets and level are unsaved."),
        InstanceCount, InstanceGroupCount, ObjectCount, Options.bLandscape ? TEXT(" and one Landscape") : TEXT(""), *Options.Destination);
    if (bTiledBundle)
    {
        Message += FString::Printf(TEXT(" Tiles: %d independent instance actors%s."), TileInstances.Num(),
            Options.bLandscape && World->IsPartitionedWorld() ? TEXT(" and one streaming proxy per tile") : TEXT(""));
    }
    if (Options.bLandscape)
    {
        Message += FString::Printf(TEXT(" Landscape: %d weight layers; generated material %s."),
            LandscapeData.WeightLayers.Num(), Options.bMaterial ? TEXT("assigned") : TEXT("disabled"));
    }
    UE_LOG(LogTopoTopoImport, Display, TEXT("%s"), *Message);
    return true;
}

static void OpenDialog()
{
    TSharedRef<FOptions> Options = MakeShared<FOptions>();
    Options->Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir() / TEXT("TopoTopo/landscape"));
    TSharedRef<SWindow> Window = SNew(SWindow).Title(LOCTEXT("Title", "Import TopoTopo scene"))
        .ClientSize(FVector2D(650, 400)).SupportsMaximize(false).SupportsMinimize(false);
    TSharedPtr<STextBlock> Status;
    Window->SetContent(SNew(SBox).Padding(16)
        [SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 5)[SNew(STextBlock).Text(LOCTEXT("Source", "Bundle folder containing instances.csv and meshes/"))]
        + SVerticalBox::Slot().AutoHeight()[SNew(SEditableTextBox).Text(FText::FromString(Options->Directory))
            .OnTextChanged_Lambda([Options](const FText& Text) { Options->Directory = Text.ToString(); })]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 10, 0, 5)[SNew(STextBlock).Text(LOCTEXT("Dest", "New, empty content folder (/Game/TopoTopo/<set>)"))]
        + SVerticalBox::Slot().AutoHeight()[SNew(SEditableTextBox).Text(FText::FromString(Options->Destination))
            .OnTextChanged_Lambda([Options](const FText& Text) { Options->Destination = Text.ToString(); })]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 10, 0, 0)[SNew(SCheckBox).IsChecked(ECheckBoxState::Checked)
            .OnCheckStateChanged_Lambda([Options](ECheckBoxState State) { Options->bExpandedObjects = State == ECheckBoxState::Checked; })
            [SNew(STextBlock).Text(LOCTEXT("Objects", "Import expanded reference assets and place ordinary objects (e.g. road)"))]]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 5, 0, 10)[SNew(SCheckBox)
            .OnCheckStateChanged_Lambda([Options](ECheckBoxState State) { Options->bLandscape = State == ECheckBoxState::Checked; })
            [SNew(STextBlock).Text(LOCTEXT("Landscape", "Import Landscape heightmap (exact-fit bundle)"))]]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 5)[SNew(SCheckBox).IsChecked(ECheckBoxState::Checked)
            .IsEnabled_Lambda([Options]() { return Options->bLandscape; })
            .OnCheckStateChanged_Lambda([Options](ECheckBoxState State) { Options->bLayers = State == ECheckBoxState::Checked; })
            [SNew(STextBlock).Text(LOCTEXT("Layers", "Import Landscape weight layers and create layer info assets"))]]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 10)[SNew(SCheckBox).IsChecked(ECheckBoxState::Checked)
            .IsEnabled_Lambda([Options]() { return Options->bLandscape; })
            .OnCheckStateChanged_Lambda([Options](ECheckBoxState State) { Options->bMaterial = State == ECheckBoxState::Checked; })
            [SNew(STextBlock).Text(LOCTEXT("Material", "Generate and assign a Landscape material"))]]
        + SVerticalBox::Slot().AutoHeight()[SAssignNew(Status, STextBlock).AutoWrapText(true).Text(LOCTEXT("Unsaved", "Imports assets and creates HISM components in the current level. Nothing is saved automatically."))]
        + SVerticalBox::Slot().AutoHeight().Padding(0, 12, 0, 0)[SNew(SButton).Text(LOCTEXT("Import", "Import"))
            .OnClicked_Lambda([Options, Status]()
            {
                FString Result;
                if (!Run(*Options, Result)) { UE_LOG(LogTopoTopoImport, Error, TEXT("%s"), *Result); }
                Status->SetText(FText::FromString(Result));
                return FReply::Handled();
            })]]);
    FSlateApplication::Get().AddWindow(Window);
}
}

class FTopoTopoPCGEditorModule : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FTopoTopoPCGEditorModule::RegisterMenus));
        Command = MakeUnique<FAutoConsoleCommand>(TEXT("TopoTopo.ImportScene"),
            TEXT("TopoTopo.ImportScene \"absolute bundle directory\" /Game/TopoTopo/NewSet [landscape=0|1] [objects=0|1] [layers=0|1] [material=0|1]. Imports into the current editor level, without saving."),
            FConsoleCommandWithArgsDelegate::CreateLambda([](const TArray<FString>& Args)
            {
                if (Args.Num() < 2) { UE_LOG(LogTopoTopoImport, Error, TEXT("Usage: TopoTopo.ImportScene \"bundle directory\" /Game/TopoTopo/NewSet [landscape=1] [objects=1] [layers=1] [material=1]")); return; }
                TopoTopoImport::FOptions Options;
                Options.Directory = Args[0];
                Options.Destination = Args[1];
                for (int32 I = 2; I < Args.Num(); ++I)
                {
                    if (Args[I] == TEXT("landscape=1")) { Options.bLandscape = true; }
                    else if (Args[I] == TEXT("landscape=0")) { Options.bLandscape = false; }
                    else if (Args[I] == TEXT("layers=0")) { Options.bLayers = false; }
                    else if (Args[I] == TEXT("layers=1")) { Options.bLayers = true; }
                    else if (Args[I] == TEXT("material=0")) { Options.bMaterial = false; }
                    else if (Args[I] == TEXT("material=1")) { Options.bMaterial = true; }
                    else if (Args[I] == TEXT("objects=0")) { Options.bExpandedObjects = false; }
                    else if (Args[I] == TEXT("objects=1")) { Options.bExpandedObjects = true; }
                    else { UE_LOG(LogTopoTopoImport, Error, TEXT("Unknown argument: %s"), *Args[I]); return; }
                }
                FString Message;
                if (!TopoTopoImport::Run(Options, Message)) { UE_LOG(LogTopoTopoImport, Error, TEXT("%s"), *Message); }
            }));
    }

    virtual void ShutdownModule() override
    {
        Command.Reset();
        UToolMenus::UnRegisterStartupCallback(this);
        UToolMenus::UnregisterOwner(this);
    }

private:
    TUniquePtr<FAutoConsoleCommand> Command;
    void RegisterMenus()
    {
        FToolMenuOwnerScoped Owner(this);
        UToolMenu* Menu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Tools"));
        Menu->FindOrAddSection(TEXT("TopoTopo")).AddMenuEntry(TEXT("TopoTopoImportScene"),
            LOCTEXT("Menu", "Import TopoTopo scene"), LOCTEXT("Tip", "Import a TopoTopo bundle into the current level."),
            FSlateIcon(), FUIAction(FExecuteAction::CreateStatic(&TopoTopoImport::OpenDialog)));
    }
};

IMPLEMENT_MODULE(FTopoTopoPCGEditorModule, TopoTopoPCGEditor)

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoLandscapeManifestCompatibilityTest,
    "TopoTopo.Editor.LandscapeManifestCompatibility",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoLandscapeManifestCompatibilityTest::RunTest(const FString& Parameters)
{
    // Exercise the importer's real reader and heightmap decoder without spawning or saving a Landscape.
    const FString Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() /
        TEXT("Automation/TopoTopo") / FGuid::NewGuid().ToString(EGuidFormats::Digits));
    if (!TestTrue(TEXT("Create isolated fixture directory"), IFileManager::Get().MakeDirectory(*Directory, true)))
    {
        return false;
    }
    ON_SCOPE_EXIT { IFileManager::Get().DeleteDirectory(*Directory, false, true); };
    TArray<uint8> Bytes;
    Bytes.SetNumZeroed(8 * 8 * 2);
    for (int32 I = 0; I < 64; ++I) { Bytes[I * 2 + 1] = 128; } // Little-endian uint16 height 32768.
    if (!TestTrue(TEXT("Write 8x8 r16 fixture"), FFileHelper::SaveArrayToFile(Bytes, *(Directory / TEXT("heightmap.r16")))))
    {
        return false;
    }
    const auto ReadFixture = [&](const TCHAR* Format, int32 Version, bool bExact, TopoTopoImport::FLandscapeData& Data, FString& Error)
    {
        const FString Manifest = FString::Printf(TEXT(R"json({"format":"%s","version":%d,
"heightmap":{"file":"heightmap.r16"},"landscape":{"exact_fit":%s,"overall_resolution":[8,8],
"sections_per_component":1,"section_size_quads":7,"actor_location_cm":[-350,-350,42],"scale":[100,100,2]}})json"),
            Format, Version, bExact ? TEXT("true") : TEXT("false"));
        if (!FFileHelper::SaveStringToFile(Manifest, *(Directory / TEXT("landscape.json"))))
        {
            AddError(TEXT("Could not write Landscape manifest fixture."));
            return false;
        }
        return TopoTopoImport::ReadLandscape(Directory, Data, Error);
    };
    for (const TCHAR* Format : {TEXT("topotopo-unreal-landscape"), TEXT("polyforge-unreal-landscape")})
    {
        TopoTopoImport::FLandscapeData Data;
        FString Error;
        if (TestTrue(FString(Format) + TEXT(" v1 accepted"), ReadFixture(Format, 1, true, Data, Error)))
        {
            TestEqual(TEXT("Decoded height count"), Data.Heights.Num(), 64);
            TestTrue(TEXT("All decoded heights are 32768"), Data.Heights.ContainsByPredicate([](uint16 Height) { return Height != 32768; }) == false);
            TestTrue(TEXT("Actor corner retained"), Data.Location.Equals(FVector(-350, -350, 42)));
            TestTrue(TEXT("Actor scale retained"), Data.Scale.Equals(FVector(100, 100, 2)));
        }
        else { AddError(Error); }
        TestFalse(FString(Format) + TEXT(" incomplete v2 without tiles rejected"), ReadFixture(Format, 2, true, Data, Error));
        TestFalse(FString(Format) + TEXT(" non-exact layout rejected"), ReadFixture(Format, 1, false, Data, Error));
    }
    TopoTopoImport::FLandscapeData Data;
    FString Error;
    TestFalse(TEXT("Unknown format rejected"), ReadFixture(TEXT("unknown-landscape"), 1, true, Data, Error));
    return true;
}
#endif

#undef LOCTEXT_NAMESPACE
