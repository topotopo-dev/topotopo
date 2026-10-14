// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "TopoTopoLandscapeImport.h"
#include "TopoTopoStream.h"

class AActor;
class UStaticMesh;
class UWorld;

namespace TopoTopoImport
{
struct FTileInstances
{
    FLandscapeTile Tile;
    FVector Location = FVector::ZeroVector;
    FTopoTopoStream Stream;
};

// Parse tile CSVs using the shared prototype mapping; require the exact global mesh/transform multiset.
bool ReadTileInstances(const FLandscapeData& Data, const FTopoTopoStreamOptions& Options,
    const FTopoTopoStream& Global, TArray<FTileInstances>& Out, FString& Error);

// One independent spatial actor per tile, with world-space transforms and a HISM per used prototype.
// No references or attachments to the Landscape: those would couple World Partition streaming cells.
AActor* SpawnTileInstances(UWorld* World, const FTileInstances& Tile,
    const TMap<FString, UStaticMesh*>& Prototypes, const FString& Label, bool bTransient, FString& Error);
}
