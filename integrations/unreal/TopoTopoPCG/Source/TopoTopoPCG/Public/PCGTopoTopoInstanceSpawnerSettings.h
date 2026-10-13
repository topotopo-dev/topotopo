// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "Elements/PCGStaticMeshSpawner.h"
#include "PCGTopoTopoInstanceSpawnerSettings.generated.h"

/** Native PCG spawner, with TopoTopo's MeshPath attribute selected by default. */
UCLASS(BlueprintType, ClassGroup = (Procedural))
class TOPOTOPOPCG_API UPCGTopoTopoInstanceSpawnerSettings : public UPCGStaticMeshSpawnerSettings
{
    GENERATED_BODY()
public:
    UPCGTopoTopoInstanceSpawnerSettings(const FObjectInitializer& ObjectInitializer);
#if WITH_EDITOR
    virtual FName GetDefaultNodeName() const override { return TEXT("TopoTopoInstanceSpawner"); }
    virtual FText GetDefaultNodeTitle() const override;
#endif
};
