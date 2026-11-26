#!/usr/bin/env node
// GET /api/dashboard/summary through the real HTTP API: numbers match seeded data (devices, alerts, security, patching, agent
// versions, tickets, schedule, activity), every section is gated by its own right, a person limited to some customers sees only
// theirs, the clientId filter works, the 30 s cache (set short here) never lets one scope, organisation or filter see another's
// numbers, an empty install, and a 5,000 device seed answers quickly.
//
//   ADG_E2E_ALLOW=1 DASHBOARD_CACHE_TTL_MS=2500 BASE_URL=http://127.0.0.1:3961 DATABASE_URL=postgres://.../adg_dash_e2e JWT_SECRET=... node test/dashboard-http.e2e.cjs
//   (SCALE_DEVICES=5000 by default)
"use strict";
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TTL = Number(process.env.DASHBOARD_CACHE_TTL_MS || 2500);
const N = Number(process.env.SCALE_DEVICES || 5000);

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `DB${Date.now()}`;
    const devs = [];
    const orgs2 = [];

    const get = async (user, qs = "") => {
        const r = await call(`/api/dashboard/summary${qs}`, { token: user?.token });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const ok = async (user, qs = "") => {
        const r = await get(user, qs);
        assert.equal(r.status, 200, `status ${r.status} ${JSON.stringify(r.body)}`);
        return r.body;
    };

    // ---------- people
    const ALL = ["devices.read", "alerts.read", "tickets.read", "schedule.read", "audit.read", "customers.read", "settings.read"];
    const boss = await staffUser("db-boss", ALL);
    const noTickets = await staffUser("db-notickets", ["devices.read", "alerts.read", "schedule.read"]);
    const ticketsOnly = await staffUser("db-ticketsonly", ["tickets.read"]);
    const nothing = await staffUser("db-nothing", ["me.read"]);
    const releaseMgr = await staffUser("db-release", ["devices.read", "agents.release.manage"]);
    const limited = await staffUser("db-limited", ["devices.read", "alerts.read", "tickets.read", "schedule.read", "audit.read", "customers.read"]);
    const noAudit = await staffUser("db-noaudit", ["devices.read", "alerts.read"]);

    // ---------- the empty install comes first: nothing of ours exists yet
    await test("an empty install: zero everywhere, no attention, no devices to start from, and nothing breaks", async () => {
        const base = await q(`SELECT (SELECT count(*) FROM devices)::int AS d, (SELECT count(*) FROM tickets)::int AS t, (SELECT count(*) FROM alerts)::int AS a`);
        if (base.rows[0].d + base.rows[0].t + base.rows[0].a > 0) { console.log("        (database is not empty, skipped)"); return; }
        const s = await ok(boss);
        assert.deepEqual(s.devices, { total: 0, online: 0, offline: 0, offlineOver24h: 0, neverCheckedIn: 0, removalRequests: 0 });
        assert.equal(s.setup.hasDevices, false);
        assert.equal(s.setup.customers, 0);
        assert.deepEqual(s.attention, []);
        assert.equal(s.tickets.hasTickets, false);
        assert.equal(s.security.windowsDevices, 0);
        assert.equal(s.patching.devicesWithAgent, 0);
        assert.equal(s.agents.devicesWithAgent, 0);
        assert.deepEqual(s.agents.versions, []);
        assert.equal(s.schedule.today, 0);
        assert.equal(s.schedule.next, null);
    });

    // ---------- data
    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, name: `${tag} ${n}`, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A");
    const B = await mkClient("B");
    const C = await mkClient("C-empty");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);

    // minutes: minutes since the last check-in (null: never), version, os, ring
    const mk = async (cl, host, { os = "windows", minutes = 0, version = "1.3.30", agent = true, ring = null, seenMinutes = null } = {}) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system, update_ring, last_seen_at) VALUES ($1,$2,$3,$4, ${seenMinutes === null ? "NULL" : `now() - interval '${seenMinutes} minutes'`}) RETURNING id`,
            [cl.site, `${tag}-${host}`, os === "windows" ? "Windows 11 Pro" : os === "mac" ? "macOS 15" : "Ubuntu 24.04", ring])).rows[0].id;
        devs.push(id);
        let aid = null;
        if (agent) {
            aid = uuid();
            await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,$4, ${minutes === null ? "NULL" : `now() - interval '${minutes} minutes'`}, $5)`,
                [aid, id, uuid(), version, JSON.stringify({ os: os === "mac" ? "macos" : os })]);
        }
        return { id, agent: aid };
    };
    const a1 = await mk(A, "a1", { minutes: 0, version: "1.3.30" });
    const a2 = await mk(A, "a2", { minutes: 1, version: "1.3.30", ring: "pilot" });
    const a3 = await mk(A, "a3", { minutes: 90, version: "1.3.29" });                    // offline, but not for long
    const aLin = await mk(A, "alin", { os: "linux", minutes: 60 * 48, version: "1.3.30" }); // offline two days
    const aNever = await mk(A, "anever", { minutes: null, version: "1.3.28" });             // an agent that never reported
    const aNoAgent = await mk(A, "anoagent", { agent: false, seenMinutes: 60 * 72 });       // no agent, last seen three days ago
    const b1 = await mk(B, "b1", { minutes: 2, version: "1.3.31" });
    const b2 = await mk(B, "b2", { minutes: 60 * 30, version: "1.3.31", ring: "pilot" });   // offline 30 hours

    // alerts: A: crit on a1; warn on a2; warn on aLin but silenced; acked on a3; B: warn on b1; resolved crit on b2
    const alert = (dev, state, sev, silenced = null) => q(`INSERT INTO alerts (device_id, kind, dedupe_key, state, severity, title, silenced_until) VALUES ($1,'check',$2,$3,$4,$5,$6)`, [dev.id, `${tag}-${uuid()}`, state, sev, `${tag} alert`, silenced]);
    await alert(a1, "OPEN", "CRIT");
    await alert(a2, "OPEN", "WARN");
    await alert(aLin, "OPEN", "WARN", new Date(Date.now() + 3600_000));
    await alert(a3, "ACKED", "CRIT");
    await alert(b1, "OPEN", "WARN");
    await alert(b2, "RESOLVED", "CRIT");

    // security: a1 grade F (2 critical), a2 grade A, b1 grade B, a3 and aNever never scanned
    const scan = (dev, grade, score, crit) => q(`INSERT INTO device_security_scans (device_id, scanned_at, attempted_at, ok, score, grade, critical_failed, failed_rules) VALUES ($1, now(), now(), true, $2, $3, $4, '{}')`, [dev.id, score, grade, crit]);
    await scan(a1, "F", 40, 2);
    await scan(a2, "A", 96, 0);
    await scan(b1, "B", 84, 0);

    // patching: a1 3 missing + restart; a2 none missing; b1 two missing (in the run's output) and its last install failed; aNever scanned long ago with 1
    const task = async (dev, type, status = "succeeded") => (await q(`INSERT INTO agent_tasks (agent_id, type, payload, status, queued_at) VALUES ($1,$2,'{}',$3, now()) RETURNING id`, [dev.agent, type, status])).rows[0].id;
    const run = async (taskId, status, { output = null, artifacts = null, finished = "now()" } = {}) => {
        const id = (await q(`INSERT INTO agent_task_runs (task_id, status, started_at, finished_at, output) VALUES ($1,$2, ${finished}, ${finished}, $3) RETURNING id`, [taskId, status, output ? JSON.stringify(output) : null])).rows[0].id;
        if (artifacts) await q(`INSERT INTO agent_task_results (run_id, artifacts) VALUES ($1,$2)`, [id, JSON.stringify(artifacts)]);
        return id;
    };
    const patches = (n) => Array.from({ length: n }, (_, i) => ({ id: `kb${i}`, title: `Update ${i}`, severity: "important", requiresReboot: false, kbIds: [`${i}`] }));
    await run(await task(a1, "patch_scan"), "succeeded", { artifacts: { patches: patches(3), rebootRequired: true } });
    await run(await task(a2, "patch_scan"), "succeeded", { artifacts: { patches: [], rebootRequired: false } });
    await run(await task(b1, "patch_scan"), "succeeded", { output: { artifacts: { patches: patches(2) } }, finished: "now() - interval '2 hours'" });
    await run(await task(b1, "patch_install", "failed"), "failed", { finished: "now() - interval '1 hour'" });
    // an older, superseded scan on a2 that listed updates must not count
    await run(await task(a2, "patch_scan"), "succeeded", { artifacts: { patches: patches(5) }, finished: "now() - interval '3 days'" });
    // an install that failed a month ago is not news
    await run(await task(a2, "patch_install", "failed"), "failed", { finished: "now() - interval '30 days'" });
    const outdated = (dev, app) => q(`INSERT INTO agent_outdated_software (agent_id, source, app_id, name, installed_version, available_version) VALUES ($1,'winget',$2,$2,'1','2')`, [dev.agent, app]);
    await outdated(a1, "Mozilla.Firefox");
    await outdated(a1, "7zip.7zip");
    await outdated(a2, "Mozilla.Firefox");

    // tickets: A: open unassigned; in progress assigned; closed; breached; about to breach. B: open assigned to nobody
    const tn = async (client, subject, { status = "open", assignee = null } = {}) =>
        (await q(`INSERT INTO tickets (organization_id, ticket_number, subject, status, client_id, assignee_user_id) VALUES ($1, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets WHERE organization_id = $1), $2, $3, $4, $5) RETURNING id`,
            [org, `${tag} ${subject}`, status, client.id, assignee])).rows[0].id;
    const tA1 = await tn(A, "open unassigned");
    await tn(A, "in progress mine", { status: "in_progress", assignee: limited.id });
    await tn(A, "closed", { status: "closed" });
    const tBreached = await tn(A, "breached");
    const tWarn = await tn(A, "warning");
    await tn(B, "b open");
    const tBOther = await tn(B, "b assigned elsewhere", { assignee: boss.id });
    const sla = (id, extra) => q(`INSERT INTO ticket_sla (ticket_id, policy_name, priority, status, ${Object.keys(extra).join(", ")}) VALUES ($1,'Std','medium','open', ${Object.keys(extra).map((_, i) => `$${i + 2}`).join(", ")})`, [id, ...Object.values(extra)]);
    await sla(tBreached, { response_target_min: 60, response_breached_at: new Date(Date.now() - 3600_000) });
    await sla(tWarn, { response_target_min: 60, response_running_since: new Date(Date.now() - 50 * 60_000), response_due_at: new Date(Date.now() + 10 * 60_000), response_warn_at: new Date(Date.now() - 5 * 60_000) });
    void tA1; void tBOther;

    // visits: today (UTC) for A: one done, one cancelled, one still to come; one for B still to come; and one tomorrow for A
    const now = new Date();
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const at = (ms) => new Date(dayStart + ms);
    const HOUR = 3600_000, MIN = 60_000;
    const visit = async (client, ticket, title, startMs, endMs, status) =>
        q(`INSERT INTO ticket_visits (organization_id, ticket_id, client_id, title, status, starts_at, ends_at, time_zone) VALUES ($1,$2,$3,$4,$5,$6,$7,'UTC')`, [org, ticket, client.id, `${tag} ${title}`, status, at(startMs), at(endMs)]);
    await visit(A, tBreached, "done today", 10 * MIN, 20 * MIN, "done");
    await visit(A, tBreached, "cancelled today", 30 * MIN, 40 * MIN, "cancelled");
    await visit(A, tWarn, "later today", 23 * HOUR + 40 * MIN, 23 * HOUR + 55 * MIN, "scheduled");
    await visit(B, tBOther, "b later today", 23 * HOUR + 41 * MIN, 23 * HOUR + 56 * MIN, "scheduled");
    await visit(A, tWarn, "tomorrow", 30 * HOUR, 31 * HOUR, "scheduled");

    // audit
    const aud = (action, cat, label, outcome, ago) => q(`INSERT INTO audit_events (created_at, action, category, outcome, target_label, actor_email) VALUES (now() - ($5 || ' seconds')::interval, $1,$2,$3,$4,'tech@example.test')`, [action, cat, outcome, label, String(ago)]);
    await aud("device.list", "device", `${tag} noise-1`, "success", 5);
    await aud("auth.signin", "auth", `${tag} noise-2`, "success", 4);
    await aud("ticket.create", "ticket", `${tag} Printer is down`, "success", 3);
    await aud("device.reboot", "device", `${tag} PC-12`, "failure", 1);

    // The empty-install answer above is still cached for a moment; the numbers below must be read after it expires.
    await sleep(TTL + 300);

    // ---------- numbers
    await test("devices: total, online, offline, offline over a day, never checked in match the seed (counted like the device list)", async () => {
        const s = await ok(boss);
        // only our own devices matter: filter by our three customers one by one and add them up
        const a = await ok(boss, `?clientId=${A.id}`);
        const b = await ok(boss, `?clientId=${B.id}`);
        const c = await ok(boss, `?clientId=${C.id}`);
        assert.deepEqual(a.devices, { total: 6, online: 2, offline: 4, offlineOver24h: 2, neverCheckedIn: 1, removalRequests: 0 });
        assert.deepEqual(b.devices, { total: 2, online: 1, offline: 1, offlineOver24h: 1, neverCheckedIn: 0, removalRequests: 0 });
        assert.deepEqual(c.devices, { total: 0, online: 0, offline: 0, offlineOver24h: 0, neverCheckedIn: 0, removalRequests: 0 });
        assert.ok(s.devices.total >= 8);
        // the whole-install number is the device list's own (a device with no site included)
        const listAll = await (await call(`/api/devices/counts`, { token: boss.token })).json();
        assert.equal(s.devices.total, listAll.total);
        assert.equal(s.devices.online, listAll.online);
        // the same numbers the device list's own counts give
        const list = await (await call(`/api/devices/counts?clientId=${A.id}`, { token: boss.token })).json();
        assert.equal(list.total, a.devices.total);
        assert.equal(list.online, a.devices.online);
        assert.equal(list.offline, a.devices.offline);
    });

    await test("alerts: open, critical, acknowledged, silenced, and the devices behind the Critical and Warning tiles", async () => {
        const a = await ok(boss, `?clientId=${A.id}`);
        assert.deepEqual({ ...a.alerts }, { open: 3, openCritical: 1, acknowledged: 1, silenced: 0, devicesCritical: 1, devicesWarning: 1 }, "the silenced alert still counts as open (as on the alerts page) but not as a live warning");
        const b = await ok(boss, `?clientId=${B.id}`);
        assert.deepEqual({ ...b.alerts }, { open: 1, openCritical: 0, acknowledged: 0, silenced: 0, devicesCritical: 0, devicesWarning: 1 }, "a resolved alert counts nowhere");
        const mine = await (await call("/api/alerts/summary", { token: boss.token })).json();
        const all = await ok(boss);
        assert.equal(all.alerts.open, mine.open, "the same open count as /api/alerts/summary");
        assert.equal(all.alerts.openCritical, mine.openCritical);
    });

    await test("security: grades, scanned, never scanned and devices needing action match /api/security/summary", async () => {
        const a = await ok(boss, `?clientId=${A.id}`);
        assert.equal(a.security.windowsDevices, 6, "Windows and Linux devices of A (the seed has a Linux device, which a security scan covers too)");
        assert.equal(a.security.withAgent, 5, "a1 a2 a3 aNever and the Linux one (the no-agent one has no scan to read)");
        assert.deepEqual(a.security.grades, { A: 1, B: 0, C: 0, D: 0, F: 1, none: 3 });
        assert.equal(a.security.neverScanned, 3);
        assert.equal(a.security.scanned, 2);
        assert.equal(a.security.devicesNeedingAction, 1);
        assert.equal(a.security.devicesWithCriticalFailures, 1);
        assert.equal(a.security.averageScore, 68);
        const real = await (await call(`/api/security/summary?clientId=${A.id}`, { token: boss.token })).json();
        assert.equal(a.security.averageScore, real.averageScore);
        assert.deepEqual(a.security.grades, real.grades);
        assert.ok(a.security.topFailingRules.length <= 3);
    });

    await test("patching: pending updates (latest scan only), restart needed, failed installs (recent only), outdated software", async () => {
        const a = await ok(boss, `?clientId=${A.id}`);
        assert.equal(a.patching.devicesWithAgent, 5);
        assert.equal(a.patching.scanned, 2);
        assert.equal(a.patching.neverScanned, 3);
        assert.equal(a.patching.withPendingUpdates, 1, "a1 only; a2's old scan was replaced by a newer one with nothing missing");
        assert.equal(a.patching.needRestart, 1);
        assert.equal(a.patching.installFailed, 0, "a2's failed install is a month old");
        assert.equal(a.patching.outdatedSoftwareDevices, 2);
        assert.equal(a.patching.outdatedSoftwareApps, 2, "Firefox on two devices is one program");
        const b = await ok(boss, `?clientId=${B.id}`);
        assert.equal(b.patching.withPendingUpdates, 1, "the scan result can sit in the run's output too");
        assert.equal(b.patching.installFailed, 1);
        assert.equal(b.patching.needRestart, 0);
        assert.equal(b.patching.outdatedSoftwareDevices, 0);
    });

    await test("agent versions: devices per version newest first, pilot ring (device or customer default), latest version", async () => {
        const a = await ok(boss, `?clientId=${A.id}`);
        assert.equal(a.agents.devicesWithAgent, 5);
        assert.deepEqual(a.agents.versions.map((v) => [v.version, v.devices, v.pilot]), [["1.3.30", 3, 1], ["1.3.29", 1, 0], ["1.3.28", 1, 0]]);
        assert.equal(a.agents.latestVersion, "1.3.30");
        assert.equal(a.agents.onLatest, 3);
        assert.equal(a.agents.pilotDevices, 1);
        assert.equal(a.agents.otherVersions, null);
        await q(`UPDATE clients SET default_update_ring = 'pilot' WHERE id = $1`, [B.id]);
        await sleep(TTL + 300);
        const b = await ok(boss, `?clientId=${B.id}`);
        assert.equal(b.agents.pilotDevices, 2, "b1 follows its customer's pilot default, b2 has its own pilot");
        assert.equal(a.agents.release, null, "a person who may not manage releases gets no release information");
        await q(`UPDATE clients SET default_update_ring = 'stable' WHERE id = $1`, [B.id]);
    });

    await test("service desk: open, unassigned, breached, close to breaching; closed tickets are not open", async () => {
        const a = await ok(boss, `?clientId=${A.id}`);
        assert.deepEqual({ ...a.tickets }, { open: 4, unassigned: 3, breached: 1, warning: 1, hasTickets: true });
        const b = await ok(boss, `?clientId=${B.id}`);
        assert.deepEqual({ ...b.tickets }, { open: 2, unassigned: 1, breached: 0, warning: 0, hasTickets: true });
        const c = await ok(boss, `?clientId=${C.id}`);
        assert.deepEqual({ ...c.tickets }, { open: 0, unassigned: 0, breached: 0, warning: 0, hasTickets: false });
        const counts = await (await call("/api/ticket-queues/counts", { token: boss.token })).json();
        const all = await ok(boss);
        assert.equal(all.tickets.open, counts.open, "the same open count as the tickets screen");
        assert.equal(all.tickets.unassigned, counts.unassigned);
        assert.equal(all.tickets.breached, counts.breached);
    });

    await test("today's schedule: visits today (not cancelled), what is still to come, done, the next one, the next seven days", async () => {
        const a = await ok(boss, `?clientId=${A.id}`);
        assert.equal(a.schedule.today, 2, "done + later today; the cancelled one does not count");
        assert.equal(a.schedule.doneToday, 1);
        assert.equal(a.schedule.remainingToday, 1);
        assert.equal(a.schedule.nextSevenDays, 2, "later today and tomorrow");
        assert.equal(a.schedule.next.title, `${tag} later today`);
        assert.equal(a.schedule.next.customer, A.name);
        assert.equal(a.schedule.timeZone, "UTC");
        const b = await ok(boss, `?clientId=${B.id}`);
        assert.equal(b.schedule.today, 1);
        assert.equal((await ok(boss, `?clientId=${C.id}`)).schedule.next, null);
    });

    await test("recent activity: plain language, newest first, no noise (sign-ins, lists), no details, failures marked", async () => {
        const s = await ok(boss);
        const mine = s.activity.items.filter((i) => i.text.includes(tag));
        assert.deepEqual(mine.map((i) => i.text), [`restarted device ${tag} PC-12 (did not work)`, `created ticket ${tag} Printer is down`]);
        assert.equal(mine[0].failed, true);
        assert.equal(mine[0].actor, "tech@example.test");
        assert.ok(!s.activity.items.some((i) => /noise/.test(i.text)));
        assert.ok(s.activity.items.length <= 8);
        for (const i of s.activity.items) assert.deepEqual(Object.keys(i).sort(), ["actor", "at", "failed", "id", "text"], "nothing else leaves the server");
        assert.equal(s.activity.allCustomers, false);
        assert.equal((await ok(boss, `?clientId=${A.id}`)).activity.allCustomers, true, "the audit log is not split by customer, and says so");
    });

    await test("attention: ranked, plain language, only what is non-zero, with where to go", async () => {
        const a = await ok(boss, `?clientId=${A.id}`);
        assert.deepEqual(a.attention.map((i) => [i.id, i.count, i.severity]), [
            ["alerts-critical", 1, "critical"],
            ["sla-breached", 1, "critical"],
            ["security-critical", 1, "critical"],
            ["devices-offline", 2, "warning"],
            ["alerts-open", 2, "warning"],
            ["sla-risk", 1, "warning"],
            ["needs-restart", 1, "info"],
            ["not-scanned", 3, "info"],
            ["never-checked-in", 1, "info"],
        ]);
        const first = a.attention[0];
        assert.equal(first.text, "1 critical alert is open");
        assert.equal(first.route, "/alerts");
        assert.deepEqual(first.query, { severity: "CRIT" });
        const c = await ok(boss, `?clientId=${C.id}`);
        assert.deepEqual(c.attention, [], "an empty customer is all clear");
    });

    // ---------- rights
    await test("no token is refused; a signed-in person with no rights gets an answer with nothing in it", async () => {
        assert.ok([401, 403].includes((await get(null)).status));
        const s = await ok(nothing);
        for (const k of ["devices", "alerts", "security", "patching", "agents", "tickets", "schedule", "activity", "setup"]) assert.equal(s[k], null, k);
        assert.deepEqual(s.attention, []);
        assert.equal(s.access.devices, false);
    });

    await test("every section has its own right: a person without tickets rights gets no tickets section, and so on", async () => {
        const nt = await ok(noTickets);
        assert.equal(nt.tickets, null);
        assert.equal(nt.access.tickets, false);
        assert.ok(nt.devices && nt.alerts && nt.security && nt.patching && nt.agents && nt.schedule);
        assert.ok(!nt.attention.some((i) => i.area === "tickets"), "and no ticket row in the attention list");
        assert.equal(nt.activity, null, "no audit.read");
        const to = await ok(ticketsOnly);
        assert.ok(to.tickets && to.tickets.open >= 4);
        for (const k of ["devices", "alerts", "security", "patching", "agents", "schedule", "activity", "setup"]) assert.equal(to[k], null, k);
        assert.deepEqual(to.attention.map((i) => i.area).filter((x, i, all) => all.indexOf(x) === i), ["tickets"]);
        const na = await ok(noAudit);
        assert.equal(na.activity, null);
        assert.equal(na.schedule, null);
        assert.ok(na.alerts && na.devices);
        const alertsOff = await staffUser("db-noalerts", ["devices.read"]);
        const x = await ok(alertsOff);
        assert.equal(x.alerts, null, "without alerts.read there are no alert numbers, so no Critical or Warning tiles");
        assert.ok(!x.attention.some((i) => i.area === "alerts"));
    });

    await test("the release candidate is for release managers only; others get null", async () => {
        const r = await ok(releaseMgr);
        assert.ok(Array.isArray(r.agents.release), "a list (empty when no build waits on this server)");
        assert.equal(r.access.release, true);
        const b = await ok(boss);
        assert.equal(b.agents.release, null);
        assert.equal(b.access.release, false);
    });

    await test("a person limited to one customer sees only that customer's numbers in every section", async () => {
        const l = await ok(limited);
        const a = await ok(boss, `?clientId=${A.id}`);
        assert.deepEqual(l.devices, a.devices);
        assert.deepEqual(l.alerts, a.alerts);
        assert.deepEqual(l.security, a.security);
        assert.deepEqual(l.patching, a.patching);
        assert.deepEqual(l.agents.versions, a.agents.versions);
        assert.deepEqual(l.schedule.today, a.schedule.today);
        assert.deepEqual(l.tickets, a.tickets, "customer A's open tickets, and the one assigned to them is in A anyway");
        assert.equal(l.activity, null, "the audit log is not split by customer, so a limited person never gets it");
        assert.equal(l.access.activity, false);
        assert.ok(!JSON.stringify(l).includes(B.name));
        // asking for someone else's customer gives zeros, never their numbers
        const other = await ok(limited, `?clientId=${B.id}`);
        assert.equal(other.devices.total, 0);
        assert.equal(other.alerts.open, 0);
        assert.equal(other.tickets.open, 0);
        assert.equal(other.security.windowsDevices, 0);
        assert.equal(other.schedule.today, 0);
        assert.deepEqual(other.attention, []);
    });

    await test("a limited person's own assigned tickets count even in another customer (as on the tickets list)", async () => {
        await tn(B, "assigned to the limited person", { assignee: limited.id });
        await sleep(TTL + 300);
        const l = await ok(limited);
        assert.equal(l.tickets.open, 5, "customer A's four plus the one assigned to them");
        const lb = await ok(limited, `?clientId=${B.id}`);
        assert.equal(lb.tickets.open, 1);
    });

    await test("clientId must be a customer id", async () => {
        assert.equal((await get(boss, "?clientId=not-a-uuid")).status, 400);
        assert.equal((await get(boss, `?clientId=${uuid()}`)).status, 200);
        assert.equal((await ok(boss, `?clientId=${uuid()}`)).devices.total, 0);
        assert.equal((await ok(boss, "?clientId=")).clientId, null);
    });

    // ---------- the cache
    await test("the cache keeps numbers for a short time, then shows new ones; the answer carries its time and lifetime", async () => {
        const first = await ok(boss, `?clientId=${C.id}`);
        assert.equal(first.cacheSeconds, Math.round(TTL / 1000));
        assert.ok(Math.abs(Date.now() - Date.parse(first.generatedAt)) < 5000);
        const d = await mk(C, "late-arrival", { minutes: 0 });
        const cached = await ok(boss, `?clientId=${C.id}`);
        assert.equal(cached.devices.total, 0, "still the old number inside the lifetime");
        await sleep(TTL + 300);
        const fresh = await ok(boss, `?clientId=${C.id}`);
        assert.equal(fresh.devices.total, 1, "and the new one after it");
        assert.equal(fresh.devices.online, 1);
        void d;
    });

    await test("the cache never lets one scope or one filter see another's numbers, whoever asked first", async () => {
        await sleep(TTL + 300);
        // a limited person asks first, then the unlimited one, then the filtered ones, then the limited one again
        const l1 = await ok(limited);
        const b1r = await ok(boss);
        const bA = await ok(boss, `?clientId=${A.id}`);
        const bB = await ok(boss, `?clientId=${B.id}`);
        const l2 = await ok(limited);
        assert.deepEqual(l1.devices, l2.devices);
        assert.equal(l1.devices.total, 6);
        assert.ok(b1r.devices.total > l1.devices.total, "the unlimited person is not served the limited person's numbers");
        assert.equal(bA.devices.total, 6);
        assert.equal(bB.devices.total, 2);
        assert.notDeepEqual(bA.tickets, bB.tickets);
        // and the other way round: unlimited first, limited second
        await sleep(TTL + 300);
        const u = await ok(boss);
        const lim = await ok(limited);
        assert.ok(u.devices.total > lim.devices.total);
        assert.equal(lim.devices.total, 6);
        assert.equal(lim.tickets.open, 5);
    });

    await test("the cache does not hand a section to someone who may not see it", async () => {
        await ok(boss);                                   // fills the tickets section for everyone unlimited
        const nt = await ok(noTickets);                   // same scope, no tickets right
        assert.equal(nt.tickets, null);
        const to = await ok(ticketsOnly);
        assert.equal(to.devices, null);
        assert.equal(to.setup, null);
        const nothingAgain = await ok(nothing);
        assert.equal(nothingAgain.tickets, null);
        assert.equal(nothingAgain.devices, null);
    });

    await test("another organisation never sees this organisation's numbers, and the cache does not mix them", async () => {
        const org2 = (await q(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`, [`${tag} Other org`, `${tag.toLowerCase()}-other`])).rows[0].id;
        orgs2.push(org2);
        const client2 = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org2, `${tag} Other customer`])).rows[0].id;
        const site2 = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'HQ') RETURNING id`, [client2])).rows[0].id;
        const d2 = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Windows 11') RETURNING id`, [site2, `${tag}-org2-dev`])).rows[0].id;
        devs.push(d2);
        await q(`INSERT INTO agents (device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,'9.9.9', now(), '{"os":"windows"}')`, [d2, uuid()]);
        const uid = uuid();
        const email = `db-org2-${uid}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E','org2','active','x')`, [uid, org2, email]);
        const role = uuid();
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [role, org2, `e2e-org2-${uid}`]);
        for (const p of ["devices.read", "alerts.read", "tickets.read", "audit.read"]) {
            await q(`INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES ($1,$1,'x','x') ON CONFLICT DO NOTHING`, [p]);
            await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role, p]);
        }
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [uid, role]);
        const jti = uuid();
        const crypto = require("node:crypto");
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, uid, crypto.createHash("sha256").update(jti).digest("hex")]);
        const jwt = require("jsonwebtoken");
        const other = { id: uid, token: jwt.sign({ sub: uid, email, jti }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
        made.users.push(uid); made.roles.push(role);
        orgs2.push({ user: uid, role });

        // a device with no site: the device list shows it to everyone, the dashboard counts it for the default organisation only
        const orphan = (await q(`INSERT INTO devices (hostname, operating_system) VALUES ($1,'Windows 11') RETURNING id`, [`${tag}-orphan`])).rows[0].id;
        devs.push(orphan);
        await sleep(TTL + 300);
        const mineFirst = await ok(boss);
        const theirs = await ok(other);
        // the device list is not split by organisation: its total is ours plus the other organisation's one device, and ours holds the orphan
        assert.equal(mineFirst.devices.total, (await (await call(`/api/devices/counts`, { token: boss.token })).json()).total - 1, "the orphan is in the default organisation's total");
        const mineAgain = await ok(boss);
        assert.equal(theirs.devices.total, 1, "only their own device");
        assert.equal(theirs.tickets.open, 0);
        assert.equal(theirs.alerts.open, 0);
        assert.equal(theirs.agents.versions.length, 1);
        assert.equal(theirs.agents.versions[0].version, "9.9.9");
        assert.equal(theirs.security.windowsDevices, 0, "security numbers are the default organisation's, so another organisation gets none of them");
        assert.equal(theirs.activity, null, "the audit log belongs to the default organisation");
        assert.deepEqual(mineFirst.devices, mineAgain.devices);
        assert.ok(mineFirst.devices.total >= 9);
        assert.ok(!mineAgain.agents.versions.some((v) => v.version === "9.9.9"));
        // and a customer of the other organisation asked for by this organisation's person finds nothing
        assert.equal((await ok(boss, `?clientId=${client2}`)).devices.total, 0);
    });

    // ---------- scale
    await test(`scale: ${N} devices answer quickly and the numbers match the database`, async () => {
        const clients = [];
        for (let i = 0; i < 20; i++) clients.push(await mkClient(`Scale ${i}`));
        // many sites per customer
        const siteIds = [];
        for (const cl of clients) for (let s = 0; s < 5; s++) siteIds.push((await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [cl.id, `site ${s}`])).rows[0].id);
        const t0 = Date.now();
        await q(`
            INSERT INTO devices (id, site_id, hostname, operating_system, update_ring)
            SELECT gen_random_uuid(), ($1::uuid[])[(1 + (g % ${siteIds.length}))::int], $2 || '-scale-' || g,
                   CASE WHEN g % 10 < 7 THEN 'Windows 11 Pro' WHEN g % 10 < 9 THEN 'Ubuntu 24.04' ELSE 'macOS 15' END,
                   CASE WHEN g % 50 = 0 THEN 'pilot' END
              FROM generate_series(1, ${N}) g`, [siteIds, tag]);
        await q(`
            INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts)
            SELECT gen_random_uuid(), d.id, gen_random_uuid()::text, '1.3.' || (25 + (row_number() OVER ()) % 7),
                   CASE WHEN (row_number() OVER ()) % 10 < 6 THEN now() - interval '1 minute' WHEN (row_number() OVER ()) % 10 < 9 THEN now() - interval '2 days' ELSE NULL END,
                   CASE WHEN d.operating_system LIKE 'Windows%' THEN '{"os":"windows"}'::jsonb WHEN d.operating_system LIKE 'Ubuntu%' THEN '{"os":"linux"}'::jsonb ELSE '{"os":"macos"}'::jsonb END
              FROM devices d WHERE d.hostname LIKE $1 || '-scale-%'`, [tag]);
        await q(`
            INSERT INTO device_security_scans (device_id, scanned_at, attempted_at, ok, score, grade, critical_failed, failed_rules)
            SELECT d.id, now(), now(), true, 30 + (row_number() OVER ()) % 70,
                   (ARRAY['A','B','C','D','F'])[1 + (row_number() OVER ()) % 5], (row_number() OVER ()) % 3, ARRAY['defender-off']
              FROM devices d WHERE d.hostname LIKE $1 || '-scale-%' AND d.operating_system LIKE 'Windows%'`, [tag]);
        await q(`
            INSERT INTO alerts (device_id, kind, dedupe_key, state, severity, title)
            SELECT d.id, 'check', gen_random_uuid()::text, 'OPEN', CASE WHEN (row_number() OVER ()) % 4 = 0 THEN 'CRIT' ELSE 'WARN' END, 'scale alert'
              FROM devices d WHERE d.hostname LIKE $1 || '-scale-%' AND d.hostname ~ '[05]$'`, [tag]);
        // patch scans for every Windows agent: some with missing updates, some with a restart
        await q(`
            INSERT INTO agent_tasks (id, agent_id, type, payload, status, queued_at)
            SELECT gen_random_uuid(), a.id, 'patch_scan', '{}', 'succeeded', now()
              FROM agents a JOIN devices d ON d.id = a.device_id WHERE d.hostname LIKE $1 || '-scale-%' AND d.operating_system LIKE 'Windows%'`, [tag]);
        await q(`
            INSERT INTO agent_task_runs (id, task_id, status, started_at, finished_at)
            SELECT gen_random_uuid(), t.id, 'succeeded', now(), now() - ((row_number() OVER ()) % 5 || ' hours')::interval
              FROM agent_tasks t JOIN agents a ON a.id = t.agent_id JOIN devices d ON d.id = a.device_id WHERE d.hostname LIKE $1 || '-scale-%' AND t.type = 'patch_scan'`, [tag]);
        await q(`
            INSERT INTO agent_task_results (run_id, artifacts)
            SELECT r.id, jsonb_build_object('patches', CASE WHEN (row_number() OVER ()) % 3 = 0 THEN '[{"id":"kb1","title":"x"}]'::jsonb ELSE '[]'::jsonb END, 'rebootRequired', (row_number() OVER ()) % 7 = 0)
              FROM agent_task_runs r JOIN agent_tasks t ON t.id = r.task_id JOIN agents a ON a.id = t.agent_id JOIN devices d ON d.id = a.device_id WHERE d.hostname LIKE $1 || '-scale-%' AND t.type = 'patch_scan'`, [tag]);
        await q(`
            INSERT INTO agent_outdated_software (agent_id, source, app_id, name, installed_version, available_version)
            SELECT a.id, 'winget', 'App.' || (row_number() OVER ()) % 40, 'App', '1', '2'
              FROM agents a JOIN devices d ON d.id = a.device_id WHERE d.hostname LIKE $1 || '-scale-%' AND d.operating_system LIKE 'Windows%' AND d.hostname ~ '[0-4]$'`, [tag]);
        await q(`
            INSERT INTO tickets (organization_id, ticket_number, subject, status, client_id)
            SELECT $1::uuid, (SELECT COALESCE(MAX(ticket_number), 0) FROM tickets WHERE organization_id = $1::uuid) + g, $2 || ' scale ticket', 'open', ($3::uuid[])[(1 + g % ${clients.length})::int]
              FROM generate_series(1, 2000) g`, [org, tag, clients.map((c) => c.id)]);
        console.log(`        seeded ${N} devices, scans, alerts, patch runs and 2000 tickets in ${Date.now() - t0} ms`);

        await sleep(TTL + 300);
        const t1 = Date.now();
        const cold = await ok(boss);
        const coldMs = Date.now() - t1;
        const t2 = Date.now();
        await ok(boss);
        const warmMs = Date.now() - t2;
        const t3 = Date.now();
        const lim = await ok(limited);
        const limMs = Date.now() - t3;
        console.log(`        cold ${coldMs} ms (all sections, ${cold.devices.total} devices), cached ${warmMs} ms, limited person ${limMs} ms`);
        assert.ok(coldMs < 5000, `the first answer took ${coldMs} ms`);
        assert.ok(warmMs < 1000, `the cached answer took ${warmMs} ms`);

        // numbers against the database, directly
        const own = clients.map((c) => c.id);
        const direct = (await q(`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE a.last_check_in_at > now() - interval '5 minutes')::int AS online
              FROM devices d JOIN sites s ON s.id = d.site_id JOIN agents a ON a.device_id = d.id WHERE s.client_id = ANY($1::uuid[])`, [own])).rows[0];
        const perCustomerTotals = [];
        for (const c of clients.slice(0, 3)) perCustomerTotals.push((await ok(boss, `?clientId=${c.id}`)).devices.total);
        const directPer = (await q(`SELECT s.client_id, count(*)::int AS n FROM devices d JOIN sites s ON s.id = d.site_id WHERE s.client_id = ANY($1::uuid[]) GROUP BY 1`, [clients.slice(0, 3).map((c) => c.id)])).rows;
        assert.deepEqual(perCustomerTotals, clients.slice(0, 3).map((c) => directPer.find((r) => r.client_id === c.id).n));
        assert.equal(direct.total, N);
        const sec = (await q(`
            SELECT count(*)::int AS n FROM device_security_scans s JOIN devices d ON d.id = s.device_id JOIN sites st ON st.id = d.site_id WHERE st.client_id = ANY($1::uuid[]) AND (s.grade = 'F' OR s.critical_failed > 0)`, [own])).rows[0].n;
        const pend = (await q(`
            SELECT count(*)::int AS n FROM agent_task_results res JOIN agent_task_runs r ON r.id = res.run_id JOIN agent_tasks t ON t.id = r.task_id JOIN agents a ON a.id = t.agent_id JOIN devices d ON d.id = a.device_id JOIN sites st ON st.id = d.site_id
             WHERE st.client_id = ANY($1::uuid[]) AND jsonb_array_length(res.artifacts->'patches') > 0`, [own])).rows[0].n;
        // the numbers of the whole install also hold our seed from before, so compare through per-customer sums
        let secSum = 0, pendSum = 0, devSum = 0, onlineSum = 0, alertOpen = 0;
        for (const c of clients) {
            const r = await ok(boss, `?clientId=${c.id}`);
            secSum += r.security.devicesNeedingAction; pendSum += r.patching.withPendingUpdates; devSum += r.devices.total; onlineSum += r.devices.online; alertOpen += r.alerts.open;
        }
        assert.equal(devSum, N);
        assert.equal(onlineSum, direct.online);
        assert.equal(secSum, sec);
        assert.equal(pendSum, pend);
        const alertsDirect = (await q(`SELECT count(*)::int AS n FROM alerts al JOIN devices d ON d.id = al.device_id JOIN sites st ON st.id = d.site_id WHERE st.client_id = ANY($1::uuid[]) AND al.state = 'OPEN'`, [own])).rows[0].n;
        assert.equal(alertOpen, alertsDirect);
        assert.equal(lim.devices.total, 6, "the limited person still sees only customer A");
        // every section in the busy answer is populated
        assert.ok(cold.devices.total >= N && cold.alerts.open > 0 && cold.security.windowsDevices > 0 && cold.patching.scanned > 0 && cold.agents.versions.length > 0 && cold.tickets.open >= 2000);
        assert.ok(cold.attention.length >= 4 && cold.attention.length <= 12);
    });

    await cleanupMine();
    finish();

    async function cleanupMine() {
        try {
            await q(`DELETE FROM ticket_visits WHERE organization_id = $1 AND title LIKE $2`, [org, `${tag}%`]);
            await q(`DELETE FROM ticket_sla WHERE ticket_id IN (SELECT id FROM tickets WHERE subject LIKE $1)`, [`${tag}%`]);
            await q(`DELETE FROM audit_events WHERE target_label LIKE $1`, [`${tag}%`]);
            await q(`DELETE FROM devices WHERE id = ANY($1::uuid[]) OR hostname LIKE $2`, [devs, `${tag}-%`]);
            await q(`DELETE FROM sites WHERE client_id = ANY($1::uuid[])`, [made.clients]);
            await q(`DELETE FROM user_client_access WHERE user_id = $1`, [limited.id]);
            await q(`DELETE FROM tickets WHERE subject LIKE $1`, [`${tag}%`]);
            for (const o of orgs2) if (typeof o === "string") {
                await q(`DELETE FROM sites WHERE client_id IN (SELECT id FROM clients WHERE organization_id = $1)`, [o]);
                await q(`DELETE FROM clients WHERE organization_id = $1`, [o]);
            }
            for (const o of orgs2) if (typeof o === "object") {
                await q(`DELETE FROM user_roles WHERE user_id = $1`, [o.user]);
                await q(`DELETE FROM sessions WHERE user_id = $1`, [o.user]);
                await q(`DELETE FROM users WHERE id = $1`, [o.user]);
                await q(`DELETE FROM role_permissions WHERE role_id = $1`, [o.role]);
                await q(`DELETE FROM roles WHERE id = $1`, [o.role]);
            }
            for (const o of orgs2) if (typeof o === "string") await q(`DELETE FROM organizations WHERE id = $1`, [o]);
        } catch (e) { console.log(`cleanup: ${e.message}`); }
        try { await cleanup(); } catch (e) { console.log(`cleanup: ${e.message}`); }
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
