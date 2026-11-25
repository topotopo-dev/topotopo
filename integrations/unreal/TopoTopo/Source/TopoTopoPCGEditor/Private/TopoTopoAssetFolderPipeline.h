// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "InterchangePipelineBase.h"
#include "TopoTopoAssetFolderPipeline.generated.h"

/**
 * Runs after the glTF pipelines of a prototype import. Static meshes stay at the root of the import folder, which is
 * the predictable Meshes/<name> path that instance streams and PCG graphs resolve; materials and textures move into
 * Materials/ and Textures/ sub-folders. Without this, a material that shares a prototype's name (a mesh "rock" with a
 * material "rock") is created first, takes the name, and Interchange renames the mesh to "rock1".
 */
UCLASS(Transient)
class UTopoTopoAssetFolderPipeline : public UInterchangePipelineBase
{
    GENERATED_BODY()

public:
    /**
     * Per-prototype sub-folder under Materials/ and Textures/ (the prototype name). Prototypes share material names
     * (fir, oak and pine all use "bark"); one shared folder made the second import ask whether to override the first
     * prototype's material in a modal dialog, which stalls an automated import (found 2026-10-16).
     */
    UPROPERTY()
    FString SubFolder;

protected:
    virtual void ExecutePipeline(UInterchangeBaseNodeContainer* BaseNodeContainer,
        const TArray<UInterchangeSourceData*>& SourceDatas, const FString& ContentBasePath) override;
    virtual bool CanExecuteOnAnyThread(EInterchangePipelineTask PipelineTask) override { return true; }
};
