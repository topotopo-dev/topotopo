// Copyright 2026 faxcorp, Apache-2.0
#include "AssetRegistry/AssetRegistryModule.h"
#include "ContentBrowserMenuContexts.h"
#include "DirectoryWatcherModule.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "IDirectoryWatcher.h"
#include "MessageLogModule.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Settings/EditorLoadingSavingSettings.h"
#include "ToolMenus.h"
#include "TopoTopoCook.h"
#include "TopoTopoImporter.h"
#include "TopoTopoImportSettings.h"
#include "TopoTopoPackage.h"
#include "TopoTopoRunner.h"

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
            Add(TEXT("TopoTopoTerrain"), LOCTEXT("Terrain", "Place Terrain in Level"), LOCTEXT("TerrainTip", "Place the package's terrain outputs in the open level (needs the TopoTopoPCG plugin)."), &UTopoTopoPackage::PlaceTerrainInLevel);
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
            TEXT("Cook every TopoTopo package of the project now. TopoTopo.CookAll force: every output again, ignoring the record and the cache."),
            FConsoleCommandWithArgsDelegate::CreateLambda([](const TArray<FString>& Args)
            {
                const bool bForce = Args.Contains(TEXT("force"));
                for (UTopoTopoPackage* Package : TopoTopo::AllPackages()) { TopoTopo::CookNow(Package, bForce); }
            }));
    }

    virtual void ShutdownModule() override
    {
        if (CookAll) { IConsoleManager::Get().UnregisterConsoleObject(CookAll); }
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
};

IMPLEMENT_MODULE(FTopoTopoImportEditorModule, TopoTopoImportEditor)

#undef LOCTEXT_NAMESPACE
