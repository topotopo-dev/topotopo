// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "UObject/SoftObjectPath.h"
#include "TopoTopoStream.generated.h"

/** PCG CSV has already been converted. Native points.json normally needs FromTopoTopoYUp. */
UENUM(BlueprintType)
enum class ETopoTopoCoordinateMode : uint8
{
    AsWritten,
    FromTopoTopoYUp
};

enum class ETopoTopoAttributeType : uint8
{
    Float, Integer, String, Vector2, Vector, Vector4
};

struct FTopoTopoAttributeValue
{
    ETopoTopoAttributeType Type = ETopoTopoAttributeType::Float;
    double FloatValue = 0;
    int64 IntValue = 0;
    FString StringValue;
    FVector4 VectorValue = FVector4(0, 0, 0, 0);
};

struct FTopoTopoStreamRow
{
    FTransform Transform = FTransform::Identity;
    float Density = 1;
    int32 Seed = 0;
    FVector4 Color = FVector4(1, 1, 1, 1);
    TMap<FString, FTopoTopoAttributeValue> Attributes;
};

struct FTopoTopoStreamOptions
{
    ETopoTopoCoordinateMode CoordinateMode = ETopoTopoCoordinateMode::AsWritten;
    /** Empty means the stream's standard Seed/seed and Density/density columns. */
    FString SeedColumn;
    FString DensityColumn;
    /** Exact, case-sensitive attribute names. Empty include means all; exclude wins. */
    TArray<FString> AttributeInclude;
    TArray<FString> AttributeExclude;
    FString MeshFolder = TEXT("/Game/TopoTopo/Demo");
    /** Explicit mappings override sidecar folder/name paths; no asset is loaded by the parser. */
    TMap<FString, FSoftObjectPath> MeshMapping;
};

struct FTopoTopoStream
{
    TArray<FTopoTopoStreamRow> Rows;
    /** Sorted names, independent of TMap iteration order. */
    TArray<FString> AttributeNames;
    TArray<FString> Warnings;
};

namespace TopoTopoStream
{
    TOPOTOPOPCG_API FString ResolveFilePath(const FString& FilePath);
    /** On failure OutStream is empty. A sibling <stream>.meshes.json supplies mesh names. */
    TOPOTOPOPCG_API bool LoadFile(const FString& FilePath, const FTopoTopoStreamOptions& Options,
        FTopoTopoStream& OutStream, FString& OutError);
    /** In-memory variant for tests. Explicit MeshMapping still applies; there is no sidecar lookup. */
    TOPOTOPOPCG_API bool ParseText(const FString& Text, bool bJson, const FTopoTopoStreamOptions& Options,
        FTopoTopoStream& OutStream, FString& OutError);
    /** Literal equivalent of src/io/points.ts unrealRotator(m4fromQuat(Orientation)). */
    TOPOTOPOPCG_API FRotator UnrealRotator(const FQuat& Orientation);
}
