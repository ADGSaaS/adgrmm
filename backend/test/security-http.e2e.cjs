#!/usr/bin/env node
// Security basics, stage 1 (Defender status, baseline checks and score, BitLocker status) through the real HTTP API, with a fake agent
// that answers the signed script jobs with scripted output: rights, the states of a device that cannot be scanned, the scan flow
// (queued, pending, read back on request and by the poller), scoring and grade caps end to end, hostile and failed answers (the last
// good result stays), timeouts, the Defender actions, the customer limit, the fleet endpoint (paging, sorting, filters, one row per
// Windows device), the summary, the bulk action, the Security posture report, and an audit trail without scan data.
//
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../riq_sec_e2e JWT_SECRET=... node test/security-http.e2e.cjs
"use strict";
const path = require("node:path");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");
const { healthy, unknown, text } = require("./security-fixtures.cjs");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "security");
const S = require(path.join(dist, "security.scripts.js"));
const B = require(path.join(dist, "security.baseline.js"));
const LA = require(path.join(dist, "security-linux.actions.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `SC${Date.now()}`;
    const devs = [];

    const reader = await staffUser("sc-reader", ["devices.read"]);
    const ops = await staffUser("sc-ops", ["devices.read", "devices.actions"]);
    const onlyActions = await staffUser("sc-onlyactions", ["devices.actions"]);
    const nobody = await staffUser("sc-nobody", ["customers.read"]);
    const limited = await staffUser("sc-limited", ["devices.read", "devices.actions", "reports.read"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, name: `${tag} ${n}`, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A");
    const B_ = await mkClient("B");
    const P = await mkClient("Paging");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);

    const mk = async (site, host, os, minutes = 0) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11 Pro" : os === "mac" ? "macOS 15" : "Ubuntu 24.04"])).rows[0].id;
        devs.push(id);
        let agent = null;
        if (minutes !== null) {
            agent = uuid();
            await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.30', now() - ($4 || ' minutes')::interval, $5)`, [agent, id, uuid(), String(minutes), JSON.stringify({ os: os === "mac" ? "macos" : os })]);
        }
        return { id, agent };
    };
    const w1 = await mk(A.site, "w1", "windows");
    const w2 = await mk(A.site, "w2", "windows");
    const w3 = await mk(A.site, "w3", "windows");
    const w4 = await mk(A.site, "w4", "windows");
    const w5 = await mk(A.site, "w5", "windows");
    const w6 = await mk(A.site, "w6", "windows");
    const lin = await mk(A.site, "lin", "linux");
    const mac = await mk(A.site, "mac", "mac");
    const off = await mk(A.site, "off", "windows", 90);
    const none = await mk(A.site, "none", "windows", null);
    const other = await mk(B_.site, "other", "windows");

    // ----- the fake agent: answers every queued security job with what the scenario of that device says
    const scenario = new Map(); // device id -> { mode, out } for the NEXT job
    const seen = [];
    const handled = new Set();
    const finishJob = async (id, stdout, { stderr = "", status = "succeeded" } = {}) => {
        await q(`UPDATE jobs SET status=$2, finished_at=now() WHERE id=$1`, [id, status]);
        await q(`INSERT INTO job_results (job_id, exit_code, stdout, stderr) VALUES ($1,$2,$3,$4) ON CONFLICT (job_id) DO NOTHING`, [id, status === "succeeded" ? 0 : 1, stdout, stderr]);
    };
    const defaultAnswers = {
        "security.scan": () => text(healthy()),
        "security.defender.update": () => JSON.stringify({ ok: true, action: "update", before: "1.463.311.0", after: "1.463.330.0", updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }),
        "security.defender.quick-scan": () => JSON.stringify({ ok: true, action: "scan", scanType: "QuickScan", started: true }),
        "security.defender.full-scan": () => JSON.stringify({ ok: true, action: "scan", scanType: "FullScan", started: true }),
        "security.linux.firewall-enable": () => "OK The firewall (ufw) is on. Incoming SSH (port 22) is allowed; everything else coming in is blocked.",
        "security.linux.malware-scan": () => "R clean 1200 12 0",
    };
    const timer = setInterval(async () => {
        try {
            const rows = (await q(`SELECT j.id, j.payload, a.device_id FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.status = 'queued' AND a.device_id = ANY($1::uuid[])`, [devs])).rows;
            for (const r of rows) {
                const kind = r.payload?.env?.RIQ_TOOL;
                if (!kind || !kind.startsWith("security.") || handled.has(r.id)) continue;
                handled.add(r.id);
                const sc = scenario.get(r.device_id);
                scenario.delete(r.device_id);
                seen.push({ id: r.id, kind, device: r.device_id, payload: r.payload });
                if (sc?.mode === "never") continue;
                if (sc?.delay) await sleep(sc.delay);
                if (sc?.mode === "fail") { await finishJob(r.id, "", { stderr: sc.stderr ?? "Access is denied", status: "failed" }); continue; }
                const out = sc?.out ?? defaultAnswers[kind]();
                await finishJob(r.id, out);
            }
        } catch { /* next tick */ }
    }, 150);

    const url = (id, p = "") => `/api/devices/${id}/security${p}`;
    const get = (id, t, p = "") => call(url(id, p), { token: t.token });
    const post = (id, t, p = "", body) => call(url(id, p), { method: "POST", token: t.token, body: body ?? {} });
    const view = async (id, t = reader) => (await get(id, t)).json();
    const scanNow = async (d, out, t = ops) => {
        if (out !== undefined) scenario.set(d.id, { out: typeof out === "string" ? out : text(out) });
        const r = await post(d.id, t, "/scan");
        assert.equal(r.status, 200, `scan: ${r.status}`);
        const j = await r.json();
        for (let i = 0; i < 60; i++) {
            const v = await view(d.id);
            if (v.state === "scanned" && !v.pending) return v;
            if (v.lastAttemptFailed && !v.pending) return v;
            await sleep(250);
        }
        throw new Error("the scan was never read back");
    };
    const withProbes = (over) => healthy(over);

    console.log("rights");
    await test("looking needs devices.read; scanning and Defender actions also need devices.actions; no token is refused", async () => {
        assert.equal((await get(w1.id, nobody)).status, 403);
        assert.equal((await get(w1.id, onlyActions)).status, 403, "devices.actions alone cannot look");
        assert.equal((await get(w1.id, reader)).status, 200);
        assert.ok([401, 403].includes((await call(url(w1.id))).status));
        assert.equal((await post(w1.id, reader, "/scan")).status, 403);
        assert.equal((await post(w1.id, nobody, "/scan")).status, 403);
        assert.equal((await post(w1.id, onlyActions, "/scan")).status, 403, "devices.read is needed too");
        for (const a of ["update", "quick-scan", "full-scan"]) assert.equal((await post(w1.id, reader, `/defender/${a}`)).status, 403, a);
        assert.equal((await get(w1.id, reader, `/jobs/${uuid()}`)).status, 403);
        assert.equal((await call("/api/security/fleet", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/security/summary", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/security/fleet", { token: reader.token })).status, 200);
        assert.ok([401, 403].includes((await call("/api/security/fleet")).status));
        assert.equal(seen.length, 0, "no job was created by a refused request");
    });

    console.log("devices that cannot be scanned");
    await test("the states: macOS is unsupported, a Linux device is scannable, no agent, offline and never scanned, not scanned yet, unknown id", async () => {
        let v = await view(mac.id);
        assert.equal(v.state, "unsupported"); assert.match(v.reason, /Windows and Linux/); assert.equal(v.scan, null);
        v = await view(lin.id);
        assert.equal(v.state, "not_scanned"); assert.equal(v.linux, true); assert.equal(v.windows, false); assert.equal(v.scan, null);
        v = await view(none.id); assert.equal(v.state, "no_agent"); assert.match(v.reason, /no agent/i);
        v = await view(off.id); assert.equal(v.state, "offline"); assert.equal(v.online, false); assert.match(v.reason, /offline/i);
        v = await view(w1.id); assert.equal(v.state, "not_scanned"); assert.equal(v.online, true); assert.equal(v.scan, null); assert.equal(v.pending, false); assert.match(v.reason, /not been scanned/);
        assert.equal((await get(uuid(), reader)).status, 404);
        assert.equal((await get("not-a-uuid", reader)).status, 404);
    });
    await test("scans and Defender actions are refused with a reason, and no job is created", async () => {
        let r = await post(mac.id, ops, "/scan"); assert.equal(r.status, 400); assert.match((await r.json()).message, /Windows and Linux/);
        r = await post(none.id, ops, "/scan"); assert.equal(r.status, 409); assert.match((await r.json()).message, /no agent/i);
        r = await post(off.id, ops, "/scan"); assert.equal(r.status, 409); assert.match((await r.json()).message, /offline/i);
        assert.equal((await post(off.id, ops, "/defender/update")).status, 409);
        assert.equal((await post(lin.id, ops, "/defender/quick-scan")).status, 400);
        assert.equal((await post(w1.id, ops, "/defender/disable")).status, 400, "no action turns protection off");
        for (const bad of ["exclusions", "remove-threats", "update%20x", "..%2F..", "full-scan;calc"]) assert.equal((await post(w1.id, ops, `/defender/${bad}`)).status, 400, bad);
        assert.equal(seen.length, 0);
        assert.equal((await q(`SELECT count(*)::int AS n FROM device_security_scans WHERE device_id = ANY($1::uuid[])`, [[lin.id, mac.id, none.id, off.id]])).rows[0].n, 0, "nothing was recorded for them");
    });

    console.log("a scan");
    // the poller test starts now and is checked at the end: nobody reads this device's page in between
    const pollerDevice = w6;
    scenario.set(pollerDevice.id, { out: text(withProbes({})) });
    await test("POST scan queues one signed script job: fixed script text, only RIQ_TOOL in the environment, 90 second timeout", async () => {
        const r = await post(pollerDevice.id, ops, "/scan");
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.queued, true); assert.equal(j.alreadyWaiting, false); assert.ok(j.jobId);
        const job = (await q(`SELECT payload, type, status FROM jobs WHERE id = $1`, [j.jobId])).rows[0];
        assert.equal(job.type, "RUN_SCRIPT");
        assert.equal(job.payload.language, "powershell");
        assert.equal(job.payload.scriptText, S.SECURITY_SCAN_SCRIPT);
        assert.deepEqual(job.payload.env, { RIQ_TOOL: "security.scan" });
        assert.equal(job.payload.timeoutSec, 90);
        const row = (await q(`SELECT pending_job_id FROM device_security_scans WHERE device_id = $1`, [pollerDevice.id])).rows[0];
        assert.equal(row.pending_job_id, j.jobId);
    });
    await test("a second request while the first waits does not queue another (a device with a scan waiting is left alone)", async () => {
        scenario.set(w1.id, { mode: "never" });
        const a = await (await post(w1.id, ops, "/scan")).json();
        assert.equal(a.queued, true);
        const b = await (await post(w1.id, ops, "/scan")).json();
        assert.equal(b.alreadyWaiting, true); assert.equal(b.queued, false); assert.equal(b.jobId, a.jobId);
        assert.equal((await q(`SELECT count(*)::int AS n FROM jobs WHERE agent_id = $1`, [w1.agent])).rows[0].n, 1);
        const v = await view(w1.id);
        assert.equal(v.pending, true); assert.equal(v.state, "not_scanned"); assert.match(v.reason, /waiting for the device/);
    });
    await test("an unanswered scan is given up on after six minutes: the reason is kept and a new scan can be asked for", async () => {
        await q(`UPDATE device_security_scans SET pending_at = now() - interval '7 minutes' WHERE device_id = $1`, [w1.id]);
        const v = await view(w1.id);
        assert.equal(v.pending, false); assert.equal(v.lastAttemptFailed, true); assert.match(v.message, /did not answer/);
        const again = await (await post(w1.id, ops, "/scan")).json();
        assert.equal(again.queued, true, "a new scan is queued");
        await q(`UPDATE jobs SET status='timeout', finished_at=now() WHERE agent_id=$1 AND status='queued'`, [w1.agent]);
    });
    await test("a healthy PC: score 100, grade A, every rule with its result and its texts, the highlights, nothing capped", async () => {
        const v = await scanNow(w2);
        assert.equal(v.state, "scanned"); assert.equal(v.scan.score, 100); assert.equal(v.scan.grade, "A"); assert.equal(v.scan.capped, false);
        assert.equal(v.scan.rules.length, 28);
        for (const r of v.scan.rules) {
            assert.ok(["pass", "fail", "unknown", "not_applicable"].includes(r.result), r.id);
            assert.ok(r.title && r.checks && r.why && r.fix && r.detail, `${r.id} has all its texts`);
            assert.ok(["critical", "high", "medium", "low"].includes(r.severity));
        }
        assert.equal(v.scan.counts.fail, 0);
        assert.equal(v.scan.highlights.defender.label.tone, "good");
        assert.equal(v.scan.highlights.bitlocker.label.text, "On");
        assert.equal(v.scan.highlights.os.support.status, "supported");
        assert.ok(v.scannedAt && !v.stale);
        assert.equal(v.scan.unreadableText, null);
    });
    await test("the scan is stored for the device: the row has the score, counts and failed rule ids", async () => {
        const row = (await q(`SELECT * FROM device_security_scans WHERE device_id = $1`, [w2.id])).rows[0];
        assert.equal(row.score, 100); assert.equal(row.grade, "A"); assert.equal(row.ok, true); assert.equal(row.message, null);
        assert.equal(row.pending_job_id, null); assert.deepEqual(row.failed_rules, []); assert.equal(row.raw.v, 1);
        assert.equal(row.raw.probes.os.build, 26200);
    });
    await test("no antivirus: the critical failures cap the grade; rules are listed critical first; what could not be read is counted", async () => {
        const d = healthy().probes.defender;
        const o = withProbes({
            defender: { ...d, antivirusEnabled: false, realTimeProtection: false },
            securityCenter: { status: "ok", ms: 5, products: [{ name: "Windows Defender", state: 393216 }] },
            tpm: unknown("The TPM can only be read with administrator rights."),
            lastUpdate: unknown("No installed Windows update is recorded in the update history."),
        });
        const v = await scanNow(w3, o);
        assert.equal(v.scan.grade, "F"); assert.ok(v.scan.score <= 59); assert.equal(v.scan.capped, true); assert.ok(v.scan.uncappedScore > v.scan.score);
        assert.match(v.scan.capReason, /2 critical/);
        assert.equal(v.scan.failedBySeverity.critical, 2);
        assert.equal(v.scan.counts.unknown, 2);
        assert.equal(v.scan.unreadable, 2); assert.match(v.scan.unreadableText, /2 checks could not be read/);
        const sev = v.scan.rules.map((r) => r.severity);
        const order = ["critical", "high", "medium", "low"];
        assert.deepEqual([...sev].sort((a, b) => order.indexOf(a) - order.indexOf(b)), sev, "grouped by severity, worst first");
        assert.equal(v.scan.rules[0].result, "fail");
        const tpm = v.scan.rules.find((r) => r.id === "tpm.ready");
        assert.equal(tpm.result, "unknown"); assert.match(tpm.detail, /administrator rights/);
        assert.ok(v.scan.highlights.unreadable.some((u) => u.probe === "tpm"));
        const row = (await q(`SELECT * FROM device_security_scans WHERE device_id = $1`, [w3.id])).rows[0];
        assert.ok(row.failed_rules.includes("av.present") && row.failed_rules.includes("av.realtime"));
        assert.equal(row.critical_failed, 2); assert.equal(row.unknown_count, 2);
    });
    await test("another antivirus counts: a device with Sophos on and Defender passive is not flagged as unprotected", async () => {
        const d = healthy().probes.defender;
        const v = await scanNow(w4, withProbes({
            defender: { ...d, antivirusEnabled: false, realTimeProtection: false, runningMode: "Passive Mode", tamperProtected: false },
            securityCenter: { status: "ok", ms: 5, products: [{ name: "Windows Defender", state: 393216 }, { name: "Sophos Intercept X", state: 266240 }] },
        }));
        const by = Object.fromEntries(v.scan.rules.map((r) => [r.id, r]));
        assert.equal(by["av.present"].result, "pass"); assert.match(by["av.present"].detail, /Sophos/);
        assert.equal(by["av.realtime"].result, "pass");
        assert.equal(by["av.tamper"].result, "not_applicable");
        assert.equal(v.scan.score, 100); assert.equal(v.scan.grade, "A");
        assert.match(v.scan.highlights.defender.label.text, /Sophos/);
    });
    await test("firewall off on every profile and an active threat: D at best, with the threat names", async () => {
        const d = healthy().probes.defender;
        const v = await scanNow(w5, withProbes({
            firewall: { status: "ok", ms: 1, domain: false, private: false, public: false, serviceState: "Running" },
            defender: { ...d, threatCount: 2, threats: ["HackTool:Win32/Crack", "Trojan:Win32/Vigorf.A"] },
            bitlocker: { status: "ok", ms: 1, detail: false, systemDrive: "C:", note: "Detail not readable: Access denied", volumes: [{ drive: "C:", protection: "off", percent: null, method: null, state: null, protectors: [] }] },
        }));
        assert.equal(v.scan.grade, "F"); // two critical failures
        const th = v.scan.rules.find((r) => r.id === "av.threats");
        assert.equal(th.result, "fail"); assert.match(th.detail, /HackTool:Win32\/Crack/);
        assert.equal(v.scan.highlights.bitlocker.label.tone, "bad");
        assert.equal(v.scan.highlights.defender.threats.length, 2);
        assert.equal(v.scan.rules.find((r) => r.id === "bl.recovery").result, "not_applicable");
    });

    console.log("answers that cannot be trusted");
    await test("garbage, a failed script and a script that printed an error keep the last good result and say why", async () => {
        const good = await view(w2.id);
        for (const [n, sc, re] of [
            ["garbage", { out: "{ this is not json" }, /could not be read/],
            ["script error", { out: JSON.stringify({ ok: false, error: "Access is denied" }) }, /Access is denied/],
            ["nothing", { out: "" }, /printed nothing|nothing/i],
            ["wrong shape", { out: "[1,2,3]" }, /not a security scan/],
            ["a failed job", { mode: "fail", stderr: "The term 'foo' is not recognized" }, /not recognized/],
        ]) {
            scenario.set(w2.id, sc);
            await post(w2.id, ops, "/scan");
            let v;
            for (let i = 0; i < 40; i++) { v = await view(w2.id); if (!v.pending) break; await sleep(250); }
            assert.equal(v.lastAttemptFailed, true, n);
            assert.match(v.message, re, n);
            assert.equal(v.state, "scanned", `${n}: the last good result stays`);
            assert.equal(v.scan.score, good.scan.score);
            assert.equal(v.scannedAt, good.scannedAt, `${n}: scannedAt does not move on a failed try`);
            assert.ok(Date.parse(v.attemptedAt) >= Date.parse(good.attemptedAt));
        }
    });
    await test("a job that times out marks the attempt and keeps the last good result", async () => {
        scenario.set(w2.id, { mode: "never" });
        const j = await (await post(w2.id, ops, "/scan")).json();
        await sleep(400);
        await q(`UPDATE jobs SET status='timeout', finished_at=now() WHERE id=$1`, [j.jobId]);
        const v = await view(w2.id);
        assert.equal(v.pending, false); assert.equal(v.lastAttemptFailed, true); assert.match(v.message, /took too long/);
        assert.equal(v.scan.score, 100);
    });
    await test("hostile output: unknown fields are dropped, strange types make only that probe unknown, nothing secret is stored", async () => {
        const o = withProbes({});
        o.probes.bitlocker.volumes[0].protectors = ["TPM", "123456-234567-345678-456789-567890-678901-789012-890123", "{4F8E9A12-1111-2222-3333-444455556666}"];
        o.probes.bitlocker.volumes[0].recoveryPassword = "123456-234567-345678-456789-567890-678901-789012-890123";
        o.probes.autoLogon.defaultPassword = "hunter2";
        o.probes.defender.exclusions = ["C:\\Secret"];
        o.probes.uac.enabled = "yes";
        o.probes.os.productName = "Windows 11 Pro\u0000\u001b[31m<script>alert(1)</script>";
        o.probes.accounts.adminNames = Array.from({ length: 200 }, (_, i) => `PC\\user${i}`);
        const v = await scanNow(w2, JSON.stringify(o));
        assert.equal(v.state, "scanned");
        const raw = (await q(`SELECT raw::text AS t FROM device_security_scans WHERE device_id = $1`, [w2.id])).rows[0].t;
        for (const bad of ["hunter2", "Secret", "123456-234567", "4F8E9A12", "recoveryPassword", "defaultPassword"]) assert.ok(!raw.includes(bad), bad);
        const stored = JSON.parse(raw);
        assert.equal(stored.probes.uac.status, "unknown");
        assert.equal(stored.probes.accounts.adminNames.length, 20);
        assert.ok(!/[\u0000-\u001f]/.test(stored.probes.os.productName));
        assert.deepEqual(stored.probes.bitlocker.volumes[0].protectors, ["TPM"]);
        await scanNow(w2, text(healthy()));
    });

    console.log("Defender actions");
    await test("update signatures, quick scan and full scan are signed script jobs with only the scan type in the environment", async () => {
        let r = await post(w2.id, ops, "/defender/update");
        assert.equal(r.status, 200);
        let j = await r.json();
        assert.equal(j.pending, false); assert.equal(j.result.before, "1.463.311.0"); assert.equal(j.result.after, "1.463.330.0"); assert.equal(j.result.changed, true);
        let job = (await q(`SELECT payload FROM jobs WHERE id = $1`, [j.jobId])).rows[0].payload;
        assert.equal(job.scriptText, S.DEFENDER_SCRIPTS.update); assert.deepEqual(job.env, { RIQ_TOOL: "security.defender.update" });
        j = await (await post(w2.id, ops, "/defender/quick-scan")).json();
        assert.deepEqual(j.result, { scanType: "QuickScan", started: true });
        job = (await q(`SELECT payload FROM jobs WHERE id = $1`, [j.jobId])).rows[0].payload;
        assert.equal(job.scriptText, S.DEFENDER_SCRIPTS.scan); assert.deepEqual(job.env, { RIQ_TOOL: "security.defender.quick-scan", RIQ_SCAN_TYPE: "QuickScan" });
        j = await (await post(w2.id, ops, "/defender/full-scan")).json();
        assert.deepEqual(j.result, { scanType: "FullScan", started: true });
        job = (await q(`SELECT payload FROM jobs WHERE id = $1`, [j.jobId])).rows[0].payload;
        assert.deepEqual(job.env, { RIQ_TOOL: "security.defender.full-scan", RIQ_SCAN_TYPE: "FullScan" });
    });
    await test("a refused action (Defender not running) is a 409 with the device's own reason", async () => {
        scenario.set(w2.id, { out: JSON.stringify({ ok: false, error: "Microsoft Defender is not running on this device, so it cannot scan." }) });
        const r = await post(w2.id, ops, "/defender/quick-scan");
        assert.equal(r.status, 409); assert.match((await r.json()).message, /not running/);
        scenario.set(w2.id, { out: "{}" });
        assert.equal((await post(w2.id, ops, "/defender/full-scan")).status, 409, "an answer that does not say it started");
        scenario.set(w2.id, { mode: "fail", stderr: "Update-MpSignature: network unreachable" });
        const u = await post(w2.id, ops, "/defender/update");
        assert.equal(u.status, 409); assert.match((await u.json()).message, /network unreachable/);
    });
    console.log("Linux actions");
    const linOff = await mk(A.site, "linoff", "linux", 90);
    await test("turning on the firewall and the malware scan are fixed bash jobs with only the tool name in the environment, and need devices.actions", async () => {
        assert.equal((await post(lin.id, reader, "/linux/firewall-enable")).status, 403);
        assert.equal((await post(lin.id, nobody, "/linux/malware-scan")).status, 403);
        let r = await post(lin.id, ops, "/linux/firewall-enable");
        assert.equal(r.status, 200);
        let j = await r.json();
        assert.equal(j.pending, false); assert.equal(j.result.action, "firewall-enable"); assert.match(j.result.message, /ufw/);
        let job = (await q(`SELECT payload FROM jobs WHERE id = $1`, [j.jobId])).rows[0].payload;
        assert.equal(job.language, "bash"); assert.equal(job.scriptText, LA.LINUX_FIREWALL_ENABLE_SCRIPT); assert.deepEqual(job.env, { RIQ_TOOL: "security.linux.firewall-enable" });
        j = await (await post(lin.id, ops, "/linux/malware-scan")).json();
        assert.equal(j.result.state, "clean"); assert.equal(j.result.scannedFiles, 1200);
        job = (await q(`SELECT payload FROM jobs WHERE id = $1`, [j.jobId])).rows[0].payload;
        assert.equal(job.scriptText, LA.LINUX_MALWARE_SCAN_SCRIPT); assert.deepEqual(job.env, { RIQ_TOOL: "security.linux.malware-scan" });
    });
    await test("they are refused for a Windows device, an offline device and an action that does not exist", async () => {
        assert.equal((await post(w1.id, ops, "/linux/firewall-enable")).status, 400);
        assert.equal((await post(linOff.id, ops, "/linux/malware-scan")).status, 409);
        for (const bad of ["disable-firewall", "delete-infected", "..%2Fscan", "malware-scan;id"]) assert.equal((await post(lin.id, ops, `/linux/${bad}`)).status, 400, bad);
        assert.equal((await post(lin.id, ops, "/defender/update")).status, 400, "Defender actions stay Windows only");
    });
    await test("infected files are reported with their signature and path, a scanner error is an error result, a missing tool is a 409 with its own words", async () => {
        scenario.set(lin.id, { out: "R infected 99 7 1\nF Eicar-Test-Signature|/tmp/eicar.com" });
        let j = await (await post(lin.id, ops, "/linux/malware-scan")).json();
        assert.equal(j.result.state, "infected"); assert.equal(j.result.infectedCount, 1); assert.deepEqual(j.result.found, [{ signature: "Eicar-Test-Signature", path: "/tmp/eicar.com" }]);
        scenario.set(lin.id, { out: "E LibClamAV Error: No supported database files found" });
        j = await (await post(lin.id, ops, "/linux/malware-scan")).json();
        assert.equal(j.result.state, "error"); assert.match(j.result.message, /No supported database/);
        scenario.set(lin.id, { mode: "fail", stderr: "ClamAV is not installed. Install the clamav package from the Software tab, then run this again." });
        const r = await post(lin.id, ops, "/linux/malware-scan");
        assert.equal(r.status, 409); assert.match((await r.json()).message, /ClamAV is not installed/);
        scenario.set(lin.id, { out: "nonsense" });
        assert.equal((await post(lin.id, ops, "/linux/firewall-enable")).status, 409, "an answer that does not say the firewall is on");
    });
    await test("a long scan answers pending, and the job is read back later (only a Linux or Defender action job of this device)", async () => {
        scenario.set(lin.id, { delay: 28_000, out: "R clean 5 30 0" });
        const r = await (await post(lin.id, ops, "/linux/malware-scan")).json();
        assert.equal(r.pending, true); assert.ok(r.jobId);
        let g;
        for (let i = 0; i < 40; i++) { g = await (await get(lin.id, ops, `/jobs/${r.jobId}`)).json(); if (!g.pending) break; await sleep(500); }
        assert.equal(g.pending, false); assert.equal(g.action, "malware-scan"); assert.equal(g.result.state, "clean");
        assert.equal((await get(w1.id, ops, `/jobs/${r.jobId}`)).status, 404, "another device cannot read it");
    });
    await test("the audit trail names the Linux actions", async () => {
        const rows = (await q(`SELECT action FROM audit_events WHERE target_id = $1 AND action LIKE 'device.security.linux.%'`, [lin.id])).rows.map((x) => x.action);
        assert.ok(rows.includes("device.security.linux.firewall-enable") && rows.includes("device.security.linux.malware-scan"), JSON.stringify(rows));
    });

    await test("a slow device gives a pending answer; the page asks again (only for a Defender job of this device)", async () => {
        scenario.set(w2.id, { delay: 28_000 });
        const r = await (await post(w2.id, ops, "/defender/update")).json();
        assert.equal(r.pending, true); assert.ok(r.jobId);
        let again = await (await get(w2.id, ops, `/jobs/${r.jobId}`)).json();
        for (let i = 0; i < 20 && again.pending; i++) { await sleep(500); again = await (await get(w2.id, ops, `/jobs/${r.jobId}`)).json(); }
        assert.equal(again.pending, false); assert.equal(again.action, "update"); assert.equal(again.result.after, "1.463.330.0");
        assert.equal((await get(w3.id, ops, `/jobs/${r.jobId}`)).status, 404, "a job of another device");
        const scanJob = seen.find((s) => s.kind === "security.scan");
        assert.equal((await get(w2.id, ops, `/jobs/${scanJob.id}`)).status, 404, "a scan job is not a Defender job");
        const plain = (await q(`INSERT INTO jobs (agent_id, type, payload, status) VALUES ($1,'RUN_SCRIPT','{"env":{}}','succeeded') RETURNING id`, [w2.agent])).rows[0].id;
        assert.equal((await get(w2.id, ops, `/jobs/${plain}`)).status, 404);
        assert.equal((await get(w2.id, ops, `/jobs/${uuid()}`)).status, 404);
        assert.equal((await get(w2.id, ops, `/jobs/nope`)).status, 404);
    });

    console.log("the customer limit");
    await test("a person limited to customer A gets not found for another customer's device, on every route, and no job is created", async () => {
        const before = seen.length;
        assert.equal((await get(other.id, limited)).status, 404);
        assert.equal((await post(other.id, limited, "/scan")).status, 404);
        for (const a of ["update", "quick-scan", "full-scan"]) assert.equal((await post(other.id, limited, `/defender/${a}`)).status, 404, a);
        assert.equal((await get(other.id, limited, `/jobs/${uuid()}`)).status, 404);
        assert.equal(seen.length, before);
        assert.equal((await q(`SELECT count(*)::int AS n FROM jobs WHERE agent_id = $1`, [other.agent])).rows[0].n, 0);
        assert.equal((await get(w2.id, limited)).status, 200);
    });

    console.log("the fleet");
    // 30 Windows devices of the paging customer with scores 0, 3, 6 ... 87, a few with the same score, plus one never scanned
    const probesObj = S.parseSecurityScan(text(healthy()), "");
    const paged = [];
    for (let i = 0; i < 30; i++) {
        const d = await mk(P.site, `p${String(i).padStart(2, "0")}`, "windows");
        const score = i < 3 ? 40 : i * 3;
        const grade = B.gradeFor(score);
        await q(`INSERT INTO device_security_scans (device_id, scanned_at, attempted_at, ok, raw, score, grade, critical_failed, high_failed, unknown_count, failed_rules) VALUES ($1, now() - ($2 || ' hours')::interval, now(), true, $3::jsonb, $4, $5, $6, $7, 0, $8)`,
            [d.id, String(i), JSON.stringify(probesObj), score, grade, i % 4 === 0 ? 1 : 0, i % 3, i % 4 === 0 ? ["av.present", "uac.on"] : ["uac.on"]]);
        paged.push({ ...d, i, score, grade });
    }
    const never = await mk(P.site, "never", "windows");
    const pLin = await mk(P.site, "pmac", "mac");
    const fleet = async (qs, t = reader) => { const r = await call(`/api/security/fleet?${qs}`, { token: t.token }); return { status: r.status, body: await r.json() }; };
    await test("one row per Windows or Linux device (macOS is not listed), with the score, grade, failed counts and the summaries", async () => {
        const { status, body } = await fleet(`clientId=${P.id}&limit=200`);
        assert.equal(status, 200);
        assert.equal(body.total, 31); assert.equal(body.items.length, 31);
        assert.ok(!body.items.some((x) => x.deviceId === pLin.id));
        const row = body.items.find((x) => x.deviceId === paged[29].id);
        assert.equal(row.score, 87); assert.equal(row.grade, "B"); assert.equal(row.customer, P.name); assert.equal(row.online, true); assert.equal(row.hasAgent, true);
        assert.equal(row.criticalFailed, 0); assert.equal(row.highFailed, 29 % 3);
        assert.equal(row.defender.tone, "good"); assert.equal(row.bitlocker.text, "On"); assert.equal(row.firewall.text, "On");
        const nv = body.items.find((x) => x.deviceId === never.id);
        assert.equal(nv.score, null); assert.equal(nv.grade, null); assert.equal(nv.scannedAt, null); assert.equal(nv.defender, null);
    });
    await test("server-side paging: limit, offset and total; worst first with devices that were never scanned last; stable ties", async () => {
        const all = (await fleet(`clientId=${P.id}&limit=200`)).body.items;
        const scores = all.map((x) => x.score);
        const scored = scores.filter((s) => s !== null);
        assert.deepEqual([...scored].sort((a, b) => a - b), scored, "ascending score");
        assert.equal(scores[scores.length - 1], null, "never scanned is last");
        assert.equal(scores[0], 9, "devices 0 to 2 have 40, the lowest score is device 3 with 9");
        const p1 = (await fleet(`clientId=${P.id}&limit=10&offset=0`)).body;
        const p2 = (await fleet(`clientId=${P.id}&limit=10&offset=10`)).body;
        const p4 = (await fleet(`clientId=${P.id}&limit=10&offset=30`)).body;
        assert.equal(p1.total, 31); assert.equal(p1.items.length, 10); assert.equal(p2.items.length, 10); assert.equal(p4.items.length, 1);
        assert.deepEqual([...p1.items, ...p2.items].map((x) => x.deviceId), all.slice(0, 20).map((x) => x.deviceId), "pages join up with no repeat or gap");
        assert.equal((await fleet(`clientId=${P.id}&limit=10&offset=100`)).body.items.length, 0);
    });
    await test("sorting: best, name, customer, scanned (oldest first), critical", async () => {
        const best = (await fleet(`clientId=${P.id}&sort=best&limit=5`)).body.items.map((x) => x.score);
        assert.deepEqual(best, [87, 84, 81, 78, 75]);
        const name = (await fleet(`clientId=${P.id}&sort=name&limit=200`)).body.items.map((x) => x.name);
        assert.deepEqual([...name].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), name);
        const scanned = (await fleet(`clientId=${P.id}&sort=scanned&limit=3`)).body.items;
        assert.equal(scanned[0].deviceId, never.id, "never scanned first");
        assert.equal(scanned[1].deviceId, paged[29].id, "then the oldest scan (29 hours ago)");
        const crit = (await fleet(`clientId=${P.id}&sort=critical&limit=3`)).body.items;
        assert.ok(crit.every((x) => x.criticalFailed === 1));
        assert.equal((await fleet(`sort=sideways`)).status, 400);
    });
    await test("filters: grade (including none), text on name and customer, customer", async () => {
        const f = (await fleet(`clientId=${P.id}&grade=F&limit=200`)).body;
        assert.ok(f.total > 0 && f.items.every((x) => x.grade === "F"));
        assert.equal(f.total, paged.filter((x) => x.grade === "F").length);
        const n = (await fleet(`clientId=${P.id}&grade=none`)).body;
        assert.equal(n.total, 1); assert.equal(n.items[0].deviceId, never.id);
        const t = (await fleet(`q=${encodeURIComponent(`${tag}-p07`)}`)).body;
        assert.equal(t.total, 1); assert.equal(t.items[0].deviceId, paged[7].id);
        const byCustomer = (await fleet(`q=${encodeURIComponent(`${tag} Paging`)}&limit=200`)).body;
        assert.equal(byCustomer.total, 31);
        const wild = (await fleet(`q=${encodeURIComponent("%")}`)).body;
        assert.equal(wild.total, 0, "a percent sign is text, not a wildcard");
        const un = (await fleet(`q=${encodeURIComponent("_")}`)).body;
        assert.equal(un.total, 0);
        assert.equal((await fleet(`grade=Z`)).status, 400);
        assert.equal((await fleet(`clientId=nope`)).status, 400);
        assert.equal((await fleet(`limit=201`)).status, 400);
        assert.equal((await fleet(`limit=0`)).status, 400);
        assert.equal((await fleet(`offset=-1`)).status, 400);
        assert.equal((await fleet(`q=${"x".repeat(150)}`)).status, 400);
    });
    await test("the customer limit applies to the fleet and the summary: a limited person sees only their customers", async () => {
        const mine = (await fleet(`limit=200&q=${encodeURIComponent(tag)}`, limited)).body;
        assert.ok(mine.total >= 6);
        assert.ok(mine.items.every((x) => x.clientId === A.id), "only customer A");
        assert.equal((await fleet(`clientId=${P.id}`, limited)).body.total, 0);
        assert.equal((await fleet(`clientId=${B_.id}`, limited)).body.total, 0);
        const sum = await (await call(`/api/security/summary?clientId=${P.id}`, { token: limited.token })).json();
        assert.equal(sum.windowsDevices, 0);
        const all = (await fleet(`limit=200&q=${encodeURIComponent(tag)}`)).body;
        assert.ok(all.items.some((x) => x.clientId === B_.id));
    });
    await test("the summary: devices per grade, never scanned, the top failing rules with device counts", async () => {
        const r = await call(`/api/security/summary?clientId=${P.id}`, { token: reader.token });
        assert.equal(r.status, 200);
        const s = await r.json();
        assert.equal(s.windowsDevices, 31); assert.equal(s.withAgent, 31); assert.equal(s.noAgent, 0);
        assert.equal(s.neverScanned, 1); assert.equal(s.scanned, 30);
        const expected = {};
        for (const d of paged) expected[d.grade] = (expected[d.grade] ?? 0) + 1;
        for (const g of ["A", "B", "C", "D", "F"]) assert.equal(s.grades[g], expected[g] ?? 0, g);
        assert.equal(s.grades.none, 1);
        assert.equal(s.topFailingRules[0].id, "uac.on"); assert.equal(s.topFailingRules[0].devices, 30);
        assert.equal(s.topFailingRules[0].severity, "high"); assert.ok(s.topFailingRules[0].title);
        const av = s.topFailingRules.find((x) => x.id === "av.present");
        assert.equal(av.devices, paged.filter((d) => d.i % 4 === 0).length); assert.equal(av.severity, "critical");
        assert.equal(s.devicesWithCriticalFailures, paged.filter((d) => d.i % 4 === 0).length);
        assert.equal(s.averageScore, Math.round(paged.reduce((a, d) => a + d.score, 0) / 30));
        const whole = await (await call(`/api/security/summary`, { token: reader.token })).json();
        assert.ok(whole.windowsDevices >= 31 + 7, "devices of other customers are counted without a filter");
        assert.equal((await call(`/api/security/summary?clientId=nope`, { token: reader.token })).status, 400);
    });
    await test("a device with no agent is a row with hasAgent false and is not counted as never scanned", async () => {
        const { body } = await fleet(`q=${encodeURIComponent(`${tag}-none`)}`);
        assert.equal(body.total, 1); assert.equal(body.items[0].hasAgent, false); assert.equal(body.items[0].online, false);
        const s = await (await call(`/api/security/summary?clientId=${A.id}`, { token: reader.token })).json();
        assert.equal(s.noAgent, 1);
    });

    console.log("the bulk action");
    const bulk = (ids, t = ops) => call(`/api/bulk/devices/security-scan`, { method: "POST", token: t.token, body: { deviceIds: ids } });
    await test("a bulk security scan answers per device: queued, skipped with a reason, and nothing for another customer's device", async () => {
        scenario.set(w4.id, { mode: "never" });
        assert.equal((await post(w4.id, ops, "/scan")).status, 200, "w4 now has a scan waiting");
        const ids = [w5.id, lin.id, none.id, off.id, other.id, mac.id, w4.id, uuid()];
        const jobsBefore = (await q(`SELECT count(*)::int AS n FROM jobs WHERE agent_id = ANY($1::uuid[])`, [[w5, lin, none, off, other, mac].map((d) => d.agent).filter(Boolean)])).rows[0].n;
        const r = await bulk(ids, limited);
        assert.equal(r.status, 200);
        const b = await r.json();
        const item = (id) => b.items.find((i) => i.deviceId === id);
        assert.equal(item(w5.id).status, "queued");
        assert.equal(item(w4.id).status, "skipped"); assert.match(item(w4.id).reason, /already waiting/);
        assert.equal(item(lin.id).status, "queued", "an online Linux device is scanned too");
        assert.equal(item(none.id).status, "skipped"); assert.match(item(none.id).reason, /no agent/i);
        assert.equal(item(off.id).status, "skipped"); assert.match(item(off.id).reason, /offline/i);
        assert.equal(item(mac.id).status, "skipped");
        assert.equal(item(other.id).status, "failed"); assert.match(item(other.id).reason, /not found/i);
        assert.equal(item(ids[ids.length - 1]).status, "failed");
        assert.equal(b.succeeded, 2);
        const jobsAfter = (await q(`SELECT count(*)::int AS n FROM jobs WHERE agent_id = ANY($1::uuid[])`, [[w5, lin, none, off, other, mac].map((d) => d.agent).filter(Boolean)])).rows[0].n;
        assert.equal(jobsAfter - jobsBefore, 2, "only the two valid devices got a job");
        assert.equal((await q(`SELECT count(*)::int AS n FROM jobs WHERE agent_id = $1`, [other.agent])).rows[0].n, 0);
    });
    await test("a device whose scan is already waiting is left alone; rights; limits", async () => {
        const again = await (await bulk([w4.id])).json();
        assert.equal(again.items[0].status, "skipped"); assert.match(again.items[0].reason, /already waiting/);
        assert.equal((await bulk([w4.id], reader)).status, 403);
        assert.equal((await bulk([w4.id], nobody)).status, 403);
        assert.equal((await call(`/api/bulk/devices/security-scan`, { method: "POST", token: ops.token, body: {} })).status, 400);
        assert.equal((await call(`/api/bulk/devices/security-scan`, { method: "POST", token: ops.token, body: { deviceIds: ["nope"] } })).status, 400);
        assert.equal((await bulk(Array.from({ length: 501 }, () => uuid()))).status, 400);
    });
    await test("up to 500 devices in one batch, each with its own result", async () => {
        const many = [...paged.slice(0, 20).map((d) => d.id), ...Array.from({ length: 480 }, () => uuid())];
        const r = await bulk(many);
        assert.equal(r.status, 200);
        const b = await r.json();
        assert.equal(b.requested, 500); assert.equal(b.items.length, 500);
        assert.equal(b.succeeded, 20); assert.equal(b.failed, 480);
    });

    console.log("the report");
    await test("the Security posture report lists every Windows device with score, grade, failed critical checks and the summaries; exports to CSV", async () => {
        const cat = await (await call(`/api/reports/catalog`, { token: reader.token })).json().catch(() => null);
        const r = await call(`/api/reports/run/security-posture?clientId=${A.id}`, { token: reader.token });
        assert.equal(r.status, 200, `status ${r.status}`);
        const body = await r.json();
        const rows = body.rows ?? body.items ?? [];
        const byName = Object.fromEntries(rows.map((x) => [x.name, x]));
        const w3row = byName[`${tag}-w3`];
        assert.ok(w3row, JSON.stringify([Object.keys(body), rows.length, rows.slice(0, 2)]).slice(0, 600));
        assert.equal(w3row.grade, "F"); assert.equal(w3row.criticalFailed, 2); assert.match(w3row.failedChecks, /Antivirus protection is on \(critical\)/);
        assert.equal(byName[`${tag}-w2`].grade, "A");
        assert.equal(byName[`${tag}-w1`].grade, "Not scanned", "a device that was never scanned is listed as such");
        assert.ok(!byName[`${tag}-none`], "a device with no agent cannot be scanned and is not listed");
        assert.ok(byName[`${tag}-lin`], "Linux is listed");
        assert.ok(!byName[`${tag}-mac`], "macOS is not listed");
        assert.equal(rows[0].grade, "F", "worst first");
        const csv = await call(`/api/reports/run/security-posture?clientId=${A.id}&format=csv`, { token: reader.token });
        assert.equal(csv.status, 200); assert.match(csv.headers.get("content-type"), /text\/csv/);
        const t = Buffer.from(await csv.arrayBuffer()).toString("utf8");
        assert.ok(t.includes(`${tag}-w3`) && /Antivirus/.test(t));
        void cat;
    });
    await test("a limited person's report holds only their customers", async () => {
        const r = await call(`/api/reports/run/security-posture`, { token: limited.token });
        if (r.status !== 200) return; // the reports right is not part of this check
        const body = await r.json();
        const rows = body.rows ?? [];
        assert.ok(rows.every((x) => x.customer === A.name));
    });

    console.log("the poller");
    await test("a scan nobody opened is read back by the poller within about 20 seconds", async () => {
        let row;
        for (let i = 0; i < 100; i++) {
            row = (await q(`SELECT * FROM device_security_scans WHERE device_id = $1`, [pollerDevice.id])).rows[0];
            if (!row.pending_job_id) break;
            await sleep(500);
        }
        assert.equal(row.pending_job_id, null, "the poller read it back");
        assert.equal(row.score, 100); assert.equal(row.ok, true); assert.ok(row.scanned_at);
    });

    console.log("audit");
    await test("every scan, Defender action and bulk scan is audited, with the outcome, and no scan data", async () => {
        await sleep(600);
        const ev = (await q(`SELECT action, outcome, details, target_id FROM audit_events WHERE action LIKE 'device.security.%' OR action = 'device.bulk.security-scan' ORDER BY created_at`)).rows;
        const actions = new Set(ev.map((e) => e.action));
        for (const a of ["device.security.scan", "device.security.defender.update", "device.security.defender.quick-scan", "device.security.defender.full-scan", "device.bulk.security-scan"]) assert.ok(actions.has(a), a);
        assert.ok(ev.some((e) => e.action === "device.security.scan" && e.outcome === "failure"), "a refused scan is recorded as a failure");
        assert.ok(ev.some((e) => e.action === "device.security.defender.quick-scan" && e.outcome === "failure"));
        assert.ok(ev.some((e) => e.action === "device.security.scan" && e.outcome === "success" && e.target_id === w2.id));
        const blob = JSON.stringify(ev.map((e) => e.details));
        for (const bad of ["probes", "signatureVersion", "1.463.3", "adminNames", "Sophos", "HackTool", "RecoveryPassword", "hunter2"]) assert.ok(!blob.includes(bad), `no ${bad} in the audit trail`);
        const bulkEv = ev.find((e) => e.action === "device.bulk.security-scan");
        assert.equal(bulkEv.details.devices, 8);
        assert.equal((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'device.security.scan' AND target_id = $1`, [other.id])).rows[0].n, 0, "nothing for a device the person could not see");
    });

    clearInterval(timer);
    await q(`DELETE FROM device_security_scans WHERE device_id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM bulk_batches WHERE summary LIKE 'Run a security scan on%'`);
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
