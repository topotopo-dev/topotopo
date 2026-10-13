// Copyright 2026 faxcorp, Apache-2.0
#include "PCGTopoTopoPointStreamSettings.h"

#include "PCGContext.h"
#include "Data/PCGPointArrayData.h"
#include "Engine/StaticMesh.h"
#include "Metadata/PCGMetadata.h"
#include "UObject/Package.h"

namespace
{
    template <typename T, typename F>
    void WriteAttribute(UPCGPointArrayData* Data, const FTopoTopoStream& Stream, const FString& Name,
        const T& Default, F GetValue, bool bInterpolate = true)
    {
        auto* Attribute = Data->MutableMetadata()->CreateAttribute<T>(FName(*Name), Default, bInterpolate, false);
        if (!Attribute)
        {
            return;
        }
        const auto Keys = Data->GetConstMetadataEntryValueRange();
        for (int32 Index = 0; Index < Stream.Rows.Num(); ++Index)
        {
            if (const FTopoTopoAttributeValue* Value = Stream.Rows[Index].Attributes.Find(Name))
            {
                Attribute->SetValue(Keys[Index], GetValue(*Value));
            }
        }
    }

    class FPCGTopoTopoPointStreamElement final : public IPCGElement
    {
    public:
        virtual bool CanExecuteOnlyOnMainThread(FPCGContext* Context) const override { return true; }
        virtual bool IsCacheable(const UPCGSettings* InSettings) const override
        {
            const auto* Settings = Cast<UPCGTopoTopoPointStreamSettings>(InSettings);
            return Settings && !Settings->bReimportOnChange;
        }
        virtual bool ShouldComputeFullOutputDataCrc(FPCGContext* Context) const override { return true; }

    protected:
        virtual bool ExecuteInternal(FPCGContext* Context) const override
        {
            const auto* Settings = Context->GetInputSettings<UPCGTopoTopoPointStreamSettings>();
            FTopoTopoStream Stream;
            FString Error;
            if (!TopoTopoStream::LoadFile(Settings->FilePath, Settings->GetStreamOptions(), Stream, Error))
            {
                PCGE_LOG(Error, GraphAndLog, FText::FromString(Error));
                return true;
            }
            for (const FString& Warning : Stream.Warnings)
            {
                PCGE_LOG(Warning, GraphAndLog, FText::FromString(Warning));
            }
            FPCGTaggedData& Output = Context->OutputData.TaggedData.Emplace_GetRef();
            Output.Pin = PCGPinConstants::DefaultOutputLabel;
            Output.Data = TopoTopoPCG::CreatePointData(Stream);
            return true;
        }
    };
}

UPCGPointArrayData* TopoTopoPCG::CreatePointData(const FTopoTopoStream& Stream, UObject* Outer)
{
    check(IsInGameThread());
    UPCGPointArrayData* Data = NewObject<UPCGPointArrayData>(Outer ? Outer : GetTransientPackage());
    Data->SetNumPoints(Stream.Rows.Num());
    Data->AllocateProperties(EPCGPointNativeProperties::Transform | EPCGPointNativeProperties::Density |
        EPCGPointNativeProperties::Color | EPCGPointNativeProperties::Seed | EPCGPointNativeProperties::MetadataEntry);
    auto Transforms = Data->GetTransformValueRange(false);
    auto Densities = Data->GetDensityValueRange(false);
    auto Colors = Data->GetColorValueRange(false);
    auto Seeds = Data->GetSeedValueRange(false);
    auto Keys = Data->GetMetadataEntryValueRange(false);
    for (int32 Index = 0; Index < Stream.Rows.Num(); ++Index)
    {
        const FTopoTopoStreamRow& Row = Stream.Rows[Index];
        Transforms[Index] = Row.Transform;
        Densities[Index] = Row.Density;
        Colors[Index] = Row.Color;
        Seeds[Index] = Row.Seed;
        Keys[Index] = Data->MutableMetadata()->AddEntry();
    }
    for (const FString& Name : Stream.AttributeNames)
    {
        if (Stream.Rows.IsEmpty()) { break; }
        const FTopoTopoAttributeValue* Example = Stream.Rows[0].Attributes.Find(Name);
        if (!Example) { continue; }
        if (Name == TEXT("MeshPath"))
        {
            WriteAttribute(Data, Stream, Name, FSoftObjectPath(), [](const auto& V) { return FSoftObjectPath(V.StringValue); }, false);
            continue;
        }
        switch (Example->Type)
        {
        case ETopoTopoAttributeType::Float:
            WriteAttribute(Data, Stream, Name, 0.0, [](const auto& V) { return V.FloatValue; }); break;
        case ETopoTopoAttributeType::Integer:
            WriteAttribute(Data, Stream, Name, int64(0), [](const auto& V) { return V.IntValue; }, false); break;
        case ETopoTopoAttributeType::String:
            WriteAttribute(Data, Stream, Name, FString(), [](const auto& V) { return V.StringValue; }, false); break;
        case ETopoTopoAttributeType::Vector2:
            WriteAttribute(Data, Stream, Name, FVector2D::ZeroVector, [](const auto& V) { return FVector2D(V.VectorValue.X, V.VectorValue.Y); }); break;
        case ETopoTopoAttributeType::Vector:
            WriteAttribute(Data, Stream, Name, FVector::ZeroVector, [](const auto& V) { return FVector(V.VectorValue.X, V.VectorValue.Y, V.VectorValue.Z); }); break;
        case ETopoTopoAttributeType::Vector4:
            WriteAttribute(Data, Stream, Name, FVector4(0, 0, 0, 0), [](const auto& V) { return V.VectorValue; }); break;
        }
    }
    return Data;
}

FTopoTopoStreamOptions UPCGTopoTopoPointStreamSettings::GetStreamOptions() const
{
    FTopoTopoStreamOptions Options;
    Options.CoordinateMode = CoordinateMode;
    Options.SeedColumn = SeedColumn;
    Options.DensityColumn = DensityColumn;
    Options.AttributeInclude = AttributeInclude;
    Options.AttributeExclude = AttributeExclude;
    Options.MeshFolder = MeshFolder;
    for (const auto& Pair : MeshMapping) { Options.MeshMapping.Add(Pair.Key, Pair.Value.ToSoftObjectPath()); }
    return Options;
}

FPCGElementPtr UPCGTopoTopoPointStreamSettings::CreateElement() const
{
    return MakeShared<FPCGTopoTopoPointStreamElement>();
}

#if WITH_EDITOR
FText UPCGTopoTopoPointStreamSettings::GetDefaultNodeTitle() const
{
    return NSLOCTEXT("TopoTopoPCG", "PointStreamTitle", "TopoTopo Point Stream");
}

FText UPCGTopoTopoPointStreamSettings::GetNodeTooltipText() const
{
    return NSLOCTEXT("TopoTopoPCG", "PointStreamTooltip", "Load TopoTopo CSV or points.json. PCG CSV is already in Unreal centimetres. Regenerate to reload external files.");
}
#endif
