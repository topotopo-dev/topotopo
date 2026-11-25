// Copyright 2026 faxcorp, Apache-2.0
using UnrealBuildTool;

public class TopoTopoPCG : ModuleRules
{
    public TopoTopoPCG(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "PCG" });
        PrivateDependencyModuleNames.AddRange(new[] { "Json", "Projects" });
    }
}
