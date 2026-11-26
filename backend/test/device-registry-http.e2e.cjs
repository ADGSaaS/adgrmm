#!/usr/bin/env node
// The remote registry browser (read-only phase 1, and phase 2: changing values and keys, undo, the record of changes, the rate limit)
// through the real HTTP API, with a fake agent that answers the signed
// script jobs: the devices.registry.read right, path checks, the blocklist (403, no job), the mask, the customer limit, offline and
// Linux devices, audit rows, the slow-device pending flow, and that nothing typed ever reaches the script text.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../adg_reg_e2e JWT_SECRET=... node test/device-registry-http.e2e.cjs
"use strict";
const path = require("node:path");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");
const WR = require(path.join(__dirname, "..", process.env.DIST || "dist", "device-tools", "device-registry.scripts.js"));

const KEY = JSON.stringify({
    ok: true, lastWrite: "2026-11-09T19:39:23.3336133Z", subKeyCount: 3, subKeysTruncated: false, valueCount: 5, valuesTruncated: false,
    subKeys: [{ name: "Run", has: true, blocked: false }, { name: "Lsa", has: true, blocked: false }, { name: "Empty", has: false, blocked: false }],
    values: [
        { name: "", type: "REG_SZ", size: 6, d: "defval" },
        { name: "ProgramFilesDir", type: "REG_SZ", size: 16, d: "C:\\Program Files" },
        { name: "Flags", type: "REG_DWORD", size: 4, d: "255" },
        { name: "DefaultPassword", type: "REG_SZ", size: 6, d: "hunter" },
        { name: "Blob", type: "REG_BINARY", size: 600, d: "de ad be ef", trunc: true },
    ],
});
const ROOTS = JSON.stringify({ ok: true, users: [{ sid: "S-1-5-21-1-2-3-1001", account: "Ann" }, { sid: "S-1-5-18", account: "SYSTEM" }, { sid: "S-1-5-21-1-2-3-1001_Classes", account: null }] });
const SEARCH = JSON.stringify({ ok: true, truncated: true, reason: "time", scanned: 4000, seconds: 20, results: [
    { kind: "key", path: "HKLM\\SOFTWARE\\Vendor\\Run" },
    { kind: "key", path: "HKLM\\SAM\\Domains" },
    { kind: "data", path: "HKLM\\SOFTWARE\\Vendor", name: "Password", type: "REG_SZ", preview: "hunter2" },
    { kind: "data", path: "HKLM\\SOFTWARE\\Vendor", name: "Path", type: "REG_SZ", preview: "C:\\Vendor" },
] });

/* ---- a tiny fake registry per device: the same rules the real write scripts follow (expected old value, sub keys, refusals) ---- */
const lc = (x) => x.toLowerCase();
const sizeOf = (v) => (v.type === "REG_DWORD" ? 4 : v.type === "REG_QWORD" ? 8 : v.type === "REG_BINARY" ? (v.d ? v.d.split(" ").length : 0) : Array.isArray(v.d) ? v.d.reduce((n, x) => n + x.length, 0) : String(v.d).length);
const rowOf = (v) => (v ? { exists: true, name: v.name, type: v.type, size: sizeOf(v), d: v.d } : { exists: false });
const models = new Map();
function modelOf(dev) {
    if (!models.has(dev)) {
        const m = new Map();
        const k = (p, vals = []) => m.set(lc(p), { path: p, values: new Map(vals.map((v) => [lc(v.name), v])) });
        k("HKLM\\SOFTWARE");
        k("HKLM\\SOFTWARE\\Vendor", [{ name: "Name", type: "REG_SZ", d: "old" }, { name: "Count", type: "REG_DWORD", d: "5" }, { name: "List", type: "REG_MULTI_SZ", d: ["a", "b"] }, { name: "Bin", type: "REG_BINARY", d: "01 02" }, { name: "", type: "REG_SZ", d: "default data" }]);
        k("HKLM\\SOFTWARE\\Vendor\\Sub");
        k("HKLM\\SOFTWARE\\Empty");
        k("HKLM\\SOFTWARE\\Filled", [{ name: "One", type: "REG_SZ", d: "1" }, { name: "Two", type: "REG_QWORD", d: "18446744073709551615" }, { name: "Three", type: "REG_MULTI_SZ", d: ["x", "y z"] }]);
        k("HKU\\S-1-5-21-1-2-3-1001\\Software");
        models.set(dev, m);
    }
    return models.get(dev);
}
function fakeWrite(kind, env, dev) {
    const m = modelOf(dev);
    const p = env.ADG_REG_PATH;
    if (/Denied/.test(p)) return { ok: false, error: "Access to the registry key is denied." };
    const un = (x) => String(x).slice(2);
    const dec = (j) => { const o = JSON.parse(j); return Array.isArray(o.v) ? o.v.map(un) : un(o.v); };
    const ex = env.ADG_REG_EXPECT ? JSON.parse(env.ADG_REG_EXPECT) : null;
    const refuse = (reason, message, old) => ({ ok: true, status: "refused", reason, message, ...(old ? { old } : {}) });
    const expectOk = (old) => {
        if (!ex) return true;
        if (!ex.exists) return !old;
        if (!old || ex.type !== old.type) return false;
        if (ex.size !== undefined && ex.size !== sizeOf(old)) return false;
        if (ex.hasData && JSON.stringify(Array.isArray(ex.v) ? ex.v.map(un) : un(ex.v)) !== JSON.stringify(old.d)) return false;
        return true;
    };
    const key = m.get(lc(p));
    if (kind === "set" || kind === "delete-value") {
        if (!key) return { ok: false, error: "That registry key does not exist on this device." };
        const name = env.ADG_REG_NAME ?? "";
        const old = key.values.get(lc(name));
        if (kind === "delete-value" && !old) return refuse("missing", "That value does not exist (any more), so there is nothing to delete.", rowOf(old));
        if (!expectOk(old)) return refuse("changed", "The value was changed on the device since you looked at it, so nothing was changed.", old ? rowOf(old) : undefined);
        if (kind === "delete-value") { key.values.delete(lc(name)); return { ok: true, status: "done", old: rowOf(old), new: { exists: false } }; }
        const nv = { name: old ? old.name : name, type: env.ADG_REG_TYPE, d: dec(env.ADG_REG_DATA) };
        key.values.set(lc(name), nv);
        return { ok: true, status: "done", old: rowOf(old), new: rowOf(nv) };
    }
    const i = p.lastIndexOf("\\");
    const parent = m.get(lc(p.slice(0, i)));
    if (kind === "create-key") {
        if (!parent) return refuse("missing", "The key above it does not exist, so the key cannot be created.");
        if (key) return refuse("exists", "That key already exists, so nothing was created.");
        const items = env.ADG_REG_VALUES ? JSON.parse(env.ADG_REG_VALUES).items : [];
        m.set(lc(p), { path: p, values: new Map(items.map((it) => { const v = { name: un(it.n), type: it.t, d: Array.isArray(it.v) ? it.v.map(un) : un(it.v) }; return [lc(v.name), v]; })) });
        return { ok: true, status: "done", created: true, valueCount: items.length };
    }
    if (!key) return refuse("missing", "That key does not exist (any more), so there is nothing to delete.");
    const subs = [...m.keys()].filter((k) => k.startsWith(`${lc(p)}\\`)).length;
    if (subs > 0) return refuse("hassubkeys", `This key has ${subs} sub key${subs === 1 ? "" : "s"}. Only a key without sub keys can be deleted: delete the sub keys first, one at a time.`);
    if (ex && ex.values !== undefined && ex.values !== key.values.size) return refuse("changed", "The key was changed on the device since you looked at it (its values are not the same any more), so nothing was deleted.");
    const rows = [...key.values.values()].map(rowOf);
    m.delete(lc(p));
    return { ok: true, status: "done", values: rows };
}

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `RG${Date.now()}`;
    const devs = [];

    const reader = await staffUser("rg-reader", ["devices.read", "devices.registry.read"]);
    const noRegistry = await staffUser("rg-noreg", ["devices.read", "devices.actions", "devices.tools.write"]);
    const onlyRegistry = await staffUser("rg-onlyreg", ["devices.registry.read"]);
    const limited = await staffUser("rg-limited", ["devices.read", "devices.registry.read"]);

    // An Owner holds everything by rule, even with no row for this right in the role (the built-in role may not exist in a bare database).
    const owner = await staffUser("rg-owner", []);
    const ownerRole = (await q(`SELECT id FROM roles WHERE organization_id = $1 AND lower(name) = 'owner' LIMIT 1`, [org])).rows[0]?.id
        ?? (await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization','Owner') RETURNING id`, [uuid(), org])).rows[0].id;
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [owner.id, ownerRole]);
    await q(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = 'devices.registry.read'`, [ownerRole]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A");
    const B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const mk = async (site, host, os, minutes = 0) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11" : "Ubuntu 24.04"])).rows[0].id;
        devs.push(id);
        const agent = uuid();
        if (minutes !== null) await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.28', now() - ($4 || ' minutes')::interval, $5)`, [agent, id, uuid(), String(minutes), JSON.stringify({ os })]);
        return { id, agent };
    };
    const win = await mk(A.site, "win", "windows");
    const lin = await mk(A.site, "lin", "linux");
    const off = await mk(A.site, "off", "windows", 90);
    const none = await mk(A.site, "none", "windows", null);
    const other = await mk(B.site, "other", "windows");

    // The fake agent answers every queued registry (and other tool) job as the real scripts would print it.
    let delayKind = null;
    const handled = new Set();
    const seen = [];
    const timer = setInterval(async () => {
        try {
            const rows = (await q(`SELECT j.id, j.payload, a.device_id, a.facts->>'os' AS os FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.status = 'queued' AND a.device_id = ANY($1::uuid[])`, [devs])).rows;
            for (const r of rows) {
                const kind = r.payload?.env?.ADG_TOOL;
                if (!kind || handled.has(r.id)) continue;
                handled.add(r.id);
                if (kind === delayKind) { delayKind = null; await new Promise((x) => setTimeout(x, 27_000)); }
                seen.push({ id: r.id, kind, os: r.os, payload: r.payload });
                const p = r.payload?.env?.ADG_REG_PATH ?? "";
                const writeKind = ["set", "delete-value", "create-key", "delete-key"].find((k) => kind === `registry.${k}`);
                const out = writeKind ? JSON.stringify(fakeWrite(writeKind, r.payload.env, r.device_id))
                    : kind === "registry.key"
                    ? (/NoSuchKey/.test(p) ? JSON.stringify({ ok: false, error: "That registry key does not exist on this device." }) : KEY)
                    : kind === "registry.search" ? SEARCH
                    : kind === "registry.roots" ? ROOTS
                    : kind === "services.list" ? JSON.stringify({ ok: true, items: [] }) : "";
                await q(`UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1`, [r.id]);
                await q(`INSERT INTO job_results (job_id, exit_code, stdout, stderr) VALUES ($1,0,$2,'') ON CONFLICT (job_id) DO NOTHING`, [r.id, out]);
            }
        } catch { /* next tick */ }
    }, 150);

    const get = (id, rest, t) => call(`/api/devices/${id}/tools/registry${rest}`, { token: t.token });
    const enc = encodeURIComponent;

    console.log("rights");
    await test("the permission exists and is granted to Admin only (by the migration); Owner passes by rule", async () => {
        const p = (await q(`SELECT permission_key, group_key FROM permissions WHERE permission_key = 'devices.registry.read'`)).rows;
        assert.equal(p.length, 1);
        const roles = (await q(`SELECT DISTINCT lower(r.name) AS name FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_key = 'devices.registry.read' AND r.name NOT LIKE 'e2e-%'`)).rows.map((r) => r.name);
        assert.ok(!roles.includes("operator") && !roles.includes("viewer"), "not Operator or Viewer");
        assert.ok(roles.every((n) => ["admin", "owner"].includes(n)), `only Admin and Owner hold it: ${roles}`);
    });

    await test("looking needs devices.read and devices.registry.read; a role with the other tools but not this one is refused", async () => {
        assert.equal((await get(win.id, `?path=${enc("HKLM\\SOFTWARE")}`, noRegistry)).status, 403, "services/processes rights are not enough");
        assert.equal((await get(win.id, `/search?path=HKLM&text=a`, noRegistry)).status, 403);
        assert.equal((await get(win.id, `?path=HKLM`, onlyRegistry)).status, 403, "devices.read is needed too");
        assert.ok([401, 403].includes((await call(`/api/devices/${win.id}/tools/registry?path=HKLM`)).status));
        assert.equal((await get(win.id, `/jobs/${uuid()}`, noRegistry)).status, 403);
        assert.equal((await get(win.id, `?path=${enc("HKLM\\SOFTWARE")}`, reader)).status, 200);
    });

    await test("an Owner can browse even when the role holds no row for this right", async () => {
        assert.equal((await get(win.id, `?path=HKLM`, owner)).status, 200);
    });

    console.log("a key");
    await test("a key: sub keys (with children flag, Lsa marked blocked), values rendered, mask applied, time and cuts reported", async () => {
        const before = seen.length;
        const r = await (await get(win.id, `?path=${enc("hkey_local_machine\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion")}&view=32`, reader)).json();
        assert.equal(r.os, "windows"); assert.equal(r.pending, false);
        assert.equal(r.path, "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion", "normalised");
        assert.equal(r.view, "32");
        assert.equal(r.lastWrite, "2026-11-09T19:39:23.3336133Z");
        assert.deepEqual(r.subKeys.map((s) => [s.name, s.hasChildren, s.blocked]), [["Run", true, false], ["Lsa", true, false], ["Empty", false, false]]);
        const v = Object.fromEntries(r.values.map((x) => [x.name, x]));
        assert.equal(v[""].display, "(Default)");
        assert.equal(v.ProgramFilesDir.data, "C:\\Program Files");
        assert.equal(v.Flags.data, 255); assert.equal(v.Flags.hex, "0x000000FF");
        assert.equal(v.DefaultPassword.masked, true); assert.equal(v.DefaultPassword.data, null); assert.equal(v.DefaultPassword.size, 6);
        assert.equal(v.Blob.truncated, true); assert.equal(v.Blob.size, 600);
        assert.ok(!JSON.stringify(r).includes("hunter"), "the secret is not in the answer even if the device sent it");
        const job = seen[seen.length - 1];
        assert.equal(seen.length, before + 1);
        assert.equal(job.kind, "registry.key");
        assert.equal(job.payload.language, "powershell");
        assert.equal(job.payload.env.ADG_REG_PATH, "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion");
        assert.equal(job.payload.env.ADG_REG_VIEW, "32");
        assert.ok(!job.payload.scriptText.includes("Windows\CurrentVersion") && !/Get-CimInstance|Win32_/.test(job.payload.scriptText), "typed path is not in the script; no WMI");
        assert.equal(job.payload.timeoutSec ?? job.payload.timeout_sec ?? 90, 90);
    });

    await test("the roots: HKLM and HKU plus the loaded user SIDs with account names (class hives left out)", async () => {
        const r = await (await get(win.id, ``, reader)).json();
        assert.deepEqual(r.roots.map((x) => x.key), ["HKLM", "HKU"]);
        assert.deepEqual(r.users.map((u) => [u.path, u.account]), [["HKU\\S-1-5-21-1-2-3-1001", "Ann"], ["HKU\\S-1-5-18", "SYSTEM"]]);
        assert.equal(seen[seen.length - 1].kind, "registry.roots");
        const r2 = await (await get(win.id, `?path=HKU`, reader)).json();
        assert.equal(r2.path, "HKU");
        assert.equal(seen[seen.length - 1].payload.env.ADG_REG_PATH, "HKU");
    });

    await test("a key that does not exist is a 409 with the device's words", async () => {
        const r = await get(win.id, `?path=${enc("HKLM\\SOFTWARE\\NoSuchKey")}`, reader);
        assert.equal(r.status, 409);
        assert.match((await r.json()).message, /does not exist/);
    });

    console.log("safety");
    await test("blocked keys are a 403 with a clear message, no job is made, whatever the spelling", async () => {
        const before = seen.length;
        for (const p of ["HKLM\\SAM", "hklm\\sam\\SAM\\Domains", "HKEY_LOCAL_MACHINE\\SECURITY", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa", "HKLM\\SYSTEM\\ControlSet001\\Control\\Lsa\\Data", "HKLM\\SYSTEM\\controlset002\\Control\\LSA",
            "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI", "HKU\\S-1-5-21-1\\Software\\Microsoft\\Protected Storage System Provider", "\\HKLM\\SAM\\"]) {
            const r = await get(win.id, `?path=${enc(p)}`, reader);
            assert.equal(r.status, 403, p);
            assert.match((await r.json()).message, /blocked/i);
            assert.equal((await get(win.id, `/search?path=${enc(p)}&text=a`, reader)).status, 403, `search ${p}`);
        }
        assert.equal(seen.length, before);
    });

    await test("bad paths, views and search arguments are refused before any job", async () => {
        const before = seen.length;
        for (const p of ["HKLM\\SOFTWARE\\*", "HKLM\\SOFT?", "HKLM\\a%00b", "HKLM\\..\\SAM", "HKLM\\SOFTWARE\\..\\..\\SECURITY", "HKLM\\\\SOFTWARE", "HKCU\\Software", "HKCR\\.txt", "C:\\Windows", "HKLM\\" + "a".repeat(300), "HKLM\\a%0Ab"]) {
            assert.equal((await get(win.id, `?path=${p.includes("%") ? p : enc(p)}`, reader)).status, 400, p);
        }
        assert.equal((await get(win.id, `?path=HKLM&view=16`, reader)).status, 400);
        assert.equal((await get(win.id, `/search?path=&text=a`, reader)).status, 400, "search needs a key");
        assert.equal((await get(win.id, `/search?path=HKLM`, reader)).status, 400, "search needs text");
        assert.equal((await get(win.id, `/search?path=HKLM&text=${"x".repeat(201)}`, reader)).status, 400);
        assert.equal((await get(win.id, `/search?path=HKLM&text=a%00b`, reader)).status, 400);
        assert.equal((await get(win.id, `/search?path=HKLM&text=a&in=regex`, reader)).status, 400);
        assert.equal(seen.length, before);
    });

    console.log("search");
    await test("search: text and where travel in environment variables; blocked and secret hits are dropped; the cut is reported", async () => {
        const nasty = "it's \"x\"; $(calc) .*";
        const r = await (await get(win.id, `/search?path=${enc("HKLM\\SOFTWARE")}&text=${enc(nasty)}&in=data&view=64`, reader)).json();
        assert.equal(r.pending, false); assert.equal(r.in, "data"); assert.equal(r.text, nasty);
        assert.deepEqual(r.results.map((x) => [x.kind, x.path, x.name]), [["key", "HKLM\\SOFTWARE\\Vendor\\Run", undefined], ["data", "HKLM\\SOFTWARE\\Vendor", "Path"]]);
        assert.ok(!JSON.stringify(r).includes("hunter2") && !JSON.stringify(r).includes("SAM"));
        assert.equal(r.truncated, true); assert.equal(r.reason, "time");
        const job = seen[seen.length - 1];
        assert.equal(job.kind, "registry.search");
        assert.equal(job.payload.env.ADG_REG_TEXT, nasty);
        assert.equal(job.payload.env.ADG_REG_IN, "data");
        assert.equal(job.payload.env.ADG_REG_PATH, "HKLM\\SOFTWARE");
        assert.ok(!job.payload.scriptText.includes("calc") && !job.payload.scriptText.includes("HKLM\\SOFTWARE\\Vendor"));
        const d = await (await get(win.id, `/search?path=HKU&text=Run`, reader)).json();
        assert.equal(seen[seen.length - 1].payload.env.ADG_REG_IN, "keys", "default is keys");
        assert.equal(d.in, "keys");
    });

    console.log("which devices");
    await test("Linux devices get a clear message; an offline device and one with no agent are refused; unknown ids are 404", async () => {
        const l = await get(lin.id, `?path=HKLM`, reader);
        assert.equal(l.status, 400);
        assert.match((await l.json()).message, /only available for Windows/);
        assert.equal((await get(lin.id, `/search?path=HKLM&text=a`, reader)).status, 400);
        const o = await get(off.id, `?path=HKLM`, reader);
        assert.equal(o.status, 409);
        assert.match((await o.json()).message, /offline/i);
        assert.equal((await get(none.id, `?path=HKLM`, reader)).status, 409);
        assert.equal((await get(uuid(), `?path=HKLM`, reader)).status, 404);
        assert.equal((await get("not-a-uuid", `?path=HKLM`, reader)).status, 404);
    });

    await test("a person limited to some customers gets 404 for another customer's device and cannot make a job there", async () => {
        const before = seen.length;
        assert.equal((await get(other.id, `?path=HKLM`, limited)).status, 404);
        assert.equal((await get(other.id, `/search?path=HKLM&text=a`, limited)).status, 404);
        assert.equal((await get(other.id, ``, limited)).status, 404);
        assert.equal(seen.length, before);
        assert.equal((await get(win.id, `?path=HKLM`, limited)).status, 200);
    });

    console.log("audit");
    await test("every look and search is audited with the path and text and no data; refused ones are recorded as failures", async () => {
        await new Promise((r) => setTimeout(r, 600));
        const ev = (await q(`SELECT action, outcome, details, actor_user_id FROM audit_events WHERE target_id = $1 AND action LIKE 'device.registry.%' ORDER BY created_at`, [win.id])).rows;
        const views = ev.filter((e) => e.action === "device.registry.view");
        const searches = ev.filter((e) => e.action === "device.registry.search");
        assert.ok(views.some((e) => e.outcome === "success" && e.details.path === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" && e.details.view === "32"));
        assert.ok(views.some((e) => e.outcome === "success" && !e.details.path), "the roots look (empty path)");
        assert.ok(views.some((e) => e.outcome === "failure" && e.details.path === "HKLM\\SAM" && /blocked/i.test(e.details.error)), "a blocked look is recorded");
        assert.ok(views.some((e) => e.outcome === "failure" && /wildcard/i.test(e.details.error)), "a refused path is recorded");
        const s = searches.find((e) => e.outcome === "success");
        assert.equal(s.details.text, "it's \"x\"; $(calc) .*"); assert.equal(s.details.in, "data"); assert.equal(s.details.path, "HKLM\\SOFTWARE");
        assert.equal(s.actor_user_id, reader.id);
        const blob = JSON.stringify(ev);
        for (const secret of ["defval", "C:\\\\Program Files", "hunter", "de ad be ef"]) assert.ok(!blob.includes(secret), `no data value: ${secret}`);
        const lv = (await q(`SELECT outcome FROM audit_events WHERE target_id = $1 AND action = 'device.registry.view'`, [lin.id])).rows;
        assert.ok(lv.length >= 1 && lv.every((e) => e.outcome === "failure"), "the Linux attempt is recorded");
    });

    console.log("a slow device");
    await test("a slow device answers pending, and the registry jobs route returns the result (only registry jobs of this device, with this right)", async () => {
        delayKind = "registry.key";
        const r = await (await get(win.id, `?path=${enc("HKLM\\SOFTWARE\\Slow")}`, reader)).json();
        assert.equal(r.pending, true); assert.ok(r.jobId);
        assert.equal((await call(`/api/devices/${win.id}/tools/jobs/${r.jobId}`, { token: noRegistry.token })).status, 404, "the generic tools route never returns registry data");
        assert.equal((await get(win.id, `/jobs/${r.jobId}`, noRegistry)).status, 403);
        let again = await (await get(win.id, `/jobs/${r.jobId}`, reader)).json();
        for (let i = 0; i < 20 && again.pending; i++) { await new Promise((x) => setTimeout(x, 500)); again = await (await get(win.id, `/jobs/${r.jobId}`, reader)).json(); }
        assert.equal(again.pending, false);
        assert.equal(again.values.find((v) => v.name === "DefaultPassword").data, null, "masked on the poll path as well");
        assert.equal((await get(lin.id, `/jobs/${r.jobId}`, reader)).status, 400, "not for a Linux device");
        assert.equal((await get(other.id, `/jobs/${r.jobId}`, limited)).status, 404);
        // a job of the other tools is not readable here
        await call(`/api/devices/${win.id}/tools/services`, { token: noRegistry.token });
        const svc = seen.filter((s) => s.kind === "services.list").pop();
        assert.equal((await get(win.id, `/jobs/${svc.id}`, reader)).status, 404);
        assert.equal((await get(win.id, `/jobs/nope`, reader)).status, 404);
    });

    /* ================================================== phase 2: writing ================================================== */
    // Every group uses its own device and people: a device takes 10 change attempts a minute and a person 30, and EVERY attempt counts.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const DATAMARK = "DATAMARK-7f3a";
    await q(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = 'devices.registry.write'`, [ownerRole]);
    const writer = (label, extra = []) => staffUser(label, ["devices.read", "devices.registry.read", "devices.registry.write", ...extra]);
    const newWin = (label = "w") => mk(A.site, `${label}${devs.length}`, "windows");
    const writeOnly = await staffUser("rg-writeonly", ["devices.registry.write"]);
    const adminGranted = await writer("rg-admin-granted");
    const limitedW = await writer("rg-limited-w");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limitedW.id, A.id]);
    const V = "HKLM\\SOFTWARE\\Vendor";
    const reg = (dev, rest, t, method = "GET", body) => call(`/api/devices/${typeof dev === "string" ? dev : dev.id}/tools/registry${rest}`, { token: t?.token, method, body });
    const put = (dev, t, body) => reg(dev, "/value", t, "PUT", body);
    const delv = (dev, t, body) => reg(dev, "/value", t, "DELETE", body);
    const mkkey = (dev, t, body) => reg(dev, "/key", t, "POST", body);
    const delkey = (dev, t, body) => reg(dev, "/key", t, "DELETE", body);
    const undo = (dev, t, id) => reg(dev, `/changes/${id}/undo`, t, "POST");
    const rows = async (dev) => (await q(`SELECT * FROM device_registry_changes WHERE device_id = $1 ORDER BY at, id`, [dev.id])).rows;
    const audits = async (dev, like = "device.registry.%") => { await sleep(700); return (await q(`SELECT action, outcome, details, actor_user_id FROM audit_events WHERE target_id = $1 AND action LIKE $2 ORDER BY created_at, id`, [dev.id, like])).rows; };
    const rotate = async (items, fn, per = 8) => {
        let dev, user, n = 0;
        for (const it of items) {
            if (n % per === 0) { dev = await newWin("rot"); user = await writer(`rot${devs.length}`); }
            n++;
            await fn(it, dev, user);
        }
    };
    const jobsFor = (kind) => seen.filter((s) => s.kind === kind);

    console.log("writing: rights");
    await test("the write permission exists (devices group) and the migration grants it to NO role: Admin, Operator and Viewer do not have it (Owner holds it by rule)", async () => {
        const p = (await q(`SELECT permission_key, group_key FROM permissions WHERE permission_key = 'devices.registry.write'`)).rows;
        assert.equal(p.length, 1); assert.equal(p[0].group_key, "devices");
        const roles = (await q(`SELECT DISTINCT lower(r.name) AS name FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_key = 'devices.registry.write' AND r.name NOT LIKE 'e2e-%'`)).rows.map((r) => r.name);
        assert.ok(roles.every((n) => n === "owner"), `only a role that holds everything (Owner) may have it: ${roles}`);
        const read = (await q(`SELECT DISTINCT lower(r.name) AS name FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_key = 'devices.registry.read' AND r.name NOT LIKE 'e2e-%'`)).rows.map((r) => r.name);
        assert.ok(read.length === 0 || read.every((n) => ["admin", "owner"].includes(n)), "the read right is unchanged");
    });

    await test("every change route needs devices.read AND devices.registry.read AND devices.registry.write: read-only, other-tools, write-only and signed-out callers are refused and make no job and no record", async () => {
        const D = await newWin();
        const before = seen.length;
        const bodies = [["PUT", "/value", { path: V, name: "X", type: "REG_SZ", data: "a" }], ["DELETE", "/value", { path: V, name: "Name" }], ["POST", "/key", { path: `${V}\\New` }], ["DELETE", "/key", { path: `${V}\\Sub` }], ["POST", `/changes/${uuid()}/undo`, undefined]];
        for (const [method, rest, body] of bodies) {
            for (const [who, t] of [["a reader who may browse", reader], ["a person with the other tools", noRegistry], ["write right only", writeOnly]]) {
                assert.equal((await reg(D, rest, t, method, body)).status, 403, `${method} ${rest} as ${who}`);
            }
            const anon = (await reg(D, rest, undefined, method, body)).status;
            assert.ok([401, 403].includes(anon), `${method} ${rest} signed out: ${anon}`);
        }
        assert.equal(seen.length, before); assert.equal((await rows(D)).length, 0);
        assert.equal((await reg(D, "/changes", reader)).status, 200, "the list only needs the right to browse");
        assert.equal((await reg(D, "/changes", noRegistry)).status, 403); assert.equal((await reg(D, "/changes", writeOnly)).status, 403);
    });

    await test("a refused write is recorded in the audit trail by the permission guard too", async () => {
        const D = await newWin();
        await put(D, reader, { path: V, name: "X", type: "REG_SZ", data: "a" });
        const ev = await audits(D, "device.registry.set");
        assert.ok(ev.some((e) => e.outcome === "failure" && e.details.reason === "permission_denied" && e.details.permission === "devices.registry.write" && e.actor_user_id === reader.id));
    });

    await test("Owner (by rule, with no row for this right in the role) and an Admin who was granted the right can both change a value; the right needs nothing else", async () => {
        const D1 = await newWin(), D2 = await newWin();
        for (const [D, who] of [[D1, owner], [D2, adminGranted]]) {
            const r = await put(D, who, { path: V, name: "Name", type: "REG_SZ", data: `${DATAMARK} by ${who.id}`, expected: { exists: true, type: "REG_SZ", data: "old" } });
            assert.equal(r.status, 200); const b = await r.json(); assert.equal(b.status, "ok"); assert.equal(b.change.outcome, "ok"); assert.equal(b.change.canUndo, false, "only the list says what may be undone");
        }
    });

    console.log("writing: a change");
    await test("set a value: old and new come back, the record keeps both, the job is the fixed script with the typed text only in environment variables, the audit row has the path, name and types but NO data", async () => {
        const D = await newWin(); const W = await writer("w-set");
        const before = seen.length;
        const data = `new "quoted" caf\u00e9 ${DATAMARK}`;
        const r = await put(D, W, { path: "hklm\\SOFTWARE\\Vendor", view: "64", name: "Name", type: "reg_sz", data, expected: { exists: true, type: "REG_SZ", size: 3, data: "old" } });
        assert.equal(r.status, 200); const b = await r.json();
        assert.equal(b.os, "windows"); assert.equal(b.pending, false); assert.equal(b.status, "ok");
        const c = b.change;
        assert.equal(c.path, V); assert.equal(c.action, "set"); assert.equal(c.valueName, "Name"); assert.equal(c.hive, "HKLM"); assert.equal(c.outcome, "ok");
        assert.deepEqual([c.old.type, c.old.data, c.new.type, c.new.data], ["REG_SZ", "old", "REG_SZ", data]);
        assert.equal(seen.length, before + 1);
        const job = seen[seen.length - 1];
        assert.equal(job.kind, "registry.set"); assert.equal(job.payload.language, "powershell"); assert.equal(job.payload.scriptText, WR.REGISTRY_WRITE_SCRIPTS.set, "the fixed script, byte for byte");
        const env = job.payload.env;
        assert.equal(env.ADG_REG_PATH, V); assert.equal(env.ADG_REG_NAME, "Name"); assert.equal(env.ADG_REG_TYPE, "REG_SZ"); assert.equal(env.ADG_REG_VIEW, "64");
        assert.equal(JSON.parse(env.ADG_REG_DATA).v, `s:${data}`);
        assert.deepEqual(JSON.parse(env.ADG_REG_EXPECT), { exists: true, type: "REG_SZ", size: 3, hasData: true, v: "s:old" });
        assert.ok(!job.payload.scriptText.includes(DATAMARK) && !job.payload.scriptText.includes("Vendor"), "no typed text in the script");
        assert.equal(job.payload.timeoutSec ?? job.payload.timeout_sec ?? 90, 90);
        const [row] = await rows(D);
        assert.equal(row.outcome, "ok"); assert.equal(row.action, "set"); assert.equal(row.hive, "HKLM"); assert.equal(row.view, "64"); assert.equal(row.path, V); assert.equal(row.value_name, "Name");
        assert.deepEqual([row.old_type, row.old_data, row.new_type, row.new_data], ["REG_SZ", "old", "REG_SZ", data]);
        assert.equal(row.user_id, W.id); assert.ok(row.user_name); assert.ok(row.job_id); assert.equal(row.undone_at, null); assert.equal(row.undo_of, null);
        const ev = await audits(D, "device.registry.set");
        assert.equal(ev.length, 1); assert.equal(ev[0].outcome, "success"); assert.equal(ev[0].actor_user_id, W.id);
        assert.deepEqual([ev[0].details.path, ev[0].details.valueName, ev[0].details.type, ev[0].details.oldType, ev[0].details.newType, ev[0].details.changeId], [V, "Name", "REG_SZ", "REG_SZ", "REG_SZ", row.id]);
        assert.ok(!JSON.stringify(ev).includes(DATAMARK) && !JSON.stringify(ev).includes("caf"), "no data in the audit row");
    });

    await test("every type through the API: numbers as decimal or hex, big QWORD, list, binary (hex normalised), expand string; the (Default) value; create with 'should not exist'", async () => {
        const D = await newWin(); const W = await writer("w-types");
        const one = async (name, type, data, expected) => { const r = await put(D, W, { path: V, name, type, data, expected: expected ?? { exists: false } }); assert.equal(r.status, 200, `${name}: ${JSON.stringify(await r.clone().json())}`); return (await r.json()).change; };
        const d = await one("Count", "REG_DWORD", "0xFF", { exists: true, type: "REG_DWORD", data: 5, size: 4 }); assert.equal(d.old.data, 5); assert.equal(d.new.data, 255); assert.equal(d.new.hex, "0x000000FF");
        const q64 = await one("Big", "REG_QWORD", "18446744073709551615"); assert.equal(q64.new.data, "18446744073709551615"); assert.equal(q64.new.hex, "0xFFFFFFFFFFFFFFFF"); assert.deepEqual(q64.old, { exists: false });
        const m = await one("Lines", "REG_MULTI_SZ", ["l1", "l 2"]); assert.deepEqual(m.new.data, ["l1", "l 2"]);
        const b = await one("Blob", "REG_BINARY", "DE AD BE EF"); assert.equal(b.new.data, "de ad be ef");
        const e = await one("Path", "REG_EXPAND_SZ", "%SystemRoot%\\x"); assert.equal(e.new.type, "REG_EXPAND_SZ");
        const def = await one("", "REG_SZ", "changed default", { exists: true, type: "REG_SZ", data: "default data" }); assert.equal(def.display, "(Default)"); assert.equal(def.old.data, "default data");
        assert.equal(jobsFor("registry.set").slice(-1)[0].payload.env.ADG_REG_NAME, "");
        const bin = jobsFor("registry.set").find((j) => j.payload.env.ADG_REG_NAME === "Blob");
        assert.equal(JSON.parse(bin.payload.env.ADG_REG_DATA).v, "s:de ad be ef");
    });

    await test("optimistic concurrency: a stale 'expected old value' is a 409 'changed' (record: refused, audit: failure), nothing changes; a failing or missing key is a 409 and a 'failed' record", async () => {
        const D = await newWin(); const W = await writer("w-conc");
        const stale = await put(D, W, { path: V, name: "Name", type: "REG_SZ", data: `x ${DATAMARK}`, expected: { exists: true, type: "REG_SZ", data: "stale" } });
        assert.equal(stale.status, 409); const sb = await stale.json(); assert.equal(sb.code, "changed"); assert.match(sb.message, /changed on the device since you looked/); assert.ok(sb.changeId);
        assert.equal((await put(D, W, { path: V, name: "Name", type: "REG_SZ", data: "x", expected: { exists: false } })).status, 409, "'should not exist' but it does");
        const ok = await put(D, W, { path: V, name: "Name", type: "REG_SZ", data: `fine ${DATAMARK}`, expected: { exists: true, type: "REG_SZ", data: "old" } });
        assert.equal(ok.status, 200, "the registry was not touched by the refused attempts");
        const miss = await put(D, W, { path: "HKLM\\SOFTWARE\\NoSuchKey", name: "Z", type: "REG_SZ", data: "x" });
        assert.equal(miss.status, 409); assert.match((await miss.json()).message, /does not exist/);
        const denied = await put(D, W, { path: "HKLM\\SOFTWARE\\Denied", name: "Z", type: "REG_SZ", data: "x" });
        assert.equal(denied.status, 409); assert.match((await denied.json()).message, /denied/i);
        const rs = await rows(D);
        assert.deepEqual(rs.map((r) => r.outcome), ["refused", "refused", "ok", "failed", "failed"]);
        assert.match(rs[0].error, /changed on the device/); assert.equal(rs[0].new_data, null, "a refused change keeps no data"); assert.match(rs[4].error, /denied/i);
        const ev = await audits(D, "device.registry.set");
        assert.deepEqual(ev.map((e) => e.outcome), ["failure", "failure", "success", "failure", "failure"]);
        assert.equal(ev[0].details.reason, "changed"); assert.equal(ev[0].details.changeId, rs[0].id);
        assert.ok(!JSON.stringify(ev).includes(DATAMARK));
    });

    console.log("writing: checks before any job");
    await test("bad names, types and data are 400 and make no job; with a valid path they are recorded as refused (no data kept); a bad path or view is a 400 with no record", async () => {
        const before = seen.length; const recorded = [];
        const bads = [
            [{ name: "a".repeat(16384), type: "REG_SZ", data: "x" }, /too long/], [{ name: "a\nb", type: "REG_SZ", data: "x" }, /not allowed/], [{ name: 5, type: "REG_SZ", data: "x" }, /text/],
            [{ name: "N", type: "REG_NONE", data: "x" }, /type must be/], [{ name: "N", data: "x" }, /type must be/], [{ name: "N", type: "REG_SZ; calc", data: "x" }, /type must be/],
            [{ name: "N", type: "REG_DWORD", data: "4294967296" }, /from 0 to/], [{ name: "N", type: "REG_DWORD", data: "-1" }, /whole number/], [{ name: "N", type: "REG_DWORD", data: "abc" }, /whole number/],
            [{ name: "N", type: "REG_QWORD", data: "18446744073709551616" }, /from 0 to/], [{ name: "N", type: "REG_BINARY", data: "xyz" }, /hex bytes/], [{ name: "N", type: "REG_BINARY", data: "abc" }, /hex bytes/],
            [{ name: "N", type: "REG_BINARY", data: "ab".repeat(4097) }, /too long/], [{ name: "N", type: "REG_SZ", data: "x".repeat(8193) }, /too long/], [{ name: "N", type: "REG_SZ", data: `a${String.fromCharCode(0)}b` }, /NUL/],
            [{ name: "N", type: "REG_MULTI_SZ", data: ["a", "", "b"] }, /empty/], [{ name: "N", type: "REG_MULTI_SZ", data: Array.from({ length: 101 }, () => "x") }, /100 lines/], [{ name: "N", type: "REG_MULTI_SZ", data: "a\nb" }, /list of lines/],
            [{ name: "N", type: "REG_SZ", data: "x", expected: { exists: "yes" } }, /expected/],
        ];
        await rotate(bads, async ([extra, re], D, W) => {
            const r = await put(D, W, { path: V, ...extra });
            assert.equal(r.status, 400, JSON.stringify(extra).slice(0, 80)); const b = await r.json(); assert.match(b.message, re); assert.ok(b.changeId, "recorded");
            recorded.push(b.changeId);
        });
        const rs = (await q(`SELECT outcome, new_data, error FROM device_registry_changes WHERE id = ANY($1::uuid[])`, [recorded])).rows;
        assert.equal(rs.length, bads.length); assert.ok(rs.every((r) => r.outcome === "refused" && r.new_data === null && r.error));
        await rotate(["HKLM\\SOFTWARE\\*", "HKCU\\Software", "HKLM\\a\\..\\b", "", "HKLM\\SOFTWARE\\" + "a".repeat(300)], async (p, D, W) => {
            const r = await put(D, W, { path: p, name: "N", type: "REG_SZ", data: "x" }); assert.equal(r.status, 400, p);
            assert.equal((await rows(D)).length, 0, "no record without a path");
        });
        const D = await newWin(); const W = await writer("w-view");
        assert.equal((await put(D, W, { path: V, view: "16", name: "N", type: "REG_SZ", data: "x" })).status, 400);
        assert.equal((await mkkey(D, W, { path: "" })).status, 400); assert.equal((await delkey(D, W, { path: V, expectedValueCount: -1 })).status, 400);
        assert.equal(seen.length, before, "no job for any of them");
    });

    await test("THE WRITE BLOCKLIST: protected keys and values are a 403 'This change is blocked', whatever the route or spelling, with NO job, a refused record and an audit failure; secret-named values too", async () => {
        const before = seen.length;
        const WN = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
        const cases = [
            ["PUT", { path: "HKLM\\SOFTWARE", name: "x" }, /registry roots and top-level/], ["PUT", { path: "HKLM", name: "x" }, /registry roots/], ["PUT", { path: "HKU\\S-1-5-21-1-2-3-1001", name: "x" }, /top-level/],
            ["PUT", { path: `${WN}\\Winlogon`, name: "Shell" }, /Winlogon/], ["PUT", { path: `${WN}\\Winlogon`, name: "userinit" }, /Winlogon/], ["PUT", { path: `${WN}\\Winlogon`, name: "Taskman" }, /Winlogon/], ["PUT", { path: `${WN}\\Winlogon`, name: "AppSetup" }, /Winlogon/],
            ["PUT", { path: "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", name: "x" }, /Session Manager/], ["PUT", { path: "HKLM\\SYSTEM\\ControlSet002\\Control\\Session Manager", name: "BootExecute" }, /Session Manager/],
            ["PUT", { path: "HKLM\\SYSTEM\\ControlSet001\\Control\\SafeBoot\\Minimal", name: "x" }, /SafeBoot/], ["PUT", { path: "HKLM\\SYSTEM\\Setup\\Status", name: "x" }, /Setup/],
            ["PUT", { path: `${WN}\\Image File Execution Options\\notepad.exe`, name: "Debugger" }, /Image File Execution/], ["PUT", { path: `${WN}\\SilentProcessExit\\a`, name: "x" }, /SilentProcessExit/],
            ["PUT", { path: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", name: "EnableLUA" }, /User Account Control/], ["PUT", { path: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", name: "ConsentPromptBehaviorAdmin" }, /User Account Control/],
            ["PUT", { path: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", name: "LocalAccountTokenFilterPolicy" }, /User Account Control/],
            ["PUT", { path: "HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Exclusions\\Paths", name: "C:\\x" }, /Defender/], ["PUT", { path: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender", name: "DisableAntiSpyware" }, /Defender/],
            ["PUT", { path: "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WinDefend", name: "Start" }, /Defender/],
            ["PUT", { path: "HKLM\\SOFTWARE\\AdgRmm", name: "x" }, /AdgRmm/], ["PUT", { path: "HKLM\\SOFTWARE\\WOW6432Node\\Vendor\\AdgRmm Agent", name: "x" }, /AdgRmm/], ["PUT", { path: "HKLM\\SYSTEM\\CurrentControlSet\\Services\\AdgRmmAgent", name: "ImagePath" }, /AdgRmm/],
            ["PUT", { path: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run", name: "Updater" }, /Run keys/], ["PUT", { path: "HKU\\S-1-5-21-1-2-3-1001\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce", name: "x" }, /Run keys/], ["POST", { path: "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run\\New" }, /Run keys/], ["PUT", { path: `${WN}\\Windows`, name: "AppInit_DLLs" }, /AppInit_DLLs/], ["PUT", { path: `${WN}\\Windows`, name: "LoadAppInit_DLLs" }, /AppInit_DLLs/],
            ["PUT", { path: "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa", name: "RunAsPPL" }, /blocked/], ["PUT", { path: "HKLM\\SAM\\SAM", name: "x" }, /protected|holds|blocked/], ["PUT", { path: "HKLM\\SECURITY", name: "x" }, /blocked/],
            ["PUT", { path: V, name: "MyPassword" }, /password, secret, token/], ["PUT", { path: V, name: "ApiKey" }, /password, secret, token/], ["PUT", { path: V, name: "client_secret" }, /password, secret, token/],
            ["DELETE", { path: V, name: "MyPassword" }, /password, secret, token/], ["DELETE", { path: `${WN}\\Winlogon`, name: "Shell" }, /Winlogon/], ["DELETE", { path: "HKLM\\SOFTWARE\\AdgRmm", name: "x" }, /AdgRmm/],
            ["POST", { path: "HKLM\\SYSTEM" }, /top-level/], ["POST", { path: "HKLM\\SOFTWARE\\AdgRmm\\New" }, /AdgRmm/], ["POST", { path: "HKLM\\SYSTEM\\Setup\\New" }, /Setup/], ["POST", { path: "HKU\\.DEFAULT" }, /top-level/],
            ["DKEY", { path: `${WN}\\Winlogon` }, /Winlogon/], ["DKEY", { path: "HKLM\\SOFTWARE" }, /top-level/], ["DKEY", { path: `${WN}\\Image File Execution Options` }, /Image File/], ["DKEY", { path: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" }, /User Account Control/],
        ];
        const ids = [];
        await rotate(cases, async ([method, body, re], D, W) => {
            const full = { type: "REG_SZ", data: `x ${DATAMARK}`, ...body };
            const r = method === "PUT" ? await put(D, W, full) : method === "DELETE" ? await delv(D, W, body) : method === "POST" ? await mkkey(D, W, body) : await delkey(D, W, body);
            assert.equal(r.status, 403, `${method} ${JSON.stringify(body)}`); const b = await r.json();
            assert.match(b.message, /^This change is blocked: /); assert.match(b.message, re, JSON.stringify(body)); assert.ok(b.changeId); ids.push(b.changeId);
        });
        assert.equal(seen.length, before, "no job was made for any blocked change");
        const rs = (await q(`SELECT outcome, error, new_data, new_type, old_data FROM device_registry_changes WHERE id = ANY($1::uuid[])`, [ids])).rows;
        assert.equal(rs.length, cases.length); assert.ok(rs.every((r) => r.outcome === "refused" && /blocked/.test(r.error) && r.new_data === null && r.old_data === null));
        const fails = (await q(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'device.registry.%' AND outcome = 'failure' AND details->>'changeId' = ANY($1::text[])`, [ids])).rows[0].n;
        await sleep(300);
        assert.equal((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'device.registry.%' AND outcome = 'failure' AND details->>'changeId' = ANY($1::text[])`, [ids])).rows[0].n >= fails, true);
        assert.ok(fails >= cases.length - 2, `audit failures recorded: ${fails}`);
        assert.ok(!(await q(`SELECT 1 FROM audit_events WHERE details::text LIKE $1`, [`%${DATAMARK}%`])).rowCount, "no data in any audit row");
    });

    console.log("writing: values and keys");
    await test("delete a value (old comes back), a missing value is refused, create a key, an existing key and a missing parent are refused, delete a key with sub keys is refused, only an empty key goes, with its values recorded", async () => {
        const D = await newWin(); const W = await writer("w-keys");
        let r = await delv(D, W, { path: V, name: "Count", expected: { exists: true, type: "REG_DWORD", data: 5, size: 4 } });
        assert.equal(r.status, 200); let b = await r.json(); assert.equal(b.change.action, "delete-value"); assert.equal(b.change.old.data, 5); assert.deepEqual(b.change.new, { exists: false });
        assert.equal(jobsFor("registry.delete-value").slice(-1)[0].payload.scriptText, WR.REGISTRY_WRITE_SCRIPTS.deleteValue);
        r = await delv(D, W, { path: V, name: "Count" }); assert.equal(r.status, 409); assert.match((await r.json()).message, /does not exist/);
        r = await mkkey(D, W, { path: "HKLM\\SOFTWARE\\Created" }); assert.equal(r.status, 200); b = await r.json(); assert.equal(b.change.action, "create-key"); assert.equal(b.change.valueCount, 0);
        assert.equal(jobsFor("registry.create-key").slice(-1)[0].payload.env.ADG_REG_PATH, "HKLM\\SOFTWARE\\Created");
        assert.equal((await mkkey(D, W, { path: "HKLM\\SOFTWARE\\Created" })).status, 409);
        r = await mkkey(D, W, { path: "HKLM\\SOFTWARE\\NoParent\\Child" }); assert.equal(r.status, 409); assert.match((await r.json()).message, /above it does not exist/);
        r = await delkey(D, W, { path: V }); assert.equal(r.status, 409); assert.match((await r.json()).message, /has 1 sub key/); assert.ok(modelOf(D.id).has(lc(V)), "nothing deleted");
        r = await delkey(D, W, { path: "HKLM\\SOFTWARE\\Filled", expectedValueCount: 2 }); assert.equal(r.status, 409); assert.equal((await r.json()).code, "changed");
        r = await delkey(D, W, { path: "HKLM\\SOFTWARE\\Filled", expectedValueCount: 3 }); assert.equal(r.status, 200); b = await r.json();
        assert.equal(b.change.action, "delete-key"); assert.equal(b.change.valueCount, 3);
        assert.deepEqual(b.change.deletedValues.map((v) => [v.name, v.type]), [["One", "REG_SZ"], ["Two", "REG_QWORD"], ["Three", "REG_MULTI_SZ"]]);
        assert.equal(jobsFor("registry.delete-key").slice(-1)[0].payload.scriptText, WR.REGISTRY_WRITE_SCRIPTS.deleteKey);
        const [rec] = (await rows(D)).filter((x) => x.action === "delete-key" && x.outcome === "ok");
        assert.equal(rec.old_type, "KEY"); assert.equal(rec.old_data.length, 3); assert.equal(rec.old_data[1].data, "18446744073709551615");
        const ev = await audits(D);
        assert.deepEqual([...new Set(ev.map((e) => e.action))].sort(), ["device.registry.create-key", "device.registry.delete-key", "device.registry.delete-value"]);
        assert.ok(!JSON.stringify(ev).includes("18446744073709551615") && !JSON.stringify(ev).includes("y z"), "no data in the audit rows");
        assert.ok(ev.some((e) => e.action === "device.registry.delete-key" && e.outcome === "success" && e.details.valueCount === 3 && e.details.path === "HKLM\\SOFTWARE\\Filled"));
    });

    console.log("writing: undo");
    await test("undo a value change: only an ok change not yet undone, only while the value is what the change left ('changed again' otherwise, nothing clobbered), recorded as its own change, an undo cannot be undone", async () => {
        const D = await newWin(); const W = await writer("w-undo");
        const set = async (data, expected) => (await (await put(D, W, { path: V, name: "Name", type: "REG_SZ", data, expected })).json()).change;
        const c1 = await set("v1", { exists: true, type: "REG_SZ", data: "old" });
        const c2 = await set("v2", { exists: true, type: "REG_SZ", data: "v1" });
        let r = await undo(D, W, c1.id); assert.equal(r.status, 409); let b = await r.json();
        assert.equal(b.code, "changed_again"); assert.match(b.message, /changed again since/); assert.match(b.message, /nothing was clobbered/);
        assert.equal(modelOf(D.id).get(lc(V)).values.get("name").d, "v2", "not clobbered");
        assert.equal((await q(`SELECT undone_at FROM device_registry_changes WHERE id = $1`, [c1.id])).rows[0].undone_at, null);
        r = await undo(D, W, c2.id); assert.equal(r.status, 200); b = await r.json(); assert.equal(b.change.action, "set"); assert.equal(b.change.undo, true); assert.equal(b.change.undoOf, c2.id); assert.equal(b.change.new.data, "v1");
        assert.equal(modelOf(D.id).get(lc(V)).values.get("name").d, "v1");
        const j = jobsFor("registry.set").slice(-1)[0]; assert.deepEqual(JSON.parse(j.payload.env.ADG_REG_EXPECT), { exists: true, type: "REG_SZ", hasData: true, v: "s:v2" }, "undo expects what the change left");
        const orig = (await q(`SELECT undone_at, undone_by FROM device_registry_changes WHERE id = $1`, [c2.id])).rows[0]; assert.ok(orig.undone_at); assert.equal(orig.undone_by, W.id);
        r = await undo(D, W, c2.id); assert.equal(r.status, 409); assert.match((await r.json()).message, /already undone/);
        r = await undo(D, W, b.change.id); assert.equal(r.status, 409); assert.match((await r.json()).message, /undo cannot be undone/);
        r = await undo(D, W, c1.id); assert.equal(r.status, 200); assert.equal(modelOf(D.id).get(lc(V)).values.get("name").d, "old");
        const rs = await rows(D);
        const undoRows = rs.filter((x) => x.undo_of);
        assert.deepEqual(undoRows.map((x) => [x.undo_of, x.outcome]), [[c1.id, "refused"], [c2.id, "ok"], [c1.id, "ok"]]);
        assert.match(undoRows[0].error, /changed again since/);
        const ev = await audits(D, "device.registry.undo");
        assert.ok(ev.length >= 4); assert.ok(ev.some((e) => e.outcome === "success" && e.details.changeId) && ev.some((e) => e.outcome === "failure" && e.details.reason === "changed_again"));
        assert.ok(!/v[12]/.test(JSON.stringify(ev.map((e) => e.details))), "no data in the undo audit rows");
        r = await undo(D, W, uuid()); assert.equal(r.status, 404); r = await undo(D, W, "nope"); assert.equal(r.status, 404);
    });

    await test("undo a created value (deletes it), a deleted value (puts it back, not over a re-created one), a refused change (refused), another device's change (404); undo needs the write right", async () => {
        const D = await newWin(); const W = await writer("w-undo2"); const D2 = await newWin();
        const made = (await (await put(D, W, { path: V, name: "Fresh", type: "REG_DWORD", data: "7", expected: { exists: false } })).json()).change;
        let r = await undo(D, W, made.id); assert.equal(r.status, 200); let b = await r.json(); assert.equal(b.change.action, "delete-value"); assert.equal(modelOf(D.id).get(lc(V)).values.has("fresh"), false);
        const del = (await (await delv(D, W, { path: V, name: "Count", expected: { exists: true, type: "REG_DWORD", data: 5 } })).json()).change;
        r = await undo(D, W, del.id); assert.equal(r.status, 200); b = await r.json(); assert.equal(b.change.action, "set"); assert.deepEqual([b.change.new.type, b.change.new.data], ["REG_DWORD", 5]);
        assert.deepEqual(JSON.parse(jobsFor("registry.set").slice(-1)[0].payload.env.ADG_REG_EXPECT), { exists: false });
        const refusedRec = await put(D, W, { path: V, name: "Name", type: "REG_SZ", data: "x", expected: { exists: false } }); const rb = await refusedRec.json(); assert.equal(refusedRec.status, 409);
        r = await undo(D, W, rb.changeId); assert.equal(r.status, 409); assert.match((await r.json()).message, /Only a change that was made/);
        r = await undo(D2, W, made.id); assert.equal(r.status, 404, "a change id of another device");
        r = await undo(D, reader, made.id); assert.equal(r.status, 403);
        const del2 = (await (await delv(D, W, { path: V, name: "List" })).json()).change;
        await put(D, W, { path: V, name: "List", type: "REG_SZ", data: "recreated" });
        r = await undo(D, W, del2.id); assert.equal(r.status, 409); assert.equal((await r.json()).code, "changed_again"); assert.equal(modelOf(D.id).get(lc(V)).values.get("list").d, "recreated");
    });

    await test("undo a created key (only while empty) and a deleted key (puts the key and its values back, not over a key that exists again)", async () => {
        const D = await newWin(); const W = await writer("w-undo3");
        const k = (await (await mkkey(D, W, { path: "HKLM\\SOFTWARE\\Made1" })).json()).change;
        let r = await undo(D, W, k.id); assert.equal(r.status, 200); assert.equal(modelOf(D.id).has(lc("HKLM\\SOFTWARE\\Made1")), false); assert.equal((await r.json()).change.action, "delete-key");
        const k2 = (await (await mkkey(D, W, { path: "HKLM\\SOFTWARE\\Made2" })).json()).change;
        await put(D, W, { path: "HKLM\\SOFTWARE\\Made2", name: "sneaky", type: "REG_SZ", data: "x", expected: { exists: false } });
        r = await undo(D, W, k2.id); assert.equal(r.status, 409); assert.equal((await r.json()).code, "changed_again"); assert.ok(modelOf(D.id).has(lc("HKLM\\SOFTWARE\\Made2")), "the key with a value is not deleted");
        const dk = (await (await delkey(D, W, { path: "HKLM\\SOFTWARE\\Filled", expectedValueCount: 3 })).json()).change;
        r = await undo(D, W, dk.id); assert.equal(r.status, 200); const b = await r.json(); assert.equal(b.change.action, "create-key"); assert.equal(b.change.valueCount, 3);
        const restored = modelOf(D.id).get(lc("HKLM\\SOFTWARE\\Filled")); assert.ok(restored); assert.deepEqual([...restored.values.values()].map((v) => [v.name, v.type, v.d]), [["One", "REG_SZ", "1"], ["Two", "REG_QWORD", "18446744073709551615"], ["Three", "REG_MULTI_SZ", ["x", "y z"]]]);
        const env = jobsFor("registry.create-key").slice(-1)[0].payload.env; assert.equal(JSON.parse(env.ADG_REG_VALUES).items.length, 3); assert.equal(jobsFor("registry.create-key").slice(-1)[0].payload.scriptText, WR.REGISTRY_WRITE_SCRIPTS.createKey);
        r = await undo(D, W, dk.id); assert.equal(r.status, 409); assert.match((await r.json()).message, /already undone/);
    });

    await test("undoing a deleted key when the key exists again is refused (not merged)", async () => {
        const D = await newWin(); const W = await writer("w-undo4");
        const dk = (await (await delkey(D, W, { path: "HKLM\\SOFTWARE\\Empty", expectedValueCount: 0 })).json()).change;
        assert.equal((await mkkey(D, W, { path: "HKLM\\SOFTWARE\\Empty" })).status, 200);
        const r = await undo(D, W, dk.id); assert.equal(r.status, 409); const b = await r.json(); assert.equal(b.code, "changed_again"); assert.match(b.message, /already exists/);
    });

    console.log("writing: the list of changes");
    await test("GET changes: newest first, with who/when/what, data shown as the reader shows it, canUndo only for the write right, undone marker, path filter, limit; secret-named data is hidden even if a row holds it", async () => {
        const D = await newWin(); const W = await writer("w-list", []);
        const a = (await (await put(D, W, { path: V, name: "Count", type: "REG_DWORD", data: "0x10", expected: { exists: true, type: "REG_DWORD", data: 5 } })).json()).change;
        const b = (await (await put(D, W, { path: V, name: "Name", type: "REG_SZ", data: "second", expected: { exists: true, type: "REG_SZ", data: "old" } })).json()).change;
        const k = (await (await mkkey(D, W, { path: `${V}\\Listed` })).json()).change;
        await undo(D, W, b.id);
        await q(`INSERT INTO device_registry_changes (organization_id, device_id, user_id, user_name, action, hive, path, value_name, old_type, old_data, new_type, new_data, outcome) VALUES ((SELECT organization_id FROM device_registry_changes WHERE id = $2), $1, $3, 'x', 'set', 'HKLM', 'HKLM\\SOFTWARE\\Other', 'MyPassword', 'REG_SZ', '"hunter2-old"', 'REG_SZ', '"hunter2-new"', 'ok')`, [D.id, a.id, W.id]);
        const list = async (t, qs = "") => { const r = await reg(D, `/changes${qs}`, t); assert.equal(r.status, 200, qs); return r.json(); };
        const w = await list(W); assert.equal(w.canWrite, true);
        assert.deepEqual(w.items.map((x) => x.at).slice().sort().reverse(), w.items.map((x) => x.at), "newest first");
        const byId = Object.fromEntries(w.items.map((x) => [x.id, x]));
        assert.equal(byId[a.id].new.data, 16); assert.equal(byId[a.id].new.hex, "0x00000010"); assert.equal(byId[a.id].old.data, 5); assert.equal(byId[a.id].canUndo, true); assert.ok(byId[a.id].user && byId[a.id].userId === W.id);
        assert.ok(byId[b.id].undoneAt); assert.equal(byId[b.id].canUndo, false); assert.ok(byId[b.id].undoneBy);
        assert.equal(byId[k.id].action, "create-key"); assert.equal(byId[k.id].canUndo, true);
        const undoRow = w.items.find((x) => x.undo); assert.equal(undoRow.undoOf, b.id); assert.equal(undoRow.canUndo, false, "an undo cannot be undone");
        const pw = w.items.find((x) => x.valueName === "MyPassword"); assert.equal(pw.old.data, null); assert.equal(pw.old.masked, true); assert.equal(pw.new.data, null);
        assert.ok(!JSON.stringify(w).includes("hunter2"), "secret-named data never leaves the server");
        const rd = await list(reader); assert.equal(rd.canWrite, false); assert.ok(rd.items.every((x) => x.canUndo === false), "a reader sees no undo");
        const f = await list(W, `?path=${enc(V)}`); assert.ok(f.items.length >= 3 && f.items.every((x) => x.path === V || x.path === `${V}\\Listed`), "this key's values and keys made directly in it");
        assert.ok(f.items.some((x) => x.id === k.id) && !f.items.some((x) => x.path === "HKLM\\SOFTWARE\\Other"));
        assert.equal((await list(W, `?path=${enc("hklm\\software\\vendor")}`)).items.length, f.items.length, "path match ignores case");
        assert.equal((await list(W, "?limit=2")).items.length, 2); assert.ok((await list(W, "?limit=abc")).items.length >= 3);
        assert.equal((await reg(D, `/changes?path=${enc("HKLM\\SOFTWARE\\*")}`, W)).status, 400);
        assert.equal((await reg(lin, "/changes", reader)).status, 400);
        assert.equal((await reg(other, "/changes", limited)).status, 404);
    });

    console.log("writing: which devices");
    await test("an offline device is refused (409, record refused, no job); a Linux device and one with no agent are refused; unknown ids are 404", async () => {
        const before = seen.length;
        const W = await writer("w-dev");
        const r = await put(off, W, { path: V, name: "N", type: "REG_SZ", data: "x" }); assert.equal(r.status, 409); const b = await r.json(); assert.match(b.message, /offline/i); assert.equal(b.code, "offline");
        const [rec] = await rows(off); assert.equal(rec.outcome, "refused"); assert.match(rec.error, /offline/i); assert.equal(rec.new_data, null);
        assert.equal((await delv(off, W, { path: V, name: "N" })).status, 409); assert.equal((await mkkey(off, W, { path: `${V}\\X` })).status, 409); assert.equal((await delkey(off, W, { path: `${V}\\Sub` })).status, 409);
        const l = await put(lin, W, { path: V, name: "N", type: "REG_SZ", data: "x" }); assert.equal(l.status, 400); assert.match((await l.json()).message, /only available for Windows/);
        assert.equal((await mkkey(lin, W, { path: `${V}\\X` })).status, 400); assert.equal((await rows(lin)).length, 0);
        assert.equal((await put(none, W, { path: V, name: "N", type: "REG_SZ", data: "x" })).status, 409);
        assert.equal((await put(uuid(), W, { path: V, name: "N", type: "REG_SZ", data: "x" })).status, 404); assert.equal((await put("not-a-uuid", W, { path: V, name: "N", type: "REG_SZ", data: "x" })).status, 404);
        assert.equal(seen.length, before, "no job");
        const ev = await audits(off); assert.ok(ev.length >= 4 && ev.every((e) => e.outcome === "failure"), "the attempts on the offline device are recorded");
        const lv = await audits(lin); assert.ok(lv.length >= 2 && lv.every((e) => e.outcome === "failure"));
    });

    await test("a person limited to some customers gets 404 for another customer's device on every route, with no job and no record; their own customer's device works", async () => {
        const before = seen.length; const id = uuid();
        for (const [method, rest, body] of [["PUT", "/value", { path: V, name: "N", type: "REG_SZ", data: "x" }], ["DELETE", "/value", { path: V, name: "Name" }], ["POST", "/key", { path: `${V}\\X` }], ["DELETE", "/key", { path: `${V}\\Sub` }], ["POST", `/changes/${id}/undo`], ["GET", "/changes"]]) {
            assert.equal((await reg(other, rest, limitedW, method, body)).status, 404, `${method} ${rest}`);
        }
        assert.equal(seen.length, before); assert.equal((await rows(other)).length, 0);
        const D = await newWin(); assert.equal((await put(D, limitedW, { path: V, name: "Name", type: "REG_SZ", data: `ok ${DATAMARK}`, expected: { exists: true, type: "REG_SZ", data: "old" } })).status, 200);
    });

    console.log("writing: a slow device");
    await test("a change on a slow device answers pending with its record; the jobs route finalises the record on the first read (and again, the same); the list settles one that nobody polled; stale and job-less pending records are closed", async () => {
        const D = await newWin(); const W = await writer("w-slow");
        delayKind = "registry.set";
        const first = put(D, W, { path: V, name: "SlowA", type: "REG_SZ", data: `a ${DATAMARK}`, expected: { exists: false } });
        await sleep(1200);
        delayKind = "registry.set";
        const second = put(D, W, { path: V, name: "SlowB", type: "REG_SZ", data: `b ${DATAMARK}`, expected: { exists: false } });
        const [ra, rb] = await Promise.all([first, second]);
        const a = await ra.json(), b = await rb.json();
        assert.equal(ra.status, 200); assert.equal(a.pending, true); assert.ok(a.jobId && a.changeId); assert.equal(b.pending, true);
        const [pend] = (await q(`SELECT outcome, job_id FROM device_registry_changes WHERE id = $1`, [a.changeId])).rows; assert.equal(pend.outcome, "pending"); assert.equal(pend.job_id, a.jobId);
        const listed = await (await reg(D, "/changes", W)).json(); assert.equal(listed.items.find((x) => x.id === a.changeId).outcome, "pending", "still running: still pending");
        assert.equal((await reg(D, `/jobs/${a.jobId}`, noRegistry)).status, 403); assert.equal((await reg(other, `/jobs/${a.jobId}`, limitedW)).status, 404);
        let again = await (await reg(D, `/jobs/${a.jobId}`, W)).json();
        for (let i = 0; i < 30 && again.pending; i++) { await sleep(700); again = await (await reg(D, `/jobs/${a.jobId}`, W)).json(); }
        assert.equal(again.pending, false); assert.equal(again.change.outcome, "ok"); assert.equal(again.change.new.data, `a ${DATAMARK}`); assert.equal(again.changeId, a.changeId);
        assert.equal((await q(`SELECT outcome FROM device_registry_changes WHERE id = $1`, [a.changeId])).rows[0].outcome, "ok", "finalised by the first read");
        const same = await (await reg(D, `/jobs/${a.jobId}`, reader)).json(); assert.equal(same.change.outcome, "ok", "a second read gives the same answer (a reader may read it)");
        assert.equal(modelOf(D.id).get(lc(V)).values.get("slowa").d, `a ${DATAMARK}`);
        // the second one nobody polled: the list settles it from the job's result
        for (let i = 0; i < 40; i++) {
            const l = await (await reg(D, "/changes", W)).json();
            if (l.items.find((x) => x.id === b.changeId).outcome === "ok") break;
            await sleep(700);
        }
        assert.equal((await q(`SELECT outcome FROM device_registry_changes WHERE id = $1`, [b.changeId])).rows[0].outcome, "ok", "settled by the list");
        // stale: a job that does not exist any more, a job-less record that is old, and a fresh job-less one that is left alone
        const org = (await q(`SELECT organization_id FROM device_registry_changes WHERE id = $1`, [a.changeId])).rows[0].organization_id;
        const ins = async (job, age) => (await q(`INSERT INTO device_registry_changes (organization_id, device_id, user_id, action, hive, path, value_name, outcome, job_id, at) VALUES ($1,$2,$3,'set','HKLM',$4,'Z','pending',$5, now() - ($6 || ' seconds')::interval) RETURNING id`, [org, D.id, W.id, V, job, String(age)])).rows[0].id;
        const gone = await ins(uuid(), 30), oldNoJob = await ins(null, 600), freshNoJob = await ins(null, 5);
        await reg(D, "/changes", W);
        const st = Object.fromEntries((await q(`SELECT id, outcome, error FROM device_registry_changes WHERE id = ANY($1::uuid[])`, [[gone, oldNoJob, freshNoJob]])).rows.map((r) => [r.id, r]));
        assert.equal(st[gone].outcome, "failed"); assert.match(st[gone].error, /not found|Job/i);
        assert.equal(st[oldNoJob].outcome, "failed"); assert.match(st[oldNoJob].error, /never reached/);
        assert.equal(st[freshNoJob].outcome, "pending");
        const none2 = await reg(D, `/jobs/${uuid()}`, W); assert.equal(none2.status, 404);
    });

    console.log("writing: rate limit");
    await test("rate limit: 10 change attempts a minute per device (a clear 429, no record, one audit row for the burst), 30 per person across devices; every attempt counts, other devices and people are not affected", async () => {
        const D = await newWin(); const W = await writer("w-rate1"); const W2 = await writer("w-rate1b");
        const before = seen.length;
        const blocked = { path: "HKLM\\SOFTWARE", name: "x", type: "REG_SZ", data: "a" };
        for (let i = 0; i < 10; i++) assert.equal((await put(D, W, blocked)).status, 403, `attempt ${i + 1} is checked (and refused) normally`);
        const r = await put(D, W, blocked); assert.equal(r.status, 429); const b = await r.json();
        assert.match(b.message, /10 registry changes were made on this device in the last minute/); assert.match(b.message, /Wait \d+ seconds? and try again/); assert.equal(b.code, "rate_limited"); assert.ok(b.retryAfterSec >= 1 && b.retryAfterSec <= 60);
        assert.equal((await mkkey(D, W, { path: "HKLM\\SYSTEM" })).status, 429); assert.equal((await delv(D, W2, { path: V, name: "a" })).status, 429, "the device limit is for everyone");
        assert.equal((await undo(D, W, uuid())).status, 429, "undo counts like any change");
        assert.equal((await rows(D)).length, 10, "429 attempts leave no record");
        const D2 = await newWin(); assert.equal((await put(D2, W, blocked)).status, 403, "another device is fine");
        assert.equal((await put(D, reader, blocked)).status, 403, "a person without the right is refused by the guard, not counted");
        assert.equal((await reg(D, "/changes", W)).status, 200, "looking is not limited");
        const ev = await audits(D, "device.registry.%"); const limitedRows = ev.filter((e) => e.details.reason === "rate_limited");
        assert.equal(limitedRows.length, 1, "one audit row for the whole burst"); assert.equal(limitedRows[0].outcome, "failure");
        assert.equal(seen.length, before, "no job");
        // 30 a person: 10 each on three devices, then a fourth refuses
        const U = await writer("w-rate2"); const ds = [await newWin(), await newWin(), await newWin(), await newWin()];
        for (const d of ds.slice(0, 3)) for (let i = 0; i < 10; i++) assert.equal((await mkkey(d, U, { path: "HKLM\\SYSTEM" })).status, 403);
        const u = await mkkey(ds[3], U, { path: "HKLM\\SYSTEM" }); assert.equal(u.status, 429); assert.match((await u.json()).message, /You have made 30 registry changes in the last minute/);
        assert.equal((await mkkey(ds[3], W2, { path: "HKLM\\SYSTEM" })).status, 403, "another person is not limited by it");
    });

    await test("no data anywhere in the audit trail for this whole run; every change attempt has an audit row", async () => {
        await sleep(500);
        assert.equal((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'device.registry.%' AND details::text LIKE $1`, [`%${DATAMARK}%`])).rows[0].n, 0);
        assert.equal((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'device.registry.%' AND (details::text LIKE '%hunter2%' OR details::text LIKE '%default data%' OR details::text LIKE '%y z%')`)).rows[0].n, 0);
        const kinds = (await q(`SELECT DISTINCT action FROM audit_events WHERE action LIKE 'device.registry.%'`)).rows.map((r) => r.action);
        for (const a of ["device.registry.set", "device.registry.delete-value", "device.registry.create-key", "device.registry.delete-key", "device.registry.undo"]) assert.ok(kinds.includes(a), a);
    });

    clearInterval(timer);
    await q(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [made.users]);
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
