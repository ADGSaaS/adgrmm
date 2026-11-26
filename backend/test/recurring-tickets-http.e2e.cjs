#!/usr/bin/env node
// Recurring tickets: the schedule arithmetic, then the real HTTP API and the in-process sweep (restart and double-run safety).
// The sweep runs every 30 seconds, so this test waits for it once.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... node test/recurring-tickets-http.e2e.cjs
"use strict";
const path = require("node:path");
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");
const sched = require(path.join(__dirname, "..", "dist", "recurring-tickets", "recurring-schedule.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rule = (o) => sched.checkRecurringRule({ time: "09:00", timezone: "UTC", ...o });
const iso = (d) => (d ? d.toISOString() : null);

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = Date.now();
    const tag = `RT${stamp}`;

    console.log("schedule arithmetic");
    await test("daily: the next time is today if it has not passed, else tomorrow", () => {
        const r = rule({ frequency: "daily" });
        assert.equal(iso(sched.nextRecurringRun(r, new Date("2026-11-13T08:00:00Z"))), "2026-11-13T09:00:00.000Z");
        assert.equal(iso(sched.nextRecurringRun(r, new Date("2026-11-13T09:00:00Z"))), "2026-11-14T09:00:00.000Z");
    });
    await test("weekly: chosen days only", () => {
        const r = rule({ frequency: "weekly", daysOfWeek: [1, 3] });
        const runs = sched.previewRecurringRuns(r, 4, new Date("2026-11-13T10:00:00Z")).map(iso); // 13 Nov 2026 is a Friday
        assert.deepEqual(runs, ["2026-11-16T09:00:00.000Z", "2026-11-18T09:00:00.000Z", "2026-11-23T09:00:00.000Z", "2026-11-25T09:00:00.000Z"]);
    });
    await test("monthly: the 31st falls on the last day of shorter months, and 'last day' always does", () => {
        const r31 = rule({ frequency: "monthly", dayOfMonth: 31 });
        assert.deepEqual(sched.previewRecurringRuns(r31, 4, new Date("2027-01-01T00:00:00Z")).map((d) => d.toISOString().slice(0, 10)), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
        const last = rule({ frequency: "monthly", dayOfMonth: -1 });
        assert.deepEqual(sched.previewRecurringRuns(last, 3, new Date("2028-01-15T00:00:00Z")).map((d) => d.toISOString().slice(0, 10)), ["2028-01-31", "2028-02-29", "2028-03-31"]);
    });
    await test("yearly: a month and a day, Feb 29 lands on Feb 28 in other years, Feb 30 is refused", () => {
        const r = rule({ frequency: "yearly", monthOfYear: 3, dayOfMonth: 15 });
        assert.deepEqual(sched.previewRecurringRuns(r, 3, new Date("2026-04-01T00:00:00Z")).map((d) => d.toISOString().slice(0, 10)), ["2027-03-15", "2028-03-15", "2029-03-15"]);
        const leap = rule({ frequency: "yearly", monthOfYear: 2, dayOfMonth: 29 });
        assert.deepEqual(sched.previewRecurringRuns(leap, 3, new Date("2027-01-01T00:00:00Z")).map((d) => d.toISOString().slice(0, 10)), ["2027-02-28", "2028-02-29", "2029-02-28"]);
        assert.throws(() => rule({ frequency: "yearly", monthOfYear: 2, dayOfMonth: 30 }), /no day 30/);
        assert.deepEqual(sched.previewRecurringRuns(rule({ frequency: "yearly", monthOfYear: 12, dayOfMonth: -1 }), 2, new Date("2026-01-01T00:00:00Z")).map((d) => d.toISOString().slice(0, 10)), ["2026-12-31", "2027-12-31"]);
    });
    await test("time zones and daylight saving: 09:00 in New York is 14:00 UTC in winter and 13:00 in summer", () => {
        const r = rule({ frequency: "daily", timezone: "America/New_York" });
        assert.equal(iso(sched.nextRecurringRun(r, new Date("2027-03-12T00:00:00Z"))), "2027-03-12T14:00:00.000Z");
        assert.equal(iso(sched.nextRecurringRun(r, new Date("2027-03-15T00:00:00Z"))), "2027-03-15T13:00:00.000Z");
        // a time that does not exist (02:30 on the spring forward day) still runs once that day
        const gap = rule({ frequency: "daily", timezone: "America/New_York", time: "02:30" });
        const day = sched.previewRecurringRuns(gap, 3, new Date("2027-03-13T12:00:00Z")).map(iso);
        assert.equal(day.length, 3);
        assert.ok(day[0].startsWith("2027-03-14"), day[0]);
        assert.ok(day[1].startsWith("2027-03-15"), day[1]);
    });
    await test("start and end dates: nothing before the start, nothing after the end", () => {
        const r = rule({ frequency: "daily", startDate: "2026-12-01", endDate: "2026-12-03" });
        assert.deepEqual(sched.previewRecurringRuns(r, 10, new Date("2026-11-13T00:00:00Z")).map((d) => d.toISOString().slice(0, 10)), ["2026-12-01", "2026-12-02", "2026-12-03"]);
        assert.equal(sched.nextRecurringRun(r, new Date("2026-12-03T10:00:00Z")), null);
        assert.throws(() => rule({ frequency: "daily", startDate: "2026-12-05", endDate: "2026-12-01" }), /before the start/);
        assert.throws(() => rule({ frequency: "daily", endDate: "2026-02-30" }), /not a real date/);
    });
    await test("bad rules are refused", () => {
        assert.throws(() => rule({ frequency: "hourly" }), /daily, weekly/);
        assert.throws(() => rule({ frequency: "weekly", daysOfWeek: [] }), /at least one day/);
        assert.throws(() => rule({ frequency: "weekly", daysOfWeek: [7] }), /at least one day/);
        assert.throws(() => rule({ frequency: "monthly", dayOfMonth: 32 }), /day of the month/);
        assert.throws(() => rule({ frequency: "daily", time: "25:00" }), /09:30/);
        assert.throws(() => rule({ frequency: "daily", timezone: "Mars/Base" }), /time zone/);
        assert.match(sched.describeRecurringRule(rule({ frequency: "weekly", daysOfWeek: [1, 2, 3, 4, 5] })), /Every weekday at 9:00 AM/);
        assert.match(sched.describeRecurringRule(rule({ frequency: "yearly", monthOfYear: 3, dayOfMonth: 15 })), /Every year on March 15/);
    });

    console.log("the API");
    const admin = await staffUser("rt-admin", ["tickets.read", "tickets.write", "settings.read", "settings.write", "devices.read"]);
    const reader = await staffUser("rt-reader", ["tickets.read"]);
    const nobody = await staffUser("rt-nobody", ["customers.read"]);
    const limited = await staffUser("rt-limited", ["tickets.read", "tickets.write", "settings.write", "devices.read"]);
    const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} Customer`])).rows[0].id;
    const other = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} Other`])).rows[0].id;
    made.clients.push(client, other);
    const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'Main office') RETURNING id`, [client])).rows[0].id;
    const otherSite = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'Elsewhere') RETURNING id`, [other])).rows[0].id;
    const device = (await q(`INSERT INTO devices (site_id, hostname) VALUES ($1,$2) RETURNING id`, [site, `${tag}-SRV`])).rows[0].id;
    const strange = (await q(`INSERT INTO devices (site_id, hostname) VALUES ($1,$2) RETURNING id`, [otherSite, `${tag}-OTHER`])).rows[0].id;
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, other]);
    await q(`DELETE FROM recurring_tickets WHERE name LIKE $1`, [`${tag}%`]);
    const tpl = (await q(`INSERT INTO ticket_templates (organization_id, name, subject, body, priority) VALUES ($1,$2,'Monthly check for {{customer}} - {{month}}','Run the checklist.{{date}}','high') RETURNING id`, [org, `${tag} template`])).rows[0].id;

    const post = (p, body, t = admin) => call(p, { method: "POST", token: t.token, body });
    const mk = async (extra = {}, t = admin) => {
        const r = await post("/api/recurring-tickets", { name: `${tag} ${Math.random().toString(36).slice(2, 8)}`, templateId: tpl, clientId: client, frequency: "daily", time: "09:00", timezone: "UTC", ...extra }, t);
        assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
        return r.json();
    };

    let s1;
    await test("a schedule is made from a template, with a next-run preview", async () => {
        s1 = await mk({ name: `${tag} monthly`, frequency: "monthly", dayOfMonth: -1, siteId: site, deviceId: device, assigneeUserId: admin.id, skipIfOpen: true });
        assert.equal(s1.enabled, true);
        assert.equal(s1.templateName, `${tag} template`);
        assert.equal(s1.clientName, `${tag} Customer`);
        assert.equal(s1.siteName, "Main office");
        assert.equal(s1.deviceName, `${tag}-SRV`);
        assert.match(s1.schedule, /The last day of every month at 9:00 AM \(UTC\)/);
        assert.equal(s1.nextRuns.length, 3);
        assert.ok(new Date(s1.nextRunAt) > new Date());
        assert.equal(s1.nextRunAt, s1.nextRuns[0]);
    });

    await test("the preview route shows the next times without saving anything", async () => {
        const r = await (await post("/api/recurring-tickets/preview", { frequency: "weekly", daysOfWeek: [1], time: "07:30", timezone: "Europe/London" }, reader)).json();
        assert.equal(r.runs.length, 5);
        assert.match(r.schedule, /Every Monday at 7:30 AM \(Europe\/London\)/);
        assert.equal((await post("/api/recurring-tickets/preview", { frequency: "weekly" }, reader)).status, 400);
    });

    await test("what is wrong is said: name, template or subject, customer, site, device, priority, schedule", async () => {
        const bad = async (extra, re) => {
            const r = await post("/api/recurring-tickets", { name: `${tag} bad`, templateId: tpl, clientId: client, frequency: "daily", ...extra });
            const j = await r.json();
            assert.equal(r.status, 400, JSON.stringify(j));
            assert.match(String(j.message), re);
        };
        await bad({ name: "" }, /name/);
        await bad({ templateId: undefined }, /template, or give the ticket a subject/);
        await bad({ templateId: uuid() }, /template does not exist/);
        await bad({ clientId: undefined }, /Choose the customer/);
        await bad({ clientId: uuid() }, /customer does not exist/);
        await bad({ siteId: otherSite }, /site does not belong/);
        await bad({ deviceId: strange }, /different customer/);
        await bad({ priority: "asap" }, /priority/);
        await bad({ assigneeUserId: uuid() }, /person does not exist/);
        await bad({ frequency: "weekly", daysOfWeek: [] }, /day of the week/);
        assert.equal((await post("/api/recurring-tickets", { name: s1.name, templateId: tpl, clientId: client, frequency: "daily" })).status, 400, "names are unique");
    });

    await test("who may do what", async () => {
        assert.equal((await call("/api/recurring-tickets", { token: reader.token })).status, 200);
        assert.equal((await call(`/api/recurring-tickets/${s1.id}`, { token: reader.token })).status, 200);
        assert.equal((await post("/api/recurring-tickets", { name: `${tag} x`, templateId: tpl, clientId: client, frequency: "daily" }, reader)).status, 403);
        assert.equal((await post(`/api/recurring-tickets/${s1.id}/run`, {}, reader)).status, 403);
        assert.equal((await post(`/api/recurring-tickets/${s1.id}/pause`, {}, reader)).status, 403);
        assert.equal((await call(`/api/recurring-tickets/${s1.id}`, { method: "DELETE", token: reader.token })).status, 403);
        assert.equal((await call("/api/recurring-tickets", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/recurring-tickets")).status, 401);
        // a person limited to another customer neither sees nor touches it
        const list = await json("/api/recurring-tickets", { token: limited.token });
        assert.ok(!list.items.some((s) => s.id === s1.id));
        assert.equal((await call(`/api/recurring-tickets/${s1.id}`, { token: limited.token })).status, 404);
        assert.equal((await post(`/api/recurring-tickets/${s1.id}/run`, {}, limited)).status, 404);
        assert.equal((await post("/api/recurring-tickets", { name: `${tag} lim`, templateId: tpl, clientId: client, frequency: "daily" }, limited)).status, 404);
    });

    let ticket1;
    await test("run now opens a ticket from the template: tokens filled, customer, site, priority, assignee, device, history", async () => {
        const before = s1.nextRunAt;
        const r = await (await post(`/api/recurring-tickets/${s1.id}/run`, {})).json();
        assert.equal(r.status, "created");
        ticket1 = r.ticketId;
        const t = await json(`/api/tickets/${ticket1}`, { token: admin.token });
        assert.match(t.title, new RegExp(`^Monthly check for ${tag} Customer - [A-Z][a-z]+ \\d{4}$`));
        assert.match(t.description, /Run the checklist\.\d{4}-\d{2}-\d{2}\n\nSite: Main office/);
        assert.equal(t.priority, "high");
        assert.equal(t.clientId, client);
        assert.equal(t.assigneeUserId, admin.id);
        assert.equal(t.deviceId, device);
        assert.equal(t.recurringId, s1.id);
        const devs = (await json(`/api/tickets/${ticket1}/devices`, { token: admin.token })).items;
        assert.deepEqual(devs.map((d) => d.id), [device]);
        const hist = (await json(`/api/tickets/${ticket1}/history`, { token: admin.token })).map((h) => h.what);
        assert.ok(hist.includes(`Opened by the recurring ticket "${s1.name}"`), hist.join(" | "));
        const after = await json(`/api/recurring-tickets/${s1.id}`, { token: admin.token });
        assert.equal(after.nextRunAt, before, "a run now is an extra: the schedule is not moved");
        assert.equal(after.lastStatus, "created");
        assert.equal(after.openTickets, 1);
    });

    await test("run now is not held back by an open ticket; the run history lists both with links", async () => {
        const r = await (await post(`/api/recurring-tickets/${s1.id}/run`, {})).json();
        assert.equal(r.status, "created");
        assert.notEqual(r.ticketId, ticket1);
        const runs = (await json(`/api/recurring-tickets/${s1.id}/runs`, { token: reader.token })).items;
        assert.equal(runs.length, 2);
        assert.ok(runs.every((x) => x.status === "created" && x.trigger === "manual" && x.ticket?.number > 0 && x.ticket.title));
        const byRecurring = await json(`/api/tickets?recurringId=${s1.id}`, { token: admin.token });
        assert.equal(byRecurring.length, 2);
    });

    await test("pause stops it, resume starts it from now without catching up, editing moves the next time", async () => {
        const paused = await (await post(`/api/recurring-tickets/${s1.id}/pause`, {})).json();
        assert.equal(paused.enabled, false);
        assert.equal(paused.nextRunAt, null);
        assert.deepEqual(paused.nextRuns, []);
        // pretend it was paused a long time: the old time is in the past
        await q(`UPDATE recurring_tickets SET next_run_at = now() - interval '30 days' WHERE id = $1`, [s1.id]);
        const resumed = await (await post(`/api/recurring-tickets/${s1.id}/resume`, {})).json();
        assert.equal(resumed.enabled, true);
        assert.ok(new Date(resumed.nextRunAt) > new Date(), "no catching up");
        const edited = await (await call(`/api/recurring-tickets/${s1.id}`, { method: "PATCH", token: admin.token, body: { frequency: "weekly", daysOfWeek: [2], time: "06:15", timezone: "Asia/Tokyo" } })).json();
        assert.match(edited.schedule, /Every Tuesday at 6:15 AM \(Asia\/Tokyo\)/);
        assert.equal(edited.nextRuns.length, 3);
        assert.equal(edited.name, s1.name, "what was not sent is kept");
        assert.equal((await call(`/api/recurring-tickets/${s1.id}`, { method: "PATCH", token: admin.token, body: { clientId: other } })).status, 400, "the site and device belong to the old customer");
    });

    console.log("the sweep (restart and double-run safety)");
    const overdue = async (name, extra = {}) => {
        const s = await mk({ name: `${tag} ${name}`, ...extra });
        const due = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 1000));
        await q(`UPDATE recurring_tickets SET next_run_at = $2 WHERE id = $1`, [s.id, due]);
        return { ...s, due };
    };
    const countTickets = async (id) => (await q(`SELECT count(*)::int AS n FROM tickets WHERE recurring_id = $1`, [id])).rows[0].n;
    const runRows = async (id) => (await q(`SELECT run_key, status, ticket_id, trigger FROM recurring_ticket_runs WHERE recurring_id = $1 ORDER BY created_at`, [id])).rows;
    const keyOf = (d) => `p:${d.toISOString()}`;

    await test("the unique run key refuses a second row for the same period", async () => {
        const s = await mk({ name: `${tag} unique` });
        const ins = () => q(`INSERT INTO recurring_ticket_runs (recurring_id, run_key, scheduled_for) VALUES ($1,'p:x',now())`, [s.id]);
        await ins();
        await assert.rejects(ins, /duplicate key|unique/);
    });

    const S1 = await overdue("normal");
    const S2 = await overdue("already done by another process");
    await q(`INSERT INTO recurring_ticket_runs (recurring_id, run_key, scheduled_for, status, ticket_id, finished_at) VALUES ($1,$2,$3,'created',NULL,now())`, [S2.id, keyOf(S2.due), S2.due]);
    const S3 = await overdue("interrupted before the ticket");
    await q(`INSERT INTO recurring_ticket_runs (recurring_id, run_key, scheduled_for, status, created_at) VALUES ($1,$2,$3,'pending', now() - interval '10 minutes')`, [S3.id, keyOf(S3.due), S3.due]);
    const S4 = await overdue("interrupted after the ticket");
    await q(`INSERT INTO recurring_ticket_runs (recurring_id, run_key, scheduled_for, status, created_at) VALUES ($1,$2,$3,'pending', now() - interval '10 minutes')`, [S4.id, keyOf(S4.due), S4.due]);
    const ticketS4 = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject, client_id, recurring_id, created_at) VALUES ($1,(SELECT COALESCE(MAX(ticket_number),0)+1 FROM tickets WHERE organization_id=$1),$2,$3,$4, now() - interval '9 minutes') RETURNING id`, [org, `${tag} left behind`, client, S4.id])).rows[0].id;
    const S5 = await overdue("previous still open", { skipIfOpen: true });
    const openOne = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject, client_id, recurring_id, status) VALUES ($1,(SELECT COALESCE(MAX(ticket_number),0)+1 FROM tickets WHERE organization_id=$1),$2,$3,$4,'open') RETURNING id, ticket_number`, [org, `${tag} still open`, client, S5.id])).rows[0];
    const S6 = await overdue("another process is on it right now");
    await q(`INSERT INTO recurring_ticket_runs (recurring_id, run_key, scheduled_for, status) VALUES ($1,$2,$3,'pending')`, [S6.id, keyOf(S6.due), S6.due]);
    const S7 = await overdue("last one");
    // its end date was yesterday, so the period that is due now is its last
    await q(`UPDATE recurring_tickets SET end_date = (now() AT TIME ZONE 'UTC')::date - 1, enabled = true WHERE id = $1`, [S7.id]);
    const S8 = await overdue("template gone");
    // S8 shares the template with the others: give it its own so deleting it does not break them
    const own = (await q(`INSERT INTO ticket_templates (organization_id, name, subject) VALUES ($1,$2,'Own') RETURNING id`, [org, `${tag} own template`])).rows[0].id;
    await q(`UPDATE recurring_tickets SET template_id = $2 WHERE id = $1`, [S8.id, own]);
    await q(`DELETE FROM ticket_templates WHERE id = $1`, [own]);
    const tplRow = (await q(`SELECT id FROM ticket_templates WHERE id = $1`, [tpl])).rowCount;
    assert.equal(tplRow, 1);

    // The sweep runs every 30 seconds in the server: wait for it to have handled everything that is due.
    const settled = async () => {
        const left = (await q(`SELECT count(*)::int AS n FROM recurring_tickets WHERE id = ANY($1::uuid[]) AND next_run_at <= now()`, [[S1, S2, S3, S4, S5, S7, S8].map((s) => s.id)])).rows[0].n;
        return left === 0;
    };
    for (let i = 0; i < 50 && !(await settled()); i++) await sleep(2000);

    await test("a due schedule opens exactly one ticket and moves on to its next time", async () => {
        assert.equal(await countTickets(S1.id), 1);
        const row = (await q(`SELECT next_run_at, last_status FROM recurring_tickets WHERE id = $1`, [S1.id])).rows[0];
        assert.ok(row.next_run_at > new Date());
        assert.equal(row.last_status, "created");
        const runs = await runRows(S1.id);
        assert.deepEqual(runs.map((r) => [r.run_key, r.status, r.trigger]), [[keyOf(S1.due), "created", "scheduled"]]);
        assert.ok(runs[0].ticket_id);
    });
    await test("a period another process already handled is not opened again", async () => {
        assert.equal(await countTickets(S2.id), 0);
        assert.equal((await runRows(S2.id)).length, 1);
        assert.ok((await q(`SELECT next_run_at FROM recurring_tickets WHERE id = $1`, [S2.id])).rows[0].next_run_at > new Date(), "but it moves on");
    });
    await test("a run interrupted before its ticket is picked up again, once", async () => {
        assert.equal(await countTickets(S3.id), 1);
        const runs = await runRows(S3.id);
        assert.equal(runs.length, 1);
        assert.equal(runs[0].status, "created");
        assert.ok(runs[0].ticket_id);
    });
    await test("a run interrupted after its ticket was made finds that ticket instead of opening another", async () => {
        assert.equal(await countTickets(S4.id), 1);
        const runs = await runRows(S4.id);
        assert.equal(runs.length, 1);
        assert.equal(runs[0].status, "created");
        assert.equal(runs[0].ticket_id, ticketS4);
    });
    await test("skip if the previous one is still open: the run is recorded as skipped with the reason", async () => {
        assert.equal(await countTickets(S5.id), 1, "only the open one");
        const runs = await runRows(S5.id);
        assert.deepEqual(runs.map((r) => r.status), ["skipped"]);
        const why = (await json(`/api/recurring-tickets/${S5.id}/runs`, { token: admin.token })).items[0];
        assert.match(why.error, new RegExp(`#${openOne.ticket_number} from the previous run is still open`));
        // close it: the next period is opened normally
        await q(`UPDATE tickets SET status = 'closed' WHERE id = $1`, [openOne.id]);
    });
    await test("a run that another process is still working on is left alone", async () => {
        assert.equal(await countTickets(S6.id), 0);
        const row = (await q(`SELECT next_run_at FROM recurring_tickets WHERE id = $1`, [S6.id])).rows[0];
        assert.ok(row.next_run_at <= new Date(), "not moved on yet");
    });
    await test("the end date: after the last ticket the schedule switches itself off", async () => {
        assert.equal(await countTickets(S7.id), 1);
        const row = (await q(`SELECT enabled, next_run_at FROM recurring_tickets WHERE id = $1`, [S7.id])).rows[0];
        assert.equal(row.enabled, false);
        assert.equal(row.next_run_at, null);
        const api = await json(`/api/recurring-tickets/${S7.id}`, { token: admin.token });
        assert.equal(api.finished, true);
        assert.equal((await post(`/api/recurring-tickets/${S7.id}/resume`, {})).status, 400);
    });
    await test("a failure is recorded with its reason and does not stop the schedule", async () => {
        assert.equal(await countTickets(S8.id), 0);
        const api = await json(`/api/recurring-tickets/${S8.id}`, { token: admin.token });
        assert.equal(api.lastStatus, "failed");
        assert.match(api.lastError, /no ticket template and no subject/);
        const runs = (await json(`/api/recurring-tickets/${S8.id}/runs`, { token: admin.token })).items;
        assert.equal(runs[0].status, "failed");
        assert.ok(new Date(api.nextRunAt) > new Date());
    });
    await test("the next sweep does nothing more for schedules that are not due", async () => {
        const before = await countTickets(S1.id);
        await sleep(32_000);
        assert.equal(await countTickets(S1.id), before);
        assert.equal((await runRows(S1.id)).length, 1);
    });

    await test("deleting a schedule keeps the tickets it opened", async () => {
        assert.equal((await call(`/api/recurring-tickets/${S1.id}`, { method: "DELETE", token: admin.token })).status, 200);
        assert.equal((await call(`/api/recurring-tickets/${S1.id}`, { token: admin.token })).status, 404);
        const t = (await q(`SELECT id, recurring_id FROM tickets WHERE subject LIKE $1`, [`Monthly check for ${tag}%`])).rows;
        assert.ok(t.length >= 1);
        assert.ok(t.every((x) => x.recurring_id === null || x.recurring_id !== S1.id));
    });

    await test("audit: schedule changes and runs are recorded", async () => {
        const rows = (await q(`SELECT action FROM audit_events WHERE action LIKE 'recurring_ticket.%' AND created_at > now() - interval '30 minutes'`)).rows.map((r) => r.action);
        for (const a of ["recurring_ticket.create", "recurring_ticket.update", "recurring_ticket.pause", "recurring_ticket.resume", "recurring_ticket.run_now", "recurring_ticket.delete", "recurring_ticket.run"]) assert.ok(rows.includes(a), `${a} in ${[...new Set(rows)].join(",")}`);
    });

    await q(`DELETE FROM tickets WHERE client_id = ANY($1::uuid[])`, [[client, other]]);
    await q(`DELETE FROM recurring_tickets WHERE name LIKE $1`, [`${tag}%`]);
    await q(`DELETE FROM ticket_templates WHERE name LIKE $1`, [`${tag}%`]);
    await q(`DELETE FROM user_client_access WHERE user_id = $1`, [limited.id]);
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
