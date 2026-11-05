// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoAssetDefinitions.h"

#include "AssetDefinition.h"
#include "TopoTopoInstances.h"
#include "TopoTopoPackage.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(TopoTopoAssetDefinitions)

#define LOCTEXT_NAMESPACE "TopoTopoImport"

static TConstArrayView<FAssetCategoryPath> TopoTopoCategories()
{
    static const FAssetCategoryPath Categories[] = { FAssetCategoryPath(LOCTEXT("Category", "TopoTopo")) };
    return Categories;
}

FText UAssetDefinition_TopoTopoPackage::GetAssetDisplayName() const { return LOCTEXT("Package", "TopoTopo Package"); }
TSoftClassPtr<UObject> UAssetDefinition_TopoTopoPackage::GetAssetClass() const { return UTopoTopoPackage::StaticClass(); }
TConstArrayView<FAssetCategoryPath> UAssetDefinition_TopoTopoPackage::GetAssetCategories() const { return TopoTopoCategories(); }

FText UAssetDefinition_TopoTopoInstances::GetAssetDisplayName() const { return LOCTEXT("Instances", "TopoTopo Instances"); }
TSoftClassPtr<UObject> UAssetDefinition_TopoTopoInstances::GetAssetClass() const { return UTopoTopoInstances::StaticClass(); }
TConstArrayView<FAssetCategoryPath> UAssetDefinition_TopoTopoInstances::GetAssetCategories() const { return TopoTopoCategories(); }

#undef LOCTEXT_NAMESPACE
