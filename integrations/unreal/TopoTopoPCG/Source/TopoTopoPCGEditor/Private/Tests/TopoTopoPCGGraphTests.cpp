// Copyright 2026 faxcorp, Apache-2.0
#if WITH_DEV_AUTOMATION_TESTS

#include "PCGTopoTopoInstanceSpawnerSettings.h"
#include "PCGTopoTopoPointStreamSettings.h"
#include "PCGComponent.h"
#include "PCGGraph.h"
#include "PCGNode.h"
#include "PCGSubsystem.h"
#include "Components/BoxComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Data/PCGBasePointData.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformTime.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

namespace TopoTopoGraphTests
{
constexpr double GenerationTimeoutSeconds = 60.0;
constexpr const TCHAR* MeshFolder = TEXT("/Game/TopoTopo/PluginDemo/Meshes");

struct FExpectedMesh
{
    const TCHAR* Name;
    int32 Instances;
};

constexpr FExpectedMesh ExpectedMeshes[] = {
    {TEXT("pine"), 117}, {TEXT("fir"), 81}, {TEXT("oak"), 94},
    {TEXT("rock_a"), 118}, {TEXT("rock_b"), 125}
};

FString FindDemoCSV()
{
    FString Path;
    if (FParse::Value(FCommandLine::Get(), TEXT("TopoTopoDemoCSV="), Path))
    {
        return TopoTopoStream::ResolveFilePath(Path);
    }
    Path = FPlatformMisc::GetEnvironmentVariable(TEXT("TOPOTOPO_DEMO_CSV"));
    if (!Path.IsEmpty())
    {
        return TopoTopoStream::ResolveFilePath(Path);
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
            if (Parent == Root) { break; }
            Root = Parent;
        }
    }
    return FString();
}

struct FCompletion
{
    bool bCompleted = false;
    bool bAborted = false;
};

/** The component follows the public generate-and-wait path, including managed resources and postprocessing.
 * Only this isolated world's subsystem is ticked explicitly. The automation frame pump services async asset
 * loads and PCG's next-frame callbacks; spinning Execute() synchronously would prevent those from advancing.
 */
class FGenerateAndCheck final : public IAutomationLatentCommand
{
public:
    explicit FGenerateAndCheck(FAutomationTestBase& InTest) : Test(InTest) {}

    virtual ~FGenerateAndCheck() override
    {
        Cleanup();
    }

    bool Initialize(const FString& FilePath)
    {
        if (!Test.TestNotNull(TEXT("Engine available for isolated PCG test world"), GEngine))
        {
            return false;
        }

        const FName WorldName = MakeUniqueObjectName(GetTransientPackage(), UWorld::StaticClass(), TEXT("TopoTopoPCGTestWorld"));
        World = UWorld::CreateWorld(EWorldType::Game, false, WorldName, GetTransientPackage());
        if (!Test.TestNotNull(TEXT("Transient test world created"), World))
        {
            return false;
        }
        // CreateWorld roots the world; the context makes async engine callbacks resolve the correct world.
        GEngine->CreateNewWorldContext(EWorldType::Game).SetCurrentWorld(World);
        Subsystem = UPCGSubsystem::GetInstance(World);
        if (!Test.TestNotNull(TEXT("Test world's PCG subsystem initialized"), Subsystem))
        {
            return false;
        }

        FActorSpawnParameters SpawnParameters;
        SpawnParameters.ObjectFlags = RF_Transient;
        Actor = World->SpawnActor<AActor>(SpawnParameters);
        if (!Test.TestNotNull(TEXT("Transient PCG owner created"), Actor))
        {
            return false;
        }
        // Bounds must exist before the PCG component registers. A component on a bounded actor is equivalent
        // to a PCG volume for this graph, and needs no editor brush builder or persistent level change.
        UBoxComponent* Bounds = NewObject<UBoxComponent>(Actor, TEXT("Bounds"), RF_Transient);
        Bounds->SetBoxExtent(FVector(20000.0));
        Bounds->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        Actor->AddInstanceComponent(Bounds);
        Actor->SetRootComponent(Bounds);
        Bounds->RegisterComponent();
        // Nonidentity owner catches a regression that accidentally treats stream transforms as local space.
        Actor->SetActorLocation(FVector(137.0, -251.0, 83.0));

        Component = NewObject<UPCGComponent>(Actor, TEXT("PCG"), RF_Transient);
        Component->GenerationTrigger = EPCGComponentGenerationTrigger::GenerateOnDemand;
        Component->bRegenerateInEditor = false;
        Actor->AddInstanceComponent(Component);
        Component->RegisterComponent();
        Component->SetIsPartitioned(false);

        UPCGGraph* Graph = NewObject<UPCGGraph>(Component, NAME_None, RF_Transient);
        UPCGTopoTopoPointStreamSettings* StreamSettings = nullptr;
        UPCGNode* StreamNode = Graph->AddNodeOfType(StreamSettings);
        UPCGTopoTopoInstanceSpawnerSettings* SpawnerSettings = nullptr;
        UPCGNode* SpawnerNode = Graph->AddNodeOfType(SpawnerSettings);
        if (!Test.TestNotNull(TEXT("Point stream node created"), StreamNode)
            || !Test.TestNotNull(TEXT("Instance spawner node created"), SpawnerNode))
        {
            return false;
        }
        StreamSettings->FilePath = FilePath;
        StreamSettings->CoordinateMode = ETopoTopoCoordinateMode::AsWritten;
        StreamSettings->MeshFolder = MeshFolder;
        SpawnerSettings->SetExecuteOnGPU(false);
        if (!Test.TestNotNull(TEXT("Point Stream Out -> Instance Spawner In"),
                Graph->AddEdge(StreamNode, PCGPinConstants::DefaultOutputLabel, SpawnerNode, PCGPinConstants::DefaultInputLabel))
            || !Test.TestNotNull(TEXT("Instance Spawner Out -> graph Output Out"),
                Graph->AddEdge(SpawnerNode, PCGPinConstants::DefaultOutputLabel, Graph->GetOutputNode(), PCGPinConstants::DefaultOutputLabel)))
        {
            return false;
        }

        Component->SetGraph(Graph);
        const FPCGTaskId GenerationTask = Component->GenerateLocalGetTaskId(true);
        if (!Test.TestTrue(TEXT("PCG subsystem scheduled graph generation"), GenerationTask != InvalidPCGTaskId))
        {
            return false;
        }
        const TSharedRef<FCompletion> Result = Completion;
        const FPCGTaskId WaitTask = Subsystem->ScheduleGeneric(
            [Result]() { Result->bCompleted = true; return true; },
            [Result]() { Result->bAborted = true; }, Component, {GenerationTask});
        if (!Test.TestTrue(TEXT("Completion sentinel scheduled after generation"), WaitTask != InvalidPCGTaskId))
        {
            return false;
        }
        StartSeconds = FPlatformTime::Seconds();
        return true;
    }

    virtual bool Update() override
    {
        Subsystem->Tick(1.0f / 60.0f);
        if (Completion->bAborted)
        {
            Test.AddError(TEXT("PCG graph generation was aborted before its completion sentinel."));
            Cleanup();
            return true;
        }
        if (Completion->bCompleted)
        {
            CheckResult();
            Cleanup();
            return true;
        }
        if (FPlatformTime::Seconds() - StartSeconds >= GenerationTimeoutSeconds)
        {
            Test.AddError(TEXT("PCG graph generation timed out after 60 seconds; cancelling tasks and destroying the transient test world."));
            Cleanup();
            return true;
        }
        return false;
    }

    // Keep preflight-loaded meshes alive even when they are newly imported, unsaved Content Browser assets.
    TArray<TStrongObjectPtr<UStaticMesh>> Meshes;

private:
    void CheckResult()
    {
        Test.TestFalse(TEXT("PCG component finished generation"), Component->IsGenerating());
        Test.TestTrue(TEXT("PCG component reports generated"), Component->bGenerated);
        int32 OutputPoints = 0;
        for (const FPCGTaggedData& TaggedData : Component->GetGeneratedGraphOutput().TaggedData)
        {
            const UPCGBasePointData* Points = Cast<UPCGBasePointData>(TaggedData.Data);
            if (Test.TestNotNull(TEXT("Graph output contains point data"), Points))
            {
                OutputPoints += Points->GetNumPoints();
            }
        }
        Test.TestEqual(TEXT("Graph output contains 535 points"), OutputPoints, 535);

        TArray<UInstancedStaticMeshComponent*> Instances;
        Actor->GetComponents(Instances); // Includes UHierarchicalInstancedStaticMeshComponent subclasses.
        Test.TestEqual(TEXT("Exactly five ISM/HISM components"), Instances.Num(), 5);
        int32 TotalInstances = 0;
        for (const FExpectedMesh& Expected : ExpectedMeshes)
        {
            const FString ExpectedPath = FString::Printf(TEXT("%s/%s.%s"), MeshFolder, Expected.Name, Expected.Name);
            int32 MeshInstances = 0;
            int32 MeshComponents = 0;
            for (UInstancedStaticMeshComponent* Instance : Instances)
            {
                if (!Instance->GetStaticMesh() || Instance->GetStaticMesh()->GetPathName() != ExpectedPath) { continue; }
                ++MeshComponents;
                MeshInstances += Instance->GetInstanceCount();
                if (FString(Expected.Name) == TEXT("pine"))
                {
                    FTransform First;
                    if (Test.TestTrue(TEXT("First pine instance has a world transform"), Instance->GetInstanceTransform(0, First, true)))
                    {
                        // ISM matrices are floats even with LWC. 0.01 cm / 0.0001 degrees/scale comfortably
                        // covers float storage without permitting an axis swap or local/world-space error.
                        Test.TestTrue(TEXT("First pine world position"),
                            First.GetLocation().Equals(FVector(3840.23858, -6233.69197, 363.347349), 0.01));
                        Test.TestTrue(TEXT("First pine world rotation"),
                            First.Rotator().Equals(FRotator(0, -105.954505, 0), 0.0001));
                        Test.TestTrue(TEXT("First pine world scale"),
                            First.GetScale3D().Equals(FVector(2.02927671), 0.0001));
                    }
                }
            }
            Test.TestEqual(FString::Printf(TEXT("%s has one ISM/HISM component"), Expected.Name), MeshComponents, 1);
            Test.TestEqual(FString::Printf(TEXT("%s instance count"), Expected.Name), MeshInstances, Expected.Instances);
            TotalInstances += MeshInstances;
        }
        Test.TestEqual(TEXT("Total spawned instance count"), TotalInstances, 535);
    }

    void Cleanup()
    {
        if (!World) { return; }
        if (Component)
        {
            // Cancel active generation before releasing resources. World teardown below also releases any
            // remaining sentinel when generation has already finished; its callbacks own their state.
            if (Subsystem) { Subsystem->CancelGeneration(Component); }
            Component->CleanupLocalImmediate(true);
            Component->UnregisterComponent();
            Component = nullptr;
        }
        World->DestroyWorld(false);
        if (GEngine) { GEngine->DestroyWorldContext(World); }
        World->RemoveFromRoot();
        World = nullptr;
        Actor = nullptr;
        Subsystem = nullptr;
    }

    FAutomationTestBase& Test;
    UWorld* World = nullptr;
    AActor* Actor = nullptr;
    UPCGComponent* Component = nullptr;
    UPCGSubsystem* Subsystem = nullptr;
    TSharedRef<FCompletion> Completion = MakeShared<FCompletion>();
    double StartSeconds = 0;
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FTopoTopoPCGGraphSpawns536Test, "TopoTopo.PCG.GraphSpawns536",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FTopoTopoPCGGraphSpawns536Test::RunTest(const FString& Parameters)
{
    using namespace TopoTopoGraphTests;
    const FString FilePath = FindDemoCSV();
    if (FilePath.IsEmpty() || !FPaths::FileExists(FilePath))
    {
        AddError(TEXT("Demo CSV missing. Run npm run export:demo, then supply -TopoTopoDemoCSV=\"<repository>/out/unreal_demo/landscape/instances.csv\" ")
            TEXT("or TOPOTOPO_DEMO_CSV before starting the editor."));
        return false;
    }

    TSharedRef<FGenerateAndCheck> Command = MakeShared<FGenerateAndCheck>(*this);
    TArray<FString> MissingMeshes;
    for (const FExpectedMesh& Expected : ExpectedMeshes)
    {
        const FSoftObjectPath Path(FString::Printf(TEXT("%s/%s.%s"), MeshFolder, Expected.Name, Expected.Name));
        if (!Path.ResolveObject() && !FPackageName::DoesPackageExist(Path.GetLongPackageName()))
        {
            MissingMeshes.Add(Path.ToString());
            continue;
        }
        UStaticMesh* Mesh = Cast<UStaticMesh>(Path.TryLoad());
        if (!TestNotNull(TEXT("Demo asset loads as a Static Mesh: ") + Path.ToString(), Mesh))
        {
            return false;
        }
        Command->Meshes.Emplace(Mesh);
    }
    if (!MissingMeshes.IsEmpty())
    {
        // UE simple automation has no skipped-result API. Surface an explicit warning, never a silent pass.
        AddWarning(TEXT("SKIPPED TopoTopo.PCG.GraphSpawns536: required demo meshes are absent: ")
            + FString::Join(MissingMeshes, TEXT(", "))
            + TEXT(". Import the demo into /Game/TopoTopo/PluginDemo using TopoTopo.ImportScene, then rerun. No PCG assertions were executed."));
        return true;
    }
    AddInfo(TEXT("Generating real PCG graph in an isolated transient test world from: ") + FilePath);
    if (!Command->Initialize(FilePath))
    {
        return false;
    }
    FAutomationTestFramework::Get().EnqueueLatentCommand(Command);
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
