// Copyright 2026 faxcorp, Apache-2.0
#if WITH_DEV_AUTOMATION_TESTS

#include "TopoTopoLandscapeImport.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Engine/StaticMesh.h"
#include "HAL/FileManager.h"
#include "Materials/MaterialInterface.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "ObjectTools.h"

// Found while dogfooding (2026-10-15): a prototype mesh "rock" whose glTF material is also named "rock" was imported
// as "rock1", because the material was created first in the same folder, and the import stopped. One triangle with
// mesh and material sharing the name reproduces it.
namespace TopoTopoPrototypeImportTests
{
static const TCHAR* GLTF = TEXT(R"json({
 "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
 "nodes": [{"mesh": 0, "name": "rock"}],
 "meshes": [{"name": "rock", "primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
 "materials": [{"name": "rock", "pbrMetallicRoughness": {"baseColorFactor": [0.55, 0.53, 0.49, 1]}}],
 "buffers": [{"byteLength": 44, "uri": "data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAAAAAAIA/AAABAAIAAAA="}],
 "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36, "target": 34962},
                 {"buffer": 0, "byteOffset": 36, "byteLength": 6, "target": 34963}],
 "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 0, 1]},
               {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"}]
})json");
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoPrototypeNameCollisionTest, "TopoTopo.Editor.PrototypeMaterialNameCollision",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoPrototypeNameCollisionTest::RunTest(const FString& Parameters)
{
    const FString Id = FGuid::NewGuid().ToString(EGuidFormats::Digits);
    const FString Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectIntermediateDir() / TEXT("Automation/TopoTopo/Prototype") / Id);
    const FString File = Directory / TEXT("rock.gltf");
    const FString Folder = TEXT("/Game/TopoTopo/Automation_") + Id + TEXT("/Meshes");
    TArray<UStaticMesh*> Meshes;
    ON_SCOPE_EXIT
    {
        IFileManager::Get().DeleteDirectory(*Directory, false, true);
        TArray<FAssetData> Assets;
        FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get()
            .GetAssetsByPath(FName(*FPaths::GetPath(Folder)), Assets, true);
        TArray<UObject*> Objects;
        for (const FAssetData& Asset : Assets) { if (UObject* Object = Asset.GetAsset()) { Objects.Add(Object); } }
        if (!Objects.IsEmpty()) { ObjectTools::ForceDeleteObjects(Objects, false); }
    };
    if (!TestTrue(TEXT("Write the one-triangle glTF fixture"), FFileHelper::SaveStringToFile(TopoTopoPrototypeImportTests::GLTF, *File)))
    {
        return false;
    }
    FString Error;
    const bool bImported = TopoTopoImport::ImportGLB(File, Folder, TEXT("rock"), Meshes, Error);
    if (!TestTrue(TEXT("Interchange imports the prototype: ") + Error, bImported)) { return false; }
    if (!TestEqual(TEXT("Exactly one static mesh"), Meshes.Num(), 1)) { return false; }
    TestEqual(TEXT("Mesh keeps the prototype name despite a material of the same name"), Meshes[0]->GetName(), FString(TEXT("rock")));
    TestEqual(TEXT("Mesh stays at the predictable mapping path"), Meshes[0]->GetPathName(), Folder / TEXT("rock.rock"));
    const TArray<FStaticMaterial>& Materials = Meshes[0]->GetStaticMaterials();
    if (TestEqual(TEXT("The prototype has its material"), Materials.Num(), 1) && TestNotNull(TEXT("Material assigned"), Materials[0].MaterialInterface.Get()))
    {
        const FString MaterialPath = Materials[0].MaterialInterface->GetPathName();
        TestTrue(TEXT("Material lives in the Materials sub-folder: ") + MaterialPath, MaterialPath.StartsWith(Folder / TEXT("Materials/")));
    }
    return !HasAnyErrors();
}

#endif // WITH_DEV_AUTOMATION_TESTS
