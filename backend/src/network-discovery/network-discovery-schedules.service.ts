// Scheduled network discovery: a schedule per customer site. Every minute the server looks for schedules that are due and starts a scan
// from an online Windows or Linux device of the site (the preferred one when it is online). A scan that cannot be started (no device is
// online, a scan is still running) is tried again a minute later and says why on the schedule. Nothing here scans faster than the
// interval, and a person limited to some customers sees and changes only the schedules of their own sites.
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { checkRanges } from "./discovery.scripts";
import { NetworkDiscoveryService } from "./network-discovery.service";

const MAX_PER_TICK = 20;
export const INTERVALS_HOURS = [1, 6, 12, 24, 48, 168];

export type ScheduleInput = { enabled?: boolean; intervalHours?: number; ranges?: unknown; scannerDeviceId?: string | null; alertNew?: boolean };

type Row = {
    site_id: string; enabled: boolean; interval_hours: number; ranges: string[]; scanner_device_id: string | null; alert_new: boolean;
    last_requested_at: Date | null; last_message: string | null; site_name: string | null; client_id: string | null; client_name: string | null; scanner_name: string | null;
};

@Injectable()
export class NetworkDiscoverySchedulesService {
    private readonly logger = new Logger(NetworkDiscoverySchedulesService.name);
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly discovery: NetworkDiscoveryService,
    ) { }

    private shape(r: Row) {
        const next = r.enabled ? new Date((r.last_requested_at?.getTime() ?? Date.now()) + r.interval_hours * 3_600_000) : null;
        return {
            siteId: r.site_id, site: r.site_name, clientId: r.client_id, customer: r.client_name, enabled: r.enabled, intervalHours: r.interval_hours, ranges: r.ranges,
            scannerDeviceId: r.scanner_device_id, scannerName: r.scanner_name, alertNew: r.alert_new,
            lastRequestedAt: r.last_requested_at?.toISOString() ?? null, nextDueAt: next ? (next.getTime() < Date.now() ? "due now" : next.toISOString()) : null, message: r.last_message,
        };
    }

    async list(userId: string | null) {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.access.scopeFor(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`];
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`s.site_id::text`, id: Prisma.sql`s.scanner_device_id::text` }));
        const rows = await this.prisma.$queryRaw<Row[]>`
            SELECT s.site_id::text AS site_id, s.enabled, s.interval_hours, s.ranges, s.scanner_device_id::text AS scanner_device_id, s.alert_new, s.last_requested_at, s.last_message,
                   st.name AS site_name, c.id::text AS client_id, c.name AS client_name, COALESCE(d.alias, d.hostname) AS scanner_name
              FROM public.network_discovery_schedules s
              JOIN public.sites st ON st.id = s.site_id JOIN public.clients c ON c.id = st.client_id LEFT JOIN public.devices d ON d.id = s.scanner_device_id
             WHERE ${Prisma.join(conds, " AND ")} ORDER BY c.name, st.name`;
        return { items: rows.map((r) => this.shape(r)) };
    }

    async save(userId: string | null, siteId: string, input: ScheduleInput) {
        if (!isCanonicalUuid(siteId)) throw new NotFoundException("Site not found");
        const scope = await this.access.scopeFor(userId);
        if (!(await this.access.canSeeSite(scope, siteId)) || !(await this.prisma.sites.findUnique({ where: { id: siteId }, select: { id: true } }))) throw new NotFoundException("Site not found");
        const interval = input.intervalHours ?? 24;
        if (!INTERVALS_HOURS.includes(interval)) throw new BadRequestException(`Scan every ${INTERVALS_HOURS.join(", ")} hours.`);
        const ranges = checkRanges(input.ranges ?? []);
        let scanner: string | null = null;
        if (input.scannerDeviceId) {
            const d = await this.prisma.devices.findUnique({ where: { id: String(input.scannerDeviceId) }, select: { site_id: true } }).catch(() => null);
            if (!d || d.site_id !== siteId) throw new BadRequestException("The scanning device must belong to this site.");
            scanner = String(input.scannerDeviceId);
        }
        await this.prisma.$executeRaw`
            INSERT INTO public.network_discovery_schedules (site_id, enabled, interval_hours, ranges, scanner_device_id, alert_new, created_by)
            VALUES (${siteId}::uuid, ${input.enabled ?? true}, ${interval}, ${ranges}::text[], ${scanner}::uuid, ${input.alertNew ?? true}, ${userId}::uuid)
            ON CONFLICT (site_id) DO UPDATE SET enabled = EXCLUDED.enabled, interval_hours = EXCLUDED.interval_hours, ranges = EXCLUDED.ranges,
                   scanner_device_id = EXCLUDED.scanner_device_id, alert_new = EXCLUDED.alert_new, updated_at = now(), last_message = NULL`;
        return (await this.list(userId)).items.find((x) => x.siteId === siteId) ?? null;
    }

    async remove(userId: string | null, siteId: string): Promise<boolean> {
        if (!isCanonicalUuid(siteId)) return false;
        const scope = await this.access.scopeFor(userId);
        if (!(await this.access.canSeeSite(scope, siteId))) return false;
        return (await this.prisma.$executeRaw`DELETE FROM public.network_discovery_schedules WHERE site_id = ${siteId}::uuid`) > 0;
    }

    /* ------------------------------ running the schedules ------------------------------ */

    @Interval(60_000)
    async tick(): Promise<void> {
        if (process.env.NETWORK_DISCOVERY_SCHEDULER_ENABLED === "false") return;
        await this.runDue();
    }

    /** Starts a scan for every schedule that is due. Returns how many scans were started. */
    async runDue(): Promise<number> {
        if (this.running) return 0;
        this.running = true;
        let started = 0;
        try {
            const due = await this.prisma.$queryRaw<Array<{ site_id: string; interval_hours: number; ranges: string[]; scanner_device_id: string | null }>>`
                SELECT site_id::text AS site_id, interval_hours, ranges, scanner_device_id::text AS scanner_device_id
                  FROM public.network_discovery_schedules
                 WHERE enabled AND (last_requested_at IS NULL OR last_requested_at <= now() - make_interval(hours => interval_hours))
                 ORDER BY last_requested_at NULLS FIRST LIMIT ${MAX_PER_TICK}`;
            for (const s of due) {
                try { if (await this.runOne(s)) started++; } catch (e) { this.logger.warn(`A scheduled network scan failed to start: ${(e as Error).message}`); }
            }
        } finally {
            this.running = false;
        }
        return started;
    }

    private async runOne(s: { site_id: string; ranges: string[]; scanner_device_id: string | null }): Promise<boolean> {
        // a site whose scan is still running (started by a person or the schedule) is left alone until it ends
        const busy = (await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.network_discovery_runs WHERE site_id = ${s.site_id}::uuid AND status = 'pending' AND requested_at > now() - interval '15 minutes'`)[0].n;
        if (busy) return false;
        const note = (m: string | null) => this.prisma.$executeRaw`UPDATE public.network_discovery_schedules SET last_message = ${m} WHERE site_id = ${s.site_id}::uuid`;
        // preferred device first when it is online, then any other online Windows or Linux device of the site
        const candidates = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT d.id::text AS id FROM public.devices d JOIN public.agents a ON a.device_id = d.id
             WHERE d.site_id = ${s.site_id}::uuid AND a.last_check_in_at > now() - interval '5 minutes'
               AND (lower(COALESCE(a.facts->>'os', d.operating_system, '')) LIKE 'windows%' OR lower(COALESCE(a.facts->>'os', '')) = 'linux'
                    OR lower(COALESCE(d.operating_system, '')) ~ 'linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle')
             ORDER BY (d.id = ${s.scanner_device_id}::uuid) DESC, a.last_check_in_at DESC LIMIT 5`;
        if (!candidates.length) { await note("No Windows or Linux device of this site is online, so the scan waits."); return false; }
        for (const c of candidates) {
            try {
                const r = await this.discovery.startScan(null, c.id, s.ranges);
                // the scan counts as started (or already running): the next one is an interval from now
                await this.prisma.$executeRaw`UPDATE public.network_discovery_schedules SET last_requested_at = now(), last_message = NULL WHERE site_id = ${s.site_id}::uuid`;
                return !r.alreadyRunning;
            } catch (e) {
                await note(String((e as Error).message ?? "The scan could not be started.").slice(0, 300));
            }
        }
        return false;
    }
}
