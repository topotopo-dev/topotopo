// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "ActorFactories/ActorFactory.h"
#include "CoreMinimal.h"
#include "TopoTopoActorFactory.generated.h"

/** Dragging a TopoTopo Instances asset into a level makes a TopoTopo Instances actor. */
UCLASS(MinimalAPI, config = Editor)
class UTopoTopoInstancesActorFactory : public UActorFactory
{
    GENERATED_BODY()

public:
    UTopoTopoInstancesActorFactory();

    virtual bool CanCreateActorFrom(const FAssetData& AssetData, FText& OutErrorMsg) override;
    virtual void PostSpawnActor(UObject* Asset, AActor* NewActor) override;
    virtual void PostCreateBlueprint(UObject* Asset, AActor* CDO) override;
    virtual UObject* GetAssetFromActorInstance(AActor* ActorInstance) override;
};
