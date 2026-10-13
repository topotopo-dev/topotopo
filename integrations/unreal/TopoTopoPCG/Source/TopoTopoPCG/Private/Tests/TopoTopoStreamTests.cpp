// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoStream.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "PCGTopoTopoPointStreamSettings.h"
#include "PCGTopoTopoInstanceSpawnerSettings.h"
#include "Data/PCGPointArrayData.h"
#include "HAL/PlatformMisc.h"
#include "Interfaces/IPluginManager.h"
#include "Metadata/PCGMetadata.h"
#include "MeshSelectors/PCGMeshSelectorByAttribute.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

namespace TopoTopoTests
{
constexpr EAutomationTestFlags Flags = EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter;

bool Near(FAutomationTestBase& Test, const FString& Label, double Actual, double Expected, double Tolerance = 1.e-6)
{
    return Test.TestTrue(FString::Printf(TEXT("%s: %.12g (expected %.12g)"), *Label, Actual, Expected),
        FMath::Abs(Actual - Expected) <= Tolerance);
}

bool VectorNear(FAutomationTestBase& Test, const FString& Label, const FVector& Actual, const FVector& Expected)
{
    return Test.TestTrue(FString::Printf(TEXT("%s: %s (expected %s)"), *Label, *Actual.ToString(), *Expected.ToString()),
        Actual.Equals(Expected, 1.e-6));
}

bool TransformNear(FAutomationTestBase& Test, const FString& Label, const FTransform& Actual,
    const FVector& Position, const FRotator& Rotation, const FVector& Scale)
{
    const bool bPosition = VectorNear(Test, Label + TEXT(" position"), Actual.GetLocation(), Position);
    const bool bRotation = Test.TestTrue(Label + TEXT(" rotation"), Actual.GetRotation().Equals(Rotation.Quaternion(), 1.e-7));
    const bool bScale = VectorNear(Test, Label + TEXT(" scale"), Actual.GetScale3D(), Scale);
    return bPosition && bRotation && bScale;
}

const FTopoTopoAttributeValue* Attribute(FAutomationTestBase& Test, const FTopoTopoStreamRow& Row,
    const TCHAR* Name, ETopoTopoAttributeType Type)
{
    const FTopoTopoAttributeValue* Value = Row.Attributes.Find(Name);
    if (!Test.TestNotNull(FString::Printf(TEXT("Attribute %s exists"), Name), Value))
    {
        return nullptr;
    }
    Test.TestTrue(FString::Printf(TEXT("Attribute %s has expected type"), Name), Value->Type == Type);
    return Value;
}

template<typename T>
const FPCGMetadataAttribute<T>* MetadataAttribute(FAutomationTestBase& Test, const UPCGPointArrayData* Data, const TCHAR* Name)
{
    const FPCGMetadataAttribute<T>* Value = Data->ConstMetadata()->GetConstTypedAttribute<T>(FName(Name));
    Test.TestNotNull(FString::Printf(TEXT("Typed PCG metadata %s exists"), Name), Value);
    return Value;
}

FString FindDemoCSV()
{
    FString ExplicitPath;
    if (FParse::Value(FCommandLine::Get(), TEXT("TopoTopoDemoCSV="), ExplicitPath))
    {
        return TopoTopoStream::ResolveFilePath(ExplicitPath);
    }
    ExplicitPath = FPlatformMisc::GetEnvironmentVariable(TEXT("TOPOTOPO_DEMO_CSV"));
    if (!ExplicitPath.IsEmpty())
    {
        return TopoTopoStream::ResolveFilePath(ExplicitPath);
    }

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
            const FString Candidate = FPaths::Combine(Root, TEXT("out/unreal_demo/landscape/instances.csv"));
            if (FPaths::FileExists(Candidate))
            {
                return Candidate;
            }
            const FString Parent = FPaths::GetPath(Root);
            if (Parent == Root)
            {
                break;
            }
            Root = Parent;
        }
    }
    return FString();
}

// Expected rotations below were generated independently with the repository writer:
// exportCSV(importPointsJSON(fixture), {pcg:true}) in src/io/points.ts.
// Keep decimal expectations independent of the C++ conversion being tested.
const TCHAR* OrientJSON = TEXT(R"json({"format":"topotopo-points","version":1,"count":1,"attributes":{
"P":{"type":"float","size":3,"data":[2,-3,4]},
"trans":{"type":"float","size":3,"data":[0.25,-0.75,1.5]},
"scale":{"type":"float","size":3,"data":[-2,3,0.5]},"pscale":{"type":"float","size":1,"data":[1.7]},
"orient":{"type":"float","size":4,"data":[0.14751136415190022,0.29502272830380044,0.44253409245570063,0.8338858220671682]},
"rot":{"type":"float","size":4,"data":[0.19936793441719716,0,0,0.9799247046208296]},
"N":{"type":"float","size":3,"data":[1,0,0]},"up":{"type":"float","size":3,"data":[0,0,1]},
"Cd":{"type":"float","size":3,"data":[0.1,0.3,0.7]},"Alpha":{"type":"float","size":1,"data":[0.4]},
"density":{"type":"float","size":1,"data":[0.6]},"seed":{"type":"float","size":1,"data":[-2.5]},
"id":{"type":"int","size":1,"data":[7]},"Mesh":{"type":"string","size":1,"data":["pine"]}}})json");

const TCHAR* NormalJSON = TEXT(R"json({"format":"topotopo-points","version":1,"count":1,"attributes":{
"P":{"type":"float","size":3,"data":[2,-3,4]},"trans":{"type":"float","size":3,"data":[0.25,-0.75,1.5]},
"scale":{"type":"float","size":3,"data":[-2,3,0.5]},"pscale":{"type":"float","size":1,"data":[1.7]},
"N":{"type":"float","size":3,"data":[1,2,-3]},"up":{"type":"float","size":3,"data":[0.5,1,0.2]},
"rot":{"type":"float","size":4,"data":[0,0.26723837607825685,0,0.963630453208623]},
"seed":{"type":"float","size":1,"data":[-2.5]}}})json");
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoDemoPointStreamTest, "TopoTopo.UnrealDemo.PointStream", TopoTopoTests::Flags)

bool FTopoTopoDemoPointStreamTest::RunTest(const FString& Parameters)
{
    using namespace TopoTopoTests;
    const FString FilePath = FindDemoCSV();
    if (FilePath.IsEmpty() || !FPaths::FileExists(FilePath))
    {
        AddError(TEXT("Demo CSV missing. Run npm run export:demo in the TopoTopo repository, then launch the editor with ")
            TEXT("-TopoTopoDemoCSV=\"<repository>/out/unreal_demo/landscape/instances.csv\" or set TOPOTOPO_DEMO_CSV before launch."));
        return false;
    }
    AddInfo(TEXT("Loading demo: ") + FilePath);
    FTopoTopoStreamOptions Options;
    Options.MeshFolder = TEXT("/Game/TopoTopo/Demo");
    FTopoTopoStream Stream;
    FString Error;
    if (!TestTrue(TEXT("Demo CSV loads: ") + Error, TopoTopoStream::LoadFile(FilePath, Options, Stream, Error)))
    {
        AddError(Error);
        return false;
    }
    TestEqual(TEXT("Demo has 536 points"), Stream.Rows.Num(), 536);
    if (Stream.Rows.IsEmpty())
    {
        return false;
    }
    const FTopoTopoStreamRow& First = Stream.Rows[0];
    TransformNear(*this, TEXT("First pine"), First.Transform, FVector(3740.23858, -6233.69197, 396.099846),
        FRotator(0, -105.954505, 0), FVector(2.02927671));
    TestEqual(TEXT("First seed"), First.Seed, 0);
    Near(*this, TEXT("First density"), First.Density, 1);
    TestTrue(TEXT("First color is white"), First.Color.Equals(FVector4(1, 1, 1, 1), 1.e-6));
    if (const auto* Value = Attribute(*this, First, TEXT("Mesh"), ETopoTopoAttributeType::String))
    {
        TestEqual(TEXT("First mesh name"), Value->StringValue, FString(TEXT("pine")));
    }
    if (const auto* Value = Attribute(*this, First, TEXT("MeshPath"), ETopoTopoAttributeType::String))
    {
        TestEqual(TEXT("Sidecar name resolves into asset folder"), Value->StringValue, FString(TEXT("/Game/TopoTopo/Demo/pine.pine")));
    }
    const TCHAR* FloatNames[] = {TEXT("curveu"), TEXT("hitprim"), TEXT("hitdist"), TEXT("height"), TEXT("slope"), TEXT("mask"), TEXT("tint")};
    for (const TCHAR* Name : FloatNames)
    {
        Attribute(*this, First, Name, ETopoTopoAttributeType::Float);
    }
    Attribute(*this, First, TEXT("id"), ETopoTopoAttributeType::Integer);
    Attribute(*this, First, TEXT("copynum"), ETopoTopoAttributeType::Integer);
    Attribute(*this, First, TEXT("material"), ETopoTopoAttributeType::String);
    Attribute(*this, First, TEXT("name"), ETopoTopoAttributeType::String);
    TestEqual(TEXT("All 12 CSV extras plus resolved MeshPath"), Stream.AttributeNames.Num(), 13);

    TMap<FString, int32> Counts;
    for (const FTopoTopoStreamRow& Row : Stream.Rows)
    {
        const FTopoTopoAttributeValue* Mesh = Row.Attributes.Find(TEXT("Mesh"));
        if (TestNotNull(TEXT("Every demo row has Mesh"), Mesh))
        {
            ++Counts.FindOrAdd(Mesh->StringValue);
        }
    }
    TestEqual(TEXT("Five distinct mesh names"), Counts.Num(), 5);
    TestEqual(TEXT("Pine instances"), Counts.FindRef(TEXT("pine")), 117);
    TestEqual(TEXT("Fir instances"), Counts.FindRef(TEXT("fir")), 81);
    TestEqual(TEXT("Oak instances"), Counts.FindRef(TEXT("oak")), 94);
    TestEqual(TEXT("Rock A instances"), Counts.FindRef(TEXT("rock_a")), 119);
    TestEqual(TEXT("Rock B instances"), Counts.FindRef(TEXT("rock_b")), 125);

    UPCGPointArrayData* Data = TopoTopoPCG::CreatePointData(Stream);
    if (!TestNotNull(TEXT("PCG point data created"), Data))
    {
        return false;
    }
    TestEqual(TEXT("PCG emits 536 points"), Data->GetNumPoints(), 536);
    TransformNear(*this, TEXT("PCG first pine"), Data->GetConstTransformValueRange()[0],
        FVector(3740.23858, -6233.69197, 396.099846), FRotator(0, -105.954505, 0), FVector(2.02927671));
    const PCGMetadataEntryKey Entry = Data->GetConstMetadataEntryValueRange()[0];
    if (const auto* Mesh = MetadataAttribute<FString>(*this, Data, TEXT("Mesh")))
    {
        TestEqual(TEXT("PCG retains human mesh name"), Mesh->GetValueFromItemKey(Entry), FString(TEXT("pine")));
    }
    if (const auto* MeshPath = MetadataAttribute<FSoftObjectPath>(*this, Data, TEXT("MeshPath")))
    {
        TestEqual(TEXT("PCG provides spawner-compatible soft path"), MeshPath->GetValueFromItemKey(Entry).ToString(),
            FString(TEXT("/Game/TopoTopo/Demo/pine.pine")));
    }
    MetadataAttribute<int64>(*this, Data, TEXT("id"));
    MetadataAttribute<int64>(*this, Data, TEXT("copynum"));
    for (const TCHAR* Name : FloatNames)
    {
        MetadataAttribute<double>(*this, Data, Name);
    }
    MetadataAttribute<FString>(*this, Data, TEXT("material"));
    MetadataAttribute<FString>(*this, Data, TEXT("name"));

    // A manual asset rename wins over the sidecar's suggested folder/name path.
    Options.MeshMapping.Add(TEXT("pine"), FSoftObjectPath(TEXT("/Game/Custom/SM_Pine.SM_Pine")));
    FTopoTopoStream Remapped;
    if (TestTrue(TEXT("Demo reload with mapping override"), TopoTopoStream::LoadFile(FilePath, Options, Remapped, Error))
        && !Remapped.Rows.IsEmpty())
    {
        if (const auto* Value = Attribute(*this, Remapped.Rows[0], TEXT("MeshPath"), ETopoTopoAttributeType::String))
        {
            TestEqual(TEXT("Explicit mapping overrides sidecar"), Value->StringValue, FString(TEXT("/Game/Custom/SM_Pine.SM_Pine")));
        }
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoCSVAttributesTest, "TopoTopo.Stream.CSVAttributes", TopoTopoTests::Flags)

bool FTopoTopoCSVAttributesTest::RunTest(const FString& Parameters)
{
    using namespace TopoTopoTests;
    const FString CSV = TEXT("Name,Position.X,Position.Y,Position.Z,Rotation.Pitch,Rotation.Yaw,Rotation.Roll,")
        TEXT("Scale.X,Scale.Y,Scale.Z,Seed,Density,Color.R,Color.G,Color.B,Color.A,Mesh,id,weight,velocity.X,velocity.Y,velocity.Z,")
        TEXT("Tint.R,Tint.G,Tint.B,Tint.A,note,custom_seed,custom_density\r\n")
        TEXT("0,12,-23,34,17,-31,9,-2,3,4,13,0.9,0.1,0.2,0.3,0.4,\"pine\",7,0.125,1,2,3,0.2,0.3,0.4,0.5,")
        TEXT("\"branch, \"\"quoted\"\"\r\nsecond line\",-2.5,0.35\r\n")
        TEXT("1,0,0,0,0,0,0,1,1,1,17,1,1,1,1,1,\"fir\",8,0.5,4,5,6,1,1,1,1,\"tail\",42,0.8\r\n");
    FTopoTopoStreamOptions Options;
    Options.SeedColumn = TEXT("custom_seed");
    Options.DensityColumn = TEXT("custom_density");
    Options.MeshMapping.Add(TEXT("pine"), FSoftObjectPath(TEXT("/Game/Trees/Pine.Pine")));
    FTopoTopoStream Stream;
    FString Error;
    if (!TestTrue(TEXT("CSV accepts RFC4180 quotes and CRLF"), TopoTopoStream::ParseText(CSV, false, Options, Stream, Error)))
    {
        AddError(Error);
        return false;
    }
    TestEqual(TEXT("Embedded newline stays in one row"), Stream.Rows.Num(), 2);
    if (Stream.Rows.Num() != 2)
    {
        return false;
    }
    const FTopoTopoStreamRow& First = Stream.Rows[0];
    TransformNear(*this, TEXT("AsWritten"), First.Transform, FVector(12, -23, 34), FRotator(17, -31, 9), FVector(-2, 3, 4));
    TestEqual(TEXT("Custom seed uses JS rounding"), First.Seed, -2);
    Near(*this, TEXT("Custom density"), First.Density, 0.35);
    TestTrue(TEXT("Color native property"), First.Color.Equals(FVector4(0.1, 0.2, 0.3, 0.4), 1.e-6));
    if (const auto* Value = Attribute(*this, First, TEXT("note"), ETopoTopoAttributeType::String))
    {
        TestEqual(TEXT("Quoted comma, double quote and newline preserved"), Value->StringValue,
            FString(TEXT("branch, \"quoted\"\r\nsecond line")));
    }
    Attribute(*this, First, TEXT("id"), ETopoTopoAttributeType::Integer);
    Attribute(*this, First, TEXT("weight"), ETopoTopoAttributeType::Float);
    if (const auto* Value = Attribute(*this, First, TEXT("velocity"), ETopoTopoAttributeType::Vector))
    {
        VectorNear(*this, TEXT("XYZ suffix group"), FVector(Value->VectorValue.X, Value->VectorValue.Y, Value->VectorValue.Z), FVector(1, 2, 3));
    }
    if (const auto* Value = Attribute(*this, First, TEXT("Tint"), ETopoTopoAttributeType::Vector4))
    {
        TestTrue(TEXT("RGBA suffix group"), Value->VectorValue.Equals(FVector4(0.2, 0.3, 0.4, 0.5), 1.e-6));
    }

    UPCGPointArrayData* Data = TopoTopoPCG::CreatePointData(Stream);
    if (TestNotNull(TEXT("CSV converts to PCG"), Data))
    {
        const PCGMetadataEntryKey Entry = Data->GetConstMetadataEntryValueRange()[0];
        Near(*this, TEXT("PCG density property"), Data->GetConstDensityValueRange()[0], 0.35);
        TestEqual(TEXT("PCG seed property"), Data->GetConstSeedValueRange()[0], -2);
        TestTrue(TEXT("PCG color property"), Data->GetConstColorValueRange()[0].Equals(FVector4(0.1, 0.2, 0.3, 0.4), 1.e-6));
        if (const auto* Value = MetadataAttribute<int64>(*this, Data, TEXT("id")))
        {
            TestEqual(TEXT("PCG integer value"), Value->GetValueFromItemKey(Entry), int64(7));
        }
        if (const auto* Value = MetadataAttribute<double>(*this, Data, TEXT("weight")))
        {
            Near(*this, TEXT("PCG float value"), Value->GetValueFromItemKey(Entry), 0.125);
        }
        if (const auto* Value = MetadataAttribute<FVector>(*this, Data, TEXT("velocity")))
        {
            VectorNear(*this, TEXT("PCG vector value"), Value->GetValueFromItemKey(Entry), FVector(1, 2, 3));
        }
        if (const auto* Value = MetadataAttribute<FVector4>(*this, Data, TEXT("Tint")))
        {
            TestTrue(TEXT("PCG color metadata value"), Value->GetValueFromItemKey(Entry).Equals(FVector4(0.2, 0.3, 0.4, 0.5), 1.e-6));
        }
    }

    Options.AttributeInclude = {TEXT("note"), TEXT("id"), TEXT("weight")};
    Options.AttributeExclude = {TEXT("weight")};
    FTopoTopoStream Filtered;
    if (TestTrue(TEXT("CSV with attribute filters"), TopoTopoStream::ParseText(CSV, false, Options, Filtered, Error))
        && !Filtered.Rows.IsEmpty())
    {
        TestTrue(TEXT("Included string retained"), Filtered.Rows[0].Attributes.Contains(TEXT("note")));
        TestTrue(TEXT("Included integer retained"), Filtered.Rows[0].Attributes.Contains(TEXT("id")));
        TestFalse(TEXT("Exclude wins over include"), Filtered.Rows[0].Attributes.Contains(TEXT("weight")));
        TestFalse(TEXT("Other generic attributes excluded"), Filtered.Rows[0].Attributes.Contains(TEXT("velocity")));
        TestEqual(TEXT("Filtering does not change native seed"), Filtered.Rows[0].Seed, -2);
        Near(*this, TEXT("Filtering does not change native density"), Filtered.Rows[0].Density, 0.35);
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoJSONTransformTest, "TopoTopo.Stream.JSONTransforms", TopoTopoTests::Flags)

bool FTopoTopoJSONTransformTest::RunTest(const FString& Parameters)
{
    using namespace TopoTopoTests;
    FTopoTopoStreamOptions Options;
    Options.CoordinateMode = ETopoTopoCoordinateMode::FromTopoTopoYUp;
    FString Error;
    FTopoTopoStream Stream;
    if (!TestTrue(TEXT("Native orient JSON loads"), TopoTopoStream::ParseText(OrientJSON, true, Options, Stream, Error)))
    {
        AddError(Error);
        return false;
    }
    if (!TestEqual(TEXT("One orient point"), Stream.Rows.Num(), 1))
    {
        return false;
    }
    TransformNear(*this, TEXT("orient overrides N/up; rot post-multiplies"), Stream.Rows[0].Transform,
        FVector(225, 550, -375), FRotator(55.597031, -39.7742267, 21.4685804), FVector(-3.4, 0.85, 5.1));
    TestEqual(TEXT("JSON seed uses JS Math.round"), Stream.Rows[0].Seed, -2);
    Near(*this, TEXT("JSON density"), Stream.Rows[0].Density, 0.6);
    TestTrue(TEXT("Cd and Alpha become PCG color"), Stream.Rows[0].Color.Equals(FVector4(0.1, 0.3, 0.7, 0.4), 1.e-6));
    Attribute(*this, Stream.Rows[0], TEXT("id"), ETopoTopoAttributeType::Integer);

    const FString IntegerAlphaJSON = FString(OrientJSON).Replace(
        TEXT("\"Alpha\":{\"type\":\"float\",\"size\":1,\"data\":[0.4]}"),
        TEXT("\"Alpha\":{\"type\":\"int\",\"size\":1,\"data\":[0]}"));
    if (TestTrue(TEXT("Integer Alpha JSON loads"), TopoTopoStream::ParseText(IntegerAlphaJSON, true, Options, Stream, Error))
        && TestEqual(TEXT("Single integer Alpha row"), Stream.Rows.Num(), 1))
    {
        Near(*this, TEXT("Integer Alpha is not consumed by the CSV writer"), Stream.Rows[0].Color.W, 1);
        Attribute(*this, Stream.Rows[0], TEXT("Alpha"), ETopoTopoAttributeType::Integer);
    }
    const FString TupleSeedJSON = FString(OrientJSON).Replace(
        TEXT("\"seed\":{\"type\":\"float\",\"size\":1,\"data\":[-2.5]}"),
        TEXT("\"seed\":{\"type\":\"float\",\"size\":4,\"data\":[-2.5,99,100,101]}"));
    if (TestTrue(TEXT("Tuple seed JSON loads"), TopoTopoStream::ParseText(TupleSeedJSON, true, Options, Stream, Error))
        && TestEqual(TEXT("Single tuple seed row"), Stream.Rows.Num(), 1))
    {
        TestEqual(TEXT("Tuple seed consumes its first component like the CSV writer"), Stream.Rows[0].Seed, -2);
        Attribute(*this, Stream.Rows[0], TEXT("seed"), ETopoTopoAttributeType::Vector4);
    }

    if (TestTrue(TEXT("Native N/up JSON loads"), TopoTopoStream::ParseText(NormalJSON, true, Options, Stream, Error))
        && TestEqual(TEXT("Single fixture row"), Stream.Rows.Num(), 1))
    {
        TransformNear(*this, TEXT("N/up plus rot"), Stream.Rows[0].Transform, FVector(225, 550, -375),
            FRotator(6.20219488, 155.456723, -43.83317), FVector(-3.4, 0.85, 5.1));
    }

    // The writer's N fallback is v, and a zero direction keeps the identity basis.
    const FString VelocityJSON = FString(NormalJSON).Replace(TEXT("\"N\""), TEXT("\"v\""));
    if (TestTrue(TEXT("v fallback JSON loads"), TopoTopoStream::ParseText(VelocityJSON, true, Options, Stream, Error))
        && TestEqual(TEXT("Single fixture row"), Stream.Rows.Num(), 1))
    {
        TransformNear(*this, TEXT("v fallback"), Stream.Rows[0].Transform, FVector(225, 550, -375),
            FRotator(6.20219488, 155.456723, -43.83317), FVector(-3.4, 0.85, 5.1));
    }
    const FString ZeroNormalJSON = FString(NormalJSON)
        .Replace(TEXT("[1,2,-3]"), TEXT("[0,0,0]"))
        .Replace(TEXT("[0,0.26723837607825685,0,0.963630453208623]"), TEXT("[0,0,0.3826834323650898,0.9238795325112867]"));
    if (TestTrue(TEXT("Zero normal JSON loads"), TopoTopoStream::ParseText(ZeroNormalJSON, true, Options, Stream, Error))
        && TestEqual(TEXT("Single fixture row"), Stream.Rows.Num(), 1))
    {
        TransformNear(*this, TEXT("Zero normal keeps identity before rot"), Stream.Rows[0].Transform,
            FVector(225, 550, -375), FRotator(45, 0, 0), FVector(-3.4, 0.85, 5.1));
    }
    const FString BareJSON = TEXT(R"json({"format":"topotopo-points","version":1,"count":2,"attributes":{
        "P":{"type":"float","size":3,"data":[1,2,3,4,5,6]}}})json");
    if (TestTrue(TEXT("Defaults JSON loads"), TopoTopoStream::ParseText(BareJSON, true, Options, Stream, Error))
        && TestEqual(TEXT("Two fixture rows"), Stream.Rows.Num(), 2))
    {
        TransformNear(*this, TEXT("Native point defaults"), Stream.Rows[0].Transform, FVector(100, 300, 200), FRotator::ZeroRotator, FVector::OneVector);
        TestEqual(TEXT("Default hash seed zero"), Stream.Rows[0].Seed, 0);
        TestEqual(TEXT("Default seed matches hash32(1) >>> 1"), Stream.Rows[1].Seed, 876922976);
        Options.CoordinateMode = ETopoTopoCoordinateMode::AsWritten;
        if (TestTrue(TEXT("AsWritten JSON loads"), TopoTopoStream::ParseText(BareJSON, true, Options, Stream, Error))
            && TestEqual(TEXT("Two fixture rows"), Stream.Rows.Num(), 2))
        {
            VectorNear(*this, TEXT("AsWritten JSON does not rescale or exchange axes"), Stream.Rows[0].Transform.GetLocation(), FVector(1, 2, 3));
        }
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoCSVVariantsTest, "TopoTopo.Stream.CSVVariants", TopoTopoTests::Flags)

bool FTopoTopoCSVVariantsTest::RunTest(const FString& Parameters)
{
    using namespace TopoTopoTests;
    const FString StructCSV = TEXT("Name,Position,Rotation,Scale,Density,Color,Seed,Mesh\n")
        TEXT("0,\"(X=12,Y=-23,Z=34)\",\"(Pitch=17,Yaw=-31,Roll=9)\",\"(X=-2,Y=3,Z=4)\",0.7,")
        TEXT("\"(X=0.1,Y=0.2,Z=0.3,W=0.4)\",19,\"pine\"\n");
    FTopoTopoStreamOptions Options;
    FTopoTopoStream Stream;
    FString Error;
    if (TestTrue(TEXT("Unreal struct-text columns load"), TopoTopoStream::ParseText(StructCSV, false, Options, Stream, Error))
        && TestEqual(TEXT("Single fixture row"), Stream.Rows.Num(), 1))
    {
        TransformNear(*this, TEXT("Struct-text transform"), Stream.Rows[0].Transform,
            FVector(12, -23, 34), FRotator(17, -31, 9), FVector(-2, 3, 4));
        TestEqual(TEXT("Struct-text seed"), Stream.Rows[0].Seed, 19);
        Near(*this, TEXT("Struct-text density"), Stream.Rows[0].Density, 0.7);
        TestTrue(TEXT("FVector4 struct-text color"), Stream.Rows[0].Color.Equals(FVector4(0.1, 0.2, 0.3, 0.4), 1.e-6));
    }
    const FString LinearColorCSV = StructCSV.Replace(TEXT("(X=0.1,Y=0.2,Z=0.3,W=0.4)"), TEXT("(R=0.1,G=0.2,B=0.3,A=0.4)"));
    if (TestTrue(TEXT("FLinearColor struct-text loads"), TopoTopoStream::ParseText(LinearColorCSV, false, Options, Stream, Error))
        && TestEqual(TEXT("Single fixture row"), Stream.Rows.Num(), 1))
    {
        TestTrue(TEXT("FLinearColor struct-text value"), Stream.Rows[0].Color.Equals(FVector4(0.1, 0.2, 0.3, 0.4), 1.e-6));
    }

    Options.CoordinateMode = ETopoTopoCoordinateMode::FromTopoTopoYUp;
    TestFalse(TEXT("Already-converted PCG CSV cannot be converted twice"), TopoTopoStream::ParseText(StructCSV, false, Options, Stream, Error));
    TestFalse(TEXT("Double-conversion error is actionable"), Error.IsEmpty());
    TestEqual(TEXT("Rejected double-conversion leaves no points"), Stream.Rows.Num(), 0);

    const FString NativeCSV = TEXT("P.x;P.y;P.z;trans.x;trans.y;trans.z;N.x;N.y;N.z;up.x;up.y;up.z;")
        TEXT("rot.x;rot.y;rot.z;rot.w;scale.x;scale.y;scale.z;pscale;seed\r\n")
        TEXT("2;-3;4;0.25;-0.75;1.5;1;2;-3;0.5;1;0.2;0;0.26723837607825685;0;0.963630453208623;-2;3;0.5;1.7;-2.5\r\n");
    if (TestTrue(TEXT("Native semicolon CSV loads"), TopoTopoStream::ParseText(NativeCSV, false, Options, Stream, Error))
        && TestEqual(TEXT("Single fixture row"), Stream.Rows.Num(), 1))
    {
        TransformNear(*this, TEXT("Native CSV matches JSON and TypeScript writer"), Stream.Rows[0].Transform,
            FVector(225, 550, -375), FRotator(6.20219488, 155.456723, -43.83317), FVector(-3.4, 0.85, 5.1));
        TestEqual(TEXT("Native CSV negative seed"), Stream.Rows[0].Seed, -2);
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoSpawnerDefaultsTest, "TopoTopo.PCG.SpawnerDefaults", TopoTopoTests::Flags)

bool FTopoTopoSpawnerDefaultsTest::RunTest(const FString& Parameters)
{
    UPCGTopoTopoInstanceSpawnerSettings* Settings = NewObject<UPCGTopoTopoInstanceSpawnerSettings>();
    TestTrue(TEXT("Spawner inherits the native mesh spawner"), Settings->IsA<UPCGStaticMeshSpawnerSettings>());
    TestTrue(TEXT("New spawner selects meshes by attribute"), Settings->MeshSelectorType == UPCGMeshSelectorByAttribute::StaticClass());
    UPCGMeshSelectorByAttribute* Selector = Cast<UPCGMeshSelectorByAttribute>(Settings->MeshSelectorParameters);
    if (!TestNotNull(TEXT("New spawner owns an attribute selector"), Selector))
    {
        return false;
    }
    TestEqual(TEXT("New spawner reads MeshPath"), Selector->AttributeName, FName(TEXT("MeshPath")));
    TestTrue(TEXT("Selector belongs to its settings"), Selector->GetOuter() == Settings);

    UPCGTopoTopoInstanceSpawnerSettings* Copy = DuplicateObject<UPCGTopoTopoInstanceSpawnerSettings>(Settings, GetTransientPackage());
    if (!TestNotNull(TEXT("Settings can be duplicated for graph copy/paste"), Copy))
    {
        return false;
    }
    TestTrue(TEXT("Duplicate retains attribute selector type"), Copy->MeshSelectorType == UPCGMeshSelectorByAttribute::StaticClass());
    const UPCGMeshSelectorByAttribute* CopySelector = Cast<UPCGMeshSelectorByAttribute>(Copy->MeshSelectorParameters);
    if (TestNotNull(TEXT("Duplicate owns an attribute selector"), CopySelector))
    {
        TestEqual(TEXT("Duplicate retains MeshPath default"), CopySelector->AttributeName, FName(TEXT("MeshPath")));
        TestTrue(TEXT("Duplicate has independent instanced selector"), CopySelector != Selector && CopySelector->GetOuter() == Copy);
    }

    Selector->AttributeName = TEXT("CustomMesh");
    UPCGTopoTopoInstanceSpawnerSettings* CustomizedCopy = DuplicateObject<UPCGTopoTopoInstanceSpawnerSettings>(Settings, GetTransientPackage());
    if (!TestNotNull(TEXT("Customized settings can be duplicated"), CustomizedCopy))
    {
        return false;
    }
    const UPCGMeshSelectorByAttribute* CustomizedSelector = Cast<UPCGMeshSelectorByAttribute>(CustomizedCopy->MeshSelectorParameters);
    if (TestNotNull(TEXT("Customized duplicate owns an attribute selector"), CustomizedSelector))
    {
        TestEqual(TEXT("Copy/paste preserves user customization"), CustomizedSelector->AttributeName, FName(TEXT("CustomMesh")));
    }
    const UPCGTopoTopoInstanceSpawnerSettings* FreshSettings = NewObject<UPCGTopoTopoInstanceSpawnerSettings>();
    const UPCGMeshSelectorByAttribute* FreshSelector = Cast<UPCGMeshSelectorByAttribute>(FreshSettings->MeshSelectorParameters);
    if (TestNotNull(TEXT("Fresh spawner owns an attribute selector"), FreshSelector))
    {
        TestEqual(TEXT("User customization does not change defaults"), FreshSelector->AttributeName, FName(TEXT("MeshPath")));
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoMalformedStreamTest, "TopoTopo.Stream.RejectMalformed", TopoTopoTests::Flags)

bool FTopoTopoMalformedStreamTest::RunTest(const FString& Parameters)
{
    const TCHAR* BadCSV[] = {
        TEXT("Position.X,Position.Y,Position.Z\n1,2\n"),
        TEXT("Position.X,Position.Y,Position.Z\nNaN,2,3\n"),
        TEXT("Position.X,Position.Y,Position.Z,note\n1,2,3,\"unterminated\n"),
        TEXT("Position.X,Position.Y,Position.Z,id,ID\n1,2,3,1,2\n")
    };
    const TCHAR* BadJSON[] = {
        TEXT("{unclosed"),
        TEXT(R"json({"format":"unknown","version":1,"count":1,"attributes":{"P":{"type":"float","size":3,"data":[1,2,3]}}})json"),
        TEXT(R"json({"format":"topotopo-points","version":1,"count":-1,"attributes":{"P":{"type":"float","size":3,"data":[]}}})json"),
        TEXT(R"json({"format":"topotopo-points","version":1,"count":1,"attributes":{"P":{"type":"float","size":3,"data":[1,2]}}})json"),
        TEXT(R"json({"format":"topotopo-points","version":1,"count":1,"attributes":{"P":{"type":"float","size":3,"data":["oops",2,3]}}})json")
    };
    FTopoTopoStreamOptions Options;
    const auto Reject = [this, &Options](const TCHAR* Text, bool bJson)
    {
        FTopoTopoStream Stream;
        Stream.Rows.AddDefaulted(); // A failed parse must not leak a previous or partial result.
        FString Error;
        TestFalse(TEXT("Malformed stream rejected"), TopoTopoStream::ParseText(Text, bJson, Options, Stream, Error));
        TestFalse(TEXT("Rejection supplies an actionable error"), Error.IsEmpty());
        TestEqual(TEXT("Failed parse leaves no rows"), Stream.Rows.Num(), 0);
    };
    for (const TCHAR* Text : BadCSV)
    {
        Reject(Text, false);
    }
    for (const TCHAR* Text : BadJSON)
    {
        Reject(Text, true);
    }
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
