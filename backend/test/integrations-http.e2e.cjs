#!/usr/bin/env node
// The Integrations screen's API and the webhook settings API, through the real HTTP server: every card shows the true
// state of its integration (and changes when the real settings change), nothing on it can be switched, and webhooks
// can be made, tested, rotated and deleted only by people with the settings right. The server must run with
// ALLOW_PRIVATE_WEBHOOKS=true so the test receiver on 127.0.0.1 is allowed.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... node test/integrations-http.e2e.cjs
"use strict";
const http = require("node:http");
const path = require("node:path");
const { assert, call, json, runner, setup } = require("./groupc-helpers.cjs");
const core = require(path.join(__dirname, "..", process.env.DIST || "dist", "webhooks", "webhook-core.js"));

async function main() {
    const { q, org, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = Date.now();

    const admin = await staffUser("int-admin", ["settings.read", "settings.write", "tickets.read", "tickets.write", "alerts.read", "alerts.manage"]);
    const reader = await staffUser("int-reader", ["settings.read"]);
    const nobody = await staffUser("int-nobody", ["tickets.read"]);

    // Start from nothing configured.
    const keep = {
        email: (await q(`SELECT * FROM email_settings`)).rows,
        stripe: (await q(`SELECT organization_id, stripe_secret_key, stripe_webhook_secret FROM billing_settings`)).rows,
    };
    await q(`DELETE FROM email_settings`);
    await q(`DELETE FROM support_mailbox`);
    await q(`DELETE FROM sso_config`);
    await q(`DELETE FROM sso_identities`);
    await q(`UPDATE billing_settings SET stripe_secret_key = NULL, stripe_webhook_secret = NULL`);
    await q(`DELETE FROM portal_settings`);
    await q(`DELETE FROM notification_channels`);
    await q(`DELETE FROM webhook_endpoints`);
    await q(`DELETE FROM storage_connections`);
    await q(`DELETE FROM import_jobs`);

    const cards = async (who = admin) => {
        const r = await json("/api/admin/integrations", { token: who.token });
        return Object.fromEntries(r.items.map((c) => [c.key, c]));
    };

    await test("only people who can read settings see the integrations", async () => {
        assert.equal((await call("/api/admin/integrations", { token: reader.token })).status, 200);
        assert.equal((await call("/api/admin/integrations", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/admin/integrations")).status, 401);
        // Read only: there is no way to change anything through it.
        for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.ok([404, 405].includes((await call("/api/admin/integrations", { method: m, token: admin.token, body: {} })).status), m);
    });

    await test("with nothing configured, every card says so honestly and says what it does and where to change it", async () => {
        const c = await cards();
        assert.deepEqual(Object.keys(c).sort(), ["alert_channels", "billing", "client_portal", "helpdesk_import", "mailbox", "smtp", "sso", "storage", "tokens", "turn", "webhooks"].sort());
        for (const card of Object.values(c)) {
            assert.ok(card.name && card.description.length > 20, `${card.key} says what it does`);
            assert.ok(card.link && card.link.label && (card.link.tab || card.link.href), `${card.key} says where to change it`);
            assert.ok(["ok", "attention", "error", "off"].includes(card.status), card.key);
        }
        for (const k of ["smtp", "mailbox", "sso", "billing", "helpdesk_import", "client_portal", "alert_channels", "webhooks", "storage", "tokens"]) assert.equal(c[k].status, "off", `${k}: ${c[k].statusLabel}`);
        assert.equal(c.smtp.statusLabel, "Not set up");
        assert.ok(["attention", "ok"].includes(c.turn.status), "TURN comes from the server environment");
    });

    await test("email shows which mailboxes are set up", async () => {
        await q(`INSERT INTO email_settings (purpose, enabled, smtp_host, smtp_port, smtp_from_address) VALUES ('alerts', true, 'smtp.example.test', 587, 'a@example.test'), ('invites', true, 'smtp.example.test', 587, 'a@example.test')`);
        let c = (await cards()).smtp;
        assert.equal(c.status, "attention");
        assert.match(c.detail, /alerts, invitations/);
        assert.match(c.detail, /Not set up for/);
        for (const p of ["password_resets", "reports", "tickets"]) await q(`INSERT INTO email_settings (purpose, enabled, smtp_host, smtp_port, smtp_from_address) VALUES ($1, true, 'smtp.example.test', 587, 'a@example.test')`, [p]);
        c = (await cards()).smtp;
        assert.equal(c.status, "ok");
        assert.equal(c.statusLabel, "Set up");
        await q(`UPDATE email_settings SET enabled = false WHERE purpose = 'tickets'`);
        assert.equal((await cards()).smtp.status, "attention", "a mailbox that is turned off does not count");
    });

    await test("the support mailbox shows turned off, not connected, connected and failing", async () => {
        await q(`INSERT INTO support_mailbox (organization_id, enabled, source, mailbox_address) VALUES ($1, true, 'microsoft', 'support@example.test')`, [org]);
        let c = (await cards()).mailbox;
        assert.equal(c.status, "attention");
        assert.equal(c.statusLabel, "Not connected");
        await q(`UPDATE support_mailbox SET refresh_token = 'x', connected_at = now(), last_polled_at = now() WHERE organization_id = $1`, [org]);
        c = (await cards()).mailbox;
        assert.deepEqual([c.status, c.statusLabel], ["ok", "Connected"]);
        assert.match(c.detail, /support@example\.test/);
        assert.equal(c.last.ok, true);
        await q(`UPDATE support_mailbox SET last_error = 'invalid_grant: the token expired', last_error_at = now() + interval '1 minute' WHERE organization_id = $1`, [org]);
        c = (await cards()).mailbox;
        assert.deepEqual([c.status, c.last.ok], ["error", false]);
        assert.match(c.last.message, /invalid_grant/);
        await q(`UPDATE support_mailbox SET enabled = false WHERE organization_id = $1`, [org]);
        assert.equal((await cards()).mailbox.status, "off");
    });

    await test("single sign-on shows incomplete, on with how many people use it, and set up but off", async () => {
        await q(`INSERT INTO sso_config (organization_id, enabled, display_name, issuer, client_id, password_login) VALUES ($1, true, 'Contoso', 'https://login.example.test', 'abc', true)`, [org]);
        assert.deepEqual([(await cards()).sso.status, (await cards()).sso.statusLabel], ["attention", "Incomplete"]);
        await q(`UPDATE sso_config SET client_secret = 'enc' WHERE organization_id = $1`, [org]);
        const u = admin.id;
        await q(`INSERT INTO sso_identities (organization_id, user_id, issuer, subject, last_login_at) VALUES ($1,$2,'https://login.example.test',$3, now())`, [org, u, `sub-${stamp}`]);
        let c = (await cards()).sso;
        assert.deepEqual([c.status, c.statusLabel], ["ok", "On"]);
        assert.match(c.detail, /1 person linked/);
        assert.equal(c.last.ok, true);
        await q(`UPDATE sso_config SET enabled = false WHERE organization_id = $1`, [org]);
        c = (await cards()).sso;
        assert.deepEqual([c.status, c.statusLabel], ["off", "Set up, turned off"]);
        await q(`DELETE FROM sso_identities WHERE subject = $1`, [`sub-${stamp}`]);
    });

    await test("Stripe shows incomplete until both the key and the webhook secret are saved", async () => {
        await q(`INSERT INTO billing_settings (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`, [org]);
        await q(`UPDATE billing_settings SET stripe_secret_key = 'enc:key' WHERE organization_id = $1`, [org]);
        let c = (await cards()).billing;
        assert.deepEqual([c.status, c.statusLabel], ["attention", "Incomplete"]);
        assert.match(c.detail, /webhook secret is not/);
        await q(`UPDATE billing_settings SET stripe_webhook_secret = 'enc:hook' WHERE organization_id = $1`, [org]);
        c = (await cards()).billing;
        assert.deepEqual([c.status, c.statusLabel], ["ok", "Set up"]);
        assert.ok(!JSON.stringify(c).includes("enc:"), "no secret is ever shown");
        await q(`UPDATE billing_settings SET stripe_secret_key = NULL, stripe_webhook_secret = NULL WHERE organization_id = $1`, [org]);
    });

    await test("the Freshdesk import shows its last job and how it ended", async () => {
        const job = (await q(`INSERT INTO import_jobs (organization_id, source, status, message, finished_at) VALUES ($1, 'freshdesk', 'failed', 'Freshdesk answered 401: check the API key', now()) RETURNING id`, [org])).rows[0].id;
        let c = (await cards()).helpdesk_import;
        assert.deepEqual([c.status, c.last.ok], ["error", false]);
        assert.match(c.last.message, /401/);
        await q(`UPDATE import_jobs SET status = 'completed', message = NULL WHERE id = $1`, [job]);
        c = (await cards()).helpdesk_import;
        assert.deepEqual([c.status, c.last.ok], ["ok", true]);
    });

    await test("the client portal shows its address and how many people use it", async () => {
        await q(`INSERT INTO portal_settings (organization_id, enabled, domain) VALUES ($1, true, 'portal.example.test')`, [org]);
        const c = (await cards()).client_portal;
        assert.deepEqual([c.status, c.statusLabel], ["ok", "On"]);
        assert.match(c.detail, /portal\.example\.test/);
        await q(`UPDATE portal_settings SET enabled = false`);
        assert.equal((await cards()).client_portal.status, "off");
    });

    await test("alert notifications show the channels and whether the last one worked", async () => {
        const ch = await (await call("/api/notifications/channels", { method: "POST", token: admin.token, body: { name: `Int ${stamp}`, kind: "email", recipients: ["ops@example.test"] } })).json();
        let c = (await cards()).alert_channels;
        assert.deepEqual([c.status, c.detail], ["ok", "1 email channel"]);
        await q(`INSERT INTO notification_deliveries (channel_id, event, status, attempts, last_error) VALUES ($1, 'opened', 'failed', 7, 'Email for alerts is not set up in Administration.')`, [ch.id]);
        c = (await cards()).alert_channels;
        assert.deepEqual([c.status, c.last.ok], ["error", false]);
        assert.match(c.last.message, /not set up/);
        await call(`/api/notifications/channels/${ch.id}`, { method: "DELETE", token: admin.token });
    });

    await test("storage and API tokens show what is saved and in use", async () => {
        await q(`INSERT INTO storage_connections (organization_id, name, kind) VALUES ($1, $2, 's3')`, [org, `bucket-${stamp}`]);
        let c = await cards();
        assert.deepEqual([c.storage.status, c.storage.statusLabel], ["ok", "Saved"]);
        assert.match(c.storage.detail, new RegExp(`bucket-${stamp}`));
        assert.equal(c.tokens.status, "off");
        await q(`INSERT INTO personal_access_tokens (user_id, token_hash, description, last_used_at) VALUES ($1, 'x', 'ci', now())`, [admin.id]);
        c = await cards();
        assert.deepEqual([c.tokens.status, c.tokens.detail], ["ok", "1 active token."]);
        assert.equal(c.tokens.last.ok, true);
        await q(`UPDATE personal_access_tokens SET revoked_at = now() WHERE user_id = $1`, [admin.id]);
        assert.equal((await cards()).tokens.status, "off", "a revoked token does not count");
        await q(`DELETE FROM personal_access_tokens WHERE user_id = $1`, [admin.id]);
        await q(`DELETE FROM storage_connections WHERE name = $1`, [`bucket-${stamp}`]);
    });

    /* ------------------------------ webhooks through the API ------------------------------ */
    const received = [];
    const hook = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => { received.push({ headers: req.headers, body }); res.statusCode = hook.status ?? 200; res.end(); });
    });
    await new Promise((r) => hook.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${hook.address().port}/in`;
    let ep;

    await test("webhooks can be listed by anyone who reads settings, and changed only by people who write them", async () => {
        const body = { name: `Hook ${stamp}`, url, events: ["ticket.created", "alert.opened"] };
        assert.equal((await call("/api/admin/webhooks", { method: "POST", token: reader.token, body })).status, 403);
        assert.equal((await call("/api/admin/webhooks", { token: reader.token })).status, 200);
        assert.equal((await call("/api/admin/webhooks", { token: nobody.token })).status, 403);
        const res = await call("/api/admin/webhooks", { method: "POST", token: admin.token, body });
        assert.equal(res.status, 201);
        ep = await res.json();
        assert.match(ep.signingSecret, /^whsec_/);
        const list = await json("/api/admin/webhooks", { token: admin.token });
        assert.equal(list.items.length, 1);
        assert.ok(!JSON.stringify(list).includes(ep.signingSecret), "the secret is not in the list");
        assert.ok(list.events.length >= 5 && JSON.stringify(list.events).includes("ticket.sla_breached"), "the five original events and the SLA ones");
        assert.equal((await call(`/api/admin/webhooks/${ep.id}`, { method: "PATCH", token: reader.token, body: { enabled: false } })).status, 403);
        assert.equal((await call(`/api/admin/webhooks/${ep.id}/test`, { method: "POST", token: reader.token })).status, 403);
        assert.equal((await call("/api/admin/webhooks", { method: "POST", token: admin.token, body: { name: "x", url: "not a url", events: ["ticket.created"] } })).status, 400);
    });

    await test("the hub counts the webhook, a test goes out signed, and the log and last result show it", async () => {
        let c = (await cards()).webhooks;
        assert.deepEqual([c.status, c.detail], ["ok", "1 webhook on."]);
        const r = await json(`/api/admin/webhooks/${ep.id}/test`, { method: "POST", token: admin.token });
        assert.equal(r.ok, true);
        const got = received.at(-1);
        assert.equal(got.headers["x-adg-event"], "webhook.test");
        assert.ok(core.verify(ep.signingSecret, got.headers["x-adg-timestamp"], got.body, got.headers["x-adg-signature"]));
        hook.status = 500;
        const bad = await json(`/api/admin/webhooks/${ep.id}/test`, { method: "POST", token: admin.token });
        hook.status = 200;
        assert.equal(bad.ok, false);
        assert.match(bad.message, /500/);
        const log = (await json(`/api/admin/webhooks/${ep.id}/deliveries`, { token: reader.token })).items;
        assert.deepEqual(log.map((d) => d.status), ["failed", "delivered"]);
        assert.equal(log[0].responseStatus, 500);
        const listed = (await json("/api/admin/webhooks", { token: admin.token })).items[0];
        assert.equal(listed.last.status, "failed");
        // Test sends do not count as the last real event on the hub.
        assert.equal((await cards()).webhooks.last, null);
    });

    await test("a real ticket event reaches the webhook through the API, and shows on the hub", async () => {
        const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `INT Customer ${stamp}`])).rows[0].id;
        const before = received.length;
        const res = await call("/api/tickets", { method: "POST", token: admin.token, body: { subject: `GC integration ticket ${stamp}`, clientId: client } });
        assert.equal(res.status, 201);
        // The worker runs every few seconds.
        const end = Date.now() + 25_000;
        while (received.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 300));
        const got = received.slice(before).find((r) => r.headers["x-adg-event"] === "ticket.created");
        assert.ok(got, "delivered by the background worker");
        assert.equal(JSON.parse(got.body).data.ticket.subject, `GC integration ticket ${stamp}`);
        const c = (await cards()).webhooks;
        assert.equal(c.last.ok, true);
        await q(`DELETE FROM tickets WHERE client_id = $1`, [client]);
        await q(`DELETE FROM clients WHERE id = $1`, [client]);
    });

    await test("rotating the secret, turning it off and deleting it", async () => {
        const rot = await json(`/api/admin/webhooks/${ep.id}`, { method: "PATCH", token: admin.token, body: { rotateSecret: true } });
        assert.match(rot.signingSecret, /^whsec_/);
        assert.notEqual(rot.signingSecret, ep.signingSecret);
        const off = await json(`/api/admin/webhooks/${ep.id}`, { method: "PATCH", token: admin.token, body: { enabled: false } });
        assert.equal(off.enabled, false);
        assert.ok(!off.signingSecret, "not shown unless it was just replaced");
        assert.equal((await cards()).webhooks.status, "off");
        assert.equal((await call(`/api/admin/webhooks/${ep.id}`, { method: "DELETE", token: admin.token })).status, 200);
        assert.equal((await call(`/api/admin/webhooks/${ep.id}`, { method: "DELETE", token: admin.token })).status, 404);
        assert.equal((await call(`/api/admin/webhooks/not-a-uuid/deliveries`, { token: admin.token })).status, 404);
        const actions = (await q(`SELECT action FROM audit_events WHERE action LIKE 'webhook.%'`)).rows.map((r) => r.action);
        for (const a of ["webhook.create", "webhook.update", "webhook.test", "webhook.delete"]) assert.ok(actions.includes(a), a);
    });

    // ------------------------------------------------------------------ clean up
    hook.close();
    await q(`DELETE FROM webhook_endpoints`);
    await q(`DELETE FROM support_mailbox`);
    await q(`DELETE FROM sso_config`);
    await q(`DELETE FROM portal_settings`);
    await q(`DELETE FROM import_jobs`);
    await q(`DELETE FROM email_settings`);
    for (const r of keep.stripe) await q(`UPDATE billing_settings SET stripe_secret_key = $2, stripe_webhook_secret = $3 WHERE organization_id = $1`, [r.organization_id, r.stripe_secret_key, r.stripe_webhook_secret]);
    for (const r of keep.email) {
        const cols = Object.keys(r);
        await q(`INSERT INTO email_settings (${cols.join(",")}) VALUES (${cols.map((_c, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]));
    }
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
