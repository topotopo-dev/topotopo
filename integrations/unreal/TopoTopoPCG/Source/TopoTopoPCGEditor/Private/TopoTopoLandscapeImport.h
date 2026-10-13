// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "TopoTopoLandscapeLayers.h"

class ALandscape;
class UWorld;

namespace TopoTopoImport
{
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
};

// Validate/decode everything before creating assets or touching a level. layers=0 bypasses the weight files.
bool ReadLandscape(const FString& Directory, FLandscapeData& Out, FString& Error, bool bLayers = true);

// Shared by the scene command and the isolated editor acceptance test. Transient mode registers/saves no assets.
ALandscape* ImportLandscape(UWorld* World, const FLandscapeData& Data, const FString& Destination,
    bool bMaterial, bool bTransient, FString& Error);
}
