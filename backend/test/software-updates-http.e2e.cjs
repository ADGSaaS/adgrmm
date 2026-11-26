#!/usr/bin/env node
// Third-party software patching over the real routes and sign-in: who may read, scan, update and change the lists,
// what a customer-limited person can reach, and what the audit log records. Throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3931 DATABASE_URL=postgres://.../adg_g3_e2e JWT_SECRET=... node test/software-updates-http.e2e.cjs
"use strict";

const { assert, uuid, call, json, runner, setup } = require("./groupc-helpers.cjs");

(async () => {
    const t = runner();
    const env = await setup();
    const { q, org, staffUser } = env;
    const stamp = Date.now();
    const MIN = "1.3.34";

    const A = uuid(), B = uuid();
    await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3),($4,$2,$5)`, [A, org, `SU-A-${stamp}`, B, `SU-B-${stamp}`]);
    env.made.clients.push(A, B);
    const mkDevice = async (clientId, label, os = "windows", version = MIN) => {
        const site = uuid(), dev = uuid(), agent = uuid();
        await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,$3)`, [site, clientId, `HQ-${label}`]);
        await q(`INSERT INTO devices (id, site_id, hostname, operating_system) VALUES ($1,$2,$3,$4)`, [dev, site, `SU-${label}-${stamp}`, os === "windows" ? "Windows 11 Pro" : "Ubuntu"]);
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,$4,now(),$5)`, [agent, dev, uuid(), version, JSON.stringify({ os })]);
        await q(`INSERT INTO agent_outdated_software (agent_id, source, app_id, name, installed_version, available_version) VALUES ($1,'winget','7zip.7zip','7-Zip 25.01 (x64)','25.01','26.06'), ($1,'winget','Git.Git','Git','2.40.0','2.56.0')`, [agent]);
        await q(`INSERT INTO agent_software_scans (agent_id, scanned_at, ok, winget_state, choco_state, app_count) VALUES ($1, now(), true, 'ok', 'missing', 2)`, [agent]);
        return { dev, agent };
    };
    const dA = await mkDevice(A, "a");
    const dB = await mkDevice(B, "b");
    const dLin = await mkDevice(A, "lin", "linux");

    const reader = await staffUser("reader", ["devices.read"]);
    const installer = await staffUser("installer", ["devices.read", "software.install"]);
    const policyReader = await staffUser("polread", ["policies.read"]);
    const policyWriter = await staffUser("polwrite", ["policies.read", "policies.write"]);
    const limited = await staffUser("limited", ["devices.read", "software.install", "policies.read", "policies.write"]);
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A]);

    const s = (path, token, method = "GET", body) => call(path, { method, token, body });

    await t.test("signed-out callers are turned away from every route", async () => {
        for (const [m, p] of [["GET", "/api/software-updates/fleet"], ["POST", "/api/software-updates/scan"], ["POST", "/api/software-updates/update"], ["GET", "/api/software-updates/rules"], ["GET", `/api/devices/${dA.dev}/software/updates`]]) {
            const r = await call(p, { method: m, body: m === "POST" ? {} : undefined });
            assert.equal(r.status, 401, `${m} ${p}`);
        }
    });

    await t.test("reading needs devices.read; the lists need policies.read", async () => {
        assert.equal((await s("/api/software-updates/fleet", reader.token)).status, 200);
        assert.equal((await s(`/api/devices/${dA.dev}/software/updates`, reader.token)).status, 200);
        assert.equal((await s("/api/software-updates/fleet", policyReader.token)).status, 403);
        assert.equal((await s("/api/software-updates/rules", reader.token)).status, 403);
        assert.equal((await s("/api/software-updates/rules", policyReader.token)).status, 200);
    });

    await t.test("scanning, previewing and updating need software.install", async () => {
        for (const [p, body] of [["/api/software-updates/scan", { deviceIds: [dA.dev] }], ["/api/software-updates/preview", { deviceIds: [dA.dev], all: true }], ["/api/software-updates/update", { deviceIds: [dA.dev], all: true }]]) {
            assert.equal((await s(p, reader.token, "POST", body)).status, 403, p);
        }
    });

    await t.test("changing the lists needs policies.write", async () => {
        const body = { rule: "block", source: "winget", appId: "Zoom.Zoom.EXE" };
        assert.equal((await s("/api/software-updates/rules", policyReader.token, "POST", body)).status, 403);
        assert.equal((await s("/api/software-updates/rules", installer.token, "POST", body)).status, 403);
        const ok = await s("/api/software-updates/rules", policyWriter.token, "POST", body);
        assert.equal(ok.status, 200);
        const id = (await ok.json()).id;
        assert.equal((await s(`/api/software-updates/rules/${id}`, policyReader.token, "DELETE")).status, 403);
        assert.equal((await s(`/api/software-updates/rules/${id}`, policyWriter.token, "DELETE")).status, 200);
        assert.equal((await s(`/api/software-updates/rules/${id}`, policyWriter.token, "DELETE")).status, 404);
    });

    await t.test("a scan is accepted (202) and queued; the device view shows it as scanning", async () => {
        const r = await s("/api/software-updates/scan", installer.token, "POST", { deviceIds: [dA.dev, dLin.dev] });
        assert.equal(r.status, 202);
        const b = await r.json();
        assert.equal(b.queued, 1);
        assert.match(b.skipped[0].reason, /Windows/);
        const view = await (await s(`/api/devices/${dA.dev}/software/updates`, reader.token)).json();
        assert.equal(view.scanning, true);
        assert.equal(view.items.length, 2);
        await q(`UPDATE agent_tasks SET status = 'succeeded' WHERE agent_id = $1`, [dA.agent]);
    });

    await t.test("an update is accepted, queued as an upgrade task, and listed in the install log", async () => {
        const body = { deviceIds: [dA.dev], apps: [{ source: "winget", appId: "7zip.7zip" }] };
        const pv = await (await s("/api/software-updates/preview", installer.token, "POST", body)).json();
        assert.equal(pv.eligible.length, 1);
        const r = await s("/api/software-updates/update", installer.token, "POST", body);
        assert.equal(r.status, 202);
        assert.equal((await r.json()).queued, 1);
        const task = (await q(`SELECT payload, created_by FROM agent_tasks WHERE agent_id = $1 AND type = 'software_install'`, [dA.agent])).rows[0];
        assert.equal(task.payload.action, "upgrade");
        assert.equal(task.payload.wingetId, "7zip.7zip");
        assert.equal(task.created_by, installer.id);
        const log = await (await s(`/api/devices/${dA.dev}/software/installs`, reader.token)).json();
        assert.equal(log.items[0].action, "upgrade");
        assert.equal(log.items[0].name, "7-Zip (x64)");
        assert.equal((await (await s("/api/software-updates/update", installer.token, "POST", body)).json()).queued, 0, "the same update twice");
        await q(`UPDATE agent_tasks SET status = 'succeeded' WHERE agent_id = $1`, [dA.agent]);
    });

    await t.test("limits: 201 devices is a 400; nothing chosen is a 400; a bad id is a 400", async () => {
        const many = Array.from({ length: 201 }, () => uuid());
        assert.equal((await s("/api/software-updates/update", installer.token, "POST", { deviceIds: many, all: true })).status, 400);
        assert.equal((await s("/api/software-updates/scan", installer.token, "POST", { deviceIds: many })).status, 400);
        assert.equal((await s("/api/software-updates/update", installer.token, "POST", { deviceIds: [dA.dev] })).status, 400);
        assert.equal((await s("/api/software-updates/update", installer.token, "POST", { deviceIds: ["nope"], all: true })).status, 400);
        assert.equal((await s("/api/software-updates/rules", policyWriter.token, "POST", { rule: "block", appId: "a b" })).status, 400);
        assert.equal((await s("/api/software-updates/fleet?source=apt", reader.token)).status, 400);
        assert.equal((await s("/api/software-updates/fleet?clientId=nope", reader.token)).status, 400);
    });

    await t.test("customer limits: a limited person sees only their customer, and cannot reach the other's device", async () => {
        const fleet = await (await s("/api/software-updates/fleet", limited.token)).json();
        const z = fleet.items.find((i) => i.appId === "7zip.7zip");
        assert.equal(z.devices, 2, "customer A has two devices with it (one is Linux data we planted)");
        const all = await (await s("/api/software-updates/fleet", reader.token)).json();
        assert.ok(all.items.find((i) => i.appId === "7zip.7zip").devices >= 3);
        assert.equal((await s(`/api/devices/${dB.dev}/software/updates`, limited.token)).status, 404);
        const r = await (await s("/api/software-updates/update", limited.token, "POST", { deviceIds: [dB.dev], all: true })).json();
        assert.equal(r.queued, 0);
        assert.match(r.skipped[0].reason, /not found/i);
        const scan = await (await s("/api/software-updates/scan", limited.token, "POST", { deviceIds: [dB.dev] })).json();
        assert.equal(scan.queued, 0);
        assert.equal((await s(`/api/software-updates/fleet/devices?source=winget&appId=7zip.7zip`, limited.token).then((x) => x.json())).items.every((i) => i.customer === `SU-A-${stamp}`), true);
        assert.equal((await s("/api/software-updates/rules", limited.token, "POST", { rule: "block", appId: "Foo.Bar" })).status, 403, "organisation-wide entry");
        assert.equal((await s("/api/software-updates/rules", limited.token, "POST", { rule: "block", appId: "Foo.Bar", clientId: B })).status, 403, "other customer");
        assert.equal((await s("/api/software-updates/rules", limited.token, "POST", { rule: "block", appId: "Foo.Bar", clientId: A })).status, 200);
    });

    await t.test("a Linux device says so instead of failing", async () => {
        const v = await (await s(`/api/devices/${dLin.dev}/software/updates`, reader.token)).json();
        assert.equal(v.supported, false);
        assert.match(v.reason, /Windows/);
    });

    await t.test("the audit log records scans, updates and list changes, without anything it should not", async () => {
        const deadline = Date.now() + 4000;
        let rows = [];
        while (Date.now() < deadline) {
            rows = (await q(`SELECT action, actor_email, outcome, details FROM audit_events WHERE action LIKE 'software.updates.%' ORDER BY created_at`)).rows;
            if (rows.some((r) => r.action === "software.updates.rule.delete")) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        const actions = new Set(rows.map((r) => r.action));
        for (const a of ["software.updates.scan", "software.updates.update", "software.updates.rule", "software.updates.rule.delete"]) assert.ok(actions.has(a), `missing ${a}: ${[...actions].join(", ")}`);
        assert.ok(!rows.some((r) => r.action === "software.updates.preview" && r.outcome === "success"), "a preview changes nothing and is not recorded (a refused one is, like any denial)");
        const upd = rows.find((r) => r.action === "software.updates.update" && r.outcome === "success");
        assert.ok(upd.actor_email.startsWith("installer-"));
        assert.ok(JSON.stringify(upd.details).includes("deviceIds"));
    });

    await q(`DELETE FROM user_client_access WHERE user_id = $1`, [limited.id]);
    await q(`DELETE FROM software_update_rules WHERE client_id = ANY($1::uuid[]) OR app_id IN ('Foo.Bar','Zoom.Zoom.EXE')`, [[A, B]]);
    await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [[dA.dev, dB.dev, dLin.dev]]);
    await env.cleanup();
    t.finish();
})().catch((e) => { console.error(e); process.exit(1); });
