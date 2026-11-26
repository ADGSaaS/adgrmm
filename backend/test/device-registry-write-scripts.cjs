// Runs the registry editor's fixed WRITE scripts for real (Windows only, Windows PowerShell as the agent runs them) against a throwaway
// key under the CURRENT USER's own hive: HKU\<this user's SID>\Software\AdgRmm-Test (read back as HKCU). Run as a normal user,
// so HKLM CANNOT be written here: HKLM writes (and their blocklist inside the script) are only exercised up to the refusal, which
// happens before the key is opened; a real write below HKLM needs an elevated run and is not part of this test.
// Covers every type round trip (unicode, quotes, very long, binary), optimistic concurrency, delete key with sub keys, undo at the
// script level, hostile text passed only through the environment, and times every script (each must take < 2 s: a past WMI script took 90 s).
// Run after a build: node test/device-registry-write-scripts.cjs   (not for CI on Linux: it exits 0 with a note)
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adg-regw-"));
const writeScript = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

// the user's SID, and a clean slate
const sid = ps(writeScript("sid.ps1", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"), {}).stdout.trim();
assert.match(sid, /^S-1-5-21-/);
const cleanup = () => ps(writeScript("rm.ps1", "Remove-Item 'HKCU:\\Software\\AdgRmm-Test' -Recurse -ErrorAction SilentlyContinue"), {});
cleanup();
const BASE = `HKU\\${sid}\\Software\\AdgRmm-Test`;

/** Runs a write script. `answer` is what the server would store; throws what the server would turn into a 409 (ToolOutputError). */
function W(kind, env, label) {
    const f = writeScript(`${kind}.ps1`, "﻿" + R.REGISTRY_WRITE_SCRIPTS[kind]);
    const t = Date.now();
    const r = ps(f, { ADG_REG_VIEW: "64", ADG_REG_NAME: "", ADG_REG_TYPE: "", ADG_REG_DATA: "", ADG_REG_EXPECT: "", ADG_REG_VALUES: "", ...env });
    const ms = Date.now() - t;
    timings.push(`${label || kind}: ${ms} ms`);
    assert.ok(ms < 2000, `${kind} took ${ms} ms (must be under 2 s)`);
    assert.ok(/^[\x00-\x7f]*$/.test(r.stdout), "ASCII only");
    return { ms, answer: R.parseRegistryWrite(parseWindowsJson(r.stdout, r.stderr)), raw: r.stdout };
}
const setV = (name, type, data, expected, path = BASE, extra = {}) => W("set", { ADG_REG_PATH: path, ADG_REG_NAME: name, ADG_REG_TYPE: type, ADG_REG_DATA: R.dataArg(type, R.cleanValueData(type, data)), ADG_REG_EXPECT: R.expectArg(R.cleanExpected(expected)), ...extra }, `set ${type}`).answer;
const delV = (name, expected, path = BASE) => W("deleteValue", { ADG_REG_PATH: path, ADG_REG_NAME: name, ADG_REG_EXPECT: R.expectArg(R.cleanExpected(expected)) }, "delete value").answer;
const mkKey = (p, values) => W("createKey", { ADG_REG_PATH: p, ...(values ? { ADG_REG_VALUES: R.valuesArg(values) } : {}) }, values ? "create key (put values back)" : "create key").answer;
const rmKey = (p, n) => W("deleteKey", { ADG_REG_PATH: p, ADG_REG_EXPECT: n === undefined ? "" : JSON.stringify({ values: n }) }, "delete key").answer;
const readKey = (p) => {
    const f = writeScript("key.ps1", "﻿" + R.REGISTRY_SCRIPTS.key);
    const r = ps(f, { ADG_REG_VIEW: "64", ADG_REG_PATH: p, ADG_REG_TEXT: "", ADG_REG_IN: "keys" });
    return R.parseRegistryKey(parseWindowsJson(r.stdout, r.stderr), p);
};
const val = (p, n) => readKey(p).values.find((v) => v.name === n);
const throwsDevice = (fn, re) => assert.throws(fn, (e) => re.test(String(e.message)));
const ps1 = (text) => ps(writeScript("x.ps1", "﻿" + text), {});

try {
    check("create a key: ok; again: refused (exists); under a missing parent: refused; nothing created either time", () => {
        const a = mkKey(BASE); assert.equal(a.status, "done"); assert.equal(a.valueCount, 0);
        const b = mkKey(BASE); assert.equal(b.status, "refused"); assert.equal(b.reason, "exists");
        const c = mkKey(`${BASE}\\no\\parent`); assert.equal(c.status, "refused"); assert.equal(c.reason, "missing");
        assert.equal(readKey(BASE).subKeyCount, 0);
    });

    check("every type round trips: old is 'not there', new is read back from the registry, and the browser's reader shows the same", () => {
        const cases = [
            ["S", "REG_SZ", "hello"], ["E", "REG_EXPAND_SZ", "%SystemRoot%\\system32"], ["M", "REG_MULTI_SZ", ["a", "b c", "d"]], ["D", "REG_DWORD", "4294967295"], ["Q", "REG_QWORD", "18446744073709551615"], ["B", "REG_BINARY", "00 ff 10 7f 80"],
            ["EmptyS", "REG_SZ", ""], ["EmptyM", "REG_MULTI_SZ", []], ["OneM", "REG_MULTI_SZ", ["only"]], ["EmptyB", "REG_BINARY", ""], ["Zero", "REG_DWORD", "0"], ["QZero", "REG_QWORD", "0"], ["Hex", "REG_DWORD", "0xDEADBEEF"],
        ];
        for (const [n, t, d] of cases) {
            const a = setV(n, t, d, { exists: false });
            assert.equal(a.status, "done", n); assert.deepEqual(a.old, { exists: false }, n);
            assert.equal(a.new.exists, true); assert.equal(a.new.type, t, n);
            assert.deepEqual(a.new.data, R.cleanValueData(t, d), `${n} read back`);
            const shown = val(BASE, n);
            assert.equal(shown.type, t);
            if (t === "REG_DWORD") assert.equal(String(shown.data), R.cleanValueData(t, d)); else if (t === "REG_QWORD") assert.equal(String(shown.data), R.cleanValueData(t, d)); else assert.deepEqual(shown.data, R.cleanValueData(t, d), `${n} as the reader shows it`);
        }
    });

    check("unicode, quotes, backslashes, newlines, dates and PowerShell syntax are stored exactly; the (Default) value works; names too", () => {
        const wild = "café 中😀 \"dq\" 'sq' \\ back\r\nline2\t`n $(calc) $env:USERNAME %PATH% 2026-01-01T00:00:00Z 0x10 {} []";
        const a = setV("Wild \"name\" 'x' é中 $(calc)", "REG_SZ", wild, { exists: false });
        assert.equal(a.new.data, wild);
        assert.equal(val(BASE, "Wild \"name\" 'x' é中 $(calc)").data, wild);
        const d = setV("", "REG_SZ", "default data", { exists: false }); assert.equal(d.new.data, "default data");
        assert.equal(val(BASE, "").display, "(Default)");
        assert.equal(setV("", "REG_SZ", "again", { exists: true, type: "REG_SZ", data: "default data" }).old.data, "default data");
        const m = setV("MultiTricky", "REG_MULTI_SZ", ["2026-01-01", "'; calc; '", "café", "line with \"q\""], { exists: false });
        assert.deepEqual(m.new.data, ["2026-01-01", "'; calc; '", "café", "line with \"q\""]);
        assert.equal(setV("Date", "REG_SZ", "2026-01-01T00:00:00Z", { exists: false }).new.data, "2026-01-01T00:00:00Z", "text that looks like a date stays text");
    });

    check("very long values: 8192 characters, 100 list lines, 4096 bytes round trip whole (and the env variable limit holds)", () => {
        const long = "\"\\x".repeat(2730) + "ab";
        assert.equal(long.length, 8192);
        assert.equal(setV("Long", "REG_SZ", long, { exists: false }).new.data, long);
        const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ` + "x".repeat(70));
        assert.deepEqual(setV("Lines", "REG_MULTI_SZ", lines, { exists: false }).new.data, lines);
        const bytes = Array.from({ length: 4096 }, (_, i) => (i % 256).toString(16).padStart(2, "0")).join(" ");
        const b = setV("Bytes", "REG_BINARY", bytes, { exists: false }); assert.equal(b.new.data, bytes); assert.equal(b.new.size, 4096);
        // and the whole value is compared when it is the expected old value of the next change (no truncation anywhere)
        const again = setV("Long", "REG_SZ", "short", { exists: true, type: "REG_SZ", data: long, size: 8192 }); assert.equal(again.status, "done"); assert.equal(again.old.data, long);
        const r2 = setV("Bytes", "REG_BINARY", "00", { exists: true, type: "REG_BINARY", data: bytes }); assert.equal(r2.status, "done");
    });

    check("overwrite: the old value and type come back, the type can change, the name's case is kept, no 'expected' means no check", () => {
        setV("Over", "REG_SZ", "one", { exists: false });
        const a = setV("Over", "REG_DWORD", "7", { exists: true, type: "REG_SZ", data: "one", size: 3 });
        assert.deepEqual(a.old, { exists: true, type: "REG_SZ", size: 3, data: "one" }); assert.equal(a.new.type, "REG_DWORD"); assert.equal(a.new.data, "7");
        const b = setV("OVER", "REG_SZ", "two", undefined); assert.equal(b.status, "done"); assert.equal(b.old.type, "REG_DWORD");
        assert.equal(readKey(BASE).values.filter((v) => v.name.toLowerCase() === "over").length, 1, "one value, not two");
    });

    check("optimistic concurrency on set: a changed value, a changed type, a changed size, 'should not exist' and 'should exist' are all REFUSED and nothing changes", () => {
        setV("Opt", "REG_SZ", "current", { exists: false });
        const same = () => val(BASE, "Opt").data === "current";
        const bad1 = setV("Opt", "REG_SZ", "X", { exists: true, type: "REG_SZ", data: "stale" }); assert.equal(bad1.status, "refused"); assert.equal(bad1.reason, "changed"); assert.match(bad1.message, /changed on the device since you looked/); assert.equal(bad1.old.data, "current");
        assert.equal(setV("Opt", "REG_SZ", "X", { exists: true, type: "REG_DWORD", data: "5" }).reason, "changed");
        assert.equal(setV("Opt", "REG_SZ", "X", { exists: true, type: "REG_SZ", size: 99 }).reason, "changed", "size alone is compared when no data is given");
        assert.equal(setV("Opt", "REG_SZ", "X", { exists: false }).reason, "changed", "'should not exist' but it does");
        assert.equal(setV("Opt", "REG_SZ", "X", { exists: true, type: "REG_SZ", data: "CURRENT" }).reason, "changed", "data is compared exactly (case)");
        assert.equal(setV("NotThere", "REG_SZ", "X", { exists: true, type: "REG_SZ", data: "a" }).reason, "changed", "'should exist' but it does not");
        assert.equal(val(BASE, "NotThere"), undefined, "nothing was created");
        assert.ok(same(), "the value is untouched");
        assert.equal(setV("Opt", "REG_SZ", "new", { exists: true, type: "REG_SZ", size: 7 }).status, "done", "size alone matches");
        // other types compare too
        setV("OptM", "REG_MULTI_SZ", ["a", "b"], { exists: false });
        assert.equal(setV("OptM", "REG_SZ", "x", { exists: true, type: "REG_MULTI_SZ", data: ["a", "c"] }).reason, "changed");
        assert.equal(setV("OptM", "REG_SZ", "x", { exists: true, type: "REG_MULTI_SZ", data: ["a"] }).reason, "changed");
        assert.equal(setV("OptM", "REG_MULTI_SZ", ["z"], { exists: true, type: "REG_MULTI_SZ", data: ["a", "b"] }).status, "done");
        setV("OptB", "REG_BINARY", "0a 0b", { exists: false });
        assert.equal(setV("OptB", "REG_BINARY", "00", { exists: true, type: "REG_BINARY", data: "0a 0c" }).reason, "changed");
        assert.equal(setV("OptB", "REG_BINARY", "00", { exists: true, type: "REG_BINARY", data: "0A0B" }).status, "done", "hex case and spacing do not matter");
        setV("OptD", "REG_DWORD", "10", { exists: false });
        assert.equal(setV("OptD", "REG_DWORD", "11", { exists: true, type: "REG_DWORD", data: "0x0B" }).reason, "changed");
        assert.equal(setV("OptD", "REG_DWORD", "11", { exists: true, type: "REG_DWORD", data: "0xA" }).status, "done");
    });

    check("delete a value: old comes back; a stale expectation, a missing value are refused", () => {
        setV("Del", "REG_SZ", "bye", { exists: false });
        assert.equal(delV("Del", { exists: true, type: "REG_SZ", data: "other" }).reason, "changed"); assert.ok(val(BASE, "Del"), "still there");
        assert.equal(delV("Del", { exists: false }).reason, "changed");
        const a = delV("Del", { exists: true, type: "REG_SZ", data: "bye" }); assert.equal(a.status, "done"); assert.equal(a.old.data, "bye"); assert.deepEqual(a.new, { exists: false });
        assert.equal(val(BASE, "Del"), undefined);
        const b = delV("Del", undefined); assert.equal(b.status, "refused"); assert.equal(b.reason, "missing");
        setV("DelDefault", "REG_SZ", "x", { exists: false }); assert.equal(delV("DelDefault", undefined).status, "done");
    });

    check("secret-looking names are refused by the script too: nothing is written, deleted or read back", () => {
        for (const n of ["MyPassword", "ApiKey", "client_secret", "Token1"]) {
            const a = W("set", { ADG_REG_PATH: BASE, ADG_REG_NAME: n, ADG_REG_TYPE: "REG_SZ", ADG_REG_DATA: R.dataArg("REG_SZ", "hunter2") }).answer;
            assert.equal(a.status, "refused"); assert.equal(a.reason, "masked"); assert.match(a.message, /blocked/);
            assert.equal(val(BASE, n), undefined, `${n} was not written`);
            assert.equal(W("deleteValue", { ADG_REG_PATH: BASE, ADG_REG_NAME: n }).answer.reason, "masked");
        }
        // a secret-named value that exists (put there by someone else) is not touched, read, or recorded
        ps1(`New-ItemProperty 'HKCU:\\Software\\AdgRmm-Test' 'PreexistingPassword' -Value 'real-secret-data' | Out-Null`);
        const d = W("deleteValue", { ADG_REG_PATH: BASE, ADG_REG_NAME: "PreexistingPassword" });
        assert.equal(d.answer.reason, "masked"); assert.ok(!d.raw.includes("real-secret-data"));
        assert.ok(readKey(BASE).values.some((v) => v.name === "PreexistingPassword"), "still there");
        ps1(`Remove-ItemProperty 'HKCU:\\Software\\AdgRmm-Test' 'PreexistingPassword'`);
    });

    check("blocklist inside the script: refused BEFORE anything is opened (HKLM roots, Winlogon Shell, IFEO, Session Manager, ADG RMM, Lsa); HKLM itself cannot be written without elevation", () => {
        const set = (p, n = "x") => W("set", { ADG_REG_PATH: p, ADG_REG_NAME: n, ADG_REG_TYPE: "REG_SZ", ADG_REG_DATA: R.dataArg("REG_SZ", "v") }).answer;
        for (const [p, n] of [["HKLM\\SOFTWARE", "x"], ["HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon", "Shell"], ["HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\notepad.exe", "Debugger"],
            ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager", "BootExecute"], ["HKLM\\SOFTWARE\\AdgRmm", "x"], ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa", "x"], [`HKU\\${sid}`, "x"]]) {
            const a = set(p, n); assert.equal(a.status, "refused", p); assert.equal(a.reason, "blocked", p); assert.match(a.message, /^This change is blocked: /);
        }
        assert.equal(W("createKey", { ADG_REG_PATH: "HKLM\\SYSTEM" }).answer.reason, "blocked");
        assert.equal(W("deleteKey", { ADG_REG_PATH: "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" }).answer.reason, "blocked");
        assert.equal(W("deleteValue", { ADG_REG_PATH: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", ADG_REG_NAME: "EnableLUA" }).answer.reason, "blocked");
        // an allowed HKLM path: the script reaches the registry and Windows refuses (not elevated): an error, not a silent success
        throwsDevice(() => set("HKLM\\SOFTWARE\\AdgRegNoSuchVendor"), /does not exist|denied|not allowed|Access/i);
    });

    check("create a key with values (used to put back a deleted key); a failure part way leaves nothing behind", () => {
        const p = `${BASE}\\Restored`;
        const a = mkKey(p, [{ name: "a", type: "REG_SZ", data: "x\"y" }, { name: "", type: "REG_DWORD", data: "5" }, { name: "m", type: "REG_MULTI_SZ", data: ["1", "2"] }, { name: "b", type: "REG_BINARY", data: "01 02" }, { name: "q", type: "REG_QWORD", data: "9" }]);
        assert.equal(a.status, "done"); assert.equal(a.valueCount, 5);
        const k = readKey(p); assert.equal(k.valueCount, 5); assert.equal(k.values.find((v) => v.name === "a").data, "x\"y"); assert.deepEqual(k.values.find((v) => v.name === "m").data, ["1", "2"]);
        const bad = mkKey(`${BASE}\\Partial`, [{ name: "ok", type: "REG_SZ", data: "x" }, { name: "MyPassword", type: "REG_SZ", data: "no" }]);
        assert.equal(bad.status, "refused"); assert.equal(bad.reason, "masked");
        assert.ok(!readKey(BASE).subKeys.some((s) => s.name === "Partial"), "no half-made key");
    });

    check("delete key: refused when it has sub keys (and says how many, deletes nothing); only an empty key goes; its values come back in the answer", () => {
        mkKey(`${BASE}\\Parent`); mkKey(`${BASE}\\Parent\\Child1`); mkKey(`${BASE}\\Parent\\Child2`);
        setV("v", "REG_SZ", "kept", { exists: false }, `${BASE}\\Parent`);
        const a = rmKey(`${BASE}\\Parent`); assert.equal(a.status, "refused"); assert.equal(a.reason, "hassubkeys"); assert.match(a.message, /has 2 sub keys/);
        assert.ok(val(`${BASE}\\Parent`, "v"), "nothing was deleted");
        assert.equal(rmKey(`${BASE}\\Parent\\Child1`).status, "done");
        const b = rmKey(`${BASE}\\Parent`); assert.equal(b.reason, "hassubkeys"); assert.match(b.message, /has 1 sub key\./);
        assert.equal(rmKey(`${BASE}\\Parent\\Child2`).status, "done");
        const c = rmKey(`${BASE}\\Parent`, 1); assert.equal(c.status, "done"); assert.deepEqual(c.values.map((v) => [v.name, v.type, v.data]), [["v", "REG_SZ", "kept"]]);
        assert.ok(!readKey(BASE).subKeys.some((s) => s.name === "Parent"));
        assert.equal(rmKey(`${BASE}\\Parent`).reason, "missing");
    });

    check("delete key refusals: the value count changed since, a secret-named value inside, too many values, too much data, an unrecordable type: nothing is deleted", () => {
        const p = `${BASE}\\Guard`; mkKey(p); setV("a", "REG_SZ", "1", { exists: false }, p);
        const c = rmKey(p, 0); assert.equal(c.reason, "changed"); assert.ok(val(p, "a"));
        ps1(`New-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' 'Password1' -Value 'real-secret' | Out-Null`);
        const s = W("deleteKey", { ADG_REG_PATH: p }); assert.equal(s.answer.reason, "masked"); assert.ok(!s.raw.includes("real-secret")); assert.ok(readKey(p).values.some((v) => v.name === "Password1"));
        ps1(`Remove-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' 'Password1'`);
        ps1(`1..101 | ForEach-Object { New-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' ('n' + $_) -Value 'x' | Out-Null }`);
        assert.equal(rmKey(p).reason, "toolarge");
        ps1(`1..101 | ForEach-Object { Remove-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' ('n' + $_) }`);
        ps1(`New-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' 'Blob' -Value ([byte[]](1..12 | ForEach-Object { 0..255 })) -PropertyType Binary | Out-Null`);
        assert.equal(rmKey(p).reason, "toolarge", "3072 bytes weigh 9216, more than 8000");
        ps1(`Remove-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' 'Blob'`);
        ps1(`New-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' 'Huge' -Value ('x' * 9000) | Out-Null`);
        assert.equal(rmKey(p).reason, "unrecordable"); assert.ok(val(p, "a"));
        const o = setV("Huge", "REG_SZ", "small", undefined, p); assert.equal(o.reason, "unrecordable", "overwriting a value too big to record is refused too");
        assert.equal(delV("Huge", undefined, p).reason, "unrecordable");
        ps1(`Remove-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' 'Huge'`);
        ps1(`New-ItemProperty 'HKCU:\\Software\\AdgRmm-Test\\Guard' 'NoneKind' -Value ([byte[]](1,2)) -PropertyType Binary | Out-Null`);
        assert.equal(rmKey(p, 2).status, "done", "the guard key is deletable once it only holds ordinary values");
    });

    check("undo at the script level: restores the old value / removes what was created / puts a deleted key back, ONLY while the state is what the change left", () => {
        const p = `${BASE}\\Undo`; mkKey(p);
        // set over an old value
        setV("U", "REG_SZ", "old", { exists: false }, p);
        const ch = setV("U", "REG_MULTI_SZ", ["new1", "new2"], { exists: true, type: "REG_SZ", data: "old" }, p);
        const left = { exists: true, type: "REG_MULTI_SZ", data: ["new1", "new2"] };
        setV("U", "REG_SZ", "someone else changed it", undefined, p);
        const refused = setV("U", ch.old.type, ch.old.data, left, p); assert.equal(refused.status, "refused"); assert.equal(refused.reason, "changed"); assert.equal(val(p, "U").data, "someone else changed it", "not clobbered");
        setV("U", "REG_MULTI_SZ", ["new1", "new2"], undefined, p);
        const undone = setV("U", ch.old.type, ch.old.data, left, p); assert.equal(undone.status, "done"); assert.equal(val(p, "U").data, "old"); assert.equal(val(p, "U").type, "REG_SZ");
        // set that created the value: undo removes it, only if unchanged
        const made = setV("Created", "REG_DWORD", "5", { exists: false }, p); assert.deepEqual(made.old, { exists: false });
        setV("Created", "REG_DWORD", "6", undefined, p);
        assert.equal(delV("Created", { exists: true, type: "REG_DWORD", data: "5" }, p).reason, "changed"); assert.ok(val(p, "Created"));
        setV("Created", "REG_DWORD", "5", undefined, p);
        assert.equal(delV("Created", { exists: true, type: "REG_DWORD", data: "5" }, p).status, "done"); assert.equal(val(p, "Created"), undefined);
        // delete of a value: undo sets it back only if nobody re-created it
        setV("Gone", "REG_BINARY", "01 02 03", { exists: false }, p);
        const d = delV("Gone", { exists: true, type: "REG_BINARY", data: "01 02 03" }, p);
        setV("Gone", "REG_SZ", "recreated", undefined, p);
        assert.equal(setV("Gone", d.old.type, d.old.data, { exists: false }, p).reason, "changed"); assert.equal(val(p, "Gone").data, "recreated");
        delV("Gone", undefined, p);
        assert.equal(setV("Gone", d.old.type, d.old.data, { exists: false }, p).status, "done"); assert.equal(val(p, "Gone").data, "01 02 03");
        // created key: undo deletes it only while empty
        mkKey(`${p}\\NewKey`); setV("sneaky", "REG_SZ", "x", { exists: false }, `${p}\\NewKey`);
        assert.equal(rmKey(`${p}\\NewKey`, 0).reason, "changed"); delV("sneaky", undefined, `${p}\\NewKey`); assert.equal(rmKey(`${p}\\NewKey`, 0).status, "done");
        // deleted key: undo recreates it with its values, only if it is not there again
        mkKey(`${p}\\Back`); setV("k1", "REG_SZ", "v1", { exists: false }, `${p}\\Back`); setV("k2", "REG_QWORD", "123456789012", { exists: false }, `${p}\\Back`);
        const dk = rmKey(`${p}\\Back`, 2); assert.equal(dk.values.length, 2);
        const values = dk.values.map((v) => ({ name: v.name, type: v.type, data: v.data }));
        mkKey(`${p}\\Back`);
        assert.equal(mkKey(`${p}\\Back`, values).reason, "exists", "the key exists again: refused, not merged");
        rmKey(`${p}\\Back`, 0);
        const back = mkKey(`${p}\\Back`, values); assert.equal(back.status, "done"); assert.equal(back.valueCount, 2);
        assert.equal(val(`${p}\\Back`, "k1").data, "v1"); assert.equal(String(val(`${p}\\Back`, "k2").data), "123456789012");
    });

    check("hostile text only ever travels in environment variables: nothing typed is executed, and no script contains it", () => {
        const sentinel = path.join(dir, "pwned.txt"); const sentinelPs = sentinel.split(String.fromCharCode(92)).join("/");
        const evil = `'; New-Item '${sentinelPs}' -ItemType File; '`;
        const evil2 = `$(New-Item '${sentinelPs}' -ItemType File)`;
        const a = setV(evil, "REG_SZ", evil2 + "\r\n" + evil, { exists: false }); assert.equal(a.status, "done"); assert.equal(a.new.data, evil2 + "\r\n" + evil);
        const m = setV("evilmulti", "REG_MULTI_SZ", [evil, evil2, "`$(calc)"], { exists: false }); assert.deepEqual(m.new.data, [evil, evil2, "`$(calc)"]);
        assert.equal(delV(evil, { exists: true, type: "REG_SZ", data: evil2 + "\r\n" + evil }).status, "done");
        const k = mkKey(`${BASE}\\${evil}`); assert.equal(k.status, "done"); assert.ok(readKey(BASE).subKeys.some((s) => s.name === evil));
        assert.equal(rmKey(`${BASE}\\${evil}`).status, "done");
        assert.ok(!fs.existsSync(sentinel), "the injected command never ran");
        for (const t of Object.values(R.REGISTRY_WRITE_SCRIPTS)) assert.ok(!t.includes("New-Item") && !t.includes("pwned"), "no typed text in the script");
        // a malformed argument (not made by the server) is an error, never a write
        throwsDevice(() => W("set", { ADG_REG_PATH: BASE, ADG_REG_NAME: "bad", ADG_REG_TYPE: "REG_SZ", ADG_REG_DATA: JSON.stringify({ v: "no prefix" }) }), /malformed/);
        throwsDevice(() => W("set", { ADG_REG_PATH: BASE, ADG_REG_NAME: "bad", ADG_REG_TYPE: "REG_DWORD", ADG_REG_DATA: R.dataArg("REG_DWORD", "4294967296") }), /./);
        throwsDevice(() => W("set", { ADG_REG_PATH: BASE, ADG_REG_NAME: "bad", ADG_REG_TYPE: "REG_BINARY", ADG_REG_DATA: R.dataArg("REG_BINARY", "zz") }), /hex/);
        throwsDevice(() => W("set", { ADG_REG_PATH: BASE, ADG_REG_NAME: "bad", ADG_REG_TYPE: "REG_NONE", ADG_REG_DATA: R.dataArg("REG_SZ", "x") }), /cannot be written/);
        assert.equal(val(BASE, "bad"), undefined);
    });
} finally {
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\ntimings (each script under 2 s):\n  " + timings.join("\n  "));
const worst = Math.max(...timings.map((t) => Number(/: (\d+) ms/.exec(t)[1])));
const avg = Math.round(timings.reduce((n, t) => n + Number(/: (\d+) ms/.exec(t)[1]), 0) / timings.length);
console.log(`\n${timings.length} script runs, slowest ${worst} ms, average ${avg} ms`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
