// The device removal request queue over HTTP against a real backend and database (throwaway database only):
//   - GET /api/device-removals lists what waits, oldest first, with who asked and why, for the customers the person may see
//   - POST /api/device-removals/approve deletes the devices; /decline closes the requests and keeps them; both need devices.delete
//   - nothing is deleted without a waiting request, one bad id does not stop the others, every answer is audited
//   - the Overview's attention list says how many wait
// Run: RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../riq_x_e2e JWT_SECRET=... node test/device-removals-http.e2e.cjs
"use strict";
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `RM${Date.now()}`;

    const reader = await staffUser("rm-reader", ["devices.read"]);
    const approver = await staffUser("rm-approver", ["devices.read", "devices.delete", "devices.write"]);
    const nobody = await staffUser("rm-nobody", ["customers.read"]);
    const limited = await staffUser("rm-limited", ["devices.read", "devices.delete"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, name: `${tag} ${n}`, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A");
    const B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);

    const mk = async (site, host) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Ubuntu 24.04') RETURNING id`, [site, `${tag}-${host}`])).rows[0].id;
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.36', now(), '{"os":"linux"}')`, [uuid(), id, uuid()]);
        return id;
    };
    const ask = async (id, reason, userId, minutesAgo = 0) => {
        await q(`INSERT INTO device_deletion_requests (id, device_id, status, requested_by_user_id, reason, requested_at) VALUES ($1,$2,'pending',$3,$4, now() - ($5 || ' minutes')::interval)`, [uuid(), id, userId, reason, String(minutesAgo)]);
    };
    const exists = async (id) => (await q(`SELECT 1 FROM devices WHERE id = $1`, [id])).rowCount === 1;
    const status = async (id) => (await q(`SELECT status FROM device_deletion_requests WHERE device_id = $1`, [id])).rows[0]?.status ?? null;
    const list = async (t) => (await (await call("/api/device-removals", { token: t.token })).json());
    const answer = (kind, ids, t = approver) => call(`/api/device-removals/${kind}`, { method: "POST", token: t.token, body: { deviceIds: ids } });

    const a1 = await mk(A.site, "a1");
    const a2 = await mk(A.site, "a2");
    const a3 = await mk(A.site, "a3");
    const b1 = await mk(B.site, "b1");
    const quiet = await mk(A.site, "quiet");
    await ask(a1, "Replaced with a new laptop", reader.id, 30);
    await ask(a2, "Old test machine", reader.id, 20);
    await ask(a3, "Duplicate of another device", null, 10);
    await ask(b1, "Customer left", reader.id, 5);

    console.log("who sees what");
    await test("a person with no device rights gets 403, and nobody signed in gets 401", async () => {
        assert.equal((await call("/api/device-removals", { token: nobody.token })).status, 403);
        assert.ok([401, 403].includes((await call("/api/device-removals")).status));
    });
    await test("the queue lists what waits, oldest first, with the reason, who asked and the customer", async () => {
        const body = await list(approver);
        const mine = body.items.filter((i) => i.hostname.startsWith(tag));
        assert.deepEqual(mine.map((i) => i.hostname), [`${tag}-a1`, `${tag}-a2`, `${tag}-a3`, `${tag}-b1`]);
        assert.equal(mine[0].reason, "Replaced with a new laptop");
        assert.ok(mine[0].requestedBy, "names who asked");
        assert.equal(mine[2].requestedBy, null, "an unknown requester is null");
        assert.equal(mine[0].customer, A.name); assert.equal(mine[0].online, true); assert.ok(mine[0].requestedAt);
        assert.ok(!mine.some((i) => i.hostname === `${tag}-quiet`), "a device with no request is not listed");
        assert.ok(body.total >= 4);
    });
    await test("someone who can only read may look, and a limited person sees only the customers they may see", async () => {
        const r = await list(reader);
        assert.ok(r.items.filter((i) => i.hostname.startsWith(tag)).length === 4);
        const l = await list(limited);
        const names = l.items.filter((i) => i.hostname.startsWith(tag)).map((i) => i.hostname);
        assert.deepEqual(names, [`${tag}-a1`, `${tag}-a2`, `${tag}-a3`]);
    });

    console.log("answering");
    await test("answering needs the right to delete: a reader gets 403 and nothing changes", async () => {
        assert.equal((await answer("approve", [a1], reader)).status, 403);
        assert.equal((await answer("decline", [a1], reader)).status, 403);
        assert.equal(await exists(a1), true);
        assert.equal(await status(a1), "pending");
    });
    await test("bad input is refused: no devices, not ids, too many", async () => {
        assert.equal((await call("/api/device-removals/approve", { method: "POST", token: approver.token, body: { deviceIds: [] } })).status, 400);
        assert.equal((await call("/api/device-removals/approve", { method: "POST", token: approver.token, body: { deviceIds: ["nope"] } })).status, 400);
        assert.equal((await call("/api/device-removals/approve", { method: "POST", token: approver.token, body: {} })).status, 400);
        assert.equal((await answer("approve", Array.from({ length: 101 }, () => uuid()))).status, 400);
    });
    await test("decline closes the request and keeps the device; it leaves the queue", async () => {
        const r = await answer("decline", [a2]);
        assert.equal(r.status, 200);
        const b = await r.json();
        assert.equal(b.done, 1); assert.equal(b.items[0].status, "declined");
        assert.equal(await exists(a2), true);
        assert.equal(await status(a2), "declined");
        assert.ok(!(await list(approver)).items.some((i) => i.deviceId === a2));
    });
    await test("approve deletes the device and completes the request", async () => {
        const r = await answer("approve", [a1]);
        assert.equal(r.status, 200);
        const b = await r.json();
        assert.equal(b.items[0].status, "deleted"); assert.equal(b.items[0].name, `${tag}-a1`);
        assert.equal(await exists(a1), false);
        assert.equal(await status(a1), "completed");
    });
    await test("a device nobody asked to remove is never deleted by this route", async () => {
        const r = await (await answer("approve", [quiet])).json();
        assert.equal(r.items[0].status, "skipped"); assert.match(r.items[0].reason, /No removal request/);
        assert.equal(await exists(quiet), true);
        const again = await (await answer("approve", [a2])).json();
        assert.equal(again.items[0].status, "skipped", "a declined request is not waiting any more");
        assert.equal(await exists(a2), true);
    });
    await test("a limited person cannot answer another customer's request (reported as not found), and can answer their own", async () => {
        const r = await (await answer("approve", [b1], limited)).json();
        assert.equal(r.items[0].status, "skipped");
        assert.equal(await exists(b1), true);
        assert.equal(await status(b1), "pending");
        const own = await (await answer("decline", [a3], limited)).json();
        assert.equal(own.items[0].status, "declined");
    });
    await test("a batch answers each device on its own: one unknown id does not stop the others", async () => {
        const c1 = await mk(A.site, "c1");
        const c2 = await mk(A.site, "c2");
        await ask(c1, "batch one", reader.id); await ask(c2, "batch two", reader.id);
        const ghost = uuid();
        const r = await (await answer("approve", [c1, ghost, c2, c1])).json();
        assert.equal(r.items.length, 3, "a repeated id is answered once");
        assert.deepEqual(r.items.map((i) => i.status), ["deleted", "skipped", "deleted"]);
        assert.equal(r.done, 2);
        assert.equal(await exists(c1), false); assert.equal(await exists(c2), false);
    });
    await test("every answer is in the audit trail with the device and no more than that", async () => {
        const rows = (await q(`SELECT action, outcome, target_id, target_label, details FROM audit_events WHERE action IN ('device.deletion.approve','device.deletion.decline') AND target_id = ANY($1::text[]) ORDER BY created_at`, [[a1, a2, b1, quiet]])).rows;
        const by = (a, id) => rows.find((r) => r.action === a && r.target_id === id);
        assert.equal(by("device.deletion.approve", a1)?.outcome, "success");
        assert.equal(by("device.deletion.decline", a2)?.outcome, "success");
        assert.equal(by("device.deletion.approve", quiet)?.outcome, "failure");
        assert.equal(by("device.deletion.approve", b1)?.outcome, "failure");
        assert.ok(rows.every((r) => r.details?.via === "removal queue"));
    });

    console.log("the Overview");
    await test("the attention list says how many requests wait", async () => {
        const d = await (await call("/api/dashboard/summary", { token: approver.token })).json();
        const item = (d.attention ?? []).find((i) => i.id === "removal-requests");
        assert.ok(item, JSON.stringify(d.attention));
        assert.match(item.text, /device removal requests? (is|are) waiting for approval/);
        assert.equal(item.route, "/removal-requests");
        const scoped = await (await call(`/api/dashboard/summary?clientId=${B.id}`, { token: approver.token })).json();
        assert.equal((scoped.attention ?? []).find((i) => i.id === "removal-requests")?.count, 1);
    });

    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
