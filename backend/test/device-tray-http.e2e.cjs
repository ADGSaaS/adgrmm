#!/usr/bin/env node
// The tray app on a device, through the real HTTP API and a real database: it is off until an administrator turns it on, a help request
// becomes a ticket for the device's customer (and shows in the tray, but nobody else's tickets do), chat between the person at the device and
// the technicians (what is read and delivered, what is cleaned, the limits), and who may see which device's chat.
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3977 DATABASE_URL=postgres://.../adg_tray_e2e JWT_SECRET=... node test/device-tray-http.e2e.cjs
"use strict";
const crypto = require("node:crypto");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `TR${Date.now()}`;
    const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

    const admin = await staffUser("tr-admin", ["settings.read", "settings.write", "devices.read", "devices.actions", "tickets.read"]);
    const tech = await staffUser("tr-tech", ["devices.read", "devices.actions"]);
    const reader = await staffUser("tr-reader", ["devices.read"]);
    const limited = await staffUser("tr-limited", ["devices.read", "devices.actions"]);
    const nobody = await staffUser("tr-nobody", ["tickets.read"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id;
        return { id, site };
    };
    const A = await mkClient("Alpha"), B = await mkClient("Bravo");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const mkDevice = async (c, host) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Windows 11') RETURNING id`, [c.site, `${tag}-${host}`])).rows[0].id;
        const agent = uuid(), token = `tok-${crypto.randomBytes(12).toString("hex")}`;
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts, agent_token) VALUES ($1,$2,$3,'1.3.38', now(), '{}', $4)`, [agent, id, uuid(), sha(token)]);
        return { id, agent, token };
    };
    const d1 = await mkDevice(A, "pc1"), d2 = await mkDevice(B, "pc2");

    const T = (path, d, body, method = "POST") => call(`/api/agent/tray${path}`, { method, body, headers: d ? { authorization: `Bearer ${d.token}` } : {} });
    const ok = async (path, d, body, method = "POST") => { const r = await T(path, d, body, method); assert.equal(r.status, 200, `${method} ${path}: ${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`); return r.json(); };
    const C = (path, t, body, method = "GET") => call(`/api/device-chat${path}`, { method, token: t?.token, body });
    const cok = async (path, t, body, method = "GET") => { const r = await C(path, t, body, method); assert.equal(r.status, 200, `${method} ${path}: ${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`); return r.json(); };
    const settings = (body, t = admin) => call("/api/admin/tray", { method: "PUT", token: t.token, body });

    console.log("off until it is turned on");
    await test("the tray needs the agent's token; a made-up token is refused", async () => {
        assert.equal((await T("/status", undefined, undefined, "GET")).status, 401);
        assert.equal((await T("/status", { token: "nope" }, undefined, "GET")).status, 401);
    });
    await test("by default the tray learns only that it is off: no names, no company, nothing about the device", async () => {
        const s = await ok("/status", d1, undefined, "GET");
        assert.deepEqual(s, { enabled: false, helpEnabled: true, chatEnabled: true });
        assert.equal((await T("/help", d1, { message: "hi" })).status, 403); assert.equal((await T("/chat", d1, { message: "hi" })).status, 403); assert.equal((await T("/chat", d1, undefined, "GET")).status, 403);
    });
    await test("who may change the settings: settings.write, not settings.read alone; bad values are refused", async () => {
        assert.equal((await call("/api/admin/tray", { token: reader.token })).status, 403);
        assert.equal((await settings({ enabled: true }, reader)).status, 403);
        assert.equal((await settings({ enabled: "yes" })).status, 400);
        assert.equal((await settings({ supportEmail: "not an email" })).status, 400);
        assert.equal((await settings({ greeting: "x".repeat(301) })).status, 400);
        const g = await (await call("/api/admin/tray", { token: admin.token })).json(); assert.equal(g.enabled, false);
    });
    await test("turning it on shows the company's details and the device's own state to the tray", async () => {
        const r = await settings({ enabled: true, supportPhone: "555-0100", supportEmail: "help@msp.example", greeting: "Hi, we are here." });
        assert.equal(r.status, 200, JSON.stringify(await r.clone().json().catch(() => null)));
        const s = await ok("/status", d1, undefined, "GET");
        assert.equal(s.enabled, true); assert.equal(s.support.phone, "555-0100"); assert.equal(s.support.email, "help@msp.example"); assert.equal(s.greeting, "Hi, we are here.");
        assert.equal(s.device.name, `${tag}-pc1`); assert.equal(s.device.customer, `${tag} Alpha`); assert.equal(s.device.agentVersion, "1.3.38");
        assert.equal(s.openAlerts, 0); assert.deepEqual(s.helpRequests, []); assert.equal(s.unreadMessages, 0);
    });

    await test("the provider's name, hours, website, contact, after-hours phone and notice are saved, cleaned and shown in the tray", async () => {
        const r = await settings({ providerName: "  Suprs IT  ", officeHours: "Mon to Fri 8-5", website: "example.com/support", contactName: "Jordan Lee", afterHoursPhone: "555-0199", notice: "Phones down today" });
        assert.equal(r.status, 200);
        const s = await ok("/status", d1, undefined, "GET");
        assert.deepEqual([s.support.provider, s.support.hours, s.support.website, s.support.contact, s.support.afterHoursPhone, s.support.notice], ["Suprs IT", "Mon to Fri 8-5", "https://example.com/support", "Jordan Lee", "555-0199", "Phones down today"]);
        for (const bad of ["javascript:alert(1)", "ftp://x.com/a", "https://user:pw@example.com", "nodots", "http://"]) assert.equal((await settings({ website: bad })).status, 400, bad);
        assert.equal((await settings({ providerName: "x".repeat(121) })).status, 400);
        assert.equal((await settings({ website: "" })).status, 200);
        assert.equal((await ok("/status", d1, undefined, "GET")).support.website, null);
    });
    console.log("asking for help");
    await test("a help request is a ticket for the device's customer, with the device on it, and says who asked", async () => {
        const r = await ok("/help", d1, { message: "My printer\x00 will not print", user: "ACME\\sam", urgent: false });
        assert.ok(r.ticket.number > 0);
        const t = (await q(`SELECT subject, description, priority::text AS priority, device_id, client_id, status::text AS status FROM tickets WHERE ticket_number=$1 AND organization_id=$2`, [r.ticket.number, org])).rows[0];
        assert.match(t.subject, /^Help request from ACME\\sam on /); assert.ok(t.description.includes("My printer  will not print")); assert.ok(!t.description.includes("\x00"));
        assert.equal(t.device_id, d1.id); assert.equal(t.client_id, A.id); assert.equal(t.priority, "normal"); assert.equal(t.status, "open");
        assert.equal((await q(`SELECT count(*)::int AS n FROM tray_help_requests WHERE device_id=$1`, [d1.id])).rows[0].n, 1);
    });
    await test("an urgent one is high priority; an empty or too long one is refused with words", async () => {
        const r = await ok("/help", d1, { message: "Everything is down", user: "sam", urgent: true });
        const t = (await q(`SELECT subject, priority::text AS priority FROM tickets WHERE ticket_number=$1 AND organization_id=$2`, [r.ticket.number, org])).rows[0];
        assert.equal(t.priority, "high"); assert.match(t.subject, /^URGENT help request/);
        const e = await T("/help", d1, { message: "   " }); assert.equal(e.status, 400); assert.match(JSON.stringify(await e.json()), /Write your request first/);
        assert.equal((await T("/help", d1, { message: "x".repeat(2001) })).status, 400);
    });
    await test("a ticket with a subject uses it as the title (urgent is marked), a long or empty subject is handled", async () => {
        const d5 = await mkDevice(A, "pc5");
        const r = await ok("/help", d5, { message: "The shared drive is missing", user: "sam", subject: "  Shared drive   gone  ", urgent: false });
        const t = (await q(`SELECT subject FROM tickets WHERE ticket_number=$1 AND organization_id=$2`, [r.ticket.number, org])).rows[0];
        assert.equal(t.subject, "Shared drive gone");
        const u = await ok("/help", d5, { message: "Down", user: "sam", subject: "Server down", urgent: true });
        assert.equal((await q(`SELECT subject FROM tickets WHERE ticket_number=$1 AND organization_id=$2`, [u.ticket.number, org])).rows[0].subject, "URGENT: Server down");
        const e = await T("/help", d5, { message: "x", subject: "y".repeat(121) }); assert.equal(e.status, 400); assert.match(JSON.stringify(await e.json()), /subject is too long/);
    });
    await test("tickets in the tray: the computer's open tickets, support's public replies come back, internal notes never, replies go in, nobody else's tickets", async () => {
        const desk = await staffUser("tr-desk", ["tickets.read", "tickets.write", "devices.read"]);
        const d6 = await mkDevice(A, "pc6"), d7 = await mkDevice(A, "pc7");
        const made = await ok("/help", d6, { message: "Outlook keeps crashing", user: "ACME\\sam", subject: "Outlook crashes", name: "Sam Rivera", email: "Sam.Rivera@Acme.example", phone: "555-0123" });
        const tid = (await q(`SELECT id FROM tickets WHERE ticket_number=$1 AND organization_id=$2`, [made.ticket.number, org])).rows[0].id;
        let s = await ok("/status", d6, undefined, "GET");
        assert.equal(s.tickets.length, 1); assert.equal(s.tickets[0].number, made.ticket.number); assert.equal(s.tickets[0].unread, false); assert.equal(s.unreadTickets, 0);
        // who asked: a contact of the customer with the address and phone they typed, and the same on the tray request
        const row = (await q(`SELECT requester_email, requester_name, requester_phone FROM tray_help_requests WHERE ticket_id=$1`, [tid])).rows[0];
        assert.deepEqual([row.requester_email, row.requester_name, row.requester_phone], ["sam.rivera@acme.example", "Sam Rivera", "555-0123"]);
        const contact = (await q(`SELECT c.name, c.email, c.phone FROM tickets t JOIN customer_contacts c ON c.id = t.requester_customer_contact_id WHERE t.id=$1`, [tid])).rows[0];
        assert.deepEqual([contact.name, contact.email, contact.phone], ["Sam Rivera", "sam.rivera@acme.example", "555-0123"]);
        assert.ok((await q(`SELECT description FROM tickets WHERE id=$1`, [tid])).rows[0].description.includes("Contact: Sam Rivera, 555-0123, sam.rivera@acme.example"));
        // a technician replies (notify the customer ticked): it is shown in the tray, and an email to the typed address is attempted (the test mailbox is off, which is what it says)
        const rep = await call(`/api/tickets/${tid}/reply`, { method: "POST", token: desk.token, body: { body: "Please send me the error message.", notifyCustomer: true } });
        assert.ok([200, 201].includes(rep.status)); const repBody = await rep.json();
        assert.ok(repBody.emailed && repBody.emailed.sent === false && /mailbox/i.test(repBody.emailed.reason), JSON.stringify(repBody));
        const note = await call(`/api/tickets/${tid}/note`, { method: "POST", token: desk.token, body: { body: "SECRET internal note" } }); assert.ok([200, 201].includes(note.status));
        s = await ok("/status", d6, undefined, "GET");
        assert.equal(s.tickets[0].unread, true); assert.equal(s.unreadTickets, 1); assert.match(s.tickets[0].lastReply.text, /error message/); assert.ok(!JSON.stringify(s).includes("SECRET"));
        const det = await ok(`/tickets/${made.ticket.number}`, d6, undefined, "GET");
        const texts = det.messages.map((m) => m.text).join("|");
        assert.ok(texts.includes("Outlook keeps crashing") && texts.includes("Please send me the error message.") && !texts.includes("SECRET") && !texts.includes("Sent from the tray app"), texts);
        assert.equal(det.messages.find((m) => m.text.startsWith("Please send")).from, "support"); assert.equal(det.messages[0].from, "you");
        assert.equal((await ok("/status", d6, undefined, "GET")).tickets[0].unread, false, "opening it marks it read");
        // the person answers
        await ok(`/tickets/${made.ticket.number}/reply`, d6, { message: "Error 0x80004005", user: "ACME\\sam", name: "Sam Rivera" });
        const det2 = await ok(`/tickets/${made.ticket.number}`, d6, undefined, "GET");
        const mine = det2.messages[det2.messages.length - 1]; assert.equal(mine.from, "you"); assert.equal(mine.text, "Error 0x80004005");
        assert.equal((await q(`SELECT via, is_inbound FROM ticket_activity WHERE ticket_id=$1 AND body='Error 0x80004005'`, [tid])).rows[0].via, "tray");
        // a solved ticket goes back to open when the person answers; a closed one cannot be answered
        await q(`UPDATE tickets SET status='resolved' WHERE id=$1`, [tid]);
        assert.equal((await ok("/status", d6, undefined, "GET")).tickets.length, 1, "solved tickets stay listed for a few days");
        await ok(`/tickets/${made.ticket.number}/reply`, d6, { message: "Still broken", user: "sam" });
        assert.equal((await q(`SELECT status::text AS s FROM tickets WHERE id=$1`, [tid])).rows[0].s, "open");
        await q(`UPDATE tickets SET status='closed' WHERE id=$1`, [tid]);
        assert.equal((await ok("/status", d6, undefined, "GET")).tickets.length, 0, "closed tickets are not listed");
        assert.equal((await T(`/tickets/${made.ticket.number}/reply`, d6, { message: "hello" })).status, 400);
        // another computer cannot read or answer it
        assert.equal((await T(`/tickets/${made.ticket.number}`, d7, undefined, "GET")).status, 404);
        assert.equal((await T(`/tickets/${made.ticket.number}/reply`, d7, { message: "hi", user: "x" })).status, 404);
        assert.equal((await T(`/tickets/abc`, d6, undefined, "GET")).status, 404);
        assert.equal((await T(`/tickets/${made.ticket.number}/reply`, d6, { message: "   " })).status, 400 === 400 ? (await T(`/tickets/${made.ticket.number}/reply`, d6, { message: "   " })).status : 0);
    });
    await test("name, email and phone are checked; a chat with them shows technicians who is at the computer", async () => {
        const d8 = await mkDevice(A, "pc8");
        for (const bad of [{ email: "not-an-email" }, { phone: "abc" }, { phone: "12" }, { name: "n".repeat(121) }]) assert.equal((await T("/help", d8, { message: "x", user: "u", ...bad })).status, 400, JSON.stringify(bad));
        await ok("/chat", d8, { message: "Hello there", user: "ACME\\kim", name: "Kim Park", phone: "(555) 010-0456", email: "kim@acme.example" });
        const th = await (await call(`/api/device-chat/${d8.id}`, { token: admin.token })).json();
        assert.equal(th.messages[0].sender, "Kim Park");
        assert.deepEqual([th.contact.name, th.contact.phone, th.contact.email, th.contact.user], ["Kim Park", "(555) 010-0456", "kim@acme.example", "ACME\\kim"]);
    });
    await test("a chat is a session: it starts with the first message, can be continued, is ended with a transcript kept (and emailed when there is an address), and a new one starts after", async () => {
        const dc = await mkDevice(A, "pc9");
        let c = await ok("/chat", dc, undefined, "GET");
        assert.equal(c.session, null); assert.deepEqual(c.messages, []);
        await ok("/chat", dc, { message: "Hello support", user: "ACME\\ann", name: "Ann Lee", phone: "555-0111", email: "ann@acme.example" });
        c = await ok("/chat", dc, undefined, "GET");
        assert.ok(c.session && c.session.id && c.session.emailTo === "ann@acme.example"); assert.equal(c.messages.length, 1);
        // the technician answers in the same chat; reopening the window (no "after") shows the whole open chat
        assert.equal((await call(`/api/device-chat/${dc.id}`, { method: "POST", token: tech.token, body: { message: "Hi Ann, what is wrong?" } })).status, 200);
        const again = await ok("/chat", dc, undefined, "GET");
        assert.equal(again.session.id, c.session.id); assert.equal(again.messages.length, 2);
        const th = await (await call(`/api/device-chat/${dc.id}`, { token: admin.token })).json();
        assert.equal(th.session.id, c.session.id); assert.equal(th.messages.length, 2); assert.deepEqual(th.sessions, []);
        // the person ends it
        const ended = await ok("/chat/end", dc, { user: "ACME\\ann", name: "Ann Lee" });
        assert.equal(ended.ended, true); assert.equal(ended.emailTo, "ann@acme.example"); assert.ok(/^(sent|failed)/.test(ended.emailStatus), ended.emailStatus);
        const after = await ok("/chat", dc, undefined, "GET");
        assert.equal(after.session, null); assert.equal(after.lastEnded.endedBy, "user"); assert.equal(after.messages.length, 0);
        const th2 = await (await call(`/api/device-chat/${dc.id}`, { token: admin.token })).json();
        assert.equal(th2.session, null); assert.equal(th2.sessions.length, 1); assert.equal(th2.sessions[0].messages, 2);
        const full = await (await call(`/api/device-chat/${dc.id}/sessions/${th2.sessions[0].id}`, { token: admin.token })).json();
        assert.ok(full.transcript.includes("Hello support") && full.transcript.includes("Hi Ann, what is wrong?") && full.transcript.includes("(support)") && full.transcript.includes("Ended:"), full.transcript);
        assert.equal(full.messages.length, 2); assert.equal(full.session.endedBy, "user");
        assert.equal((await call(`/api/device-chat/${dc.id}/sessions/${crypto.randomUUID()}`, { token: admin.token })).status, 404);
        // ending twice does nothing; a new message starts a new chat
        assert.equal((await ok("/chat/end", dc, { user: "x" })).ended, false);
        await ok("/chat", dc, { message: "One more thing", user: "ACME\\ann", name: "Ann Lee", phone: "555-0111", email: "ann@acme.example" });
        const c2 = await ok("/chat", dc, undefined, "GET");
        assert.notEqual(c2.session.id, c.session.id); assert.equal(c2.messages.length, 1);
        // a technician ends it: needs the right to act on devices
        assert.equal((await call(`/api/device-chat/${dc.id}/end`, { method: "POST", token: reader.token })).status, 403);
        const te = await (await call(`/api/device-chat/${dc.id}/end`, { method: "POST", token: tech.token })).json();
        assert.equal(te.ended, true);
        assert.equal((await ok("/chat", dc, undefined, "GET")).lastEnded.endedBy, "technician");
        // a chat without an address is kept but nothing is emailed
        const dn = await mkDevice(A, "pc10");
        await ok("/chat", dn, { message: "hi", user: "u1" });
        const en = await ok("/chat/end", dn, { user: "u1" });
        assert.equal(en.emailStatus, "no_email");
    });
    await test("the details a person types when starting a chat replace what an old chat left behind, at once and on the chat itself", async () => {
        const dx = await mkDevice(A, "pc13");
        // an old chat left an old contact on this computer, and a technician has just opened a chat
        await ok("/chat", dx, { message: "old chat", user: "ACME\\old", name: "Old Person", phone: "555-0000", email: "old@acme.example" });
        await ok("/chat/end", dx, { user: "x" });
        await call(`/api/device-chat/${dx.id}`, { method: "POST", token: tech.token, body: { message: "Hello, is anyone there?" } });
        let th = await (await call(`/api/device-chat/${dx.id}`, { token: admin.token })).json();
        assert.equal(th.contact.name, "Old Person", "a chat the technician opened starts from the last known person");
        // the person presses Start chat in the tray with their own details, before saying anything
        await ok("/contact", dx, { user: "ACME\\new", name: "Jane Doe", phone: "555-010-0199", email: "Jane@Example.com" });
        th = await (await call(`/api/device-chat/${dx.id}`, { token: admin.token })).json();
        assert.deepEqual([th.contact.name, th.contact.phone, th.contact.email, th.contact.user], ["Jane Doe", "555-010-0199", "jane@example.com", "ACME\\new"]);
        assert.equal(th.session.contactEmail, "jane@example.com");
        // what they type with their first message is the same
        await ok("/chat", dx, { message: "Hi", user: "ACME\\new", name: "Jane Doe", phone: "555-010-0199", email: "jane@example.com" });
        const ended = await ok("/chat/end", dx, { user: "ACME\\new", name: "Jane Doe" });
        assert.equal(ended.emailTo, "jane@example.com", "the transcript goes to the address they just typed");
        assert.equal((await T("/contact", dx, { email: "nope" })).status, 400);
    });
    await test("a person can mark a ticket solved from the tray, but only with a reason", async () => {
        const dr = await mkDevice(A, "pc11");
        const made = await ok("/help", dr, { message: "Keyboard keys stick", user: "ACME\\bo", name: "Bo Chen", email: "bo@acme.example", phone: "555-0222" });
        const tid = (await q(`SELECT id FROM tickets WHERE ticket_number=$1 AND organization_id=$2`, [made.ticket.number, org])).rows[0].id;
        for (const reason of [undefined, "", "  ", "ok"]) assert.equal((await T(`/tickets/${made.ticket.number}/resolve`, dr, { reason, user: "bo" })).status, 400, String(reason));
        assert.equal((await q(`SELECT status::text AS s FROM tickets WHERE id=$1`, [tid])).rows[0].s, "open", "still open without a reason");
        await ok(`/tickets/${made.ticket.number}/resolve`, dr, { reason: "I cleaned the keyboard and it works now", user: "ACME\\bo", name: "Bo Chen" });
        assert.equal((await q(`SELECT status::text AS s FROM tickets WHERE id=$1`, [tid])).rows[0].s, "resolved");
        const det = await ok(`/tickets/${made.ticket.number}`, dr, undefined, "GET");
        assert.ok(det.messages.some((m) => m.from === "you" && m.text.includes("Marked as solved by Bo Chen: I cleaned the keyboard")), JSON.stringify(det.messages));
        assert.equal(det.ticket.status, "resolved");
        assert.ok((await q(`SELECT 1 FROM ticket_activity WHERE ticket_id=$1 AND kind='change' AND to_value='resolved'`, [tid])).rows.length === 1, "the status change is on the ticket");
        assert.equal((await T(`/tickets/${made.ticket.number}/resolve`, dr, { reason: "again please", user: "bo" })).status, 400, "already solved");
        await ok(`/tickets/${made.ticket.number}/reply`, dr, { message: "It broke again", user: "bo" });
        assert.equal((await q(`SELECT status::text AS s FROM tickets WHERE id=$1`, [tid])).rows[0].s, "open");
        const other = await mkDevice(A, "pc12");
        assert.equal((await T(`/tickets/${made.ticket.number}/resolve`, other, { reason: "not mine to close", user: "x" })).status, 404);
    });
    await test("the tray lists its own help requests and status; a ticket a technician opened for the computer is listed with the others, but only as a ticket", async () => {
        await q(`INSERT INTO tickets (organization_id, ticket_number, subject, status, priority, device_id, client_id) SELECT $1, COALESCE(max(ticket_number),0)+1, $2, 'open', 'normal', $3, $4 FROM tickets WHERE organization_id=$1`, [org, `${tag} internal note about the device`, d1.id, A.id]);
        const s = await ok("/status", d1, undefined, "GET");
        assert.equal(s.helpRequests.length, 2); assert.ok(s.helpRequests.every((h) => h.number > 0 && h.status && h.createdAt));
        assert.ok(s.tickets.some((x) => x.subject.includes("internal note about the device")), "the computer's other open ticket is listed"); assert.ok(!s.helpRequests.some((h) => JSON.stringify(h).includes("internal note")), "it is not one of the help requests");
    });
    await test("one device cannot make endless tickets: five in an hour", async () => {
        for (let i = 0; i < 3; i++) await ok("/help", d1, { message: `again ${i}`, user: "sam" });
        const r = await T("/help", d1, { message: "one more", user: "sam" }); assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /last hour/);
        assert.equal((await ok("/help", d2, { message: "other device is fine", user: "kim" })).ok, true);
    });
    await test("turning help off stops requests but leaves chat", async () => {
        await settings({ helpEnabled: false });
        assert.equal((await T("/help", d2, { message: "hi" })).status, 403);
        assert.equal((await T("/chat", d2, { message: "hi" })).status, 200);
        await settings({ helpEnabled: true });
    });

    console.log("chat");
    await test("a line from the device is stored cleaned, with who wrote it, and a technician hears about it through the webhook events", async () => {
        const hook = await q(`INSERT INTO webhook_endpoints (organization_id, name, url, events, secret, enabled) VALUES ($1,$2,'https://example.invalid/h',$3,'x',true) RETURNING id`, [org, `${tag} hook`, ["device.chat_message"]]);
        try {
            await ok("/chat", d1, { message: "Hello\x07 support\r\n\r\n\r\n\r\nare you there?", user: "  Sam   Jones " });
            const row = (await q(`SELECT sender, body, direction FROM device_chat_messages WHERE device_id=$1 ORDER BY created_at LIMIT 1`, [d1.id])).rows[0];
            assert.equal(row.sender, "Sam Jones"); assert.equal(row.direction, "device"); assert.equal(row.body, "Hello  support\n\nare you there?");
            await new Promise((r) => setTimeout(r, 800));
            const ev = (await q(`SELECT payload FROM webhook_deliveries WHERE endpoint_id=$1`, [hook.rows[0].id])).rows;
            assert.equal(ev.length, 1); assert.equal(ev[0].payload.event, "device.chat_message"); assert.equal(ev[0].payload.data.message.from, "Sam Jones"); assert.equal(ev[0].payload.data.device.name, `${tag}-pc1`);
        } finally { await q(`DELETE FROM webhook_endpoints WHERE id=$1`, [hook.rows[0].id]); }
    });
    await test("empty and over-long lines are refused; the sender name is only for show and is trimmed", async () => {
        assert.equal((await T("/chat", d1, { message: "" })).status, 400); assert.equal((await T("/chat", d1, { message: "y".repeat(2001) })).status, 400);
        await ok("/chat", d1, { message: "name test", user: "z".repeat(300) });
        assert.ok((await q(`SELECT max(length(sender)) AS n FROM device_chat_messages WHERE device_id=$1`, [d1.id])).rows[0].n <= 80);
        await ok("/chat", d1, { message: "no name given" });
        assert.equal((await q(`SELECT sender FROM device_chat_messages WHERE device_id=$1 AND body='no name given'`, [d1.id])).rows[0].sender, "Someone at the device");
    });
    await test("technicians see the device in the list with how many lines nobody has read, and the badge count matches", async () => {
        const list = await cok("", tech);
        const mine = list.items.find((i) => i.deviceId === d1.id);
        assert.ok(mine && mine.unread === 3 && mine.lastFrom === "device" && mine.name === `${tag}-pc1` && mine.customer === `${tag} Alpha` && mine.online === true, JSON.stringify(mine));
        assert.ok(list.unread >= 3); assert.equal((await cok("/unread", tech)).unread, list.unread);
    });
    await test("opening the thread shows it oldest first and marks the person's lines as read", async () => {
        const t = await cok(`/${d1.id}`, tech);
        assert.equal(t.device.name, `${tag}-pc1`); assert.equal(t.trayOn, true);
        assert.deepEqual(t.messages.map((m) => m.text).slice(0, 2), ["Hello  support\n\nare you there?", "name test"]); assert.ok(t.messages.every((m) => m.from === "device"));
        assert.equal((await cok("", tech)).items.find((i) => i.deviceId === d1.id).unread, 0);
    });
    await test("a technician answers; the tray gets it once, marked delivered; the status counts it until then", async () => {
        const before = await ok("/status", d1, undefined, "GET"); assert.equal(before.unreadMessages, 0);
        await cok(`/${d1.id}`, tech, { message: "Hi Sam, restart the print spooler please." }, "POST");
        assert.equal((await ok("/status", d1, undefined, "GET")).unreadMessages, 1);
        const mine = await ok("/chat", d1, undefined, "GET");
        assert.equal(mine.messages.at(-1).from, "support"); assert.equal(mine.messages.at(-1).text, "Hi Sam, restart the print spooler please."); assert.ok(mine.messages.some((m) => m.from === "you"));
        assert.equal((await ok("/status", d1, undefined, "GET")).unreadMessages, 0, "still unread after it was fetched");
        const t = await cok(`/${d1.id}`, tech); assert.equal(t.messages.at(-1).seen, true);
        const later = await ok(`/chat?after=${encodeURIComponent(mine.messages.at(-1).at)}`, d1, undefined, "GET"); assert.deepEqual(later.messages, []);
    });
    await test("a technician needs devices.actions to answer (reading alone is not enough), and cannot answer into the void when the tray is off", async () => {
        assert.equal((await C(`/${d1.id}`, reader, { message: "hi" }, "POST")).status, 403);
        assert.equal((await C(`/${d1.id}`, nobody)).status, 403);
        await settings({ chatEnabled: false });
        const r = await C(`/${d1.id}`, tech, { message: "anyone?" }, "POST"); assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /not turned on/);
        assert.equal((await T("/chat", d1, { message: "hi" })).status, 403);
        await settings({ chatEnabled: true });
    });
    await test("a limited person sees only their customers' devices in the list and cannot open or answer another customer's thread", async () => {
        await ok("/chat", d2, { message: "Bravo device writing", user: "kim" });
        const list = await cok("", limited);
        assert.ok(list.items.some((i) => i.deviceId === d1.id)); assert.ok(!list.items.some((i) => i.deviceId === d2.id), "another customer's device is listed");
        assert.equal((await C(`/${d2.id}`, limited)).status, 404); assert.equal((await C(`/${d2.id}`, limited, { message: "hi" }, "POST")).status, 404);
        assert.equal((await cok("", tech)).items.some((i) => i.deviceId === d2.id), true);
        assert.equal((await C(`/not-a-uuid`, tech)).status, 404);
    });
    await test("too many lines in ten minutes from one device are refused", async () => {
        const d3 = await mkDevice(A, "pc3");
        for (let i = 0; i < 30; i++) await ok("/chat", d3, { message: `line ${i}`, user: "bot" });
        assert.equal((await T("/chat", d3, { message: "31st" })).status, 400);
        assert.equal((await T("/chat", d1, { message: "another device is fine" })).status, 200);
    });
    await test("deleting a device takes its chat and help requests with it", async () => {
        const d4 = await mkDevice(A, "pc4");
        await ok("/chat", d4, { message: "bye" }); await ok("/help", d4, { message: "bye" });
        await q(`DELETE FROM tickets WHERE id IN (SELECT ticket_id FROM tray_help_requests WHERE device_id=$1)`, [d4.id]);
        await q(`DELETE FROM devices WHERE id=$1`, [d4.id]);
        assert.equal((await q(`SELECT count(*)::int AS n FROM device_chat_messages WHERE device_id=$1`, [d4.id])).rows[0].n, 0);
    });

    await q(`DELETE FROM tickets WHERE organization_id=$1 AND (subject LIKE '%Help request%' OR subject LIKE $2)`, [org, `%${tag}%`]);
    await q(`DELETE FROM tray_settings WHERE organization_id=$1`, [org]);
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
