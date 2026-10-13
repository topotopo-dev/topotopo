// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"

class FJsonObject;

namespace TopoTopoLandscape
{
struct FWeightLayer
{
    FName Name;
    FString AssetName;
    FString Filename;
    double Min = 0;
    double Max = 1;
    FString Encoding;
    TArray<uint8> Weights;
};

/** Decode the stored grey bytes without gamma correction, rescaling or alpha multiplication. */
bool DecodeWeightPNG(const TArray<uint8>& Bytes, int32 Width, int32 Height, TArray<uint8>& Out, FString& Error);

/** Validate/decode in manifest order before creating assets; missing layers is valid for older bundles.
 * AssetName includes the LI_ prefix; Filename is absolute. Failure leaves Out empty.
 */
bool ReadWeightLayers(const TSharedPtr<FJsonObject>& Manifest, const FString& Directory, int32 Width,
    int32 Height, TArray<FWeightLayer>& Out, FString& Error);
}
