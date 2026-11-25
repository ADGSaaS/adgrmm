// Workflows, server health and automatic repair through the real HTTP API with signed-in users of different rights (throwaway backend and database only).
"use strict";
const { assert, call, runner, setup } = require("./groupc-helpers.cjs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `WH${Date.now()}`;
    const admin = await staffUser("wh-admin", ["settings.read", "settings.write", "automation.read", "tickets.read", "tickets.write", "tickets.create", "devices.read"]);
    const viewer = await staffUser("wh-viewer", ["automation.read"]);
    const nobody = await staffUser("wh-nobody", ["tickets.read"]);
    const json = async (r) => r.json().catch(() => null);

    const rule = { name: `${tag} rule`, trigger: "ticket.created", enabled: false, conditions: [{ field: "subject", op: "contains", value: tag }], actions: [{ type: "create_ticket", subject: `${tag} follow-up for {{subject}}`, description: "", priority: "low" }], cooldownMinutes: 5 };
    let id;

    console.log("workflows");
    await test("rights: reading needs automation.read, changing needs settings.write", async () => {
        assert.equal((await call("/api/admin/workflows", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/admin/workflows", { token: viewer.token })).status, 200);
        assert.equal((await call("/api/admin/workflows", { method: "POST", token: viewer.token, body: rule })).status, 403);
        assert.equal((await call("/api/admin/workflows", { method: "POST" , body: rule })).status, 401);
    });
    await test("the editor's choices come from the server", async () => {
        const m = await json(await call("/api/admin/workflows/meta", { token: viewer.token }));
        assert.deepEqual(m.triggers.map((t) => t.id).sort(), ["alert.opened", "device.registered", "ticket.created"]);
        assert.ok(m.actions.find((a) => a.id === "run_script").needsDevice && m.ops.length === 5);
    });
    await test("a bad rule is refused in plain words", async () => {
        const r = await call("/api/admin/workflows", { method: "POST", token: admin.token, body: { ...rule, name: "", actions: [] } });
        assert.equal(r.status, 400); const t = JSON.stringify(await json(r)); assert.ok(/Give the rule a name/.test(t) && /at least one action/.test(t), t);
    });
    await test("create, list, try, turn on", async () => {
        const r = await call("/api/admin/workflows", { method: "POST", token: admin.token, body: rule });
        assert.equal(r.status, 201); const c = await json(r); id = c.id; assert.equal(c.enabled, false);
        assert.equal((await json(await call("/api/admin/workflows", { token: viewer.token }))).items.filter((x) => x.id === id).length, 1);
        const p = await call(`/api/admin/workflows/${id}/preview`, { method: "POST", token: viewer.token, body: {} });
        assert.equal(p.status, 200); assert.ok("wouldRun" in (await json(p)));
        const e = await call(`/api/admin/workflows/${id}/enable`, { method: "POST", token: admin.token, body: {} });
        assert.equal(e.status, 200); assert.equal((await json(e)).enabled, true);
    });
    await test("a ticket made through the API runs the rule, once, and the ticket the rule made does not run it again", async () => {
        const r = await call("/api/tickets", { method: "POST", token: admin.token, body: { subject: `${tag} printer broken`, description: "x", priority: "medium" } });
        assert.ok(r.status === 200 || r.status === 201, `create ticket ${r.status} ${JSON.stringify(await json(r))}`);
        let n = 0;
        for (let i = 0; i < 40 && n < 1; i++) { await wait(250); n = Number((await q(`SELECT count(*) FROM tickets WHERE subject LIKE $1`, [`${tag} follow-up%`])).rows[0].count); }
        assert.equal(n, 1); await wait(1500);
        assert.equal(Number((await q(`SELECT count(*) FROM tickets WHERE subject LIKE $1`, [`${tag} follow-up%`])).rows[0].count), 1);
        const runs = (await json(await call(`/api/admin/workflows/runs?ruleId=${id}`, { token: viewer.token }))).items;
        assert.equal(runs.length, 1); assert.equal(runs[0].outcome, "done");
    });
    await test("turned off it stops; edited, deleted", async () => {
        assert.equal((await json(await call(`/api/admin/workflows/${id}/disable`, { method: "POST", token: admin.token, body: {} }))).enabled, false);
        await call("/api/tickets", { method: "POST", token: admin.token, body: { subject: `${tag} second`, description: "x", priority: "medium" } });
        await wait(2000);
        assert.equal(Number((await q(`SELECT count(*) FROM tickets WHERE subject LIKE $1`, [`${tag} follow-up%`])).rows[0].count), 1);
        assert.equal((await call(`/api/admin/workflows/${id}`, { method: "PUT", token: admin.token, body: { ...rule, name: `${tag} renamed` } })).status, 200);
        assert.equal((await call(`/api/admin/workflows/${id}`, { method: "DELETE", token: viewer.token })).status, 403);
        assert.equal((await call(`/api/admin/workflows/${id}`, { method: "DELETE", token: admin.token })).status, 200);
        assert.equal((await call(`/api/admin/workflows/${id}`, { method: "DELETE", token: admin.token })).status, 404);
    });

    console.log("server health");
    await test("readable with settings.read, not without", async () => {
        assert.equal((await call("/api/admin/system-health", { token: nobody.token })).status, 403);
        const r = await call("/api/admin/system-health", { token: admin.token });
        assert.equal(r.status, 200); const h = await json(r);
        assert.deepEqual(h.checks.map((c) => c.key).sort(), ["backup", "database", "disk", "memory", "queue", "restore"]);
        assert.equal(h.checks.find((c) => c.key === "database").status, "ok");
    });
    await test("the restore test button needs settings.write and says why when there is nothing to test", async () => {
        assert.equal((await call("/api/admin/system-health/restore-test", { method: "POST", token: viewer.token, body: {} })).status, 403);
        const r = await call("/api/admin/system-health/restore-test", { method: "POST", token: admin.token, body: {} });
        assert.equal(r.status, 200); const b = await json(r); assert.equal(b.started, false); assert.ok(/no completed/i.test(b.reason), b.reason);
    });

    console.log("automatic repair");
    await test("settings, scripts, report and playbooks are guarded and answer", async () => {
        for (const p of ["/api/admin/auto-repair", "/api/admin/auto-repair/report?days=30", "/api/admin/auto-repair/runs", "/api/admin/auto-repair/playbooks", "/api/admin/auto-repair/scripts"]) {
            assert.equal((await call(p, { token: nobody.token })).status, 403, p);
            assert.equal((await call(p, { token: admin.token })).status, 200, p);
        }
        const rep = await json(await call("/api/admin/auto-repair/report?days=30", { token: admin.token }));
        assert.ok("total" in rep && Array.isArray(rep.reasons));
    });
    await test("switching it on needs settings.write and is remembered", async () => {
        assert.equal((await call("/api/admin/auto-repair", { method: "PUT", token: viewer.token, body: { enabled: true } })).status, 403);
        const r = await call("/api/admin/auto-repair", { method: "PUT", token: admin.token, body: { enabled: true, selfHealing: true } });
        assert.equal(r.status, 200);
        const g = await json(await call("/api/admin/auto-repair", { token: admin.token }));
        assert.equal(g.enabled, true); assert.equal(g.selfHealing, true);
    });
    await test("approving a custom repair is for the Owner only", async () => {
        const r = await call("/api/admin/auto-repair/playbooks", { method: "POST", token: admin.token, body: { title: `${tag} pb`, plain: "x", signs: "", fixText: "", ifItReturns: "", categories: ["Printing"], appWords: [], checkService: null, checkMetric: null, detectScript: "Write-Output 'RIQ_FOUND=0'", fixScript: "", risk: "low" } });
        assert.ok([200, 201, 400].includes(r.status), `playbook create ${r.status}`);
        if (r.status < 300) {
            const pb = await json(r);
            assert.equal((await call(`/api/admin/auto-repair/playbooks/${pb.id}/approve`, { method: "POST", token: admin.token, body: {} })).status >= 400, true);
        }
    });

    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
