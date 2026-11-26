// The Defender exclusions probe of the Windows security scan, run for real in Windows PowerShell with made-up exclusion lists in place of
// Get-MpPreference (reading the real list needs administrator rights): which exclusions count as broad and which are fine (an application's
// own folder), what is reported (counts and kinds only, never a path), and that a list hidden from a non-administrator is "unknown".
// Run after a build: node test/security-exclusions-script.cjs   (Windows only; it exits 0 with a note elsewhere)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
if (process.platform !== "win32") { console.log("skipped: Windows only"); process.exit(0); }
const S = require(path.join(__dirname, "..", process.env.DIST || "dist", "security", "security.scripts.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };

const m = /Probe 'defenderExclusions' 12000 \{\r?\n([\s\S]*?)\r?\n\}\r?\n/.exec(S.SECURITY_SCAN_SCRIPT);
assert.ok(m, "the probe is in the script");
const body = m[1];
assert.ok(body.includes("$p = Get-MpPreference"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adg-excl-"));
const q = (a) => "@(" + a.map((x) => `'${x.replace(/'/g, "''")}'`).join(",") + ")";
function run(paths, exts, procs) {
    const fake = `$p = [pscustomobject]@{ ExclusionPath = ${q(paths)}; ExclusionExtension = ${q(exts)}; ExclusionProcess = ${q(procs)} }`;
    const script = `$ErrorActionPreference = 'Stop'\n$r = & {\n${body.replace("$p = Get-MpPreference", fake)}\n}\n$r | ConvertTo-Json -Compress -Depth 4\n`;
    const f = path.join(dir, "t.ps1");
    fs.writeFileSync(f, "\ufeff" + script);
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", timeout: 60_000 });
    return { status: r.status, out: r.stdout.trim(), err: (r.stderr || "").trim() };
}

check("no exclusions: zero counts and nothing broad", () => {
    const r = run([], [], []);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { paths: 0, extensions: 0, processes: 0, broad: [] });
});
check("an application's own folders and harmless types are not broad", () => {
    const r = run(["C:\\Program Files\\AdgRmm", "C:\\ProgramData\\AdgRmm\\agent", "D:\\Data\\App", "C:\\Users\\ann\\source\\repo"], [".tmp", "log"], ["C:\\Tools\\app.exe", "service.exe"]);
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.deepEqual(j, { paths: 4, extensions: 2, processes: 2, broad: [] });
});
check("whole drives, system folders, whole profiles, temp and downloads, risky file types and script engines are broad", () => {
    const r = run(
        ["C:\\", "d:", "C:\\Windows", "c:\\windows\\system32\\", "C:\\Program Files", "C:\\Users", "C:\\Users\\ann", "C:\\Users\\ann\\AppData\\Local", "C:\\Users\\ann\\Downloads", "C:\\Users\\ann\\AppData\\Local\\Temp", "C:\\Windows\\Temp", "*"],
        [".exe", "DLL", ".ps1", ".tmp"],
        ["C:\\Tools\\powershell.exe", "CMD.EXE", "mshta.exe", "chrome.exe"]);
    assert.equal(r.status, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.paths, 12); assert.equal(j.extensions, 4); assert.equal(j.processes, 4);
    for (const kind of ["a whole drive", "a system folder", "a whole user profile", "a temp or downloads folder", "program or script files (.exe)", "program or script files (.dll)", "program or script files (.ps1)", "a script or system program (powershell.exe)", "a script or system program (cmd.exe)", "a script or system program (mshta.exe)"])
        assert.ok(j.broad.includes(kind), `${kind} in ${JSON.stringify(j.broad)}`);
    assert.ok(!j.broad.some((k) => /tmp|chrome/i.test(k)), "a .tmp file type and chrome.exe are not broad");
    assert.ok(j.broad.length <= 10, "at most ten kinds are sent");
});
check("what is reported never contains a path", () => {
    const r = run(["C:\\Users\\ann\\secret-client-project", "C:\\Users\\ann\\Downloads"], [], []);
    assert.equal(r.status, 0, r.err);
    assert.ok(!/secret-client-project|ann/i.test(r.out), r.out);
});
check("every kind it can send passes the server's checker, and a path would not", () => {
    const r = run(["C:\\", "C:\\Windows", "C:\\Users\\ann", "C:\\Windows\\Temp"], [".exe"], ["powershell.exe"]);
    const probe = { status: "ok", ms: 5, ...JSON.parse(r.out) };
    const scanText = JSON.stringify({ v: 1, ms: 1, probes: { defenderExclusions: probe } });
    const parsed = S.parseSecurityScan(scanText, "");
    assert.deepEqual(parsed.probes.defenderExclusions.broad.sort(), JSON.parse(r.out).broad.sort());
});
check("a list hidden from a non-administrator (the N/A text) throws, so the probe is unknown", () => {
    const r = run(["N/A: Must be an administrator to view exclusions"], [], []);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /administrator rights/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
