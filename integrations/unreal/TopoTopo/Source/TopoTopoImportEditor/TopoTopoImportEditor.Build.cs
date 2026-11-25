// Copyright 2026 faxcorp, Apache-2.0
using UnrealBuildTool;

public class TopoTopoImportEditor : ModuleRules
{
    public TopoTopoImportEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "TopoTopoImport", "UnrealEd", "DeveloperSettings", "InterchangeCore" });
        PrivateDependencyModuleNames.AddRange(new[]
        {
            "AssetDefinition", "AssetRegistry", "AssetTools", "ContentBrowser", "DirectoryWatcher", "InterchangeEngine", "InterchangePipelines", "Json",
            "MessageLog", "PCG", "Slate", "SlateCore", "StaticMeshEditor", "ToolMenus"
        });
    }
}
