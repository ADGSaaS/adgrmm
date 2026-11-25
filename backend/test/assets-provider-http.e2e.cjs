#!/usr/bin/env node
// Who owns assets, through the real HTTP API: the switch between the built-in asset manager and an external one (Owner right, confirmation,
// audit), what it turns off (the built-in asset endpoints answer "managed in <name>", expiry still lists passwords), recording a found host or
// an SNMP device as an asset, the export, the customer limit, and that nothing is deleted by switching either way. The database needs the
// migrations 20261121010000, 20261121030000 and 20261121040000 applied.
//   RIQ_E2E_ALLOW=1 SNMP_POLLER_ENABLED=false BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../riq_x_e2e JWT_SECRET=... DATA_ENCRYPTION_KEY=... node test/assets-provider-http.e2e.cjs
"use strict";
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `AP${Date.now()}`;
    const owner = await staffUser("ap-owner", ["devices.read", "assets.read", "assets.write", "integrations.manage"]);
    const writer = await staffUser("ap-writer", ["devices.read", "assets.read", "assets.write"]);
    const reader = await staffUser("ap-reader", ["devices.read", "assets.read"]);
    const limited = await staffUser("ap-limited", ["devices.read", "assets.read", "assets.write"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A"), B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const host = async (site, ip, mac, kind, extra = {}) => (await q(`INSERT INTO discovered_hosts (site_id, host_key, ip, mac, hostname, vendor, kind, ports, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [site, mac ?? `ip:${ip}`, ip, mac, extra.hostname ?? null, extra.vendor ?? null, kind, extra.ports ?? [], extra.deviceId ?? null])).rows[0].id;
    const snmpDev = async (site, ip, name, kind = "auto", detected = null, descr = null) => (await q(`INSERT INTO snmp_devices (site_id, ip, name, community_enc, kind, detected_kind, sys_descr) VALUES ($1,$2,$3,'enc:v1:x',$4,$5,$6) RETURNING id`, [site, ip, name, kind, detected, descr])).rows[0].id;
    const printerHost = await host(A.site, "10.4.0.20", "AA:BB:CC:04:00:20", "printer", { hostname: "office-printer", vendor: "HP", ports: [9100, 515] });
    const plainHost = await host(A.site, "10.4.0.21", null, "unknown");
    const otherHost = await host(B.site, "10.4.0.30", "AA:BB:CC:04:00:30", "network");
    const devId = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Windows 11 Pro') RETURNING id`, [A.site, `${tag}-pc`])).rows[0].id;
    const managedHost = await host(A.site, "10.4.0.22", "AA:BB:CC:04:00:22", "windows", { deviceId: devId });
    const switchDev = await snmpDev(A.site, "10.4.0.40", "Core switch", "auto", "switch", "Cisco IOS");
    const get = (p, t = owner) => call(p, { token: t.token });
    const send = (method, p, body, t = owner) => call(p, { method, token: t.token, body });
    const assetsOf = async () => (await q(`SELECT id, name, kind, source, details, client_id, manufacturer FROM assets WHERE client_id = ANY($1::uuid[]) ORDER BY name`, [[A.id, B.id]])).rows;

    console.log("rights and the setting");
    await test("assets are built-in by default; anyone who can see devices can ask who owns them; only the Owner right can switch, look or export", async () => {
        const r = await (await get("/api/assets/provider", reader)).json();
        assert.equal(r.provider, "builtin"); assert.equal(r.canSwitch, false);
        assert.equal((await (await get("/api/assets/provider", owner)).json()).canSwitch, true);
        for (const [m, p, t] of [["GET", "/api/assets/provider/preflight", writer], ["GET", "/api/assets/export", writer], ["PUT", "/api/assets/provider", writer], ["GET", "/api/assets/provider/preflight", reader]]) assert.equal((await send(m, p, m === "PUT" ? { provider: "external", externalName: "Killian", confirm: true } : undefined, t)).status, 403, `${m} ${p}`);
        assert.ok([401, 403].includes((await call("/api/assets/provider")).status));
    });
    await test("the switch needs a confirmation, a name for the other system, a sane address, and a real value", async () => {
        const put = (b) => send("PUT", "/api/assets/provider", b);
        assert.equal((await put({ provider: "external", externalName: "Killian" })).status, 400, "no confirmation");
        assert.equal((await put({ provider: "external", externalName: "Killian", confirm: false })).status, 400);
        assert.equal((await put({ provider: "external", externalName: "  ", confirm: true })).status, 400, "no name");
        assert.equal((await put({ provider: "external", externalName: "x".repeat(70), confirm: true })).status, 400);
        assert.equal((await put({ provider: "external", externalName: "Killian", externalUrl: "javascript:alert(1)", confirm: true })).status, 400);
        assert.equal((await put({ provider: "external", externalName: "Killian", externalUrl: "ftp://x", confirm: true })).status, 400);
        assert.equal((await put({ provider: "magic", confirm: true })).status, 400);
        assert.equal((await (await get("/api/assets/provider")).json()).provider, "builtin", "nothing changed");
    });

    console.log("built-in: recording hosts and devices as assets");
    await test("a found host is recorded as an asset of the right type with what is known about it, and remembers where it lives", async () => {
        const r = await send("POST", `/api/network-discovery/hosts/${printerHost}/asset`, undefined, writer);
        assert.equal(r.status, 200); const link = await r.json();
        assert.equal(link.provider, "builtin"); assert.equal(link.alreadyLinked, false);
        const a = (await q(`SELECT * FROM assets WHERE id = $1`, [link.ref])).rows[0];
        assert.equal(a.name, "office-printer"); assert.equal(a.kind, "printer"); assert.equal(a.client_id, A.id); assert.equal(a.source, "discovery"); assert.equal(a.manufacturer, "HP");
        assert.equal(a.details.ip, "10.4.0.20"); assert.equal(a.details.mac, "AA:BB:CC:04:00:20"); assert.deepEqual(a.details.ports, [9100, 515]);
        const row = (await q(`SELECT asset_provider, asset_ref FROM discovered_hosts WHERE id = $1`, [printerHost])).rows[0];
        assert.deepEqual([row.asset_provider, row.asset_ref], ["builtin", link.ref]);
        const listed = (await (await get("/api/network-discovery/hosts?status=all", writer)).json()).items.find((x) => x.id === printerHost);
        assert.equal(listed.assetProvider, "builtin"); assert.equal(listed.assetRef, link.ref);
    });
    await test("doing it again changes nothing; the same MAC recorded from another row is the same asset; a managed device's host is refused", async () => {
        const before = (await assetsOf()).length;
        const again = await (await send("POST", `/api/network-discovery/hosts/${printerHost}/asset`, undefined, writer)).json();
        assert.equal(again.alreadyLinked, true); assert.equal((await assetsOf()).length, before);
        const site2 = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [A.id, "A annex"])).rows[0].id;
        const twin = await host(site2, "10.4.0.99", "AA:BB:CC:04:00:20", "printer");
        const t = await (await send("POST", `/api/network-discovery/hosts/${twin}/asset`, undefined, writer)).json();
        assert.equal(t.alreadyLinked, true); assert.equal(t.ref, again.ref); assert.equal((await assetsOf()).length, before, "no duplicate");
        assert.equal((await send("POST", `/api/network-discovery/hosts/${managedHost}/asset`, undefined, writer)).status, 409);
        const p = await (await send("POST", `/api/network-discovery/hosts/${plainHost}/asset`, undefined, writer)).json();
        const a = (await q(`SELECT name, kind FROM assets WHERE id = $1`, [p.ref])).rows[0]; assert.equal(a.name, "10.4.0.21"); assert.equal(a.kind, "other");
    });
    await test("an SNMP device is recorded the same way (a switch is network gear, its description goes in the notes)", async () => {
        const link = await (await send("POST", `/api/snmp/devices/${switchDev}/asset`, undefined, writer)).json();
        const a = (await q(`SELECT name, kind, source, notes, details FROM assets WHERE id = $1`, [link.ref])).rows[0];
        assert.deepEqual([a.name, a.kind, a.source, a.notes], ["Core switch", "network", "snmp", "Cisco IOS"]); assert.equal(a.details.ip, "10.4.0.40");
        assert.equal((await (await send("POST", `/api/snmp/devices/${switchDev}/asset`, undefined, writer)).json()).alreadyLinked, true);
        const d = (await get(`/api/snmp/devices/${switchDev}`, writer)); assert.equal((await d.json()).assetProvider, "builtin");
    });
    await test("it needs the right to manage assets and the host to be one the person may see", async () => {
        assert.equal((await send("POST", `/api/network-discovery/hosts/${otherHost}/asset`, undefined, reader)).status, 403);
        assert.equal((await send("POST", `/api/network-discovery/hosts/${otherHost}/asset`, undefined, limited)).status, 404, "another customer's host");
        assert.equal((await send("POST", `/api/network-discovery/hosts/${uuid()}/asset`, undefined, writer)).status, 404);
        assert.equal((await send("POST", `/api/snmp/devices/${switchDev}/asset`, undefined, reader)).status, 403);
    });

    console.log("what switching shows, and the export");
    await test("the preflight counts what the switch changes", async () => {
        const p = await (await get("/api/assets/provider/preflight")).json();
        assert.ok(p.assets >= 3 && p.linkedHosts >= 2 && p.linkedSnmpDevices >= 1, JSON.stringify(p));
        assert.ok(p.willStop.length === 3 && p.staysTheSame.length === 3);
    });
    await test("the export holds every asset with the keys a match is made on, as JSON or CSV, and a spreadsheet formula in a name is made text", async () => {
        await send("POST", "/api/docs/assets", { clientId: A.id, name: "=HYPERLINK(\"http://evil\")", kind: "other", serialNumber: "SN-1" });
        const j = await (await get("/api/assets/export?format=json")).json();
        assert.ok(j.count >= 4 && j.assets.every((a) => "id" in a && "customerId" in a && "deviceId" in a && "serialNumber" in a));
        assert.ok(j.assets.some((a) => a.serialNumber === "SN-1"));
        const csvRes = await get("/api/assets/export?format=csv");
        assert.match(csvRes.headers.get("content-type"), /text\/csv/); assert.match(csvRes.headers.get("content-disposition"), /remoteiq-assets-.*\.csv/);
        const csv = await csvRes.text();
        assert.ok(csv.split("\r\n")[0].startsWith("id,customerId,customer,deviceId,name,kind"));
        assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), "the formula is quoted as text");
        assert.ok(!csv.split("\r\n").some((l) => /^[^,]*,[^,]*,[^,]*,[^,]*,=/.test(l)), "no cell starts with =");
    });

    console.log("switching to an external asset manager");
    const countBefore = (await q(`SELECT count(*)::int AS n FROM assets`)).rows[0].n;
    await test("switching turns the built-in asset manager off: it answers where assets are managed, for reads and writes, and add-as-asset says the same", async () => {
        const r = await send("PUT", "/api/assets/provider", { provider: "external", externalName: "Killian", externalUrl: "https://killian.example.test", confirm: true });
        assert.equal(r.status, 200); const s = await r.json(); assert.deepEqual([s.provider, s.externalName], ["external", "Killian"]);
        const info = await (await get("/api/assets/provider", reader)).json(); assert.deepEqual([info.provider, info.externalName, info.externalUrl], ["external", "Killian", "https://killian.example.test"]);
        const expectOff = async (res, what) => { assert.equal(res.status, 409, what); const b = await res.json(); const m = b.message?.code ? b.message : b; assert.equal(m.code, "assets_external", what + JSON.stringify(b)); assert.match(m.message, /Assets are managed in Killian\./); assert.equal(m.url, "https://killian.example.test"); };
        await expectOff(await get("/api/docs/assets", reader), "list");
        await expectOff(await send("POST", "/api/docs/assets", { clientId: A.id, name: "x", kind: "other" }, writer), "create");
        await expectOff(await send("PUT", `/api/docs/assets/${uuid()}`, { clientId: A.id, name: "x", kind: "other" }, writer), "update");
        await expectOff(await send("DELETE", `/api/docs/assets/${uuid()}`, undefined, writer), "delete");
        await expectOff(await send("POST", "/api/docs/assets/sync", {}, writer), "sync");
        await expectOff(await send("POST", `/api/network-discovery/hosts/${otherHost}/asset`, undefined, owner), "add found host");
        await expectOff(await send("POST", `/api/snmp/devices/${switchDev}/asset`, undefined, owner), "add snmp device");
    });
    await test("nothing is deleted by switching, and the rest of RemoteIQ carries on (passwords still expire, the host list still works)", async () => {
        assert.equal((await q(`SELECT count(*)::int AS n FROM assets`)).rows[0].n, countBefore);
        const exp = await get("/api/docs/expiring?days=3650", reader); assert.equal(exp.status, 200);
        assert.ok((await exp.json()).items.every((i) => i.type !== "asset"), "no asset in the expiry list");
        assert.equal((await get("/api/network-discovery/hosts?status=all", reader)).status, 200);
        assert.equal((await get("/api/assets/provider/preflight")).status, 200, "the export and preflight still work, to be able to import elsewhere");
        assert.equal((await get("/api/assets/export?format=json")).status, 200);
    });
    await test("switching back brings everything back as it was", async () => {
        const r = await send("PUT", "/api/assets/provider", { provider: "builtin", confirm: true }); assert.equal(r.status, 200);
        assert.equal((await r.json()).provider, "builtin");
        const list = await (await get("/api/docs/assets", reader)).json();
        assert.equal(list.items.length >= 4, true); assert.equal((await q(`SELECT count(*)::int AS n FROM assets`)).rows[0].n, countBefore);
        assert.ok(list.items.some((a) => a.name === "office-printer"));
    });
    await test("both switches and the export are in the audit trail", async () => {
        const ev = (await q(`SELECT action, outcome, details FROM audit_events WHERE action LIKE 'assets.%'`)).rows;
        const sw = ev.filter((e) => e.action === "assets.provider.switch");
        assert.ok(sw.some((e) => e.outcome === "success" && e.details.from === "builtin" && e.details.to === "external"), JSON.stringify(sw));
        assert.ok(sw.some((e) => e.outcome === "success" && e.details.from === "external" && e.details.to === "builtin"));
        assert.ok(sw.some((e) => e.outcome === "failure"), "a refused switch is recorded");
        assert.ok(ev.some((e) => e.action === "assets.export"));
        assert.ok((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action IN ('network.discovery.asset','snmp.device.asset')`)).rows[0].n >= 4);
    });

    await q(`DELETE FROM assets WHERE client_id = ANY($1::uuid[])`, [[A.id, B.id]]);
    await q(`DELETE FROM discovered_hosts WHERE site_id IN (SELECT id FROM sites WHERE client_id = ANY($1::uuid[]))`, [[A.id, B.id]]);
    await q(`DELETE FROM snmp_devices WHERE site_id = ANY($1::uuid[])`, [[A.site, B.site]]);
    await q(`DELETE FROM devices WHERE id = $1`, [devId]).catch(() => { });
    await q(`DELETE FROM asset_provider_settings`).catch(() => { });
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
