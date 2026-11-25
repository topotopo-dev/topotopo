// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoRunner.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Containers/Ticker.h"
#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "FileHelpers.h"
#include "InterchangeManager.h"
#include "Misc/App.h"
#include "Misc/Paths.h"
#include "Misc/ScopedSlowTask.h"
#include "TopoTopoCook.h"
#include "TopoTopoImporter.h"
#include "TopoTopoPackage.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

#define LOCTEXT_NAMESPACE "TopoTopoImport"

namespace
{
    /** Seconds a package's files must stay quiet before its background cook. */
    constexpr double SettleSeconds = 0.5;

    FTSTicker::FDelegateHandle Tick;
    /** The background cook, and the packages waiting for one with when they last changed. */
    TUniquePtr<TopoTopo::FCookProcess> Live;
    TMap<FString, double> Waiting;

    struct FCommandCook
    {
        TStrongObjectPtr<UTopoTopoPackage> Package;
        bool bForce;
        bool bImported;
    };
    TArray<FCommandCook> CommandQueue;
    TOptional<FCommandCook> LiveCommand;

    /** Whether importing now would not get in anyone's way. */
    bool EditorIsFree()
    {
        // an import inside someone's transaction would land in their undo step
        return GEditor && !GEditor->PlayWorld && !GIsSlowTask && !UE::IsSavingPackage() && !GEditor->IsTransactionActive()
            && !(FSlateApplication::IsInitialized() && FSlateApplication::Get().GetActiveModalWindow().IsValid())
            && !UInterchangeManager::GetInterchangeManager().IsInterchangeActive();
    }

    UTopoTopoPackage* PackageOf(const FString& Topo)
    {
        for (UTopoTopoPackage* Package : TopoTopo::AllPackages())
        {
            if (FPaths::IsSamePath(Package->SourceFile(), Topo)) { return Package; }
        }
        return nullptr;
    }

    void FinishLive()
    {
        const TUniquePtr<TopoTopo::FCookProcess> Done = MoveTemp(Live);
        if (LiveCommand)
        {
            const FCommandCook Request = MoveTemp(LiveCommand.GetValue());
            LiveCommand.Reset();
            UTopoTopoPackage* Package = Request.Package.Get();
            const TopoTopo::FCookResult Result = TopoTopo::ApplyCook(Package, Done->ExitCode(), Done->ReportFile(), Done->Errors(), Request.bForce);
            TopoTopo::ReportCommandCook(Package, Result, Request.bImported);
        }
        else if (UTopoTopoPackage* Package = PackageOf(Done->Topo()))
        {
            TopoTopo::ApplyCook(Package, Done->ExitCode(), Done->ReportFile(), Done->Errors(), false);
        }
    }

    bool OnTick(float)
    {
        TopoTopo::PollViewers();
        if (Live)
        {
            if (!Live->Poll() && EditorIsFree()) { FinishLive(); }
            return true;
        }
        if ((CommandQueue.IsEmpty() && Waiting.IsEmpty()) || !EditorIsFree()) { return true; }
        if (!CommandQueue.IsEmpty())
        {
            FCommandCook Request = MoveTemp(CommandQueue[0]);
            CommandQueue.RemoveAt(0);
            UTopoTopoPackage* Package = Request.Package.Get();
            const FString Topo = Package->SourceFile();
            Waiting.Remove(Topo);
            FString Error;
            TUniquePtr<TopoTopo::FCookProcess> Process = MakeUnique<TopoTopo::FCookProcess>();
            if (Topo.IsEmpty() || !FPaths::FileExists(Topo))
            {
                Error = FString::Printf(TEXT("its source file %s is not there"), *Topo);
            }
            else if (Process->Start(Topo, Request.bForce, Error))
            {
                Live = MoveTemp(Process);
                LiveCommand.Emplace(MoveTemp(Request));
                return true;
            }
            TopoTopo::ReportCommandCook(Package, TopoTopo::FailCook(Package, Error), Request.bImported);
            return true;
        }
        const double Now = FPlatformTime::Seconds();
        for (auto It = Waiting.CreateIterator(); It; ++It)
        {
            if (Now - It->Value < SettleSeconds) { continue; }
            const FString Topo = It->Key;
            It.RemoveCurrent();
            UTopoTopoPackage* Package = PackageOf(Topo);
            if (!Package) { continue; }
            FString Error;
            TUniquePtr<TopoTopo::FCookProcess> Process = MakeUnique<TopoTopo::FCookProcess>();
            if (Process->Start(Topo, false, Error)) { Live = MoveTemp(Process); }
            else { TopoTopo::FailCook(Package, Error); }
            break;
        }
        return true;
    }
}

TArray<UTopoTopoPackage*> TopoTopo::AllPackages()
{
    TArray<FAssetData> Assets;
    FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get().GetAssetsByClass(UTopoTopoPackage::StaticClass()->GetClassPathName(), Assets);
    TArray<UTopoTopoPackage*> Packages;
    for (const FAssetData& Asset : Assets)
    {
        if (Asset.PackageName.ToString().StartsWith(TEXT("/Game/")))
        {
            if (UTopoTopoPackage* Package = Cast<UTopoTopoPackage>(Asset.GetAsset())) { Packages.Add(Package); }
        }
    }
    return Packages;
}

void TopoTopo::CookLater(const FString& Topo)
{
    Waiting.Add(Topo, FPlatformTime::Seconds());
}

void TopoTopo::QueueCommandCook(UTopoTopoPackage* Package, bool bForce, bool bImported)
{
    CommandQueue.Add({ TStrongObjectPtr<UTopoTopoPackage>(Package), bForce, bImported });
}

TopoTopo::ECookState TopoTopo::ReportCommandCook(UTopoTopoPackage* Package, FCookResult Result, bool bImported)
{
    if (Package->GetOutermost()->IsDirty() && !UEditorLoadingAndSavingUtils::SavePackages({ Package->GetOutermost() }, true))
    {
        if (Result.State != ECookState::Failed) { Result = { ECookState::Failed, TEXT("the package asset could not be saved") }; }
    }
    if (Result.State == ECookState::Failed)
    {
        const FString Reason = Result.Reason.Replace(TEXT("\r"), TEXT(" ")).Replace(TEXT("\n"), TEXT(" "));
        UE_LOG(LogTopoTopo, Display, TEXT("TopoTopo: %s: failed: %s"), *Package->GetPathName(), *Reason);
    }
    else
    {
        const TCHAR* Outcome = bImported ? TEXT("imported") : Result.State == ECookState::Cooked ? TEXT("cooked") : TEXT("unchanged");
        UE_LOG(LogTopoTopo, Display, TEXT("TopoTopo: %s: %s"), *Package->GetPathName(), Outcome);
    }
    return Result.State;
}

TopoTopo::FCookResult TopoTopo::CookNow(UTopoTopoPackage* Package, bool bForce)
{
    const FString Topo = Package->SourceFile();
    if (Topo.IsEmpty() || !FPaths::FileExists(Topo))
    {
        return FailCook(Package, FString::Printf(TEXT("its source file %s is not there"), *Topo));
    }
    FScopedSlowTask Task(100.f, FText::Format(LOCTEXT("Cooking", "TopoTopo: cooking {0}"), FText::FromString(Package->GetName())));
    if (!FApp::IsUnattended()) { Task.MakeDialog(true); }
    // one cook at a time: a background cook is ended, not waited for; its package cooks again later (this one now)
    if (Live)
    {
        const FString Other = Live->Topo();
        Live->Cancel();
        Live.Reset();
        if (LiveCommand)
        {
            CommandQueue.Insert(MoveTemp(LiveCommand.GetValue()), 0);
            LiveCommand.Reset();
        }
        else if (!FPaths::IsSamePath(Other, Topo)) { CookLater(Other); }
        UE_LOG(LogTopoTopo, Log, TEXT("TopoTopo: ended the background cook of %s for %s"), *Other, *Topo);
    }
    Waiting.Remove(Topo);

    FCookProcess Process;
    FString Error;
    if (!Process.Start(Topo, bForce, Error))
    {
        return FailCook(Package, Error);
    }
    float Shown = 0.f;
    while (Process.Poll())
    {
        if (Task.ShouldCancel())
        {
            Process.Cancel();
            return FailCook(Package, TEXT("the cook was cancelled; the last good assets stay"));
        }
        const float Now = Process.Total() > 0 ? 80.f * Process.Done() / Process.Total() : 0.f;
        Task.EnterProgressFrame(Now - Shown, Process.Current().IsEmpty() ? FText::GetEmpty() : FText::Format(LOCTEXT("CookingOutput", "TopoTopo: cooked {0}"), FText::FromString(Process.Current())));
        Shown = Now;
        FPlatformProcess::Sleep(0.03f);
    }
    Task.EnterProgressFrame(0.f, LOCTEXT("Importing", "TopoTopo: importing"));
    return ApplyCook(Package, Process.ExitCode(), Process.ReportFile(), Process.Errors(), bForce);
}

void TopoTopo::StartRunner()
{
    Tick = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateStatic(&OnTick), 0.1f);
}

void TopoTopo::StopRunner()
{
    FTSTicker::RemoveTicker(Tick);
    Live.Reset();
    LiveCommand.Reset();
    CommandQueue.Reset();
    Waiting.Reset();
    StopViewers();
}

#undef LOCTEXT_NAMESPACE
