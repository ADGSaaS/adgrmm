// backend/src/reports/endpoint-reports.service.ts
//
// Endpoint reports: what is on the devices and how they are doing. Each report builds its rows and says how to
// summarise and chart them; the common pipeline then filters, sorts and groups them the way the person asked
// (see report-view.ts), so the screen, the CSV and the PDF all agree.
import { AssetsService } from "../assets/assets.service";
import { PoliciesService } from "../policies/policies.service";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { csvCell, parseDateOnly } from "../billing/billing.util";
import {
    applyFilter,
    applySort,
    buildCharts,
    checkView,
    exportColumns,
    groupCounts,
    displayValue,
    type Chart,
    type ChartSpec,
    type ReportColumn,
    type Row,
    type ViewSpec,
} from "./report-view";

import { ageYears, avVerdict, encryptionVerdict, firewallOff, parseDeviceHealth, parseRisk, parseThreats, uptimeDays, type DeviceHealthData, type RiskData, type ThreatData } from "./device-data";
import { canPatch, patchOs } from "../patches/linux-patching";
import { loadPatchState, readInstalled, readRequiresReboot, severityRank } from "./patch-data";

import { drawCharts } from "./pdf-charts";
import { EXTRA_BUILDERS, EXTRA_CATALOG, type ExtraKey } from "./extra-reports";
import { SERVICE_BUILDERS, SERVICE_CATALOG, type ServiceKey } from "./service-reports";
import { HISTORY_BUILDERS, HISTORY_CATALOG, type HistoryKey } from "./history-reports";

export type { ColumnType, ReportColumn, ViewSpec } from "./report-view";

const MAX_ROWS = 20_000;
/** The same window the device list uses to call a device online. */
const ONLINE_WINDOW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const GB = 1024 ** 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReportParam = { key: string; label: string; type: "number" | "text" | "date"; default?: number | string; min?: number; max?: number; help?: string };

export type ReportKey =
    | "hardware-inventory" | "software-inventory" | "software-summary"
    | "device-health" | "security-status"
    | "patch-compliance" | "patch-missing" | "patch-activity"
    | "alert-history" | "remote-sessions" | ExtraKey | ServiceKey | HistoryKey;

export type ReportDefinition = {
    key: ReportKey;
    title: string;
    group: "Inventory" | "Health" | "Security" | "Patching" | "Activity" | "Lifecycle" | "Service";
    description: string;
    /** Whether the customer and site pickers apply. */
    scoped: boolean;
    /** Whether it covers a period, so asks for from and to. */
    dated: boolean;
    params: ReportParam[];
    /** The right a person needs to run it. */
    permission: "devices.read" | "alerts.read" | "audit.read" | "tickets.read" | "customers.read";
};

export type ReportInput = {
    clientId?: string;
    siteId?: string;
    /** A single device. Any report can be limited to one. */
    deviceId?: string;
    from?: string;
    to?: string;
    q?: string;
    offlineDays?: number;
    minDiskFreePercent?: number;
    minRamGb?: number;
    maxUptimeDays?: number;
    maxDefinitionAgeDays?: number;
    staleDays?: number;
    refreshYears?: number;
    /** Set for people who may only see some customers: the customers they may see. Applies to every query. */
    restrictClientIds?: string[];
    warnDays?: number;
    notSeenDays?: number;
    required?: string;
    banned?: string;
    withinDays?: number;
    targetPercent?: number;
    businessHoursOnly?: string;
    slowDays?: number;
    maxLocalAdmins?: number;
};

export type ReportResult = {
    key: ReportKey;
    title: string;
    description: string;
    generatedAt: string;
    scope: { customer: string | null; site: string | null; device: string | null };
    period: { from: string; to: string } | null;
    params: Record<string, string | number>;
    columns: ReportColumn[];
    rows: Row[];
    /** Rows before any filter, and rows after. */
    totalRows: number;
    matchedRows: number;
    summary: Array<{ label: string; value: string | number }>;
    charts: Chart[];
    groups: Array<{ value: string; count: number }>;
    view: ViewSpec;
    notes: string[];
    truncated: boolean;
};

type Summary = ReportResult["summary"];
export type Built = {
    columns: ReportColumn[];
    rows: Row[];
    summarize: (rows: Row[]) => Summary;
    charts: ChartSpec[];
    notes?: string[];
    params?: Record<string, string | number>;
    period?: { from: string; to: string } | null;
    truncated: boolean;
};

const BASE_CATALOG: ReportDefinition[] = [
    {
        key: "hardware-inventory",
        title: "Hardware inventory",
        group: "Inventory",
        description: "Every device with its operating system, model, serial number, processor, memory, graphics and disk space, as the agent last reported it.",
        scoped: true,
        dated: false,
        params: [],
        permission: "devices.read",
    },
    {
        key: "software-inventory",
        title: "Software inventory",
        group: "Inventory",
        description: "What is installed on each device. Search by name to find every device that has a program, or a version you want to get rid of.",
        scoped: true,
        dated: false,
        params: [{ key: "q", label: "Software name contains", type: "text", help: "Leave empty for everything." }],
        permission: "devices.read",
    },
    {
        key: "software-summary",
        title: "Software summary",
        group: "Inventory",
        description: "Each program and version once, with how many devices have it. For licence counts and spotting old versions.",
        scoped: true,
        dated: false,
        params: [{ key: "q", label: "Software name contains", type: "text", help: "Leave empty for everything." }],
        permission: "devices.read",
    },
    {
        key: "device-health",
        title: "Device health",
        group: "Health",
        description: "Which devices need attention: offline for too long, low on disk space, short of memory, or running an old agent. You choose the limits.",
        scoped: true,
        dated: false,
        params: [
            { key: "offlineDays", label: "Offline for more than (days)", type: "number", default: 7, min: 1, max: 365 },
            { key: "minDiskFreePercent", label: "Disk free below (%)", type: "number", default: 15, min: 1, max: 90 },
            { key: "minRamGb", label: "Memory below (GB)", type: "number", default: 4, min: 1, max: 512 },
            { key: "maxUptimeDays", label: "Up without a restart for more than (days)", type: "number", default: 30, min: 1, max: 365 },
        ],
        permission: "devices.read",
    },
    {
        key: "security-status",
        title: "Security status",
        group: "Security",
        description: "Antivirus, firewall and disk encryption on every device, with the devices that are unprotected first. Needs agent 1.3.26 or later.",
        scoped: true,
        dated: false,
        params: [{ key: "maxDefinitionAgeDays", label: "Antivirus definitions older than (days)", type: "number", default: 7, min: 1, max: 90 }],
        permission: "devices.read",
    },
    {
        key: "patch-compliance",
        title: "Patch compliance",
        group: "Patching",
        description: "Which Windows and Linux devices are fully patched, which are missing updates (and how many are critical or security updates), and which have not been scanned lately.",
        scoped: true,
        dated: false,
        params: [{ key: "staleDays", label: "Scan counts as overdue after (days)", type: "number", default: 7, min: 1, max: 90 }],
        permission: "devices.read",
    },
    {
        key: "patch-missing",
        title: "Missing updates",
        group: "Patching",
        description: "Every update that is missing on every Windows and Linux device, most serious first. Use it to see which updates are missing on the most machines.",
        scoped: true,
        dated: false,
        params: [],
        permission: "devices.read",
    },
    {
        key: "patch-activity",
        title: "Patch activity",
        group: "Patching",
        description: "Every update install that was run in a period: when, on which device, who started it, what was installed and whether it worked.",
        scoped: true,
        dated: true,
        params: [],
        permission: "devices.read",
    },
    {
        key: "alert-history",
        title: "Alert history",
        group: "Activity",
        description: "Every alert raised in a period, including ones long since resolved, with how long each was open.",
        scoped: true,
        dated: true,
        params: [],
        permission: "alerts.read",
    },
    {
        key: "remote-sessions",
        title: "Remote sessions",
        group: "Activity",
        description: "Who connected to which device and when, taken from the audit log, including refused attempts.",
        scoped: true,
        dated: true,
        params: [{ key: "q", label: "Technician or device contains", type: "text" }],
        permission: "audit.read",
    },
];

const ALL_BUILDERS = { ...EXTRA_BUILDERS, ...SERVICE_BUILDERS, ...HISTORY_BUILDERS };
export const CATALOG: ReportDefinition[] = [...BASE_CATALOG, ...EXTRA_CATALOG, ...SERVICE_CATALOG, ...HISTORY_CATALOG];

const round1 = (n: number) => Math.round(n * 10) / 10;
const sum = (rows: Row[], key: string) => rows.reduce((s, r) => s + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);
const distinct = (rows: Row[], ...keys: string[]) => new Set(rows.map((r) => keys.map((k) => String(r[k] ?? "")).join("/"))).size;
const asRecord = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** Turns "1.3.25" into something that compares properly. */
function versionParts(v: string): number[] {
    return (v.match(/\d+/g) ?? []).map(Number);
}
function compareVersions(a: string, b: string): number {
    const x = versionParts(a);
    const y = versionParts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d) return d;
    }
    return 0;
}

export type DeviceFacts = {
    id: string;
    agentId: string;
    health: DeviceHealthData;
    customer: string;
    clientId: string;
    site: string;
    name: string;
    os: string;
    arch: string;
    user: string | null;
    ip: string | null;
    online: boolean;
    lastSeenAt: Date | null;
    agentVersion: string;
    model: string | null;
    serial: string | null;
    cpu: string | null;
    gpu: string | null;
    ramGb: number | null;
    disks: Array<{ mount: string; totalBytes: number; freeBytes: number }>;
    hasInventory: boolean;
    risk: RiskData | null;
    threats: ThreatData | null;
};

@Injectable()
export class EndpointReportsService {
    constructor(
        readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        readonly policies: PoliciesService,
        readonly assets: AssetsService,
    ) { }

    catalog() {
        return { items: CATALOG };
    }

    definition(key: string): ReportDefinition {
        const def = CATALOG.find((d) => d.key === key);
        if (!def) throw new NotFoundException("Unknown report");
        return def;
    }

    /* ------------------------------ shared helpers ------------------------------ */

    /** The customer limit for a query: the one asked for, and for people limited to some customers, only those. */
    private clientFilter(input: ReportInput) {
        if (input.clientId && input.restrictClientIds && !input.restrictClientIds.includes(input.clientId)) throw new BadRequestException("You do not have access to that customer.");
        return input.clientId ? { client_id: input.clientId } : input.restrictClientIds ? { client_id: { in: input.restrictClientIds } } : {};
    }

    /** The customers a report covers: this organization's, and for people limited to some customers, only those. */
    async customerWhere(input: ReportInput) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        if (input.clientId && input.restrictClientIds && !input.restrictClientIds.includes(input.clientId)) throw new BadRequestException("You do not have access to that customer.");
        return {
            organization_id: organizationId,
            archived_at: null,
            ...(input.clientId ? { id: input.clientId } : input.restrictClientIds ? { id: { in: input.restrictClientIds } } : {}),
        };
    }

    async deviceWhere(input: ReportInput) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        return {
            ...(input.deviceId ? { id: input.deviceId } : {}),
            sites: {
                clients: { organization_id: organizationId },
                ...this.clientFilter(input),
                ...(input.siteId ? { id: input.siteId } : {}),
            },
        };
    }

    private async scopeNames(input: ReportInput) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        let customer: string | null = null;
        let site: string | null = null;
        let device: string | null = null;
        const clientFilter = this.clientFilter(input);
        if (input.clientId) {
            const c = await this.prisma.clients.findFirst({ where: { id: input.clientId, organization_id: organizationId }, select: { name: true } });
            if (!c) throw new BadRequestException("That customer does not exist.");
            customer = c.name;
        }
        if (input.siteId) {
            const s = await this.prisma.sites.findFirst({
                where: { id: input.siteId, clients: { organization_id: organizationId }, ...clientFilter },
                select: { name: true },
            });
            if (!s) throw new BadRequestException("That site does not exist for this customer.");
            site = s.name;
        }
        if (input.deviceId) {
            const d = await this.prisma.devices.findFirst({
                where: { id: input.deviceId, sites: { clients: { organization_id: organizationId }, ...clientFilter, ...(input.siteId ? { id: input.siteId } : {}) } },
                select: { hostname: true, alias: true },
            });
            if (!d) throw new BadRequestException("That device does not exist in this customer or site.");
            device = d.alias || d.hostname;
        }
        return { customer, site, device };
    }

    period(input: ReportInput) {
        try {
            const today = new Date();
            const toDate = input.to ? parseDateOnly(input.to) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
            const fromDate = input.from ? parseDateOnly(input.from) : new Date(toDate.getTime() - 29 * DAY_MS);
            const end = new Date(toDate.getTime() + DAY_MS);
            if (end <= fromDate) throw new Error("The end date must be after the start date.");
            return { start: fromDate, end, from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10) };
        } catch (err) {
            throw new BadRequestException((err as Error).message);
        }
    }

    /** Every device with an agent in scope, reduced to what the reports need. */
    async loadDevices(input: ReportInput): Promise<{ devices: DeviceFacts[]; truncated: boolean }> {
        const rows = await this.prisma.devices.findMany({
            where: { ...(await this.deviceWhere(input)), agents: { isNot: null } },
            orderBy: [{ sites: { clients: { name: "asc" } } }, { hostname: "asc" }],
            take: MAX_ROWS,
            select: {
                id: true,
                hostname: true,
                alias: true,
                operating_system: true,
                architecture: true,
                serial_number: true,
                primary_user: true,
                last_seen_at: true,
                sites: { select: { name: true, client_id: true, clients: { select: { name: true } } } },
                agents: { select: { id: true, version: true, last_check_in_at: true, facts: true } },
            },
        });
        const now = Date.now();
        const devices = rows.map((d): DeviceFacts => {
            const facts = asRecord(d.agents?.facts);
            const health = parseDeviceHealth(d.agents?.facts);
            const device = asRecord(facts.device);
            const hw = asRecord(device.hardware);
            const checkIn = d.agents?.last_check_in_at ?? null;
            const lastSeenAt = checkIn ?? d.last_seen_at ?? null;
            const gpu = Array.isArray(hw.gpu) ? hw.gpu.filter(Boolean).join(", ") : typeof hw.gpu === "string" ? hw.gpu : "";
            const ramBytes = Number(hw.ramBytes);
            const ramText = typeof hw.ram === "string" ? parseFloat(hw.ram) : NaN;
            const disks = (Array.isArray(device.disks) ? device.disks : [])
                .map((x: any) => ({ mount: String(x?.mount ?? x?.name ?? ""), totalBytes: Number(x?.totalBytes), freeBytes: Number(x?.freeBytes) }))
                .filter((x: { totalBytes: number; freeBytes: number }) => Number.isFinite(x.totalBytes) && x.totalBytes > 0 && Number.isFinite(x.freeBytes));
            return {
                id: d.id,
                agentId: d.agents?.id ?? "",
                health,
                customer: d.sites?.clients.name ?? "",
                clientId: d.sites?.client_id ?? "",
                site: d.sites?.name ?? "",
                name: d.alias || d.hostname,
                os: String(facts.os || d.operating_system || ""),
                arch: String(facts.arch || d.architecture || ""),
                user: (facts.logged_in_user as string | null) || d.primary_user || null,
                ip: (facts.primary_ip as string | null) || health.nics.find((n) => n.ipv4.length)?.ipv4[0] || null,
                online: !!checkIn && now - checkIn.getTime() <= ONLINE_WINDOW_MS,
                lastSeenAt,
                agentVersion: d.agents?.version ?? "",
                model: (hw.model as string) || null,
                serial: d.serial_number || (hw.serial as string) || null,
                cpu: (hw.cpu as string) || null,
                gpu: gpu || null,
                ramGb: Number.isFinite(ramBytes) && ramBytes > 0 ? round1(ramBytes / GB) : Number.isFinite(ramText) ? round1(ramText) : null,
                disks,
                hasInventory: Object.keys(hw).length > 0 || disks.length > 0,
                risk: parseRisk(d.agents?.facts),
                threats: parseThreats(d.agents?.facts),
            };
        });
        return { devices, truncated: rows.length === MAX_ROWS };
    }

    private diskTotals(d: DeviceFacts) {
        const total = d.disks.reduce((s, x) => s + x.totalBytes, 0);
        const free = d.disks.reduce((s, x) => s + x.freeBytes, 0);
        const lowest = d.disks.reduce<{ mount: string; percent: number } | null>((best, x) => {
            const percent = (x.freeBytes / x.totalBytes) * 100;
            return !best || percent < best.percent ? { mount: x.mount, percent } : best;
        }, null);
        return { total, free, lowest };
    }

    /* ------------------------------ running a report ------------------------------ */

    /** Builds a report, then applies the view (filter, sort, group) the person chose. */
    async run(key: string, input: ReportInput, rawView?: unknown): Promise<ReportResult> {
        const def = this.definition(key);
        const scope = def.scoped ? await this.scopeNames(input) : { customer: null, site: null, device: null };
        const built = await this.build(def, input);
        const view = checkView(rawView, built.columns);

        const matched = applyFilter(built.rows, view.filter, built.columns);
        const rows = applySort(matched, view.sort, view.groupBy);
        return {
            key: def.key,
            title: def.title,
            description: def.description,
            generatedAt: new Date().toISOString(),
            scope,
            period: built.period ?? null,
            params: built.params ?? {},
            columns: built.columns,
            rows,
            totalRows: built.rows.length,
            matchedRows: matched.length,
            summary: built.summarize(matched),
            charts: buildCharts(matched, built.charts),
            groups: groupCounts(rows, view.groupBy),
            view,
            notes: built.notes ?? [],
            truncated: built.truncated,
        };
    }

    private build(def: ReportDefinition, input: ReportInput): Promise<Built> {
        switch (def.key) {
            case "hardware-inventory": return this.hardwareInventory(input);
            case "software-inventory": return this.softwareInventory(input);
            case "software-summary": return this.softwareSummary(input);
            case "device-health": return this.deviceHealth(input);
            case "security-status": return this.securityStatus(input);
            case "patch-compliance": return this.patchCompliance(input);
            case "patch-missing": return this.patchMissing(input);
            case "patch-activity": return this.patchActivity(input);
            case "alert-history": return this.alertHistory(input);
            case "remote-sessions": return this.remoteSessions(input);
            default: return (ALL_BUILDERS as Record<string, (s: EndpointReportsService, i: ReportInput) => Promise<Built>>)[def.key](this, input);
        }
    }

    private async hardwareInventory(input: ReportInput): Promise<Built> {
        const { devices, truncated } = await this.loadDevices(input);
        const rows: Row[] = devices.map((d) => {
            const t = this.diskTotals(d);
            return {
                deviceId: d.id,
                customer: d.customer,
                site: d.site,
                name: d.name,
                status: d.online ? "Online" : "Offline",
                os: d.os,
                arch: d.arch,
                model: d.model,
                serial: d.serial,
                cpu: d.cpu,
                ramGb: d.ramGb,
                gpu: d.gpu,
                diskTotalGb: t.total ? round1(t.total / GB) : null,
                diskFreeGb: t.total ? round1(t.free / GB) : null,
                diskFreePercent: t.total ? round1((t.free / t.total) * 100) : null,
                diskDetail: d.disks.length ? d.disks.map((x) => `${x.mount || "disk"} ${round1(x.freeBytes / GB)} of ${round1(x.totalBytes / GB)} GB free`).join("; ") : null,
                ip: d.ip,
                mac: d.health.nics.find((n) => n.mac)?.mac ?? null,
                user: d.user,
                osName: d.health.osName,
                osVersion: d.health.osVersion,
                osBuild: d.health.osBuild,
                biosDate: d.health.biosDate,
                ageYears: ageYears(d.health.biosDate),
                lastBootAt: d.health.lastBootAt,
                uptimeDays: d.online ? uptimeDays(d.health.lastBootAt) : null,
                pendingReboot: d.health.pendingReboot === null ? null : d.health.pendingReboot ? "Yes" : "No",
                agentVersion: d.agentVersion,
                lastSeenAt: d.lastSeenAt,
            };
        });
        const noInventory = devices.filter((d) => !d.hasInventory).length;
        return {
            rows,
            truncated,
            notes: noInventory ? [`${noInventory} device${noInventory === 1 ? " has" : "s have"} not reported hardware details yet, so those columns are empty for them.`] : [],
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                { key: "customer", label: "Customer", pdf: true },
                { key: "site", label: "Site" },
                { key: "name", label: "Device", pdf: true, weight: 1.3 },
                { key: "status", label: "Status", type: "status", pdf: true, weight: 0.7 },
                { key: "os", label: "OS", pdf: true, weight: 0.7 },
                { key: "arch", label: "Architecture", visible: false },
                { key: "model", label: "Model", pdf: true, weight: 1.5 },
                { key: "serial", label: "Serial", visible: false },
                { key: "cpu", label: "Processor", pdf: true, weight: 1.6 },
                { key: "ramGb", label: "RAM (GB)", type: "number", pdf: true, weight: 0.6 },
                { key: "gpu", label: "Graphics", visible: false },
                { key: "diskTotalGb", label: "Disk (GB)", type: "number", pdf: true, weight: 0.6 },
                { key: "diskFreeGb", label: "Disk free (GB)", type: "number", visible: false },
                { key: "diskFreePercent", label: "Disk free (%)", type: "percent", pdf: true, weight: 0.6 },
                { key: "diskDetail", label: "Disks", visible: false },
                { key: "ip", label: "IP address", visible: false },
                { key: "user", label: "User", visible: false },
                { key: "mac", label: "MAC address", visible: false },
                { key: "osName", label: "Windows edition", visible: false },
                { key: "osVersion", label: "Windows version", visible: false },
                { key: "osBuild", label: "OS build", visible: false },
                { key: "biosDate", label: "Firmware date", type: "date", visible: false },
                { key: "ageYears", label: "Age (years)", type: "number", visible: false },
                { key: "lastBootAt", label: "Last restart", type: "date", visible: false },
                { key: "uptimeDays", label: "Days since restart", type: "number", visible: false },
                { key: "pendingReboot", label: "Restart pending", visible: false },
                { key: "agentVersion", label: "Agent", visible: false },
                { key: "lastSeenAt", label: "Last seen", type: "date", pdf: true, weight: 1.1 },
            ],
            summarize: (r) => [
                { label: "Devices", value: r.length },
                { label: "Online now", value: r.filter((x) => x.status === "Online").length },
                { label: "Offline", value: r.filter((x) => x.status === "Offline").length },
                { label: "Total RAM (GB)", value: round1(sum(r, "ramGb")) },
                { label: "Total disk (TB)", value: round1(sum(r, "diskTotalGb") / 1024) },
            ],
            charts: [
                { key: "status", title: "Status", kind: "donut", field: "status" },
                { key: "os", title: "Operating system", kind: "bar", field: "os" },
                { key: "customer", title: "By customer", kind: "bar", field: "customer" },
                { key: "ram", title: "Memory", kind: "bar", field: "ramGb", buckets: [{ label: "Under 4 GB", max: 4 }, { label: "4 to 8 GB", min: 4, max: 8 }, { label: "8 to 16 GB", min: 8, max: 16 }, { label: "16 to 32 GB", min: 16, max: 32 }, { label: "32 GB or more", min: 32 }] },
                { key: "disk", title: "Disk space free", kind: "bar", field: "diskFreePercent", buckets: [{ label: "Under 10%", max: 10 }, { label: "10 to 25%", min: 10, max: 25 }, { label: "25 to 50%", min: 25, max: 50 }, { label: "50% or more", min: 50 }] },
                { key: "agent", title: "Agent version", kind: "bar", field: "agentVersion" },
            ],
        };
    }

    private softwareWhere(input: ReportInput, deviceWhere: Awaited<ReturnType<EndpointReportsService["deviceWhere"]>>) {
        const q = input.q?.trim();
        return {
            agents: { devices: deviceWhere },
            ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
        };
    }

    private async softwareInventory(input: ReportInput): Promise<Built> {
        const q = input.q?.trim() ?? "";
        const found = await this.prisma.agent_software.findMany({
            where: this.softwareWhere(input, await this.deviceWhere(input)),
            orderBy: [{ name: "asc" }, { version: "asc" }],
            take: MAX_ROWS,
            select: {
                name: true,
                publisher: true,
                version: true,
                install_date: true,
                install_location: true,
                agents: { select: { devices: { select: { id: true, alias: true, hostname: true, sites: { select: { name: true, clients: { select: { name: true } } } } } } } },
            },
        });
        const rows: Row[] = found.map((r) => ({
            deviceId: r.agents.devices.id,
            customer: r.agents.devices.sites?.clients.name ?? "",
            site: r.agents.devices.sites?.name ?? "",
            device: r.agents.devices.alias || r.agents.devices.hostname,
            name: r.name,
            publisher: r.publisher,
            version: r.version,
            installDate: r.install_date,
            installLocation: r.install_location,
        }));
        return {
            rows,
            truncated: found.length === MAX_ROWS,
            params: q ? { q } : {},
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                { key: "customer", label: "Customer", pdf: true },
                { key: "site", label: "Site" },
                { key: "device", label: "Device", pdf: true },
                { key: "name", label: "Software", pdf: true, weight: 1.6 },
                { key: "publisher", label: "Publisher", pdf: true, weight: 1.2 },
                { key: "version", label: "Version", pdf: true, weight: 0.8 },
                { key: "installDate", label: "Installed or updated", type: "date", pdf: true, weight: 0.8 },
                { key: "installLocation", label: "Install location", visible: false },
            ],
            summarize: (r) => [
                { label: "Entries", value: r.length },
                { label: "Devices", value: distinct(r, "customer", "device") },
                { label: "Different programs", value: distinct(r, "name") },
                { label: "Publishers", value: distinct(r, "publisher") },
            ],
            charts: [
                { key: "top", title: "Most installed programs", kind: "bar", field: "name", top: 10 },
                { key: "publisher", title: "Publishers", kind: "bar", field: "publisher" },
                { key: "customer", title: "By customer", kind: "bar", field: "customer" },
            ],
        };
    }

    private async softwareSummary(input: ReportInput): Promise<Built> {
        const q = input.q?.trim() ?? "";
        const groups = await this.prisma.agent_software.groupBy({
            by: ["name", "publisher", "version"],
            where: this.softwareWhere(input, await this.deviceWhere(input)),
            _count: { agent_id: true },
            orderBy: [{ name: "asc" }, { version: "asc" }],
            take: MAX_ROWS,
        });
        const rows: Row[] = groups.map((g) => ({ name: g.name, publisher: g.publisher, version: g.version, devices: g._count.agent_id }));
        return {
            rows,
            truncated: groups.length === MAX_ROWS,
            params: q ? { q } : {},
            columns: [
                { key: "name", label: "Software", pdf: true, weight: 2 },
                { key: "publisher", label: "Publisher", pdf: true, weight: 1.4 },
                { key: "version", label: "Version", pdf: true },
                { key: "devices", label: "Devices", type: "number", pdf: true, weight: 0.6 },
            ],
            summarize: (r) => [
                { label: "Different programs", value: distinct(r, "name") },
                { label: "Program versions", value: r.length },
                { label: "Installs", value: sum(r, "devices") },
            ],
            charts: [
                { key: "top", title: "Programs on the most devices", kind: "bar", field: "name", weight: "devices", top: 10 },
                { key: "publisher", title: "Installs by publisher", kind: "bar", field: "publisher", weight: "devices" },
            ],
        };
    }

    limit(value: unknown, fallback: number, min: number, max: number): number {
        const n = Number(value);
        if (value === undefined || value === null || value === "" || !Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    private async deviceHealth(input: ReportInput): Promise<Built> {
        const offlineDays = this.limit(input.offlineDays, 7, 1, 365);
        const minDisk = this.limit(input.minDiskFreePercent, 15, 1, 90);
        const minRam = this.limit(input.minRamGb, 4, 1, 512);
        const maxUptime = this.limit(input.maxUptimeDays, 30, 1, 365);

        const { devices, truncated } = await this.loadDevices(input);

        // "Old agent" means behind the newest version any device in the organisation runs, not a guess at a release.
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const versions = await this.prisma.agents.findMany({ where: { devices: { sites: { clients: { organization_id: organizationId } } } }, select: { version: true }, distinct: ["version"] });
        const newest = versions.map((v) => v.version).filter(Boolean).sort(compareVersions).pop() ?? "";

        const now = Date.now();
        const rows: Row[] = devices.map((d) => {
            const issues: string[] = [];
            const offlineForDays = !d.online && d.lastSeenAt ? Math.floor((now - d.lastSeenAt.getTime()) / DAY_MS) : !d.online ? null : 0;
            const issueOffline = !d.online && (offlineForDays === null || offlineForDays >= offlineDays);
            if (issueOffline) issues.push(offlineForDays === null ? "Never seen" : `Offline ${offlineForDays} days`);
            const t = this.diskTotals(d);
            const issueDisk = !!t.lowest && t.lowest.percent < minDisk;
            if (issueDisk) issues.push(`Low disk space: ${t.lowest!.mount || "disk"} ${round1(t.lowest!.percent)}% free`);
            const issueRam = d.ramGb !== null && d.ramGb < minRam;
            if (issueRam) issues.push(`Low memory: ${d.ramGb} GB`);
            const issueAgent = !!newest && !!d.agentVersion && compareVersions(d.agentVersion, newest) < 0;
            if (issueAgent) issues.push(`Old agent ${d.agentVersion}`);
            const issueNoData = !d.hasInventory;
            if (issueNoData) issues.push("No hardware details reported yet");

            // These need the 1.3.26 agent. Without it they are unknown, which is not a problem.
            const h = d.health;
            const uptime = d.online ? uptimeDays(h.lastBootAt, now) : null;
            const issueReboot = h.pendingReboot === true;
            if (issueReboot) issues.push(`Restart pending${h.pendingRebootReasons.length ? ` (${h.pendingRebootReasons.join(", ")})` : ""}`);
            const issueUptime = uptime !== null && uptime > maxUptime;
            if (issueUptime) issues.push(`Up ${uptime} days without a restart`);
            const av = avVerdict(h, 7);
            const issueAv = av.state === "off" || av.state === "old";
            if (issueAv) issues.push(av.text);

            return {
                deviceId: d.id,
                customer: d.customer,
                site: d.site,
                name: d.name,
                status: d.online ? "Online" : "Offline",
                lastSeenAt: d.lastSeenAt,
                offlineDays: offlineForDays,
                diskFreePercent: t.lowest ? round1(t.lowest.percent) : null,
                diskDrive: t.lowest?.mount ?? null,
                ramGb: d.ramGb,
                agentVersion: d.agentVersion,
                os: d.os,
                uptimeDays: uptime,
                pendingReboot: h.pendingReboot === null ? null : h.pendingReboot ? "Yes" : "No",
                antivirus: av.state === "unknown" ? null : av.text,
                result: issues.length ? "Needs attention" : "Healthy",
                issueCount: issues.length,
                issues: issues.join("; "),
                issueOffline,
                issueDisk,
                issueRam,
                issueAgent,
                issueNoData,
                issueReboot,
                issueUptime,
                issueAv,
            };
        });
        // The worst first, unless the person sorts it otherwise.
        rows.sort((a, b) => Number(b.issueCount) - Number(a.issueCount) || String(a.customer).localeCompare(String(b.customer)) || String(a.name).localeCompare(String(b.name)));

        const flag = (r: Row[], key: string) => r.filter((x) => x[key] === true).length;
        return {
            rows,
            truncated,
            params: { offlineDays, minDiskFreePercent: minDisk, minRamGb: minRam, maxUptimeDays: maxUptime },
            notes: [newest ? `The newest agent version in use is ${newest}.` : "No agent versions are known yet.", "Restart, uptime and antivirus checks need agent 1.3.26 or later; older agents are not flagged for them."],
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                ...["issueOffline", "issueDisk", "issueRam", "issueAgent", "issueNoData", "issueReboot", "issueUptime", "issueAv"].map((key) => ({ key, label: key, internal: true })),
                { key: "customer", label: "Customer", pdf: true },
                { key: "site", label: "Site" },
                { key: "name", label: "Device", pdf: true },
                { key: "os", label: "OS", visible: false },
                { key: "status", label: "Status", type: "status" as const, pdf: true, weight: 0.7 },
                { key: "lastSeenAt", label: "Last seen", type: "date" as const, pdf: true, weight: 1.1 },
                { key: "offlineDays", label: "Days offline", type: "number" as const, visible: false },
                { key: "diskFreePercent", label: "Lowest disk free (%)", type: "percent" as const, pdf: true, weight: 0.8 },
                { key: "diskDrive", label: "Drive", visible: false },
                { key: "ramGb", label: "RAM (GB)", type: "number" as const, pdf: true, weight: 0.6 },
                { key: "uptimeDays", label: "Days since restart", type: "number" as const, visible: false },
                { key: "pendingReboot", label: "Restart pending", visible: false },
                { key: "antivirus", label: "Antivirus", visible: false },
                { key: "agentVersion", label: "Agent", pdf: true, weight: 0.6 },
                { key: "result", label: "Result", type: "status" as const, pdf: true, weight: 0.9 },
                { key: "issueCount", label: "Issues found", type: "number" as const, visible: false },
                { key: "issues", label: "Issues", pdf: true, weight: 2.4 },
            ],
            summarize: (r) => [
                { label: "Devices", value: r.length },
                { label: "Need attention", value: r.filter((x) => x.result === "Needs attention").length },
                { label: `Offline ${offlineDays}+ days`, value: flag(r, "issueOffline") },
                { label: `Disk under ${minDisk}% free`, value: flag(r, "issueDisk") },
                { label: `Memory under ${minRam} GB`, value: flag(r, "issueRam") },
                { label: "Old agent", value: flag(r, "issueAgent") },
                { label: "Restart pending", value: flag(r, "issueReboot") },
                { label: `Up over ${maxUptime} days`, value: flag(r, "issueUptime") },
                { label: "Antivirus problem", value: flag(r, "issueAv") },
                ...(r.some((x) => x.issueNoData === true) ? [{ label: "No hardware details yet", value: flag(r, "issueNoData") }] : []),
            ],
            charts: [
                { key: "result", title: "Result", kind: "donut", field: "result" },
                {
                    key: "issues",
                    title: "What needs attention",
                    kind: "bar",
                    flags: [
                        { field: "issueOffline", label: `Offline ${offlineDays}+ days` },
                        { field: "issueDisk", label: "Low disk space" },
                        { field: "issueRam", label: "Low memory" },
                        { field: "issueAgent", label: "Old agent" },
                        { field: "issueReboot", label: "Restart pending" },
                        { field: "issueUptime", label: `Up over ${maxUptime} days` },
                        { field: "issueAv", label: "Antivirus problem" },
                        { field: "issueNoData", label: "No hardware details" },
                    ],
                },
                { key: "customer", title: "By customer", kind: "bar", field: "customer" },
            ],
        };
    }

    /* ------------------------------ security ------------------------------ */

    private async securityStatus(input: ReportInput): Promise<Built> {
        const maxDefinitionAge = this.limit(input.maxDefinitionAgeDays, 7, 1, 90);
        const { devices, truncated } = await this.loadDevices(input);

        const rows: Row[] = devices.map((d) => {
            const h = d.health;
            const av = avVerdict(h, maxDefinitionAge);
            const fwOff = firewallOff(h);
            const enc = encryptionVerdict(h);
            const known = h.antivirus !== null || h.defender !== null || h.firewall !== null || h.bitlocker !== null || h.tpm !== null || h.secureBoot !== null;

            const issues: string[] = [];
            const issueAv = av.state === "off" || av.state === "old";
            if (issueAv) issues.push(av.text);
            const issueFirewall = fwOff.length > 0;
            if (issueFirewall) issues.push(`Firewall off: ${fwOff.join(", ")}`);
            const issueEncryption = enc.state === "unprotected";
            if (issueEncryption) issues.push(enc.text);

            const tpmText = !h.tpm ? null : h.tpm.present === false ? "None" : h.tpm.version ? `Version ${h.tpm.version}` : "Present";
            return {
                deviceId: d.id,
                customer: d.customer,
                site: d.site,
                name: d.name,
                status: d.online ? "Online" : "Offline",
                os: h.osName ?? d.os,
                antivirus: av.state === "unknown" ? null : av.text || null,
                antivirusState: av.state === "ok" ? "On" : av.state === "off" ? "Off" : av.state === "old" ? "Out of date" : "Not reported",
                definitionsAgeDays: h.defender?.signatureAgeDays ?? null,
                firewall: !h.firewall ? "Not reported" : fwOff.length ? `Off: ${fwOff.join(", ")}` : "On",
                encryption: enc.state === "protected" ? "Encrypted" : enc.state === "unprotected" ? "Not encrypted" : "Not reported",
                tpm: tpmText ?? "Not reported",
                secureBoot: h.secureBoot === null ? "Not reported" : h.secureBoot ? "On" : "Off",
                pendingReboot: h.pendingReboot === null ? null : h.pendingReboot ? "Yes" : "No",
                result: !known ? "Not reported" : issues.length ? "Needs attention" : "Protected",
                issues: issues.join("; "),
                issueAv,
                issueFirewall,
                issueEncryption,
            };
        });
        rows.sort((a, b) => (a.result === "Needs attention" ? 0 : 1) - (b.result === "Needs attention" ? 0 : 1) || String(a.customer).localeCompare(String(b.customer)) || String(a.name).localeCompare(String(b.name)));

        const flag = (r: Row[], key: string) => r.filter((x) => x[key] === true).length;
        return {
            rows,
            truncated,
            params: { maxDefinitionAgeDays: maxDefinitionAge },
            notes: ["This report needs agent 1.3.26 or later. A device that has not reported yet shows \"Not reported\", which is different from a problem."],
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                { key: "issueAv", label: "Antivirus flag", internal: true },
                { key: "issueFirewall", label: "Firewall flag", internal: true },
                { key: "issueEncryption", label: "Encryption flag", internal: true },
                { key: "customer", label: "Customer", pdf: true },
                { key: "site", label: "Site" },
                { key: "name", label: "Device", pdf: true },
                { key: "status", label: "Status", type: "status", pdf: true, weight: 0.7 },
                { key: "os", label: "OS", visible: false },
                { key: "antivirusState", label: "Antivirus", type: "status", pdf: true, weight: 0.8 },
                { key: "antivirus", label: "Antivirus detail", pdf: true, weight: 1.4 },
                { key: "definitionsAgeDays", label: "Definitions age (days)", type: "number", visible: false },
                { key: "firewall", label: "Firewall", pdf: true, weight: 0.8 },
                { key: "encryption", label: "Disk encryption", pdf: true, weight: 0.9 },
                { key: "tpm", label: "TPM", visible: false },
                { key: "secureBoot", label: "Secure Boot", visible: false },
                { key: "pendingReboot", label: "Restart pending", visible: false },
                { key: "result", label: "Result", type: "status", pdf: true, weight: 0.9 },
                { key: "issues", label: "Issues", pdf: true, weight: 2 },
            ],
            summarize: (r) => [
                { label: "Devices", value: r.length },
                { label: "Protected", value: r.filter((x) => x.result === "Protected").length },
                { label: "Need attention", value: r.filter((x) => x.result === "Needs attention").length },
                { label: "Not reported", value: r.filter((x) => x.result === "Not reported").length },
                { label: "Antivirus problem", value: flag(r, "issueAv") },
                { label: "Firewall off", value: flag(r, "issueFirewall") },
                { label: "Not encrypted", value: flag(r, "issueEncryption") },
            ],
            charts: [
                { key: "result", title: "Result", kind: "donut", field: "result" },
                {
                    key: "issues",
                    title: "What needs attention",
                    kind: "bar",
                    flags: [
                        { field: "issueAv", label: "Antivirus problem" },
                        { field: "issueFirewall", label: "Firewall off" },
                        { field: "issueEncryption", label: "Disk not encrypted" },
                    ],
                },
                { key: "av", title: "Antivirus", kind: "donut", field: "antivirusState" },
                { key: "enc", title: "Disk encryption", kind: "donut", field: "encryption" },
                { key: "customer", title: "By customer", kind: "bar", field: "customer" },
            ],
        };
    }

    /* ------------------------------ patching ------------------------------ */

    private async patchContext(input: ReportInput) {
        const { devices, truncated } = await this.loadDevices(input);
        // Windows devices, and Linux devices whose agent runs patch tasks. Others have nothing the reports could say.
        const windows = devices.filter((d) => {
            const os = /windows/i.test(d.health.osName ?? "") ? "windows" : patchOs({ os: String(d.os).toLowerCase() }, d.os);
            return canPatch(os, d.agentVersion);
        });
        const states = await loadPatchState(this.prisma, windows.map((d) => d.agentId).filter(Boolean));
        return { windows, skipped: devices.length - windows.length, states, truncated };
    }

    async patchCompliance(input: ReportInput): Promise<Built> {
        const staleDays = this.limit(input.staleDays, 7, 1, 90);
        const { windows, skipped, states, truncated } = await this.patchContext(input);
        const now = Date.now();

        const rows: Row[] = windows.map((d) => {
            const s = states.get(d.agentId);
            const scannedAt = s?.scannedAt ?? null;
            const scanAgeDays = scannedAt ? Math.floor((now - scannedAt.getTime()) / DAY_MS) : null;
            const missing = s?.missing ?? [];
            const critical = missing.filter((p) => severityRank(p.severity) === "Critical").length;
            const important = missing.filter((p) => severityRank(p.severity) === "Important").length;
            const security = missing.filter((p) => p.security === true).length;
            const lastFailed = !!s?.lastAttempt && s.lastAttempt.status === "failed";
            const fresh = scanAgeDays !== null && scanAgeDays <= staleDays;

            let result: string;
            let issues: string;
            if (!scannedAt && lastFailed) { result = "Scan failed"; issues = "The last scan failed and there has never been a successful one"; }
            else if (!scannedAt) { result = "Not scanned"; issues = "No scan has run yet"; }
            else if (!fresh && lastFailed) { result = "Scan failed"; issues = `The last scan failed; the last good one was ${scanAgeDays} days ago`; }
            else if (!fresh) { result = "Scan overdue"; issues = `Last scanned ${scanAgeDays} days ago`; }
            else if (missing.length) { result = "Missing patches"; issues = `${missing.length} missing${critical ? `, ${critical} critical` : ""}${important ? `, ${important} important` : ""}${security ? `, ${security} security` : ""}`; }
            else { result = "Compliant"; issues = ""; }

            return {
                deviceId: d.id,
                customer: d.customer,
                site: d.site,
                name: d.name,
                status: d.online ? "Online" : "Offline",
                osVersion: d.health.osVersion,
                osBuild: d.health.osBuild,
                lastScanAt: scannedAt,
                scanAgeDays,
                missing: scannedAt ? missing.length : null,
                critical: scannedAt ? critical : null,
                important: scannedAt ? important : null,
                security: scannedAt ? security : null,
                needsRestart: scannedAt ? (missing.some((p) => p.requiresReboot) ? "Yes" : "No") : null,
                pendingReboot: d.health.pendingReboot === null ? null : d.health.pendingReboot ? "Yes" : "No",
                lastInstallAt: s?.lastInstallAt ?? null,
                result,
                issues,
            };
        });
        const order: Record<string, number> = { "Scan failed": 0, "Not scanned": 1, "Missing patches": 2, "Scan overdue": 3, Compliant: 4 };
        rows.sort((a, b) => (order[String(a.result)] ?? 9) - (order[String(b.result)] ?? 9) || Number(b.critical ?? 0) - Number(a.critical ?? 0) || Number(b.missing ?? 0) - Number(a.missing ?? 0) || String(a.customer).localeCompare(String(b.customer)) || String(a.name).localeCompare(String(b.name)));

        return {
            rows,
            truncated,
            params: { staleDays },
            notes: [
                ...(skipped ? [`${skipped} device${skipped === 1 ? " that is" : "s that are"} not Windows or Linux (or ${skipped === 1 ? "runs" : "run"} a Linux agent too old to patch) ${skipped === 1 ? "is" : "are"} left out.`] : []),
                "Based on each device's latest successful scan, less anything installed since. Devices are scanned automatically once a day while they are online.",
            ],
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                { key: "customer", label: "Customer", pdf: true },
                { key: "site", label: "Site" },
                { key: "name", label: "Device", pdf: true },
                { key: "status", label: "Status", type: "status", pdf: true, weight: 0.7 },
                { key: "osVersion", label: "OS version", visible: false },
                { key: "osBuild", label: "OS build", visible: false },
                { key: "lastScanAt", label: "Last scanned", type: "date", pdf: true, weight: 1.1 },
                { key: "scanAgeDays", label: "Scan age (days)", type: "number", visible: false },
                { key: "missing", label: "Missing", type: "number", pdf: true, weight: 0.6 },
                { key: "critical", label: "Critical", type: "number", pdf: true, weight: 0.6 },
                { key: "important", label: "Important", type: "number", visible: false },
                { key: "security", label: "Security", type: "number", visible: false },
                { key: "needsRestart", label: "Restart needed", pdf: true, weight: 0.7 },
                { key: "pendingReboot", label: "Restart pending", visible: false },
                { key: "lastInstallAt", label: "Last install", type: "date", visible: false },
                { key: "result", label: "Result", type: "status", pdf: true, weight: 0.9 },
                { key: "issues", label: "Details", pdf: true, weight: 2 },
            ],
            summarize: (r) => {
                const scanned = r.filter((x) => x.lastScanAt);
                return [
                    { label: "Devices", value: r.length },
                    { label: "Compliant", value: r.filter((x) => x.result === "Compliant").length },
                    { label: "Missing patches", value: r.filter((x) => x.result === "Missing patches").length },
                    { label: "Not scanned or overdue", value: r.filter((x) => ["Not scanned", "Scan overdue", "Scan failed"].includes(String(x.result))).length },
                    { label: "Patches missing", value: sum(scanned, "missing") },
                    { label: "Critical missing", value: sum(scanned, "critical") },
                ];
            },
            charts: [
                { key: "result", title: "Result", kind: "donut", field: "result" },
                { key: "missing", title: "Missing patches per device", kind: "bar", field: "missing", buckets: [{ label: "None", max: 1 }, { label: "1 to 3", min: 1, max: 4 }, { label: "4 to 10", min: 4, max: 11 }, { label: "More than 10", min: 11 }] },
                { key: "customer", title: "By customer", kind: "bar", field: "customer" },
            ],
        };
    }

    private async patchMissing(input: ReportInput): Promise<Built> {
        const { windows, skipped, states, truncated } = await this.patchContext(input);
        const rows: Row[] = [];
        for (const d of windows) {
            const s = states.get(d.agentId);
            if (!s?.scannedAt) continue;
            for (const p of s.missing) {
                // Windows updates are named by KB number; a Linux package or patch by its own name.
                const kb = p.kbIds[0] && /^(kb)?\d+$/i.test(p.kbIds[0]) ? (/^kb/i.test(p.kbIds[0]) ? p.kbIds[0].toUpperCase() : `KB${p.kbIds[0]}`) : p.id;
                rows.push({
                    deviceId: d.id,
                    customer: d.customer,
                    site: d.site,
                    device: d.name,
                    kb,
                    title: p.title,
                    severity: p.severity ?? (p.security === true ? "Important" : "Unrated"),
                    restartNeeded: p.requiresReboot ? "Yes" : "No",
                    scannedAt: s.scannedAt,
                    patchId: p.id,
                });
            }
        }
        const rank: Record<string, number> = { Critical: 0, Important: 1, Moderate: 2, Low: 3 };
        rows.sort((a, b) => (rank[String(a.severity)] ?? 9) - (rank[String(b.severity)] ?? 9) || String(a.customer).localeCompare(String(b.customer)) || String(a.device).localeCompare(String(b.device)) || String(a.kb).localeCompare(String(b.kb)));
        return {
            rows,
            truncated: truncated || rows.length > MAX_ROWS,
            notes: [
                ...(skipped ? [`${skipped} device${skipped === 1 ? " that is" : "s that are"} not Windows or Linux (or ${skipped === 1 ? "runs" : "run"} a Linux agent too old to patch) ${skipped === 1 ? "is" : "are"} left out.`] : []),
                "One row for each missing update on each device, from its latest successful scan. See Patch compliance for devices that have not been scanned.",
            ],
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                { key: "customer", label: "Customer", pdf: true },
                { key: "site", label: "Site", visible: false },
                { key: "device", label: "Device", pdf: true },
                { key: "kb", label: "Update", pdf: true, weight: 0.8 },
                { key: "title", label: "Title", pdf: true, weight: 3 },
                { key: "severity", label: "Severity", type: "status", pdf: true, weight: 0.7 },
                { key: "restartNeeded", label: "Restart needed", pdf: true, weight: 0.7 },
                { key: "scannedAt", label: "Scanned", type: "date", pdf: true, weight: 1 },
                { key: "patchId", label: "Update id", visible: false },
            ],
            summarize: (r) => [
                { label: "Missing updates", value: r.length },
                { label: "Devices affected", value: distinct(r, "customer", "device") },
                { label: "Different updates", value: distinct(r, "kb") },
                { label: "Critical", value: r.filter((x) => x.severity === "Critical").length },
                { label: "Need a restart", value: r.filter((x) => x.restartNeeded === "Yes").length },
            ],
            charts: [
                { key: "severity", title: "Severity", kind: "donut", field: "severity" },
                { key: "top", title: "Updates missing on the most devices", kind: "bar", field: "title", top: 10 },
                { key: "customer", title: "By customer", kind: "bar", field: "customer" },
                { key: "restart", title: "Needs a restart", kind: "donut", field: "restartNeeded" },
            ],
        };
    }

    private async patchActivity(input: ReportInput): Promise<Built> {
        const p = this.period(input);
        const found = await this.prisma.agent_task_runs.findMany({
            where: { created_at: { gte: p.start, lt: p.end }, agent_tasks: { type: "patch_install", agents: { devices: await this.deviceWhere(input) } } },
            orderBy: { created_at: "desc" },
            take: MAX_ROWS,
            select: {
                status: true,
                started_at: true,
                finished_at: true,
                output: true,
                agent_task_results: { select: { artifacts: true, stderr: true } },
                agent_tasks: {
                    select: {
                        users: { select: { first_name: true, last_name: true, email: true } },
                        agents: { select: { devices: { select: { id: true, hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true } } } } } } } },
                    },
                },
            },
        });
        const out: Row[] = found.map((r) => {
            const d = r.agent_tasks.agents.devices;
            const installed = readInstalled(r.output, r.agent_task_results?.artifacts);
            const reboot = readRequiresReboot(r.output, r.agent_task_results?.artifacts);
            const u = r.agent_tasks.users;
            const who = u ? ([u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email) : "Automatic";
            const status = String(r.status);
            return {
                deviceId: d.id,
                at: r.finished_at ?? r.started_at,
                customer: d.sites?.clients.name ?? "",
                site: d.sites?.name ?? "",
                device: d.alias || d.hostname,
                by: who,
                status: status.charAt(0).toUpperCase() + status.slice(1),
                updates: installed.length,
                installed: installed.length ? `${installed.slice(0, 5).join(", ")}${installed.length > 5 ? ` and ${installed.length - 5} more` : ""}` : null,
                restartNeeded: reboot === null ? null : reboot ? "Yes" : "No",
                error: r.agent_task_results?.stderr ? r.agent_task_results.stderr.slice(0, 200) : null,
            };
        });
        return {
            rows: out,
            truncated: found.length === MAX_ROWS,
            period: { from: p.from, to: p.to },
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                { key: "at", label: "When", type: "date", pdf: true, weight: 1.1 },
                { key: "customer", label: "Customer", pdf: true },
                { key: "site", label: "Site", visible: false },
                { key: "device", label: "Device", pdf: true },
                { key: "by", label: "Started by", pdf: true, weight: 1.1 },
                { key: "status", label: "Result", type: "status", pdf: true, weight: 0.7 },
                { key: "updates", label: "Updates installed", type: "number", pdf: true, weight: 0.7 },
                { key: "installed", label: "Which", pdf: true, weight: 2 },
                { key: "restartNeeded", label: "Restart needed", pdf: true, weight: 0.7 },
                { key: "error", label: "Error", visible: false },
            ],
            summarize: (r) => [
                { label: "Install runs", value: r.length },
                { label: "Succeeded", value: r.filter((x) => x.status === "Succeeded").length },
                { label: "Failed", value: r.filter((x) => x.status === "Failed").length },
                { label: "Updates installed", value: sum(r, "updates") },
                { label: "Devices", value: distinct(r, "customer", "device") },
            ],
            charts: [
                { key: "day", title: "Install runs per day", kind: "line", field: "at", days: 60 },
                { key: "status", title: "Result", kind: "donut", field: "status" },
                { key: "by", title: "Started by", kind: "bar", field: "by", top: 8 },
                { key: "customer", title: "By customer", kind: "bar", field: "customer" },
            ],
        };
    }

    private async alertHistory(input: ReportInput): Promise<Built> {
        const p = this.period(input);
        const found = await this.prisma.alerts.findMany({
            where: { first_seen_at: { gte: p.start, lt: p.end }, devices: await this.deviceWhere(input) },
            orderBy: { first_seen_at: "desc" },
            take: MAX_ROWS,
            select: {
                title: true,
                severity: true,
                state: true,
                first_seen_at: true,
                resolved_at: true,
                devices: { select: { id: true, hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true } } } } } },
            },
        });
        const rows: Row[] = found.map((r) => ({
            deviceId: r.devices.id,
            openedAt: r.first_seen_at,
            customer: r.devices.sites?.clients.name ?? "",
            site: r.devices.sites?.name ?? "",
            device: r.devices.alias || r.devices.hostname,
            title: r.title,
            severity: String(r.severity),
            state: String(r.state),
            resolvedAt: r.resolved_at,
            minutesOpen: r.resolved_at ? Math.round((r.resolved_at.getTime() - r.first_seen_at.getTime()) / 60_000) : null,
        }));
        return {
            rows,
            truncated: found.length === MAX_ROWS,
            period: { from: p.from, to: p.to },
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                { key: "openedAt", label: "Opened", type: "date", pdf: true, weight: 1.1 },
                { key: "customer", label: "Customer", pdf: true },
                { key: "site", label: "Site", visible: false },
                { key: "device", label: "Device", pdf: true },
                { key: "title", label: "Alert", pdf: true, weight: 2 },
                { key: "severity", label: "Severity", type: "status", pdf: true, weight: 0.7 },
                { key: "state", label: "State", type: "status", pdf: true, weight: 0.7 },
                { key: "resolvedAt", label: "Resolved", type: "date", pdf: true, weight: 1.1 },
                { key: "minutesOpen", label: "Minutes open", type: "number", pdf: true, weight: 0.7 },
            ],
            summarize: (r) => {
                const resolved = r.filter((x) => x.resolvedAt);
                const open = resolved.map((x) => x.minutesOpen).filter((m): m is number => typeof m === "number");
                return [
                    { label: "Alerts", value: r.length },
                    { label: "Critical", value: r.filter((x) => x.severity === "CRIT").length },
                    { label: "Resolved", value: resolved.length },
                    { label: "Still open", value: r.length - resolved.length },
                    ...(open.length ? [{ label: "Average minutes to resolve", value: Math.round(open.reduce((s, m) => s + m, 0) / open.length) }] : []),
                ];
            },
            charts: [
                { key: "day", title: "Alerts per day", kind: "line", field: "openedAt", days: 60 },
                { key: "severity", title: "Severity", kind: "donut", field: "severity" },
                { key: "state", title: "State", kind: "donut", field: "state" },
                { key: "title", title: "Most common alerts", kind: "bar", field: "title", top: 8 },
                { key: "device", title: "Noisiest devices", kind: "bar", field: "device", top: 8 },
            ],
        };
    }

    private async remoteSessions(input: ReportInput): Promise<Built> {
        const p = this.period(input);
        const q = input.q?.trim() ?? "";
        // The log names devices by id, so a customer, site or device is turned into the ids of its devices.
        const limited = !!(input.clientId || input.siteId || input.deviceId || input.restrictClientIds);
        const deviceIds = limited ? (await this.prisma.devices.findMany({ where: await this.deviceWhere(input), select: { id: true }, take: MAX_ROWS })).map((d) => d.id) : null;
        const found = await this.prisma.audit_events.findMany({
            where: {
                category: "remote",
                created_at: { gte: p.start, lt: p.end },
                ...(deviceIds ? { target_id: { in: deviceIds } } : {}),
                ...(q ? { OR: [{ actor_email: { contains: q, mode: "insensitive" as const } }, { target_label: { contains: q, mode: "insensitive" as const } }] } : {}),
            },
            orderBy: { created_at: "desc" },
            take: MAX_ROWS,
            select: { created_at: true, actor_email: true, action: true, target_label: true, target_id: true, ip: true, outcome: true },
        });
        const rows: Row[] = found.map((r) => ({
            deviceId: r.target_id && UUID.test(r.target_id) ? r.target_id : null,
            at: r.created_at,
            technician: r.actor_email,
            action: r.action,
            device: r.target_label ?? r.target_id,
            ip: r.ip,
            outcome: r.outcome,
        }));
        return {
            rows,
            truncated: found.length === MAX_ROWS,
            period: { from: p.from, to: p.to },
            params: q ? { q } : {},
            columns: [
                { key: "deviceId", label: "Device id", internal: true },
                { key: "at", label: "Time", type: "date", pdf: true, weight: 1.2 },
                { key: "technician", label: "Technician", pdf: true, weight: 1.4 },
                { key: "action", label: "Action", pdf: true, weight: 1.4 },
                { key: "device", label: "Device", pdf: true, weight: 1.2 },
                { key: "ip", label: "From address", pdf: true },
                { key: "outcome", label: "Outcome", type: "status", pdf: true, weight: 0.7 },
            ],
            summarize: (r) => [
                { label: "Events", value: r.length },
                { label: "Technicians", value: distinct(r, "technician") },
                { label: "Devices", value: distinct(r, "device") },
                { label: "Refused", value: r.filter((x) => String(x.outcome) !== "success").length },
            ],
            charts: [
                { key: "day", title: "Sessions per day", kind: "line", field: "at", days: 60 },
                { key: "technician", title: "By technician", kind: "bar", field: "technician", top: 8 },
                { key: "outcome", title: "Outcome", kind: "donut", field: "outcome" },
                { key: "device", title: "Most connected devices", kind: "bar", field: "device", top: 8 },
            ],
        };
    }

    /* ------------------------------ output ------------------------------ */

    /** UTF-8 with a byte order mark, so Excel reads accents and symbols correctly. Formulas are defused by csvCell. */
    toCsv(result: ReportResult): string {
        const columns = exportColumns(result.columns, result.view.columns);
        const lines = [columns.map((c) => csvCell(c.label)).join(",")];
        for (const row of result.rows) lines.push(columns.map((c) => csvCell(row[c.key] instanceof Date ? (row[c.key] as Date).toISOString() : row[c.key])).join(","));
        return "﻿" + lines.join("\r\n");
    }

    private displayCell(c: ReportColumn, value: unknown): string {
        if (value === null || value === undefined || value === "") return "";
        if (value instanceof Date) return value.toISOString().slice(0, 16).replace("T", " ");
        if (c.type === "percent") return `${value}%`;
        return String(value);
    }

    /** A new landscape letter document, the layout every report PDF uses. */
    newPdf(title: string): { doc: any; done: Promise<Buffer>; margin: number } {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const PDFDocument = require("pdfkit");
        const margin = 36;
        const doc = new PDFDocument({ size: "LETTER", layout: "landscape", margin, bufferPages: true, info: { Title: title } });
        const chunks: Buffer[] = [];
        const done = new Promise<Buffer>((resolve, reject) => {
            doc.on("data", (c: Buffer) => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);
        });
        return { doc, done, margin };
    }

    /**
     * Draws one report from the current position: its title and scope, the headline numbers, the charts, and the table.
     * `maxRows` keeps a long table from filling a combined document; the rest are in the spreadsheet.
     */
    drawReport(doc: any, result: ReportResult, companyName: string, margin: number, opts: { maxRows?: number } = {}) {
        // The columns the person chose, otherwise the ones that fit a page.
        const chosen = exportColumns(result.columns, result.view.columns);
        const columns = result.view.columns?.length ? chosen : chosen.some((c) => c.pdf) ? chosen.filter((c) => c.pdf) : chosen.slice(0, 8);
        const pageWidth = doc.page.width - margin * 2;
        const totalWeight = columns.reduce((s, c) => s + (c.weight ?? 1), 0);
        const widths = columns.map((c) => (pageWidth * (c.weight ?? 1)) / totalWeight);
        const bottom = () => doc.page.height - margin - 14;

        doc.x = margin;
        doc.font("Helvetica-Bold").fontSize(18).fillColor("#111111").text(result.title, margin);
        const scopeText = [result.scope.customer, result.scope.site, result.scope.device].filter(Boolean).join(" / ") || "All customers";
        const periodText = result.period ? `, ${result.period.from} to ${result.period.to}` : "";
        doc.font("Helvetica").fontSize(9).fillColor("#555555").text(`${scopeText}${periodText}. As of ${result.generatedAt.slice(0, 16).replace("T", " ")} UTC.${companyName ? ` Prepared by ${companyName}.` : ""}`);
        if (Object.keys(result.params).length) doc.text(`Limits: ${Object.entries(result.params).map(([k, v]) => `${k} ${v}`).join(", ")}`);
        if (result.matchedRows !== result.totalRows) doc.text(`Filtered: ${result.matchedRows} of ${result.totalRows} rows.`);
        doc.moveDown(0.6);

        if (result.summary.length) {
            doc.font("Helvetica-Bold").fontSize(10).fillColor("#111111").text(result.summary.map((s) => `${s.label}: ${s.value}`).join("    "), { width: pageWidth });
            doc.moveDown(0.4);
        }
        for (const note of result.notes) doc.font("Helvetica-Oblique").fontSize(8).fillColor("#555555").text(note, { width: pageWidth });
        if (result.truncated) doc.font("Helvetica-Oblique").fontSize(8).fillColor("#aa0000").text(`Only the first ${MAX_ROWS} rows are included.`);
        doc.moveDown(0.4);

        // The same charts as on screen, above the table, drawn from the rows the person's filter left.
        if (drawCharts(doc, result.charts, { margin, width: pageWidth, bottom })) doc.moveDown(0.2);

        const rowHeight = 16;
        const header = () => {
            let x = margin;
            const y = doc.y;
            doc.rect(margin, y, pageWidth, rowHeight).fill("#eeeeee");
            doc.fillColor("#111111").font("Helvetica-Bold").fontSize(8);
            columns.forEach((c, i) => {
                doc.text(c.label, x + 3, y + 4, { width: widths[i] - 6, height: rowHeight - 4, lineBreak: false, ellipsis: true });
                x += widths[i];
            });
            doc.y = y + rowHeight;
        };
        header();

        const groupColumn = result.view.groupBy ? result.columns.find((c) => c.key === result.view.groupBy) : undefined;
        const counts = new Map(result.groups.map((g) => [g.value, g.count]));
        let currentGroup: string | null = null;

        const shown = opts.maxRows ? result.rows.slice(0, opts.maxRows) : result.rows;
        doc.font("Helvetica").fontSize(8);
        shown.forEach((row, index) => {
            const group = groupColumn ? displayValue(row[groupColumn.key]) : null;
            const needsGroupHeader = group !== null && group !== currentGroup;
            if (doc.y + rowHeight * (needsGroupHeader ? 2 : 1) > bottom()) {
                doc.addPage();
                header();
                doc.font("Helvetica").fontSize(8);
            }
            if (needsGroupHeader) {
                currentGroup = group;
                const gy = doc.y;
                doc.rect(margin, gy, pageWidth, rowHeight).fill("#dde6f0");
                doc.fillColor("#111111").font("Helvetica-Bold").text(`${groupColumn!.label}: ${group} (${counts.get(group!) ?? 0})`, margin + 3, gy + 4, { width: pageWidth - 6, lineBreak: false, ellipsis: true });
                doc.font("Helvetica");
                doc.y = gy + rowHeight;
            }
            const y = doc.y;
            if (index % 2) doc.rect(margin, y, pageWidth, rowHeight).fill("#f8f8f8");
            let x = margin;
            columns.forEach((c, i) => {
                const text = this.displayCell(c, row[c.key]);
                const bad = c.type === "status" && /offline|needs attention|crit|open|refused|denied/i.test(text);
                doc.fillColor(bad ? "#b00020" : "#222222").text(text, x + 3, y + 4, { width: widths[i] - 6, height: rowHeight - 4, lineBreak: false, ellipsis: true });
                x += widths[i];
            });
            doc.y = y + rowHeight;
        });
        if (!result.rows.length) doc.fillColor("#555555").text("Nothing to report for this selection.", margin, doc.y + 6);
        else if (opts.maxRows && result.rows.length > opts.maxRows) {
            doc.font("Helvetica-Oblique").fontSize(8).fillColor("#555555").text(`Showing the first ${opts.maxRows.toLocaleString()} of ${result.rows.length.toLocaleString()} rows. The Excel version of this report has every row.`, margin, doc.y + 6);
        }
    }

    /** "Page 1 of N" on every page, drawn last because the total is not known until the end. */
    addPageNumbers(doc: any, margin: number, footerText?: string) {
        const pageWidth = doc.page.width - margin * 2;
        const range = doc.bufferedPageRange();
        for (let i = 0; i < range.count; i++) {
            doc.switchToPage(range.start + i);
            // The footer sits at the very bottom of the printable area. With the bottom margin on, the library starts a
            // new page for any text that touches it, which left a blank last page holding only this line.
            const bottomMargin = doc.page.margins.bottom;
            doc.page.margins.bottom = 0;
            doc.font("Helvetica").fontSize(8).fillColor("#777777").text(`Page ${i + 1} of ${range.count}`, margin, doc.page.height - margin - 10, { width: pageWidth, align: "right", lineBreak: false });
            if (footerText) doc.text(footerText, margin, doc.page.height - margin - 10, { width: pageWidth - 80, align: "left", lineBreak: false, ellipsis: true });
            doc.page.margins.bottom = bottomMargin;
        }
    }

    pdf(result: ReportResult, companyName: string): Promise<Buffer> {
        const { doc, done, margin } = this.newPdf(result.title);
        this.drawReport(doc, result, companyName, margin);
        this.addPageNumbers(doc, margin);
        doc.end();
        return done;
    }

    async pdfFile(key: string, input: ReportInput, rawView?: unknown) {
        const result = await this.run(key, input, rawView);
        const company = await this.prisma.company_profile.findFirst({ select: { name: true } });
        return { filename: `${key}-${result.generatedAt.slice(0, 10)}.pdf`, data: await this.pdf(result, company?.name ?? "") };
    }
}
