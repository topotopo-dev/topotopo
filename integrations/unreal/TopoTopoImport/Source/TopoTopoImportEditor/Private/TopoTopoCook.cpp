// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoCook.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/SecureHash.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "TopoTopoImportSettings.h"

DEFINE_LOG_CATEGORY(LogTopoTopo);

namespace
{
    bool IsFile(const FString& P) { return FPaths::FileExists(P); }

    /** A CLI path as it may be given: a folder means its src/cli.ts, else its dist/cli.js. Empty when none is there. */
    FString CliAt(const FString& Given)
    {
        const FString P = FPaths::ConvertRelativePathToFull(Given);
        if (FPaths::DirectoryExists(P))
        {
            for (const TCHAR* Rel : { TEXT("src/cli.ts"), TEXT("dist/cli.js") })
            {
                if (IsFile(P / Rel)) { return P / Rel; }
            }
            return FString();
        }
        return IsFile(P) ? P : FString();
    }

    FString Env(const TCHAR* Name) { return FPlatformMisc::GetEnvironmentVariable(Name); }

    TArray<FString> PathDirs()
    {
        TArray<FString> Dirs;
        Env(TEXT("PATH")).ParseIntoArray(Dirs, FPlatformMisc::GetPathVarDelimiter());
        return Dirs;
    }

    /** "install".<Key> of the config topotopo unreal setup writes to. */
    FString InstallRecord(const TCHAR* Key)
    {
        FString File = Env(TEXT("TOPOTOPO_CONFIG"));
        if (File.IsEmpty())
        {
            FString Home = Env(TEXT("USERPROFILE"));
            if (Home.IsEmpty()) { Home = Env(TEXT("HOME")); }
            File = Home / TEXT(".topotopo/config.json");
        }
        FString Text;
        TSharedPtr<FJsonObject> Root;
        if (!FFileHelper::LoadFileToString(Text, *File) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root) { return FString(); }
        const TSharedPtr<FJsonObject>* Install = nullptr;
        FString Value;
        if (Root->TryGetObjectField(TEXT("install"), Install) && (*Install)->TryGetStringField(Key, Value)) { return Value; }
        return FString();
    }

    FString FindCli()
    {
        const FString FromEnv = Env(TEXT("TOPOTOPO_CLI"));
        if (!FromEnv.IsEmpty()) { const FString P = CliAt(FromEnv); if (!P.IsEmpty()) { return P; } }
        const FString& FromSettings = GetDefault<UTopoTopoImportSettings>()->TopoTopoPath;
        if (!FromSettings.IsEmpty()) { const FString P = CliAt(FromSettings); if (!P.IsEmpty()) { return P; } }
        // node_modules in the project or above it
        for (FString Dir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()); !Dir.IsEmpty();)
        {
            FPaths::NormalizeDirectoryName(Dir);
            const FString P = Dir / TEXT("node_modules/topotopo/dist/cli.js");
            if (IsFile(P)) { return P; }
            const FString Up = FPaths::GetPath(Dir);
            if (Up == Dir) { break; }
            Dir = Up;
        }
        const FString FromRecord = InstallRecord(TEXT("cli"));
        if (!FromRecord.IsEmpty()) { const FString P = CliAt(FromRecord); if (!P.IsEmpty()) { return P; } }
        // the command on PATH: its package lies beside it
        for (const FString& Dir : PathDirs())
        {
            if (!IsFile(Dir / TEXT("topotopo.cmd")) && !IsFile(Dir / TEXT("topotopo"))) { continue; }
            for (const TCHAR* Rel : { TEXT("node_modules/topotopo/dist/cli.js"), TEXT("../lib/node_modules/topotopo/dist/cli.js") })
            {
                const FString P = FPaths::ConvertRelativePathToFull(Dir / Rel);
                if (IsFile(P)) { return P; }
            }
        }
        return FString();
    }

    FString FindNode()
    {
#if PLATFORM_WINDOWS
        const TCHAR* Exe = TEXT("node.exe");
#else
        const TCHAR* Exe = TEXT("node");
#endif
        const FString FromEnv = Env(TEXT("TOPOTOPO_NODE"));
        if (IsFile(FromEnv)) { return FromEnv; }
        const FString& FromSettings = GetDefault<UTopoTopoImportSettings>()->NodePath;
        if (IsFile(FromSettings)) { return FromSettings; }
        const FString FromRecord = InstallRecord(TEXT("node"));
        if (IsFile(FromRecord)) { return FromRecord; }
        for (const FString& Dir : PathDirs())
        {
            if (IsFile(Dir / Exe)) { return Dir / Exe; }
        }
        for (const TCHAR* Dir : { TEXT("C:/Program Files/nodejs"), TEXT("/usr/local/bin"), TEXT("/opt/homebrew/bin"), TEXT("/usr/bin") })
        {
            if (IsFile(FString(Dir) / Exe)) { return FString(Dir) / Exe; }
        }
        return FString();
    }

    /** Whether a node is 22.18 or newer, which TopoTopo needs. */
    bool NodeIsNewEnough(const FString& Node, FString& OutVersion)
    {
        int32 Code = -1;
        FString Out, Err;
        if (!FPlatformProcess::ExecProcess(*Node, TEXT("--version"), &Code, &Out, &Err) || Code != 0) { return false; }
        OutVersion = Out.TrimStartAndEnd();
        TArray<FString> Parts;
        OutVersion.Replace(TEXT("v"), TEXT("")).ParseIntoArray(Parts, TEXT("."));
        const int32 Major = Parts.Num() > 0 ? FCString::Atoi(*Parts[0]) : 0;
        const int32 Minor = Parts.Num() > 1 ? FCString::Atoi(*Parts[1]) : 0;
        return Major > 22 || (Major == 22 && Minor >= 18);
    }

    FString Quoted(const FString& S) { return TEXT("\"") + S + TEXT("\""); }
}

bool TopoTopo::FindTools(FTools& OutTools, FString& OutError)
{
    OutTools.Cli = FindCli();
    if (OutTools.Cli.IsEmpty())
    {
        OutError = TEXT("TopoTopo was not found. Install it (npm install -g topotopo), run topotopo unreal setup on this project, or set its path in Editor Preferences > Plugins > TopoTopo.");
        return false;
    }
    OutTools.Node = FindNode();
    if (OutTools.Node.IsEmpty())
    {
        OutError = TEXT("Node.js was not found. Install Node.js 22.18 or newer, or set its path in Editor Preferences > Plugins > TopoTopo.");
        return false;
    }
    FString Version;
    if (!NodeIsNewEnough(OutTools.Node, Version))
    {
        OutError = FString::Printf(TEXT("TopoTopo needs Node.js 22.18 or newer, and %s is %s. Update it, or set another one in Editor Preferences > Plugins > TopoTopo."), *OutTools.Node, Version.IsEmpty() ? TEXT("not usable") : *Version);
        return false;
    }
    return true;
}

TopoTopo::FCookProcess::~FCookProcess()
{
    if (Proc.IsValid() && FPlatformProcess::IsProcRunning(Proc)) { FPlatformProcess::TerminateProc(Proc, true); }
    Close();
}

void TopoTopo::FCookProcess::Close()
{
    if (Proc.IsValid()) { FPlatformProcess::CloseProc(Proc); }
    if (OutRead || OutWrite) { FPlatformProcess::ClosePipe(OutRead, OutWrite); OutRead = OutWrite = nullptr; }
    if (ErrRead || ErrWrite) { FPlatformProcess::ClosePipe(ErrRead, ErrWrite); ErrRead = ErrWrite = nullptr; }
}

bool TopoTopo::FCookProcess::Start(const FString& InTopo, bool bForce, FString& OutError)
{
    FTools Tools;
    if (!FindTools(Tools, OutError)) { return false; }
    TopoFile = InTopo;
    const FString Project = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    const FString Stem = FPaths::GetBaseFilename(InTopo) + TEXT("-") + FMD5::HashAnsiString(*InTopo).Left(8);
    const FString Dir = Project / TEXT("Saved/TopoTopo/reports");
    IFileManager::Get().MakeDirectory(*Dir, true);
    Report = Dir / Stem + TEXT(".json");
    const FString Jobs = Dir / Stem + TEXT(".jobs.json");
    IFileManager::Get().Delete(*Report, false, true, true);

    FString Text;
    {
        TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> W = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text);
        W->WriteObjectStart();
        W->WriteValue(TEXT("for"), TEXT("unreal"));
        W->WriteValue(TEXT("protocol"), Protocol);
        W->WriteArrayStart(TEXT("jobs"));
        W->WriteObjectStart();
        W->WriteValue(TEXT("package"), InTopo);
        W->WriteValue(TEXT("report"), Report);
        W->WriteValue(TEXT("timeout"), GetDefault<UTopoTopoImportSettings>()->CookTimeout);
        W->WriteObjectEnd();
        W->WriteArrayEnd();
        W->WriteObjectEnd();
        W->Close();
    }
    if (!FFileHelper::SaveStringToFile(Text, *Jobs, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
    {
        OutError = FString::Printf(TEXT("cannot write %s"), *Jobs);
        return false;
    }

    FPlatformProcess::CreatePipe(OutRead, OutWrite);
    FPlatformProcess::CreatePipe(ErrRead, ErrWrite);
    FString Args = Quoted(Tools.Cli) + TEXT(" cook --jobs ") + Quoted(Jobs) + TEXT(" --progress json");
    if (bForce) { Args += TEXT(" --force --no-cache"); }
    UE_LOG(LogTopoTopo, Log, TEXT("TopoTopo: cooking %s: %s %s"), *InTopo, *Tools.Node, *Args);
    Proc = FPlatformProcess::CreateProc(*Tools.Node, *Args, false, true, true, nullptr, 0, *Project, OutWrite, nullptr, ErrWrite);
    if (!Proc.IsValid())
    {
        Close();
        OutError = FString::Printf(TEXT("%s could not be started"), *Tools.Node);
        return false;
    }
    return true;
}

void TopoTopo::FCookProcess::Read()
{
    Buffer += FPlatformProcess::ReadPipe(OutRead);
    Err += FPlatformProcess::ReadPipe(ErrRead);
    int32 At = INDEX_NONE;
    while (Buffer.FindChar(TEXT('\n'), At))
    {
        const FString Line = Buffer.Left(At).TrimStartAndEnd();
        Buffer.RightChopInline(At + 1);
        TSharedPtr<FJsonObject> Event;
        if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Line), Event) || !Event) { continue; }
        FString Kind;
        Event->TryGetStringField(TEXT("event"), Kind);
        if (Kind == TEXT("start")) { Event->TryGetNumberField(TEXT("outputs"), OutputsTotal); }
        else if (Kind == TEXT("output"))
        {
            OutputsDone++;
            Event->TryGetStringField(TEXT("output"), CurrentOutput);
        }
    }
}

bool TopoTopo::FCookProcess::Poll()
{
    Read();
    if (FPlatformProcess::IsProcRunning(Proc)) { return true; }
    Read();
    FPlatformProcess::GetProcReturnCode(Proc, &Code);
    Close();
    return false;
}

void TopoTopo::FCookProcess::Cancel()
{
    if (Proc.IsValid() && FPlatformProcess::IsProcRunning(Proc)) { FPlatformProcess::TerminateProc(Proc, true); }
}

// ---------------------------------------------------------------------------------------------------------- viewers

namespace
{
    struct FViewer
    {
        FString Id;
        FProcHandle Proc;
        void* Read = nullptr;
        void* Write = nullptr;
        FString Buffer;
        FString Url;
        bool bWanted = true;
    };
    TMap<FString, FViewer> Viewers;
}

void TopoTopo::OpenViewer(const FString& PackageDir, const FString& Id)
{
    if (FViewer* V = Viewers.Find(PackageDir))
    {
        if (FPlatformProcess::IsProcRunning(V->Proc))
        {
            V->bWanted = true;
            return;
        }
        Viewers.Remove(PackageDir);
    }
    FTools Tools;
    FString Error;
    if (!FindTools(Tools, Error))
    {
        UE_LOG(LogTopoTopo, Error, TEXT("TopoTopo: %s"), *Error);
        return;
    }
    FViewer V;
    V.Id = Id;
    FPlatformProcess::CreatePipe(V.Read, V.Write);
    const FString Args = Quoted(Tools.Cli) + TEXT(" edit ") + Quoted(PackageDir) + TEXT(" --json");
    V.Proc = FPlatformProcess::CreateProc(*Tools.Node, *Args, false, true, true, nullptr, 0, *PackageDir, V.Write, nullptr, nullptr);
    if (!V.Proc.IsValid())
    {
        FPlatformProcess::ClosePipe(V.Read, V.Write);
        UE_LOG(LogTopoTopo, Error, TEXT("TopoTopo: the viewer could not start"));
        return;
    }
    UE_LOG(LogTopoTopo, Log, TEXT("TopoTopo: starting the viewer on %s"), *Id);
    Viewers.Add(PackageDir, MoveTemp(V));
}

void TopoTopo::PollViewers()
{
    for (auto It = Viewers.CreateIterator(); It; ++It)
    {
        FViewer& V = It->Value;
        V.Buffer += FPlatformProcess::ReadPipe(V.Read);
        int32 At = INDEX_NONE;
        if (V.Url.IsEmpty() && V.Buffer.FindChar(TEXT('\n'), At))
        {
            TSharedPtr<FJsonObject> Line;
            if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(V.Buffer.Left(At)), Line) && Line)
            {
                Line->TryGetStringField(TEXT("url"), V.Url);
                UE_LOG(LogTopoTopo, Log, TEXT("TopoTopo: the viewer on %s is at %s"), *V.Id, *V.Url);
            }
        }
        V.Buffer.Reset();
        if (!V.Url.IsEmpty() && V.bWanted)
        {
            V.bWanted = false;
            FPlatformProcess::LaunchURL(*V.Url, nullptr, nullptr);
        }
        if (!FPlatformProcess::IsProcRunning(V.Proc))
        {
            if (V.Url.IsEmpty()) { UE_LOG(LogTopoTopo, Error, TEXT("TopoTopo: the viewer on %s stopped before it opened"), *V.Id); }
            FPlatformProcess::CloseProc(V.Proc);
            FPlatformProcess::ClosePipe(V.Read, V.Write);
            It.RemoveCurrent();
        }
    }
}

void TopoTopo::StopViewers()
{
    for (TPair<FString, FViewer>& It : Viewers)
    {
        if (FPlatformProcess::IsProcRunning(It.Value.Proc)) { FPlatformProcess::TerminateProc(It.Value.Proc, true); }
        FPlatformProcess::CloseProc(It.Value.Proc);
        FPlatformProcess::ClosePipe(It.Value.Read, It.Value.Write);
    }
    Viewers.Reset();
}
