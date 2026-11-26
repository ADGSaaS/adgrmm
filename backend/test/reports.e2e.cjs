// Reports through the real service, against a real database.
const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}

process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
async function rejects(name, fn, pattern) {
    try {
        await fn();
        check(name, false, "it was accepted");
    } catch (err) {
        check(name, !pattern || pattern.test(err.message), err.message);
    }
}

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { ReportsService } = require(path.join(dist, "reports/reports.service.js"));
    const { EndpointReportsService } = require(path.join(dist, "reports/endpoint-reports.service.js"));
    const { ReportViewsService } = require(path.join(dist, "reports/report-views.service.js"));
    const { PatchesService } = require(path.join(dist, "patches/patches.service.js"));
    const { AlertsService } = require(path.join(dist, "alerts/alerts.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const reports = app.get(ReportsService, { strict: false });
    const endpoint = app.get(EndpointReportsService, { strict: false });
    const alerts = app.get(AlertsService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Zeta ${stamp}` } });
    const other = await prisma.clients.create({ data: { organization_id: org.id, name: `Eta ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "Main" } });
    const otherSite = await prisma.sites.create({ data: { client_id: other.id, name: "Main" } });

    const GB = 1024 ** 3;
    const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
    const device = await prisma.devices.create({ data: { site_id: site.id, hostname: `Z-${stamp}`, operating_system: "Windows 11", serial_number: "SN1" } });
    // facts exactly as the agent sends them: hardware under device.hardware, disks beside it
    const agent = await prisma.agents.create({
        data: {
            device_id: device.id, agent_uuid: crypto.randomUUID(), version: "1.3.5", last_check_in_at: new Date(),
            facts: { os: "windows", arch: "x64", device: { hardware: { model: "Dell 7420", cpu: "i7", ram: "32 GB", ramBytes: 32 * GB, gpu: ["Intel UHD"] }, disks: [{ mount: "C:", fs: "NTFS", totalBytes: 500 * GB, freeBytes: 50 * GB }, { mount: "D:", fs: "NTFS", totalBytes: 1000 * GB, freeBytes: 900 * GB }] } },
        },
    });
    // stale status on purpose: the report must go by the agent's last check-in, not this field
    const offline = await prisma.devices.create({ data: { site_id: site.id, hostname: `OFF-${stamp}`, status: "online", last_seen_at: new Date() } });
    await prisma.agents.create({ data: { device_id: offline.id, agent_uuid: crypto.randomUUID(), version: "1.3.4", last_check_in_at: daysAgo(10) } });
    await prisma.devices.create({ data: { site_id: site.id, hostname: `NOAGENT-${stamp}` } });
    const elsewhere = await prisma.devices.create({ data: { site_id: otherSite.id, hostname: `E-${stamp}` } });
    const elsewhereAgent = await prisma.agents.create({
        data: {
            device_id: elsewhere.id, agent_uuid: crypto.randomUUID(), version: "99.9.9", last_check_in_at: new Date(),
            facts: { os: "windows", device: { hardware: { model: "HP", cpu: "i5", ram: "16 GB", ramBytes: 16 * GB }, disks: [{ mount: "C:", totalBytes: 500 * GB, freeBytes: 400 * GB }] } },
        },
    });

    await prisma.agent_software.create({ data: { agent_id: agent.id, name: `=cmd|calc ${stamp}`, version: "1.0", publisher: "Acme" } });
    await prisma.agent_software.create({ data: { agent_id: agent.id, name: `Chrome ${stamp}`, version: "120" } });
    await prisma.agent_software.create({ data: { agent_id: elsewhereAgent.id, name: `Chrome ${stamp}`, version: "119" } });

    const raise = (title, severity, d = device.id) => alerts.raise({ deviceId: d, kind: "check", dedupeKey: `r-${crypto.randomUUID()}`, severity, title, detail: null });
    await raise("Disk full", "CRIT");
    await raise("Disk full", "WARN");
    await raise("CPU high", "WARN");
    await raise("Other customer", "CRIT", elsewhere.id);

    const today = new Date().toISOString().slice(0, 10);

    // ---- customer health
    const first = await prisma.alerts.findFirst({ where: { device_id: device.id, title: "CPU high" } });
    await alerts.resolve(first.id, null, "done");
    const report = await reports.customerHealth(client.id, "2020-01-01", today);
    check("health counts only devices with agents", report.devices.total === 2 && report.devices.online === 1, report.devices);
    check("health names what is offline", report.devices.offline.length === 1 && report.devices.offline[0].name === `OFF-${stamp}`, report.devices.offline);
    check("health counts this customer's alerts only", report.alerts.total === 3 && report.alerts.critical === 1 && report.alerts.resolved === 1 && report.alerts.stillOpen === 2, report.alerts);
    check("health ranks common problems", report.alerts.mostCommon[0].title === "Disk full" && report.alerts.mostCommon[0].count === 2, report.alerts.mostCommon);
    check("no check runs reads as unknown, not zero", report.checks.runs === 0 && report.checks.passedPercent === null, report.checks);
    await rejects("reports check their dates", () => reports.customerHealth(client.id, "2026-02-31", today), /does not exist/);
    await rejects("reports check the customer", () => reports.customerHealth(crypto.randomUUID(), "2020-01-01", today), /not found/);
    const empty = await reports.customerHealth(client.id, "2001-01-01", "2001-02-01");
    check("a period before anything happened is empty", empty.alerts.total === 0, empty.alerts);

    const pdf = await reports.healthPdfFile(client.id, "2020-01-01", today);
    check("health makes a real PDF", pdf.data.subarray(0, 5).toString() === "%PDF-" && pdf.data.length > 500);

    // ---- the catalogue
    const catalog = endpoint.catalog().items;
    check("the catalogue lists every report", catalog.length === 32 && catalog.every((r) => r.title && r.description && r.permission), catalog.map((r) => r.key));
    await rejects("an unknown report is refused", () => endpoint.run("nope", {}), /Unknown report/);

    // ---- hardware inventory
    let hw = await endpoint.run("hardware-inventory", { clientId: client.id });
    check("hardware lists devices with agents", hw.rows.length === 2 && !hw.rows.some((d) => d.name.startsWith("NOAGENT")), hw.rows.map((d) => d.name));
    const zrow = hw.rows.find((d) => d.name === `Z-${stamp}`);
    check("hardware uses what the agent reports", zrow.model === "Dell 7420" && zrow.cpu === "i7" && zrow.ramGb === 32 && zrow.gpu === "Intel UHD" && zrow.serial === "SN1" && zrow.agentVersion === "1.3.5" && zrow.os === "windows", zrow);
    check("hardware adds up the disks", zrow.diskTotalGb === 1500 && zrow.diskFreePercent === 63.3, [zrow.diskTotalGb, zrow.diskFreePercent]);
    check("online comes from the check-in, not the stale status field", zrow.status === "Online" && hw.rows.find((d) => d.name === `OFF-${stamp}`).status === "Offline", hw.rows.map((d) => [d.name, d.status]));
    check("hardware has an as-of time and scope", !!hw.generatedAt && hw.scope.customer === `Zeta ${stamp}` && hw.scope.site === null, hw.scope);
    check("hardware says who has not reported yet", hw.notes.some((n) => /1 device has not reported hardware/.test(n)), hw.notes);
    check("hardware summary counts online", hw.summary[0].value === 2 && hw.summary[1].value === 1, hw.summary);
    hw = await endpoint.run("hardware-inventory", {});
    check("with no filter it covers every customer", hw.rows.some((d) => d.name === `E-${stamp}`) && hw.rows.some((d) => d.name === `Z-${stamp}`) && hw.scope.customer === null);
    hw = await endpoint.run("hardware-inventory", { clientId: client.id, siteId: site.id });
    check("a site narrows it and is named", hw.rows.length === 2 && hw.scope.site === "Main", hw.scope);
    await rejects("a site must belong to the customer", () => endpoint.run("hardware-inventory", { clientId: other.id, siteId: site.id }), /does not exist/);
    await rejects("an unknown customer is refused", () => endpoint.run("hardware-inventory", { clientId: crypto.randomUUID() }), /does not exist/);

    // ---- device health
    let health = await endpoint.run("device-health", { clientId: client.id });
    const hz = health.rows.find((d) => d.name === `Z-${stamp}`);
    const ho = health.rows.find((d) => d.name === `OFF-${stamp}`);
    check("health flags the low disk and names the drive", hz.result === "Needs attention" && /Low disk space: C: 10% free/.test(hz.issues) && hz.diskFreePercent === 10, hz);
    check("health flags a long-offline device and an old agent", /Offline 10 days/.test(ho.issues) && /Old agent 1\.3\.4/.test(ho.issues) && /No hardware details/.test(ho.issues), ho.issues);
    check("health puts the worst first", health.rows[0].issues.split(";").length >= health.rows[health.rows.length - 1].issues.split(";").length && health.rows[0].result === "Needs attention");
    check("health summary adds up", health.summary.find((s) => s.label === "Devices").value === 2 && health.summary.find((s) => s.label === "Need attention").value === 2, health.summary);
    health = await endpoint.run("device-health", { clientId: other.id });
    check("a device within every limit is healthy", health.rows[0].result === "Healthy" && health.rows[0].issues === "", health.rows[0]);
    health = await endpoint.run("device-health", { clientId: client.id, offlineDays: 30, minDiskFreePercent: 5 });
    const loose = health.rows.find((d) => d.name === `Z-${stamp}`);
    check("looser limits clear the flags", !/disk/i.test(loose.issues) && !/Offline/.test(health.rows.find((d) => d.name === `OFF-${stamp}`).issues) && health.params.offlineDays === 30, health.params);
    health = await endpoint.run("device-health", { clientId: client.id, minRamGb: 64 });
    check("a memory limit flags small machines", /Low memory: 32 GB/.test(health.rows.find((d) => d.name === `Z-${stamp}`).issues));
    health = await endpoint.run("device-health", { clientId: client.id, offlineDays: -5, minDiskFreePercent: 9999 });
    check("silly limits are held to sensible ones", health.params.offlineDays === 1 && health.params.minDiskFreePercent === 90, health.params);

    // ---- software
    let software = await endpoint.run("software-inventory", { q: `chrome ${stamp}` });
    check("software search spans customers", software.rows.length === 2 && new Set(software.rows.map((s) => s.version)).size === 2, software.rows);
    software = await endpoint.run("software-inventory", { q: `chrome ${stamp}`, clientId: other.id });
    check("the customer filter holds", software.rows.length === 1 && software.rows[0].customer === `Eta ${stamp}`, software.rows);
    const summary = await endpoint.run("software-summary", { q: `chrome ${stamp}` });
    check("the summary counts devices per version", summary.rows.length === 2 && summary.rows.every((r) => r.devices === 1), summary.rows);
    const dirty = await endpoint.run("software-inventory", { q: "=cmd" });
    const csv = endpoint.toCsv(dirty);
    check("a formula in a software name is defused", csv.includes("'=cmd|calc"), csv.slice(0, 120));
    check("the CSV opens correctly in Excel", csv.charCodeAt(0) === 0xfeff && csv.startsWith("﻿Customer,Site,Device,Software"), csv.slice(0, 50));

    // ---- remote sessions
    const email = `tech${stamp}@example.test`;
    await prisma.audit_events.createMany({
        data: [
            { actor_email: email, action: "remote.console.start", category: "remote", target_type: "device", target_id: device.id, target_label: `Z-${stamp}`, ip: "198.51.100.7", outcome: "success" },
            { actor_email: email, action: "remote.console.start", category: "remote", target_type: "device", target_id: device.id, target_label: `Z-${stamp}`, ip: "198.51.100.7", outcome: "denied" },
            { actor_email: email, action: "device.delete", category: "device", target_type: "device", target_id: device.id, outcome: "success" },
        ],
    });
    const sessions = await endpoint.run("remote-sessions", { from: "2020-01-01", to: today, q: email });
    check("sessions come from the audit log", sessions.rows.length === 2 && sessions.rows[0].technician === email && sessions.rows[0].device === `Z-${stamp}`, sessions.rows);
    check("sessions include refused attempts", sessions.rows.some((s) => s.outcome === "denied"));
    check("sessions leave out other audit events", !sessions.rows.some((s) => s.action === "device.delete"));
    check("sessions know their period", sessions.period.from === "2020-01-01" && sessions.period.to === today, sessions.period);
    check("search also matches the device", (await endpoint.run("remote-sessions", { from: "2020-01-01", to: today, q: `z-${stamp}` })).rows.length === 2);
    check("dates limit the sessions", (await endpoint.run("remote-sessions", { from: "2001-01-01", to: "2001-02-01" })).rows.length === 0);
    check("times export as full timestamps", /\d{4}-\d{2}-\d{2}T/.test(endpoint.toCsv(sessions)));
    await rejects("a bad date is a client error", () => endpoint.run("remote-sessions", { from: "2026-02-31", to: today }), /does not exist/);
    await rejects("the end cannot be before the start", () => endpoint.run("remote-sessions", { from: "2026-03-01", to: "2026-02-01" }), /end date/);

    // ---- alert history
    const history = await endpoint.run("alert-history", { from: "2020-01-01", to: today, clientId: client.id });
    check("history is this customer's only", history.rows.length === 3 && history.rows.every((a) => a.customer === `Zeta ${stamp}`), history.rows.length);
    const resolvedRow = history.rows.find((a) => a.title === "CPU high");
    check("history works out time open", resolvedRow.minutesOpen === 0 && resolvedRow.state === "RESOLVED", resolvedRow);
    check("open alerts have no time open", history.rows.find((a) => a.title === "Disk full").minutesOpen === null);
    check("history summarises", history.summary.find((s) => s.label === "Alerts").value === 3 && history.summary.find((s) => s.label === "Critical").value === 1, history.summary);

    // ---- PDF
    for (const key of ["hardware-inventory", "software-inventory", "software-summary", "device-health", "alert-history", "remote-sessions"]) {
        const file = await endpoint.pdfFile(key, { from: "2020-01-01", to: today });
        check(`${key} makes a real PDF`, file.data.subarray(0, 5).toString() === "%PDF-" && file.data.length > 800 && file.filename.startsWith(key), file.filename);
    }
    const emptyPdf = await endpoint.pdfFile("alert-history", { from: "2001-01-01", to: "2001-02-01" });
    check("an empty report still makes a PDF", emptyPdf.data.subarray(0, 5).toString() === "%PDF-");

    // ---- views: filter, sort, group, columns and charts on a real report
    const offlineOnly = await endpoint.run("hardware-inventory", { clientId: client.id }, { filter: { match: "all", conditions: [{ field: "status", op: "eq", value: "Offline" }] } });
    check("a filter narrows the rows and says how many were left out", offlineOnly.rows.length === 1 && offlineOnly.totalRows === 2 && offlineOnly.matchedRows === 1, [offlineOnly.matchedRows, offlineOnly.totalRows]);
    check("the summary follows the filter", offlineOnly.summary[0].value === 1 && offlineOnly.summary[1].value === 0 && offlineOnly.summary[2].value === 1, offlineOnly.summary);
    check("the charts follow the filter", offlineOnly.charts.find((c) => c.key === "status").data.length === 1 && offlineOnly.charts.find((c) => c.key === "status").data[0].label === "Offline", offlineOnly.charts.find((c) => c.key === "status"));
    const bigRam = await endpoint.run("hardware-inventory", {}, { filter: { match: "all", conditions: [{ field: "ramGb", op: "gte", value: 32 }, { field: "diskFreePercent", op: "lt", value: 70 }] } });
    check("number conditions work on real columns", bigRam.rows.some((r) => r.name === `Z-${stamp}`) && !bigRam.rows.some((r) => r.name === `OFF-${stamp}` || r.name === `E-${stamp}`), bigRam.rows.map((r) => r.name));
    const notSeen = await endpoint.run("hardware-inventory", { clientId: client.id }, { filter: { match: "all", conditions: [{ field: "lastSeenAt", op: "olderThanDays", value: 7 }] } });
    check("a date condition finds the device not seen for a week", notSeen.rows.length === 1 && notSeen.rows[0].name === `OFF-${stamp}`, notSeen.rows.map((r) => r.name));
    const grouped = await endpoint.run("hardware-inventory", {}, { groupBy: "customer", sort: [{ key: "name", dir: "desc" }] });
    check("grouping returns the groups with counts", grouped.groups.length >= 2 && grouped.groups.every((g) => g.count > 0) && grouped.groups.find((g) => g.value === `Zeta ${stamp}`).count === 2, grouped.groups);
    check("rows come grouped, then sorted", (() => { const seen = []; for (const r of grouped.rows) if (seen[seen.length - 1] !== r.customer) seen.push(r.customer); return seen.length === grouped.groups.length; })());
    const charts = (await endpoint.run("hardware-inventory", {})).charts;
    check("every report comes with charts", charts.length >= 5 && charts.every((c) => c.key && c.title && Array.isArray(c.data)), charts.map((c) => c.key));
    check("the memory chart sorts machines into sizes", charts.find((c) => c.key === "ram").data.some((d) => d.label === "32 GB or more"), charts.find((c) => c.key === "ram").data);
    const healthCharts = (await endpoint.run("device-health", { clientId: client.id })).charts;
    check("health charts say what needs attention", healthCharts.find((c) => c.key === "issues").data.some((d) => d.label === "Low disk space"), healthCharts.find((c) => c.key === "issues").data);
    const alertCharts = (await endpoint.run("alert-history", { from: "2020-01-01", to: today, clientId: client.id })).charts;
    check("alert history has a daily chart", alertCharts.find((c) => c.key === "day").data.length >= 1 && alertCharts.find((c) => c.key === "day").data.reduce((s, d) => s + d.value, 0) === 3, alertCharts.find((c) => c.key === "day").data);
    const rowIds = (await endpoint.run("hardware-inventory", { clientId: client.id })).rows;
    check("rows carry the device id for links, and it is not a column anyone sees", rowIds.every((r) => /^[0-9a-f-]{36}$/.test(r.deviceId)) && endpoint.toCsv(await endpoint.run("hardware-inventory", { clientId: client.id })).split("\r\n")[0].indexOf("Device id") === -1);
    const picked = endpoint.toCsv(await endpoint.run("hardware-inventory", { clientId: client.id }, { columns: ["name", "ip", "serial"], sort: [{ key: "name", dir: "asc" }] }));
    check("an export has only the columns chosen, in order", picked.split("\r\n")[0] === "﻿Device,IP address,Serial" && picked.split("\r\n").length === 3, picked.split("\r\n")[0]);
    const filteredCsv = endpoint.toCsv(await endpoint.run("hardware-inventory", { clientId: client.id }, { filter: { match: "all", conditions: [{ field: "status", op: "eq", value: "Offline" }] } }));
    check("an export has only the rows that match", filteredCsv.split("\r\n").length === 2 && filteredCsv.includes(`OFF-${stamp}`) && !filteredCsv.includes(`Z-${stamp}`), filteredCsv.split("\r\n").length);
    const viaString = await endpoint.run("hardware-inventory", {}, JSON.stringify({ filter: { match: "any", conditions: [{ field: "os", op: "contains", value: "WIN" }] } }));
    check("a view can arrive as a string", viaString.matchedRows >= 1, viaString.matchedRows);
    await rejects("a view with a column that is not there is refused", () => endpoint.run("hardware-inventory", {}, { filter: { match: "all", conditions: [{ field: "nope", op: "eq", value: "x" }] } }), /does not exist/);
    await rejects("a view cannot reach the internal id", () => endpoint.run("hardware-inventory", {}, { groupBy: "deviceId" }), /does not exist/);
    const groupedPdf = await endpoint.pdfFile("hardware-inventory", {}, { groupBy: "customer", filter: { match: "all", conditions: [{ field: "ramGb", op: "gt", value: 1 }] }, columns: ["name", "status", "ramGb"] });
    check("a grouped, filtered PDF with chosen columns is a real PDF", groupedPdf.data.subarray(0, 5).toString() === "%PDF-" && groupedPdf.data.length > 800);
    const healthSorted = await endpoint.run("device-health", { clientId: client.id }, { sort: [{ key: "name", dir: "asc" }] });
    check("the person's sort replaces the worst-first order", healthSorted.rows[0].name === `OFF-${stamp}` && healthSorted.rows[1].name === `Z-${stamp}`, healthSorted.rows.map((r) => r.name));
    const healthFiltered = await endpoint.run("device-health", { clientId: client.id }, { filter: { match: "all", conditions: [{ field: "issues", op: "contains", value: "low disk" }] } });
    check("health can be filtered by what is wrong, and its summary follows", healthFiltered.rows.length === 1 && healthFiltered.summary.find((s) => s.label === "Devices").value === 1 && healthFiltered.summary.find((s) => s.label === "Need attention").value === 1, healthFiltered.summary);

    // ---- saved views
    const views = app.get(ReportViewsService, { strict: false });
    const userRowA = await prisma.users.create({ data: { organization_id: org.id, email: `viewa${stamp}@example.test`, password_hash: "x" } });
    const userRowB = await prisma.users.create({ data: { organization_id: org.id, email: `viewb${stamp}@example.test`, password_hash: "x" } });
    const config = { scope: { clientId: client.id }, params: { offlineDays: 3 }, days: 14, view: { filter: { match: "all", conditions: [{ field: "result", op: "eq", value: "Needs attention" }] }, sort: [{ key: "name", dir: "asc" }] } };
    const made = await views.create(userRowA.id, { reportKey: "device-health", name: `  Needs   attention ${stamp} `, config });
    check("a view is saved with a tidy name", made.name === `Needs attention ${stamp}` && made.mine === true && made.reportKey === "device-health", made);
    check("a view keeps its settings", made.config.scope.clientId === client.id && made.config.params.offlineDays === 3 && made.config.days === 14 && made.config.view.sort[0].key === "name", made.config);
    const listed = await views.list("device-health", userRowB.id);
    check("everyone in the organisation sees it, and who owns it", listed.items.some((v) => v.id === made.id && v.mine === false) && (await views.list("device-health", userRowA.id)).items.find((v) => v.id === made.id).mine === true);
    check("views are listed per report", !(await views.list("hardware-inventory", userRowA.id)).items.some((v) => v.id === made.id));
    await rejects("a name cannot be used twice for one report", () => views.create(userRowB.id, { reportKey: "device-health", name: `Needs attention ${stamp}`, config: {} }), /already exists/);
    const sameNameElsewhere = await views.create(userRowB.id, { reportKey: "hardware-inventory", name: `Needs attention ${stamp}`, config: {} });
    check("the same name is fine on another report", !!sameNameElsewhere.id);
    await rejects("a view needs a name", () => views.create(userRowA.id, { reportKey: "device-health", name: "   ", config: {} }), /name/);
    await rejects("a name cannot be very long", () => views.create(userRowA.id, { reportKey: "device-health", name: "x".repeat(81), config: {} }), /too long/);
    await rejects("a view must be for a real report", () => views.create(userRowA.id, { reportKey: "nope", name: "x", config: {} }), /Unknown report/);
    await rejects("a customer in a view must be a UUID", () => views.create(userRowA.id, { reportKey: "device-health", name: "bad1", config: { scope: { clientId: "abc" } } }), /not valid/);
    await rejects("a limit in a view must be simple", () => views.create(userRowA.id, { reportKey: "device-health", name: "bad2", config: { params: { offlineDays: { x: 1 } } } }), /not valid/);
    await rejects("a period in a view must be sensible", () => views.create(userRowA.id, { reportKey: "device-health", name: "bad3", config: { days: 0 } }), /period/);
    await rejects("a huge view is refused", () => views.create(userRowA.id, { reportKey: "device-health", name: "bad4", config: { view: { filter: "x".repeat(9000) } } }), /too large/);
    const sanitised = await views.create(userRowA.id, { reportKey: "device-health", name: `clean ${stamp}`, config: { scope: {}, params: {}, evil: "<script>", view: { groupBy: "customer" } } });
    check("anything a view may not hold is dropped", !("evil" in sanitised.config) && sanitised.config.view.groupBy === "customer" && !("scope" in sanitised.config), sanitised.config);
    await rejects("someone else cannot change a view", () => views.update(made.id, userRowB.id, { name: "mine now" }), /Only the person who saved/);
    await rejects("someone else cannot remove a view", () => views.remove(made.id, userRowB.id), /Only the person who saved/);
    await rejects("nobody signed in cannot change a view", () => views.update(made.id, null, { name: "x" }), /Only the person who saved/);
    const renamed = await views.update(made.id, userRowA.id, { name: `Renamed ${stamp}`, config: { days: 30 } });
    check("the owner can rename and change it", renamed.name === `Renamed ${stamp}` && renamed.config.days === 30 && !renamed.config.view, renamed);
    const second = await views.create(userRowB.id, { reportKey: "hardware-inventory", name: `Second ${stamp}`, config: {} });
    await rejects("renaming onto an existing name is refused", () => views.update(second.id, userRowB.id, { name: `Needs attention ${stamp}` }), /already exists/);
    await rejects("an unknown view is not found", () => views.update(crypto.randomUUID(), userRowA.id, { name: "x" }), /not found/);
    await views.remove(made.id, userRowA.id);
    check("the owner can remove it", !(await views.list(undefined, userRowA.id)).items.some((v) => v.id === made.id));
    const config2 = sanitised.config;
    const ran = await endpoint.run("device-health", { clientId: client.id }, config2.view);
    check("what a view holds can be run as it is", ran.view.groupBy === "customer" && ran.groups.length >= 1, ran.groups);

    // ---- security, patching and the richer health facts, on a customer of their own
    const patches = app.get(PatchesService, { strict: false });
    const theta = await prisma.clients.create({ data: { organization_id: org.id, name: `Theta ${stamp}` } });
    const thetaSite = await prisma.sites.create({ data: { client_id: theta.id, name: "Lab" } });
    const mk = async (host, version, facts, extra = {}, checkIn = new Date()) => {
        const dev = await prisma.devices.create({ data: { site_id: thetaSite.id, hostname: `${host}-${stamp}`, operating_system: facts.os === "linux" ? "Ubuntu 22.04" : "Windows 11", ...extra } });
        const ag = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version, last_check_in_at: checkIn, facts } });
        return { dev, ag };
    };
    const box = { hardware: { model: "Dell", ram: "16 GB", ramBytes: 16 * GB }, disks: [{ mount: "C:", totalBytes: 500 * GB, freeBytes: 300 * GB }] };
    const problem = await mk("PA", "1.3.26", {
        os: "windows", primary_ip: "10.9.0.5",
        device: {
            ...box,
            os: { name: "Windows 11 Pro", displayVersion: "23H2", build: "22631", buildRevision: "22631.3007" },
            boot: { lastBootAt: daysAgo(45).toISOString(), pendingReboot: true, pendingRebootReasons: ["Windows Update", "Pending file changes"] },
            bios: { vendor: "Dell", version: "1.2", releaseDate: "2021-03-10" },
            security: { antivirus: [{ name: "Windows Defender", state: "off", upToDate: true }], defender: { realTimeProtection: false, signatureAgeDays: 3, antivirusEnabled: true }, firewall: { domain: true, private: true, public: false }, bitLocker: [{ mount: "C:", protection: "off", status: "decrypted" }], tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true },
            network: [{ description: "Ethernet", mac: "AA:BB:CC:DD:EE:01", ipv4: ["10.9.0.5"], gateway: "10.9.0.1" }],
        },
    });
    const fine = await mk("PB", "99.9.9", {
        os: "windows",
        device: {
            ...box,
            os: { name: "Windows 10 Pro", displayVersion: "22H2" },
            boot: { lastBootAt: daysAgo(2).toISOString(), pendingReboot: false },
            security: { antivirus: [{ name: "Windows Defender", state: "on", upToDate: true }], defender: { realTimeProtection: true, signatureAgeDays: 0, antivirusEnabled: true }, firewall: { domain: true, private: true, public: true }, bitLocker: [{ mount: "C:", protection: "on", status: "encrypted" }], tpm: { present: true, version: "2.0" }, secureBoot: true },
        },
    });
    const failing = await mk("PC", "1.3.25", { os: "windows", device: box }, {}, new Date());
    const never = await mk("PD", "1.3.25", { os: "windows", device: box });
    const linux = await mk("PE", "1.3.25", { os: "linux", device: box });
    const old = await mk("PF", "1.3.20", { os: "windows", device: box }, {}, daysAgo(3));
    const quiet = await mk("PG", "1.3.24", { os: "windows", device: box });

    // what the agent really answers to a scan, in the two places the answer can be kept
    const scanTask = (agentId, createdAt = new Date()) => prisma.agent_tasks.create({ data: { agent_id: agentId, type: "patch_scan", payload: {}, status: "succeeded", created_at: createdAt } });
    const scanRun = async (agentId, finishedAt, status, output, artifacts) => {
        const task = await scanTask(agentId, finishedAt);
        const run = await prisma.agent_task_runs.create({ data: { task_id: task.id, status, started_at: finishedAt, finished_at: finishedAt, output, created_at: finishedAt } });
        if (artifacts !== undefined) await prisma.agent_task_results.create({ data: { run_id: run.id, artifacts, stderr: status === "failed" ? "0x80240017" : null } });
        return run;
    };
    const p1 = { id: "KB5001", title: "Security Update for Windows (KB5001)", severity: "Critical", requiresReboot: true, kbIds: ["5001"] };
    const p2 = { id: "KB5002", title: "Cumulative Update (KB5002)", severity: "Important", requiresReboot: false, kbIds: ["5002"] };
    const p3 = { id: "KB5003", title: "Driver update", severity: null, requiresReboot: false, kbIds: [] };
    await scanRun(problem.ag.id, daysAgo(2), "succeeded", { ok: true, patches: [p1, p2, p3] });
    await scanRun(problem.ag.id, daysAgo(40), "succeeded", { ok: true, patches: [{ ...p1, id: "KB1", title: "Ancient" }] });
    await scanRun(fine.ag.id, new Date(Date.now() - 6 * 3_600_000), "succeeded", { ok: true }, { patches: [] });
    await scanRun(failing.ag.id, daysAgo(1), "failed", { ok: false }, {});
    await scanRun(old.ag.id, daysAgo(20), "succeeded", { ok: true, patches: [] });
    const installTask = (agentId, createdAt, createdBy) => prisma.agent_tasks.create({ data: { agent_id: agentId, type: "patch_install", payload: {}, status: "succeeded", created_at: createdAt, created_by: createdBy } });
    const installRun = async (agentId, at, status, output, artifacts, createdBy = null) => {
        const task = await installTask(agentId, at, createdBy);
        const run = await prisma.agent_task_runs.create({ data: { task_id: task.id, status, started_at: at, finished_at: at, output, created_at: at } });
        await prisma.agent_task_results.create({ data: { run_id: run.id, artifacts, stderr: status === "failed" ? "Access denied (0x80070005)" : null } });
        return run;
    };
    // before the scan: must not take anything off the scan's list. After the scan: takes KB5002 off.
    await installRun(problem.ag.id, daysAgo(3), "succeeded", { ok: true }, { installed: ["KB5001"], requiresReboot: true }, userRowA.id);
    await installRun(problem.ag.id, daysAgo(1), "succeeded", { ok: true }, { installed: ["KB5002", "KB9"], requiresReboot: false }, userRowA.id);
    await installRun(fine.ag.id, daysAgo(5), "failed", { ok: false }, {}, null);

    // ---- richer facts show up in the inventory
    const inv = await endpoint.run("hardware-inventory", { clientId: theta.id });
    const invA = inv.rows.find((r) => r.name === `PA-${stamp}`);
    check("inventory reads the Windows edition, version and build", invA.osName === "Windows 11 Pro" && invA.osVersion === "23H2" && invA.osBuild === "22631.3007", invA);
    check("inventory works out age and uptime", invA.ageYears > 5 && invA.uptimeDays === 45 && invA.pendingReboot === "Yes" && invA.mac === "AA:BB:CC:DD:EE:01", [invA.ageYears, invA.uptimeDays]);
    check("these columns are there but hidden until chosen", inv.columns.filter((c) => ["osName", "biosDate", "uptimeDays", "mac"].includes(c.key)).every((c) => c.visible === false) && !endpoint.toCsv(inv).split("\r\n")[0].includes("MAC address"));
    check("a device that has not reported leaves them empty", inv.rows.find((r) => r.name === `PC-${stamp}`).osName === null);

    // ---- health notices restarts, long uptime and antivirus
    let th = await endpoint.run("device-health", { clientId: theta.id });
    const thA = th.rows.find((r) => r.name === `PA-${stamp}`);
    check("health flags a pending restart with its reason", /Restart pending \(Windows Update, Pending file changes\)/.test(thA.issues), thA.issues);
    check("health flags a long time without a restart", /Up 45 days without a restart/.test(thA.issues));
    check("health flags antivirus that is off", /real-time protection is off|No antivirus is switched on/i.test(thA.issues), thA.issues);
    check("a device that reports it is fine is healthy", th.rows.find((r) => r.name === `PB-${stamp}`).issues === "", th.rows.find((r) => r.name === `PB-${stamp}`).issues);
    check("an older agent is not flagged for what it cannot tell us", !/Restart|Up \d+ days|ntivirus/.test(th.rows.find((r) => r.name === `PC-${stamp}`).issues), th.rows.find((r) => r.name === `PC-${stamp}`).issues);
    th = await endpoint.run("device-health", { clientId: theta.id, maxUptimeDays: 90 });
    check("the uptime limit can be changed", !/Up \d+ days/.test(th.rows.find((r) => r.name === `PA-${stamp}`).issues) && th.params.maxUptimeDays === 90, th.params);
    check("health summary counts the new problems", th.summary.find((s) => s.label === "Restart pending").value === 1 && th.summary.find((s) => s.label === "Antivirus problem").value === 1, th.summary);

    // ---- security status
    const sec = await endpoint.run("security-status", { clientId: theta.id });
    const sA = sec.rows.find((r) => r.name === `PA-${stamp}`);
    const sB = sec.rows.find((r) => r.name === `PB-${stamp}`);
    check("security calls an unprotected device out, with every reason", sA.result === "Needs attention" && /Firewall off: Public/.test(sA.issues) && /not encrypted/.test(sA.issues) && sA.antivirusState === "Off", sA);
    check("security calls a protected device protected", sB.result === "Protected" && sB.antivirusState === "On" && sB.firewall === "On" && sB.encryption === "Encrypted" && sB.tpm === "Version 2.0", sB);
    check("a device that has not reported is not a failure", sec.rows.find((r) => r.name === `PC-${stamp}`).result === "Not reported" && sec.rows.find((r) => r.name === `PC-${stamp}`).antivirusState === "Not reported");
    check("security puts the problems first", sec.rows[0].result === "Needs attention", sec.rows.map((r) => r.result));
    check("security summary adds up", sec.summary.find((s) => s.label === "Need attention").value === 1 && sec.summary.find((s) => s.label === "Protected").value === 1 && sec.summary.find((s) => s.label === "Not reported").value === 5, sec.summary);
    check("security has charts", sec.charts.find((c) => c.key === "issues").data.length === 3, sec.charts.find((c) => c.key === "issues").data);
    const defOld = await endpoint.run("security-status", { clientId: theta.id, maxDefinitionAgeDays: 1 }, { filter: { match: "all", conditions: [{ field: "antivirusState", op: "eq", value: "Off" }] } });
    check("security takes a view like any report", defOld.rows.length === 1 && defOld.matchedRows === 1, defOld.rows.length);

    // ---- patch compliance
    const pc = await endpoint.run("patch-compliance", { clientId: theta.id });
    const by = (name) => pc.rows.find((r) => r.name === `${name}-${stamp}`);
    check("patch compliance leaves out devices that are not Windows, and says so", !pc.rows.some((r) => r.name === `PE-${stamp}`) && pc.notes.some((n) => /1 device that is not Windows or Linux/.test(n)), pc.notes);
    check("missing patches are counted from the latest good scan, less what was installed since", by("PA").result === "Missing patches" && by("PA").missing === 2 && by("PA").critical === 1 && by("PA").important === 0, by("PA"));
    check("it describes what is missing", by("PA").issues === "2 missing, 1 critical", by("PA").issues);
    check("the last install is shown", by("PA").lastInstallAt instanceof Date, by("PA").lastInstallAt);
    check("a restart-needed patch is noticed", by("PA").needsRestart === "Yes");
    check("an answer kept as a result artifact works too", by("PB").result === "Compliant" && by("PB").missing === 0 && by("PB").issues === "", by("PB"));
    check("a scan that failed says so", by("PC").result === "Scan failed" && /never been a successful/.test(by("PC").issues), by("PC"));
    check("a device with no scan at all is not scanned", by("PD").result === "Not scanned" && by("PD").missing === null, by("PD"));
    check("a scan that is too old is overdue, not compliant", by("PF").result === "Scan overdue" && /20 days ago/.test(by("PF").issues), by("PF"));
    const lenient = await endpoint.run("patch-compliance", { clientId: theta.id, staleDays: 30 });
    check("the overdue limit can be changed", lenient.rows.find((r) => r.name === `PF-${stamp}`).result === "Compliant" && lenient.params.staleDays === 30);
    check("the worst come first", ["Scan failed", "Not scanned", "Missing patches"].includes(pc.rows[0].result), pc.rows.map((r) => r.result));
    check("patch compliance summary adds up", pc.summary.find((s) => s.label === "Devices").value === 6 && pc.summary.find((s) => s.label === "Compliant").value === 1 && pc.summary.find((s) => s.label === "Critical missing").value === 1, pc.summary);

    // ---- missing updates, one row each
    const mp = await endpoint.run("patch-missing", { clientId: theta.id });
    check("one row for each missing update", mp.rows.length === 2 && mp.rows.every((r) => r.device === `PA-${stamp}`), mp.rows);
    check("the most serious is first, and shows its KB and restart", mp.rows[0].kb === "KB5001" && mp.rows[0].severity === "Critical" && mp.rows[0].restartNeeded === "Yes", mp.rows[0]);
    check("an update with no rating says so", mp.rows[1].severity === "Unrated" && mp.rows[1].kb === "KB5003", mp.rows[1]);
    check("what was installed since the scan is gone from the list", !mp.rows.some((r) => r.kb === "KB5002"));
    check("missing updates summarise and chart", mp.summary.find((s) => s.label === "Missing updates").value === 2 && mp.charts.find((c) => c.key === "severity").data.length === 2);

    // ---- what was installed
    const act = await endpoint.run("patch-activity", { from: "2020-01-01", to: today, clientId: theta.id });
    check("patch activity lists the installs", act.rows.length === 3, act.rows.length);
    const recent = act.rows.find((r) => r.installed === "KB5002, KB9");
    check("it says who, what and how it went", recent.by === `viewa${stamp}@example.test` && recent.status === "Succeeded" && recent.updates === 2 && recent.restartNeeded === "No", recent);
    const failedRun = act.rows.find((r) => r.status === "Failed" && r.device === `PB-${stamp}`);
    check("a failed install shows its error and counts as automatic when nobody started it", failedRun.by === "Automatic" && /Access denied/.test(failedRun.error), failedRun);
    check("patch activity summary and chart", act.summary.find((s) => s.label === "Failed").value === 1 && act.summary.find((s) => s.label === "Updates installed").value === 3 && act.charts.find((c) => c.key === "day").data.length >= 3);
    check("dates limit patch activity", (await endpoint.run("patch-activity", { from: "2001-01-01", to: "2001-02-01", clientId: theta.id })).rows.length === 0);

    // ---- every new report as a PDF and in the catalogue
    for (const key of ["security-status", "patch-compliance", "patch-missing", "patch-activity"]) {
        const file = await endpoint.pdfFile(key, { from: "2020-01-01", to: today, clientId: theta.id });
        check(`${key} makes a real PDF`, file.data.subarray(0, 5).toString() === "%PDF-" && file.data.length > 800, file.filename);
    }

    // ---- charts in PDFs, and no stray blank page
    const zlib = require("node:zlib");
    const pdfInfo = (buf) => {
        const raw = buf.toString("latin1");
        const pages = (raw.match(/\/Type \/Page(?!s)/g) || []).length;
        let content = "";
        // The data may itself end in a carriage return, so only the line feed before endstream is the separator.
        const re = /stream\r?\n([\s\S]*?)\nendstream/g;
        let m;
        while ((m = re.exec(raw))) {
            try { content += zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1") + "\n"; } catch { /* not a compressed stream */ }
        }
        // chart bars, rings and legends are curves and filled shapes; a table alone has straight-edged rectangles only
        return { pages, curves: (content.match(/ c\n/g) || []).length };
    };
    const withCharts = pdfInfo((await endpoint.pdfFile("hardware-inventory", {})).data);
    check("a report's PDF has its charts drawn in it", withCharts.curves > 30, withCharts);
    const noRows = { filter: { match: "all", conditions: [{ field: "name", op: "contains", value: "no-such-device" }] } };
    const noCharts = pdfInfo((await endpoint.pdfFile("hardware-inventory", {}, noRows)).data);
    check("and a filter that leaves nothing leaves no charts", noCharts.curves < 5 && noCharts.pages === 1, noCharts);
    const filteredCharts = pdfInfo((await endpoint.pdfFile("hardware-inventory", { clientId: theta.id })).data);
    check("charts follow the filter and scope: fewer devices, a smaller chart set", filteredCharts.curves > 0 && filteredCharts.curves <= withCharts.curves, [filteredCharts.curves, withCharts.curves]);
    for (const key of ["security-status", "patch-compliance", "device-health", "patch-missing"]) {
        const info = pdfInfo((await endpoint.pdfFile(key, { clientId: theta.id })).data);
        check(`${key} for a small customer is one page, with its charts, and no blank last page`, info.pages === 1 && info.curves > 10, info);
    }
    const alertsInfo = pdfInfo((await endpoint.pdfFile("alert-history", { from: "2020-01-01", to: today, clientId: client.id })).data);
    check("alert history has its daily chart and charts too", alertsInfo.pages === 1 && alertsInfo.curves > 10, alertsInfo);
    const summaryInfo = pdfInfo((await reports.healthPdfFile(client.id, "2020-01-01", today)).data);
    check("the customer summary PDF has charts as well", summaryInfo.pages === 1 && summaryInfo.curves > 10, summaryInfo);
    const manyRows = pdfInfo((await endpoint.pdfFile("software-inventory", {})).data);
    check("a long table runs over to more pages without a blank one at the end", manyRows.pages >= 1, manyRows);

    // ---- one device: every report can be limited to it
    const oneHw = await endpoint.run("hardware-inventory", { deviceId: device.id });
    check("a report can be limited to one device, and says which", oneHw.rows.length === 1 && oneHw.rows[0].name === `Z-${stamp}` && oneHw.scope.device === `Z-${stamp}` && oneHw.scope.customer === null, oneHw.scope);
    const oneSoft = await endpoint.run("software-inventory", { deviceId: device.id });
    check("software for one device", oneSoft.rows.length === 2 && oneSoft.rows.every((r) => r.device === `Z-${stamp}`), oneSoft.rows.length);
    const oneAlerts = await endpoint.run("alert-history", { deviceId: device.id, from: "2020-01-01", to: today });
    check("alerts for one device", oneAlerts.rows.length === 3 && oneAlerts.rows.every((r) => r.device === `Z-${stamp}`), oneAlerts.rows.length);
    const onePatch = await endpoint.run("patch-compliance", { deviceId: problem.dev.id });
    check("patching for one device", onePatch.rows.length === 1 && onePatch.rows[0].name === `PA-${stamp}` && onePatch.rows[0].missing === 2, onePatch.rows);
    const oneSessions = await endpoint.run("remote-sessions", { deviceId: device.id, from: "2020-01-01", to: today });
    check("remote sessions for one device", oneSessions.rows.length === 2 && oneSessions.rows.every((r) => r.device === `Z-${stamp}`) && oneSessions.scope.device === `Z-${stamp}`, oneSessions.rows.length);
    check("remote sessions for a customer include its devices' sessions", (await endpoint.run("remote-sessions", { clientId: client.id, from: "2020-01-01", to: today })).rows.length >= 2);
    check("and not another customer's", (await endpoint.run("remote-sessions", { clientId: theta.id, from: "2020-01-01", to: today, q: email })).rows.length === 0);
    check("remote sessions for a site", (await endpoint.run("remote-sessions", { siteId: site.id, from: "2020-01-01", to: today, q: email })).rows.length === 2);
    await rejects("a device from another customer is refused", () => endpoint.run("hardware-inventory", { clientId: theta.id, deviceId: device.id }), /does not exist in this customer or site/);
    await rejects("a device from another site is refused", () => endpoint.run("hardware-inventory", { siteId: thetaSite.id, deviceId: device.id }), /does not exist in this customer or site/);
    await rejects("an unknown device is refused", () => endpoint.run("hardware-inventory", { deviceId: crypto.randomUUID() }), /does not exist in this customer or site/);
    const oneDevicePdf = pdfInfo((await endpoint.pdfFile("hardware-inventory", { deviceId: device.id })).data);
    check("a one-device PDF works", oneDevicePdf.pages === 1);

    // ---- scheduled scans
    const { scanEveryHours } = require(path.join(dist, "patches/patches.service.js"));
    check("the scan interval defaults to a day", scanEveryHours(undefined) === 24 && scanEveryHours("") === 24);
    check("it can be changed, switched off or capped", scanEveryHours("6") === 6 && scanEveryHours("0") === 0 && scanEveryHours("100000") === 720);
    check("nonsense falls back to a day", scanEveryHours("abc") === 24 && scanEveryHours("-5") === 24);
    const taskCount = (agentId) => prisma.agent_tasks.count({ where: { agent_id: agentId, type: "patch_scan" } });
    const before = { quiet: await taskCount(quiet.ag.id), never: await taskCount(never.ag.id), linux: await taskCount(linux.ag.id), old: await taskCount(old.ag.id), fine: await taskCount(fine.ag.id) };
    check("switched off, nothing is queued", (await patches.queueDueScans(0)) === 0 && (await taskCount(quiet.ag.id)) === before.quiet);
    const queued = await patches.queueDueScans(24);
    check("a scan is queued for an online Windows device that has none", queued >= 1 && (await taskCount(quiet.ag.id)) === before.quiet + 1 && (await taskCount(never.ag.id)) === before.never + 1, [queued, before]);
    const queuedTask = await prisma.agent_tasks.findFirst({ where: { agent_id: quiet.ag.id, status: "queued", type: "patch_scan" } });
    check("it is a read-only scan with no user attached", queuedTask.payload.includeOptional === false && queuedTask.created_by === null && !!queuedTask.queued_at, queuedTask);
    check("a Linux device is never scanned", (await taskCount(linux.ag.id)) === before.linux);
    check("a device that is offline is not queued", (await taskCount(old.ag.id)) === before.old, [await taskCount(old.ag.id), before.old]);
    check("a device scanned within the day is left alone", (await taskCount(fine.ag.id)) === before.fine, [await taskCount(fine.ag.id), before.fine]);
    const again = await patches.queueDueScans(24);
    check("asking again does not queue a second scan", (await taskCount(quiet.ag.id)) === before.quiet + 1 && again >= 0);
    await prisma.agent_tasks.updateMany({ where: { agent_id: quiet.ag.id, status: "queued" }, data: { status: "succeeded" } });
    await patches.queueDueScans(24);
    check("a scan that just ran is not repeated inside the interval", (await taskCount(quiet.ag.id)) === before.quiet + 1);

    // ---- schedules
    await rejects("schedules check addresses", () => reports.createSchedule({ clientId: client.id, frequency: "monthly", recipients: ["nope"] }), /valid email/);
    await rejects("schedules check frequency", () => reports.createSchedule({ clientId: client.id, frequency: "hourly", recipients: ["a@example.test"] }), /daily, weekly, monthly or once/);
    const schedule = await reports.createSchedule({ clientId: client.id, frequency: "monthly", recipients: ["owner@example.test"] });
    let saved = await prisma.report_schedules.findUnique({ where: { id: schedule.id } });
    check("monthly reports go out on the first", saved.next_run_at.getUTCDate() === 1 && saved.next_run_at > new Date(), saved.next_run_at);

    const due = new Date(Date.UTC(2027, 2, 1, 7));
    await prisma.report_schedules.update({ where: { id: schedule.id }, data: { next_run_at: due } });
    saved = await prisma.report_schedules.findUnique({ where: { id: schedule.id } });
    const sent = await reports.runSchedule(saved, due);
    saved = await prisma.report_schedules.findUnique({ where: { id: schedule.id } });
    check("a mail failure keeps the report due and says why", sent === false && !!saved.last_error && saved.next_run_at.getTime() === due.getTime(), saved.last_error);

    const weekly = reports.nextRun("weekly", new Date(Date.UTC(2027, 2, 3)));
    check("weekly reports go out on Monday", weekly.getUTCDay() === 1 && weekly.getUTCDate() === 8, weekly);
    const march = reports.period("monthly", due);
    check("a monthly report covers the whole previous month", march.from === "2027-02-01" && march.to === "2027-02-28", march);
    const week = reports.period("weekly", new Date(Date.UTC(2027, 2, 8, 7)));
    check("a weekly report covers the previous seven days", week.from === "2027-03-01" && week.to === "2027-03-07", week);

    await reports.updateSchedule(schedule.id, { frequency: "weekly", recipients: ["b@example.test"], enabled: false });
    saved = await prisma.report_schedules.findUnique({ where: { id: schedule.id } });
    check("a changed schedule moves its next run", saved.frequency === "weekly" && saved.next_run_at.getUTCDay() === 1 && saved.enabled === false, saved);
    await reports.deleteSchedule(schedule.id);
    check("schedules can be removed", (await reports.listSchedules()).items.every((s) => s.id !== schedule.id));

    // ---- scheduling any report (mail is replaced by a recorder, so what would be sent can be looked at)
    const { SmtpService } = require(path.join(dist, "smtp/smtp.service.js"));
    const smtp = app.get(SmtpService, { strict: false });
    const realSend = smtp.sendWithAttachment.bind(smtp);
    const mailbox = [];
    let mailResult = { ok: true, result: "Sent" };
    smtp.sendWithAttachment = async (purpose, to, subject, text, attachment) => {
        mailbox.push({ purpose, to, subject, text, attachments: Array.isArray(attachment) ? attachment : attachment ? [attachment] : [] });
        return mailResult;
    };
    const sched = async (extra) => reports.createSchedule({ frequency: "daily", recipients: ["boss@example.test", "tech@example.test"], ...extra });

    await rejects("alert history is not emailed", () => sched({ reportKey: "alert-history" }), /cannot be scheduled/);
    await rejects("remote sessions are not emailed", () => sched({ reportKey: "remote-sessions" }), /cannot be scheduled/);
    await rejects("an unknown report is not scheduled", () => sched({ reportKey: "nope" }), /cannot be scheduled/);
    await rejects("a format must be one we make", () => sched({ reportKey: "security-status", format: "xlsx" }), /PDF, a CSV or both/);
    await rejects("the customer summary needs a customer", () => sched({ reportKey: "customer-health" }), /Choose a customer/);
    await rejects("the customer summary is only a PDF", () => sched({ reportKey: "customer-health", clientId: theta.id, format: "csv" }), /only|as a PDF/);
    await rejects("a customer that is not there is refused", () => sched({ reportKey: "security-status", clientId: crypto.randomUUID() }), /does not exist/);
    await rejects("a saved view must be for the same report", async () => {
        const v = await views.create(userRowA.id, { reportKey: "hardware-inventory", name: `For sched ${stamp}`, config: {} });
        return sched({ reportKey: "security-status", viewId: v.id });
    }, /not for this report/);
    await rejects("a view that cannot run is refused now, not at 07:00", () => sched({ reportKey: "security-status", clientId: theta.id, config: { view: { filter: { match: "all", conditions: [{ field: "nope", op: "eq", value: "x" }] } } } }), /does not exist/);
    await rejects("recipients are checked", () => sched({ reportKey: "security-status", recipients: ["nope"] }), /valid email/);
    await rejects("there is a limit on recipients", () => sched({ reportKey: "security-status", recipients: Array.from({ length: 21 }, (_, i) => `a${i}@example.test`) }), /at most 20/);

    // the All report on a schedule, for a customer, a site or one device
    await rejects("the All report is sent as a PDF, a workbook or both, not CSV", () => sched({ reportKey: "full-report", clientId: client.id, format: "csv" }), /PDF, an Excel workbook or both/);
    await rejects("only the All report can be sent for one device", () => sched({ reportKey: "security-status", deviceId: device.id }), /Only the All report/);
    await rejects("a device that is not there is refused", () => sched({ reportKey: "full-report", deviceId: crypto.randomUUID() }), /device does not exist/);
    await rejects("a device must be in the chosen site", () => sched({ reportKey: "full-report", deviceId: device.id, siteId: otherSite.id }), /not in that site/);
    await rejects("a site must be in the chosen customer", () => sched({ reportKey: "full-report", siteId: site.id, clientId: other.id }), /not in that customer/);
    const fullSite = await sched({ reportKey: "full-report", siteId: site.id, format: "both" });
    const fullDev = await sched({ reportKey: "full-report", deviceId: device.id, format: "xlsx" });
    const fullRows = await prisma.report_schedules.findMany({ where: { id: { in: [fullSite.id, fullDev.id] } } });
    const siteRow = fullRows.find((r) => r.id === fullSite.id);
    const devRow = fullRows.find((r) => r.id === fullDev.id);
    check("a site schedule keeps its site and customer", siteRow.client_id === client.id && siteRow.config.scope.siteId === site.id && !siteRow.config.scope.deviceId, siteRow.config);
    check("a device schedule keeps its device and works out the customer", devRow.client_id === client.id && devRow.config.scope.deviceId === device.id && !devRow.config.scope.siteId, devRow.config);
    check("the list calls it the All report", (await reports.listSchedules()).items.find((s) => s.id === fullSite.id).title === "All report");
    mailbox.length = 0;
    const fullOut = await reports.sendNow(fullSite.id);
    const fullMail = mailbox[0];
    check("it sends a PDF and a workbook, and says what is in them", fullOut.result.startsWith("Sent (") && fullMail.attachments.length === 2 && fullMail.attachments.some((a) => /\.pdf$/.test(a.filename) && a.content.subarray(0, 5).toString() === "%PDF-") && fullMail.attachments.some((a) => /\.xlsx$/.test(a.filename) && a.content.subarray(0, 2).toString() === "PK") && /Patch compliance:/.test(fullMail.text), [fullOut, fullMail.attachments.map((a) => a.filename)]);
    check("the email never carries remote sessions", /Remote sessions is not included in emailed reports/.test(fullMail.text) && !/Remote sessions: \d/.test(fullMail.text), fullMail.text);
    mailbox.length = 0;
    await reports.sendNow(fullDev.id);
    check("a device schedule sends only the workbook", mailbox[0].attachments.length === 1 && /\.xlsx$/.test(mailbox[0].attachments[0].filename) && mailbox[0].subject.startsWith(`Full report: Z-${stamp}`), [mailbox[0].subject, mailbox[0].attachments.map((a) => a.filename)]);
    await reports.updateSchedule(fullDev.id, { frequency: "daily", recipients: ["boss@example.test"], format: "pdf" });
    await rejects("a change cannot make the All report a CSV", () => reports.updateSchedule(fullDev.id, { frequency: "daily", recipients: ["boss@example.test"], format: "csv" }), /PDF, an Excel workbook or both/);
    await reports.deleteSchedule(fullSite.id);
    await reports.deleteSchedule(fullDev.id);

    // a saved view becomes a schedule, and the schedule keeps its own copy
    const sv = await views.create(userRowA.id, { reportKey: "security-status", name: `Unprotected ${stamp}`, config: { scope: { clientId: theta.id }, params: { maxDefinitionAgeDays: 3 }, view: { filter: { match: "all", conditions: [{ field: "result", op: "eq", value: "Needs attention" }] }, sort: [{ key: "name", dir: "asc" }], columns: ["name", "antivirusState", "issues"] } } });
    const made2 = await sched({ reportKey: "security-status", viewId: sv.id, format: "both" });
    let listed2 = (await reports.listSchedules()).items.find((s) => s.id === made2.id);
    check("a schedule says what it sends, to whom and how", listed2.reportKey === "security-status" && listed2.title === "Security status" && listed2.client.name === `Theta ${stamp}` && listed2.format === "both" && listed2.filtered === true && listed2.frequency === "daily" && listed2.sendIfEmpty === true, listed2);
    await views.remove(sv.id, userRowA.id);
    const stored = await prisma.report_schedules.findUnique({ where: { id: made2.id } });
    check("the schedule keeps its settings when the saved view is removed", stored.config.view.filter.conditions[0].value === "Needs attention" && stored.config.params.maxDefinitionAgeDays === 3 && stored.client_id === theta.id, stored.config);
    check("a daily schedule is first due at 07:00 tomorrow", stored.next_run_at.getUTCHours() === 7 && stored.next_run_at > new Date() && stored.next_run_at.getTime() - Date.now() <= 31 * 3_600_000, stored.next_run_at);

    // send it now, and look at the mail
    const nextBefore = stored.next_run_at.getTime();
    mailbox.length = 0;
    const out = await reports.sendNow(made2.id);
    const mail = mailbox[0];
    check("send-now sends one message through the reports mailbox", mailbox.length === 1 && mail.purpose === "reports" && mail.to === "boss@example.test, tech@example.test" && out.result.startsWith("Sent (1 row)"), [mailbox.length, out]);
    check("the subject names the report, customer and day", new RegExp(`^Security status, Theta ${stamp}, \\d{4}-\\d{2}-\\d{2}$`).test(mail.subject), mail.subject);
    check("the body gives the headline numbers and says a filter is on", /Devices: 1/.test(mail.text) && /Need attention: 1/.test(mail.text) && /A filter is applied: 1 of 7 rows/.test(mail.text) && /as a PDF and a CSV/.test(mail.text), mail.text);
    check("both a PDF and a CSV are attached", mail.attachments.length === 2 && mail.attachments[0].filename.endsWith(".pdf") && mail.attachments[1].filename.endsWith(".csv"), mail.attachments.map((a) => a.filename));
    check("the PDF is a real PDF", mail.attachments[0].content.subarray(0, 5).toString() === "%PDF-" && mail.attachments[0].contentType === "application/pdf");
    const csvBody = mail.attachments[1].content;
    check("the CSV opens in Excel, with the chosen columns and only the matching row", csvBody[0] === 0xef && csvBody.toString("utf8").replace(/^﻿/, "").split("\r\n")[0] === "Device,Antivirus,Issues" && csvBody.toString("utf8").split("\r\n").length === 2 && csvBody.toString("utf8").includes(`PA-${stamp}`), csvBody.toString("utf8").slice(0, 120));
    const afterNow = await prisma.report_schedules.findUnique({ where: { id: made2.id } });
    check("a test send leaves the schedule's next run alone and records itself", afterNow.next_run_at.getTime() === nextBefore && /\(test\)$/.test(afterNow.last_result) && afterNow.last_error === null, afterNow.last_result);

    // a real run moves the schedule on
    mailbox.length = 0;
    const dueAt = new Date(Date.UTC(2027, 5, 10, 7));
    await prisma.report_schedules.update({ where: { id: made2.id }, data: { next_run_at: dueAt } });
    const sentOk = await reports.runSchedule(await prisma.report_schedules.findUnique({ where: { id: made2.id } }), dueAt);
    const ranRow = await prisma.report_schedules.findUnique({ where: { id: made2.id } });
    check("a successful run sends, records the result and moves to the next day", sentOk === true && mailbox.length === 1 && /^Sent \(1 row\)$/.test(ranRow.last_result) && ranRow.last_error === null && ranRow.next_run_at.getTime() === Date.UTC(2027, 5, 11, 7), [ranRow.last_result, ranRow.next_run_at]);

    // nothing to report
    const quietView = { filter: { match: "all", conditions: [{ field: "name", op: "contains", value: "no-such-device" }] } };
    const quiet2 = await sched({ reportKey: "security-status", clientId: theta.id, config: { view: quietView }, sendIfEmpty: false });
    mailbox.length = 0;
    const skip = await reports.sendNow(quiet2.id);
    check("a report with nothing in it is skipped when the schedule says so", mailbox.length === 0 && skip.result === "Skipped: nothing to report", skip);
    await reports.updateSchedule(quiet2.id, { frequency: "daily", recipients: ["a@example.test"], sendIfEmpty: true });
    await reports.sendNow(quiet2.id);
    check("and sent when it does not", mailbox.length === 1 && /Sent \(0 rows\)/.test((await prisma.report_schedules.findUnique({ where: { id: quiet2.id } })).last_result));

    // a mail failure keeps the report due
    mailResult = { ok: false, result: "Connection refused" };
    await prisma.report_schedules.update({ where: { id: made2.id }, data: { next_run_at: dueAt } });
    const mailFailed = await reports.runSchedule(await prisma.report_schedules.findUnique({ where: { id: made2.id } }), dueAt);
    const failedRow = await prisma.report_schedules.findUnique({ where: { id: made2.id } });
    check("a mail failure keeps the schedule due and says why", mailFailed === false && failedRow.last_error === "Connection refused" && failedRow.next_run_at.getTime() === dueAt.getTime(), failedRow.last_error);
    await rejects("send-now tells the person why it failed", () => reports.sendNow(made2.id), /Connection refused/);
    mailResult = { ok: true, result: "Sent" };
    await rejects("an unknown schedule is not found", () => reports.sendNow(crypto.randomUUID()), /not found/);

    // a report with a period uses the days it was saved with
    const act2 = await sched({ reportKey: "patch-activity", clientId: theta.id, config: { days: 14 } });
    mailbox.length = 0;
    await reports.sendNow(act2.id);
    const periodMatch = /, (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/.exec(mailbox[0].subject);
    const spanDays = Math.round((new Date(periodMatch[2]).getTime() - new Date(periodMatch[1]).getTime()) / 86_400_000) + 1;
    check("a report with a period covers the days it was saved with, ending yesterday", spanDays === 14 && periodMatch[2] === new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), mailbox[0].subject);
    const noViewSchedule = await sched({ reportKey: "hardware-inventory", format: "csv" });
    mailbox.length = 0;
    await reports.sendNow(noViewSchedule.id);
    check("a schedule for every customer works, and a CSV alone is just a CSV", mailbox[0].attachments.length === 1 && mailbox[0].attachments[0].filename.endsWith(".csv") && /All customers/.test(mailbox[0].subject), mailbox[0].subject);

    // changing a schedule
    const before2 = (await prisma.report_schedules.findUnique({ where: { id: noViewSchedule.id } })).next_run_at.getTime();
    await reports.updateSchedule(noViewSchedule.id, { frequency: "weekly", recipients: ["z@example.test"], format: "pdf", enabled: false });
    const changed = (await reports.listSchedules()).items.find((s) => s.id === noViewSchedule.id);
    const changedRow = await prisma.report_schedules.findUnique({ where: { id: noViewSchedule.id } });
    check("a schedule can be changed, and a new frequency moves its next run", changed.frequency === "weekly" && changed.format === "pdf" && changed.enabled === false && changedRow.next_run_at.getTime() !== before2 && changedRow.next_run_at.getUTCDay() === 1, changed);
    await rejects("a schedule update checks its format", () => reports.updateSchedule(noViewSchedule.id, { frequency: "daily", recipients: ["z@example.test"], format: "doc" }), /PDF, a CSV or both/);
    const healthSched = await reports.createSchedule({ clientId: theta.id, frequency: "monthly", recipients: ["o@example.test"] });
    check("the original customer summary schedule still works the same way", (await reports.listSchedules()).items.find((s) => s.id === healthSched.id).title === "Customer summary");
    mailbox.length = 0;
    await reports.sendNow(healthSched.id);
    check("and is sent as one PDF", mailbox.length === 1 && mailbox[0].attachments.length === 1 && mailbox[0].attachments[0].contentType === "application/pdf" && /health report/.test(mailbox[0].subject), mailbox[0] && mailbox[0].subject);
    const rows = (await reports.listSchedules()).items;
    check("every schedule can be removed", await Promise.all([made2.id, quiet2.id, act2.id, noViewSchedule.id, healthSched.id].map((id) => reports.deleteSchedule(id))).then(() => true));
    check("and they are gone", !(await reports.listSchedules()).items.some((s) => [made2.id, quiet2.id, act2.id, noViewSchedule.id, healthSched.id].includes(s.id)) && rows.length >= 5);
    check("days and weeks for a new schedule", reports.nextRun("daily", new Date(Date.UTC(2027, 2, 3, 12))).getTime() === Date.UTC(2027, 2, 4, 7) && reports.period("daily", new Date(Date.UTC(2027, 2, 4, 7))).from === "2027-03-03");
    smtp.sendWithAttachment = realSend;

    // ---- choosing days and times (mail is still the recorder from above)
    smtp.sendWithAttachment = async (purpose, to, subject, text, attachment) => {
        mailbox.push({ purpose, to, subject, text, attachments: Array.isArray(attachment) ? attachment : attachment ? [attachment] : [] });
        return mailResult;
    };
    const timing = require(path.join(dist, "reports/schedule-time.js"));
    const NYC = "America/New_York";
    const base = { reportKey: "security-status", clientId: theta.id, recipients: ["ops@example.test"] };

    const monThu = await reports.createSchedule({ ...base, frequency: "weekly", daysOfWeek: [4, 1], time: "09:00", timezone: NYC });
    let mt = await prisma.report_schedules.findUnique({ where: { id: monThu.id } });
    check("a weekly schedule keeps its days, time and zone", mt.frequency === "weekly" && mt.days_of_week.join() === "1,4" && mt.time_of_day === "09:00" && mt.timezone === NYC, mt);
    const expectNext = timing.nextRun({ kind: "weekly", daysOfWeek: [1, 4], time: "09:00", timezone: NYC }, new Date());
    check("its first send is the next Monday or Thursday at 9 in New York", mt.next_run_at.getTime() === expectNext.getTime() && [1, 4].includes(timing.localParts(mt.next_run_at.getTime(), NYC).weekday) && timing.localParts(mt.next_run_at.getTime(), NYC).hour === 9, mt.next_run_at);
    const listedMT = (await reports.listSchedules()).items.find((s) => s.id === monThu.id);
    check("the list says it in words", listedMT.description === "Every Monday and Thursday at 9:00 AM (America/New_York)" && listedMT.schedule.daysOfWeek.join() === "1,4" && listedMT.schedule.timezone === NYC, listedMT.description);

    const previewed = await reports.previewSchedule({ frequency: "monthly", nthWeek: 2, nthWeekday: 2, time: "17:30", timezone: "Europe/London" });
    check("a preview shows the next five send times in the customer's zone", previewed.runs.length === 5 && previewed.description === "The second Tuesday of every month at 5:30 PM (Europe/London)" && previewed.runs.every((r, i) => i === 0 || r.at > previewed.runs[i - 1].at) && /Tuesday/.test(previewed.runs[0].local) && /(GMT|BST|UTC)/.test(previewed.runs[0].local), previewed.runs[0]);
    await rejects("a preview of a bad rule says why", () => reports.previewSchedule({ frequency: "weekly", time: "9am" }), /09:30/);
    await rejects("a time zone must exist", () => reports.createSchedule({ ...base, frequency: "daily", timezone: "Mars/Base" }), /time zone/);
    await rejects("a weekly schedule needs a day", () => reports.createSchedule({ ...base, frequency: "weekly", daysOfWeek: [] }), /at least one day/);
    await rejects("a made-up frequency is refused", () => reports.createSchedule({ ...base, frequency: "hourly" }), /daily, weekly, monthly or once/);
    await rejects("a one-off in the past is refused", () => reports.createSchedule({ ...base, frequency: "once", onceDate: "2020-01-01", time: "09:00" }), /already passed/);

    // changing when it sends
    const nextBeforeEdit = mt.next_run_at.getTime();
    await reports.updateSchedule(monThu.id, { frequency: "weekly", recipients: ["ops2@example.test"] });
    mt = await prisma.report_schedules.findUnique({ where: { id: monThu.id } });
    check("changing only who it goes to does not move it", mt.next_run_at.getTime() === nextBeforeEdit && mt.recipients.join() === "ops2@example.test");
    await reports.updateSchedule(monThu.id, { frequency: "monthly", nthWeek: -1, nthWeekday: 5, time: "16:00", recipients: ["ops2@example.test"] });
    mt = await prisma.report_schedules.findUnique({ where: { id: monThu.id } });
    const lastFri = timing.localParts(mt.next_run_at.getTime(), NYC);
    check("it can become the last Friday of the month at 4 PM, keeping the zone", mt.frequency === "monthly" && mt.nth_week === -1 && mt.nth_weekday === 5 && mt.day_of_month === null && mt.timezone === NYC && lastFri.weekday === 5 && lastFri.hour === 16 && lastFri.day + 7 > new Date(Date.UTC(lastFri.year, lastFri.month, 0)).getUTCDate(), [mt, lastFri]);
    await reports.updateSchedule(monThu.id, { frequency: "monthly", dayOfMonth: 31, recipients: ["ops2@example.test"] });
    mt = await prisma.report_schedules.findUnique({ where: { id: monThu.id } });
    check("switching to a day of the month drops the weekday rule", mt.day_of_month === 31 && mt.nth_week === null && mt.nth_weekday === null && mt.time_of_day === "16:00", mt);
    await reports.updateSchedule(monThu.id, { frequency: "daily", time: "06:15", timezone: "Asia/Kolkata", recipients: ["ops2@example.test"] });
    mt = await prisma.report_schedules.findUnique({ where: { id: monThu.id } });
    check("or every day in another zone", mt.frequency === "daily" && mt.timezone === "Asia/Kolkata" && mt.days_of_week.length === 0 && mt.day_of_month === null && timing.localParts(mt.next_run_at.getTime(), "Asia/Kolkata").hour === 6 && timing.localParts(mt.next_run_at.getTime(), "Asia/Kolkata").minute === 15, mt.next_run_at);
    await rejects("a bad change is refused and nothing is saved", () => reports.updateSchedule(monThu.id, { frequency: "weekly", daysOfWeek: [9], recipients: ["ops2@example.test"] }), /at least one day/);
    check("the stored schedule is untouched by a refused change", (await prisma.report_schedules.findUnique({ where: { id: monThu.id } })).frequency === "daily");

    // a run crosses the clocks going forward and keeps the same local time
    const dst = await reports.createSchedule({ ...base, frequency: "daily", time: "09:00", timezone: NYC });
    const beforeChange = new Date(Date.UTC(2026, 2, 7, 14, 0));
    await prisma.report_schedules.update({ where: { id: dst.id }, data: { next_run_at: beforeChange } });
    mailbox.length = 0;
    await reports.runSchedule(await prisma.report_schedules.findUnique({ where: { id: dst.id } }), beforeChange);
    const afterRun = await prisma.report_schedules.findUnique({ where: { id: dst.id } });
    check("after Saturday's 9 AM the next is Sunday's 9 AM, which is an hour earlier in UTC", afterRun.next_run_at.toISOString() === "2026-03-08T13:00:00.000Z" && mailbox.length === 1, afterRun.next_run_at);

    // a one-off sends once, then switches itself off
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const oneOff = await reports.createSchedule({ ...base, frequency: "once", onceDate: day, time: "10:00", timezone: "America/Chicago" });
    let oneRow = await prisma.report_schedules.findUnique({ where: { id: oneOff.id } });
    check("a one-off is due on its date at its time", oneRow.once_date === day && timing.localDate(oneRow.next_run_at, "America/Chicago") === day && timing.localParts(oneRow.next_run_at.getTime(), "America/Chicago").hour === 10, oneRow.next_run_at);
    mailbox.length = 0;
    await reports.runSchedule(oneRow, oneRow.next_run_at);
    oneRow = await prisma.report_schedules.findUnique({ where: { id: oneOff.id } });
    check("after it sends, a one-off is switched off and kept as a record", mailbox.length === 1 && oneRow.enabled === false && /^Sent/.test(oneRow.last_result) && oneRow.last_error === null, oneRow);
    check("and is not due again", !(await prisma.report_schedules.findMany({ where: { enabled: true, next_run_at: { lte: new Date(Date.now() + 365 * 86_400_000) }, id: oneOff.id } })).length);

    // the period a report covers follows the customer's calendar
    check("the period just finished is worked out where the customer is", reports.period("daily", new Date("2026-06-10T13:00:00Z"), "Pacific/Auckland").from === "2026-06-10" && reports.period("daily", new Date("2026-06-10T13:00:00Z"), "UTC").from === "2026-06-09");
    check("seven days and months follow the same calendar", reports.period("weekly", new Date("2026-06-10T13:00:00Z"), "Pacific/Auckland").to === "2026-06-10" && reports.period("monthly", new Date("2026-06-30T13:00:00Z"), "Pacific/Auckland").from === "2026-06-01");

    // existing schedules keep sending when they did
    const legacy = await prisma.report_schedules.create({ data: { organization_id: org.id, client_id: theta.id, report_key: "customer-health", frequency: "weekly", recipients: ["l@example.test"], next_run_at: new Date(Date.UTC(2027, 0, 4, 7)), days_of_week: [1] } });
    const legacyListed = (await reports.listSchedules()).items.find((s) => s.id === legacy.id);
    check("a weekly schedule from before is still Monday at 7 UTC", legacyListed.description === "Every Monday at 7:00 AM (UTC)", legacyListed.description);
    for (const id of [monThu.id, dst.id, oneOff.id, legacy.id]) await reports.deleteSchedule(id);
    smtp.sendWithAttachment = realSend;

    const { FullReportService, EMAILED_PERMISSIONS, FULL_SECTIONS } = require(path.join(dist, "reports/full-report.service.js"));
    const full = app.get(FullReportService, { strict: false });
    // demo data, and the reports that read it
    const { DemoService } = require(path.join(dist, "demo/demo.service.js"));
    const demo = app.get(DemoService, { strict: false });
    await demo.disable();
    const rowsBefore = {
        devices: await prisma.devices.count(), clients: await prisma.clients.count(), tickets: await prisma.tickets.count(),
        audit: await prisma.audit_events.count(), assets: await prisma.assets.count(), contracts: await prisma.contracts.count(), sites: await prisma.sites.count(),
    };
    check("demo data starts off", (await demo.status()).enabled === false);
    const onRun = await demo.enable();
    check("turning it onRun makes two customers and ten endpoints", onRun.enabled && onRun.counts.customers === 2 && onRun.counts.devices === 10 && onRun.counts.sites === 4, onRun);
    check("it makes tickets, remote sessions and assets as well", onRun.counts.tickets >= 10 && onRun.counts.sessions >= 10 && onRun.counts.assets === 10, onRun.counts);
    check("turning it onRun again changes nothing", (await demo.enable()).counts.devices === 10 && (await prisma.devices.count()) === rowsBefore.devices + 10);
    const demoClients = await prisma.clients.findMany({ where: { name: { startsWith: "Demo: " } } });
    const harbor = demoClients.find((c) => /Harbor/.test(c.name));
    const summit = demoClients.find((c) => /Summit/.test(c.name));
    const dHealth = await endpoint.run("device-health", { clientId: harbor.id });
    const issuesOf = dHealth.rows.map((r) => [r.name, r.result, r.issues]);
    check("the demo fleet has devices that need attention and some that are fine", dHealth.rows.length === 5 && dHealth.rows.some((r) => r.result === "Needs attention") && dHealth.rows.some((r) => r.result === "Healthy"), issuesOf);
    const dSec = await endpoint.run("security-status", { clientId: summit.id });
    check("security shows real findings in the demo", dSec.rows.length === 5 && dSec.rows.some((r) => r.result === "Needs attention"), dSec.rows.map((r) => r.result));
    const dPatch = await endpoint.run("patch-compliance", { clientId: harbor.id });
    check("patching has compliant, missing and overdue devices", dPatch.rows.some((r) => r.result === "Compliant") && dPatch.rows.some((r) => r.result === "Missing patches") && dPatch.rows.some((r) => r.result === "Scan overdue"), dPatch.rows.map((r) => r.result));
    const dSoft = await endpoint.run("software-inventory", { clientId: harbor.id });
    check("each demo device has plenty of software", dSoft.rows.length >= 70, dSoft.rows.length);

    // the newer reports
    const ageRun = await endpoint.run("hardware-age", { clientId: harbor.id });
    check("hardware ageRun says what to replace, and uses purchase dates", ageRun.rows.length === 5 && ageRun.rows.some((r) => r.stage === "Replace now") && ageRun.rows.some((r) => r.stage === "Current") && ageRun.rows.every((r) => r.ageSource === "Purchase date"), ageRun.rows.map((r) => [r.name, r.stage, r.ageYears]));
    check("a longer refresh limit changes the answer", (await endpoint.run("hardware-age", { clientId: harbor.id, refreshYears: 15 })).rows.every((r) => r.stage === "Current"));
    const winRun = await endpoint.run("windows-support", { clientId: harbor.id });
    const xrayRow = winRun.rows.find((r) => r.name === "HAR-XRAY-03");
    check("Windows support flags Windows 10 21H2 as out of support and not ready for 11", xrayRow && xrayRow.support === "Out of support" && xrayRow.windows11 === "Not ready" && /TPM/.test(xrayRow.blockers) && /too old/.test(xrayRow.blockers), xrayRow);
    const frontRow = winRun.rows.find((r) => r.name === "HAR-FRONT-01");
    check("a current Windows 11 machine has support and no readiness verdict", frontRow && frontRow.windows11 === null && frontRow.support !== "Out of support", frontRow);
    const serverRow = winRun.rows.find((r) => r.name === "HAR-SRV-01");
    check("Server 2016 is recognised and still supported", serverRow && serverRow.os.includes("2016") && serverRow.supportEnds === "2027-01-12", serverRow);
    const chairRow = winRun.rows.find((r) => r.name === "HAR-CHAIR-02");
    check("a Windows 10 machine that meets the requirements is ready for 11", chairRow && chairRow.windows11 === "Ready" && chairRow.support === "Out of support", chairRow);
    const staleRun = await endpoint.run("stale-devices", { clientId: summit.id, notSeenDays: 7 });
    check("staleRun devices lists the one not seen for 16 days, and only that one", staleRun.rows.length === 1 && staleRun.rows[0].name === "SUM-REMOTE-04" && staleRun.rows[0].state === "Stale", staleRun.rows.map((r) => [r.name, r.state]));
    const staleLong = await endpoint.run("stale-devices", { clientId: summit.id, notSeenDays: 30 });
    check("a longer limit empties the list", staleLong.rows.length === 0);
    const noAgent = await prisma.devices.create({ data: { site_id: (await prisma.sites.findFirst({ where: { client_id: summit.id } })).id, hostname: `DEMO-NOAGENT-${stamp}` } });
    check("a device with no agent shows as one", (await endpoint.run("stale-devices", { clientId: summit.id, notSeenDays: 30 })).rows.some((r) => r.name === noAgent.hostname && r.state === "No agent"));
    await prisma.devices.delete({ where: { id: noAgent.id } });
    const netRun = await endpoint.run("network-map", { clientId: harbor.id });
    check("the network map lists an address for each device with its network and gateway", netRun.rows.length === 5 && netRun.rows.every((r) => r.network && r.gateway && r.mac) && netRun.rows.some((r) => r.network === "10.20.2.0/24"), netRun.rows.map((r) => r.network));
    const frontId = (await prisma.devices.findFirst({ where: { hostname: "HAR-FRONT-01" } })).id;
    const frontFacts = (await prisma.agents.findUnique({ where: { device_id: frontId } })).facts;
    await prisma.agents.update({ where: { device_id: (await prisma.devices.findFirst({ where: { hostname: "HAR-FRONT-01" } })).id }, data: { facts: (await prisma.agents.findFirst({ where: { devices: { hostname: "HAR-CHAIR-02" } } })).facts } });
    const dupRun = await endpoint.run("network-map", { clientId: harbor.id });
    await prisma.agents.update({ where: { device_id: frontId }, data: { facts: frontFacts } });
    check("two devices onRun one address in a customer are flagged onRun both rows", dupRun.rows.filter((r) => r.duplicate === true).length === 2 && dupRun.rows.filter((r) => r.duplicate === true).every((r) => /Also used by 1 other device/.test(r.conflict)), dupRun.rows.map((r) => [r.name, r.ip, r.conflict]));
    const scoreRun = await endpoint.run("security-score", { clientId: summit.id });
    const best = scoreRun.rows.find((r) => r.name === "SUM-PARTNER-01");
    const worst = scoreRun.rows.find((r) => r.name === "SUM-PARALEGAL-02");
    check("the security scoreRun ranks a well-protected machine above a weak one", best.score >= 90 && best.grade === "A" && worst.score < best.score && /encrypt|Secure Boot|Patches/i.test(worst.weakest), [best, worst]);
    check("the worst devices come first", scoreRun.rows.filter((r) => r.score !== null).every((r, i, a) => i === 0 || a[i - 1].score <= r.score));
    check("every scoreRun says how much of it was measured", scoreRun.rows.every((r) => r.coverage > 0 && r.coverage <= 100));

    // service reports on the demo data
    const lastMonth = { from: new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) };
    const comp = await endpoint.run("software-compliance", { clientId: harbor.id, required: "Zzz Nonexistent Program", banned: "" });
    check("every device missing a required program is non-compliant and says what is missing", comp.rows.length === 5 && comp.rows.every((r) => r.result === "Non-compliant" && r.missingRequired === "Zzz Nonexistent Program"), comp.rows.map((r) => r.result));
    const compNone = await endpoint.run("software-compliance", { clientId: harbor.id, required: "", banned: "" });
    check("with no lists everything is compliant, and it says so", compNone.rows.every((r) => r.result === "Compliant") && /no lists/.test(compNone.notes.join(" ")));
    const compBanned = await endpoint.run("software-compliance", { clientId: harbor.id, required: "", banned: "e" });
    check("a banned entry matches any part of a program's name", compBanned.rows.every((r) => r.result === "Non-compliant" && r.bannedFound.length > 0));
    const ren = await endpoint.run("renewals", { clientId: harbor.id, withinDays: 730 });
    check("renewals lists warranties and the contract, soonest first", ren.rows.some((r) => r.type === "Warranty") && ren.rows.some((r) => r.type === "Contract") && ren.rows.every((r, i, a) => i === 0 || Number(a[i - 1].daysLeft) <= Number(r.daysLeft)), ren.rows.map((r) => [r.type, r.item, r.daysLeft]));
    const renSite = await endpoint.run("renewals", { siteId: (await prisma.sites.findFirst({ where: { client_id: harbor.id, name: "Front desk" } })).id, withinDays: 730 });
    check("narrowed to a site, renewals leaves out customer contracts", renSite.rows.every((r) => r.type !== "Contract") && renSite.rows.length <= 1, renSite.rows.length);
    const scr = await endpoint.run("script-results", { clientId: harbor.id, ...lastMonth });
    check("script results show runs with status, duration and who started them", scr.rows.length >= 20 && scr.rows.every((r) => r.status && r.script && r.startedBy) && scr.rows.some((r) => r.status === "Succeeded"), scr.rows.length);
    check("a failed script says what it said", scr.rows.filter((r) => r.status === "Failed").every((r) => String(r.error).length > 0));
    check("the script search narrows the list", (await endpoint.run("script-results", { clientId: harbor.id, ...lastMonth, q: "spooler" })).rows.every((r) => /spooler/i.test(String(r.script))));
    const noise = await endpoint.run("alert-noise", { clientId: harbor.id, ...lastMonth });
    check("alert noise groups alerts by kind, busiest first", noise.rows.length >= 2 && noise.rows.every((r, i, a) => i === 0 || Number(a[i - 1].alerts) >= Number(r.alerts)) && noise.rows.reduce((s, r) => s + Number(r.alerts), 0) === noise.summary.find((x) => x.label === "Alerts").value, noise.rows.map((r) => [r.alert, r.alerts]));
    const tick = await endpoint.run("ticket-sla", { clientId: harbor.id, ...lastMonth });
    check("ticket SLA lists the customer's tickets with hours to close and an SLA result", tick.rows.length >= 5 && tick.rows.every((r) => r.sla) && tick.rows.some((r) => r.hoursToClose !== null), tick.rows.length);
    check("an open ticket past its due time is overdue", tick.rows.filter((r) => r.closedAt === null).every((r) => r.sla === "Overdue"));
    const tech = await endpoint.run("technician-activity", { clientId: summit.id, ...lastMonth });
    check("technician activity counts sessions, refusals and devices per person", tech.rows.length >= 1 && tech.rows.every((r) => r.sessions + r.refused > 0 || r.scripts > 0) && tech.rows.every((r) => /@demo\.invalid$/.test(String(r.email))), tech.rows);

    // history reports on the demo data
    const span45 = { from: new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) };
    const avail = await endpoint.run("availability", { clientId: harbor.id, ...span45 });
    const availOf = (n) => avail.rows.find((r) => r.name === n);
    check("availability covers the days with data for every device", avail.rows.length === 5 && avail.rows.every((r) => r.daysCovered >= 44), avail.rows.map((r) => [r.name, r.daysCovered]));
    check("a steady server is available nearly all the time and meets the target", availOf("HAR-SRV-01").availability >= 99 && availOf("HAR-SRV-01").result === "Meets target", availOf("HAR-SRV-01"));
    check("a flaky machine is below target, with hours offline and a worst day", availOf("HAR-XRAY-03").availability < 95 && availOf("HAR-XRAY-03").result === "Below target" && availOf("HAR-XRAY-03").offlineHours > 50 && !!availOf("HAR-XRAY-03").worstDay, availOf("HAR-XRAY-03"));
    check("the least available device is listed first", avail.rows.every((r, i, a) => i === 0 || a[i - 1].availability <= r.availability));
    const availSummit = await endpoint.run("availability", { clientId: summit.id, ...span45 });
    check("a device offline for its last 16 days shows it", availSummit.rows.find((r) => r.name === "SUM-REMOTE-04").availability < 60, availSummit.rows.map((r) => [r.name, r.availability]));
    check("a lower target changes the verdict", (await endpoint.run("availability", { clientId: harbor.id, ...span45, targetPercent: 50 })).rows.every((r) => r.result === "Meets target"));
    const trend = await endpoint.run("disk-trend", { clientId: harbor.id, ...span45 });
    const trendOf = (n) => trend.rows.find((r) => r.name === n);
    check("a disk that has been filling is flagged as full soon with the days left", trendOf("HAR-CHAIR-02").state === "Full soon" && trendOf("HAR-CHAIR-02").daysUntilFull > 0 && trendOf("HAR-CHAIR-02").daysUntilFull <= 60 && trendOf("HAR-CHAIR-02").changeGb < 0, trendOf("HAR-CHAIR-02"));
    check("one that has been freeing up or steady is not", ["Freeing up", "Stable"].includes(trendOf("HAR-FRONT-01").state), trendOf("HAR-FRONT-01"));
    check("the most urgent disk is listed first", trend.rows[0].name === "HAR-CHAIR-02" || trend.rows[0].state === "Full soon");
    check("a longer warning window catches more", (await endpoint.run("disk-trend", { clientId: harbor.id, ...span45, warnDays: 730 })).rows.filter((r) => r.state === "Full soon").length >= trend.rows.filter((r) => r.state === "Full soon").length);
    const log = await endpoint.run("change-log", { clientId: harbor.id, ...span45 });
    check("the change log lists software and hardware changes with the device and a time", log.rows.length >= 15 && log.rows.every((r) => r.change && r.device && r.changedAt) && log.rows.some((r) => /Memory changed from 4 GB to 8 GB/.test(r.change) && r.device === "HAR-CHAIR-02"), log.rows.length);
    check("it can be searched", (await endpoint.run("change-log", { clientId: harbor.id, ...span45, q: "memory changed" })).rows.every((r) => /memory changed/i.test(r.change)));
    check("the newest change is first", log.rows.every((r, i, a) => i === 0 || new Date(a[i - 1].changedAt) >= new Date(r.changedAt)));
    const speed = await endpoint.run("patch-speed", { clientId: harbor.id, from: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10), to: span45.to });
    check("patch speed finds patches that were installed, with days between first sighting and install", speed.rows.some((r) => r.installedAt && Number(r.days) > 0 && /^Installed/.test(r.state)), speed.rows.slice(0, 3));
    check("and ones still missing, counted up to now", speed.rows.every((r) => r.installedAt || /missing/i.test(r.state)));
    check("the slowest come first", speed.rows.every((r, i, a) => i === 0 || a[i - 1].days >= r.days));
    check("a tighter limit marks more as late", speed.rows.filter((x) => /late|too long/.test(x.state)).length <= (await endpoint.run("patch-speed", { clientId: harbor.id, from: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10), to: span45.to, slowDays: 1 })).rows.filter((x) => /late|too long/.test(x.state)).length);
    const rc = await endpoint.run("risky-configuration", { clientId: harbor.id });
    const rcOf = (n) => rc.rows.find((r) => r.name === n);
    check("a machine with Remote Desktop and no NLA plus auto logon is high risk and says why", rcOf("HAR-CHAIR-02").result === "High risk" && /without network-level authentication/.test(rcOf("HAR-CHAIR-02").findings) && /Automatic logon/.test(rcOf("HAR-CHAIR-02").findings), rcOf("HAR-CHAIR-02"));
    check("SMBv1 and UAC off are high risk", rcOf("HAR-XRAY-03").result === "High risk" && /SMBv1/.test(rcOf("HAR-XRAY-03").findings) && /User Account Control/.test(rcOf("HAR-XRAY-03").findings));
    check("a tidy machine has no findings", rcOf("HAR-FRONT-01").result === "No findings" && rcOf("HAR-FRONT-01").findings === "", rcOf("HAR-FRONT-01"));
    check("Remote Desktop with NLA and too many admins is medium", rcOf("HAR-SRV-01").result === "Medium risk" && /6 local administrators/.test(rcOf("HAR-SRV-01").findings), rcOf("HAR-SRV-01"));
    check("the worst machines come first", rc.rows[0].result === "High risk");
    check("a higher admin allowance clears that finding", !/local administrators/.test((await endpoint.run("risky-configuration", { clientId: harbor.id, maxLocalAdmins: 10 })).rows.find((r) => r.name === "HAR-SRV-01").findings));
    const rcSummit = await endpoint.run("risky-configuration", { clientId: summit.id });
    check("a device with no risk data is not reported, not clean", rcSummit.rows.find((r) => r.name === "SUM-REMOTE-04").result === "Not reported");

    // the sampler and the change log are fed as devices report
    const { DeviceHistoryService } = require(path.join(dist, "reports/device-history.service.js"));
    const { AgentsService } = require(path.join(dist, "agents/agents.service.js"));
    const historySvc = app.get(DeviceHistoryService, { strict: false });
    const agentsSvc = app.get(AgentsService, { strict: false });
    const frontDevice = await prisma.devices.findFirst({ where: { hostname: "HAR-FRONT-01" }, include: { agents: true } });
    const todayDay = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const sampleBefore = await prisma.device_daily.findUnique({ where: { device_id_day: { device_id: frontDevice.id, day: todayDay } } });
    const written = await historySvc.sample();
    const sampleAfter = await prisma.device_daily.findUnique({ where: { device_id_day: { device_id: frontDevice.id, day: todayDay } } });
    check("a sample adds one to today's count for every device", written >= 10 && sampleAfter.samples === sampleBefore.samples + 1 && sampleAfter.online_samples >= sampleBefore.online_samples, [written, sampleBefore, sampleAfter]);
    check("it records the disk space from the device's facts", sampleAfter.disk_total_bytes > 0n && sampleAfter.disk_free_bytes > 0n && sampleAfter.disk_free_pct_min > 0);
    const changesBefore = await prisma.device_changes.count({ where: { device_id: frontDevice.id } });
    await agentsSvc.replaceSoftwareInventory(frontDevice.agents.id, [{ name: "Brand New Tool", version: "1.0" }, { name: "Another One", version: "2" }]);
    const afterSoftware = await prisma.device_changes.findMany({ where: { device_id: frontDevice.id }, orderBy: { changed_at: "desc" }, take: 40 });
    check("a changed software list is written to the change log as installs and removals", afterSoftware.filter((c) => c.summary === "Installed Brand New Tool 1.0").length === 1 && afterSoftware.some((c) => c.kind === "software_removed") && (await prisma.device_changes.count({ where: { device_id: frontDevice.id } })) > changesBefore + 2);
    const loggedBefore = await prisma.device_changes.count({ where: { device_id: frontDevice.id } });
    await agentsSvc.replaceSoftwareInventory(frontDevice.agents.id, [{ name: "Brand New Tool", version: "1.0" }, { name: "Another One", version: "2" }]);
    check("sending the same list again logs nothing", (await prisma.device_changes.count({ where: { device_id: frontDevice.id } })) === loggedBefore);
    const facts = frontDevice.agents.facts;
    const newDevice = JSON.parse(JSON.stringify(facts.device));
    newDevice.hardware.ramBytes = 32 * 1024 ** 3;
    await agentsSvc.updateFacts(frontDevice.agents.id, { facts: newDevice });
    check("more memory reported is written to the change log", !!(await prisma.device_changes.findFirst({ where: { device_id: frontDevice.id, kind: "hardware", summary: { contains: "Memory changed from 16 GB to 32 GB" } } })));
    const emptyAgent = await prisma.agents.create({ data: { device_id: (await prisma.devices.create({ data: { site_id: (await prisma.sites.findFirst({ where: { client_id: harbor.id } })).id, hostname: `DEMO-FRESH-${stamp}` } })).id, agent_uuid: crypto.randomUUID(), version: "1.3.26" } });
    await agentsSvc.replaceSoftwareInventory(emptyAgent.id, [{ name: "First Program", version: "1" }]);
    check("a device's first software list is a starting point, not a change", (await prisma.device_changes.count({ where: { device_id: emptyAgent.device_id } })) === 0);
    await agentsSvc.replaceSoftwareInventory(emptyAgent.id, [
        { name: "Bad Date App", installDate: "2024-13-45" },
        { name: "Zero Date App", installDate: "0000-00-00" },
        { name: "Good Date App", installDate: "2024-05-06" },
        { name: "User App", scope: "user", user: "PC\\bob", installedBy: "PC\\bob" },
        { name: "Machine App", scope: "machine", user: "PC\\ignored", installedBy: "PC\\admin" },
        { name: "Nul\u0000 App", publisher: "Pub\u0000lisher\u0001", version: "1.0\u0000", scope: "user", user: "PC\\a\u0000b", installedBy: "\uD800x" },
    ]);
    const swRows = Object.fromEntries((await prisma.agent_software.findMany({ where: { agent_id: emptyAgent.id } })).map((r) => [r.name, r]));
    check("an impossible install date is stored as unknown and never fails the whole software list", Object.keys(swRows).length === 6 && swRows["Bad Date App"].install_date === null && swRows["Zero Date App"].install_date === null && swRows["Good Date App"].install_date?.toISOString().startsWith("2024-05-06"), Object.keys(swRows));
    check("text with NUL or broken characters is cleaned instead of failing the whole list", swRows["Nul App"]?.publisher === "Publisher" && swRows["Nul App"].version === "1.0" && swRows["Nul App"].installed_user === "PC\\ab" && swRows["Nul App"].installed_by === "x", swRows["Nul App"]);
    check("a user-installed program keeps its owner, and a machine program keeps who installed it but not an owner", swRows["User App"].scope === "user" && swRows["User App"].installed_user === "PC\\bob" && swRows["User App"].installed_by === "PC\\bob" && swRows["Machine App"].scope === "machine" && swRows["Machine App"].installed_user === null && swRows["Machine App"].installed_by === "PC\\admin", [swRows["User App"], swRows["Machine App"]]);
    await agentsSvc.replaceSoftwareInventory(emptyAgent.id, [{ name: "Some App", version: "1" }], [{ account: "PC\\bob", loggedIn: true }, { account: "PC\\alice" }, { account: "PC\\bob", loggedIn: false }, { account: "" }, { account: "PC\\ca\u0000rol", loggedIn: true }]);
    const accounts = Object.fromEntries((await prisma.agent_user_accounts.findMany({ where: { agent_id: emptyAgent.id } })).map((r) => [r.account, r.logged_in]));
    check("the accounts a device reports are stored with whether each is signed in, cleaned and without duplicates", Object.keys(accounts).length === 3 && accounts["PC\\alice"] === false && accounts["PC\\carol"] === true && typeof accounts["PC\\bob"] === "boolean", accounts);
    await agentsSvc.replaceSoftwareInventory(emptyAgent.id, [{ name: "Some App", version: "1" }]);
    check("an agent that does not report accounts leaves the stored ones alone", (await prisma.agent_user_accounts.count({ where: { agent_id: emptyAgent.id } })) === 3);
    await agentsSvc.replaceSoftwareInventory(emptyAgent.id, [{ name: "Some App", version: "1" }], []);
    check("an empty list of accounts clears them", (await prisma.agent_user_accounts.count({ where: { agent_id: emptyAgent.id } })) === 0);
    await prisma.devices.delete({ where: { id: emptyAgent.device_id } });

    // the quarterly review and the bigger All report, on the demo data
    const { QBR_SECTIONS: qbrSections } = require(path.join(dist, "reports/full-report.service.js"));
    const qbr = await full.build({ clientId: harbor.id }, null, { kind: "qbr", sections: qbrSections, defaultDays: 90 });
    check("the review has its own sections, a quarter's period and a title naming the customer", qbr.kind === "qbr" && qbr.sections.map((s) => s.key).join() === qbrSections.join() && qbr.title === "Quarterly business review: Demo: Harbor Dental" && qbr.period.from === new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10), [qbr.title, qbr.period]);
    check("it says what needs attention, in sentences, worst first", qbr.recommendations.length >= 4 && qbr.recommendations.some((t) => /high-risk settings/.test(t)) && qbr.recommendations.every((t) => /\.$/.test(t)), qbr.recommendations);
    check("it says what was done", qbr.highlights.some((t) => /scripts and automations ran/.test(t)) && qbr.highlights.some((t) => /tickets were opened/.test(t)), qbr.highlights);
    const qbrTile = (label) => qbr.scorecard.find((t) => t.label === label);
    check("its cover shows the score, availability and what is due for replacement", !!qbrTile("Security score") && !!qbrTile("Availability") && !!qbrTile("Due for replacement") && !!qbrTile("Windows out of support") && !!qbrTile("High-risk settings") && Number(qbrTile("High-risk settings").value) >= 2, qbr.scorecard.map((t) => t.label));
    const qbrPdf = await full.pdfFile(qbr);
    const qbrXlsx = await full.xlsxFile(qbr);
    check("the review downloads as a PDF and a workbook with the right names", /^quarterly-review-.*\.pdf$/.test(qbrPdf.filename) && qbrPdf.data.subarray(0, 5).toString() === "%PDF-" && /^quarterly-review-.*\.xlsx$/.test(qbrXlsx.filename) && qbrXlsx.data.subarray(0, 2).toString() === "PK", [qbrPdf.filename, qbrXlsx.filename]);
    const bigFull = await full.build({ clientId: harbor.id });
    check("the All report now has all twenty-seven sections", bigFull.sections.length === 27 && bigFull.omitted.length === 0 && bigFull.recommendations.length >= 4, bigFull.sections.length);
    const bigPdf = await full.pdfFile(bigFull);
    check("and still makes a PDF without a blank last page", bigPdf.data.subarray(0, 5).toString() === "%PDF-" && (bigPdf.data.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length >= 26);
    const qbrEmailed = await full.build({ clientId: harbor.id }, EMAILED_PERMISSIONS, { kind: "qbr", sections: qbrSections, defaultDays: 90 });
    check("an emailed review leaves out tickets and technician activity and says so", qbrEmailed.omitted.map((o) => o.key).sort().join() === "technician-activity,ticket-sla" && qbrEmailed.omitted.every((o) => /not included in emailed/.test(o.reason)), qbrEmailed.omitted);
    await rejects("the review cannot be sent as CSV", () => sched({ reportKey: "quarterly-review", clientId: harbor.id, format: "csv" }), /PDF, an Excel workbook or both/);
    smtp.sendWithAttachment = async (purpose, to, subject, text, attachment) => {
        mailbox.push({ purpose, to, subject, text, attachments: Array.isArray(attachment) ? attachment : attachment ? [attachment] : [] });
        return mailResult;
    };
    const qbrSched = await sched({ reportKey: "quarterly-review", clientId: harbor.id, format: "both", frequency: "monthly", dayOfMonth: 1 });
    check("the review is listed by name", (await reports.listSchedules()).items.find((s) => s.id === qbrSched.id).title === "Quarterly business review");
    mailbox.length = 0;
    await reports.sendNow(qbrSched.id);
    check("it emails a PDF and a workbook, with what needs attention in the message", mailbox.length === 1 && mailbox[0].attachments.length === 2 && /^Quarterly business review: Demo: Harbor Dental/.test(mailbox[0].subject) && /What needs attention:/.test(mailbox[0].text) && /high-risk settings/.test(mailbox[0].text) && !/Technician activity:/.test(mailbox[0].text), [mailbox[0]?.subject, mailbox[0]?.text.slice(0, 400)]);
    const qbrRow = await prisma.report_schedules.findUnique({ where: { id: qbrSched.id } });
    check("a scheduled review covers a quarter, not the month", reports.inputFor({ client_id: harbor.id, report_key: "quarterly-review", frequency: "monthly", timezone: "UTC", config: qbrRow.config }, new Date()).from === new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
    await reports.deleteSchedule(qbrSched.id);
    smtp.sendWithAttachment = realSend;

    // company colour and logo on the cover
    const fsx = require("node:fs");
    const uploads = path.join(process.cwd(), "public", "uploads");
    fsx.mkdirSync(uploads, { recursive: true });
    const logoName = `test-logo-${stamp}.png`;
    // a 1x1 PNG
    fsx.writeFileSync(path.join(uploads, logoName), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const brandBefore = await prisma.branding_settings.findFirst();
    await prisma.branding_settings.upsert({ where: { id: brandBefore?.id ?? 1 }, create: { id: 1, primary_color: "#0a7d4f", logo_light_url: `http://x/static/uploads/${logoName}` }, update: { primary_color: "#0a7d4f", logo_light_url: `http://x/static/uploads/${logoName}` } });
    const branded = await full.pdfFile(qbr);
    check("a branded cover still makes a valid PDF, larger for the logo", branded.data.subarray(0, 5).toString() === "%PDF-" && branded.data.length > qbrPdf.data.length, [branded.data.length, qbrPdf.data.length]);
    await prisma.branding_settings.update({ where: { id: brandBefore?.id ?? 1 }, data: { primary_color: "not a colour", logo_light_url: "http://x/static/uploads/../../etc/passwd.png" } });
    const unbranded = await full.pdfFile(qbr);
    check("a bad colour and a logo outside the uploads folder are ignored, not fatal", unbranded.data.subarray(0, 5).toString() === "%PDF-");
    if (brandBefore) await prisma.branding_settings.update({ where: { id: brandBefore.id }, data: { primary_color: brandBefore.primary_color, logo_light_url: brandBefore.logo_light_url } });
    else await prisma.branding_settings.delete({ where: { id: 1 } });
    fsx.unlinkSync(path.join(uploads, logoName));

    // reports people designCfg themselves
    const { CustomReportsService, cleanCustomConfig } = require(path.join(dist, "reports/custom-reports.service.js"));
    const customSvc = app.get(CustomReportsService, { strict: false });
    const designCols = await customSvc.columnsFor("security-score");
    check("the builder can list a report's columns, without the internal ones", designCols.some((c) => c.key === "score") && !designCols.some((c) => c.internal) && designCols.every((c) => c.label), designCols.map((c) => c.key));
    await rejects("a report with no sections is refused", async () => cleanCustomConfig({ sections: [] }), /at least one section/);
    await rejects("an unknown report in a section is refused, by number", async () => cleanCustomConfig({ sections: [{ key: "nope" }] }), /Section 1 is not one of the reports/);
    await rejects("a limit that is not a number is refused", async () => cleanCustomConfig({ sections: [{ key: "stale-devices", params: { notSeenDays: "lots" } }] }), /must be a number/);
    await rejects("a row limit outside its range is refused", async () => cleanCustomConfig({ sections: [{ key: "stale-devices", maxRows: 0 }] }), /row limit/);
    await rejects("a title that is too long is refused", async () => cleanCustomConfig({ title: "x".repeat(121), sections: [{ key: "stale-devices" }] }), /at most 120/);
    await rejects("a number of days outside its range is refused", async () => cleanCustomConfig({ days: 0, sections: [{ key: "stale-devices" }] }), /days/);
    const cleanedCfg = cleanCustomConfig({ title: "T", sections: [{ key: "stale-devices", params: { notSeenDays: "45", junk: 1 }, charts: false, bogus: true }] });
    check("only what a designCfg may hold is kept", cleanedCfg.sections[0].params.notSeenDays === 45 && !("junk" in cleanedCfg.sections[0].params) && cleanedCfg.sections[0].charts === false && !("bogus" in cleanedCfg.sections[0]) && cleanedCfg.cover.scorecard === true, cleanedCfg);

    const designCfg = {
        title: "Monthly health pack",
        intro: "Prepared for the practice manager.",
        footer: "Confidential",
        cover: { scorecard: true, recommendations: false },
        days: 14,
        sections: [
            { key: "security-status", title: "Who is not protected", view: { filter: { match: "all", conditions: [{ field: "result", op: "eq", value: "Needs attention" }] }, columns: ["name", "antivirusState", "issues"] }, charts: false, maxRows: 3 },
            { key: "security-score", title: "Scores" },
            { key: "security-status", title: "Everyone" },
            { key: "alert-noise", title: "Alert noise" },
        ],
    };
    await rejects("a filter on a column that is not there is refused when saving, saying which section", () => customSvc.create(null, { name: `Bad ${stamp}`, config: { sections: [{ key: "security-status", view: { filter: { match: "all", conditions: [{ field: "nope", op: "eq", value: "x" }] } } }] } }), /Section 1.*does not exist/);
    await rejects("a report must have a name", () => customSvc.create(null, { name: "  ", config: designCfg }), /name/);
    const designed = await customSvc.create(null, { name: `Health pack ${stamp}`, description: "d", config: designCfg });
    check("a designed report is saved with its designCfg", designed.name === `Health pack ${stamp}` && designed.config.sections.length === 4 && designed.config.cover.recommendations === false && designed.config.days === 14, designed);
    await rejects("two reports cannot share a name, whatever the capitals", () => customSvc.create(null, { name: `HEALTH PACK ${stamp}`, config: designCfg }), /already exists/);
    check("it appears in the list with its section count", (await customSvc.list()).items.find((d) => d.id === designed.id).sections === 4);
    const designedRun = await customSvc.build(designed.id, { clientId: harbor.id }, new Set(["devices.read", "alerts.read"]));
    check("running it makes a report with the sections in the order designed and the titles chosen", designedRun.kind === "custom" && designedRun.sections.map((s) => s.title).join("|") === "Who is not protected|Scores|Everyone|Alert noise" && designedRun.title === "Monthly health pack: Demo: Harbor Dental", designedRun.sections.map((s) => s.title));
    check("the same report can be used twice with different views", designedRun.sections[0].key === "security-status" && designedRun.sections[2].key === "security-status" && designedRun.sections[0].rows.length < designedRun.sections[2].rows.length && designedRun.sections[0].rows.every((r) => r.result === "Needs attention"), [designedRun.sections[0].rows.length, designedRun.sections[2].rows.length]);
    check("the columns chosen for a section are kept", JSON.stringify(designedRun.sections[0].view.columns) === JSON.stringify(["name", "antivirusState", "issues"]));
    check("charts can be switched off for a section", designedRun.sections[0].charts.length === 0 && designedRun.sections[1].charts.length > 0);
    check("the cover text, footer and cover choices come through", designedRun.intro === "Prepared for the practice manager." && designedRun.footer === "Confidential" && designedRun.cover.scorecard === true && designedRun.cover.recommendations === false && designedRun.limits[0] === 3 && designedRun.limits[1] === undefined, [designedRun.intro, designedRun.footer, designedRun.cover, designedRun.limits]);
    check("its period is the number of days it was designed with", designedRun.period.from === new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10), designedRun.period);
    const readOnlyRun = await customSvc.build(designed.id, { clientId: harbor.id }, new Set(["devices.read"]));
    check("a section the reader may not see is left out and listed, whatever its title", readOnlyRun.sections.length === 3 && readOnlyRun.omitted.length === 1 && readOnlyRun.omitted[0].title === "Alert noise", readOnlyRun.omitted);
    const customPdf = await full.pdfFile(designedRun);
    const customXlsx = await full.xlsxFile(designedRun);
    check("it downloads as a PDF and a workbook named for the report", /^monthly-health-pack-.*\.pdf$/.test(customPdf.filename) && customPdf.data.subarray(0, 5).toString() === "%PDF-" && /^monthly-health-pack-.*\.xlsx$/.test(customXlsx.filename) && customXlsx.data.subarray(0, 2).toString() === "PK", [customPdf.filename, customXlsx.filename]);
    const oneSection = await customSvc.create(null, { name: `Single ${stamp}`, config: { sections: [{ key: "stale-devices", params: { notSeenDays: 5 } }] } });
    const singleRun = await customSvc.build(oneSection.id, { clientId: summit.id }, null);
    check("a report of one section works, with the limit it was given", singleRun.sections.length === 1 && singleRun.sections[0].params.notSeenDays === 5 && singleRun.title === `Single ${stamp}: Demo: Summit Law`, [singleRun.title, singleRun.sections[0].params]);
    const updatedDesign = await customSvc.update(oneSection.id, { name: `Single renamed ${stamp}`, config: { sections: [{ key: "stale-devices" }, { key: "network-map" }] } });
    check("a designCfg can be changed", updatedDesign.name === `Single renamed ${stamp}` && updatedDesign.config.sections.length === 2 && (await customSvc.get(oneSection.id)).config.sections.length === 2);
    await rejects("a report that is not there is a not-found", () => customSvc.get(crypto.randomUUID()), /does not exist/);

    smtp.sendWithAttachment = async (purpose, to, subject, text, attachment) => {
        mailbox.push({ purpose, to, subject, text, attachments: Array.isArray(attachment) ? attachment : attachment ? [attachment] : [] });
        return mailResult;
    };
    await rejects("a schedule for a designed report that does not exist is refused", () => sched({ reportKey: `custom:${crypto.randomUUID()}`, clientId: harbor.id }), /does not exist/);
    await rejects("a designed report is sent as a PDF, a workbook or both", () => sched({ reportKey: `custom:${designed.id}`, clientId: harbor.id, format: "csv" }), /PDF, an Excel workbook or both/);
    const customSched = await sched({ reportKey: `custom:${designed.id}`, clientId: harbor.id, format: "both" });
    check("a schedule for a designed report is listed by its name", (await reports.listSchedules()).items.find((s) => s.id === customSched.id).title === `Health pack ${stamp}`);
    mailbox.length = 0;
    await reports.sendNow(customSched.id);
    check("it emails a PDF and a workbook, leaving out what emailed copies never carry", mailbox.length === 1 && mailbox[0].attachments.length === 2 && /^Monthly health pack: Demo: Harbor Dental/.test(mailbox[0].subject), [mailbox[0]?.subject, mailbox[0]?.attachments.length]);
    // the delivery log
    const sentLog = await reports.listDeliveries(customSched.id);
    check("a send is written to the delivery log with its subject, files and recipients", sentLog.items.length === 1 && sentLog.items[0].ok === true && sentLog.items[0].trigger === "test" && sentLog.items[0].label === `Health pack ${stamp}` && /\.pdf, .*\.xlsx$/.test(sentLog.items[0].attachments) && /^Monthly health pack/.test(sentLog.items[0].subject) && sentLog.items[0].recipients === "boss@example.test, tech@example.test", sentLog.items);
    mailResult = { ok: false, result: "Mailbox is full" };
    await rejects("a send that fails says so", () => reports.sendNow(customSched.id), /Mailbox is full/);
    mailResult = { ok: true, result: "Sent" };
    const failedLog = (await reports.listDeliveries(customSched.id)).items;
    check("and the failure is in the log too, newest first", failedLog.length === 2 && failedLog[0].ok === false && failedLog[0].error === "Mailbox is full" && failedLog[1].ok === true, failedLog.map((d) => [d.ok, d.error]));
    const quietSched = await sched({ reportKey: "stale-devices", clientId: summit.id, config: { params: { notSeenDays: 730 } }, sendIfEmpty: false });
    await reports.sendNow(quietSched.id);
    const skippedLog = (await reports.listDeliveries(quietSched.id)).items;
    check("a send skipped because there was nothing to report is logged as that", skippedLog.length === 1 && skippedLog[0].ok === true && /Skipped/.test(skippedLog[0].result) && skippedLog[0].subject === null, skippedLog);
    const dueRow = await prisma.report_schedules.findUnique({ where: { id: customSched.id } });
    await reports.runSchedule(dueRow, new Date());
    check("a scheduled run is logged as scheduled", (await reports.listDeliveries(customSched.id)).items[0].trigger === "scheduled");
    check("the log of everything includes them", (await reports.listDeliveries(undefined, 200)).items.filter((d) => d.scheduleId === customSched.id || d.scheduleId === quietSched.id).length >= 4);
    await reports.deleteSchedule(quietSched.id);
    check("the log is kept after the schedule is gone", (await reports.listDeliveries(quietSched.id)).items.length === 1);
    await prisma.report_deliveries.deleteMany({ where: { schedule_id: { in: [customSched.id, quietSched.id] } } });

    smtp.sendWithAttachment = realSend;
    await customSvc.remove(designed.id);
    check("removing a designed report removes its schedules too", !(await prisma.report_schedules.findUnique({ where: { id: customSched.id } })) && !(await prisma.custom_reports.findUnique({ where: { id: designed.id } })));
    await customSvc.remove(oneSection.id);

    // software policies saved per customer
    const { SoftwarePoliciesService } = require(path.join(dist, "reports/software-policies.service.js"));
    const polSvc = app.get(SoftwarePoliciesService, { strict: false });
    const demoPolicies = await polSvc.list(harbor.id);
    check("the demo has policies for Harbor and for everyone, and not Summit's", demoPolicies.items.length === 4 && demoPolicies.items.some((p) => p.clientId === null && p.pattern === "Adobe Flash") && demoPolicies.items.some((p) => p.customer === "Demo: Harbor Dental" && p.pattern === "Dentrix") && !demoPolicies.items.some((p) => p.pattern === "Clio Manage"), demoPolicies.items.map((p) => [p.customer, p.kind, p.pattern]));
    const byPolicy = await endpoint.run("software-compliance", { clientId: harbor.id });
    check("with nothing typed, the report uses the customer's saved policies", byPolicy.params.required === "saved policies" && byPolicy.rows.some((r) => /Dentrix|Windows Defender/.test(r.missingRequired)) && byPolicy.rows.every((r) => !/Clio/.test(r.missingRequired)), byPolicy.rows.map((r) => r.missingRequired));
    const bySummit = await endpoint.run("software-compliance", { clientId: summit.id });
    check("another customer gets its own policies, plus the ones for everyone", bySummit.rows.every((r) => !/Dentrix/.test(r.missingRequired)) && bySummit.rows.some((r) => /Clio/.test(r.missingRequired)) || bySummit.rows.every((r) => r.result !== "Non-compliant" || r.issues.length > 0), bySummit.rows.map((r) => r.issues));
    const typedOverrides = await endpoint.run("software-compliance", { clientId: harbor.id, required: "none", banned: "none" });
    check("typing none switches the saved policies off", typedOverrides.rows.every((r) => r.result === "Compliant") && typedOverrides.params.required === "none", typedOverrides.params);
    const oneSide = await endpoint.run("software-compliance", { clientId: harbor.id, required: "Zzz Not A Program" });
    check("a typed list replaces only its own side", oneSide.rows.every((r) => r.missingRequired === "Zzz Not A Program") && oneSide.params.banned === "saved policies", oneSide.params);
    const newPolicy = await polSvc.create({ clientId: harbor.id, kind: "required", pattern: "Zzz Policy Test" });
    check("a new policy applies at once", (await endpoint.run("software-compliance", { clientId: harbor.id })).rows.every((r) => /Zzz Policy Test/.test(r.missingRequired)));
    await rejects("the same policy cannot be added twice", () => polSvc.create({ clientId: harbor.id, kind: "required", pattern: "zzz policy TEST" }), /already exists/);
    await rejects("a policy needs a name for the software", () => polSvc.create({ kind: "banned", pattern: "   " }), /Enter the name/);
    await rejects("a policy is required or banned", () => polSvc.create({ kind: "maybe", pattern: "x" }), /required or banned/);
    await rejects("a policy for a customer that is not there is refused", () => polSvc.create({ clientId: crypto.randomUUID(), kind: "banned", pattern: "x" }), /does not exist/);
    await polSvc.remove(newPolicy.id);
    check("removing it stops it applying", (await endpoint.run("software-compliance", { clientId: harbor.id })).rows.every((r) => !/Zzz Policy Test/.test(r.missingRequired)));
    await rejects("removing one that is not there is a not-found", () => polSvc.remove(crypto.randomUUID()), /does not exist/);

    // business hours
    const { ReportSettingsService } = require(path.join(dist, "reports/report-settings.service.js"));
    const settingsSvc = app.get(ReportSettingsService, { strict: false });
    const hoursBefore = await prisma.report_settings.findMany();
    check("business hours default to Monday to Friday, 8 to 6, UTC", JSON.stringify(await settingsSvc.getBusinessHours()) === JSON.stringify({ days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", timezone: "UTC" }) || hoursBefore.length > 0);
    await rejects("business hours need a working day", () => settingsSvc.setBusinessHours({ days: [], start: "08:00", end: "18:00", timezone: "UTC" }), /working day/);
    await rejects("and times that look like times", () => settingsSvc.setBusinessHours({ days: [1], start: "8am", end: "18:00", timezone: "UTC" }), /08:00/);
    await rejects("and a real time zone", () => settingsSvc.setBusinessHours({ days: [1], start: "08:00", end: "18:00", timezone: "Mars/Base" }), /time zone/);
    const savedHours = await settingsSvc.setBusinessHours({ days: [5, 1, 3, 1], start: "07:30", end: "16:00", timezone: "America/Chicago" });
    check("they are saved, sorted and without repeats", JSON.stringify(savedHours) === JSON.stringify({ days: [1, 3, 5], start: "07:30", end: "16:00", timezone: "America/Chicago" }), savedHours);
    const availAll = await endpoint.run("availability", { clientId: harbor.id, ...span45 });
    const availBusiness = await endpoint.run("availability", { clientId: harbor.id, ...span45, businessHoursOnly: "yes" });
    const allOf = (n) => availAll.rows.find((r) => r.name === n);
    const bizOf = (n) => availBusiness.rows.find((r) => r.name === n);
    check("measured in business hours, weekends and nights drop out, so fewer days are covered", bizOf("HAR-LAPTOP-04").daysCovered < allOf("HAR-LAPTOP-04").daysCovered && bizOf("HAR-LAPTOP-04").daysCovered >= 20, [bizOf("HAR-LAPTOP-04").daysCovered, allOf("HAR-LAPTOP-04").daysCovered]);
    check("a machine that is off outside work looks much better in business hours", bizOf("HAR-LAPTOP-04").availability > allOf("HAR-LAPTOP-04").availability + 10, [bizOf("HAR-LAPTOP-04").availability, allOf("HAR-LAPTOP-04").availability]);
    check("and the report says it was measured that way", availBusiness.params.businessHoursOnly === "yes" && /working day/.test(availBusiness.notes.join(" ")) && !availAll.params.businessHoursOnly);
    // the sampler marks checks made inside the working day
    await settingsSvc.setBusinessHours({ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00", timezone: "UTC" });
    const bizDevice = await prisma.devices.findFirst({ where: { hostname: "HAR-SRV-01" } });
    const todayBiz = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const bizBefore = await prisma.device_daily.findUnique({ where: { device_id_day: { device_id: bizDevice.id, day: todayBiz } } });
    await historySvc.sample();
    const bizAfter = await prisma.device_daily.findUnique({ where: { device_id_day: { device_id: bizDevice.id, day: todayBiz } } });
    check("a check made during the working day counts toward the business-hours totals", bizAfter.business_samples === bizBefore.business_samples + 1, [bizBefore.business_samples, bizAfter.business_samples]);
    await settingsSvc.setBusinessHours({ days: [1], start: "03:00", end: "03:01", timezone: "UTC" });
    const bizBefore2 = await prisma.device_daily.findUnique({ where: { device_id_day: { device_id: bizDevice.id, day: todayBiz } } });
    await historySvc.sample();
    const bizAfter2 = await prisma.device_daily.findUnique({ where: { device_id_day: { device_id: bizDevice.id, day: todayBiz } } });
    check("one made outside it does not", bizAfter2.business_samples === bizBefore2.business_samples && bizAfter2.samples === bizBefore2.samples + 1);
    await prisma.report_settings.deleteMany({});
    if (hoursBefore.length) await prisma.report_settings.createMany({ data: hoursBefore });

    // a customer's own look for its reports
    const { ClientBrandingService } = require(path.join(dist, "reports/client-branding.service.js"));
    const cbSvc = app.get(ClientBrandingService, { strict: false });
    const plainBrand = await cbSvc.get(harbor.id);
    check("a customer starts with nothing of its own", plainBrand.primaryColor === null && plainBrand.logoFile === null && plainBrand.coverText === null && plainBrand.customer === "Demo: Harbor Dental", plainBrand);
    await rejects("a colour must look like a colour", () => cbSvc.set(harbor.id, { primaryColor: "blue" }), /#1a73e8/);
    await rejects("a cover note has a length limit", () => cbSvc.set(harbor.id, { coverText: "x".repeat(1501) }), /1500/);
    await rejects("so does the footer", () => cbSvc.set(harbor.id, { footerText: "x".repeat(161) }), /160/);
    await rejects("a customer that is not there is a not-found", () => cbSvc.get(crypto.randomUUID()), /does not exist/);
    await cbSvc.set(harbor.id, { primaryColor: "#7a1fa2", coverText: "Thank you for choosing Harbor Dental's IT partner.", footerText: "Harbor Dental, confidential" });
    const harborRun = await full.build({ clientId: harbor.id }, null, { kind: "qbr", sections: qbrSections, intro: "From the design", footer: "Design footer" });
    check("the customer's note follows the design's cover text and its footer wins", harborRun.intro === "From the design\n\nThank you for choosing Harbor Dental's IT partner." && harborRun.footer === "Harbor Dental, confidential" && harborRun.clientId === harbor.id, [harborRun.intro, harborRun.footer]);
    const summitRun = await full.build({ clientId: summit.id }, null, { kind: "qbr", sections: qbrSections, intro: "From the design", footer: "Design footer" });
    check("another customer gets the design's own text, not Harbor's", summitRun.intro === "From the design" && summitRun.footer === "Design footer" && summitRun.clientId === summit.id, [summitRun.intro, summitRun.footer]);
    const siteOfHarbor = await prisma.sites.findFirst({ where: { client_id: harbor.id } });
    const bySite = await full.build({ siteId: siteOfHarbor.id }, null, { kind: "qbr", sections: ["hardware-age"] });
    const byDevice = await full.build({ deviceId: (await prisma.devices.findFirst({ where: { hostname: "HAR-FRONT-01" } })).id }, null, { kind: "qbr", sections: ["hardware-age"] });
    check("a site or a device finds its customer, so the note applies there too", bySite.clientId === harbor.id && byDevice.clientId === harbor.id && /Thank you for choosing/.test(bySite.intro) && /Thank you for choosing/.test(byDevice.intro));
    const everyone = await full.build({}, null, { kind: "qbr", sections: ["hardware-age"] });
    check("a report for everyone has no customer's note", everyone.clientId === null && !/Thank you/.test(everyone.intro ?? ""));
    const fsBrand = require("node:fs");
    const upDir = path.join(process.cwd(), "public", "uploads");
    fsBrand.mkdirSync(upDir, { recursive: true });
    const clientLogo = `client-logo-${harbor.id}-test.png`;
    fsBrand.writeFileSync(path.join(upDir, clientLogo), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const withLogo = await cbSvc.setLogo(harbor.id, clientLogo);
    check("a logo can be set, and is served from the uploads folder", withLogo.logoFile === clientLogo && withLogo.logoUrl === `/static/uploads/${clientLogo}`, withLogo);
    const brandedClientPdf = await full.pdfFile(harborRun);
    const afterRemoval = await cbSvc.removeLogo(harbor.id);
    const unbrandedClientPdf = await full.pdfFile(harborRun);
    check("the customer's PDF carries its own logo, so it is larger than the same PDF without it", brandedClientPdf.data.subarray(0, 5).toString() === "%PDF-" && brandedClientPdf.data.length > unbrandedClientPdf.data.length, [brandedClientPdf.data.length, unbrandedClientPdf.data.length]);
    check("removing the logo deletes the file", afterRemoval.logoFile === null && !fsBrand.existsSync(path.join(upDir, clientLogo)));
    await cbSvc.set(harbor.id, {});
    const cleared = await cbSvc.get(harbor.id);
    check("saving with nothing in it clears the customer's settings", cleared.primaryColor === null && cleared.coverText === null && cleared.footerText === null, cleared);
    await prisma.client_report_settings.deleteMany({ where: { client_id: { in: [harbor.id, summit.id] } } });

    // who took a copy of a report
    const { ReportsController } = require(path.join(dist, "reports/reports.controller.js"));
    const controllerSvc = app.get(ReportsController, { strict: false });
    const fakeRes = () => { const r = { headers: {}, body: null, setHeader(k, v) { r.headers[k] = v; }, send(b) { r.body = b; }, json(b) { r.body = b; } }; return r; };
    const fakeReq = { user: { id: crypto.randomUUID(), email: "auditor@example.test" }, headers: {}, socket: {} };
    const auditCount = () => prisma.audit_events.count({ where: { action: "report.download", actor_email: "auditor@example.test" } });
    const auditBefore = await auditCount();
    await controllerSvc.runDevices("hardware-inventory", { clientId: harbor.id, format: "csv" }, fakeRes(), fakeReq);
    await controllerSvc.fullReport({ clientId: harbor.id, format: "xlsx" }, fakeReq, fakeRes());
    await controllerSvc.quarterlyReview({ clientId: harbor.id, format: "pdf" }, fakeReq, fakeRes());
    await new Promise((resolve) => setTimeout(resolve, 400));
    const audited = await prisma.audit_events.findMany({ where: { action: "report.download", actor_email: "auditor@example.test" }, orderBy: { created_at: "desc" }, take: 5 });
    check("downloads of a report, the All report and the review are written to the audit log with who and what", (await auditCount()) === auditBefore + 3 && audited.some((e) => e.target_label === "hardware-inventory" && e.details.format === "csv" && e.details.clientId === harbor.id) && audited.some((e) => /^Full report/.test(e.target_label) && e.details.format === "xlsx") && audited.some((e) => /^Quarterly business review/.test(e.target_label)), audited.map((e) => [e.target_label, e.details]));
    await controllerSvc.fullReport({ clientId: harbor.id, format: "summary" }, fakeReq, fakeRes());
    await new Promise((resolve) => setTimeout(resolve, 200));
    check("looking at one on screen is not recorded as a download", (await auditCount()) === auditBefore + 3);
    await prisma.audit_events.deleteMany({ where: { action: "report.download", actor_email: "auditor@example.test" } });

    // people limited to some customers
    const { ClientAccessService } = require(path.join(dist, "reports/client-access.service.js"));
    const accessSvc = app.get(ClientAccessService, { strict: false });
    const limitedUser = await prisma.users.create({ data: { organization_id: org.id, email: `limited-${stamp}@example.test`, password_hash: "x", first_name: "Lim", last_name: "Ited" } });
    check("someone with no entries may see every customer", (await accessSvc.allowedFor(limitedUser.id)) === null && (await accessSvc.allowedFor(null)) === null);
    await rejects("a customer that is not there cannot be given", () => accessSvc.set(limitedUser.id, [crypto.randomUUID()]), /does not exist/);
    await rejects("nor can a person who is not there", () => accessSvc.set(crypto.randomUUID(), [harbor.id]), /does not exist/);
    await accessSvc.set(limitedUser.id, [harbor.id, harbor.id]);
    check("a list can be set, without repeats", JSON.stringify(await accessSvc.allowedFor(limitedUser.id)) === JSON.stringify([harbor.id]));
    const accessList = await accessSvc.list();
    check("the admin list shows each person with their customers", accessList.users.find((u) => u.id === limitedUser.id).clientIds.join() === harbor.id && accessList.customers.some((c) => c.id === harbor.id));
    const limit = [harbor.id];
    const hwLimited = await endpoint.run("hardware-inventory", { restrictClientIds: limit });
    check("with no customer chosen, a limited person's report holds only their customers", hwLimited.rows.length > 0 && hwLimited.rows.every((r) => r.customer === "Demo: Harbor Dental"), [...new Set(hwLimited.rows.map((r) => r.customer))]);
    await rejects("asking for another customer is refused", () => endpoint.run("hardware-inventory", { clientId: summit.id, restrictClientIds: limit }), /do not have access/);
    await rejects("so is asking for another customer's device", async () => endpoint.run("hardware-inventory", { deviceId: (await prisma.devices.findFirst({ where: { hostname: "SUM-FILE-01" } })).id, restrictClientIds: limit }), /does not exist|do not have access/);
    for (const key of ["software-inventory", "device-health", "security-score", "patch-speed", "change-log", "availability", "stale-devices", "network-map", "software-compliance"]) {
        const limitedRun = await endpoint.run(key, { restrictClientIds: limit });
        const names = [...new Set(limitedRun.rows.map((r) => r.customer).filter(Boolean))];
        check(`${key} holds only their customers' rows`, names.every((n) => n === "Demo: Harbor Dental"), names);
    }
    const renewalsLimited = await endpoint.run("renewals", { restrictClientIds: limit, withinDays: 730 });
    check("renewals leaves out other customers' contracts and warranties", renewalsLimited.rows.length > 0 && renewalsLimited.rows.every((r) => r.customer === "Demo: Harbor Dental"), [...new Set(renewalsLimited.rows.map((r) => r.customer))]);
    const ticketsLimited = await endpoint.run("ticket-sla", { restrictClientIds: limit, ...span45 });
    check("tickets are only those for their customers' devices", ticketsLimited.rows.length > 0 && ticketsLimited.rows.every((r) => r.customer === "Demo: Harbor Dental"), [...new Set(ticketsLimited.rows.map((r) => r.customer))]);
    const sessionsLimited = await endpoint.run("remote-sessions", { restrictClientIds: limit, ...span45 });
    check("remote sessions are only for their customers' devices", sessionsLimited.rows.every((r) => String(r.device).startsWith("HAR-")), sessionsLimited.rows.map((r) => r.device));
    const alertsLimited = await endpoint.run("alert-history", { restrictClientIds: limit, ...span45 });
    check("alerts are only for their customers' devices", alertsLimited.rows.every((r) => r.customer === "Demo: Harbor Dental"), [...new Set(alertsLimited.rows.map((r) => r.customer))]);
    const everyoneRun = await endpoint.run("hardware-inventory", {});
    check("someone with no limit still sees everyone", everyoneRun.rows.some((r) => r.customer === "Demo: Summit Law") && everyoneRun.rows.length > hwLimited.rows.length);
    const limitedFull = await full.build({}, null, { restrictClientIds: limit });
    check("the All report for a limited person holds only their customers, in every section", limitedFull.sections.every((s) => s.rows.every((r) => !r.customer || r.customer === "Demo: Harbor Dental")) && limitedFull.scorecard.find((t) => t.label === "Devices").value === "5", [limitedFull.scorecard.find((t) => t.label === "Devices")]);

    // and the same through the controller, as that person
    const limitedReq = { user: { id: limitedUser.id, email: limitedUser.email }, headers: {}, socket: {} };
    const jsonRes = fakeRes();
    await controllerSvc.fullReport({ format: "json" }, limitedReq, jsonRes);
    check("the All report route holds only their customers", jsonRes.body.sections.find((s) => s.key === "hardware-inventory").rows.every((r) => r.customer === "Demo: Harbor Dental"));
    await rejects("a report route refuses another customer", () => controllerSvc.runDevices("hardware-inventory", { clientId: summit.id }, fakeRes(), limitedReq), /do not have access/);
    await rejects("the customer summary refuses another customer", () => controllerSvc.health({ clientId: summit.id, from: span45.from, to: span45.to }, limitedReq), /do not have access/);
    await rejects("a schedule for another customer is refused", () => controllerSvc.create({ reportKey: "security-status", clientId: summit.id, frequency: "daily", recipients: ["a@example.test"] }, limitedReq), /do not have access/);
    await rejects("and so is one with no customer at all", () => controllerSvc.create({ reportKey: "security-status", frequency: "daily", recipients: ["a@example.test"] }, limitedReq), /do not have access/);
    const mineSched = await reports.createSchedule({ reportKey: "security-status", clientId: harbor.id, frequency: "daily", recipients: ["a@example.test"] });
    const theirSched = await reports.createSchedule({ reportKey: "security-status", clientId: summit.id, frequency: "daily", recipients: ["a@example.test"] });
    const scheduleList = await controllerSvc.schedules(limitedReq);
    check("the schedule list shows only their customers'", scheduleList.items.some((s) => s.id === mineSched.id) && !scheduleList.items.some((s) => s.id === theirSched.id));
    await rejects("another customer's schedule cannot be changed, run or removed", async () => { await controllerSvc.update(theirSched.id, { frequency: "daily", recipients: ["a@example.test"] }, limitedReq); }, /do not have access/);
    await rejects("run now is refused too", () => controllerSvc.sendNow(theirSched.id, limitedReq), /do not have access/);
    await rejects("removal is refused", () => controllerSvc.remove(theirSched.id, limitedReq), /do not have access/);
    await rejects("and its delivery log", () => controllerSvc.scheduleDeliveries(theirSched.id, limitedReq), /do not have access/);
    check("their own schedule's log is open to them", Array.isArray((await controllerSvc.scheduleDeliveries(mineSched.id, limitedReq)).items));
    const polLimited = await controllerSvc.listPolicies({}, limitedReq);
    check("policies listed for them hold no other customer's", polLimited.items.every((p) => p.clientId === null || p.clientId === harbor.id), polLimited.items.map((p) => p.customer));
    await reports.deleteSchedule(mineSched.id);
    await reports.deleteSchedule(theirSched.id);
    await accessSvc.set(limitedUser.id, []);
    check("clearing the list gives back every customer", (await accessSvc.allowedFor(limitedUser.id)) === null);
    await prisma.users.delete({ where: { id: limitedUser.id } });

    // antivirus threats
    const threatsH = await endpoint.run("antivirus-threats", { clientId: harbor.id, ...span45 });
    check("the threats report lists detections with device, threat, severity, status and where", threatsH.rows.length === 3 && threatsH.rows.every((r) => r.threat && r.severity && r.status && r.resource), threatsH.rows.map((r) => [r.device, r.threat, r.status]));
    check("active and failed ones come first", threatsH.rows[0].status === "Active" && threatsH.rows[1].status === "Failed to clean" && threatsH.rows[2].status === "Cleaned", threatsH.rows.map((r) => r.status));
    check("severity and the counts are right", threatsH.rows[0].severity === "Severe" && threatsH.summary.find((s) => s.label === "Still active").value === 1 && threatsH.summary.find((s) => s.label === "Failed to clean").value === 1 && threatsH.summary.find((s) => s.label === "Devices affected").value === 2 && threatsH.summary.find((s) => s.label === "Severe or high").value === 1);
    check("it says how many devices reported threat data", /5 of 5 devices have reported/.test(threatsH.notes.join(" ")), threatsH.notes);
    const threatsS = await endpoint.run("antivirus-threats", { clientId: summit.id, ...span45 });
    check("a device with no threat data is counted as not reporting, not as clean", threatsS.summary.find((s) => s.label === "Not reporting").value === 1 && /4 of 5 devices have reported/.test(threatsS.notes.join(" ")) && threatsS.rows.every((r) => r.device !== "SUM-REMOTE-04"), threatsS.notes);
    check("detections outside the period are left out", (await endpoint.run("antivirus-threats", { clientId: harbor.id, from: span45.to, to: span45.to })).rows.length === 0);
    check("the review mentions an active threat first", (await full.build({ clientId: harbor.id }, null, { kind: "qbr", sections: qbrSections })).recommendations[0].includes("still active or could not be cleaned"));

    // turning it off removes all of it, and only it
    const offRun = await demo.disable();
    const rowsAfter = {
        devices: await prisma.devices.count(), clients: await prisma.clients.count(), tickets: await prisma.tickets.count(),
        audit: await prisma.audit_events.count(), assets: await prisma.assets.count(), contracts: await prisma.contracts.count(), sites: await prisma.sites.count(),
    };
    check("turning it offRun deletes all of it and leaves everything else alone", offRun.enabled === false && JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore), [rowsBefore, rowsAfter]);
    check("nothing is recorded as demo afterwards", (await prisma.demo_records.count()) === 0 && (await prisma.agent_software.count({ where: { agents: { hostname: { startsWith: "HAR-" } } } })) === 0);
    check("turning it offRun again is harmless", (await demo.disable()).enabled === false);

    // the All report
    const everything = await full.build({ clientId: client.id });
    check("the All report has every section, in order, and omits none", everything.sections.map((s) => s.key).join() === FULL_SECTIONS.join() && everything.omitted.length === 0, everything.sections.map((s) => s.key));
    const tile = (r, label) => r.scorecard.find((t) => t.label === label);
    check("its cover counts this customer's two managed devices, not the other customer's", tile(everything, "Devices").value === "2" && tile(everything, "Devices").detail === "1 online now", tile(everything, "Devices"));
    check("it is titled for the customer and the scope names it", everything.title === `Full report: Zeta ${stamp}` && everything.scope.customer === `Zeta ${stamp}` && everything.scope.device === null, everything.scope);
    const oneDevice = await full.build({ deviceId: device.id });
    check("one device's report covers only that device in every section", tile(oneDevice, "Devices").value === "1" && oneDevice.sections.filter((s) => ["hardware-inventory", "hardware-age", "windows-support", "device-health", "security-status", "security-score", "risky-configuration", "patch-compliance", "software-compliance"].includes(s.key)).every((s) => s.rows.length === 1) && oneDevice.title === `Full report: Z-${stamp}`, oneDevice.sections.map((s) => [s.key, s.rows.length]));
    await rejects("a device from nowhere is refused", () => full.build({ deviceId: crypto.randomUUID() }), /does not exist/);
    const siteOnly = await full.build({ siteId: otherSite.id });
    check("a site's report covers its own devices", tile(siteOnly, "Devices").value === "1" && siteOnly.scope.site === "Main", siteOnly.scope);

    // who may read what
    const limited = await full.build({ clientId: client.id }, new Set(["devices.read"]));
    check("without the alerts and audit rights those sections are left out and listed", !limited.sections.some((s) => ["alert-history", "alert-noise", "remote-sessions", "technician-activity", "ticket-sla"].includes(s.key)) && limited.omitted.map((o) => o.key).sort().join() === "alert-history,alert-noise,remote-sessions,technician-activity,ticket-sla" && !tile(limited, "Alerts in the period") && !tile(limited, "Remote sessions"), limited.omitted);
    const emailed = await full.build({ clientId: client.id }, EMAILED_PERMISSIONS);
    check("an emailed copy never carries remote sessions but does carry alerts", emailed.omitted.map((o) => o.key).sort().join() === "remote-sessions,technician-activity,ticket-sla" && /not included in emailed/.test(emailed.omitted[0].reason) && emailed.sections.some((s) => s.key === "alert-history"), emailed.omitted);

    // the files
    const pdfFile = await full.pdfFile(everything);
    const pageCount = (pdfFile.data.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    check("the PDF is a PDF with a cover and a page per section at least", pdfFile.data.subarray(0, 5).toString() === "%PDF-" && pageCount >= 2 && /\.pdf$/.test(pdfFile.filename), [pageCount, pdfFile.filename]);
    const xlsxFile = await full.xlsxFile(everything);
    const names = xlsxFile.data.toString("latin1");
    check("the workbook is a zip with a summary sheet and a sheet per section", xlsxFile.data.subarray(0, 2).toString() === "PK" && /\.xlsx$/.test(xlsxFile.filename) && names.includes("xl/workbook.xml") && (names.match(/xl\/worksheets\/sheet\d+\.xml/g) || []).length >= FULL_SECTIONS.length + 1, xlsxFile.filename);
    const fullSummary = full.summarise(everything);
    check("the summary carries the scorecard and each section's row count", Array.isArray(fullSummary.scorecard) && fullSummary.sections.length === FULL_SECTIONS.length, Object.keys(fullSummary));

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
