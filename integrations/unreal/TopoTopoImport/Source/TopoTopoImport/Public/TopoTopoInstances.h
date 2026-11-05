// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "TopoTopoInstances.generated.h"

class UHierarchicalInstancedStaticMeshComponent;
class UStaticMesh;

/** The placements of one mesh: transforms in the instances asset's own space, in Unreal axes and centimetres. */
USTRUCT(BlueprintType)
struct TOPOTOPOIMPORT_API FTopoTopoInstanceGroup
{
    GENERATED_BODY()

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "TopoTopo")
    TObjectPtr<UStaticMesh> Mesh;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "TopoTopo")
    TArray<FTransform> Transforms;
};

/** A TopoTopo instances output: which meshes go where. Reimporting the package updates it in place. */
UCLASS(BlueprintType)
class TOPOTOPOIMPORT_API UTopoTopoInstances : public UObject
{
    GENERATED_BODY()

public:
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "TopoTopo")
    TArray<FTopoTopoInstanceGroup> Groups;

    /** Changes every time the placements change; actors built from another id build again. */
    UPROPERTY(VisibleAnywhere, Category = "TopoTopo")
    FGuid ContentId;

    /** Every placement of every group. */
    UFUNCTION(BlueprintPure, Category = "TopoTopo")
    int32 NumInstances() const;
};

/** Places a TopoTopo instances asset in a level, one hierarchical instanced static mesh per mesh. */
UCLASS(BlueprintType)
class TOPOTOPOIMPORT_API ATopoTopoInstancesActor : public AActor
{
    GENERATED_BODY()

public:
    ATopoTopoInstancesActor();

    UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "TopoTopo")
    TObjectPtr<UTopoTopoInstances> Instances;

    /** Make the components anew from the asset. */
    UFUNCTION(BlueprintCallable, CallInEditor, Category = "TopoTopo")
    void Rebuild();

    virtual void OnConstruction(const FTransform& Transform) override;

protected:
    UPROPERTY(VisibleAnywhere, Category = "TopoTopo")
    TArray<TObjectPtr<UHierarchicalInstancedStaticMeshComponent>> Components;

    /** The ContentId the components were built from. */
    UPROPERTY()
    FGuid BuiltFrom;
};
