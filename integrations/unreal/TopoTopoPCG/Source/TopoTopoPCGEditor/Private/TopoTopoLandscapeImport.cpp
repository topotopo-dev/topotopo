// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoLandscapeImport.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Engine/World.h"
#include "Landscape.h"
#include "LandscapeImportHelper.h"
#include "LandscapeInfo.h"
#include "LandscapeLayerInfoObject.h"
#include "LandscapeSubsystem.h"
#include "Materials/Material.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "TopoTopoLandscapeMaterial.h"
#include "UObject/Package.h"

namespace TopoTopoImport
{
static bool ReadLandscapeJSON(const FString& File, TSharedPtr<FJsonObject>& Out, FString& Error)
{
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *File) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Out) || !Out)
    {
        Error = FString::Printf(TEXT("Cannot read JSON object: %s"), *File);
        return false;
    }
    return true;
}

static bool ReadVector(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, FVector& Out)
{
    const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
    if (!Object->TryGetArrayField(Field, Values) || Values->Num() != 3) { return false; }
    for (int32 I = 0; I < 3; ++I)
    {
        double Value;
        if (!(*Values)[I]->TryGetNumber(Value) || !FMath::IsFinite(Value)) { return false; }
        Out[I] = Value;
    }
    return true;
}

static bool LandscapeBundleFile(const FString& Directory, const FString& Relative, FString& Out, FString& Error)
{
    Out = FPaths::ConvertRelativePathToFull(Directory, Relative);
    FPaths::NormalizeFilename(Out);
    FPaths::CollapseRelativeDirectories(Out);
    if (!FPaths::IsRelative(Relative) || !FPaths::IsUnderDirectory(Out, Directory) || !FPaths::FileExists(Out))
    {
        Error = FString::Printf(TEXT("Missing file or path outside bundle: %s"), *Relative);
        return false;
    }
    return true;
}

static bool ReadPair(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, FIntPoint& Out)
{
    const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
    if (!Object->TryGetArrayField(Field, Values) || Values->Num() != 2) { return false; }
    for (int32 I = 0; I < 2; ++I)
    {
        double Value;
        if (!(*Values)[I]->TryGetNumber(Value) || !FMath::IsFinite(Value) || Value < 0 || Value > MAX_int32 ||
            Value != FMath::FloorToDouble(Value)) { return false; }
        Out[I] = static_cast<int32>(Value);
    }
    return true;
}

static bool DecodeHeightmap(const FString& Filename, int32 Width, int32 Height, TArray<uint16>& Heights, FString& Error)
{
    FLandscapeImportDescriptor Descriptor;
    FText Message;
    // single-file=true: do not let UE discover similarly named neighboring files behind the manifest.
    if (FLandscapeImportHelper::GetHeightmapImportDescriptor(Filename, true, false, Descriptor, Message) == ELandscapeImportResult::Error)
    {
        Error = Message.ToString();
        return false;
    }
    const int32 Index = Descriptor.FindDescriptorIndex(Width, Height);
    if (Index == INDEX_NONE)
    {
        Error = TEXT("Heightmap dimensions do not match the manifest resolution: ") + Filename;
        return false;
    }
    if (FLandscapeImportHelper::GetHeightmapImportData(Descriptor, Index, Heights, Message) == ELandscapeImportResult::Error ||
        Heights.Num() != Width * Height)
    {
        Error = TEXT("Could not decode the complete Landscape heightmap: ") + Message.ToString();
        return false;
    }
    return true;
}

static bool ReadTiles(const TSharedPtr<FJsonObject>& Manifest, const FString& Directory,
    FLandscapeData& Out, FString& Error, bool bLayers, bool bDecodeHeightmap)
{
    const TSharedPtr<FJsonObject>* Grid = nullptr;
    const TSharedPtr<FJsonObject>* Padding = nullptr;
    const TSharedPtr<FJsonObject>* SharedHeight = nullptr;
    const TArray<TSharedPtr<FJsonValue>>* Tiles = nullptr;
    const TArray<TSharedPtr<FJsonValue>>* SharedLayers = nullptr;
    FIntPoint Source, Padded, HeightResolution;
    double TileQuads, Right, Bottom, MinHeight, MaxHeight;
    FString PaddingMode;
    if (!Manifest->TryGetObjectField(TEXT("tile_grid"), Grid) ||
        !Manifest->TryGetObjectField(TEXT("heightmap"), SharedHeight) ||
        !(*SharedHeight)->TryGetNumberField(TEXT("height_min_m"), MinHeight) ||
        !(*SharedHeight)->TryGetNumberField(TEXT("height_max_m"), MaxHeight) ||
        !FMath::IsFinite(MinHeight) || !FMath::IsFinite(MaxHeight) || MinHeight > MaxHeight ||
        !ReadPair(*SharedHeight, TEXT("resolution"), HeightResolution) ||
        !(*Grid)->TryGetNumberField(TEXT("tile_size_quads"), TileQuads) || !FMath::IsFinite(TileQuads) ||
        TileQuads < 1 || TileQuads > 8192 || TileQuads != FMath::FloorToDouble(TileQuads) ||
        !ReadPair(*Grid, TEXT("grid"), Out.TileGrid) || Out.TileGrid.X < 1 || Out.TileGrid.Y < 1 ||
        !ReadPair(*Grid, TEXT("source_resolution"), Source) || Source.X < 2 || Source.Y < 2 ||
        !ReadPair(*Grid, TEXT("padded_resolution"), Padded) ||
        !(*Grid)->TryGetObjectField(TEXT("padding"), Padding) ||
        !(*Padding)->TryGetNumberField(TEXT("right"), Right) || !(*Padding)->TryGetNumberField(TEXT("bottom"), Bottom) ||
        !(*Padding)->TryGetStringField(TEXT("mode"), PaddingMode) || PaddingMode != TEXT("edge") ||
        !Manifest->TryGetArrayField(TEXT("tiles"), Tiles) ||
        int64(Out.TileGrid.X) * Out.TileGrid.Y != Tiles->Num() ||
        !Manifest->TryGetArrayField(TEXT("layers"), SharedLayers))
    {
        Error = TEXT("Tiled Landscape requires a complete v2 tile_grid, shared height range, layers and rectangular tiles array.");
        return false;
    }
    Out.TileSizeQuads = static_cast<int32>(TileQuads);
    if (Out.TileSizeQuads % (Out.Sections * Out.Quads) != 0 ||
        int64(Out.TileGrid.X) * Out.TileSizeQuads + 1 != Out.Width ||
        int64(Out.TileGrid.Y) * Out.TileSizeQuads + 1 != Out.Height ||
        Padded != FIntPoint(Out.Width, Out.Height) || Source != HeightResolution ||
        Source.X > Padded.X || Source.Y > Padded.Y || Right != Padded.X - Source.X || Bottom != Padded.Y - Source.Y ||
        Right < 0 || Bottom < 0 || Right >= TileQuads || Bottom >= TileQuads)
    {
        Error = TEXT("Tiled Landscape padding, grid, source resolution or per-tile component layout is inconsistent.");
        return false;
    }
    const int32 Side = Out.TileSizeQuads + 1;
    int64 InstanceTotal = 0;
    if (bDecodeHeightmap) { Out.Heights.SetNumUninitialized(Out.Width * Out.Height); }
    for (int32 Index = 0; Index < Tiles->Num(); ++Index)
    {
        const TSharedPtr<FJsonObject>* Tile = nullptr;
        const TSharedPtr<FJsonObject>* Heightmap = nullptr;
        FIntPoint Resolution;
        FString Relative, Filename;
        double TileMin, TileMax;
        FLandscapeTile Data;
        if (!(*Tiles)[Index]->TryGetObject(Tile) ||
            !ReadPair(*Tile, TEXT("grid_position"), Data.GridPosition) ||
            !ReadPair(*Tile, TEXT("sample_min"), Data.SampleMin) || !ReadPair(*Tile, TEXT("sample_max"), Data.SampleMax) ||
            !ReadVector(*Tile, TEXT("world_offset_cm"), Data.WorldOffset) ||
            !(*Tile)->TryGetObjectField(TEXT("heightmap"), Heightmap) ||
            !ReadPair(*Heightmap, TEXT("resolution"), Resolution) ||
            !(*Heightmap)->TryGetStringField(TEXT("file"), Relative) ||
            !(*Heightmap)->TryGetNumberField(TEXT("height_min_m"), TileMin) ||
            !(*Heightmap)->TryGetNumberField(TEXT("height_max_m"), TileMax) ||
            TileMin != MinHeight || TileMax != MaxHeight || Resolution != FIntPoint(Side, Side) ||
            Data.GridPosition != FIntPoint(Index % Out.TileGrid.X, Index / Out.TileGrid.X) ||
            Data.SampleMin != Data.GridPosition * Out.TileSizeQuads ||
            Data.SampleMax != Data.SampleMin + FIntPoint(Out.TileSizeQuads, Out.TileSizeQuads) ||
            !Data.WorldOffset.Equals(FVector(Data.SampleMin.X * Out.Scale.X, Data.SampleMin.Y * Out.Scale.Y, 0), 0.001))
        {
            Error = FString::Printf(TEXT("Tile %d has inconsistent shared range, resolution, position or sample range (tiles must be row-major)."), Index);
            return false;
        }
        const FString Prefix = FString::Printf(TEXT("tiles/%d_%d/"), Data.GridPosition.X, Data.GridPosition.Y);
        if (!Relative.StartsWith(Prefix))
        {
            Error = TEXT("Tile heightmap must be inside its tiles/<x>_<y> directory.");
            return false;
        }
        if (!LandscapeBundleFile(Directory, Relative, Filename, Error)) { return false; }
        const TSharedPtr<FJsonObject>* Instances = nullptr;
        if ((*Tile)->TryGetObjectField(TEXT("instances"), Instances))
        {
            double Count;
            FString CSV, Meshes, SharedMeshes;
            if (!(*Instances)->TryGetNumberField(TEXT("count"), Count) || !FMath::IsFinite(Count) ||
                Count < 0 || Count > MAX_int32 || Count != FMath::FloorToDouble(Count) ||
                !(*Instances)->TryGetStringField(TEXT("csv"), CSV) || !CSV.StartsWith(Prefix) ||
                !(*Instances)->TryGetStringField(TEXT("meshes"), Meshes) || Meshes != TEXT("instances.meshes.json") ||
                !LandscapeBundleFile(Directory, CSV, Data.InstancesCSV, Error) ||
                !LandscapeBundleFile(Directory, Meshes, SharedMeshes, Error))
            {
                if (Error.IsEmpty()) { Error = TEXT("Tile instance stream must declare a count and reference the shared root mesh sidecar."); }
                return false;
            }
            Data.InstanceCount = static_cast<int32>(Count);
            InstanceTotal += Data.InstanceCount;
        }
        else if (!(*Tile)->HasTypedField<EJson::Null>(TEXT("instances")))
        {
            Error = TEXT("Tile instances must be an object or null.");
            return false;
        }
        Out.Tiles.Add(Data);
        if (!bDecodeHeightmap) { continue; }
        TArray<uint16> Heights;
        TArray<TopoTopoLandscape::FWeightLayer> Weights;
        if (!DecodeHeightmap(Filename, Side, Side, Heights, Error) ||
            (bLayers && !TopoTopoLandscape::ReadWeightLayers(*Tile, Directory, Side, Side, Weights, Error, Prefix + TEXT("layers")))) { return false; }
        if (bLayers && Weights.Num() != SharedLayers->Num())
        {
            Error = TEXT("Every tile must contain every shared weight layer in manifest order.");
            return false;
        }
        for (int32 LayerIndex = 0; LayerIndex < Weights.Num(); ++LayerIndex)
        {
            const TSharedPtr<FJsonObject>* Shared = nullptr;
            FString Name, Encoding;
            double Min, Max;
            const TopoTopoLandscape::FWeightLayer& Layer = Weights[LayerIndex];
            if (!(*SharedLayers)[LayerIndex]->TryGetObject(Shared) ||
                !(*Shared)->TryGetStringField(TEXT("name"), Name) || Name != Layer.Name.ToString() ||
                !(*Shared)->TryGetStringField(TEXT("encoding"), Encoding) || Encoding != Layer.Encoding ||
                !(*Shared)->TryGetNumberField(TEXT("min"), Min) || Min != Layer.Min ||
                !(*Shared)->TryGetNumberField(TEXT("max"), Max) || Max != Layer.Max)
            {
                Error = TEXT("Tile weight layers must share the root manifest's order, names, ranges and encodings.");
                return false;
            }
            if (Index == 0)
            {
                TopoTopoLandscape::FWeightLayer& Full = Out.WeightLayers.Add_GetRef(Layer);
                // There is no single padded weight file: do not advertise the first tile as the reimport source.
                Full.Filename.Empty();
                Full.Weights.SetNumUninitialized(Out.Width * Out.Height);
            }
        }
        for (int32 Y = 0; Y < Side; ++Y)
        {
            for (int32 X = 0; X < Side; ++X)
            {
                const int32 From = Y * Side + X;
                const int32 To = (Y + Data.SampleMin.Y) * Out.Width + X + Data.SampleMin.X;
                const bool bSharedSample = (Data.GridPosition.X > 0 && X == 0) || (Data.GridPosition.Y > 0 && Y == 0);
                if (bSharedSample && Out.Heights[To] != Heights[From])
                {
                    Error = TEXT("Height samples differ across a tile seam.");
                    return false;
                }
                Out.Heights[To] = Heights[From];
                for (int32 LayerIndex = 0; LayerIndex < Weights.Num(); ++LayerIndex)
                {
                    TArray<uint8>& Full = Out.WeightLayers[LayerIndex].Weights;
                    if (bSharedSample && Full[To] != Weights[LayerIndex].Weights[From])
                    {
                        Error = TEXT("Weight samples differ across a tile seam.");
                        return false;
                    }
                    Full[To] = Weights[LayerIndex].Weights[From];
                }
            }
        }
    }
    const TSharedPtr<FJsonObject>* GlobalInstances = nullptr;
    if (Manifest->TryGetObjectField(TEXT("instances"), GlobalInstances))
    {
        double Count;
        if (!(*GlobalInstances)->TryGetNumberField(TEXT("count"), Count) || Count != InstanceTotal)
        {
            Error = TEXT("Tile instance counts must sum to the root manifest's instance count.");
            return false;
        }
    }
    else if (!Manifest->HasTypedField<EJson::Null>(TEXT("instances")) || InstanceTotal != 0)
    {
        Error = TEXT("Root instances must declare the global stream or be null for an empty tiled scene.");
        return false;
    }
    Out.Filename.Empty();
    return true;
}

bool ReadLandscape(const FString& Directory, FLandscapeData& Out, FString& Error, bool bLayers, bool bDecodeHeightmap)
{
    Out = FLandscapeData();
    Error.Reset();
    TSharedPtr<FJsonObject> Manifest;
    if (!ReadLandscapeJSON(Directory / TEXT("landscape.json"), Manifest, Error)) { return false; }
    FString Format;
    double Version = 0;
    const TSharedPtr<FJsonObject>* Settings = nullptr;
    const TSharedPtr<FJsonObject>* Heightmap = nullptr;
    bool bExact = false;
    if (!Manifest->TryGetStringField(TEXT("format"), Format) ||
        (Format != TEXT("topotopo-unreal-landscape") && Format != TEXT("polyforge-unreal-landscape")) ||
        !Manifest->TryGetNumberField(TEXT("version"), Version) || (Version != 1 && Version != 2) ||
        !Manifest->TryGetObjectField(TEXT("landscape"), Settings) ||
        !Manifest->TryGetObjectField(TEXT("heightmap"), Heightmap) ||
        !(*Settings)->TryGetBoolField(TEXT("exact_fit"), bExact) || !bExact)
    {
        Error = TEXT("Landscape requires a version 1 or tiled version 2 topotopo-unreal-landscape (or legacy polyforge-unreal-landscape) manifest with exact_fit=true.");
        return false;
    }
    const TArray<TSharedPtr<FJsonValue>>* Resolution = nullptr;
    double Width, Height, Sections, Quads;
    FString Relative;
    if (!(*Heightmap)->TryGetStringField(TEXT("file"), Relative) ||
        !(*Settings)->TryGetArrayField(TEXT("overall_resolution"), Resolution) || Resolution->Num() != 2 ||
        !(*Resolution)[0]->TryGetNumber(Width) || !(*Resolution)[1]->TryGetNumber(Height) ||
        !(*Settings)->TryGetNumberField(TEXT("sections_per_component"), Sections) ||
        !(*Settings)->TryGetNumberField(TEXT("section_size_quads"), Quads) ||
        !ReadVector(*Settings, TEXT("actor_location_cm"), Out.Location) || !ReadVector(*Settings, TEXT("scale"), Out.Scale))
    {
        Error = TEXT("Landscape manifest is missing valid resolution, component layout, location or scale.");
        return false;
    }
    const int32 MaxSide = Version == 2 ? 32769 : 8193;
    if (!FMath::IsFinite(Width) || !FMath::IsFinite(Height) || Width < 2 || Height < 2 || Width > MaxSide || Height > MaxSide ||
        Width != FMath::FloorToDouble(Width) || Height != FMath::FloorToDouble(Height) ||
        (Sections != 1 && Sections != 2) || (Quads != 7 && Quads != 15 && Quads != 31 && Quads != 63 && Quads != 127 && Quads != 255) ||
        Out.Scale.X <= 0 || Out.Scale.Y <= 0 || Out.Scale.Z <= 0)
    {
        Error = TEXT("Unsupported Landscape dimensions/layout/scale (single: maximum 8193; tiled padded grid: maximum 32769 samples per side).");
        return false;
    }
    Out.Width = static_cast<int32>(Width);
    Out.Height = static_cast<int32>(Height);
    Out.Sections = static_cast<int32>(Sections);
    Out.Quads = static_cast<int32>(Quads);
    if ((Out.Width - 1) % (Out.Sections * Out.Quads) != 0 || (Out.Height - 1) % (Out.Sections * Out.Quads) != 0)
    {
        Error = TEXT("Landscape resolution does not fit its component grid.");
        return false;
    }
    if (Version == 2)
    {
        FIntPoint Components;
        if (!ReadPair(*Settings, TEXT("components"), Components) ||
            Components != FIntPoint((Out.Width - 1) / (Out.Sections * Out.Quads), (Out.Height - 1) / (Out.Sections * Out.Quads)))
        {
            Error = TEXT("Tiled Landscape component counts must match the padded resolution.");
            return false;
        }
        return ReadTiles(Manifest, Directory, Out, Error, bLayers, bDecodeHeightmap);
    }
    if (Manifest->HasField(TEXT("tiles"))) { Error = TEXT("Tiles require Landscape manifest version 2."); return false; }
    if (!LandscapeBundleFile(Directory, Relative, Out.Filename, Error)) { return false; }
    if (!bDecodeHeightmap) { return true; }
    if (!DecodeHeightmap(Out.Filename, Out.Width, Out.Height, Out.Heights, Error)) { return false; }
    if (bLayers && !TopoTopoLandscape::ReadWeightLayers(Manifest, Directory, Out.Width, Out.Height, Out.WeightLayers, Error))
    {
        Out = FLandscapeData();
        return false;
    }
    return true;
}

ALandscape* ImportLandscape(UWorld* World, const FLandscapeData& Data, const FString& Destination,
    bool bMaterial, bool bTransient, FString& Error)
{
    if (!World || Data.Heights.Num() != Data.Width * Data.Height)
    {
        Error = TEXT("Landscape import requires a world and a fully decoded heightmap.");
        return nullptr;
    }
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = bTransient ? RF_Transient : RF_Transactional;
    Spawn.OverrideLevel = World->GetCurrentLevel();
    ALandscape* Landscape = World->SpawnActor<ALandscape>(Data.Location, FRotator::ZeroRotator, Spawn);
    if (!Landscape)
    {
        Error = TEXT("Landscape actor creation failed. Any previously imported assets remain unsaved.");
        return nullptr;
    }
    Landscape->SetActorScale3D(Data.Scale);
    Landscape->StaticLightingLOD = FMath::DivideAndRoundUp(FMath::CeilLogTwo(
        (Data.Width * Data.Height) / (2048 * 2048) + 1), static_cast<uint32>(2));

    TArray<FName> LayerNames;
    TArray<FLandscapeImportLayerInfo> ImportLayers;
    for (const TopoTopoLandscape::FWeightLayer& Layer : Data.WeightLayers)
    {
        UPackage* Package = bTransient ? GetTransientPackage() : CreatePackage(*(Destination / TEXT("Landscape") / Layer.AssetName));
        const FName ObjectName = bTransient
            ? MakeUniqueObjectName(Package, ULandscapeLayerInfoObject::StaticClass(), FName(*Layer.AssetName)) : FName(*Layer.AssetName);
        const EObjectFlags Flags = bTransient ? RF_Transient : RF_Public | RF_Standalone | RF_Transactional;
        ULandscapeLayerInfoObject* LayerInfo = NewObject<ULandscapeLayerInfoObject>(Package, ObjectName, Flags);
        LayerInfo->SetLayerName(Layer.Name, false);
        // These are independent data masks, not weights whose sum is 255. UE 5.8's None is
        // the former bNoWeightBlend: keep PNG bytes intact through import and edit-layer merge.
        // The material still uses LB_WeightBlend, normalizing only the final appearance.
        LayerInfo->SetBlendMethod(ELandscapeTargetLayerBlendMethod::None, false);
        if (!bTransient)
        {
            FAssetRegistryModule::AssetCreated(LayerInfo);
            LayerInfo->MarkPackageDirty();
        }
        LayerNames.Add(Layer.Name);
        FLandscapeImportLayerInfo& ImportLayer = ImportLayers.Emplace_GetRef(Layer.Name);
        ImportLayer.LayerInfo = LayerInfo;
        ImportLayer.SourceFilePath = Layer.Filename;
        ImportLayer.LayerData = Layer.Weights;
        // Retain the reimport source and assignments even for an entirely zero-valued map.
        Landscape->AddTargetLayer(Layer.Name, FLandscapeTargetLayerSettings(LayerInfo, Layer.Filename), false);
    }
    Landscape->TargetDisplayOrderList = LayerNames;
    Landscape->TargetDisplayOrder = ELandscapeLayerDisplayMode::UserSpecific;
    if (bMaterial)
    {
        Landscape->LandscapeMaterial = TopoTopoLandscape::CreateMaterial(Destination, LayerNames, bTransient);
    }

    TMap<FGuid, TArray<uint16>> Heights;
    Heights.Add(FGuid(), Data.Heights);
    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> Layers;
    Layers.Add(FGuid(), MoveTemp(ImportLayers));
    // ALandscape inherits the public ALandscapeProxy::Import route. It builds both final
    // textures and the default edit layer, and internally writes its masks via SetAlphaData.
    Landscape->Import(FGuid::NewGuid(), 0, 0, Data.Width - 1, Data.Height - 1,
        Data.Sections, Data.Quads, Heights, *Data.Filename, Layers,
        ELandscapeImportAlphamapType::Additive, TArrayView<const FLandscapeLayer>());
    if (ULandscapeInfo* Info = Landscape->GetLandscapeInfo())
    {
        Info->UpdateLayerInfoMap(Landscape);
        if (Data.TileSizeQuads > 0 && World->IsPartitionedWorld())
        {
            // Same post-import conversion as UE's New Landscape panel. Section coordinates start at zero,
            // so each actor-partition cell exactly matches one exported tile, even with a nonzero world origin.
            World->GetSubsystem<ULandscapeSubsystem>()->ChangeGridSize(Info, Data.TileSizeQuads / (Data.Sections * Data.Quads));
        }
    }
    if (!bTransient) { Landscape->MarkPackageDirty(); }
    return Landscape;
}

}
