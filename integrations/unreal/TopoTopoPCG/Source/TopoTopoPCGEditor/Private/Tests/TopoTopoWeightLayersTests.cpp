// Copyright 2026 faxcorp, Apache-2.0
#if WITH_DEV_AUTOMATION_TESTS

#include "TopoTopoLandscapeImport.h"
#include "TopoTopoStream.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "HAL/PlatformMisc.h"
#include "Interfaces/IPluginManager.h"
#include "Landscape.h"
#include "LandscapeEdit.h"
#include "LandscapeInfo.h"
#include "LandscapeLayerInfoObject.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionLandscapeLayerBlend.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "UObject/Package.h"

namespace TopoTopoWeightTests
{
FString FindDemoBundle()
{
    FString Path;
    if (FParse::Value(FCommandLine::Get(), TEXT("TopoTopoDemoBundle="), Path))
    {
        return TopoTopoStream::ResolveFilePath(Path);
    }
    Path = FPlatformMisc::GetEnvironmentVariable(TEXT("TOPOTOPO_DEMO_BUNDLE"));
    if (!Path.IsEmpty()) { return TopoTopoStream::ResolveFilePath(Path); }
    if (FParse::Value(FCommandLine::Get(), TEXT("TopoTopoDemoCSV="), Path))
    {
        return FPaths::GetPath(TopoTopoStream::ResolveFilePath(Path));
    }
    Path = FPlatformMisc::GetEnvironmentVariable(TEXT("TOPOTOPO_DEMO_CSV"));
    if (!Path.IsEmpty()) { return FPaths::GetPath(TopoTopoStream::ResolveFilePath(Path)); }

    TArray<FString> Roots;
    if (const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("TopoTopoPCG")))
    {
        Roots.Add(Plugin->GetBaseDir());
    }
    Roots.Add(FPaths::ProjectDir());
    for (FString Root : Roots)
    {
        Root = FPaths::ConvertRelativePathToFull(Root);
        FPaths::NormalizeDirectoryName(Root);
        for (int32 Depth = 0; Depth < 16 && !Root.IsEmpty(); ++Depth)
        {
            const FString Candidate = FPaths::Combine(Root, TEXT("out/unreal_demo/landscape"));
            if (FPaths::FileExists(FPaths::Combine(Candidate, TEXT("landscape.json")))) { return Candidate; }
            const FString Parent = FPaths::GetPath(Root);
            if (Parent == Root) { break; }
            Root = Parent;
        }
    }
    return FString();
}

double Mean(const TArray<uint8>& Bytes)
{
    uint64 Sum = 0;
    for (uint8 Value : Bytes) { Sum += Value; }
    return Bytes.IsEmpty() ? 0.0 : static_cast<double>(Sum) / Bytes.Num();
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoWeightLayersTest, "TopoTopo.Editor.WeightLayers",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoWeightLayersTest::RunTest(const FString& Parameters)
{
    const FString Directory = TopoTopoWeightTests::FindDemoBundle();
    if (Directory.IsEmpty() || !FPaths::FileExists(FPaths::Combine(Directory, TEXT("landscape.json"))))
    {
        // UE simple automation has no skipped-result API. A warning distinguishes this from acceptance.
        AddWarning(TEXT("SKIPPED TopoTopo.Editor.WeightLayers: demo Landscape bundle is absent. Run npm run export:demo, ")
            TEXT("then supply -TopoTopoDemoBundle=\"<repository>/out/unreal_demo/landscape\" or TOPOTOPO_DEMO_BUNDLE. ")
            TEXT("The existing -TopoTopoDemoCSV/TOPOTOPO_DEMO_CSV path is also accepted. No Landscape assertions were executed."));
        return true;
    }

    TopoTopoImport::FLandscapeData Data;
    FString Error;
    if (!TopoTopoImport::ReadLandscape(Directory, Data, Error, true))
    {
        AddError(TEXT("Reading the demo Landscape and weight PNGs failed: ") + Error);
        return false;
    }
    const TArray<FName> ExpectedNames = {
        TEXT("mask"), TEXT("sediment"), TEXT("debris"), TEXT("flow"), TEXT("water"),
        TEXT("path"), TEXT("rock"), TEXT("road"), TEXT("grass"), TEXT("trees")
    };
    if (!TestEqual(TEXT("Ten demo manifest weight layers"), Data.WeightLayers.Num(), ExpectedNames.Num())) { return false; }
    for (int32 Index = 0; Index < ExpectedNames.Num(); ++Index)
    {
        TestEqual(FString::Printf(TEXT("Manifest layer %d keeps its order"), Index), Data.WeightLayers[Index].Name, ExpectedNames[Index]);
    }
    TestEqual(TEXT("Demo heightmap width"), Data.Width, 253);
    TestEqual(TEXT("Demo heightmap height"), Data.Height, 253);
    if (!TestNotNull(TEXT("Engine available for isolated Landscape test world"), GEngine)) { return false; }

    const FName WorldName = MakeUniqueObjectName(GetTransientPackage(), UWorld::StaticClass(), TEXT("TopoTopoWeightTestWorld"));
    UWorld* World = UWorld::CreateWorld(EWorldType::Editor, false, WorldName, GetTransientPackage());
    if (!TestNotNull(TEXT("Transient editor test world created"), World)) { return false; }
    GEngine->CreateNewWorldContext(EWorldType::Editor).SetCurrentWorld(World);
    ON_SCOPE_EXIT
    {
        World->DestroyWorld(false);
        if (GEngine) { GEngine->DestroyWorldContext(World); }
        World->RemoveFromRoot();
    };

    // This is the command's Landscape import path, with transient assets and no current-level mutation,
    // asset registration, saving, or transaction. GLB/PCG assets are not prerequisites for this test.
    AddInfo(TEXT("Importing heightmap, ten weight layers and generated material into an isolated transient world: ") + Directory);
    ALandscape* Landscape = TopoTopoImport::ImportLandscape(World, Data, TEXT("/Game/TopoTopo/WeightLayersTest"), true, true, Error);
    if (!TestNotNull(TEXT("Landscape import succeeds: ") + Error, Landscape)) { return false; }
    TestTrue(TEXT("Test Landscape is transient"), Landscape->HasAnyFlags(RF_Transient));
    ULandscapeInfo* Info = Landscape->GetLandscapeInfo();
    if (!TestNotNull(TEXT("Landscape info exists"), Info)) { return false; }
    int32 ImportedLayerCount = 0;
    for (const FLandscapeInfoLayerSettings& Layer : Info->Layers)
    {
        // UE also registers its built-in visibility target; it is not a bundle weight layer.
        if (Layer.LayerInfoObj == ALandscapeProxy::VisibilityLayer) { continue; }
        ++ImportedLayerCount;
        TestTrue(TEXT("No unexpected imported target layers"), ExpectedNames.Contains(Layer.GetLayerName()));
    }
    TestEqual(TEXT("Ten assigned imported layer infos including all-zero maps"), ImportedLayerCount, ExpectedNames.Num());
    TestTrue(TEXT("Landscape Paint target display uses explicit order"), Landscape->TargetDisplayOrder == ELandscapeLayerDisplayMode::UserSpecific);
    TArray<FName> DisplayNames;
    for (FName Name : Landscape->TargetDisplayOrderList)
    {
        if (ALandscapeProxy::VisibilityLayer && Name == ALandscapeProxy::VisibilityLayer->GetLayerName()) { continue; }
        DisplayNames.Add(Name);
    }
    TestTrue(TEXT("Landscape Paint target display follows manifest order"), DisplayNames == ExpectedNames);

    int32 MinX = 0, MinY = 0, MaxX = 0, MaxY = 0;
    if (!TestTrue(TEXT("Landscape extent exists"), Info->GetLandscapeExtent(MinX, MinY, MaxX, MaxY))) { return false; }
    TestEqual(TEXT("Landscape extent width"), MaxX - MinX + 1, Data.Width);
    TestEqual(TEXT("Landscape extent height"), MaxY - MinY + 1, Data.Height);
    if (MaxX - MinX + 1 != Data.Width || MaxY - MinY + 1 != Data.Height) { return false; }

    // Invalid edit-layer GUID explicitly reads the imported final weightmaps. Read at Landscape vertices,
    // not packed texture texels (those include duplicated component/subsection borders).
    FLandscapeEditDataInterface Edit(Info, FGuid(), false);
    for (const TopoTopoLandscape::FWeightLayer& Expected : Data.WeightLayers)
    {
        const FString Name = Expected.Name.ToString();
        const FLandscapeInfoLayerSettings* Settings = Info->Layers.FindByPredicate(
            [&Expected](const FLandscapeInfoLayerSettings& Layer) { return Layer.GetLayerName() == Expected.Name; });
        if (!TestNotNull(Name + TEXT(" target-layer assignment"), Settings)) { continue; }
        ULandscapeLayerInfoObject* LayerInfo = Settings->LayerInfoObj;
        if (!TestNotNull(Name + TEXT(" layer-info object"), LayerInfo)) { continue; }
        TestEqual(Name + TEXT(" layer-info name"), LayerInfo->GetLayerName(), Expected.Name);
        TestTrue(Name + TEXT(" layer-info is transient"), LayerInfo->HasAnyFlags(RF_Transient));
        TestTrue(Name + TEXT(" preserves independent PNG weights"), LayerInfo->GetBlendMethod() == ELandscapeTargetLayerBlendMethod::None);
        const FLandscapeTargetLayerSettings* Target = Landscape->GetTargetLayers().Find(Expected.Name);
        if (TestNotNull(Name + TEXT(" persistent target settings"), Target))
        {
            TestEqual(Name + TEXT(" reimport source is its PNG"), Target->ReimportLayerFilePath, Expected.Filename);
        }

        TArray<uint8> Actual;
        Actual.SetNumZeroed(Data.Width * Data.Height);
        Edit.GetWeightDataFast(LayerInfo, MinX, MinY, MaxX, MaxY, Actual.GetData(), Data.Width);
        const double ExpectedMean = TopoTopoWeightTests::Mean(Expected.Weights);
        const double ActualMean = TopoTopoWeightTests::Mean(Actual);
        const double Tolerance = ExpectedMean * 0.02;
        TestTrue(FString::Printf(TEXT("%s weight mean %.6f matches PNG %.6f within 2%% (zero means exact)"),
            *Name, ActualMean, ExpectedMean), FMath::Abs(ActualMean - ExpectedMean) <= Tolerance);
        TestTrue(Name + TEXT(" all imported vertex weights equal PNG bytes"), Actual == Expected.Weights);
    }

    UMaterial* Material = Cast<UMaterial>(Landscape->LandscapeMaterial);
    if (!TestNotNull(TEXT("Generated Landscape material assigned"), Material)) { return false; }
    TestTrue(TEXT("Test material is transient"), Material->HasAnyFlags(RF_Transient));
    const TArray<FName> MaterialLayers = Landscape->RetrieveTargetLayerNamesFromMaterials(false);
    TestEqual(TEXT("Material references ten distinct layers"), MaterialLayers.Num(), ExpectedNames.Num());
    for (FName Name : ExpectedNames)
    {
        TestTrue(Name.ToString() + TEXT(" referenced by material"), MaterialLayers.Contains(Name));
    }
    int32 BlendCount = 0;
    for (UMaterialExpression* Expression : Material->GetExpressions())
    {
        const UMaterialExpressionLandscapeLayerBlend* Blend = Cast<UMaterialExpressionLandscapeLayerBlend>(Expression);
        if (!Blend) { continue; }
        ++BlendCount;
        if (!TestEqual(TEXT("Every LandscapeLayerBlend contains all layers"), Blend->Layers.Num(), ExpectedNames.Num())) { continue; }
        for (int32 Index = 0; Index < ExpectedNames.Num(); ++Index)
        {
            TestEqual(TEXT("Material blend preserves manifest order"), Blend->Layers[Index].LayerName, ExpectedNames[Index]);
            TestTrue(TEXT("Material layer uses weight blending"), Blend->Layers[Index].BlendType == LB_WeightBlend);
        }
    }
    TestTrue(TEXT("Material blends both colour and roughness"), BlendCount >= 2);
    const UMaterialEditorOnlyData* MaterialData = Material->GetEditorOnlyData();
    if (TestNotNull(TEXT("Material editor data exists"), MaterialData))
    {
        TestNotNull(TEXT("Base colour graph connected"), MaterialData->BaseColor.Expression);
        TestNotNull(TEXT("Roughness graph connected"), MaterialData->Roughness.Expression);
        const UMaterialExpressionConstant3Vector* Normal = Cast<UMaterialExpressionConstant3Vector>(MaterialData->Normal.Expression);
        if (TestNotNull(TEXT("Simple constant tangent-space normal connected"), Normal))
        {
            TestTrue(TEXT("Normal follows the Landscape surface"), Normal->Constant.Equals(FLinearColor(0.0f, 0.0f, 1.0f), KINDA_SMALL_NUMBER));
        }
    }

    // Exercise the independent command switches using one-component synthetic terrain. Decode with
    // layers disabled first, then reuse that heightmap shape at 8x8 to keep these flag checks inexpensive.
    TopoTopoImport::FLandscapeData Tiny;
    if (!TestTrue(TEXT("layers=0 heightmap path reads successfully"), TopoTopoImport::ReadLandscape(Directory, Tiny, Error, false)))
    {
        AddError(Error);
        return false;
    }
    TestTrue(TEXT("layers=0 decodes no weights"), Tiny.WeightLayers.IsEmpty());
    Tiny.Filename.Empty();
    Tiny.Width = Tiny.Height = 8;
    Tiny.Sections = 1;
    Tiny.Quads = 7;
    Tiny.Location = FVector(20000.0, 20000.0, 0.0);
    Tiny.Heights.Init(32768, 64);
    ALandscape* Fallback = TopoTopoImport::ImportLandscape(World, Tiny, TEXT("/Game/TopoTopo/WeightLayersFallbackTest"), true, true, Error);
    if (TestNotNull(TEXT("layers=0 material=1 creates a Landscape"), Fallback))
    {
        TestNotNull(TEXT("layers=0 material=1 assigns fallback material"), Fallback->LandscapeMaterial.Get());
        TestTrue(TEXT("Fallback material references no absent weight layers"), Fallback->RetrieveTargetLayerNamesFromMaterials(false).IsEmpty());
        if (ULandscapeInfo* FallbackInfo = Fallback->GetLandscapeInfo())
        {
            for (const FLandscapeInfoLayerSettings& Layer : FallbackInfo->Layers)
            {
                TestTrue(TEXT("layers=0 creates no custom layer-info assignments"), Layer.LayerInfoObj == ALandscapeProxy::VisibilityLayer);
            }
        }
    }
    Tiny.Location.X += 10000.0;
    Tiny.WeightLayers.Add(Data.WeightLayers[0]);
    Tiny.WeightLayers[0].Filename.Empty();
    Tiny.WeightLayers[0].Weights.Init(128, 64);
    ALandscape* Unshaded = TopoTopoImport::ImportLandscape(World, Tiny, TEXT("/Game/TopoTopo/WeightLayersUnshadedTest"), false, true, Error);
    if (TestNotNull(TEXT("layers=1 material=0 creates a Landscape"), Unshaded))
    {
        TestNull(TEXT("material=0 leaves the Landscape material unassigned"), Unshaded->LandscapeMaterial.Get());
        const FLandscapeTargetLayerSettings* Target = Unshaded->GetTargetLayers().Find(ExpectedNames[0]);
        if (TestNotNull(TEXT("material=0 preserves weight-layer assignment"), Target))
        {
            ULandscapeInfo* UnshadedInfo = Unshaded->GetLandscapeInfo();
            if (TestNotNull(TEXT("Unshaded Landscape info exists"), UnshadedInfo))
            {
                FLandscapeEditDataInterface UnshadedEdit(UnshadedInfo, FGuid(), false);
                TArray<uint8> UnshadedWeights;
                UnshadedWeights.SetNumZeroed(64);
                UnshadedEdit.GetWeightDataFast(Target->LayerInfoObj, 0, 0, 7, 7, UnshadedWeights.GetData(), 8);
                TestTrue(TEXT("material=0 preserves all imported weights"), UnshadedWeights == Tiny.WeightLayers[0].Weights);
            }
        }
    }
    return !HasAnyErrors();
}

#endif // WITH_DEV_AUTOMATION_TESTS
