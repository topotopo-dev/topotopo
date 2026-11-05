// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "TopoTopoPackage.generated.h"

class UAssetImportData;

UENUM()
enum class ETopoTopoInstanceMode : uint8
{
    /** A TopoTopo Instances asset placed as hierarchical instanced static meshes, and PCG points. */
    Instanced,
    /** Real copies, merged into one static mesh. */
    Expand
};

/** What one published output of a package became. */
USTRUCT()
struct FTopoTopoOutputStatus
{
    GENERATED_BODY()

    UPROPERTY(VisibleAnywhere, Category = "Output")
    FString Id;

    UPROPERTY(VisibleAnywhere, Category = "Output")
    FString Label;

    UPROPERTY(VisibleAnywhere, Category = "Output")
    FString Kind;

    /** ok, or failed (its last good assets are kept). */
    UPROPERTY(VisibleAnywhere, Category = "Output")
    FString State;

    /** One per error: [node] message (hint: hint). */
    UPROPERTY(VisibleAnywhere, Category = "Output")
    TArray<FString> Errors;

    UPROPERTY(VisibleAnywhere, Category = "Output")
    TArray<FString> Warnings;

    UPROPERTY(VisibleAnywhere, Category = "Output")
    TArray<TSoftObjectPtr<UObject>> Assets;

    /** A terrain output: the bundle's landscape.json below the project; Place Terrain in Level brings it in. */
    UPROPERTY(VisibleAnywhere, Category = "Output")
    FString Bundle;
};

/**
 * A TopoTopo package in the Content Browser: the asset whose source file is <id>.topo. It holds the import options and the
 * state of the package's outputs; levels and code use the assets it lists, never this one, and it never ships.
 */
UCLASS(BlueprintType, hidecategories = Object)
class TOPOTOPOIMPORTEDITOR_API UTopoTopoPackage : public UObject
{
    GENERATED_BODY()

public:
    UTopoTopoPackage();

    /** Where the assets go: a folder relative to the package's, or a content path (/Game/...). */
    UPROPERTY(EditAnywhere, Category = "Import Options")
    FString OutputFolder = TEXT("outputs");

    /** On: <folder>/<output>/<output>. Off: <folder>/<output>. */
    UPROPERTY(EditAnywhere, Category = "Import Options")
    bool bPerOutputFolders = true;

    /** Output ids not to cook, comma-separated. */
    UPROPERTY(EditAnywhere, Category = "Import Options")
    FString SkipOutputs;

    UPROPERTY(EditAnywhere, Category = "Import Options")
    ETopoTopoInstanceMode InstanceMode = ETopoTopoInstanceMode::Instanced;

    /** What the last cook said, in a line. */
    UPROPERTY(VisibleAnywhere, Category = "Package")
    FString Status;

    /** The publish name in the manifest, if it has one. */
    UPROPERTY(VisibleAnywhere, Category = "Package")
    FString PublishName;

    /** The TopoTopo that cooked it. */
    UPROPERTY(VisibleAnywhere, Category = "Package")
    FString TopoTopoVersion;

    UPROPERTY(VisibleAnywhere, Category = "Package")
    TArray<FTopoTopoOutputStatus> Outputs;

    /** Outputs that are not imported, and why. */
    UPROPERTY(VisibleAnywhere, Category = "Package")
    TArray<FString> Skipped;

    /** Cooked files no output has any more. Their assets stay: a level may use them. */
    UPROPERTY(VisibleAnywhere, Category = "Package")
    TArray<FString> Orphans;

    UPROPERTY(VisibleAnywhere, Category = "Package")
    TArray<FString> Notes;

    /** The cooked files the assets were made from, with their hashes: what makes an unchanged output stay as it is. */
    UPROPERTY()
    TMap<FString, FString> ImportedFiles;

    UPROPERTY(VisibleAnywhere, Instanced, Category = "Import Settings")
    TObjectPtr<UAssetImportData> AssetImportData;

    /** The .topo on disk (absolute), or empty. */
    FString SourceFile() const;

    /** Cook every output again, ignoring the record and the cache, and import them all. */
    UFUNCTION(CallInEditor, Category = "TopoTopo")
    void Recook();

    /** Open the package in TopoTopo's viewer, in the browser. */
    UFUNCTION(CallInEditor, Category = "TopoTopo")
    void OpenInTopoTopo();

    /** Show the last cook's report. */
    UFUNCTION(CallInEditor, Category = "TopoTopo")
    void ShowCookReport();

    /** Place the package's terrain outputs in the open level (needs the TopoTopoPCG plugin). */
    UFUNCTION(CallInEditor, Category = "TopoTopo")
    void PlaceTerrainInLevel();

    virtual void PostInitProperties() override;
    virtual void GetAssetRegistryTags(FAssetRegistryTagsContext Context) const override;
    virtual bool IsEditorOnly() const override { return true; }
    virtual void PostEditChangeProperty(FPropertyChangedEvent& Event) override;
};
