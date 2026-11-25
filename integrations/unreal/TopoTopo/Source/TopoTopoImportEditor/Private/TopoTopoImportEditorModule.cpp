// Copyright 2026 faxcorp, Apache-2.0
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetImportTask.h"
#include "AssetToolsModule.h"
#include "ContentBrowserMenuContexts.h"
#include "DirectoryWatcherModule.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "IDirectoryWatcher.h"
#include "MessageLogModule.h"
#include "Misc/OutputDevice.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Settings/EditorLoadingSavingSettings.h"
#include "ToolMenus.h"
#include "TopoTopoCook.h"
#include "TopoTopoImporter.h"
#include "TopoTopoImportSettings.h"
#include "TopoTopoPackage.h"
#include "TopoTopoPackageFactory.h"
#include "TopoTopoRunner.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/ScopeExit.h"
#include "Misc/StringOutputDevice.h"
#endif

#define LOCTEXT_NAMESPACE "TopoTopoImport"

namespace
{
    /** What Auto Reimport must not see of a package in Content/: UNREAL_EXCLUDES in the CLI, which topotopo unreal setup writes to the project. */
    const TCHAR* const Excludes[] = {
        TEXT("*/graphs/*"), TEXT("*/assets/*"), TEXT("*/inputs/*"), TEXT("*/exports/*"), TEXT("*/versions/*"), TEXT("*/packages/*"), TEXT("*/attachments/*"), TEXT("*/.topotopo/*"),
        TEXT("*/topotopo-packages/*"), TEXT("topotopo-packages/*"), TEXT("*topotopo-workspace.json"),
    };

    /** A project's saved editor settings can hold another list than its ini: the exclusions go in whichever it has. */
    void EnsureExcludes()
    {
        UEditorLoadingSavingSettings* Settings = GetMutableDefault<UEditorLoadingSavingSettings>();
        bool bChanged = false;
        for (FAutoReimportDirectoryConfig& Directory : Settings->AutoReimportDirectorySettings)
        {
            if (!Directory.SourceDirectory.StartsWith(TEXT("/Game"))) { continue; }
            for (const TCHAR* Exclude : Excludes)
            {
                if (!Directory.Wildcards.ContainsByPredicate([&](const FAutoReimportWildcard& W) { return W.Wildcard == Exclude; }))
                {
                    FAutoReimportWildcard& Added = Directory.Wildcards.AddDefaulted_GetRef();
                    Added.Wildcard = Exclude;
                    Added.bInclude = false;
                    bChanged = true;
                }
            }
        }
        if (bChanged)
        {
            Settings->SaveConfig();
            Settings->OnSettingChanged().Broadcast(GET_MEMBER_NAME_CHECKED(UEditorLoadingSavingSettings, AutoReimportDirectorySettings));
        }
    }

    bool LiveCookIsOn()
    {
        return GetDefault<UTopoTopoImportSettings>()->bLiveCook && GetDefault<UEditorLoadingSavingSettings>()->bMonitorContentDirectories;
    }

    /** The .topo of the package whose working folder (graphs, assets, inputs) holds a file, or empty. Auto Reimport never sees those, by the exclusions. */
    FString PackageOfWorkingFile(const FString& File)
    {
        TArray<FString> Parts;
        File.ParseIntoArray(Parts, TEXT("/"));
        for (int32 At = Parts.Num() - 2; At > 0; At--)
        {
            if (Parts[At] != TEXT("graphs") && Parts[At] != TEXT("assets") && Parts[At] != TEXT("inputs")) { continue; }
            FString Dir = File.Left(File.Find(FString::Printf(TEXT("/%s/%s"), *Parts[At], *Parts[At + 1]), ESearchCase::CaseSensitive, ESearchDir::FromEnd));
            TArray<FString> Found;
            IFileManager::Get().FindFiles(Found, *(Dir / TEXT("*.topo")), true, false);
            if (Found.Num() == 1) { return Dir / Found[0]; }
        }
        return FString();
    }

    void OnContentChanged(const TArray<FFileChangeData>& Changes)
    {
        if (!LiveCookIsOn()) { return; }
        bool bEveryPackage = false;
        for (const FFileChangeData& Change : Changes)
        {
            FString File = FPaths::ConvertRelativePathToFull(Change.Filename);
            FPaths::NormalizeFilename(File);
            if (File.EndsWith(TEXT(".topotopo-part")) || File.Contains(TEXT("/.topotopo/"))) { continue; }
            // a workspace's shared packages feed every package of it; the cook of one that did not change is quick
            if (File.Contains(TEXT("/topotopo-packages/")) || File.EndsWith(TEXT("topotopo-workspace.json")))
            {
                bEveryPackage = true;
                continue;
            }
            const FString Topo = PackageOfWorkingFile(File);
            if (!Topo.IsEmpty()) { TopoTopo::CookLater(Topo); }
        }
        if (bEveryPackage)
        {
            for (const UTopoTopoPackage* Package : TopoTopo::AllPackages()) { TopoTopo::CookLater(Package->SourceFile()); }
        }
    }

    /** The package files that changed while the editor was closed. */
    void OnAssetsDiscovered()
    {
        if (!LiveCookIsOn()) { return; }
        for (const UTopoTopoPackage* Package : TopoTopo::AllPackages()) { TopoTopo::CookLater(Package->SourceFile()); }
    }

    TArray<UTopoTopoPackage*> DiscoverPackageAssets()
    {
        IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
        Registry.ScanPathsSynchronous({ TEXT("/Game") });
        TArray<UTopoTopoPackage*> Packages = TopoTopo::AllPackages();
        Packages.Sort([](const UTopoTopoPackage& A, const UTopoTopoPackage& B) { return A.GetPathName() < B.GetPathName(); });
        return Packages;
    }

    // Published snapshots and dependency folders hold copies of the working package manifest.
    bool IsPublishedCopy(const FString& File, const FString& Content)
    {
        if (FPaths::FileExists(FPaths::GetPath(File) / TEXT("version.json"))) { return true; }
        for (FString Dir = FPaths::GetPath(File); FPaths::IsUnderDirectory(Dir, Content); Dir = FPaths::GetPath(Dir))
        {
            const FString Name = FPaths::GetCleanFilename(Dir).ToLower();
            if (Name == TEXT("topotopo-packages")) { return true; }
            if (Name == TEXT("versions") || Name == TEXT("packages"))
            {
                TArray<FString> Manifests;
                IFileManager::Get().FindFiles(Manifests, *(FPaths::GetPath(Dir) / TEXT("*.topo")), true, false);
                if (!Manifests.IsEmpty()) { return true; }
            }
        }
        return false;
    }

    TArray<TStrongObjectPtr<UTopoTopoPackage>> ImportMissingPackages(const FString& Content, const TArray<UTopoTopoPackage*>& Existing, int32& Failures)
    {
        TArray<FString> Files, Sources;
        IFileManager::Get().FindFilesRecursive(Files, *Content, TEXT("*.topo"), true, false);
        Files.Sort();
        for (const UTopoTopoPackage* Package : Existing) { Sources.Add(Package->SourceFile()); }
        TArray<TStrongObjectPtr<UTopoTopoPackage>> Imported;
        for (const FString& File : Files)
        {
            if (Sources.ContainsByPredicate([&](const FString& Source) { return FPaths::IsSamePath(Source, File); }) || IsPublishedCopy(File, Content)) { continue; }
            FString Asset;
            FString Reason;
            if (!FPackageName::TryConvertFilenameToLongPackageName(File, Asset) || !FPackageName::IsValidLongPackageName(Asset))
            {
                Reason = TEXT("the source does not have a valid Unreal package path");
            }
            else if (FPackageName::DoesPackageExist(Asset) || FindPackage(nullptr, *Asset))
            {
                Reason = FString::Printf(TEXT("%s is already in use"), *Asset);
            }
            else
            {
                TStrongObjectPtr<UAssetImportTask> Task(NewObject<UAssetImportTask>());
                UTopoTopoPackageFactory* Factory = NewObject<UTopoTopoPackageFactory>(Task.Get());
                Factory->bCookOnImport = false;
                Task->Factory = Factory;
                Task->Filename = File;
                Task->DestinationPath = FPaths::GetPath(Asset);
                Task->bAutomated = true;
                Task->bAsync = false;
                Task->bSave = false;
                Task->bReplaceExisting = false;
                FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools").Get().ImportAssetTasks({ Task.Get() });
                const int32 NumImported = Imported.Num();
                for (UObject* Object : Task->GetObjects())
                {
                    if (UTopoTopoPackage* Package = Cast<UTopoTopoPackage>(Object))
                    {
                        Package->MarkPackageDirty();
                        Imported.Emplace(Package);
                        break;
                    }
                }
                if (Imported.Num() > NumImported) { continue; }
                Reason = TEXT("Unreal could not import the package asset; see the asset import log");
            }
            FString Relative = File;
            FPaths::MakePathRelativeTo(Relative, *FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()));
            UE_LOG(LogTopoTopo, Display, TEXT("TopoTopo: %s: failed: %s"), *Relative, *Reason);
            ++Failures;
        }
        return Imported;
    }

    void CookAllPackages(const TArray<FString>& Args, FOutputDevice& Ar)
    {
        for (const FString& Arg : Args)
        {
            if (!Arg.Equals(TEXT("force")) && !Arg.Equals(TEXT("wait")))
            {
                Ar.Log(TEXT("Usage: TopoTopo.CookAll [force] [wait]"));
                return;
            }
        }
        const bool bForce = Args.Contains(TEXT("force"));
        const bool bWait = Args.Contains(TEXT("wait"));
        const TArray<UTopoTopoPackage*> Existing = DiscoverPackageAssets();
        TArray<TStrongObjectPtr<UTopoTopoPackage>> Packages;
        for (UTopoTopoPackage* Package : Existing) { Packages.Emplace(Package); }
        int32 Failed = 0;
        TArray<TStrongObjectPtr<UTopoTopoPackage>> Imported = ImportMissingPackages(
            FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir()), Existing, Failed);
        const int32 NumExisting = Packages.Num();
        Packages.Append(MoveTemp(Imported));
        if (Packages.IsEmpty() && Failed == 0) { UE_LOG(LogTopoTopo, Display, TEXT("TopoTopo: no packages in this project")); }
        int32 NumImported = 0, Cooked = 0, Unchanged = 0;
        for (int32 I = 0; I < Packages.Num(); ++I)
        {
            UTopoTopoPackage* Package = Packages[I].Get();
            const bool bImported = I >= NumExisting;
            if (!bWait)
            {
                TopoTopo::QueueCommandCook(Package, bForce, bImported);
                continue;
            }
            const TopoTopo::FCookResult Result = TopoTopo::CookNow(Package, bForce);
            const TopoTopo::ECookState State = TopoTopo::ReportCommandCook(Package, Result, bImported);
            if (State == TopoTopo::ECookState::Failed) { ++Failed; }
            else if (bImported) { ++NumImported; }
            else if (State == TopoTopo::ECookState::Cooked) { ++Cooked; }
            else
            {
                ++Unchanged;
            }
        }
        if (bWait)
        {
            UE_LOG(LogTopoTopo, Display, TEXT("TopoTopo: CookAll finished: %d imported, %d cooked, %d unchanged, %d failed"), NumImported, Cooked, Unchanged, Failed);
        }
    }

    bool MatchesPackage(const UTopoTopoPackage& Package, const FString& Name)
    {
        return Package.GetName().Equals(Name, ESearchCase::IgnoreCase) || Package.GetPathName().Equals(Name, ESearchCase::IgnoreCase)
            || Package.GetOutermost()->GetName().Equals(Name, ESearchCase::IgnoreCase);
    }

    void PlaceTerrain(const TArray<FString>& Args, FOutputDevice& Ar)
    {
        FString Name;
        bool bSave = false;
        for (const FString& Arg : Args)
        {
            // A lone package named "save" can be selected by its asset path.
            if (Arg.Equals(TEXT("save"))) { bSave = true; }
            else if (Name.IsEmpty()) { Name = Arg; }
            else
            {
                Ar.Log(TEXT("Usage: TopoTopo.PlaceTerrain [package] [save]"));
                return;
            }
        }
        TArray<UTopoTopoPackage*> Matches = DiscoverPackageAssets();
        Matches.RemoveAll([&](const UTopoTopoPackage* Package)
        {
            return Name.IsEmpty() ? !Package->HasTerrain() : !MatchesPackage(*Package, Name);
        });
        if (!Name.IsEmpty() && Matches.Num() > 1)
        {
            Ar.Logf(TEXT("TopoTopo: more than one package is named %s; use its asset path"), *Name);
            return;
        }
        if (Matches.IsEmpty())
        {
            if (Name.IsEmpty()) { Ar.Log(TEXT("TopoTopo: no packages with terrain in this project")); }
            else { Ar.Logf(TEXT("TopoTopo: package %s was not found; run TopoTopo.CookAll wait first"), *Name); }
            return;
        }
        TArray<TStrongObjectPtr<UTopoTopoPackage>> Packages;
        for (UTopoTopoPackage* Package : Matches) { Packages.Emplace(Package); }
        for (const TStrongObjectPtr<UTopoTopoPackage>& Package : Packages) { Package->PlaceTerrain(bSave); }
    }

    void RegisterMenus()
    {
        UToolMenu* Menu = UE::ContentBrowser::ExtendToolMenu_AssetContextMenu(UTopoTopoPackage::StaticClass());
        FToolMenuSection& Section = Menu->FindOrAddSection(TEXT("GetAssetActions"));
        Section.AddDynamicEntry(TEXT("TopoTopoPackageActions"), FNewToolMenuSectionDelegate::CreateLambda([](FToolMenuSection& InSection)
        {
            const UContentBrowserAssetContextMenuContext* Context = InSection.FindContext<UContentBrowserAssetContextMenuContext>();
            if (!Context) { return; }
            const auto Add = [&](const TCHAR* Name, const FText& Label, const FText& Tip, void (UTopoTopoPackage::*Action)())
            {
                InSection.AddMenuEntry(Name, Label, Tip, FSlateIcon(), FToolUIActionChoice(FExecuteAction::CreateWeakLambda(Context, [Context, Action]()
                {
                    for (UTopoTopoPackage* Package : Context->LoadSelectedObjects<UTopoTopoPackage>()) { (Package->*Action)(); }
                })));
            };
            Add(TEXT("TopoTopoRecook"), LOCTEXT("Recook", "Recook"), LOCTEXT("RecookTip", "Cook every output again, ignoring the record and the cache, and import them all."), &UTopoTopoPackage::Recook);
            Add(TEXT("TopoTopoOpen"), LOCTEXT("Open", "Open in TopoTopo"), LOCTEXT("OpenTip", "Open the package in TopoTopo's viewer, in the browser."), &UTopoTopoPackage::OpenInTopoTopo);
            Add(TEXT("TopoTopoReport"), LOCTEXT("Report", "Show Cook Report"), LOCTEXT("ReportTip", "Open the TopoTopo message log."), &UTopoTopoPackage::ShowCookReport);
            Add(TEXT("TopoTopoTerrain"), LOCTEXT("Terrain", "Place Terrain in Level"), LOCTEXT("TerrainTip", "Place the package's terrain outputs in the open level."), &UTopoTopoPackage::PlaceTerrainInLevel);
        }));
    }
}

class FTopoTopoImportEditorModule : public IModuleInterface
{
public:
    virtual void StartupModule() override
    {
        FMessageLogModule& Log = FModuleManager::LoadModuleChecked<FMessageLogModule>("MessageLog");
        FMessageLogInitializationOptions Options;
        Options.bShowFilters = true;
        Options.bShowPages = true;
        Log.RegisterLogListing(TopoTopo::MessageLogName, LOCTEXT("MessageLog", "TopoTopo"), Options);

        EnsureExcludes();
        TopoTopo::StartRunner();

        ContentDir = FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir());
        FDirectoryWatcherModule& Watcher = FModuleManager::LoadModuleChecked<FDirectoryWatcherModule>("DirectoryWatcher");
        if (IDirectoryWatcher* Directories = Watcher.Get())
        {
            Directories->RegisterDirectoryChangedCallback_Handle(ContentDir, IDirectoryWatcher::FDirectoryChanged::CreateStatic(&OnContentChanged), WatcherHandle);
        }
        IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
        Registry.OnFilesLoaded().AddStatic(&OnAssetsDiscovered);

        UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateStatic(&RegisterMenus));
        CookAll = IConsoleManager::Get().RegisterConsoleCommand(TEXT("TopoTopo.CookAll"),
            TEXT("TopoTopo.CookAll [force] [wait]: import missing package assets and cook every package. Use force to ignore the record and cache, and wait to finish before the next command."),
            FConsoleCommandWithArgsAndOutputDeviceDelegate::CreateStatic(&CookAllPackages));
        Place = IConsoleManager::Get().RegisterConsoleCommand(TEXT("TopoTopo.PlaceTerrain"),
            TEXT("TopoTopo.PlaceTerrain [package] [save]: place one package by asset name or path, or every package with terrain. Use save to save the level and new assets."),
            FConsoleCommandWithArgsAndOutputDeviceDelegate::CreateStatic(&PlaceTerrain));
    }

    virtual void ShutdownModule() override
    {
        if (CookAll) { IConsoleManager::Get().UnregisterConsoleObject(CookAll); }
        if (Place) { IConsoleManager::Get().UnregisterConsoleObject(Place); }
        if (FDirectoryWatcherModule* Watcher = FModuleManager::GetModulePtr<FDirectoryWatcherModule>("DirectoryWatcher"))
        {
            if (IDirectoryWatcher* Directories = Watcher->Get()) { Directories->UnregisterDirectoryChangedCallback_Handle(ContentDir, WatcherHandle); }
        }
        TopoTopo::StopRunner();
        if (FMessageLogModule* Log = FModuleManager::GetModulePtr<FMessageLogModule>("MessageLog")) { Log->UnregisterLogListing(TopoTopo::MessageLogName); }
    }

private:
    FString ContentDir;
    FDelegateHandle WatcherHandle;
    IConsoleObject* CookAll = nullptr;
    IConsoleObject* Place = nullptr;
};

IMPLEMENT_MODULE(FTopoTopoImportEditorModule, TopoTopoImportEditor)

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoHeadlessCommandsTest, "TopoTopo.Editor.Headless.Commands",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoHeadlessCommandsTest::RunTest(const FString& Parameters)
{
    FStringOutputDevice Output;
    IConsoleManager& Console = IConsoleManager::Get();
    TestTrue(TEXT("CookAll is registered"), Console.ProcessUserConsoleInput(TEXT("TopoTopo.CookAll unknown"), Output, nullptr));
    TestTrue(TEXT("CookAll reports its options"), Output.Contains(TEXT("Usage: TopoTopo.CookAll [force] [wait]")));
    Output.Reset();
    TestTrue(TEXT("PlaceTerrain is registered"), Console.ProcessUserConsoleInput(TEXT("TopoTopo.PlaceTerrain first second"), Output, nullptr));
    TestTrue(TEXT("PlaceTerrain accepts at most one package"), Output.Contains(TEXT("Usage: TopoTopo.PlaceTerrain [package] [save]")));
    Output.Reset();
    const FString Missing = TEXT("/Game/TopoTopo/") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    Console.ProcessUserConsoleInput(*(TEXT("TopoTopo.PlaceTerrain ") + Missing + TEXT(" save")), Output, nullptr);
    TestTrue(TEXT("PlaceTerrain reports that the requested package is missing"), Output.Contains(TEXT("was not found; run TopoTopo.CookAll wait first")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoHeadlessSourcesTest, "TopoTopo.Editor.Headless.Sources",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoHeadlessSourcesTest::RunTest(const FString& Parameters)
{
    const FString Content = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir()) / TEXT("TopoTopo");
    TestFalse(TEXT("A working manifest is eligible"), IsPublishedCopy(Content / TEXT("sets/one/one.topo"), Content));
    TestTrue(TEXT("A workspace dependency copy is skipped"), IsPublishedCopy(Content / TEXT("topotopo-packages/owner/one/1.0/one.topo"), Content));

    UPackage* Outer = CreatePackage(*(TEXT("/Game/TopoTopo/") + FGuid::NewGuid().ToString(EGuidFormats::Digits)));
    UTopoTopoPackage* Package = NewObject<UTopoTopoPackage>(Outer, TEXT("Terrain"));
    TestTrue(TEXT("Select by asset name"), MatchesPackage(*Package, TEXT("terrain")));
    TestTrue(TEXT("Select by object path"), MatchesPackage(*Package, Package->GetPathName()));
    TestTrue(TEXT("Select by package path"), MatchesPackage(*Package, Outer->GetName()));
    TestFalse(TEXT("Unrelated names do not match"), MatchesPackage(*Package, TEXT("Other")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoHeadlessImportTest, "TopoTopo.Editor.Headless.Import",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoHeadlessImportTest::RunTest(const FString& Parameters)
{
    const FString Folder = FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir())
        / (TEXT("TopoTopoTest_") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const FString File = Folder / TEXT("terrain.topo");
    IFileManager& Files = IFileManager::Get();
    Files.MakeDirectory(*Folder, true);
    ON_SCOPE_EXIT
    {
        Files.Delete(*File);
        Files.DeleteDirectory(*Folder);
    };
    if (!TestTrue(TEXT("Write the source manifest"), FFileHelper::SaveStringToFile(TEXT("{\"title\":\"Terrain\",\"graph\":\"main\"}"), *File))) { return false; }
    int32 Failed = 0;
    const TArray<TStrongObjectPtr<UTopoTopoPackage>> Imported = ImportMissingPackages(Folder, {}, Failed);
    TestEqual(TEXT("The import has no failures"), Failed, 0);
    if (!TestEqual(TEXT("Imports the new manifest"), Imported.Num(), 1)) { return false; }
    UTopoTopoPackage* Package = Imported[0].Get();
    TestTrue(TEXT("The factory records the source file"), FPaths::IsSamePath(Package->SourceFile(), File));
    TestTrue(TEXT("An existing source is skipped"), ImportMissingPackages(Folder, { Package }, Failed).IsEmpty() && Failed == 0);
    FAssetRegistryModule::AssetDeleted(Package);
    Package->ClearFlags(RF_Public | RF_Standalone);
    Package->GetOutermost()->SetDirtyFlag(false);
    return true;
}
#endif

#undef LOCTEXT_NAMESPACE
