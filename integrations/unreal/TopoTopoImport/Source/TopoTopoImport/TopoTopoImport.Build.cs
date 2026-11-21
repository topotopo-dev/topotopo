// Copyright 2026 faxcorp, Apache-2.0
using UnrealBuildTool;

public class TopoTopoImport : ModuleRules
{
    public TopoTopoImport(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
    }
}
