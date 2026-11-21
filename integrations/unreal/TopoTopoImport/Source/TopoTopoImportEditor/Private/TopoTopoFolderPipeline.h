// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "InterchangePipelineBase.h"
#include "TopoTopoFolderPipeline.generated.h"

/** Runs last in a GLB's import: materials and textures go into sub-folders, so none can take a mesh's name. */
UCLASS(BlueprintType, EditInlineNew)
class UTopoTopoFolderPipeline : public UInterchangePipelineBase
{
    GENERATED_BODY()

protected:
    virtual void ExecutePipeline(UInterchangeBaseNodeContainer* BaseNodeContainer, const TArray<UInterchangeSourceData*>& SourceDatas, const FString& ContentBasePath) override;
};
