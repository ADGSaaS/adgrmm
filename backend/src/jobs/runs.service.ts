// backend/src/jobs/runs.service.ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { UiSocketRegistry } from "../common/ui-socket-registry.service";
import { PrismaService } from "../storage/prisma.service";
import { JobsService } from "./jobs.service";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type JobSnapshot = {
    jobId: string;
    deviceId: string;
    status: JobStatus;
    log: string;
    exitCode?: number | null;
    startedAt: number;
    finishedAt?: number | null;
};

export type StartRunInput = {
    deviceId: string;
    script: string;
    shell?: "powershell" | "bash" | "cmd";
    timeoutSec?: number;
};

const WATCH_EVERY_MS = 1000;
const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 3600;

function toRunStatus(status: string): JobStatus {
    if (status === "succeeded") return "succeeded";
    if (status === "failed" || status === "timeout") return "failed";
    if (status === "queued") return "queued";
    return "running";
}

function combineOutput(stdout?: string | null, stderr?: string | null): string {
    const out = stdout ?? "";
    const err = stderr ?? "";
    if (!err) return out;
    return out ? `${out}${out.endsWith("\n") ? "" : "\n"}${err}` : err;
}

/** Runs a script on a device through the agent job queue and reports it to the console. */
@Injectable()
export class RunsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jobs: JobsService,
        private readonly uiSockets: UiSocketRegistry,
    ) { }

    /** `watch: false` leaves out the per-job watcher: a batch of hundreds of runs is followed from its own view instead. */
    async startRun(input: StartRunInput, opts: { watch?: boolean } = {}): Promise<string> {
        const agent = await this.prisma.agents.findUnique({
            where: { device_id: input.deviceId },
            select: { id: true, facts: true, devices: { select: { operating_system: true } } },
        });
        if (!agent) throw new NotFoundException("No agent is attached to this device yet.");

        const reported = (agent.facts as any)?.os;
        const os = String(reported || agent.devices?.operating_system || "").toLowerCase();
        const job = await this.jobs.createRunScriptJob({
            agentId: agent.id,
            ...this.toAgentScript(input, os),
            timeoutSec: Math.min(Math.max(input.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC),
        });

        if (opts.watch !== false) void this.watch(job.id, input.deviceId);
        return job.id;
    }

    private toAgentScript(input: StartRunInput, os: string) {
        const shell = input.shell ?? (os === "windows" ? "powershell" : "bash");

        if (os === "windows") {
            if (shell === "bash") throw new BadRequestException("Windows devices run PowerShell or cmd scripts.");
            if (shell === "powershell") return { language: "powershell" as const, scriptText: input.script };

            // The batch text travels in an environment variable, so nothing in it can break out of a string here.
            return {
                language: "powershell" as const,
                scriptText: [
                    "$file = [IO.Path]::ChangeExtension([IO.Path]::GetTempFileName(), '.cmd')",
                    "try {",
                    "  [IO.File]::WriteAllText($file, $env:ADG_BATCH_SCRIPT)",
                    "  & cmd.exe /c $file",
                    "  exit $LASTEXITCODE",
                    "} finally { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue }",
                ].join("\n"),
                env: { ADG_BATCH_SCRIPT: input.script },
            };
        }

        if (shell !== "bash") throw new BadRequestException("Linux devices run bash scripts.");
        return { language: "bash" as const, scriptText: input.script };
    }

    /** Sends status changes to the console until the job ends. The sweeper bounds how long that takes. */
    private async watch(jobId: string, deviceId: string): Promise<void> {
        let lastStatus = "";
        const started = Date.now();

        while (Date.now() - started < (MAX_TIMEOUT_SEC + 300) * 1000) {
            await new Promise((r) => setTimeout(r, WATCH_EVERY_MS));

            let snap: JobSnapshot | null;
            try {
                snap = await this.get(jobId);
            } catch {
                return;
            }
            if (!snap) return;

            if (snap.status !== lastStatus) {
                lastStatus = snap.status;
                const done = snap.status === "succeeded" || snap.status === "failed";
                this.uiSockets.broadcastToDevice(deviceId, {
                    type: "job.run.updated",
                    jobId,
                    status: snap.status,
                    progress: done ? 100 : snap.status === "running" ? 50 : 0,
                    chunk: done ? snap.log : "",
                    exitCode: snap.exitCode ?? null,
                    finishedAt: snap.finishedAt ? new Date(snap.finishedAt).toISOString() : null,
                });
                if (done) return;
            }
        }
    }

    async get(jobId: string): Promise<JobSnapshot | null> {
        const row = await this.prisma.jobs.findUnique({
            where: { id: jobId },
            select: {
                id: true,
                status: true,
                created_at: true,
                finished_at: true,
                agents: { select: { device_id: true } },
                job_results: { select: { exit_code: true, stdout: true, stderr: true } },
            },
        });
        if (!row) return null;

        return {
            jobId: row.id,
            deviceId: row.agents?.device_id ?? "",
            status: toRunStatus(row.status),
            log: combineOutput(row.job_results?.stdout, row.job_results?.stderr),
            exitCode: row.job_results?.exit_code ?? null,
            startedAt: row.created_at.getTime(),
            finishedAt: row.finished_at?.getTime() ?? null,
        };
    }
}
