// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoPackage.h"

#include "Editor.h"
#include "EditorFramework/AssetImportData.h"
#include "Logging/MessageLog.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Containers/Ticker.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "Misc/App.h"
#include "Misc/Paths.h"
#include "ScopedTransaction.h"
#include "TopoTopoCook.h"
#include "TopoTopoImporter.h"
#include "TopoTopoInstances.h"
#include "TopoTopoRunner.h"
#include "UObject/AssetRegistryTagsContext.h"
#include "UObject/Package.h"

UTopoTopoPackage::UTopoTopoPackage() = default;
FTopoTopoPlaceLandscape UTopoTopoPackage::ImportLandscapeBundle;

void UTopoTopoPackage::PostInitProperties()
{
    if (!HasAnyFlags(RF_ClassDefaultObject | RF_NeedLoad))
    {
        AssetImportData = NewObject<UAssetImportData>(this, TEXT("AssetImportData"));
    }
    Super::PostInitProperties();
}

void UTopoTopoPackage::GetAssetRegistryTags(FAssetRegistryTagsContext Context) const
{
    // what Auto Reimport finds an asset by when its source file changes
    if (AssetImportData)
    {
        Context.AddTag(FAssetRegistryTag(SourceFileTagName(), AssetImportData->GetSourceData().ToJson(), FAssetRegistryTag::TT_Hidden));
    }
    Super::GetAssetRegistryTags(Context);
}

FString UTopoTopoPackage::SourceFile() const
{
    return AssetImportData ? AssetImportData->GetFirstFilename() : FString();
}

void UTopoTopoPackage::PostEditChangeProperty(FPropertyChangedEvent& Event)
{
    Super::PostEditChangeProperty(Event);
    const FName Name = Event.GetMemberPropertyName();
    if (Name != GET_MEMBER_NAME_CHECKED(UTopoTopoPackage, OutputFolder) && Name != GET_MEMBER_NAME_CHECKED(UTopoTopoPackage, bPerOutputFolders)
        && Name != GET_MEMBER_NAME_CHECKED(UTopoTopoPackage, SkipOutputs) && Name != GET_MEMBER_NAME_CHECKED(UTopoTopoPackage, InstanceMode)) { return; }
    OptionsChanged();
}

void UTopoTopoPackage::PostEditUndo()
{
    Super::PostEditUndo();
    // undo and redo bring back other import options: the file the cook reads follows them
    OptionsChanged();
}

void UTopoTopoPackage::OptionsChanged()
{
    FString Error;
    if (!TopoTopo::WriteImportOptions(this, Error))
    {
        TopoTopo::FailCook(this, Error);
        return;
    }
    if (bCookPending) { return; }
    bCookPending = true;
    // the cook and its imports run after the property edit's transaction, so they never become part of its undo step
    FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateWeakLambda(this, [this](float)
    {
        if (GEditor && GEditor->IsTransactionActive()) { return true; }
        bCookPending = false;
        TopoTopo::CookNow(this, false);
        return false;
    }));
}

void UTopoTopoPackage::Recook()
{
    TopoTopo::CookNow(this, true);
}

void UTopoTopoPackage::OpenInTopoTopo()
{
    const FString Topo = SourceFile();
    TopoTopo::OpenViewer(FPaths::GetPath(Topo), FPaths::GetBaseFilename(Topo));
}

void UTopoTopoPackage::ShowCookReport()
{
    FMessageLog(TopoTopo::MessageLogName).Open(EMessageSeverity::Info, true);
}

void UTopoTopoPackage::PlaceTerrainInLevel()
{
    PlaceTerrain(false);
}

bool UTopoTopoPackage::HasTerrain() const
{
    return Outputs.ContainsByPredicate([](const FTopoTopoOutputStatus& Output) { return !Output.Bundle.IsEmpty(); });
}

void UTopoTopoPackage::PlaceTerrain(bool bSave)
{
    FMessageLog Log(TopoTopo::MessageLogName);
    const auto Warn = [&](const FString& Reason)
    {
        const FString Line = FString::Printf(TEXT("TopoTopo: %s: %s"), *GetPathName(), *Reason);
        UE_LOG(LogTopoTopo, Warning, TEXT("%s"), *Line);
        Log.Warning(FText::FromString(Line));
    };
    if (!HasTerrain())
    {
        Warn(TEXT("has no terrain output"));
        if (!FApp::IsUnattended()) { Log.Open(EMessageSeverity::Warning, true); }
        return;
    }
    UWorld* World = GEditor && !GEditor->PlayWorld ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World || !World->GetCurrentLevel())
    {
        Warn(TEXT("open an editor level outside Play/Simulate mode before placing terrain"));
        return;
    }
    if (!ImportLandscapeBundle.IsBound())
    {
        Warn(TEXT("the TopoTopo landscape importer is unavailable"));
        return;
    }

    ULevel* Level = World->GetCurrentLevel();
    const TArray<UPackage*> ExternalBefore = bSave ? Level->GetLoadedExternalObjectPackages() : TArray<UPackage*>{};
    TSet<UPackage*> ToSave;
    const IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
    const FString Project = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    int32 Landscapes = 0, Meshes = 0, Instances = 0;
    bool bSceneIncludesObjects = false;
    for (const FTopoTopoOutputStatus& Output : Outputs)
    {
        if (Output.Bundle.IsEmpty()) { continue; }
        // TopoTopo.ImportScene wants an empty folder below /Game/TopoTopo/: every placement is a set of its own
        const FString Base = FString::Printf(TEXT("/Game/TopoTopo/%s_%s"), *GetName(), *Output.Id);
        FString Destination = Base;
        for (int32 N = 2; Registry.HasAssets(FName(*Destination), true); N++) { Destination = FString::Printf(TEXT("%s_%d"), *Base, N); }
        const FString Bundle = FPaths::GetPath(Project / Output.Bundle);
        FString Message;
        if (!ImportLandscapeBundle.Execute(Bundle, Destination, bSave ? &ToSave : nullptr, Message))
        {
            Warn(FString::Printf(TEXT("could not place %s: %s"), *Output.Id, *Message));
            continue;
        }
        ++Landscapes;
        bSceneIncludesObjects |= Output.Kind == TEXT("scene");
    }
    if (!Landscapes) { return; }
    if (!bSceneIncludesObjects)
    {
        // Terrain bundles contain the ground. Place the separately imported assets so live cooks can update them.
        const FScopedTransaction Transaction(NSLOCTEXT("TopoTopoImport", "PlaceTerrainTransaction", "Place TopoTopo outputs"));
        Level->Modify();
        FActorSpawnParameters Spawn;
        Spawn.ObjectFlags = RF_Transactional;
        Spawn.OverrideLevel = Level;
        for (const FTopoTopoOutputStatus& Output : Outputs)
        {
            if (!Output.Bundle.IsEmpty() || (Output.Kind != TEXT("mesh") && Output.Kind != TEXT("instances") && Output.Kind != TEXT("scene"))) { continue; }
            TArray<UStaticMesh*> StaticMeshes;
            TSet<UStaticMesh*> Prototypes;
            for (const TSoftObjectPtr<UObject>& Asset : Output.Assets)
            {
                UObject* Object = Asset.LoadSynchronous();
                if (UTopoTopoInstances* Data = Cast<UTopoTopoInstances>(Object))
                {
                    for (const FTopoTopoInstanceGroup& Group : Data->Groups) { Prototypes.Add(Group.Mesh.Get()); }
                    if (ATopoTopoInstancesActor* Actor = World->SpawnActor<ATopoTopoInstancesActor>(Spawn))
                    {
                        Actor->SetActorLabel(TEXT("Topo_") + Output.Id);
                        Actor->Instances = Data;
                        Actor->Rebuild();
                        Actor->MarkPackageDirty();
                        Instances += Data->NumInstances();
                    }
                    else { Warn(FString::Printf(TEXT("could not place %s"), *Data->GetName())); }
                }
                else if (UStaticMesh* Mesh = Cast<UStaticMesh>(Object)) { StaticMeshes.Add(Mesh); }
            }
            for (UStaticMesh* Mesh : StaticMeshes)
            {
                if (Prototypes.Contains(Mesh)) { continue; }
                if (AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(Spawn))
                {
                    Actor->SetActorLabel(TEXT("Topo_") + Output.Id);
                    Actor->GetStaticMeshComponent()->SetStaticMesh(Mesh);
                    Actor->MarkPackageDirty();
                    ++Meshes;
                }
                else { Warn(FString::Printf(TEXT("could not place %s"), *Mesh->GetName())); }
            }
        }
    }
    UE_LOG(LogTopoTopo, Display, TEXT("TopoTopo: %s: placed %d Landscape output(s), %d separate mesh actor(s), and %d separate instances"), *GetPathName(), Landscapes, Meshes, Instances);
    if (!bSave) { return; }
    Level->MarkPackageDirty();
    ToSave.Add(Level->GetOutermost());
    for (UPackage* External : Level->GetLoadedExternalObjectPackages())
    {
        if (!ExternalBefore.Contains(External)) { ToSave.Add(External); }
    }
    if (UEditorLoadingAndSavingUtils::SavePackages(ToSave.Array(), true))
    {
        UE_LOG(LogTopoTopo, Display, TEXT("TopoTopo: saved %s and its new assets"), *Level->GetOutermost()->GetName());
    }
    else { Warn(TEXT("could not save the level and its new assets")); }
}
