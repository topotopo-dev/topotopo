// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoPackageFactory.h"

#include "Editor.h"
#include "EditorFramework/AssetImportData.h"
#include "Logging/MessageLog.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Subsystems/ImportSubsystem.h"
#include "TopoTopoImporter.h"
#include "TopoTopoPackage.h"
#include "TopoTopoRunner.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(TopoTopoPackageFactory)

UTopoTopoPackageFactory::UTopoTopoPackageFactory()
{
    bCreateNew = false;
    bEditorImport = true;
    bText = false;
    SupportedClass = UTopoTopoPackage::StaticClass();
    Formats.Add(TEXT("topo;TopoTopo package"));
}

bool UTopoTopoPackageFactory::FactoryCanImport(const FString& Filename)
{
    return FPaths::GetExtension(Filename).Equals(TEXT("topo"), ESearchCase::IgnoreCase);
}

UObject* UTopoTopoPackageFactory::FactoryCreateFile(UClass* InClass, UObject* InParent, FName InName, EObjectFlags Flags, const FString& Filename, const TCHAR* Parms, FFeedbackContext* Warn, bool& bOutOperationCanceled)
{
    // a package is imported where it lies: its graphs and inputs stay beside its manifest
    const FString Topo = FPaths::ConvertRelativePathToFull(Filename);
    FString Mounted;
    if (!FPackageName::TryConvertFilenameToLongPackageName(Topo, Mounted))
    {
        FMessageLog Log(TopoTopo::MessageLogName);
        const FText Text = FText::FromString(FString::Printf(TEXT("TopoTopo: %s is outside the project's Content folder. Move the package's folder into Content, then import its .topo."), *Topo));
        Log.Error(Text);
        Log.Notify(Text, EMessageSeverity::Error, true);
        return nullptr;
    }

    GEditor->GetEditorSubsystem<UImportSubsystem>()->BroadcastAssetPreImport(this, InClass, InParent, InName, TEXT("topo"));
    UTopoTopoPackage* Package = FindObject<UTopoTopoPackage>(InParent, *InName.ToString());
    if (!Package) { Package = NewObject<UTopoTopoPackage>(InParent, InClass, InName, Flags | RF_Transactional); }
    Package->AssetImportData->Update(Topo);
    TopoTopo::ReadImportOptions(Package);
    TopoTopo::CookNow(Package, false);
    GEditor->GetEditorSubsystem<UImportSubsystem>()->BroadcastAssetPostImport(this, Package);
    return Package;
}

bool UTopoTopoPackageFactory::CanReimport(UObject* Obj, TArray<FString>& OutFilenames)
{
    const UTopoTopoPackage* Package = Cast<UTopoTopoPackage>(Obj);
    if (!Package || !Package->AssetImportData) { return false; }
    Package->AssetImportData->ExtractFilenames(OutFilenames);
    return true;
}

void UTopoTopoPackageFactory::SetReimportPaths(UObject* Obj, const TArray<FString>& NewReimportPaths)
{
    UTopoTopoPackage* Package = Cast<UTopoTopoPackage>(Obj);
    if (Package && NewReimportPaths.Num() == 1)
    {
        Package->Modify();
        Package->AssetImportData->UpdateFilenameOnly(NewReimportPaths[0]);
    }
}

EReimportResult::Type UTopoTopoPackageFactory::Reimport(UObject* Obj)
{
    UTopoTopoPackage* Package = Cast<UTopoTopoPackage>(Obj);
    if (!Package) { return EReimportResult::Failed; }
    // the hash of the source, which Auto Reimport compares against
    Package->AssetImportData->Update(Package->SourceFile());
    TopoTopo::ReadImportOptions(Package);
    return TopoTopo::CookNow(Package, false) ? EReimportResult::Succeeded : EReimportResult::Failed;
}
