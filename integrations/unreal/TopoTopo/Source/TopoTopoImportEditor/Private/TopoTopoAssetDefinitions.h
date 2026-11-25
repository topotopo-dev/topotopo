// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "AssetDefinitionDefault.h"
#include "CoreMinimal.h"
#include "TopoTopoAssetDefinitions.generated.h"

UCLASS()
class UAssetDefinition_TopoTopoPackage : public UAssetDefinitionDefault
{
    GENERATED_BODY()

public:
    virtual FText GetAssetDisplayName() const override;
    virtual TSoftClassPtr<UObject> GetAssetClass() const override;
    virtual FLinearColor GetAssetColor() const override { return FLinearColor(FColor(226, 92, 32)); }
    virtual TConstArrayView<FAssetCategoryPath> GetAssetCategories() const override;
    virtual bool CanImport() const override { return true; }
};

UCLASS()
class UAssetDefinition_TopoTopoInstances : public UAssetDefinitionDefault
{
    GENERATED_BODY()

public:
    virtual FText GetAssetDisplayName() const override;
    virtual TSoftClassPtr<UObject> GetAssetClass() const override;
    virtual FLinearColor GetAssetColor() const override { return FLinearColor(FColor(240, 150, 60)); }
    virtual TConstArrayView<FAssetCategoryPath> GetAssetCategories() const override;
};
