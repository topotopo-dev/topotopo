// Copyright 2026 faxcorp, Apache-2.0
#if WITH_DEV_AUTOMATION_TESTS

#include "TopoTopoLandscapeLayers.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/Base64.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include <limits>

namespace TopoTopoLayerTests
{
// Original 3x2 fixtures: grey samples [0,1,63,127,192,255]. Alpha varies independently, including zero
// on nonzero grey samples. gAMA fixtures carry 45455: loading a weight must never linearize those bytes.
const TCHAR* GrayPNG = TEXT("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAAAAAC4HznGAAAAEElEQVR4nGNgYLRnqD/wHwAFRQJ/xUyUDAAAAABJRU5ErkJggg==");
const TCHAR* GrayAlphaPNG = TEXT("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAQAAAA3fa6RAAAAFklEQVR4nGNgYGCst//PUP//AMP/egAcsAV7x/cn6QAAAABJRU5ErkJggg==");
const TCHAR* GammaGrayPNG = TEXT("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAAAAAC4HznGAAAABGdBTUEAALGPC/xhBQAAABBJREFUeJxjYGC0Z6g/8B8ABUUCf8VMlAwAAAAASUVORK5CYII=");
const TCHAR* GammaGrayAlphaPNG = TEXT("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAQAAAA3fa6RAAAABGdBTUEAALGPC/xhBQAAABZJREFUeJxjYGBgrLf/z1D//wDD/3oAHLAFe8f3J+kAAAAASUVORK5CYII=");

TSharedPtr<FJsonObject> Layer(const FString& Name, const FString& File = TEXT("layers/weight.png"))
{
    TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
    Object->SetStringField(TEXT("name"), Name);
    Object->SetStringField(TEXT("file"), File);
    Object->SetNumberField(TEXT("min"), 0);
    Object->SetNumberField(TEXT("max"), 1);
    Object->SetStringField(TEXT("encoding"), TEXT("value = round(clamp(layer, 0, 1) * 255)"));
    return Object;
}

TSharedPtr<FJsonObject> Manifest(const TArray<TSharedPtr<FJsonObject>>& Layers)
{
    TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Values;
    for (const TSharedPtr<FJsonObject>& LayerObject : Layers)
    {
        Values.Add(MakeShared<FJsonValueObject>(LayerObject));
    }
    Object->SetArrayField(TEXT("layers"), Values);
    return Object;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoWeightPNGDecodeTest, "TopoTopo.Editor.WeightPNGDecode",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoWeightPNGDecodeTest::RunTest(const FString& Parameters)
{
    using namespace TopoTopoLayerTests;
    const TArray<uint8> Expected = {0, 1, 63, 127, 192, 255};
    const TCHAR* Fixtures[] = {GrayPNG, GrayAlphaPNG, GammaGrayPNG, GammaGrayAlphaPNG};
    const TCHAR* Labels[] = {TEXT("Grey"), TEXT("Grey+alpha"), TEXT("Gamma grey"), TEXT("Gamma grey+alpha")};
    FString Error;
    TArray<uint8> Out;
    for (int32 Index = 0; Index < UE_ARRAY_COUNT(Fixtures); ++Index)
    {
        TArray<uint8> Bytes;
        if (!TestTrue(TEXT("Decode embedded PNG fixture"), FBase64::Decode(Fixtures[Index], Bytes))) { return false; }
        if (TestTrue(FString(Labels[Index]) + TEXT(" PNG decodes: ") + Error,
            TopoTopoLandscape::DecodeWeightPNG(Bytes, 3, 2, Out, Error)))
        {
            TestTrue(FString(Labels[Index]) + TEXT(" exact bytes, row order and zero-alpha samples preserved"), Out == Expected);
        }
    }

    TArray<uint8> Bytes;
    FBase64::Decode(GrayPNG, Bytes);
    auto Reject = [this, &Out, &Error](const TCHAR* Label, const TArray<uint8>& Data, int32 Width, int32 Height)
    {
        Out = {77};
        TestFalse(Label, TopoTopoLandscape::DecodeWeightPNG(Data, Width, Height, Out, Error));
        TestEqual(TEXT("Rejected PNG leaves no partial weights"), Out.Num(), 0);
        TestFalse(TEXT("Rejected PNG explains the error"), Error.IsEmpty());
    };
    Reject(TEXT("Resolution mismatch rejected"), Bytes, 2, 3);
    Reject(TEXT("Zero dimensions rejected"), Bytes, 0, 2);
    Reject(TEXT("Excessive dimensions rejected before allocation"), Bytes, 8194, 2);
    TArray<uint8> Invalid = Bytes;
    Invalid[24] = 16;
    Reject(TEXT("16-bit PNG rejected rather than scaled"), Invalid, 3, 2);
    Invalid = Bytes;
    Invalid[25] = 2;
    Reject(TEXT("RGB PNG rejected rather than converted"), Invalid, 3, 2);
    Invalid[25] = 3;
    Reject(TEXT("Palette PNG rejected"), Invalid, 3, 2);
    Invalid = Bytes;
    Invalid[0] = 0;
    Reject(TEXT("Non-PNG rejected"), Invalid, 3, 2);
    Invalid.SetNum(12);
    Reject(TEXT("Truncated header rejected"), Invalid, 3, 2);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoWeightLayerManifestTest, "TopoTopo.Editor.WeightLayerManifest",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoWeightLayerManifestTest::RunTest(const FString& Parameters)
{
    using namespace TopoTopoLayerTests;
    using TopoTopoLandscape::FWeightLayer;
    const FString Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectIntermediateDir() /
        TEXT("Automation/TopoTopo/Layers") / FGuid::NewGuid().ToString(EGuidFormats::Digits));
    if (!TestTrue(TEXT("Create temporary layer fixture directory"),
        IFileManager::Get().MakeDirectory(*(Directory / TEXT("layers")), true))) { return false; }
    ON_SCOPE_EXIT { IFileManager::Get().DeleteDirectory(*Directory, false, true); };
    TArray<uint8> Bytes;
    FBase64::Decode(GrayAlphaPNG, Bytes);
    if (!TestTrue(TEXT("Write grey+alpha weight fixture"),
        FFileHelper::SaveArrayToFile(Bytes, *(Directory / TEXT("layers/weight.png")))) ||
        !TestTrue(TEXT("Write outside-layers fixture"),
        FFileHelper::SaveArrayToFile(Bytes, *(Directory / TEXT("outside.png"))))) { return false; }

    TSharedPtr<FJsonObject> ParsedJSON;
    const FString JSON = TEXT("{\"layers\":[{\"name\":\"mask\",\"file\":\"layers/weight.png\",\"min\":0,\"max\":1,")
        TEXT("\"encoding\":\"value = round(clamp(layer, 0, 1) * 255)\"},")
        TEXT("{\"name\":\"sediment\",\"file\":\"layers/weight.png\",\"min\":-2,\"max\":4,")
        TEXT("\"encoding\":\"normalised\"},{\"name\":\"rock.detail\",\"file\":\"layers/weight.png\",\"min\":0,\"max\":0,")
        TEXT("\"encoding\":\"normalised\"}]}");
    if (!TestTrue(TEXT("Parse real layer JSON"), FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(JSON), ParsedJSON)))
    {
        return false;
    }
    TArray<FWeightLayer> Out;
    FString Error;
    if (TestTrue(TEXT("Manifest layers accepted"), TopoTopoLandscape::ReadWeightLayers(ParsedJSON, Directory, 3, 2, Out, Error)) &&
        TestEqual(TEXT("All layers read"), Out.Num(), 3))
    {
        TestEqual(TEXT("First layer preserves manifest order"), Out[0].Name, FName(TEXT("mask")));
        TestEqual(TEXT("Second layer preserves manifest order"), Out[1].Name, FName(TEXT("sediment")));
        TestEqual(TEXT("Asset basename includes LI prefix"), Out[0].AssetName, FString(TEXT("LI_mask")));
        TestEqual(TEXT("Asset basename sanitized without changing layer name"), Out[2].AssetName, FString(TEXT("LI_rock_detail")));
        TestEqual(TEXT("Original layer FName preserved"), Out[2].Name, FName(TEXT("rock.detail")));
        TestFalse(TEXT("Validated PNG filename is absolute"), FPaths::IsRelative(Out[0].Filename));
        TestEqual(TEXT("Source minimum retained"), Out[1].Min, -2.0);
        TestEqual(TEXT("Source maximum retained"), Out[1].Max, 4.0);
        TestEqual(TEXT("Source encoding retained"), Out[1].Encoding, FString(TEXT("normalised")));
        const TArray<uint8> Expected = {0, 1, 63, 127, 192, 255};
        TestTrue(TEXT("Normalised PNG imports exact bytes without undoing normalization"), Out[1].Weights == Expected);
        TestTrue(TEXT("Every layer decoded"), Out[0].Weights == Expected && Out[2].Weights == Expected);
    }
    const TSharedPtr<FJsonObject> Legacy = MakeShared<FJsonObject>();
    TestTrue(TEXT("Missing layers supports old bundles"), TopoTopoLandscape::ReadWeightLayers(Legacy, Directory, 3, 2, Out, Error));
    TestEqual(TEXT("Legacy bundle has no layers"), Out.Num(), 0);
    TestTrue(TEXT("Empty layer array accepted"), TopoTopoLandscape::ReadWeightLayers(Manifest({}), Directory, 3, 2, Out, Error));

    auto Reject = [this, &Directory, &Out, &Error](const TCHAR* Label, const TSharedPtr<FJsonObject>& Object)
    {
        Out.AddDefaulted();
        TestFalse(Label, TopoTopoLandscape::ReadWeightLayers(Object, Directory, 3, 2, Out, Error));
        TestEqual(TEXT("Rejected manifest leaves no partial layers"), Out.Num(), 0);
        TestFalse(TEXT("Rejected manifest explains the error"), Error.IsEmpty());
    };
    Reject(TEXT("Invalid manifest rejected"), nullptr);
    TSharedPtr<FJsonObject> Invalid = MakeShared<FJsonObject>();
    Invalid->SetStringField(TEXT("layers"), TEXT("mask"));
    Reject(TEXT("Non-array layers rejected"), Invalid);
    Invalid->SetArrayField(TEXT("layers"), {MakeShared<FJsonValueNull>()});
    Reject(TEXT("Non-object layer rejected"), Invalid);
    Reject(TEXT("Duplicate layer names rejected"), Manifest({Layer(TEXT("mask")), Layer(TEXT("mask"))}));
    Reject(TEXT("Case-colliding layer names rejected"), Manifest({Layer(TEXT("mask")), Layer(TEXT("MASK"))}));
    Reject(TEXT("Sanitized asset-name collision rejected"), Manifest({Layer(TEXT("rock.detail")), Layer(TEXT("rock_detail"))}));
    Reject(TEXT("Empty layer name rejected"), Manifest({Layer(TEXT(""))}));
    Reject(TEXT("None layer name rejected"), Manifest({Layer(TEXT("None"))}));
    Reject(TEXT("Engine visibility layer name rejected"), Manifest({Layer(TEXT("__LANDSCAPE_VISIBILITY__"))}));
    Reject(TEXT("Engine visibility layer name rejected case-insensitively"), Manifest({Layer(TEXT("__landscape_visibility__"))}));
    Reject(TEXT("Whitespace layer name rejected"), Manifest({Layer(TEXT("bad name"))}));
    Reject(TEXT("Traversal outside layers rejected"), Manifest({Layer(TEXT("mask"), TEXT("layers/../outside.png"))}));
    Reject(TEXT("Files outside layers rejected"), Manifest({Layer(TEXT("mask"), TEXT("outside.png"))}));
    Reject(TEXT("Absolute file rejected"), Manifest({Layer(TEXT("mask"), Directory / TEXT("layers/weight.png"))}));
    Reject(TEXT("Missing file rejected"), Manifest({Layer(TEXT("mask"), TEXT("layers/missing.png"))}));
    TSharedPtr<FJsonObject> InvalidLayer = Layer(TEXT("mask"));
    InvalidLayer->RemoveField(TEXT("min"));
    Reject(TEXT("Missing minimum rejected"), Manifest({InvalidLayer}));
    InvalidLayer = Layer(TEXT("mask"));
    InvalidLayer->SetNumberField(TEXT("min"), 2);
    Reject(TEXT("Reversed bounds rejected"), Manifest({InvalidLayer}));
    InvalidLayer = Layer(TEXT("mask"));
    InvalidLayer->SetNumberField(TEXT("max"), std::numeric_limits<double>::infinity());
    Reject(TEXT("Nonfinite bounds rejected"), Manifest({InvalidLayer}));
    InvalidLayer = Layer(TEXT("mask"));
    InvalidLayer->SetStringField(TEXT("encoding"), TEXT(" \t"));
    Reject(TEXT("Empty encoding rejected"), Manifest({InvalidLayer}));
    TestFalse(TEXT("PNG dimensions checked during manifest preflight"),
        TopoTopoLandscape::ReadWeightLayers(Manifest({Layer(TEXT("mask"))}), Directory, 2, 3, Out, Error));
    TestEqual(TEXT("Dimension mismatch leaves no layers"), Out.Num(), 0);
    return true;
}

#endif
