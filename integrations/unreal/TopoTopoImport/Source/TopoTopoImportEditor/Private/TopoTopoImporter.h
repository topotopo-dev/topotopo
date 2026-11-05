// Copyright 2026 faxcorp, Apache-2.0
// Bringing a finished cook into the project: the steps of its report (`import`, integrations/unreal/PROTOCOL.md).
#pragma once

#include "CoreMinimal.h"

class UTopoTopoPackage;

namespace TopoTopo
{
    /**
     * Carry out a finished cook: every step whose cooked files changed since they were imported, whose asset is missing, or
     * all of them with bForce. A failed output keeps its last good assets. The package asset gets the outcome. True when
     * every output is fine.
     */
    bool ApplyCook(UTopoTopoPackage* Package, int32 ExitCode, const FString& ReportFile, const FString& Errors, bool bForce);

    /** A cook that could not run: the reason goes on the asset and to the message log. */
    void FailCook(UTopoTopoPackage* Package, const FString& Why);

    /** Open the import options the package's <id>.topo.import holds, if it has one. */
    void ReadImportOptions(UTopoTopoPackage* Package);

    /** Write the import options to the package's <id>.topo.import, which the cook reads. */
    bool WriteImportOptions(const UTopoTopoPackage* Package, FString& OutError);

    /** Save an asset's package on the next tick: an asset being imported cannot be saved yet. */
    void SaveSoon(UObject* Asset);

    /** The message log's name, under Window > Message Log. */
    extern const FName MessageLogName;
}
