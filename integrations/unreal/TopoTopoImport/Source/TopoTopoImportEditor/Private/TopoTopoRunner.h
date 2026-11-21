// Copyright 2026 faxcorp, Apache-2.0
// When cooks run: now and blocking (an import, a reimport, Recook), or later in the background (a package's graphs, inputs
// or assets changed).
#pragma once

#include "CoreMinimal.h"

class UTopoTopoPackage;

namespace TopoTopo
{
    /** Cook a package with a progress dialog and import the result. True when every output is fine. */
    bool CookNow(UTopoTopoPackage* Package, bool bForce);

    /** Cook a package in the background soon, once changes have settled and the editor is free. */
    void CookLater(const FString& Topo);

    /** Every package asset of the project. */
    TArray<UTopoTopoPackage*> AllPackages();

    void StartRunner();
    void StopRunner();
}
