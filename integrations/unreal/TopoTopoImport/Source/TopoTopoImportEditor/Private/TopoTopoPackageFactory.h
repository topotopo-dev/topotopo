// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"
#include "EditorReimportHandler.h"
#include "Factories/Factory.h"
#include "TopoTopoPackageFactory.generated.h"

/** Imports a <id>.topo as a package asset, and reimports it: both cook the package and bring its outputs in. */
UCLASS(hidecategories = Object)
class UTopoTopoPackageFactory : public UFactory, public FReimportHandler
{
    GENERATED_BODY()

public:
    UTopoTopoPackageFactory();

    virtual bool FactoryCanImport(const FString& Filename) override;
    virtual UObject* FactoryCreateFile(UClass* InClass, UObject* InParent, FName InName, EObjectFlags Flags, const FString& Filename, const TCHAR* Parms, FFeedbackContext* Warn, bool& bOutOperationCanceled) override;

    virtual bool CanReimport(UObject* Obj, TArray<FString>& OutFilenames) override;
    virtual void SetReimportPaths(UObject* Obj, const TArray<FString>& NewReimportPaths) override;
    virtual EReimportResult::Type Reimport(UObject* Obj) override;
    virtual int32 GetPriority() const override { return ImportPriority; }
};
