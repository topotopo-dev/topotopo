// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoRunner.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Containers/Ticker.h"
#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "InterchangeManager.h"
#include "Misc/Paths.h"
#include "Misc/ScopedSlowTask.h"
#include "TopoTopoCook.h"
#include "TopoTopoImporter.h"
#include "TopoTopoPackage.h"

#define LOCTEXT_NAMESPACE "TopoTopoImport"

namespace
{
    /** Seconds a package's files must stay quiet before its background cook. */
    constexpr double SettleSeconds = 0.5;

    FTSTicker::FDelegateHandle Tick;
    /** The background cook, and the packages waiting for one with when they last changed. */
    TUniquePtr<TopoTopo::FCookProcess> Live;
    TMap<FString, double> Waiting;

    /** Whether importing now would not get in anyone's way. */
    bool EditorIsFree()
    {
        return GEditor && !GEditor->PlayWorld && !GIsSlowTask && !GIsSavingPackage()
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
        if (UTopoTopoPackage* Package = PackageOf(Done->Topo()))
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
        if (Waiting.IsEmpty() || !EditorIsFree()) { return true; }
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
        if (UTopoTopoPackage* Package = Cast<UTopoTopoPackage>(Asset.GetAsset())) { Packages.Add(Package); }
    }
    return Packages;
}

void TopoTopo::CookLater(const FString& Topo)
{
    Waiting.Add(Topo, FPlatformTime::Seconds());
}

bool TopoTopo::CookNow(UTopoTopoPackage* Package, bool bForce)
{
    const FString Topo = Package->SourceFile();
    if (Topo.IsEmpty() || !FPaths::FileExists(Topo))
    {
        FailCook(Package, FString::Printf(TEXT("its source file %s is not there"), *Topo));
        return false;
    }
    FScopedSlowTask Task(100.f, FText::Format(LOCTEXT("Cooking", "TopoTopo: cooking {0}"), FText::FromString(Package->GetName())));
    Task.MakeDialog(true);
    // a background cook first: one cook at a time for a package's record
    if (Live)
    {
        while (Live->Poll()) { FPlatformProcess::Sleep(0.03f); }
        const TUniquePtr<FCookProcess> Done = MoveTemp(Live);
        if (UTopoTopoPackage* Other = PackageOf(Done->Topo()); Other && Other != Package)
        {
            ApplyCook(Other, Done->ExitCode(), Done->ReportFile(), Done->Errors(), false);
        }
    }
    Waiting.Remove(Topo);

    FCookProcess Process;
    FString Error;
    if (!Process.Start(Topo, bForce, Error))
    {
        FailCook(Package, Error);
        return false;
    }
    float Shown = 0.f;
    while (Process.Poll())
    {
        if (Task.ShouldCancel())
        {
            Process.Cancel();
            FailCook(Package, TEXT("the cook was cancelled; the last good assets stay"));
            return false;
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
    Waiting.Reset();
    StopViewers();
}

#undef LOCTEXT_NAMESPACE
