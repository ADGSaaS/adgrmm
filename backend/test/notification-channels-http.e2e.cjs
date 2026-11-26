// The notification channel API over HTTP: the message format of a webhook channel can be chosen, left to the address ("auto") and changed,
// a format that does not exist is refused, email channels have none, and the rights are checked. Throwaway database only.
// Run: ADG_E2E_ALLOW=1 ALLOW_PRIVATE_WEBHOOKS=true BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... node test/notification-channels-http.e2e.cjs
"use strict";
const { assert, call, runner, setup } = require("./groupc-helpers.cjs");

async function main() {
    const { q, cleanup, staffUser } = await setup();
    const { test, finish } = runner();
    const manager = await staffUser("nc-manager", ["alerts.read", "alerts.manage"]);
    const reader = await staffUser("nc-reader", ["alerts.read"]);
    const tag = `NC${Date.now()}`;
    const make = (body, t = manager) => call("/api/notifications/channels", { method: "POST", token: t.token, body: { enabled: false, ...body } });
    const patch = (id, body, t = manager) => call(`/api/notifications/channels/${id}`, { method: "PATCH", token: t.token, body });
    const list = async () => (await (await call("/api/notifications/channels", { token: manager.token })).json()).items;
    const ids = [];

    await test("a webhook is created with the format the address implies, and says it was not chosen", async () => {
        const r = await make({ name: `${tag} slack`, kind: "webhook", url: "https://hooks.slack.com/services/T0/B0/abc" });
        assert.equal(r.status, 201);
        const b = await r.json(); ids.push(b.id);
        assert.equal(b.format, "slack"); assert.equal(b.formatChosen, null);
    });
    await test("a format can be chosen when creating, and 'auto' means no choice", async () => {
        let r = await make({ name: `${tag} chosen`, kind: "webhook", url: "https://example.com/hook", format: "teams" });
        assert.equal(r.status, 201); let b = await r.json(); ids.push(b.id);
        assert.equal(b.format, "teams"); assert.equal(b.formatChosen, "teams");
        r = await make({ name: `${tag} auto`, kind: "webhook", url: "https://example.com/hook2", format: "auto" });
        assert.equal(r.status, 201); b = await r.json(); ids.push(b.id);
        assert.equal(b.format, "adgrmm"); assert.equal(b.formatChosen, null);
    });
    await test("the format is changed, and put back to Automatic, with PATCH", async () => {
        const id = ids[0];
        let r = await patch(id, { format: "discord" });
        assert.equal(r.status, 200); let b = await r.json();
        assert.equal(b.format, "discord"); assert.equal(b.formatChosen, "discord");
        r = await patch(id, { format: "auto" });
        assert.equal(r.status, 200); b = await r.json();
        assert.equal(b.formatChosen, null); assert.equal(b.format, "slack", "the Slack address decides again");
        assert.equal((await list()).find((c) => c.id === id).format, "slack");
    });
    await test("a format that does not exist is refused when creating and when changing", async () => {
        assert.equal((await make({ name: `${tag} bad`, kind: "webhook", url: "https://example.com/h", format: "pigeon" })).status, 400);
        assert.equal((await patch(ids[0], { format: "pigeon" })).status, 400);
        assert.equal((await list()).find((c) => c.id === ids[0]).formatChosen, null, "nothing changed");
    });
    await test("an email channel has no format, and asking for one on it changes nothing", async () => {
        const r = await make({ name: `${tag} mail`, kind: "email", recipients: ["a@example.com"] });
        assert.equal(r.status, 201); const b = await r.json(); ids.push(b.id);
        assert.equal(b.format, null); assert.equal(b.formatChosen, null);
        const p = await patch(b.id, { format: "slack" });
        assert.equal(p.status, 200);
        assert.equal((await p.json()).formatChosen, null);
    });
    await test("changing a channel needs the right to manage alerts", async () => {
        assert.equal((await make({ name: `${tag} no`, kind: "webhook", url: "https://example.com/n" }, reader)).status, 403);
        assert.equal((await patch(ids[0], { format: "teams" }, reader)).status, 403);
        assert.equal((await call("/api/notifications/channels", { token: reader.token })).status, 200, "reading is allowed");
    });

    for (const id of ids) await q(`DELETE FROM notification_channels WHERE id = $1`, [id]);
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
