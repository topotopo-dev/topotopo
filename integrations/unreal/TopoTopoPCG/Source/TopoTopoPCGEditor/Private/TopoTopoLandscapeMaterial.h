// Copyright 2026 faxcorp, Apache-2.0
#pragma once

#include "CoreMinimal.h"

class UMaterial;

namespace TopoTopoLandscape
{
    /** Creates an unsaved, replaceable preview material, with inputs in manifest order. */
    UMaterial* CreateMaterial(const FString& Destination, const TArray<FName>& LayerNames, bool bTransient);
}
