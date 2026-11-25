// Copyright 2026 faxcorp, Apache-2.0
// When cooks run: now and blocking (an import, a reimport, Recook), or later in the background (a package's graphs, inputs
// or assets changed).
#pragma once

#include "CoreMinimal.h"
#include "TopoTopoImporter.h"

class UTopoTopoPackage;

namespace TopoTopo
{
    /** Cook a package with progress and import the result before returning. */
    FCookResult CookNow(UTopoTopoPackage* Package, bool bForce);

    /** Save the package asset and print one line: imported, cooked, unchanged or failed with the reason. */
    ECookState ReportCommandCook(UTopoTopoPackage* Package, FCookResult Result, bool bImported);

    /** Cook a package in the background soon, once changes have settled and the editor is free. */
    void CookLater(const FString& Topo);

    /** Every package asset of the project. */
    TArray<UTopoTopoPackage*> AllPackages();

    void StartRunner();
    void StopRunner();
}
