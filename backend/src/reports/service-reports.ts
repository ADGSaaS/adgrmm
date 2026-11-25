// backend/src/reports/service-reports.ts
//
// Reports about the work being done: what technicians did, how scripts and alerts and tickets are going, what is
// coming up for renewal, and whether software matches what a customer should and should not have. Same engine as the
// others; only types are imported from it, so there is no import cycle.
import type { Built, EndpointReportsService, ReportDefinition, ReportInput } from "./endpoint-reports.service";
import type { Row } from "./report-view";
import { viewOf, type SlaRow, type SlaView } from "../service-desk/sla-view";

export type ServiceKey = "software-compliance" | "technician-activity" | "script-results" | "alert-noise" | "ticket-sla" | "renewals";

export const SERVICE_CATALOG: ReportDefinition[] = [
    {
        key: "software-compliance",
        title: "Software compliance",
        group: "Inventory",
        description: "Which devices are missing software that should be there, and which have software that should not be. You choose the lists; each entry matches any program whose name contains it.",
        scoped: true,
        dated: false,
        params: [
            { key: "required", label: "Must be installed (comma separated)", type: "text", default: "the saved policies", help: "Leave empty to use the software policies saved for each customer. Part of a program's name is enough. Type none for no list." },
            { key: "banned", label: "Must not be installed (comma separated)", type: "text", default: "the saved policies", help: "Leave empty to use the software policies saved for each customer. Part of a program's name is enough. Type none for no list." },
        ],
        permission: "devices.read",
    },
    {
        key: "renewals",
        title: "Renewals and expiries",
        group: "Lifecycle",
        description: "Warranties, other asset expiry dates and service contracts that have run out or are coming up, soonest first.",
        scoped: true,
        dated: false,
        params: [{ key: "withinDays", label: "Coming up within (days)", type: "number", default: 90, min: 1, max: 730 }],
        permission: "devices.read",
    },
    {
        key: "script-results",
        title: "Script and automation results",
        group: "Service",
        description: "Every script that ran in the period: where, who started it, whether it worked, how long it took and what it said when it failed.",
        scoped: true,
        dated: true,
        params: [{ key: "q", label: "Script or device contains", type: "text" }],
        permission: "devices.read",
    },
    {
        key: "alert-noise",
        title: "Alert noise and time to resolve",
        group: "Activity",
        description: "Which alerts fire most, on how many devices, how many are still open and how long they take to resolve, so you can tune what is too noisy.",
        scoped: true,
        dated: true,
        params: [],
        permission: "alerts.read",
    },
    {
        key: "ticket-sla",
        title: "Tickets and SLA",
        group: "Service",
        description: "Tickets opened in the period with how long they took to close and whether they were closed by their due time.",
        scoped: true,
        dated: true,
        params: [],
        permission: "tickets.read",
    },
    {
        key: "technician-activity",
        title: "Technician activity",
        group: "Service",
        description: "For each technician: remote sessions, refused attempts, devices touched, scripts run, tickets closed and time logged in the period.",
        scoped: true,
        dated: true,
        params: [],
        permission: "audit.read",
    },
];

export const SERVICE_BUILDERS: Record<ServiceKey, (svc: EndpointReportsService, input: ReportInput) => Promise<Built>> = {
    "software-compliance": softwareCompliance,
    renewals,
    "script-results": scriptResults,
    "alert-noise": alertNoise,
    "ticket-sla": ticketSla,
    "technician-activity": technicianActivity,
};

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const count = (rows: Row[], key: string, value: unknown) => rows.filter((r) => r[key] === value).length;
const list = (text: unknown) => String(text ?? "").split(/[,;\n]/).map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== "none").slice(0, 40);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const average = (n: number[]) => (n.length ? round1(n.reduce((s, x) => s + x, 0) / n.length) : null);
const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

/** Device ids in scope, with the names the rows show. */
async function scopedDevices(svc: EndpointReportsService, input: ReportInput) {
    const found = await svc.prisma.devices.findMany({
        where: await svc.deviceWhere(input),
        take: 20_000,
        select: { id: true, hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true } } } } },
    });
    const byId = new Map(found.map((d) => [d.id, { name: d.alias || d.hostname, site: d.sites?.name ?? "", customer: d.sites?.clients.name ?? "" }]));
    return { ids: found.map((d) => d.id), byId };
}

const isScoped = (input: ReportInput) => !!(input.clientId || input.siteId || input.deviceId || input.restrictClientIds);

/* ------------------------------ software compliance ------------------------------ */

async function softwareCompliance(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    // A list typed into the report stands in for the saved policies on that side; left empty, each customer's policies apply.
    const typedRequired = input.required !== undefined ? list(input.required) : null;
    const typedBanned = input.banned !== undefined ? list(input.banned) : null;
    const { devices, truncated } = await svc.loadDevices(input);
    const organizationId = (await svc.deviceWhere({})).sites.clients.organization_id;
    const clientIds = [...new Set(devices.map((d) => d.clientId).filter(Boolean))];
    // What each device must and must not have comes from the policies that reach it, on top of the saved software lists.
    void clientIds;
    const effective = typedRequired !== null && typedBanned !== null ? new Map() : await svc.policies.effectiveForDevices(devices.map((d) => d.id), organizationId);
    const policyFor = (deviceId: string, kind: "required" | "banned") =>
        (effective.get(deviceId)?.lists[kind === "required" ? "software.required" : "software.banned"] ?? []).map((h: { value: string }) => h.value);
    const required = typedRequired ?? [...new Set(devices.flatMap((d) => policyFor(d.id, "required")))];
    const banned = typedBanned ?? [...new Set(devices.flatMap((d) => policyFor(d.id, "banned")))];
    const software = await svc.prisma.agent_software.findMany({
        where: { agent_id: { in: devices.map((d) => d.agentId).filter(Boolean) } },
        select: { agent_id: true, name: true, version: true },
    });
    const byAgent = new Map<string, Array<{ name: string; version: string | null }>>();
    for (const s of software) {
        if (!byAgent.has(s.agent_id)) byAgent.set(s.agent_id, []);
        byAgent.get(s.agent_id)!.push({ name: s.name, version: s.version });
    }
    const has = (items: Array<{ name: string; version: string | null }>, term: string) => items.filter((i) => i.name.toLowerCase().includes(term.toLowerCase()));

    const rows: Row[] = devices.map((d) => {
        const items = byAgent.get(d.agentId) ?? [];
        const mustHave = typedRequired ?? policyFor(d.id, "required");
        const mustNotHave = typedBanned ?? policyFor(d.id, "banned");
        const missing = mustHave.filter((r) => !has(items, r).length);
        const found = mustNotHave.flatMap((b) => has(items, b).map((i) => (i.version ? `${i.name} ${i.version}` : i.name)));
        // The policy items themselves (not the program names they matched), for "Fix now".
        const bannedItems = mustNotHave.filter((b) => has(items, b).length);
        const reported = items.length > 0;
        return {
            deviceId: d.id,
            customer: d.customer,
            site: d.site,
            name: d.name,
            status: d.online ? "Online" : "Offline",
            programs: items.length,
            missingRequired: missing.join(", "),
            bannedFound: [...new Set(found)].join(", "),
            missingJson: JSON.stringify(missing),
            bannedJson: JSON.stringify(bannedItems),
            missingCount: missing.length,
            bannedCount: new Set(found).size,
            result: !reported ? "Not reported" : missing.length || found.length ? "Non-compliant" : "Compliant",
            issues: [...missing.map((m) => `Missing: ${m}`), ...[...new Set(found)].map((f) => `Banned: ${f}`)].join("; "),
        };
    });
    rows.sort((a, b) => (a.result === "Non-compliant" ? 0 : 1) - (b.result === "Non-compliant" ? 0 : 1) || String(a.customer).localeCompare(String(b.customer)) || String(a.name).localeCompare(String(b.name)));

    return {
        rows,
        truncated,
        params: { required: typedRequired ? typedRequired.join(", ") || "none" : "saved policies", banned: typedBanned ? typedBanned.join(", ") || "none" : "saved policies" },
        notes: [!required.length && !banned.length ? "There are no lists to check against, so every device counts as compliant. Add software to a policy, or type the software that must or must not be installed." : "A device that has not sent its software list yet shows as \"Not reported\"."],
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "missingJson", label: "Missing required (list)", internal: true },
            { key: "bannedJson", label: "Banned found (list)", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site" },
            { key: "name", label: "Device", pdf: true },
            { key: "status", label: "Status", type: "status", visible: false },
            { key: "programs", label: "Programs", type: "number", visible: false },
            { key: "missingCount", label: "Missing count", type: "number", visible: false },
            { key: "bannedCount", label: "Banned count", type: "number", visible: false },
            { key: "result", label: "Result", type: "status", pdf: true, weight: 0.9 },
            { key: "missingRequired", label: "Missing required", pdf: true, weight: 1.6 },
            { key: "bannedFound", label: "Banned software found", pdf: true, weight: 1.8 },
        ],
        summarize: (r) => [
            { label: "Devices", value: r.length },
            { label: "Compliant", value: count(r, "result", "Compliant") },
            { label: "Non-compliant", value: count(r, "result", "Non-compliant") },
            { label: "Missing required software", value: r.filter((x) => Number(x.missingCount) > 0).length },
            { label: "Banned software present", value: r.filter((x) => Number(x.bannedCount) > 0).length },
        ],
        charts: [
            { key: "result", title: "Result", kind: "donut", field: "result" },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ renewals ------------------------------ */

async function renewals(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const withinDays = svc.limit(input.withinDays, 90, 1, 730);
    const organizationId = (await svc.deviceWhere({})).sites.clients.organization_id;
    const now = Date.now();
    const assetsBuiltin = await svc.assets.isBuiltin();
    const assets = !assetsBuiltin ? [] : await svc.prisma.assets.findMany({
        where: {
            organization_id: organizationId,
            expires_at: { not: null },
            ...(input.clientId ? { client_id: input.clientId } : input.restrictClientIds ? { client_id: { in: input.restrictClientIds } } : {}),
            ...(input.deviceId ? { device_id: input.deviceId } : {}),
            ...(input.siteId ? { devices: { site_id: input.siteId } } : {}),
        },
        take: 20_000,
        select: { name: true, kind: true, model: true, serial_number: true, expires_at: true, purchase_date: true, device_id: true, clients: { select: { name: true } }, devices: { select: { sites: { select: { name: true } } } } },
    });
    // Contracts belong to a customer, not a device or site, so they are left out when the report is narrowed below that.
    const contracts = input.deviceId || input.siteId ? [] : await svc.prisma.contracts.findMany({
        where: { organization_id: organizationId, status: "active", end_date: { not: null }, ...(input.clientId ? { client_id: input.clientId } : input.restrictClientIds ? { client_id: { in: input.restrictClientIds } } : {}) },
        take: 5000,
        select: { name: true, kind: true, end_date: true, clients: { select: { name: true } } },
    });

    const stateOf = (days: number) => (days < 0 ? "Expired" : days <= 30 ? "Due within 30 days" : "Due soon");
    const all: Row[] = [
        ...assets.map((a): Row => {
            const days = Math.ceil((a.expires_at!.getTime() - now) / DAY);
            return { type: a.device_id ? "Warranty" : "Asset expiry", customer: a.clients.name, site: a.devices?.sites?.name ?? "", item: a.name, detail: [a.model, a.serial_number].filter(Boolean).join(", "), expiresAt: dateOnly(a.expires_at), daysLeft: days, state: stateOf(days) };
        }),
        ...contracts.map((c): Row => {
            const days = Math.ceil((c.end_date!.getTime() - now) / DAY);
            return { type: "Contract", customer: c.clients.name, site: "", item: c.name, detail: c.kind, expiresAt: dateOnly(c.end_date), daysLeft: days, state: stateOf(days) };
        }),
    ];
    const rows = all.filter((r) => Number(r.daysLeft) <= withinDays).sort((a, b) => Number(a.daysLeft) - Number(b.daysLeft));

    return {
        rows,
        truncated: false,
        params: { withinDays },
        notes: [`Items that have already expired are always listed. ${all.length - rows.length} more expire later than ${withinDays} days from now.`, ...(assetsBuiltin ? [] : [`Assets are managed in ${(await svc.assets.settings()).externalName ?? "another system"}, so asset warranties and licences are not listed here.`])],
        columns: [
            { key: "type", label: "Type", pdf: true, weight: 0.8 },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site", visible: false },
            { key: "item", label: "Item", pdf: true, weight: 1.4 },
            { key: "detail", label: "Detail", pdf: true, weight: 1.4 },
            { key: "expiresAt", label: "Expires", type: "date", pdf: true, weight: 0.9 },
            { key: "daysLeft", label: "Days left", type: "number", pdf: true, weight: 0.6 },
            { key: "state", label: "State", type: "status", pdf: true, weight: 1 },
        ],
        summarize: (r) => [
            { label: "Items", value: r.length },
            { label: "Already expired", value: count(r, "state", "Expired") },
            { label: "Due within 30 days", value: count(r, "state", "Due within 30 days") },
            { label: "Warranties", value: count(r, "type", "Warranty") },
            { label: "Contracts", value: count(r, "type", "Contract") },
        ],
        charts: [
            { key: "state", title: "State", kind: "donut", field: "state" },
            { key: "type", title: "Type", kind: "bar", field: "type" },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ script results ------------------------------ */

const JOB_STATUS: Record<string, string> = { succeeded: "Succeeded", failed: "Failed", timeout: "Timed out", queued: "Queued", running: "Running", dispatched: "Running" };

async function scriptResults(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const { start, end, from, to } = svc.period(input);
    const devices = await scopedDevices(svc, input);
    const runs = await svc.prisma.script_runs.findMany({
        where: { created_at: { gte: start, lt: end }, device_id: { in: devices.ids } },
        orderBy: { created_at: "desc" },
        take: 20_000,
        select: { id: true, script_name: true, device_id: true, triggered_by: true, created_at: true, schedule_id: true, jobs: { select: { status: true, started_at: true, finished_at: true, job_results: { select: { exit_code: true, stderr: true, duration_ms: true } } } } },
    });
    const userIds = [...new Set(runs.map((r) => r.triggered_by).filter((v): v is string => !!v))];
    const users = userIds.length ? await svc.prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [];
    const emailOf = new Map(users.map((u) => [u.id, String(u.email)]));
    const q = String(input.q ?? "").trim().toLowerCase();

    let rows: Row[] = runs.map((r) => {
        const d = devices.byId.get(r.device_id)!;
        const res = r.jobs.job_results;
        const status = JOB_STATUS[r.jobs.status] ?? r.jobs.status;
        const seconds = res ? round1(Number(res.duration_ms) / 1000) : r.jobs.started_at && r.jobs.finished_at ? round1((r.jobs.finished_at.getTime() - r.jobs.started_at.getTime()) / 1000) : null;
        return {
            deviceId: r.device_id,
            customer: d.customer,
            site: d.site,
            device: d.name,
            script: r.script_name,
            startedAt: r.created_at,
            status,
            exitCode: res ? res.exit_code : null,
            seconds,
            startedBy: r.triggered_by ? emailOf.get(r.triggered_by) ?? "Unknown user" : r.schedule_id ? "Schedule" : "Automation",
            error: status === "Succeeded" ? "" : (res?.stderr ?? "").trim().split("\n")[0].slice(0, 160),
        };
    });
    if (q) rows = rows.filter((r) => String(r.script).toLowerCase().includes(q) || String(r.device).toLowerCase().includes(q));

    return {
        rows,
        truncated: runs.length === 20_000,
        period: { from, to },
        params: q ? { q } : {},
        columns: [
            { key: "deviceId", label: "Device id", internal: true },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site", visible: false },
            { key: "device", label: "Device", pdf: true },
            { key: "script", label: "Script", pdf: true, weight: 1.4 },
            { key: "startedAt", label: "Started", type: "date", pdf: true, weight: 1.1 },
            { key: "status", label: "Status", type: "status", pdf: true, weight: 0.8 },
            { key: "exitCode", label: "Exit code", type: "number", visible: false },
            { key: "seconds", label: "Seconds", type: "number", pdf: true, weight: 0.6 },
            { key: "startedBy", label: "Started by", pdf: true, weight: 1.1 },
            { key: "error", label: "What it said", pdf: true, weight: 1.8 },
        ],
        summarize: (r) => [
            { label: "Runs", value: r.length },
            { label: "Succeeded", value: count(r, "status", "Succeeded") },
            { label: "Failed", value: count(r, "status", "Failed") + count(r, "status", "Timed out") },
            { label: "Success rate", value: r.length ? `${Math.round((count(r, "status", "Succeeded") / r.length) * 100)}%` : "n/a" },
            { label: "Scripts", value: new Set(r.map((x) => x.script)).size },
        ],
        charts: [
            { key: "status", title: "Result", kind: "donut", field: "status" },
            { key: "script", title: "Most run scripts", kind: "bar", field: "script", top: 8 },
            { key: "by", title: "Started by", kind: "bar", field: "startedBy", top: 8 },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ alert noise ------------------------------ */

async function alertNoise(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const { start, end, from, to } = svc.period(input);
    const devices = await scopedDevices(svc, input);
    const alerts = await svc.prisma.alerts.findMany({
        where: { first_seen_at: { gte: start, lt: end }, device_id: { in: devices.ids } },
        take: 50_000,
        select: { title: true, kind: true, severity: true, device_id: true, resolved_at: true, first_seen_at: true, open_count: true, state: true },
    });
    const groups = new Map<string, typeof alerts>();
    for (const a of alerts) {
        const key = `${a.kind}/${a.title}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(a);
    }
    const total = alerts.length;
    const rows: Row[] = [...groups.values()].map((g) => {
        const perDevice = new Map<string, number>();
        for (const a of g) perDevice.set(a.device_id, (perDevice.get(a.device_id) ?? 0) + 1);
        const noisiest = [...perDevice.entries()].sort((a, b) => b[1] - a[1])[0];
        const minutes = g.filter((a) => a.resolved_at).map((a) => (a.resolved_at!.getTime() - a.first_seen_at.getTime()) / 60_000);
        const open = g.filter((a) => !a.resolved_at && a.state !== "RESOLVED").length;
        return {
            alert: g[0].title,
            kind: g[0].kind,
            severity: g.some((a) => a.severity === "CRIT") ? "CRIT" : g[0].severity,
            alerts: g.length,
            firings: g.reduce((s, a) => s + (a.open_count || 1), 0),
            devices: perDevice.size,
            open,
            resolved: g.length - open,
            share: total ? Math.round((g.length / total) * 100) : 0,
            avgHoursToResolve: minutes.length ? round1(minutes.reduce((s, x) => s + x, 0) / minutes.length / 60) : null,
            noisiestDevice: noisiest ? `${devices.byId.get(noisiest[0])?.name ?? ""} (${noisiest[1]})` : "",
            verdict: g.length >= 5 && g.length / Math.max(1, perDevice.size) >= 2 ? "Noisy" : open > 0 && open === g.length ? "Never resolved" : "Normal",
        };
    });
    rows.sort((a, b) => Number(b.alerts) - Number(a.alerts));

    return {
        rows,
        truncated: false,
        period: { from, to },
        notes: ["\"Noisy\" means an alert that fired five or more times, at least twice per device on average. \"Never resolved\" means every one of them is still open."],
        columns: [
            { key: "alert", label: "Alert", pdf: true, weight: 2 },
            { key: "kind", label: "Kind", visible: false },
            { key: "severity", label: "Severity", type: "status", pdf: true, weight: 0.7 },
            { key: "alerts", label: "Alerts", type: "number", pdf: true, weight: 0.6 },
            { key: "firings", label: "Times it fired", type: "number", visible: false },
            { key: "devices", label: "Devices", type: "number", pdf: true, weight: 0.6 },
            { key: "open", label: "Open now", type: "number", pdf: true, weight: 0.6 },
            { key: "resolved", label: "Resolved", type: "number", visible: false },
            { key: "share", label: "Share of all alerts (%)", type: "percent", visible: false },
            { key: "avgHoursToResolve", label: "Avg hours to resolve", type: "number", pdf: true, weight: 0.9 },
            { key: "noisiestDevice", label: "Noisiest device", pdf: true, weight: 1.4 },
            { key: "verdict", label: "Verdict", type: "status", pdf: true, weight: 0.9 },
        ],
        summarize: (r) => {
            const times = r.map((x) => x.avgHoursToResolve).filter((x): x is number => typeof x === "number");
            return [
                { label: "Kinds of alert", value: r.length },
                { label: "Alerts", value: total },
                { label: "Still open", value: r.reduce((s, x) => s + Number(x.open), 0) },
                { label: "Noisy alerts", value: count(r, "verdict", "Noisy") },
                { label: "Avg hours to resolve", value: average(times) ?? "n/a" },
            ];
        },
        charts: [
            { key: "top", title: "Alerts that fire most", kind: "bar", field: "alert", weight: "alerts", top: 8 },
            { key: "sev", title: "Severity", kind: "bar", field: "severity", weight: "alerts" },
            { key: "verdict", title: "Verdict", kind: "donut", field: "verdict" },
        ],
    };
}

/* ------------------------------ tickets and SLA ------------------------------ */

async function ticketSla(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const { start, end, from, to } = svc.period(input);
    const organizationId = (await svc.deviceWhere({})).sites.clients.organization_id;
    const devices = await scopedDevices(svc, input);
    const scoped = isScoped(input);
    const tickets = await svc.prisma.tickets.findMany({
        where: { organization_id: organizationId, created_at: { gte: start, lt: end }, ...(scoped ? { device_id: { in: devices.ids } } : {}) },
        orderBy: { created_at: "desc" },
        take: 20_000,
        select: { id: true, queue_id: true, ticket_number: true, subject: true, status: true, priority: true, created_at: true, closed_at: true, due_at: true, device_id: true, users: { select: { email: true } } },
    });
    const now = Date.now();
    // The real clocks: the policy each ticket got, when its first response and resolution were due, and whether they were met.
    const slaRows = tickets.length ? await svc.prisma.$queryRaw<SlaRow[]>`SELECT * FROM ticket_sla WHERE ticket_id = ANY(${tickets.map((t) => t.id)}::uuid[])` : [];
    const slaBy = new Map(slaRows.map((r) => [r.ticket_id, viewOf(r, now)]));
    const queueName = new Map((await svc.prisma.ticket_queues.findMany({ where: { organization_id: organizationId }, select: { id: true, name: true } })).map((q) => [q.id, q.name]));
    const clockWord = (c: SlaView["response"]) => (c.state === "none" ? "No target" : c.state === "met" ? "Met" : c.state === "missed" ? "Missed" : c.state === "paused" ? "Paused" : c.level === "breached" ? "Overdue" : c.level === "warning" ? "At risk" : "Waiting");
    const slaWord = (v: SlaView, finished: boolean) => {
        const both = [v.response, v.resolution].filter((c) => c.state !== "none");
        if (!both.length) return "No due time";
        if (finished) return both.some((c) => c.state === "missed" || c.level === "breached") ? "Breached" : "Met";
        if (both.some((c) => c.level === "breached")) return "Overdue";
        if (both.some((c) => c.level === "warning")) return "At risk";
        return v.paused ? "Paused" : "On track";
    };
    const rows: Row[] = tickets.map((t) => {
        const finished = t.status === "resolved" || t.status === "closed";
        const closedAt = t.closed_at ?? (finished ? t.created_at : null);
        const hours = closedAt ? round1((closedAt.getTime() - t.created_at.getTime()) / 3_600_000) : null;
        const d = t.device_id ? devices.byId.get(t.device_id) : undefined;
        // With a policy the clocks decide; a ticket with none keeps the due time set on the ticket itself.
        const v = slaBy.get(t.id);
        const sla = v ? slaWord(v, finished) : !t.due_at ? "No due time" : finished ? (closedAt!.getTime() <= t.due_at.getTime() ? "Met" : "Breached") : now > t.due_at.getTime() ? "Overdue" : "On track";
        return {
            ticket: Number(t.ticket_number),
            subject: t.subject,
            customer: d?.customer ?? "",
            site: d?.site ?? "",
            device: d?.name ?? "",
            priority: t.priority,
            status: t.status.replace("_", " "),
            assignee: t.users?.email ? String(t.users.email) : "",
            createdAt: t.created_at,
            closedAt,
            hoursToClose: hours,
            dueAt: t.due_at,
            policy: v?.policy ?? "",
            queue: t.queue_id ? queueName.get(t.queue_id) ?? "" : "",
            firstResponse: v ? clockWord(v.response) : "",
            responseDueAt: v?.response.dueAt ? new Date(v.response.dueAt) : null,
            resolutionDueAt: v?.resolution.dueAt ? new Date(v.resolution.dueAt) : null,
            sla,
        };
    });

    return {
        rows,
        truncated: tickets.length === 20_000,
        period: { from, to },
        notes: [scoped ? "Only tickets linked to a device in this customer, site or device are included." : "Tickets with no device are included only when the report is not narrowed to a customer, site or device.", "SLA comes from the policy each ticket got (its customer's, its queue's, or the default one): first response and resolution clocks that pause while the ticket waits on the customer. A ticket with no policy is judged by the due time set on it."],
        columns: [
            { key: "ticket", label: "Ticket", type: "number", pdf: true, weight: 0.6 },
            { key: "subject", label: "Subject", pdf: true, weight: 2 },
            { key: "customer", label: "Customer", pdf: true },
            { key: "site", label: "Site", visible: false },
            { key: "device", label: "Device", visible: false },
            { key: "priority", label: "Priority", type: "status", pdf: true, weight: 0.7 },
            { key: "status", label: "Status", type: "status", pdf: true, weight: 0.8 },
            { key: "assignee", label: "Assigned to", visible: false },
            { key: "createdAt", label: "Opened", type: "date", pdf: true, weight: 1 },
            { key: "closedAt", label: "Closed", type: "date", visible: false },
            { key: "hoursToClose", label: "Hours to close", type: "number", pdf: true, weight: 0.7 },
            { key: "dueAt", label: "Due", type: "date", visible: false },
            { key: "policy", label: "SLA policy", visible: false },
            { key: "queue", label: "Queue", visible: false },
            { key: "firstResponse", label: "First response", type: "status", visible: false },
            { key: "responseDueAt", label: "Response due", type: "date", visible: false },
            { key: "resolutionDueAt", label: "Resolution due", type: "date", visible: false },
            { key: "sla", label: "SLA", type: "status", pdf: true, weight: 0.8 },
        ],
        summarize: (r) => {
            const closed = r.map((x) => x.hoursToClose).filter((x): x is number => typeof x === "number");
            const judged = count(r, "sla", "Met") + count(r, "sla", "Breached");
            return [
                { label: "Tickets", value: r.length },
                { label: "Still open", value: r.filter((x) => x.closedAt === null).length },
                { label: "Avg hours to close", value: average(closed) ?? "n/a" },
                { label: "SLA met", value: judged ? `${Math.round((count(r, "sla", "Met") / judged) * 100)}%` : "n/a" },
                { label: "Breached or overdue", value: count(r, "sla", "Breached") + count(r, "sla", "Overdue") },
                { label: "First response met", value: count(r, "firstResponse", "Met") + count(r, "firstResponse", "Missed") + count(r, "firstResponse", "Overdue") ? `${Math.round((count(r, "firstResponse", "Met") / (count(r, "firstResponse", "Met") + count(r, "firstResponse", "Missed") + count(r, "firstResponse", "Overdue"))) * 100)}%` : "n/a" },
            ];
        },
        charts: [
            { key: "sla", title: "SLA", kind: "donut", field: "sla" },
            { key: "status", title: "Status", kind: "donut", field: "status" },
            { key: "priority", title: "Priority", kind: "bar", field: "priority" },
            { key: "customer", title: "By customer", kind: "bar", field: "customer" },
        ],
    };
}

/* ------------------------------ technician activity ------------------------------ */

async function technicianActivity(svc: EndpointReportsService, input: ReportInput): Promise<Built> {
    const { start, end, from, to } = svc.period(input);
    const organizationId = (await svc.deviceWhere({})).sites.clients.organization_id;
    const devices = await scopedDevices(svc, input);
    const deviceIds = new Set(devices.ids);

    const events = await svc.prisma.audit_events.findMany({
        where: { category: "remote", created_at: { gte: start, lt: end }, target_type: "device", target_id: { in: devices.ids } },
        take: 50_000,
        select: { actor_email: true, actor_user_id: true, target_id: true, outcome: true, created_at: true },
    });
    const runs = await svc.prisma.script_runs.findMany({
        where: { created_at: { gte: start, lt: end }, device_id: { in: devices.ids }, triggered_by: { not: null } },
        take: 50_000,
        select: { triggered_by: true, device_id: true },
    });
    const closed = await svc.prisma.tickets.findMany({
        where: { organization_id: organizationId, closed_at: { gte: start, lt: end }, assignee_user_id: { not: null }, ...(isScoped(input) ? { device_id: { in: devices.ids } } : {}) },
        take: 50_000,
        select: { assignee_user_id: true },
    });
    const time = await svc.prisma.time_entries.groupBy({
        by: ["user_id"],
        where: { organization_id: organizationId, work_date: { gte: start, lt: end }, ...(input.clientId ? { client_id: input.clientId } : input.restrictClientIds ? { client_id: { in: input.restrictClientIds } } : {}) },
        _sum: { minutes: true },
    });
    const users = await svc.prisma.users.findMany({ where: { organization_id: organizationId }, select: { id: true, email: true, first_name: true, last_name: true } });
    const nameOf = new Map(users.map((u) => [u.id, { email: String(u.email), name: [u.first_name, u.last_name].filter(Boolean).join(" ") }]));

    type Tech = { email: string; name: string; sessions: number; refused: number; devices: Set<string>; scripts: number; tickets: number; minutes: number; last: Date | null };
    const techs = new Map<string, Tech>();
    const get = (key: string, email: string, name: string) => {
        if (!techs.has(key)) techs.set(key, { email, name, sessions: 0, refused: 0, devices: new Set(), scripts: 0, tickets: 0, minutes: 0, last: null });
        return techs.get(key)!;
    };
    for (const e of events) {
        const email = e.actor_email ?? "Unknown";
        const t = get(email.toLowerCase(), email, users.find((u) => String(u.email).toLowerCase() === email.toLowerCase())?.first_name ?? "");
        if (e.outcome === "success") t.sessions++;
        else t.refused++;
        if (e.target_id && deviceIds.has(e.target_id)) t.devices.add(e.target_id);
        if (!t.last || e.created_at > t.last) t.last = e.created_at;
    }
    for (const r of runs) {
        const u = nameOf.get(r.triggered_by!);
        if (!u) continue;
        const t = get(u.email.toLowerCase(), u.email, u.name);
        t.scripts++;
        t.devices.add(r.device_id);
    }
    for (const c of closed) {
        const u = nameOf.get(c.assignee_user_id!);
        if (u) get(u.email.toLowerCase(), u.email, u.name).tickets++;
    }
    for (const t of time) {
        const u = nameOf.get(t.user_id);
        if (u && (t._sum.minutes ?? 0) > 0) get(u.email.toLowerCase(), u.email, u.name).minutes += t._sum.minutes ?? 0;
    }
    for (const t of techs.values()) if (!t.name) t.name = nameOf.size ? [...nameOf.values()].find((u) => u.email.toLowerCase() === t.email.toLowerCase())?.name ?? "" : "";

    const rows: Row[] = [...techs.values()].map((t) => ({
        technician: t.name || t.email,
        email: t.email,
        sessions: t.sessions,
        refused: t.refused,
        devices: t.devices.size,
        scripts: t.scripts,
        ticketsClosed: t.tickets,
        hoursLogged: round1(t.minutes / 60),
        lastActive: t.last,
        total: t.sessions + t.scripts + t.tickets,
    }));
    rows.sort((a, b) => Number(b.total) - Number(a.total));

    return {
        rows,
        truncated: false,
        period: { from, to },
        notes: ["Remote sessions come from the audit log, scripts from the script history, tickets are those closed in the period by their assignee, and time is what was logged on time entries (all customers when no customer is chosen)."],
        columns: [
            { key: "technician", label: "Technician", pdf: true, weight: 1.3 },
            { key: "email", label: "Email", visible: false },
            { key: "sessions", label: "Remote sessions", type: "number", pdf: true, weight: 0.8 },
            { key: "refused", label: "Refused", type: "number", pdf: true, weight: 0.6 },
            { key: "devices", label: "Devices touched", type: "number", pdf: true, weight: 0.8 },
            { key: "scripts", label: "Scripts run", type: "number", pdf: true, weight: 0.7 },
            { key: "ticketsClosed", label: "Tickets closed", type: "number", pdf: true, weight: 0.8 },
            { key: "hoursLogged", label: "Hours logged", type: "number", pdf: true, weight: 0.7 },
            { key: "lastActive", label: "Last remote activity", type: "date", pdf: true, weight: 1.1 },
            { key: "total", label: "Total actions", type: "number", visible: false },
        ],
        summarize: (r) => [
            { label: "Technicians", value: r.length },
            { label: "Remote sessions", value: r.reduce((s, x) => s + Number(x.sessions), 0) },
            { label: "Refused attempts", value: r.reduce((s, x) => s + Number(x.refused), 0) },
            { label: "Scripts run", value: r.reduce((s, x) => s + Number(x.scripts), 0) },
            { label: "Tickets closed", value: r.reduce((s, x) => s + Number(x.ticketsClosed), 0) },
        ],
        charts: [
            { key: "sessions", title: "Remote sessions", kind: "bar", field: "technician", weight: "sessions", top: 8 },
            { key: "scripts", title: "Scripts run", kind: "bar", field: "technician", weight: "scripts", top: 8 },
            { key: "tickets", title: "Tickets closed", kind: "bar", field: "technician", weight: "ticketsClosed", top: 8 },
        ],
    };
}

void ids;
