// Copyright 2026 faxcorp, Apache-2.0
#if WITH_DEV_AUTOMATION_TESTS

#include "TopoTopoLandscapeImport.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/Engine.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/SkyLight.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"
#include "Misc/ScopeExit.h"
#include "UObject/Package.h"

// Dogfood finding 25: lighting=1 adds a sun, sky, sky light and fog where the level has none, and never doubles them.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoPreviewLightingTest, "TopoTopo.Editor.PreviewLighting",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoPreviewLightingTest::RunTest(const FString& Parameters)
{
    if (!TestNotNull(TEXT("Engine available"), GEngine)) { return false; }
    UPackage* Package = CreatePackage(*(TEXT("/Temp/TopoTopoLightingTest_") + FGuid::NewGuid().ToString(EGuidFormats::Digits)));
    Package->SetFlags(RF_Transient);
    const UWorld::InitializationValues Init = UWorld::InitializationValues().ShouldSimulatePhysics(false).CreateNavigation(false).CreateAISystem(false);
    UWorld* World = UWorld::CreateWorld(EWorldType::Editor, false, TEXT("TopoTopoLightingWorld"), Package, true, ERHIFeatureLevel::Num, &Init);
    if (!TestNotNull(TEXT("Isolated editor test world"), World)) { return false; }
    World->SetFlags(RF_Transient);
    GEngine->CreateNewWorldContext(EWorldType::Editor).SetCurrentWorld(World);
    ON_SCOPE_EXIT
    {
        World->DestroyWorld(false);
        if (GEngine) { GEngine->DestroyWorldContext(World); }
        Package->SetDirtyFlag(false);
    };
    const auto Count = [World](UClass* Class) { int32 N = 0; for (TActorIterator<AActor> It(World, Class); It; ++It) { ++N; } return N; };

    TestEqual(TEXT("An empty level gets all four actors"), TopoTopoImport::AddPreviewLighting(World, true), 4);
    TestEqual(TEXT("One sun"), Count(ADirectionalLight::StaticClass()), 1);
    TestEqual(TEXT("One sky atmosphere"), Count(ASkyAtmosphere::StaticClass()), 1);
    TestEqual(TEXT("One sky light"), Count(ASkyLight::StaticClass()), 1);
    TestEqual(TEXT("One height fog"), Count(AExponentialHeightFog::StaticClass()), 1);
    for (TActorIterator<ADirectionalLight> It(World); It; ++It)
    {
        const UDirectionalLightComponent* Sun = Cast<UDirectionalLightComponent>(It->GetLightComponent());
        TestTrue(TEXT("The sun drives the sky atmosphere"), Sun && Sun->IsUsedAsAtmosphereSunLight());
        TestTrue(TEXT("The sun is above the horizon"), It->GetActorRotation().Pitch < 0);
    }
    for (TActorIterator<ASkyLight> It(World); It; ++It)
    {
        TestTrue(TEXT("The sky light captures the sky in real time"), It->GetLightComponent() && It->GetLightComponent()->bRealTimeCapture);
    }
    TestEqual(TEXT("A second call adds nothing"), TopoTopoImport::AddPreviewLighting(World, true), 0);
    TestEqual(TEXT("Still one sun"), Count(ADirectionalLight::StaticClass()), 1);
    return !HasAnyErrors();
}

#endif // WITH_DEV_AUTOMATION_TESTS
