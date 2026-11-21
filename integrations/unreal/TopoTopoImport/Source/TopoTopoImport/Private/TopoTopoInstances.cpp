// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoInstances.h"

#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Components/SceneComponent.h"
#include "Engine/StaticMesh.h"

int32 UTopoTopoInstances::NumInstances() const
{
    int32 N = 0;
    for (const FTopoTopoInstanceGroup& Group : Groups) { N += Group.Transforms.Num(); }
    return N;
}

ATopoTopoInstancesActor::ATopoTopoInstancesActor()
{
    PrimaryActorTick.bCanEverTick = false;
    USceneComponent* Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
    Root->SetMobility(EComponentMobility::Static);
    RootComponent = Root;
}

void ATopoTopoInstancesActor::OnConstruction(const FTransform& Transform)
{
    Super::OnConstruction(Transform);
    // the asset changed while the level was closed, or the asset was just set
    const bool bStale = Instances ? BuiltFrom != Instances->ContentId || Components.IsEmpty() : !Components.IsEmpty();
    if (bStale && !IsTemplate()) { Rebuild(); }
}

void ATopoTopoInstancesActor::Rebuild()
{
    Modify();
    for (UHierarchicalInstancedStaticMeshComponent* Component : Components)
    {
        if (Component)
        {
            RemoveInstanceComponent(Component);
            Component->DestroyComponent();
        }
    }
    Components.Reset();
    BuiltFrom.Invalidate();
    if (!Instances) { return; }
    BuiltFrom = Instances->ContentId;
    for (const FTopoTopoInstanceGroup& Group : Instances->Groups)
    {
        if (!Group.Mesh || Group.Transforms.IsEmpty()) { continue; }
        const FName Name = MakeUniqueObjectName(this, UHierarchicalInstancedStaticMeshComponent::StaticClass(), Group.Mesh->GetFName());
        UHierarchicalInstancedStaticMeshComponent* Component = NewObject<UHierarchicalInstancedStaticMeshComponent>(this, Name, RF_Transactional);
        AddInstanceComponent(Component);
        Component->SetupAttachment(GetRootComponent());
        Component->SetStaticMesh(Group.Mesh);
        Component->SetMobility(EComponentMobility::Static);
        Component->RegisterComponent();
        Component->AddInstances(Group.Transforms, /*bShouldReturnIndices*/ false, /*bWorldSpace*/ false);
        Components.Add(Component);
    }
}
