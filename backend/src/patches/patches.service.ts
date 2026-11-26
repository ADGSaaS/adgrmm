// adgrmm-minimal-e2e/backend/src/patches/patches.service.ts
import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";
import { agentVersionAtLeast, linuxPatchMinVersion, patchOs, type PatchOs } from "./linux-patching";

/** How often the sweep looks for devices whose scan is due. */
const SWEEP_EVERY_MS = 15 * 60_000;
/** At most this many scans are queued per sweep, so a large fleet is scanned over a few hours, not all at once. */
const SCANS_PER_SWEEP = 50;
const DEFAULT_SCAN_EVERY_HOURS = 24;

/** Hours between automatic scans of each device. 0 turns automatic scanning off. */
export function scanEveryHours(raw: string | undefined = process.env.PATCH_SCAN_EVERY_HOURS): number {
    if (raw === undefined || raw === "") return DEFAULT_SCAN_EVERY_HOURS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 24 * 30) : DEFAULT_SCAN_EVERY_HOURS;
}

export type PatchRow = {
    id: string;
    title: string;
    severity: string | null;
    requiresReboot: boolean;
    kbIds: string[];
    status: "Required" | "Installed" | "Pending";
    /** Linux only: the distribution says this is a security update. Windows rows have a severity instead. */
    security?: boolean;
    /** Linux only: the package, and the version it has now and would get. */
    name?: string | null;
    current?: string | null;
    available?: string | null;
    source?: string | null;
};

type LatestPatchesResult = {
    ok: true;
    lastScanAt: string | null;
    lastScan: { status: string; error: string | null } | null;
    scanPending: boolean;
    installPending: boolean;
    patches: PatchRow[];
    /** "windows" or "linux" (null when the device is neither). */
    os: PatchOs;
    /** False when the device cannot be patched from here, with the reason. */
    supported: boolean;
    unsupportedReason: string | null;
    /** Linux: apt, dnf, yum or zypper. */
    packageManager: string | null;
    /** Packages the package manager is holding back (held, kept back, phased), from the last scan. */
    skipped: { id: string; reason: string }[];
    /** The last scan or install says the device needs a restart to finish. */
    rebootRequired: boolean | null;
    rebootReason: string | null;
};

export type PatchHistoryItem = {
    taskId: string;
    runId: string;
    agentId: string;
    deviceId: string;

    status: "running" | "succeeded" | "failed" | "cancelled" | "queued" | "pending";

    startedAt: string;
    finishedAt: string | null;
    error: string | null;

    installed: string[];
    requiresReboot: boolean | null;

    createdBy: string | null;
    createdByName: string | null;
};

function asObject(v: any): Record<string, any> | null {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null;
}

function asStringArray(v: any): string[] {
    if (!v) return [];
    if (Array.isArray(v)) return v.map((x) => String(x)).map((s) => s.trim()).filter(Boolean);
    return [];
}

function asBooleanOrNull(v: any): boolean | null {
    if (v === true) return true;
    if (v === false) return false;
    if (v == null) return null;

    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
    }
    return null;
}

function userDisplayName(u: { first_name: string | null; last_name: string | null; email: string; id: string } | null): string | null {
    if (!u) return null;
    const full = [u.first_name, u.last_name].filter((v) => v != null).join(" ").replace(/^ +| +$/g, "");
    return full || u.email.replace(/^ +| +$/g, "") || u.id;
}

@Injectable()
export class PatchesService {
    private readonly logger = new Logger(PatchesService.name);
    private sweeping = false;

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Keeps every Windows device scanned, so patch reports always have a recent answer. A scan only looks at what is
     * missing and changes nothing on the device. Only devices that are online now are queued, and a device that already
     * has a scan waiting, or had one inside the interval, is left alone.
     */
    async queueDueScans(hours = scanEveryHours()): Promise<number> {
        if (hours <= 0) return 0;
        const due = await this.prisma.$queryRaw<Array<{ agent_id: string }>>`
            SELECT a.id::text AS agent_id
            FROM public.agents a
            JOIN public.devices d ON d.id = a.device_id
            WHERE (
                    lower(COALESCE(a.facts->>'os', '')) = 'windows' OR lower(COALESCE(d.operating_system, '')) LIKE 'windows%'
                    -- Linux agents older than the one that runs patch tasks would leave the scan waiting for ever.
                    OR (lower(COALESCE(a.facts->>'os', '')) = 'linux'
                        AND CASE WHEN a.version ~ '^[0-9]+([.][0-9]+){1,3}$' THEN string_to_array(a.version, '.')::int[] >= string_to_array(${linuxPatchMinVersion()}, '.')::int[] ELSE false END)
                  )
              AND a.last_check_in_at > now() - interval '10 minutes'
              AND NOT EXISTS (
                  SELECT 1 FROM public.agent_tasks t
                  WHERE t.agent_id = a.id AND t.type = 'patch_scan'
                    AND (t.status IN ('pending', 'queued', 'running') OR t.created_at > now() - make_interval(hours => ${Math.floor(hours)}::int))
              )
            ORDER BY a.last_check_in_at DESC
            LIMIT ${SCANS_PER_SWEEP}
        `;
        const now = new Date();
        for (const row of due) {
            await this.prisma.agent_tasks.create({
                data: { agent_id: row.agent_id, type: "patch_scan", payload: { includeOptional: false, scheduled: true }, status: "queued", queued_at: now, created_by: null, created_at: now, updated_at: now },
                select: { id: true },
            });
        }
        return due.length;
    }

    @Interval(SWEEP_EVERY_MS)
    async sweepScans(): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            const queued = await this.queueDueScans();
            if (queued) this.logger.log(`Queued ${queued} scheduled patch scan(s).`);
        } catch (err) {
            this.logger.error(`Scheduled patch scans failed: ${(err as Error).message}`);
        } finally {
            this.sweeping = false;
        }
    }

    private async resolveAgentIdByDeviceId(deviceId: string): Promise<string> {
        const agent = await this.prisma.agents.findUnique({
            where: { device_id: deviceId },
            select: { id: true },
        });
        if (!agent) throw new NotFoundException("No agent is attached to this device yet.");
        return agent.id;
    }

    /**
     * Windows agents, and Linux agents new enough, run patch tasks. Anything else would leave the task waiting for ever,
     * so it is refused here with a reason the screen can show.
     */
    private async assertPatchableAgent(agentId: string): Promise<NonNullable<PatchOs>> {
        const agent = await this.prisma.agents.findUnique({
            where: { id: agentId },
            select: { version: true, facts: true, devices: { select: { operating_system: true } } },
        });
        const os = patchOs(agent?.facts, agent?.devices?.operating_system);
        if (os === "windows") return os;
        if (os === "linux") {
            const need = linuxPatchMinVersion();
            if (!agentVersionAtLeast(agent?.version, need)) {
                throw new ConflictException(`Patching a Linux device needs agent ${need} or newer. This device has ${agent?.version || "an unknown version"}; update its agent first.`);
            }
            return os;
        }
        throw new BadRequestException("Patching is available on Windows and Linux devices.");
    }

    private async enqueue(
        deviceId: string,
        type: "patch_scan" | "patch_install",
        payload: { includeOptional: boolean; ids?: string[]; mode?: "all" | "security" },
        createdBy?: string | null,
    ) {
        const agentId = await this.resolveAgentIdByDeviceId(deviceId);
        await this.assertPatchableAgent(agentId);
        const now = new Date();

        const { id } = await this.prisma.agent_tasks.create({
            data: {
                agent_id: agentId,
                type,
                payload,
                status: "queued",
                queued_at: now,
                created_by: createdBy ?? null,
                created_at: now,
                updated_at: now,
            },
            select: { id: true },
        });

        return { accepted: true as const, taskId: id };
    }

    async enqueueScan(deviceId: string, includeOptional: boolean, createdBy?: string | null) {
        return this.enqueue(deviceId, "patch_scan", { includeOptional: !!includeOptional }, createdBy);
    }

    async enqueueInstall(deviceId: string, includeOptional: boolean, ids: string[], createdBy?: string | null, mode?: "all" | "security") {
        return this.enqueue(deviceId, "patch_install", { includeOptional: !!includeOptional, ids, ...(mode ? { mode } : {}) }, createdBy);
    }

    /**
     * Installs every update, or every security update. A Linux agent works out what that is when the task runs; a
     * Windows device installs from the last scan's list, as it always has.
     */
    async enqueueInstallMode(deviceId: string, mode: "all" | "security", includeOptional: boolean, createdBy?: string | null) {
        const agentId = await this.resolveAgentIdByDeviceId(deviceId);
        const os = await this.assertPatchableAgent(agentId);
        if (os === "linux") return this.enqueueInstall(deviceId, includeOptional, [], createdBy, mode);
        const latest = await this.getLatest(deviceId);
        const ids = latest.patches
            .filter((p) => p.status === "Required" && (mode === "all" || ["critical", "important"].includes(String(p.severity ?? "").toLowerCase())))
            .map((p) => p.id);
        if (!ids.length) throw new BadRequestException(latest.lastScanAt ? "The last scan found no matching updates." : "This device has not been scanned yet. Scan it first.");
        return this.enqueueInstall(deviceId, includeOptional, ids, createdBy);
    }

    /**
     * Patch history for a device (all patch_install runs).
     * Pulls:
     * - status/timestamps from agent_task_runs
     * - installed ids + requiresReboot from:
     *    - agent_task_results.artifacts (schema-supported), OR
     *    - agent_task_runs.output.artifacts (controller merges artifacts into output), OR
     *    - agent_task_runs.output (fallback)
     * - createdByName from the user who queued the task
     */
    async getHistory(deviceId: string, limit = 200): Promise<{ ok: true; items: PatchHistoryItem[] }> {
        const runs = await this.prisma.agent_task_runs.findMany({
            where: { agent_tasks: { type: "patch_install", agents: { device_id: deviceId } } },
            include: {
                agent_task_results: { select: { artifacts: true, stderr: true } },
                agent_tasks: {
                    select: {
                        id: true,
                        agent_id: true,
                        created_by: true,
                        agents: { select: { device_id: true } },
                        users: { select: { id: true, first_name: true, last_name: true, email: true } },
                    },
                },
            },
        });

        // Prisma cannot order by COALESCE(finished_at, started_at), so sort here.
        // A device has few patch runs, and this is an on-demand page.
        const sortKey = (r: { finished_at: Date | null; started_at: Date }) => (r.finished_at ?? r.started_at).getTime();
        const rows = runs
            .sort((a, b) => sortKey(b) - sortKey(a) || b.created_at.getTime() - a.created_at.getTime())
            .slice(0, limit);

        const items: PatchHistoryItem[] = rows.map((row) => {
            const output = asObject(row.output);
            const rrArtifacts = asObject(row.agent_task_results?.artifacts);

            const installed = asStringArray(rrArtifacts?.installed ?? output?.artifacts?.installed ?? output?.installed);

            const requiresReboot = asBooleanOrNull(
                rrArtifacts?.requiresReboot ?? output?.artifacts?.requiresReboot ?? output?.requiresReboot,
            );

            const createdByName = userDisplayName(row.agent_tasks.users);

            return {
                taskId: row.agent_tasks.id,
                runId: row.id,
                agentId: row.agent_tasks.agent_id,
                deviceId: row.agent_tasks.agents.device_id,

                status: String(row.status) as PatchHistoryItem["status"],

                startedAt: row.started_at ? new Date(row.started_at).toISOString() : new Date().toISOString(),
                finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
                error: row.agent_task_results?.stderr || null,

                installed,
                requiresReboot,

                createdBy: row.agent_tasks.created_by,
                createdByName: createdByName && createdByName.trim() ? createdByName.trim() : null,
            };
        });

        return { ok: true as const, items };
    }

    /**
     * Latest patch state for a device:
     * - Base list comes from latest successful patch_scan
     * - Mark Installed if found in latest successful patch_install
     * - Mark Pending if currently queued/running patch_install includes the id
     *
     * Handles artifacts stored either:
     * - in agent_task_runs.output.artifacts (controller merges artifacts into output), OR
     * - in agent_task_results.artifacts (schema-supported)
     */
    async getLatest(deviceId: string): Promise<LatestPatchesResult> {
        const agentId = await this.resolveAgentIdByDeviceId(deviceId);

        const who = await this.prisma.agents.findUnique({ where: { id: agentId }, select: { version: true, facts: true, devices: { select: { operating_system: true } } } });
        const os = patchOs(who?.facts, who?.devices?.operating_system);
        let unsupportedReason: string | null = null;
        if (os === null) unsupportedReason = "Patching is available on Windows and Linux devices.";
        else if (os === "linux" && !agentVersionAtLeast(who?.version, linuxPatchMinVersion())) {
            unsupportedReason = `Patching a Linux device needs agent ${linuxPatchMinVersion()} or newer. This device has ${who?.version || "an unknown version"}; update its agent first.`;
        }
        const platform = { os, supported: unsupportedReason === null, unsupportedReason };

        // 1) Latest successful scan (patches list)
        const latestRun = (type: "patch_scan" | "patch_install") =>
            this.prisma.agent_task_runs.findFirst({
                where: { status: "succeeded", agent_tasks: { agent_id: agentId, type } },
                orderBy: [{ finished_at: { sort: "desc", nulls: "last" } }, { created_at: "desc" }],
                select: {
                    finished_at: true,
                    output: true,
                    agent_task_results: { select: { artifacts: true } },
                },
            });

        const scanRow = await latestRun("patch_scan");

        // A failed scan never becomes scanRow, so the most recent attempt is read separately.
        const lastScanRun = await this.prisma.agent_task_runs.findFirst({
            where: { agent_tasks: { agent_id: agentId, type: "patch_scan" } },
            orderBy: { created_at: "desc" },
            select: { status: true, agent_task_results: { select: { stderr: true } } },
        });
        const lastScan = lastScanRun
            ? { status: String(lastScanRun.status), error: lastScanRun.agent_task_results?.stderr || null }
            : null;

        const unfinished = { in: ["pending", "queued", "running"] as ("pending" | "queued" | "running")[] };
        const scanPending =
            (await this.prisma.agent_tasks.count({ where: { agent_id: agentId, type: "patch_scan", status: unfinished } })) > 0;
        const installPending =
            (await this.prisma.agent_tasks.count({ where: { agent_id: agentId, type: "patch_install", status: unfinished } })) > 0;

        // If no scan yet, return empty (but still ok)
        if (!scanRow) {
            return { ok: true, lastScanAt: null, lastScan, scanPending, installPending, patches: [], ...platform, packageManager: null, skipped: [], rebootRequired: null, rebootReason: null };
        }

        const out = asObject(scanRow.output);
        const rrArtifacts = asObject(scanRow.agent_task_results?.artifacts);

        // Prefer task_results.artifacts.patches, else output.artifacts.patches, else output.patches
        const rawPatches = Array.isArray(rrArtifacts?.patches)
            ? rrArtifacts!.patches
            : Array.isArray(out?.artifacts?.patches)
                ? out!.artifacts.patches
                : Array.isArray(out?.patches)
                    ? out!.patches
                    : [];

        const base: PatchRow[] = rawPatches
            .map((p: any, i: number) => ({
                id: String(p?.id ?? `patch-${i}`),
                title: String(p?.title ?? ""),
                severity: p?.severity == null ? null : String(p.severity),
                requiresReboot: !!p?.requiresReboot,
                kbIds: Array.isArray(p?.kbIds) ? p.kbIds.map((x: any) => String(x)) : [],
                status: "Required" as const,
                ...(typeof p?.security === "boolean" ? { security: p.security } : {}),
                ...(p?.current !== undefined || p?.available !== undefined ? { name: p?.name == null ? null : String(p.name), current: p?.current == null ? null : String(p.current), available: p?.available == null ? null : String(p.available), source: p?.source == null ? null : String(p.source) } : {}),
            }))
            .filter((p: PatchRow) => !!p.id);

        // 2) Latest successful install (installed ids)
        const installRow = await latestRun("patch_install");
        const installOut = asObject(installRow?.output);
        const installArtifacts = asObject(installRow?.agent_task_results?.artifacts);

        // Linux package names come back every month, so an install only counts for a scan that is older than it.
        const installCounts = os !== "linux" || (!!installRow?.finished_at && !!scanRow.finished_at && installRow.finished_at > scanRow.finished_at);
        const installNewer = !!installRow?.finished_at && !!scanRow.finished_at && installRow.finished_at > scanRow.finished_at;
        const installedIds = new Set(
            installCounts
                ? asStringArray(installArtifacts?.installed ?? installOut?.artifacts?.installed ?? installOut?.installed).map((s) => s.toLowerCase())
                : [],
        );
        // On Linux every install since the scan counts, not only the newest: installing one package at a time (or a package that pulls in
        // others) leaves the earlier ones installed too. A new scan replaces all of this with what the device really says.
        if (os === "linux" && scanRow.finished_at) {
            const since = await this.prisma.agent_task_runs.findMany({
                where: { status: "succeeded", finished_at: { gt: scanRow.finished_at }, agent_tasks: { agent_id: agentId, type: "patch_install" } },
                select: { output: true, agent_task_results: { select: { artifacts: true } } },
                take: 200,
            });
            for (const r of since) {
                const a = asObject(r.agent_task_results?.artifacts);
                const o = asObject(r.output);
                for (const id of asStringArray(a?.installed ?? o?.artifacts?.installed ?? o?.installed)) installedIds.add(id.toLowerCase());
            }
        }

        // 3) Any queued/running install payload ids => Pending
        const pendingTasks = await this.prisma.agent_tasks.findMany({
            where: {
                agent_id: agentId,
                type: "patch_install",
                status: { in: ["pending", "queued", "running"] },
            },
            select: { payload: true },
        });

        const pendingIds = new Set(
            pendingTasks
                .flatMap((task) => asStringArray((task.payload as any)?.ids))
                .map((s) => s.toLowerCase()),
        );

        // Apply status overlays: Installed > Pending > Required
        const patches = base.map((p) => {
            const key = p.id.toLowerCase();
            if (installedIds.has(key)) return { ...p, status: "Installed" as const };
            if (pendingIds.has(key)) return { ...p, status: "Pending" as const };
            return p;
        });

        return {
            ok: true,
            lastScanAt: scanRow.finished_at?.toISOString() ?? null,
            lastScan,
            scanPending,
            installPending,
            patches,
            ...platform,
            packageManager: typeof (rrArtifacts?.packageManager ?? out?.artifacts?.packageManager) === "string" ? String(rrArtifacts?.packageManager ?? out?.artifacts?.packageManager) : null,
            skipped: (Array.isArray(rrArtifacts?.skipped) ? rrArtifacts!.skipped : Array.isArray(out?.artifacts?.skipped) ? out!.artifacts.skipped : [])
                .map((s: any) => ({ id: String(s?.id ?? ""), reason: String(s?.reason ?? "") }))
                .filter((s: { id: string }) => !!s.id),
            // An install that finished after the scan knows better whether a restart is now needed.
            rebootRequired: installNewer && asBooleanOrNull(installArtifacts?.requiresReboot ?? installOut?.artifacts?.requiresReboot) !== null
                ? asBooleanOrNull(installArtifacts?.requiresReboot ?? installOut?.artifacts?.requiresReboot)
                : asBooleanOrNull(rrArtifacts?.rebootRequired ?? out?.artifacts?.rebootRequired),
            rebootReason: installNewer ? null : (rrArtifacts?.rebootReason ?? out?.artifacts?.rebootReason) == null ? null : String(rrArtifacts?.rebootReason ?? out?.artifacts?.rebootReason),
        };
    }
}
