// The report routes over real HTTP: what a request may contain, what comes back, and in which format.
// The reports module runs on its own, so the sign-in and permission guards are not under test here (the
// security-lockdown flow covers those). This covers the routes, the query checks and the downloads.
"use strict";

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

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { ReportsModule } = require(path.join(dist, "reports/reports.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.create(ReportsModule, { logger: ["error"] });
    await app.listen(0, "127.0.0.1");
    const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Http ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
    const device = await prisma.devices.create({ data: { site_id: site.id, hostname: `H-${stamp}` } });
    await prisma.agents.create({
        data: { device_id: device.id, agent_uuid: crypto.randomUUID(), version: "1.0.0", last_check_in_at: new Date(), facts: { os: "windows", device: { hardware: { model: "Dell", ram: "8 GB", ramBytes: 8 * 1024 ** 3 } } } },
    });

    const get = (p) => fetch(`${base}${p}`);

    // ---- the catalogue
    let res = await get("/api/reports/catalog");
    let body = await res.json();
    check("the catalogue is served", res.status === 200 && body.items.length === 32, res.status);
    // The Reports page sends every report to this one route. All of them must run, not just the first eight.
    for (const def of body.items.filter((d) => d.key !== "alert-history" && d.key !== "remote-sessions")) {
        const r = await get(`/api/reports/run/${def.key}`);
        check(`the ${def.key} report runs from the Reports page route`, r.status === 200, `${r.status} ${r.status === 200 ? "" : await r.clone().text()}`);
    }

    // ---- each report, as data, CSV and PDF
    res = await get(`/api/reports/run/hardware-inventory?clientId=${client.id}`);
    body = await res.json();
    check("a report comes back as JSON by default", res.status === 200 && /json/.test(res.headers.get("content-type")) && body.rows.length === 1 && body.rows[0].model === "Dell", body);
    check("it says what it covers", body.scope.customer === `Http ${stamp}` && !!body.generatedAt, body.scope);

    res = await get(`/api/reports/run/hardware-inventory?clientId=${client.id}&format=csv`);
    check("CSV downloads with a name and the right type", res.status === 200 && /text\/csv/.test(res.headers.get("content-type")) && /attachment; filename="hardware-inventory-\d{4}-\d{2}-\d{2}\.csv"/.test(res.headers.get("content-disposition")), res.headers.get("content-disposition"));
    // The raw bytes, because decoding to text drops a leading byte order mark.
    const csvBytes = Buffer.from(await res.arrayBuffer());
    check("the CSV starts with a byte order mark, and has the device", csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf && csvBytes.toString("utf8").includes(`H-${stamp}`), [...csvBytes.subarray(0, 4)]);

    res = await get(`/api/reports/run/device-health?clientId=${client.id}&format=pdf`);
    const pdf = Buffer.from(await res.arrayBuffer());
    check("PDF downloads", res.status === 200 && /application\/pdf/.test(res.headers.get("content-type")) && pdf.subarray(0, 5).toString() === "%PDF-" && /device-health/.test(res.headers.get("content-disposition")), res.headers.get("content-disposition"));

    res = await get(`/api/reports/run/device-health?clientId=${client.id}&offlineDays=3&minDiskFreePercent=20&minRamGb=16`);
    body = await res.json();
    check("limits arrive as numbers", res.status === 200 && body.params.offlineDays === 3 && body.params.minDiskFreePercent === 20 && body.params.minRamGb === 16 && /Low memory: 8 GB/.test(body.rows[0].issues), body.params);

    res = await get("/api/reports/alert-history?from=2020-01-01&to=2030-01-01");
    check("alert history has its own route", res.status === 200 && (await res.json()).key === "alert-history", res.status);
    res = await get("/api/reports/remote-sessions?from=2020-01-01&to=2030-01-01&format=csv");
    check("remote sessions export as CSV", res.status === 200 && /text\/csv/.test(res.headers.get("content-type")), res.status);

    // ---- a view: filter, sort, group and columns, in the address
    const onlineView = encodeURIComponent(JSON.stringify({ filter: { match: "all", conditions: [{ field: "status", op: "eq", value: "Online" }] }, groupBy: "customer", sort: [{ key: "name", dir: "desc" }] }));
    res = await get(`/api/reports/run/hardware-inventory?clientId=${client.id}&view=${onlineView}`);
    body = await res.json();
    check("a view in the address filters and groups", res.status === 200 && body.matchedRows === 1 && body.groups.length === 1 && body.view.groupBy === "customer", { status: res.status, matched: body.matchedRows });
    check("the answer includes charts", Array.isArray(body.charts) && body.charts.length >= 5, body.charts && body.charts.length);
    const colView = encodeURIComponent(JSON.stringify({ columns: ["name", "model"] }));
    res = await get(`/api/reports/run/hardware-inventory?clientId=${client.id}&format=csv&view=${colView}`);
    const colText = Buffer.from(await res.arrayBuffer()).toString("utf8").replace(/^﻿/, "");
    check("a view picks the CSV columns", colText.split("\r\n")[0] === "Device,Model", colText.split("\r\n")[0]);
    res = await get(`/api/reports/run/hardware-inventory?format=pdf&view=${onlineView}`);
    check("a view applies to the PDF too", res.status === 200 && Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString() === "%PDF-");
    for (const [name, bad] of [["not JSON", "{nope"], ["an unknown column", JSON.stringify({ groupBy: "nope" })], ["a bad operator", JSON.stringify({ filter: { match: "all", conditions: [{ field: "name", op: "gt", value: 1 }] } })]]) {
        res = await get(`/api/reports/run/hardware-inventory?view=${encodeURIComponent(bad)}`);
        check(`a view that is ${name} is refused`, res.status === 400, res.status);
    }
    res = await get(`/api/reports/run/hardware-inventory?view=${"x".repeat(8001)}`);
    check("a view that is far too long is refused", res.status === 400, res.status);

    // ---- saved views over HTTP (the module runs without sign-in, so there is no owner to change them)
    const send = (p, b, method = "POST") => fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    res = await send("/api/reports/views", { reportKey: "device-health", name: `Http view ${stamp}`, config: { days: 7 } });
    const saved = await res.json();
    check("a view can be saved", res.status === 201 && saved.name === `Http view ${stamp}` && saved.mine === false, { status: res.status, saved });
    res = await get("/api/reports/views?report=device-health");
    body = await res.json();
    check("saved views are listed per report", res.status === 200 && body.items.some((v) => v.id === saved.id), res.status);
    res = await send("/api/reports/views", { reportKey: "device-health", name: `Http view ${stamp}`, config: {} });
    check("a duplicate name is a conflict", res.status === 409, res.status);
    res = await send("/api/reports/views", { reportKey: "nope", name: "x", config: {} });
    check("a view for an unknown report is refused", res.status === 400, res.status);
    res = await send("/api/reports/views", { name: "no report" });
    check("a view with no report is refused", res.status === 400, res.status);
    res = await get("/api/reports/views?report=nope");
    check("listing views for an unknown report is refused", res.status === 400, res.status);
    res = await send(`/api/reports/views/${saved.id}`, { name: "renamed" }, "PUT");
    check("a view nobody owns cannot be changed from here", res.status === 403, res.status);
    res = await send(`/api/reports/views/${saved.id}`, undefined, "DELETE");
    check("or removed", res.status === 403, res.status);
    res = await send("/api/reports/views/not-a-uuid", { name: "x" }, "PUT");
    check("a view id must be a UUID", res.status === 400, res.status);

    // ---- schedules over HTTP
    const sched1 = await send("/api/reports/schedules", { reportKey: "device-health", clientId: client.id, frequency: "daily", recipients: ["ops@example.test"], format: "both", sendIfEmpty: false });
    const schedBody = await sched1.json();
    check("a schedule for any report can be created", sched1.status === 201 && !!schedBody.id, { status: sched1.status, schedBody });
    res = await get("/api/reports/schedules");
    body = await res.json();
    const listedSched = body.items.find((s) => s.id === schedBody.id);
    check("it is listed with what it sends", res.status === 200 && listedSched.title === "Device health" && listedSched.format === "both" && listedSched.sendIfEmpty === false && listedSched.frequency === "daily", listedSched);
    res = await send("/api/reports/schedules", { reportKey: "alert-history", frequency: "daily", recipients: ["ops@example.test"] });
    check("an alert or audit report cannot be scheduled", res.status === 400, res.status);
    res = await send("/api/reports/schedules", { reportKey: "device-health", frequency: "hourly", recipients: ["ops@example.test"] });
    check("a made-up frequency is refused", res.status === 400, res.status);
    res = await send("/api/reports/schedules", { reportKey: "device-health", frequency: "daily", recipients: ["ops@example.test"], format: "xlsx" });
    check("a made-up format is refused", res.status === 400, res.status);
    res = await send("/api/reports/schedules", { reportKey: "device-health", frequency: "daily", recipients: ["ops@example.test"], viewId: "not-a-uuid" });
    check("a view id must be a UUID", res.status === 400, res.status);
    res = await send(`/api/reports/schedules/${schedBody.id}`, { frequency: "weekly", recipients: ["ops@example.test"], format: "pdf", sendIfEmpty: true, enabled: false }, "PUT");
    check("a schedule can be changed", res.status === 200, res.status);
    res = await send(`/api/reports/schedules/${schedBody.id}/send-now`, undefined, "POST");
    const sendNowBody = await res.json();
    check("send-now says plainly when mail is not set up", res.status === 400 && /not set up/i.test(sendNowBody.message), sendNowBody);
    res = await send("/api/reports/schedules/not-a-uuid/send-now", undefined, "POST");
    check("send-now needs a real schedule id", res.status === 400, res.status);
    res = await send(`/api/reports/schedules/${schedBody.id}`, undefined, "DELETE");
    check("a schedule can be removed", res.status === 200, res.status);

    // ---- days, times and zones over HTTP
    res = await send("/api/reports/schedules/preview", { frequency: "weekly", daysOfWeek: [1, 3], time: "08:30", timezone: "America/Los_Angeles" });
    const prev = await res.json();
    check("a preview returns the next five send times", res.status === 201 && prev.runs.length === 5 && /Monday and Wednesday at 8:30 AM/.test(prev.description) && /(PST|PDT)/.test(prev.runs[0].local), { status: res.status, prev });
    res = await send("/api/reports/schedules/preview", { frequency: "monthly", dayOfMonth: -1, time: "23:59", timezone: "Asia/Kolkata" });
    check("the last day of the month works", res.status === 201 && /last day of every month/.test((await res.json()).description), res.status);
    for (const [name, bad] of [
        ["a time without a leading zero", { frequency: "daily", time: "9:00" }],
        ["a time that is not a time", { frequency: "daily", time: "25:00" }],
        ["a zone that does not exist", { frequency: "daily", timezone: "Mars/Base" }],
        ["a day of the week out of range", { frequency: "weekly", daysOfWeek: [8] }],
        ["a day of the month out of range", { frequency: "monthly", dayOfMonth: 40 }],
        ["a made-up week of the month", { frequency: "monthly", nthWeek: 5, nthWeekday: 1 }],
        ["a one-off with no date", { frequency: "once" }],
        ["a one-off date that does not exist", { frequency: "once", onceDate: "2026-02-30" }],
        ["a frequency that is not offered", { frequency: "hourly" }],
    ]) {
        res = await send("/api/reports/schedules/preview", bad);
        check(`${name} is refused`, res.status === 400, { name, status: res.status });
    }
    res = await send("/api/reports/schedules", { reportKey: "device-health", clientId: client.id, frequency: "weekly", daysOfWeek: [2, 5], time: "14:00", timezone: "Europe/Berlin", recipients: ["ops@example.test"] });
    const timed = await res.json();
    res = await get("/api/reports/schedules");
    const timedRow = (await res.json()).items.find((s) => s.id === timed.id);
    check("a schedule is created with its days, time and zone, and says so", timedRow && timedRow.description === "Every Tuesday and Friday at 2:00 PM (Europe/Berlin)" && timedRow.schedule.daysOfWeek.join() === "2,5", timedRow && timedRow.description);
    res = await send(`/api/reports/schedules/${timed.id}`, { frequency: "monthly", nthWeek: 1, nthWeekday: 1, time: "09:00", timezone: "Europe/Berlin", recipients: ["ops@example.test"] }, "PUT");
    check("it can be changed to the first Monday of the month", res.status === 200, res.status);
    res = await send(`/api/reports/schedules/${timed.id}`, undefined, "DELETE");
    check("and removed", res.status === 200);

    // ---- what is refused
    for (const [name, url] of [
        ["an unknown report", "/api/reports/run/nope"],
        ["a report that has its own route", "/api/reports/run/alert-history"],
        ["a customer that is not a UUID", "/api/reports/run/hardware-inventory?clientId=abc"],
        ["a site that is not a UUID", "/api/reports/run/hardware-inventory?siteId=abc"],
        ["a made-up format", `/api/reports/run/hardware-inventory?format=xml`],
        ["a malformed date", "/api/reports/alert-history?from=yesterday"],
        ["a limit outside its range", "/api/reports/run/device-health?offlineDays=100000"],
        ["a limit that is not a number", "/api/reports/run/device-health?minRamGb=lots"],
    ]) {
        res = await get(url);
        check(`${name} is refused`, res.status === 400 || res.status === 404, { url, status: res.status });
    }
    res = await get("/api/reports/alert-history?from=2026-02-31&to=2026-03-01");
    check("a date that does not exist is a client error, not a crash", res.status === 400, res.status);
    res = await get(`/api/reports/run/hardware-inventory?clientId=${crypto.randomUUID()}`);
    check("an unknown customer is a client error", res.status === 400, res.status);

    // ---- the All report
    res = await get(`/api/reports/full?clientId=${client.id}&format=summary`);
    body = await res.json();
    check("the All report summary is served, with a scorecard and a line per section", res.status === 200 && Array.isArray(body.scorecard) && body.scorecard.length > 0 && Array.isArray(body.sections), { status: res.status, keys: Object.keys(body) });
    res = await get(`/api/reports/full?deviceId=${device.id}&format=json`);
    body = await res.json();
    check("without the alert and audit rights, those sections are left out and listed", res.status === 200 && body.omitted.map((o) => o.key).sort().join() === "alert-history,alert-noise,remote-sessions,technician-activity,ticket-sla" && body.scope.device === `H-${stamp}`, body.omitted);
    res = await get(`/api/reports/full?deviceId=${device.id}&format=pdf`);
    const fullPdf = Buffer.from(await res.arrayBuffer());
    check("the All report downloads as a PDF", res.status === 200 && /application\/pdf/.test(res.headers.get("content-type")) && fullPdf.subarray(0, 5).toString() === "%PDF-" && /attachment; filename="[^"]+\.pdf"/.test(res.headers.get("content-disposition")), res.headers.get("content-disposition"));
    res = await get(`/api/reports/full?siteId=${site.id}&format=xlsx`);
    const fullXlsx = Buffer.from(await res.arrayBuffer());
    check("and as an Excel workbook", res.status === 200 && /spreadsheetml\.sheet/.test(res.headers.get("content-type")) && fullXlsx.subarray(0, 2).toString() === "PK" && /\.xlsx"/.test(res.headers.get("content-disposition")), res.headers.get("content-type"));
    for (const [name, url] of [
        ["a device that is not a UUID", "/api/reports/full?deviceId=abc"],
        ["a made-up format", "/api/reports/full?format=csv"],
        ["a malformed date", "/api/reports/full?from=yesterday"],
        ["a device that does not exist", `/api/reports/full?deviceId=${crypto.randomUUID()}`],
    ]) {
        res = await get(url);
        check(`the All report with ${name} is refused`, res.status === 400, { url, status: res.status });
    }

    // ---- reports people design
    res = await send("/api/reports/custom", { name: `Http design ${stamp}`, description: "x", config: { title: "Http pack", intro: "Hello", sections: [{ key: "hardware-inventory", title: "Machines", maxRows: 10 }, { key: "device-health" }] } });
    const designBody = await res.json();
    check("a designed report can be saved", res.status === 201 && designBody.name === `Http design ${stamp}` && designBody.config.sections.length === 2, { status: res.status, designBody });
    res = await get("/api/reports/custom");
    check("designed reports are listed", res.status === 200 && (await res.json()).items.some((d) => d.id === designBody.id));
    res = await get(`/api/reports/custom/${designBody.id}`);
    check("one can be read back", res.status === 200 && (await res.json()).config.intro === "Hello");
    res = await get(`/api/reports/custom/${designBody.id}/run?clientId=${client.id}&format=summary`);
    body = await res.json();
    check("it runs for a customer and says what is in it", res.status === 200 && body.title === "Http pack: Http " + stamp && body.sections.map((s) => s.title).join() === "Machines,Device health" && body.intro === "Hello", { status: res.status, body });
    res = await get(`/api/reports/custom/${designBody.id}/run?deviceId=${device.id}&format=pdf`);
    const designPdf = Buffer.from(await res.arrayBuffer());
    check("and downloads as a PDF", res.status === 200 && /application\/pdf/.test(res.headers.get("content-type")) && designPdf.subarray(0, 5).toString() === "%PDF-" && /http-pack/.test(res.headers.get("content-disposition")), res.headers.get("content-disposition"));
    res = await get(`/api/reports/custom/${designBody.id}/run?siteId=${site.id}&format=xlsx`);
    check("and as a workbook", res.status === 200 && /spreadsheetml\.sheet/.test(res.headers.get("content-type")));
    res = await get("/api/reports/custom/columns/security-score");
    check("the columns of a report can be listed for the builder", res.status === 200 && (await res.json()).items.some((c) => c.key === "score"));
    res = await get("/api/reports/custom/columns/nope");
    check("for a report that is not there it is a not-found", res.status === 404, res.status);
    res = await send(`/api/reports/custom/${designBody.id}`, { name: `Http design ${stamp}`, config: { sections: [{ key: "hardware-inventory" }] } }, "PUT");
    check("a design can be changed", res.status === 200 && (await res.json()).config.sections.length === 1, res.status);
    res = await send("/api/reports/custom", { name: `Http design ${stamp}`, config: { sections: [{ key: "hardware-inventory" }] } });
    check("a name already used is a conflict", res.status === 409, res.status);
    res = await send("/api/reports/custom", { name: `Http empty ${stamp}`, config: { sections: [] } });
    check("a design with no sections is refused, in words", res.status === 400 && /at least one section/.test((await res.json()).message), res.status);
    res = await send("/api/reports/custom", { config: { sections: [{ key: "hardware-inventory" }] } });
    check("a design with no name is refused", res.status === 400, res.status);
    res = await get("/api/reports/custom/not-a-uuid");
    check("an id must be a UUID", res.status === 400, res.status);
    res = await send(`/api/reports/custom/${designBody.id}`, undefined, "DELETE");
    check("a design can be removed", res.status === 200, res.status);
    res = await get(`/api/reports/custom/${designBody.id}/run?format=summary`);
    check("running one that is gone is a not-found", res.status === 404, res.status);

    // ---- a customer's own look for its reports
    res = await get(`/api/reports/branding/${client.id}`);
    body = await res.json();
    check("a customer's report look can be read", res.status === 200 && body.customer === `Http ${stamp}` && body.primaryColor === null, body);
    res = await send(`/api/reports/branding/${client.id}`, { primaryColor: "#0a7d4f", coverText: "Hello from us", footerText: "Confidential" }, "PUT");
    body = await res.json();
    check("it can be set", res.status === 200 && body.primaryColor === "#0a7d4f" && body.coverText === "Hello from us", { status: res.status, body });
    res = await send(`/api/reports/branding/${client.id}`, { primaryColor: "green" }, "PUT");
    check("a colour that is not one is refused, in words", res.status === 400 && /#1a73e8/.test((await res.json()).message), res.status);
    res = await send(`/api/reports/branding/${crypto.randomUUID()}`, { primaryColor: "#0a7d4f" }, "PUT");
    check("for a customer that is not there it is a not-found", res.status === 404, res.status);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const upload = (type, name, bytes) => { const f = new FormData(); f.append("file", new Blob([bytes], { type }), name); return fetch(`${base}/api/reports/branding/${client.id}/logo`, { method: "POST", body: f }); };
    res = await upload("image/png", "logo.png", png);
    body = await res.json();
    check("a PNG logo can be uploaded", (res.status === 201 || res.status === 200) && /^client-logo-.*\.png$/.test(body.logoFile) && body.logoUrl === `/static/uploads/${body.logoFile}`, { status: res.status, body });
    const storedLogo = path.join(process.cwd(), "public", "uploads", body.logoFile);
    check("it is kept in the uploads folder", require("node:fs").existsSync(storedLogo));
    res = await upload("image/gif", "logo.gif", png);
    check("a GIF is refused", res.status === 400 && /PNG or JPEG/.test((await res.json()).message), res.status);
    res = await upload("image/png", "big.png", Buffer.alloc(2 * 1024 * 1024 + 10));
    check("a logo over 2 MB is refused", res.status === 413 || res.status === 400, res.status);
    res = await fetch(`${base}/api/reports/branding/${client.id}/logo`, { method: "POST" });
    check("an upload with no file is refused", res.status === 400, res.status);
    res = await send(`/api/reports/branding/${client.id}/logo`, undefined, "DELETE");
    body = await res.json();
    check("the logo can be removed, and the file goes", res.status === 200 && body.logoFile === null && !require("node:fs").existsSync(storedLogo), res.status);
    res = await send(`/api/reports/branding/${client.id}`, {}, "PUT");
    check("saving nothing clears the look", res.status === 200 && (await res.json()).primaryColor === null);

    // ---- software policies and business hours
    res = await send("/api/reports/software-policies", { clientId: client.id, kind: "banned", pattern: "Http Test Tool" });
    const polBody = await res.json();
    check("a software policy can be added", res.status === 201 && polBody.pattern === "Http Test Tool" && polBody.kind === "banned", { status: res.status, polBody });
    res = await send("/api/reports/software-policies", { clientId: client.id, kind: "banned", pattern: "http test tool" });
    check("the same policy twice is a conflict", res.status === 409, res.status);
    res = await send("/api/reports/software-policies", { kind: "sometimes", pattern: "x" });
    check("a policy that is neither required nor banned is refused", res.status === 400, res.status);
    res = await get(`/api/reports/software-policies?clientId=${client.id}`);
    check("policies are listed for a customer", res.status === 200 && (await res.json()).items.some((p) => p.id === polBody.id));
    res = await send(`/api/reports/software-policies/${polBody.id}`, undefined, "DELETE");
    check("and removed", res.status === 200, res.status);
    res = await send(`/api/reports/software-policies/${polBody.id}`, undefined, "DELETE");
    check("removing it again is a not-found", res.status === 404, res.status);
    res = await get("/api/reports/business-hours");
    body = await res.json();
    check("business hours are served", res.status === 200 && Array.isArray(body.days) && /^\d\d:\d\d$/.test(body.start), body);
    res = await send("/api/reports/business-hours", { days: [1, 2, 3], start: "09:00", end: "17:00", timezone: "Europe/London" }, "PUT");
    check("and can be changed", res.status === 200 && (await res.json()).timezone === "Europe/London", res.status);
    res = await send("/api/reports/business-hours", { days: [9], start: "09:00", end: "17:00", timezone: "UTC" }, "PUT");
    check("a day that is not a day is refused", res.status === 400, res.status);
    res = await send("/api/reports/business-hours", { days: [1], start: "9am", end: "17:00", timezone: "UTC" }, "PUT");
    check("a time that is not a time is refused", res.status === 400, res.status);
    await prisma.report_settings.deleteMany({});

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
