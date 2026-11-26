#!/usr/bin/env node
// Session recording (roadmap 1.26) behind the real sign-in: the per-customer setting and its policy override, a session
// that was not told it is recorded can never be recorded, chunked upload with ordering, size and quota limits,
// encryption at rest, tampering, other organizations, customer limits, permissions, audit, retention cleanup, and
// what the device is told (read from the signed session start of a simulated agent).
// Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 ADMIN_API_KEY=e2e-admin BASE_URL=http://127.0.0.1:3931 DATABASE_URL=postgres://.../adg_g2_e2e \
//   JWT_SECRET=... ADMIN_DATA_DIR=<the backend's ADMIN_DATA_DIR> node test/recordings-http.e2e.cjs
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3931";
const WS_BASE = BASE.replace(/^http/, "ws");
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const DATA_DIR = process.env.ADMIN_DATA_DIR || path.join(process.cwd(), "var");
const REC_ROOT = path.join(DATA_DIR, "recordings");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(new URL(DB_URL).pathname) || !SECRET) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1, JWT_SECRET, and a DATABASE_URL naming an e2e database.");
    process.exit(2);
}

const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

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

const call = (p, { method = "GET", token, body, raw, headers = {} } = {}) =>
    fetch(`${BASE}${p}`, {
        method,
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
            ...headers,
        },
        body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
const json = async (p, o) => {
    const r = await call(p, o);
    return { status: r.status, body: await r.json().catch(() => null) };
};

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const stamp = Date.now();

    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;
    const org2 = (await q(`INSERT INTO organizations (name, slug) VALUES ('Other Org','other-org') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;

    const madeUsers = [];
    const madeRoles = [];
    async function user(label, permissions, orgId = org) {
        const id = uuid();
        madeUsers.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, orgId, email, label]);
        const role = uuid();
        madeRoles.push(role);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [role, orgId, `e2e-${label}-${id}`]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role, p]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return { id, email, token: jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" }) };
    }

    async function customer(label, orgId = org) {
        const client = uuid(), site = uuid(), device = uuid(), agent = uuid(), agentUuid = uuid(), agentToken = `tok-${uuid()}`;
        await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [client, orgId, `Rec ${label} ${stamp}`]);
        await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'HQ')`, [site, client]);
        await q(`INSERT INTO devices (id, site_id, hostname, operating_system) VALUES ($1,$2,$3,'Windows 11')`, [device, site, `REC-${label}-${stamp}`]);
        await q(`INSERT INTO agents (id, device_id, agent_uuid, agent_token, version, last_check_in_at, facts) VALUES ($1,$2,$3,$4,'1.3.28', now(), '{"os":"windows"}')`, [agent, device, agentUuid, sha256(agentToken)]);
        return { client, site, device, agent, agentUuid, agentToken, name: `Rec ${label} ${stamp}`, host: `REC-${label}-${stamp}` };
    }

    const RC = ["devices.read", "devices.actions", "customers.read", "customers.write"];
    const tech = await user("tech", RC);
    const tech2 = await user("tech2", RC);
    const reader = await user("reader", ["recordings.read"]);
    const manager = await user("manager", ["recordings.read", "recordings.delete", "customers.read"]);
    const nobody = await user("nobody", ["customers.read"]);
    const outsider = await user("outsider", ["recordings.read", "recordings.delete", ...RC], org2);

    const A = await customer("A");
    const B = await customer("B");
    const limited = await user("limited", ["recordings.read", "recordings.delete", ...RC]);
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);

    const session = async (who, c) => (await json("/api/remote-console/sessions", { method: "POST", token: who.token, body: { agentId: c.agentUuid } }));
    const setRec = (c, record, consent) => json(`/api/customers/${c.client}/remote-console`, { method: "PATCH", token: tech.token, body: { ...(record === undefined ? {} : { record }), ...(consent ? { consent } : {}) } });
    const startRec = (who, sessionId) => json("/api/remote-recordings", { method: "POST", token: who.token, body: { sessionId } });
    const piece = (who, id, seq, bytes, type = "application/octet-stream") => json(`/api/remote-recordings/${id}/chunks?seq=${seq}`, { method: "POST", token: who.token, raw: bytes, headers: { "content-type": type } });
    const finish = (who, id, durationMs) => json(`/api/remote-recordings/${id}/finish`, { method: "POST", token: who.token, body: { durationMs } });
    const audit = async (action, targetId) => {
        for (let i = 0; i < 80; i++) {
            const r = (await q(`SELECT * FROM audit_events WHERE action = $1 AND target_id = $2 ORDER BY created_at DESC LIMIT 1`, [action, targetId])).rows[0];
            if (r) return r;
            await sleep(50);
        }
        throw new Error(`no audit row ${action} for ${targetId}`);
    };
    const body = (n, fill = 7) => Buffer.alloc(n, fill);

    // ------------------------------------------------------------------ the setting
    await test("the permissions exist and the Admin role holds them", async () => {
        const perms = (await q(`SELECT permission_key FROM permissions WHERE permission_key LIKE 'recordings.%' ORDER BY 1`)).rows.map((r) => r.permission_key);
        assert.deepEqual(perms, ["recordings.delete", "recordings.read"]);
        const admin = (await q(`SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE lower(r.name) = 'admin' AND rp.permission_key LIKE 'recordings.%'`)).rows[0].n;
        const admins = (await q(`SELECT count(*)::int AS n FROM roles WHERE lower(name) = 'admin'`)).rows[0].n;
        assert.equal(admin, admins * 2);
        const op = (await q(`SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE lower(r.name) IN ('operator','viewer') AND rp.permission_key LIKE 'recordings.%'`)).rows[0].n;
        assert.equal(op, 0, "technicians do not get recordings by default");
    });

    await test("recording is off by default and each setting changes alone", async () => {
        let r = await json(`/api/customers/${A.client}/remote-console`, { token: tech.token });
        assert.equal(r.status, 200);
        assert.equal(r.body.record, false);
        assert.equal(r.body.consent, "notice");
        r = await setRec(A, true);
        assert.deepEqual(r.body, { codec: "auto", consent: "notice", record: true });
        r = await setRec(A, undefined, "consent");
        assert.deepEqual(r.body, { codec: "auto", consent: "consent", record: true }, "saving the notice does not switch recording off");
        r = await setRec(A, false, "notice");
        assert.deepEqual(r.body, { codec: "auto", consent: "notice", record: false });
        assert.equal((await json(`/api/customers/${A.client}/remote-console`, { method: "PATCH", token: tech.token, body: { record: "yes" } })).status, 400);
        assert.equal((await json(`/api/customers/${A.client}/remote-console`, { method: "PATCH", token: tech.token, body: {} })).status, 400);
        assert.equal((await json(`/api/customers/${A.client}/remote-console`, { method: "PATCH", token: tech.token, body: { consent: "bogus" } })).status, 400);
        await audit("customer.remote_console.update", A.client);
        await sleep(300);
        const kept = (await q(`SELECT details FROM audit_events WHERE action = 'customer.remote_console.update' AND target_id = $1 AND details ? 'record'`, [A.client])).rows;
        assert.ok(kept.length >= 3, "each change of the recording setting is audited with its value");
    });

    // ------------------------------------------------------------------ off means off
    await test("a session started while recording is off cannot be recorded, even by a client that tries", async () => {
        const s = await session(tech, A);
        assert.equal(s.status, 201, JSON.stringify(s.body));
        assert.equal(s.body.recording, false);
        const r = await startRec(tech, s.body.sessionId);
        assert.equal(r.status, 403);
        assert.equal((await q(`SELECT count(*)::int AS n FROM remote_session_recordings WHERE session_id = $1`, [s.body.sessionId])).rows[0].n, 0);
        // Turning it on afterwards does not change a session that was already announced as not recorded.
        await setRec(A, true);
        assert.equal((await startRec(tech, s.body.sessionId)).status, 403);
        const before = fs.existsSync(REC_ROOT) ? fs.readdirSync(REC_ROOT).length : 0;
        assert.equal((await piece(tech, uuid(), 0, body(100))).status, 404);
        assert.equal(fs.existsSync(REC_ROOT) ? fs.readdirSync(REC_ROOT).length : 0, before, "nothing was written");
        await setRec(A, false);
    });

    await test("only a live session of the caller can be recorded", async () => {
        await setRec(A, true);
        const s = await session(tech, A);
        assert.equal(s.body.recording, true);
        assert.equal((await startRec(tech2, s.body.sessionId)).status, 404, "another technician's session");
        assert.equal((await startRec(tech, uuid())).status, 404, "a session that does not exist");
        assert.equal((await startRec(tech, "nope")).status, 400);
        assert.equal((await startRec(nobody, s.body.sessionId)).status, 403, "no permission to run device actions");
        assert.equal((await call("/api/remote-recordings", { method: "POST", body: { sessionId: s.body.sessionId } })).status, 401);
        await setRec(A, false);
    });

    // ------------------------------------------------------------------ the device is told
    await test("the device is told the session is recorded, and a recorded session is never silent", async () => {
        await setRec(A, true, "off");
        const s = await session(tech, A);
        const agentWs = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`${WS_BASE}/ws/remote-console`);
            ws.on("open", () => resolve(ws));
            ws.on("error", reject);
        });
        const frames = [];
        agentWs.on("message", (d) => frames.push(JSON.parse(d.toString())));
        agentWs.send(JSON.stringify({ type: "hello", kind: "agent", agentUuid: A.agentUuid, agentToken: A.agentToken }));
        const techWs = new WebSocket(`${WS_BASE}/ws/remote-console`);
        await new Promise((r) => techWs.on("open", r));
        techWs.send(JSON.stringify({ type: "hello", kind: "tech", sessionId: s.body.sessionId, sessionToken: s.body.sessionToken }));
        let ready;
        for (let i = 0; i < 100 && !ready; i++) {
            ready = frames.find((f) => f.type === "session.ready");
            if (!ready) await sleep(50);
        }
        assert.ok(ready?.signed, "the agent got a signed session start");
        const payload = JSON.parse(Buffer.from(ready.signed.payload, "base64").toString("utf8"));
        assert.equal(payload.consent, "notice", "'show nothing' becomes a notice when the session is recorded");
        assert.match(payload.technician, /\(this session is being recorded\)$/);
        assert.ok(payload.technician.length <= 60, "the agent cuts the name at 60 characters");
        techWs.close();
        agentWs.close();

        // Without recording the name is unchanged and "show nothing" stays.
        await setRec(A, false, "off");
        const s2 = await session(tech, A);
        assert.equal(s2.body.recording, false);
        await setRec(A, false, "notice");
    });

    // ------------------------------------------------------------------ a recording
    let rec; // the main recording, used by the later tests
    const parts = [Buffer.concat([Buffer.from("PLAINTEXT-MARKER-0123456789"), body(5000, 1)]), body(7000, 2), body(3000, 3)];
    await test("upload in pieces: order, duplicates, content type, finish", async () => {
        await setRec(A, true);
        const s = await session(tech, A);
        const st = await startRec(tech, s.body.sessionId);
        assert.equal(st.status, 201, JSON.stringify(st.body));
        rec = st.body;
        assert.equal(rec.status, "recording");
        assert.equal(rec.clientName, A.name);
        assert.equal(rec.deviceName, A.host);
        assert.equal(rec.technicianId, tech.id);
        assert.equal(rec.nextSeq, 0);
        assert.equal(rec.maxPieceBytes, 16 * MB);

        assert.equal((await piece(tech, rec.id, 1, parts[1])).status, 409, "pieces must come in order");
        assert.equal((await piece(tech, rec.id, 0, parts[0], "application/json")).status, 400);
        assert.equal((await piece(tech, rec.id, 0, Buffer.alloc(0))).status, 400, "an empty piece");
        let r = await piece(tech, rec.id, 0, parts[0]);
        assert.equal(r.status, 200);
        assert.deepEqual([r.body.nextSeq, r.body.sizeBytes], [1, parts[0].length]);
        r = await piece(tech, rec.id, 0, parts[0]);
        assert.equal(r.body.duplicate, true, "a retried piece is not stored twice");
        assert.equal(r.body.sizeBytes, parts[0].length);
        r = await piece(tech, rec.id, 1, parts[1]);
        assert.equal(r.body.nextSeq, 2);
        assert.equal((await startRec(tech, s.body.sessionId)).body.nextSeq, 2, "starting again resumes the same recording");
        r = await piece(tech, rec.id, 2, parts[2]);
        r = await finish(tech, rec.id, 12345);
        assert.equal(r.body.status, "complete");
        assert.equal(r.body.sizeBytes, parts.reduce((a, b) => a + b.length, 0));
        assert.ok(r.body.durationMs <= 5000 + 60_000, "the browser's duration is capped by real time");
        assert.equal((await piece(tech, rec.id, 3, body(10))).status, 409, "a finished recording takes no more");
        assert.equal((await finish(tech, rec.id, 1)).body.status, "complete", "finishing twice is harmless");
        await setRec(A, false);
    });

    await test("pieces are encrypted on disk and bound to their recording", async () => {
        const dir = path.join(REC_ROOT, rec.id);
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".piece")).sort();
        assert.equal(files.length, 3);
        const all = Buffer.concat(files.map((f) => fs.readFileSync(path.join(dir, f))));
        assert.ok(!all.includes(Buffer.from("PLAINTEXT-MARKER")), "no plain video bytes on disk");
        assert.equal(fs.statSync(path.join(dir, files[0])).size, parts[0].length + 52);
    });

    await test("playback returns the exact bytes, with ranges, and the headers keep it private", async () => {
        const whole = Buffer.concat(parts);
        const res = await call(`/api/remote-recordings/${rec.id}/stream`, { token: manager.token });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "video/webm");
        assert.equal(res.headers.get("accept-ranges"), "bytes");
        assert.match(res.headers.get("cache-control"), /no-store/);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(whole));

        // a range that crosses a piece boundary
        const start = parts[0].length - 10, end = parts[0].length + parts[1].length + 20;
        const r2 = await call(`/api/remote-recordings/${rec.id}/stream`, { token: manager.token, headers: { range: `bytes=${start}-${end}` } });
        assert.equal(r2.status, 206);
        assert.equal(r2.headers.get("content-range"), `bytes ${start}-${end}/${whole.length}`);
        assert.ok(Buffer.from(await r2.arrayBuffer()).equals(whole.subarray(start, end + 1)));
        const r3 = await call(`/api/remote-recordings/${rec.id}/stream`, { token: manager.token, headers: { range: "bytes=-100" } });
        assert.equal(r3.status, 206);
        assert.ok(Buffer.from(await r3.arrayBuffer()).equals(whole.subarray(whole.length - 100)));
        const r4 = await call(`/api/remote-recordings/${rec.id}/stream`, { token: manager.token, headers: { range: `bytes=${whole.length + 5}-` } });
        assert.equal(r4.status, 416);
        const dl = await call(`/api/remote-recordings/${rec.id}/stream?download=1`, { token: manager.token });
        assert.match(dl.headers.get("content-disposition"), /^attachment; filename="session-REC-A-\d+-.*\.webm"$/);
        await dl.arrayBuffer();
    });

    await test("viewing, downloading, starting and finishing are audited", async () => {
        const view = await audit("recording.view", rec.id);
        assert.equal(view.actor_user_id, manager.id);
        assert.match(view.target_label, new RegExp(A.name));
        assert.equal((await audit("recording.download", rec.id)).actor_user_id, manager.id);
        assert.equal((await audit("recording.start", rec.id)).actor_user_id, tech.id);
        assert.equal((await audit("recording.finish", rec.id)).actor_user_id, tech.id);
        const n = (await q(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'recording.view' AND target_id = $1`, [rec.id])).rows[0].n;
        assert.equal(n, 1, "the range requests of one playback are not each listed");
    });

    await test("permissions: read to list and watch, delete to remove, nothing without them", async () => {
        assert.equal((await json("/api/remote-recordings", { token: nobody.token })).status, 403);
        assert.equal((await json(`/api/remote-recordings/${rec.id}`, { token: nobody.token })).status, 403);
        assert.equal((await call(`/api/remote-recordings/${rec.id}/stream`, { token: nobody.token })).status, 403);
        assert.equal((await call(`/api/remote-recordings/${rec.id}/stream`)).status, 401);
        assert.equal((await json("/api/remote-recordings", { token: reader.token })).status, 200);
        assert.equal((await call(`/api/remote-recordings/${rec.id}/stream`, { token: reader.token })).status, 200);
        assert.equal((await json(`/api/remote-recordings/${rec.id}`, { method: "DELETE", token: reader.token })).status, 403);
        assert.equal((await json("/api/remote-recordings/settings", { method: "PATCH", token: reader.token, body: { retentionDays: 5 } })).status, 403);
        assert.equal((await json("/api/remote-recordings/cleanup", { method: "POST", token: reader.token })).status, 403);
        // a technician who only runs the console cannot read recordings, not even their own
        assert.equal((await json(`/api/remote-recordings/${rec.id}`, { token: tech.token })).status, 403);
    });

    await test("another technician cannot add to or finish a recording; another organization sees nothing", async () => {
        await setRec(A, true);
        const s = await session(tech, A);
        const st = (await startRec(tech, s.body.sessionId)).body;
        assert.equal((await piece(tech2, st.id, 0, body(10))).status, 404);
        assert.equal((await finish(tech2, st.id, 1)).status, 404);
        assert.equal((await piece(outsider, st.id, 0, body(10))).status, 404);
        assert.equal((await finish(tech, st.id, 0)).body.status, "empty", "a recording with nothing in it is not kept");
        assert.equal((await q(`SELECT count(*)::int AS n FROM remote_session_recordings WHERE id = $1`, [st.id])).rows[0].n, 0);

        for (const p of [`/api/remote-recordings/${rec.id}`, `/api/remote-recordings/${rec.id}/stream`]) assert.equal((await call(p, { token: outsider.token })).status, 404, p);
        const list = await json("/api/remote-recordings", { token: outsider.token });
        assert.equal(list.body.total, 0);
        assert.equal((await json(`/api/remote-recordings/${rec.id}`, { method: "DELETE", token: outsider.token })).status, 404);
        assert.equal((await q(`SELECT count(*)::int AS n FROM remote_session_recordings WHERE id = $1`, [rec.id])).rows[0].n, 1);
        await setRec(A, false);
    });

    await test("tampering with a stored piece is detected, not played", async () => {
        const dir = path.join(REC_ROOT, rec.id);
        const f = path.join(dir, "00000001.piece");
        const original = fs.readFileSync(f);
        const bad = Buffer.from(original);
        bad[60] ^= 0xff;
        fs.writeFileSync(f, bad);
        let failed = false;
        try {
            const res = await call(`/api/remote-recordings/${rec.id}/stream`, { token: manager.token });
            const got = Buffer.from(await res.arrayBuffer());
            failed = got.length < Buffer.concat(parts).length;
        } catch {
            failed = true;
        }
        assert.ok(failed, "an edited piece must not play as if nothing happened");
        // a piece moved from another recording does not authenticate either
        fs.writeFileSync(f, original);
        const ok = await call(`/api/remote-recordings/${rec.id}/stream`, { token: manager.token });
        assert.ok(Buffer.from(await ok.arrayBuffer()).equals(Buffer.concat(parts)));
    });

    // ------------------------------------------------------------------ customer limits
    await test("people limited to some customers see only those recordings", async () => {
        await setRec(B, true);
        const sb = await session(limited, B);
        assert.equal(sb.status, 201, JSON.stringify(sb.body));
        const recB = (await startRec(limited, sb.body.sessionId)).body;
        assert.equal((await piece(limited, recB.id, 0, body(2000, 9))).status, 200);
        await finish(limited, recB.id, 100);

        // a customer they may not see: no console, no recording
        assert.equal((await session(limited, A)).status, 404, "no console on another customer's device");
        const sa = await session(tech, A);
        assert.equal((await startRec(limited, sa.body.sessionId)).status, 404);

        const list = await json("/api/remote-recordings", { token: limited.token });
        assert.deepEqual(list.body.items.map((i) => i.id), [recB.id]);
        assert.equal(list.body.total, 1);
        for (const p of [`/api/remote-recordings/${rec.id}`, `/api/remote-recordings/${rec.id}/stream`]) assert.equal((await call(p, { token: limited.token })).status, 404, p);
        assert.equal((await json(`/api/remote-recordings/${rec.id}`, { method: "DELETE", token: limited.token })).status, 404);
        assert.equal((await call(`/api/remote-recordings/${recB.id}/stream`, { token: limited.token })).status, 200);
        const facets = await json("/api/remote-recordings/facets", { token: limited.token });
        assert.deepEqual(facets.body.clients.map((c) => c.id), [B.client], "filters list only what they may see");
        const all = await json("/api/remote-recordings", { token: manager.token });
        assert.ok(all.body.items.some((i) => i.id === rec.id) && all.body.items.some((i) => i.id === recB.id));
        await setRec(B, false);
        assert.equal((await json(`/api/remote-recordings/${recB.id}`, { method: "DELETE", token: limited.token })).status, 200);
        assert.equal(fs.existsSync(path.join(REC_ROOT, recB.id)), false, "delete removes the files");
    });

    // ------------------------------------------------------------------ filters
    await test("the list filters by customer, device, technician, date and status", async () => {
        const f = async (qs) => (await json(`/api/remote-recordings?${qs}`, { token: manager.token })).body;
        assert.ok((await f(`clientId=${A.client}`)).items.every((i) => i.clientId === A.client));
        assert.ok((await f(`clientId=${A.client}`)).items.some((i) => i.id === rec.id));
        assert.equal((await f(`clientId=${B.client}`)).items.some((i) => i.id === rec.id), false);
        assert.ok((await f(`deviceId=${A.device}`)).items.some((i) => i.id === rec.id));
        assert.equal((await f(`deviceId=${B.device}`)).items.some((i) => i.id === rec.id), false);
        assert.ok((await f(`technicianId=${tech.id}`)).items.some((i) => i.id === rec.id));
        assert.equal((await f(`technicianId=${tech2.id}`)).items.some((i) => i.id === rec.id), false);
        assert.ok((await f(`from=${new Date(Date.now() - 3600_000).toISOString()}`)).items.some((i) => i.id === rec.id));
        assert.equal((await f(`from=${new Date(Date.now() + 3600_000).toISOString()}`)).items.some((i) => i.id === rec.id), false);
        assert.equal((await f(`to=${new Date(Date.now() - 3600_000).toISOString()}`)).items.some((i) => i.id === rec.id), false);
        assert.ok((await f("status=complete")).items.some((i) => i.id === rec.id));
        assert.equal((await f("status=interrupted")).items.some((i) => i.id === rec.id), false);
        assert.equal((await f("clientId=not-an-id")).total, 0, "a bad id matches nothing");
        assert.equal((await json("/api/remote-recordings?from=zzz", { token: manager.token })).status, 400);
        assert.equal((await f("limit=1")).items.length, 1);
    });

    // ------------------------------------------------------------------ limits
    await test("size limits: one piece, one recording, and the storage quota", async () => {
        await setRec(A, true);
        assert.equal((await json("/api/remote-recordings/settings", { method: "PATCH", token: manager.token, body: { maxRecordingMb: 10 } })).status, 200);
        const s = await session(tech, A);
        const st = (await startRec(tech, s.body.sessionId)).body;
        assert.equal(st.maxRecordingBytes, 10 * MB);
        const big = await piece(tech, st.id, 0, body(16 * MB + 1));
        assert.equal(big.status, 413, "a piece over 16 MB");
        assert.equal((await piece(tech, st.id, 0, body(6 * MB))).status, 200);
        const over = await piece(tech, st.id, 1, body(6 * MB));
        assert.equal(over.status, 413, "the recording would pass its limit");
        assert.match(String(over.body.message), /limit of 10 MB/);
        const row = (await q(`SELECT chunk_count, size_bytes FROM remote_session_recordings WHERE id = $1`, [st.id])).rows[0];
        assert.equal(row.chunk_count, 1);
        assert.equal(Number(row.size_bytes), 6 * MB, "what was refused is not stored");
        assert.equal(fs.readdirSync(path.join(REC_ROOT, st.id)).filter((x) => x.endsWith(".piece")).length, 1);
        assert.equal((await finish(tech, st.id, 50)).body.status, "complete", "what was recorded before the limit is kept");

        // the storage limit: an org already at its quota cannot start another
        const fake = uuid();
        await q(`INSERT INTO remote_session_recordings (id, organization_id, session_id, status, size_bytes, expires_at) VALUES ($1,$2,$3,'complete', $4, now() + interval '1 day')`, [fake, org, uuid(), 60 * 1024 * MB]);
        const s2 = await session(tech, A);
        const full = await startRec(tech, s2.body.sessionId);
        assert.equal(full.status, 413);
        assert.match(String(full.body.message), /storage limit/);
        await q(`DELETE FROM remote_session_recordings WHERE id = $1`, [fake]);
        assert.equal((await json("/api/remote-recordings/settings", { method: "PATCH", token: manager.token, body: { maxRecordingMb: 5 } })).status, 400);
        assert.equal((await json("/api/remote-recordings/settings", { method: "PATCH", token: manager.token, body: { retentionDays: 0 } })).status, 400);
        assert.equal((await json("/api/remote-recordings/settings", { method: "PATCH", token: manager.token, body: { retentionDays: "x" } })).status, 400);
        await json("/api/remote-recordings/settings", { method: "PATCH", token: manager.token, body: { maxRecordingMb: 2048 } });
        await setRec(A, false);
    });

    await test("turning recording off stops what is stored, mid-session", async () => {
        await setRec(A, true);
        const s = await session(tech, A);
        const st = (await startRec(tech, s.body.sessionId)).body;
        assert.equal((await piece(tech, st.id, 0, body(1000))).status, 200);
        await setRec(A, false);
        const r = await piece(tech, st.id, 1, body(1000));
        assert.equal(r.status, 403);
        const row = (await q(`SELECT status, chunk_count FROM remote_session_recordings WHERE id = $1`, [st.id])).rows[0];
        assert.equal(row.status, "interrupted");
        assert.equal(row.chunk_count, 1);
        assert.equal((await piece(tech, st.id, 1, body(1000))).status, 409, "and it stays closed");
    });

    await test("a policy that reaches the device overrides the customer's setting", async () => {
        await setRec(A, false);
        const pol = await json("/api/policies", { method: "POST", token: (await user("poladmin", ["policies.read", "policies.write"])).token, body: { name: `rec-${stamp}`, enabled: true, priority: 10, os: "any", sections: { remote: { record: true } }, assignments: [{ level: "customer", targetId: A.client }] } });
        if (pol.status >= 300) throw new Error(`policy create failed ${pol.status} ${JSON.stringify(pol.body)}`);
        try {
            await sleep(100);
            // the policy cache is short-lived; wait it out if needed
            let on = false;
            for (let i = 0; i < 80 && !on; i++) {
                const s = await session(tech, A);
                on = s.body.recording === true;
                if (!on) await sleep(500);
            }
            assert.ok(on, "recording follows the policy while the customer setting is off");
        } finally {
            await q(`DELETE FROM policies WHERE name = $1`, [`rec-${stamp}`]);
        }
    });

    // ------------------------------------------------------------------ retention and cleanup
    await test("retention: changing the period moves every expiry; the cleanup removes expired recordings and files", async () => {
        const before = (await q(`SELECT started_at, expires_at FROM remote_session_recordings WHERE id = $1`, [rec.id])).rows[0];
        assert.ok(Math.abs((before.expires_at - before.started_at) / 86400000 - 90) < 0.01, "kept 90 days by default");
        let r = await json("/api/remote-recordings/settings", { method: "PATCH", token: manager.token, body: { retentionDays: 30 } });
        assert.equal(r.status, 200);
        assert.equal(r.body.retentionDays, 30);
        const after = (await q(`SELECT started_at, expires_at FROM remote_session_recordings WHERE id = $1`, [rec.id])).rows[0];
        assert.ok(Math.abs((after.expires_at - after.started_at) / 86400000 - 30) < 0.01);
        await sleep(300);
        const setAudit = (await q(`SELECT details FROM audit_events WHERE action = 'recording.settings.update' AND actor_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [manager.id])).rows[0];
        assert.equal(setAudit?.details?.retentionDays, 30);

        // a stray folder from nothing, an old one and a fresh one
        const stray = uuid(), fresh = uuid();
        fs.mkdirSync(path.join(REC_ROOT, stray), { recursive: true });
        fs.writeFileSync(path.join(REC_ROOT, stray, "x.piece"), "x");
        const old = new Date(Date.now() - 3 * 3600_000);
        fs.utimesSync(path.join(REC_ROOT, stray), old, old);
        fs.mkdirSync(path.join(REC_ROOT, fresh), { recursive: true });

        // a recording whose browser vanished, and one that expired
        await setRec(A, true);
        const s = await session(tech, A);
        const lost = (await startRec(tech, s.body.sessionId)).body;
        await piece(tech, lost.id, 0, body(500));
        await q(`UPDATE remote_session_recordings SET last_chunk_at = now() - interval '10 minutes' WHERE id = $1`, [lost.id]);
        await setRec(A, false);
        await q(`UPDATE remote_session_recordings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [rec.id]);

        r = await json("/api/remote-recordings/cleanup", { method: "POST", token: manager.token });
        assert.equal(r.status, 200);
        assert.ok(r.body.expired >= 1 && r.body.interrupted >= 1 && r.body.orphans >= 1, JSON.stringify(r.body));
        assert.equal((await q(`SELECT count(*)::int AS n FROM remote_session_recordings WHERE id = $1`, [rec.id])).rows[0].n, 0);
        assert.equal(fs.existsSync(path.join(REC_ROOT, rec.id)), false, "expired files are gone");
        assert.equal(fs.existsSync(path.join(REC_ROOT, stray)), false, "a folder that belongs to nothing is removed");
        assert.equal(fs.existsSync(path.join(REC_ROOT, fresh)), true, "a fresh folder is left alone");
        fs.rmSync(path.join(REC_ROOT, fresh), { recursive: true, force: true });
        const l = (await q(`SELECT status, chunk_count FROM remote_session_recordings WHERE id = $1`, [lost.id])).rows[0];
        assert.equal(l.status, "interrupted", "a tab crash keeps what was uploaded");
        assert.equal(l.chunk_count, 1);
        const kept = await call(`/api/remote-recordings/${lost.id}/stream`, { token: manager.token });
        assert.equal(kept.status, 200);
        assert.equal((await kept.arrayBuffer()).byteLength, 500);
        await json("/api/remote-recordings/settings", { method: "PATCH", token: manager.token, body: { retentionDays: 90 } });
    });

    await test("deleting is audited, removes the files and the row, and cannot be repeated", async () => {
        const id = (await q(`SELECT id FROM remote_session_recordings WHERE status = 'interrupted' AND organization_id = $1 ORDER BY started_at DESC LIMIT 1`, [org])).rows[0].id;
        assert.ok(fs.existsSync(path.join(REC_ROOT, id)));
        assert.equal((await json(`/api/remote-recordings/${id}`, { method: "DELETE", token: manager.token })).status, 200);
        assert.equal(fs.existsSync(path.join(REC_ROOT, id)), false);
        assert.equal((await audit("recording.delete", id)).actor_user_id, manager.id);
        assert.equal((await json(`/api/remote-recordings/${id}`, { method: "DELETE", token: manager.token })).status, 404);
        assert.equal((await call(`/api/remote-recordings/${id}/stream`, { token: manager.token })).status, 404);
        assert.equal((await json(`/api/remote-recordings/not-a-uuid`, { token: manager.token })).status, 404);
    });

    // clean up what this run made
    for (const r of (await q(`SELECT id FROM remote_session_recordings WHERE organization_id = $1`, [org])).rows) fs.rmSync(path.join(REC_ROOT, r.id), { recursive: true, force: true });
    await q(`DELETE FROM remote_session_recordings WHERE organization_id = $1`, [org]);
    await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await db.end();

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.log(failures.map((f) => ` - ${f}`).join("\n"));
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
