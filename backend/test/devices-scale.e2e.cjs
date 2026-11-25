#!/usr/bin/env node
// Device counts and the filtered, sorted, paged device list, with more devices than the old 1000-row browser cap:
// nothing is left out, the numbers match the list, and a person limited to some customers only ever sees theirs.
// Run against a throwaway backend and database only:
//
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../riq_e2e JWT_SECRET=... node test/devices-scale.e2e.cjs
//   (SCALE_DEVICES=1500 by default)
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3951";
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const N = Number(process.env.SCALE_DEVICES || 1500);

if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(new URL(DB_URL).pathname) || !SECRET) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1, JWT_SECRET, and a DATABASE_URL naming an e2e database.");
    process.exit(2);
}

const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`);
    }
}

const call = (path, { token } = {}) => fetch(`${BASE}${path}`, { headers: token ? { cookie: `${COOKIE}=${token}` } : {} });
const json = async (path, opts) => {
    const r = await call(path, opts);
    const text = await r.text();
    assert.equal(r.status, 200, `${path} -> ${r.status} ${text}`);
    return JSON.parse(text);
};

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const stamp = Date.now();
    const tag = `DS${stamp}`;

    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;
    await q(`INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES ('devices.read','devices.read','x','x') ON CONFLICT DO NOTHING`);

    const madeUsers = [];
    const madeRoles = [];
    async function user(label, permissions) {
        const id = uuid();
        madeUsers.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, org, email, label]);
        const role = uuid();
        madeRoles.push(role);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [role, org, `e2e-${label}-${id}`]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role, p]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return { id, token: jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" }) };
    }

    // ---- seed: 3 customers, 2 sites each (+ some devices with no site), N devices in all, with a known mix
    const clients = [];
    for (const n of ["Alpha", "Bravo", "Charlie"]) {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        const sites = [];
        for (const s of ["North", "South"]) sites.push({ name: s, id: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, s])).rows[0].id });
        clients.push({ id, name: `${tag} ${n}`, sites });
    }
    const siteIds = clients.flatMap((c) => c.sites.map((s) => ({ client: c, site: s })));
    const oses = ["windows", "windows", "windows", "linux", "macos", "unknown"]; // 'unknown' has no os fact: falls under other
    const expected = []; // what the seed means, to compare the server against
    const rows = [];
    for (let i = 0; i < N; i++) {
        const where = siteIds[i % siteIds.length];
        const os = oses[i % oses.length];
        const online = i % 3 === 0;
        const hostname = `${tag}-H${String(i).padStart(5, "0")}`;
        const alert = i % 11 === 0;
        rows.push({ id: uuid(), site: where.site.id, hostname, os, online, alert, i });
        expected.push({ hostname, client: where.client.name, clientId: where.client.id, site: where.site.name, siteId: where.site.id, os, online, alert, i });
    }
    // A few with no site at all (and no customer): the list shows them with no customer.
    const loose = [];
    for (let i = 0; i < 4; i++) loose.push({ id: uuid(), hostname: `${tag}-LOOSE${i}`, os: "windows", online: false });
    await q(
        `INSERT INTO devices (id, site_id, hostname) SELECT (x->>'id')::uuid, (x->>'site')::uuid, x->>'hostname' FROM jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify(rows.map((r) => ({ id: r.id, site: r.site, hostname: r.hostname })))]
    );
    await q(`INSERT INTO devices (id, site_id, hostname) SELECT (x->>'id')::uuid, NULL, x->>'hostname' FROM jsonb_array_elements($1::jsonb) x`, [JSON.stringify(loose)]);
    await q(
        `INSERT INTO agents (id, device_id, agent_uuid, hostname, version, last_check_in_at, facts, agent_token, token)
         SELECT gen_random_uuid(), (x->>'id')::uuid, 'u-' || (x->>'hostname'), x->>'hostname', '1.3.33',
                CASE WHEN (x->>'online')::boolean THEN now() - interval '1 minute' ELSE now() - ((1 + (x->>'i')::int % 400) || ' minutes')::interval - interval '10 minutes' END,
                CASE WHEN x->>'os' = 'unknown' THEN '{}'::jsonb ELSE jsonb_build_object('os', x->>'os', 'user', 'u' || ((x->>'i')::int % 7)) END,
                't-' || (x->>'hostname'), 't-' || (x->>'hostname')
           FROM jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify([...rows.map((r) => ({ id: r.id, hostname: r.hostname, online: r.online, os: r.os, i: r.i })), ...loose.map((r, i) => ({ ...r, i: 9000 + i }))])]
    );
    await q(
        `INSERT INTO alerts (id, device_id, kind, dedupe_key, state, severity, title)
         SELECT gen_random_uuid(), (x->>'id')::uuid, 'disk', 'k-' || (x->>'id'), 'OPEN', 'warning', 'Low disk' FROM jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify(rows.filter((r) => r.alert).map((r) => ({ id: r.id })))]
    );
    // One tag on the first 5 devices.
    const tagId = (await q(`INSERT INTO tag_defs (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag}-label`])).rows[0].id;
    for (const r of rows.slice(0, 5)) await q(`INSERT INTO device_tags (device_id, tag_id) VALUES ($1,$2)`, [r.id, tagId]);

    const reader = await user("scalread", ["devices.read"]);
    const limited = await user("scallim", ["devices.read"]);
    const nobody = await user("scalnone", []);
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, clients[1].id]);

    const mine = (e) => expected.filter(e);
    const place = (c, s) => `place=${encodeURIComponent(JSON.stringify(s === undefined ? { c } : { c, s }))}`;
    const allOfMine = encodeURIComponent(tag); // q matching only this test's devices (host name prefix)
    const sum = (list, f) => list.reduce((n, x) => n + (f(x) ? 1 : 0), 0);

    try {
        console.log(`counts (${N} devices seeded)`);
        await test("counts total, online, offline and devices with open alerts come from the database", async () => {
            const c = await json(`/api/devices/counts?q=${allOfMine}`, { token: reader.token });
            const total = N + loose.length;
            assert.equal(c.total, total);
            assert.equal(c.online, sum(expected, (e) => e.online));
            assert.equal(c.offline, total - c.online);
            assert.equal(c.withAlerts, sum(expected, (e) => e.alert));
            assert.equal(c.online + c.offline, c.total);
        });
        await test("counts by operating system add up and split online/offline", async () => {
            const c = await json(`/api/devices/counts?q=${allOfMine}`, { token: reader.token });
            const want = (os) => sum(expected, (e) => e.os === os);
            assert.equal(c.byOs.windows.total, want("windows") + loose.length);
            assert.equal(c.byOs.linux.total, want("linux"));
            assert.equal(c.byOs.macos.total, want("macos"));
            assert.equal(c.byOs.other.total, want("unknown"));
            assert.equal(c.byOs.linux.online, sum(expected, (e) => e.os === "linux" && e.online));
            assert.equal(c.byOs.linux.offline, sum(expected, (e) => e.os === "linux" && !e.online));
            assert.equal(c.byOs.windows.total + c.byOs.linux.total + c.byOs.macos.total + c.byOs.other.total, c.total);
        });
        await test("counts by customer and site, with devices in no customer as one entry", async () => {
            const c = await json(`/api/devices/counts?q=${allOfMine}`, { token: reader.token });
            for (const cl of clients) {
                const got = c.clients.find((x) => x.id === cl.id);
                assert.ok(got, `customer ${cl.name} missing`);
                assert.equal(got.total, sum(expected, (e) => e.clientId === cl.id));
                assert.equal(got.online, sum(expected, (e) => e.clientId === cl.id && e.online));
                assert.equal(got.withAlerts, sum(expected, (e) => e.clientId === cl.id && e.alert));
                for (const s of cl.sites) {
                    const gs = got.sites.find((x) => x.id === s.id);
                    assert.equal(gs.total, sum(expected, (e) => e.siteId === s.id));
                    assert.equal(gs.name, s.name);
                }
            }
            const none = c.clients.find((x) => x.id === null);
            assert.equal(none.total, loose.length);
            assert.equal(none.name, null);
            assert.equal(c.clients.reduce((n, x) => n + x.total, 0), c.total);
        });
        await test("counts follow the filters the list takes (status, os, platform, place, site, tag, search)", async () => {
            const cnt = (qs) => json(`/api/devices/counts?q=${allOfMine}&${qs}`, { token: reader.token });
            assert.equal((await cnt("status=online")).total, sum(expected, (e) => e.online));
            assert.equal((await cnt("os=linux&os=macos")).total, sum(expected, (e) => e.os === "linux" || e.os === "macos"));
            assert.equal((await cnt("platform=other")).total, sum(expected, (e) => e.os !== "windows"));
            assert.equal((await cnt("platform=windows")).total, sum(expected, (e) => e.os === "windows") + loose.length);
            assert.equal((await cnt(place(clients[0].name))).total, sum(expected, (e) => e.clientId === clients[0].id));
            assert.equal((await cnt(place(clients[0].name, "North"))).total, sum(expected, (e) => e.siteId === clients[0].sites[0].id));
            assert.equal((await cnt(`${place(clients[0].name, "North")}&${place(clients[2].name)}`)).total, sum(expected, (e) => e.siteId === clients[0].sites[0].id || e.clientId === clients[2].id));
            assert.equal((await cnt(place("—"))).total, loose.length, "an em dash means no customer");
            assert.equal((await cnt(`siteId=${clients[1].sites[1].id}`)).total, sum(expected, (e) => e.siteId === clients[1].sites[1].id));
            assert.equal((await cnt(`tag=${tagId}`)).total, 5);
            assert.equal((await cnt(`status=offline&os=windows&${place(clients[2].name)}`)).total, sum(expected, (e) => e.os === "windows" && !e.online && e.clientId === clients[2].id));
        });
        await test("counts are not mistaken for a device id", async () => {
            const r = await call(`/api/devices/counts`, { token: reader.token });
            assert.equal(r.status, 200);
            assert.equal(typeof (await r.json()).total, "number");
        });

        console.log("the list, past the old 1000-device cap");
        await test("paging with an offset reaches every device, once each, in order (more than 1000 of them)", async () => {
            const want = N + loose.length;
            assert.ok(want > 1000, "this test is meant to cross the old cap");
            const seen = [];
            let offset = 0;
            let total = null;
            for (;;) {
                const r = await json(`/api/devices?q=${allOfMine}&pageSize=200&offset=${offset}&total=1`, { token: reader.token });
                total = r.total;
                seen.push(...r.items.map((d) => d.hostname));
                if (!r.nextCursor) break;
                offset += 200;
            }
            assert.equal(total, want);
            assert.equal(seen.length, want);
            assert.equal(new Set(seen).size, want, "no device twice");
            assert.deepEqual(seen, [...seen].sort(), "hostname order by default");
        });
        await test("the cursor still works for older callers and `total` is left out unless asked for", async () => {
            const a = await json(`/api/devices?q=${allOfMine}&pageSize=3`, { token: reader.token });
            assert.equal(a.total, undefined);
            const b = await json(`/api/devices?q=${allOfMine}&pageSize=3&cursor=${encodeURIComponent(a.nextCursor)}`, { token: reader.token });
            const all = await json(`/api/devices?q=${allOfMine}&pageSize=6`, { token: reader.token });
            assert.deepEqual([...a.items, ...b.items].map((d) => d.id), all.items.map((d) => d.id));
        });
        await test("sorting on the server: every sortable column, both ways, same order on every page", async () => {
            const keys = { hostname: (d) => d.hostname, status: (d) => d.status, os: (d) => d.os, client: (d) => d.client, site: (d) => d.site, lastSeen: (d) => d.lastSeen, user: (d) => d.user };
            for (const [key, get] of Object.entries(keys)) {
                for (const dir of ["asc", "desc"]) {
                    const got = [];
                    for (let off = 0; off < 600; off += 200) {
                        got.push(...(await json(`/api/devices?q=${allOfMine}&pageSize=200&offset=${off}&sort=${key}&dir=${dir}`, { token: reader.token })).items);
                    }
                    assert.equal(new Set(got.map((d) => d.id)).size, 600, `${key} ${dir}: pages overlap`);
                    const vals = got.map(get).filter((v) => v !== null && v !== undefined);
                    const nulls = got.map(get).findIndex((v) => v === null || v === undefined);
                    if (nulls >= 0) assert.ok(got.slice(nulls).every((d) => get(d) === null || get(d) === undefined), `${key} ${dir}: empty values come last`);
                    // Values must be monotone in the chosen direction (compared the way the database does for dates and ranks; for text, equal prefixes may differ by collation, so compare case-insensitively).
                    const norm = (v) => (typeof v === "string" ? v.toLowerCase() : v);
                    for (let i = 1; i < vals.length; i++) {
                        const a = norm(vals[i - 1]);
                        const b = norm(vals[i]);
                        if (key === "hostname" || key === "client" || key === "site" || key === "user" || key === "os") continue; // collation-dependent: checked below on the first page edges
                        assert.ok(dir === "asc" ? a <= b : a >= b, `${key} ${dir}: ${a} then ${b}`);
                    }
                }
            }
            const asc = (await json(`/api/devices?q=${allOfMine}&pageSize=2&sort=hostname&dir=asc`, { token: reader.token })).items.map((d) => d.hostname);
            const desc = (await json(`/api/devices?q=${allOfMine}&pageSize=2&sort=hostname&dir=desc`, { token: reader.token })).items.map((d) => d.hostname);
            assert.deepEqual(asc, [`${tag}-H00000`, `${tag}-H00001`]);
            assert.deepEqual(desc, [`${tag}-LOOSE3`, `${tag}-LOOSE2`]);
            // Oldest check-in first: the offline devices, longest unheard-from at the top, devices never seen (none here) last.
            const oldest = (await json(`/api/devices?q=${allOfMine}&pageSize=50&sort=lastSeen&dir=asc`, { token: reader.token })).items.map((d) => new Date(d.lastSeen).getTime());
            assert.deepEqual(oldest, [...oldest].sort((x, y) => x - y));
        });
        await test("filters on the server: status, os, platform, customer, site, place, tag and search", async () => {
            const list = async (qs) => {
                const out = [];
                let offset = 0;
                for (;;) {
                    const r = await json(`/api/devices?q=${allOfMine}&${qs}&pageSize=200&offset=${offset}&total=1`, { token: reader.token });
                    out.push(...r.items);
                    if (!r.nextCursor) return { items: out, total: r.total };
                    offset += 200;
                }
            };
            const names = (r) => r.items.map((d) => d.hostname).sort();
            const want = (f) => mine(f).map((e) => e.hostname).sort();
            assert.deepEqual(names(await list("status=online")), want((e) => e.online));
            assert.deepEqual(names(await list("os=linux")), want((e) => e.os === "linux"));
            assert.deepEqual(names(await list(`clientId=${clients[2].id}&status=offline&os=windows`)), want((e) => e.clientId === clients[2].id && !e.online && e.os === "windows"));
            assert.deepEqual(names(await list(`siteId=${clients[0].sites[1].id}`)), want((e) => e.siteId === clients[0].sites[1].id));
            assert.deepEqual(names(await list(place(clients[1].name, "South"))), want((e) => e.siteId === clients[1].sites[1].id));
            assert.deepEqual(names(await list(`${place(clients[0].name, "North")}&${place(clients[1].name)}`)), want((e) => e.siteId === clients[0].sites[0].id || e.clientId === clients[1].id));
            assert.deepEqual(names(await list(place("—"))), loose.map((l) => l.hostname).sort());
            assert.deepEqual(names(await list(`tag=${tagId}`)), rows.slice(0, 5).map((r) => r.hostname).sort());
            const t = await list("platform=other");
            assert.equal(t.total, sum(expected, (e) => e.os !== "windows"));
            assert.ok(t.items.every((d) => !/windows/i.test(d.os)));
            // Search matches the host name, the customer, the site or a tag name.
            const bySearch = async (text) => (await json(`/api/devices?q=${encodeURIComponent(text)}&pageSize=1&total=1`, { token: reader.token })).total;
            assert.equal(await bySearch(`${tag}-H00007`), 1);
            assert.equal(await bySearch(`${clients[0].name}`), sum(expected, (e) => e.clientId === clients[0].id));
            assert.equal(await bySearch(`${tag}-label`), 5);
        });
        await test("several filters together are ANDed, and bad ones are refused", async () => {
            assert.equal((await call(`/api/devices?sort=password`, { token: reader.token })).status, 400);
            assert.equal((await call(`/api/devices/counts?siteId=nope`, { token: reader.token })).status, 400);
            assert.equal((await call(`/api/devices?offset=-1`, { token: reader.token })).status, 400);
            assert.equal((await call(`/api/devices?platform=beos`, { token: reader.token })).status, 400);
            // A place that is not valid JSON is ignored rather than breaking the list.
            assert.equal((await call(`/api/devices?place=not-json&pageSize=1`, { token: reader.token })).status, 200);
        });

        console.log("who may see what");
        await test("a person limited to one customer sees only that customer in the counts and the list", async () => {
            const c = await json(`/api/devices/counts?q=${allOfMine}`, { token: limited.token });
            assert.equal(c.total, sum(expected, (e) => e.clientId === clients[1].id));
            assert.deepEqual(c.clients.map((x) => x.id), [clients[1].id]);
            const l = await json(`/api/devices?q=${allOfMine}&pageSize=200&total=1`, { token: limited.token });
            assert.equal(l.total, c.total);
            assert.ok(l.items.every((d) => d.clientId === clients[1].id));
            // Asking for someone else's customer, site or place gets nothing, not their devices.
            assert.equal((await json(`/api/devices?clientId=${clients[0].id}&total=1`, { token: limited.token })).total, 0);
            assert.equal((await json(`/api/devices?${place(clients[2].name)}&total=1`, { token: limited.token })).total, 0);
            assert.equal((await json(`/api/devices/counts?siteId=${clients[0].sites[0].id}`, { token: limited.token })).total, 0);
            assert.equal((await json(`/api/devices?q=${encodeURIComponent(clients[0].name)}&total=1`, { token: limited.token })).total, 0, "search cannot reach other customers either");
            // The person with no customer limit sees them all.
            assert.equal((await json(`/api/devices/counts?${place(clients[0].name)}`, { token: reader.token })).total, sum(expected, (e) => e.clientId === clients[0].id));
        });
        await test("counts and the list need the devices permission", async () => {
            assert.equal((await call(`/api/devices/counts`, { token: nobody.token })).status, 403);
            assert.equal((await call(`/api/devices?pageSize=1`, { token: nobody.token })).status, 403);
            assert.equal((await call(`/api/devices/counts`)).status, 401);
        });
    } finally {
        await q(`DELETE FROM alerts WHERE device_id IN (SELECT id FROM devices WHERE hostname LIKE $1)`, [`${tag}-%`]);
        await q(`DELETE FROM device_tags WHERE tag_id = $1`, [tagId]);
        await q(`DELETE FROM tag_defs WHERE id = $1`, [tagId]);
        await q(`DELETE FROM agents WHERE hostname LIKE $1`, [`${tag}-%`]);
        await q(`DELETE FROM devices WHERE hostname LIKE $1`, [`${tag}-%`]);
        await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
        await q(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [clients.map((c) => c.id)]);
        await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
        await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
        await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [madeRoles]);
        await q(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [madeRoles]);
        await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]);
        await db.end();
    }

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
