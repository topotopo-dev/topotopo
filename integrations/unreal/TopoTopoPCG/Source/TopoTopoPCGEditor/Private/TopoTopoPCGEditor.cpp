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
#include "LandscapeImportHelper.h"
#include "LandscapeInfo.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "ObjectTools.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "ToolMenus.h"
#include "TopoTopoStream.h"
#include "UObject/StrongObjectPtr.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SWindow.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "TopoTopoPCGEditor"
DEFINE_LOG_CATEGORY_STATIC(LogTopoTopoImport, Log, All);

namespace TopoTopoImport
{
struct FOptions
{
    FString Directory;
    FString Destination = TEXT("/Game/TopoTopo/PluginDemo");
    bool bLandscape = false;
    bool bExpandedObjects = true;
};

struct FLandscapeData
{
    FString Filename;
    int32 Width = 0;
    int32 Height = 0;
    int32 Sections = 0;
    int32 Quads = 0;
    FVector Location = FVector::ZeroVector;
    FVector Scale = FVector::OneVector;
    TArray<uint16> Heights;
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

static bool ReadVector(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, FVector& Out)
{
    const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
    if (!Object->TryGetArrayField(Field, Values) || Values->Num() != 3) { return false; }
    for (int32 I = 0; I < 3; ++I)
    {
        double Value;
        if (!(*Values)[I]->TryGetNumber(Value) || !FMath::IsFinite(Value)) { return false; }
        Out[I] = Value;
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

static bool ReadLandscape(const FString& Directory, FLandscapeData& Out, FString& Error)
{
    TSharedPtr<FJsonObject> Manifest;
    if (!ReadJSON(Directory / TEXT("landscape.json"), Manifest, Error)) { return false; }
    FString Format;
    double Version = 0;
    const TSharedPtr<FJsonObject>* Settings = nullptr;
    const TSharedPtr<FJsonObject>* Heightmap = nullptr;
    bool bExact = false;
    if (!Manifest->TryGetStringField(TEXT("format"), Format) || Format != TEXT("topotopo-unreal-landscape") ||
        !Manifest->TryGetNumberField(TEXT("version"), Version) || Version != 1 ||
        !Manifest->TryGetObjectField(TEXT("landscape"), Settings) ||
        !Manifest->TryGetObjectField(TEXT("heightmap"), Heightmap) ||
        !(*Settings)->TryGetBoolField(TEXT("exact_fit"), bExact) || !bExact)
    {
        Error = TEXT("Landscape requires a version 1 topotopo-unreal-landscape manifest with exact_fit=true. Resample non-exact bundles before importing.");
        return false;
    }
    const TArray<TSharedPtr<FJsonValue>>* Resolution = nullptr;
    double Width, Height, Sections, Quads;
    FString Relative;
    if (!(*Heightmap)->TryGetStringField(TEXT("file"), Relative) ||
        !(*Settings)->TryGetArrayField(TEXT("overall_resolution"), Resolution) || Resolution->Num() != 2 ||
        !(*Resolution)[0]->TryGetNumber(Width) || !(*Resolution)[1]->TryGetNumber(Height) ||
        !(*Settings)->TryGetNumberField(TEXT("sections_per_component"), Sections) ||
        !(*Settings)->TryGetNumberField(TEXT("section_size_quads"), Quads) ||
        !ReadVector(*Settings, TEXT("actor_location_cm"), Out.Location) || !ReadVector(*Settings, TEXT("scale"), Out.Scale))
    {
        Error = TEXT("Landscape manifest is missing valid resolution, component layout, location or scale.");
        return false;
    }
    if (Width < 2 || Height < 2 || Width > 8193 || Height > 8193 ||
        Width != FMath::FloorToDouble(Width) || Height != FMath::FloorToDouble(Height) ||
        (Sections != 1 && Sections != 2) || (Quads != 7 && Quads != 15 && Quads != 31 && Quads != 63 && Quads != 127 && Quads != 255) ||
        Out.Scale.X <= 0 || Out.Scale.Y <= 0 || Out.Scale.Z <= 0)
    {
        Error = TEXT("Unsupported Landscape dimensions/layout/scale (maximum 8193 samples per side).");
        return false;
    }
    Out.Width = static_cast<int32>(Width);
    Out.Height = static_cast<int32>(Height);
    Out.Sections = static_cast<int32>(Sections);
    Out.Quads = static_cast<int32>(Quads);
    if ((Out.Width - 1) % (Out.Sections * Out.Quads) != 0 || (Out.Height - 1) % (Out.Sections * Out.Quads) != 0)
    {
        Error = TEXT("Landscape resolution does not fit its component grid.");
        return false;
    }
    if (!BundleFile(Directory, Relative, Out.Filename, Error)) { return false; }
    FLandscapeImportDescriptor Descriptor;
    FText Message;
    if (FLandscapeImportHelper::GetHeightmapImportDescriptor(Out.Filename, true, false, Descriptor, Message) == ELandscapeImportResult::Error)
    {
        Error = Message.ToString();
        return false;
    }
    const int32 Index = Descriptor.FindDescriptorIndex(Out.Width, Out.Height);
    if (Index == INDEX_NONE)
    {
        Error = TEXT("Heightmap dimensions do not match landscape.overall_resolution.");
        return false;
    }
    if (FLandscapeImportHelper::GetHeightmapImportData(Descriptor, Index, Out.Heights, Message) == ELandscapeImportResult::Error ||
        Out.Heights.Num() != Out.Width * Out.Height)
    {
        Error = TEXT("Could not decode the complete Landscape heightmap: ") + Message.ToString();
        return false;
    }
    return true;
}

static bool ImportGLB(const FString& File, const FString& Folder, const FString& PrototypeName,
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
    FTopoTopoStream Stream;
    if (!TopoTopoStream::LoadFile(Options.Directory / TEXT("instances.csv"), StreamOptions, Stream, Message)) { return false; }
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
    if (Options.bLandscape && !ReadLandscape(Options.Directory, LandscapeData, Message)) { return false; }
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
    for (const FString& Name : Names)
    {
        if (const TArray<FTransform>* Instances = Transforms.Find(Name))
        {
            AddInstances(Actor, Prototypes[Name], Name, *Instances);
            InstanceCount += Instances->Num();
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
        ALandscape* Landscape = World->SpawnActor<ALandscape>(LandscapeData.Location, FRotator::ZeroRotator, Spawn);
        if (!Landscape) { Message = TEXT("Instances imported, but Landscape actor creation failed. Changes remain unsaved."); return false; }
        Landscape->SetActorLabel(Actor->GetActorLabel() + TEXT("_Landscape"));
        Landscape->SetActorScale3D(LandscapeData.Scale);
        Landscape->StaticLightingLOD = FMath::DivideAndRoundUp(FMath::CeilLogTwo(
            (LandscapeData.Width * LandscapeData.Height) / (2048 * 2048) + 1), static_cast<uint32>(2));
        TMap<FGuid, TArray<uint16>> Heights;
        Heights.Add(FGuid(), MoveTemp(LandscapeData.Heights));
        TMap<FGuid, TArray<FLandscapeImportLayerInfo>> Layers;
        Layers.Add(FGuid(), {});
        Landscape->Import(FGuid::NewGuid(), 0, 0, LandscapeData.Width - 1, LandscapeData.Height - 1,
            LandscapeData.Sections, LandscapeData.Quads, Heights, *LandscapeData.Filename, Layers,
            ELandscapeImportAlphamapType::Additive, TArrayView<const FLandscapeLayer>());
        if (ULandscapeInfo* Info = Landscape->GetLandscapeInfo()) { Info->UpdateLayerInfoMap(Landscape); }
        Landscape->MarkPackageDirty();
    }
    Actor->MarkPackageDirty();
    GEditor->SelectNone(false, true);
    GEditor->SelectActor(Actor, true, true);
    GEditor->RedrawLevelEditingViewports();
    Message = FString::Printf(TEXT("Imported %d instances in %d mesh groups, %d ordinary objects%s into %s. Assets and level are unsaved. Landscape materials/weight layers are assigned manually."),
        InstanceCount, Transforms.Num(), ObjectCount, Options.bLandscape ? TEXT(" and one Landscape") : TEXT(""), *Options.Destination);
    UE_LOG(LogTopoTopoImport, Display, TEXT("%s"), *Message);
    return true;
}

static void OpenDialog()
{
    TSharedRef<FOptions> Options = MakeShared<FOptions>();
    Options->Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir() / TEXT("TopoTopo/landscape"));
    TSharedRef<SWindow> Window = SNew(SWindow).Title(LOCTEXT("Title", "Import TopoTopo scene"))
        .ClientSize(FVector2D(650, 320)).SupportsMaximize(false).SupportsMinimize(false);
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
            [SNew(STextBlock).Text(LOCTEXT("Landscape", "Import Landscape heightmap (exact-fit bundle; materials/layers manual)"))]]
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
            TEXT("TopoTopo.ImportScene \"absolute bundle directory\" /Game/TopoTopo/NewSet [landscape=0|1] [objects=0|1]. Imports into the current editor level, without saving."),
            FConsoleCommandWithArgsDelegate::CreateLambda([](const TArray<FString>& Args)
            {
                if (Args.Num() < 2) { UE_LOG(LogTopoTopoImport, Error, TEXT("Usage: TopoTopo.ImportScene \"bundle directory\" /Game/TopoTopo/NewSet [landscape=1] [objects=1]")); return; }
                TopoTopoImport::FOptions Options;
                Options.Directory = Args[0];
                Options.Destination = Args[1];
                for (int32 I = 2; I < Args.Num(); ++I)
                {
                    if (Args[I] == TEXT("landscape=1")) { Options.bLandscape = true; }
                    else if (Args[I] == TEXT("landscape=0")) { Options.bLandscape = false; }
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
#undef LOCTEXT_NAMESPACE
