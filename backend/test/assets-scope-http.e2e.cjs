#!/usr/bin/env node
// The customer limit on assets, through the real HTTP API: a person limited to some customers sees, creates, changes, deletes and gets
// expiry notices for the assets of their own customers only (and those of devices they can see); another customer's asset does not
// exist for them. Throwaway backend and database only.
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... DATA_ENCRYPTION_KEY=... node test/assets-scope-http.e2e.cjs
"use strict";
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `AS${Date.now()}`;
    const ops = await staffUser("as-ops", ["devices.read", "assets.read", "assets.write"]);
    const limited = await staffUser("as-limited", ["devices.read", "assets.read", "assets.write"]);
    const reader = await staffUser("as-reader", ["assets.read"]);
    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A"), B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const send = (m, p, body, t = ops) => call(`/api/docs${p}`, { method: m, token: t.token, body });
    const mk = async (clientId, name, extra = {}) => (await (await send("POST", "/assets", { clientId, name, kind: "other", expiresAt: soon, ...extra })).json()).id;
    const aId = await mk(A.id, `${tag} A thing`), bId = await mk(B.id, `${tag} B thing`);
    const devB = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Windows 11') RETURNING id`, [B.site, `${tag}-bpc`])).rows[0].id;
    const bDevAsset = (await q(`INSERT INTO assets (organization_id, client_id, device_id, name, kind, source) VALUES ($1,$2,$3,$4,'computer','agent') RETURNING id`, [org, B.id, devB, `${tag} B pc`])).rows[0].id;
    const names = async (t, qs = "") => (await (await send("GET", `/assets${qs}`, undefined, t)).json()).items.filter((x) => x.name.startsWith(tag)).map((x) => x.name).sort();

    await test("SECURITY: nothing under /api/docs (assets, links) works without signing in, and a signed-in person is held to their rights", async () => {
        // /api/docs used to be treated as the Swagger page by the sign-in and permission checks, which left the whole IT Docs API open
        const anon = (m, p, body) => call(`/api/docs${p}`, { method: m, body });
        const id = uuid();
        const routes = [["GET", "/assets"], ["POST", "/assets", { clientId: A.id, name: "x", kind: "other" }], ["PUT", `/assets/${id}`, { clientId: A.id, name: "x", kind: "other" }], ["DELETE", `/assets/${id}`], ["POST", "/assets/sync", {}],
            ["GET", "/expiring"], ["GET", `/links?type=asset&id=${id}`]];
        for (const [m, p, body] of routes) { const r = await anon(m, p, body); assert.equal(r.status, 401, `${m} /api/docs${p} without signing in gave ${r.status}`); }
        const bare = await staffUser("as-bare", ["customers.read"]);
        for (const [m, p, body] of routes.filter((r) => ["/assets", "/expiring"].some((x) => r[1].startsWith(x)))) {
            const r = await call(`/api/docs${p}`, { method: m, token: bare.token, body });
            assert.equal(r.status, 403, `${m} /api/docs${p} for someone with no rights gave ${r.status}`);
        }
        assert.equal((await call("/api/docs")).status === 401 || (await call("/api/docs")).status === 404, true, "the old Swagger path is not an open door either");
        // the password vault and the documents are gone: even a fully signed-in person finds nothing there
        for (const [m, p] of [["GET", "/vault"], ["POST", `/vault/${id}/reveal`], ["POST", "/vault"], ["GET", "/documents"], ["POST", "/documents"], ["GET", `/documents/${id}`], ["PUT", `/documents/${id}`], ["DELETE", `/documents/${id}`]]) assert.equal((await call(`/api/docs${p}`, { method: m, token: ops.token, body: m === "POST" ? {} : undefined })).status, 404, `${m} /api/docs${p} exists`);
    });
    await test("a person with no limit sees every customer's assets; one limited to a customer sees only theirs", async () => {
        assert.deepEqual(await names(ops), [`${tag} A thing`, `${tag} B pc`, `${tag} B thing`]);
        assert.deepEqual(await names(limited), [`${tag} A thing`]);
        assert.deepEqual(await names(limited, `?clientId=${B.id}`), [], "asking for another customer's assets finds nothing");
        assert.deepEqual(await names(limited, `?q=${encodeURIComponent("B thing")}`), [], "searching does not find them either");
        assert.equal((await send("GET", "/assets", undefined, reader)).status, 200, "reading needs assets.read only");
    });
    await test("a limited person cannot create an asset for another customer, and can for their own", async () => {
        assert.equal((await send("POST", "/assets", { clientId: B.id, name: `${tag} sneaky`, kind: "other" }, limited)).status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM assets WHERE name = $1`, [`${tag} sneaky`])).rows[0].n, 0);
        const r = await send("POST", "/assets", { clientId: A.id, name: `${tag} A mine`, kind: "printer" }, limited); assert.equal(r.status, 201);
        assert.ok((await names(limited)).includes(`${tag} A mine`));
    });
    await test("another customer's asset cannot be changed, moved to, or deleted by a limited person: it does not exist for them", async () => {
        assert.equal((await send("PUT", `/assets/${bId}`, { clientId: B.id, name: `${tag} hijack`, kind: "other" }, limited)).status, 404);
        assert.equal((await send("DELETE", `/assets/${bId}`, undefined, limited)).status, 404);
        assert.equal((await send("DELETE", `/assets/${bDevAsset}`, undefined, limited)).status, 404);
        assert.equal((await send("PUT", `/assets/${aId}`, { clientId: B.id, name: `${tag} A thing`, kind: "other" }, limited)).status, 400, "cannot move their own asset to another customer");
        const ok = await send("PUT", `/assets/${aId}`, { clientId: A.id, name: `${tag} A renamed`, kind: "other", location: "Rack 2" }, limited); assert.equal(ok.status, 200);
        assert.equal((await q(`SELECT name FROM assets WHERE id = $1`, [bId])).rows[0].name, `${tag} B thing`, "B's asset is untouched");
        assert.equal((await send("DELETE", `/assets/${aId}`, undefined, limited)).status, 200);
    });
    await test("the expiry list a limited person sees holds their customers' assets only", async () => {
        await mk(A.id, `${tag} A expiring`);
        const items = (await (await send("GET", "/expiring?days=90", undefined, limited)).json()).items.filter((i) => i.name.startsWith(tag));
        assert.deepEqual(items.map((i) => i.name), [`${tag} A expiring`]);
        const all = (await (await send("GET", "/expiring?days=90", undefined, ops)).json()).items.filter((i) => i.name.startsWith(tag)).map((i) => i.name);
        assert.ok(all.includes(`${tag} B thing`) && all.includes(`${tag} A expiring`));
    });
    await test("without the right to manage assets nothing can be created, changed or deleted", async () => {
        assert.equal((await send("POST", "/assets", { clientId: A.id, name: "x", kind: "other" }, reader)).status, 403);
        assert.equal((await send("DELETE", `/assets/${bId}`, undefined, reader)).status, 403);
    });

    await q(`DELETE FROM assets WHERE client_id = ANY($1::uuid[])`, [[A.id, B.id]]);
    await q(`DELETE FROM devices WHERE id = $1`, [devB]).catch(() => { });
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
