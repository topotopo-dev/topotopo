// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoFolderPipeline.h"

#include "Engine/Texture.h"
#include "Materials/MaterialInterface.h"
#include "Nodes/InterchangeBaseNodeContainer.h"
#include "Nodes/InterchangeFactoryBaseNode.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(TopoTopoFolderPipeline)

void UTopoTopoFolderPipeline::ExecutePipeline(UInterchangeBaseNodeContainer* BaseNodeContainer, const TArray<UInterchangeSourceData*>& SourceDatas, const FString& ContentBasePath)
{
    if (!BaseNodeContainer) { return; }
    BaseNodeContainer->IterateNodesOfType<UInterchangeFactoryBaseNode>([](const FString&, UInterchangeFactoryBaseNode* Node)
    {
        const UClass* Class = Node ? Node->GetObjectClass() : nullptr;
        if (!Class) { return; }
        if (Class->IsChildOf(UMaterialInterface::StaticClass()))
        {
            Node->SetCustomSubPath(TEXT("Materials"));
        }
        else if (Class->IsChildOf(UTexture::StaticClass()))
        {
            Node->SetCustomSubPath(TEXT("Textures"));
        }
    });
}
