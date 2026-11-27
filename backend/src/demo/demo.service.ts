// backend/src/demo/demo.service.ts
//
// Demo data: six fictional customers with forty endpoints between them (Windows and Linux), and everything a visitor looks at
// around them: hardware, security, network and software facts, patch scans, alerts with history, check results, script runs,
// remote sessions, a service desk with conversations, time entries, contracts, invoices and payments, a knowledge base,
// contacts, tags, policies, check profiles, SLA policies, report schedules, web monitors and asset records.
//
// Every top-level row it creates is recorded in demo_records, and turning demo data off deletes exactly those rows (rows
// that hang off a demo device or ticket go with it), so real data is never touched. Everything is built in memory first and
// written in one transaction with batched inserts: it is fast, and a failure leaves nothing behind. Nothing here reaches the
// network and no credentials of any kind are created.
import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PoliciesService } from "../policies/policies.service";
import { reconcile, type PolicySpec, type SlaState, type Clock } from "../service-desk/sla-engine";
import type { Calendar } from "../service-desk/sla-calendar";
import { evalCertificate, evalDomain, evalDns } from "../web-monitors/web-monitors.core";
import {
    GB, SOFTWARE, PATCH_CATALOG, ALERTS, SCRIPTS, AVAILABILITY, DISK_DRIFT, HARDWARE_CHANGES, RISK, THREATS, type DemoDevice,
} from "./demo.devices";
import { FLEET, LINUX_SOFTWARE, LINUX_PATCHES, LINUX_SCRIPTS } from "./demo.fleet";
import { CUSTOMERS, TECHS, emailOf } from "./demo.people";
import { TICKETS, CANNED, TEMPLATES } from "./demo.desk";
import { KB, KB_CATEGORIES } from "./demo.kb";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const DEMO_PREFIX = "Demo: ";
const LOG = new Logger("DemoData");

// The newest agent release a "current" demo device runs. Older strings in the fleet are devices that fell behind.
const CURRENT_AGENT = "1.3.60";
const IO_MIN_AGENT = "1.3.36";

/** Compares dotted version numbers part by part. */
const cmpVersion = (a: string, b: string) => {
    const x = a.match(/\d+/g)?.map(Number) ?? [];
    const y = b.match(/\d+/g)?.map(Number) ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The same demo every time it is turned on: a small seeded generator instead of Math.random. */
function makeRng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const rnd = (n: number) => Math.floor(next() * n);
    const pick = <T,>(arr: readonly T[]): T => arr[rnd(arr.length)];
    const shuffle = <T,>(arr: readonly T[]): T[] => { const o = [...arr]; for (let i = o.length - 1; i > 0; i--) { const j = rnd(i + 1); [o[i], o[j]] = [o[j], o[i]]; } return o; };
    return { next, rnd, pick, shuffle };
}

const LINUX_ALERTS: Array<[string, string, string]> = [
    ["WARN", "Disk space low", "Free space is under 15% on /"], ["WARN", "Memory pressure", "Available memory under 10%"],
    ["CRIT", "Service stopped", "A watched service is not running"], ["WARN", "CPU high for 10 minutes", "CPU stayed above 90%"],
    ["WARN", "Pending restart for 14 days", "Updates are waiting for a restart"], ["CRIT", "Backup failed", "Last nightly backup did not complete"],
];

const WINGET_APPS: Array<[string, string, string, string]> = [
    ["Google.Chrome", "Google Chrome", "124.0.6367.119", "131.0.6778.205"], ["Mozilla.Firefox", "Mozilla Firefox", "125.0.3", "133.0.3"], ["Zoom.Zoom", "Zoom Workplace", "5.17.5", "6.2.10"],
    ["7zip.7zip", "7-Zip", "22.01", "24.09"], ["Adobe.Acrobat.Reader.64-bit", "Adobe Acrobat Reader", "23.008.20470", "24.005.20320"], ["VideoLAN.VLC", "VLC media player", "3.0.18", "3.0.21"],
    ["Notepad++.Notepad++", "Notepad++", "8.5.8", "8.7.4"], ["Microsoft.Teams", "Microsoft Teams", "1.6.00", "24295.605"],
];

export type DemoStatus = { enabled: boolean; since: string | null; counts: { customers: number; sites: number; devices: number; tickets: number; sessions: number; assets: number; contacts: number; invoices: number; articles: number } };

type Rows = Record<string, any[]>;
type Check = { key: string; type: string; name: string; status: "OK" | "WARN" | "CRIT"; output: string; metrics: Record<string, any>; history?: Array<{ at: number; metrics: Record<string, any>; status: "OK" | "WARN" | "CRIT"; output: string }> };

@Injectable()
export class DemoService implements OnModuleInit, OnModuleDestroy {
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    /**
     * Demo devices have no agent, so nothing would ever report for them and they would all drift offline within minutes.
     * While demo data is on, the devices that were online when it was created keep their last-seen time current.
     * Devices that were created as offline stay offline.
     */
    onModuleInit() {
        this.timer = setInterval(() => { void this.keepOnline().catch(() => undefined); }, 60_000);
        this.timer.unref?.();
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async keepOnline() {
        await this.prisma.$executeRaw`
            WITH d AS (
                UPDATE public.devices SET last_seen_at = now(), status = 'online'::device_status
                 WHERE id IN (SELECT record_id FROM public.demo_records WHERE table_name = 'devices') AND last_seen_at > now() - interval '30 minutes'
             RETURNING id)
            UPDATE public.agents SET last_check_in_at = now() WHERE device_id IN (SELECT id FROM d)`;
    }

    async status(): Promise<DemoStatus> {
        const rows = await this.prisma.demo_records.groupBy({ by: ["table_name"], _count: { _all: true }, _min: { created_at: true } });
        const n = (t: string) => rows.find((r) => r.table_name === t)?._count._all ?? 0;
        const since = rows.map((r) => r._min.created_at).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
        const remote = n("audit_events") > 0
            ? (await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.audit_events a JOIN public.demo_records r ON r.table_name = 'audit_events' AND r.record_id = a.id WHERE a.category = 'remote'`)[0]?.n ?? 0
            : 0;
        return { enabled: n("devices") > 0, since: since?.toISOString() ?? null, counts: { customers: n("clients"), sites: n("sites"), devices: n("devices"), tickets: n("tickets"), sessions: remote, assets: n("assets"), contacts: n("customer_contacts"), invoices: n("invoices"), articles: n("kb_articles") } };
    }

    /** Policies are read against the data the demo adds and removes, so they must look again afterwards. */
    async enable(): Promise<DemoStatus> {
        try {
            return await this.doEnable();
        } finally {
            PoliciesService.invalidate();
        }
    }

    async disable(): Promise<DemoStatus> {
        try {
            return await this.doDisable();
        } finally {
            PoliciesService.invalidate();
        }
    }

    /** Creates the demo fleet. Does nothing if it is already on. */
    private async doEnable(): Promise<DemoStatus> {
        if ((await this.status()).enabled) return this.status();
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const taken = await this.prisma.clients.findFirst({ where: { organization_id: organizationId, name: { startsWith: DEMO_PREFIX } }, select: { id: true } });
        if (taken) throw new BadRequestException(`A customer whose name starts with "${DEMO_PREFIX}" already exists. Rename or remove it before turning demo data on.`);

        const t0 = Date.now();
        const rows: Rows = {};
        const tracked: Array<{ table_name: string; record_id: string }> = [];
        const web: Array<Record<string, any>> = [];
        const numbers = { invoice: 0, quote: 0 };
        await this.build(organizationId, rows, tracked, web, numbers);
        const t1 = Date.now();

        // One transaction: if anything fails the database is as it was, with no half a demo left behind.
        await this.prisma.$transaction(async (tx) => {
            for (const table of WRITE_ORDER) {
                const data = rows[table];
                if (!data?.length) continue;
                for (let i = 0; i < data.length; i += 2000) await (tx as any)[table.split("#")[0]].createMany({ data: data.slice(i, i + 2000) });
            }
            for (const m of web) {
                await tx.$executeRaw`INSERT INTO public.web_monitors (id, organization_id, client_id, kind, name, host, port, config, enabled, status, detail, result, expires_at, error_count, last_checked_at, next_check_at, status_since)
                    VALUES (${m.id}::uuid, ${organizationId}::uuid, ${m.client_id}::uuid, ${m.kind}, ${m.name}, ${m.host}, ${m.port}, ${JSON.stringify(m.config)}::jsonb, false, ${m.status}, ${m.detail}, ${JSON.stringify(m.result)}::jsonb, ${m.expires_at}, 0, ${m.last_checked_at}, ${m.next_check_at}, ${m.status_since})`;
            }
            // Real invoices and quotes must go on numbering after the demo ones, never reuse them.
            await tx.$executeRaw`INSERT INTO public.billing_settings (organization_id, next_invoice_number, next_quote_number) VALUES (${organizationId}::uuid, ${numbers.invoice}, ${numbers.quote})
                ON CONFLICT (organization_id) DO UPDATE SET next_invoice_number = GREATEST(public.billing_settings.next_invoice_number, EXCLUDED.next_invoice_number), next_quote_number = GREATEST(public.billing_settings.next_quote_number, EXCLUDED.next_quote_number)`;
            for (let i = 0; i < tracked.length; i += 2000) await tx.demo_records.createMany({ data: tracked.slice(i, i + 2000), skipDuplicates: true });
        }, { timeout: 120_000, maxWait: 20_000 });
        LOG.log(`Demo data created: built in ${t1 - t0} ms, written in ${Date.now() - t1} ms.`);
        return this.status();
    }

    /** Builds every row in memory. Reads from the database only to avoid clashing with what is already there. */
    private async build(organizationId: string, T: Rows, tracked: Array<{ table_name: string; record_id: string }>, web: Array<Record<string, any>>, numbers: { invoice: number; quote: number }) {
        const now = Date.now();
        const R = makeRng(20261126);
        const { rnd, pick, shuffle } = R;
        const uuid = () => crypto.randomUUID();
        const add = (table: string, row: any) => { (T[table] ??= []).push(row); return row; };
        const mark = (table: string, id: string) => { tracked.push({ table_name: table, record_id: id }); return id; };
        const addT = (table: string, row: any) => { add(table, row); mark(table, row.id); return row; };

        // What is already in the organisation, so the demo never clashes with it.
        const versions = (await this.prisma.agents.findMany({ select: { version: true }, distinct: ["version"] })).map((a) => a.version);
        const newestAgent = [...versions, CURRENT_AGENT].sort((a, b) => cmpVersion(b, a))[0];
        const last = await this.prisma.tickets.aggregate({ where: { organization_id: organizationId }, _max: { ticket_number: true } });
        let ticketNumber = Number(last._max.ticket_number ?? 1000n);
        const existingUsers = await this.prisma.users.findMany({ where: { organization_id: organizationId }, select: { id: true, email: true, status: true, created_at: true }, orderBy: { created_at: "asc" } });
        const meUser = existingUsers.find((u) => u.status === "active" && !String(u.email).toLowerCase().endsWith("@demo.invalid")) ?? null;
        const takenCatalog = new Set((await this.prisma.catalog_items.findMany({ where: { organization_id: organizationId }, select: { name: true } })).map((c) => c.name.toLowerCase()));
        const takenTags = new Set((await this.prisma.tag_defs.findMany({ where: { organization_id: organizationId }, select: { name: true } })).map((c) => c.name.toLowerCase()));
        const takenChecks = new Set((await this.prisma.checks.findMany({ where: { organization_id: organizationId }, select: { name: true } })).map((c) => c.name.toLowerCase()));
        const takenProfiles = new Set((await this.prisma.check_profiles.findMany({ where: { organization_id: organizationId }, select: { name: true } })).map((c) => c.name.toLowerCase()));
        const takenPolicies = new Set((await this.prisma.policies.findMany({ where: { organization_id: organizationId }, select: { name: true } })).map((c) => c.name.toLowerCase()));
        const hasDefaultSla = (await this.prisma.sla_policies.count({ where: { organization_id: organizationId, is_default: true } })) > 0;
        const settings = await this.prisma.billing_settings.findUnique({ where: { organization_id: organizationId } });
        const invoicePrefix = settings?.invoice_prefix ?? "INV-";
        const quotePrefix = settings?.quote_prefix ?? "QUO-";
        const freeName = (name: string, taken: Set<string>) => { let n = name; while (taken.has(n.toLowerCase())) n += " (demo)"; taken.add(n.toLowerCase()); return n; };

        // Technicians. They are demo accounts nobody can sign in to: the stored value is not a password hash of any kind, so no password can match it.
        const noLogin = "!demo-account-no-sign-in";
        const techs = TECHS.map((t) => {
            const found = existingUsers.find((u) => String(u.email).toLowerCase() === t.email);
            const id = found?.id ?? uuid();
            if (!found) addT("users", { id, organization_id: organizationId, email: t.email, password_hash: noLogin, first_name: t.first, last_name: t.last, status: "active", last_seen_at: new Date(now - rnd(48) * HOUR) });
            return { id, name: `${t.first} ${t.last}`, email: t.email };
        });
        const meId = meUser?.id ?? null;
        const meName = meUser ? (await this.prisma.users.findUnique({ where: { id: meUser.id }, select: { first_name: true, last_name: true, email: true } }).then((u) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || String(u?.email ?? "Technician"))) : "Technician";
        const staff = (who: number | "me" | null) => who === null ? null : who === "me" ? (meId ? { id: meId, name: meName } : techs[0]) : techs[who];

        // Customers, contacts, sites.
        const clientIds: string[] = [];
        const contactIds: string[][] = [];
        const contactNames: string[][] = [];
        const contactEmails: string[][] = [];
        const siteIds = new Map<string, string>();
        CUSTOMERS.forEach((c, ci) => {
            const id = uuid();
            clientIds.push(id);
            const primary = c.contacts.find((x) => x.primary) ?? c.contacts[0];
            addT("clients", {
                id, organization_id: organizationId, name: `${DEMO_PREFIX}${c.name}`, external_ref: "demo", contact: { name: primary.name, email: emailOf(primary.name, c.domain), phone: c.phone },
                status: "active", legal_name: c.legal, industry: c.industry, website: `https://www.${c.domain}`, phone: c.phone, email: `office@${c.domain}`, billing_email: `billing@${c.domain}`,
                time_zone: c.zone, currency: "USD", payment_terms: c.terms, employee_count: c.employees, customer_since: new Date(now - c.sinceYearsAgo * 365.25 * DAY),
                address: { line1: c.address.line1, line2: "", city: c.address.city, region: c.address.region, postalCode: c.address.postalCode, country: "US" }, billing_same_as_address: true,
                notes: c.note, tags: c.tags, created_at: new Date(now - c.sinceYearsAgo * 365.25 * DAY),
            });
            contactIds.push([]); contactNames.push([]); contactEmails.push([]);
            c.contacts.forEach((p, pi) => {
                const cid = uuid();
                contactIds[ci].push(cid); contactNames[ci].push(p.name); contactEmails[ci].push(emailOf(p.name, c.domain));
                addT("customer_contacts", { id: cid, client_id: id, name: p.name, job_title: p.title, email: emailOf(p.name, c.domain), phone: `555-01${String(10 + ci * 5 + pi).padStart(2, "0")}`, mobile: p.mobile ? `555-01${String(60 + ci * 5 + pi).padStart(2, "0")}` : null, role: p.role, is_primary: !!p.primary, notes: null });
            });
            c.sites.forEach((s, si) => {
                const sid = uuid();
                siteIds.set(`${ci}/${s}`, sid);
                addT("sites", { id: sid, client_id: id, name: s, address: si === 0 ? { line1: c.address.line1, city: c.address.city, region: c.address.region, postalCode: c.address.postalCode, country: "US" } : {}, time_zone: c.zone, contact_name: primary.name, contact_email: emailOf(primary.name, c.domain), contact_phone: c.phone });
            });
        });

        // ---- Devices ----------------------------------------------------------------------------------------------------
        const deviceIdByHost = new Map<string, string>();
        const deviceByHost = new Map<string, DemoDevice>();
        const seenByHost = new Map<string, Date | null>();
        const alertsByHost = new Map<string, any[]>();
        const tagBy: Record<string, string> = {};
        const tagDefs: Array<[string, string]> = [["VIP", "#f59e0b"], ["Server", "#3b82f6"], ["Linux", "#10b981"], ["Remote worker", "#8b5cf6"], ["Point of sale", "#ef4444"], ["CAD", "#14b8a6"], ["Lab", "#6366f1"], ["Legacy OS", "#9ca3af"]];
        for (const [name, color] of tagDefs) { const id = uuid(); tagBy[name] = id; addT("tag_defs", { id, organization_id: organizationId, name: freeName(name, takenTags), color }); }

        for (const d of FLEET) {
            const linux = d.platform === "linux";
            const deviceId = uuid();
            deviceIdByHost.set(d.host, deviceId); deviceByHost.set(d.host, d);
            const seen = d.lastSeenHoursAgo === null ? null : new Date(now - d.lastSeenHoursAgo * HOUR - rnd(120) * 1000);
            seenByHost.set(d.host, seen);
            const ageDays = d.purchasedYearsAgo ? Math.round(d.purchasedYearsAgo * 365) : 400;
            addT("devices", {
                id: deviceId, site_id: siteIds.get(`${d.customer}/${d.site}`)!, hostname: d.host, operating_system: d.os.name, architecture: "x64",
                serial_number: `DEMO${crypto.createHash("sha1").update(d.host).digest("hex").slice(0, 8).toUpperCase()}`, primary_user: d.user || null, last_seen_at: seen,
                status: seen && now - seen.getTime() < 5 * MIN ? "online" : "offline", created_at: new Date(now - Math.min(ageDays, 900) * DAY),
            });

            // Tags.
            const tagNames = [d.kind === "server" ? "Server" : "", linux ? "Linux" : "", /POS/.test(d.host) ? "Point of sale" : "", /CAD/.test(d.host) ? "CAD" : "", /LAB/.test(d.host) ? "Lab" : "",
                /REMOTE|ACCT-04|TEACH/.test(d.host) ? "Remote worker" : "", /Windows 10/.test(d.os.name) ? "Legacy OS" : "", /PARTNER|SUM-/.test(d.host) && d.host.includes("PARTNER") ? "VIP" : ""].filter(Boolean);
            for (const n of tagNames) add("device_tags", { device_id: deviceId, tag_id: tagBy[n] });

            // Facts, in the shape each agent sends.
            const mounts: [string, string] = d.mounts ?? (linux ? ["/", "/data"] : ["C:", "D:"]);
            const fsName = linux ? (d.distro === "rocky" ? "xfs" : "ext4") : "NTFS";
            const disks: any[] = [{ mount: mounts[0], fs: fsName, totalBytes: d.diskGb * GB, freeBytes: Math.round(d.diskGb * GB * d.freePct / 100) }];
            if (d.secondDisk) disks.push({ mount: mounts[1], fs: fsName, totalBytes: d.secondDisk.gb * GB, freeBytes: Math.round(d.secondDisk.gb * GB * d.secondDisk.freePct / 100) });
            if (linux) for (const k of disks) { k.usedBytes = k.totalBytes - k.freeBytes; k.usedPercent = round1((k.usedBytes * 100) / k.totalBytes); }
            const mac = Array.from({ length: 6 }, (_, i) => (i === 0 ? "00" : crypto.createHash("md5").update(d.host + i).digest("hex").slice(0, 2))).join(":").toUpperCase();
            const bootAt = new Date(now - d.bootDaysAgo * DAY).toISOString();
            const rebootWhy = linux ? "kernel update" : "Windows Update";
            const threats = THREATS[d.host] ?? [];
            const security: any = {
                ...(d.av ? { antivirus: [{ name: d.av.name, state: d.av.state, upToDate: d.av.upToDate }] } : {}),
                ...(!linux && d.sigAge !== null ? { defender: { realTimeProtection: d.av?.state === "on", signatureAgeDays: d.sigAge, antivirusEnabled: d.av?.name === "Windows Defender" } } : {}),
                ...(d.firewall ? { firewall: d.firewall } : {}),
                ...(d.bitlocker ? { bitLocker: [{ mount: linux ? "/" : "C:", protection: d.bitlocker, status: linux ? (d.bitlocker === "on" ? "encrypted (LUKS)" : "not encrypted") : d.bitlocker === "on" ? "FullyEncrypted" : "FullyDecrypted" }] } : {}),
                ...(d.tpm ? { tpm: d.tpm } : {}),
                ...(d.secureBoot !== null ? { secureBoot: d.secureBoot } : {}),
            };
            const hardware: any = { model: d.model, cpu: d.cpu, ram: `${d.ramGb} GB`, ramBytes: d.ramGb * GB, serial: `DEMO-${d.host}` };
            if (!linux || d.kind === "workstation") hardware.gpu = [d.gpu ?? (/AMD/.test(d.cpu) ? "AMD Radeon Graphics" : "Intel(R) UHD Graphics")];
            const device: any = {
                ...(linux ? { libc: "glibc", init: "systemd" } : {}),
                hardware, disks,
                os: linux
                    ? { name: d.os.name, edition: d.distro, version: d.os.version, displayVersion: d.os.version, build: d.os.build, buildRevision: d.os.build, architecture: "x64", installedAt: new Date(now - (ageDays - 20) * DAY).toISOString() }
                    : { name: d.os.name, displayVersion: d.os.version, version: d.os.version, build: d.os.build.split(".")[0], buildRevision: d.os.build },
                boot: { lastBootAt: bootAt, pendingReboot: d.pendingReboot, pendingRebootReasons: d.pendingReboot ? [rebootWhy] : [] },
                bios: { vendor: d.model.split(" ")[0], version: `${1 + rnd(3)}.${rnd(20)}.${rnd(9)}`, releaseDate: d.biosDate },
                security,
                ...(RISK[d.host] ? { risk: RISK[d.host] } : {}),
                ...(d.host !== "SUM-REMOTE-04" && !linux ? { threats: { readAt: new Date(now).toISOString(), activeCount: threats.filter((t) => t[3] === "active").length, items: threats.map(([name, severity, daysAgo, status, action, resource]) => ({ name, severity, detectedAt: new Date(now - daysAgo * DAY - rnd(10) * HOUR).toISOString(), status, action, resource, user: d.user })) } } : {}),
                network: [{ description: linux ? (d.kind === "server" ? "eth0" : "enp3s0") : d.kind === "server" ? "Intel(R) Ethernet Server Adapter" : /Surface|XPS|Latitude|ThinkPad|EliteBook/.test(d.model) ? "Intel(R) Wi-Fi 6E AX211" : "Intel(R) Ethernet Connection", mac, ipv4: [d.ip], gateway: d.gateway }],
            };
            const agentVersion = d.agent === "1.3.26" ? newestAgent : d.agent;
            const agentId = uuid();
            add("agents", { id: agentId, device_id: deviceId, agent_uuid: uuid(), version: agentVersion, last_check_in_at: seen, facts: { os: linux ? "linux" : "windows", arch: "x64", primary_ip: d.ip, logged_in_user: d.user || null, device }, hostname: d.host, created_at: new Date(now - Math.min(ageDays, 700) * DAY) });

            // Software.
            const pool = linux ? LINUX_SOFTWARE : SOFTWARE;
            // The programs this kind of machine runs for its business come first, so software policies show a mix of compliant and not.
            const wanted: string[] = [];
            if (!linux && d.av?.name === "Windows Defender") wanted.push("Windows Defender");
            if (!linux) {
                if (d.customer === 0 && (d.kind === "server" || rnd(10) < 7)) wanted.push("Dentrix");
                if (d.customer === 1 && rnd(10) < 7) wanted.push("Clio Manage");
                if (d.customer === 2) wanted.push("QuickBooks Desktop", ...(/ACCT|PARTNER/.test(d.host) ? ["Example Tax Software Pro"] : []));
                if (d.customer === 3 && /POS/.test(d.host)) wanted.push("Retail Point of Sale Client");
                if (d.customer === 4) { if (/CAD/.test(d.host)) wanted.push("Example CAD Suite"); if (/PLANT/.test(d.host)) wanted.push("Machine Shop Controller"); if (rnd(10) < 6) wanted.push("Bitdefender Endpoint"); }
                if (d.customer === 5 && /ADMIN|TEACH/.test(d.host)) wanted.push("School Gradebook Client");
            }
            const first = pool.filter((p) => wanted.includes(p[0]));
            const rest = shuffle(pool.filter((p) => !wanted.includes(p[0])));
            for (const [name, publisher, vers] of [...first, ...rest].slice(0, d.software)) add("agent_software", { agent_id: agentId, name, publisher, version: pick(vers), install_date: new Date(now - (20 + rnd(700)) * DAY) });

            // Programs with an update waiting.
            if (!linux && seen) {
                const n = d.outdatedApps ?? (d.kind === "workstation" ? rnd(4) : rnd(2));
                for (const [appId, name, have, avail] of shuffle(WINGET_APPS).slice(0, n)) add("agent_outdated_software", { agent_id: agentId, source: "winget", app_id: appId, name, installed_version: have, available_version: avail, approximate: false, first_seen_at: new Date(now - (3 + rnd(30)) * DAY), scanned_at: new Date(seen.getTime() - rnd(10) * HOUR) });
            }

            // Patch scans over the last weeks: the newest scan is what is missing now, older ones carry patches fixed since.
            const catalog = linux ? LINUX_PATCHES : PATCH_CATALOG;
            const task = (type: "patch_scan" | "patch_install", at: Date, artifacts: Record<string, unknown>, ok = true, output: Record<string, unknown> = { ok: true }) => {
                const taskId = uuid(); const runId = uuid();
                const done = new Date(at.getTime() + 60_000);
                add("agent_tasks", { id: taskId, agent_id: agentId, type, payload: {}, status: ok ? "succeeded" : "failed", queued_at: at, started_at: at, completed_at: done, created_at: at });
                add("agent_task_runs", { id: runId, task_id: taskId, status: ok ? "succeeded" : "failed", started_at: at, finished_at: done, output, created_at: at });
                add("agent_task_results", { run_id: runId, stdout: "", stderr: ok ? "" : String(output.error ?? "failed"), artifacts, created_at: at });
            };
            if (d.patches !== "never" && seen) {
                const finalCount = d.patches === "clean" ? 0 : d.patches === "few" ? 2 + rnd(2) : d.patches === "many" ? 5 + rnd(3) : 3;
                const newestAge = d.patches === "overdue" ? Math.max(19, Math.round((now - seen.getTime()) / DAY) + 1) : rnd(3);
                const scanAges = [newestAge + 28, newestAge + 21, newestAge + 14, newestAge + 7, newestAge];
                const shuffled = shuffle(catalog);
                const current = shuffled.slice(0, finalCount).map((p, i) => ({ id: `demo-${d.host}-${i}`, p, firstAge: 1 + rnd(newestAge + 28) }));
                const fixed = shuffled.slice(finalCount, finalCount + 3).map((p, i) => { const firstAge = newestAge + 8 + rnd(21); return { id: `demo-${d.host}-r${i}`, p, firstAge, fixedAge: Math.max(newestAge + 1, firstAge - (3 + rnd(18))) }; });
                for (const age of scanAges) {
                    const missing = [...current.filter((c) => c.firstAge >= age), ...fixed.filter((f) => f.firstAge >= age && age > f.fixedAge)].map(({ id, p }) => ({ id, title: p.title, severity: p.severity, requiresReboot: p.requiresReboot, kbIds: p.kb ? [p.kb] : [] }));
                    task("patch_scan", new Date(now - age * DAY - rnd(20) * HOUR), { patches: missing, rebootRequired: missing.some((m) => m.requiresReboot) });
                }
                if (d.patches !== "overdue" && d.patches !== "clean") task("patch_install", new Date(now - (newestAge + 4 + rnd(10)) * DAY), linux ? { installed: ["openssl", "libc6"], requiresReboot: false } : { installed: ["KB5043080", "KB5044284"], requiresReboot: false });
                if (d.host === "IRB-ERP-01" || d.host === "BRW-ACCT-02") {
                    // Failed installs: they show in the patch history and explain the missing updates.
                    for (const k of [3, 9, 16]) task("patch_install", new Date(now - k * DAY - rnd(6) * HOUR), { installed: [], failed: ["KB5046613"] }, false, { ok: false, error: "Installation failed: 0x80073712 (component store is corrupt)" });
                }
            }

            // Security scan score and grade.
            if (seen) {
                const score = d.score ?? clamp(Math.round(92 - (d.freePct < 10 ? 12 : 0) - (d.patches === "many" || d.patches === "overdue" ? 14 : d.patches === "few" ? 4 : 0) - (!d.av && !linux ? 25 : 0) - (d.bitlocker === "off" && !linux ? 6 : 0)), 20, 98);
                const failed = Math.round((100 - score) / 4);
                add("device_security_scans", { device_id: deviceId, scanned_at: new Date(seen.getTime() - (2 + rnd(20)) * HOUR), attempted_at: new Date(seen.getTime() - (2 + rnd(20)) * HOUR), ok: true, score, grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F", findings_failed: failed, findings_warned: Math.round(failed / 2), critical_failed: score < 50 ? 2 : score < 70 ? 1 : 0, high_failed: score < 80 ? Math.round(failed / 3) : 0, unknown_count: rnd(3), failed_rules: [] });
            }

            // Availability and disk history for the last 60 days, and a few changes noticed along the way.
            {
                const profile = AVAILABILITY[d.host] ?? 0.98;
                const totalBytes = disks.reduce((s, x) => s + x.totalBytes, 0);
                const nowFree = disks.reduce((s, x) => s + x.freeBytes, 0);
                const drift = DISK_DRIFT[d.host] ?? 0;
                const today = new Date(now);
                const lastSeenAge = seen ? (now - seen.getTime()) / DAY : 60;
                for (let age = 60; age >= 0; age--) {
                    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - age * DAY);
                    const samples = age === 0 ? Math.max(1, today.getUTCHours() * 4) : 96;
                    const gone = age < lastSeenAge - 0.5 && lastSeenAge > 2;
                    const wobble = Math.min(0.06, (1 - profile) * 0.8);
                    const share = gone ? 0 : clamp(profile + (R.next() - 0.5) * wobble - (profile < 0.99 && rnd(20) === 0 ? 0.3 : 0), 0, 1);
                    const pct = Math.max(1, (nowFree / totalBytes) * 100 + (drift * age) / 60 + (R.next() - 0.5) * 0.6);
                    const weekday = day.getUTCDay() >= 1 && day.getUTCDay() <= 5;
                    const businessSamples = weekday ? (age === 0 ? Math.min(40, Math.max(0, (today.getUTCHours() - 8) * 4)) : 40) : 0;
                    const businessShare = gone ? 0 : Math.min(1, share + (1 - share) * 0.8);
                    add("device_daily", { device_id: deviceId, day, samples, online_samples: Math.round(samples * share), business_samples: businessSamples, business_online_samples: Math.round(businessSamples * businessShare), disk_free_pct_min: round1(pct), disk_total_bytes: BigInt(totalBytes), disk_free_bytes: BigInt(Math.round((totalBytes * pct) / 100)) });
                }
                const at = () => new Date(now - (1 + rnd(40)) * DAY - rnd(20) * HOUR);
                for (let i = 0; i < 3 + rnd(5); i++) {
                    const [name, , vers] = pick(pool);
                    const roll = rnd(4);
                    if (roll === 0) add("device_changes", { device_id: deviceId, changed_at: at(), kind: "software_added", summary: `Installed ${name} ${pick(vers)}` });
                    else if (roll === 1) add("device_changes", { device_id: deviceId, changed_at: at(), kind: "software_removed", summary: `Removed ${name} ${pick(vers)}` });
                    else add("device_changes", { device_id: deviceId, changed_at: at(), kind: "software_updated", summary: `Updated ${name} from ${vers[0]} to ${vers[vers.length - 1]}` });
                }
                for (const extra of HARDWARE_CHANGES[d.host] ?? []) add("device_changes", { device_id: deviceId, changed_at: at(), kind: extra.kind, summary: extra.summary });
            }

            // ---- Check results (the device page's Checks tab and performance graphs) ----
            const end = seen?.getTime() ?? null;
            const checks: Check[] = [];
            if (end !== null) {
                const hot = d.hot;
                const cpuNow = hot === "cpu" ? 95 : hot === "both" ? 99 : round1((d.kind === "server" ? 5 : 9) + R.next() * 16);
                const memNow = hot === "memory" ? 93 : hot === "both" ? 98 : round1(32 + R.next() * 34);
                const stat = (v: number, warn: number, crit: number) => (v >= crit ? "CRIT" : v >= warn ? "WARN" : "OK") as "OK" | "WARN" | "CRIT";
                const wave = (t: number, base: number, amp: number) => clamp(base + amp * Math.sin((t / HOUR) * (Math.PI / 12)) + (R.next() - 0.5) * amp * 0.8, 1, 99);
                const times: number[] = [];
                for (let i = 0; i < 48; i++) times.push(end - i * 30 * MIN);
                for (let j = 1; j <= 36; j++) times.push(end - 24 * HOUR - j * 4 * HOUR);
                const cpuHist = times.map((t, i) => { const v = i === 0 ? cpuNow : round1(wave(t, cpuNow > 80 ? 40 : cpuNow, 10)); return { at: t, metrics: { busyPercent: v, thresholds: { warn: 90, crit: 98 } }, status: stat(v, 90, 98), output: `Average ${v}% busy since the last check.` }; });
                checks.push({ key: "builtin:cpu", type: "CPU", name: "CPU usage", status: cpuHist[0].status, output: cpuHist[0].output, metrics: cpuHist[0].metrics, history: cpuHist });
                const totalGb = d.ramGb;
                const memHist = times.map((t, i) => { const v = i === 0 ? memNow : round1(wave(t, memNow > 85 ? 60 : memNow, 6)); const avail = round1(totalGb * (100 - v) / 100); return { at: t, metrics: { usedPercent: v, availableGb: avail, totalGb, thresholds: { warn: 90, crit: 97 } }, status: stat(v, 90, 97), output: `${v}% in use; ${avail} GB available of ${totalGb} GB.` }; });
                checks.push({ key: "builtin:memory", type: "MEMORY", name: "Memory usage", status: memHist[0].status, output: memHist[0].output, metrics: memHist[0].metrics, history: memHist });
                for (const k of disks) {
                    const mount = String(k.mount).length > 1 ? String(k.mount).replace(/[\\/]+$/, "") : String(k.mount);
                    const pctNow = round1((k.freeBytes / k.totalBytes) * 100);
                    const dr = DISK_DRIFT[d.host] ?? 0;
                    const hist = times.map((t, i) => { const days = (end - t) / DAY; const p = i === 0 ? pctNow : round1(clamp(pctNow + (dr * days) / 60 + (R.next() - 0.5) * 0.2, 1, 99)); const fg = round1((k.totalBytes / GB) * p / 100); const tg = round1(k.totalBytes / GB); return { at: t, metrics: { freePercent: p, freeGb: fg, totalGb: tg, thresholds: { warn: 10, crit: 5 } }, status: (p <= 5 ? "CRIT" : p <= 10 ? "WARN" : "OK") as "OK" | "WARN" | "CRIT", output: `${mount} has ${fg} GB free of ${tg} GB (${p}%).` }; });
                    checks.push({ key: `builtin:disk:${mount.toLowerCase()}`, type: "DISK", name: `Disk free ${mount}`, status: hist[0].status, output: hist[0].output, metrics: hist[0].metrics, history: hist });
                }
                const svc = [...(linux ? ["sshd"] : d.kind === "server" ? ["W32Time"] : ["WinDefend"]), ...(d.services ?? [])];
                for (const name of [...new Set(svc)]) {
                    const down = d.downService === name;
                    checks.push({ key: `service:${name.toLowerCase()}`, type: "SERVICE", name: `Service: ${name}`, status: down ? "CRIT" : "OK", output: down ? `${name} is not running (Stopped).` : `${name} is running.`, metrics: {} });
                }
                checks.push({ key: "builtin:server", type: "PORT", name: "Connection to server", status: "OK", output: `Connected to rmm.example.test:443 in ${12 + rnd(40)} ms.`, metrics: { connectMs: 12 + rnd(40) } });
                const oldAgent = cmpVersion(agentVersion, newestAgent) < 0 && ["BRW-ACCT-02", "LRK-POS-02", "IRB-PLANT-PC-01", "LRK-SRV-01"].includes(d.host);
                checks.push({ key: "builtin:agent-update", type: "AGENT", name: "Agent update", status: oldAgent ? "WARN" : "OK", output: oldAgent ? `Running ${agentVersion}. The update to ${newestAgent} did not complete (failed) at ${new Date(now - 2 * DAY).toISOString()}. Not enough disk space to unpack the update.` : `Running ${agentVersion}.`, metrics: oldAgent ? { version: agentVersion, failedVersion: newestAgent } : { version: agentVersion } });
                if (cmpVersion(agentVersion, IO_MIN_AGENT) >= 0) {
                    const rx = d.kind === "server" ? 900_000 : 250_000;
                    const netHist = times.map((t, i) => { const r = Math.round(wave(t, 50, 40) / 50 * rx * (0.3 + R.next())); const x = Math.round(r * (0.2 + R.next() * 0.4)); return { at: t, metrics: { rxBytesPerSec: r, txBytesPerSec: x, intervalSec: 1800, adapters: 1 }, status: "OK" as const, output: `Received ${(r / 1024).toFixed(1)} KB/s, sent ${(x / 1024).toFixed(1)} KB/s (average over 30.0 minutes).` }; });
                    checks.push({ key: "builtin:network", type: "NETWORK", name: "Network traffic", status: "OK", output: netHist[0].output, metrics: netHist[0].metrics, history: netHist });
                    const ioHist = times.map((t) => { const r = Math.round(wave(t, 50, 40) / 50 * (d.kind === "server" ? 2_500_000 : 600_000) * (0.3 + R.next())); const w = Math.round(r * (0.4 + R.next() * 0.8)); return { at: t, metrics: { readBytesPerSec: r, writeBytesPerSec: w, intervalSec: 1800, devices: 1 }, status: "OK" as const, output: `Read ${(r / 1024).toFixed(1)} KB/s, wrote ${(w / 1024).toFixed(1)} KB/s (average over 30.0 minutes).` }; });
                    checks.push({ key: "builtin:diskio", type: "DISKIO", name: "Disk activity", status: "OK", output: ioHist[0].output, metrics: ioHist[0].metrics, history: ioHist });
                }
            }
            const assignmentByKey = new Map<string, string>();
            for (const c of checks) {
                const aid = uuid();
                assignmentByKey.set(c.key, aid);
                add("check_assignments", { id: aid, target_type: "device", target_id: deviceId, dedupe_key: c.key, check_type: c.type, check_name: c.name, created_at: new Date(now - 40 * DAY), updated_at: new Date(end ?? now) });
                const hist = c.history ?? [{ at: end!, metrics: c.metrics, status: c.status, output: c.output }, { at: end! - 6 * HOUR, metrics: c.metrics, status: c.key.startsWith("service:") || c.key === "builtin:server" || c.key === "builtin:agent-update" ? "OK" as const : c.status, output: c.output }];
                for (const h of hist) add("check_runs", { assignment_id: aid, device_id: deviceId, status: h.status, severity: h.status === "OK" ? null : h.status === "WARN" ? "medium" : "critical", started_at: new Date(h.at - 4000), finished_at: new Date(h.at), metrics: h.metrics, output: h.output, created_at: new Date(h.at) });
            }

            // ---- Alerts: open ones follow the check results, plus history and a few in other states ----
            const alertRows: any[] = [];
            alertsByHost.set(d.host, alertRows);
            const alertEvent = (alertId: string, type: string, at: Date, reason: string | null, actor: string | null = null) => add("alert_events", { id: uuid(), alert_id: alertId, type, actor_user_id: actor, reason, created_at: at });
            const mkAlert = (o: { kind: string; key: string; sev: string; title: string; detail: string; state: "OPEN" | "ACKED" | "SILENCED" | "RESOLVED"; firstHoursAgo: number; assignment?: string | null }) => {
                const id = uuid();
                const first = new Date(now - o.firstHoursAgo * HOUR);
                const resolved = o.state === "RESOLVED" ? new Date(first.getTime() + (1 + rnd(30)) * HOUR) : null;
                const lastSeen = resolved ?? (seen && o.kind !== "offline" ? seen : new Date(first.getTime() + 10 * MIN));
                const row = {
                    id, device_id: deviceId, assignment_id: o.assignment ?? null, kind: o.kind, dedupe_key: o.key, state: o.state, severity: o.sev, title: o.title, detail: o.detail,
                    open_count: 1 + rnd(o.state === "RESOLVED" ? 3 : 6), first_seen_at: first, last_seen_at: lastSeen, state_changed_at: resolved ?? (o.state === "OPEN" ? first : new Date(first.getTime() + 25 * MIN)),
                    silenced_until: o.state === "SILENCED" ? new Date(now + (2 + rnd(5)) * DAY) : null, resolved_at: resolved, last_notified_at: o.state === "RESOLVED" ? first : null, ticket_id: null as string | null,
                };
                add("alerts", row); alertRows.push(row);
                alertEvent(id, "opened", first, null);
                if (o.state === "RESOLVED") alertEvent(id, "resolved", resolved!, pick(["The check is passing again.", "Cleared by a technician.", "The device is back online."]));
                if (o.state === "ACKED") alertEvent(id, "acked", new Date(first.getTime() + 25 * MIN), "Looking into it.", techs[rnd(techs.length)].id);
                if (o.state === "SILENCED") alertEvent(id, "silenced", new Date(first.getTime() + 25 * MIN), "Known issue, replacement planned.", techs[rnd(techs.length)].id);
                return row;
            };
            const offlineHours = seen ? (now - seen.getTime()) / HOUR : null;
            if (offlineHours !== null && offlineHours > 0.25) {
                mkAlert({ kind: "offline", key: `offline:${deviceId}`, sev: "CRIT", title: `${d.host} is offline`, detail: `Last seen ${seen!.toISOString()}.`, state: "OPEN", firstHoursAgo: Math.max(0.1, offlineHours - 0.1) });
            }
            if (offlineHours !== null && offlineHours <= 0.25) {
                let k = 0;
                for (const c of checks) {
                    if (c.status === "OK") continue;
                    const state = k++ % 4 === 3 ? "ACKED" : "OPEN";
                    mkAlert({ kind: "check", key: `check:${assignmentByKey.get(c.key)}`, sev: c.status, title: `${c.name} on ${d.host}`, detail: c.output, state, firstHoursAgo: 2 + rnd(60), assignment: assignmentByKey.get(c.key) });
                }
            }
            for (const [sev, title, detail, state, hrs] of d.extraAlerts ?? []) mkAlert({ kind: /Backup/i.test(title) ? "backup" : "check", key: `demo:${uuid()}`, sev, title, detail, state, firstHoursAgo: hrs });
            for (let i = 0; i < d.alerts; i++) {
                const [sev, title, detail] = pick(linux ? LINUX_ALERTS : ALERTS);
                mkAlert({ kind: "check", key: `demo:${uuid()}`, sev, title: `${title} on ${d.host}`, detail, state: "RESOLVED", firstHoursAgo: (2 + rnd(26)) * 24 + rnd(20) });
            }

            // Script runs over the last month, most working and some failing.
            const scripts = linux ? LINUX_SCRIPTS : SCRIPTS;
            for (let i = 0; seen && i < 4 + rnd(6); i++) {
                const name = pick(scripts);
                const at = new Date(now - (1 + rnd(28)) * DAY - rnd(20) * HOUR);
                const failed = rnd(6) === 0;
                const timedOut = !failed && rnd(25) === 0;
                const jobId = uuid();
                const dur = (3 + rnd(90)) * 1000;
                add("jobs", { id: jobId, agent_id: agentId, type: "script", payload: { script: name }, status: failed ? "failed" : timedOut ? "timeout" : "succeeded", created_at: at, dispatched_at: at, started_at: at, finished_at: new Date(at.getTime() + dur) });
                add("job_results", { job_id: jobId, exit_code: failed ? 1 + rnd(3) : timedOut ? -1 : 0, stdout: failed ? "" : "Completed.", stderr: failed ? pick(["Access is denied.", "The term 'Get-Thing' is not recognized as a cmdlet", "Service did not respond within 30 seconds", "Could not find a part of the path"]) : timedOut ? "Timed out waiting for the script to finish" : "", duration_ms: BigInt(dur) });
                add("script_runs", { id: uuid(), script_name: name, job_id: jobId, device_id: deviceId, created_at: at, triggered_by: techs[rnd(techs.length)].id });
            }

            // Remote sessions by technicians.
            for (let i = 0; i < d.sessions; i++) {
                const tech = techs[rnd(techs.length)];
                addT("audit_events", { id: uuid(), actor_user_id: tech.id, actor_email: tech.email, action: pick(["remote.console.start", "remote.shell.start", "remote.desktop.start"]), category: "remote", target_type: "device", target_id: deviceId, target_label: d.host, ip: `198.51.100.${1 + rnd(200)}`, outcome: i === 0 && d.alerts > 4 ? "denied" : "success", created_at: new Date(now - (1 + rnd(27)) * DAY - rnd(20) * HOUR) });
            }

            // Asset record, with purchase and warranty dates.
            if (d.purchasedYearsAgo !== null) {
                const purchased = new Date(now - d.purchasedYearsAgo * 365.25 * DAY);
                const expires = d.warrantyMonths ? new Date(purchased.getTime() + d.warrantyMonths * 30.4375 * DAY) : null;
                addT("assets", { id: uuid(), organization_id: organizationId, client_id: clientIds[d.customer], device_id: deviceId, name: d.host, kind: d.kind === "server" ? "server" : "workstation", manufacturer: d.model.split(" ")[0], model: d.model, serial_number: `DEMO-${d.host}`, location: d.site, purchase_date: purchased, expires_at: expires, source: "demo", details: {} });
            }
        }

        // Equipment that is not a managed endpoint: firewalls, printers and licences with their renewal dates.
        const extraAssets: Array<[number, string, string, string, string, number, string | null, number | null]> = [
            [0, "Clinic firewall", "network", "Fortinet", "FortiGate 40F", 3.1, "Main clinic", 22], [0, "Reception printer", "printer", "Brother", "HL-L6200DW", 2.0, "Main clinic", 180], [0, "Microsoft 365 Business Premium (14 seats)", "license", "Microsoft", "Business Premium", 1.0, null, 41],
            [1, "Office firewall", "network", "Fortinet", "FortiGate 60F", 2.6, "Downtown", 140], [1, "Floor 4 copier", "printer", "Ricoh", "IM C3000", 3.5, "Downtown", -45], [1, "Microsoft 365 Business Premium (22 seats)", "license", "Microsoft", "Business Premium", 1.0, null, 63],
            [2, "Office firewall", "network", "SonicWall", "TZ370", 2.2, "Head office", 330], [2, "Tax software licence", "license", "Example Tax Software", "Pro 2027", 0.3, null, 345],
            [3, "Store 1 router", "network", "Ubiquiti", "UniFi Dream Machine Pro", 1.5, "Store 1", 400], [3, "Receipt printers (6)", "printer", "Epson", "TM-T88VII", 2.2, "Store 1", 200],
            [4, "Plant firewall", "network", "Fortinet", "FortiGate 100F", 4.5, "Plant", -120], [4, "Core switch", "network", "Aruba", "2930F 48G", 5.8, "Office", -300], [4, "CAD software subscription (8 seats)", "license", "Example CAD Vendor", "Design Suite", 0.7, null, 29],
            [5, "Campus firewall", "network", "Fortinet", "FortiGate 80F", 3.2, "Main building", 90], [5, "Classroom projectors (12)", "other", "Epson", "PowerLite 1781W", 4.0, "Main building", -200], [5, "Web filter licence", "license", "Example Filter Co.", "Education 500", 1.0, null, 18],
        ];
        for (const [ci, name, kind, maker, model, years, location, expiresIn] of extraAssets) {
            addT("assets", { id: uuid(), organization_id: organizationId, client_id: clientIds[ci], device_id: null, name, kind, manufacturer: maker, model, serial_number: `DEMO-${crypto.createHash("sha1").update(name + ci).digest("hex").slice(0, 8).toUpperCase()}`, location, purchase_date: new Date(now - years * 365.25 * DAY), expires_at: expiresIn === null ? null : new Date(now + expiresIn * DAY), source: "manual", details: {} });
        }

        // More audit trail: sign-ins and changes by the technicians.
        const actions: Array<[string, string, string]> = [["auth.login", "auth", "success"], ["auth.login", "auth", "success"], ["auth.login", "auth", "failed"], ["ticket.reply", "tickets", "success"], ["ticket.update", "tickets", "success"], ["device.script.run", "devices", "success"], ["customer.update", "customers", "success"], ["billing.invoice.send", "billing", "success"], ["policy.update", "policies", "success"], ["alert.ack", "alerts", "success"]];
        for (let i = 0; i < 70; i++) {
            const [action, category, outcome] = pick(actions);
            const tech = techs[rnd(techs.length)];
            addT("audit_events", { id: uuid(), actor_user_id: tech.id, actor_email: tech.email, action, category, target_type: null, target_id: null, target_label: category === "tickets" ? `Ticket ${1001 + rnd(40)}` : null, ip: `198.51.100.${1 + rnd(200)}`, user_agent: "Mozilla/5.0 (demo)", outcome, created_at: new Date(now - rnd(14 * 24) * HOUR - rnd(60) * MIN) });
        }

        // Software each demo customer must and must not have, and rules for everyone.
        const swPolicies: Array<[number | null, string, string]> = [[null, "banned", "Adobe Flash"], [null, "banned", "Java 8"], [0, "required", "Windows Defender"], [0, "required", "Dentrix"], [1, "required", "Clio Manage"], [1, "banned", "TeamViewer"], [2, "required", "QuickBooks Desktop"], [4, "required", "Bitdefender Endpoint"], [5, "banned", "Dropbox"]];
        for (const [ci, kind, pattern] of swPolicies) addT("software_policies", { id: uuid(), organization_id: organizationId, client_id: ci === null ? null : clientIds[ci], kind, pattern, note: "Demo policy" });

        // ---- Service desk -------------------------------------------------------------------------------------------------
        const calendarId = uuid();
        addT("sla_calendars", { id: calendarId, organization_id: organizationId, name: "Demo: Business hours (Mon to Fri, 8 to 6)", timezone: "UTC", days: [1, 2, 3, 4, 5], start_time: "08:00", end_time: "18:00", holidays: [], created_at: new Date(now - 120 * DAY) });
        const slaId = uuid();
        const slaCreated = now - 120 * DAY;
        const targets = { low: { response: 1440, resolution: 14400 }, medium: { response: 480, resolution: 7200 }, high: { response: 240, resolution: 3000 }, urgent: { response: 60, resolution: 1200 } };
        addT("sla_policies", { id: slaId, organization_id: organizationId, name: "Demo: Standard support", description: "Response and resolution targets by priority, counted in working hours.", calendar_id: calendarId, is_default: !hasDefaultSla, enabled: true, targets, pause_statuses: ["pending"], warn_percent: 80, escalation: {}, created_at: new Date(slaCreated), updated_at: new Date(slaCreated) });
        const policy: PolicySpec = { id: slaId, name: "Demo: Standard support", targets, pauseStatuses: ["pending"], warnPercent: 80, createdAt: slaCreated };
        const calendar: Calendar = { timezone: "UTC", days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", holidays: [] };
        const queueIds = ["Helpdesk", "Projects", "Alerts and monitoring"].map((name, i) => { const id = uuid(); addT("ticket_queues", { id, organization_id: organizationId, name: `Demo: ${name}`, description: ["Everyday requests from users", "Planned work: onboarding, upgrades, quotes", "Tickets opened by monitoring alerts"][i], enabled: true, assignment: "none", pool_user_ids: [] }); return id; });

        const kbIds = KB.map(() => uuid());
        const sorted = [...TICKETS].sort((a, b) => b.age - a.age);
        const clientsOf = (ci: number) => clientIds[ci];
        const timeEntries: any[] = [];
        const ticketIdByIndex = new Map<TicketSeedRef, string>();
        type TicketSeedRef = (typeof TICKETS)[number];
        const toDate = (ms: number) => new Date(Math.round(ms / MIN) * MIN);
        const stateOf = (s: SlaState) => s;
        const markClock = (c: Clock): Clock => {
            // The sweeper records a warning and a breach once each; the demo has to do the same by hand.
            const x = { ...c };
            if (x.doneAt === null && x.runningSince !== null) {
                if (x.warnAt !== null && x.warnAt <= now && x.warnedAt === null) x.warnedAt = x.warnAt;
                if (x.dueAt !== null && x.dueAt <= now && x.breachedAt === null) { x.breachedAt = x.dueAt; x.warnedAt = x.warnedAt ?? x.warnAt ?? x.dueAt; }
            }
            return x;
        };
        for (const s of sorted) {
            const id = uuid();
            ticketIdByIndex.set(s, id);
            const created = now - s.age * HOUR;
            const assignee = staff(s.who);
            const deviceId = s.host ? deviceIdByHost.get(s.host) ?? null : null;
            const finished = s.status === "resolved" || s.status === "closed";
            // Conversation.
            const acts: any[] = [];
            let t = created + 5 * MIN;
            let firstReply: number | null = null;
            let lastAt = created;
            if (assignee) acts.push({ kind: "change", at: created + 2 * MIN, author: "System", field: "assignee", from: "-", to: assignee.name, body: `assignee: - -> ${assignee.name}`, internal: true });
            for (const [who, after, text, minutes] of s.steps) {
                t += after * HOUR;
                if (t > now) t = now - 5 * MIN;
                lastAt = t;
                const contactName = contactNames[s.cust][s.contact];
                if (who === "c") acts.push({ kind: "message", at: t, author: contactName, body: text, inbound: true, internal: false, via: s.via === "portal" ? "portal" : null });
                else if (who === "r") { if (firstReply === null) firstReply = t; acts.push({ kind: "message", at: t, author: assignee?.name ?? techs[0].name, body: text, internal: false, notify: true, seconds: (minutes ?? 0) * 60 }); }
                else acts.push({ kind: "note", at: t, author: assignee?.name ?? techs[0].name, body: text, internal: true, handoff: who === "h", seconds: (minutes ?? 0) * 60 });
                if (minutes && who !== "c") timeEntries.push({ tech: assignee ?? techs[0], at: t, minutes, ticketId: id, cust: s.cust, note: text.slice(0, 90) });
            }
            if (s.status !== "open" && (acts.length || assignee)) {
                const from = "open";
                const to = s.status === "in_progress" ? "in_progress" : s.status;
                const when = finished ? lastAt + 10 * MIN : Math.min(now - 5 * MIN, (firstReply ?? created + 20 * MIN) + 2 * MIN);
                acts.push({ kind: "change", at: when, author: assignee?.name ?? "System", field: "status", from, to, body: `status: ${from} -> ${to}`, internal: true });
                if (finished) lastAt = when;
            }
            if (!finished && s.status === "pending") lastAt = Math.max(lastAt, now - 2 * HOUR);
            // SLA clocks, brought up to date step by step the way the service desk would have.
            const pri = s.pri === "normal" ? "medium" : s.pri;
            let sla = reconcile(null, { now: created, createdAt: created, status: "open", priority: pri as any, policy, calendar, respondedAt: null });
            if (firstReply !== null) sla = reconcile(sla, { now: firstReply, createdAt: created, status: finished || s.status === "pending" ? "open" : "in_progress", priority: pri as any, policy, calendar, respondedAt: firstReply });
            const settleAt = finished ? lastAt : s.status === "pending" ? lastAt : now;
            sla = reconcile(sla, { now: Math.min(settleAt, now), createdAt: created, status: s.status, priority: pri as any, policy, calendar, respondedAt: firstReply });
            if (!finished) sla = reconcile(sla, { now, createdAt: created, status: s.status, priority: pri as any, policy, calendar, respondedAt: firstReply });
            sla = stateOf({ ...sla, response: markClock(sla.response), resolution: markClock(sla.resolution) });
            const dueAt = sla.resolution.dueAt ?? (sla.resolution.targetMin ? created + sla.resolution.targetMin * MIN : null);
            ticketNumber += 1;
            addT("tickets", {
                id, organization_id: organizationId, ticket_number: BigInt(ticketNumber), device_id: deviceId, subject: s.subject, description: s.desc, status: s.status, priority: s.pri,
                assignee_user_id: assignee?.id ?? null, created_at: toDate(created), updated_at: toDate(lastAt), closed_at: finished ? toDate(lastAt) : null, due_at: dueAt ? new Date(dueAt) : null,
                client_id: clientsOf(s.cust), queue_id: queueIds[s.queue], created_via: s.via, requester_customer_contact_id: contactIds[s.cust][s.contact], custom_fields: {},
            });
            // The ticket_devices row for the main device is added by a database trigger.
            for (const tag of s.tags ?? []) add("ticket_tags", { ticket_id: id, tag, created_at: toDate(created) });
            // Oldest first, with distinct timestamps (history lists newest first).
            acts.sort((a, b) => a.at - b.at).forEach((a, i) => add("ticket_activity", {
                id: uuid(), ticket_id: id, kind: a.kind, body: a.body ?? "", attachments: [], time_worked_seconds: a.seconds ?? 0, notify_customer: !!a.notify, author: a.author, created_at: new Date(Math.min(now, a.at) + i),
                is_internal: !!a.internal, is_handoff: !!a.handoff, is_inbound: !!a.inbound, via: a.via ?? null, field: a.field ?? null, from_value: a.from ?? null, to_value: a.to ?? null,
            }));
            const r = sla.response, x = sla.resolution;
            const dd = (n: number | null) => (n === null ? null : new Date(n));
            add("ticket_sla", {
                ticket_id: id, policy_id: slaId, policy_name: sla.policyName, priority: sla.priority, status: sla.status, paused: sla.paused, warn_percent: sla.warnPercent,
                response_target_min: r.targetMin, response_used_ms: BigInt(Math.round(r.usedMs)), response_running_since: dd(r.runningSince), response_due_at: dd(r.dueAt), response_warn_at: dd(r.warnAt), response_done_at: dd(r.doneAt), response_met: r.met, response_warned_at: dd(r.warnedAt), response_breached_at: dd(r.breachedAt),
                resolution_target_min: x.targetMin, resolution_used_ms: BigInt(Math.round(x.usedMs)), resolution_running_since: dd(x.runningSince), resolution_due_at: dd(x.dueAt), resolution_warn_at: dd(x.warnAt), resolution_done_at: dd(x.doneAt), resolution_met: x.met, resolution_warned_at: dd(x.warnedAt), resolution_breached_at: dd(x.breachedAt), updated_at: new Date(lastAt),
            });
            // Surveys for solved tickets: an answer when there is one, otherwise recorded as not sent.
            if (finished) {
                const answeredAt = lastAt + (4 + rnd(20)) * HOUR;
                const base = { id: uuid(), organization_id: organizationId, ticket_id: id, client_id: clientsOf(s.cust), recipient_email: contactEmails[s.cust][s.contact], recipient_name: contactNames[s.cust][s.contact], technician_user_id: assignee?.id ?? null, created_at: new Date(lastAt) };
                if (s.survey && answeredAt < now) add("ticket_surveys", { ...base, status: "answered", attempts: 1, triggered_at: new Date(lastAt + HOUR), sent_at: new Date(lastAt + HOUR), expires_at: new Date(lastAt + 30 * DAY), answered_at: new Date(answeredAt), answered_via: "email", score: s.survey[0], comment: s.survey[1] || null });
                else add("ticket_surveys", { ...base, status: "skipped", skip_reason: "No survey is sent for demo tickets.", attempts: 0, next_attempt_at: new Date(now + 3650 * DAY) });
            }
            for (const k of s.kb ?? []) add("kb_ticket_links", { ticket_id: id, article_id: kbIds[k], linked_by: assignee?.id ?? null, created_at: new Date(lastAt) });
        }
        // Tickets opened from an alert: tie them to the device's open alert.
        for (const s of TICKETS) {
            if (s.via !== "alert" || !s.host) continue;
            const open = (alertsByHost.get(s.host) ?? []).find((a) => a.state !== "RESOLVED" && !a.ticket_id);
            if (open) { open.ticket_id = ticketIdByIndex.get(s)!; add("alert_events", { id: uuid(), alert_id: open.id, type: "ticket-opened", actor_user_id: null, reason: null, created_at: new Date(open.first_seen_at.getTime() + 20 * MIN) }); }
        }

        // Canned replies and ticket templates.
        for (const [title, body] of CANNED) addT("canned_responses", { id: uuid(), organization_id: organizationId, title, body, is_active: true });
        TEMPLATES.forEach((tpl, i) => addT("ticket_templates", { id: uuid(), organization_id: organizationId, name: tpl.name, hint: tpl.hint, subject: tpl.subject, body: tpl.body, priority: tpl.priority, custom_fields: {}, sort_order: i }));

        // ---- Knowledge base -----------------------------------------------------------------------------------------------
        const catIds = KB_CATEGORIES.map((name, i) => { const id = uuid(); addT("kb_categories", { id, organization_id: organizationId, name, sort_order: i }); return id; });
        KB.forEach((a, i) => {
            const created = new Date(now - (30 + i * 13) * DAY);
            const updated = a.edited ? new Date(now - (4 + i) * DAY) : created;
            addT("kb_articles", { id: kbIds[i], organization_id: organizationId, category_id: catIds[a.cat], title: a.title, body: a.body, tags: a.tags, status: a.status, customer_visible: a.visible, author_user_id: techs[i % techs.length].id, updated_by: techs[(i + 1) % techs.length].id, version: a.edited ? 2 : 1, view_count: a.views, helpful_count: a.helpful, unhelpful_count: a.unhelpful, created_at: created, updated_at: updated, published_at: a.status === "published" ? created : null });
            add("kb_article_versions", { id: uuid(), article_id: kbIds[i], version: 1, title: a.title, body: a.body, tags: a.tags, saved_by: techs[i % techs.length].id, saved_at: created, note: "First version" });
            if (a.edited) add("kb_article_versions", { id: uuid(), article_id: kbIds[i], version: 2, title: a.title, body: a.body, tags: a.tags, saved_by: techs[(i + 1) % techs.length].id, saved_at: updated, note: "Clearer steps and a technician section" });
        });

        // ---- Billing ------------------------------------------------------------------------------------------------------
        const catalog: Array<[string, string, number, boolean]> = [
            ["Managed endpoint (per device per month)", "Monitoring, patching, antivirus and help desk for one workstation or laptop", 5900, false],
            ["Managed server (per server per month)", "Monitoring, patching, backup checks and priority support for one server", 14900, false],
            ["Help desk time: standard hours", "Billed per hour, weekdays 8 to 6", 13500, false], ["Help desk time: after hours", "Evenings, weekends and holidays", 20250, false],
            ["Project engineering (hourly)", "Planned projects: migrations, upgrades, network work", 16500, false], ["Onsite visit (half day)", "Onsite technician, up to four hours", 38000, false],
            ["Microsoft 365 Business Premium (per user per month)", "Licence, passed through at cost plus handling", 2600, false], ["Cloud backup storage (per TB per month)", "Encrypted offsite backup storage", 8900, false],
            ["Business laptop, standard build", "Business-class laptop, imaged and delivered", 124900, true], ["24 inch monitor", "Full HD monitor with cables", 18900, true],
            ["Managed firewall (per site per month)", "Firewall licence, updates and configuration backups", 9900, false], ["Domain and DNS management (per domain per year)", "Registration and DNS hosting", 3500, false],
        ];
        catalog.forEach(([name, description, price, taxable]) => { const id = uuid(); addT("catalog_items", { id, organization_id: organizationId, name: freeName(name, takenCatalog), description, unit_price_cents: price, taxable, active: true, created_at: new Date(now - 200 * DAY) }); });

        // Contracts, one per customer: two renew soon.
        type ContractSeed = { cust: number; kind: "flat" | "per_device" | "per_user" | "block_hours" | "hourly"; name: string; price: number; qty: number | null; endsInDays: number; months: number };
        const contractSeeds: ContractSeed[] = [
            { cust: 0, kind: "per_device", name: "Managed services: per device", price: 5900, qty: null, endsInDays: 38, months: 22 },
            { cust: 1, kind: "per_user", name: "Managed services: per user", price: 12500, qty: 22, endsInDays: 190, months: 14 },
            { cust: 2, kind: "flat", name: "Managed services: flat monthly", price: 249900, qty: null, endsInDays: 21, months: 24 },
            { cust: 3, kind: "per_device", name: "Managed retail IT: per device", price: 4900, qty: null, endsInDays: 260, months: 8 },
            { cust: 4, kind: "flat", name: "Managed services: plant and office", price: 549000, qty: null, endsInDays: 330, months: 17 },
            { cust: 5, kind: "per_user", name: "Managed school IT: per seat", price: 800, qty: 85, endsInDays: 120, months: 11 },
        ];
        const firstOfMonth = (monthsAgo: number) => { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsAgo, 1)); };
        const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
        const contractIds: string[] = [];
        for (const c of contractSeeds) {
            const id = uuid(); contractIds[c.cust] = id;
            addT("contracts", { id, organization_id: organizationId, client_id: clientIds[c.cust], name: `${DEMO_PREFIX}${c.name}`, kind: c.kind, status: "active", billing_interval_months: 1, start_date: new Date(now - c.months * 30 * DAY), end_date: new Date(now + c.endsInDays * DAY), next_invoice_date: firstOfMonth(-1), price_cents: c.price, quantity: c.qty, taxable: false, notes: c.endsInDays < 60 ? "Renewal due: send proposal." : null, created_at: new Date(now - c.months * 30 * DAY) });
        }
        const deviceCount = (ci: number) => FLEET.filter((d) => d.customer === ci).length;

        // Invoices: three past months and the current one, in different states.
        let invoiceNo = settings?.next_invoice_number ?? 1001;
        const existingNumbers = new Set((await this.prisma.invoices.findMany({ where: { organization_id: organizationId }, select: { number: true } })).map((i) => i.number));
        const nextNumber = (kind: "invoice" | "quote") => { const prefix = kind === "invoice" ? invoicePrefix : quotePrefix; let n = kind === "invoice" ? invoiceNo++ : quoteNo++; while (existingNumbers.has(`${prefix}${n}`)) n = kind === "invoice" ? invoiceNo++ : quoteNo++; existingNumbers.add(`${prefix}${n}`); return `${prefix}${n}`; };
        let quoteNo = settings?.next_quote_number ?? 1001;
        const states: Record<number, Array<"paid" | "partial" | "overdue" | "sent" | "draft">> = {
            0: ["paid", "paid", "paid", "sent"], 1: ["paid", "paid", "partial", "sent"], 2: ["paid", "paid", "overdue", "sent"],
            3: ["paid", "overdue", "overdue", "draft"], 4: ["paid", "paid", "paid", "draft"], 5: ["paid", "paid", "paid", "draft"],
        };
        const invoiceRows: any[] = [];
        const invoicedTime: any[] = [];
        const paymentRows: any[] = [];
        const timeByClient = new Map<number, any[]>();
        for (const e of timeEntries) { const l = timeByClient.get(e.cust) ?? []; l.push(e); timeByClient.set(e.cust, l); }
        let payNo = 0;
        const methods = ["ach", "card", "check"];
        for (const c of contractSeeds) {
            for (let m = 3; m >= 0; m--) {
                const state = states[c.cust][3 - m];
                const issue = firstOfMonth(m);
                const terms = c.cust === 1 ? 15 : c.cust === 4 ? 45 : 30;
                const due = addDays(issue, terms);
                const periodEnd = addDays(firstOfMonth(m - 1), -1);
                const monthName = issue.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
                const count = c.kind === "per_device" ? deviceCount(c.cust) : c.kind === "per_user" ? c.qty! : 1;
                const lines: Array<{ description: string; qty: number; price: number; taxable: boolean; time?: boolean }> = [{ description: `${c.name} (${monthName})${c.kind === "flat" ? "" : `, ${count} ${c.kind === "per_device" ? "devices" : c.cust === 5 ? "seats" : "users"}`}`, qty: c.kind === "flat" ? 1 : count, price: c.price, taxable: false }];
                if (c.cust === 2 || c.cust === 3) lines.push({ description: "Managed firewall (per site)", qty: c.cust === 2 ? 2 : 3, price: 9900, taxable: false });
                if (m >= 1 && [0, 1, 3, 4].includes(c.cust)) { const h = [2.5, 4, 1.5, 6][[0, 1, 3, 4].indexOf(c.cust)] + (m === 2 ? 1 : 0); lines.push({ description: `Help desk time beyond the plan (${monthName})`, qty: h, price: 13500, taxable: false, time: true }); }
                if (m === 1 && c.cust === 3) lines.push({ description: "24 inch monitor", qty: 2, price: 18900, taxable: true });
                if (m === 2 && c.cust === 4) lines.push({ description: "Onsite visit (half day): plant network", qty: 1, price: 38000, taxable: false });
                const taxBps = lines.some((l) => l.taxable) ? 825 : 0;
                const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0);
                const tax = Math.round(lines.filter((l) => l.taxable).reduce((s, l) => s + Math.round(l.qty * l.price), 0) * taxBps / 10000);
                const total = subtotal + tax;
                const id = uuid();
                const status = state === "draft" ? "draft" : state === "paid" ? "paid" : state === "partial" ? "partial" : "sent";
                const paid = state === "paid" ? total : state === "partial" ? Math.round(total / 2) : 0;
                const row = { id, organization_id: organizationId, client_id: clientIds[c.cust], contract_id: contractIds[c.cust], kind: "invoice", number: state === "draft" ? null : nextNumber("invoice"), status, currency: "USD", tax_rate_bps: taxBps, subtotal_cents: subtotal, tax_cents: tax, total_cents: total, paid_cents: paid, issue_date: state === "draft" ? null : issue, due_date: state === "draft" ? null : due, period_start: issue, period_end: periodEnd, recipient_email: `billing@${CUSTOMERS[c.cust].domain}`, notes: null, sent_at: state === "draft" ? null : addDays(issue, 0), created_at: addDays(issue, -1), updated_at: addDays(issue, 1) };
                invoiceRows.push(row);
                addT("invoices", row);
                lines.forEach((l, i) => {
                    const lineId = uuid();
                    add("invoice_lines", { id: lineId, invoice_id: id, position: i, description: l.description, quantity: l.qty, unit_price_cents: l.price, amount_cents: Math.round(l.qty * l.price), taxable: l.taxable });
                    // The hours on this line are real time entries, already billed: they show as invoiced on the time sheet.
                    if (l.time && state !== "draft") for (let k = 0; k < 3; k++) { const tech = techs[(c.cust + k) % techs.length]; invoicedTime.push({ id: uuid(), organization_id: organizationId, user_id: tech.id, client_id: clientIds[c.cust], ticket_id: null, work_date: addDays(issue, -(4 + k * 8)), minutes: Math.round((l.qty * 60) / 3), billable: true, note: ["Remote support sessions", "Patch review and user requests", "Phone support"][k], status: "approved", approved_by: techs[0].id, approved_at: addDays(issue, -1), invoice_line_id: lineId, created_at: addDays(issue, -(4 + k * 8)), updated_at: addDays(issue, -1) }); }
                });
                if (paid > 0) {
                    const parts = state === "paid" && m === 3 && c.cust % 2 === 0 ? [Math.round(total / 2), total - Math.round(total / 2)] : [paid];
                    parts.forEach((amt, k) => { const method = methods[(c.cust + m + k) % 3]; paymentRows.push({ id: uuid(), invoice_id: id, amount_cents: amt, method, reference: `${method === "check" ? "CHK" : method.toUpperCase()}-DEMO-${String(++payNo).padStart(4, "0")}`, paid_at: addDays(due, -(3 + k * 6 + rnd(5))), created_at: addDays(due, -(3 + k * 6)) }); });
                }
            }
        }
        // A voided duplicate, a project invoice and three quotes.
        const extraInvoice = (ci: number, status: "void" | "sent" | "paid", issueAgo: number, items: Array<[string, number, number, boolean]>, notes: string | null) => {
            const id = uuid(); const issue = new Date(now - issueAgo * DAY); const due = addDays(issue, 30);
            const taxable = items.filter((i) => i[3]).reduce((s, i) => s + Math.round(i[1] * i[2]), 0);
            const subtotal = items.reduce((s, i) => s + Math.round(i[1] * i[2]), 0); const tax = Math.round(taxable * 825 / 10000); const total = subtotal + tax;
            const row = { id, organization_id: organizationId, client_id: clientIds[ci], contract_id: null, kind: "invoice", number: nextNumber("invoice"), status, currency: "USD", tax_rate_bps: taxable ? 825 : 0, subtotal_cents: subtotal, tax_cents: tax, total_cents: total, paid_cents: status === "paid" ? total : 0, issue_date: issue, due_date: due, period_start: null, period_end: null, recipient_email: `billing@${CUSTOMERS[ci].domain}`, notes, sent_at: issue, created_at: issue, updated_at: issue };
            invoiceRows.push(row); addT("invoices", row);
            items.forEach((l, i) => add("invoice_lines", { id: uuid(), invoice_id: id, position: i, description: l[0], quantity: l[1], unit_price_cents: l[2], amount_cents: Math.round(l[1] * l[2]), taxable: l[3] }));
            if (status === "paid") paymentRows.push({ id: uuid(), invoice_id: id, amount_cents: total, method: "ach", reference: `ACH-DEMO-${String(++payNo).padStart(4, "0")}`, paid_at: addDays(issue, 12), created_at: addDays(issue, 12) });
        };
        extraInvoice(2, "void", 40, [["Managed services: flat monthly (duplicate)", 1, 249900, false]], "Voided: issued twice by mistake.");
        extraInvoice(0, "paid", 75, [["Business laptop, standard build", 1, 124900, true], ["Setup and data transfer (2 hours)", 2, 13500, false]], "Replacement laptop for the practice manager.");
        extraInvoice(4, "sent", 20, [["Project: file server migration (fixed fee)", 1, 780000, false], ["Cloud backup storage (2 TB)", 2, 8900, false]], "Migration project, milestone 1 of 2.");
        const quoteRows: Array<[number, "draft" | "sent" | "accepted", number, Array<[string, number, number, boolean]>, string]> = [
            [2, "sent", 6, [["Remote access seats, seasonal (Jan to Apr): 2 seats x 4 months", 8, 1800, false], ["Setup and testing", 2, 13500, false]], "Seasonal remote access for tax season."],
            [3, "draft", 3, [["Guest Wi-Fi: access point and VLAN setup", 1, 42000, false], ["Onsite visit (half day)", 1, 38000, false]], "Guest network for Store 2."],
            [4, "accepted", 30, [["Windows 11 upgrade: office PCs (3)", 3, 22000, false], ["Business laptop, standard build", 2, 124900, true]], "Phase 1 of the Windows 10 replacement plan."],
        ];
        for (const [ci, status, ago, items, notes] of quoteRows) {
            const id = uuid(); const issue = new Date(now - ago * DAY);
            const taxable = items.filter((i) => i[3]).reduce((s, i) => s + Math.round(i[1] * i[2]), 0); const subtotal = items.reduce((s, i) => s + Math.round(i[1] * i[2]), 0); const tax = Math.round(taxable * 825 / 10000);
            addT("invoices", { id, organization_id: organizationId, client_id: clientIds[ci], contract_id: null, kind: "quote", number: status === "draft" ? null : nextNumber("quote"), status, currency: "USD", tax_rate_bps: taxable ? 825 : 0, subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax, paid_cents: 0, issue_date: status === "draft" ? null : issue, due_date: status === "draft" ? null : addDays(issue, 30), recipient_email: `billing@${CUSTOMERS[ci].domain}`, notes, sent_at: status === "draft" ? null : issue, created_at: issue, updated_at: issue });
            items.forEach((l, i) => add("invoice_lines", { id: uuid(), invoice_id: id, position: i, description: l[0], quantity: l[1], unit_price_cents: l[2], amount_cents: Math.round(l[1] * l[2]), taxable: l[3] }));
        }
        for (const p of paymentRows) addT("payments", p);
        for (const e of invoicedTime) addT("time_entries", e);
        numbers.invoice = invoiceNo; numbers.quote = quoteNo;

        // Time entries: the work logged on tickets, plus some background work. Older months are on invoices.
        const dateOnly = (ms: number) => new Date(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate()));
        const notes = ["Remote session: troubleshooting", "Patch review and restart scheduling", "Phone support", "Onsite: cabling and checks", "User account changes", "Backup verification", "Monthly review with the customer", "Printer and scanner setup"];
        for (const e of timeEntries) {
            const old = now - e.at > 7 * DAY;
            addT("time_entries", { id: uuid(), organization_id: organizationId, user_id: e.tech.id, client_id: clientIds[e.cust], ticket_id: e.ticketId, work_date: dateOnly(e.at), minutes: e.minutes, billable: !/internal/i.test(e.note), note: e.note, status: old ? "approved" : "pending", approved_by: old ? techs[0].id : null, approved_at: old ? new Date(e.at + 2 * DAY) : null, created_at: new Date(e.at), updated_at: new Date(e.at) });
        }
        for (let i = 0; i < 28; i++) {
            const ci = rnd(CUSTOMERS.length); const tech = techs[rnd(techs.length)]; const at = now - (1 + rnd(40)) * DAY - rnd(8) * HOUR; const old = now - at > 14 * DAY;
            addT("time_entries", { id: uuid(), organization_id: organizationId, user_id: tech.id, client_id: clientIds[ci], ticket_id: null, work_date: dateOnly(at), minutes: pick([15, 30, 30, 45, 60, 60, 90, 120]), billable: rnd(5) !== 0, note: pick(notes), status: old ? "approved" : "pending", approved_by: old ? techs[0].id : null, approved_at: old ? new Date(at + 2 * DAY) : null, created_at: new Date(at), updated_at: new Date(at) });
        }

        // ---- Checks, check profiles, policies ----------------------------------------------------------------------------
        const checkDefs: Array<[string, string, string, Record<string, unknown>, string]> = [
            ["Demo: Disk free (warn 15%, critical 8%)", "metric", "Warns before a disk fills up", { metric: "disk", warn: 85, crit: 92 }, "5m"],
            ["Demo: CPU sustained high", "metric", "CPU stays above the limit", { metric: "cpu", warn: 90, crit: 98 }, "5m"],
            ["Demo: Defender service running", "service", "Windows antivirus service must run", { service: "WinDefend", severity: "CRIT" }, "5m"],
            ["Demo: Backup agent process", "process", "The backup agent must be running", { process: "backupagent.exe", severity: "WARN" }, "15m"],
        ];
        const checkIds = checkDefs.map(([name, type, description, config, schedule]) => { const id = uuid(); addT("checks", { id, organization_id: organizationId, name: freeName(name, takenChecks), type, category: "Demo", description, schedule, config, enabled: true, created_at: new Date(now - 60 * DAY) }); add("check_assignments#defs", { id: uuid(), check_id: id, target_type: "organization", target_id: organizationId, dedupe_key: `check:${id}`, created_at: new Date(now - 60 * DAY), updated_at: new Date(now - 60 * DAY) }); return id; });
        const profileId = uuid();
        addT("check_profiles", { id: profileId, organization_id: organizationId, name: freeName("Demo: Windows essentials", takenProfiles), description: "Disk, CPU, antivirus and backup checks for Windows machines", created_at: new Date(now - 60 * DAY) });
        for (const id of checkIds) add("check_profile_members", { profile_id: profileId, check_id: id });

        const policyRows: Array<{ name: string; description: string; os: string; sections: Record<string, unknown>; assignments: Array<{ level: string; target: string | null }> }> = [
            { name: "Demo: Workstation baseline", description: "Standard settings for office workstations and laptops", os: "windows", sections: { alerting: { offlineAfterMinutes: 15, renotifyAfterHours: 24 }, remote: { consent: "notice" }, patching: { approve: "none", installIn: "maintenance", reboot: "maintenance" }, checks: { profileIds: [profileId] } }, assignments: [{ level: "global", target: null }] },
            { name: "Demo: Server policy", description: "Faster alerting and a monthly maintenance window for servers", os: "any", sections: { alerting: { offlineAfterMinutes: 5, renotifyAfterHours: 4 }, remote: { consent: "consent" }, maintenance: { windows: [{ name: "Sunday night", days: [0], start: "01:00", end: "05:00", timezone: "UTC" }], muteAlerts: false }, software: { banned: ["TeamViewer"] } }, assignments: [{ level: "tag", target: tagBy["Server"] }] },
            { name: "Demo: School labs", description: "Lab machines: no remote notice during lessons, shorter offline window", os: "windows", sections: { alerting: { offlineAfterMinutes: 30 }, remote: { consent: "off" }, hours: { days: [1, 2, 3, 4, 5], start: "07:30", end: "16:30", timezone: "UTC" } }, assignments: [{ level: "customer", target: clientIds[5] }] },
        ];
        policyRows.forEach((p, i) => { const id = uuid(); addT("policies", { id, organization_id: organizationId, name: freeName(p.name, takenPolicies), description: p.description, enabled: true, priority: 100 + i * 10, os: p.os, enforced: false, sections: p.sections, created_at: new Date(now - 45 * DAY) }); for (const a of p.assignments) add("policy_assignments", { id: uuid(), policy_id: id, level: a.level, target_id: a.target, exclude: false }); });

        // ---- Report schedules (the next run is days away: nothing is ever sent while demoing) ------------------------------
        const schedules: Array<[number, string, string, number, number | null]> = [[0, "monthly", "pdf", 5, 1], [1, "weekly", "pdf", 4, null], [3, "monthly", "both", 12, 1], [4, "monthly", "pdf", 9, 1]];
        for (const [ci, frequency, format, daysAway, dom] of schedules) addT("report_schedules", { id: uuid(), organization_id: organizationId, client_id: clientIds[ci], report_key: "customer-health", config: {}, format, send_if_empty: true, frequency, time_of_day: "07:00", timezone: CUSTOMERS[ci].zone, days_of_week: frequency === "weekly" ? [1] : [], day_of_month: dom, recipients: [`reports@${CUSTOMERS[ci].domain.replace(".example.com", ".example.invalid")}`], enabled: true, next_run_at: new Date(now + daysAway * DAY), last_run_at: new Date(now - (30 - daysAway) * DAY), last_result: "Sent to 1 recipient." });

        // ---- Web monitors: certificates, domains and DNS, disabled so nothing is ever fetched ----------------------------
        const nowDate = new Date(now);
        const mon = (ci: number, kind: "certificate" | "domain" | "dns", name: string, host: string, cfg: any, result: any) => {
            const id = uuid(); mark("web_monitors", id);
            const ev = kind === "certificate" ? evalCertificate(result, cfg, nowDate) : kind === "domain" ? evalDomain(result, cfg, nowDate) : evalDns(result, cfg);
            web.push({ id, client_id: clientIds[ci], kind, name, host, port: kind === "certificate" ? 443 : 443, config: cfg, status: ev.status, detail: ev.detail, result, expires_at: ev.expiresAt, last_checked_at: new Date(now - 3 * HOUR), next_check_at: new Date(now + 3650 * DAY), status_since: new Date(now - 20 * DAY) });
        };
        const cert = (days: number, name: string) => ({ subject: name, issuer: "Example Demo CA", validFrom: new Date(now - (365 - days) * DAY).toISOString(), validTo: new Date(now + days * DAY).toISOString(), names: [name], protocol: "TLSv1.3", trusted: true, authError: null, nameError: null });
        mon(0, "certificate", "Patient portal certificate", "portal.harbor-dental.example.com", { warnDays: 30, failDays: 7 }, cert(142, "portal.harbor-dental.example.com"));
        mon(1, "certificate", "Client extranet certificate", "extranet.summit-law.example.com", { warnDays: 30, failDays: 7 }, cert(19, "extranet.summit-law.example.com"));
        mon(3, "certificate", "Online store certificate", "shop.larkspur-outfitters.example.com", { warnDays: 30, failDays: 7 }, cert(4, "shop.larkspur-outfitters.example.com"));
        mon(2, "domain", "Domain: brightwater-cpa.example.com", "brightwater-cpa.example.com", { warnDays: 30, failDays: 7 }, { expiresAt: new Date(now + 212 * DAY).toISOString(), registrar: "Example Registrar, Inc.", status: ["client transfer prohibited"], nameservers: ["ns1.example.net", "ns2.example.net"] });
        mon(4, "domain", "Domain: ironbridge-fab.example.com", "ironbridge-fab.example.com", { warnDays: 30, failDays: 7 }, { expiresAt: new Date(now + 24 * DAY).toISOString(), registrar: "Example Registrar, Inc.", status: ["client transfer prohibited"], nameservers: ["ns1.example.net", "ns2.example.net"] });
        mon(5, "domain", "Domain: maplegrove-academy.example.com", "maplegrove-academy.example.com", { warnDays: 30, failDays: 7 }, { expiresAt: new Date(now + 340 * DAY).toISOString(), registrar: "Example Registrar, Inc.", status: ["client transfer prohibited"], nameservers: ["ns1.example.net", "ns2.example.net"] });
        mon(1, "dns", "DNS: summit-law.example.com mail records", "summit-law.example.com", { records: [{ type: "MX", expected: ["10 mail.summit-law.example.com"] }] }, { MX: ["10 mail.summit-law.example.com"] });
        mon(0, "dns", "DNS: harbor-dental.example.com mail records", "harbor-dental.example.com", { records: [{ type: "MX", expected: ["10 mail.harbor-dental.example.com"] }, { type: "TXT", expected: ["v=spf1 include:spf.example.com -all"] }] }, { MX: ["10 mail.harbor-dental.example.com"], TXT: ["v=spf1 include:spf.example.com ~all"] });

    }

    /** Deletes exactly what demo data created, and nothing else. */
    private async doDisable(): Promise<DemoStatus> {
        const records = await this.prisma.demo_records.findMany({ select: { table_name: true, record_id: true } });
        const ids = (table: string) => records.filter((r) => r.table_name === table).map((r) => r.record_id);
        const deviceIds = ids("devices");
        const ticketIds = ids("tickets");
        const invoiceIds = ids("invoices");
        const checkIds = ids("checks");
        const textIds = (a: string[]) => a;
        await this.prisma.$transaction(async (tx) => {
            // Children first. Everything under a device (agent, software, tasks, alerts, tags) goes with the device.
            await tx.payments.deleteMany({ where: { invoice_id: { in: invoiceIds } } });
            await tx.time_entries.deleteMany({ where: { id: { in: ids("time_entries") } } });
            await tx.invoices.deleteMany({ where: { id: { in: invoiceIds } } });
            await tx.contracts.deleteMany({ where: { id: { in: ids("contracts") } } });
            await tx.catalog_items.deleteMany({ where: { id: { in: ids("catalog_items") } } });
            await tx.ticket_surveys.deleteMany({ where: { ticket_id: { in: ticketIds } } });
            await tx.ticket_sla.deleteMany({ where: { ticket_id: { in: ticketIds } } });
            await tx.kb_ticket_links.deleteMany({ where: { ticket_id: { in: ticketIds } } });
            await tx.kb_articles.deleteMany({ where: { id: { in: ids("kb_articles") } } });
            await tx.kb_categories.deleteMany({ where: { id: { in: ids("kb_categories") } } });
            await tx.tickets.deleteMany({ where: { id: { in: ticketIds } } });
            await tx.ticket_queues.deleteMany({ where: { id: { in: ids("ticket_queues") } } });
            await tx.sla_policies.deleteMany({ where: { id: { in: ids("sla_policies") } } });
            await tx.sla_calendars.deleteMany({ where: { id: { in: ids("sla_calendars") } } });
            await tx.canned_responses.deleteMany({ where: { id: { in: ids("canned_responses") } } });
            await tx.ticket_templates.deleteMany({ where: { id: { in: ids("ticket_templates") } } });
            await tx.audit_events.deleteMany({ where: { id: { in: ids("audit_events") } } });
            await tx.assets.deleteMany({ where: { id: { in: ids("assets") } } });
            await tx.software_policies.deleteMany({ where: { id: { in: ids("software_policies") } } });
            await tx.report_schedules.deleteMany({ where: { id: { in: ids("report_schedules") } } });
            await tx.$executeRaw`DELETE FROM public.web_monitors WHERE id = ANY(${ids("web_monitors")}::uuid[])`;
            // Check results hang off the check assignments of the demo devices (the assignment's target is a plain id, not a key).
            const deviceTexts = textIds(deviceIds);
            await tx.$executeRaw`DELETE FROM public.check_runs WHERE assignment_id IN (SELECT id FROM public.check_assignments WHERE target_type = 'device' AND target_id = ANY(${deviceTexts}::uuid[]))`;
            await tx.$executeRaw`DELETE FROM public.check_runs WHERE device_id = ANY(${deviceTexts}::text[])`;
            await tx.$executeRaw`DELETE FROM public.check_assignments WHERE (target_type = 'device' AND target_id = ANY(${deviceTexts}::uuid[])) OR check_id = ANY(${checkIds}::uuid[])`;
            await tx.$executeRaw`DELETE FROM public.check_profile_members WHERE profile_id = ANY(${ids("check_profiles")}::uuid[]) OR check_id = ANY(${checkIds}::uuid[])`;
            await tx.check_profiles.deleteMany({ where: { id: { in: ids("check_profiles") } } });
            await tx.checks.deleteMany({ where: { id: { in: checkIds } } });
            await tx.policy_assignments.deleteMany({ where: { policy_id: { in: ids("policies") } } });
            await tx.policies.deleteMany({ where: { id: { in: ids("policies") } } });
            await tx.$executeRaw`DELETE FROM public.device_security_scans WHERE device_id = ANY(${deviceTexts}::uuid[])`;
            await tx.$executeRaw`DELETE FROM public.agent_outdated_software WHERE agent_id IN (SELECT id FROM public.agents WHERE device_id = ANY(${deviceTexts}::uuid[]))`;
            await tx.$executeRaw`DELETE FROM public.device_tags WHERE device_id = ANY(${deviceTexts}::uuid[])`;
            await tx.devices.deleteMany({ where: { id: { in: deviceIds } } });
            await tx.tag_defs.deleteMany({ where: { id: { in: ids("tag_defs") } } });
            await tx.sites.deleteMany({ where: { id: { in: ids("sites") } } });
            await tx.clients.deleteMany({ where: { id: { in: ids("clients") } } });
            await tx.users.deleteMany({ where: { id: { in: ids("users") } } });
            await tx.demo_records.deleteMany({});
        }, { timeout: 120_000, maxWait: 20_000 });
        return this.status();
    }
}

/** The order rows are written in: parents before the rows that point at them. */
const WRITE_ORDER = [
    "users", "clients", "customer_contacts", "sites", "tag_defs", "devices", "device_tags", "agents", "agent_software", "agent_outdated_software", "device_security_scans", "device_daily", "device_changes",
    "agent_tasks", "agent_task_runs", "agent_task_results", "jobs", "job_results", "script_runs", "check_assignments", "check_runs", "alerts", "alert_events", "assets", "audit_events", "software_policies",
    "sla_calendars", "sla_policies", "ticket_queues", "tickets", "ticket_tags", "ticket_activity", "ticket_sla", "ticket_surveys", "canned_responses", "ticket_templates",
    "kb_categories", "kb_articles", "kb_article_versions", "kb_ticket_links", "catalog_items", "contracts", "invoices", "invoice_lines", "payments", "time_entries",
    "checks", "check_assignments#defs", "check_profiles", "check_profile_members", "policies", "policy_assignments", "report_schedules",
];
