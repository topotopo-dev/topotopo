// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "PCGSettings.h"
#include "TopoTopoStream.h"
#include "PCGTopoTopoPointStreamSettings.generated.h"

class UPCGPointArrayData;
class UStaticMesh;

/** Read external CSV / points.json into world-space PCG points. */
UCLASS(BlueprintType, ClassGroup = (Procedural))
class TOPOTOPOPCG_API UPCGTopoTopoPointStreamSettings : public UPCGSettings
{
    GENERATED_BODY()

public:
#if WITH_EDITOR
    virtual FName GetDefaultNodeName() const override { return TEXT("TopoTopoPointStream"); }
    virtual FText GetDefaultNodeTitle() const override;
    virtual FText GetNodeTooltipText() const override;
    virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::InputOutput; }
#endif

    /** Absolute path or path relative to the directory containing the .uproject. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Stream", meta = (PCG_Overridable))
    FString FilePath;

    /** Reload on each graph generation. No background watcher: click Generate after editing the file. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Stream")
    bool bReimportOnChange = true;

    /** AsWritten for PCG CSV; FromTopoTopoYUp for native points.json / P.x,y,z CSV. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Stream", meta = (PCG_Overridable))
    ETopoTopoCoordinateMode CoordinateMode = ETopoTopoCoordinateMode::AsWritten;

    /** Empty uses Seed/seed, then the same point-index hash as the CSV exporter. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Stream")
    FString SeedColumn;

    /** Empty uses Density/density, then 1. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Stream")
    FString DensityColumn;

    /** Exact metadata names, case sensitive. Empty means all. Native point properties are always loaded. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Attributes")
    TArray<FString> AttributeInclude;

    /** Exact names; exclusion wins. Keep MeshPath to use the instance spawner. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Attributes")
    TArray<FString> AttributeExclude;

    /** A sidecar mesh called pine resolves to <folder>/pine.pine. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Meshes", meta = (ContentDir))
    FString MeshFolder = TEXT("/Game/TopoTopo/PluginDemo/Meshes");

    /** Explicit per-name assets override folder/name resolution. Also works without a sidecar. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Meshes")
    TMap<FString, TSoftObjectPtr<UStaticMesh>> MeshMapping;

    FTopoTopoStreamOptions GetStreamOptions() const;

protected:
    virtual TArray<FPCGPinProperties> InputPinProperties() const override { return {}; }
    virtual TArray<FPCGPinProperties> OutputPinProperties() const override { return DefaultPointOutputPinProperties(); }
    virtual FPCGElementPtr CreateElement() const override;
};

namespace TopoTopoPCG
{
    /** Shared by the PCG element and automation tests; caller must be on the game thread. */
    TOPOTOPOPCG_API UPCGPointArrayData* CreatePointData(const FTopoTopoStream& Stream, UObject* Outer = nullptr);
}
