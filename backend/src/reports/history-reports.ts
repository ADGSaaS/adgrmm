// backend/src/reports/history-reports.ts
//
// Reports that look at change over time (availability, disk space, the change log, how fast patches go on) and the
// risky-configuration report that reads the newer agent data. Same engine as the others; only types are imported from
// it, so there is no import cycle.
import type { Built, EndpointReportsService, ReportDefinition, ReportInput } from "./endpoint-reports.service";
import { readPatches, severityRank } from "./patch-data";
import type { Row } from "./report-view";

export type HistoryKey = "availability" | "disk-trend" | "change-log" | "patch-speed" | "risky-configuration" | "antivirus-threats";

export const HISTORY_CATALOG: ReportDefinition[] = [
    {
        key: "availability",
        title: "Availability and uptime",
        group: "Health",
        description: "How much of the time each device was online over the period, from checks every 15 minutes, with its worst day and a target to measure against.",
        scoped: true,
        dated: true,
        params: [
            { key: "targetPercent", label: "Target availability (%)", type: "number", default: 99, min: 50, max: 100 },
            { key: "businessHoursOnly", label: "Business hours only (yes or no)", type: "text", default: "no", help: "Type yes to count only the working day set in Reports, Business hours." },
        ],
        permission: "devices.read",
    },
    {
        key: "disk-trend",
        title: "Disk space trend",
        group: "Health",
        description: "How fast each device's disks are filling or emptying over the period, and how many days are left before they are full at that rate.",
        scoped: true,
        dated: true,
        params: [{ key: "warnDays", label: "Warn when full within (days)", type: "number", default: 60, min: 1, max: 730 }],
        permission: "devices.read",
    },
    {
        key: "change-log",
        title: "Change log",
        group: "Activity",
        description: "Software installed, removed and updated, and hardware or Windows changes, noticed when each device reported in.",
        scoped: true,
        dated: true,
        params: [{ key: "q", label: "Device or change contains", type: "text" }],
        permission: "devices.read",
    },
    {
        key: "patch-speed",
        title: "Patch speed",
        group: "Patching",
        description: "How many days patches stayed missing before they were installed, from the history of patch scans, and the ones still missing now.",
        scoped: true,
        dated: true,
        params: [{ key: "slowDays", label: "Counts as slow after (days)", type: "number", default: 14, min: 1, max: 365 }],
        permission: "devices.read",
    },
    {
        key: "risky-configuration",
        title: "Risky configuration",
        group: "Security",
        description: "Settings that put a device at risk: Remote Desktop without network-level authentication, SMBv1, automatic logon, User Account Control off, a guest account, too many local administrators, weak password rules and screens that never lock.",
        scoped: true,
        dated: false,
        params: [{ key: "maxLocalAdmins", label: "Too many local administrators above", type: "number", default: 3, min: 1, max: 50 }],
        permission: "devices.read",
    },
];

HISTORY_CATALOG.push({
    key: "antivirus-threats",
    title: "Antivirus threats",
    group: "Security",
    description: "Threats Windows Defender found on each device in the period, how serious they were, and whether they were dealt with. Devices not using Defender, or whose agent has not reported yet, are listed as not reporting.",
    scoped: true,
    dated: true,
    params: [],
    permission: "devices.read",
});

export const HISTORY_BUILDERS: Record<HistoryKey, (svc: EndpointReportsService, input: ReportInput) => Promise<Built>> = {
    "antivirus-threats": antivirusThreats,
    availability,
    "disk-trend": diskTrend,
    "change-log": changeLog,
    "patch-speed": patchSpeed,
    "risky-configuration": riskyConfiguration,
};

const DAY = 86_400_000;
const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;
const count = (rows: Row[], key: string, value: unknown) => rows.filter((r) => r[key] === value).length;
const dayText = (d: Date) => d.toISOString().slice(0, 10);

async function scopedDevices(svc: EndpointReportsService, input: ReportInput) {
    const found = await svc.prisma.devices.findMany({
        where: await svc.deviceWhere(input),
        take: 20_000,
        orderBy: [{ sites: { clients: { name: "asc" } } }, { hostname: "asc" }],
        select: { id: true, hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true } } } }, agents: { select: { id: true } } },
    });
    const byId = new Map(found.map((d) => [d.id, { name: d.alias || d.hostname, site: d.sites?.name ?? "", customer: d.sites?.clients.name ?? "", agentId: d.agents?.id ?? null }]));
    return { ids: found.map((d) => d.id), byId };
}

/* ------------------------------ availability ------------------------------ */

async function availability(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const target = svc.limit(input.targetPercent, 99, 50, 100);
    const businessOnly = /^(yes|y|true|1)$/i.test(String(input.businessHoursOnly ?? "").trim());
    const { start, end, from, to } = svc.period(input);
    const devices = await scopedDevices(svc, input);
    const days = await svc.prisma.device_daily.findMany({
        where: { device_id: { in: devices.ids }, day: { gte: start, lt: end } },
        select: { device_id: true, day: true, samples: true, online_samples: true, business_samples: true, business_online_samples: true },
    });
    const byDevice = new Map<string, typeof days>();
    // In business hours only, a day counts for what happened inside the working day, and weekends and nights drop out.
    for (const d of days) {
        const row = businessOnly ? { ...d, samples: d.business_samples, online_samples: d.business_online_samples } : d;
        if (businessOnly && !row.samples) continue;
        byDevice.set(d.device_id, [...(byDevice.get(d.device_id) ?? []), row]);
    }

    const rows: Row[] = [];
    for (const [id, meta] of devices.byId) {
        if (!meta.agentId) continue;
        const list = byDevice.get(id) ?? [];
        const samples = list.reduce((s, d) => s + d.samples, 0);
        const online = list.reduce((s, d) => s + d.online_samples, 0);
        const percent = samples ? round1((online / samples) * 100) : null;
        const worst = list.filter((d) => d.samples >= 4).map((d) => ({ day: d.day, pct: (d.online_samples / d.samples) * 100 })).sort((a, b) => a.pct - b.pct)[0];
        rows.push({
            deviceId: id,
            customer: meta.customer,
            site: meta.site,
            name: meta.name,
            daysCovered: list.length,
            availability: percent,
            offlineHours: samples ? round1(((samples - online) * 15) / 60) : null,
            worstDay: worst ? dayText(worst.day) : null,
            worstDayPercent: worst ? round1(worst.pct) : null,
            result: percent === null ? "No data" : percent >= target ? "Meets target" : percent >= target - 5 ? "Slightly below" : "Below target",
        });
    }
    rows.sort((a, b) => Number(a.availability ?? 101) - Number(b.availability ?? 101));

    return {
        rows,
        truncated: false,
        period: { from, to },
        params: { targetPercent: target, ...(businessOnly ? { businessHoursOnly: "yes" } : {}) },
        notes: [...(businessOnly ? ["Only checks made during the working day set under Business hours are counted, so nights and weekends do not count against a device. Business-hours history starts when this was first switched on."] : []), "Availability is the share of checks, made every 15 minutes, at which the device's agent had reported in within the last five minutes. A device that was switched off overnight counts as unavailable overnight. History starts when this was first switched on, so a device only has data from then."],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "daysCovered", label: "Days of data", type: "number", visible: false },
            { key: "availability", label: "Availability (%)", type: "percent", pdf: true, weight: 0.9 },
            { key: "offlineHours", label: "Hours offline", type: "number", pdf: true, weight: 0.7 },
            { key: "worstDay", label: "Worst day", type: "date", pdf: true, weight: 0.9 },
            { key: "worstDayPercent", label: "Worst day (%)", type: "percent", visible: false },
            { key: "result", label: "Result", type: "status", pdf: true, weight: 0.9 },
        ],
        summarize: (r) => {
            const values = r.map((x) => x.availability).filter((x): x is number => typeof x === "number");
            return [
                { label: "Devices", value: r.length },
                { label: "Average availability", value: values.length ? `${round1(values.reduce((s, x) => s + x, 0) / values.length)}%` : "n/a" },
                { label: "Meet the target", value: count(r, "result", "Meets target") },
                { label: "Below target", value: count(r, "result", "Below target") + count(r, "result", "Slightly below") },
                { label: "No data yet", value: count(r, "result", "No data") },
            ];
        },
        charts: [
            { key: "result", title: "Result", kind: "donut", field: "result" },
            { key: "avail", title: "Availability", kind: "bar", field: "availability", buckets: [{ label: "Under 90%", max: 90 }, { label: "90 to 95%", min: 90, max: 95 }, { label: "95 to 99%", min: 95, max: 99 }, { label: "99% or more", min: 99 }] },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ disk space trend ------------------------------ */

async function diskTrend(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const warnDays = svc.limit(input.warnDays, 60, 1, 730);
    const { start, end, from, to } = svc.period(input);
    const devices = await scopedDevices(svc, input);
    const days = await svc.prisma.device_daily.findMany({
        where: { device_id: { in: devices.ids }, day: { gte: start, lt: end }, disk_free_bytes: { not: null } },
        orderBy: { day: "asc" },
        select: { device_id: true, day: true, disk_free_bytes: true, disk_total_bytes: true },
    });
    const byDevice = new Map<string, typeof days>();
    for (const d of days) byDevice.set(d.device_id, [...(byDevice.get(d.device_id) ?? []), d]);

    const rows: Row[] = [];
    for (const [id, list] of byDevice) {
        const meta = devices.byId.get(id)!;
        const first = list[0];
        const last = list[list.length - 1];
        const span = Math.max(1, Math.round((last.day.getTime() - first.day.getTime()) / DAY));
        const freeNow = Number(last.disk_free_bytes) / GB;
        const freeThen = Number(first.disk_free_bytes) / GB;
        const total = Number(last.disk_total_bytes ?? 0) / GB;
        const perDay = (freeThen - freeNow) / span;
        const daysLeft = perDay > 0.01 ? Math.round(freeNow / perDay) : null;
        const state = list.length < 3 ? "Not enough data" : daysLeft !== null && daysLeft <= warnDays ? "Full soon" : perDay > 0.05 ? "Filling" : perDay < -0.05 ? "Freeing up" : "Stable";
        rows.push({
            deviceId: id,
            customer: meta.customer,
            site: meta.site,
            name: meta.name,
            daysCovered: list.length,
            totalGb: round1(total),
            freeGb: round1(freeNow),
            freePercent: total ? round1((freeNow / total) * 100) : null,
            changeGb: round1(freeNow - freeThen),
            gbPerDay: round1(perDay * 10) / 10,
            daysUntilFull: state === "Not enough data" ? null : daysLeft,
            state,
        });
    }
    const order: Record<string, number> = { "Full soon": 0, Filling: 1, Stable: 2, "Freeing up": 3, "Not enough data": 4 };
    rows.sort((a, b) => order[String(a.state)] - order[String(b.state)] || Number(a.daysUntilFull ?? 99999) - Number(b.daysUntilFull ?? 99999));

    return {
        rows,
        truncated: false,
        period: { from, to },
        params: { warnDays },
        notes: ["Free space is compared between the first and last day with data in the period, across all of a device's disks together. A steady fall is projected forward; a device that fills and empties in cycles can look steadier than it is."],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "daysCovered", label: "Days of data", type: "number", visible: false },
            { key: "totalGb", label: "Total (GB)", type: "number", pdf: true, weight: 0.7 },
            { key: "freeGb", label: "Free now (GB)", type: "number", pdf: true, weight: 0.8 },
            { key: "freePercent", label: "Free now (%)", type: "percent", pdf: true, weight: 0.7 },
            { key: "changeGb", label: "Change (GB)", type: "number", pdf: true, weight: 0.7 },
            { key: "gbPerDay", label: "Filling (GB a day)", type: "number", visible: false },
            { key: "daysUntilFull", label: "Days until full", type: "number", pdf: true, weight: 0.8 },
            { key: "state", label: "Trend", type: "status", pdf: true, weight: 0.9 },
        ],
        summarize: (r) => [
            { label: "Devices", value: r.length },
            { label: "Full soon", value: count(r, "state", "Full soon") },
            { label: "Filling", value: count(r, "state", "Filling") },
            { label: "Stable or freeing up", value: count(r, "state", "Stable") + count(r, "state", "Freeing up") },
            { label: "Not enough data", value: count(r, "state", "Not enough data") },
        ],
        charts: [
            { key: "state", title: "Trend", kind: "donut", field: "state" },
            { key: "left", title: "Days until full", kind: "bar", field: "daysUntilFull", buckets: [{ label: "30 days or less", max: 31 }, { label: "30 to 90 days", min: 31, max: 91 }, { label: "90 to 365 days", min: 91, max: 366 }, { label: "Over a year", min: 366 }] },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ change log ------------------------------ */

const KIND_LABEL: Record<string, string> = { software_added: "Software installed", software_removed: "Software removed", software_updated: "Software updated", hardware: "Hardware", os: "Windows" };

async function changeLog(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const { start, end, from, to } = svc.period(input);
    const devices = await scopedDevices(svc, input);
    const changes = await svc.prisma.device_changes.findMany({
        where: { device_id: { in: devices.ids }, changed_at: { gte: start, lt: end } },
        orderBy: { changed_at: "desc" },
        take: 20_000,
        select: { device_id: true, changed_at: true, kind: true, summary: true },
    });
    const q = String(input.q ?? "").trim().toLowerCase();
    let rows: Row[] = changes.map((c) => {
        const d = devices.byId.get(c.device_id)!;
        return { deviceId: c.device_id, changedAt: c.changed_at, customer: d.customer, site: d.site, device: d.name, kind: KIND_LABEL[c.kind] ?? c.kind, change: c.summary };
    });
    if (q) rows = rows.filter((r) => String(r.device).toLowerCase().includes(q) || String(r.change).toLowerCase().includes(q));

    return {
        rows,
        truncated: changes.length === 20_000,
        period: { from, to },
        params: q ? { q } : {},
        notes: ["Changes are noticed when a device reports in, so the time shown is when the change was seen, which can be some hours after it happened. A device's first software list is the starting point and is not listed as changes."],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "changedAt", label: "Seen", type: "date", pdf: true, weight: 1.1 },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site", visible: false },
            { key: "device", label: "Device", pdf: true },
            { key: "kind", label: "Kind", type: "status", pdf: true, weight: 1 },
            { key: "change", label: "Change", pdf: true, weight: 3 },
        ],
        summarize: (r) => [
            { label: "Changes", value: r.length },
            { label: "Devices changed", value: new Set(r.map((x) => x.deviceId)).size },
            { label: "Software installed", value: count(r, "kind", "Software installed") },
            { label: "Software removed", value: count(r, "kind", "Software removed") },
            { label: "Hardware or Windows", value: count(r, "kind", "Hardware") + count(r, "kind", "Windows") },
        ],
        charts: [
            { key: "kind", title: "Kind of change", kind: "donut", field: "kind" },
            { key: "device", title: "Devices with most changes", kind: "bar", field: "device", top: 8 },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ patch speed ------------------------------ */

type ScanRow = { agent_id: string; finished_at: Date; output: unknown; artifacts: unknown };

async function patchSpeed(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const slowDays = svc.limit(input.slowDays, 14, 1, 365);
    const { start, end, from, to } = svc.period(input);
    const devices = await scopedDevices(svc, input);
    const agentIds = [...devices.byId.values()].map((d) => d.agentId).filter((v): v is string => !!v);
    const deviceOfAgent = new Map([...devices.byId.entries()].filter(([, d]) => d.agentId).map(([id, d]) => [d.agentId!, { id, ...d }]));
    // Scans from well before the period, so a patch first seen just before it still has its start.
    const since = new Date(start.getTime() - 90 * DAY);
    const scans = agentIds.length
        ? await svc.prisma.$queryRaw<ScanRow[]>`
            SELECT t.agent_id::text AS agent_id, r.finished_at, r.output, res.artifacts
              FROM public.agent_task_runs r
              JOIN public.agent_tasks t ON t.id = r.task_id
              LEFT JOIN public.agent_task_results res ON res.run_id = r.id
             WHERE r.status = 'succeeded' AND t.type = 'patch_scan' AND r.finished_at IS NOT NULL AND r.finished_at >= ${since}
               AND t.agent_id = ANY(${agentIds}::uuid[])
             ORDER BY t.agent_id, r.finished_at ASC`
        : [];
    const byAgent = new Map<string, ScanRow[]>();
    for (const s of scans) byAgent.set(s.agent_id, [...(byAgent.get(s.agent_id) ?? []), s]);

    type Seen = { title: string; severity: string | null; firstSeen: Date; fromFirstScan: boolean; installedAt: Date | null };
    const now = Date.now();
    const rows: Row[] = [];
    for (const [agentId, list] of byAgent) {
        const meta = deviceOfAgent.get(agentId);
        if (!meta) continue;
        const seen = new Map<string, Seen>();
        list.forEach((scan, index) => {
            const present = new Map(readPatches(scan.output, scan.artifacts).map((p) => [p.id, p]));
            for (const [id, p] of present) if (!seen.has(id)) seen.set(id, { title: p.title, severity: p.severity, firstSeen: scan.finished_at, fromFirstScan: index === 0, installedAt: null });
            for (const [id, s] of seen) if (!s.installedAt && !present.has(id)) s.installedAt = scan.finished_at;
        });
        for (const [id, s] of seen) {
            const gone = s.installedAt;
            const inPeriod = gone ? gone >= start && gone < end : s.firstSeen < end;
            if (!inPeriod) continue;
            const days = round1(((gone?.getTime() ?? now) - s.firstSeen.getTime()) / DAY);
            const slow = days > slowDays;
            rows.push({
                deviceId: meta.id,
                customer: meta.customer,
                site: meta.site,
                device: meta.name,
                patch: s.title || id,
                severity: severityRank(s.severity),
                firstSeen: s.firstSeen,
                installedAt: gone,
                days,
                state: gone ? (slow ? "Installed late" : "Installed") : slow ? "Missing too long" : "Still missing",
                startKnown: s.fromFirstScan ? "From first scan" : "Seen appear",
            });
        }
    }
    rows.sort((a, b) => Number(b.days) - Number(a.days));

    return {
        rows,
        truncated: false,
        period: { from, to },
        params: { slowDays },
        notes: ["Days are counted from the first scan that found the patch missing to the first scan that no longer did, or to now if it is still missing. A patch already missing in a device's very first scan really started earlier, so its days are a minimum."],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site", visible: false },
            { key: "device", label: "Device", pdf: true },
            { key: "patch", label: "Patch", pdf: true, weight: 2.4 },
            { key: "severity", label: "Severity", type: "status", pdf: true, weight: 0.7 },
            { key: "firstSeen", label: "First missing", type: "date", pdf: true, weight: 1 },
            { key: "installedAt", label: "Installed", type: "date", pdf: true, weight: 1 },
            { key: "days", label: "Days", type: "number", pdf: true, weight: 0.5 },
            { key: "state", label: "State", type: "status", pdf: true, weight: 0.9 },
            { key: "startKnown", label: "Start", visible: false },
        ],
        summarize: (r) => {
            const done = r.filter((x) => x.installedAt);
            const avg = done.length ? round1(done.reduce((s, x) => s + Number(x.days), 0) / done.length) : null;
            const critical = done.filter((x) => x.severity === "Critical");
            return [
                { label: "Patches", value: r.length },
                { label: "Average days to install", value: avg ?? "n/a" },
                { label: "Critical, average days", value: critical.length ? round1(critical.reduce((s, x) => s + Number(x.days), 0) / critical.length) : "n/a" },
                { label: "Installed within the limit", value: done.length ? `${Math.round((done.filter((x) => x.state === "Installed").length / done.length) * 100)}%` : "n/a" },
                { label: "Still missing", value: r.filter((x) => !x.installedAt).length },
            ];
        },
        charts: [
            { key: "state", title: "State", kind: "donut", field: "state" },
            { key: "sev", title: "Severity", kind: "bar", field: "severity" },
            { key: "days", title: "Days to install", kind: "bar", field: "days", buckets: [{ label: "Under 3 days", max: 3 }, { label: "3 to 7 days", min: 3, max: 7 }, { label: "7 to 14 days", min: 7, max: 14 }, { label: "14 to 30 days", min: 14, max: 30 }, { label: "30 days or more", min: 30 }] },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ risky configuration ------------------------------ */

async function riskyConfiguration(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const maxAdmins = svc.limit(input.maxLocalAdmins, 3, 1, 50);
    const { devices, truncated } = await svc.loadDevices(input);
    const yesNo = (v: boolean | null) => (v === null ? "Not reported" : v ? "Yes" : "No");

    const rows: Row[] = devices.map((d) => {
        const risk = d.risk;
        const high: string[] = [];
        const medium: string[] = [];
        const low: string[] = [];
        if (risk) {
            if (risk.rdpEnabled && risk.rdpNla === false) high.push("Remote Desktop is on without network-level authentication");
            else if (risk.rdpEnabled) medium.push("Remote Desktop is switched on");
            if (risk.smb1Enabled) high.push("SMBv1 is enabled");
            if (risk.autoLogon) high.push("Automatic logon is configured");
            if (risk.uacEnabled === false) high.push("User Account Control is off");
            if (risk.guestEnabled) medium.push("The guest account is enabled");
            if (risk.localAdmins && risk.localAdmins.length > maxAdmins) medium.push(`${risk.localAdmins.length} local administrators`);
            if (risk.minPasswordLength !== null && risk.minPasswordLength < 8) medium.push(risk.minPasswordLength === 0 ? "Passwords can be blank" : `Passwords can be as short as ${risk.minPasswordLength} characters`);
            if (risk.lockoutThreshold === 0) low.push("No account lockout after failed sign-ins");
            if (risk.screenLockMinutes !== null && (risk.screenLockMinutes === 0 || risk.screenLockMinutes > 15)) low.push(risk.screenLockMinutes === 0 ? "The screen never locks" : `The screen locks only after ${risk.screenLockMinutes} minutes`);
        }
        const result = !risk ? "Not reported" : high.length ? "High risk" : medium.length ? "Medium risk" : low.length ? "Low risk" : "No findings";
        return {
            deviceId: d.id,
            customer: d.customer,
            site: d.site,
            name: d.name,
            status: d.online ? "Online" : "Offline",
            result,
            high: high.length,
            medium: medium.length,
            low: low.length,
            rdp: risk ? (risk.rdpEnabled === null ? "Not reported" : risk.rdpEnabled ? (risk.rdpNla === false ? "On, no NLA" : "On") : "Off") : "Not reported",
            smb1: risk ? yesNo(risk.smb1Enabled) : "Not reported",
            autoLogon: risk ? yesNo(risk.autoLogon) : "Not reported",
            uac: risk ? (risk.uacEnabled === null ? "Not reported" : risk.uacEnabled ? "On" : "Off") : "Not reported",
            guest: risk ? yesNo(risk.guestEnabled) : "Not reported",
            localAdmins: risk?.localAdmins ? risk.localAdmins.join(", ") : null,
            adminCount: risk?.localAdmins ? risk.localAdmins.length : null,
            minPassword: risk?.minPasswordLength ?? null,
            screenLock: risk?.screenLockMinutes ?? null,
            findings: [...high, ...medium, ...low].join("; "),
        };
    });
    const order: Record<string, number> = { "High risk": 0, "Medium risk": 1, "Low risk": 2, "No findings": 3, "Not reported": 4 };
    rows.sort((a, b) => order[String(a.result)] - order[String(b.result)] || Number(b.high) - Number(a.high) || String(a.customer).localeCompare(String(b.customer)));

    return {
        rows,
        truncated,
        params: { maxLocalAdmins: maxAdmins },
        notes: ["This report needs agent 1.3.27 or later. A device that has not reported yet shows \"Not reported\", which is different from having no findings."],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "status", label: "Status", type: "status", visible: false },
            { key: "result", label: "Risk", type: "status", pdf: true, weight: 0.9 },
            { key: "high", label: "High", type: "number", visible: false },
            { key: "medium", label: "Medium", type: "number", visible: false },
            { key: "low", label: "Low", type: "number", visible: false },
            { key: "rdp", label: "Remote Desktop", visible: false },
            { key: "smb1", label: "SMBv1", visible: false },
            { key: "autoLogon", label: "Auto logon", visible: false },
            { key: "uac", label: "UAC", visible: false },
            { key: "guest", label: "Guest account", visible: false },
            { key: "adminCount", label: "Local admins", type: "number", visible: false },
            { key: "localAdmins", label: "Local administrators", visible: false },
            { key: "minPassword", label: "Min password length", type: "number", visible: false },
            { key: "screenLock", label: "Screen lock (minutes)", type: "number", visible: false },
            { key: "findings", label: "Findings", pdf: true, weight: 3 },
        ],
        summarize: (r) => [
            { label: "Devices", value: r.length },
            { label: "High risk", value: count(r, "result", "High risk") },
            { label: "Medium risk", value: count(r, "result", "Medium risk") },
            { label: "No findings", value: count(r, "result", "No findings") },
            { label: "Not reported", value: count(r, "result", "Not reported") },
        ],
        charts: [
            { key: "result", title: "Risk", kind: "donut", field: "result" },
            { key: "rdp", title: "Remote Desktop", kind: "donut", field: "rdp" },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ antivirus threats ------------------------------ */

const SEVERITY_LABEL: Record<string, string> = { low: "Low", moderate: "Moderate", high: "High", severe: "Severe" };
const STATUS_LABEL: Record<string, string> = { active: "Active", cleaned: "Cleaned", quarantined: "Quarantined", removed: "Removed", failed: "Failed to clean", allowed: "Allowed", blocked: "Blocked", unknown: "Unknown" };

async function antivirusThreats(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const { start, end, from, to } = svc.period(input);
    const { devices, truncated } = await svc.loadDevices(input);
    const rows: Row[] = [];
    let notReporting = 0;
    for (const d of devices) {
        if (!d.threats) {
            notReporting++;
            continue;
        }
        for (const t of d.threats.items) {
            if (t.detectedAt < start || t.detectedAt >= end) continue;
            rows.push({
                deviceId: d.id,
                customer: d.customer,
                site: d.site,
                device: d.name,
                detectedAt: t.detectedAt,
                threat: t.name,
                severity: t.severity ? SEVERITY_LABEL[t.severity] : "Unknown",
                status: STATUS_LABEL[t.status] ?? "Unknown",
                action: t.action,
                resource: t.resource,
                user: t.user,
            });
        }
    }
    rows.sort((a, b) => (a.status === "Active" ? 0 : a.status === "Failed to clean" ? 1 : 2) - (b.status === "Active" ? 0 : b.status === "Failed to clean" ? 1 : 2) || new Date(String(b.detectedAt)).getTime() - new Date(String(a.detectedAt)).getTime());
    const reporting = devices.length - notReporting;

    return {
        rows,
        truncated,
        period: { from, to },
        notes: [
            "This report needs agent 1.3.28 or later and Windows Defender. Each device keeps its most recent 50 detections from the last 30 days.",
            `${reporting} of ${devices.length} devices have reported threat data${notReporting ? `; ${notReporting} have not (an older agent, or no Defender), so "no threats" for them means unknown, not clean.` : "."}`,
        ],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "detectedAt", label: "Detected", type: "date", pdf: true, weight: 1.1 },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site", visible: false },
            { key: "device", label: "Device", pdf: true },
            { key: "threat", label: "Threat", pdf: true, weight: 1.8 },
            { key: "severity", label: "Severity", type: "status", pdf: true, weight: 0.8 },
            { key: "status", label: "Status", type: "status", pdf: true, weight: 0.9 },
            { key: "action", label: "Action taken", visible: false },
            { key: "resource", label: "Where", pdf: true, weight: 2 },
            { key: "user", label: "User", visible: false },
        ],
        summarize: (r) => [
            { label: "Detections", value: r.length },
            { label: "Devices affected", value: new Set(r.map((x) => x.deviceId)).size },
            { label: "Still active", value: count(r, "status", "Active") },
            { label: "Failed to clean", value: count(r, "status", "Failed to clean") },
            { label: "Severe or high", value: count(r, "severity", "Severe") + count(r, "severity", "High") },
            { label: "Not reporting", value: notReporting },
        ],
        charts: [
            { key: "status", title: "Status", kind: "donut", field: "status" },
            { key: "severity", title: "Severity", kind: "bar", field: "severity" },
            { key: "threat", title: "Most common threats", kind: "bar", field: "threat", top: 8 },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}
