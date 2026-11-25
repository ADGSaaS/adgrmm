#!/usr/bin/env node
// SLAs, queues and routing rules through the real HTTP API: calendars and policies, a policy per customer or queue,
// the clocks on a ticket (pause, resume, priority change, first reply, resolve and reopen), the periodic check with its
// warnings, breaches and escalation, tickets from the form, email, the portal and an alert, round-robin assignment,
// routing rules in order, the list filters and counts, customers limited to some tickets, the Tickets and SLA report and
// the audit log. Throwaway backend and database only (name contains "e2e"):
//
//   . scratchpad/p3a-env.sh; node test/service-desk-http.e2e.cjs     (DIST points at the build the in-process parts use)
"use strict";
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

const dist = (p) => require(path.join(__dirname, "..", process.env.DIST || "dist", p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = Date.now();
    const all = ["settings.read", "settings.write", "customers.read", "customers.write", "tickets.read", "tickets.write", "audit.read", "reports.read", "devices.read", "alerts.read", "alerts.manage"];
    const admin = await staffUser("sd-admin", all);
    const t1 = await staffUser("sd-tech1", ["tickets.read", "tickets.write"]);
    const t2 = await staffUser("sd-tech2", ["tickets.read", "tickets.write"]);
    const t3 = await staffUser("sd-tech3", ["tickets.read", "tickets.write"]);
    const reader = await staffUser("sd-reader", ["tickets.read"]);
    const noTickets = await staffUser("sd-none", ["customers.read"]);
    const mkClient = async (name) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${name} ${stamp}`])).rows[0].id;
        made.clients.push(id);
        const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'Main') RETURNING id`, [id])).rows[0].id;
        return { id, site, name: `${name} ${stamp}` };
    };
    const A = await mkClient("SD Alpha");
    const B = await mkClient("SD Beta");

    // A clean slate for this run (the database is this test's own).
    await q(`DELETE FROM tickets WHERE subject LIKE 'SD %'`);
    await q(`DELETE FROM sla_policies`);
    await q(`DELETE FROM sla_calendars`);
    await q(`DELETE FROM ticket_routing_rules`);
    await q(`DELETE FROM ticket_queues`);

    const post = (p, body, who = admin) => call(p, { method: "POST", token: who.token, body });
    const patch = (p, body, who = admin) => call(p, { method: "PATCH", token: who.token, body });
    const get = (p, who = admin) => json(p, { token: who.token });
    const mkTicket = async (subject, body = {}, who = admin) => {
        const res = await post("/api/tickets", { subject: `SD ${subject}`, ...body }, who);
        assert.equal(res.status, 201, `create ticket: ${res.status} ${await res.clone().text()}`);
        const { id } = await res.json();
        made.tickets = [...(made.tickets ?? []), id];
        return id;
    };
    const one = (id, who = admin) => get(`/api/tickets/${id}`, who);
    const wait = async (fn, ms = 8000) => {
        const end = Date.now() + ms;
        for (;;) {
            const v = await fn();
            if (v) return v;
            if (Date.now() > end) throw new Error("timed out waiting");
            await sleep(150);
        }
    };
    const targets = (o = {}) => ({ low: { response: 480, resolution: 4320 }, medium: { response: 60, resolution: 480 }, high: { response: 30, resolution: 240 }, urgent: { response: 10, resolution: 60 }, ...o });

    // ------------------------------------------------------------------ rights and checks
    console.log("calendars and policies");
    let cal24, calBiz, std, gold;
    await test("only people with the settings right change SLA settings; reading needs the settings read right", async () => {
        for (const p of ["/api/sla/policies", "/api/sla/calendars", "/api/sla/clients", "/api/ticket-routing-rules"]) {
            assert.equal((await call(p, { token: t1.token })).status, 403, p);
            assert.equal((await call(p)).status, 401, p);
        }
        assert.equal((await post("/api/sla/policies", { name: "x", targets: targets() }, t1)).status, 403);
        assert.equal((await post("/api/ticket-queues", { name: "x" }, t1)).status, 403);
        assert.equal((await post("/api/ticket-routing-rules", {}, t1)).status, 403);
        assert.equal((await call("/api/sla/run", { method: "POST", token: t1.token })).status, 403);
        // queues are readable by anyone who reads tickets, and not by people who cannot
        assert.equal((await call("/api/ticket-queues", { token: reader.token })).status, 200);
        assert.equal((await call("/api/ticket-queues", { token: noTickets.token })).status, 403);
    });
    await test("a calendar has a time zone, working days and hours, and holidays, all checked", async () => {
        const d = await get("/api/sla/calendars/defaults");
        assert.ok(d.timezone && d.days.length && d.start && d.end);
        calBiz = await (await post("/api/sla/calendars", { name: "Office hours", timezone: "America/New_York", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", holidays: [{ date: "2026-12-25", name: "Christmas Day" }] })).json();
        assert.equal(calBiz.holidays[0].date, "2026-12-25");
        assert.equal(calBiz.end, "17:30");
        assert.equal((await post("/api/sla/calendars", { name: "office HOURS", timezone: "UTC", days: [1], start: "09:00", end: "10:00" })).status, 409);
        const bad = (o) => post("/api/sla/calendars", { name: `bad ${Math.random()}`, timezone: "UTC", days: [1], start: "09:00", end: "17:00", ...o });
        assert.equal((await bad({ timezone: "Mars/Base" })).status, 400);
        assert.equal((await bad({ days: [] })).status, 400);
        assert.equal((await bad({ end: "08:00" })).status, 400);
        assert.equal((await bad({ holidays: [{ date: "2026-13-01" }] })).status, 400);
        assert.equal((await bad({ name: "" })).status, 400);
        cal24 = await (await post("/api/sla/calendars", { name: "Every day, all day", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00" })).json();
        assert.equal(cal24.end, "24:00");
    });
    await test("a policy has targets by priority, a calendar (or around the clock), pause statuses and a warning point, all checked", async () => {
        const bad = (o) => post("/api/sla/policies", { name: `bad ${Math.random()}`, targets: targets(), ...o });
        assert.equal((await bad({ targets: {} })).status, 400);
        assert.equal((await bad({ targets: targets({ high: { response: 0, resolution: 10 } }) })).status, 400);
        assert.equal((await bad({ targets: targets({ high: { response: 90, resolution: 60 } }) })).status, 400); // response longer than resolution
        assert.equal((await bad({ targets: targets({ high: { response: 1.5, resolution: 60 } }) })).status, 400);
        assert.equal((await bad({ warnPercent: 100 })).status, 400);
        assert.equal((await bad({ warnPercent: 0 })).status, 400);
        assert.equal((await bad({ pauseStatuses: ["closed"] })).status, 400);
        assert.equal((await bad({ calendarId: uuid() })).status, 400);
        assert.equal((await bad({ escalation: { warning: { users: [uuid()] } } })).status, 400);
        assert.equal((await bad({ escalation: { breach: { users: ["nope"] } } })).status, 400);
        std = await (await post("/api/sla/policies", { name: "Standard", targets: targets(), calendarId: cal24.id })).json();
        assert.equal(std.isDefault, true, "the first policy is the default");
        assert.equal(std.warnPercent, 80);
        assert.deepEqual(std.pauseStatuses, ["pending"]);
        assert.equal(std.targets.high.response, 30);
        assert.equal(std.calendarName, "Every day, all day");
        assert.equal((await post("/api/sla/policies", { name: "standard", targets: targets() })).status, 409);
        gold = await (await post("/api/sla/policies", { name: "Gold", targets: targets({ medium: { response: 15, resolution: 120 } }), warnPercent: 50 })).json();
        assert.equal(gold.isDefault, false);
        assert.equal(gold.calendarId, null);
        const list = (await get("/api/sla/policies")).items;
        assert.deepEqual(list.map((p) => p.name), ["Standard", "Gold"]);
    });
    await test("a calendar in use cannot be deleted; there is one default policy at a time", async () => {
        const res = await call(`/api/sla/calendars/${cal24.id}`, { method: "DELETE", token: admin.token });
        assert.equal(res.status, 409);
        assert.match((await res.json()).message, /1 policy uses this calendar/);
        assert.equal((await patch(`/api/sla/policies/${gold.id}`, { isDefault: true })).status, 200);
        assert.deepEqual((await get("/api/sla/policies")).items.map((p) => [p.name, p.isDefault]), [["Gold", true], ["Standard", false]]);
        assert.equal((await patch(`/api/sla/policies/${std.id}`, { isDefault: true })).status, 200);
        assert.equal((await q(`SELECT count(*)::int AS n FROM sla_policies WHERE is_default`)).rows[0].n, 1);
    });

    console.log("queues and a policy per customer");
    let qSupport, qProjects, qRR;
    await test("queues are made with a name and how they hand out tickets, all checked", async () => {
        assert.equal((await post("/api/ticket-queues", { name: "" })).status, 400);
        assert.equal((await post("/api/ticket-queues", { name: "Bad", assignment: "user" })).status, 400); // needs a person
        assert.equal((await post("/api/ticket-queues", { name: "Bad", assignment: "round_robin" })).status, 400); // needs a pool
        assert.equal((await post("/api/ticket-queues", { name: "Bad", assignment: "user", defaultAssigneeUserId: uuid() })).status, 400);
        assert.equal((await post("/api/ticket-queues", { name: "Bad", defaultSlaPolicyId: uuid() })).status, 400);
        qSupport = await (await post("/api/ticket-queues", { name: "Support", assignment: "user", defaultAssigneeUserId: t1.id, defaultSlaPolicyId: gold.id })).json();
        qProjects = await (await post("/api/ticket-queues", { name: "Projects" })).json();
        qRR = await (await post("/api/ticket-queues", { name: "Round robin", assignment: "round_robin", poolUserIds: [t1.id, t2.id, t3.id] })).json();
        assert.equal(qSupport.assignment, "user");
        assert.equal((await post("/api/ticket-queues", { name: "support" })).status, 409);
        const names = (await get("/api/ticket-queues", reader)).items.map((x) => x.name);
        assert.deepEqual(names, ["Projects", "Round robin", "Support"]);
    });
    await test("a customer can have a policy of its own, and goes back to the default when it is taken away", async () => {
        assert.equal((await call(`/api/sla/clients/${A.id}`, { method: "PUT", token: t1.token, body: { policyId: gold.id } })).status, 403);
        assert.equal((await call(`/api/sla/clients/${uuid()}`, { method: "PUT", token: admin.token, body: { policyId: gold.id } })).status, 404);
        assert.equal((await call(`/api/sla/clients/${A.id}`, { method: "PUT", token: admin.token, body: { policyId: uuid() } })).status, 404);
        assert.equal((await call(`/api/sla/clients/${A.id}`, { method: "PUT", token: admin.token, body: { policyId: gold.id } })).status, 200);
        const list = (await get("/api/sla/clients")).items;
        assert.deepEqual(list.map((x) => [x.clientName, x.policyName]), [[A.name, "Gold"]]);
        assert.equal((await get("/api/sla/policies")).items.find((p) => p.id === gold.id).customers, 1);
    });

    console.log("the clocks of a ticket");
    let tkA, tkB;
    await test("a customer's own policy wins, then the queue's, then the default; each takes the targets of the priority", async () => {
        tkA = await mkTicket("customer with its own policy", { clientId: A.id, priority: "medium" });
        const a = await one(tkA);
        assert.equal(a.sla.policy, "Gold");
        assert.equal(a.sla.resolution.targetMinutes, 120);
        assert.equal(a.sla.response.targetMinutes, 15);
        assert.equal(a.queueId, null);
        tkB = await mkTicket("customer on the default", { clientId: B.id, priority: "medium" });
        const b = await one(tkB);
        assert.equal(b.sla.policy, "Standard");
        assert.equal(b.sla.resolution.targetMinutes, 480);
        // due = opened + target, in a calendar open round the clock
        const due = new Date(b.sla.resolution.dueAt).getTime() - new Date(b.createdAt).getTime();
        assert.ok(Math.abs(due - 480 * MIN) < 5000, `due ${due}`);
        assert.ok(b.sla.response.state === "met", "a ticket staff open themselves counts as acknowledged");
        // a queue with its own policy, for a customer with none of its own
        const c = await mkTicket("in the support queue", { clientId: B.id, queueId: qSupport.id, priority: "medium" });
        const cv = await one(c);
        assert.equal(cv.sla.policy, "Gold");
        assert.equal(cv.queueName, "Support");
        assert.equal(cv.assigneeUserId, t1.id, "a queue that has a default person gives the ticket to them");
        // a ticket given a person on the form keeps that person
        const d = await mkTicket("queue but chosen assignee", { clientId: B.id, queueId: qSupport.id, assigneeUserId: t2.id });
        assert.equal((await one(d)).assigneeUserId, t2.id);
    });
    await test("the ticket list and the ticket page carry the clocks, and portal tickets are not touched (checked below)", async () => {
        const list = await get(`/api/tickets?pageSize=200`);
        const row = list.find((t) => t.id === tkB);
        assert.equal(row.sla.policy, "Standard");
        assert.ok(["ok", "met"].includes(row.sla.level));
        assert.equal(typeof row.sla.resolution.remainingMs, "number");
        assert.equal(row.createdVia, "ui");
    });
    await test("a priority change moves the due time", async () => {
        const before = await one(tkB);
        assert.equal((await patch(`/api/tickets/${tkB}`, { priority: "urgent" })).status, 200);
        const after = await one(tkB);
        assert.equal(after.sla.resolution.targetMinutes, 60);
        assert.ok(new Date(after.sla.resolution.dueAt).getTime() < new Date(before.sla.resolution.dueAt).getTime() - 300 * MIN);
        assert.equal((await patch(`/api/tickets/${tkB}`, { priority: "medium" })).status, 200);
        assert.equal((await one(tkB)).sla.resolution.targetMinutes, 480);
    });
    await test("waiting on the customer stops the clock, and the due time moves by the wait when it starts again", async () => {
        const t = await mkTicket("pause and resume", { clientId: B.id });
        const before = await one(t);
        assert.equal((await patch(`/api/tickets/${t}`, { status: "pending" })).status, 200);
        const paused = await one(t);
        assert.equal(paused.status, "pending");
        assert.equal(paused.sla.paused, true);
        assert.equal(paused.sla.resolution.state, "paused");
        assert.equal(paused.sla.resolution.dueAt, null);
        assert.equal(paused.sla.level, "paused");
        assert.ok(paused.sla.resolution.remainingMs > 479 * MIN - 5000);
        await sleep(2200);
        assert.equal((await patch(`/api/tickets/${t}`, { status: "open" })).status, 200);
        const resumed = await one(t);
        assert.equal(resumed.sla.paused, false);
        const shift = new Date(resumed.sla.resolution.dueAt).getTime() - new Date(before.sla.resolution.dueAt).getTime();
        assert.ok(shift >= 2000 && shift < 8000, `due moved by ${shift} ms`);
        // the same through the list filter
        assert.equal((await patch(`/api/tickets/${t}`, { status: "pending" })).status, 200);
        assert.ok((await get(`/api/tickets?sla=paused&pageSize=200`)).some((x) => x.id === t));
        assert.ok(!(await get(`/api/tickets?sla=ok&pageSize=200`)).some((x) => x.id === t));
        assert.ok((await get(`/api/tickets?status=pending&pageSize=200`)).some((x) => x.id === t));
    });
    await test("resolving finishes the clock as met, reopening starts it again", async () => {
        const t = await mkTicket("resolve and reopen", { clientId: B.id });
        assert.equal((await patch(`/api/tickets/${t}`, { status: "resolved" })).status, 200);
        const done = await one(t);
        assert.equal(done.sla.resolution.state, "met");
        assert.equal(done.sla.resolution.met, true);
        assert.equal(done.sla.level, "met");
        assert.equal((await patch(`/api/tickets/${t}`, { status: "open" })).status, 200);
        const back = await one(t);
        assert.equal(back.sla.resolution.state, "running");
        assert.equal(back.sla.resolution.doneAt, null);
        assert.ok(back.sla.resolution.dueAt);
    });

    console.log("tickets from email, the portal and an alert");
    let mailTicket, portalTicket;
    await test("an email opens a ticket that is routed and has running clocks until a technician answers", async () => {
        const { PrismaService } = dist("storage/prisma.service.js");
        const { SupportMailboxService } = dist("support-mailbox/support-mailbox.service.js");
        const { ServiceDeskService } = dist("service-desk/service-desk.service.js");
        const { SlaService } = dist("service-desk/sla.service.js");
        const { QueuesService } = dist("service-desk/queues.service.js");
        const { RoutingService } = dist("service-desk/routing.service.js");
        const prisma = new PrismaService();
        const hooks = { emitTicket: async () => {} };
        const queues = new QueuesService(prisma);
        const desk = new ServiceDeskService(new SlaService(prisma, hooks, { sendPlain: async () => ({ ok: true }) }), new RoutingService(prisma, queues));
        const mailbox = new SupportMailboxService(prisma, { getAllRaw: async () => ({}) }, { sendPlain: async () => ({ ok: true }) }, hooks, desk);
        // a rule for mail from one domain
        const rule = await (await post("/api/ticket-routing-rules", { name: "Mail from vip.test", conditions: [{ field: "sender_domain", values: ["vip.test"] }, { field: "source", values: ["email"] }], actions: { queueId: qProjects.id, priority: "high" } })).json();
        assert.ok(rule.id);
        const raw = (from, subject, id) => Buffer.from(`From: Pat <${from}>\r\nTo: support@msp.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@${stamp}.test>\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nSomething is broken.\r\n`);
        const r = await mailbox.processRaw({ organization_id: org, mailbox_address: "support@msp.test" }, raw(`pat${stamp}@vip.test`, `SD VIP mail ${stamp}`, "vip"), new Date());
        assert.equal(r.action, "ticket");
        mailTicket = r.ticketId;
        made.tickets = [...(made.tickets ?? []), mailTicket];
        const t = await one(mailTicket);
        assert.equal(t.createdVia, "email");
        assert.equal(t.queueName, "Projects");
        assert.equal(t.priority, "high");
        assert.equal(t.sla.policy, "Standard");
        assert.equal(t.sla.response.state, "running");
        assert.equal(t.sla.response.targetMinutes, 30);
        // another sender goes nowhere special
        const r2 = await mailbox.processRaw({ organization_id: org, mailbox_address: "support@msp.test" }, raw(`pat${stamp}@other.test`, `SD other mail ${stamp}`, "other"), new Date());
        made.tickets.push(r2.ticketId);
        const t2x = await one(r2.ticketId);
        assert.equal(t2x.queueId, null);
        assert.equal(t2x.priority, "medium");
        assert.equal(t2x.sla.response.state, "running");
        await prisma.$disconnect();
        // the first reply stops the response clock
        assert.equal((await post(`/api/tickets/${mailTicket}/reply`, { body: "On it." })).status, 201);
        const answered = await one(mailTicket);
        assert.equal(answered.sla.response.state, "met");
        assert.equal(answered.sla.response.met, true);
        assert.equal(answered.sla.resolution.state, "running");
        await q(`DELETE FROM ticket_routing_rules WHERE id = $1`, [rule.id]);
    });
    await test("a ticket opened in the client portal is routed and timed, and the portal shows nothing about it", async () => {
        const stampP = `${stamp}p`;
        const PASS = "correct horse battery";
        const email = `portal-${stampP}@sdalpha.example.test`;
        const acc = (await q(`INSERT INTO portal_accounts (organization_id, client_id, email, name, role, status, password_hash) VALUES ($1,$2,$3,'Portal Pat','manager','active',$4) RETURNING id`, [org, B.id, email, await bcrypt.hash(PASS, 4)])).rows[0].id;
        await q(`DELETE FROM portal_settings`);
        const set = await call("/api/portal-admin/settings", { method: "PUT", token: admin.token, body: { enabled: true, domain: `sd-${stampP}.example.test` } });
        assert.equal(set.status, 200, await set.clone().text());
        const rule = await (await post("/api/ticket-routing-rules", { name: "Portal tickets", conditions: [{ field: "source", values: ["portal"] }], actions: { queueId: qProjects.id, assignee: t3.id } })).json();
        const login = await call("/api/portal/auth/login", { method: "POST", body: { email, password: PASS } });
        assert.equal(login.status, 200, await login.clone().text());
        const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.match(/^portal_token=([^;]*)/)?.[1]).find((v) => v !== undefined);
        const made1 = await call("/api/portal/tickets", { method: "POST", portal: cookie, body: { subject: "SD portal printer", description: "It is jammed" } });
        assert.equal(made1.status, 201, await made1.clone().text());
        const created = await made1.json();
        portalTicket = created.id;
        made.tickets.push(portalTicket);
        const t = await one(portalTicket);
        assert.equal(t.createdVia, "portal");
        assert.equal(t.queueName, "Projects");
        assert.equal(t.assigneeUserId, t3.id);
        assert.equal(t.sla.policy, "Standard");
        assert.equal(t.sla.response.state, "running");
        const asPortal = await json(`/api/portal/tickets/${portalTicket}`, { portal: cookie });
        const asList = await json(`/api/portal/tickets`, { portal: cookie });
        const text = JSON.stringify([asPortal, asList]).toLowerCase();
        for (const word of ["sla", "queue", "policy", "duein", "breach", "routing", "createdvia", "assignee"]) {
            const at = text.search(new RegExp("\b" + word));
            assert.ok(at < 0, `the portal shows "${word}": ${text.slice(Math.max(0, at - 60), at + 60)}`);
        }
        // the customer writing back while waiting takes the ticket off hold
        assert.equal((await patch(`/api/tickets/${portalTicket}`, { status: "pending" })).status, 200);
        assert.equal((await one(portalTicket)).sla.paused, true);
        assert.equal((await call(`/api/portal/tickets/${portalTicket}/replies`, { method: "POST", portal: cookie, body: { body: "Still jammed" } })).status, 200);
        const after = await one(portalTicket);
        assert.equal(after.status, "open");
        assert.equal(after.sla.paused, false);
        await q(`DELETE FROM ticket_routing_rules WHERE id = $1`, [rule.id]);
        await q(`DELETE FROM portal_accounts WHERE id = $1`, [acc]);
    });
    await test("a ticket opened from an alert is routed and timed too", async () => {
        const device = (await q(`INSERT INTO devices (site_id, hostname) VALUES ($1,$2) RETURNING id`, [B.site, `SD-PC-${stamp}`])).rows[0].id;
        const alert = (await q(`INSERT INTO alerts (device_id, kind, dedupe_key, severity, state, title, detail) VALUES ($1,'offline',$2,'CRIT','OPEN',$3,'down') RETURNING id`, [device, `sd-${stamp}`, `SD alert ${stamp}`])).rows[0].id;
        const rule = await (await post("/api/ticket-routing-rules", { name: "Alerts", conditions: [{ field: "source", values: ["alert"] }], actions: { queueId: qProjects.id } })).json();
        const res = await post(`/api/alerts/${alert}/ticket`, {});
        assert.ok([200, 201].includes(res.status), `alert ticket ${res.status} ${await res.clone().text()}`);
        const { ticketId } = await res.json();
        made.tickets.push(ticketId);
        const t = await one(ticketId);
        assert.equal(t.createdVia, "alert");
        assert.equal(t.queueName, "Projects");
        assert.equal(t.priority, "high"); // a critical alert
        assert.equal(t.sla.response.state, "running");
        await q(`DELETE FROM ticket_routing_rules WHERE id = $1`, [rule.id]);
        await q(`DELETE FROM alerts WHERE id = $1`, [alert]);
        await q(`DELETE FROM devices WHERE id = $1`, [device]);
    });

    console.log("warnings, breaches and escalation");
    let esc;
    await test("the escalation settings are saved: who to tell, and what a breach does", async () => {
        const res = await patch(`/api/sla/policies/${std.id}`, { warnPercent: 80, escalation: { warning: { users: [t3.id], notifyAssignee: false }, breach: { users: [t3.id], notifyAssignee: true, raisePriority: true, reassignUserId: t2.id, moveToQueueId: qProjects.id } } });
        assert.equal(res.status, 200, await res.clone().text());
        esc = (await res.json()).escalation;
        assert.deepEqual(esc.breach.users, [t3.id]);
        assert.equal(esc.breach.raisePriority, true);
        assert.equal(esc.breach.reassignUserId, t2.id);
        assert.equal((await patch(`/api/sla/policies/${std.id}`, { escalation: { breach: { moveToQueueId: uuid() } } })).status, 400);
        // the queue cannot be deleted while a policy moves late tickets to it
        const del = await call(`/api/ticket-queues/${qProjects.id}`, { method: "DELETE", token: admin.token });
        assert.equal(del.status, 409);
    });
    await test("a warning is recorded once, tells the people chosen, and sends the webhook", async () => {
        const hook = (await q(`INSERT INTO webhook_endpoints (organization_id, name, url, secret, events, enabled) VALUES ($1,$2,'https://example.invalid/hook','x',ARRAY['ticket.sla_warning','ticket.sla_breached'],true) RETURNING id`, [org, `sd-hook-${stamp}`])).rows[0].id;
        made.hook = hook;
        const t = await mkTicket("warning ticket", { clientId: B.id, priority: "medium", assigneeUserId: t1.id });
        await q(`UPDATE ticket_sla SET resolution_warn_at = now() - interval '2 minutes', resolution_due_at = now() + interval '30 minutes' WHERE ticket_id = $1`, [t]);
        const r1 = await (await call("/api/sla/run", { method: "POST", token: admin.token })).json();
        assert.ok(r1.warnings >= 1, JSON.stringify(r1));
        const row = (await q(`SELECT resolution_warned_at, resolution_breached_at FROM ticket_sla WHERE ticket_id = $1`, [t])).rows[0];
        assert.ok(row.resolution_warned_at);
        assert.equal(row.resolution_breached_at, null);
        const notices = (await get("/api/sla/notices", t3)).items.filter((n) => n.ticketId === t);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].kind, "sla_warning");
        assert.match(notices[0].title, /SLA warning/);
        assert.equal((await get("/api/sla/notices", t1)).items.filter((n) => n.ticketId === t).length, 0, "the assignee is told only if the policy says so");
        const hooks = (await q(`SELECT payload FROM webhook_deliveries WHERE endpoint_id = $1 AND event = 'ticket.sla_warning'`, [hook])).rows.filter((d) => d.payload.data.ticket.id === t);
        assert.equal(hooks.length, 1);
        assert.equal(hooks[0].payload.data.sla.timer, "resolution");
        assert.equal(hooks[0].payload.data.ticket.number > 0, true);
        const deliveriesBefore = (await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND event = 'ticket.sla_warning'`, [hook])).rows[0].n;
        await call("/api/sla/run", { method: "POST", token: admin.token });
        assert.equal((await get("/api/sla/notices", t3)).items.filter((n) => n.ticketId === t).length, 1, "not told again");
        assert.equal((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND event = 'ticket.sla_warning'`, [hook])).rows[0].n, deliveriesBefore, "not sent again");
        assert.ok((await get(`/api/tickets?sla=warning&pageSize=200`)).some((x) => x.id === t));
        assert.ok((await get(`/api/tickets?sla=at_risk&pageSize=200`)).some((x) => x.id === t));
        assert.ok(!(await get(`/api/tickets?sla=breached&pageSize=200`)).some((x) => x.id === t));
        assert.equal((await one(t)).sla.level, "warning");
    });
    await test("a breach is recorded once, tells the people chosen and the assignee, raises the priority, reassigns, moves the queue and sends the webhook", async () => {
        const t = await mkTicket("breach ticket", { clientId: B.id, priority: "medium", assigneeUserId: t1.id });
        await q(`UPDATE ticket_sla SET resolution_warn_at = now() - interval '20 minutes', resolution_due_at = now() - interval '1 minute' WHERE ticket_id = $1`, [t]);
        const r1 = await (await call("/api/sla/run", { method: "POST", token: admin.token })).json();
        assert.ok(r1.breaches >= 1, JSON.stringify(r1));
        const row = (await q(`SELECT resolution_breached_at FROM ticket_sla WHERE ticket_id = $1`, [t])).rows[0];
        assert.ok(row.resolution_breached_at);
        const after = await one(t);
        assert.equal(after.priority, "high", "raised one level");
        assert.equal(after.assigneeUserId, t2.id, "reassigned");
        assert.equal(after.queueName, "Projects", "moved");
        assert.equal(after.sla.level, "breached", JSON.stringify(after.sla));
        assert.ok(after.sla.resolution.breachedAt);
        assert.equal(after.sla.resolution.targetMinutes, 240, "the new priority's target");
        assert.equal((await get("/api/sla/notices", t3)).items.filter((n) => n.ticketId === t && n.kind === "sla_breached").length, 1);
        assert.equal((await get("/api/sla/notices", t1)).items.filter((n) => n.ticketId === t && n.kind === "sla_breached").length, 1, "the person it was assigned to is told");
        const history = (await get(`/api/tickets/${t}/history`)).map((h) => `${h.who}|${h.what}`);
        assert.ok(history.some((h) => h.startsWith("SLA|") && /resolution time breached/.test(h)), history.join(" ; "));
        assert.ok(history.some((h) => h.startsWith("SLA|priority: medium -> high")), history.join(" ; "));
        const n = async () => (await q(`SELECT payload FROM webhook_deliveries WHERE endpoint_id = $1 AND event = 'ticket.sla_breached'`, [made.hook])).rows.filter((d) => d.payload.data.ticket.id === t).length;
        assert.equal(await n(), 1);
        await call("/api/sla/run", { method: "POST", token: admin.token });
        assert.equal(await n(), 1, "sent once");
        assert.equal((await get("/api/sla/notices", t3)).items.filter((x) => x.ticketId === t && x.kind === "sla_breached").length, 1);
        assert.ok((await get(`/api/tickets?sla=breached&pageSize=200`)).some((x) => x.id === t));
        // sorted by the soonest due time, tickets with nothing running go last
        const sorted = await get(`/api/tickets?sort=sla_due&pageSize=200`);
        const nextDue = (x) => {
            const running = [x.sla?.response, x.sla?.resolution].filter((c) => c?.state === "running").map((c) => new Date(c.dueAt).getTime());
            return running.length ? Math.min(...running) : null;
        };
        const dues = sorted.map(nextDue).filter((x) => x !== null);
        assert.deepEqual(dues, [...dues].sort((a, b) => a - b));
        assert.deepEqual(sorted.map(nextDue).map((x) => x === null), sorted.map(nextDue).map((x) => x === null).sort((a, b) => Number(a) - Number(b)), "tickets with nothing running go last");
    });
    await test("a response that is never given breaches the response clock", async () => {
        const raw = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject, client_id, created_at) VALUES ($1,(SELECT COALESCE(MAX(ticket_number),0)+1 FROM tickets WHERE organization_id=$1),$2,$3, now() - interval '3 hours') RETURNING id`, [org, `SD never answered`, B.id])).rows[0].id;
        made.tickets.push(raw);
        await q(`UPDATE sla_policies SET created_at = now() - interval '1 day'`);
        await call("/api/sla/run", { method: "POST", token: admin.token }); // finds it, starts its clocks from when it was opened, and sees the response is late
        const t = await one(raw);
        assert.equal(t.sla.response.level, "breached");
        assert.ok(t.sla.response.breachedAt);
        assert.equal(t.sla.resolution.level, "ok");
        assert.ok((await get(`/api/tickets?sla=breached&pageSize=200`)).some((x) => x.id === raw));
    });
    await test("changing a policy re-aims open tickets and every change is in the audit log", async () => {
        const t = await mkTicket("policy edit", { clientId: B.id, priority: "medium" });
        const before = await one(t);
        assert.equal((await patch(`/api/sla/policies/${std.id}`, { targets: targets({ medium: { response: 60, resolution: 960 } }) })).status, 200);
        const after = await wait(async () => {
            const x = await one(t);
            return x.sla.resolution.targetMinutes === 960 ? x : null;
        });
        assert.ok(new Date(after.sla.resolution.dueAt).getTime() > new Date(before.sla.resolution.dueAt).getTime() + 400 * MIN);
        assert.equal((await patch(`/api/sla/policies/${std.id}`, { targets: targets() })).status, 200);
        const events = (await q(`SELECT action, target_label, details FROM audit_events WHERE action LIKE 'sla.%' ORDER BY created_at`)).rows;
        const actions = events.map((e) => e.action);
        for (const a of ["sla.calendar.create", "sla.policy.create", "sla.policy.update", "sla.customer_policy.set"]) assert.ok(actions.includes(a), `${a} in ${actions.join(",")}`);
        const upd = events.find((e) => e.action === "sla.policy.update" && (e.details.changes ?? []).some((c) => /targets\.medium\.resolution: 480 -> 960/.test(c)));
        assert.ok(upd, "what changed is spelled out");
        assert.equal(upd.target_label, "Standard");
    });
    await test("a policy that is switched off or removed leaves tickets with no clocks", async () => {
        const solo = await (await post("/api/sla/policies", { name: "Temporary", targets: targets(), isDefault: false })).json();
        assert.equal((await call(`/api/sla/clients/${A.id}`, { method: "PUT", token: admin.token, body: { policyId: solo.id } })).status, 200);
        const t = await mkTicket("temporary policy", { clientId: A.id });
        assert.equal((await one(t)).sla.policy, "Temporary");
        assert.equal((await call(`/api/sla/policies/${solo.id}`, { method: "DELETE", token: admin.token })).status, 200);
        const back = await wait(async () => {
            const x = await one(t);
            return x.sla?.policy === "Standard" ? x : null;
        });
        assert.ok(back);
        assert.equal((await call(`/api/sla/clients/${A.id}`, { method: "PUT", token: admin.token, body: { policyId: gold.id } })).status, 200);
    });

    console.log("routing rules");
    let rules = [];
    await test("a rule needs conditions it can test and an effect, all checked", async () => {
        const bad = (o) => post("/api/ticket-routing-rules", { name: `r ${Math.random()}`, conditions: [{ field: "subject_contains", values: ["printer"] }], actions: { queueId: qSupport.id }, ...o });
        assert.equal((await bad({ name: "" })).status, 400);
        assert.equal((await bad({ conditions: [] })).status, 400);
        assert.equal((await bad({ conditions: [{ field: "colour", values: ["red"] }] })).status, 400);
        assert.equal((await bad({ conditions: [{ field: "subject_contains", values: [] }] })).status, 400);
        assert.equal((await bad({ conditions: [{ field: "customer", values: ["nope"] }] })).status, 400);
        assert.equal((await bad({ conditions: [{ field: "customer", values: [uuid()] }] })).status, 400);
        assert.equal((await bad({ conditions: [{ field: "source", values: ["fax"] }] })).status, 400);
        assert.equal((await bad({ conditions: [{ field: "priority", values: ["critical"] }] })).status, 400);
        assert.equal((await bad({ actions: {} })).status, 400);
        assert.equal((await bad({ actions: { queueId: uuid() } })).status, 400);
        assert.equal((await bad({ actions: { assignee: "round_robin" } })).status, 400); // needs a queue
        assert.equal((await bad({ actions: { priority: "critical" } })).status, 400);
        assert.equal((await bad({ actions: { assignee: uuid() } })).status, 400);
    });
    await test("rules are tried in order: the first match decides, and a rule that does not stop lets later ones fill in the rest", async () => {
        await q(`DELETE FROM ticket_routing_rules`);
        const mk = async (b) => {
            const r = await post("/api/ticket-routing-rules", b);
            assert.equal(r.status, 201, await r.clone().text());
            const x = await r.json();
            rules.push(x);
            return x;
        };
        const r1 = await mk({ name: "Printers to support", conditions: [{ field: "subject_contains", values: ["printer", "scanner"] }], actions: { queueId: qSupport.id, priority: "low" } });
        const r2 = await mk({ name: "Alpha customer", conditions: [{ field: "customer", values: [A.id] }], actions: { queueId: qProjects.id, assignee: t3.id }, stopOnMatch: false });
        const r3 = await mk({ name: "Urgent from anyone", match: "any", conditions: [{ field: "priority", values: ["urgent"] }, { field: "body_contains", values: ["server is down"] }], actions: { queueId: qRR.id, assignee: "round_robin", priority: "urgent" } });
        assert.deepEqual((await get("/api/ticket-routing-rules")).items.map((r) => r.position), [1, 2, 3]);
        // first rule matches, and stops: the customer rule never runs
        const a = await mkTicket("Printer jammed", { clientId: A.id, priority: "high" }, t1);
        const av = await one(a);
        assert.equal(av.queueName, "Support");
        assert.equal(av.assigneeUserId, t1.id, "the queue's own person");
        assert.equal(av.priority, "high", "the person chose the priority on the form, so the rule leaves it");
        // no rule on the first, the customer rule on the second: queue and person, and it does not stop
        const b = await mkTicket("Something else", { clientId: A.id });
        const bv = await one(b);
        assert.equal(bv.queueName, "Projects");
        assert.equal(bv.assigneeUserId, t3.id);
        // match any, round robin and a priority from the rule (the form gave none)
        const c = await mkTicket("Help", { clientId: B.id, description: "our server is down since noon" });
        const cv = await one(c);
        assert.equal(cv.queueName, "Round robin");
        assert.equal(cv.priority, "urgent");
        assert.ok([t1.id, t2.id, t3.id].includes(cv.assigneeUserId));
        // none match: nothing is set
        const d = await mkTicket("Quiet one", { clientId: B.id });
        const dv = await one(d);
        assert.equal(dv.queueId, null);
        assert.equal(dv.assigneeUserId, null);
        // the history says who did it
        const hist = await get(`/api/tickets/${b}/history`);
        assert.ok(hist.some((h) => h.who.startsWith("Routing (Alpha customer)") && /queue: - -> Projects/.test(h.what)), JSON.stringify(hist));
        assert.ok((await get("/api/sla/notices", t3)).items.some((n) => n.ticketId === b && n.kind === "assigned"));
        void r1; void r2; void r3;
    });
    await test("round robin gives tickets to the pool in turn", async () => {
        const got = [];
        for (let i = 0; i < 6; i++) {
            const t = await mkTicket(`Server is down ${i}`, { clientId: B.id, description: "the server is down" });
            got.push((await one(t)).assigneeUserId);
        }
        const counts = new Map();
        for (const g of got) counts.set(g, (counts.get(g) ?? 0) + 1);
        assert.equal(counts.size, 3, JSON.stringify([...counts]));
        assert.deepEqual([...counts.values()], [2, 2, 2]);
        // never the same person twice in a row
        for (let i = 1; i < got.length; i++) assert.notEqual(got[i], got[i - 1]);
        // parallel tickets still spread out
        const ids = await Promise.all([0, 1, 2].map((i) => mkTicket(`Server is down parallel ${i}`, { clientId: B.id, description: "the server is down" })));
        const people = (await Promise.all(ids.map((i) => one(i)))).map((x) => x.assigneeUserId);
        assert.equal(new Set(people).size, 3, "three tickets at once went to three people");
    });
    await test("a person out of the pool (switched off) is skipped", async () => {
        await q(`UPDATE users SET status = 'disabled' WHERE id = $1`, [t2.id]);
        const seen = new Set();
        for (let i = 0; i < 4; i++) seen.add((await one(await mkTicket(`Server is down skip ${i}`, { clientId: B.id, description: "the server is down" }))).assigneeUserId);
        await q(`UPDATE users SET status = 'active' WHERE id = $1`, [t2.id]);
        assert.ok(!seen.has(t2.id));
        assert.equal(seen.size, 2);
    });
    await test("rules can be switched off, reordered and edited, and a test shows where a made-up ticket would go without changing anything", async () => {
        const [r1, r2, r3] = rules;
        const countBefore = (await q(`SELECT count(*)::int AS n FROM tickets`)).rows[0].n;
        let p = await (await post("/api/ticket-routing-rules/test", { subject: "Printer broke", customerId: A.id, source: "email", priority: "medium" })).json();
        assert.deepEqual(p.matched.map((m) => m.name), ["Printers to support"]);
        assert.equal(p.queue.name, "Support");
        assert.equal(p.assignee.name.includes("sd-tech1"), true);
        assert.equal(p.priority, "low");
        // switch the first rule off: the customer rule decides, and does not stop, so nothing after it matches
        assert.equal((await patch(`/api/ticket-routing-rules/${r1.id}`, { enabled: false })).status, 200);
        p = await (await post("/api/ticket-routing-rules/test", { subject: "Printer broke", customerId: A.id, source: "email", priority: "medium" })).json();
        assert.deepEqual(p.matched.map((m) => m.name), ["Alpha customer"]);
        assert.equal(p.queue.name, "Projects");
        // put the customer rule first and the printer rule second, both on: order decides
        assert.equal((await patch(`/api/ticket-routing-rules/${r1.id}`, { enabled: true })).status, 200);
        const re = await post("/api/ticket-routing-rules/reorder", { ids: [r2.id, r1.id, r3.id] });
        assert.equal(re.status, 200);
        assert.deepEqual((await re.json()).items.map((r) => r.name), ["Alpha customer", "Printers to support", "Urgent from anyone"]);
        p = await (await post("/api/ticket-routing-rules/test", { subject: "Printer broke", customerId: A.id, source: "email", priority: "medium" })).json();
        assert.deepEqual(p.matched.map((m) => m.name), ["Alpha customer", "Printers to support"]);
        assert.equal(p.queue.name, "Projects", "the first rule to name a queue wins");
        assert.equal(p.priority, "low", "a later rule fills in what is still undecided");
        p = await (await post("/api/ticket-routing-rules/test", { subject: "hello", source: "ui", priority: "medium" })).json();
        assert.equal(p.noRuleMatched, true);
        assert.equal(p.queue, null);
        assert.equal((await post("/api/ticket-routing-rules/test", { subject: "x", source: "fax" })).status, 400);
        assert.equal((await post("/api/ticket-routing-rules/reorder", { ids: [uuid()] })).status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM tickets`)).rows[0].n, countBefore, "testing makes no ticket");
        // a sender domain and a device tag are conditions too
        const dom = await (await post("/api/ticket-routing-rules", { name: "VIP domain", conditions: [{ field: "sender_domain", values: ["@Big.Example.test"] }], actions: { priority: "urgent" } })).json();
        assert.deepEqual(dom.conditions[0].values, ["big.example.test"]);
        p = await (await post("/api/ticket-routing-rules/test", { subject: "x", source: "email", senderEmail: "boss@big.example.test", priority: "low" })).json();
        assert.deepEqual(p.matched.map((m) => m.name), ["VIP domain"]);
        assert.equal(p.priority, "urgent");
        assert.equal((await call(`/api/ticket-routing-rules/${dom.id}`, { method: "DELETE", token: admin.token })).status, 200);
        assert.equal((await call(`/api/ticket-routing-rules/${dom.id}`, { method: "DELETE", token: admin.token })).status, 404);
    });
    await test("a queue in use by a rule cannot be deleted, and tickets stay when a queue goes", async () => {
        const del = await call(`/api/ticket-queues/${qSupport.id}`, { method: "DELETE", token: admin.token });
        assert.equal(del.status, 409);
        assert.match((await del.json()).message, /routing rule/);
        const spare = await (await post("/api/ticket-queues", { name: "Spare" })).json();
        const t = await mkTicket("in spare", { clientId: B.id, queueId: spare.id });
        assert.equal((await one(t)).queueName, "Spare");
        assert.equal((await call(`/api/ticket-queues/${spare.id}`, { method: "DELETE", token: admin.token })).status, 200);
        const x = await one(t);
        assert.equal(x.queueId, null);
    });

    console.log("assignment by hand, the list and the counts");
    await test("a ticket is moved to a queue or a person by hand, with history; a ticket nobody has takes the queue's person", async () => {
        await q(`DELETE FROM ticket_routing_rules`);
        const t = await mkTicket("by hand", { clientId: B.id });
        assert.equal((await patch(`/api/tickets/${t}`, { queueId: qSupport.id })).status, 200);
        const a = await one(t);
        assert.equal(a.queueName, "Support");
        assert.equal(a.assigneeUserId, t1.id);
        assert.equal(a.sla.policy, "Gold", "the queue's policy applies");
        assert.equal((await patch(`/api/tickets/${t}`, { assigneeUserId: t2.id })).status, 200);
        assert.equal((await patch(`/api/tickets/${t}`, { queueId: qRR.id })).status, 200);
        assert.equal((await one(t)).assigneeUserId, t2.id, "a ticket that has a person keeps them when the queue changes");
        assert.equal((await patch(`/api/tickets/${t}`, { queueId: null })).status, 200);
        assert.equal((await one(t)).queueId, null);
        assert.equal((await patch(`/api/tickets/${t}`, { queueId: uuid() })).status, 400);
        assert.equal((await patch(`/api/tickets/${t}`, { queueId: "x" })).status, 400);
        assert.equal((await patch(`/api/tickets/${t}`, { queueId: qSupport.id }, reader)).status, 403);
        assert.equal((await patch(`/api/tickets/${t}`, { assigneeUserId: null })).status, 200);
        assert.equal((await one(t)).assigneeUserId, null);
        const hist = (await get(`/api/tickets/${t}/history`)).map((h) => h.what);
        assert.ok(hist.includes("queue: - -> Support"), hist.join(" ; "));
        assert.ok(hist.includes("queue: Support -> Round robin"), hist.join(" ; "));
        assert.ok(hist.includes("queue: Round robin -> -"), hist.join(" ; "));
        // a switched-off queue is refused
        const off = await (await post("/api/ticket-queues", { name: "Switched off", enabled: false })).json();
        assert.equal((await patch(`/api/tickets/${t}`, { queueId: off.id })).status, 400);
        assert.equal((await post("/api/tickets", { subject: "SD bad queue", queueId: off.id })).status, 400);
        await call(`/api/ticket-queues/${off.id}`, { method: "DELETE", token: admin.token });
    });
    await test("the list filters by queue, by person (me, unassigned, someone) and by status", async () => {
        const mine = await mkTicket("mine", { clientId: B.id, assigneeUserId: t1.id });
        const free = await mkTicket("free", { clientId: B.id });
        const inQ = await mkTicket("in projects", { clientId: B.id, queueId: qProjects.id });
        const ids = async (qs, who = admin) => (await get(`/api/tickets?pageSize=200&${qs}`, who)).map((x) => x.id);
        assert.ok((await ids("assignee=me", t1)).includes(mine));
        assert.ok(!(await ids("assignee=me", t2)).includes(mine));
        assert.ok((await ids("assignee=unassigned")).includes(free));
        assert.ok(!(await ids("assignee=unassigned")).includes(mine));
        assert.ok((await ids(`assignee=${t1.id}`)).includes(mine));
        assert.ok((await ids(`queueId=${qProjects.id}`)).includes(inQ));
        assert.ok(!(await ids(`queueId=${qProjects.id}`)).includes(free));
        assert.ok((await ids("queueId=none")).includes(free));
        assert.ok(!(await ids("queueId=none")).includes(inQ));
        assert.ok((await ids(`queueId=${qProjects.id}&assignee=unassigned`)).includes(inQ));
        assert.equal((await call(`/api/tickets?queueId=banana`, { token: admin.token })).status, 400);
        assert.equal((await call(`/api/tickets?assignee=banana`, { token: admin.token })).status, 400);
        assert.equal((await call(`/api/tickets?sla=banana`, { token: admin.token })).status, 400);
        assert.equal((await call(`/api/tickets?sort=banana`, { token: admin.token })).status, 400);
        // search still works together with the new filters
        assert.ok((await ids(`search=${encodeURIComponent("SD in projects")}&queueId=${qProjects.id}`)).includes(inQ));
        assert.ok(!(await ids(`search=${encodeURIComponent("SD in projects")}&queueId=none`)).includes(inQ));
        // sorting by priority
        const pr = await get(`/api/tickets?pageSize=200&sort=priority&dir=desc`);
        const rank = { urgent: 4, high: 3, medium: 2, low: 1 };
        const ranks = pr.map((x) => rank[x.priority]);
        assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
    });
    await test("counts per queue, mine, unassigned and breached", async () => {
        const c = await get("/api/ticket-queues/counts", t1);
        assert.ok(c.open > 0 && c.mine >= 1 && c.unassigned >= 1 && c.breached >= 1, JSON.stringify(c));
        const projects = c.queues.find((x) => x.name === "Projects");
        const real = (await q(`SELECT count(*)::int AS n FROM tickets WHERE queue_id = $1 AND status::text NOT IN ('resolved','closed')`, [qProjects.id])).rows[0].n;
        assert.equal(projects.open, real);
        assert.ok(c.noQueue >= 1);
        assert.equal((await call("/api/ticket-queues/counts", { token: noTickets.token })).status, 403);
    });

    console.log("customers limited to some tickets");
    await test("a person limited to one customer sees only that customer's tickets, counts and queues, and what is assigned to them", async () => {
        const lim = await staffUser("sd-limited", ["tickets.read", "tickets.write"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [lim.id, A.id]);
        const aT = await mkTicket("limited sees A", { clientId: A.id });
        const bT = await mkTicket("limited not B", { clientId: B.id });
        const mineB = await mkTicket("limited assigned in B", { clientId: B.id, assigneeUserId: lim.id });
        const none = await mkTicket("limited no customer");
        const ids = (await get(`/api/tickets?pageSize=200`, lim)).map((x) => x.id);
        assert.ok(ids.includes(aT));
        assert.ok(!ids.includes(bT));
        assert.ok(ids.includes(mineB), "tickets assigned to them are theirs");
        assert.ok(!ids.includes(none));
        assert.equal((await call(`/api/tickets/${bT}`, { token: lim.token })).status, 404);
        assert.equal((await call(`/api/tickets/${aT}`, { token: lim.token })).status, 200);
        assert.equal((await call(`/api/tickets/${bT}/replies`, { token: lim.token })).status, 404);
        assert.equal((await call(`/api/tickets/${bT}`, { method: "PATCH", token: lim.token, body: { status: "closed" } })).status, 404);
        assert.equal((await call(`/api/tickets/${bT}/reply`, { method: "POST", token: lim.token, body: { body: "hi" } })).status, 404);
        const search = (await get(`/api/tickets?search=${encodeURIComponent("SD limited")}&pageSize=200`, lim)).map((x) => x.id);
        assert.ok(search.includes(aT) && !search.includes(bT));
        // The routes that work on a ticket by id from elsewhere (stopwatch, reply templates) and the global search follow the same limit.
        for (const [m, p, b] of [["GET", `/api/ticket-timers/${bT}`], ["POST", `/api/ticket-timers/${bT}/start`], ["POST", `/api/ticket-timers/${bT}/discard`], ["GET", `/api/tickets/${bT}/canned-variables`], ["POST", `/api/tickets/${bT}/canned-render`, { template: "x" }], ["GET", `/api/tickets/${bT}/survey`]]) {
            assert.equal((await call(p, { method: m, token: lim.token, body: b })).status, 404, p);
        }
        // the knowledge-base routes need kb.read; with it they still answer 404 for a ticket the person may not see (kb-http covers the 200 side)
        for (const p of [`/api/kb/tickets/${bT}/suggestions`, `/api/kb/tickets/${bT}/links`]) assert.ok([403, 404].includes((await call(p, { token: lim.token })).status), p);
        assert.equal((await call(`/api/ticket-timers/${aT}`, { token: lim.token })).status, 200);
        assert.equal((await call(`/api/tickets/${aT}/canned-variables`, { token: lim.token })).status, 200);
        assert.equal((await call(`/api/tickets/${aT}/survey`, { token: lim.token })).status, 200);
        const found = async (who) => ((await get(`/api/search?q=${encodeURIComponent("SD limited")}`, who)).groups.find((g) => g.key === "tickets")?.items ?? []).map((i) => i.id);
        const foundLim = await found(lim);
        assert.ok(foundLim.includes(aT) && foundLim.includes(mineB) && !foundLim.includes(bT) && !foundLim.includes(none), "global search follows the limit");
        assert.ok((await found(admin)).includes(bT), "and finds everything for everyone else");
        for (const qs of [`sla=ok`, `queueId=none`, `assignee=unassigned`, `sort=sla_due`]) {
            const got = (await get(`/api/tickets?pageSize=200&${qs}`, lim)).map((x) => x.id);
            assert.ok(!got.includes(bT) && !got.includes(none), qs);
        }
        const counts = await get("/api/ticket-queues/counts", lim);
        const mineCount = (await q(`SELECT count(*)::int AS n FROM tickets t WHERE status::text NOT IN ('resolved','closed') AND (client_id = $1 OR assignee_user_id = $2)`, [A.id, lim.id])).rows[0].n;
        assert.equal(counts.open, mineCount);
        // everyone else still sees everything
        assert.ok((await get(`/api/tickets?pageSize=200`)).some((x) => x.id === bT));
    });

    console.log("the report and the webhook events");
    await test("the Tickets and SLA report uses the real clocks: policy, first response and SLA result", async () => {
        const res = await call("/api/reports/run/ticket-sla", { token: admin.token });
        assert.equal(res.status, 200, await res.clone().text());
        const body = await res.json();
        const rows = body.rows ?? body.result?.rows ?? [];
        const find = (s) => rows.find((r) => String(r.subject).includes(s));
        const breach = find("SD breach ticket");
        assert.ok(breach, "found the ticket");
        assert.equal(breach.sla, "Overdue");
        assert.equal(breach.policy, "Standard");
        const never = find("SD never answered");
        assert.equal(never.firstResponse, "Overdue");
        const answered = find("VIP mail");
        assert.equal(answered.firstResponse, "Met");
        const paused = find("pause and resume");
        assert.equal(paused.sla, "Paused");
        assert.ok(find("resolve and reopen").queue === "");
        const summary = JSON.stringify(body.summary ?? body.result?.summary ?? []);
        assert.match(summary, /First response met/);
    });
    await test("the webhook screen offers the two SLA events", async () => {
        const res = await call("/api/admin/webhooks", { token: admin.token });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(text.includes("ticket.sla_warning") && text.includes("ticket.sla_breached"));
    });

    // ------------------------------------------------------------------ tidy up what this run made
    await q(`DELETE FROM webhook_endpoints WHERE name LIKE 'sd-hook-%'`);
    await q(`DELETE FROM alerts WHERE title LIKE 'SD alert%'`);
    await q(`DELETE FROM devices WHERE hostname LIKE 'SD-PC-%'`);
    await q(`DELETE FROM tickets WHERE subject LIKE 'SD %'`);
    await q(`DELETE FROM user_client_access WHERE client_id = ANY($1::uuid[])`, [made.clients]);
    await q(`DELETE FROM ticket_notices WHERE user_id = ANY($1::uuid[])`, [made.users]);
    await q(`DELETE FROM ticket_routing_rules`);
    await q(`DELETE FROM ticket_queues`);
    await q(`DELETE FROM sla_client_policies`);
    await q(`DELETE FROM sla_policies`);
    await q(`DELETE FROM sla_calendars`);
    await q(`DELETE FROM portal_settings`);
    await q(`DELETE FROM sites WHERE client_id = ANY($1::uuid[])`, [made.clients]);
    await cleanup().catch((e) => console.log("cleanup:", e.message));
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
