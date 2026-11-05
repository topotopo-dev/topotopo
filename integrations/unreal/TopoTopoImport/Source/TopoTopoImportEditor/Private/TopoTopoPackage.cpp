// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoPackage.h"

#include "Editor.h"
#include "EditorFramework/AssetImportData.h"
#include "HAL/IConsoleManager.h"
#include "Logging/MessageLog.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Misc/Paths.h"
#include "TopoTopoCook.h"
#include "TopoTopoImporter.h"
#include "TopoTopoRunner.h"
#include "UObject/AssetRegistryTagsContext.h"

UTopoTopoPackage::UTopoTopoPackage() = default;

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
    FString Error;
    if (TopoTopo::WriteImportOptions(this, Error)) { TopoTopo::CookNow(this, false); }
    else { TopoTopo::FailCook(this, Error); }
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
    FMessageLog Log(TopoTopo::MessageLogName);
    if (!IConsoleManager::Get().FindConsoleObject(TEXT("TopoTopo.ImportScene")))
    {
        Log.Error(FText::FromString(TEXT("TopoTopo: placing terrain needs the TopoTopoPCG plugin: topotopo unreal setup <project> --with-pcg")));
        Log.Open(EMessageSeverity::Error, true);
        return;
    }
    const IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
    const FString Project = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    bool bPlaced = false;
    for (const FTopoTopoOutputStatus& Output : Outputs)
    {
        if (Output.Bundle.IsEmpty()) { continue; }
        // TopoTopo.ImportScene wants an empty folder below /Game/TopoTopo/: every placement is a set of its own
        const FString Base = FString::Printf(TEXT("/Game/TopoTopo/%s_%s"), *GetName(), *Output.Id);
        FString Destination = Base;
        for (int32 N = 2; Registry.HasAssets(FName(*Destination), true); N++) { Destination = FString::Printf(TEXT("%s_%d"), *Base, N); }
        const FString Bundle = FPaths::GetPath(Project / Output.Bundle);
        const FString Command = FString::Printf(TEXT("TopoTopo.ImportScene \"%s\" %s landscape=1 layers=1 material=1 objects=1"), *Bundle, *Destination);
        UE_LOG(LogTopoTopo, Log, TEXT("TopoTopo: %s"), *Command);
        GEngine->Exec(GEditor ? GEditor->GetEditorWorldContext().World() : nullptr, *Command);
        bPlaced = true;
    }
    if (!bPlaced)
    {
        Log.Warning(FText::FromString(FString::Printf(TEXT("TopoTopo: %s has no terrain output"), *GetName())));
        Log.Open(EMessageSeverity::Warning, true);
    }
}
