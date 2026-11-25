// backend/src/software-updates/ingest.ts
//
// What a finished agent task does to the outdated-software tables. Called when an agent completes a task:
//  - software_updates_scan: the programs it found replace what was stored for each tool that answered.
//  - software_install with action "upgrade": when it succeeded and was confirmed, that program is no longer outdated.
// Nothing here may break completing the task, so callers catch whatever it throws.
import type { PrismaService } from "../storage/prisma.service";
import { CHOCO_ID, WINGET_ID, isSource } from "./update-rules";

const MAX_APPS = 2000;
const STATES = new Set(["ok", "missing", "failed", "timeout", "skipped"]);

type Clean = { source: string; id: string; name: string; installed: string | null; available: string; approximate: boolean };

const str = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null;
    const s = v.replace(/[\u0000-\u001f]/g, " ").trim();
    return s ? s.slice(0, max) : null;
};

/** The programs of an agent's scan, checked: an agent is trusted to be one of ours, not to send well-formed data. */
export function cleanApps(raw: unknown): Clean[] {
    if (!Array.isArray(raw)) return [];
    const out: Clean[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
        if (out.length >= MAX_APPS) break;
        if (!r || typeof r !== "object") continue;
        const o = r as Record<string, unknown>;
        const source = str(o.source, 20);
        const id = str(o.id, 100);
        const available = str(o.availableVersion, 100);
        if (!source || !isSource(source) || !id || !available) continue;
        if (!(source === "winget" ? WINGET_ID.test(id) : CHOCO_ID.test(id))) continue;
        const key = `${source}\u0001${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ source, id, name: str(o.name, 200) ?? id, installed: str(o.installedVersion, 100), available, approximate: o.approximate === true });
    }
    return out;
}

const state = (v: unknown): string | null => {
    const s = v && typeof v === "object" ? (v as Record<string, unknown>).state : null;
    return typeof s === "string" && STATES.has(s) ? s : null;
};

export type ScanOutcome = { replaced: string[]; apps: number; ok: boolean };

export async function ingestScan(
    prisma: PrismaService,
    args: { agentId: string; status: string; output: unknown; artifacts: unknown; stderr: string | null },
): Promise<ScanOutcome> {
    const out = (args.output && typeof args.output === "object" ? args.output : {}) as Record<string, unknown>;
    // The completion route keeps what the agent sent as artifacts inside the output (the run has no separate column for them).
    const sent = args.artifacts && typeof args.artifacts === "object" ? args.artifacts : out.artifacts;
    const art = (sent && typeof sent === "object" ? sent : {}) as Record<string, unknown>;
    const wingetState = state(art.winget);
    const chocoState = state(art.chocolatey);
    const apps = cleanApps(art.apps);
    const ok = args.status === "succeeded";
    const message = str(out.message, 500) ?? str(args.stderr, 500);
    const now = new Date();

    // A tool that answered replaces what we had for it. A tool that is gone has nothing outdated to report. One that
    // failed or timed out says nothing, so the last answer stays (the scan row says it is out of date).
    const replaced = ([["winget", wingetState], ["chocolatey", chocoState]] as const).filter(([, s]) => s === "ok" || s === "missing").map(([src]) => src);

    await prisma.$transaction(async (tx) => {
        for (const source of replaced) {
            const mine = apps.filter((a) => a.source === source);
            if (mine.length) {
                await tx.$executeRaw`
                    INSERT INTO public.agent_outdated_software (agent_id, source, app_id, name, installed_version, available_version, approximate, first_seen_at, scanned_at)
                    SELECT ${args.agentId}::uuid, ${source}::text, u.id, u.name, u.installed, u.available, u.approx, ${now}::timestamptz, ${now}::timestamptz
                      FROM unnest(${mine.map((a) => a.id)}::text[], ${mine.map((a) => a.name)}::text[], ${mine.map((a) => a.installed)}::text[], ${mine.map((a) => a.available)}::text[], ${mine.map((a) => a.approximate)}::boolean[])
                           AS u(id, name, installed, available, approx)
                    ON CONFLICT (agent_id, source, app_id) DO UPDATE
                       SET name = EXCLUDED.name, installed_version = EXCLUDED.installed_version, available_version = EXCLUDED.available_version,
                           approximate = EXCLUDED.approximate, scanned_at = EXCLUDED.scanned_at`;
                await tx.$executeRaw`DELETE FROM public.agent_outdated_software WHERE agent_id = ${args.agentId}::uuid AND source = ${source} AND NOT (app_id = ANY(${mine.map((a) => a.id)}::text[]))`;
            } else {
                await tx.$executeRaw`DELETE FROM public.agent_outdated_software WHERE agent_id = ${args.agentId}::uuid AND source = ${source}`;
            }
        }
        const total = (await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.agent_outdated_software WHERE agent_id = ${args.agentId}::uuid`)[0]?.n ?? 0;
        // "ok" means at least one tool answered; scanned_at is when that last happened
        const answered = replaced.some((s) => (s === "winget" ? wingetState : chocoState) === "ok");
        await tx.$executeRaw`
            INSERT INTO public.agent_software_scans (agent_id, attempted_at, scanned_at, ok, winget_state, choco_state, message, app_count)
            VALUES (${args.agentId}::uuid, ${now}::timestamptz, ${answered ? now : null}::timestamptz, ${ok && answered}::boolean, ${wingetState}::text, ${chocoState}::text, ${message}::text, ${total}::int)
            ON CONFLICT (agent_id) DO UPDATE
               SET attempted_at = EXCLUDED.attempted_at, scanned_at = COALESCE(EXCLUDED.scanned_at, agent_software_scans.scanned_at),
                   ok = EXCLUDED.ok, winget_state = EXCLUDED.winget_state, choco_state = EXCLUDED.choco_state, message = EXCLUDED.message, app_count = EXCLUDED.app_count`;
    });
    return { replaced: [...replaced], apps: apps.length, ok };
}

/** A confirmed upgrade: the program is no longer outdated on that device. */
export async function ingestUpgrade(
    prisma: PrismaService,
    args: { agentId: string; status: string; payload: unknown; output: unknown },
): Promise<boolean> {
    const p = (args.payload && typeof args.payload === "object" ? args.payload : {}) as Record<string, unknown>;
    const out = (args.output && typeof args.output === "object" ? args.output : {}) as Record<string, unknown>;
    if (args.status !== "succeeded" || p.action !== "upgrade" || out.ok !== true || out.verified !== true) return false;
    const source = p.method === "chocolatey" ? "chocolatey" : p.method === "winget" ? "winget" : null;
    const id = source === "chocolatey" ? str(p.chocolateyId, 100) : str(p.wingetId, 100);
    if (!source || !id) return false;
    await prisma.$executeRaw`DELETE FROM public.agent_outdated_software WHERE agent_id = ${args.agentId}::uuid AND source = ${source} AND lower(app_id) = lower(${id})`;
    return true;
}
