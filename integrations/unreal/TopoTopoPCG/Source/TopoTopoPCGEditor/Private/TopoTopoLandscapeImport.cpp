// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoLandscapeImport.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Engine/World.h"
#include "Landscape.h"
#include "LandscapeImportHelper.h"
#include "LandscapeInfo.h"
#include "LandscapeLayerInfoObject.h"
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

bool ReadLandscape(const FString& Directory, FLandscapeData& Out, FString& Error, bool bLayers)
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
        !Manifest->TryGetNumberField(TEXT("version"), Version) || Version != 1 ||
        !Manifest->TryGetObjectField(TEXT("landscape"), Settings) ||
        !Manifest->TryGetObjectField(TEXT("heightmap"), Heightmap) ||
        !(*Settings)->TryGetBoolField(TEXT("exact_fit"), bExact) || !bExact)
    {
        Error = TEXT("Landscape requires a version 1 topotopo-unreal-landscape (or legacy polyforge-unreal-landscape) manifest with exact_fit=true. Resample non-exact bundles before importing.");
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
    if (Width < 2 || Height < 2 || Width > 8193 || Height > 8193 ||
        Width != FMath::FloorToDouble(Width) || Height != FMath::FloorToDouble(Height) ||
        (Sections != 1 && Sections != 2) || (Quads != 7 && Quads != 15 && Quads != 31 && Quads != 63 && Quads != 127 && Quads != 255) ||
        Out.Scale.X <= 0 || Out.Scale.Y <= 0 || Out.Scale.Z <= 0)
    {
        Error = TEXT("Unsupported Landscape dimensions/layout/scale (maximum 8193 samples per side).");
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
    if (!LandscapeBundleFile(Directory, Relative, Out.Filename, Error)) { return false; }
    FLandscapeImportDescriptor Descriptor;
    FText Message;
    if (FLandscapeImportHelper::GetHeightmapImportDescriptor(Out.Filename, true, false, Descriptor, Message) == ELandscapeImportResult::Error)
    {
        Error = Message.ToString();
        return false;
    }
    const int32 Index = Descriptor.FindDescriptorIndex(Out.Width, Out.Height);
    if (Index == INDEX_NONE)
    {
        Error = TEXT("Heightmap dimensions do not match landscape.overall_resolution.");
        return false;
    }
    if (FLandscapeImportHelper::GetHeightmapImportData(Descriptor, Index, Out.Heights, Message) == ELandscapeImportResult::Error ||
        Out.Heights.Num() != Out.Width * Out.Height)
    {
        Error = TEXT("Could not decode the complete Landscape heightmap: ") + Message.ToString();
        return false;
    }
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
    if (ULandscapeInfo* Info = Landscape->GetLandscapeInfo()) { Info->UpdateLayerInfoMap(Landscape); }
    if (!bTransient) { Landscape->MarkPackageDirty(); }
    return Landscape;
}

}
