#!/usr/bin/env node
// Templates, through the real HTTP API: ticket templates (create, edit, use from POST /api/tickets) and the editable
// system emails (portal invitation and reset, alert, invoice): saved wording is what is really sent, a test email goes
// out with sample values, and the built-in wording is back after a reset. A small SMTP server in this test catches the mail.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... node test/templates-http.e2e.cjs
"use strict";
const net = require("node:net");
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

/** A tiny SMTP server: says yes to everything and keeps the messages it was given. */
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

/** The text of a message as it was sent: its headers and body with quoted-printable undone. */
const text = (raw) => raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = Date.now();
    const sink = await smtpSink();

    const admin = await staffUser("tpl-admin", ["settings.read", "settings.write", "tickets.read", "tickets.write", "alerts.read", "alerts.manage", "billing.read", "billing.write", "audit.read", "customers.read", "customers.write"]);
    const tech = await staffUser("tpl-tech", ["tickets.read", "tickets.write"]);
    const reader = await staffUser("tpl-reader", ["tickets.read"]);
    const nobody = await staffUser("tpl-nobody", ["customers.read"]);
    const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `TPL Customer ${stamp}`])).rows[0].id;
    made.clients.push(client);

    // Mail goes to the sink, for every purpose.
    const savedMail = (await q(`SELECT * FROM email_settings`)).rows;
    for (const p of ["alerts", "invites", "password_resets", "reports", "tickets"]) {
        await q(`INSERT INTO email_settings (purpose, enabled, smtp_host, smtp_port, smtp_username, smtp_use_tls, smtp_use_ssl, smtp_from_address)
                 VALUES ($1, true, '127.0.0.1', $2, '', false, false, 'adg@example.test')
                 ON CONFLICT (purpose) DO UPDATE SET enabled = true, smtp_host = '127.0.0.1', smtp_port = $2, smtp_username = '', smtp_password = NULL, smtp_use_tls = false, smtp_use_ssl = false, smtp_from_address = 'adg@example.test'`, [p, sink.port]);
    }
    await q(`DELETE FROM email_templates`);
    await q(`DELETE FROM ticket_templates`);
    await q(`DELETE FROM custom_field_defs WHERE entity = 'ticket'`);
    const mailSince = (n) => sink.mails.slice(n);

    /* ------------------------------ ticket templates ------------------------------ */
    console.log("ticket templates");
    const field = await (await call("/api/ticket-custom-fields", { method: "POST", token: admin.token, body: { label: "Support tier", type: "dropdown", options: ["Gold", "Silver"] } })).json();
    const required = await (await call("/api/ticket-custom-fields", { method: "POST", token: admin.token, body: { label: "Contract", type: "text", required: true } })).json();
    let tpl;

    await test("only people with the settings right can change templates; people who read tickets can list them", async () => {
        const body = { name: "X", subject: "s" };
        assert.equal((await call("/api/ticket-templates", { method: "POST", token: tech.token, body })).status, 403);
        assert.equal((await call("/api/ticket-templates", { token: reader.token })).status, 200);
        assert.equal((await call("/api/ticket-templates", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/ticket-templates")).status, 401);
    });

    await test("a template is made with a subject, text, priority and custom field values, all checked", async () => {
        const res = await call("/api/ticket-templates", { method: "POST", token: admin.token, body: { name: "New starter", hint: "Accounts and a laptop", subject: "GC New starter: {name}", body: "Please set up:\n- account\n- laptop", priority: "high", customFields: { support_tier: "silver" } } });
        assert.equal(res.status, 201);
        tpl = await res.json();
        assert.equal(tpl.priority, "high");
        assert.deepEqual(tpl.customFields, { support_tier: "Silver" });
        const bad = (body) => call("/api/ticket-templates", { method: "POST", token: admin.token, body });
        assert.equal((await bad({ name: "" })).status, 400);
        assert.equal((await bad({ name: "x".repeat(81) })).status, 400);
        assert.equal((await bad({ name: "Bad priority", priority: "asap" })).status, 400);
        assert.equal((await bad({ name: "Bad value", customFields: { support_tier: "Bronze" } })).status, 400);
        assert.equal((await bad({ name: "Unknown field", customFields: { nope: "x" } })).status, 400);
        assert.equal((await bad({ name: "new STARTER" })).status, 409);
        // A required field need not be in a template: it is checked when a ticket is made.
        assert.equal((await bad({ name: "Partial", subject: "GC partial" })).status, 201);
    });

    await test("a ticket made from a template takes what the form did not give, and the form can override", async () => {
        const fromTpl = await call("/api/tickets", { method: "POST", token: tech.token, body: { templateId: tpl.id, clientId: client, customFields: { contract: "C-9" } } });
        assert.equal(fromTpl.status, 201);
        const t = await json(`/api/tickets/${(await fromTpl.json()).id}`, { token: reader.token });
        assert.equal(t.title, "GC New starter: {name}");
        assert.equal(t.description, "Please set up:\n- account\n- laptop");
        assert.equal(t.priority, "high");
        assert.deepEqual(t.customFields, { contract: "C-9", support_tier: "Silver" });

        const over = await call("/api/tickets", { method: "POST", token: tech.token, body: { templateId: tpl.id, subject: "GC My own subject", priority: "low", description: "Mine", clientId: client, customFields: { contract: "C-1", support_tier: "Gold" } } });
        const o = await json(`/api/tickets/${(await over.json()).id}`, { token: reader.token });
        assert.deepEqual([o.title, o.description, o.priority, o.customFields.support_tier], ["GC My own subject", "Mine", "low", "Gold"]);

        // The required field still has to be there.
        assert.equal((await call("/api/tickets", { method: "POST", token: tech.token, body: { templateId: tpl.id, clientId: client } })).status, 400);
        assert.equal((await call("/api/tickets", { method: "POST", token: tech.token, body: { templateId: uuid() } })).status, 400);
    });

    await test("editing a template changes later tickets only; a field archived since is left out", async () => {
        const upd = await call(`/api/ticket-templates/${tpl.id}`, { method: "PATCH", token: admin.token, body: { priority: "urgent", body: "Changed" } });
        assert.equal(upd.status, 200);
        assert.equal((await upd.json()).priority, "urgent");
        assert.equal((await call(`/api/ticket-templates/${tpl.id}`, { method: "PATCH", token: tech.token, body: { priority: "low" } })).status, 403);
        assert.equal((await call(`/api/ticket-templates/${uuid()}`, { method: "PATCH", token: admin.token, body: { priority: "low" } })).status, 404);
        await call(`/api/ticket-custom-fields/${field.id}`, { method: "DELETE", token: admin.token });
        const listed = (await json("/api/ticket-templates", { token: reader.token })).items.find((t) => t.id === tpl.id);
        assert.deepEqual(listed.customFields, {});
        const res = await call("/api/tickets", { method: "POST", token: tech.token, body: { templateId: tpl.id, clientId: client, customFields: { contract: "C-2" } } });
        assert.equal(res.status, 201); // the archived field in the template no longer breaks it
        await call(`/api/ticket-custom-fields/${field.id}`, { method: "PATCH", token: admin.token, body: { active: true } });
    });

    await test("a template can be deleted, and it is audited", async () => {
        assert.equal((await call(`/api/ticket-templates/${tpl.id}`, { method: "DELETE", token: admin.token })).status, 200);
        assert.equal((await call(`/api/ticket-templates/${tpl.id}`, { method: "DELETE", token: admin.token })).status, 404);
        assert.ok(!(await json("/api/ticket-templates", { token: reader.token })).items.some((t) => t.id === tpl.id));
        const actions = (await q(`SELECT action FROM audit_events WHERE action LIKE 'ticket_template.%'`)).rows.map((r) => r.action);
        for (const a of ["ticket_template.create", "ticket_template.update", "ticket_template.delete"]) assert.ok(actions.includes(a), a);
    });

    /* ------------------------------ email templates ------------------------------ */
    console.log("email templates");
    const list = async () => (await json("/api/admin/email-templates", { token: admin.token })).items;
    const put = (key, body, token = admin.token) => call(`/api/admin/email-templates/${key}`, { method: "PUT", token, body });

    await test("the built-in wording is listed with its variables, and only people with the settings right can read or change it", async () => {
        const items = await list();
        assert.deepEqual(items.map((i) => i.key).slice(0, 4), ["portal_invite", "portal_reset", "alert", "invoice"]);
        for (const k of ["visit_tech", "visit_customer"]) assert.ok(items.some((i) => i.key === k), k);
        for (const k of ["survey_request", "survey_low_score"]) assert.ok(items.some((i) => i.key === k), k);
        for (const i of items) {
            assert.equal(i.customized, false);
            assert.ok(i.variables.length > 0 && i.subject && i.body);
        }
        assert.equal((await call("/api/admin/email-templates", { token: tech.token })).status, 403);
        assert.equal((await put("alert", { subject: "x", body: "y" }, tech.token)).status, 403);
        assert.equal((await call("/api/admin/email-templates")).status, 401);
    });

    await test("wording that uses an unknown variable, or leaves out a needed one, is refused", async () => {
        assert.equal((await put("portal_invite", { subject: "Hi {{nope}}", body: "{{link}}" })).status, 400);
        assert.equal((await put("portal_invite", { subject: "Hi", body: "no link" })).status, 400);
        assert.equal((await put("nothing", { subject: "Hi", body: "x" })).status, 400);
        assert.equal((await put("alert", { subject: "", body: "x" })).status, 400);
    });

    await test("the preview shows an edit with sample values, without saving it", async () => {
        const r = await json("/api/admin/email-templates/portal_invite/preview", { method: "POST", token: admin.token, body: { subject: "Welcome {{name}}", body: "Go to {{link}}" } });
        assert.equal(r.subject, "Welcome Jordan Lee");
        assert.match(r.body, /^Go to https:\/\/portal\.example\.com\/set-password/);
        assert.equal((await list()).find((i) => i.key === "portal_invite").customized, false);
        assert.equal((await call("/api/admin/email-templates/portal_invite/preview", { method: "POST", token: admin.token, body: { subject: "{{bad}}", body: "{{link}}" } })).status, 400);
    });

    await test("a test email goes to the address given, with sample values and a note that it is a test", async () => {
        const before = sink.mails.length;
        const r = await json("/api/admin/email-templates/alert/test", { method: "POST", token: admin.token, body: { to: "me@example.test" } });
        assert.equal(r.ok, true, r.message);
        const [mail] = mailSince(before);
        assert.match(mail.to[0], /me@example\.test/);
        const t = text(mail.raw);
        assert.match(t, /Subject: \[Test\] \[Critical\] Disk C: is 96% full on FRONTDESK-PC/);
        assert.match(t, /Customer: Contoso Legal/);
        assert.match(t, /This is a test with sample values/);
        assert.equal((await call("/api/admin/email-templates/alert/test", { method: "POST", token: admin.token, body: { to: "not an address" } })).status, 400);
        assert.equal((await call("/api/admin/email-templates/alert/test", { method: "POST", token: tech.token, body: { to: "me@example.test" } })).status, 403);
    });

    // Portal setup used by the invitation tests.
    const domain = `tpl-${stamp}.example.test`;
    await call("/api/portal-admin/settings", { method: "PUT", token: admin.token, body: { enabled: true, domain } });
    const person = async (label) => {
        const email = `${label}-${stamp}@customer.example.test`;
        const id = (await q(`INSERT INTO portal_accounts (organization_id, client_id, email, name, role, status) VALUES ($1,$2,$3,$4,'user','invited') RETURNING id`, [org, client, email, `${label} Person`])).rows[0].id;
        return { id, email };
    };

    await test("with no edit, the portal invitation is the built-in one", async () => {
        const p = await person("builtin");
        const before = sink.mails.length;
        const res = await call(`/api/portal-admin/accounts/${p.id}/send`, { method: "POST", token: admin.token });
        assert.equal(res.status, 200);
        const [mail] = mailSince(before);
        const t = text(mail.raw);
        assert.match(t, /Subject: .*You have been invited to the customer portal/);
        assert.match(t, /Hello builtin Person,/);
        assert.match(t, new RegExp(`https://${domain.replace(/\./g, "\\.")}/set-password\\?token=`));
        assert.match(t, /the link works for 7 days/);
        await q(`DELETE FROM portal_accounts WHERE id = $1`, [p.id]);
    });

    await test("a saved wording is what the portal invitation really says", async () => {
        const saved = await put("portal_invite", { subject: "{{company_prefix}}Welcome aboard, {{name}}", body: "Hi {{name}}!\n\nStart here: {{link}}\n\nQuestions? Ask {{company}}.\nLink works {{valid_days}} days." });
        assert.equal(saved.status, 200);
        assert.equal((await saved.json()).customized, true);
        const p = await person("custom");
        const before = sink.mails.length;
        assert.equal((await call(`/api/portal-admin/accounts/${p.id}/send`, { method: "POST", token: admin.token })).status, 200);
        const t = text(mailSince(before)[0].raw);
        assert.match(t, /Subject: .*Welcome aboard, custom Person/);
        assert.match(t, /Hi custom Person!/);
        assert.match(t, /Start here: https:\/\//);
        assert.match(t, /Link works 7 days\./);
        assert.ok(!/You have been invited to the customer portal/.test(t), "the old wording is gone");
        await q(`DELETE FROM portal_accounts WHERE id = $1`, [p.id]);
    });

    await test("a password reset email uses its own wording", async () => {
        await put("portal_reset", { subject: "Reset for {{name}}", body: "Reset here: {{link}} (valid {{valid_hours}} hours)" });
        const p = await person("reset");
        await q(`UPDATE portal_accounts SET status = 'active', password_hash = 'x' WHERE id = $1`, [p.id]);
        const before = sink.mails.length;
        await call("/api/portal/auth/forgot", { method: "POST", body: { email: p.email } });
        const mail = await waitFor(() => mailSince(before)[0]);
        const t = text(mail.raw);
        assert.match(t, /Subject: Reset for reset Person/);
        assert.match(t, /Reset here: https:\/\/.*set-password\?token=.* \(valid 2 hours\)/s);
        await q(`DELETE FROM portal_accounts WHERE id = $1`, [p.id]);
    });

    await test("an alert notification email uses its wording; empty parts leave no blank lines", async () => {
        await put("alert", { subject: "ALERT {{event}}: {{title}}", body: "{{title}}\n{{customer_line}}\n\n{{detail}}\n\n{{device_line}}" });
        const ch = await (await call("/api/notifications/channels", { method: "POST", token: admin.token, body: { name: `TPL ${stamp}`, kind: "email", recipients: ["ops@example.test"] } })).json();
        const before = sink.mails.length;
        const r = await json(`/api/notifications/channels/${ch.id}/test`, { method: "POST", token: admin.token });
        assert.equal(r.ok, true, r.message);
        const t = text(mailSince(before)[0].raw);
        assert.match(t, /Subject: ALERT Test: Test notification from AdgRmm/);
        assert.match(t, /\r\nTest notification from AdgRmm\r\n\r\nIf this arrived, this channel works\.$/);
        await call(`/api/notifications/channels/${ch.id}`, { method: "DELETE", token: admin.token });
    });

    await test("an invoice email uses its wording", async () => {
        await put("invoice", { subject: "{{company_prefix}}Your {{document}} {{number}}", body: "Dear customer, {{document_title}} {{number}} totals {{total}}.\n{{due_line}}" });
        const invoice = (await q(`INSERT INTO invoices (organization_id, client_id, kind, number, status, currency, subtotal_cents, total_cents, paid_cents, issue_date, due_date)
            VALUES ($1,$2,'invoice',$3,'sent','USD',12500,12500,0, CURRENT_DATE, CURRENT_DATE + 30) RETURNING id`, [org, client, `TPL-${stamp}`])).rows[0].id;
        await q(`INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_cents, amount_cents) VALUES ($1,0,'Managed services',1,12500,12500)`, [invoice]);
        const before = sink.mails.length;
        const res = await call(`/api/billing/invoices/${invoice}/send`, { method: "POST", token: admin.token, body: { to: "billing@customer.example.test" } });
        assert.equal(res.status, 201, await res.clone().text());
        const sent = await res.json();
        assert.equal(sent.emailed, true, sent.emailError);
        const t = text(mailSince(before)[0].raw);
        assert.match(t, new RegExp(`Subject: .*Your invoice TPL-${stamp}`));
        assert.match(t, new RegExp(`Dear customer, Invoice TPL-${stamp} totals .*125`));
        assert.match(t, /It is due on \d{4}-\d{2}-\d{2}\./);
        await q(`DELETE FROM invoices WHERE id = $1`, [invoice]);
    });

    await test("resetting brings the built-in wording back, and it is all audited", async () => {
        const res = await call("/api/admin/email-templates/portal_invite", { method: "DELETE", token: admin.token });
        assert.equal(res.status, 200);
        const back = await res.json();
        assert.equal(back.customized, false);
        assert.equal(back.subject, back.defaultSubject);
        const p = await person("again");
        const before = sink.mails.length;
        await call(`/api/portal-admin/accounts/${p.id}/send`, { method: "POST", token: admin.token });
        assert.match(text(mailSince(before)[0].raw), /You have been invited to the customer portal/);
        await q(`DELETE FROM portal_accounts WHERE id = $1`, [p.id]);
        const actions = (await q(`SELECT action FROM audit_events WHERE action LIKE 'email_template.%'`)).rows.map((r) => r.action);
        for (const a of ["email_template.update", "email_template.reset", "email_template.test"]) assert.ok(actions.includes(a), a);
    });

    // ------------------------------------------------------------------ clean up
    await q(`DELETE FROM email_templates`);
    await q(`DELETE FROM ticket_templates`);
    await q(`DELETE FROM custom_field_defs WHERE entity = 'ticket'`);
    await q(`DELETE FROM portal_accounts WHERE client_id = $1`, [client]);
    await q(`DELETE FROM portal_settings`);
    await q(`DELETE FROM invoices WHERE client_id = $1`, [client]);
    await q(`DELETE FROM email_settings`);
    for (const r of savedMail) {
        const cols = Object.keys(r);
        await q(`INSERT INTO email_settings (${cols.join(",")}) VALUES (${cols.map((_c, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]));
    }
    sink.close();
    await cleanup();
    finish();
}

async function waitFor(fn, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 100));
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
