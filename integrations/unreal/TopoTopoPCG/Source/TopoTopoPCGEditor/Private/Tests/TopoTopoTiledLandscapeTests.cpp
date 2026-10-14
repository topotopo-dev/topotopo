// Copyright 2026 faxcorp, Apache-2.0
#if WITH_DEV_AUTOMATION_TESTS

#include "TopoTopoLandscapeImport.h"
#include "TopoTopoStream.h"
#include "TopoTopoTileInstances.h"
#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "HAL/FileManager.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "Landscape.h"
#include "LandscapeComponent.h"
#include "LandscapeEdit.h"
#include "LandscapeInfo.h"
#include "LandscapeLayerInfoObject.h"
#include "LandscapeStreamingProxy.h"
#include "Materials/Material.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"

namespace TopoTopoTiledTests
{
constexpr int32 TileQuads = 7;
constexpr int32 TileSamples = TileQuads + 1;
constexpr int32 Samples = TileQuads * 2 + 1;
const FVector Origin(-1250.0, 2450.0, 300.0);
const FVector Scale(100.0, 150.0, 2.0);

uint16 Height(int32 X, int32 Y) { return uint16(30000 + 31 * X + 47 * Y + 3 * X * Y); }
uint8 Weight(int32 X, int32 Y) { return uint8(20 + (7 * X + 11 * Y) % 220); }

TArray<TSharedPtr<FJsonValue>> Numbers(std::initializer_list<double> Values)
{
    TArray<TSharedPtr<FJsonValue>> Result;
    for (double Value : Values) { Result.Add(MakeShared<FJsonValueNumber>(Value)); }
    return Result;
}

TSharedPtr<FJsonObject> Layer(const FString& File)
{
    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("name"), TEXT("mask"));
    Result->SetStringField(TEXT("file"), File);
    Result->SetNumberField(TEXT("min"), 0);
    Result->SetNumberField(TEXT("max"), 1);
    Result->SetStringField(TEXT("encoding"), TEXT("value = round(clamp(layer, 0, 1) * 255)"));
    return Result;
}

TSharedPtr<FJsonObject> Heightmap(const FString& File, int32 Resolution)
{
    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("file"), File);
    Result->SetStringField(TEXT("layer"), TEXT("height"));
    Result->SetArrayField(TEXT("resolution"), Numbers({double(Resolution), double(Resolution)}));
    Result->SetNumberField(TEXT("height_min_m"), -2.12);
    Result->SetNumberField(TEXT("height_max_m"), 8.11984375);
    return Result;
}

bool SaveJSON(const FString& Directory, const TSharedPtr<FJsonObject>& Manifest)
{
    FString JSON;
    return FJsonSerializer::Serialize(Manifest.ToSharedRef(), TJsonWriterFactory<>::Create(&JSON)) &&
        FFileHelper::SaveStringToFile(JSON, *(Directory / TEXT("landscape.json")));
}

bool SaveMaps(const FString& Directory, int32 StartX, int32 StartY, int32 Resolution, bool bCorruptSeam = false)
{
    if (!IFileManager::Get().MakeDirectory(*(Directory / TEXT("layers")), true)) { return false; }
    TArray<uint16> Heights;
    TArray<uint8> Weights;
    Heights.SetNumUninitialized(Resolution * Resolution);
    Weights.SetNumUninitialized(Resolution * Resolution);
    for (int32 Y = 0; Y < Resolution; ++Y)
    {
        for (int32 X = 0; X < Resolution; ++X)
        {
            Heights[Y * Resolution + X] = Height(StartX + X, StartY + Y);
            Weights[Y * Resolution + X] = Weight(StartX + X, StartY + Y);
        }
    }
    if (bCorruptSeam) { ++Heights[Resolution]; }
    const FImageView HeightView(Heights.GetData(), Resolution, Resolution, 1, ERawImageFormat::G16, EGammaSpace::Linear);
    const FImageView WeightView(Weights.GetData(), Resolution, Resolution, 1, ERawImageFormat::G8, EGammaSpace::Linear);
    return FImageUtils::SaveImageByExtension(*(Directory / TEXT("heightmap.png")), HeightView) &&
        FImageUtils::SaveImageByExtension(*(Directory / TEXT("layers/mask.png")), WeightView);
}

bool WriteFixture(const FString& Directory, TSharedPtr<FJsonObject>& Manifest)
{
    Manifest = MakeShared<FJsonObject>();
    Manifest->SetStringField(TEXT("format"), TEXT("topotopo-unreal-landscape"));
    Manifest->SetNumberField(TEXT("version"), 2);
    Manifest->SetObjectField(TEXT("heightmap"), Heightmap(TEXT("heightmap.png"), Samples));
    Manifest->SetArrayField(TEXT("layers"), {MakeShared<FJsonValueObject>(Layer(TEXT("layers/mask.png")))});
    TSharedPtr<FJsonObject> Settings = MakeShared<FJsonObject>();
    Settings->SetBoolField(TEXT("exact_fit"), true);
    Settings->SetNumberField(TEXT("section_size_quads"), TileQuads);
    Settings->SetNumberField(TEXT("sections_per_component"), 1);
    Settings->SetArrayField(TEXT("components"), Numbers({2, 2}));
    Settings->SetArrayField(TEXT("overall_resolution"), Numbers({Samples, Samples}));
    Settings->SetArrayField(TEXT("actor_location_cm"), Numbers({Origin.X, Origin.Y, Origin.Z}));
    Settings->SetArrayField(TEXT("scale"), Numbers({Scale.X, Scale.Y, Scale.Z}));
    Manifest->SetObjectField(TEXT("landscape"), Settings);
    TSharedPtr<FJsonObject> Grid = MakeShared<FJsonObject>();
    Grid->SetNumberField(TEXT("tile_size_quads"), TileQuads);
    Grid->SetArrayField(TEXT("grid"), Numbers({2, 2}));
    Grid->SetArrayField(TEXT("source_resolution"), Numbers({Samples, Samples}));
    Grid->SetArrayField(TEXT("padded_resolution"), Numbers({Samples, Samples}));
    Grid->SetArrayField(TEXT("tile_components"), Numbers({1, 1}));
    Grid->SetNumberField(TEXT("overlap_samples"), 1);
    TSharedPtr<FJsonObject> Padding = MakeShared<FJsonObject>();
    Padding->SetNumberField(TEXT("right"), 0);
    Padding->SetNumberField(TEXT("bottom"), 0);
    Padding->SetStringField(TEXT("mode"), TEXT("edge"));
    Grid->SetObjectField(TEXT("padding"), Padding);
    Manifest->SetObjectField(TEXT("tile_grid"), Grid);
    TSharedPtr<FJsonObject> Instances = MakeShared<FJsonObject>();
    Instances->SetStringField(TEXT("csv"), TEXT("instances.csv"));
    Instances->SetStringField(TEXT("meshes"), TEXT("instances.meshes.json"));
    Instances->SetNumberField(TEXT("count"), 10);
    Manifest->SetObjectField(TEXT("instances"), Instances);

    // Unequal row counts ensure that a duplicated/omitted tile stream cannot pass a total-only check.
    const FString Header = TEXT("Name,Position.X,Position.Y,Position.Z,Rotation.Pitch,Rotation.Yaw,Rotation.Roll,Scale.X,Scale.Y,Scale.Z,Seed,Mesh\n");
    FString GlobalCSV = Header;
    TArray<TSharedPtr<FJsonValue>> Tiles;
    for (int32 Y = 0; Y < 2; ++Y)
    {
        for (int32 X = 0; X < 2; ++X)
        {
            const FString Relative = FString::Printf(TEXT("tiles/%d_%d"), X, Y);
            if (!SaveMaps(Directory / Relative, X * TileQuads, Y * TileQuads, TileSamples)) { return false; }
            TSharedPtr<FJsonObject> Tile = MakeShared<FJsonObject>();
            Tile->SetArrayField(TEXT("grid_position"), Numbers({double(X), double(Y)}));
            Tile->SetArrayField(TEXT("sample_min"), Numbers({double(X * TileQuads), double(Y * TileQuads)}));
            Tile->SetArrayField(TEXT("sample_max"), Numbers({double((X + 1) * TileQuads), double((Y + 1) * TileQuads)}));
            Tile->SetArrayField(TEXT("world_offset_cm"), Numbers({X * TileQuads * Scale.X, Y * TileQuads * Scale.Y, 0}));
            Tile->SetObjectField(TEXT("heightmap"), Heightmap(Relative / TEXT("heightmap.png"), TileSamples));
            Tile->SetArrayField(TEXT("layers"), {MakeShared<FJsonValueObject>(Layer(Relative / TEXT("layers/mask.png")))});
            const int32 Count = 1 + X + Y * 2;
            FString CSV = Header;
            for (int32 I = 0; I < Count; ++I)
            {
                const FString Row = FString::Printf(TEXT("%d,%.6f,%.6f,300,0,0,0,1,1,1,%d,cube\n"),
                    (X + Y * 2) * 10 + I, Origin.X + (X * TileQuads + I + 1) * Scale.X,
                    Origin.Y + (Y * TileQuads + 2) * Scale.Y, 100 + (X + Y * 2) * 10 + I);
                CSV += Row;
                GlobalCSV += Row;
            }
            if (!FFileHelper::SaveStringToFile(CSV, *(Directory / Relative / TEXT("instances.csv")))) { return false; }
            TSharedPtr<FJsonObject> TileInstances = MakeShared<FJsonObject>();
            TileInstances->SetStringField(TEXT("csv"), Relative / TEXT("instances.csv"));
            TileInstances->SetStringField(TEXT("meshes"), TEXT("instances.meshes.json"));
            TileInstances->SetNumberField(TEXT("count"), Count);
            Tile->SetObjectField(TEXT("instances"), TileInstances);
            Tiles.Add(MakeShared<FJsonValueObject>(Tile));
        }
    }
    Manifest->SetArrayField(TEXT("tiles"), Tiles);
    const FString Sidecar = TEXT(R"json({"format":"topotopo-instance-meshes","version":1,"stream":"instances.csv","meshes":[{"name":"cube","file":"meshes/cube.glb"}]})json");
    return SaveMaps(Directory, 0, 0, Samples) &&
        FFileHelper::SaveStringToFile(GlobalCSV, *(Directory / TEXT("instances.csv"))) &&
        FFileHelper::SaveStringToFile(Sidecar, *(Directory / TEXT("instances.meshes.json"))) && SaveJSON(Directory, Manifest);
}

bool CheckImport(FAutomationTestBase& Test, bool bPartitioned)
{
    const FString Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectIntermediateDir() /
        TEXT("Automation/TopoTopo/Tiled") / FGuid::NewGuid().ToString(EGuidFormats::Digits));
    ON_SCOPE_EXIT { IFileManager::Get().DeleteDirectory(*Directory, false, true); };
    TSharedPtr<FJsonObject> Manifest;
    if (!Test.TestTrue(TEXT("Generate known-function 2x2 tiled bundle"), WriteFixture(Directory, Manifest))) { return false; }
    TopoTopoImport::FLandscapeData Data;
    FString Error;
    if (!Test.TestTrue(TEXT("Read tiled bundle"), TopoTopoImport::ReadLandscape(Directory, Data, Error)))
    {
        Test.AddError(Error);
        return false;
    }
    Test.TestEqual(TEXT("Four manifest tiles"), Data.Tiles.Num(), 4);
    Test.TestEqual(TEXT("Overlap assembles to 15x15 samples"), Data.Heights.Num(), Samples * Samples);
    Test.TestEqual(TEXT("One assembled weight layer"), Data.WeightLayers.Num(), 1);
    if (Data.Heights.Num() != Samples * Samples || Data.WeightLayers.Num() != 1) { return false; }
    for (int32 Y = 0; Y < Samples; ++Y)
    {
        for (int32 X = 0; X < Samples; ++X)
        {
            Test.TestEqual(TEXT("Assembled height follows known function, including both seams"), Data.Heights[Y * Samples + X], Height(X, Y));
            Test.TestEqual(TEXT("Assembled weights follow known function, including both seams"), Data.WeightLayers[0].Weights[Y * Samples + X], Weight(X, Y));
        }
    }
    if (!Test.TestNotNull(TEXT("Engine available"), GEngine)) { return false; }
    UPackage* WorldPackage = CreatePackage(*(TEXT("/Temp/TopoTopoTiledTest_") + FGuid::NewGuid().ToString(EGuidFormats::Digits)));
    WorldPackage->SetFlags(RF_Transient);
    const UWorld::InitializationValues InitValues = UWorld::InitializationValues().ShouldSimulatePhysics(false)
        .CreateNavigation(false).CreateAISystem(false).CreateWorldPartition(bPartitioned).EnableWorldPartitionStreaming(bPartitioned);
    UWorld* World = UWorld::CreateWorld(EWorldType::Editor, false, TEXT("TopoTopoTiledWorld"), WorldPackage,
        true, ERHIFeatureLevel::Num, &InitValues);
    if (!Test.TestNotNull(TEXT("Isolated editor test world"), World)) { return false; }
    World->SetFlags(RF_Transient);
    GEngine->CreateNewWorldContext(EWorldType::Editor).SetCurrentWorld(World);
    ON_SCOPE_EXIT
    {
        World->DestroyWorld(false);
        if (GEngine) { GEngine->DestroyWorldContext(World); }
        WorldPackage->SetDirtyFlag(false);
    };
    Test.TestEqual(TEXT("World partition mode matches requested test"), World->IsPartitionedWorld(), bPartitioned);
    ALandscape* Landscape = TopoTopoImport::ImportLandscape(World, Data, TEXT("/Game/TopoTopo/TiledAcceptance"), true, true, Error);
    if (!Test.TestNotNull(TEXT("Tiled Landscape imported: ") + Error, Landscape)) { return false; }
    ULandscapeInfo* Info = Landscape->GetLandscapeInfo();
    if (!Test.TestNotNull(TEXT("Shared LandscapeInfo"), Info)) { return false; }
    Test.TestTrue(TEXT("Actor corner preserved"), Landscape->GetActorLocation().Equals(Origin));
    Test.TestTrue(TEXT("Actor spacing and shared height scale preserved"), Landscape->GetActorScale3D().Equals(Scale));
    Test.TestEqual(TEXT("Exactly four landscape components"), Info->XYtoComponentMap.Num(), 4);
    Test.TestEqual(TEXT("Parent component count matches partition mode"), Landscape->LandscapeComponents.Num(), bPartitioned ? 0 : 4);
    int32 ProxyCount = 0;
    TSet<FIntPoint> ProxyOffsets;
    for (TActorIterator<ALandscapeStreamingProxy> It(World); It; ++It)
    {
        ++ProxyCount;
        ALandscapeStreamingProxy* Proxy = *It;
        Test.TestEqual(TEXT("Proxy has one tile component"), Proxy->LandscapeComponents.Num(), 1);
        Test.TestTrue(TEXT("Proxy shares Landscape GUID"), Proxy->GetLandscapeGuid() == Landscape->GetLandscapeGuid());
        Test.TestTrue(TEXT("Proxy shares generated material"), Proxy->LandscapeMaterial == Landscape->LandscapeMaterial);
        Test.TestTrue(TEXT("Proxy shares LandscapeInfo"), Proxy->GetLandscapeInfo() == Info);
        Test.TestTrue(TEXT("Proxy is spatially loaded"), Proxy->GetIsSpatiallyLoaded());
        ProxyOffsets.Add(Proxy->GetSectionBase());
    }
    Test.TestEqual(TEXT("One streaming proxy per tile only in World Partition"), ProxyCount, bPartitioned ? 4 : 0);
    if (bPartitioned)
    {
        for (int32 Y = 0; Y < 2; ++Y)
        {
            for (int32 X = 0; X < 2; ++X) { Test.TestTrue(TEXT("Proxy exists at exact tile sample offset"), ProxyOffsets.Contains(FIntPoint(X * TileQuads, Y * TileQuads))); }
        }
    }
    TArray<uint16> ActualHeights;
    ActualHeights.SetNumZeroed(Samples * Samples);
    FLandscapeEditDataInterface Edit(Info, FGuid(), false);
    Edit.GetHeightDataFast(0, 0, Samples - 1, Samples - 1, ActualHeights.GetData(), Samples);
    Test.TestTrue(TEXT("Engine height readback exactly matches all source samples and seams"), ActualHeights == Data.Heights);
    const FLandscapeTargetLayerSettings* Target = Landscape->GetTargetLayers().Find(TEXT("mask"));
    if (Test.TestNotNull(TEXT("Shared weight-layer target"), Target))
    {
        TArray<uint8> ActualWeights;
        ActualWeights.SetNumZeroed(Samples * Samples);
        Edit.GetWeightDataFast(Target->LayerInfoObj, 0, 0, Samples - 1, Samples - 1, ActualWeights.GetData(), Samples);
        Test.TestTrue(TEXT("Engine weight readback exactly matches all tile samples and seams"), ActualWeights == Data.WeightLayers[0].Weights);
    }
    FTopoTopoStreamOptions StreamOptions;
    StreamOptions.MeshMapping.Add(TEXT("cube"), FSoftObjectPath(TEXT("/Engine/BasicShapes/Cube.Cube")));
    FTopoTopoStream Global;
    TArray<TopoTopoImport::FTileInstances> TileStreams;
    if (!Test.TestTrue(TEXT("Read global stream"), TopoTopoStream::LoadFile(Directory / TEXT("instances.csv"), StreamOptions, Global, Error)) ||
        !Test.TestTrue(TEXT("Validate tile streams against global mesh/transform rows"),
            TopoTopoImport::ReadTileInstances(Data, StreamOptions, Global, TileStreams, Error)))
    {
        Test.AddError(Error);
        return false;
    }
    UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    if (!Test.TestNotNull(TEXT("Engine cube prototype available"), Cube)) { return false; }
    TMap<FString, UStaticMesh*> Prototypes;
    Prototypes.Add(TEXT("cube"), Cube);
    int32 TotalInstances = 0;
    Test.TestEqual(TEXT("Four independent tile instance streams"), TileStreams.Num(), 4);
    for (int32 Index = 0; Index < TileStreams.Num(); ++Index)
    {
        const TopoTopoImport::FTileInstances& Tile = TileStreams[Index];
        const int32 ExpectedCount = Index + 1;
        Test.TestEqual(TEXT("Tile instance count follows 1,2,3,4 fixture"), Tile.Stream.Rows.Num(), ExpectedCount);
        AActor* Actor = TopoTopoImport::SpawnTileInstances(World, Tile, Prototypes, TEXT("TopoTopo_TiledAcceptance"), true, Error);
        if (!Test.TestNotNull(TEXT("Tile HISM actor created: ") + Error, Actor)) { continue; }
        Test.TestTrue(TEXT("Tile actor spatially loaded"), Actor->GetIsSpatiallyLoaded());
        Test.TestNull(TEXT("Tile actor has no cross-tile attachment"), Actor->GetAttachParentActor());
        Test.TestTrue(TEXT("Tile actor rooted at tile centre"), Actor->GetActorLocation().Equals(Tile.Location));
        TArray<UHierarchicalInstancedStaticMeshComponent*> Components;
        Actor->GetComponents(Components);
        if (!Test.TestEqual(TEXT("One cube HISM group per tile"), Components.Num(), 1)) { continue; }
        UHierarchicalInstancedStaticMeshComponent* Component = Components[0];
        Test.TestEqual(TEXT("Tile HISM keeps its exact instance count"), Component->GetInstanceCount(), ExpectedCount);
        TotalInstances += Component->GetInstanceCount();
        for (int32 RowIndex = 0; RowIndex < Tile.Stream.Rows.Num(); ++RowIndex)
        {
            FTransform Actual;
            Test.TestTrue(TEXT("HISM world transform can be read"), Component->GetInstanceTransform(RowIndex, Actual, true));
            Test.TestTrue(TEXT("World-space CSV transforms survive nonzero tile actor origin"), Actual.Equals(Tile.Stream.Rows[RowIndex].Transform, 1.e-4));
        }
    }
    Test.TestEqual(TEXT("Tiled HISM instances sum to global count"), TotalInstances, Global.Rows.Num());
    Test.TestEqual(TEXT("Exactly ten synthetic instances"), TotalInstances, 10);
    return !Test.HasAnyErrors();
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoTiledLandscapePlainTest, "TopoTopo.Editor.TiledLandscape.Plain",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FTopoTopoTiledLandscapePlainTest::RunTest(const FString& Parameters) { return TopoTopoTiledTests::CheckImport(*this, false); }

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoTiledLandscapePartitionedTest, "TopoTopo.Editor.TiledLandscape.WorldPartition",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FTopoTopoTiledLandscapePartitionedTest::RunTest(const FString& Parameters) { return TopoTopoTiledTests::CheckImport(*this, true); }

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoTiledLandscapeValidationTest, "TopoTopo.Editor.TiledLandscape.Validation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FTopoTopoTiledLandscapeValidationTest::RunTest(const FString& Parameters)
{
    using namespace TopoTopoTiledTests;
    const FString Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectIntermediateDir() /
        TEXT("Automation/TopoTopo/TiledValidation") / FGuid::NewGuid().ToString(EGuidFormats::Digits));
    ON_SCOPE_EXIT { IFileManager::Get().DeleteDirectory(*Directory, false, true); };
    TSharedPtr<FJsonObject> Manifest;
    if (!TestTrue(TEXT("Generate 2x2 fixture"), WriteFixture(Directory, Manifest))) { return false; }
    TopoTopoImport::FLandscapeData Data;
    FString Error;
    if (!TestTrue(TEXT("Valid tiled manifest accepted"), TopoTopoImport::ReadLandscape(Directory, Data, Error)))
    {
        AddError(Error);
        return false;
    }
    TestTrue(TEXT("Write inconsistent seam sample"), SaveMaps(Directory / TEXT("tiles/1_0"), TileQuads, 0, TileSamples, true));
    TestFalse(TEXT("Different duplicate height samples reject the bundle"), TopoTopoImport::ReadLandscape(Directory, Data, Error));
    TestTrue(TEXT("Height seam rejection explains the seam"), Error.Contains(TEXT("seam")));
    if (!TestTrue(TEXT("Restore seam"), SaveMaps(Directory / TEXT("tiles/1_0"), TileQuads, 0, TileSamples))) { return false; }
    TArray<uint8> BrokenWeights;
    BrokenWeights.SetNumUninitialized(TileSamples * TileSamples);
    for (int32 Y = 0; Y < TileSamples; ++Y)
    {
        for (int32 X = 0; X < TileSamples; ++X) { BrokenWeights[Y * TileSamples + X] = Weight(TileQuads + X, Y); }
    }
    ++BrokenWeights[TileSamples];
    const FImageView BrokenWeightView(BrokenWeights.GetData(), TileSamples, TileSamples, 1, ERawImageFormat::G8, EGammaSpace::Linear);
    TestTrue(TEXT("Write inconsistent weight seam"), FImageUtils::SaveImageByExtension(*(Directory / TEXT("tiles/1_0/layers/mask.png")), BrokenWeightView));
    TestFalse(TEXT("Different duplicate weight samples reject the bundle"), TopoTopoImport::ReadLandscape(Directory, Data, Error));
    TestTrue(TEXT("Weight seam rejection explains the seam"), Error.Contains(TEXT("seam")));
    if (!TestTrue(TEXT("Restore weight seam"), SaveMaps(Directory / TEXT("tiles/1_0"), TileQuads, 0, TileSamples))) { return false; }

    const TSharedPtr<FJsonObject> Tile = Manifest->GetArrayField(TEXT("tiles"))[1]->AsObject();
    Tile->GetObjectField(TEXT("heightmap"))->SetNumberField(TEXT("height_min_m"), -3);
    TestTrue(TEXT("Save inconsistent range"), SaveJSON(Directory, Manifest));
    TestFalse(TEXT("Per-tile height ranges cannot diverge"), TopoTopoImport::ReadLandscape(Directory, Data, Error));
    Tile->GetObjectField(TEXT("heightmap"))->SetNumberField(TEXT("height_min_m"), -2.12);
    Tile->SetArrayField(TEXT("sample_min"), Numbers({8, 0}));
    TestTrue(TEXT("Save inconsistent sample range"), SaveJSON(Directory, Manifest));
    TestFalse(TEXT("Missing one-sample overlap rejected"), TopoTopoImport::ReadLandscape(Directory, Data, Error));
    Tile->SetArrayField(TEXT("sample_min"), Numbers({7, 0}));
    Tile->SetArrayField(TEXT("grid_position"), Numbers({0, 0}));
    TestTrue(TEXT("Save duplicate grid position"), SaveJSON(Directory, Manifest));
    TestFalse(TEXT("Duplicate tile position rejected"), TopoTopoImport::ReadLandscape(Directory, Data, Error));
    Tile->SetArrayField(TEXT("grid_position"), Numbers({1, 0}));
    Manifest->GetObjectField(TEXT("tile_grid"))->GetObjectField(TEXT("padding"))->SetNumberField(TEXT("right"), 1);
    TestTrue(TEXT("Save wrong padding"), SaveJSON(Directory, Manifest));
    TestFalse(TEXT("Padding must explain the exact source-to-grid difference"), TopoTopoImport::ReadLandscape(Directory, Data, Error));
    Manifest->GetObjectField(TEXT("tile_grid"))->GetObjectField(TEXT("padding"))->SetNumberField(TEXT("right"), 0);
    if (!TestTrue(TEXT("Restore valid manifest"), SaveJSON(Directory, Manifest)) ||
        !TestTrue(TEXT("Restored fixture accepted"), TopoTopoImport::ReadLandscape(Directory, Data, Error))) { return false; }
    FTopoTopoStreamOptions Options;
    Options.MeshMapping.Add(TEXT("cube"), FSoftObjectPath(TEXT("/Engine/BasicShapes/Cube.Cube")));
    FTopoTopoStream Global;
    TArray<TopoTopoImport::FTileInstances> TileStreams;
    if (!TestTrue(TEXT("Load validation instance stream"), TopoTopoStream::LoadFile(Directory / TEXT("instances.csv"), Options, Global, Error)))
    {
        AddError(Error);
        return false;
    }
    TestTrue(TEXT("Complete tile instance split accepted"), TopoTopoImport::ReadTileInstances(Data, Options, Global, TileStreams, Error));
    ++Data.Tiles[0].InstanceCount;
    TestFalse(TEXT("Incorrect per-tile instance count rejected"), TopoTopoImport::ReadTileInstances(Data, Options, Global, TileStreams, Error));
    --Data.Tiles[0].InstanceCount;
    Global.Rows[0].Transform.AddToTranslation(FVector(1, 0, 0));
    TestFalse(TEXT("Tile rows must match the global mesh/transform multiset"), TopoTopoImport::ReadTileInstances(Data, Options, Global, TileStreams, Error));
    return !HasAnyErrors();
}

#endif // WITH_DEV_AUTOMATION_TESTS
