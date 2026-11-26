// backend/src/patches/patch-automation.service.ts
//
// Installs updates and restarts devices on their own, as the policies that reach each device say, inside the
// maintenance windows they set. It only uses what already exists: the patch scan the agent reports, the install task
// the agent already understands, and the restart job. Nothing here needs a new agent.
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";
import { JobsService } from "../jobs/jobs.service";
import { PoliciesService } from "../policies/policies.service";
import { activeWindow } from "../policies/time-window";
import type { Effective } from "../policies/policy-engine";
import { PatchesService, type PatchRow } from "./patches.service";
import { canPatch, patchOs } from "./linux-patching";

const SWEEP_EVERY_MS = 5 * 60_000;
const ONLINE_WITHIN_MS = 10 * 60_000;
/** A device is not given another automatic install this soon after the last, so a failing one cannot loop. */
const INSTALL_COOLDOWN_MS = 4 * 3_600_000;
/** Nor another restart. */
const REBOOT_COOLDOWN_MS = 6 * 3_600_000;
/** A restart is not requested while an install that was just queued may still be running. */
const MAX_PER_SWEEP = 25;
const DEVICE_LIMIT = 2000;


/**
 * Windows rates updates Critical, Important, Moderate or Low, and some have no rating; "critical" approves the first two.
 * Linux flags updates as security or not, and "critical" (shown as security on Linux) approves every security update.
 */
export function approved(patch: Pick<PatchRow, "severity" | "status"> & { security?: boolean }, level: "none" | "critical" | "all"): boolean {
    if (level === "none" || patch.status !== "Required") return false;
    if (level === "all") return true;
    if (patch.security === true) return true;
    const s = String(patch.severity ?? "").toLowerCase();
    return s === "critical" || s === "important";
}

@Injectable()
export class PatchAutomationService {
    private readonly logger = new Logger(PatchAutomationService.name);
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly policies: PoliciesService,
        private readonly patches: PatchesService,
        private readonly jobs: JobsService,
    ) { }

    @Interval(SWEEP_EVERY_MS)
    async sweep(): Promise<void> {
        if (this.running || process.env.PATCH_AUTOMATION_ENABLED === "false") return;
        this.running = true;
        try {
            const r = await this.run();
            if (r.installs || r.reboots) this.logger.log(`Policies started ${r.installs} update install(s) and ${r.reboots} restart(s).`);
        } catch (err) {
            this.logger.error(`Automatic patching failed: ${(err as Error).message}`);
        } finally {
            this.running = false;
        }
    }

    private async recently(deviceId: string, kind: string, ms: number): Promise<boolean> {
        return (await this.prisma.policy_actions.count({ where: { device_id: deviceId, kind, created_at: { gt: new Date(Date.now() - ms) } } })) > 0;
    }

    private sourceName(e: Effective, key: "patching.approve" | "patching.installIn" | "patching.reboot"): { id: string | null; name: string | null } {
        const s = e.scalars[key]?.source;
        return s?.kind === "policy" ? { id: s.policyId, name: s.name } : { id: null, name: null };
    }

    /** One pass over the Windows and Linux devices that are online. Returns what was started. */
    async run(now = Date.now()): Promise<{ installs: number; reboots: number }> {
        const found = await this.prisma.$queryRaw<Array<{ agent_id: string; device_id: string; pending: boolean | null; facts_os: string | null; os_name: string | null; version: string | null }>>`
            SELECT a.id::text AS agent_id, a.device_id::text AS device_id, a.facts->>'os' AS facts_os, d.operating_system AS os_name, a.version AS version,
                   CASE WHEN a.facts->'device'->'boot'->>'pendingReboot' IN ('true','false') THEN (a.facts->'device'->'boot'->>'pendingReboot')::boolean END AS pending
              FROM public.agents a
              JOIN public.devices d ON d.id = a.device_id
             WHERE a.last_check_in_at > ${new Date(now - ONLINE_WITHIN_MS)}
             ORDER BY a.last_check_in_at DESC
             LIMIT ${DEVICE_LIMIT}`;
        // Windows devices, and Linux devices whose agent runs patch tasks. Anything else cannot be patched from here.
        const osOf = new Map<string, "windows" | "linux">();
        const rows = found.filter((r) => {
            const os = patchOs({ os: r.facts_os }, r.os_name);
            if (!os || !canPatch(os, r.version)) return false;
            osOf.set(r.device_id, os);
            return true;
        });
        if (!rows.length) return { installs: 0, reboots: 0 };

        const effective = await this.policies.effectiveForDevices(rows.map((r) => r.device_id));
        const orgs = await this.deviceOrgs(rows.map((r) => r.device_id));
        let installs = 0;
        let reboots = 0;

        for (const row of rows) {
            const e = effective.get(row.device_id);
            if (!e) continue;
            const approve = (e.scalars["patching.approve"]?.value ?? "none") as "none" | "critical" | "all";
            const installIn = (e.scalars["patching.installIn"]?.value ?? "anytime") as "anytime" | "maintenance";
            const reboot = (e.scalars["patching.reboot"]?.value ?? "never") as "never" | "maintenance" | "always";
            if (approve === "none" && reboot === "never") continue;

            const m = e.scalars.maintenance?.value as { windows: { name: string; days: number[]; start: string; end: string; timezone: string }[] } | undefined;
            const inWindow = !!m && !!activeWindow(m.windows, now);
            const organizationId = orgs.get(row.device_id);
            if (!organizationId) continue;

            const busy = (await this.prisma.agent_tasks.count({ where: { agent_id: row.agent_id, type: "patch_install", status: { in: ["pending", "queued", "running"] } } })) > 0;

            if (approve !== "none" && !busy && installs < MAX_PER_SWEEP && (installIn === "anytime" || inWindow) && !(await this.recently(row.device_id, "patch_install", INSTALL_COOLDOWN_MS))) {
                const latest = await this.patches.getLatest(row.device_id).catch(() => null);
                const ids = (latest?.patches ?? []).filter((p) => approved(p, approve)).map((p) => p.id);
                if (ids.length) {
                    await this.patches.enqueueInstall(row.device_id, false, ids, null);
                    const src = this.sourceName(e, "patching.approve");
                    await this.prisma.policy_actions.create({
                        data: { organization_id: organizationId, device_id: row.device_id, policy_id: src.id, policy_name: src.name, kind: "patch_install", detail: { count: ids.length, ids: ids.slice(0, 50), approve, inWindow } },
                    });
                    installs++;
                    continue;
                }
            }

            // A restart waits for installs to finish, then happens when the policy says: inside a window, or straight away.
            if (reboot !== "never" && row.pending === true && !busy && reboots < MAX_PER_SWEEP && (reboot === "always" || inWindow) && !(await this.recently(row.device_id, "reboot", REBOOT_COOLDOWN_MS))) {
                const linux = osOf.get(row.device_id) === "linux";
                await this.jobs.createRunScriptJob({
                    agentId: row.agent_id,
                    language: linux ? "bash" : "powershell",
                    scriptText: linux
                        ? 'shutdown -r +2 "ADG RMM: restarting to finish installing updates" >/dev/null 2>&1 &'
                        : 'shutdown.exe /r /t 120 /c "ADG RMM: restarting to finish installing updates"',
                    timeoutSec: 60,
                } as any);
                const src = this.sourceName(e, "patching.reboot");
                await this.prisma.policy_actions.create({
                    data: { organization_id: organizationId, device_id: row.device_id, policy_id: src.id, policy_name: src.name, kind: "reboot", detail: { when: reboot, inWindow } },
                });
                reboots++;
            }
        }
        return { installs, reboots };
    }

    private async deviceOrgs(ids: string[]): Promise<Map<string, string>> {
        const rows = await this.prisma.devices.findMany({ where: { id: { in: ids } }, select: { id: true, sites: { select: { clients: { select: { organization_id: true } } } } } });
        return new Map(rows.flatMap((d) => (d.sites?.clients?.organization_id ? [[d.id, d.sites.clients.organization_id] as const] : [])));
    }
}
