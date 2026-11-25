#!/usr/bin/env node
// Customer satisfaction surveys, through the real HTTP API and the real worker: settings, who gets a survey (and who
// does not), the email, the public link (forged, tampered, expired, replayed and raced links), abuse limits, low-score
// alerts, the portal, the ticket page and the results. A small SMTP server catches the mail.
//
// Start the backend with SURVEY_WORK_MS=1500 and PUBLIC_CONSOLE_URL=http://console.test, then:
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3931 DATABASE_URL=postgres://.../riq_x_e2e JWT_SECRET=... node test/surveys-http.e2e.cjs
"use strict";
const net = require("node:net");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

function smtpSink() {
    const mails = [];
    const server = net.createServer((sock) => {
        let data = false;
        let buf = "";
        let cur = { to: [], raw: "" };
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
                    cur = { to: [], raw: "" };
                    sock.write("250 queued\r\n");
                    continue;
                }
                const nl = buf.indexOf("\r\n");
                if (nl < 0) return;
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 2);
                const cmd = line.slice(0, 4).toUpperCase();
                if (cmd === "EHLO" || cmd === "HELO") sock.write("250 sink\r\n");
                else if (cmd === "RCPT") { cur.to.push(line.toLowerCase()); sock.write("250 ok\r\n"); }
                else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); }
                else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
                else sock.write("250 ok\r\n");
            }
        });
        sock.on("error", () => { /* a client that hung up */ });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, mails, close: () => server.close() })));
}

const text = (raw) => raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 20000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(400);
    }
}

// The same key and format the server uses, so the test can make a genuine-but-expired link.
const surveyKey = () => crypto.createHmac("sha256", process.env.JWT_SECRET).update("remoteiq:ticket-survey:v1").digest("hex");
const sign = (id, exp) => `${id}.${exp}.${crypto.createHmac("sha256", surveyKey()).update(`survey:${id}:${exp}`).digest("base64url")}`;

let ipN = 20;
const freshIp = () => ({ "cf-connecting-ip": `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` });

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = Date.now();
    const sink = await smtpSink();
    const savedMail = (await q(`SELECT * FROM email_settings`)).rows;

    const admin = await staffUser("sv-admin", ["settings.read", "settings.write", "tickets.read", "tickets.write", "audit.read", "customers.read", "customers.write"]);
    const tech = await staffUser("sv-tech", ["tickets.read", "tickets.write"]);
    const nobody = await staffUser("sv-nobody", ["customers.read"]);
    const alertee = await staffUser("sv-alert", ["tickets.read"]);
    const clientA = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `SV Alpha ${stamp}`])).rows[0].id;
    const clientB = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `SV Beta ${stamp}`])).rows[0].id;
    made.clients.push(clientA, clientB);

    for (const p of ["alerts", "invites", "password_resets", "reports", "tickets"]) {
        await q(`INSERT INTO email_settings (purpose, enabled, smtp_host, smtp_port, smtp_username, smtp_use_tls, smtp_use_ssl, smtp_from_address)
                 VALUES ($1, true, '127.0.0.1', $2, '', false, false, 'riq@example.test')
                 ON CONFLICT (purpose) DO UPDATE SET enabled = true, smtp_host = '127.0.0.1', smtp_port = $2, smtp_username = '', smtp_password = NULL, smtp_use_tls = false, smtp_use_ssl = false, smtp_from_address = 'riq@example.test'`, [p, sink.port]);
    }
    await q(`DELETE FROM email_templates WHERE key IN ('survey_request','survey_low_score')`);
    await q(`DELETE FROM survey_settings`);
    await q(`DELETE FROM ticket_surveys WHERE organization_id = $1`, [org]);
    await q(`DELETE FROM portal_settings`);

    const contact = async (label) => (await q(`INSERT INTO contacts (organization_id, name, email) VALUES ($1,$2,$3) RETURNING id`, [org, `SV ${label}`, `sv-${label}-${stamp}@customer.test`])).rows[0];
    const emailOf = (label) => `sv-${label}-${stamp}@customer.test`;
    let n = 0;
    const ticket = async (label, { client = clientA, status = "open", contactLabel, account = null, assignee = tech.id } = {}) => {
        const c = contactLabel ? await contact(contactLabel) : null;
        const id = (await q(
            `INSERT INTO tickets (organization_id, ticket_number, subject, description, status, client_id, requester_contact_id, portal_account_id, assignee_user_id)
             VALUES ($1, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets WHERE organization_id = $1), $2,'Details',$3::ticket_status,$4,$5,$6,$7) RETURNING id`,
            [org, `SV ${label} ${stamp}-${++n}`, status, client, c ? c.id : null, account, assignee])).rows[0].id;
        return id;
    };
    // Moving a ticket to a status the way the ticket screen does: the status changes and the change is logged.
    const move = async (id, to, ago = 0) => {
        await q(`UPDATE tickets SET status = $2::ticket_status, closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END WHERE id = $1`, [id, to]);
        await q(`INSERT INTO ticket_activity (id, ticket_id, kind, body, author, is_internal, field, from_value, to_value, created_at)
                 VALUES ($1,$2,'change','status','Someone',true,'status','open',$3, now() - ($4 || ' minutes')::interval)`, [uuid(), id, to, String(ago)]);
    };
    const survey = async (id) => (await q(`SELECT * FROM ticket_surveys WHERE ticket_id = $1`, [id])).rows[0];
    const mailsTo = (email) => sink.mails.filter((m) => m.to.some((t) => t.includes(email.toLowerCase())));
    const tokenFrom = (mail) => {
        const m = text(mail.raw).match(/survey\?t=([A-Za-z0-9._-]+)/);
        return m ? m[1] : null;
    };
    const put = (body, token = admin.token) => call("/api/admin/surveys/settings", { method: "PUT", token, body });

    /* ---------------------------------------------------------------- settings */
    console.log("settings");
    await test("only people with the settings right can read or change them", async () => {
        assert.equal((await call("/api/admin/surveys/settings")).status, 401);
        assert.equal((await call("/api/admin/surveys/settings", { token: tech.token })).status, 403);
        assert.equal((await put({ enabled: true }, tech.token)).status, 403);
        assert.equal((await call("/api/admin/surveys/summary", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/admin/surveys/options", { token: nobody.token })).status, 403);
        const s = await json("/api/admin/surveys/settings", { token: admin.token });
        assert.equal(s.enabled, false);
        assert.deepEqual(s.triggerStatuses, ["resolved", "closed"]);
    });

    await test("settings are checked", async () => {
        for (const bad of [
            { triggerStatuses: [] }, { triggerStatuses: ["open"] }, { delayMinutes: -1 }, { delayMinutes: 1.5 }, { delayMinutes: "soon" },
            { scope: "some" }, { clientIds: ["nope"] }, { clientIds: [uuid()] }, { throttleDays: 366 }, { expiryDays: 0 }, { scale: "emoji" },
            { lowThreshold: 5 }, { alertUserIds: [uuid()] }, { alertGroupIds: [uuid()] }, { alertUserIds: "x" },
            { reminderEnabled: true, reminderAfterDays: 40, expiryDays: 30 }, { scope: "selected", enabled: true },
        ]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
        const o = await json("/api/admin/surveys/options", { token: admin.token });
        assert.ok(o.clients.some((c) => c.id === clientA) && o.users.some((u) => u.id === admin.id) && Array.isArray(o.groups));
    });

    // A ticket resolved before surveys are on, and one resolved while they are off: neither is ever asked about.
    const before = await ticket("before", { contactLabel: "before" });
    await move(before, "resolved");

    await test("nothing is sent while surveys are off, and tickets finished before they were turned on are never asked", async () => {
        await sleep(3500);
        assert.equal(await survey(before), undefined);
        assert.equal(mailsTo(emailOf("before")).length, 0);
        assert.equal((await put({
            enabled: true, delayMinutes: 0, throttleDays: 14, reminderEnabled: true, reminderAfterDays: 1, expiryDays: 30, scale: "stars", lowThreshold: 2,
            alertUserIds: [alertee.id],
        })).status, 200);
        await sleep(3500);
        assert.equal(await survey(before), undefined, "still not asked");
        assert.equal(mailsTo(emailOf("before")).length, 0);
    });

    /* ---------------------------------------------------------------- sending */
    console.log("sending");
    const t1 = await ticket("first", { contactLabel: "one" });
    await move(t1, "resolved");
    let token1;

    await test("a resolved ticket sends the requester one email with a signed link and one link per rating", async () => {
        const mail = await waitFor(() => mailsTo(emailOf("one"))[0], "the survey email");
        const body = text(mail.raw);
        assert.match(body, /Subject: .*How did we do\? Ticket #/);
        assert.match(body, /5 - Very happy: http:\/\/console\.test\/survey\?t=/);
        assert.match(body, /&r=1/);
        token1 = tokenFrom(mail);
        assert.ok(token1 && token1.split(".").length === 3);
        const row = await survey(t1);
        assert.equal(row.status, "sent");
        assert.equal(row.recipient_email, emailOf("one"));
        assert.equal(row.technician_user_id, tech.id);
        assert.ok(new Date(row.expires_at) > new Date(Date.now() + 29 * 86400000));
        assert.equal(mailsTo(emailOf("one")).length, 1);
    });

    await test("a ticket is never surveyed twice, even when it is resolved again", async () => {
        await move(t1, "open");
        await move(t1, "closed");
        await sleep(4000);
        assert.equal((await q(`SELECT count(*)::int AS n FROM ticket_surveys WHERE ticket_id = $1`, [t1])).rows[0].n, 1);
        assert.equal(mailsTo(emailOf("one")).length, 1);
    });

    await test("the same person is not asked again within the throttle days, for another ticket", async () => {
        const t = await ticket("throttled", { contactLabel: "one-again" });
        await q(`UPDATE contacts SET email = $2 WHERE id = (SELECT requester_contact_id FROM tickets WHERE id = $1)`, [t, emailOf("one")]);
        await move(t, "resolved");
        const row = await waitFor(() => survey(t), "the decision");
        assert.equal(row.status, "skipped");
        assert.equal(row.skip_reason, "throttled");
        assert.equal(mailsTo(emailOf("one")).length, 1);
    });

    await test("a ticket with nobody to ask is skipped quietly, and a ticket that was reopened before sending is not sent", async () => {
        const t = await ticket("nobody");
        await move(t, "resolved");
        const row = await waitFor(() => survey(t), "the decision");
        assert.deepEqual([row.status, row.skip_reason], ["skipped", "no_recipient"]);
    });

    await test("only the chosen customers are asked when the setting says so", async () => {
        assert.equal((await put({ scope: "selected", clientIds: [clientB] })).status, 200);
        const t = await ticket("scope", { client: clientA, contactLabel: "scope" });
        await move(t, "resolved");
        const row = await waitFor(() => survey(t), "the decision");
        assert.deepEqual([row.status, row.skip_reason], ["skipped", "customer_not_included"]);
        const tb = await ticket("scope-b", { client: clientB, contactLabel: "scopeb" });
        await move(tb, "resolved");
        await waitFor(() => mailsTo(emailOf("scopeb"))[0], "the email for the chosen customer");
        assert.equal((await put({ scope: "all" })).status, 200);
    });

    await test("the wording comes from the email templates, and a saved wording is used", async () => {
        const saved = await call("/api/admin/email-templates/survey_request", { method: "PUT", token: admin.token, body: { subject: "Rate #{{ticket_number}} please", body: "Hi {{name}}\n{{rating_links}}\n{{link}}" } });
        assert.equal(saved.status, 200);
        const bad = await call("/api/admin/email-templates/survey_request", { method: "PUT", token: admin.token, body: { subject: "x", body: "no link here" } });
        assert.equal(bad.status, 400, "the link is required");
        const t = await ticket("wording", { contactLabel: "wording" });
        await move(t, "resolved");
        const mail = await waitFor(() => mailsTo(emailOf("wording"))[0], "the email");
        assert.match(text(mail.raw), /Subject: Rate #\d+ please/);
        await call("/api/admin/email-templates/survey_request", { method: "DELETE", token: admin.token });
    });

    /* ---------------------------------------------------------------- the public link */
    console.log("the public link");
    const pub = (t, opts = {}) => call(`/api/survey/${t}`, { headers: freshIp(), ...opts });
    const answer = (t, body, headers = freshIp()) => call(`/api/survey/${t}`, { method: "POST", body, headers });

    await test("opening the link shows the survey without recording anything, and works without signing in", async () => {
        const a = await json(`/api/survey/${token1}`, { headers: freshIp() });
        const b = await json(`/api/survey/${token1}`, { headers: freshIp() });
        assert.equal(a.state, "open");
        assert.equal(a.scale, "stars");
        assert.ok(a.subject.startsWith("SV first"));
        assert.deepEqual(a, b);
        assert.equal((await survey(t1)).status, "sent");
        const res = await pub(token1);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("referrer-policy"), "no-referrer");
        // It is also served where the portal's own domain can reach it.
        assert.equal((await call(`/api/portal/survey/${token1}`, { headers: freshIp() })).status, 200);
    });

    await test("forged, changed and cut-off links all get the same answer and reveal nothing", async () => {
        const [id, exp, sig] = token1.split(".");
        const other = uuid();
        const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
        const forged = [
            `${id}.${exp}.${flipped}`,
            `${id}.${Number(exp) + 86400 * 365}.${sig}`, // a longer life
            `${id}.${Number(exp) - 1}.${sig}`,
            `${other}.${exp}.${sig}`,
            `${other}.${exp}.${crypto.randomBytes(32).toString("base64url")}`,
            sign(other, Math.floor(Date.now() / 1000) + 3600), // genuinely signed, but for a survey that does not exist
            `${id}.${exp}`, `${id}`, `${id}.${exp}.`, "a.b", "x".repeat(300), `${id}.${exp}.${sig}.extra`, `${id.toUpperCase()}.${exp}.${sig}`,
            `${id}.abc.${sig}`, "null", "undefined", "%00", "..%2f..%2fetc%2fpasswd", id,
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", // a JWT is not a survey link
        ];
        const bodies = new Set();
        for (const t of forged) {
            const res = await pub(encodeURIComponent(t));
            assert.ok(res.status === 404 || res.status === 400, `${t.slice(0, 40)} -> ${res.status}`);
            if (res.status === 404) bodies.add(JSON.stringify(await res.json()));
            const post = await answer(encodeURIComponent(t), { score: 5 });
            assert.ok(post.status === 404 || post.status === 400, `POST ${t.slice(0, 40)} -> ${post.status}`);
        }
        assert.equal(bodies.size, 1, "one message for every kind of bad link");
        assert.equal((await survey(t1)).status, "sent", "nothing was answered");
    });

    await test("a genuine link past its time is told apart from a forged one, and cannot be used", async () => {
        const row = await survey(t1);
        const old = sign(row.id, Math.floor(Date.now() / 1000) - 60);
        const view = await json(`/api/survey/${old}`, { headers: freshIp() });
        assert.equal(view.state, "expired");
        assert.equal(view.subject, "", "no ticket details on an expired link");
        assert.equal((await answer(old, { score: 5 })).status, 410);
        assert.equal((await survey(t1)).status, "sent");
    });

    await test("answers are checked: rating, comment length and type", async () => {
        for (const body of [{}, { score: 0 }, { score: 6 }, { score: "x" }, { score: 3.5 }, { score: null }, { score: [5] }, { score: 3, comment: "x".repeat(2001) }, { score: 3, comment: { a: 1 } }, { score: 3, comment: 5 }]) {
            assert.equal((await answer(token1, body)).status, 400, JSON.stringify(body).slice(0, 60));
        }
        assert.equal((await survey(t1)).status, "sent");
    });

    await test("a rating is recorded once; the link then says thank you and nothing can change it", async () => {
        const res = await answer(token1, { score: 2, comment: "  Slow.  <script>alert(1)</script>\u0000  " });
        assert.equal(res.status, 200);
        const row = await survey(t1);
        assert.equal(row.status, "answered");
        assert.equal(row.score, 2);
        assert.equal(row.comment, "Slow.  <script>alert(1)</script>", "kept as plain text, control characters removed");
        assert.equal(row.answered_via, "link");
        assert.equal((await answer(token1, { score: 5, comment: "changed" })).status, 409, "replay");
        assert.equal((await survey(t1)).score, 2);
        const view = await json(`/api/survey/${token1}`, { headers: freshIp() });
        assert.equal(view.state, "answered");
        assert.ok(!JSON.stringify(view).includes("Slow"), "the comment is not shown back");
    });

    await test("many answers at the same moment: exactly one wins", async () => {
        const t = await ticket("race", { contactLabel: "race" });
        await move(t, "resolved");
        const mail = await waitFor(() => mailsTo(emailOf("race"))[0], "the email");
        const tok = tokenFrom(mail);
        const res = await Promise.all(Array.from({ length: 12 }, (_, i) => answer(tok, { score: (i % 5) + 1, comment: `try ${i}` }, freshIp())));
        const codes = res.map((r) => r.status);
        assert.equal(codes.filter((c) => c === 200).length, 1, codes.join(","));
        assert.ok(codes.filter((c) => c !== 200).every((c) => c === 409));
        const row = await survey(t);
        assert.equal((Number(row.comment.replace("try ", "")) % 5) + 1, row.score, "the score and comment are from the same answer");
        assert.equal((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'survey.response' AND target_id = $1`, [t])).rows[0].n, 1);
    });

    await test("a survey that expired in the database cannot be answered even with a link that is still genuine", async () => {
        const t = await ticket("dbexp", { contactLabel: "dbexp" });
        await move(t, "resolved");
        const tok = tokenFrom(await waitFor(() => mailsTo(emailOf("dbexp"))[0], "the email"));
        await q(`UPDATE ticket_surveys SET expires_at = now() - interval '1 minute' WHERE ticket_id = $1`, [t]);
        assert.equal((await answer(tok, { score: 5 })).status, 410);
        assert.equal((await survey(t)).score, null);
    });

    await test("a reminder is sent once, after the chosen days, to people who have not answered", async () => {
        const t = await ticket("remind", { contactLabel: "remind" });
        await move(t, "resolved");
        await waitFor(() => mailsTo(emailOf("remind"))[0], "the first email");
        await q(`UPDATE ticket_surveys SET sent_at = now() - interval '2 days' WHERE ticket_id = $1`, [t]);
        const second = await waitFor(() => mailsTo(emailOf("remind"))[1], "the reminder");
        assert.match(text(second.raw), /Subject: Reminder: /);
        assert.equal(tokenFrom(second), tokenFrom(mailsTo(emailOf("remind"))[0]), "the same link");
        assert.ok((await survey(t)).reminded_at);
        await sleep(4000);
        assert.equal(mailsTo(emailOf("remind")).length, 2, "no third email");
    });

    await test("the public link is limited per address, and wrong links cost more", async () => {
        const ip = freshIp();
        let limited = 0;
        for (let i = 0; i < 20; i++) {
            const r = await call(`/api/survey/${uuid()}.1.${crypto.randomBytes(32).toString("base64url")}`, { headers: ip });
            if (r.status === 429) limited++;
        }
        assert.ok(limited >= 6, `limited ${limited}`);
        // A different address is not affected, and a limited one cannot answer either.
        assert.equal((await call(`/api/survey/${token1}`, { headers: freshIp() })).status, 200);
        assert.equal((await call(`/api/survey/${token1}`, { method: "POST", body: { score: 5 }, headers: ip })).status, 429);
    });

    /* ---------------------------------------------------------------- low scores */
    console.log("low scores");
    await test("a low score tells the chosen people by email and queues the ticket.survey_low webhook once", async () => {
        const ev = await json("/api/admin/webhooks", { token: admin.token });
        assert.ok(ev.events.some((e) => e.key === "ticket.survey_low"));
        const ep = (await q(`INSERT INTO webhook_endpoints (organization_id, name, url, secret, events) VALUES ($1,$2,'https://hooks.example.test/x','x', ARRAY['ticket.survey_low']) RETURNING id`, [org, `sv-hook-${stamp}`])).rows[0].id;
        try {
            const t = await ticket("low", { contactLabel: "low" });
            await move(t, "resolved");
            const tok = tokenFrom(await waitFor(() => mailsTo(emailOf("low"))[0], "the email"));
            assert.equal((await answer(tok, { score: 1, comment: "Terrible." })).status, 200);
            const mail = await waitFor(() => mailsTo(alertee.email).find((m) => text(m.raw).includes("SV low")), "the alert email");
            const body = text(mail.raw);
            assert.match(body, /Subject: \[Low score 1\/5\] Ticket #/);
            assert.match(body, /Terrible\./);
            const d = await waitFor(async () => (await q(`SELECT payload FROM webhook_deliveries WHERE endpoint_id = $1`, [ep])).rows[0], "the webhook delivery");
            assert.equal(d.payload.event, "ticket.survey_low");
            assert.equal(d.payload.data.survey.score, 1);
            assert.equal(d.payload.data.survey.comment, "Terrible.");
            await sleep(1500);
            assert.equal((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1`, [ep])).rows[0].n, 1);
            // A good score does not alert.
            const t2 = await ticket("good", { contactLabel: "good" });
            await move(t2, "resolved");
            const tok2 = tokenFrom(await waitFor(() => mailsTo(emailOf("good"))[0], "the email"));
            const alertsBefore = mailsTo(alertee.email).length;
            assert.equal((await answer(tok2, { score: 5 })).status, 200);
            await sleep(2500);
            assert.equal(mailsTo(alertee.email).length, alertsBefore);
            assert.equal((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1`, [ep])).rows[0].n, 1);
        } finally {
            await q(`DELETE FROM webhook_endpoints WHERE id = $1`, [ep]);
        }
    });

    /* ---------------------------------------------------------------- the ticket page and results */
    console.log("ticket page and results");
    await test("the ticket page can show the survey to people who can read tickets, and only them", async () => {
        const r = await json(`/api/tickets/${t1}/survey`, { token: tech.token });
        assert.equal(r.survey.status, "answered");
        assert.equal(r.survey.score, 2);
        assert.match(r.survey.comment, /^Slow/);
        assert.equal(r.survey.recipient, emailOf("one"));
        assert.equal((await call(`/api/tickets/${t1}/survey`, { token: nobody.token })).status, 403);
        assert.equal((await call(`/api/tickets/${t1}/survey`)).status, 401);
        assert.equal((await call(`/api/tickets/${uuid()}/survey`, { token: tech.token })).status, 404);
        const none = await ticket("plain");
        assert.equal((await json(`/api/tickets/${none}/survey`, { token: tech.token })).survey, null);
    });

    await test("the results: response rate, average, per technician and per customer, comments and low scores", async () => {
        const s = await json("/api/admin/surveys/summary?days=30", { token: admin.token });
        assert.ok(s.sent >= 6, `sent ${s.sent}`);
        assert.ok(s.answered >= 4);
        assert.ok(Math.abs(s.responseRate - s.answered / s.sent) < 1e-9);
        assert.ok(s.average > 1 && s.average < 5);
        assert.equal(s.distribution.reduce((a, d) => a + d.count, 0), s.answered);
        const me = s.byTechnician.find((x) => x.id === tech.id);
        assert.ok(me && me.answered >= 4 && me.sent >= me.answered);
        assert.ok(s.byCustomer.find((x) => x.id === clientA));
        assert.ok(s.comments.some((c) => c.comment === "Terrible." && c.number > 0));
        assert.ok(s.lowScores.some((c) => c.score === 1) && s.lowScores.every((c) => c.score <= 2));
        assert.ok(s.throttled >= 1);
    });

    await test("changing the settings is audited, without leaking more than the allowed fields", async () => {
        const rows = (await q(`SELECT details FROM audit_events WHERE action = 'survey.settings.update' ORDER BY created_at DESC LIMIT 3`)).rows;
        assert.ok(rows.length >= 1);
        assert.ok(!JSON.stringify(rows).includes("alertUserIds"));
    });

    /* ---------------------------------------------------------------- thumbs and the portal */
    console.log("thumbs and the portal");
    await test("with thumbs only up (5) and down (1) are accepted", async () => {
        assert.equal((await put({ scale: "thumbs" })).status, 200);
        const t = await ticket("thumbs", { contactLabel: "thumbs" });
        await move(t, "resolved");
        const mail = await waitFor(() => mailsTo(emailOf("thumbs"))[0], "the email");
        assert.match(text(mail.raw), /Thumbs up: /);
        const tok = tokenFrom(mail);
        assert.equal((await json(`/api/survey/${tok}`, { headers: freshIp() })).scale, "thumbs");
        assert.equal((await answer(tok, { score: 3 })).status, 400);
        assert.equal((await answer(tok, { score: 5 })).status, 200);
        assert.equal((await put({ scale: "stars" })).status, 200);
    });

    const PASS = "correct horse battery";
    const acct = async (client, label, role) => {
        const email = `sv-${label}-${stamp}@portal.test`;
        const id = (await q(`INSERT INTO portal_accounts (organization_id, client_id, email, name, role, status, password_hash) VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id`, [org, client, email, `${label} person`, role, await bcrypt.hash(PASS, 4)])).rows[0].id;
        const res = await call("/api/portal/auth/login", { method: "POST", body: { email, password: PASS }, headers: freshIp() });
        assert.equal(res.status, 200);
        const cookie = res.headers.getSetCookie().find((c) => c.startsWith("portal_token="));
        return { id, email, token: cookie.split(";")[0].split("=")[1] };
    };
    await q(`INSERT INTO portal_settings (organization_id, enabled, domain) VALUES ($1, true, $2) ON CONFLICT (organization_id) DO UPDATE SET enabled = true, domain = $2`, [org, `portal-sv-${stamp}.example.test`]);
    const pA = await acct(clientA, "pa", "user");
    const pB = await acct(clientB, "pb", "user");
    const pM = await acct(clientA, "pm", "manager");
    let portalTicket;
    await test("a portal ticket's survey goes to the portal person and is answered on the portal, by them or a manager of the customer only", async () => {
        portalTicket = await ticket("portal", { account: pA.id });
        await move(portalTicket, "closed");
        const mail = await waitFor(() => mailsTo(pA.email)[0], "the email to the portal person");
        const row = await survey(portalTicket);
        assert.equal(row.portal_link, true);
        assert.equal(tokenFrom(mail).split(".")[0], row.id);
        const g = (t, as) => call(`/api/portal/tickets/${portalTicket}/survey`, { portal: as?.token ?? t });
        assert.equal((await g(null, null)).status, 401);
        assert.equal((await json(`/api/portal/tickets/${portalTicket}/survey`, { portal: pB.token })).available, false, "another customer");
        assert.equal((await call(`/api/portal/tickets/${portalTicket}/survey`, { method: "POST", portal: pB.token, body: { score: 5 } })).status, 404);
        const mine = await json(`/api/portal/tickets/${portalTicket}/survey`, { portal: pA.token });
        assert.deepEqual([mine.available, mine.state, mine.scale], [true, "open", "stars"]);
        assert.equal((await json(`/api/portal/tickets/${portalTicket}/survey`, { portal: pM.token })).available, true, "the manager sees it");
        assert.equal((await call(`/api/portal/tickets/${portalTicket}/survey`, { method: "POST", portal: pA.token, body: { score: 9 } })).status, 400);
        assert.equal((await call(`/api/portal/tickets/${portalTicket}/survey`, { method: "POST", portal: pA.token, body: { score: 4, comment: "Fine" } })).status, 200);
        assert.equal((await call(`/api/portal/tickets/${portalTicket}/survey`, { method: "POST", portal: pA.token, body: { score: 1 } })).status, 409);
        const done = await json(`/api/portal/tickets/${portalTicket}/survey`, { portal: pA.token });
        assert.deepEqual([done.state, done.score], ["answered", 4]);
        assert.equal((await survey(portalTicket)).answered_via, "portal");
        // The emailed link is now used up too.
        assert.equal((await answer(tokenFrom(mail), { score: 5 })).status, 409);
    });

    await test("a staff sign-in does not open the portal survey, and a portal sign-in is not staff", async () => {
        assert.equal((await call(`/api/portal/tickets/${portalTicket}/survey`, { portal: admin.token })).status, 401);
        assert.equal((await call(`/api/tickets/${portalTicket}/survey`, { token: pA.token })).status, 401);
        assert.equal((await call("/api/admin/surveys/summary", { token: pA.token })).status, 401);
    });

    await test("nothing leaked: the survey answers carry no email addresses of other people and no stack traces", async () => {
        const res = await call(`/api/survey/${token1}`, { headers: freshIp() });
        const body = await res.text();
        assert.ok(!body.includes("@"));
        assert.ok(!/stack|prisma|SELECT /i.test(body));
    });

    // Put things back.
    await q(`DELETE FROM survey_settings`);
    await q(`DELETE FROM portal_settings`);
    await q(`DELETE FROM portal_accounts WHERE email LIKE $1`, [`sv-%-${stamp}@portal.test`]);
    await q(`DELETE FROM contacts WHERE email LIKE $1`, [`sv-%-${stamp}@customer.test`]);
    await q(`DELETE FROM email_settings`);
    for (const r of savedMail) {
        const cols = Object.keys(r);
        await q(`INSERT INTO email_settings (${cols.join(",")}) VALUES (${cols.map((_c, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]));
    }
    sink.close();
    await cleanup();
    finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
