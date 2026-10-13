// Copyright 2026 faxcorp, Apache-2.0
using UnrealBuildTool;

public class TopoTopoPCGEditor : ModuleRules
{
    public TopoTopoPCGEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new[]
        {
            "Core", "CoreUObject", "Engine", "TopoTopoPCG", "PCG", "Projects", "UnrealEd", "ToolMenus",
            "Slate", "SlateCore", "Json", "AssetRegistry", "InterchangeCore",
            "InterchangeEngine", "InterchangePipelines", "Landscape", "LandscapeEditor"
        });
    }
}
