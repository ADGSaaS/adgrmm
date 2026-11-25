// backend/src/software-updates/software-updates-automation.service.ts
//
// Scans devices for outdated programs and updates them on their own, as the policies that reach each device say, inside
// the maintenance windows they set. Like automatic patching it only uses what already exists: the scan and upgrade
// tasks the agent knows, and the maintenance windows. A restart is never forced: the agent asks winget and Chocolatey
// not to restart, and a program that needs one says so in the install log.
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";
import { PoliciesService } from "../policies/policies.service";
import { activeWindow } from "../policies/time-window";
import { SoftwareUpdatesService } from "./software-updates.service";
import { AutoMode, UpdateRule, appKey, autoDecision, displayName, versionAtLeast, UPDATES_MIN_VERSION } from "./update-rules";

const SWEEP_EVERY_MS = 5 * 60_000;
const ONLINE_WITHIN_MS = 10 * 60_000;
const DEVICE_LIMIT = 2000;
const SCANS_PER_SWEEP = 50;
const DEVICES_PER_SWEEP = 25;
/** Updates queued for one device in one pass: the agent runs them one at a time, each can take minutes. */
const APPS_PER_DEVICE = 10;
/** A program that was tried (and failed, or is not fixed by updating) is not tried again by a policy for this long. */
const APP_COOLDOWN_MS = 24 * 3_600_000;
/** A scan older than this is not trusted to say what is outdated. */
const SCAN_FRESH_MS = 7 * 86_400_000;

@Injectable()
export class SoftwareUpdatesAutomationService {
    private readonly logger = new Logger(SoftwareUpdatesAutomationService.name);
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly policies: PoliciesService,
        private readonly updates: SoftwareUpdatesService,
    ) { }

    @Interval(SWEEP_EVERY_MS)
    async sweep(): Promise<void> {
        if (this.running || process.env.SOFTWARE_UPDATES_AUTOMATION_ENABLED === "false") return;
        this.running = true;
        try {
            const r = await this.run();
            if (r.scans || r.updates) this.logger.log(`Policies queued ${r.scans} outdated-program scan(s) and ${r.updates} program update(s).`);
        } catch (err) {
            this.logger.error(`Automatic program updates failed: ${(err as Error).message}`);
        } finally {
            this.running = false;
        }
    }

    /** One pass over the Windows devices that are online. Returns what was started. */
    async run(now = Date.now()): Promise<{ scans: number; updates: number; devices: number }> {
        const rows = await this.prisma.$queryRaw<Array<{ agent_id: string; device_id: string; version: string; client_id: string | null }>>`
            SELECT a.id::text AS agent_id, a.device_id::text AS device_id, a.version, st.client_id::text AS client_id
              FROM public.agents a
              JOIN public.devices d ON d.id = a.device_id
              LEFT JOIN public.sites st ON st.id = d.site_id
             WHERE (lower(COALESCE(a.facts->>'os', '')) = 'windows' OR lower(COALESCE(d.operating_system, '')) LIKE 'windows%')
               AND a.last_check_in_at > ${new Date(now - ONLINE_WITHIN_MS)}
             ORDER BY a.last_check_in_at DESC
             LIMIT ${DEVICE_LIMIT}`;
        const capable = rows.filter((r) => versionAtLeast(r.version, UPDATES_MIN_VERSION));
        if (!capable.length) return { scans: 0, updates: 0, devices: 0 };

        const effective = await this.policies.effectiveForDevices(capable.map((r) => r.device_id));
        const orgs = await this.deviceOrgs(capable.map((r) => r.device_id));

        const wantsUpdates = capable.filter((r) => {
            const e = effective.get(r.device_id);
            return !!e && String(e.scalars["patching.appUpdate"]?.value ?? "none") !== "none";
        });
        const agentIds = wantsUpdates.map((r) => r.agent_id);
        const [outdated, scans, recentUpgrades, queuedUpgrades] = agentIds.length
            ? await Promise.all([
                this.prisma.agent_outdated_software.findMany({ where: { agent_id: { in: agentIds } }, orderBy: { name: "asc" } }),
                this.prisma.agent_software_scans.findMany({ where: { agent_id: { in: agentIds } } }),
                this.prisma.agent_tasks.findMany({ where: { agent_id: { in: agentIds }, type: "software_install", created_by: null, created_at: { gt: new Date(now - APP_COOLDOWN_MS) } }, select: { agent_id: true, payload: true } }),
                this.prisma.agent_tasks.findMany({ where: { agent_id: { in: agentIds }, type: "software_install", status: { in: ["pending", "queued", "running"] } }, select: { agent_id: true, payload: true } }),
            ])
            : [[], [], [], []];
        const rulesByOrg = new Map<string, UpdateRule[]>();
        const rulesFor = async (orgId: string) => {
            if (!rulesByOrg.has(orgId)) rulesByOrg.set(orgId, await this.updates.loadRules(orgId));
            return rulesByOrg.get(orgId)!;
        };
        const scanOf = new Map(scans.map((s) => [s.agent_id, s]));
        const tried = new Set(recentUpgrades.filter((t) => (t.payload as any)?.action === "upgrade").map((t) => `${t.agent_id}\u0001${appKey(String((t.payload as any).method), String((t.payload as any).wingetId ?? (t.payload as any).chocolateyId ?? ""))}`));
        const waiting = new Set(queuedUpgrades.filter((t) => (t.payload as any)?.action === "upgrade").map((t) => `${t.agent_id}\u0001${appKey(String((t.payload as any).method), String((t.payload as any).wingetId ?? (t.payload as any).chocolateyId ?? ""))}`));

        let scanCount = 0;
        let updateCount = 0;
        let deviceCount = 0;

        // scans first: an up-to-date list is what updates are chosen from
        const scanRows = capable.filter((r) => Number(effective.get(r.device_id)?.scalars["patching.appScanHours"]?.value ?? 0) > 0);
        if (scanRows.length) {
            const ids = scanRows.map((r) => r.agent_id);
            const recent = await this.prisma.agent_tasks.findMany({
                where: { agent_id: { in: ids }, type: "software_updates_scan", OR: [{ status: { in: ["pending", "queued", "running"] } }, { created_at: { gt: new Date(now - 720 * 3_600_000) } }] },
                orderBy: { created_at: "desc" }, select: { agent_id: true, status: true, created_at: true },
            });
            for (const r of scanRows) {
                if (scanCount >= SCANS_PER_SWEEP) break;
                const hours = Number(effective.get(r.device_id)?.scalars["patching.appScanHours"]?.value ?? 0);
                const mine = recent.filter((t) => t.agent_id === r.agent_id);
                if (mine.some((t) => ["pending", "queued", "running"].includes(t.status))) continue;
                const last = mine[0]?.created_at.getTime() ?? 0;
                if (now - last < hours * 3_600_000) continue;
                const at = new Date(now);
                await this.prisma.agent_tasks.create({ data: { agent_id: r.agent_id, type: "software_updates_scan", payload: { scheduled: true } as any, status: "queued", queued_at: at, created_by: null, created_at: at, updated_at: at }, select: { id: true } });
                scanCount++;
            }
        }

        for (const r of wantsUpdates) {
            if (deviceCount >= DEVICES_PER_SWEEP) break;
            const e = effective.get(r.device_id);
            if (!e) continue;
            const mode = String(e.scalars["patching.appUpdate"]?.value ?? "none") as AutoMode;
            const when = String(e.scalars["patching.appUpdateIn"]?.value ?? "anytime");
            const m = e.scalars.maintenance?.value as { windows: { name: string; days: number[]; start: string; end: string; timezone: string }[] } | undefined;
            const inWindow = !!m && !!activeWindow(m.windows, now);
            if (when === "maintenance" && !inWindow) continue;
            const organizationId = orgs.get(r.device_id);
            if (!organizationId) continue;
            const scan = scanOf.get(r.agent_id);
            if (!scan?.scanned_at || now - scan.scanned_at.getTime() > SCAN_FRESH_MS) continue;

            const rules = await rulesFor(organizationId);
            const chosen: Array<{ source: string; appId: string; name: string; from: string | null; to: string }> = [];
            for (const o of outdated.filter((x) => x.agent_id === r.agent_id)) {
                if (chosen.length >= APPS_PER_DEVICE) break;
                const key = `${r.agent_id}\u0001${appKey(o.source, o.app_id)}`;
                if (tried.has(key) || waiting.has(key)) continue;
                if (o.approximate) continue; // only an upper bound of the installed version is known: could be up to date already
                if (!autoDecision(mode, rules, r.client_id, o.source, o.app_id).update) continue;
                chosen.push({ source: o.source, appId: o.app_id, name: o.name, from: o.installed_version, to: o.available_version });
            }
            if (!chosen.length) continue;

            const at = new Date(now);
            await this.prisma.agent_tasks.createMany({
                data: chosen.map((u) => ({ agent_id: r.agent_id, type: "software_install" as const, payload: SoftwareUpdatesService.payloadFor(u) as any, status: "queued" as const, queued_at: at, created_by: null, created_at: at, updated_at: at })),
            });
            const s = e.scalars["patching.appUpdate"]?.source;
            await this.prisma.policy_actions.create({
                data: {
                    organization_id: organizationId, device_id: r.device_id, policy_id: s?.kind === "policy" ? s.policyId : null, policy_name: s?.kind === "policy" ? s.name : null, kind: "software_update",
                    detail: { count: chosen.length, mode, inWindow, apps: chosen.slice(0, 20).map((u) => ({ id: u.appId, name: displayName(u.name, u.from), from: u.from, to: u.to })) },
                },
            });
            updateCount += chosen.length;
            deviceCount++;
        }
        return { scans: scanCount, updates: updateCount, devices: deviceCount };
    }

    private async deviceOrgs(ids: string[]): Promise<Map<string, string>> {
        const rows = await this.prisma.devices.findMany({ where: { id: { in: ids } }, select: { id: true, sites: { select: { clients: { select: { organization_id: true } } } } } });
        return new Map(rows.flatMap((d) => (d.sites?.clients?.organization_id ? [[d.id, d.sites.clients.organization_id] as const] : [])));
    }
}
