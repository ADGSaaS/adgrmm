// Runs the security scan script for real (Windows only, Windows PowerShell 5.1 as the agent runs it), parses what it prints with the
// same function the server uses, scores it, and times every probe: a WMI query that asked for all properties once took 90 seconds on a
// real PC, so the whole scan must finish far under 30 seconds even when a probe hangs. Also checks that all three scripts parse in
// PowerShell, and that a probe that never returns is dropped at its time limit without delaying the answer or the process exit.
// Run after a build: node test/security-scripts.cjs   (it exits 0 with a note on other systems)
// Run elevated (as an administrator) to see the probes that need it work; non-elevated, those report "unknown" with a reason.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
if (process.platform !== "win32") { console.log("skipped: Windows only"); process.exit(0); }
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "security");
const S = require(path.join(dist, "security.scripts.js"));
const B = require(path.join(dist, "security.baseline.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riq-sec-"));
const ps = (file, env = {}) => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1e8, timeout: 120_000 });
const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, "﻿" + text); return f; };

console.log("syntax");
for (const [name, text] of Object.entries({ "security scan": S.SECURITY_SCAN_SCRIPT, "defender update": S.DEFENDER_SCRIPTS.update, "defender scan": S.DEFENDER_SCRIPTS.scan })) {
    check(`${name} parses in Windows PowerShell`, () => {
        const f = write("syntax.ps1", text);
        const r = spawnSync("powershell", ["-NoProfile", "-Command", `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}`], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stdout + r.stderr);
    });
}

console.log("the real scan on this PC");
const elevated = spawnSync("powershell", ["-NoProfile", "-Command", "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"], { encoding: "utf8" }).stdout.trim();
console.log(`     elevated: ${elevated}`);
const file = write("scan.ps1", S.SECURITY_SCAN_SCRIPT);
const t0 = Date.now();
const r = ps(file);
const wall = Date.now() - t0;
let scan = null;
check("prints one ASCII JSON that the server's parser accepts", () => {
    assert.ok(/^[\x00-\x7f]*$/.test(r.stdout), "ASCII only");
    assert.ok(r.stdout.length < 190000, "under the agent's output cap");
    scan = S.parseSecurityScan(r.stdout, r.stderr);
    assert.equal(scan.v, 1);
});
check(`finishes well under 30 seconds (took ${(wall / 1000).toFixed(1)} s)`, () => assert.ok(wall < 30_000, `${wall} ms`));
if (scan) {
    const rows = S.PROBE_NAMES.map((n) => { const p = scan.probes[n]; return `${n.padEnd(15)} ${p.status.padEnd(8)} ${String(p.ms).padStart(6)} ms${p.status === "unknown" ? `   ${p.reason}` : ""}`; });
    console.log("     per probe:\n       " + rows.join("\n       "));
    check("the cheap registry probes all answer", () => { for (const n of ["os", "firewall", "uac", "secureBoot", "autoLogon", "rdp", "screenLock", "reboot"]) assert.equal(scan.probes[n].status, "ok", n); });
    check("no probe takes more than its time box", () => { for (const n of S.PROBE_NAMES) assert.ok(scan.probes[n].ms <= 21_000, `${n} ${scan.probes[n].ms}`); });
    check("what the scan found scores without error", () => {
        const ev = B.evaluateScan(scan);
        console.log(`     score ${ev.score} grade ${ev.grade}${ev.capped ? ` (capped from ${ev.uncappedScore})` : ""}; pass ${ev.counts.pass}, fail ${ev.counts.fail}, unknown ${ev.counts.unknown}, n/a ${ev.counts.notApplicable}`);
        console.log("     failed: " + ev.rules.filter((x) => x.result === "fail").map((x) => `${x.id} (${x.detail})`).join(" | "));
        assert.equal(ev.rules.length, 28);
    });
    check("no secret appears anywhere in the output (no recovery password, key, DefaultPassword)", () => {
        assert.ok(!/\b\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}\b/.test(r.stdout));
        assert.ok(!/DefaultPassword|RecoveryPassword\"?:\s*\"[0-9-]{20,}/.test(r.stdout));
        assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(r.stdout), "no GUID (a key protector id would be one)");
    });
}

console.log("a probe that never returns");
check("is dropped at its time limit, the rest still answer, and the process ends at once", () => {
    const hung = S.SECURITY_SCAN_SCRIPT
        .replace("Probe 'os' 0 {", "Probe 'hang' 2000 { Start-Sleep 300; @{ a = 1 } }\nProbe 'spin' 2000 { while ($true) { $x = 1 } }\nProbe 'os' 0 {")
        .replace("Out-Riq @{ ok = $true; v = 1;", "Out-Riq @{ ok = $true; v = 1; extra = 1;");
    const f = write("hang.ps1", hung);
    const t = Date.now();
    const h = ps(f);
    const took = Date.now() - t;
    const j = JSON.parse(h.stdout);
    assert.equal(j.probes.hang.status, "unknown"); assert.match(j.probes.hang.reason, /Timed out/);
    assert.equal(j.probes.spin.status, "unknown");
    assert.equal(j.probes.os.status, "ok");
    assert.ok(took < wall + 8_000, `took ${took} ms against ${wall} ms for the normal scan`);
});
check("the time budget skips what is left when the script is out of time", () => {
    const slow = S.SECURITY_SCAN_SCRIPT
        .replace("$BUDGET_MS = 26000", "$BUDGET_MS = 3000")
        .replace("Probe 'os' 0 {", "Probe 'hang' 2500 { Start-Sleep 300; @{ a = 1 } }\nProbe 'os' 0 {");
    const j = JSON.parse(ps(write("budget.ps1", slow)).stdout);
    assert.equal(j.probes.hang.status, "unknown");
    const skipped = Object.values(j.probes).filter((p) => /ran out of time/.test(p.reason || "")).length;
    assert.ok(skipped >= 1, "later probes are skipped, not started");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
