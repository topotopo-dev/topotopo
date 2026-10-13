// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoLandscapeLayers.h"

#include "Dom/JsonObject.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "Materials/MaterialExpressionLandscapeVisibilityMask.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "ObjectTools.h"

namespace TopoTopoLandscape
{
namespace
{
uint32 ReadBigEndian32(const uint8* Bytes)
{
    return (uint32(Bytes[0]) << 24) | (uint32(Bytes[1]) << 16) | (uint32(Bytes[2]) << 8) | uint32(Bytes[3]);
}
}

bool DecodeWeightPNG(const TArray<uint8>& Bytes, int32 Width, int32 Height, TArray<uint8>& Out, FString& Error)
{
    Out.Reset();
    Error.Reset();
    const int64 PixelCount = int64(Width) * Height;
    if (Width <= 0 || Height <= 0 || Width > 8193 || Height > 8193 || PixelCount > MAX_int32)
    {
        Error = TEXT("Weightmap dimensions must be positive and at most 8193 samples per side.");
        return false;
    }

    // Inspect IHDR before the decoder allocates its output. Only the exporter's data formats are accepted;
    // RGB/palette/16-bit images must not be silently converted into a different weight field.
    constexpr uint8 Signature[] = {137, 80, 78, 71, 13, 10, 26, 10};
    if (Bytes.Num() < 33 || FMemory::Memcmp(Bytes.GetData(), Signature, UE_ARRAY_COUNT(Signature)) != 0 ||
        ReadBigEndian32(Bytes.GetData() + 8) != 13 || FMemory::Memcmp(Bytes.GetData() + 12, "IHDR", 4) != 0 ||
        Bytes[24] != 8 || (Bytes[25] != 0 && Bytes[25] != 4))
    {
        Error = TEXT("Weightmap must be an 8-bit greyscale PNG, optionally with an alpha channel.");
        return false;
    }
    if (ReadBigEndian32(Bytes.GetData() + 16) != uint32(Width) ||
        ReadBigEndian32(Bytes.GetData() + 20) != uint32(Height))
    {
        Error = TEXT("Weightmap PNG dimensions do not match the Landscape resolution.");
        return false;
    }

    // UE 5.8's PNG wrapper returns G8 for grey and BGRA8 for grey+alpha. Its PNG decode preserves
    // the U8 channel bytes, including gAMA-tagged files; avoid CopyTo/float conversion afterwards.
    FImage Image;
    if (!FImageUtils::DecompressImage(Bytes.GetData(), Bytes.Num(), Image) ||
        Image.SizeX != Width || Image.SizeY != Height || Image.NumSlices != 1)
    {
        Error = TEXT("Could not decode the complete weightmap PNG.");
        return false;
    }
    if (Image.Format == ERawImageFormat::G8 && Image.RawData.Num() == PixelCount)
    {
        Out.Append(Image.RawData.GetData(), int32(PixelCount));
    }
    else if (Image.Format == ERawImageFormat::BGRA8 && Image.RawData.Num() == PixelCount * 4)
    {
        Out.SetNumUninitialized(int32(PixelCount));
        const TArrayView64<FColor> Pixels = Image.AsBGRA8();
        for (int32 Index = 0; Index < Out.Num(); ++Index)
        {
            Out[Index] = Pixels[Index].R;
        }
    }
    else
    {
        Error = TEXT("Weightmap PNG decoder returned an unsupported channel format.");
        return false;
    }
    return true;
}

bool ReadWeightLayers(const TSharedPtr<FJsonObject>& Manifest, const FString& Directory, int32 Width,
    int32 Height, TArray<FWeightLayer>& Out, FString& Error)
{
    Out.Reset();
    Error.Reset();
    if (!Manifest.IsValid())
    {
        Error = TEXT("Cannot read weight layers from an invalid Landscape manifest.");
        return false;
    }
    if (!Manifest->HasField(TEXT("layers"))) { return true; }
    const TArray<TSharedPtr<FJsonValue>>* Layers = nullptr;
    if (!Manifest->TryGetArrayField(TEXT("layers"), Layers))
    {
        Error = TEXT("Landscape manifest layers must be an array.");
        return false;
    }

    FString LayerDirectory = FPaths::ConvertRelativePathToFull(Directory / TEXT("layers"));
    FPaths::NormalizeDirectoryName(LayerDirectory);
    FPaths::CollapseRelativeDirectories(LayerDirectory);
    TArray<FWeightLayer> Parsed;
    TSet<FName> LayerNames;
    TSet<FName> AssetNames;
    for (int32 Index = 0; Index < Layers->Num(); ++Index)
    {
        const TSharedPtr<FJsonObject>* Object = nullptr;
        FString Name;
        FString RelativeFile;
        FWeightLayer Layer;
        if (!(*Layers)[Index].IsValid() || !(*Layers)[Index]->TryGetObject(Object) || !Object->IsValid() ||
            !(*Object)->TryGetStringField(TEXT("name"), Name) ||
            !(*Object)->TryGetStringField(TEXT("file"), RelativeFile) ||
            !(*Object)->TryGetNumberField(TEXT("min"), Layer.Min) ||
            !(*Object)->TryGetNumberField(TEXT("max"), Layer.Max) ||
            !(*Object)->TryGetStringField(TEXT("encoding"), Layer.Encoding) ||
            !FMath::IsFinite(Layer.Min) || !FMath::IsFinite(Layer.Max) || Layer.Min > Layer.Max ||
            Layer.Encoding.TrimStartAndEnd().IsEmpty())
        {
            Error = FString::Printf(TEXT("Landscape layer %d needs name, file, finite min <= max and nonempty encoding."), Index);
            return false;
        }
        bool bControlCharacter = false;
        for (const TCHAR Character : Name)
        {
            bControlCharacter |= Character < 32 || Character == 127;
        }
        if (Name.IsEmpty() || Name.Len() >= NAME_SIZE - 3 || bControlCharacter || Name.TrimStartAndEnd() != Name ||
            !FName::IsValidXName(Name, INVALID_NAME_CHARACTERS))
        {
            Error = FString::Printf(TEXT("Landscape layer %d has an invalid Unreal layer name; rename it before import."), Index);
            return false;
        }
        Layer.Name = FName(*Name);
        if (Layer.Name == UMaterialExpressionLandscapeVisibilityMask::ParameterName)
        {
            Error = FString::Printf(TEXT("Landscape layer '%s' is reserved for Unreal's visibility mask; rename it before import."), *Name);
            return false;
        }
        Layer.AssetName = TEXT("LI_") + ObjectTools::SanitizeObjectName(Name);
        const FName AssetKey(*Layer.AssetName);
        if (Layer.Name.IsNone() || LayerNames.Contains(Layer.Name) || AssetNames.Contains(AssetKey) ||
            !FPackageName::IsValidLongPackageName(TEXT("/Game/TopoTopo/Landscape/") + Layer.AssetName))
        {
            Error = FString::Printf(TEXT("Landscape layer '%s' is invalid or collides after case folding/asset-name sanitization; rename it before import."), *Name);
            return false;
        }
        LayerNames.Add(Layer.Name);
        AssetNames.Add(AssetKey);

        FPaths::NormalizeFilename(RelativeFile);
        Layer.Filename = FPaths::ConvertRelativePathToFull(Directory, RelativeFile);
        FPaths::NormalizeFilename(Layer.Filename);
        FPaths::CollapseRelativeDirectories(Layer.Filename);
        if (!FPaths::IsRelative(RelativeFile) || RelativeFile.Contains(TEXT(":")) ||
            !RelativeFile.StartsWith(TEXT("layers/")) ||
            !FPaths::IsUnderDirectory(Layer.Filename, LayerDirectory) ||
            !FPaths::GetExtension(Layer.Filename).Equals(TEXT("png"), ESearchCase::IgnoreCase) ||
            !FPaths::FileExists(Layer.Filename))
        {
            Error = FString::Printf(TEXT("Layer '%s' needs an existing PNG inside the bundle's layers directory: %s"), *Name, *RelativeFile);
            return false;
        }
        TArray<uint8> Bytes;
        FString DecodeError;
        if (!FFileHelper::LoadFileToArray(Bytes, *Layer.Filename) ||
            !DecodeWeightPNG(Bytes, Width, Height, Layer.Weights, DecodeError))
        {
            Error = FString::Printf(TEXT("Cannot import layer '%s' (%s): %s"), *Name, *RelativeFile,
                DecodeError.IsEmpty() ? TEXT("could not read file") : *DecodeError);
            return false;
        }
        // min/max and encoding describe the exported source values. Normalised maps are imported as
        // their stored 0..255 bytes, never inverted back into sediment/debris physical values.
        Parsed.Add(MoveTemp(Layer));
    }
    Out = MoveTemp(Parsed);
    return true;
}
}
