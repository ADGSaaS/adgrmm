#!/usr/bin/env node
// The technician schedule and dispatch board, through the real HTTP API: booking visits, conflicts (double booking,
// time off, working hours), the invite with its calendar file, status and time logging, customer-limited people,
// the list of tickets with no visit, and the audit trail. A small SMTP server catches the mail.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... node test/schedule-http.e2e.cjs
"use strict";
const net = require("node:net");
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

function smtpSink() {
    const mails = [];
    const server = net.createServer((sock) => {
        let data = false;
        let buf = "";
        let cur = { from: "", to: [], raw: "" };
        sock.write("220 sink ESMTP\r\n");
        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            for (;;) {
                if (data) {
                    const end = buf.indexOf("\r\n.\r\n");
                    if (end < 0) return;
                    cur.raw = buf.slice(0, end);
                    buf = buf.slice(end + 5);
                    data = false;
                    mails.push(cur);
                    cur = { from: "", to: [], raw: "" };
                    sock.write("250 queued\r\n");
                    continue;
                }
                const nl = buf.indexOf("\r\n");
                if (nl < 0) return;
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 2);
                const cmd = line.slice(0, 4).toUpperCase();
                if (cmd === "EHLO" || cmd === "HELO") sock.write("250 sink\r\n");
                else if (cmd === "MAIL") { cur.from = line; sock.write("250 ok\r\n"); }
                else if (cmd === "RCPT") { cur.to.push(line); sock.write("250 ok\r\n"); }
                else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); }
                else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
                else sock.write("250 ok\r\n");
            }
        });
        sock.on("error", () => { /* a client that hung up */ });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, mails, close: () => server.close() })));
}

const qp = (raw) => raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
/** The calendar file attached to a message, decoded. */
function attachedIcs(raw) {
    const m = /Content-Type: text\/calendar[\s\S]*?\r\n\r\n([\s\S]*?)(\r\n--|$)/i.exec(raw);
    if (!m) return null;
    const head = raw.slice(m.index, m.index + m[0].length);
    return /base64/i.test(head) ? Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8") : qp(m[1]);
}

const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600_000;

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = Date.now();
    const sink = await smtpSink();

    const perms = ["tickets.read", "tickets.write", "tickets.time.manual", "schedule.read", "schedule.write", "customers.read", "settings.read"];
    const admin = await staffUser("sch-admin", perms);
    const tech = await staffUser("sch-tech", perms);
    const tech2 = await staffUser("sch-tech2", perms);
    const reader = await staffUser("sch-reader", ["tickets.read", "schedule.read"]);
    const noTime = await staffUser("sch-notime", ["tickets.read", "tickets.write", "schedule.read", "schedule.write"]);
    const limited = await staffUser("sch-limited", ["tickets.read", "tickets.write", "schedule.read", "schedule.write"]);
    const nobody = await staffUser("sch-nobody", ["customers.read"]);
    const clientA = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `SCH Customer A ${stamp}`])).rows[0].id;
    const clientB = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `SCH Customer B ${stamp}`])).rows[0].id;
    made.clients.push(clientA, clientB);
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, clientA]);
    const contact = (await q(`INSERT INTO contacts (organization_id, name, email) VALUES ($1,'Jordan Contact',$2) RETURNING id`, [org, `jordan-${stamp}@customer.test`])).rows[0].id;

    const savedMail = (await q(`SELECT * FROM email_settings`)).rows;
    for (const p of ["alerts", "invites", "password_resets", "reports", "tickets"]) {
        await q(`INSERT INTO email_settings (purpose, enabled, smtp_host, smtp_port, smtp_username, smtp_use_tls, smtp_use_ssl, smtp_from_address)
                 VALUES ($1, true, '127.0.0.1', $2, '', false, false, 'adg@example.test')
                 ON CONFLICT (purpose) DO UPDATE SET enabled = true, smtp_host = '127.0.0.1', smtp_port = $2, smtp_username = '', smtp_password = NULL, smtp_use_tls = false, smtp_use_ssl = false, smtp_from_address = 'adg@example.test'`, [p, sink.port]);
    }
    await q(`DELETE FROM email_templates WHERE key LIKE 'visit_%'`);

    const mkTicket = async (clientId, subject, withContact = false) => {
        const res = await call("/api/tickets", { method: "POST", token: admin.token, body: { subject: `GC ${subject}`, clientId } });
        assert.equal(res.status, 201);
        const id = (await res.json()).id;
        if (withContact) await q(`UPDATE tickets SET requester_contact_id = $1 WHERE id = $2`, [contact, id]);
        return id;
    };
    const tA = await mkTicket(clientA, "Printer offline", true);
    const tA2 = await mkTicket(clientA, "Second job");
    const tB = await mkTicket(clientB, "Other customer");
    const tNone = await mkTicket(undefined, "No customer");

    // Next Monday 09:00 UTC, so that the working hours of a UTC person (Monday to Friday, 08:00-17:00) apply.
    const d = new Date();
    d.setUTCHours(9, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
    const mon9 = d.getTime();
    const book = (token, body) => call("/api/schedule/visits", { method: "POST", token, body });
    const visitBody = (ticketId, startMs, hours, techs, extra = {}) => ({ ticketId, startsAt: iso(startMs), endsAt: iso(startMs + hours * HOUR), techIds: techs, ...extra });
    let v1;
    const sinceMail = (n) => sink.mails.slice(n);

    console.log("rights");
    await test("signing in and the schedule rights are needed", async () => {
        assert.equal((await call("/api/schedule/visits")).status, 401);
        assert.equal((await call("/api/schedule/visits", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/schedule/visits", { token: reader.token })).status, 200);
        assert.equal((await book(reader.token, visitBody(tA, mon9, 1, [tech.id]))).status, 403);
        assert.equal((await call("/api/schedule/techs", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/schedule/unscheduled", { token: nobody.token })).status, 403);
        assert.equal((await call(`/api/schedule/availability/${tech.id}`, { method: "PUT", token: reader.token, body: {} })).status, 403);
        assert.equal((await call("/api/schedule/time-off", { method: "POST", token: reader.token, body: {} })).status, 403);
    });

    console.log("booking");
    await test("a visit needs a real ticket, technicians, and a sensible range", async () => {
        const bad = async (body, status = 400) => assert.equal((await book(admin.token, body)).status, status, JSON.stringify(body).slice(0, 80));
        await bad(visitBody(uuid(), mon9, 1, [tech.id]), 404);
        await bad(visitBody("nope", mon9, 1, [tech.id]));
        await bad(visitBody(tA, mon9, 1, []));
        await bad(visitBody(tA, mon9, 1, [uuid()]));
        await bad(visitBody(tA, mon9, 1, ["x"]));
        await bad({ ticketId: tA, startsAt: iso(mon9 + HOUR), endsAt: iso(mon9), techIds: [tech.id] });
        await bad({ ticketId: tA, startsAt: "garbage", endsAt: iso(mon9), techIds: [tech.id] });
        await bad(visitBody(tA, mon9, 25, [tech.id]));
        await bad(visitBody(tA, mon9, 1, [tech.id], { timeZone: "Mars/Base" }));
        await bad(visitBody(tA, mon9, 1, Array.from({ length: 11 }, () => uuid())));
    });

    await test("booking a visit stores it with its technicians, zone and customer, and the technician is emailed an invite with a calendar file", async () => {
        const n = sink.mails.length;
        const res = await book(admin.token, visitBody(tA, mon9, 1.5, [tech.id, tech2.id], { location: "12 High St", notes: "Bring toner; ask for Sam", timeZone: "Europe/London" }));
        assert.equal(res.status, 201);
        v1 = await res.json();
        assert.equal(v1.status, "scheduled");
        assert.equal(v1.clientId, clientA);
        assert.equal(v1.timeZone, "Europe/London");
        assert.equal(v1.techs.length, 2);
        assert.equal(v1.notified.techs, 2);
        const mails = sinceMail(n);
        assert.equal(mails.length, 2);
        const ics = attachedIcs(mails[0].raw);
        assert.ok(ics && ics.includes("BEGIN:VCALENDAR") && ics.includes(`UID:${v1.id}@adgrmm`), "calendar file attached");
        assert.ok(ics.includes(`DTSTART:${iso(mon9).replace(/[-:]|\.\d{3}/g, "")}`));
        assert.ok(qp(mails[0].raw).includes("12 High St"));
    });

    await test("a visit without a time zone takes the technician's, and the customer is not emailed unless asked", async () => {
        const n = sink.mails.length;
        const res = await book(admin.token, visitBody(tA2, mon9 + 6 * HOUR, 1, [tech2.id], { notifyTechs: false }));
        assert.equal(res.status, 201);
        const v = await res.json();
        assert.equal(v.timeZone, "UTC");
        assert.equal(sinceMail(n).length, 0);
        assert.equal(v.customerNotifiedAt, null);
        await call(`/api/schedule/visits/${v.id}`, { method: "DELETE", token: admin.token });
    });

    console.log("conflicts");
    await test("booking a technician who is already busy is refused with who and why, and goes ahead when forced", async () => {
        const res = await book(admin.token, visitBody(tA2, mon9 + HOUR / 2, 1, [tech.id]));
        assert.equal(res.status, 409);
        const b = await res.json();
        assert.equal(b.conflicts[0].kind, "visit");
        assert.equal(b.conflicts[0].userId, tech.id);
        assert.ok(/already has a visit/.test(b.conflicts[0].message));
        const forced = await book(admin.token, visitBody(tA2, mon9 + HOUR / 2, 1, [tech.id], { force: true, notifyTechs: false }));
        assert.equal(forced.status, 201);
        const f = await forced.json();
        assert.equal(f.conflicts.length, 1);
        await call(`/api/schedule/visits/${f.id}`, { method: "DELETE", token: admin.token });
    });

    await test("back to back visits and different technicians do not clash; the conflict check says the same without booking", async () => {
        const after = await call("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9 + 1.5 * HOUR, 1, [tech.id]) });
        assert.equal(after.status, 200);
        assert.deepEqual((await after.json()).conflicts, []);
        const other = await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9, 1, [admin.id]) });
        assert.deepEqual(other.conflicts, []);
        const clash = await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9, 1, [tech2.id]) });
        assert.equal(clash.conflicts.length, 1);
        // Moving the visit onto its own time is not a clash with itself.
        const self = await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: { ...visitBody(tA, mon9, 1, [tech.id]), ignoreVisitId: v1.id } });
        assert.deepEqual(self.conflicts, []);
    });

    await test("a cancelled or finished visit holds nobody's time", async () => {
        const res = await book(admin.token, visitBody(tA2, mon9 + 3 * HOUR, 1, [tech.id], { notifyTechs: false }));
        const v = await res.json();
        assert.equal((await call(`/api/schedule/visits/${v.id}`, { method: "PATCH", token: admin.token, body: { status: "cancelled", notifyTechs: false } })).status, 200);
        assert.equal((await book(admin.token, visitBody(tA2, mon9 + 3 * HOUR, 1, [tech.id], { notifyTechs: false }))).status, 201);
        // Bringing the cancelled one back onto a taken slot is a clash.
        assert.equal((await call(`/api/schedule/visits/${v.id}`, { method: "PATCH", token: admin.token, body: { status: "scheduled" } })).status, 409);
        await q(`DELETE FROM ticket_visits WHERE ticket_id = $1`, [tA2]);
    });

    await test("working hours and time off warn, and only for the person they belong to", async () => {
        const hours = Array.from({ length: 7 }, (_, i) => ({ on: i < 5, start: "08:00", end: "17:00" }));
        assert.equal((await call(`/api/schedule/availability/${tech.id}`, { method: "PUT", token: admin.token, body: { timeZone: "UTC", hours } })).status, 200);
        const early = await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9 - 3 * HOUR, 1, [tech.id]) });
        assert.deepEqual(early.conflicts.map((c) => c.kind), ["outside_hours"]);
        const saturday = await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9 + 5 * 24 * HOUR, 1, [tech.id]) });
        assert.deepEqual(saturday.conflicts.map((c) => c.kind), ["outside_hours"]);
        const fine = await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9 + 3 * HOUR, 1, [tech.id]) });
        assert.deepEqual(fine.conflicts, []);
        // tech2 has no hours set, so nothing is checked for them.
        assert.deepEqual((await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9 - 3 * HOUR, 1, [tech2.id]) })).conflicts, []);
        // Another zone is read in that zone: 09:00 UTC is 04:00 in New York.
        assert.equal((await call(`/api/schedule/availability/${tech2.id}`, { method: "PUT", token: admin.token, body: { timeZone: "America/New_York", hours } })).status, 200);
        assert.deepEqual((await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9 + 96 * HOUR, 1, [tech2.id]) })).conflicts.map((c) => c.kind), ["outside_hours"]);

        await q(`DELETE FROM tech_availability WHERE user_id = ANY($1::uuid[])`, [[tech2.id]]);
        const off = await call("/api/schedule/time-off", { method: "POST", token: admin.token, body: { userId: tech.id, startsAt: iso(mon9 + 24 * HOUR), endsAt: iso(mon9 + 48 * HOUR), reason: "Holiday" } });
        assert.equal(off.status, 201);
        const offId = (await off.json()).id;
        const tue = await json("/api/schedule/visits/conflicts", { method: "POST", token: admin.token, body: visitBody(tA2, mon9 + 25 * HOUR, 1, [tech.id]) });
        assert.ok(tue.conflicts.some((c) => c.kind === "time_off" && /Holiday/.test(c.message)));
        assert.equal((await book(admin.token, visitBody(tA2, mon9 + 25 * HOUR, 1, [tech.id]))).status, 409);
        const listed = await json(`/api/schedule/time-off?from=${iso(mon9)}&to=${iso(mon9 + 72 * HOUR)}`, { token: reader.token });
        assert.ok(listed.items.some((i) => i.id === offId));
        assert.equal((await call(`/api/schedule/time-off/${offId}`, { method: "DELETE", token: reader.token })).status, 403);
        assert.equal((await call(`/api/schedule/time-off/${offId}`, { method: "DELETE", token: admin.token })).status, 200);
        assert.equal((await call(`/api/schedule/time-off/${offId}`, { method: "DELETE", token: admin.token })).status, 404);
        // The hours have served their purpose; later tests book on any day.
        await q(`DELETE FROM tech_availability WHERE user_id = ANY($1::uuid[])`, [[tech.id, tech2.id]]);
    });

    await test("availability and time off input is validated", async () => {
        const put = (body, id = tech.id) => call(`/api/schedule/availability/${id}`, { method: "PUT", token: admin.token, body });
        const hours = Array.from({ length: 7 }, () => ({ on: true, start: "08:00", end: "17:00" }));
        assert.equal((await put({ timeZone: "Nope/Zone", hours })).status, 400);
        assert.equal((await put({ timeZone: "UTC", hours: hours.slice(0, 3) })).status, 400);
        assert.equal((await put({ timeZone: "UTC", hours: hours.map((h, i) => (i ? h : { on: true, start: "18:00", end: "09:00" })) })).status, 400);
        assert.equal((await put({ timeZone: "UTC", hours }, uuid())).status, 404);
        const to = (body) => call("/api/schedule/time-off", { method: "POST", token: admin.token, body });
        assert.equal((await to({ userId: tech.id, startsAt: iso(mon9), endsAt: iso(mon9 - HOUR) })).status, 400);
        assert.equal((await to({ userId: uuid(), startsAt: iso(mon9), endsAt: iso(mon9 + HOUR) })).status, 400);
        assert.equal((await to({ userId: tech.id, startsAt: iso(mon9), endsAt: iso(mon9 + 400 * 24 * HOUR) })).status, 400);
        const techs = (await json("/api/schedule/techs", { token: reader.token })).items;
        const me = techs.find((t) => t.id === tech.id);
        assert.equal(me.timeZone, "UTC");
        assert.equal(me.hours.length, 7);
    });

    console.log("changing a visit");
    await test("moving a visit emails the technicians again with a newer calendar file, and a bad change is refused", async () => {
        const n = sink.mails.length;
        const res = await call(`/api/schedule/visits/${v1.id}`, { method: "PATCH", token: admin.token, body: { startsAt: iso(mon9 + 24 * 3 * HOUR), endsAt: iso(mon9 + 24 * 3 * HOUR + HOUR) } });
        assert.equal(res.status, 200);
        const v = await res.json();
        assert.equal(v.startsAt, iso(mon9 + 72 * HOUR));
        assert.equal(v.notified.techs, 2);
        const ics = attachedIcs(sinceMail(n)[0].raw);
        assert.ok(ics.includes("SEQUENCE:1"), "sequence goes up");
        assert.equal((await call(`/api/schedule/visits/${v1.id}`, { method: "PATCH", token: admin.token, body: { endsAt: iso(mon9 - HOUR) } })).status, 400);
        assert.equal((await call(`/api/schedule/visits/${v1.id}`, { method: "PATCH", token: admin.token, body: { status: "teleported" } })).status, 400);
        assert.equal((await call(`/api/schedule/visits/${v1.id}`, { method: "PATCH", token: admin.token, body: { techIds: [] } })).status, 400);
        assert.equal((await call(`/api/schedule/visits/${uuid()}`, { method: "PATCH", token: admin.token, body: { notes: "x" } })).status, 404);
        // Notes can change without any email.
        const n2 = sink.mails.length;
        assert.equal((await call(`/api/schedule/visits/${v1.id}`, { method: "PATCH", token: admin.token, body: { notes: "New note" } })).status, 200);
        assert.equal(sinceMail(n2).length, 0);
        assert.equal((await json(`/api/schedule/visits/${v1.id}`, { token: reader.token })).notes, "New note");
    });

    await test("the customer's contact can be told, and hears again about a change and a cancellation", async () => {
        const n = sink.mails.length;
        const res = await book(admin.token, visitBody(tA, mon9 + 24 * 4 * HOUR, 1, [tech.id], { notifyCustomer: true, notifyTechs: false, timeZone: "America/New_York", location: "Their office" }));
        assert.equal(res.status, 201);
        const v = await res.json();
        assert.equal(v.notified.customer, true);
        assert.ok(v.customerNotifiedAt);
        const first = sinceMail(n)[0];
        assert.ok(first.to.some((t) => t.includes(`jordan-${stamp}@customer.test`)));
        const text = qp(first.raw);
        assert.ok(text.includes("America/New_York") && text.includes("Their office"), "time zone and place");
        const n2 = sink.mails.length;
        await call(`/api/schedule/visits/${v.id}`, { method: "PATCH", token: admin.token, body: { startsAt: iso(mon9 + 24 * 4 * HOUR + HOUR), endsAt: iso(mon9 + 24 * 4 * HOUR + 2 * HOUR), notifyTechs: false } });
        assert.ok(sinceMail(n2).some((m) => m.to.some((t) => t.includes("customer.test"))), "customer told of the move");
        const n3 = sink.mails.length;
        await call(`/api/schedule/visits/${v.id}`, { method: "PATCH", token: admin.token, body: { status: "cancelled", notifyTechs: false } });
        const cancel = sinceMail(n3).find((m) => m.to.some((t) => t.includes("customer.test")));
        assert.ok(cancel, "customer told of the cancellation");
        assert.ok(attachedIcs(cancel.raw).includes("METHOD:CANCEL"));
        await call(`/api/schedule/visits/${v.id}`, { method: "DELETE", token: admin.token });
        // A ticket with no contact: nothing to send, and it says so.
        const none = await json("/api/schedule/visits", { method: "POST", token: admin.token, body: visitBody(tNone, mon9 + 24 * 5 * HOUR, 1, [tech.id], { notifyCustomer: true, notifyTechs: false }) });
        assert.equal(none.notified.customer, false);
        assert.ok(/no customer contact/.test(none.notified.note));
        await call(`/api/schedule/visits/${none.id}`, { method: "DELETE", token: admin.token });
    });

    await test("the calendar file can be downloaded, and a bad id is not found", async () => {
        const res = await call(`/api/schedule/visits/${v1.id}/ics`, { token: reader.token });
        assert.equal(res.status, 200);
        assert.ok((res.headers.get("content-type") || "").startsWith("text/calendar"));
        assert.ok((await res.text()).startsWith("BEGIN:VCALENDAR"));
        assert.equal((await call(`/api/schedule/visits/${uuid()}/ics`, { token: reader.token })).status, 404);
        assert.equal((await call(`/api/schedule/visits/not-a-uuid`, { token: reader.token })).status, 404);
    });

    console.log("status and time");
    await test("a visit moves through en route, on site and done; finishing can log its time once, and only for someone who may add time", async () => {
        const res = await book(admin.token, visitBody(tA2, mon9 + 24 * 6 * HOUR, 2, [tech.id], { notifyTechs: false }));
        const v = await res.json();
        const patch = (token, body) => call(`/api/schedule/visits/${v.id}`, { method: "PATCH", token, body });
        assert.equal((await (await patch(tech.token, { status: "en_route" })).json()).status, "en_route");
        assert.equal((await (await patch(tech.token, { status: "on_site" })).json()).status, "on_site");
        // Someone without the right to add time by hand cannot log it, and the visit stays as it was.
        assert.equal((await patch(noTime.token, { status: "done", logTime: { minutes: 30 } })).status, 403);
        assert.equal((await json(`/api/schedule/visits/${v.id}`, { token: reader.token })).status, "on_site");
        const done = await patch(tech.token, { status: "done", logTime: { minutes: 95, billable: false } });
        assert.equal(done.status, 200);
        const dv = await done.json();
        assert.equal(dv.status, "done");
        assert.equal(dv.timeLogged, 95);
        assert.ok(dv.timeEntryId);
        const entry = (await q(`SELECT * FROM time_entries WHERE id = $1`, [dv.timeEntryId])).rows[0];
        assert.equal(entry.minutes, 95);
        assert.equal(entry.billable, false);
        assert.equal(entry.ticket_id, tA2);
        assert.equal(entry.user_id, tech.id);
        assert.equal(entry.client_id, clientA);
        // Saying done again does not log a second entry.
        await patch(tech.token, { status: "done", logTime: { minutes: 10 } });
        assert.equal((await q(`SELECT count(*)::int AS n FROM time_entries WHERE ticket_id = $1`, [tA2])).rows[0].n, 1);
        // Without a minutes figure the visit's length is used.
        const v2 = await (await book(admin.token, visitBody(tA2, mon9 + 24 * 7 * HOUR, 1.25, [tech.id], { notifyTechs: false }))).json();
        const d2 = await (await call(`/api/schedule/visits/${v2.id}`, { method: "PATCH", token: tech.token, body: { status: "done", logTime: {} } })).json();
        assert.equal(d2.timeLogged, 75);
    });

    console.log("customer-limited people");
    await test("a person limited to one customer sees and books only that customer's visits", async () => {
        const vB = await (await book(admin.token, visitBody(tB, mon9 + 24 * 8 * HOUR, 1, [tech.id], { notifyTechs: false }))).json();
        const vN = await (await book(admin.token, visitBody(tNone, mon9 + 24 * 9 * HOUR, 1, [tech.id], { notifyTechs: false }))).json();
        const all = (await json(`/api/schedule/visits?from=${iso(mon9 - 24 * HOUR)}&to=${iso(mon9 + 24 * 30 * HOUR)}`, { token: admin.token })).items;
        assert.ok(all.some((v) => v.id === vB.id) && all.some((v) => v.id === vN.id));
        const mine = (await json(`/api/schedule/visits?from=${iso(mon9 - 24 * HOUR)}&to=${iso(mon9 + 24 * 30 * HOUR)}`, { token: limited.token })).items;
        assert.ok(mine.length > 0 && mine.every((v) => v.clientId === clientA), "only customer A");
        assert.ok(!mine.some((v) => v.id === vB.id || v.id === vN.id));
        assert.equal((await call(`/api/schedule/visits/${vB.id}`, { token: limited.token })).status, 404);
        assert.equal((await call(`/api/schedule/visits/${vB.id}/ics`, { token: limited.token })).status, 404);
        assert.equal((await call(`/api/schedule/visits/${vB.id}`, { method: "PATCH", token: limited.token, body: { notes: "x" } })).status, 404);
        assert.equal((await call(`/api/schedule/visits/${vB.id}`, { method: "DELETE", token: limited.token })).status, 404);
        assert.equal((await book(limited.token, visitBody(tB, mon9 + 24 * 11 * HOUR, 1, [tech.id], { notifyTechs: false }))).status, 404);
        assert.equal((await book(limited.token, visitBody(tNone, mon9 + 24 * 11 * HOUR, 1, [tech.id], { notifyTechs: false }))).status, 404);
        const ok = await book(limited.token, visitBody(tA, mon9 + 24 * 11 * HOUR, 1, [tech.id], { notifyTechs: false }));
        assert.equal(ok.status, 201);
        const un = (await json("/api/schedule/unscheduled", { token: limited.token })).items;
        assert.ok(un.every((t) => t.clientName === `SCH Customer A ${stamp}`), "unscheduled list limited");
        assert.ok(!un.some((t) => t.id === tB || t.id === tNone));
    });

    console.log("tickets with no visit");
    await test("the side list holds worked tickets that have no visit coming up", async () => {
        const tFresh = await mkTicket(clientA, "Needs a visit");
        const list = async (qs = "") => (await json(`/api/schedule/unscheduled${qs}`, { token: admin.token })).items;
        assert.ok((await list()).some((t) => t.id === tFresh));
        assert.ok(!(await list()).some((t) => t.id === tA), "tA has a visit coming up");
        assert.ok((await list("?q=needs%20a%20vis")).some((t) => t.id === tFresh));
        assert.ok(!(await list("?q=zzzzqq")).some((t) => t.id === tFresh));
        await q(`UPDATE tickets SET status = 'closed' WHERE id = $1`, [tFresh]);
        assert.ok(!(await list()).some((t) => t.id === tFresh), "closed tickets are not listed");
    });

    console.log("deleting and the audit trail");
    await test("deleting a visit tells the technicians it is cancelled and it is gone", async () => {
        const v = await (await book(admin.token, visitBody(tA2, mon9 + 24 * 12 * HOUR, 1, [tech.id, tech2.id]))).json();
        const n = sink.mails.length;
        const res = await call(`/api/schedule/visits/${v.id}`, { method: "DELETE", token: admin.token });
        assert.equal(res.status, 200);
        const mails = sinceMail(n);
        assert.equal(mails.length, 2);
        assert.ok(attachedIcs(mails[0].raw).includes("METHOD:CANCEL"));
        assert.equal((await call(`/api/schedule/visits/${v.id}`, { token: admin.token })).status, 404);
        assert.equal((await call(`/api/schedule/visits/${v.id}`, { method: "DELETE", token: admin.token })).status, 404);
        // Deleting a ticket removes its visits.
        const tx = await mkTicket(clientA, "Soon gone");
        const vx = await (await book(admin.token, visitBody(tx, mon9 + 24 * 13 * HOUR, 1, [tech.id], { notifyTechs: false }))).json();
        await q(`DELETE FROM tickets WHERE id = $1`, [tx]);
        assert.equal((await q(`SELECT count(*)::int AS n FROM ticket_visits WHERE id = $1`, [vx.id])).rows[0].n, 0);
    });

    await test("booking, changing and deleting visits are audited, and the email wording can be edited", async () => {
        const actions = (await q(`SELECT DISTINCT action FROM audit_events WHERE action LIKE 'schedule.%'`)).rows.map((r) => r.action);
        for (const a of ["schedule.visit.create", "schedule.visit.update", "schedule.visit.delete", "schedule.availability.update", "schedule.time_off.add", "schedule.time_off.remove"]) assert.ok(actions.includes(a), a);
        assert.ok(!actions.includes("schedule.visit.check"), "the conflict check is not an event");
        const list = (await json("/api/admin/email-templates", { token: (await staffUser("sch-tpl", ["settings.read", "settings.write"])).token })).items;
        assert.ok(list.some((t) => t.key === "visit_tech") && list.some((t) => t.key === "visit_customer"));
    });

    // Put things back.
    await q(`DELETE FROM ticket_visits WHERE organization_id = $1 AND ticket_id IN (SELECT id FROM tickets WHERE subject LIKE 'GC %')`, [org]);
    await q(`DELETE FROM tech_availability WHERE user_id = ANY($1::uuid[])`, [[tech.id, tech2.id]]);
    await q(`DELETE FROM tech_time_off WHERE user_id = ANY($1::uuid[])`, [[tech.id, tech2.id]]);
    await q(`DELETE FROM user_client_access WHERE user_id = $1`, [limited.id]);
    await q(`DELETE FROM time_entries WHERE client_id = ANY($1::uuid[])`, [made.clients]);
    await q(`DELETE FROM tickets WHERE subject LIKE 'GC %'`);
    await q(`DELETE FROM contacts WHERE id = $1`, [contact]);
    await q(`DELETE FROM email_templates WHERE key LIKE 'visit_%'`);
    sink.close();
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
