// backend/src/device-tools/device-tools.service.ts
//
// Services, processes and event log of one device, through signed script jobs (see device-tools.scripts.ts).
// The job is created, then followed for up to WAIT_MS so the page gets an answer in one request; when the device is
// slow the answer is `{ pending: true, jobId }` and the page asks again for that job.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { JobsService } from "../jobs/jobs.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import {
    cleanHours, cleanLevels, cleanLogName, cleanMax, cleanPid, cleanSearch, cleanServiceName, eventsCsv,
    Family, linuxEvents, linuxOutcome, linuxProcesses, linuxServices, LINUX, maxPriorityFor, parseWindowsJson, SEARCH_SCAN,
    ServiceAction, StartType, START_TYPES, ToolOutputError, windowsEvents, windowsProcesses, windowsServices, WINDOWS,
    type EventRow, type ProcessRow, type ServiceRow,
} from "./device-tools.scripts";

import { parseRegistryKey, parseRegistryRoots, parseRegistrySearch, parseRegistryWrite } from "./device-registry.scripts";

const WAIT_MS = 25_000;
const POLL_MS = 600;
const ONLINE_WINDOW_MS = 5 * 60_000;
const TOOL_TIMEOUT_SEC = 90;

export type ToolKind = "services.list" | "service.action" | "processes.list" | "process.end" | "eventlog" | "registry.key" | "registry.search" | "registry.roots" | "registry.set" | "registry.delete-value" | "registry.create-key" | "registry.delete-key";
/** The registry browser's jobs are read back only through its own route (its own right), never through the generic jobs route. */
export type JobScope = "tools" | "registry";

export type Target = { deviceId: string; agentId: string; family: Family; name: string; online: boolean };

type Finished = { status: string; stdout: string; stderr: string };
type Reader = (stdout: string, stderr: string) => any;

@Injectable()
export class DeviceToolsService {
    constructor(private readonly prisma: PrismaService, private readonly jobs: JobsService) { }

    /** The device and its agent. */
    async target(id: string): Promise<Target> {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Device not found");
        const d = await this.prisma.devices.findUnique({
            where: { id },
            select: { id: true, hostname: true, alias: true, operating_system: true, agents: { select: { id: true, facts: true, last_check_in_at: true } } },
        });
        if (!d) throw new NotFoundException("Device not found");
        if (!d.agents) throw new ConflictException("This device has no agent.");
        const os = String((d.agents.facts as any)?.os || d.operating_system || "").toLowerCase();
        const family: Family | null = os.startsWith("windows") ? "windows" : os === "linux" || /linux|ubuntu|debian|centos|rhel|fedora|suse|rocky|alma/.test(os) ? "linux" : null;
        if (!family) throw new BadRequestException("These tools are available for Windows and Linux devices.");
        const online = Date.now() - (d.agents.last_check_in_at?.getTime() ?? 0) <= ONLINE_WINDOW_MS;
        return { deviceId: d.id, agentId: d.agents.id, family, name: d.alias || d.hostname, online };
    }

    /** Offline devices are refused: these tools are for now, not for whenever the device is back. */
    private async start(t: Target, kind: ToolKind, script: string, env: Record<string, string>): Promise<string> {
        if (!t.online) throw new ConflictException("This device is offline. These tools work on a device that is online now.");
        const job = await this.jobs.createRunScriptJob({
            agentId: t.agentId,
            language: t.family === "windows" ? "powershell" : "bash",
            scriptText: script,
            // ADG_TOOL marks the job as one of these, so only these jobs can be read back through this service.
            env: { ...env, ADG_TOOL: kind },
            timeoutSec: TOOL_TIMEOUT_SEC,
        });
        return job.id;
    }

    /** Follows a job until it ends or the wait is over. */
    private async finish(jobId: string): Promise<(Finished & { done: boolean })> {
        const until = Date.now() + WAIT_MS;
        for (;;) {
            const j = await this.jobs.getJobWithResult(jobId);
            if (["succeeded", "failed", "timeout"].includes(j.status)) return { done: true, status: j.status, stdout: j.stdout ?? "", stderr: j.stderr ?? "" };
            if (Date.now() >= until) return { done: false, status: j.status, stdout: "", stderr: "" };
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
    }

    /** Turns what a finished job printed into the answer. A tool error is a 409 with the device's own reason. */
    private read(r: Finished, read: Reader): any {
        if (r.status === "timeout") throw new ConflictException("The device took too long to answer.");
        try {
            return { pending: false, ...read(r.stdout, r.stderr) };
        } catch (e) {
            if (!(e instanceof ToolOutputError)) throw e;
            if (r.status !== "succeeded" && !r.stdout.trim() && r.stderr.trim()) throw new ConflictException(r.stderr.trim().slice(0, 400));
            throw new ConflictException(e.message);
        }
    }

    /** Starts a job of these tools and follows it; the answer is `{ pending: true, jobId }` when the device is slow. */
    async run(t: Target, kind: ToolKind, script: string, env: Record<string, string>, read: Reader, onStart?: (jobId: string) => Promise<void>): Promise<{ jobId: string; answer: any }> {
        const jobId = await this.start(t, kind, script, env);
        // The caller can note the job at once (a change record keeps it), before the wait for the answer begins.
        if (onStart) await onStart(jobId);
        const r = await this.finish(jobId);
        return { jobId, answer: r.done ? this.read(r, read) : { pending: true, jobId } };
    }

    /** What an earlier request left running: only a job of these tools, on this device. */
    async result(t: Target, jobId: string, scope: JobScope = "tools"): Promise<any> {
        if (!isCanonicalUuid(jobId)) throw new NotFoundException("Job not found");
        const j = await this.jobs.getJobWithResult(jobId).catch(() => null);
        const env = ((j?.parsed_payload as any)?.env ?? {}) as Record<string, string>;
        const kind = String(env.ADG_TOOL ?? "") as ToolKind;
        if (!j || j.agent_id !== t.agentId || j.type !== "RUN_SCRIPT" || !kind) throw new NotFoundException("Job not found");
        if (kind.startsWith("registry.") !== (scope === "registry")) throw new NotFoundException("Job not found");
        if (!["succeeded", "failed", "timeout"].includes(j.status)) return { pending: true, jobId };
        return this.read({ status: j.status, stdout: j.stdout ?? "", stderr: j.stderr ?? "" }, this.reader(kind, t.family, env));
    }

    reader(kind: ToolKind, family: Family, env: Record<string, string>): Reader {
        const win = (f: (p: any) => any): Reader => (o, e) => f(parseWindowsJson(o, e));
        switch (kind) {
            case "services.list": return family === "windows" ? win((p) => ({ items: windowsServices(p) })) : (o) => ({ items: linuxServices(o) });
            case "processes.list": return family === "windows" ? win((p) => ({ items: windowsProcesses(p) })) : (o) => ({ items: linuxProcesses(o) });
            case "eventlog": {
                const levels = String(env.ADG_LEVELS ?? "").split(",").filter(Boolean).map(Number);
                return family === "windows" ? win((p) => windowsEvents(p)) : (o) => linuxEvents(o, levels);
            }
            case "service.action": return family === "windows"
                ? win((p) => ({ ok: true, state: String(p.state ?? "").toLowerCase(), startType: String(p.startMode ?? "").toLowerCase() }))
                : (o, e) => { const l = linuxOutcome(o, e); return { ok: true, state: l[0] ?? "", startType: l[1] ?? "" }; };
            case "registry.key": return win((p) => parseRegistryKey(p, String(env.ADG_REG_PATH ?? "")));
            case "registry.search": return win((p) => parseRegistrySearch(p));
            case "registry.roots": return win((p) => parseRegistryRoots(p));
            case "registry.set":
            case "registry.delete-value":
            case "registry.create-key":
            case "registry.delete-key": return win((p) => parseRegistryWrite(p));
            case "process.end": return family === "windows" ? win((p) => ({ ok: true, name: String(p.name ?? "") })) : (o, e) => ({ ok: true, name: linuxOutcome(o, e)[0] ?? "" });
        }
    }

    /* ------------------------------ the tools ------------------------------ */

    async listServices(t: Target): Promise<{ jobId: string; pending: boolean; items?: ServiceRow[] }> {
        const { jobId, answer } = await this.run(t, "services.list", t.family === "windows" ? WINDOWS.servicesList : LINUX.servicesList, {}, this.reader("services.list", t.family, {}));
        return { jobId, ...answer };
    }

    async serviceAction(t: Target, input: { name: unknown; action: ServiceAction; startType?: StartType; force?: boolean }) {
        const name = cleanServiceName(input.name, t.family);
        const env: Record<string, string> = { ADG_SERVICE: name, ADG_FORCE: input.force ? "1" : "0" };
        if (t.family === "windows") {
            env.ADG_ACTION = input.action;
            if (input.action === "startup") {
                if (!input.startType || !START_TYPES.includes(input.startType)) throw new BadRequestException("Choose how the service should start.");
                env.ADG_STARTTYPE = input.startType;
            }
        } else if (input.action === "startup") {
            if (input.startType === "delayed") throw new BadRequestException("Delayed start is a Windows setting. Choose automatic, manual or disabled.");
            // automatic = enable; manual = disable (starts only when asked); disabled = mask (cannot be started at all)
            env.ADG_ACTION = ({ automatic: "enable", manual: "disable", disabled: "mask" } as Record<string, string>)[String(input.startType)] ?? "";
            if (!env.ADG_ACTION) throw new BadRequestException("Choose how the service should start.");
        } else {
            env.ADG_ACTION = input.action;
        }
        const { jobId, answer } = await this.run(t, "service.action", t.family === "windows" ? WINDOWS.serviceAction : LINUX.serviceAction, env, this.reader("service.action", t.family, env));
        return { jobId, name, ...answer };
    }

    async listProcesses(t: Target): Promise<{ jobId: string; pending: boolean; items?: ProcessRow[] }> {
        const { jobId, answer } = await this.run(t, "processes.list", t.family === "windows" ? WINDOWS.processesList : LINUX.processesList, {}, this.reader("processes.list", t.family, {}));
        return { jobId, ...answer };
    }

    async endProcess(t: Target, input: { pid: unknown; force?: boolean }) {
        const pid = cleanPid(input.pid);
        const env = { ADG_PID: String(pid), ADG_FORCE: input.force ? "1" : "0" };
        const { jobId, answer } = await this.run(t, "process.end", t.family === "windows" ? WINDOWS.processEnd : LINUX.processEnd, env, this.reader("process.end", t.family, env));
        return { jobId, pid, ...answer };
    }

    /** What the query asks for, checked; used both to run it and to describe it in the audit trail. */
    parseEventQuery(family: Family, q: { log?: unknown; hours?: unknown; levels?: unknown; max?: unknown; q?: unknown }) {
        const log = cleanLogName(q.log, family);
        const levels = log.toLowerCase() === "security" && family === "windows" ? [] : cleanLevels(q.levels);
        return { log, hours: cleanHours(q.hours), levels, max: cleanMax(q.max), text: cleanSearch(q.q) };
    }

    async eventLog(t: Target, query: ReturnType<DeviceToolsService["parseEventQuery"]>): Promise<{ jobId: string; pending: boolean; items?: EventRow[]; truncated?: boolean; scanned?: number }> {
        const env: Record<string, string> = { ADG_LOG: query.log, ADG_MAX: String(query.max), ADG_TEXT: query.text, ADG_SCAN: String(SEARCH_SCAN), ADG_LEVELS: query.levels.join(",") };
        if (t.family === "windows") env.ADG_HOURS = String(query.hours);
        else {
            env.ADG_SINCE = String(Math.floor(Date.now() / 1000) - query.hours * 3600);
            env.ADG_PRIO = maxPriorityFor(query.levels);
        }
        const { jobId, answer } = await this.run(t, "eventlog", t.family === "windows" ? WINDOWS.eventLog : LINUX.eventLog, env, this.reader("eventlog", t.family, env));
        return { jobId, ...answer };
    }

    csv(items: EventRow[]) {
        return eventsCsv(items);
    }
}
