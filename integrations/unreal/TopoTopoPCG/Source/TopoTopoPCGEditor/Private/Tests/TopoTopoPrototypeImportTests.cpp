// Copyright 2026 faxcorp, Apache-2.0
#if WITH_DEV_AUTOMATION_TESTS

#include "TopoTopoLandscapeImport.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "CoreGlobals.h"
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

// The same triangle as a prototype named Mesh whose material is named Material.
static FString Named(const FString& Mesh, const FString& Material)
{
    FString Out = GLTF;
    Out.ReplaceInline(TEXT("\"mesh\": 0, \"name\": \"rock\""), *FString::Printf(TEXT("\"mesh\": 0, \"name\": \"%s\""), *Mesh));
    Out.ReplaceInline(TEXT("{\"name\": \"rock\", \"primitives\""), *FString::Printf(TEXT("{\"name\": \"%s\", \"primitives\""), *Mesh));
    Out.ReplaceInline(TEXT("[{\"name\": \"rock\", \"pbrMetallicRoughness\""), *FString::Printf(TEXT("[{\"name\": \"%s\", \"pbrMetallicRoughness\""), *Material));
    return Out;
}
}

// Found 2026-10-16 in the demo bundle: fir, oak and pine all use a material named "bark". With one shared Materials
// folder the second prototype's import asked, in a modal dialog, whether to override the first one's material, and
// the automated import stalled. Each prototype now has Materials/<prototype>.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoPrototypeSharedMaterialTest, "TopoTopo.Editor.PrototypesShareMaterialName",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoPrototypeSharedMaterialTest::RunTest(const FString& Parameters)
{
    const FString Id = FGuid::NewGuid().ToString(EGuidFormats::Digits);
    const FString Directory = FPaths::ConvertRelativePathToFull(FPaths::ProjectIntermediateDir() / TEXT("Automation/TopoTopo/Shared") / Id);
    const FString Folder = TEXT("/Game/TopoTopo/Automation_") + Id + TEXT("/Meshes");
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
    // a regression must fail here, not wait for someone to click a dialog
    TGuardValue<bool> Unattended(GIsRunningUnattendedScript, true);
    for (const TCHAR* Name : {TEXT("fir"), TEXT("oak")})
    {
        const FString File = Directory / FString(Name) + TEXT(".gltf");
        if (!TestTrue(TEXT("Write fixture"), FFileHelper::SaveStringToFile(TopoTopoPrototypeImportTests::Named(Name, TEXT("bark")), *File))) { return false; }
        TArray<UStaticMesh*> Meshes;
        FString Error;
        if (!TestTrue(FString::Printf(TEXT("Import %s: %s"), Name, *Error), TopoTopoImport::ImportGLB(File, Folder, Name, Meshes, Error)) || !TestEqual(TEXT("One mesh"), Meshes.Num(), 1)) { return false; }
        TestEqual(TEXT("Mesh keeps its prototype name"), Meshes[0]->GetPathName(), Folder / FString(Name) + TEXT(".") + Name);
        const TArray<FStaticMaterial>& Slots = Meshes[0]->GetStaticMaterials();
        if (TestEqual(TEXT("One material slot"), Slots.Num(), 1) && TestNotNull(TEXT("Material assigned"), Slots[0].MaterialInterface.Get()))
        {
            TestEqual(TEXT("Material in the prototype's own folder"), Slots[0].MaterialInterface->GetPathName(),
                Folder / TEXT("Materials") / FString(Name) / TEXT("bark.bark"));
        }
    }
    return !HasAnyErrors();
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
