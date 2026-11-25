// SNMP monitoring: the devices a site wants watched (printers, switches, anything that answers SNMP v1/v2c), polled by an online Windows or
// Linux device of the same site through a fixed signed job. The server stores the last answer and a thin history, and raises alerts for a
// device that stops answering, a printer supply that runs low and a printer that reports a fault.
//   - The community string is encrypted at rest and never returned. It travels to the poller in the job's environment; the job's payload
//     is scrubbed as soon as the job has finished.
//   - A person limited to some customers sees and changes only the devices of their own sites.
//   - A monitored device is NOT an asset record. It may point at one (asset_provider and asset_ref, both optional), so the asset can live
//     in the built-in asset manager or in another system without this module caring which.
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { JobsService } from "../jobs/jobs.service";
import { AlertsService } from "../alerts/alerts.service";
import { AssetsService } from "../assets/assets.service";
import { ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { ToolOutputError } from "../device-tools/device-tools.scripts";
import { isPrivateV4 } from "../network-discovery/discovery.scripts";
import {
    checkTargets, guessKind, isValidCommunity, LINUX_SNMP_SCRIPT, parseSnmp, PRINTER_STATUS_TEXT, printerErrors, SNMP_KIND, SNMP_MAX_TARGETS, SNMP_TIMEOUT_SEC,
    supplyPercent, WINDOWS_SNMP_SCRIPT, type SnmpResult,
} from "./snmp.scripts";

const FINISHED = ["succeeded", "failed", "timeout"];
const GIVE_UP_MS = 12 * 60_000;
const DOWN_AFTER_FAILURES = 3;
const SAMPLE_KEEP_DAYS = 60;
export const POLL_MINUTES = [5, 15, 30, 60];
export const SNMP_KINDS = ["auto", "printer", "switch", "other"];

type Row = {
    id: string; site_id: string; ip: string; port: number; name: string | null; kind: string; poll_minutes: number; enabled: boolean; alert_enabled: boolean;
    poller_device_id: string | null; asset_provider: string | null; asset_ref: string | null; created_at: Date; last_polled_at: Date | null; last_ok_at: Date | null;
    fail_count: number; status: string; last_error: string | null; sys_name: string | null; sys_descr: string | null; sys_location: string | null;
    uptime_seconds: string | null; detected_kind: string | null; data: any; site_name: string | null; client_id: string | null; client_name: string | null; poller_name: string | null;
    pending_poll_id: string | null;
};

export type SnmpInput = {
    siteId?: string; ip?: string; port?: number; community?: string; name?: string | null; kind?: string; pollMinutes?: number; enabled?: boolean;
    alertEnabled?: boolean; pollerDeviceId?: string | null;
};

@Injectable()
export class SnmpService {
    private readonly logger = new Logger(SnmpService.name);
    private busy = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly jobs: JobsService,
        private readonly alerts: AlertsService,
        private readonly access: ClientAccessService,
        private readonly assets: AssetsService,
    ) { }

    /* ------------------------------ reading ------------------------------ */

    private shape(r: Row, detail = false) {
        const kind = r.kind === "auto" ? r.detected_kind ?? "other" : r.kind;
        const d = r.data ?? {};
        const supplies = (Array.isArray(d.supplies) ? d.supplies : []).map((s: any) => ({ index: s.index, description: s.description, level: s.level, max: s.max, percent: supplyPercent(s) }));
        const errors = printerErrors(d.printer?.errors ?? null);
        const lowest = supplies.map((s: any) => s.percent).filter((p: number | null) => p !== null) as number[];
        const base = {
            id: r.id, siteId: r.site_id, site: r.site_name, clientId: r.client_id, customer: r.client_name, ip: r.ip, port: r.port,
            name: r.name || r.sys_name || r.ip, label: r.name, sysName: r.sys_name, description: r.sys_descr, location: r.sys_location,
            kind, kindChosen: r.kind, status: r.status, enabled: r.enabled, alertEnabled: r.alert_enabled, pollMinutes: r.poll_minutes, hasCommunity: true,
            pollerDeviceId: r.poller_device_id, pollerName: r.poller_name, assetProvider: r.asset_provider, assetRef: r.asset_ref,
            lastPolledAt: r.last_polled_at?.toISOString() ?? null, lastOkAt: r.last_ok_at?.toISOString() ?? null, failures: r.fail_count, message: r.last_error,
            uptimeSeconds: r.uptime_seconds === null ? null : Number(r.uptime_seconds), polling: !!r.pending_poll_id,
            summary: {
                lowestSupplyPercent: lowest.length ? Math.min(...lowest) : null, pages: d.printer?.pages ?? null,
                printerStatus: d.printer?.status != null ? PRINTER_STATUS_TEXT[d.printer.status] ?? `Status ${d.printer.status}` : null,
                faults: errors.map((e) => e.text), portsUp: Array.isArray(d.interfaces) ? d.interfaces.filter((i: any) => i.oper === 1 && i.name !== "lo").length : null,
                portsDown: Array.isArray(d.interfaces) ? d.interfaces.filter((i: any) => i.oper !== 1 && i.name !== "lo").length : null,
            },
        };
        return detail ? { ...base, supplies, printer: d.printer ? { ...d.printer, faults: errors } : null, interfaces: Array.isArray(d.interfaces) ? d.interfaces : [] } : base;
    }

    /** The rows, after reading back any poll that has finished since (so a page that asks sees the answer without waiting for the next round). */
    private async rows(userId: string | null, extra: Prisma.Sql[] = []): Promise<Row[]> {
        const first = await this.baseQuery(userId, extra);
        const pending = [...new Set(first.map((r) => r.pending_poll_id).filter((x): x is string => !!x))];
        if (!pending.length) return first;
        let settled = false;
        for (const id of pending) { try { if ((await this.refreshPoll(id)) !== "waiting") settled = true; } catch { /* the scheduler tries again */ } }
        return settled ? this.baseQuery(userId, extra) : first;
    }

    private async baseQuery(userId: string | null, extra: Prisma.Sql[] = []) {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.access.scopeFor(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`, ...extra];
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`s.site_id::text`, id: Prisma.sql`s.poller_device_id::text` }));
        return this.prisma.$queryRaw<Row[]>`
            SELECT s.id::text AS id, s.site_id::text AS site_id, s.ip, s.port, s.name, s.kind, s.poll_minutes, s.enabled, s.alert_enabled, s.poller_device_id::text AS poller_device_id,
                   s.asset_provider, s.asset_ref, s.created_at, s.last_polled_at, s.last_ok_at, s.fail_count, s.status, s.last_error, s.sys_name, s.sys_descr, s.sys_location,
                   s.uptime_seconds::text AS uptime_seconds, s.detected_kind, s.data, s.pending_poll_id::text AS pending_poll_id,
                   st.name AS site_name, c.id::text AS client_id, c.name AS client_name, COALESCE(d.alias, d.hostname) AS poller_name
              FROM public.snmp_devices s JOIN public.sites st ON st.id = s.site_id JOIN public.clients c ON c.id = st.client_id LEFT JOIN public.devices d ON d.id = s.poller_device_id
             WHERE ${Prisma.join(conds, " AND ")} ORDER BY c.name, st.name, s.ip LIMIT 1000`;
    }

    async list(userId: string | null, q: { clientId?: string; siteId?: string; status?: string; q?: string }) {
        const extra: Prisma.Sql[] = [];
        if (q.clientId && isCanonicalUuid(q.clientId)) extra.push(Prisma.sql`st.client_id = ${q.clientId}::uuid`);
        if (q.siteId && isCanonicalUuid(q.siteId)) extra.push(Prisma.sql`s.site_id = ${q.siteId}::uuid`);
        const only = q.status && ["ok", "unreachable", "unknown"].includes(q.status) ? q.status : null;
        const term = String(q.q ?? "").trim().slice(0, 100);
        if (term) { const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`; extra.push(Prisma.sql`(s.ip ILIKE ${like} OR s.name ILIKE ${like} OR s.sys_name ILIKE ${like} OR s.sys_descr ILIKE ${like})`); }
        // the tab counts describe the whole list (with the customer, site and search filters), never just the tab being viewed
        const all = (await this.rows(userId, extra)).map((r) => this.shape(r));
        const items = only ? all.filter((i) => i.status === only) : all;
        return { total: items.length, counts: { ok: all.filter((i) => i.status === "ok").length, unreachable: all.filter((i) => i.status === "unreachable").length, unknown: all.filter((i) => i.status === "unknown").length }, items };
    }

    async get(userId: string | null, id: string) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Device not found");
        const row = (await this.rows(userId, [Prisma.sql`s.id = ${id}::uuid`]))[0];
        if (!row) throw new NotFoundException("Device not found");
        const samples = await this.prisma.$queryRaw<Array<{ at: Date; ok: boolean; uptime_seconds: string | null; pages: string | null; min_supply_pct: number | null }>>`
            SELECT at, ok, uptime_seconds::text AS uptime_seconds, pages::text AS pages, min_supply_pct FROM public.snmp_samples WHERE device_id = ${id}::uuid ORDER BY at DESC LIMIT 200`;
        return { ...this.shape(row, true), samples: samples.map((s) => ({ at: s.at.toISOString(), ok: s.ok, uptimeSeconds: s.uptime_seconds === null ? null : Number(s.uptime_seconds), pages: s.pages === null ? null : Number(s.pages), lowestSupplyPercent: s.min_supply_pct })) };
    }

    /* ------------------------------ changing ------------------------------ */

    private async checkInput(userId: string | null, siteId: string, input: SnmpInput) {
        const scope = await this.access.scopeFor(userId);
        if (!isCanonicalUuid(siteId) || !(await this.access.canSeeSite(scope, siteId)) || !(await this.prisma.sites.findUnique({ where: { id: siteId }, select: { id: true } }))) throw new NotFoundException("Site not found");
        if (input.kind !== undefined && !SNMP_KINDS.includes(input.kind)) throw new BadRequestException(`The type must be one of: ${SNMP_KINDS.join(", ")}.`);
        if (input.pollMinutes !== undefined && !POLL_MINUTES.includes(input.pollMinutes)) throw new BadRequestException(`Poll every ${POLL_MINUTES.join(", ")} minutes.`);
        if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new BadRequestException("The port must be 1 to 65535.");
        if (input.community !== undefined && !isValidCommunity(input.community)) throw new BadRequestException("The community string may use letters, digits and . _ ~ @ # % ^ * + = - only, up to 64 characters.");
        if (input.name != null && String(input.name).length > 120) throw new BadRequestException("The name is too long.");
        if (input.pollerDeviceId) {
            const d = await this.prisma.devices.findUnique({ where: { id: String(input.pollerDeviceId) }, select: { site_id: true } }).catch(() => null);
            if (!d || d.site_id !== siteId) throw new BadRequestException("The polling device must belong to this site.");
        }
    }

    async create(userId: string | null, input: SnmpInput) {
        const siteId = String(input.siteId ?? "");
        await this.checkInput(userId, siteId, input);
        const ip = String(input.ip ?? "").trim();
        if (!isPrivateV4(ip)) throw new BadRequestException("The address must be a private IPv4 address (10.x.x.x, 172.16-31.x.x, 192.168.x.x).");
        const community = input.community ?? "public";
        if ((await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.snmp_devices WHERE site_id = ${siteId}::uuid AND ip = ${ip}`)[0].n) throw new ConflictException("That address is already monitored at this site.");
        const row = await this.prisma.$queryRaw<Array<{ id: string }>>`
            INSERT INTO public.snmp_devices (site_id, ip, port, name, community_enc, kind, poll_minutes, enabled, alert_enabled, poller_device_id, created_by)
            VALUES (${siteId}::uuid, ${ip}, ${input.port ?? 161}, ${input.name?.toString().trim() || null}, ${encryptSecret(community)}, ${input.kind ?? "auto"}, ${input.pollMinutes ?? 15},
                    ${input.enabled ?? true}, ${input.alertEnabled ?? true}, ${input.pollerDeviceId ?? null}::uuid, ${userId}::uuid) RETURNING id::text AS id`;
        return row[0].id;
    }

    async update(userId: string | null, id: string, input: SnmpInput) {
        const cur = (await this.baseQuery(userId, [Prisma.sql`s.id = ${id}::uuid`]).catch(() => []))[0];
        if (!isCanonicalUuid(id) || !cur) throw new NotFoundException("Device not found");
        await this.checkInput(userId, cur.site_id, input);
        if (input.ip !== undefined && input.ip !== cur.ip) throw new BadRequestException("The address cannot be changed. Remove the device and add it again.");
        const sets: Prisma.Sql[] = [Prisma.sql`updated_at = now()`];
        if (input.name !== undefined) sets.push(Prisma.sql`name = ${input.name?.toString().trim() || null}`);
        if (input.port !== undefined) sets.push(Prisma.sql`port = ${input.port}`);
        if (input.kind !== undefined) sets.push(Prisma.sql`kind = ${input.kind}`);
        if (input.pollMinutes !== undefined) sets.push(Prisma.sql`poll_minutes = ${input.pollMinutes}`);
        if (input.enabled !== undefined) sets.push(Prisma.sql`enabled = ${input.enabled}`);
        if (input.alertEnabled !== undefined) sets.push(Prisma.sql`alert_enabled = ${input.alertEnabled}`);
        if (input.pollerDeviceId !== undefined) sets.push(Prisma.sql`poller_device_id = ${input.pollerDeviceId}::uuid`);
        if (input.community !== undefined) sets.push(Prisma.sql`community_enc = ${encryptSecret(input.community)}`);
        await this.prisma.$executeRaw`UPDATE public.snmp_devices SET ${Prisma.join(sets, ", ")} WHERE id = ${id}::uuid`;
        if (input.alertEnabled === false || input.enabled === false) await this.clearAlerts(id);
    }

    async remove(userId: string | null, id: string): Promise<boolean> {
        const cur = isCanonicalUuid(id) ? (await this.baseQuery(userId, [Prisma.sql`s.id = ${id}::uuid`]))[0] : null;
        if (!cur) return false;
        await this.clearAlerts(id);
        await this.prisma.$executeRaw`DELETE FROM public.snmp_devices WHERE id = ${id}::uuid`;
        return true;
    }

    /** Records a monitored device as an asset, through whoever owns assets. A device that already has an asset keeps it. */
    async addAsset(userId: string | null, id: string) {
        await this.assets.assertBuiltin();
        const cur = isCanonicalUuid(id) ? (await this.baseQuery(userId, [Prisma.sql`s.id = ${id}::uuid`]))[0] : null;
        if (!cur) throw new NotFoundException("Device not found");
        if (cur.asset_ref) return { provider: cur.asset_provider, ref: cur.asset_ref, alreadyLinked: true };
        const orgId = await this.orgs.getDefaultOrganizationId();
        const kind = cur.kind === "auto" ? cur.detected_kind ?? "other" : cur.kind;
        const link = await this.assets.registerHost({
            organizationId: orgId, siteId: cur.site_id, name: cur.name || cur.sys_name || cur.ip, ip: cur.ip, mac: null, vendor: null, guess: kind === "switch" ? "network" : kind,
            ports: [], description: cur.sys_descr, source: "snmp",
        });
        await this.prisma.$executeRaw`UPDATE public.snmp_devices SET asset_provider = ${link.provider}, asset_ref = ${link.ref}, updated_at = now() WHERE id = ${id}::uuid`;
        return link;
    }

    /* ------------------------------ polling ------------------------------ */

    /** Polls one device now (the poller of its site, the preferred one when it is online). Returns the poll id. */
    async pollNow(userId: string | null, id: string): Promise<{ pollId: string; alreadyPolling: boolean }> {
        const cur = isCanonicalUuid(id) ? (await this.baseQuery(userId, [Prisma.sql`s.id = ${id}::uuid`]))[0] : null;
        if (!cur) throw new NotFoundException("Device not found");
        if (cur.pending_poll_id) {
            const p = (await this.prisma.$queryRaw<Array<{ status: string; requested_at: Date }>>`SELECT status, requested_at FROM public.snmp_polls WHERE id = ${cur.pending_poll_id}::uuid`)[0];
            if (p?.status === "pending" && Date.now() - p.requested_at.getTime() < GIVE_UP_MS) return { pollId: cur.pending_poll_id, alreadyPolling: true };
        }
        const started = await this.startPoll(cur.site_id, [id], cur.poller_device_id, true);
        if (!started) throw new ConflictException("No Windows or Linux device of this site is online to poll from.");
        return { pollId: started, alreadyPolling: false };
    }

    private async pickPoller(siteId: string, preferred: string | null): Promise<Array<{ id: string; windows: boolean; name: string }>> {
        return this.prisma.$queryRaw<Array<{ id: string; windows: boolean; name: string }>>`
            SELECT d.id::text AS id, (lower(COALESCE(a.facts->>'os', d.operating_system, '')) LIKE 'windows%') AS windows, COALESCE(d.alias, d.hostname) AS name
              FROM public.devices d JOIN public.agents a ON a.device_id = d.id
             WHERE d.site_id = ${siteId}::uuid AND a.last_check_in_at > now() - interval '5 minutes'
               AND (lower(COALESCE(a.facts->>'os', d.operating_system, '')) LIKE 'windows%' OR lower(COALESCE(a.facts->>'os', '')) = 'linux'
                    OR lower(COALESCE(d.operating_system, '')) ~ 'linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle')
             ORDER BY (d.id = ${preferred}::uuid) DESC, a.last_check_in_at DESC LIMIT 1`;
    }

    /** Queues one poll job for some devices of a site. Returns the poll id, or null when no device of the site is online. */
    async startPoll(siteId: string, deviceIds: string[], preferred: string | null, manual = false): Promise<string | null> {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; ip: string; port: number; community_enc: string; poller_device_id: string | null }>>`
            SELECT id::text AS id, ip, port, community_enc, poller_device_id::text AS poller_device_id FROM public.snmp_devices WHERE site_id = ${siteId}::uuid AND id = ANY(${deviceIds}::uuid[]) LIMIT ${SNMP_MAX_TARGETS}`;
        if (!rows.length) return null;
        const poller = (await this.pickPoller(siteId, preferred ?? rows.find((r) => r.poller_device_id)?.poller_device_id ?? null))[0];
        if (!poller) {
            await this.prisma.$executeRaw`UPDATE public.snmp_devices SET last_error = 'No Windows or Linux device of this site is online to poll from.' WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
            return null;
        }
        const agent = (await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.agents WHERE device_id = ${poller.id}::uuid`)[0];
        if (!agent) return null;
        const targets = checkTargets(rows.map((r) => ({ ip: r.ip, port: r.port, community: decryptSecret(r.community_enc) })));
        const job = await this.jobs.createRunScriptJob({
            agentId: agent.id, language: poller.windows ? "powershell" : "bash", scriptText: poller.windows ? WINDOWS_SNMP_SCRIPT : LINUX_SNMP_SCRIPT,
            env: { RIQ_TOOL: SNMP_KIND, RIQ_SNMP_TARGETS: targets }, timeoutSec: SNMP_TIMEOUT_SEC,
        });
        const poll = (await this.prisma.$queryRaw<Array<{ id: string }>>`
            INSERT INTO public.snmp_polls (site_id, job_id, poller_device_id, poller_name, device_ids)
            VALUES (${siteId}::uuid, ${job.id}::uuid, ${poller.id}::uuid, ${poller.name}, ${rows.map((r) => r.id)}::uuid[]) RETURNING id::text AS id`)[0].id;
        await this.prisma.$executeRaw`UPDATE public.snmp_devices SET pending_poll_id = ${poll}::uuid, last_polled_at = now(), last_error = NULL WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
        return poll;
    }

    @Interval(60_000)
    async tick(): Promise<void> {
        if (process.env.SNMP_POLLER_ENABLED === "false") return;
        await this.run();
    }

    /** One round: read back finished polls, then start polls for the devices that are due (one job per site, 20 devices at most). */
    async run(): Promise<{ read: number; started: number }> {
        if (this.busy) return { read: 0, started: 0 };
        this.busy = true;
        let read = 0, started = 0;
        try {
            const pending = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.snmp_polls WHERE status = 'pending' ORDER BY requested_at LIMIT 50`;
            for (const p of pending) { try { if ((await this.refreshPoll(p.id)) !== "waiting") read++; } catch (e) { this.logger.warn(`Reading an SNMP poll back failed: ${(e as Error).message}`); } }
            const due = await this.prisma.$queryRaw<Array<{ site_id: string; ids: string[] }>>`
                SELECT site_id::text AS site_id, (array_agg(id::text ORDER BY last_polled_at NULLS FIRST))[1:${SNMP_MAX_TARGETS}] AS ids
                  FROM public.snmp_devices
                 WHERE enabled AND pending_poll_id IS NULL AND (last_polled_at IS NULL OR last_polled_at <= now() - make_interval(mins => poll_minutes))
                 GROUP BY site_id LIMIT 20`;
            for (const g of due) { try { if (await this.startPoll(g.site_id, g.ids, null)) started++; } catch (e) { this.logger.warn(`Starting an SNMP poll failed: ${(e as Error).message}`); } }
            await this.prisma.$executeRaw`DELETE FROM public.snmp_samples WHERE at < now() - make_interval(days => ${SAMPLE_KEEP_DAYS}::int)`;
        } finally {
            this.busy = false;
        }
        return { read, started };
    }

    async refreshPoll(pollId: string): Promise<"waiting" | "done" | "failed"> {
        const poll = (await this.prisma.$queryRaw<Array<{ id: string; site_id: string; job_id: string | null; poller_device_id: string | null; poller_name: string | null; device_ids: string[]; requested_at: Date; status: string }>>`
            SELECT id::text AS id, site_id::text AS site_id, job_id::text AS job_id, poller_device_id::text AS poller_device_id, poller_name, device_ids::text[] AS device_ids, requested_at, status FROM public.snmp_polls WHERE id = ${pollId}::uuid`)[0];
        if (!poll || poll.status !== "pending") return poll?.status === "done" ? "done" : "failed";
        const fail = async (message: string) => {
            const closed = await this.prisma.$executeRaw`UPDATE public.snmp_polls SET status = 'failed', finished_at = now(), message = ${message.slice(0, 400)} WHERE id = ${pollId}::uuid AND status = 'pending'`;
            // the devices are not blamed for a poller that could not poll: they keep their state and show why
            if (closed) await this.prisma.$executeRaw`UPDATE public.snmp_devices SET pending_poll_id = NULL, last_error = ${message.slice(0, 400)} WHERE pending_poll_id = ${pollId}::uuid`;
            return "failed" as const;
        };
        if (!poll.job_id) return fail("The poll was never started.");
        const job = await this.jobs.getJobWithResult(poll.job_id).catch(() => null);
        if (!job) return fail("The poll job is gone.");
        if (!FINISHED.includes(String(job.status))) return Date.now() - poll.requested_at.getTime() > GIVE_UP_MS ? fail("The poller did not answer in time.") : "waiting";
        // the community strings are not needed in the job any more
        await this.prisma.$executeRaw`UPDATE public.jobs SET payload = jsonb_set(payload, '{env,RIQ_SNMP_TARGETS}', '"(removed)"'::jsonb) WHERE id = ${poll.job_id}::uuid AND payload #> '{env,RIQ_SNMP_TARGETS}' IS NOT NULL`;
        if (job.status === "timeout") return fail("The poll took too long on the polling device.");
        const devs = await this.prisma.$queryRaw<Array<{ id: string; ip: string }>>`SELECT id::text AS id, ip FROM public.snmp_devices WHERE id = ANY(${poll.device_ids}::uuid[])`;
        let parsed: ReturnType<typeof parseSnmp>;
        try {
            parsed = parseSnmp(job.stdout ?? "", job.stderr ?? "", devs.map((d) => d.ip));
        } catch (e) {
            if (!(e instanceof ToolOutputError)) throw e;
            return fail(e.message);
        }
        const claimed = await this.prisma.$executeRaw`UPDATE public.snmp_polls SET status = 'done', finished_at = now(), seconds = ${parsed.seconds} WHERE id = ${pollId}::uuid AND status = 'pending'`;
        if (!claimed) return "done";
        for (const d of devs) {
            const r = parsed.results.find((x) => x.ip === d.ip);
            if (r) await this.ingest(d.id, r, poll.poller_device_id).catch((e) => this.logger.warn(`Storing an SNMP result failed: ${(e as Error).message}`));
        }
        await this.prisma.$executeRaw`UPDATE public.snmp_devices SET pending_poll_id = NULL WHERE pending_poll_id = ${pollId}::uuid`;
        return "done";
    }

    private async ingest(deviceId: string, r: SnmpResult, pollerDeviceId: string | null): Promise<void> {
        if (!r.ok) {
            await this.prisma.$executeRaw`UPDATE public.snmp_devices SET fail_count = fail_count + 1, last_error = ${r.message}, status = CASE WHEN fail_count + 1 >= ${DOWN_AFTER_FAILURES} THEN 'unreachable' ELSE status END WHERE id = ${deviceId}::uuid`;
            await this.prisma.$executeRaw`INSERT INTO public.snmp_samples (device_id, ok) VALUES (${deviceId}::uuid, false) ON CONFLICT DO NOTHING`;
        } else {
            const data = { supplies: r.supplies, printer: r.printer, interfaces: r.interfaces };
            await this.prisma.$executeRaw`
                UPDATE public.snmp_devices SET status = 'ok', fail_count = 0, last_error = NULL, last_ok_at = now(), sys_name = ${r.name}, sys_descr = ${r.descr}, sys_location = ${r.location},
                       uptime_seconds = ${r.uptimeSeconds}, detected_kind = ${guessKind(r)}, data = ${JSON.stringify(data)}::jsonb WHERE id = ${deviceId}::uuid`;
            const pcts = r.supplies.map(supplyPercent).filter((p): p is number => p !== null);
            await this.prisma.$executeRaw`INSERT INTO public.snmp_samples (device_id, ok, uptime_seconds, pages, min_supply_pct) VALUES (${deviceId}::uuid, true, ${r.uptimeSeconds}, ${r.printer?.pages ?? null}, ${pcts.length ? Math.min(...pcts) : null}) ON CONFLICT DO NOTHING`;
        }
        await this.evaluateAlerts(deviceId, r, pollerDeviceId);
    }

    /* ------------------------------ alerts ------------------------------ */

    private async clearAlerts(deviceId: string): Promise<void> {
        const keys = await this.prisma.$queryRaw<Array<{ dedupe_key: string }>>`SELECT DISTINCT dedupe_key FROM public.alerts WHERE dedupe_key LIKE ${`snmp:%:${deviceId}%`} AND state <> 'RESOLVED'`;
        for (const k of keys) await this.alerts.clear(k.dedupe_key, "SNMP monitoring of this device was switched off or removed.").catch(() => { });
    }

    /** An alert needs a device of ours to sit on: the poller. Raised on conditions, cleared when they end. Never fails a poll. */
    private async evaluateAlerts(deviceId: string, r: SnmpResult, pollerDeviceId: string | null): Promise<void> {
        try {
            const dev = (await this.prisma.$queryRaw<Array<{ name: string | null; sys_name: string | null; ip: string; alert_enabled: boolean; fail_count: number; site_name: string | null }>>`
                SELECT s.name, s.sys_name, s.ip, s.alert_enabled, s.fail_count, st.name AS site_name FROM public.snmp_devices s JOIN public.sites st ON st.id = s.site_id WHERE s.id = ${deviceId}::uuid`)[0];
            if (!dev || !pollerDeviceId) return;
            const who = `${dev.name || dev.sys_name || dev.ip}${dev.site_name ? ` at ${dev.site_name}` : ""}`;
            const downKey = `snmp:down:${deviceId}`;
            if (!dev.alert_enabled) { await this.clearAlerts(deviceId); return; }
            if (!r.ok) {
                if (dev.fail_count >= DOWN_AFTER_FAILURES) await this.alerts.raise({ deviceId: pollerDeviceId, kind: "discovery", dedupeKey: downKey, severity: "WARN", title: `${who} is not answering SNMP`, detail: `${dev.ip} did not answer ${dev.fail_count} polls in a row (${r.message ?? "no answer"}). Check that it is on, on the network, and that SNMP and the community string are right.` });
                return;
            }
            await this.alerts.clear(downKey, "The device answers SNMP again.");
            const seen = new Set<string>();
            for (const s of r.supplies) {
                const pct = supplyPercent(s); const key = `snmp:supply:${deviceId}:${s.index}`;
                if (pct !== null && pct <= 10) {
                    seen.add(key);
                    await this.alerts.raise({ deviceId: pollerDeviceId, kind: "discovery", dedupeKey: key, severity: pct <= 3 ? "CRIT" : "WARN", title: `${s.description || "A supply"} is at ${pct}% on ${who}`, detail: `${s.description || `Supply ${s.index}`} has ${pct}% left on the printer at ${dev.ip}.` });
                } else if (pct === null || pct > 15) await this.alerts.clear(key, "The supply level is fine again.");
                else seen.add(key); // between 10 and 15: neither raised nor cleared, so it does not flap
            }
            const faultKeys = new Set<string>();
            for (const e of printerErrors(r.printer?.errors ?? null)) {
                const key = `snmp:printer:${deviceId}:${e.text.toLowerCase().replace(/[^a-z]+/g, "-")}`; faultKeys.add(key);
                await this.alerts.raise({ deviceId: pollerDeviceId, kind: "discovery", dedupeKey: key, severity: e.severity, title: `${e.text} on ${who}`, detail: `The printer at ${dev.ip} reports: ${e.text}.` });
            }
            const live = await this.prisma.$queryRaw<Array<{ dedupe_key: string }>>`SELECT dedupe_key FROM public.alerts WHERE dedupe_key LIKE ${`snmp:printer:${deviceId}:%`} AND state <> 'RESOLVED'`;
            for (const a of live) if (!faultKeys.has(a.dedupe_key)) await this.alerts.clear(a.dedupe_key, "The printer no longer reports this.");
        } catch (e) {
            this.logger.warn(`Could not evaluate the SNMP alerts: ${(e as Error).message}`);
        }
    }
}
