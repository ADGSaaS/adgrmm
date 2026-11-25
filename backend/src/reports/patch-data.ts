// backend/src/reports/patch-data.ts
//
// What the patch reports know about each device, taken from the scans and installs the agent has already run.
// A scan's answer is kept with its task run, so nothing new is stored: the latest successful scan says what was
// missing then, and installs finished since then take patches off that list.
import { PrismaService } from "../storage/prisma.service";

export type PatchItem = { id: string; title: string; severity: string | null; requiresReboot: boolean; kbIds: string[]; /** Linux: flagged as a security update by the distribution. */ security?: boolean };

export type AgentPatchState = {
    agentId: string;
    /** When the latest successful scan finished, or null if there has never been one. */
    scannedAt: Date | null;
    /** What that scan found missing, less what has been installed since. */
    missing: PatchItem[];
    /** The most recent scan attempt, whether or not it worked. */
    lastAttempt: { status: string; at: Date | null } | null;
    lastInstallAt: Date | null;
};

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** The agent's answer can sit in the task result's artifacts or in the run's output, depending on how it was sent. */
export function readPatches(output: unknown, artifacts: unknown): PatchItem[] {
    const a = obj(artifacts);
    const o = obj(output);
    const raw = Array.isArray(a?.patches) ? a!.patches : Array.isArray(o?.artifacts?.patches) ? o!.artifacts.patches : Array.isArray(o?.patches) ? o!.patches : [];
    return raw
        .map((p: any, i: number): PatchItem => ({
            id: String(p?.id ?? `patch-${i}`),
            title: String(p?.title ?? ""),
            severity: p?.severity == null || String(p.severity).trim() === "" ? null : String(p.severity).trim(),
            requiresReboot: p?.requiresReboot === true,
            kbIds: strings(p?.kbIds),
            ...(typeof p?.security === "boolean" ? { security: p.security } : {}),
        }))
        .filter((p: PatchItem) => !!p.id);
}

export function readInstalled(output: unknown, artifacts: unknown): string[] {
    const a = obj(artifacts);
    const o = obj(output);
    return strings(a?.installed ?? o?.artifacts?.installed ?? o?.installed);
}

export function readRequiresReboot(output: unknown, artifacts: unknown): boolean | null {
    const a = obj(artifacts);
    const o = obj(output);
    const v = a?.requiresReboot ?? o?.artifacts?.requiresReboot ?? o?.requiresReboot;
    return v === true ? true : v === false ? false : null;
}

type ScanRow = { agent_id: string; finished_at: Date | null; output: unknown; artifacts: unknown };
type AttemptRow = { agent_id: string; status: string; at: Date | null };
type InstallRow = { agent_id: string; finished_at: Date | null; output: unknown; artifacts: unknown };

export async function loadPatchState(prisma: PrismaService, agentIds: string[]): Promise<Map<string, AgentPatchState>> {
    const states = new Map<string, AgentPatchState>();
    for (const id of agentIds) states.set(id, { agentId: id, scannedAt: null, missing: [], lastAttempt: null, lastInstallAt: null });
    if (!agentIds.length) return states;

    const scans = await prisma.$queryRaw<ScanRow[]>`
        SELECT DISTINCT ON (t.agent_id) t.agent_id::text AS agent_id, r.finished_at, r.output, res.artifacts
        FROM public.agent_task_runs r
        JOIN public.agent_tasks t ON t.id = r.task_id
        LEFT JOIN public.agent_task_results res ON res.run_id = r.id
        WHERE r.status = 'succeeded' AND t.type = 'patch_scan' AND t.agent_id = ANY(${agentIds}::uuid[])
        ORDER BY t.agent_id, r.finished_at DESC NULLS LAST, r.created_at DESC
    `;
    const attempts = await prisma.$queryRaw<AttemptRow[]>`
        SELECT DISTINCT ON (t.agent_id) t.agent_id::text AS agent_id, r.status::text AS status, COALESCE(r.finished_at, r.started_at) AS at
        FROM public.agent_task_runs r
        JOIN public.agent_tasks t ON t.id = r.task_id
        WHERE t.type = 'patch_scan' AND t.agent_id = ANY(${agentIds}::uuid[])
        ORDER BY t.agent_id, r.created_at DESC
    `;
    // Installs are few, and only those after a device's last scan can change what its scan said.
    const installs = await prisma.$queryRaw<InstallRow[]>`
        SELECT t.agent_id::text AS agent_id, r.finished_at, r.output, res.artifacts
        FROM public.agent_task_runs r
        JOIN public.agent_tasks t ON t.id = r.task_id
        LEFT JOIN public.agent_task_results res ON res.run_id = r.id
        WHERE r.status = 'succeeded' AND t.type = 'patch_install' AND t.agent_id = ANY(${agentIds}::uuid[])
          AND r.finished_at > now() - interval '90 days'
        ORDER BY r.finished_at DESC
    `;

    for (const s of scans) {
        const state = states.get(s.agent_id);
        if (!state) continue;
        state.scannedAt = s.finished_at;
        state.missing = readPatches(s.output, s.artifacts);
    }
    for (const a of attempts) {
        const state = states.get(a.agent_id);
        if (state) state.lastAttempt = { status: a.status, at: a.at };
    }
    for (const i of installs) {
        const state = states.get(i.agent_id);
        if (!state || !i.finished_at) continue;
        if (!state.lastInstallAt || i.finished_at > state.lastInstallAt) state.lastInstallAt = i.finished_at;
        // An install that finished after the scan has already dealt with what it installed.
        if (state.scannedAt && i.finished_at > state.scannedAt) {
            const done = new Set(readInstalled(i.output, i.artifacts).map((x) => x.toLowerCase()));
            if (done.size) state.missing = state.missing.filter((p) => !done.has(p.id.toLowerCase()) && !p.kbIds.some((k) => done.has(k.toLowerCase()) || done.has(`kb${k}`.toLowerCase())));
        }
    }
    return states;
}

/** Microsoft's own words for how serious an update is. Anything else, or nothing, is "Other". */
export function severityRank(severity: string | null): "Critical" | "Important" | "Other" {
    const s = (severity ?? "").toLowerCase();
    return s === "critical" ? "Critical" : s === "important" ? "Important" : "Other";
}
