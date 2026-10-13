// Copyright 2026 faxcorp, Apache-2.0
#include "PCGTopoTopoInstanceSpawnerSettings.h"
#include "MeshSelectors/PCGMeshSelectorByAttribute.h"

UPCGTopoTopoInstanceSpawnerSettings::UPCGTopoTopoInstanceSpawnerSettings(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
    MeshSelectorType = UPCGMeshSelectorByAttribute::StaticClass();
    auto* Selector = ObjectInitializer.CreateDefaultSubobject<UPCGMeshSelectorByAttribute>(this, TEXT("TopoTopoAttributeSelector"));
    Selector->AttributeName = TEXT("MeshPath");
    MeshSelectorParameters = Selector;
}

#if WITH_EDITOR
FText UPCGTopoTopoInstanceSpawnerSettings::GetDefaultNodeTitle() const
{
    return NSLOCTEXT("TopoTopoPCG", "InstanceSpawnerTitle", "TopoTopo Instance Spawner");
}
#endif
