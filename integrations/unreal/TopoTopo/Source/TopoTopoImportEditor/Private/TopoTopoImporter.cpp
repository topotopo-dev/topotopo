// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoImporter.h"

#include "AssetImportTask.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "Containers/Ticker.h"
#include "Data/PCGPointArrayData.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "EditorFramework/AssetImportData.h"
#include "Engine/StaticMesh.h"
#include "PhysicsEngine/BodySetup.h"
#include "Engine/StaticMeshSocket.h"
#include "EngineUtils.h"
#include "FileHelpers.h"
#include "Framework/Notifications/NotificationManager.h"
#include "IAssetTools.h"
#include "InterchangeAssetImportData.h"
#include "InterchangeGenericAssetsPipeline.h"
#include "InterchangeGenericAssetsPipelineSharedSettings.h"
#include "InterchangeGenericMaterialPipeline.h"
#include "InterchangeGenericMeshPipeline.h"
#include "InterchangeGenericTexturePipeline.h"
#include "InterchangeManager.h"
#include "InterchangeSourceData.h"
#include "Logging/MessageLog.h"
#include "Materials/MaterialInterface.h"
#include "Metadata/PCGMetadata.h"
#include "Misc/DefaultValueHelper.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "PCGCommon.h"
#include "PCGDataAsset.h"
#include "Serialization/Csv/CsvParser.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshEditorSubsystem.h"
#include "TopoTopoCook.h"
#include "TopoTopoFolderPipeline.h"
#include "TopoTopoInstances.h"
#include "TopoTopoPackage.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/UObjectIterator.h"
#include "Widgets/Notifications/SNotificationList.h"

const FName TopoTopo::MessageLogName(TEXT("TopoTopo"));

namespace
{
    FString ProjectFile(const FString& Rel) { return FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()) / Rel; }

    TSharedPtr<FJsonObject> ReadJson(const FString& File)
    {
        FString Text;
        TSharedPtr<FJsonObject> Root;
        if (!FFileHelper::LoadFileToString(Text, *File) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root)) { return nullptr; }
        return Root;
    }

    /** One step of a report's `import` (ImportStep in the cook). */
    struct FStep
    {
        FString As, File, Folder, Name, Sockets;
        TArray<FString> Lods;
        TMap<FString, FString> Meshes;

        explicit FStep(const FJsonObject& Json)
        {
            Json.TryGetStringField(TEXT("as"), As);
            Json.TryGetStringField(TEXT("file"), File);
            Json.TryGetStringField(TEXT("folder"), Folder);
            Json.TryGetStringField(TEXT("name"), Name);
            Json.TryGetStringField(TEXT("sockets"), Sockets);
            Json.TryGetStringArrayField(TEXT("lods"), Lods);
            const TSharedPtr<FJsonObject>* Map = nullptr;
            if (Json.TryGetObjectField(TEXT("meshes"), Map))
            {
                for (const auto& It : (*Map)->Values) { Meshes.Add(FString(*It.Key), It.Value->AsString()); }
            }
        }

        TArray<FString> Files() const
        {
            TArray<FString> Out = Lods;
            Out.Add(File);
            if (!Sockets.IsEmpty()) { Out.Add(Sockets); }
            return Out;
        }

        FString ObjectPath() const { return Folder / Name + TEXT(".") + Name; }
        FString PackagePath() const { return Folder / Name; }
    };

    /** Everything imported in one go, saved at its end. */
    struct FSession
    {
        TSet<UPackage*> ToSave;

        void Touched(UObject* Object)
        {
            if (Object && Object->GetPackage() != GetTransientPackage()) { ToSave.Add(Object->GetPackage()); }
        }
    };

    // ------------------------------------------------------------------------------------------------- meshes

    /** The pipelines a GLB is imported with, kept alive while Interchange uses them. */
    struct FGlbPipelines
    {
        TStrongObjectPtr<UInterchangeGenericAssetsPipeline> Assets;
        TStrongObjectPtr<UTopoTopoFolderPipeline> Folders;
        FImportAssetParameters Parameters;

        bool Make(const FString& Name, bool bMaterials, bool bNanite, FString& Error)
        {
            UInterchangeGenericAssetsPipeline* Template = LoadObject<UInterchangeGenericAssetsPipeline>(nullptr,
                TEXT("/Interchange/Pipelines/DefaultGLTFAssetsPipeline.DefaultGLTFAssetsPipeline"));
            if (!Template)
            {
                Error = TEXT("Interchange's DefaultGLTFAssetsPipeline is unavailable: enable the Interchange Framework plugin and restart");
                return false;
            }
            Assets.Reset(DuplicateObject(Template, GetTransientPackage()));
            // an asset that exists takes the pipeline's values again, but keeps what was changed on it in the editor since
            Assets->ReimportStrategy = EReimportStrategyFlags::ApplyEditorChangedProperties;
            Assets->bUseSourceNameForAsset = true;
            Assets->AssetName = Name;
            Assets->bSceneNameSubFolder = false;
            Assets->bAssetTypeSubFolders = false;
            Assets->CommonMeshesProperties->bBakeMeshes = true;
            Assets->MeshPipeline->bImportStaticMeshes = true;
            Assets->MeshPipeline->CombineStaticMeshesBehavior = EInterchangeCombineStaticMeshesBehavior::All;
            if (!bNanite) { Assets->MeshPipeline->bBuildNanite = false; }
            Assets->MaterialPipeline->bImportMaterials = bMaterials;
            // the default reuses a material of the same name already in the folder
            Assets->MaterialPipeline->bReuseExistingMaterials = false;
            Assets->MaterialPipeline->TexturePipeline->bImportTextures = bMaterials;

            Parameters.bIsAutomated = true;
            Parameters.bReplaceExisting = true;
            Parameters.OverridePipelines.Add(FSoftObjectPath(Assets.Get()));
            // the second native glTF pipeline maps glTF materials to the engine's material templates
            Parameters.OverridePipelines.Add(FSoftObjectPath(TEXT("/Interchange/Pipelines/DefaultGLTFPipeline.DefaultGLTFPipeline")));
            Folders.Reset(NewObject<UTopoTopoFolderPipeline>(GetTransientPackage()));
            Parameters.OverridePipelines.Add(FSoftObjectPath(Folders.Get()));
            return true;
        }
    };

    template <typename T>
    T* LoadQuiet(const FString& Path) { return LoadObject<T>(nullptr, *Path, nullptr, LOAD_NoWarn | LOAD_Quiet); }

    /**
     * A GLB into a static mesh in Folder. Materials (null: none are imported) holds the materials this plugin's imports made
     * from the file before, and gets the ones made now.
     */
    UStaticMesh* ImportGlb(const FString& File, const FString& Folder, const FString& Name, TArray<FSoftObjectPath>* Materials, bool bNanite, FSession* Session, FString& Error)
    {
        const bool bMaterials = Materials != nullptr;
        FGlbPipelines Pipelines;
        if (!Pipelines.Make(Name, bMaterials, bNanite, Error)) { return nullptr; }
        TStrongObjectPtr<UInterchangeSourceData> Source(UInterchangeManager::CreateSourceData(File));
        TArray<UObject*> Imported;
        if (!UInterchangeManager::GetInterchangeManager().ImportAsset(Folder, Source.Get(), Pipelines.Parameters, Imported))
        {
            Error = FString::Printf(TEXT("Interchange could not import %s (see the Interchange log)"), *File);
            return nullptr;
        }
        UStaticMesh* Mesh = nullptr;
        for (UObject* Object : Imported)
        {
            if (Session) { Session->Touched(Object); }
            if (UStaticMesh* Found = Cast<UStaticMesh>(Object)) { Mesh = Found; }
        }
        if (!Mesh) { Error = FString::Printf(TEXT("Interchange made no static mesh from %s"), *File); return nullptr; }
        if (!bMaterials) { return Mesh; }
        // an import over a mesh leaves the materials it already has as they were, so a changed material would never come
        // through: the materials this plugin's imports made from this GLB are reimported from it, whether or not a slot
        // still uses them. Only those, by the list the package keeps: a copy of one (Ctrl+D) has the same source file and
        // is someone's own. They belong to the package, so they take all of its values (a reimport runs with the pipelines
        // stored on the asset); an artist's choice is a material assigned to a slot or an actor, which stays
        TArray<FSoftObjectPath> Ours;
        for (UObject* Object : Imported)
        {
            if (Cast<UMaterialInterface>(Object)) { Ours.AddUnique(FSoftObjectPath(Object)); }
        }
        for (const FSoftObjectPath& Path : *Materials)
        {
            UMaterialInterface* Material = LoadQuiet<UMaterialInterface>(Path.ToString());
            if (!Material || !Material->AssetImportData || !FPaths::IsSamePath(Material->AssetImportData->GetFirstFilename(), File)) { continue; }
            Ours.AddUnique(Path);
            if (UInterchangeAssetImportData* Data = Cast<UInterchangeAssetImportData>(Material->AssetImportData))
            {
                TArray<UObject*> Stored = Data->GetPipelines();
                for (UObject* Stage : Stored)
                {
                    if (UInterchangeGenericAssetsPipeline* Assets = Cast<UInterchangeGenericAssetsPipeline>(Stage)) { Assets->ReimportStrategy = EReimportStrategyFlags::ApplyPipelineProperties; }
                }
                Data->SetPipelines(Stored);
            }
            FGlbPipelines Again;
            if (!Again.Make(Name, true, bNanite, Error)) { return nullptr; }
            Again.Parameters.ReimportAsset = Material;
            TArray<UObject*> Reimported;
            if (!UInterchangeManager::GetInterchangeManager().ReimportAsset(Material, Again.Parameters, Reimported))
            {
                UE_LOG(LogTopoTopo, Warning, TEXT("TopoTopo: %s was not reimported from %s"), *Material->GetPathName(), *File);
                continue;
            }
            for (UObject* Object : Reimported) { if (Session) { Session->Touched(Object); } }
        }
        *Materials = MoveTemp(Ours);
        return Mesh;
    }

    /** A LOD's GLB, imported aside into /Temp; Discard it after use. */
    UStaticMesh* ImportAside(const FString& File, FString& Error)
    {
        const FString Temp = FString::Printf(TEXT("/Temp/TopoTopo/%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));
        return ImportGlb(File, Temp, TEXT("Lod"), nullptr, false, nullptr, Error);
    }

    void Discard(UStaticMesh* Lod)
    {
        Lod->GetPackage()->SetDirtyFlag(false);
        Lod->MarkAsGarbage();
    }

    /** A LOD imported aside into a mesh's LOD. Its materials are the mesh's own, by slot name, so no slot is added. */
    bool SetLod(UStaticMesh* Mesh, int32 Index, UStaticMesh* Lod, const FString& File, FString& Error)
    {
        TArray<FStaticMaterial>& Slots = Lod->GetStaticMaterials();
        for (FStaticMaterial& Slot : Slots)
        {
            for (const FStaticMaterial& Own : Mesh->GetStaticMaterials())
            {
                if (Own.ImportedMaterialSlotName == Slot.ImportedMaterialSlotName) { Slot.MaterialInterface = Own.MaterialInterface; }
            }
        }
        const int32 Set = GEditor->GetEditorSubsystem<UStaticMeshEditorSubsystem>()->SetLodFromStaticMesh(Mesh, Index, Lod, 0, true);
        if (Set < 0) { Error = FString::Printf(TEXT("LOD %d could not be set from %s"), Index, *File); return false; }
        return true;
    }

    /** A mesh's sockets from their file; earlier ones of ours go, ones an artist added stay. */
    void SetSockets(UStaticMesh* Mesh, const FString& File)
    {
        static const FString Tag(TEXT("TopoTopo"));
        Mesh->Sockets.RemoveAll([](const TObjectPtr<UStaticMeshSocket>& S) { return !S || S->Tag == Tag; });
        const TSharedPtr<FJsonObject> Root = File.IsEmpty() ? nullptr : ReadJson(ProjectFile(File));
        const TArray<TSharedPtr<FJsonValue>>* Sockets = nullptr;
        if (!Root || !Root->TryGetArrayField(TEXT("sockets"), Sockets)) { return; }
        const auto Vec = [](const FJsonObject& O, const TCHAR* Key)
        {
            const TArray<TSharedPtr<FJsonValue>>* A = nullptr;
            return O.TryGetArrayField(Key, A) && A->Num() == 3 ? FVector((*A)[0]->AsNumber(), (*A)[1]->AsNumber(), (*A)[2]->AsNumber()) : FVector::ZeroVector;
        };
        for (const TSharedPtr<FJsonValue>& Value : *Sockets)
        {
            const FJsonObject& O = *Value->AsObject();
            UStaticMeshSocket* Socket = NewObject<UStaticMeshSocket>(Mesh);
            Socket->SocketName = FName(*O.GetStringField(TEXT("name")));
            Socket->RelativeLocation = Vec(O, TEXT("location"));
            const TSharedPtr<FJsonObject> Rot = O.GetObjectField(TEXT("rotation"));
            Socket->RelativeRotation = FRotator(Rot->GetNumberField(TEXT("pitch")), Rot->GetNumberField(TEXT("yaw")), Rot->GetNumberField(TEXT("roll")));
            Socket->RelativeScale = Vec(O, TEXT("scale"));
            Socket->Tag = Tag;
            Mesh->AddSocket(Socket);
        }
    }

    /** Whether a GLB has collision pieces: nodes named UCX_ (the cook's name for -convcolonly / -colonly pieces). */
    bool HasCollisionPieces(const FString& File)
    {
        TArray<uint8> Bytes;
        if (!FFileHelper::LoadFileToArray(Bytes, *File) || Bytes.Num() < 20) { return false; }
        const uint32 Length = Bytes[12] | (Bytes[13] << 8) | (Bytes[14] << 16) | (uint32(Bytes[15]) << 24);
        if (20 + int64(Length) > Bytes.Num()) { return false; }
        const FString Text = FString(FUTF8ToTCHAR(reinterpret_cast<const ANSICHAR*>(Bytes.GetData() + 20), Length));
        TSharedPtr<FJsonObject> Root;
        const TArray<TSharedPtr<FJsonValue>>* Nodes = nullptr;
        if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root || !Root->TryGetArrayField(TEXT("nodes"), Nodes)) { return false; }
        for (const TSharedPtr<FJsonValue>& Node : *Nodes)
        {
            FString Name;
            if (Node->AsObject() && Node->AsObject()->TryGetStringField(TEXT("name"), Name) && Name.StartsWith(TEXT("UCX_"), ESearchCase::CaseSensitive)) { return true; }
        }
        return false;
    }

    /**
     * A mesh step. Materials is the output's list of the materials this plugin made; the ones made from this step's GLB are
     * replaced by what the import made. A step that fails leaves the saved mesh as it was: its packages are not saved, and
     * its hashes are not recorded, so the next cook imports it again.
     */
    UObject* ImportMeshStep(const FStep& Step, TArray<FSoftObjectPath>& Materials, FSession& Session, FString& Error)
    {
        const FString File = ProjectFile(Step.File);
        // the LODs first, aside: a LOD that cannot be imported leaves the mesh untouched
        TArray<TStrongObjectPtr<UStaticMesh>> Lods;
        ON_SCOPE_EXIT { for (const TStrongObjectPtr<UStaticMesh>& Lod : Lods) { Discard(Lod.Get()); } };
        for (const FString& Lod : Step.Lods)
        {
            UStaticMesh* Aside = ImportAside(ProjectFile(Lod), Error);
            if (!Aside) { return nullptr; }
            Lods.Emplace(Aside);
        }

        // a GLB with collision pieces owns the mesh's simple collision: the old hulls go first, or Interchange copies the new
        // ones over them (an engine ensure) and keeps a hull Unreal generated before there were pieces; they come back if
        // the import fails
        UStaticMesh* Old = HasCollisionPieces(File) ? LoadQuiet<UStaticMesh>(Step.ObjectPath()) : nullptr;
        UBodySetup* Body = Old ? Old->GetBodySetup() : nullptr;
        FKAggregateGeom Hulls;
        const bool bWasDirty = Old && Old->GetPackage()->IsDirty();
        if (Body)
        {
            Hulls = Body->AggGeom;
            Body->Modify();
            Body->RemoveSimpleCollision();
        }
        TArray<FSoftObjectPath> Made;
        TArray<FSoftObjectPath> Others;
        for (const FSoftObjectPath& Path : Materials)
        {
            const UMaterialInterface* Material = LoadQuiet<UMaterialInterface>(Path.ToString());
            if (!Material) { continue; }
            (Material->AssetImportData && FPaths::IsSamePath(Material->AssetImportData->GetFirstFilename(), File) ? Made : Others).Add(Path);
        }
        FSession Own;
        UStaticMesh* Mesh = ImportGlb(File, Step.Folder, Step.Name, &Made, Step.Lods.IsEmpty(), &Own, Error);
        if (!Mesh)
        {
            if (Body)
            {
                Body->AggGeom = Hulls;
                Body->InvalidatePhysicsData();
                Body->CreatePhysicsMeshes();
                Old->GetPackage()->SetDirtyFlag(bWasDirty);
            }
            return nullptr;
        }
        for (int32 I = 0; I < Lods.Num(); I++)
        {
            if (!SetLod(Mesh, I + 1, Lods[I].Get(), Step.Lods[I], Error)) { return nullptr; }
        }
        // a LOD the graph no longer has goes
        if (Mesh->GetNumSourceModels() > Lods.Num() + 1)
        {
            UE_LOG(LogTopoTopo, Log, TEXT("TopoTopo: %s had %d LODs, the cook has %d"), *Step.ObjectPath(), Mesh->GetNumSourceModels(), Lods.Num() + 1);
            Mesh->SetNumSourceModels(Lods.Num() + 1);
        }
        SetSockets(Mesh, Step.Sockets);
        Mesh->PostEditChange();
        Mesh->MarkPackageDirty();
        Session.ToSave.Append(Own.ToSave);
        Materials = MoveTemp(Others);
        Materials.Append(Made);
        return Mesh;
    }

    UObject* ImportTextureStep(const FStep& Step, FSession& Session, FString& Error)
    {
        TStrongObjectPtr<UAssetImportTask> Task(NewObject<UAssetImportTask>(GetTransientPackage()));
        Task->Filename = ProjectFile(Step.File);
        Task->DestinationPath = Step.Folder;
        Task->DestinationName = Step.Name;
        Task->bReplaceExisting = true;
        Task->bAutomated = true;
        Task->bSave = false;
        FAssetToolsModule::GetModule().Get().ImportAssetTasks({ Task.Get() });
        for (UObject* Object : Task->GetObjects())
        {
            if (Object) { Session.Touched(Object); return Object; }
        }
        Error = FString::Printf(TEXT("the texture %s could not be imported"), *Step.File);
        return nullptr;
    }

    // ------------------------------------------------------------------------------------------------- rows

    /** A CSV's rows by column name. */
    struct FTable
    {
        TUniquePtr<FCsvParser> Parser;
        FString Text;
        TMap<FString, int32> Columns;
        TArray<FString> Names;

        bool Load(const FString& File)
        {
            if (!FFileHelper::LoadFileToString(Text, *File)) { return false; }
            Parser = MakeUnique<FCsvParser>(Text);
            if (Parser->GetRows().IsEmpty()) { return false; }
            for (const TCHAR* Cell : Parser->GetRows()[0])
            {
                Columns.Add(Cell, Names.Num());
                Names.Add(Cell);
            }
            return true;
        }

        int32 Num() const { return Parser->GetRows().Num() - 1; }

        const TCHAR* Cell(int32 Row, int32 Column) const
        {
            const TArray<const TCHAR*>& Cells = Parser->GetRows()[Row + 1];
            return Cells.IsValidIndex(Column) ? Cells[Column] : TEXT("");
        }

        double Number(int32 Row, const TCHAR* Name, double Default = 0) const
        {
            const int32* Column = Columns.Find(Name);
            return Column ? FCString::Atod(Cell(Row, *Column)) : Default;
        }

        FString String(int32 Row, const TCHAR* Name) const
        {
            const int32* Column = Columns.Find(Name);
            return Column ? FString(Cell(Row, *Column)) : FString();
        }

        FTransform Transform(int32 Row) const
        {
            const FRotator Rotation(Number(Row, TEXT("Rotation.Pitch")), Number(Row, TEXT("Rotation.Yaw")), Number(Row, TEXT("Rotation.Roll")));
            const FVector Position(Number(Row, TEXT("Position.X")), Number(Row, TEXT("Position.Y")), Number(Row, TEXT("Position.Z")));
            const FVector Scale(Number(Row, TEXT("Scale.X"), 1), Number(Row, TEXT("Scale.Y"), 1), Number(Row, TEXT("Scale.Z"), 1));
            return FTransform(Rotation.Quaternion(), Position, Scale);
        }
    };

    template <typename T>
    T* FindOrCreateAsset(const FStep& Step, FSession& Session)
    {
        UPackage* Package = CreatePackage(*Step.PackagePath());
        Package->FullyLoad();
        T* Asset = FindObject<T>(Package, *Step.Name);
        const bool bNew = !Asset;
        if (bNew) { Asset = NewObject<T>(Package, FName(*Step.Name), RF_Public | RF_Standalone | RF_Transactional); }
        Asset->Modify();
        if (bNew) { FAssetRegistryModule::AssetCreated(Asset); }
        Asset->MarkPackageDirty();
        Session.Touched(Asset);
        return Asset;
    }

    UObject* ImportInstancesStep(const FStep& Step, FSession& Session, FString& Error)
    {
        FTable Table;
        if (!Table.Load(ProjectFile(Step.File))) { Error = FString::Printf(TEXT("%s cannot be read"), *Step.File); return nullptr; }
        TMap<FString, UStaticMesh*> Meshes;
        for (const TPair<FString, FString>& It : Step.Meshes)
        {
            UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, *It.Value);
            if (!Mesh) { Error = FString::Printf(TEXT("the mesh %s of %s is missing"), *It.Value, *Step.Name); return nullptr; }
            Meshes.Add(It.Key, Mesh);
        }
        // every row read before the asset changes: a bad row leaves it as it was
        TArray<FTopoTopoInstanceGroup> Groups;
        TMap<FString, int32> GroupOf;
        for (int32 Row = 0; Row < Table.Num(); Row++)
        {
            const FString Name = Table.String(Row, TEXT("Mesh"));
            UStaticMesh** Mesh = Meshes.Find(Name);
            if (!Mesh) { Error = FString::Printf(TEXT("row %d of %s names the mesh \"%s\", which the output has no file for"), Row + 1, *Step.File, *Name); return nullptr; }
            int32* Group = GroupOf.Find(Name);
            if (!Group)
            {
                FTopoTopoInstanceGroup& New = Groups.AddDefaulted_GetRef();
                New.Mesh = *Mesh;
                Group = &GroupOf.Add(Name, Groups.Num() - 1);
            }
            Groups[*Group].Transforms.Add(Table.Transform(Row));
        }
        UTopoTopoInstances* Asset = FindOrCreateAsset<UTopoTopoInstances>(Step, Session);
        Asset->Groups = MoveTemp(Groups);
        Asset->ContentId = FGuid::NewGuid();
        for (TObjectIterator<ATopoTopoInstancesActor> It; It; ++It)
        {
            if (It->Instances == Asset && !It->IsTemplate() && It->GetWorld()) { It->Rebuild(); }
        }
        return Asset;
    }

    template <typename T, typename F>
    void WriteAttribute(UPCGPointArrayData* Data, FName Name, const T& Default, bool bInterpolate, F GetValue)
    {
        auto* Attribute = Data->MutableMetadata()->CreateAttribute<T>(Name, Default, bInterpolate, false);
        if (!Attribute) { return; }
        const auto Keys = Data->GetConstMetadataEntryValueRange();
        for (int32 Row = 0; Row < Data->GetNumPoints(); Row++) { Attribute->SetValue(Keys[Row], GetValue(Row)); }
    }

    UObject* ImportPointsStep(const FStep& Step, FSession& Session, FString& Error)
    {
        FTable Table;
        if (!Table.Load(ProjectFile(Step.File))) { Error = FString::Printf(TEXT("%s cannot be read"), *Step.File); return nullptr; }
        UPCGDataAsset* Asset = FindOrCreateAsset<UPCGDataAsset>(Step, Session);
        UPCGPointArrayData* Data = NewObject<UPCGPointArrayData>(Asset);
        const int32 N = Table.Num();
        Data->SetNumPoints(N);
        Data->AllocateProperties(EPCGPointNativeProperties::Transform | EPCGPointNativeProperties::Density | EPCGPointNativeProperties::Color | EPCGPointNativeProperties::Seed | EPCGPointNativeProperties::MetadataEntry);
        auto Transforms = Data->GetTransformValueRange(false);
        auto Densities = Data->GetDensityValueRange(false);
        auto Colors = Data->GetColorValueRange(false);
        auto Seeds = Data->GetSeedValueRange(false);
        auto Keys = Data->GetMetadataEntryValueRange(false);
        for (int32 Row = 0; Row < N; Row++)
        {
            Transforms[Row] = Table.Transform(Row);
            Densities[Row] = Table.Number(Row, TEXT("Density"), 1);
            Colors[Row] = FVector4(Table.Number(Row, TEXT("Color.R"), 1), Table.Number(Row, TEXT("Color.G"), 1), Table.Number(Row, TEXT("Color.B"), 1), Table.Number(Row, TEXT("Color.A"), 1));
            Seeds[Row] = static_cast<int32>(static_cast<int64>(Table.Number(Row, TEXT("Seed"))));
            Keys[Row] = Data->MutableMetadata()->AddEntry();
        }
        static const TSet<FString> Native = {
            TEXT("Name"), TEXT("Position.X"), TEXT("Position.Y"), TEXT("Position.Z"), TEXT("Rotation.Roll"), TEXT("Rotation.Pitch"), TEXT("Rotation.Yaw"),
            TEXT("Scale.X"), TEXT("Scale.Y"), TEXT("Scale.Z"), TEXT("Density"), TEXT("Color.R"), TEXT("Color.G"), TEXT("Color.B"), TEXT("Color.A"), TEXT("Seed"),
        };
        // every other column an attribute: whole numbers, numbers, or strings
        for (int32 Column = 0; Column < Table.Names.Num(); Column++)
        {
            const FString& Name = Table.Names[Column];
            if (Native.Contains(Name)) { continue; }
            bool bNumbers = N > 0, bWhole = N > 0;
            for (int32 Row = 0; Row < N && bNumbers; Row++)
            {
                const FString Cell = Table.Cell(Row, Column);
                bNumbers = FDefaultValueHelper::IsStringValidFloat(Cell) || FDefaultValueHelper::IsStringValidInteger(Cell);
                bWhole = bWhole && FDefaultValueHelper::IsStringValidInteger(Cell);
            }
            if (bWhole) { WriteAttribute(Data, FName(*Name), int64(0), false, [&](int32 Row) { return FCString::Atoi64(Table.Cell(Row, Column)); }); }
            else if (bNumbers) { WriteAttribute(Data, FName(*Name), 0.0, true, [&](int32 Row) { return FCString::Atod(Table.Cell(Row, Column)); }); }
            else { WriteAttribute(Data, FName(*Name), FString(), false, [&](int32 Row) { return FString(Table.Cell(Row, Column)); }); }
        }
        // the asset of each mesh, for a PCG Static Mesh Spawner's by-attribute selector
        if (!Step.Meshes.IsEmpty())
        {
            WriteAttribute(Data, TEXT("MeshPath"), FSoftObjectPath(), false, [&](int32 Row)
            {
                const FString* Path = Step.Meshes.Find(Table.String(Row, TEXT("Mesh")));
                return Path ? FSoftObjectPath(*Path) : FSoftObjectPath();
            });
        }
        FPCGTaggedData Tagged;
        Tagged.Data = Data;
        Tagged.Pin = PCGPinConstants::DefaultOutputLabel;
        Asset->Data.TaggedData.Reset();
        Asset->Data.TaggedData.Add(MoveTemp(Tagged));
        return Asset;
    }

    /** The files each output's last good cook wrote and their hashes, from the package's record. */
    TMap<FString, FString> RecordHashes(const FString& Topo)
    {
        TMap<FString, FString> Hashes;
        const TSharedPtr<FJsonObject> Record = ReadJson(FPaths::GetPath(Topo) / TEXT(".topotopo/unreal.json"));
        const TSharedPtr<FJsonObject>* Outputs = nullptr;
        if (!Record || !Record->TryGetObjectField(TEXT("outputs"), Outputs)) { return Hashes; }
        for (const auto& Output : (*Outputs)->Values)
        {
            const TSharedPtr<FJsonObject>* O = nullptr;
            const TSharedPtr<FJsonObject>* Files = nullptr;
            if (!Output.Value->TryGetObject(O) || !(*O)->TryGetObjectField(TEXT("files"), Files)) { continue; }
            for (const auto& File : (*Files)->Values) { Hashes.Add(FString(*File.Key), File.Value->AsString()); }
        }
        return Hashes;
    }

    FString IssueText(const FJsonObject& Issue)
    {
        FString Node, Message, Hint;
        Issue.TryGetStringField(TEXT("node"), Node);
        Issue.TryGetStringField(TEXT("message"), Message);
        Issue.TryGetStringField(TEXT("hint"), Hint);
        return (Node.IsEmpty() ? FString() : FString::Printf(TEXT("[%s] "), *Node)) + Message + (Hint.IsEmpty() ? FString() : FString::Printf(TEXT(" (hint: %s)"), *Hint));
    }

    TArray<FString> Strings(const FJsonObject& O, const TCHAR* Key)
    {
        TArray<FString> Out;
        O.TryGetStringArrayField(Key, Out);
        return Out;
    }

    TArray<FString> Issues(const FJsonObject& O, const TCHAR* Key)
    {
        TArray<FString> Out;
        const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
        if (O.TryGetArrayField(Key, Items))
        {
            for (const TSharedPtr<FJsonValue>& Item : *Items)
            {
                const TSharedPtr<FJsonObject>* Object = nullptr;
                FString Text;
                if (Item->TryGetObject(Object)) { Out.Add(IssueText(**Object)); }
                else if (Item->TryGetString(Text)) { Out.Add(Text); }
            }
        }
        return Out;
    }

    /** The package's state as text (its options and what the last cook made), to tell whether a cook changed it. */
    FString StateOf(const UTopoTopoPackage* Package)
    {
        FString Out;
        for (TFieldIterator<FProperty> It(UTopoTopoPackage::StaticClass(), EFieldIteratorFlags::ExcludeSuper); It; ++It)
        {
            if (It->HasAnyPropertyFlags(CPF_InstancedReference | CPF_PersistentInstance)) { continue; }
            It->ExportTextItem_InContainer(Out, Package, nullptr, nullptr, PPF_None);
            Out += TEXT("\n");
        }
        return Out;
    }

    /** What the cook did, in the message log; errors also as a notification. */
    void ShowOutcome(const UTopoTopoPackage* Package, const TArray<FString>& PackageErrors)
    {
        FMessageLog Log(TopoTopo::MessageLogName);
        const FString Name = Package->GetName();
        bool bErrors = false;
        for (const FString& E : PackageErrors)
        {
            const FString Line = FString::Printf(TEXT("TopoTopo: %s: %s"), *Name, *E);
            UE_LOG(LogTopoTopo, Error, TEXT("%s"), *Line);
            Log.Error(FText::FromString(Line));
            bErrors = true;
        }
        for (const FTopoTopoOutputStatus& Output : Package->Outputs)
        {
            for (const FString& E : Output.Errors)
            {
                const FString Line = FString::Printf(TEXT("TopoTopo: %s > %s: %s"), *Name, *Output.Id, *E);
                UE_LOG(LogTopoTopo, Error, TEXT("%s"), *Line);
                Log.Error(FText::FromString(Line));
                bErrors = true;
            }
            for (const FString& W : Output.Warnings)
            {
                const FString Line = FString::Printf(TEXT("TopoTopo: %s > %s: %s"), *Name, *Output.Id, *W);
                UE_LOG(LogTopoTopo, Warning, TEXT("%s"), *Line);
                Log.Warning(FText::FromString(Line));
            }
        }
        const FString Line = FString::Printf(TEXT("TopoTopo: %s: %s"), *Name, *Package->Status);
        UE_LOG(LogTopoTopo, Log, TEXT("%s"), *Line);
        Log.Info(FText::FromString(Line));
        if (bErrors) { Log.Notify(FText::FromString(Line), EMessageSeverity::Error, true); }
        else
        {
            FNotificationInfo Info(FText::FromString(Line));
            Info.ExpireDuration = 4.f;
            FSlateNotificationManager::Get().AddNotification(Info);
        }
    }
}

void TopoTopo::FailCook(UTopoTopoPackage* Package, const FString& Why)
{
    if (Package->Status != Why)
    {
        Package->Modify();
        Package->Status = Why;
        Package->MarkPackageDirty();
        SaveSoon(Package);
    }
    ShowOutcome(Package, { Why });
}

bool TopoTopo::ApplyCook(UTopoTopoPackage* Package, int32 ExitCode, const FString& ReportFile, const FString& Errors, bool bForce)
{
    const TSharedPtr<FJsonObject> Report = ReadJson(ReportFile);
    if (!Report)
    {
        const FString Said = Errors.TrimStartAndEnd();
        FailCook(Package, Said.IsEmpty() ? FString::Printf(TEXT("the cook ended with code %d and wrote no report"), ExitCode) : Said);
        return false;
    }
    int32 Spoken = 0;
    Report->TryGetNumberField(TEXT("protocol"), Spoken);
    if (Spoken != Protocol)
    {
        FailCook(Package, FString::Printf(TEXT("this plugin speaks protocol %d and TopoTopo %d: run topotopo unreal setup on this project"), Protocol, Spoken));
        return false;
    }

    // the asset is saved only when the cook changed it: every package cooks at editor start, and an unchanged one must not
    // be written (under source control that is a checkout)
    const FString StateBefore = StateOf(Package);
    const TMap<FString, FString> Hashes = RecordHashes(Package->SourceFile());
    TArray<FTopoTopoOutputStatus> Before = MoveTemp(Package->Outputs);
    Package->Outputs.Reset();
    Package->Skipped.Reset();
    Package->Notes.Reset();
    Report->TryGetStringField(TEXT("topotopo"), Package->TopoTopoVersion);
    const TSharedPtr<FJsonObject>* PackageInfo = nullptr;
    Package->PublishName.Reset();
    if (Report->TryGetObjectField(TEXT("package"), PackageInfo)) { (*PackageInfo)->TryGetStringField(TEXT("name"), Package->PublishName); }
    Package->Orphans = Strings(*Report, TEXT("orphans"));
    Package->Notes = Issues(*Report, TEXT("warnings"));
    for (const FString& Exposed : Strings(*Report, TEXT("exposed")))
    {
        Package->Notes.Add(FString::Printf(TEXT("Auto Reimport sees %s"), *Exposed));
    }
    TArray<FString> PackageErrors = Issues(*Report, TEXT("errors"));

    FSession Session;
    TMap<FString, FString> Imported;
    int32 NumUpdated = 0, NumSame = 0, NumFailed = 0;
    bool bAllOk = true;
    const TArray<TSharedPtr<FJsonValue>>* Outputs = nullptr;
    Report->TryGetArrayField(TEXT("outputs"), Outputs);
    const int32 Count = Outputs ? Outputs->Num() : 0;
    for (int32 At = 0; At < Count; At++)
    {
        const FJsonObject& O = *(*Outputs)[At]->AsObject();
        FTopoTopoOutputStatus Output;
        O.TryGetStringField(TEXT("id"), Output.Id);
        O.TryGetStringField(TEXT("label"), Output.Label);
        O.TryGetStringField(TEXT("kind"), Output.Kind);
        const FString State = O.GetStringField(TEXT("state"));
        Output.Errors = Issues(O, TEXT("errors"));
        Output.Warnings = Strings(O, TEXT("warnings"));
        if (State == TEXT("skipped"))
        {
            Package->Skipped.Add(FString::Printf(TEXT("%s: %s"), *Output.Id, Output.Warnings.IsEmpty() ? TEXT("skipped by the import options") : *Output.Warnings[0]));
            continue;
        }
        const FTopoTopoOutputStatus* Previous = Before.FindByPredicate([&](const FTopoTopoOutputStatus& S) { return S.Id == Output.Id; });
        if (State == TEXT("failed"))
        {
            // its last good files and assets stay as they are
            Output.State = TEXT("failed");
            if (Previous) { Output.Assets = Previous->Assets; Output.Bundle = Previous->Bundle; Output.Materials = Previous->Materials; }
            for (const FString& File : Strings(O, TEXT("files")))
            {
                if (const FString* Hash = Package->ImportedFiles.Find(File)) { Imported.Add(File, *Hash); }
            }
            NumFailed++;
            bAllOk = false;
            Package->Outputs.Add(MoveTemp(Output));
            continue;
        }
        Output.State = TEXT("ok");
        if (Previous) { Output.Materials = Previous->Materials; }
        bool bChanged = false;
        const TArray<TSharedPtr<FJsonValue>>* Steps = nullptr;
        O.TryGetArrayField(TEXT("import"), Steps);
        const int32 NumSteps = Steps ? Steps->Num() : 0;
        for (int32 S = 0; S < NumSteps; S++)
        {
            const FStep Step(*(*Steps)[S]->AsObject());
            if (Step.As == TEXT("landscape"))
            {
                Output.Bundle = Step.File;
                continue;
            }
            const TArray<FString> Files = Step.Files();
            UObject* Asset = LoadObject<UObject>(nullptr, *Step.ObjectPath(), nullptr, LOAD_NoWarn | LOAD_Quiet);
            bool bStale = bForce || !Asset;
            for (const FString& File : Files)
            {
                const FString* Now = Hashes.Find(File);
                const FString* Was = Package->ImportedFiles.Find(File);
                bStale = bStale || !Now || !Was || *Now != *Was;
            }
            const bool bHaveFile = FPaths::FileExists(ProjectFile(Step.File));
            FString Error;
            if (bStale && bHaveFile)
            {
                UE_LOG(LogTopoTopo, Log, TEXT("TopoTopo: importing %s as %s"), *Step.File, *Step.ObjectPath());
                UObject* Made = nullptr;
                if (Step.As == TEXT("static_mesh")) { Made = ImportMeshStep(Step, Output.Materials, Session, Error); }
                else if (Step.As == TEXT("texture")) { Made = ImportTextureStep(Step, Session, Error); }
                else if (Step.As == TEXT("instances")) { Made = ImportInstancesStep(Step, Session, Error); }
                else if (Step.As == TEXT("points")) { Made = ImportPointsStep(Step, Session, Error); }
                else { Error = FString::Printf(TEXT("this plugin does not know the import step \"%s\": run topotopo unreal setup on this project"), *Step.As); }
                if (Made)
                {
                    Asset = Made;
                    bChanged = true;
                }
            }
            else if (!Asset)
            {
                Error = FString::Printf(TEXT("%s is not here (a checkout without cooked files): use Recook"), *Step.File);
            }
            if (!Error.IsEmpty())
            {
                // like a failed output: the last good asset stays, with the hashes it was made from
                Output.Errors.Add(Error);
                Output.State = TEXT("failed");
                bAllOk = false;
                for (const FString& File : Files)
                {
                    if (const FString* Hash = Package->ImportedFiles.Find(File)) { Imported.Add(File, *Hash); }
                }
                if (Asset) { Output.Assets.Add(TSoftObjectPtr<UObject>(Asset)); }
                continue;
            }
            for (const FString& File : Files)
            {
                if (const FString* Now = Hashes.Find(File)) { Imported.Add(File, *Now); }
            }
            if (Asset) { Output.Assets.Add(TSoftObjectPtr<UObject>(Asset)); }
        }
        if (Output.State == TEXT("failed")) { NumFailed++; }
        else if (bChanged) { NumUpdated++; }
        else { NumSame++; }
        Package->Outputs.Add(MoveTemp(Output));
    }
    Package->ImportedFiles = MoveTemp(Imported);
    bAllOk = bAllOk && PackageErrors.IsEmpty();
    Package->Status = FString::Printf(TEXT("%d imported, %d unchanged, %d failed, %d skipped"), NumUpdated, NumSame, NumFailed, Package->Skipped.Num());
    if (!Session.ToSave.IsEmpty()) { UEditorLoadingAndSavingUtils::SavePackages(Session.ToSave.Array(), true); }
    if (StateOf(Package) != StateBefore)
    {
        Package->Modify();
        Package->MarkPackageDirty();
        SaveSoon(Package);
    }
    ShowOutcome(Package, PackageErrors);
    return bAllOk;
}

void TopoTopo::SaveSoon(UObject* Asset)
{
    TWeakObjectPtr<UObject> Weak(Asset);
    FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([Weak](float)
    {
        if (UObject* Object = Weak.Get())
        {
            UEditorLoadingAndSavingUtils::SavePackages({ Object->GetPackage() }, true);
        }
        return false;
    }));
}

void TopoTopo::ReadImportOptions(UTopoTopoPackage* Package)
{
    TArray<FString> Lines;
    if (!FFileHelper::LoadFileToStringArray(Lines, *(Package->SourceFile() + TEXT(".import")))) { return; }
    bool bParams = false;
    for (const FString& Raw : Lines)
    {
        const FString Line = Raw.TrimStartAndEnd();
        if (Line.StartsWith(TEXT("["))) { bParams = Line == TEXT("[params]"); continue; }
        FString Key, Value;
        if (!bParams || !Line.Split(TEXT("="), &Key, &Value)) { continue; }
        Key.TrimStartAndEndInline();
        Value.TrimStartAndEndInline();
        Value.RemoveFromStart(TEXT("\""));
        Value.RemoveFromEnd(TEXT("\""));
        if (Key == TEXT("outputs/folder")) { Package->OutputFolder = Value; }
        else if (Key == TEXT("outputs/per_output_folders")) { Package->bPerOutputFolders = Value == TEXT("true"); }
        else if (Key == TEXT("outputs/skip")) { Package->SkipOutputs = Value; }
        else if (Key == TEXT("instances/mode")) { Package->InstanceMode = FCString::Atoi(*Value) == 1 ? ETopoTopoInstanceMode::Expand : ETopoTopoInstanceMode::Instanced; }
    }
}

bool TopoTopo::WriteImportOptions(const UTopoTopoPackage* Package, FString& OutError)
{
    const FString File = Package->SourceFile() + TEXT(".import");
    const FString Text = FString::Printf(TEXT("[params]\n\noutputs/folder=\"%s\"\noutputs/per_output_folders=%s\noutputs/skip=\"%s\"\ninstances/mode=%d\n"),
        *Package->OutputFolder, Package->bPerOutputFolders ? TEXT("true") : TEXT("false"), *Package->SkipOutputs, Package->InstanceMode == ETopoTopoInstanceMode::Expand ? 1 : 0);
    if (FFileHelper::SaveStringToFile(Text, *File, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) { return true; }
    OutError = FString::Printf(TEXT("cannot write %s"), *File);
    return false;
}
