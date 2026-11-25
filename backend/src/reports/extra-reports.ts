// backend/src/reports/extra-reports.ts
//
// More endpoint reports, built on the same engine: each one returns its columns, rows, summary and charts, and the
// common pipeline (filter, sort, group, charts, CSV, PDF, schedules) does the rest. They live here so the engine file
// does not grow without limit. Only types are imported from the engine, so there is no import cycle.
import { canPatch, patchOs } from "../patches/linux-patching";
import { BadRequestException } from "@nestjs/common";
import type { Built, DeviceFacts, EndpointReportsService, ReportDefinition, ReportInput } from "./endpoint-reports.service";
import { ageYears, avVerdict, encryptionVerdict, firewallOff } from "./device-data";
import type { Row } from "./report-view";
import { RULE_BY_ID, SEVERITY_RANK } from "../security/security.baseline";
import { highlights } from "../security/security.highlights";
import type { ScanData } from "../security/security.scripts";
import { LINUX_RULE_BY_ID, linuxHighlights } from "../security/security-linux.baseline";

export type ExtraKey =
    | "customer-list" | "ticket-list" | "hardware-age" | "windows-support" | "stale-devices" | "network-map" | "security-score" | "automatic-patching" | "outdated-software" | "security-posture";

export const EXTRA_CATALOG: ReportDefinition[] = [
    {
        key: "hardware-age",
        title: "Hardware age and refresh",
        group: "Lifecycle",
        description: "How old each machine is, from its purchase date when one is recorded and from its firmware date when not, and which are due for replacement.",
        scoped: true,
        dated: false,
        params: [{ key: "refreshYears", label: "Replace after (years)", type: "number", default: 5, min: 1, max: 15 }],
        permission: "devices.read",
    },
    {
        key: "windows-support",
        title: "Windows support and Windows 11 readiness",
        group: "Lifecycle",
        description: "Which Windows versions are out of support or about to be, and for Windows 10 machines whether they meet the Windows 11 requirements.",
        scoped: true,
        dated: false,
        params: [{ key: "warnDays", label: "Warn when support ends within (days)", type: "number", default: 180, min: 1, max: 730 }],
        permission: "devices.read",
    },
    {
        key: "stale-devices",
        title: "Stale devices",
        group: "Health",
        description: "Devices that have not checked in for a long time, or never had an agent, as a list to clean up or chase.",
        scoped: true,
        dated: false,
        params: [{ key: "notSeenDays", label: "Not seen for more than (days)", type: "number", default: 30, min: 1, max: 730 }],
        permission: "devices.read",
    },
    {
        key: "network-map",
        title: "Network and IP addresses",
        group: "Inventory",
        description: "Every network adapter with its address, network, gateway and MAC, and any address used by more than one device.",
        scoped: true,
        dated: false,
        params: [],
        permission: "devices.read",
    },
    {
        key: "security-score",
        title: "Security score",
        group: "Security",
        description: "One score from 0 to 100 for each device, from antivirus, firewall, disk encryption, Secure Boot, TPM and patching, with a grade. Items a device has not reported are left out of its score, not counted against it.",
        scoped: true,
        dated: false,
        params: [{ key: "maxDefinitionAgeDays", label: "Antivirus definitions older than (days)", type: "number", default: 7, min: 1, max: 90 }],
        permission: "devices.read",
    },
];

EXTRA_CATALOG.push({
    key: "customer-list",
    title: "Customers",
    group: "Inventory",
    description: "Every customer with its status, tags, main contact, sites and devices, and a column for each custom field, to filter, sort, export or print.",
    scoped: false,
    dated: false,
    params: [],
    permission: "customers.read",
});

EXTRA_CATALOG.push({
    key: "ticket-list",
    title: "Tickets with custom fields",
    group: "Service",
    description: "Every ticket with its customer, status, priority and assignee, and a column for each ticket custom field, to filter, sort, export or print.",
    scoped: false,
    dated: false,
    params: [],
    permission: "tickets.read",
});

EXTRA_CATALOG.push({
    key: "automatic-patching",
    title: "Automatic patching",
    group: "Patching",
    description: "How each Windows device is patched: by hand or automatically, which policy says so, whether it waits for a maintenance window, and what the policies last did, with any restart still pending.",
    scoped: true,
    dated: false,
    params: [],
    permission: "devices.read",
});

EXTRA_CATALOG.push({
    key: "outdated-software",
    title: "Outdated software",
    group: "Patching",
    description: "Programs that have a newer version, from the last scan of each Windows device (winget and Chocolatey): how many devices have each one, which versions are installed, and how many customers are affected.",
    scoped: true,
    dated: false,
    params: [],
    permission: "devices.read",
});

EXTRA_CATALOG.push({
    key: "security-posture",
    title: "Security posture",
    group: "Security",
    description: "The result of the last security scan of each Windows and Linux device: score and grade against the security baseline, failed critical and high checks, Microsoft Defender and definitions age, BitLocker, firewall and when it was scanned. Devices that were never scanned are listed as such.",
    scoped: true,
    dated: false,
    params: [],
    permission: "devices.read",
});

export const EXTRA_BUILDERS: Record<ExtraKey, (svc: EndpointReportsService, input: ReportInput) => Promise<Built>> = {
    "customer-list": customerList,
    "ticket-list": ticketList,
    "hardware-age": hardwareAge,
    "windows-support": windowsSupport,
    "stale-devices": staleDevices,
    "network-map": networkMap,
    "security-score": securityScore,
    "automatic-patching": automaticPatching,
    "outdated-software": outdatedSoftware,
    "security-posture": securityPosture,
};

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const dateOnly = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const count = (rows: Row[], key: string, value: unknown) => rows.filter((r) => r[key] === value).length;

/* ------------------------------ customers ------------------------------ */

/** One custom field's saved value as the report holds it, by the kind of column it gets. */
function customCell(type: string, v: unknown): string | number | Date | null {
    if (v === undefined || v === null || v === "") return type === "checkbox" ? "No" : null;
    switch (type) {
        case "number": return typeof v === "number" ? v : Number(v);
        case "date": return new Date(`${String(v)}T00:00:00Z`);
        case "checkbox": return v === true ? "Yes" : "No";
        default: return String(v);
    }
}

async function customerList(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const where = await svc.customerWhere(input);
    const defs = await svc.prisma.custom_field_defs.findMany({ where: { organization_id: where.organization_id, entity: "customer", active: true }, orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] });
    const found = await svc.prisma.clients.findMany({
        where,
        take: 20_000,
        orderBy: { name: "asc" },
        select: {
            id: true, name: true, status: true, external_ref: true, industry: true, customer_since: true, tags: true, phone: true, email: true, custom_fields: true,
            customer_contacts: { where: { is_primary: true }, take: 1, select: { name: true, email: true, phone: true } },
            sites: { select: { id: true, devices: { select: { id: true } } } },
        },
    });
    const rows: Row[] = found.map((c) => {
        const saved = c.custom_fields && typeof c.custom_fields === "object" && !Array.isArray(c.custom_fields) ? (c.custom_fields as Record<string, unknown>) : {};
        const main = c.customer_contacts[0];
        const row: Row = {
            customerId: c.id,
            name: c.name,
            status: c.status === "prospect" ? "Prospect" : c.status === "inactive" ? "Inactive" : "Active",
            account: c.external_ref,
            industry: c.industry,
            since: c.customer_since,
            tags: (c.tags ?? []).join(", "),
            contact: main?.name ?? null,
            contactEmail: main?.email ?? c.email ?? null,
            contactPhone: main?.phone ?? c.phone ?? null,
            sites: c.sites.length,
            devices: c.sites.reduce((n, s) => n + s.devices.length, 0),
        };
        for (const d of defs) row[`cf_${d.key}`] = customCell(d.type, saved[d.key]);
        return row;
    });

    const dropdowns = defs.filter((d) => d.type === "dropdown").slice(0, 2);
    return {
        rows,
        truncated: found.length === 20_000,
        notes: ["Archived customers are not listed."],
        columns: [
            { key: "customerId", label: "Customer id", internal: true },
            { key: "name", label: "Customer", pdf: true, weight: 1.6 },
            { key: "status", label: "Status", type: "status", pdf: true, weight: 0.8 },
            { key: "account", label: "Account number", visible: false },
            { key: "industry", label: "Industry", visible: false },
            { key: "since", label: "Customer since", type: "date", visible: false },
            { key: "tags", label: "Tags", visible: false },
            { key: "contact", label: "Main contact", pdf: true },
            { key: "contactEmail", label: "Contact email", visible: false },
            { key: "contactPhone", label: "Contact phone", visible: false },
            { key: "sites", label: "Sites", type: "number", pdf: true, weight: 0.6 },
            { key: "devices", label: "Devices", type: "number", pdf: true, weight: 0.6 },
            ...defs.map((d) => ({
                key: `cf_${d.key}`,
                label: d.label,
                type: (d.type === "number" ? "number" : d.type === "date" ? "date" : "text") as "number" | "date" | "text",
                pdf: true,
                weight: d.type === "longtext" ? 1.6 : 1,
            })),
        ],
        summarize: (r) => [
            { label: "Customers", value: r.length },
            { label: "Active", value: count(r, "status", "Active") },
            { label: "Sites", value: r.reduce((n, x) => n + Number(x.sites ?? 0), 0) },
            { label: "Devices", value: r.reduce((n, x) => n + Number(x.devices ?? 0), 0) },
        ],
        charts: [
            { key: "status", title: "Status", kind: "donut", field: "status" },
            ...dropdowns.map((d) => ({ key: `cf_${d.key}`, title: d.label, kind: "donut" as const, field: `cf_${d.key}` })),
        ],
    };
}

/* ------------------------------ tickets ------------------------------ */

async function ticketList(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const org = (await svc.customerWhere(input)).organization_id;
    if (input.clientId && input.restrictClientIds && !input.restrictClientIds.includes(input.clientId)) throw new BadRequestException("You do not have access to that customer.");
    const defs = await svc.prisma.custom_field_defs.findMany({ where: { organization_id: org, entity: "ticket", active: true }, orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] });
    const found = await svc.prisma.tickets.findMany({
        where: {
            organization_id: org,
            ...(input.clientId ? { client_id: input.clientId } : input.restrictClientIds ? { client_id: { in: input.restrictClientIds } } : {}),
        },
        take: 20_000,
        orderBy: { ticket_number: "desc" },
        select: { id: true, client_id: true, ticket_number: true, subject: true, status: true, priority: true, created_at: true, closed_at: true, custom_fields: true, users: { select: { email: true } } },
    });
    const clients = await svc.prisma.clients.findMany({ where: { id: { in: [...new Set(found.flatMap((t) => (t.client_id ? [t.client_id] : [])))] } }, select: { id: true, name: true } });
    const clientName = new Map(clients.map((c) => [c.id, c.name]));
    const rows: Row[] = found.map((t) => {
        const saved = t.custom_fields && typeof t.custom_fields === "object" && !Array.isArray(t.custom_fields) ? (t.custom_fields as Record<string, unknown>) : {};
        const row: Row = {
            ticket: Number(t.ticket_number),
            subject: t.subject,
            customer: clientName.get(t.client_id ?? "") ?? "",
            priority: t.priority === "normal" ? "medium" : t.priority,
            status: t.status.replace("_", " "),
            assignee: t.users?.email ? String(t.users.email) : "",
            createdAt: t.created_at,
            closedAt: t.closed_at,
        };
        for (const d of defs) row[`cf_${d.key}`] = customCell(d.type, saved[d.key]);
        return row;
    });
    const dropdowns = defs.filter((d) => d.type === "dropdown").slice(0, 2);
    return {
        rows,
        truncated: found.length === 20_000,
        notes: ["The newest 20,000 tickets are listed."],
        columns: [
            { key: "ticket", label: "Ticket", type: "number", pdf: true, weight: 0.6 },
            { key: "subject", label: "Subject", pdf: true, weight: 2 },
            { key: "customer", label: "Customer", pdf: true },
            { key: "priority", label: "Priority", type: "status", pdf: true, weight: 0.7 },
            { key: "status", label: "Status", type: "status", pdf: true, weight: 0.8 },
            { key: "assignee", label: "Assigned to", visible: false },
            { key: "createdAt", label: "Opened", type: "date", visible: false },
            { key: "closedAt", label: "Closed", type: "date", visible: false },
            ...defs.map((d) => ({
                key: `cf_${d.key}`,
                label: d.label,
                type: (d.type === "number" ? "number" : d.type === "date" ? "date" : "text") as "number" | "date" | "text",
                pdf: true,
                weight: d.type === "longtext" ? 1.6 : 1,
            })),
        ],
        summarize: (r) => [
            { label: "Tickets", value: r.length },
            { label: "Still open", value: r.filter((x) => x.closedAt === null && x.status !== "resolved" && x.status !== "closed").length },
        ],
        charts: [
            { key: "status", title: "Status", kind: "donut", field: "status" },
            ...dropdowns.map((d) => ({ key: `cf_${d.key}`, title: d.label, kind: "donut" as const, field: `cf_${d.key}` })),
        ],
    };
}

/* ------------------------------ hardware age ------------------------------ */

async function hardwareAge(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const refreshYears = svc.limit(input.refreshYears, 5, 1, 15);
    const { devices, truncated } = await svc.loadDevices(input);
    // Asked of whoever owns assets. Empty when assets are managed elsewhere, so the firmware date is used instead.
    const infos = await svc.assets.deviceAssetInfos(devices.map((d) => d.id));
    const byDevice = new Map([...infos].map(([id, a]) => [id, { purchase_date: a.purchaseDate, expires_at: a.warrantyEnd }]));
    const now = Date.now();

    const rows: Row[] = devices.map((d) => {
        const asset = byDevice.get(d.id);
        const purchased = asset?.purchase_date ?? null;
        const fromPurchase = purchased ? round1((now - purchased.getTime()) / (365.25 * DAY_MS)) : null;
        const fromFirmware = ageYears(d.health.biosDate);
        const age = fromPurchase ?? fromFirmware;
        const warranty = asset?.expires_at ?? null;
        const stage = age === null ? "Unknown" : age >= refreshYears ? "Replace now" : age >= refreshYears - 1 ? "Plan soon" : "Current";
        return {
            deviceId: d.id,
            customer: d.customer,
            site: d.site,
            name: d.name,
            model: d.model,
            serial: d.serial,
            cpu: d.cpu,
            ramGb: d.ramGb,
            purchaseDate: dateOnly(purchased),
            firmwareDate: d.health.biosDate,
            ageYears: age,
            ageSource: fromPurchase !== null ? "Purchase date" : fromFirmware !== null ? "Firmware date" : null,
            warrantyEnds: dateOnly(warranty),
            warrantyState: !warranty ? "Not recorded" : warranty.getTime() < now ? "Expired" : warranty.getTime() - now < 90 * DAY_MS ? "Ends within 90 days" : "In warranty",
            stage,
            replaceBy: age === null ? null : age >= refreshYears ? "Now" : String(new Date(now + (refreshYears - age) * 365.25 * DAY_MS).getUTCFullYear()),
        };
    });
    const order: Record<string, number> = { "Replace now": 0, "Plan soon": 1, Current: 2, Unknown: 3 };
    rows.sort((a, b) => order[String(a.stage)] - order[String(b.stage)] || Number(b.ageYears ?? -1) - Number(a.ageYears ?? -1));

    return {
        rows,
        truncated,
        params: { refreshYears },
        notes: ["Age comes from the purchase date on the device's asset record when there is one, and otherwise from the firmware date the agent reports. A firmware date is a few months older than the machine's purchase, so it errs on the old side."],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "model", label: "Model", pdf: true, weight: 1.4 },
            { key: "serial", label: "Serial", visible: false },
            { key: "cpu", label: "Processor", visible: false },
            { key: "ramGb", label: "RAM (GB)", type: "number", visible: false },
            { key: "purchaseDate", label: "Purchased", type: "date", visible: false },
            { key: "firmwareDate", label: "Firmware date", type: "date", visible: false },
            { key: "ageYears", label: "Age (years)", type: "number", pdf: true, weight: 0.7 },
            { key: "ageSource", label: "Age from", visible: false },
            { key: "warrantyEnds", label: "Warranty ends", type: "date", pdf: true, weight: 0.9 },
            { key: "warrantyState", label: "Warranty", type: "status", visible: false },
            { key: "stage", label: "Refresh", type: "status", pdf: true, weight: 0.9 },
            { key: "replaceBy", label: "Replace by", pdf: true, weight: 0.7 },
        ],
        summarize: (r) => [
            { label: "Devices", value: r.length },
            { label: "Replace now", value: count(r, "stage", "Replace now") },
            { label: "Plan within a year", value: count(r, "stage", "Plan soon") },
            { label: "Age unknown", value: count(r, "stage", "Unknown") },
            { label: "Average age (years)", value: (() => { const a = r.map((x) => x.ageYears).filter((x): x is number => typeof x === "number"); return a.length ? round1(a.reduce((s, x) => s + x, 0) / a.length) : "n/a"; })() },
        ],
        charts: [
            { key: "stage", title: "Refresh", kind: "donut", field: "stage" },
            { key: "age", title: "Age", kind: "bar", field: "ageYears", buckets: [{ label: "Under 2 years", max: 2 }, { label: "2 to 3 years", min: 2, max: 3 }, { label: "3 to 4 years", min: 3, max: 4 }, { label: "4 to 5 years", min: 4, max: 5 }, { label: "5 years or more", min: 5 }] },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ Windows support ------------------------------ */

type Lifecycle = { label: string; ends: string };

/** When Microsoft stops sending security updates for the Windows releases people still run. Home and Pro dates. */
const CLIENT_LIFECYCLE: Array<{ test: RegExp; label: string; ends: string }> = [
    { test: /windows 7/i, label: "Windows 7", ends: "2020-01-14" },
    { test: /windows 8/i, label: "Windows 8.1", ends: "2023-01-10" },
];
const WIN10_ENDS = "2025-10-14";
const WIN11_ENDS: Record<string, string> = { "21H2": "2023-10-10", "22H2": "2025-10-14", "23H2": "2025-11-11", "24H2": "2026-10-13", "25H2": "2027-10-12" };
const SERVER_ENDS: Array<{ test: RegExp; label: string; ends: string }> = [
    { test: /2008/, label: "Windows Server 2008", ends: "2020-01-14" },
    { test: /2012/, label: "Windows Server 2012", ends: "2023-10-10" },
    { test: /2016/, label: "Windows Server 2016", ends: "2027-01-12" },
    { test: /2019/, label: "Windows Server 2019", ends: "2029-01-09" },
    { test: /2022/, label: "Windows Server 2022", ends: "2031-10-14" },
    { test: /2025/, label: "Windows Server 2025", ends: "2034-10-10" },
];

function lifecycleOf(osName: string, version: string | null, build: string | null): Lifecycle | null {
    for (const s of SERVER_ENDS) if (/server/i.test(osName) && s.test.test(osName)) return { label: s.label, ends: s.ends };
    for (const c of CLIENT_LIFECYCLE) if (c.test.test(osName)) return { label: c.label, ends: c.ends };
    if (/windows 11/i.test(osName)) {
        const v = (version ?? "").toUpperCase();
        const ends = WIN11_ENDS[v];
        return { label: `Windows 11 ${v}`.trim(), ends: ends ?? "" };
    }
    if (/windows 10/i.test(osName)) return { label: `Windows 10 ${version ?? ""}`.trim(), ends: WIN10_ENDS };
    void build;
    return null;
}

/** Best guess at whether a processor is new enough for Windows 11: Intel 8th generation or newer, Ryzen 2000 or newer. */
function cpuSupportsWindows11(cpu: string | null): boolean | null {
    if (!cpu) return null;
    const intel = cpu.match(/\bi[3579]-(\d{4,5})/i);
    if (intel) return Number(intel[1].length === 5 ? intel[1].slice(0, 2) : intel[1].slice(0, 1)) >= 8;
    if (/core\s*ultra|\bn\d{3}\b|\bN\d{2,3}\b/i.test(cpu) && /intel/i.test(cpu)) return true;
    const ryzen = cpu.match(/ryzen\s*(?:[3579]|threadripper)\s*(?:pro\s*)?(\d)\d{3}/i);
    if (ryzen) return Number(ryzen[1]) >= 2;
    if (/xeon/i.test(cpu)) return null;
    return null;
}

async function windowsSupport(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const warnDays = svc.limit(input.warnDays, 180, 1, 730);
    const { devices, truncated } = await svc.loadDevices(input);
    const windows = devices.filter((d) => /windows/i.test(d.os) || /windows/i.test(d.health.osName ?? ""));
    const now = Date.now();

    const rows: Row[] = windows.map((d) => {
        const h = d.health;
        const osName = h.osName ?? d.os;
        const life = lifecycleOf(osName, h.osVersion, h.osBuild);
        const endsAt = life?.ends ? new Date(life.ends).getTime() : null;
        const daysLeft = endsAt === null ? null : Math.ceil((endsAt - now) / DAY_MS);
        const support = !life ? "Unknown" : endsAt === null ? "Unknown" : daysLeft! < 0 ? "Out of support" : daysLeft! <= warnDays ? "Ends soon" : "Supported";

        let ready: string | null = null;
        const blockers: string[] = [];
        if (/windows 10/i.test(osName) || /windows (7|8)/i.test(osName)) {
            const unknown: string[] = [];
            if (h.tpm === null) unknown.push("TPM");
            else if (h.tpm.present === false || h.tpm.enabled === false || (h.tpm.version && parseFloat(h.tpm.version) < 2)) blockers.push("TPM 2.0 needed");
            if (h.secureBoot === null) unknown.push("Secure Boot");
            else if (h.secureBoot === false) blockers.push("Secure Boot is off (it can often be switched on)");
            if (d.ramGb !== null && d.ramGb < 4) blockers.push("Under 4 GB of memory");
            const total = d.disks.reduce((s, x) => s + x.totalBytes, 0) / 1024 ** 3;
            if (d.disks.length && total < 64) blockers.push("Under 64 GB of storage");
            const cpu = cpuSupportsWindows11(d.cpu);
            if (cpu === false) blockers.push("Processor is too old");
            if (cpu === null) unknown.push("processor");
            ready = blockers.length ? "Not ready" : unknown.length ? "Probably ready" : "Ready";
            if (!blockers.length && unknown.length) blockers.push(`Not checked: ${unknown.join(", ")}`);
        }
        return {
            deviceId: d.id,
            customer: d.customer,
            site: d.site,
            name: d.name,
            status: d.online ? "Online" : "Offline",
            os: osName,
            version: h.osVersion,
            build: h.osBuild,
            supportEnds: life?.ends || null,
            daysLeft,
            support,
            windows11: ready,
            blockers: blockers.join("; "),
            model: d.model,
            cpu: d.cpu,
        };
    });
    const order: Record<string, number> = { "Out of support": 0, "Ends soon": 1, Unknown: 2, Supported: 3 };
    rows.sort((a, b) => order[String(a.support)] - order[String(b.support)] || String(a.customer).localeCompare(String(b.customer)) || String(a.name).localeCompare(String(b.name)));

    return {
        rows,
        truncated,
        params: { warnDays },
        notes: [
            "Windows only. Support dates are for Home and Pro editions; Enterprise and Education editions get a year or so longer, and Windows 10 machines enrolled in Extended Security Updates stay protected past the date shown.",
            "Windows 11 readiness checks TPM, Secure Boot, memory, storage and an estimate from the processor name. Items an older agent has not reported are listed as not checked rather than as failures.",
        ],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "status", label: "Status", type: "status", visible: false },
            { key: "os", label: "Windows", pdf: true, weight: 1.3 },
            { key: "version", label: "Version", pdf: true, weight: 0.6 },
            { key: "build", label: "Build", visible: false },
            { key: "supportEnds", label: "Support ends", type: "date", pdf: true, weight: 0.9 },
            { key: "daysLeft", label: "Days left", type: "number", visible: false },
            { key: "support", label: "Support", type: "status", pdf: true, weight: 0.9 },
            { key: "windows11", label: "Windows 11", type: "status", pdf: true, weight: 0.9 },
            { key: "blockers", label: "What stands in the way", pdf: true, weight: 2 },
            { key: "model", label: "Model", visible: false },
            { key: "cpu", label: "Processor", visible: false },
        ],
        summarize: (r) => [
            { label: "Windows devices", value: r.length },
            { label: "Out of support", value: count(r, "support", "Out of support") },
            { label: "Support ends soon", value: count(r, "support", "Ends soon") },
            { label: "Windows 10 ready for 11", value: r.filter((x) => x.windows11 === "Ready" || x.windows11 === "Probably ready").length },
            { label: "Windows 10 not ready", value: count(r, "windows11", "Not ready") },
        ],
        charts: [
            { key: "support", title: "Support", kind: "donut", field: "support" },
            { key: "os", title: "Windows version", kind: "bar", field: "os" },
            { key: "w11", title: "Windows 11 readiness", kind: "donut", field: "windows11" },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ stale devices ------------------------------ */

async function staleDevices(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const staleDays = svc.limit(input.notSeenDays, 30, 1, 730);
    const where = await svc.deviceWhere(input);
    const found = await svc.prisma.devices.findMany({
        where,
        take: 20_000,
        orderBy: [{ sites: { clients: { name: "asc" } } }, { hostname: "asc" }],
        select: {
            id: true, hostname: true, alias: true, operating_system: true, last_seen_at: true, created_at: true, primary_user: true,
            sites: { select: { name: true, clients: { select: { name: true } } } },
            agents: { select: { version: true, last_check_in_at: true } },
        },
    });
    const now = Date.now();
    const all: Row[] = found.map((d) => {
        const seen = d.agents?.last_check_in_at ?? d.last_seen_at ?? null;
        const days = seen ? Math.floor((now - seen.getTime()) / DAY_MS) : null;
        const sinceAdded = Math.floor((now - d.created_at.getTime()) / DAY_MS);
        const state = !d.agents ? "No agent" : days === null ? "Never seen" : days > staleDays ? "Stale" : "Current";
        return {
            deviceId: d.id,
            customer: d.sites?.clients.name ?? "",
            site: d.sites?.name ?? "",
            name: d.alias || d.hostname,
            os: d.operating_system,
            user: d.primary_user,
            agent: d.agents ? "Installed" : "None",
            agentVersion: d.agents?.version ?? null,
            lastSeenAt: seen,
            daysSince: days,
            addedDaysAgo: sinceAdded,
            state,
            suggestion: state === "Current" ? "" : (days ?? sinceAdded) > 90 ? "Probably retired: remove it" : state === "No agent" ? "Install the agent or remove it" : "Find out if it is still in use",
        };
    });
    const rows = all.filter((r) => r.state !== "Current");
    rows.sort((a, b) => Number(b.daysSince ?? 99999) - Number(a.daysSince ?? 99999));

    return {
        rows,
        truncated: found.length === 20_000,
        params: { notSeenDays: staleDays },
        notes: [`Only devices that are not current are listed: not seen for more than ${staleDays} days, never seen, or with no agent. ${all.length - rows.length} of ${all.length} devices are current.`],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "os", label: "OS", pdf: true, weight: 0.8 },
            { key: "user", label: "User", visible: false },
            { key: "agent", label: "Agent", pdf: true, weight: 0.6 },
            { key: "agentVersion", label: "Agent version", visible: false },
            { key: "lastSeenAt", label: "Last seen", type: "date", pdf: true, weight: 1.1 },
            { key: "daysSince", label: "Days since", type: "number", pdf: true, weight: 0.6 },
            { key: "addedDaysAgo", label: "Added (days ago)", type: "number", visible: false },
            { key: "state", label: "State", type: "status", pdf: true, weight: 0.8 },
            { key: "suggestion", label: "Suggestion", pdf: true, weight: 1.8 },
        ],
        summarize: (r) => [
            { label: "Stale devices", value: r.length },
            { label: "No agent", value: count(r, "state", "No agent") },
            { label: "Never seen", value: count(r, "state", "Never seen") },
            { label: "Probably retired", value: r.filter((x) => String(x.suggestion).startsWith("Probably")).length },
        ],
        charts: [
            { key: "state", title: "State", kind: "donut", field: "state" },
            { key: "age", title: "Time since last seen", kind: "bar", field: "daysSince", buckets: [{ label: "Up to 30 days", max: 30 }, { label: "30 to 90 days", min: 30, max: 90 }, { label: "90 to 180 days", min: 90, max: 180 }, { label: "Over 180 days", min: 180 }] },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ automatic patching ------------------------------ */

async function automaticPatching(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const where = await svc.deviceWhere(input);
    const found = await svc.prisma.devices.findMany({
        where,
        take: 20_000,
        orderBy: [{ sites: { clients: { name: "asc" } } }, { hostname: "asc" }],
        select: {
            id: true, hostname: true, alias: true, operating_system: true,
            sites: { select: { name: true, clients: { select: { name: true, organization_id: true } } } },
            agents: { select: { facts: true, version: true } },
        },
    });
    // Windows devices, and Linux devices whose agent runs patch tasks.
    const windows = found.filter((d) => canPatch(patchOs(d.agents?.facts, d.operating_system), d.agents?.version));
    const skipped = found.length - windows.length;
    const ids = windows.map((d) => d.id);
    const organizationId = windows[0]?.sites?.clients.organization_id;
    const effective = ids.length ? await svc.policies.effectiveForDevices(ids, organizationId) : new Map();
    const actions = ids.length
        ? await svc.prisma.policy_actions.findMany({ where: { device_id: { in: ids }, kind: { in: ["patch_install", "reboot"] } }, orderBy: { created_at: "desc" }, select: { device_id: true, kind: true, created_at: true, detail: true } })
        : [];
    const last = (deviceId: string, kind: string) => actions.find((a) => a.device_id === deviceId && a.kind === kind);

    const approveText: Record<string, string> = { none: "By hand", critical: "Critical and important", all: "Every update" };
    const restartText: Record<string, string> = { never: "By hand", maintenance: "In a window", always: "Straight away" };
    const rows: Row[] = windows.map((d) => {
        const e = effective.get(d.id);
        const approve = String(e?.scalars["patching.approve"]?.value ?? "none");
        const installIn = String(e?.scalars["patching.installIn"]?.value ?? "anytime");
        const reboot = String(e?.scalars["patching.reboot"]?.value ?? "never");
        const m = e ? svc.policies.maintenanceOf(e) : null;
        const src = e?.scalars["patching.approve"]?.source?.kind === "policy" ? e.scalars["patching.approve"].source.name : e?.scalars["patching.reboot"]?.source?.kind === "policy" ? e.scalars["patching.reboot"].source.name : "";
        const pending = (d.agents?.facts as any)?.device?.boot?.pendingReboot;
        const install = last(d.id, "patch_install");
        const restart = last(d.id, "reboot");
        const automatic = approve !== "none" || reboot !== "never";
        const waiting = automatic && (installIn === "maintenance" || reboot === "maintenance") && !m?.activeNow;
        return {
            deviceId: d.id,
            customer: d.sites?.clients.name ?? "",
            site: d.sites?.name ?? "",
            name: d.alias || d.hostname,
            mode: !automatic ? "By hand" : waiting ? "Waiting for window" : "Automatic",
            installs: approveText[approve] ?? approve,
            when: installIn === "maintenance" ? "Only in a window" : "Any time",
            restarts: restartText[reboot] ?? reboot,
            policy: src,
            window: m ? (m.activeNow ? `Open: ${m.activeNow}` : m.next ? `Next: ${m.next.name}` : "None soon") : "None",
            lastInstallAt: install?.created_at ?? null,
            lastInstallCount: install ? Number((install.detail as any)?.count ?? 0) : null,
            lastRestartAt: restart?.created_at ?? null,
            restartPending: pending === true ? "Yes" : pending === false ? "No" : "Not reported",
        };
    });

    return {
        rows,
        truncated: found.length === 20_000,
        params: {},
        notes: [
            "Windows devices and Linux devices (with an agent that can patch) are listed, because patching policies act on both. On Linux, \"critical and important\" means security updates.",
            ...(skipped ? [`${skipped} device${skipped === 1 ? "" : "s"} that ${skipped === 1 ? "is" : "are"} not Windows or Linux, or ${skipped === 1 ? "has" : "have"} a Linux agent too old to patch, ${skipped === 1 ? "is" : "are"} left out.`] : []),
            "A device marked By hand has no policy that patches it, so updates are installed from its device page. A restart shown as pending means the device is waiting for one; it is not reported by older agents.",
        ],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site", visible: false },
            { key: "name", label: "Device", pdf: true },
            { key: "mode", label: "Patching", type: "status", pdf: true, weight: 1 },
            { key: "installs", label: "Installs", pdf: true, weight: 1.2 },
            { key: "when", label: "When", pdf: true, weight: 0.9 },
            { key: "restarts", label: "Restarts", pdf: true, weight: 0.9 },
            { key: "policy", label: "Set by policy", pdf: true, weight: 1.4 },
            { key: "window", label: "Maintenance window", visible: false },
            { key: "lastInstallAt", label: "Last automatic install", type: "date", pdf: true, weight: 1.1 },
            { key: "lastInstallCount", label: "Updates", type: "number", visible: false },
            { key: "lastRestartAt", label: "Last automatic restart", type: "date", visible: false },
            { key: "restartPending", label: "Restart pending", type: "status", pdf: true, weight: 0.8 },
        ],
        summarize: (r) => [
            { label: "Devices", value: r.length },
            { label: "Automatic", value: count(r, "mode", "Automatic") + count(r, "mode", "Waiting for window") },
            { label: "By hand", value: count(r, "mode", "By hand") },
            { label: "Waiting for a window", value: count(r, "mode", "Waiting for window") },
            { label: "Restart pending", value: count(r, "restartPending", "Yes") },
        ],
        charts: [
            { key: "mode", title: "How devices are patched", kind: "donut", field: "mode" },
            { key: "pending", title: "Restart pending", kind: "donut", field: "restartPending" },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ outdated software ------------------------------ */

async function outdatedSoftware(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const where = await svc.deviceWhere(input);
    const found = await svc.prisma.devices.findMany({
        where,
        take: 20_000,
        select: { id: true, operating_system: true, agents: { select: { id: true, facts: true } }, sites: { select: { clients: { select: { id: true, name: true } } } } },
    });
    const windows = found.filter((d) => d.agents && (/^windows/i.test(d.operating_system ?? "") || String((d.agents.facts as any)?.os ?? "").toLowerCase() === "windows"));
    const agentIds = windows.map((d) => d.agents!.id);
    const customerOf = new Map(windows.map((d) => [d.agents!.id, d.sites?.clients?.name ?? ""]));
    const [outdated, scans] = agentIds.length
        ? await Promise.all([
            svc.prisma.agent_outdated_software.findMany({ where: { agent_id: { in: agentIds } } }),
            svc.prisma.agent_software_scans.findMany({ where: { agent_id: { in: agentIds }, scanned_at: { not: null } }, select: { agent_id: true, scanned_at: true } }),
        ])
        : [[], []];
    type Acc = { source: string; appId: string; names: Map<string, number>; agents: Set<string>; customers: Set<string>; versions: Map<string, number>; available: Set<string>; approx: boolean };
    const apps = new Map<string, Acc>();
    for (const o of outdated) {
        const key = `${o.source}\u0001${o.app_id.toLowerCase()}`;
        const a = apps.get(key) ?? { source: o.source, appId: o.app_id, names: new Map(), agents: new Set(), customers: new Set(), versions: new Map(), available: new Set(), approx: false };
        const v = String(o.name ?? "");
        const clean = o.installed_version ? v.split(o.installed_version).join(" ").replace(/\s{2,}/g, " ").trim() || v : v;
        a.names.set(clean, (a.names.get(clean) ?? 0) + 1);
        a.agents.add(o.agent_id);
        a.customers.add(customerOf.get(o.agent_id) ?? "");
        const iv = o.installed_version ?? "unknown";
        a.versions.set(iv, (a.versions.get(iv) ?? 0) + 1);
        a.available.add(o.available_version);
        a.approx = a.approx || o.approximate;
        apps.set(key, a);
    }
    const rows: Row[] = [...apps.values()].map((a) => {
        const versions = [...a.versions.entries()].sort((x, y) => y[1] - x[1]);
        const name = [...a.names.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? a.appId;
        return {
            name,
            appId: a.appId,
            source: a.source === "chocolatey" ? "Chocolatey" : "winget",
            devices: a.agents.size,
            customers: [...a.customers].filter(Boolean).length,
            installedVersions: versions.slice(0, 6).map(([v, n]) => `${v} (${n})`).join(", ") + (versions.length > 6 ? `, +${versions.length - 6} more` : ""),
            availableVersion: [...a.available].slice(0, 3).join(", "),
            uncertain: a.approx ? "Some versions only known as an upper bound" : "",
        };
    }).sort((x, y) => Number(y.devices) - Number(x.devices) || String(x.name).localeCompare(String(y.name)));
    const unscanned = windows.length - scans.length;
    const oldest = scans.reduce<Date | null>((m, s) => (s.scanned_at && (!m || s.scanned_at < m) ? s.scanned_at : m), null);
    return {
        rows,
        truncated: found.length === 20_000,
        params: {},
        notes: [
            "Only Windows devices that have been scanned are counted. A scan is started from the device page, from the Outdated apps screen, or on a schedule set by a policy.",
            `${scans.length} of ${windows.length} Windows device${windows.length === 1 ? "" : "s"} ${scans.length === 1 ? "has" : "have"} been scanned${oldest ? `; the oldest scan is from ${dateOnly(oldest)}` : ""}.${unscanned > 0 ? ` ${unscanned} not yet scanned ${unscanned === 1 ? "is" : "are"} not in these numbers.` : ""}`,
            "Programs a device cannot report on (winget or Chocolatey missing, or an older agent) are not counted.",
        ],
        columns: [
            { key: "name", label: "Program", pdf: true, weight: 2 },
            { key: "appId", label: "Package id", pdf: true, weight: 1.6 },
            { key: "source", label: "Source", type: "status", pdf: true, weight: 0.8 },
            { key: "devices", label: "Devices", type: "number", pdf: true, weight: 0.7 },
            { key: "customers", label: "Customers", type: "number", pdf: true, weight: 0.7 },
            { key: "installedVersions", label: "Installed versions (devices)", pdf: true, weight: 2 },
            { key: "availableVersion", label: "Newest available", pdf: true, weight: 1.1 },
            { key: "uncertain", label: "Note", visible: false },
        ],
        summarize: (r) => [
            { label: "Outdated programs", value: r.length },
            { label: "Out-of-date installs", value: r.reduce((n, x) => n + Number(x.devices ?? 0), 0) },
            { label: "Devices scanned", value: scans.length },
            { label: "Not yet scanned", value: Math.max(unscanned, 0) },
        ],
        charts: [
            { key: "source", title: "By source", kind: "donut", field: "source" },
        ],
    };
}

/* ------------------------------ security posture ------------------------------ */

async function securityPosture(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const { devices, truncated } = await svc.loadDevices(input);
    // Windows and Linux devices are scanned; the name "windows" below is from before Linux was added.
    const windows = devices.filter((d) => /^windows/i.test(d.os) || /^linux$|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle/i.test(d.os));
    const scans = windows.length ? await svc.prisma.device_security_scans.findMany({ where: { device_id: { in: windows.map((d) => d.id) } } }) : [];
    const byDevice = new Map(scans.map((s) => [s.device_id, s]));
    const rows: Row[] = windows.map((d) => {
        const s = byDevice.get(d.id);
        const stored = s?.scanned_at && s.raw && typeof s.raw === "object" ? (s.raw as any) : null;
        const scan = stored as ScanData | null;
        const lx = stored && stored.platform === "linux" ? linuxHighlights(stored.probes) : null;
        const h = scan && !lx ? highlights(scan.probes) : null;
        const failed = (s?.failed_rules ?? []).map((id) => RULE_BY_ID.get(id) ?? LINUX_RULE_BY_ID.get(id)).filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
        const state = scan ? "Scanned" : s && !s.ok && s.message ? "Scan failed" : s?.pending_job_id ? "Scan waiting" : "Not scanned";
        return {
            deviceId: d.id,
            customer: d.customer,
            site: d.site,
            name: d.name,
            status: d.online ? "Online" : "Offline",
            state,
            score: scan ? s!.score : null,
            grade: scan && s!.grade ? s!.grade : "Not scanned",
            criticalFailed: scan ? s!.critical_failed : null,
            highFailed: scan ? s!.high_failed : null,
            failedChecks: failed.slice(0, 8).map((r) => `${r.title} (${r.severity})`).join("; ") + (failed.length > 8 ? `; +${failed.length - 8} more` : ""),
            unreadable: scan ? s!.unknown_count : null,
            defender: lx ? lx.antivirus.label.text : h ? h.defender.label.text : "",
            signatureAge: h ? h.defender.signatureAgeDays : null,
            bitlocker: lx ? lx.encryption.label.text : h ? h.bitlocker.label.text : "",
            firewall: lx ? lx.firewall.label.text : h ? h.firewall.label.text : "",
            scannedAt: s?.scanned_at ?? null,
        };
    });
    const order: Record<string, number> = { F: 0, D: 1, C: 2, B: 3, A: 4 };
    rows.sort((a, b) => (order[String(a.grade)] ?? 5) - (order[String(b.grade)] ?? 5) || Number(a.score ?? 1000) - Number(b.score ?? 1000) || String(a.name).localeCompare(String(b.name)));
    const scanned = rows.filter((r) => r.state === "Scanned");
    return {
        rows,
        truncated,
        params: {},
        notes: [
            "Only Windows and Linux devices with an agent are listed. A scan is run from the device\x27s Security tab, from the device list, or on a schedule a policy sets (Policies > Security). The score is the share of baseline checks passed (checks a device could not read are left out); a failed critical check caps the grade.",
            `${scanned.length} of ${rows.length} device${rows.length === 1 ? "" : "s"} ${scanned.length === 1 ? "has" : "have"} been scanned.`,
        ],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "status", label: "Status", type: "status", visible: false },
            { key: "state", label: "Scan", type: "status", visible: false },
            { key: "score", label: "Score", type: "number", pdf: true, weight: 0.6 },
            { key: "grade", label: "Grade", type: "status", pdf: true, weight: 0.8 },
            { key: "criticalFailed", label: "Critical failed", type: "number", pdf: true, weight: 0.8 },
            { key: "highFailed", label: "High failed", type: "number", weight: 0.7 },
            { key: "failedChecks", label: "Failed checks", pdf: true, weight: 2.6 },
            { key: "unreadable", label: "Could not read", type: "number", visible: false },
            { key: "defender", label: "Antivirus", pdf: true, weight: 1.6 },
            { key: "signatureAge", label: "Definitions age (days)", type: "number", visible: false },
            { key: "bitlocker", label: "Disk encryption", pdf: true, weight: 1.2 },
            { key: "firewall", label: "Firewall", weight: 1 },
            { key: "scannedAt", label: "Last scan", type: "date" },
        ],
        summarize: (r) => {
            const done = r.filter((x) => x.state === "Scanned");
            const scores = done.map((x) => x.score).filter((x): x is number => typeof x === "number");
            return [
                { label: "Devices", value: r.length },
                { label: "Average score", value: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : "n/a" },
                { label: "Grade A or B", value: r.filter((x) => x.grade === "A" || x.grade === "B").length },
                { label: "Grade D or F", value: r.filter((x) => x.grade === "D" || x.grade === "F").length },
                { label: "With a failed critical check", value: done.filter((x) => Number(x.criticalFailed ?? 0) > 0).length },
                { label: "Not scanned", value: r.length - done.length },
            ];
        },
        charts: [
            { key: "grade", title: "Grades", kind: "bar", field: "grade" },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ network map ------------------------------ */

async function networkMap(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const { devices, truncated } = await svc.loadDevices(input);
    const rows: Row[] = [];
    for (const d of devices) {
        for (const nic of d.health.nics) {
            for (const ip of nic.ipv4.length ? nic.ipv4 : [""]) {
                if (!ip && !nic.mac) continue;
                const octets = ip.split(".");
                rows.push({
                    deviceId: d.id,
                    customer: d.customer,
                    site: d.site,
                    name: d.name,
                    status: d.online ? "Online" : "Offline",
                    adapter: nic.description,
                    ip: ip || null,
                    network: octets.length === 4 ? `${octets.slice(0, 3).join(".")}.0/24` : null,
                    gateway: nic.gateway,
                    mac: nic.mac,
                    duplicate: false,
                    conflict: "",
                });
            }
        }
        // Devices from an older agent only have the one address.
        if (!d.health.nics.length && d.ip) {
            const octets = d.ip.split(".");
            rows.push({ deviceId: d.id, customer: d.customer, site: d.site, name: d.name, status: d.online ? "Online" : "Offline", adapter: null, ip: d.ip, network: octets.length === 4 ? `${octets.slice(0, 3).join(".")}.0/24` : null, gateway: null, mac: null, duplicate: false, conflict: "" });
        }
    }
    // The same address on two devices in one customer, ignoring link-local and loopback.
    const seen = new Map<string, Set<string>>();
    for (const r of rows) {
        const ip = String(r.ip ?? "");
        if (!ip || ip.startsWith("169.254.") || ip.startsWith("127.")) continue;
        const key = `${r.customer}/${ip}`;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)!.add(String(r.deviceId));
    }
    for (const r of rows) {
        const devicesWith = seen.get(`${r.customer}/${r.ip}`);
        if (devicesWith && devicesWith.size > 1) {
            r.duplicate = true;
            r.conflict = `Also used by ${devicesWith.size - 1} other device${devicesWith.size === 2 ? "" : "s"}`;
        }
    }
    rows.sort((a, b) => String(a.customer).localeCompare(String(b.customer)) || String(a.network ?? "").localeCompare(String(b.network ?? ""), undefined, { numeric: true }) || String(a.ip ?? "").localeCompare(String(b.ip ?? ""), undefined, { numeric: true }));

    return {
        rows,
        truncated,
        notes: ["Networks are shown as a /24 around each address, which is right for most small networks but only a guide for larger ones. Link-local (169.254) and loopback addresses are never counted as conflicts."],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "duplicate", label: "Conflict flag", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site", pdf: true, weight: 0.8 },
            { key: "name", label: "Device", pdf: true },
            { key: "status", label: "Status", type: "status", visible: false },
            { key: "adapter", label: "Adapter", pdf: true, weight: 1.4 },
            { key: "ip", label: "IP address", pdf: true },
            { key: "network", label: "Network", pdf: true },
            { key: "gateway", label: "Gateway", pdf: true },
            { key: "mac", label: "MAC address", pdf: true },
            { key: "conflict", label: "Conflict", pdf: true, weight: 1.2 },
        ],
        summarize: (r) => [
            { label: "Addresses", value: r.length },
            { label: "Devices", value: new Set(r.map((x) => x.deviceId)).size },
            { label: "Networks", value: new Set(r.map((x) => `${x.customer}/${x.network}`).filter((x) => !x.endsWith("/null"))).size },
            { label: "Address conflicts", value: r.filter((x) => x.duplicate === true).length },
        ],
        charts: [
            { key: "network", title: "Addresses by network", kind: "bar", field: "network", top: 10 },
            { key: "gateway", title: "Gateways", kind: "bar", field: "gateway", top: 8 },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ security score ------------------------------ */

/** Points each check is worth. Only the checks a device has reported count toward its score. */
const SCORE_WEIGHTS = { antivirus: 25, firewall: 20, encryption: 25, secureBoot: 10, tpm: 5, patching: 15 } as const;

async function securityScore(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const maxDefinitionAge = svc.limit(input.maxDefinitionAgeDays, 7, 1, 90);
    const { devices, truncated } = await svc.loadDevices(input);
    // Patching comes from the patch compliance report, so the two always agree.
    const patching = await svc.patchCompliance({ ...input });
    const patchByDevice = new Map(patching.rows.map((r) => [String(r.deviceId), String(r.result)]));

    const rows: Row[] = devices.map((d: DeviceFacts) => {
        const h = d.health;
        const parts: Array<{ name: string; weight: number; earned: number; problem: string | null }> = [];
        const av = avVerdict(h, maxDefinitionAge);
        if (av.state !== "unknown") parts.push({ name: "antivirus", weight: SCORE_WEIGHTS.antivirus, earned: av.state === "ok" ? 1 : av.state === "old" ? 0.4 : 0, problem: av.state === "ok" ? null : av.text });
        if (h.firewall) {
            const off = firewallOff(h);
            parts.push({ name: "firewall", weight: SCORE_WEIGHTS.firewall, earned: 1 - off.length / 3, problem: off.length ? `Firewall off: ${off.join(", ")}` : null });
        }
        const enc = encryptionVerdict(h);
        if (enc.state !== "unknown") parts.push({ name: "encryption", weight: SCORE_WEIGHTS.encryption, earned: enc.state === "protected" ? 1 : 0, problem: enc.state === "protected" ? null : enc.text });
        if (h.secureBoot !== null) parts.push({ name: "secureBoot", weight: SCORE_WEIGHTS.secureBoot, earned: h.secureBoot ? 1 : 0, problem: h.secureBoot ? null : "Secure Boot is off" });
        if (h.tpm && h.tpm.present !== null) parts.push({ name: "tpm", weight: SCORE_WEIGHTS.tpm, earned: h.tpm.present && h.tpm.enabled !== false ? 1 : 0, problem: h.tpm.present && h.tpm.enabled !== false ? null : "No working TPM" });
        const patch = patchByDevice.get(d.id);
        if (patch && patch !== "Not scanned" && patch !== "Scan failed") parts.push({ name: "patching", weight: SCORE_WEIGHTS.patching, earned: patch === "Compliant" ? 1 : patch === "Scan overdue" ? 0.5 : 0, problem: patch === "Compliant" ? null : patch === "Scan overdue" ? "Patch scan is overdue" : "Patches are missing" });

        const possible = parts.reduce((s, p) => s + p.weight, 0);
        const earned = parts.reduce((s, p) => s + p.weight * p.earned, 0);
        const coverage = Math.round((possible / Object.values(SCORE_WEIGHTS).reduce((s, x) => s + x, 0)) * 100);
        // A score from very little evidence would mislead, so under a third of the checks reported is "not enough data".
        const score = possible === 0 || coverage < 33 ? null : Math.round((earned / possible) * 100);
        const grade = score === null ? "Not enough data" : score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
        return {
            deviceId: d.id,
            customer: d.customer,
            site: d.site,
            name: d.name,
            status: d.online ? "Online" : "Offline",
            score,
            grade,
            coverage,
            weakest: parts.filter((p) => p.problem).sort((a, b) => b.weight * (1 - b.earned) - a.weight * (1 - a.earned)).map((p) => p.problem).join("; "),
        };
    });
    rows.sort((a, b) => Number(a.score ?? 1000) - Number(b.score ?? 1000));

    return {
        rows,
        truncated,
        params: { maxDefinitionAgeDays: maxDefinitionAge },
        notes: [
            "Points: antivirus 25, disk encryption 25, firewall 20, patching 15, Secure Boot 10, TPM 5. Only checks a device has reported count, so an older agent is not marked down for what it cannot see; \"Coverage\" shows how much of the score was measured.",
            "A device with under a third of the checks reported is shown as \"Not enough data\" instead of a score.",
        ],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "status", label: "Status", type: "status", visible: false },
            { key: "score", label: "Score", type: "number", pdf: true, weight: 0.6 },
            { key: "grade", label: "Grade", type: "status", pdf: true, weight: 0.8 },
            { key: "coverage", label: "Coverage (%)", type: "percent", pdf: true, weight: 0.7 },
            { key: "weakest", label: "What is costing points", pdf: true, weight: 2.6 },
        ],
        summarize: (r) => {
            const scored = r.map((x) => x.score).filter((x): x is number => typeof x === "number");
            return [
                { label: "Devices", value: r.length },
                { label: "Average score", value: scored.length ? Math.round(scored.reduce((s, x) => s + x, 0) / scored.length) : "n/a" },
                { label: "Grade A or B", value: r.filter((x) => x.grade === "A" || x.grade === "B").length },
                { label: "Grade D or F", value: r.filter((x) => x.grade === "D" || x.grade === "F").length },
                { label: "Not enough data", value: count(r, "grade", "Not enough data") },
            ];
        },
        charts: [
            { key: "grade", title: "Grades", kind: "bar", field: "grade" },
            { key: "score", title: "Score", kind: "bar", field: "score", buckets: [{ label: "Under 60", max: 60 }, { label: "60 to 70", min: 60, max: 70 }, { label: "70 to 80", min: 70, max: 80 }, { label: "80 to 90", min: 80, max: 90 }, { label: "90 or more", min: 90 }] },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}
