#!/usr/bin/env node
// Staged agent rollout (roadmap 10.10) through the real HTTP API: rights (agents.release.manage), ring changes audited and logged,
// the bulk ring change with per-device results and the customer limit, the update manifests and downloads that differ per ring
// through the real agent update route with fake agents, the health gate, promote (force + reason, changed-since refusal, files on
// disk), withdraw. The server must run with AGENT_PKG_DIR set to a TEMP folder this test also gets (it writes packages into it).
//
//   RIQ_E2E_ALLOW=1 AGENT_PKG_DIR=<temp> BASE_URL=http://127.0.0.1:3961 DATABASE_URL=postgres://.../riq_ring_e2e JWT_SECRET=... node test/agent-releases-http.e2e.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { assert, call, json, runner, setup, uuid, sha256, BASE } = require("./groupc-helpers.cjs");

const PKG = process.env.AGENT_PKG_DIR;
if (!PKG || !/(tmp|temp)/i.test(PKG)) { console.error("Set AGENT_PKG_DIR to a temp folder (the same one the server runs with)."); process.exit(2); }
const FILES = { windows: "remoteiq-agent-windows.zip", linux: "remoteiq-agent-linux-x64.tar.gz" };
const slotDir = (slot, os) => (slot === "stable" ? path.join(PKG, os) : path.join(PKG, slot, os));
const pkgPath = (slot, os) => path.join(slotDir(slot, os), FILES[os]);
const verPath = (slot, os) => path.join(slotDir(slot, os), "version.json");

/** kind: ok | badsha | nover */
function putSlot(slot, os, version, kind = "ok") {
    fs.mkdirSync(slotDir(slot, os), { recursive: true });
    const bytes = Buffer.from(`${os} ${slot} ${version} ${crypto.randomUUID()}`);
    fs.writeFileSync(pkgPath(slot, os), bytes);
    if (kind === "ok") fs.writeFileSync(verPath(slot, os), JSON.stringify({ version, sha256: sha256(bytes) }));
    else if (kind === "badsha") fs.writeFileSync(verPath(slot, os), JSON.stringify({ version, sha256: sha256("nope") }));
    else fs.rmSync(verPath(slot, os), { force: true });
    return { bytes, sha: sha256(bytes) };
}
const clearSlot = (slot, os) => { fs.rmSync(pkgPath(slot, os), { force: true }); fs.rmSync(verPath(slot, os), { force: true }); };
const diskSha = (p) => (fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null);
const diskVersion = (slot, os) => { try { return JSON.parse(fs.readFileSync(verPath(slot, os), "utf8")).version; } catch { return null; } };

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `RG${Date.now()}`;
    const devIds = [];

    const MGR = ["settings.read", "agents.release.manage", "devices.read", "devices.write", "customers.read", "customers.write"];
    const mgr = await staffUser("rg-mgr", MGR);
    const reader = await staffUser("rg-reader", ["settings.read", "devices.read", "customers.read"]);
    const noDevWrite = await staffUser("rg-nodw", ["settings.read", "agents.release.manage", "devices.read"]);
    const limited = await staffUser("rg-limited", MGR);

    // Owner and Admin are the built-in roles (created by the server's role sync); users hold them by role.
    const builtIn = async (name, label) => {
        const role = (await q(`SELECT id FROM roles WHERE lower(name) = $1 AND (organization_id = $2 OR scope = 'system') LIMIT 1`, [name, org])).rows[0];
        assert.ok(role, `built-in role ${name} exists (start the server first)`);
        const id = uuid(); made.users.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, org, email, label]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role.id]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        const jwt = require("jsonwebtoken");
        return { id, email, token: jwt.sign({ sub: id, email, jti }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
    };
    const owner = await builtIn("owner", "rg-owner");
    const admin = await builtIn("admin", "rg-admin");

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id;
        return { id, site };
    };
    const A = await mkClient("Alpha");
    const B = await mkClient("Bravo");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);

    // A fake agent: a device, an agent row, a token. minutes = since its last check-in.
    const mk = async (site, host, { os = "windows", version = "1.3.5", minutes = 1, ring = null } = {}) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system, update_ring) VALUES ($1,$2,$3,$4) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11" : "Ubuntu 24.04", ring])).rows[0].id;
        devIds.push(id);
        const token = `tok-${uuid()}`;
        const agentId = uuid();
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts, agent_token) VALUES ($1,$2,$3,$4, now() - ($5 || ' minutes')::interval, $6, $7)`, [agentId, id, uuid(), version, String(minutes), JSON.stringify({ os, arch: "x64" }), sha256(token)]);
        return { id, agentId, token, os };
    };
    const setAgent = (d, version, { checkMin, changedMin }) => q(`UPDATE agents SET version=$2, last_check_in_at = now() - ($3 || ' minutes')::interval, version_changed_at = now() - ($4 || ' minutes')::interval WHERE id=$1`, [d.agentId, version, String(checkMin), String(changedMin)]);
    const bearer = (d) => ({ authorization: `Bearer ${d.token}` });
    const check = (d, version, os) => call(`/api/agent/updates/check?os=${os ?? d.os}&arch=x64&version=${version}`, { headers: bearer(d) });
    const manifest = async (d, version, os) => { const r = await check(d, version, os); return r.status === 204 ? null : (assert.equal(r.status, 200), r.json()); };
    const download = (d, os) => call(`/api/agent/updates/download/${os ?? d.os}`, { headers: bearer(d) });
    const ringApi = (t, id, ring) => call(`/api/admin/agent-releases/devices/${id}/ring`, { method: "PATCH", token: t.token, body: { ring } });
    const status = (t) => json("/api/admin/agent-releases", { token: t.token });
    const sys = (st, os) => st.systems.find((s) => s.os === os);
    const waitAudit = async (action, where = "true", params = []) => {
        for (let i = 0; i < 40; i++) {
            const r = (await q(`SELECT * FROM audit_events WHERE action = $1 AND ${where} ORDER BY created_at DESC LIMIT 1`, [action, ...params])).rows[0];
            if (r) return r;
            await new Promise((res) => setTimeout(res, 100));
        }
        return null;
    };

    // devices
    const pilotW = await mk(A.site, "pilot-w", { ring: "pilot" });
    const stableW = await mk(A.site, "stable-w");            // no ring set, customer default stable
    const explicitStableW = await mk(A.site, "xstable-w", { ring: "stable" });
    const pilotL = await mk(A.site, "pilot-l", { os: "linux", ring: "pilot" });
    const stableL = await mk(A.site, "stable-l", { os: "linux" });
    const bDev = await mk(B.site, "b1");
    const bDev2 = await mk(B.site, "b2");

    // packages: stable 1.3.10 and candidate 1.3.11 for both systems
    const sW = putSlot("stable", "windows", "1.3.10"); const cW = putSlot("candidate", "windows", "1.3.11");
    const sL = putSlot("stable", "linux", "1.3.10"); const cL = putSlot("candidate", "linux", "1.3.11");

    console.log("rights");
    await test("agents.release.manage: Admin without it and a reader are refused everywhere; no token is refused; Owner and an explicit grant are let in", async () => {
        const body = { os: "windows", candidateVersion: "1.3.11" };
        for (const t of [admin, reader]) {
            assert.equal((await call("/api/admin/agent-releases/promote", { method: "POST", token: t.token, body })).status, 403, `promote ${t.email}`);
            assert.equal((await call("/api/admin/agent-releases/withdraw", { method: "POST", token: t.token, body })).status, 403, "withdraw");
            assert.equal((await ringApi(t, pilotW.id, "pilot")).status, 403, "device ring");
            assert.equal((await call(`/api/admin/agent-releases/customers/${A.id}/ring`, { method: "PATCH", token: t.token, body: { ring: "pilot" } })).status, 403, "customer ring");
            assert.equal((await call("/api/bulk/devices/set-ring", { method: "POST", token: t.token, body: { deviceIds: [pilotW.id], ring: "pilot" } })).status, 403, "bulk ring");
        }
        assert.ok([401, 403].includes((await call("/api/admin/agent-releases/promote", { method: "POST", body })).status));
        assert.equal((await ringApi(noDevWrite, pilotW.id, "pilot")).status, 403, "needs devices.write too");
        // nothing changed on disk or in the DB
        assert.equal(diskSha(pkgPath("stable", "windows")), sW.sha); assert.equal(diskSha(pkgPath("candidate", "windows")), cW.sha);
        const adminStatus = await status(admin);
        assert.ok(adminStatus.systems, "Admin may READ the status (settings.read)"); assert.equal(adminStatus.canManage, false);
        assert.equal((await status(reader)).canManage, false);
        assert.equal((await status(mgr)).canManage, true);
        assert.equal((await status(owner)).canManage, true, "Owner holds it by rule");
        assert.equal((await ringApi(owner, pilotW.id, "pilot")).status, 200);
    });

    console.log("status");
    await test("status: stable / candidate / previous per system with versions, sha, size and date; kill switch state; rings", async () => {
        const st = await status(mgr);
        assert.equal(st.updatesDisabledByServer, false); assert.equal(typeof st.autoUpdate, "boolean");
        const w = sys(st, "windows");
        assert.equal(w.stable.version, "1.3.10"); assert.equal(w.stable.sha256, sW.sha); assert.equal(w.stable.sizeBytes, sW.bytes.length); assert.ok(w.stable.modifiedAt);
        assert.equal(w.candidate.state, "valid"); assert.equal(w.candidate.version, "1.3.11"); assert.equal(w.candidate.sha256, cW.sha);
        assert.equal(w.previous.state, "absent"); assert.equal(w.candidateNotNewer, false);
        assert.equal(sys(st, "linux").candidate.version, "1.3.11");
        assert.ok(st.rings.pilot >= 2 && st.rings.stable >= 3, JSON.stringify(st.rings));
        const rc = w.ringCounts.find((r) => r.version === "1.3.5");
        assert.ok(rc && rc.pilot >= 1 && rc.stable >= 2, JSON.stringify(w.ringCounts));
    });

    await test("status: a candidate that is not newer than stable is flagged and ignored; a corrupt one is reported as a problem", async () => {
        const keep = putSlot("candidate", "windows", "1.3.10");
        let st = await status(mgr);
        assert.equal(sys(st, "windows").candidateNotNewer, true);
        assert.equal((await manifest(pilotW, "1.3.5")).version, "1.3.10", "pilot is offered stable, the equal candidate is ignored");
        putSlot("candidate", "windows", "1.3.9");
        assert.equal(sys(await status(mgr), "windows").candidateNotNewer, true, "older candidate flagged");
        assert.equal((await manifest(pilotW, "1.3.5")).version, "1.3.10");
        putSlot("candidate", "windows", "1.3.11", "badsha");
        st = await status(mgr);
        assert.equal(sys(st, "windows").candidate.state, "problem"); assert.ok(sys(st, "windows").candidate.problem);
        assert.equal((await manifest(pilotW, "1.3.5")).version, "1.3.10", "a corrupt candidate is never offered");
        putSlot("candidate", "windows", "1.3.11", "nover");
        assert.equal(sys(await status(mgr), "windows").candidate.state, "problem", "half written");
        assert.equal((await manifest(pilotW, "1.3.5")).version, "1.3.10");
        clearSlot("candidate", "windows");
        assert.equal(sys(await status(mgr), "windows").candidate.state, "absent");
        assert.equal((await manifest(pilotW, "1.3.5")).version, "1.3.10", "no candidate: exactly like today");
        Object.assign(cW, putSlot("candidate", "windows", "1.3.11"));
        void keep;
    });

    console.log("manifests per ring");
    await test("a pilot device is offered the candidate, everyone else the stable build, through the real agent route (both systems)", async () => {
        const mp = await manifest(pilotW, "1.3.5"); const ms = await manifest(stableW, "1.3.5"); const mx = await manifest(explicitStableW, "1.3.5");
        assert.equal(mp.version, "1.3.11"); assert.equal(mp.sha256, cW.sha); assert.equal(mp.url, "/api/agent/updates/download/windows"); assert.equal(mp.sizeBytes, cW.bytes.length);
        assert.equal(ms.version, "1.3.10"); assert.equal(ms.sha256, sW.sha); assert.equal(ms.url, "/api/agent/updates/download/windows");
        assert.equal(mx.version, "1.3.10");
        assert.notEqual(mp.signature, ms.signature); assert.ok(mp.signature.length > 20);
        const lp = await manifest(pilotL, "1.3.5"); const ls = await manifest(stableL, "1.3.5");
        assert.equal(lp.version, "1.3.11"); assert.equal(lp.sha256, cL.sha); assert.equal(ls.version, "1.3.10"); assert.equal(ls.sha256, sL.sha);
        // never a downgrade, and a stable device that is already on stable gets nothing while the candidate exists
        assert.equal(await manifest(pilotW, "1.3.11"), null); assert.equal(await manifest(pilotW, "1.3.12"), null);
        assert.equal(await manifest(stableW, "1.3.10"), null); assert.equal(await manifest(stableW, "1.3.11"), null);
        const mid = await manifest(pilotW, "1.3.10"); assert.equal(mid.version, "1.3.11", "pilot on the stable version moves to the candidate");
        // wrong architecture / unknown system unchanged
        assert.equal((await check(pilotW, "1.3.5", "windows")).status, 200);
        assert.equal((await call(`/api/agent/updates/check?os=windows&arch=arm64&version=1.3.5`, { headers: bearer(pilotW) })).status, 204);
        assert.equal((await call(`/api/agent/updates/check?os=windows&arch=x64&version=nope`, { headers: bearer(pilotW) })).status, 400);
        assert.equal((await call(`/api/agent/updates/check?os=windows&arch=x64&version=1.3.5`)).status, 401);
    });

    await test("the Update agent button follows the device's ring: a pilot device is offered the candidate, a stable device the stable build, and one already on it is told so", async () => {
        const press = async (d) => (await call(`/api/devices/${d.id}/actions/update-agent`, { method: "POST", token: owner.token, body: {} }));
        const pw = await press(pilotW); assert.equal(pw.status, 202); const pwb = await pw.json();
        assert.equal(pwb.status, "started"); assert.equal(pwb.targetVersion, "1.3.11", "a pilot Windows device is offered the candidate");
        const pl = await (await press(pilotL)).json(); assert.equal(pl.status, "started"); assert.equal(pl.targetVersion, "1.3.11", "a pilot Linux device too");
        const sw = await (await press(stableW)).json(); assert.equal(sw.status, "started"); assert.equal(sw.targetVersion, "1.3.10", "a stable device is offered the stable build");
        // one already on the candidate is told so (a throwaway device, so the shared pilot devices keep their numbers for the gate checks)
        const tmp = await mk(A.site, "pilot-tmp", { ring: "pilot", version: "1.3.11" });
        try { const same = await (await press(tmp)).json(); assert.equal(same.status, "up_to_date", "already on the candidate"); }
        finally { await q(`DELETE FROM jobs WHERE agent_id = $1`, [tmp.agentId]).catch(() => { }); await q(`DELETE FROM agents WHERE id = $1`, [tmp.agentId]); await q(`DELETE FROM devices WHERE id = $1`, [tmp.id]); }
        // the update jobs this test asked for are not part of what the later gate checks count
        await q(`DELETE FROM jobs WHERE type = 'AGENT_UPDATE' AND agent_id = ANY($1::uuid[])`, [[pilotW.agentId, pilotL.agentId, stableW.agentId]]);
    });

    await test("the download URL serves the candidate to pilot devices only; stable devices always get the stable file", async () => {
        const body = async (r) => sha256(Buffer.from(await r.arrayBuffer()));
        const dp = await download(pilotW); assert.equal(dp.status, 200); assert.equal(await body(dp), cW.sha); assert.equal(dp.headers.get("content-length"), String(cW.bytes.length));
        const ds = await download(stableW); assert.equal(ds.status, 200); assert.equal(await body(ds), sW.sha);
        const dx = await download(explicitStableW); assert.equal(await body(dx), sW.sha);
        assert.equal(await body(await download(pilotL)), cL.sha); assert.equal(await body(await download(stableL)), sL.sha);
        // guessing: slot-like paths do not exist
        for (const p of ["/api/agent/updates/download/candidate/windows", "/api/agent/updates/download/windows?slot=candidate", "/api/agent/updates/download/..%2Fcandidate%2Fwindows"]) {
            const r = await call(p, { headers: bearer(stableW) });
            if (r.status === 200) assert.equal(await body(r), sW.sha, `${p} must still be the stable file`); else assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
        }
        assert.equal((await call("/api/agent/updates/download/windows")).status, 401, "no token");
        // pilot with no usable candidate falls back to stable
        putSlot("candidate", "windows", "1.3.11", "badsha");
        assert.equal(await body(await download(pilotW)), sW.sha, "corrupt candidate is never served");
        Object.assign(cW, putSlot("candidate", "windows", "1.3.11"));
    });

    console.log("ring changes");
    await test("device ring: set, clear (follow the customer), audited with ring counts and logged; bad values refused", async () => {
        assert.equal((await ringApi(mgr, stableW.id, "pilot")).status, 200);
        let one = await json(`/api/devices/${stableW.id}`, { token: reader.token });
        assert.equal(one.updateRing, "pilot"); assert.equal(one.updateRingOwn, "pilot");
        assert.equal((await manifest(stableW, "1.3.5")).version, "1.3.11", "the device is now offered the candidate");
        const ev = await waitAudit("agents.ring.device", `target_id = $2`, [stableW.id]);
        assert.ok(ev, "audit event"); assert.equal(ev.actor_email, mgr.email); assert.equal(ev.target_type, "device");
        assert.ok(ev.details.ringCounts && typeof ev.details.ringCounts.pilot === "number", JSON.stringify(ev.details));
        assert.equal(ev.details.ring, "pilot");
        const log = (await q(`SELECT * FROM agent_releases_log WHERE action='ring-device' AND actor_email=$1 ORDER BY at DESC LIMIT 1`, [mgr.email])).rows[0];
        assert.ok(log && log.ring_counts.pilot >= 1);
        // clear -> follows the customer (stable)
        const r = await ringApi(mgr, stableW.id, null); assert.equal(r.status, 200);
        const j = await r.json(); assert.equal(j.updateRingOwn, null); assert.equal(j.updateRing, "stable");
        assert.equal((await manifest(stableW, "1.3.5")).version, "1.3.10");
        for (const bad of ["Pilot", "all", "", 1, true, undefined]) assert.equal((await ringApi(mgr, stableW.id, bad)).status, 400, `ring ${JSON.stringify(bad)}`);
        assert.equal((await ringApi(mgr, uuid(), "pilot")).status, 404); assert.equal((await ringApi(mgr, "nope", "pilot")).status, 404);
    });

    await test("customer default ring: devices without their own ring follow it, an explicit device ring overrides, audited", async () => {
        const r = await call(`/api/admin/agent-releases/customers/${B.id}/ring`, { method: "PATCH", token: mgr.token, body: { ring: "pilot" } });
        assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.defaultUpdateRing, "pilot"); assert.ok(j.devicesFollowingTheDefault >= 2);
        assert.equal((await manifest(bDev, "1.3.5")).version, "1.3.11", "new/unset devices of a pilot customer are pilot");
        assert.equal((await json(`/api/devices/${bDev.id}`, { token: reader.token })).updateRing, "pilot");
        assert.equal((await json(`/api/devices/${bDev.id}`, { token: reader.token })).updateRingOwn, null);
        await ringApi(mgr, bDev2.id, "stable");
        assert.equal((await manifest(bDev2, "1.3.5")).version, "1.3.10", "an explicit device ring overrides the customer default");
        const g = await json(`/api/admin/agent-releases/customers/${B.id}/ring`, { token: reader.token });
        assert.equal(g.defaultUpdateRing, "pilot");
        const ev = await waitAudit("agents.ring.customer", `target_id = $2`, [B.id]);
        assert.ok(ev && ev.details.ring === "pilot" && ev.details.ringCounts, JSON.stringify(ev?.details));
        assert.equal((await call(`/api/admin/agent-releases/customers/${B.id}/ring`, { method: "PATCH", token: mgr.token, body: { ring: null } })).status, 400, "a customer default cannot be null");
        assert.equal((await call(`/api/admin/agent-releases/customers/${B.id}/ring`, { method: "PATCH", token: mgr.token, body: { ring: "x" } })).status, 400);
        // back
        await call(`/api/admin/agent-releases/customers/${B.id}/ring`, { method: "PATCH", token: mgr.token, body: { ring: "stable" } });
        assert.equal((await manifest(bDev, "1.3.5")).version, "1.3.10");
        // a limited person cannot reach another customer
        assert.equal((await call(`/api/admin/agent-releases/customers/${B.id}/ring`, { method: "PATCH", token: limited.token, body: { ring: "pilot" } })).status, 404);
        assert.equal((await call(`/api/admin/agent-releases/customers/${A.id}/ring`, { method: "PATCH", token: limited.token, body: { ring: "stable" } })).status, 200);
        assert.equal((await ringApi(limited, bDev.id, "pilot")).status, 404, "a device of another customer answers not found");
        assert.equal((await ringApi(limited, stableW.id, "pilot")).status, 200); await ringApi(mgr, stableW.id, null);
    });

    await test("device list carries the ring (badge) for every device", async () => {
        const list = await json(`/api/devices?q=${tag}&pageSize=50`, { token: reader.token });
        const items = list.items ?? list;
        const w = items.find((d) => d.id === pilotW.id); assert.equal(w.updateRing, "pilot");
        assert.equal(items.find((d) => d.id === stableW.id).updateRing, "stable");
        assert.equal(items.find((d) => d.id === explicitStableW.id).updateRingOwn, "stable");
    });

    console.log("bulk ring change");
    await test("bulk set ring: per-device results, skip when unchanged, customer limit answers not found, audited, batch kept", async () => {
        const post = (t, body) => call("/api/bulk/devices/set-ring", { method: "POST", token: t.token, body });
        assert.equal((await post(mgr, { deviceIds: [], ring: "pilot" })).status, 400);
        assert.equal((await post(mgr, { deviceIds: [stableW.id], ring: "everyone" })).status, 400);
        assert.equal((await post(mgr, { deviceIds: [stableW.id] })).status, 400);
        assert.equal((await post(mgr, { deviceIds: Array.from({ length: 501 }, () => uuid()), ring: "pilot" })).status, 400);
        assert.equal((await post(noDevWrite, { deviceIds: [stableW.id], ring: "pilot" })).status, 403);

        const ghost = uuid();
        const r = await post(limited, { deviceIds: [stableW.id, stableL.id, pilotW.id, bDev.id, ghost], ring: "pilot" });
        assert.equal(r.status, 200); const res = await r.json();
        const item = (id) => res.items.find((i) => i.deviceId === id);
        assert.equal(item(stableW.id).status, "done"); assert.equal(item(stableL.id).status, "done");
        assert.equal(item(pilotW.id).status, "skipped"); assert.match(item(pilotW.id).reason, /already/i);
        assert.equal(item(bDev.id).status, "failed"); assert.equal(item(bDev.id).reason, "Device not found.", "customer limit answers like a missing device");
        assert.equal(item(ghost).status, "failed");
        assert.equal(res.succeeded, 2); assert.equal(res.skipped, 1); assert.equal(res.failed, 2);
        assert.equal((await q(`SELECT update_ring FROM devices WHERE id=$1`, [bDev.id])).rows[0].update_ring, null, "the other customer's device was not touched");
        assert.equal((await q(`SELECT update_ring FROM devices WHERE id=$1`, [stableW.id])).rows[0].update_ring, "pilot");
        assert.equal((await manifest(stableL, "1.3.5")).version, "1.3.11");

        const ev = await waitAudit("agents.ring.bulk", `target_id = $2`, [res.batchId]);
        assert.ok(ev, "bulk ring audit"); assert.equal(ev.details.ring, "pilot"); assert.equal(ev.details.changed, 2); assert.ok(ev.details.ringCounts);
        assert.ok(await waitAudit("device.bulk.set-ring", `target_id = $2`, [res.batchId]), "the generic bulk audit event too");
        const batch = await json(`/api/bulk/batches/${res.batchId}`, { token: mgr.token });
        assert.equal(batch.items?.length ?? batch.requested, 5 === (batch.items?.length ?? 5) ? 5 : batch.requested);
        assert.equal((await q(`SELECT count(*)::int n FROM agent_releases_log WHERE action='ring-bulk' AND details->>'ring' = 'pilot'`)).rows[0].n >= 1, true);

        // back to everyone, and to the customer default
        const back = await (await post(mgr, { deviceIds: [stableW.id, stableL.id], ring: "stable" })).json(); assert.equal(back.succeeded, 2);
        const inh = await (await post(mgr, { deviceIds: [stableW.id, stableL.id], ring: "inherit" })).json(); assert.equal(inh.succeeded, 2);
        assert.equal((await q(`SELECT update_ring FROM devices WHERE id=$1`, [stableL.id])).rows[0].update_ring, null);
        assert.equal((await manifest(stableL, "1.3.5")).version, "1.3.10");
    });

    console.log("health gate");
    await test("health gate numbers: pilot devices, on candidate, online, seen online after updating, not updated, offline since updating", async () => {
        // pilot windows devices so far: pilotW (1.3.5). add four more with different states
        await setAgent(pilotW, "1.3.5", { checkMin: 1, changedMin: 600 });
        const updOk = await mk(A.site, "g-ok", { ring: "pilot" });
        const updFresh = await mk(A.site, "g-fresh", { ring: "pilot" });
        const updQuiet = await mk(A.site, "g-quiet", { ring: "pilot" });
        const updLate = await mk(A.site, "g-late", { ring: "pilot" });   // updated, last seen 20 min ago: neither online nor offline-since
        await setAgent(updOk, "1.3.11", { checkMin: 2, changedMin: 30 });
        await setAgent(updFresh, "1.3.11", { checkMin: 0.5, changedMin: 1 });
        await setAgent(updQuiet, "1.3.11", { checkMin: 45, changedMin: 120 });
        await setAgent(updLate, "1.3.11", { checkMin: 20, changedMin: 120 });
        await q(`INSERT INTO jobs (agent_id, type, status, created_at) VALUES ($1,'AGENT_UPDATE','failed', now() - interval '5 minutes')`, [pilotW.agentId]);
        const g = sys(await status(mgr), "windows").gate;
        assert.equal(g.candidateVersion, "1.3.11");
        assert.equal(g.pilotTotal, 5, JSON.stringify(g)); assert.equal(g.onCandidate, 4); assert.equal(g.onCandidateOnline, 2);
        assert.equal(g.seenOnlineAfterUpdate, 3, "ok (28 min after), late (100) and quiet (75, then went quiet) were seen after updating; fresh was not");
        assert.equal(g.notYetUpdated, 1); assert.equal(g.offlineSinceUpdating, 1); assert.equal(g.updateFailed, 1);
        assert.equal(g.status, "offline_since_update"); assert.ok(g.blockers.length === 1);
        // linux: two pilot devices (pilotL 1.3.5 and the one that was set pilot then reset is inherit) -> pilotL only
        const gl = sys(await status(mgr), "linux").gate;
        assert.equal(gl.pilotTotal, 1); assert.equal(gl.onCandidate, 0); assert.equal(gl.status, "not_updated_yet");
        made.keepGate = { updOk, updFresh, updQuiet, updLate };
    });

    console.log("promote");
    await test("promote: refused without force while a pilot device is offline since updating; force needs a reason; nothing changes", async () => {
        const body = { os: "windows", candidateVersion: "1.3.11" };
        const post = (b) => call("/api/admin/agent-releases/promote", { method: "POST", token: mgr.token, body: b });
        const s0 = [diskSha(pkgPath("stable", "windows")), diskSha(pkgPath("candidate", "windows")), diskVersion("stable", "windows")];
        let r = await post(body); assert.equal(r.status, 409); let j = await r.json(); assert.equal(j.code, "force_required"); assert.ok(j.blockers.length); assert.ok(j.gate);
        r = await post({ ...body, force: true }); assert.equal(r.status, 400); assert.equal((await r.json()).code, "reason_required");
        r = await post({ ...body, force: true, reason: "x" }); assert.equal(r.status, 400);
        r = await post({ ...body, force: "yes", reason: "a long enough reason" }); assert.equal(r.status, 409);
        r = await post({ os: "windows", candidateVersion: "1.3.12" }); assert.equal(r.status, 409); assert.equal((await r.json()).code, "version_changed");
        r = await post({ os: "windows" }); assert.equal(r.status, 409);
        r = await post({ os: "macos", candidateVersion: "1.3.11" }); assert.equal(r.status, 400);
        r = await post({ os: "windows", candidateVersion: "1.3.11", force: true, reason: "bad \u0007 control" }); assert.equal(r.status, 400);
        assert.deepEqual([diskSha(pkgPath("stable", "windows")), diskSha(pkgPath("candidate", "windows")), diskVersion("stable", "windows")], s0);
        assert.equal(fs.existsSync(pkgPath("previous", "windows")), false);
        const bad = await waitAudit("agents.release.promote", `outcome = 'failure' AND details->>'os' = 'windows'`);
        assert.ok(bad, "refused attempts are audited as failures");
    });

    await test("promote: 'changed since' - the candidate was replaced after the admin looked", async () => {
        const seen = (await status(mgr));
        const before = sys(seen, "linux").candidate.version;
        assert.equal(before, "1.3.11");
        Object.assign(cL, putSlot("candidate", "linux", "1.3.12"));
        const r = await call("/api/admin/agent-releases/promote", { method: "POST", token: mgr.token, body: { os: "linux", candidateVersion: before, force: true, reason: "I looked at 1.3.11" } });
        assert.equal(r.status, 409); assert.equal((await r.json()).code, "version_changed");
        assert.equal(diskSha(pkgPath("stable", "linux")), sL.sha, "stable linux untouched");
        Object.assign(cL, putSlot("candidate", "linux", "1.3.11"));
    });

    await test("promote with force and a reason: stable replaced, previous kept, candidate removed, audited + logged with ring counts", async () => {
        const r = await call("/api/admin/agent-releases/promote", { method: "POST", token: owner.token, body: { os: "windows", candidateVersion: "1.3.11", force: true, reason: "  pilot laptop is in a bag, build looked fine  " } });
        assert.equal(r.status, 200, JSON.stringify(await r.clone().json())); const j = await r.json();
        assert.equal(j.version, "1.3.11"); assert.equal(j.previousVersion, "1.3.10"); assert.equal(j.forced, true);
        assert.equal(diskSha(pkgPath("stable", "windows")), cW.sha); assert.equal(diskVersion("stable", "windows"), "1.3.11");
        assert.equal(diskSha(pkgPath("previous", "windows")), sW.sha); assert.equal(diskVersion("previous", "windows"), "1.3.10");
        assert.equal(fs.existsSync(pkgPath("candidate", "windows")), false); assert.equal(fs.existsSync(verPath("candidate", "windows")), false);
        const st = j.status; const w = sys(st, "windows");
        assert.equal(w.stable.version, "1.3.11"); assert.equal(w.previous.version, "1.3.10"); assert.equal(w.candidate.state, "absent");
        // everyone is now offered it
        const m = await manifest(stableW, "1.3.5"); assert.equal(m.version, "1.3.11"); assert.equal(m.sha256, cW.sha);
        assert.equal(sha256(Buffer.from(await (await download(stableW)).arrayBuffer())), cW.sha);
        assert.equal(await manifest(stableW, "1.3.11"), null);
        const ev = await waitAudit("agents.release.promote", `outcome = 'success' AND details->>'os' = 'windows'`);
        assert.ok(ev); assert.equal(ev.actor_email, owner.email); assert.equal(ev.details.version, "1.3.11"); assert.equal(ev.details.previousVersion, "1.3.10");
        assert.equal(ev.details.forced, true); assert.equal(ev.details.reason, "pilot laptop is in a bag, build looked fine"); assert.ok(ev.details.ringCounts.pilot >= 1);
        const log = (await q(`SELECT * FROM agent_releases_log WHERE action='promote' AND os='windows' ORDER BY at DESC LIMIT 1`)).rows[0];
        assert.equal(log.version, "1.3.11"); assert.equal(log.previous_version, "1.3.10"); assert.equal(log.forced, true); assert.equal(log.reason, "pilot laptop is in a bag, build looked fine"); assert.ok(log.ring_counts.stable >= 1);
        // a second promote has nothing to promote
        const again = await call("/api/admin/agent-releases/promote", { method: "POST", token: mgr.token, body: { os: "windows", candidateVersion: "1.3.11" } });
        assert.equal(again.status, 409); assert.equal((await again.json()).code, "no_candidate");
        assert.ok((await json("/api/admin/agent-releases", { token: reader.token })).recent.some((x) => x.action === "promote" && x.forced && x.reason), "the log is shown in the status");
    });

    await test("promote WITHOUT force when the gate is healthy; concurrent promotes: exactly one wins", async () => {
        // windows: new candidate 1.3.12; make pilot devices healthy: all pilot windows devices on 1.3.12 and seen after
        Object.assign(cW, putSlot("candidate", "windows", "1.3.12"));
        const pilots = (await q(`SELECT a.id FROM agents a JOIN devices d ON d.id=a.device_id WHERE d.update_ring='pilot' AND a.facts->>'os'='windows' AND d.hostname LIKE $1`, [`${tag}%`])).rows;
        for (const p of pilots) await q(`UPDATE agents SET version='1.3.12', last_check_in_at = now() - interval '1 minute', version_changed_at = now() - interval '30 minutes' WHERE id=$1`, [p.id]);
        const g = sys(await status(mgr), "windows").gate;
        assert.equal(g.status, "healthy"); assert.deepEqual(g.blockers, []); assert.equal(g.onCandidate, g.pilotTotal);
        const body = { os: "windows", candidateVersion: "1.3.12" };
        const rs = await Promise.all([1, 2, 3].map(() => call("/api/admin/agent-releases/promote", { method: "POST", token: mgr.token, body })));
        const codes = rs.map((r) => r.status).sort();
        assert.deepEqual(codes, [200, 409, 409], `got ${codes}`);
        assert.equal(diskVersion("stable", "windows"), "1.3.12"); assert.equal(diskVersion("previous", "windows"), "1.3.11");
        const log = (await q(`SELECT * FROM agent_releases_log WHERE action='promote' AND version='1.3.12'`)).rows;
        assert.equal(log.length, 1); assert.equal(log[0].forced, false);
        const ev = await waitAudit("agents.release.promote", `outcome = 'success' AND details->>'version' = '1.3.12'`);
        assert.ok(ev && !ev.details.forced);
    });

    console.log("withdraw");
    await test("withdraw: candidate deleted, pilot devices are offered stable again, 'changed since' and absent are refused, audited", async () => {
        const w = (b, t = mgr) => call("/api/admin/agent-releases/withdraw", { method: "POST", token: t.token, body: b });
        assert.equal((await w({ os: "linux", candidateVersion: "1.3.11" }, admin)).status, 403);
        const stableBefore = diskSha(pkgPath("stable", "linux"));
        assert.equal((await manifest(pilotL, "1.3.5")).version, "1.3.11");
        let r = await w({ os: "linux", candidateVersion: "1.3.99" }); assert.equal(r.status, 409); assert.equal((await r.json()).code, "version_changed");
        assert.ok(fs.existsSync(pkgPath("candidate", "linux")));
        r = await w({ os: "linux", candidateVersion: "1.3.11" }); assert.equal(r.status, 200); const j = await r.json();
        assert.equal(j.version, "1.3.11"); assert.match(j.note, /no downgrade/i); assert.equal(typeof j.pilotDevicesOnCandidate, "number");
        assert.equal(fs.existsSync(pkgPath("candidate", "linux")), false); assert.equal(fs.existsSync(verPath("candidate", "linux")), false);
        assert.equal(diskSha(pkgPath("stable", "linux")), stableBefore, "stable untouched");
        assert.equal((await manifest(pilotL, "1.3.5")).version, "1.3.10", "pilot devices are offered stable again");
        assert.equal(sys(j.status, "linux").candidate.state, "absent");
        r = await w({ os: "linux" }); assert.equal(r.status, 409); assert.equal((await r.json()).code, "no_candidate");
        const ev = await waitAudit("agents.release.withdraw", `outcome = 'success' AND details->>'os' = 'linux'`);
        assert.ok(ev && ev.details.version === "1.3.11" && ev.details.ringCounts);
        assert.equal((await q(`SELECT count(*)::int n FROM agent_releases_log WHERE action='withdraw' AND os='linux'`)).rows[0].n, 1);
        // a device that already updated to the withdrawn build stays on it: no downgrade is offered
        assert.equal(await manifest(pilotL, "1.3.11"), null);
    });

    await test("kill switch and the 'automatic updates' toggle still win over rings", async () => {
        Object.assign(cL, putSlot("candidate", "linux", "1.3.11"));
        assert.equal((await manifest(pilotL, "1.3.5")).version, "1.3.11");
        const before = (await json("/api/admin/agent-settings", { token: mgr.token })).autoUpdate;
        const off = await call("/api/admin/agent-settings", { method: "PUT", token: owner.token, body: { autoUpdate: false } });
        assert.equal(off.status, 200);
        await new Promise((r) => setTimeout(r, 5200)); // the server caches the switch for 5 seconds
        assert.equal(await manifest(pilotL, "1.3.5"), null, "switched off: pilot devices get nothing either");
        assert.equal((await download(pilotL)).status, 503);
        assert.equal((await status(mgr)).autoUpdate, false);
        await call("/api/admin/agent-settings", { method: "PUT", token: owner.token, body: { autoUpdate: before } });
        await new Promise((r) => setTimeout(r, 5200));
        assert.equal((await manifest(pilotL, "1.3.5")).version, "1.3.11");
        clearSlot("candidate", "linux");
    });

    // cleanup
    await q(`DELETE FROM agent_releases_log WHERE actor_email LIKE 'rg-%'`);
    await q(`DELETE FROM jobs WHERE agent_id IN (SELECT id FROM agents WHERE device_id = ANY($1::uuid[]))`, [devIds]);
    await q(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, [devIds]);
    await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [devIds]);
    await q(`DELETE FROM bulk_batches WHERE created_by = ANY($1::uuid[])`, [made.users]);
    await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [made.users]);
    await q(`DELETE FROM sites WHERE client_id = ANY($1::uuid[])`, [made.clients]);
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
