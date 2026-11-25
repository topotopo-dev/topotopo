// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoTileInstances.h"

#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Components/SceneComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "ObjectTools.h"

namespace TopoTopoImport
{
static FString InstanceKey(const FTopoTopoStreamRow& Row)
{
    const FTopoTopoAttributeValue* Mesh = Row.Attributes.Find(TEXT("Mesh"));
    if (!Mesh || Mesh->StringValue.IsEmpty()) { return FString(); }
    const FVector P = Row.Transform.GetTranslation(), S = Row.Transform.GetScale3D();
    const FQuat Q = Row.Transform.GetRotation();
    return FString::Printf(TEXT("%d:%s|%.17g,%.17g,%.17g|%.17g,%.17g,%.17g,%.17g|%.17g,%.17g,%.17g"),
        Mesh->StringValue.Len(), *Mesh->StringValue, P.X, P.Y, P.Z, Q.X, Q.Y, Q.Z, Q.W, S.X, S.Y, S.Z);
}

bool ReadTileInstances(const FLandscapeData& Data, const FTopoTopoStreamOptions& Options,
    const FTopoTopoStream& Global, TArray<FTileInstances>& Out, FString& Error)
{
    Out.Reset();
    Error.Reset();
    if (Data.Tiles.IsEmpty()) { return true; }
    TMap<FString, int32> Remaining;
    for (const FTopoTopoStreamRow& Row : Global.Rows)
    {
        const FString Key = InstanceKey(Row);
        if (Key.IsEmpty()) { Error = TEXT("Every global instance requires a Mesh name."); return false; }
        ++Remaining.FindOrAdd(Key);
    }
    TArray<FTileInstances> Parsed;
    int64 Total = 0;
    for (const FLandscapeTile& Tile : Data.Tiles)
    {
        FTileInstances& Item = Parsed.Emplace_GetRef();
        Item.Tile = Tile;
        Item.Location = Data.Location + Tile.WorldOffset +
            FVector(Data.TileSizeQuads * Data.Scale.X * 0.5, Data.TileSizeQuads * Data.Scale.Y * 0.5, 0);
        if (!Tile.InstancesCSV.IsEmpty() && !TopoTopoStream::LoadFile(Tile.InstancesCSV, Options, Item.Stream, Error)) { return false; }
        if (Item.Stream.Rows.Num() != Tile.InstanceCount)
        {
            Error = TEXT("Tile instance CSV count differs from its manifest.");
            return false;
        }
        Total += Item.Stream.Rows.Num();
        for (const FTopoTopoStreamRow& Row : Item.Stream.Rows)
        {
            const FString Key = InstanceKey(Row);
            int32* Count = Remaining.Find(Key);
            if (!Count || *Count <= 0)
            {
                Error = TEXT("Tile instance CSVs duplicate or change a mesh/transform from the global stream.");
                return false;
            }
            --*Count;
        }
    }
    if (Total != Global.Rows.Num())
    {
        Error = TEXT("Tile instance counts do not sum to the global stream count.");
        return false;
    }
    Out = MoveTemp(Parsed);
    return true;
}

AActor* SpawnTileInstances(UWorld* World, const FTileInstances& Tile,
    const TMap<FString, UStaticMesh*>& Prototypes, const FString& Label, bool bTransient, FString& Error)
{
    TMap<FString, TArray<FTransform>> Groups;
    for (const FTopoTopoStreamRow& Row : Tile.Stream.Rows)
    {
        const FTopoTopoAttributeValue* Mesh = Row.Attributes.Find(TEXT("Mesh"));
        if (!Mesh || !Prototypes.FindRef(Mesh->StringValue))
        {
            Error = TEXT("Tile instance has no imported Static Mesh prototype.");
            return nullptr;
        }
        Groups.FindOrAdd(Mesh->StringValue).Add(Row.Transform);
    }
    if (!World) { Error = TEXT("Tile instance placement requires a world."); return nullptr; }
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = bTransient ? RF_Transient : RF_Transactional;
    Spawn.OverrideLevel = World->GetCurrentLevel();
    AActor* Actor = World->SpawnActor<AActor>(Tile.Location, FRotator::ZeroRotator, Spawn);
    if (!Actor) { Error = TEXT("Could not create tile instance actor."); return nullptr; }
    Actor->SetActorLabel(FString::Printf(TEXT("%s_Tile_%d_%d"), *Label, Tile.Tile.GridPosition.X, Tile.Tile.GridPosition.Y));
    Actor->SetIsSpatiallyLoaded(true);
    USceneComponent* Root = NewObject<USceneComponent>(Actor, TEXT("Root"), Spawn.ObjectFlags);
    Actor->SetRootComponent(Root);
    Actor->AddInstanceComponent(Root);
    Root->SetMobility(EComponentMobility::Static);
    Root->RegisterComponent();
    // A root created after SpawnActor must explicitly receive the intended transform.
    Actor->SetActorLocation(Tile.Location);
    TArray<FString> Names;
    Groups.GetKeys(Names);
    Names.Sort();
    for (const FString& Name : Names)
    {
        UHierarchicalInstancedStaticMeshComponent* Component = NewObject<UHierarchicalInstancedStaticMeshComponent>(Actor,
            MakeUniqueObjectName(Actor, UHierarchicalInstancedStaticMeshComponent::StaticClass(),
                FName(*ObjectTools::SanitizeObjectName(Name))), Spawn.ObjectFlags);
        Actor->AddInstanceComponent(Component);
        Component->SetupAttachment(Root);
        Component->SetStaticMesh(Prototypes.FindChecked(Name));
        Component->SetMobility(EComponentMobility::Static);
        Component->RegisterComponent();
        Component->AddInstances(Groups.FindChecked(Name), false, true);
    }
    if (!bTransient) { Actor->MarkPackageDirty(); }
    return Actor;
}
}
