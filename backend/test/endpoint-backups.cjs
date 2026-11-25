// Backup status of customers' computers, the rules alone (no database, no network): what a device's report may say, how a product and a whole
// computer are judged, and the settings. Then the two scripts that read it: the Windows one RUN FOR REAL on this machine (Windows PowerShell),
// the Linux one in Debian with stand-ins for zfs, timeshift and a backup tool. Run after a build: node test/endpoint-backups.cjs
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "endpoint-backups");
const C = require(path.join(dist, "backup.core.js"));
const S = require(path.join(dist, "backup.scripts.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const refused = (fn, re) => { try { fn(); } catch (e) { const m = JSON.stringify(e.response ?? e.message); if (re && !re.test(m)) throw new Error(`wrong refusal: ${m}`); return; } throw new Error("was accepted"); };
const NOW = new Date("2026-06-10T12:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000);
const T = { warnHours: 48, failHours: 168 };
const prod = (o) => ({ product: "Windows Backup", kind: "image", state: "ok", lastSuccessAt: hoursAgo(5), lastAttemptAt: hoursAgo(5), detail: "", ...o });

console.log("what a device may report");
const line = (p, k, s, a, st, d) => `P|${p}|${k}|${s}|${a}|${st}|${d}`;
check("a report is lines of P|product|kind|success|attempt|state|detail and a last D|ok; times are UTC ISO", () => {
    const out = C.parseBackupOutput([line("Windows Backup", "image", "2026-06-10T08:00:00Z", "2026-06-10T08:00:00Z", "ok", ""), line("Veeam Agent", "agent", "", "", "unknown", "Its service is running."), "D|ok"].join("\r\n"));
    assert.equal(out.length, 2); assert.equal(out[0].lastSuccessAt.toISOString(), "2026-06-10T08:00:00.000Z"); assert.equal(out[1].lastSuccessAt, null); assert.equal(out[1].state, "unknown");
});
check("a report without its last line (cut off), with an error line, or in another shape is an error, never a status", () => {
    refused(() => C.parseBackupOutput(line("x", "image", "", "", "ok", "")), /did not finish/);
    refused(() => C.parseBackupOutput("E|Access is denied\nD|ok"), /Access is denied/);
    refused(() => C.parseBackupOutput(""), /did not finish/);
    refused(() => C.parseBackupOutput("P|only|three\nD|ok"), /could not be read/);
});
check("an unknown kind, an unknown state, a bad time or no name is refused", () => {
    refused(() => C.parseBackupOutput(`${line("x", "tape", "", "", "ok", "")}\nD|ok`), /unknown kind/);
    refused(() => C.parseBackupOutput(`${line("x", "image", "", "", "great", "")}\nD|ok`), /unknown state/);
    refused(() => C.parseBackupOutput(`${line("x", "image", "yesterday", "", "ok", "")}\nD|ok`), /time/);
    refused(() => C.parseBackupOutput(`${line("x", "image", "2026-13-45T99:00:00Z", "", "ok", "")}\nD|ok`), /time/);
    refused(() => C.parseBackupOutput(`${line("  ", "image", "", "", "ok", "")}\nD|ok`), /no name/);
});
check("control characters are cleaned, a detail may hold a pipe, a repeat of a product is ignored, and there are at most 40", () => {
    const out = C.parseBackupOutput([line("A\u0007pp", "agent", "", "", "unknown", "it said|this\tand that"), line("a\u0007pp", "agent", "", "", "ok", "second"), "D|ok"].join("\n"));
    assert.equal(out.length, 1); assert.equal(out[0].product, "A pp"); assert.equal(out[0].detail, "it said|this and that");
    const many = Array.from({ length: 60 }, (_, i) => line(`P${i}`, "agent", "", "", "unknown", "")).concat("D|ok").join("\n");
    assert.equal(C.parseBackupOutput(many).length, 40);
});

console.log("one product");
check("a recent success is ok; older than the warning age warns; older than the failing age fails; the thresholds are inclusive on the good side", () => {
    assert.equal(C.judgeProduct(prod({ lastSuccessAt: hoursAgo(48) }), T, NOW).status, "ok");
    assert.equal(C.judgeProduct(prod({ lastSuccessAt: hoursAgo(49) }), T, NOW).status, "warning");
    assert.equal(C.judgeProduct(prod({ lastSuccessAt: hoursAgo(168) }), T, NOW).status, "warning");
    const f = C.judgeProduct(prod({ lastSuccessAt: hoursAgo(24 * 9) }), T, NOW); assert.equal(f.status, "failed"); assert.match(f.why, /9 days ago/);
});
check("the last attempt failed after a recent success warns; after an old success it fails; a failure older than the success does not count", () => {
    const w = C.judgeProduct(prod({ state: "failed", lastSuccessAt: hoursAgo(30), lastAttemptAt: hoursAgo(2), detail: "disk full" }), T, NOW); assert.equal(w.status, "warning"); assert.match(w.why, /last attempt failed \(disk full\)/);
    assert.equal(C.judgeProduct(prod({ state: "failed", lastSuccessAt: hoursAgo(100), lastAttemptAt: hoursAgo(2) }), T, NOW).status, "failed");
    assert.equal(C.judgeProduct(prod({ state: "failed", lastSuccessAt: hoursAgo(2), lastAttemptAt: hoursAgo(30) }), T, NOW).status, "ok");
});
check("no success at all: failed when it failed, a warning otherwise (and a stopped service says so)", () => {
    assert.equal(C.judgeProduct(prod({ state: "failed", lastSuccessAt: null }), T, NOW).status, "failed");
    const w = C.judgeProduct(prod({ product: "Veeam", kind: "agent", state: "warning", lastSuccessAt: null, detail: "It is installed, but its service is not running." }), T, NOW);
    assert.equal(w.status, "warning"); assert.match(w.why, /service is not running/);
});
check("software that does not show its results is unknown, not ok and not failed", () => {
    const u = C.judgeProduct(prod({ product: "Veeam", kind: "agent", state: "unknown", lastSuccessAt: null, detail: "" }), T, NOW); assert.equal(u.status, "unknown"); assert.match(u.why, /cannot be read/);
});

console.log("the whole computer");
const dev = (...p) => C.judgeDevice(p, T, NOW);
check("nothing found is none", () => { const v = dev(); assert.equal(v.overall, "none"); assert.match(v.detail, /No backup software or restore points/); assert.equal(v.lastSuccessAt, null); });
check("one real backup that worked recently is ok, whatever else is there", () => {
    const v = dev(prod(), prod({ product: "Old", kind: "file", lastSuccessAt: hoursAgo(24 * 30) }), prod({ product: "Veeam", kind: "agent", state: "unknown", lastSuccessAt: null }));
    assert.equal(v.overall, "ok"); assert.equal(v.lastSuccessAt.toISOString(), hoursAgo(5).toISOString()); assert.match(v.detail, /Windows Backup: Last success 5 hours ago/);
});
check("restore points on the same disk are only a warning, and the reason says why", () => {
    const v = dev(prod({ product: "Shadow copies", kind: "snapshot" })); assert.equal(v.overall, "warning"); assert.match(v.detail, /own disk/);
    assert.equal(dev(prod({ product: "Shadow copies", kind: "snapshot" }), prod({ product: "Veeam", kind: "agent", state: "unknown", lastSuccessAt: null })).overall, "warning");
});
check("real backups that are all stale or failed show the worst of them; restore points do not rescue it", () => {
    const v = dev(prod({ lastSuccessAt: hoursAgo(24 * 10) }), prod({ product: "Shadow copies", kind: "snapshot" }));
    assert.equal(v.overall, "failed"); assert.match(v.detail, /Windows Backup: Last success 10 days ago/);
    assert.equal(dev(prod({ lastSuccessAt: hoursAgo(60) }), prod({ product: "B", lastSuccessAt: hoursAgo(24 * 10) })).overall, "failed");
});
check("only software that shows nothing is unknown, with its name and where to look", () => {
    const v = dev(prod({ product: "Acronis", kind: "agent", state: "unknown", lastSuccessAt: null })); assert.equal(v.overall, "unknown"); assert.match(v.detail, /Acronis found/);
});
check("what needs attention is a problem, a warning or nothing at all, not merely unreadable", () => {
    assert.deepEqual(["ok", "warning", "failed", "unknown", "none"].map(C.needsAttention), [false, true, true, false, true]);
});

console.log("the settings");
check("defaults are off, 48 hours, 7 days, every 6 hours, alerts on; changes are checked", () => {
    assert.deepEqual(C.DEFAULT_SETTINGS, { enabled: false, warnHours: 48, failHours: 168, checkHours: 6, alerts: true });
    assert.deepEqual(C.cleanSettings({ enabled: true, warnHours: 24, failHours: 72, checkHours: 12 }, C.DEFAULT_SETTINGS), { enabled: true, warnHours: 24, failHours: 72, checkHours: 12, alerts: true });
    refused(() => C.cleanSettings({ enabled: "yes" }, C.DEFAULT_SETTINGS)); refused(() => C.cleanSettings({ warnHours: 0 }, C.DEFAULT_SETTINGS)); refused(() => C.cleanSettings({ checkHours: 169 }, C.DEFAULT_SETTINGS));
    refused(() => C.cleanSettings({ warnHours: 200 }, C.DEFAULT_SETTINGS), /longer than the warning/); refused(() => C.cleanSettings({ failHours: 48 }, C.DEFAULT_SETTINGS), /longer than the warning/);
});

console.log("the scripts");
check("neither script holds a dollar-brace, a backtick or anything that is not ASCII, and neither changes anything", () => {
    for (const [n, t] of [["windows", S.WINDOWS_BACKUP_SCRIPT], ["linux", S.LINUX_BACKUP_SCRIPT]]) {
        assert.ok(!t.includes("${") && !t.includes("`"), n); assert.ok(/^[\x00-\x7F]*$/.test(t), n);
        assert.ok(!/\b(Start|Stop|Restart|Set|Remove|New|Install|Enable|Disable)-[A-Za-z]+/.test(t) || n === "linux", `${n}: a command that changes things`);
        assert.ok(!/\b(rm|mv|kill|systemctl (start|stop|restart|enable|disable)|apt|dnf|yum|chmod|chown)\b/.test(n === "linux" ? t : ""), `${n}: a command that changes things`);
    }
});
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 120_000, ...o });
const havePs = process.platform === "win32" && run("powershell", ["-NoProfile", "-Command", "1"]).status === 0;
check("the Windows script runs on this machine, ends with D|ok, and what it printed is a valid report", () => {
    if (!havePs) return console.log("     (no Windows PowerShell, skipped)");
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "riq-bk-")), "backup.ps1");
    fs.writeFileSync(f, S.WINDOWS_BACKUP_SCRIPT);
    const r = run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /D\|ok\s*$/);
    const products = C.parseBackupOutput(r.stdout);
    console.log(`     (found ${products.length}: ${products.map((p) => `${p.product} [${p.state}]`).join(", ") || "nothing"})`);
    const v = C.judgeDevice(products, T, new Date()); assert.ok(["ok", "warning", "failed", "unknown", "none"].includes(v.overall));
});
const docker = run("docker", ["info", "--format", "{{.ServerVersion}}"]).status === 0;
check("the Linux script in Debian: with nothing it says none; with a zfs snapshot, a timeshift snapshot and a backup tool it reports each", () => {
    if (!docker) return console.log("     (Docker is not running, skipped)");
    const name = `riq-bk-${Date.now()}`;
    try {
        assert.equal(run("docker", ["run", "-d", "--name", name, "debian:12", "sleep", "300"]).status, 0);
        const sh = (cmd, env = {}) => run("docker", ["exec", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), name, "bash", "-c", cmd]);
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "riq-bk-")), "backup.sh");
        fs.writeFileSync(tmp, S.LINUX_BACKUP_SCRIPT, { mode: 0o755 });
        assert.equal(run("docker", ["cp", tmp, `${name}:/backup.sh`]).status, 0);
        const empty = sh("bash /backup.sh"); assert.equal(empty.status, 0, empty.stderr);
        assert.deepEqual(C.parseBackupOutput(empty.stdout), []);
        const epoch = Math.floor(Date.now() / 1000) - 3 * 3600;
        sh(`printf '#!/bin/bash\\nif [ "$1" = list ]; then echo ${epoch - 86400}; echo ${epoch}; fi\\n' > /usr/local/bin/zfs && chmod +x /usr/local/bin/zfs; printf '#!/bin/bash\\nexit 0\\n' > /usr/local/bin/restic && chmod +x /usr/local/bin/restic; mkdir -p /timeshift/snapshots/2026-01-02_03-04-05 /timeshift/snapshots/2026-01-31_08-30-00`);
        const full = sh("bash /backup.sh"); assert.equal(full.status, 0, full.stderr);
        const p = C.parseBackupOutput(full.stdout); const by = Object.fromEntries(p.map((x) => [x.product, x]));
        assert.ok(by["ZFS snapshots"] && by["ZFS snapshots"].kind === "snapshot" && by["ZFS snapshots"].state === "ok" && Math.abs(by["ZFS snapshots"].lastSuccessAt.getTime() / 1000 - epoch) < 2, JSON.stringify(by["ZFS snapshots"]));
        assert.ok(by["Timeshift"] && by["Timeshift"].lastSuccessAt.toISOString().startsWith("2026-01-31T08:30:00"), JSON.stringify(by["Timeshift"]));
        assert.ok(by["restic"] && by["restic"].state === "unknown" && by["restic"].kind === "agent", JSON.stringify(by["restic"]));
        const v = C.judgeDevice(p, T, new Date()); assert.equal(v.overall, "warning"); assert.match(v.detail, /own disk/);
    } finally { run("docker", ["rm", "-f", name]); }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
