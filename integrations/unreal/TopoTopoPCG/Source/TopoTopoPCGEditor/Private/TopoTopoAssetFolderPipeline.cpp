// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoAssetFolderPipeline.h"

#include "Engine/Texture.h"
#include "Materials/MaterialInterface.h"
#include "Nodes/InterchangeBaseNodeContainer.h"
#include "Nodes/InterchangeFactoryBaseNode.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(TopoTopoAssetFolderPipeline)

void UTopoTopoAssetFolderPipeline::ExecutePipeline(UInterchangeBaseNodeContainer* BaseNodeContainer,
    const TArray<UInterchangeSourceData*>& SourceDatas, const FString& ContentBasePath)
{
    if (!BaseNodeContainer) { return; }
    const FString Materials = SubFolder.IsEmpty() ? FString(TEXT("Materials")) : FString(TEXT("Materials")) / SubFolder;
    const FString Textures = SubFolder.IsEmpty() ? FString(TEXT("Textures")) : FString(TEXT("Textures")) / SubFolder;
    BaseNodeContainer->IterateNodesOfType<UInterchangeFactoryBaseNode>([&Materials, &Textures](const FString&, UInterchangeFactoryBaseNode* Node)
    {
        const UClass* Class = Node ? Node->GetObjectClass() : nullptr;
        if (!Class) { return; }
        // Meshes keep their sub path (none): Meshes/<prototype>.<prototype> is the mapping the importer promises.
        if (Class->IsChildOf(UMaterialInterface::StaticClass())) { Node->SetCustomSubPath(Materials); }
        else if (Class->IsChildOf(UTexture::StaticClass())) { Node->SetCustomSubPath(Textures); }
    });
}
