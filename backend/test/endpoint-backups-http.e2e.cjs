#!/usr/bin/env node
// Backup status of customers' computers through the real HTTP API and a real database, with a fake agent that answers the check jobs:
// off until turned on, the schedule starting checks by itself, each outcome (protected, no backup, failing, unreadable answer, offline),
// alerts that raise and clear, the customer limit, changed thresholds, and the customer's backup report (JSON and spreadsheet).
// The backend must run with ENDPOINT_BACKUPS_POLLING left on (the schedule is tried first).
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3977 DATABASE_URL=postgres://.../riq_backup_e2e JWT_SECRET=... node test/endpoint-backups-http.e2e.cjs
"use strict";
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `EB${Date.now()}`;
    const admin = await staffUser("eb-admin", ["settings.read", "settings.write", "devices.read", "devices.actions", "alerts.read"]);
    const reader = await staffUser("eb-reader", ["devices.read"]);
    const limited = await staffUser("eb-limited", ["devices.read", "devices.actions"]);
    const nobody = await staffUser("eb-nobody", ["tickets.read"]);

    const mkClient = async (n) => { const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id; made.clients.push(id); const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id; return { id, site }; };
    const A = await mkClient("Alpha"), B = await mkClient("Bravo");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const mk = async (c, host, os = "windows", online = true) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [c.site, `${tag}-${host}`, os === "windows" ? "Windows 11" : "Ubuntu 24.04"])).rows[0].id;
        const agent = uuid();
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.39', now() - ($4 || ' minutes')::interval, $5)`, [agent, id, uuid(), online ? "0" : "300", JSON.stringify({ os })]);
        return { id, agent, os };
    };
    const w1 = await mk(A, "w1"), l1 = await mk(A, "l1", "linux"), off = await mk(A, "off", "windows", false), b1 = await mk(B, "b1");
    const all = [w1, l1, off, b1];

    // the fake agent: answers the backup check jobs (found by their text) with whatever the scenario says for that device
    const scenario = new Map();           // device id -> () => ({ stdout, stderr?, status? }) ; default is "nothing found"
    const handled = new Set();
    const hours = (h) => new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
    const line = (p, k, s, a, st, d = "") => `P|${p}|${k}|${s}|${a}|${st}|${d}`;
    const ok = (h) => line("Windows Backup", "image", hours(h), hours(h), "ok");
    const finish1 = async (id, stdout, stderr = "", status = "succeeded") => {
        await q(`UPDATE jobs SET status=$2, finished_at=now() WHERE id=$1`, [id, status]);
        await q(`INSERT INTO job_results (job_id, exit_code, stdout, stderr) VALUES ($1,$2,$3,$4) ON CONFLICT (job_id) DO NOTHING`, [id, status === "succeeded" ? 0 : 1, stdout, stderr]);
    };
    const timer = setInterval(async () => {
        try {
            const rows = (await q(`SELECT j.id, j.payload, a.device_id FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.status = 'queued' AND a.device_id = ANY($1::uuid[])`, [all.map((d) => d.id)])).rows;
            for (const r of rows) {
                if (!/D\|ok/.test(r.payload?.scriptText ?? "") || handled.has(r.id)) continue;
                handled.add(r.id);
                const s = (scenario.get(r.device_id) ?? (() => ({ stdout: "D|ok\n" })))();
                if (s.never) continue;
                await finish1(r.id, s.stdout, s.stderr ?? "", s.status ?? "succeeded");
            }
        } catch { /* next tick */ }
    }, 150);

    const G = (p, t = reader) => call(`/api/endpoint-backups${p}`, { token: t?.token });
    const S = (method, p, body, t = admin) => call(`/api/endpoint-backups${p}`, { method, token: t?.token, body });
    const list = async (qs = "", t = reader) => { const r = await G(qs, t); assert.equal(r.status, 200, `${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`); return r.json(); };
    const item = (data, d) => data.items.find((i) => i.deviceId === d.id);
    const waitFor = async (d, pred, t = reader) => { for (let i = 0; i < 100; i++) { const it = item(await list("", t), d); if (it && pred(it)) return it; await sleep(250); } throw new Error(`the computer never got there: ${JSON.stringify(item(await list("", t), d))}`); };
    const alertOf = async (d) => (await q(`SELECT state, severity, kind, title FROM alerts WHERE dedupe_key=$1 ORDER BY first_seen_at DESC LIMIT 1`, [`backup:${d.id}`])).rows[0];
    const checkNow = (body, t = admin) => S("POST", "/check", body, t);
    const runCheck = async (d, outcome) => { scenario.set(d.id, outcome); const before = (await q(`SELECT requested_at FROM endpoint_backup_checks WHERE device_id=$1`, [d.id])).rows[0]; const r = await checkNow({ deviceId: d.id }); assert.equal(r.status, 200, JSON.stringify(await r.clone().json())); return waitFor(d, (it) => !it.checking && it.checkedAt && (!before || true)); };

    console.log("off until it is turned on");
    await test("who may do what: reading needs devices.read; checking devices.actions; the settings settings.write", async () => {
        assert.equal((await G("", nobody)).status, 403); assert.equal((await call("/api/endpoint-backups")).status, 401);
        assert.equal((await S("POST", "/check", { deviceId: w1.id }, reader)).status, 403);
        assert.equal((await S("PUT", "/settings", { enabled: true }, reader)).status, 403); assert.equal((await G("/settings", reader)).status, 403);
    });
    await test("it is off by default: the list says so, nothing is checked, and a check is refused with the reason", async () => {
        const d = await list(); assert.equal(d.settings.enabled, false); assert.equal(d.summary.unchecked, d.summary.total);
        const r = await checkNow({ deviceId: w1.id }); assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /turned off/);
        assert.equal((await q(`SELECT count(*)::int AS n FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE a.device_id = ANY($1::uuid[])`, [all.map((x) => x.id)])).rows[0].n, 0, "a job was made while it was off");
    });
    await test("settings are checked: ages, how often, and failing has to be longer than warning", async () => {
        for (const body of [{ enabled: "yes" }, { warnHours: 0 }, { checkHours: 500 }, { warnHours: 200 }, { failHours: 48 }]) assert.equal((await S("PUT", "/settings", body)).status, 400, JSON.stringify(body));
        assert.equal((await (await G("/settings", admin)).json()).enabled, false);
    });

    console.log("the schedule");
    await test("turned on, the schedule checks the online computers by itself and leaves the offline one alone", async () => {
        const r = await S("PUT", "/settings", { enabled: true, checkHours: 168 }); assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
        const deadline = Date.now() + 130_000;
        while (Date.now() < deadline) { const n = (await q(`SELECT count(*)::int AS n FROM endpoint_backup_checks WHERE device_id = ANY($1::uuid[])`, [[w1.id, l1.id, b1.id]])).rows[0].n; if (n === 3) break; await sleep(3000); }
        const d = await list();
        for (const x of [w1, l1, b1]) { const it = await waitFor(x, (i) => !i.checking && i.checkedAt); assert.equal(it.overall, "none", `${x.os}: ${JSON.stringify(it)}`); }
        assert.equal((await q(`SELECT count(*)::int AS n FROM endpoint_backup_checks WHERE device_id=$1`, [off.id])).rows[0].n, 0, "an offline computer was checked");
        assert.ok(d.summary.total >= 4);
    });

    console.log("the outcomes");
    await test("a computer with a recent Windows Backup is ok, shows when it last worked and what protects it, and has no alert", async () => {
        const it = await runCheck(w1, () => ({ stdout: [ok(5), line("Windows restore points (shadow copies)", "snapshot", hours(3), hours(3), "ok", "4 restore points"), "D|ok"].join("\n") }));
        assert.equal(it.overall, "ok"); assert.match(it.detail, /Windows Backup: Last success 5 hours ago/); assert.ok(Math.abs(Date.parse(it.lastSuccessAt) - (Date.now() - 3 * 3_600_000)) < 120_000, "the newest success of any product is shown");
        assert.deepEqual(it.products.map((p) => p.product).sort(), ["Windows Backup", "Windows restore points (shadow copies)"]);
        const a = await alertOf(w1); assert.ok(!a || a.state === "RESOLVED", JSON.stringify(a));
    });
    await test("a computer with nothing at all raises a warning alert, and the alert clears when a backup shows up", async () => {
        const it = await runCheck(l1, () => ({ stdout: "D|ok\n" }));
        assert.equal(it.overall, "none"); assert.match(it.detail, /No backup software or restore points/);
        let a = await alertOf(l1); assert.ok(a && a.state !== "RESOLVED" && a.kind === "backup" && a.severity === "WARN" && /has no backup/.test(a.title), JSON.stringify(a));
        const fixed = await runCheck(l1, () => ({ stdout: [line("restic", "agent", "", "", "unknown", "the program is installed"), line("ZFS snapshots", "snapshot", hours(2), hours(2), "ok", "9 snapshots"), "D|ok"].join("\n") }));
        assert.equal(fixed.overall, "warning", JSON.stringify(fixed)); assert.match(fixed.detail, /own disk/);
        a = await alertOf(l1); assert.equal(a.state, "RESOLVED");
    });
    await test("a failing backup is a problem with a critical alert; a good one afterwards clears it", async () => {
        const bad = await runCheck(w1, () => ({ stdout: [line("Windows Backup", "image", hours(24 * 10), hours(2), "failed", "The backup could not write to the destination"), "D|ok"].join("\n") }));
        assert.equal(bad.overall, "failed"); assert.match(bad.detail, /last attempt failed \(The backup could not write/);
        let a = await alertOf(w1); assert.ok(a && a.state !== "RESOLVED" && a.severity === "CRIT" && /Backup is failing/.test(a.title), JSON.stringify(a));
        const good = await runCheck(w1, () => ({ stdout: [ok(1), "D|ok"].join("\n") })); assert.equal(good.overall, "ok");
        a = await alertOf(w1); assert.equal(a.state, "RESOLVED");
    });
    await test("backup software that shows nothing is unknown: not a problem, and no alert", async () => {
        const it = await runCheck(b1, () => ({ stdout: [line("Veeam Agent", "agent", "", "", "unknown", "Its service is running. Its results are in its own console."), "D|ok"].join("\n") }));
        assert.equal(it.overall, "unknown"); assert.match(it.detail, /Veeam Agent found/);
        const a = await alertOf(b1); assert.ok(!a || a.state === "RESOLVED");
    });
    await test("an answer that is not a report, an error line, a failed script and a script that never finished are shown as a problem with the check, and keep the last verdict", async () => {
        const before = item(await list(), w1);
        for (const [name, outcome, re] of [
            ["garbage", { stdout: "hello world" }, /did not finish/], ["error", { stdout: "E|Access is denied\nD|ok" }, /Access is denied/],
            ["bad kind", { stdout: "P|x|tape|||ok|\nD|ok" }, /unknown kind/], ["failed", { stdout: "", stderr: "boom", status: "failed" }, /did not finish/],
        ]) {
            scenario.set(w1.id, () => outcome);
            assert.equal((await checkNow({ deviceId: w1.id })).status, 200);
            const it = await waitFor(w1, (i) => !i.checking && i.problem);
            assert.match(it.problem, re, name); assert.equal(it.overall, before.overall, `${name}: the verdict changed`);
        }
        scenario.set(w1.id, () => ({ stdout: [ok(1), "D|ok"].join("\n") })); assert.equal((await checkNow({ deviceId: w1.id })).status, 200); const back = await waitFor(w1, (i) => !i.checking && !i.problem); assert.equal(back.overall, "ok");
    });
    await test("an offline computer is skipped, not blamed; a check of a customer starts only the online ones", async () => {
        const r = await checkNow({ clientId: A.id }); assert.equal(r.status, 200); const body = await r.json();
        assert.equal(body.offline, 1); assert.equal(body.started, 2); assert.equal(body.total, 3);
        assert.equal((await checkNow({})).status, 400); assert.equal((await checkNow({ deviceId: uuid() })).status, 404);
        await waitFor(w1, (i) => !i.checking); await waitFor(l1, (i) => !i.checking);
    });

    console.log("who sees what, thresholds and the report");
    await test("a limited person sees only their customer's computers and cannot check or report on another's", async () => {
        const d = await list("", limited); const ids = d.items.map((i) => i.deviceId);
        assert.ok(ids.includes(w1.id) && ids.includes(l1.id) && !ids.includes(b1.id), JSON.stringify(ids));
        assert.equal((await checkNow({ deviceId: b1.id }, limited)).status, 404);
        const r = await G(`/report?clientId=${B.id}`, limited); assert.equal(r.status, 200); assert.equal((await r.json()).items.length, 0);
        assert.equal((await list(`?clientId=${B.id}`, limited)).items.length, 0);
    });
    await test("filters: by customer, by status and by name", async () => {
        const a = await list(`?clientId=${A.id}`); assert.ok(a.items.every((i) => i.clientId === A.id) && a.items.length === 3);
        const s = await list(`?status=ok`); assert.ok(s.items.length >= 1 && s.items.every((i) => i.overall === "ok"));
        const n = await list(`?q=${encodeURIComponent(`${tag}-l1`)}`); assert.equal(n.items.length, 1); assert.equal(n.items[0].deviceId, l1.id);
        assert.equal((await list(`?status=unchecked`)).items.every((i) => i.overall === null), true);
    });
    await test("a changed warning age re-judges what the computers said (a success 1 hour old now warns), without asking them again", async () => {
        const before = (await q(`SELECT count(*)::int AS n FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE a.device_id=$1`, [w1.id])).rows[0].n;
        assert.equal((await S("PUT", "/settings", { warnHours: 1, failHours: 2 })).status, 200);
        const it = item(await list(), w1); assert.equal(it.overall, "warning", JSON.stringify(it)); assert.match(it.detail, /Last success 1 hours ago/);
        assert.equal(item(await list(), b1).overall, "unknown", "software that shows nothing stays unknown");
        assert.equal((await q(`SELECT count(*)::int AS n FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE a.device_id=$1`, [w1.id])).rows[0].n, before, "a job was made");
        assert.equal((await S("PUT", "/settings", { warnHours: 48, failHours: 168 })).status, 200);
        assert.equal(item(await list(), w1).overall, "ok");
    });
    await test("the customer's backup report: a summary, a line per computer, as JSON and as a spreadsheet that cannot run formulas", async () => {
        await q(`UPDATE devices SET hostname = $2 WHERE id = $1`, [l1.id, `=cmd|' /C calc'!A0`]);
        const r = await G(`/report?clientId=${A.id}`, admin); assert.equal(r.status, 200); const rep = await r.json();
        assert.equal(rep.customer, `${tag} Alpha`); assert.equal(rep.items.length, 3); assert.equal(rep.summary.total, 3);
        assert.equal(rep.summary.checked, 2); assert.equal(rep.summary.protectedPercent, Math.round((100 * rep.summary.ok) / rep.summary.checked)); assert.deepEqual(rep.thresholds, { warnHours: 48, failHours: 168 });
        const row = rep.items.find((i) => i.computer.endsWith("w1")); assert.equal(row.status, "ok"); assert.equal(row.attention, false);
        const csv = await G(`/report?clientId=${A.id}&format=csv`, admin); assert.equal(csv.status, 200);
        assert.match(csv.headers.get("content-type"), /text\/csv/); assert.match(csv.headers.get("content-disposition"), new RegExp(`filename="backup-report-${tag.toLowerCase()}-alpha-\\d{4}-\\d{2}-\\d{2}\\.csv"`));
        const text = await csv.text(); const lines = text.trim().split("\r\n");
        assert.equal(lines.length, 4); assert.match(lines[0], /^"Customer","Site","Computer","System","Backup status"/);
        assert.ok(!/(^|,)"=cmd/.test(text), "a formula reached the spreadsheet"); assert.ok(text.includes(`"'=cmd`), "the formula was not made harmless");
        const reader2 = await G(`/report?format=csv`, reader); assert.equal(reader2.status, 200);
    });

    clearInterval(timer);
    await q(`DELETE FROM alerts WHERE dedupe_key LIKE 'backup:%' AND device_id = ANY($1::uuid[])`, [all.map((d) => d.id)]);
    await q(`DELETE FROM endpoint_backup_settings WHERE organization_id=$1`, [org]);
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
