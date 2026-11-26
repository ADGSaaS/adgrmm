// backend/src/security/security.service.ts
//
// Security basics, stage 1: the security scan of Windows devices (a fixed signed script job), what is kept of it, and the
// Defender actions. See security.scripts.ts for what the device is asked, security.baseline.ts for how it is scored.
//
// A scan is asked for, not waited for: the job is queued and noted on the device's row (pending_job_id). The result is read back
// when the job has finished, either when someone opens the device's Security tab or by the poller (every 20 seconds), so a scan
// started by a schedule or a bulk action is kept without anyone watching. A job that times out, or that nobody answered for six
// minutes, marks the attempt with a reason and keeps the last good result.
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { JobsService } from "../jobs/jobs.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { ToolOutputError } from "../device-tools/device-tools.scripts";
import { evaluateScan, RULE_BY_ID, SEVERITY_RANK, type Evaluation, type RuleResult } from "./security.baseline";
import { evaluateLinuxScan, LINUX_RULE_BY_ID, linuxHighlights } from "./security-linux.baseline";
import { LINUX_SECURITY_SCAN_SCRIPT, parseLinuxScan, type LinuxScanData } from "./security-linux.scripts";
import { highlights } from "./security.highlights";
import { LINUX_ACTION_KIND, LINUX_ACTION_TIMEOUT_SEC, LINUX_ACTIONS, LINUX_AV_INSTALL_SCRIPT, LINUX_AV_UPDATE_SCRIPT, LINUX_FIREWALL_ENABLE_SCRIPT, LINUX_MALWARE_SCAN_SCRIPT, parseLinuxAction, type LinuxAction } from "./security-linux.actions";
import {
    DEFENDER_KIND, DEFENDER_SCRIPTS, parseDefenderScan, parseDefenderUpdate, parseSecurityScan, SCAN_TYPES, SECURITY_SCAN_SCRIPT,
    type DefenderAction, type ScanData,
} from "./security.scripts";

export const SCAN_KIND = "security.scan";
const ONLINE_WINDOW_MS = 5 * 60_000;
const JOB_TIMEOUT_SEC = 90;
const WAIT_MS = 25_000;
const POLL_MS = 600;
/** A queued scan nobody answered for this long is given up on (the job sweeper times the job out on its own later). */
const PENDING_STALE_MS = 6 * 60_000;
/** A result older than this is shown as out of date. */
export const STALE_AFTER_MS = 7 * 86_400_000;
const FINISHED = ["succeeded", "failed", "timeout"];

export type SecurityDevice = {
    id: string; name: string; hostname: string; clientId: string | null; clientName: string | null; siteName: string | null;
    windows: boolean; /** A Linux device: the security scan (not the Defender actions or the device secrets) works on it too. */ linux: boolean;
    agentId: string | null; online: boolean; lastCheckInAt: Date | null; os: string;
};

/** Linux, from what the agent says or from a distribution name (an older device row may only have the name). */
export function isLinuxOs(factsOs: unknown, operatingSystem: unknown): boolean {
    const f = String(factsOs ?? "").toLowerCase();
    if (f) return f === "linux";
    return /linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle/i.test(String(operatingSystem ?? ""));
}

type AnyScan = ScanData | LinuxScanData;
const isLinuxScan = (s: unknown): s is LinuxScanData => !!s && typeof s === "object" && (s as any).platform === "linux";

type Row = {
    device_id: string; scanned_at: Date | null; attempted_at: Date; ok: boolean; raw: unknown; score: number | null; grade: string | null;
    findings_failed: number; findings_warned: number; critical_failed: number; high_failed: number; unknown_count: number;
    failed_rules: string[]; message: string | null; pending_job_id: string | null; pending_at: Date | null;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

@Injectable()
export class SecurityService {
    private readonly logger = new Logger(SecurityService.name);
    private polling = false;

    constructor(private readonly prisma: PrismaService, private readonly jobs: JobsService) { }

    /* ------------------------------ the device ------------------------------ */

    /** The device and what it is, without refusing the ones a scan cannot run on (the page explains those). */
    async device(id: string): Promise<SecurityDevice> {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Device not found");
        const d = await this.prisma.devices.findUnique({
            where: { id },
            select: {
                id: true, hostname: true, alias: true, operating_system: true,
                sites: { select: { name: true, client_id: true, clients: { select: { name: true } } } },
                agents: { select: { id: true, facts: true, last_check_in_at: true } },
            },
        });
        if (!d) throw new NotFoundException("Device not found");
        const os = String((d.agents?.facts as any)?.os || d.operating_system || "");
        return {
            id: d.id, name: d.alias || d.hostname, hostname: d.hostname, clientId: d.sites?.client_id ?? null, clientName: d.sites?.clients?.name ?? null,
            siteName: d.sites?.name ?? null, windows: os.toLowerCase().startsWith("windows"), linux: isLinuxOs((d.agents?.facts as any)?.os, d.operating_system), os,
            agentId: d.agents?.id ?? null, lastCheckInAt: d.agents?.last_check_in_at ?? null,
            online: Date.now() - (d.agents?.last_check_in_at?.getTime() ?? 0) <= ONLINE_WINDOW_MS,
        };
    }

    /** Why a scan or action cannot be run on this device, or null. */
    refusal(d: SecurityDevice): { status: 400 | 409; message: string } | null {
        if (!d.windows && !d.linux) return { status: 400, message: "Security scans are available for Windows and Linux devices." };
        if (!d.agentId) return { status: 409, message: "This device has no agent." };
        if (!d.online) return { status: 409, message: "This device is offline. A security scan or Defender action needs a device that is online now." };
        return null;
    }

    private require(d: SecurityDevice, windowsOnly = false) {
        const r = windowsOnly && !d.windows ? { status: 400 as const, message: "Microsoft Defender actions are only available for Windows devices." } : this.refusal(d);
        if (!r) return;
        throw r.status === 400 ? new BadRequestException(r.message) : new ConflictException(r.message);
    }

    /* ------------------------------ asking for a scan ------------------------------ */

    /**
     * Queues a scan on a device that is online. A device whose scan is still waiting is left alone (alreadyWaiting). The job id is
     * noted on the device's row so the answer is kept whoever reads it first.
     */
    async startScan(d: SecurityDevice): Promise<{ jobId: string; alreadyWaiting: boolean }> {
        this.require(d);
        return this.queueScan(d.id, d.agentId!);
    }

    /** The queueing itself, for callers that already know the device is a Windows device with an online agent (bulk, the schedule). */
    async queueScan(deviceId: string, agentId: string, at: Date = new Date()): Promise<{ jobId: string; alreadyWaiting: boolean }> {
        const kind = await this.prisma.$queryRaw<Array<{ os: string | null; name: string | null }>>`SELECT a.facts->>'os' AS os, d.operating_system AS name FROM public.devices d LEFT JOIN public.agents a ON a.device_id = d.id WHERE d.id = ${deviceId}::uuid`;
        const linux = isLinuxOs(kind[0]?.os, kind[0]?.name);
        const row = await this.row(deviceId);
        if (row?.pending_job_id) {
            const state = await this.refreshPending(row);
            if (state === "waiting") return { jobId: row.pending_job_id, alreadyWaiting: true };
        }
        const job = linux
            ? await this.jobs.createRunScriptJob({ agentId, language: "bash", scriptText: LINUX_SECURITY_SCAN_SCRIPT, env: { ADG_TOOL: SCAN_KIND, ADG_PLATFORM: "linux" }, timeoutSec: JOB_TIMEOUT_SEC })
            : await this.jobs.createRunScriptJob({ agentId, language: "powershell", scriptText: SECURITY_SCAN_SCRIPT, env: { ADG_TOOL: SCAN_KIND }, timeoutSec: JOB_TIMEOUT_SEC });
        const now = at;
        await this.prisma.$executeRaw`
            INSERT INTO public.device_security_scans (device_id, attempted_at, pending_job_id, pending_at)
            VALUES (${deviceId}::uuid, ${now}::timestamptz, ${job.id}::uuid, ${now}::timestamptz)
            ON CONFLICT (device_id) DO UPDATE SET attempted_at = EXCLUDED.attempted_at, pending_job_id = EXCLUDED.pending_job_id, pending_at = EXCLUDED.pending_at`;
        return { jobId: job.id, alreadyWaiting: false };
    }

    /* ------------------------------ reading a scan back ------------------------------ */

    private async row(deviceId: string): Promise<Row | null> {
        const rows = await this.prisma.$queryRaw<Row[]>`SELECT * FROM public.device_security_scans WHERE device_id = ${deviceId}::uuid`;
        return rows[0] ?? null;
    }

    /**
     * Looks at the job a row is waiting for: keeps its result when it has finished, gives up on it when it has not been answered for
     * too long. Returns what became of it.
     */
    async refreshPending(row: Pick<Row, "device_id" | "pending_job_id" | "pending_at">): Promise<"waiting" | "kept" | "failed" | "none"> {
        const jobId = row.pending_job_id;
        if (!jobId) return "none";
        const job = await this.jobs.getJobWithResult(jobId).catch(() => null);
        const env = ((job?.parsed_payload as any)?.env ?? {}) as Record<string, string>;
        if (!job || env.ADG_TOOL !== SCAN_KIND) {
            await this.fail(row.device_id, jobId, "The scan job is gone.");
            return "failed";
        }
        if (!FINISHED.includes(job.status)) {
            if (Date.now() - (row.pending_at?.getTime() ?? 0) > PENDING_STALE_MS) {
                await this.fail(row.device_id, jobId, "The device did not answer the scan in time.");
                return "failed";
            }
            return "waiting";
        }
        if (job.status === "timeout") {
            await this.fail(row.device_id, jobId, "The device took too long to finish the scan.");
            return "failed";
        }
        const linux = env.ADG_PLATFORM === "linux";
        let scan: AnyScan;
        try {
            scan = linux ? parseLinuxScan(job.stdout ?? "", job.stderr ?? "") : parseSecurityScan(job.stdout ?? "", job.stderr ?? "");
        } catch (e) {
            const why = e instanceof ToolOutputError ? e.message : "The scan result could not be read.";
            await this.fail(row.device_id, jobId, job.status === "failed" && !String(job.stdout ?? "").trim() && String(job.stderr ?? "").trim() ? String(job.stderr).trim() : why);
            return "failed";
        }
        const ev = isLinuxScan(scan) ? evaluateLinuxScan(scan) : evaluateScan(scan as ScanData);
        const finished = (job as any).finished_at instanceof Date ? (job as any).finished_at : new Date();
        const failed = ev.failedIds.map((id) => (RULE_BY_ID.get(id) ?? LINUX_RULE_BY_ID.get(id))!);
        const kept = await this.prisma.$executeRaw`
            UPDATE public.device_security_scans SET
                scanned_at = ${finished}::timestamptz, attempted_at = ${finished}::timestamptz, ok = true, raw = ${JSON.stringify(scan)}::jsonb,
                score = ${ev.score}::int, grade = ${ev.grade}::text,
                findings_failed = ${failed.filter((r) => r.severity === "critical" || r.severity === "high").length}::int,
                findings_warned = ${failed.filter((r) => r.severity === "medium" || r.severity === "low").length}::int,
                critical_failed = ${ev.failedBySeverity.critical}::int, high_failed = ${ev.failedBySeverity.high}::int, unknown_count = ${ev.counts.unknown}::int,
                failed_rules = ${ev.failedIds}::text[], message = NULL, pending_job_id = NULL, pending_at = NULL
            WHERE device_id = ${row.device_id}::uuid AND pending_job_id = ${jobId}::uuid`;
        return kept ? "kept" : "none";
    }

    /** A failed attempt: the reason is kept, the last good result stays. */
    private async fail(deviceId: string, jobId: string, message: string) {
        await this.prisma.$executeRaw`
            UPDATE public.device_security_scans SET attempted_at = now(), ok = false, message = ${clip(message, 500)}::text, pending_job_id = NULL, pending_at = NULL
            WHERE device_id = ${deviceId}::uuid AND pending_job_id = ${jobId}::uuid`;
    }

    /** Reads back every scan that has finished (or given up on those that never will). Called every 20 seconds. */
    @Interval(20_000)
    async tick(): Promise<void> {
        if (process.env.SECURITY_SCANS_POLLER_ENABLED === "false") return;
        await this.poll();
    }

    async poll(): Promise<number> {
        if (this.polling) return 0;
        this.polling = true;
        try {
            const rows = await this.prisma.$queryRaw<Array<Pick<Row, "device_id" | "pending_job_id" | "pending_at">>>`SELECT device_id::text AS device_id, pending_job_id::text AS pending_job_id, pending_at FROM public.device_security_scans WHERE pending_job_id IS NOT NULL ORDER BY pending_at LIMIT 200`;
            let kept = 0;
            for (const r of rows) {
                try { if ((await this.refreshPending(r)) === "kept") kept++; } catch (e) { this.logger.warn(`Reading a security scan back failed: ${(e as Error).message}`); }
            }
            return kept;
        } catch (e) {
            this.logger.error(`Security scan poller failed: ${(e as Error).message}`);
            return 0;
        } finally {
            this.polling = false;
        }
    }

    /* ------------------------------ what the device page shows ------------------------------ */

    async view(d: SecurityDevice) {
        let row = await this.row(d.id);
        if (row?.pending_job_id) {
            await this.refreshPending(row);
            row = await this.row(d.id);
        }
        const base = { device: { id: d.id, name: d.name, customer: d.clientName, site: d.siteName }, online: d.online, windows: d.windows, linux: d.linux, hasAgent: !!d.agentId };
        const scan = row?.scanned_at ? this.parseStored(row.raw) : null;
        const pending = !!row?.pending_job_id;
        const clamav = d.linux ? await this.linuxAv(d.id) : null;
        const meta = {
            clamav,
            scannedAt: row?.scanned_at?.toISOString() ?? null,
            attemptedAt: row?.attempted_at?.toISOString() ?? null,
            lastAttemptFailed: !!row && !row.ok && !!row.message,
            message: row?.message ?? null,
            pending,
            stale: !!row?.scanned_at && Date.now() - row.scanned_at.getTime() > STALE_AFTER_MS,
        };
        if (!d.windows && !d.linux) return { ...base, state: "unsupported", reason: "Security scans are available for Windows and Linux devices.", ...meta, scan: null };
        if (!scan) {
            const state = !d.agentId ? "no_agent" : !d.online ? "offline" : "not_scanned";
            const reason = !d.agentId ? "This device has no agent, so it cannot be scanned." : !d.online ? "This device is offline and has not been scanned yet." : pending ? "A scan has been asked for and is waiting for the device." : "This device has not been scanned yet. Run a scan to see its security state.";
            return { ...base, state, reason, ...meta, scan: null };
        }
        const ev = isLinuxScan(scan) ? evaluateLinuxScan(scan) : evaluateScan(scan);
        return { ...base, state: "scanned", reason: null, ...meta, scan: this.present(ev, scan) };
    }

    /** The checked probes of a stored scan, or null when what is stored is not a scan (the row is then treated as not scanned). */
    parseStored(raw: unknown): AnyScan | null {
        if (!raw || typeof raw !== "object" || (raw as any).v !== 1 || !(raw as any).probes) return null;
        return raw as AnyScan;
    }

    private present(ev: Evaluation, scan: AnyScan) {
        const rules = ev.rules.map((r) => {
            const def = (RULE_BY_ID.get(r.id) ?? LINUX_RULE_BY_ID.get(r.id))!;
            return { id: r.id, title: r.title, group: r.group, severity: r.severity, weight: r.weight, result: r.result, detail: r.detail, checks: def.checks, why: def.why, fix: def.fix };
        });
        const order: Record<RuleResult, number> = { fail: 0, unknown: 1, pass: 2, not_applicable: 3 };
        rules.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || order[a.result] - order[b.result] || b.weight - a.weight);
        return {
            score: ev.score, uncappedScore: ev.uncappedScore, grade: ev.grade, capped: ev.capped, capReason: ev.capReason,
            counts: ev.counts, failedBySeverity: ev.failedBySeverity,
            unreadable: ev.counts.unknown,
            unreadableText: ev.counts.unknown ? `${ev.counts.unknown} ${ev.counts.unknown === 1 ? "check" : "checks"} could not be read and ${ev.counts.unknown === 1 ? "is" : "are"} not in the score.` : null,
            rules, highlights: isLinuxScan(scan) ? linuxHighlights(scan.probes) : highlights(scan.probes), scanMs: scan.ms,
        };
    }

    /* ------------------------------ Defender actions ------------------------------ */

    /** Runs one Defender action and waits for the answer for a while; `pending` when the device is slow (ask again with the job id). */
    async defender(d: SecurityDevice, action: DefenderAction): Promise<{ jobId: string } & ({ pending: true } | { pending: false; result: unknown })> {
        this.require(d, true);
        const env: Record<string, string> = { ADG_TOOL: DEFENDER_KIND[action] };
        if (action !== "update") env.ADG_SCAN_TYPE = SCAN_TYPES[action];
        const job = await this.jobs.createRunScriptJob({
            agentId: d.agentId!, language: "powershell", scriptText: action === "update" ? DEFENDER_SCRIPTS.update : DEFENDER_SCRIPTS.scan, env, timeoutSec: JOB_TIMEOUT_SEC,
        });
        const until = Date.now() + WAIT_MS;
        for (;;) {
            const j = await this.jobs.getJobWithResult(job.id);
            if (FINISHED.includes(j.status)) return { jobId: job.id, pending: false, result: this.readDefender(action, j.status, j.stdout ?? "", j.stderr ?? "") };
            if (Date.now() >= until) return { jobId: job.id, pending: true };
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
    }

    private readDefender(action: DefenderAction, status: string, stdout: string, stderr: string) {
        if (status === "timeout") throw new ConflictException("The device took too long to answer.");
        try {
            return action === "update" ? parseDefenderUpdate(stdout, stderr) : parseDefenderScan(stdout, stderr);
        } catch (e) {
            if (!(e instanceof ToolOutputError)) throw e;
            if (status !== "succeeded" && !stdout.trim() && stderr.trim()) throw new ConflictException(stderr.trim().slice(0, 400));
            throw new ConflictException(e.message);
        }
    }

    /** Runs one Linux action (turn on the firewall, malware scan, install ClamAV, update its signatures) and waits a while for the answer; `pending` when it is still running. */
    async linuxAction(d: SecurityDevice, action: LinuxAction): Promise<{ jobId: string } & ({ pending: true } | { pending: false; result: unknown })> {
        if (!d.linux) throw new BadRequestException("This action is only available for Linux devices.");
        this.require(d);
        const job = await this.jobs.createRunScriptJob({
            agentId: d.agentId!, language: "bash", scriptText: action === "firewall-enable" ? LINUX_FIREWALL_ENABLE_SCRIPT : action === "antivirus-install" ? LINUX_AV_INSTALL_SCRIPT : action === "antivirus-update" ? LINUX_AV_UPDATE_SCRIPT : LINUX_MALWARE_SCAN_SCRIPT,
            env: { ADG_TOOL: LINUX_ACTION_KIND[action] }, timeoutSec: LINUX_ACTION_TIMEOUT_SEC[action],
        });
        const until = Date.now() + WAIT_MS;
        for (;;) {
            const j = await this.jobs.getJobWithResult(job.id);
            if (FINISHED.includes(j.status)) {
                const result = this.readLinuxAction(action, j.status, j.stdout ?? "", j.stderr ?? "");
                await this.noteLinuxAv(d.id, result);
                return { jobId: job.id, pending: false, result };
            }
            if (Date.now() >= until) return { jobId: job.id, pending: true };
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
    }

    /** Remembers what a finished ClamAV action showed: installed (or not), signatures refreshed, and the malware scan's result. Never throws. */
    private async noteLinuxAv(deviceId: string, r: ReturnType<SecurityService["readLinuxAction"]>) {
        try {
            if (r.action === "antivirus-install" || r.action === "antivirus-update") {
                await this.prisma.$executeRaw`
                    INSERT INTO public.device_linux_av (device_id, installed, installed_at, signatures_at) VALUES (${deviceId}::uuid, true, now(), now())
                    ON CONFLICT (device_id) DO UPDATE SET installed = true, installed_at = COALESCE(public.device_linux_av.installed_at, now()), signatures_at = now()`;
            } else if (r.action === "malware-scan") {
                const notInstalled = r.state === "error" && /not installed/i.test(r.message ?? "");
                await this.prisma.$executeRaw`
                    INSERT INTO public.device_linux_av (device_id, installed, scan_at, scan_state, scan_files, scan_seconds, scan_infected, scan_found, scan_message)
                    VALUES (${deviceId}::uuid, ${notInstalled ? false : r.state === "error" ? null : true}, now(), ${r.state}, ${r.scannedFiles}, ${r.seconds}, ${r.infectedCount}, ${JSON.stringify(r.found)}::jsonb, ${r.message})
                    ON CONFLICT (device_id) DO UPDATE SET installed = COALESCE(EXCLUDED.installed, public.device_linux_av.installed), scan_at = EXCLUDED.scan_at, scan_state = EXCLUDED.scan_state,
                        scan_files = EXCLUDED.scan_files, scan_seconds = EXCLUDED.scan_seconds, scan_infected = EXCLUDED.scan_infected, scan_found = EXCLUDED.scan_found, scan_message = EXCLUDED.scan_message`;
            }
        } catch {
            /* the note is a convenience; the action itself already worked */
        }
    }

    private async linuxAv(deviceId: string) {
        const rows = await this.prisma.$queryRaw<Array<{ installed: boolean | null; installed_at: Date | null; signatures_at: Date | null; scan_at: Date | null; scan_state: string | null; scan_files: number | null; scan_seconds: number | null; scan_infected: number; scan_found: unknown; scan_message: string | null }>>`
            SELECT installed, installed_at, signatures_at, scan_at, scan_state, scan_files, scan_seconds, scan_infected, scan_found, scan_message FROM public.device_linux_av WHERE device_id = ${deviceId}::uuid`.catch(() => []);
        const r = rows[0];
        return {
            installed: r?.installed ?? null,
            signaturesAt: r?.signatures_at?.toISOString() ?? null,
            lastScan: r?.scan_at ? { at: r.scan_at.toISOString(), state: r.scan_state, scannedFiles: r.scan_files, seconds: r.scan_seconds, infectedCount: r.scan_infected, found: Array.isArray(r.scan_found) ? r.scan_found : [], message: r.scan_message } : null,
        };
    }

    private readLinuxAction(action: LinuxAction, status: string, stdout: string, stderr: string) {
        if (status === "timeout") throw new ConflictException("The device took too long to answer.");
        try {
            return parseLinuxAction(action, stdout, stderr);
        } catch (e) {
            if (!(e instanceof ToolOutputError)) throw e;
            throw new ConflictException(stderr.trim() ? stderr.trim().slice(0, 400) : e.message);
        }
    }

    /** The answer of a Defender or Linux action that was still running: only such a job of this device. */
    async defenderResult(d: SecurityDevice, jobId: string) {
        if (!isCanonicalUuid(jobId)) throw new NotFoundException("Job not found");
        const j = await this.jobs.getJobWithResult(jobId).catch(() => null);
        const kind = String(((j?.parsed_payload as any)?.env ?? {}).ADG_TOOL ?? "");
        const linux = LINUX_ACTIONS.find((a) => LINUX_ACTION_KIND[a] === kind);
        if (linux) {
            if (!j || j.agent_id !== d.agentId || j.type !== "RUN_SCRIPT") throw new NotFoundException("Job not found");
            if (!FINISHED.includes(j.status)) return { jobId, action: linux, pending: true as const };
            const result = this.readLinuxAction(linux, j.status, j.stdout ?? "", j.stderr ?? "");
            await this.noteLinuxAv(d.id, result);
            return { jobId, action: linux, pending: false as const, result };
        }
        const action = (Object.keys(DEFENDER_KIND) as DefenderAction[]).find((a) => DEFENDER_KIND[a] === kind);
        if (!j || !action || j.agent_id !== d.agentId || j.type !== "RUN_SCRIPT") throw new NotFoundException("Job not found");
        if (!FINISHED.includes(j.status)) return { jobId, action, pending: true as const };
        return { jobId, action, pending: false as const, result: this.readDefender(action, j.status, j.stdout ?? "", j.stderr ?? "") };
    }

    /* ------------------------------ for the fleet and the report ------------------------------ */

    /** Rules and highlights of a stored row, for the fleet table and the report. */
    summarize(row: { raw: unknown }) {
        const scan = this.parseStored(row.raw);
        if (!scan) return null;
        // On a Linux device the same three columns hold the antivirus, the disk encryption and the firewall.
        if (isLinuxScan(scan)) {
            const l = linuxHighlights(scan.probes);
            return { defender: l.antivirus.label, bitlocker: l.encryption.label, firewall: l.firewall.label, signatureAgeDays: null, os: null };
        }
        const h = highlights(scan.probes);
        return { defender: h.defender.label, bitlocker: h.bitlocker.label, firewall: h.firewall.label, signatureAgeDays: h.defender.signatureAgeDays, os: h.os };
    }

    /** Prisma tagged SQL for a list of ids as a uuid array. */
    static uuidArray(ids: string[]) {
        return Prisma.sql`${ids}::uuid[]`;
    }
}
