// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "TopoTopoImportSettings.generated.h"

/** Editor Preferences > Plugins > TopoTopo: per machine. */
UCLASS(config = EditorPerProjectUserSettings, meta = (DisplayName = "TopoTopo"))
class UTopoTopoImportSettings : public UDeveloperSettings
{
    GENERATED_BODY()

public:
    virtual FName GetContainerName() const override { return TEXT("Editor"); }
    virtual FName GetCategoryName() const override { return TEXT("Plugins"); }

    /** A TopoTopo src/cli.ts, dist/cli.js or folder. Empty: found by itself (TOPOTOPO_CLI, node_modules, the install record topotopo unreal setup writes, PATH). */
    UPROPERTY(config, EditAnywhere, Category = "TopoTopo")
    FString TopoTopoPath;

    /** The node executable. Empty: found by itself (TOPOTOPO_NODE, the install record, PATH). */
    UPROPERTY(config, EditAnywhere, Category = "TopoTopo")
    FString NodePath;

    /** Cook when a package's graphs, inputs or assets change, while Auto Reimport (Loading & Saving > Monitor Content Directories) is on. */
    UPROPERTY(config, EditAnywhere, Category = "TopoTopo")
    bool bLiveCook = true;

    /** Seconds per package. */
    UPROPERTY(config, EditAnywhere, Category = "TopoTopo", meta = (ClampMin = 1))
    int32 CookTimeout = 600;
};
