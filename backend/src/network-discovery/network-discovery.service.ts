// Network discovery: a managed Windows or Linux device scans its own network (a signed script job), the server reads the answer back,
// remembers each host it saw (one row per site and MAC address or IP), and says which of them are NOT managed devices yet.
// A person limited to some customers sees, scans for and changes only their own sites. Nothing here changes a device or the network:
// a scan only looks, and "ignore" only hides a row from the default list.
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { JobsService } from "../jobs/jobs.service";
import { ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { AlertsService } from "../alerts/alerts.service";
import { AssetsService } from "../assets/assets.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { ToolOutputError } from "../device-tools/device-tools.scripts";
import {
    checkRanges, classifyHost, DISCOVERY_KIND, DISCOVERY_TIMEOUT_SEC, HOST_KIND_TEXT, LINUX_DISCOVERY_SCRIPT, parseDiscovery, vendorOf,
    NAME_SOURCE_TEXT, WINDOWS_DISCOVERY_SCRIPT, type DiscoveryScan, type HostKind, type NameSource,
} from "./discovery.scripts";

const ONLINE_WINDOW_MS = 5 * 60_000;
const FINISHED = ["succeeded", "failed", "timeout"];
/** A scan that was never answered is given up on after this long (the job itself times out well before). */
const GIVE_UP_MS = 15 * 60_000;
const LIST_MAX = 200;
/** This many addresses answering with one MAC means something answers for them (a router, firewall or VPN). */
export const SHARED_MAC_LIMIT = 5;
/** Scans started together from one request. */
export const MAX_SCAN_DEVICES = 25;

export type HostStatus = "unmanaged" | "managed" | "ignored" | "all";

type HostRow = {
    id: string; site_id: string; ip: string; mac: string | null; hostname: string | null; vendor: string | null; kind: string; ports: number[];
    first_seen: Date; last_seen: Date; seen_runs: number; device_id: string | null; ignored: boolean; asset_provider: string | null; asset_ref: string | null; name_source: string | null;
    site_name: string | null; client_id: string | null; client_name: string | null; device_name: string | null;
};
type RunRow = {
    id: string; site_id: string; scanner_device_id: string | null; scanner_name: string | null; job_id: string | null; requested_at: Date; status: string;
    finished_at: Date | null; ranges: string[]; hosts_found: number; new_hosts: number; seconds: number | null; message: string | null;
    site_name: string | null; client_name: string | null;
};

const isWindows = (os: string) => /^windows/i.test(os);
const isLinux = (factsOs: unknown, os: string) => (String(factsOs ?? "").toLowerCase() ? String(factsOs).toLowerCase() === "linux" : /linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle/i.test(os));

@Injectable()
export class NetworkDiscoveryService {
    private readonly logger = new Logger(NetworkDiscoveryService.name);
    private polling = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly jobs: JobsService,
        private readonly access: ClientAccessService,
        private readonly alerts: AlertsService,
        private readonly assets: AssetsService,
    ) { }

    private scopeOf(userId: string | null) {
        return this.access.scopeFor(userId);
    }

    /* ------------------------------ who can scan ------------------------------ */

    /** The online Windows and Linux devices a person may scan from, with their customer and site. */
    async scanners(userId: string | null) {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.scopeOf(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`(c.id IS NULL OR c.organization_id = ${orgId}::uuid)`, Prisma.sql`a.last_check_in_at > now() - interval '5 minutes'`];
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` }));
        const rows = await this.prisma.$queryRaw<Array<{ id: string; hostname: string; alias: string | null; operating_system: string | null; facts_os: string | null; site_id: string | null; site_name: string | null; client_id: string | null; client_name: string | null }>>`
            SELECT d.id::text AS id, d.hostname, d.alias, d.operating_system, a.facts->>'os' AS facts_os, d.site_id::text AS site_id, st.name AS site_name, c.id::text AS client_id, c.name AS client_name
              FROM public.devices d
              JOIN public.agents a ON a.device_id = d.id
              LEFT JOIN public.sites st ON st.id = d.site_id
              LEFT JOIN public.clients c ON c.id = st.client_id
             WHERE ${Prisma.join(conds, " AND ")}
             ORDER BY c.name NULLS LAST, st.name NULLS LAST, d.hostname
             LIMIT 1000`;
        return {
            items: rows
                .filter((r) => r.site_id && (isWindows(String(r.facts_os || r.operating_system || "")) || isLinux(r.facts_os, String(r.operating_system || ""))))
                .map((r) => ({ deviceId: r.id, name: r.alias || r.hostname, os: r.operating_system, customer: r.client_name, clientId: r.client_id, site: r.site_name, siteId: r.site_id })),
        };
    }

    /* ------------------------------ asking for a scan ------------------------------ */

    async startScan(userId: string | null, deviceId: string, rangesRaw: unknown): Promise<{ runId: string; jobId: string; alreadyRunning: boolean; ranges: string[] }> {
        if (!isCanonicalUuid(deviceId)) throw new NotFoundException("Device not found");
        const ranges = checkRanges(rangesRaw);
        const d = await this.prisma.devices.findUnique({
            where: { id: deviceId },
            select: { id: true, hostname: true, alias: true, operating_system: true, site_id: true, sites: { select: { client_id: true } }, agents: { select: { id: true, facts: true, last_check_in_at: true } } },
        });
        const scope = await this.scopeOf(userId);
        if (!d || !d.site_id || !(await this.access.canSeeSite(scope, d.site_id))) throw new NotFoundException("Device not found");
        const os = String((d.agents?.facts as any)?.os || d.operating_system || "");
        const windows = isWindows(os);
        const linux = !windows && isLinux((d.agents?.facts as any)?.os, String(d.operating_system || ""));
        if (!windows && !linux) throw new BadRequestException("Network discovery runs from Windows and Linux devices. A macOS version is not available yet.");
        if (!d.agents) throw new ConflictException("This device has no agent.");
        if (Date.now() - (d.agents.last_check_in_at?.getTime() ?? 0) > ONLINE_WINDOW_MS) throw new ConflictException("This device is offline. A network scan needs a device that is online now.");

        // One scan per device at a time: a scan this device is still doing is returned instead of starting another. (Several devices of one
        // site may scan together, each its own network: the hosts they both see are one host, see ingest.)
        const waiting = await this.prisma.$queryRaw<Array<{ id: string; job_id: string | null; ranges: string[] }>>`
            SELECT id::text AS id, job_id::text AS job_id, ranges FROM public.network_discovery_runs
             WHERE scanner_device_id = ${d.id}::uuid AND status = 'pending' AND requested_at > now() - make_interval(secs => ${GIVE_UP_MS / 1000}::int) LIMIT 1`;
        if (waiting[0]) return { runId: waiting[0].id, jobId: waiting[0].job_id ?? "", alreadyRunning: true, ranges: waiting[0].ranges };

        const job = await this.jobs.createRunScriptJob({
            agentId: d.agents.id, language: windows ? "powershell" : "bash", scriptText: windows ? WINDOWS_DISCOVERY_SCRIPT : LINUX_DISCOVERY_SCRIPT,
            env: { RIQ_TOOL: DISCOVERY_KIND, RIQ_RANGES: ranges.join(",") }, timeoutSec: DISCOVERY_TIMEOUT_SEC,
        });
        const name = d.alias || d.hostname;
        const run = await this.prisma.$queryRaw<Array<{ id: string }>>`
            INSERT INTO public.network_discovery_runs (site_id, scanner_device_id, scanner_name, job_id, requested_by, ranges)
            VALUES (${d.site_id}::uuid, ${d.id}::uuid, ${name}, ${job.id}::uuid, ${userId}::uuid, ${ranges}::text[]) RETURNING id::text AS id`;
        return { runId: run[0].id, jobId: job.id, alreadyRunning: false, ranges };
    }

    /* ------------------------------ reading a scan back ------------------------------ */

    @Interval(15_000)
    async tick(): Promise<void> {
        if (process.env.NETWORK_DISCOVERY_POLLER_ENABLED === "false") return;
        await this.poll();
    }

    async poll(): Promise<number> {
        if (this.polling) return 0;
        this.polling = true;
        let done = 0;
        try {
            const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.network_discovery_runs WHERE status = 'pending' ORDER BY requested_at LIMIT 50`;
            for (const r of rows) {
                try { if ((await this.refreshRun(r.id)) !== "waiting") done++; } catch (e) { this.logger.warn(`Reading a network scan back failed: ${(e as Error).message}`); }
            }
        } finally {
            this.polling = false;
        }
        return done;
    }

    /** Looks at the job a pending run waits for; keeps the hosts when it finished, records why when it failed or never answered. */
    async refreshRun(runId: string): Promise<"waiting" | "kept" | "failed"> {
        const run = (await this.prisma.$queryRaw<Array<{ id: string; site_id: string; job_id: string | null; requested_at: Date; status: string }>>`
            SELECT id::text AS id, site_id::text AS site_id, job_id::text AS job_id, requested_at, status FROM public.network_discovery_runs WHERE id = ${runId}::uuid`)[0];
        if (!run || run.status !== "pending") return run?.status === "succeeded" ? "kept" : "failed";
        const fail = async (message: string) => {
            await this.prisma.$executeRaw`UPDATE public.network_discovery_runs SET status = 'failed', finished_at = now(), message = ${message.slice(0, 400)} WHERE id = ${runId}::uuid AND status = 'pending'`;
            return "failed" as const;
        };
        if (!run.job_id) return fail("The scan was never started.");
        const job = await this.jobs.getJobWithResult(run.job_id).catch(() => null);
        if (!job) return fail("The scan job is gone.");
        if (!FINISHED.includes(String(job.status))) {
            return Date.now() - run.requested_at.getTime() > GIVE_UP_MS ? fail("The device did not answer in time.") : "waiting";
        }
        if (job.status === "timeout") return fail("The scan took too long on the device.");
        let scan: DiscoveryScan;
        try {
            scan = parseDiscovery(job.stdout ?? "", job.stderr ?? "");
        } catch (e) {
            if (!(e instanceof ToolOutputError)) throw e;
            return fail(e.message);
        }
        // Whoever closes the run first reads it in; a second reader (the poller and a page asking at once) finds it closed and leaves it.
        const claimed = await this.prisma.$executeRaw`UPDATE public.network_discovery_runs SET status = 'succeeded', finished_at = now() WHERE id = ${runId}::uuid AND status = 'pending'`;
        if (!claimed) return "kept";
        await this.ingest(run.id, run.site_id, scan);
        return "kept";
    }

    /** Remembers every host of a scan, links the ones that are managed devices, and closes the run. */
    async ingest(runId: string, siteId: string, scan: DiscoveryScan): Promise<{ hosts: number; newHosts: number }> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const agents = await this.prisma.$queryRaw<Array<{ device_id: string; hostname: string; facts: any }>>`
            SELECT d.id::text AS device_id, d.hostname, a.facts
              FROM public.devices d
              JOIN public.agents a ON a.device_id = d.id
              LEFT JOIN public.sites st ON st.id = d.site_id
              LEFT JOIN public.clients c ON c.id = st.client_id
             WHERE c.organization_id = ${orgId}::uuid LIMIT 20000`;
        const byMac = new Map<string, string>(), byIp = new Map<string, string>(), byName = new Map<string, string | null>();
        for (const a of agents) {
            const nets: any[] = Array.isArray(a.facts?.device?.network) ? a.facts.device.network : Array.isArray(a.facts?.network?.adapters) ? a.facts.network.adapters : [];
            for (const n of nets) {
                const mac = String(n?.mac ?? "").toUpperCase().replace(/-/g, ":");
                if (/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) byMac.set(mac, a.device_id);
                for (const ip of Array.isArray(n?.ipv4) ? n.ipv4 : []) byIp.set(String(ip), a.device_id);
            }
            const short = String(a.hostname || "").toLowerCase().split(".")[0];
            if (short) byName.set(short, byName.has(short) ? null : a.device_id); // two devices with one name: no match by name
        }
        // One MAC answering for many addresses (proxy ARP of a router, firewall or VPN) is not many hosts. From this many addresses on, they are
        // left out and the scan says so; fewer (a device with a few addresses) are kept, each by its own address.
        const perMac = new Map<string, number>();
        for (const h of scan.hosts) if (h.mac) perMac.set(h.mac, (perMac.get(h.mac) ?? 0) + 1);
        const phantom = new Map([...perMac].filter(([, n]) => n >= SHARED_MAC_LIMIT));
        const kept = scan.hosts.filter((h) => !(h.mac && phantom.has(h.mac)));
        const dropped = scan.hosts.length - kept.length;
        for (const mac of phantom.keys()) {
            // an earlier scan that merged them left one row under the MAC: it stands for nothing, unless someone has done something with it
            await this.prisma.$executeRaw`DELETE FROM public.discovered_hosts WHERE site_id = ${siteId}::uuid AND host_key = ${mac} AND device_id IS NULL AND asset_ref IS NULL AND NOT ignored`;
        }
        let fresh = 0;
        const newHosts: Array<{ id: string; ip: string; mac: string | null; hostname: string | null; vendor: string | null; kind: HostKind; ports: number[]; deviceId: string | null }> = [];
        for (const h of kept) {
            const vendor = vendorOf(h.mac);
            const kind: HostKind = classifyHost(h.ports, vendor);
            const shared = !!h.mac && (perMac.get(h.mac) ?? 0) > 1;
            let key = h.mac && !shared ? h.mac : `ip:${h.ip}`;
            if (key.startsWith("ip:")) {
                // another device of the site may have seen this address WITH its MAC (same network segment) while this one did not (it is routed):
                // that is the same host, so it is updated instead of listed twice
                const known = (await this.prisma.$queryRaw<Array<{ host_key: string }>>`SELECT host_key FROM public.discovered_hosts WHERE site_id = ${siteId}::uuid AND ip = ${h.ip} AND mac IS NOT NULL AND host_key NOT LIKE 'ip:%' LIMIT 1`)[0];
                if (known) key = known.host_key;
            }
            const deviceId = (h.mac && byMac.get(h.mac)) || byIp.get(h.ip) || (h.hostname ? byName.get(h.hostname.toLowerCase().split(".")[0]) ?? null : null) || null;
            if (h.mac && !shared) {
                // an address first seen without its MAC is the same host once the MAC is known
                await this.prisma.$executeRaw`
                    UPDATE public.discovered_hosts SET host_key = ${key} WHERE site_id = ${siteId}::uuid AND host_key = ${`ip:${h.ip}`}
                       AND NOT EXISTS (SELECT 1 FROM public.discovered_hosts x WHERE x.site_id = ${siteId}::uuid AND x.host_key = ${key})`;
            }
            const r = await this.prisma.$queryRaw<Array<{ inserted: boolean; id: string }>>`
                INSERT INTO public.discovered_hosts (site_id, host_key, ip, mac, hostname, name_source, vendor, kind, ports, device_id, last_run_id)
                VALUES (${siteId}::uuid, ${key}, ${h.ip}, ${h.mac}, ${h.hostname}, ${h.hostname ? h.nameSource : null}, ${vendor}, ${kind}, ${h.ports}::int[], ${deviceId}::uuid, ${runId}::uuid)
                ON CONFLICT (site_id, host_key) DO UPDATE SET
                    ip = EXCLUDED.ip, mac = COALESCE(EXCLUDED.mac, discovered_hosts.mac), hostname = COALESCE(EXCLUDED.hostname, discovered_hosts.hostname), name_source = CASE WHEN EXCLUDED.hostname IS NOT NULL THEN EXCLUDED.name_source ELSE discovered_hosts.name_source END,
                    vendor = COALESCE(EXCLUDED.vendor, discovered_hosts.vendor), kind = EXCLUDED.kind, ports = EXCLUDED.ports,
                    device_id = EXCLUDED.device_id, last_seen = now(), seen_runs = discovered_hosts.seen_runs + 1, last_run_id = EXCLUDED.last_run_id
                RETURNING (xmax = 0) AS inserted, id::text AS id`;
            if (r[0]?.inserted) { fresh++; newHosts.push({ id: r[0].id, ip: h.ip, mac: h.mac, hostname: h.hostname, vendor, kind, ports: h.ports, deviceId }); }
            // a host that has become a managed device no longer needs its alert
            else if (r[0] && deviceId) await this.alerts.clear(`discovery:host:${r[0].id}`, "The host is a managed device now.").catch(() => { });
        }
        await this.prisma.$executeRaw`
            UPDATE public.network_discovery_runs SET hosts_found = ${kept.length}, new_hosts = ${fresh},
                   seconds = ${scan.seconds}, ranges = ${scan.ranges}::text[], message = ${dropped ? `${dropped} addresses all answered with the same MAC address (${[...phantom.keys()].slice(0, 2).join(", ")}). A router, firewall or VPN is answering for them, so they are not listed as hosts.` : null}
             WHERE id = ${runId}::uuid`;
        await this.alertNew(runId, siteId, newHosts);
        return { hosts: kept.length, newHosts: fresh };
    }

    /**
     * An alert for each new host that is not a managed device, when the site's schedule asks for them and this is not the site's first
     * scan (the first one is the baseline of what is normally there). At most 10 alerts for one scan; a larger burst is one summary.
     * It never fails the reading of a scan.
     */
    private async alertNew(runId: string, siteId: string, hosts: Array<{ id: string; ip: string; mac: string | null; hostname: string | null; vendor: string | null; kind: HostKind; ports: number[]; deviceId: string | null }>): Promise<void> {
        try {
            const unknown = hosts.filter((h) => !h.deviceId);
            if (!unknown.length) return;
            const sch = (await this.prisma.$queryRaw<Array<{ alert_new: boolean }>>`SELECT alert_new FROM public.network_discovery_schedules WHERE site_id = ${siteId}::uuid`)[0];
            if (!sch?.alert_new) return;
            const before = (await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.network_discovery_runs WHERE site_id = ${siteId}::uuid AND status = 'succeeded' AND id <> ${runId}::uuid`)[0]?.n ?? 0;
            if (before === 0) return;
            const run = (await this.prisma.$queryRaw<Array<{ scanner_device_id: string | null; scanner_name: string | null; site_name: string | null }>>`
                SELECT r.scanner_device_id::text AS scanner_device_id, r.scanner_name, st.name AS site_name FROM public.network_discovery_runs r JOIN public.sites st ON st.id = r.site_id WHERE r.id = ${runId}::uuid`)[0];
            if (!run?.scanner_device_id) return;
            const where = run.site_name ?? "a site";
            for (const h of unknown.slice(0, 10)) {
                const ports = h.ports.length ? ` Open ports: ${h.ports.join(", ")}.` : "";
                await this.alerts.raise({
                    deviceId: run.scanner_device_id, kind: "discovery", dedupeKey: `discovery:host:${h.id}`, severity: "WARN",
                    title: `New device on the network at ${where}: ${h.hostname ?? h.ip}`,
                    detail: `Found at ${h.ip}${h.mac ? ` (${h.mac})` : ""}${h.vendor ? `, ${h.vendor}` : ""} by ${run.scanner_name ?? "a device"}. It looks like: ${HOST_KIND_TEXT[h.kind]}.${ports} It is not a managed device. Open Network discovery to ignore it, or install the agent on it.`,
                });
            }
            if (unknown.length > 10) {
                await this.alerts.raise({
                    deviceId: run.scanner_device_id, kind: "discovery", dedupeKey: `discovery:summary:${runId}`, severity: "WARN",
                    title: `${unknown.length} new devices on the network at ${where}`,
                    detail: `${unknown.length} hosts that are not managed devices appeared since the last scan. Open Network discovery to see them.`,
                });
            }
        } catch (e) {
            this.logger.warn(`Could not raise the alerts for new hosts: ${(e as Error).message}`);
        }
    }

    /* ------------------------------ reading what was found ------------------------------ */

    async list(userId: string | null, q: { status?: string; clientId?: string; siteId?: string; q?: string; limit?: number; offset?: number }) {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.scopeOf(userId);
        const base: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`];
        if (scope) base.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`h.site_id::text`, id: Prisma.sql`h.device_id::text` }));
        if (q.clientId && isCanonicalUuid(q.clientId)) base.push(Prisma.sql`st.client_id = ${q.clientId}::uuid`);
        if (q.siteId && isCanonicalUuid(q.siteId)) base.push(Prisma.sql`h.site_id = ${q.siteId}::uuid`);
        const term = String(q.q ?? "").trim().slice(0, 100);
        if (term) { const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`; base.push(Prisma.sql`(h.ip ILIKE ${like} OR h.mac ILIKE ${like} OR h.hostname ILIKE ${like} OR h.vendor ILIKE ${like} OR h.kind ILIKE ${like})`); }
        const from = Prisma.sql`FROM public.discovered_hosts h JOIN public.sites st ON st.id = h.site_id JOIN public.clients c ON c.id = st.client_id LEFT JOIN public.devices d ON d.id = h.device_id WHERE ${Prisma.join(base, " AND ")}`;
        const counts = (await this.prisma.$queryRaw<Array<{ unmanaged: number; managed: number; ignored: number; total: number }>>`
            SELECT count(*) FILTER (WHERE h.device_id IS NULL AND NOT h.ignored)::int AS unmanaged, count(*) FILTER (WHERE h.device_id IS NOT NULL)::int AS managed,
                   count(*) FILTER (WHERE h.ignored AND h.device_id IS NULL)::int AS ignored, count(*)::int AS total ${from}`)[0];
        const status = (["unmanaged", "managed", "ignored", "all"] as string[]).includes(String(q.status)) ? (q.status as HostStatus) : "unmanaged";
        const filter = status === "unmanaged" ? Prisma.sql`AND h.device_id IS NULL AND NOT h.ignored` : status === "managed" ? Prisma.sql`AND h.device_id IS NOT NULL` : status === "ignored" ? Prisma.sql`AND h.ignored AND h.device_id IS NULL` : Prisma.empty;
        const limit = Math.min(Math.max(Number(q.limit) || 50, 1), LIST_MAX);
        const offset = Math.max(Number(q.offset) || 0, 0);
        const rows = await this.prisma.$queryRaw<HostRow[]>`
            SELECT h.id::text AS id, h.site_id::text AS site_id, h.ip, h.mac, h.hostname, h.vendor, h.kind, h.ports, h.first_seen, h.last_seen, h.seen_runs,
                   h.device_id::text AS device_id, h.ignored, h.asset_provider, h.asset_ref, h.name_source, st.name AS site_name, c.id::text AS client_id, c.name AS client_name, COALESCE(d.alias, d.hostname) AS device_name
              ${from} ${filter}
             ORDER BY h.last_seen DESC, h.ip LIMIT ${limit} OFFSET ${offset}`;
        const totalMatching = status === "unmanaged" ? counts.unmanaged : status === "managed" ? counts.managed : status === "ignored" ? counts.ignored : counts.total;
        return {
            counts: { unmanaged: counts.unmanaged, managed: counts.managed, ignored: counts.ignored, all: counts.total },
            total: totalMatching,
            items: rows.map((r) => ({
                id: r.id, siteId: r.site_id, site: r.site_name, clientId: r.client_id, customer: r.client_name, ip: r.ip, mac: r.mac, hostname: r.hostname, vendor: r.vendor,
                kind: r.kind, kindText: HOST_KIND_TEXT[r.kind as HostKind] ?? HOST_KIND_TEXT.unknown, ports: r.ports, firstSeen: r.first_seen.toISOString(), lastSeen: r.last_seen.toISOString(),
                seenRuns: r.seen_runs, deviceId: r.device_id, deviceName: r.device_name, ignored: r.ignored, assetProvider: r.asset_provider, assetRef: r.asset_ref, nameSource: r.name_source, nameSourceText: r.name_source ? NAME_SOURCE_TEXT[r.name_source as NameSource] ?? null : null,
            })),
        };
    }

    async runs(userId: string | null, limit = 20) {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.scopeOf(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`];
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`r.site_id::text`, id: Prisma.sql`r.scanner_device_id::text` }));
        const rows = await this.prisma.$queryRaw<RunRow[]>`
            SELECT r.id::text AS id, r.site_id::text AS site_id, r.scanner_device_id::text AS scanner_device_id, r.scanner_name, r.job_id::text AS job_id, r.requested_at, r.status,
                   r.finished_at, r.ranges, r.hosts_found, r.new_hosts, r.seconds, r.message, st.name AS site_name, c.name AS client_name
              FROM public.network_discovery_runs r JOIN public.sites st ON st.id = r.site_id JOIN public.clients c ON c.id = st.client_id
             WHERE ${Prisma.join(conds, " AND ")} ORDER BY r.requested_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`;
        return {
            items: rows.map((r) => ({
                id: r.id, siteId: r.site_id, site: r.site_name, customer: r.client_name, scanner: r.scanner_name, scannerDeviceId: r.scanner_device_id, status: r.status,
                requestedAt: r.requested_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null, ranges: r.ranges, hostsFound: r.hosts_found, newHosts: r.new_hosts,
                seconds: r.seconds, message: r.message,
            })),
        };
    }

    /** One run, for the page that waits for a scan it just started (only a run of a site the person may see). */
    async run(userId: string | null, runId: string) {
        if (!isCanonicalUuid(runId)) throw new NotFoundException("Scan not found");
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.scopeOf(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`, Prisma.sql`r.id = ${runId}::uuid`];
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`r.site_id::text`, id: Prisma.sql`r.scanner_device_id::text` }));
        const found = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT r.id::text AS id FROM public.network_discovery_runs r JOIN public.sites st ON st.id = r.site_id JOIN public.clients c ON c.id = st.client_id WHERE ${Prisma.join(conds, " AND ")}`;
        if (!found[0]) throw new NotFoundException("Scan not found");
        await this.refreshRun(runId);
        return (await this.runs(userId, 100)).items.find((x) => x.id === runId) ?? null;
    }

    /* ------------------------------ ignoring ------------------------------ */

    async setIgnored(userId: string | null, ids: string[], ignored: boolean): Promise<number> {
        const clean = ids.filter(isCanonicalUuid).slice(0, 500);
        if (!clean.length) return 0;
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.scopeOf(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`, Prisma.sql`h.id = ANY(${clean}::uuid[])`];
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`h.site_id::text`, id: Prisma.sql`h.device_id::text` }));
        const allowed = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT h.id::text AS id FROM public.discovered_hosts h JOIN public.sites st ON st.id = h.site_id JOIN public.clients c ON c.id = st.client_id WHERE ${Prisma.join(conds, " AND ")}`;
        if (!allowed.length) return 0;
        const changed = await this.prisma.$executeRaw`UPDATE public.discovered_hosts SET ignored = ${ignored} WHERE id = ANY(${allowed.map((a) => a.id)}::uuid[])`;
        // an ignored host is known and wanted: its alert is closed
        if (ignored) for (const a of allowed) await this.alerts.clear(`discovery:host:${a.id}`, "The host was ignored.").catch(() => { });
        return changed;
    }

    /**
     * Starts a scan from each of several devices (a whole site, or a whole customer): every one scans its own network, the answers are read
     * back one by one, and a host that two of them both found is one host. A device that cannot scan (offline, macOS, no agent, not the
     * person's to use) is skipped with its reason; the rest go ahead.
     */
    async startScans(userId: string | null, deviceIds: string[], rangesRaw: unknown) {
        const ids = [...new Set(deviceIds.filter(isCanonicalUuid))];
        if (!ids.length) throw new BadRequestException("Choose at least one device to scan from.");
        if (ids.length > MAX_SCAN_DEVICES) throw new BadRequestException(`Scan from ${MAX_SCAN_DEVICES} devices at most at a time. Choose a smaller part of the customer.`);
        checkRanges(rangesRaw); // refuse a bad range once, before anything starts
        const names = new Map((await this.prisma.devices.findMany({ where: { id: { in: ids } }, select: { id: true, alias: true, hostname: true } })).map((d) => [d.id, d.alias || d.hostname]));
        const results: Array<{ deviceId: string; name: string; status: "started" | "already_running" | "skipped"; runId?: string; reason?: string }> = [];
        for (const id of ids) {
            const name = names.get(id) ?? id;
            try {
                const r = await this.startScan(userId, id, rangesRaw);
                results.push({ deviceId: id, name, status: r.alreadyRunning ? "already_running" : "started", runId: r.runId });
            } catch (e: any) {
                results.push({ deviceId: id, name, status: "skipped", reason: String(e?.response?.message ?? e?.message ?? "It could not be started.").slice(0, 200) });
            }
        }
        return { started: results.filter((r) => r.status === "started").length, alreadyRunning: results.filter((r) => r.status === "already_running").length, skipped: results.filter((r) => r.status === "skipped").length, results };
    }

    /**
     * Records a host that is not a managed device as an asset, through whoever owns assets (the built-in asset manager, or a refusal that says
     * where assets are managed). A host that already has an asset keeps it. The host remembers where its asset lives.
     */
    async addAsset(userId: string | null, hostId: string) {
        await this.assets.assertBuiltin();
        if (!isCanonicalUuid(hostId)) throw new NotFoundException("Host not found");
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.scopeOf(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`, Prisma.sql`h.id = ${hostId}::uuid`];
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`h.site_id::text`, id: Prisma.sql`h.device_id::text` }));
        const h = (await this.prisma.$queryRaw<Array<{ id: string; site_id: string; ip: string; mac: string | null; hostname: string | null; vendor: string | null; kind: string; ports: number[]; device_id: string | null; asset_provider: string | null; asset_ref: string | null }>>`
            SELECT h.id::text AS id, h.site_id::text AS site_id, h.ip, h.mac, h.hostname, h.vendor, h.kind, h.ports, h.device_id::text AS device_id, h.asset_provider, h.asset_ref
              FROM public.discovered_hosts h JOIN public.sites st ON st.id = h.site_id JOIN public.clients c ON c.id = st.client_id WHERE ${Prisma.join(conds, " AND ")}`)[0];
        if (!h) throw new NotFoundException("Host not found");
        if (h.device_id) throw new ConflictException("This host is a managed device. Its asset is filled in from its agent.");
        if (h.asset_ref) return { provider: h.asset_provider, ref: h.asset_ref, alreadyLinked: true };
        const link = await this.assets.registerHost({
            organizationId: orgId, siteId: h.site_id, name: h.hostname || (h.vendor ? `${h.vendor} ${h.ip}` : h.ip), ip: h.ip, mac: h.mac, vendor: h.vendor, guess: h.kind, ports: h.ports,
            description: null, source: "discovery",
        });
        await this.prisma.$executeRaw`UPDATE public.discovered_hosts SET asset_provider = ${link.provider}, asset_ref = ${link.ref} WHERE id = ${hostId}::uuid`;
        return link;
    }

    /** How many hosts are on the network and not managed (for the Overview's attention list): the same visibility as the list. */
    async unmanagedCount(userId: string | null): Promise<number> {
        return (await this.list(userId, { status: "unmanaged", limit: 1 })).counts.unmanaged;
    }
}
