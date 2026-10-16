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

// Imports one glTF/GLB through Interchange into Folder. With PrototypeName, the static mesh is named after it and
// stays at Folder/<PrototypeName>; materials and textures go to Folder/Materials and Folder/Textures.
bool ImportGLB(const FString& File, const FString& Folder, const FString& PrototypeName,
    TArray<class UStaticMesh*>& OutMeshes, FString& Error);

// Sun (atmosphere sun light), sky atmosphere, real-time sky light and height fog, each only when the level has none of
// that kind (the "lighting=1" import option). Returns how many actors were added.
int32 AddPreviewLighting(UWorld* World, bool bTransient = false);
}
