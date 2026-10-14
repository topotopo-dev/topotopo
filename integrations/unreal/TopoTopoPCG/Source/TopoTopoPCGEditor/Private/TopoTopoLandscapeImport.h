// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "TopoTopoLandscapeLayers.h"

class ALandscape;
class UWorld;

namespace TopoTopoImport
{
struct FLandscapeTile
{
    FIntPoint GridPosition = FIntPoint::ZeroValue;
    FIntPoint SampleMin = FIntPoint::ZeroValue;
    FIntPoint SampleMax = FIntPoint::ZeroValue;
    FVector WorldOffset = FVector::ZeroVector;
    FString InstancesCSV;
    int32 InstanceCount = 0;
};

struct FLandscapeData
{
    FString Filename;
    int32 Width = 0;
    int32 Height = 0;
    int32 Sections = 0;
    int32 Quads = 0;
    FVector Location = FVector::ZeroVector;
    FVector Scale = FVector::OneVector;
    TArray<uint16> Heights;
    TArray<TopoTopoLandscape::FWeightLayer> WeightLayers;
    int32 TileSizeQuads = 0;
    FIntPoint TileGrid = FIntPoint::ZeroValue;
    TArray<FLandscapeTile> Tiles;
};

// Validate/decode everything before creating assets or touching a level. layers=0 bypasses the weight files.
bool ReadLandscape(const FString& Directory, FLandscapeData& Out, FString& Error, bool bLayers = true,
    bool bDecodeHeightmap = true);

// Shared by the scene command and the isolated editor acceptance test. Transient mode registers/saves no assets.
ALandscape* ImportLandscape(UWorld* World, const FLandscapeData& Data, const FString& Destination,
    bool bMaterial, bool bTransient, FString& Error);
}
