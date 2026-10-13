// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoLandscapeMaterial.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionAdd.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionDivide.h"
#include "Materials/MaterialExpressionLandscapeLayerBlend.h"
#include "Materials/MaterialExpressionMax.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionSubtract.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"

namespace TopoTopoLandscape
{
namespace
{
    struct FLayerAppearance
    {
        FLinearColor Color;
        float Roughness;
    };

    FLayerAppearance AppearanceFor(FName LayerName)
    {
        const FString Name = LayerName.ToString().ToLower();
        if (Name == TEXT("rock")) return {FLinearColor(0.28f, 0.30f, 0.32f), 0.88f};
        if (Name == TEXT("sediment")) return {FLinearColor(0.48f, 0.34f, 0.17f), 0.94f};
        if (Name == TEXT("debris")) return {FLinearColor(0.36f, 0.27f, 0.16f), 0.97f};
        if (Name == TEXT("flow")) return {FLinearColor(0.025f, 0.065f, 0.085f), 0.45f};
        if (Name == TEXT("water")) return {FLinearColor(0.015f, 0.07f, 0.11f), 0.22f};
        if (Name == TEXT("road")) return {FLinearColor(0.035f, 0.038f, 0.042f), 0.84f};
        if (Name == TEXT("path")) return {FLinearColor(0.56f, 0.43f, 0.25f), 0.95f};
        if (Name == TEXT("trees")) return {FLinearColor(0.035f, 0.095f, 0.018f), 0.96f};
        // mask, grass, and unknown layers use the same unobtrusive grass base.
        return {FLinearColor(0.08f, 0.20f, 0.035f), 0.92f};
    }

    template<typename T>
    T* AddExpression(UMaterial* Material, int32 X, int32 Y, const TCHAR* Description)
    {
        const EObjectFlags Flags = Material->HasAnyFlags(RF_Transient) ? RF_Transient : RF_Transactional;
        T* Expression = NewObject<T>(Material, NAME_None, Flags);
        Expression->Material = Material;
        Expression->MaterialExpressionEditorX = X;
        Expression->MaterialExpressionEditorY = Y;
        Expression->Desc = Description;
        Expression->UpdateMaterialExpressionGuid(true, false);
        Material->GetExpressionCollection().AddExpression(Expression);
        return Expression;
    }

    UMaterialExpressionConstant* AddScalar(UMaterial* Material, float Value, int32 X, int32 Y, const TCHAR* Description)
    {
        UMaterialExpressionConstant* Constant = AddExpression<UMaterialExpressionConstant>(Material, X, Y, Description);
        Constant->R = Value;
        return Constant;
    }

    UMaterialExpressionConstant3Vector* AddColor(UMaterial* Material, FLinearColor Value, int32 X, int32 Y, const TCHAR* Description)
    {
        UMaterialExpressionConstant3Vector* Constant = AddExpression<UMaterialExpressionConstant3Vector>(Material, X, Y, Description);
        Constant->Constant = Value;
        return Constant;
    }

    UMaterialExpression* CompleteBlend(UMaterial* Material, UMaterialExpression* Blend, UMaterialExpression* Base,
        UMaterialExpression* UncoveredWeight, UMaterialExpression* Denominator, int32 Y)
    {
        auto* Fill = AddExpression<UMaterialExpressionMultiply>(Material, -650, Y + 120, TEXT("Grass in uncovered areas"));
        Fill->A.Connect(0, Base);
        Fill->B.Connect(0, UncoveredWeight);
        auto* Sum = AddExpression<UMaterialExpressionAdd>(Material, -420, Y, TEXT("Layers plus uncovered grass"));
        Sum->A.Connect(0, Blend);
        Sum->B.Connect(0, Fill);
        auto* Result = AddExpression<UMaterialExpressionDivide>(Material, -180, Y, TEXT("Normalize appearance, preserve imported weights"));
        Result->A.Connect(0, Sum);
        Result->B.Connect(0, Denominator);
        return Result;
    }
}

UMaterial* CreateMaterial(const FString& Destination, const TArray<FName>& LayerNames, bool bTransient)
{
    const FString AssetName = TEXT("M_TopoTopo_") + FPackageName::GetShortName(Destination);
    UPackage* Package = bTransient ? GetTransientPackage() : CreatePackage(*(Destination / TEXT("Landscape") / AssetName));
    const FName ObjectName = bTransient ? MakeUniqueObjectName(Package, UMaterial::StaticClass(), FName(*AssetName)) : FName(*AssetName);
    const EObjectFlags Flags = bTransient ? RF_Transient : RF_Public | RF_Standalone | RF_Transactional;
    UMaterial* Material = NewObject<UMaterial>(Package, ObjectName, Flags);
    Material->SetShadingModel(MSM_DefaultLit);
    Material->bTangentSpaceNormal = true;

    const FLayerAppearance Grass = AppearanceFor(TEXT("mask"));
    auto* BaseColor = AddColor(Material, Grass.Color, -1400, -350, TEXT("Uncovered terrain: grass"));
    auto* BaseRoughness = AddScalar(Material, Grass.Roughness, -1400, 500, TEXT("Uncovered terrain roughness"));
    UMaterialExpression* ColorResult = BaseColor;
    UMaterialExpression* RoughnessResult = BaseRoughness;
    if (!LayerNames.IsEmpty())
    {
        auto* ColorBlend = AddExpression<UMaterialExpressionLandscapeLayerBlend>(Material, -1400, -50, TEXT("Manifest layer colors"));
        auto* RoughnessBlend = AddExpression<UMaterialExpressionLandscapeLayerBlend>(Material, -1400, 700, TEXT("Manifest layer roughness"));
        auto* WeightSum = AddExpression<UMaterialExpressionLandscapeLayerBlend>(Material, -1900, 1300, TEXT("Sum of independent imported weights"));
        auto* One = AddScalar(Material, 1.0f, -2150, 1300, TEXT("Layer coverage"));
        for (int32 Index = 0; Index < LayerNames.Num(); ++Index)
        {
            const FLayerAppearance Appearance = AppearanceFor(LayerNames[Index]);
            FLayerBlendInput ColorInput;
            ColorInput.LayerName = LayerNames[Index];
            ColorInput.BlendType = LB_WeightBlend;
            ColorInput.PreviewWeight = Index == 0 ? 1.0f : 0.0f;
            ColorInput.ConstLayerInput = FVector(Appearance.Color.R, Appearance.Color.G, Appearance.Color.B);
            ColorBlend->Layers.Add(ColorInput);

            FLayerBlendInput RoughnessInput = ColorInput;
            auto* Roughness = AddScalar(Material, Appearance.Roughness, -1900, Index * 95, *FString::Printf(TEXT("%s roughness"), *LayerNames[Index].ToString()));
            RoughnessInput.LayerInput.Connect(0, Roughness);
            RoughnessBlend->Layers.Add(RoughnessInput);

            FLayerBlendInput WeightInput = ColorInput;
            WeightInput.LayerInput.Connect(0, One);
            WeightSum->Layers.Add(WeightInput);
        }

        // The source maps are independent masks, not a partition that sums to 255. UE's pure
        // LB_WeightBlend adds weighted inputs without renormalizing. Normalize only the shader:
        // (sum(layer * weight) + grass * max(1 - sum(weight), 0)) / max(sum(weight), 1).
        // This also gives completely unpainted terrain a valid grass color and roughness.
        auto* Remaining = AddExpression<UMaterialExpressionSubtract>(Material, -1150, 1300, TEXT("Uncovered weight"));
        Remaining->ConstA = 1.0f;
        Remaining->B.Connect(0, WeightSum);
        auto* Uncovered = AddExpression<UMaterialExpressionMax>(Material, -900, 1300, TEXT("Clamp uncovered weight"));
        Uncovered->A.Connect(0, Remaining);
        Uncovered->ConstB = 0.0f;
        auto* Denominator = AddExpression<UMaterialExpressionMax>(Material, -1150, 1550, TEXT("Safe total weight"));
        Denominator->A.Connect(0, WeightSum);
        Denominator->ConstB = 1.0f;
        ColorResult = CompleteBlend(Material, ColorBlend, BaseColor, Uncovered, Denominator, -50);
        RoughnessResult = CompleteBlend(Material, RoughnessBlend, BaseRoughness, Uncovered, Denominator, 700);
    }

    Material->GetEditorOnlyData()->BaseColor.Connect(0, ColorResult);
    Material->GetEditorOnlyData()->Roughness.Connect(0, RoughnessResult);
    auto* Normal = AddColor(Material, FLinearColor(0.0f, 0.0f, 1.0f), -400, 1100, TEXT("Landscape geometric normal"));
    Material->GetEditorOnlyData()->Normal.Connect(0, Normal);
    Material->PostEditChange();
    if (!bTransient)
    {
        FAssetRegistryModule::AssetCreated(Material);
        Material->MarkPackageDirty();
    }
    return Material;
}
}
