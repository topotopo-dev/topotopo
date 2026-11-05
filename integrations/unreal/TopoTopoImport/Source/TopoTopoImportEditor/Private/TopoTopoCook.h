// Copyright 2026 faxcorp, Apache-2.0
// Finding TopoTopo and running its cook (integrations/unreal/PROTOCOL.md).
#pragma once

#include "CoreMinimal.h"
#include "HAL/PlatformProcess.h"

DECLARE_LOG_CATEGORY_EXTERN(LogTopoTopo, Log, All);

namespace TopoTopo
{
    /** The protocol of the jobs file and the report this plugin speaks. */
    constexpr int32 Protocol = 1;

    struct FTools
    {
        FString Node;
        FString Cli;
    };

    /** node and the TopoTopo CLI, in the order PROTOCOL.md gives. False, with what to do about it in OutError, when one is not there. */
    bool FindTools(FTools& OutTools, FString& OutError);

    /** One package's cook running in the background. Poll it often: its output is read through pipes. */
    class FCookProcess
    {
    public:
        ~FCookProcess();

        /** Write the jobs file and start. False, with the reason in OutError, when it could not start. */
        bool Start(const FString& Topo, bool bForce, FString& OutError);

        /** Read what it has said. True while it runs. */
        bool Poll();

        void Cancel();

        int32 ExitCode() const { return Code; }
        const FString& ReportFile() const { return Report; }
        /** What it wrote to stderr: the reason when it exits with 2. */
        const FString& Errors() const { return Err; }
        const FString& Topo() const { return TopoFile; }
        int32 Total() const { return OutputsTotal; }
        int32 Done() const { return OutputsDone; }
        const FString& Current() const { return CurrentOutput; }

    private:
        void Read();
        void Close();

        FProcHandle Proc;
        void* OutRead = nullptr;
        void* OutWrite = nullptr;
        void* ErrRead = nullptr;
        void* ErrWrite = nullptr;
        FString Buffer;
        FString Err;
        FString Report;
        FString TopoFile;
        FString CurrentOutput;
        int32 OutputsTotal = 0;
        int32 OutputsDone = 0;
        int32 Code = -1;
    };

    /** The viewer on a package: `edit <dir> --json`, which says its URL on its first line. One per package; they end with the editor. */
    void OpenViewer(const FString& PackageDir, const FString& Id);
    void PollViewers();
    void StopViewers();
}
