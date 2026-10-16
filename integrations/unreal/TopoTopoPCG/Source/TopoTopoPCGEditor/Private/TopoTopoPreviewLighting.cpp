// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoLandscapeImport.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/SkyLight.h"
#include "Engine/World.h"
#include "EngineUtils.h"

namespace TopoTopoImport
{
// Dogfood finding 25 (2026-10-15): an imported scene in a fresh level showed a black sky and flat light. This adds the
// four actors of Unreal's own "Basic" level, each only when the level has none of that kind, so it never doubles up a
// lit level. The sun is the atmosphere sun light (it drives the sky colour), the sky light captures the sky in real time.
int32 AddPreviewLighting(UWorld* World, bool bTransient)
{
    if (!World) { return 0; }
    const auto Has = [World](UClass* Class) { return static_cast<bool>(TActorIterator<AActor>(World, Class)); };
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = bTransient ? RF_Transient : RF_Transactional;
    Spawn.OverrideLevel = World->GetCurrentLevel();
    int32 Added = 0;
    if (!Has(ADirectionalLight::StaticClass()))
    {
        // late-morning sun from the south-east: long enough shadows to read the terrain, warm enough to look like day
        if (ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector(0, 0, 50000), FRotator(-38, 135, 0), Spawn))
        {
            Sun->SetActorLabel(TEXT("TopoTopo_Sun"));
            if (UDirectionalLightComponent* Light = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
            {
                Light->SetMobility(EComponentMobility::Movable);
                Light->SetIntensity(10.0f);
                Light->SetAtmosphereSunLight(true);
            }
            ++Added;
        }
    }
    if (!Has(ASkyAtmosphere::StaticClass()))
    {
        if (ASkyAtmosphere* Sky = World->SpawnActor<ASkyAtmosphere>(FVector::ZeroVector, FRotator::ZeroRotator, Spawn))
        {
            Sky->SetActorLabel(TEXT("TopoTopo_SkyAtmosphere"));
            ++Added;
        }
    }
    if (!Has(ASkyLight::StaticClass()))
    {
        if (ASkyLight* SkyLight = World->SpawnActor<ASkyLight>(FVector(0, 0, 10000), FRotator::ZeroRotator, Spawn))
        {
            SkyLight->SetActorLabel(TEXT("TopoTopo_SkyLight"));
            if (USkyLightComponent* Light = SkyLight->GetLightComponent())
            {
                Light->SetMobility(EComponentMobility::Movable);
                Light->SetRealTimeCapture(true);
            }
            ++Added;
        }
    }
    if (!Has(AExponentialHeightFog::StaticClass()))
    {
        if (AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>(FVector::ZeroVector, FRotator::ZeroRotator, Spawn))
        {
            Fog->SetActorLabel(TEXT("TopoTopo_HeightFog"));
            if (UExponentialHeightFogComponent* F = Fog->GetComponent()) { F->SetFogDensity(0.005f); }
            ++Added;
        }
    }
    return Added;
}
}
