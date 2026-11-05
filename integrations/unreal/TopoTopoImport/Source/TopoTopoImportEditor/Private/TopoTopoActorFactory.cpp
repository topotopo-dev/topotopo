// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoActorFactory.h"

#include "AssetRegistry/AssetData.h"
#include "TopoTopoInstances.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(TopoTopoActorFactory)

UTopoTopoInstancesActorFactory::UTopoTopoInstancesActorFactory()
{
    DisplayName = NSLOCTEXT("TopoTopoImport", "InstancesActor", "TopoTopo Instances");
    NewActorClass = ATopoTopoInstancesActor::StaticClass();
}

bool UTopoTopoInstancesActorFactory::CanCreateActorFrom(const FAssetData& AssetData, FText& OutErrorMsg)
{
    if (AssetData.IsValid() && AssetData.IsInstanceOf(UTopoTopoInstances::StaticClass())) { return true; }
    OutErrorMsg = NSLOCTEXT("TopoTopoImport", "NoInstances", "A TopoTopo Instances asset must be given.");
    return false;
}

void UTopoTopoInstancesActorFactory::PostSpawnActor(UObject* Asset, AActor* NewActor)
{
    Super::PostSpawnActor(Asset, NewActor);
    if (ATopoTopoInstancesActor* Actor = Cast<ATopoTopoInstancesActor>(NewActor))
    {
        Actor->Instances = Cast<UTopoTopoInstances>(Asset);
        Actor->Rebuild();
    }
}

void UTopoTopoInstancesActorFactory::PostCreateBlueprint(UObject* Asset, AActor* CDO)
{
    if (ATopoTopoInstancesActor* Actor = Cast<ATopoTopoInstancesActor>(CDO)) { Actor->Instances = Cast<UTopoTopoInstances>(Asset); }
}

UObject* UTopoTopoInstancesActorFactory::GetAssetFromActorInstance(AActor* ActorInstance)
{
    const ATopoTopoInstancesActor* Actor = Cast<ATopoTopoInstancesActor>(ActorInstance);
    return Actor ? Actor->Instances : nullptr;
}
