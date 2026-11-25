// Runs the registry browser's fixed scripts for real (Windows only, Windows PowerShell as the agent runs them), parses what they
// print with the same functions the server uses, and times them: a script that looked fine once took 90 s on a real PC
// (WMI), so every look must be well under 5 s. A throwaway key under the current user's own hive (HKCU, read back as HKU\<SID>)
// holds one value of every type, a secret-looking name, unicode and a long binary; it is removed at the end.
// Run after a build: node test/device-registry-scripts.cjs   (not for CI on Linux: it exits 0 with a note)
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
if (process.platform !== "win32") { console.log("skipped: Windows only"); process.exit(0); }
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "device-tools");
const R = require(path.join(dist, "device-registry.scripts.js"));
const { parseWindowsJson } = require(path.join(dist, "device-tools.scripts.js"));

let passed = 0, failed = 0;
const timings = [];
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const ps = (file, env) => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1e8 });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riq-reg-"));
function run(kind, env, label) {
    const f = path.join(dir, `${kind}.ps1`);
    fs.writeFileSync(f, "\ufeff" + R.REGISTRY_SCRIPTS[kind]);
    const t = Date.now();
    const r = ps(f, { RIQ_REG_VIEW: "64", RIQ_REG_PATH: "", RIQ_REG_TEXT: "", RIQ_REG_IN: "keys", ...env });
    const ms = Date.now() - t;
    timings.push(`${label || kind}: ${ms} ms, ${r.stdout.length} chars`);
    assert.ok(r.stdout.length < 190000, "output is under the agent's 200000 character cap");
    assert.ok(/^[\x00-\x7f]*$/.test(r.stdout), "ASCII only");
    return { ms, parsed: parseWindowsJson(r.stdout, r.stderr), r };
}
const reader = { key: (p, path) => R.parseRegistryKey(p, path), search: (p) => R.parseRegistrySearch(p), roots: (p) => R.parseRegistryRoots(p) };

const mk = path.join(dir, "mk.ps1");
fs.writeFileSync(mk, `$k = 'HKCU:\\Software\\RiqRegTestUnit'
Remove-Item $k -Recurse -ErrorAction SilentlyContinue
New-Item $k | Out-Null; New-Item "$k\\child1" | Out-Null; New-Item "$k\\child1\\deep" | Out-Null
New-Item -Path ($k + '\\Caf' + [char]0xe9 + ' q') | Out-Null
Set-ItemProperty $k '(default)' 'defval'
Set-ItemProperty $k 'Str' 'hello "quoted" \\ back'
Set-ItemProperty $k 'Uni' ('caf' + [char]0xe9 + ' ' + [char]0x4e2d + [char]0xD83D + [char]0xDE00 + [char]13 + [char]10 + 'line2')
New-ItemProperty $k 'Exp' -Value '%SystemRoot%\\system32' -PropertyType ExpandString | Out-Null
New-ItemProperty $k 'Multi' -Value @('a','b c','') -PropertyType MultiString | Out-Null
New-ItemProperty $k 'Dw' -Value ([int]-1) -PropertyType DWord | Out-Null
New-ItemProperty $k 'Qw' -Value ([long]-1) -PropertyType QWord | Out-Null
New-ItemProperty $k 'Bin' -Value ([byte[]](@(0..255) + @(0..255) + @(0..9))) -PropertyType Binary | Out-Null
New-ItemProperty $k 'Empty' -Value ([byte[]]@()) -PropertyType Binary | Out-Null
New-ItemProperty $k 'MyPassword' -Value 'hunter2-secret-value' | Out-Null
New-ItemProperty $k 'ApiKey_x' -Value 'abc' | Out-Null
New-ItemProperty $k 'LongStr' -Value ('x' * 5000) | Out-Null
[Security.Principal.WindowsIdentity]::GetCurrent().User.Value`);
const made = ps(mk, {});
const sid = made.stdout.trim().split(/\r?\n/).pop();
assert.match(sid, /^S-1-5-21-/, made.stderr);
const HKU_KEY = `HKU\\${sid}\\Software\\RiqRegTestUnit`;

try {
    check("a key with every kind of value is read and rendered; unicode, quotes and control characters survive", () => {
        const { ms, parsed } = run("key", { RIQ_REG_PATH: HKU_KEY }, "key (test key under HKU)");
        const k = reader.key(parsed, HKU_KEY);
        const v = Object.fromEntries(k.values.map((x) => [x.name, x]));
        assert.equal(v[""].display, "(Default)"); assert.equal(v[""].data, "defval");
        assert.equal(v.Str.data, 'hello "quoted" \\ back');
        assert.equal(v.Uni.data, "caf\u00e9 \u4e2d\ud83d\ude00\r\nline2");
        assert.equal(v.Exp.type, "REG_EXPAND_SZ"); assert.equal(v.Exp.data, "%SystemRoot%\\system32");
        assert.deepEqual(v.Multi.data, ["a", "b c", ""]);
        assert.equal(v.Dw.data, 4294967295); assert.equal(v.Dw.hex, "0xFFFFFFFF");
        assert.equal(v.Qw.data, "18446744073709551615"); assert.equal(v.Qw.hex, "0xFFFFFFFFFFFFFFFF");
        assert.equal(v.Bin.size, 522); assert.equal(v.Bin.truncated, true); assert.equal(v.Bin.data.split(" ").length, 512);
        assert.equal(v.Bin.data.slice(0, 11), "00 01 02 03");
        assert.equal(v.Empty.data, ""); assert.equal(v.Empty.type, "REG_BINARY");
        assert.equal(v.LongStr.data.length, R.MAX_STRING_CHARS); assert.equal(v.LongStr.truncated, true); assert.equal(v.LongStr.size, 5000);
        for (const n of ["MyPassword", "ApiKey_x"]) { assert.equal(v[n].masked, true); assert.equal(v[n].data, null); assert.ok(v[n].size > 0); }
        assert.ok(!parsed || !JSON.stringify(parsed).includes("hunter2"), "the secret never left the script");
        assert.deepEqual(k.subKeys.map((s) => [s.name, s.hasChildren]), [["Caf\u00e9 q", false], ["child1", true]]);
        assert.ok(k.lastWrite && Math.abs(Date.now() - Date.parse(k.lastWrite)) < 3600_000, "last write time is today");
        assert.ok(ms < 5000);
    });

    const timed = (label, kind, env, extra) => check(label, () => {
        const { ms, parsed } = run(kind, env, label);
        assert.ok(ms < 5000, `${ms} ms is not under 5 s`);
        if (extra) extra(reader[kind](parsed, env.RIQ_REG_PATH), parsed);
    });
    timed("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion lists sub keys and values (under 5 s)", "key", { RIQ_REG_PATH: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" }, (k) => {
        assert.ok(k.subKeys.length > 5 && k.values.length > 3);
        assert.ok(k.values.some((x) => x.name === "ProgramFilesDir" && /Program Files/.test(x.data)));
    });
    timed("the same key in the 32-bit view (under 5 s)", "key", { RIQ_REG_PATH: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion", RIQ_REG_VIEW: "32" }, (k) => {
        const p64 = reader.key(run("key", { RIQ_REG_PATH: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" }, "64-bit view").parsed, "x").values.find((x) => x.name === "ProgramFilesDir").data;
        const p32 = k.values.find((x) => x.name === "ProgramFilesDir").data;
        assert.notEqual(p32, p64, "the 32-bit view has its own ProgramFilesDir");
    });
    timed("HKU lists the loaded hives (under 5 s)", "key", { RIQ_REG_PATH: "HKU" }, (k) => assert.ok(k.subKeys.some((s) => s.name === sid)));
    timed("HKLM lists its keys with SAM and SECURITY marked blocked (under 5 s)", "key", { RIQ_REG_PATH: "HKLM" }, (k) => {
        for (const n of ["SAM", "SECURITY"]) { const s = k.subKeys.find((x) => x.name === n); assert.ok(s && s.blocked && !s.hasChildren, n); }
        assert.ok(k.subKeys.find((x) => x.name === "SOFTWARE").hasChildren);
    });
    timed("a big key (HKLM\\SOFTWARE\\Classes, thousands of sub keys) is cut at 2000, within the output cap (under 5 s)", "key", { RIQ_REG_PATH: "HKLM\\SOFTWARE\\Classes" }, (k) => {
        assert.ok(k.subKeys.length <= R.MAX_SUBKEYS);
        if (k.subKeyCount > R.MAX_SUBKEYS) assert.equal(k.subKeysTruncated, true);
    });
    timed("Control\\Lsa is listed as blocked inside its parent (under 5 s)", "key", { RIQ_REG_PATH: "HKLM\\SYSTEM\\CurrentControlSet\\Control" }, (k) => {
        const l = k.subKeys.find((s) => s.name === "Lsa"); assert.ok(l && l.blocked);
    });
    timed("roots helper: loaded user SIDs with account names (under 5 s)", "roots", {}, (r) => {
        const me = r.users.find((u) => u.sid === sid); assert.ok(me, "the current user is listed"); assert.ok(me.account, "named from the profile list");
        assert.ok(r.users.every((u) => u.path === `HKU\\${u.sid}`));
    });

    check("blocked or missing keys are errors, never an empty list", () => {
        for (const p of ["HKLM\\SAM", "HKLM\\SECURITY\\Policy", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa", "HKLM\\SYSTEM\\ControlSet001\\Control\\Lsa\\Data"]) {
            assert.throws(() => run("key", { RIQ_REG_PATH: p }), /blocked/, p);
            assert.throws(() => run("search", { RIQ_REG_PATH: p, RIQ_REG_TEXT: "a" }), /blocked/, p);
        }
        assert.throws(() => run("key", { RIQ_REG_PATH: "HKLM\\SOFTWARE\\RiqNoSuchKey" }), /does not exist/);
        assert.throws(() => run("key", { RIQ_REG_PATH: "HKCU\\Software" }), /Only HKLM and HKU/);
    });

    check("search: keys, values and data below a key; the secret value is never found by its data; time is reported", () => {
        const base = { RIQ_REG_PATH: HKU_KEY };
        const keys = reader.search(run("search", { ...base, RIQ_REG_TEXT: "DEEP", RIQ_REG_IN: "keys" }, "search keys (test key)").parsed);
        assert.deepEqual(keys.results.map((r) => r.path), [`${HKU_KEY}\\child1\\deep`]);
        const vals = reader.search(run("search", { ...base, RIQ_REG_TEXT: "password", RIQ_REG_IN: "values" }, "search values (test key)").parsed);
        assert.deepEqual(vals.results.map((r) => r.name), ["MyPassword"], "found by its name");
        const data = reader.search(run("search", { ...base, RIQ_REG_TEXT: "hunter2", RIQ_REG_IN: "data" }, "search data (test key)").parsed);
        assert.equal(data.results.length, 0, "a secret-named value is not searched by its data");
        const d2 = reader.search(run("search", { ...base, RIQ_REG_TEXT: "QUOTED", RIQ_REG_IN: "data" }).parsed);
        assert.deepEqual(d2.results.map((r) => [r.name, r.type]), [["Str", "REG_SZ"]]);
        const dw = reader.search(run("search", { ...base, RIQ_REG_TEXT: "4294967295", RIQ_REG_IN: "data" }).parsed);
        assert.deepEqual(dw.results.map((r) => r.name), ["Dw"]);
        assert.equal(keys.truncated, false);
        const regex = reader.search(run("search", { ...base, RIQ_REG_TEXT: ".*", RIQ_REG_IN: "keys" }).parsed);
        assert.equal(regex.results.length, 0, ".* is plain text, not a pattern");
        const wild = reader.search(run("search", { ...base, RIQ_REG_TEXT: "*", RIQ_REG_IN: "values" }).parsed);
        assert.equal(wild.results.length, 0, "* is plain text, not a wildcard");
    });

    check("search: a wide search stops at the time limit or the result limit and says so (HKLM, takes up to 20 s by design)", () => {
        const { parsed, ms } = run("search", { RIQ_REG_PATH: "HKLM\\SOFTWARE", RIQ_REG_TEXT: "e", RIQ_REG_IN: "keys" }, "search HKLM\\SOFTWARE keys 'e' (bounded)");
        const s = reader.search(parsed);
        assert.equal(s.truncated, true); assert.ok(s.reason === "results" || s.reason === "time");
        assert.ok(s.results.length <= R.SEARCH_MAX_RESULTS); assert.ok(ms < 30_000);
        const t = run("search", { RIQ_REG_PATH: "HKLM", RIQ_REG_TEXT: "zzzz-not-there-zzzz", RIQ_REG_IN: "data" }, "search all HKLM data (time-limited)");
        const s2 = reader.search(t.parsed);
        assert.equal(s2.reason, "time"); assert.ok(t.ms < 30_000, `${t.ms} ms`);
    });

    check("search: depth is limited to 6 levels below the start key", () => {
        const deep = path.join(dir, "deep.ps1");
        fs.writeFileSync(deep, "$k = 'HKCU:\\Software\\RiqRegTestUnit\\child1\\deep'; $p = $k; 1..8 | ForEach-Object { $p = $p + '\\L' + $_; New-Item $p -Force | Out-Null }");
        ps(deep, {});
        const s = reader.search(run("search", { RIQ_REG_PATH: HKU_KEY, RIQ_REG_TEXT: "L", RIQ_REG_IN: "keys" }, "search depth").parsed);
        const levels = s.results.map((r) => r.path.slice(HKU_KEY.length).split("\\").length - 1);
        assert.ok(Math.max(...levels) <= R.SEARCH_MAX_DEPTH, `deepest ${Math.max(...levels)}`);
        assert.ok(s.results.some((r) => r.path.endsWith("\\L3")) && !s.results.some((r) => r.path.endsWith("\\L5")), "child1\\deep is level 2: L1 is 3, L4 is 6, L5 is cut");
    });

    check("user input only travels in the environment: text with quotes and PowerShell syntax is just text", () => {
        const nasty = "'; Remove-Item C:\\x -Recurse; $(calc) \"`n";
        const s = reader.search(run("search", { RIQ_REG_PATH: HKU_KEY, RIQ_REG_TEXT: nasty, RIQ_REG_IN: "data" }).parsed);
        assert.equal(s.results.length, 0);
        assert.throws(() => run("key", { RIQ_REG_PATH: `HKLM\\SOFTWARE\\'; calc; '` }), /does not exist/);
    });
} finally {
    fs.writeFileSync(path.join(dir, "rm.ps1"), "Remove-Item 'HKCU:\\Software\\RiqRegTestUnit' -Recurse -ErrorAction SilentlyContinue");
    ps(path.join(dir, "rm.ps1"), {});
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\ntimings:\n  " + timings.join("\n  "));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
