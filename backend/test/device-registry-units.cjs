// The registry browser's pure parts, without a device or a database: path checks, the blocklist, the value-name mask, how
// what a script printed is turned into rows, and that the fixed scripts never contain anything a person typed.
// Run after a build: node test/device-registry-units.cjs (DIST defaults to dist). The scripts themselves are run for real by
// test/device-registry-scripts.cjs (Windows only).
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "device-tools");
const R = require(path.join(dist, "device-registry.scripts.js"));
const { parseWindowsJson } = require(path.join(dist, "device-tools.scripts.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const bad = (fn, re) => assert.throws(fn, (e) => (re ? re.test(String(e.message)) : true));

check("paths: accepted spellings are normalised to HKLM / HKU", () => {
    assert.equal(R.cleanRegistryPath("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft"), "HKLM\\SOFTWARE\\Microsoft");
    assert.equal(R.cleanRegistryPath("hklm\\software\\"), "HKLM\\software");
    assert.equal(R.cleanRegistryPath("\\HKU\\S-1-5-18\\Software"), "HKU\\S-1-5-18\\Software");
    assert.equal(R.cleanRegistryPath("HKEY_USERS"), "HKU");
    assert.equal(R.cleanRegistryPath(""), "");
    assert.equal(R.cleanRegistryPath(undefined), "");
    assert.equal(R.cleanRegistryPath("HKLM\\SOFTWARE\\Caf\u00e9 \u00dcn\u00ef\\\u4e2d"), "HKLM\\SOFTWARE\\Caf\u00e9 \u00dcn\u00ef\\\u4e2d");
    assert.equal(R.cleanRegistryPath("HKLM\\SOFTWARE\\Microsoft\\Windows NT\\TCP/IP"), "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\TCP/IP");
});

check("paths: wildcards, control characters, dots, empty parts, bad roots and sizes are refused", () => {
    for (const p of ["HKLM\\SOFTWARE\\*", "HKLM\\SOFT?ARE", "HKLM\\a\u0000b", "HKLM\\a\nb", "HKLM\\a\u007fb", "HKLM\\..\\SAM", "HKLM\\SOFTWARE\\..\\SAM", "HKLM\\.\\SOFTWARE", "HKLM\\\\SOFTWARE", "HKLM\\SOFTWARE\\ \\x",
        "HKCU\\Software", "HKEY_CURRENT_USER\\Software", "HKCR\\.txt", "HKCC", "HKEY_CLASSES_ROOT", "C:\\Windows", "SOFTWARE\\Microsoft", "HKLM/SOFTWARE/Microsoft", "HKLMX\\a", "HKLM:\\SOFTWARE"]) {
        bad(() => R.cleanRegistryPath(p), undefined);
    }
    bad(() => R.cleanRegistryPath("HKLM\\" + "a".repeat(256)), /too long/);
    bad(() => R.cleanRegistryPath("HKLM\\" + "a\\".repeat(70)), /deep/);
    bad(() => R.cleanRegistryPath("HKLM\\" + ("abcdefgh\\".repeat(150))), /too long/);
    bad(() => R.cleanRegistryPath("", { allowEmpty: false }), /Say which key/);
    bad(() => R.cleanRegistryPath("HKCU\\Software"), /HKU/);
});

check("view and search arguments", () => {
    assert.equal(R.cleanView(undefined), "64"); assert.equal(R.cleanView("32"), "32"); assert.equal(R.cleanView("64"), "64");
    bad(() => R.cleanView("128")); bad(() => R.cleanView("x; calc"));
    assert.equal(R.cleanSearchIn(undefined), "keys"); assert.equal(R.cleanSearchIn("DATA"), "data");
    bad(() => R.cleanSearchIn("regex"));
    assert.equal(R.cleanRegistrySearchText("  Run  "), "Run");
    assert.equal(R.cleanRegistrySearchText("a.*b[x]"), "a.*b[x]", "kept as a plain substring");
    bad(() => R.cleanRegistrySearchText("")); bad(() => R.cleanRegistrySearchText("a\u0000b")); bad(() => R.cleanRegistrySearchText("x".repeat(201)));
});

check("blocklist: SAM, SECURITY, Lsa in every control set, LogonUI, protected storage, and everything below", () => {
    for (const p of ["HKLM\\SAM", "HKLM\\sam\\SAM\\Domains", "HKLM\\SECURITY", "HKLM\\SECURITY\\Policy\\Secrets",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\Data", "HKLM\\SYSTEM\\ControlSet001\\Control\\Lsa", "HKLM\\system\\controlset002\\control\\lsa\\Skew1", "HKLM\\SYSTEM\\ControlSet003\\Control\\Lsa\\JD",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI\\SessionData\\1",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI",
        "HKU\\S-1-5-21-1-2-3-1001\\Software\\Microsoft\\Protected Storage System Provider"]) {
        assert.ok(R.isBlockedPath(p), p);
        bad(() => R.assertNotBlocked(p), /blocked/);
    }
    try { R.assertNotBlocked("HKLM\\SAM"); assert.fail("not thrown"); } catch (e) { assert.equal(e.getStatus(), 403); }
});

check("blocklist: look-alikes are not blocked (no over-matching by prefix)", () => {
    for (const p of ["HKLM", "HKLM\\SOFTWARE", "HKLM\\SAMPLE", "HKLM\\SECURITY2", "HKLM\\SYSTEM\\CurrentControlSet\\Control", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\LsaExtra", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager",
        "HKLM\\SYSTEM\\ControlSet1\\Control\\Lsa", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUIx", "HKU\\S-1-5-21-1\\Software", "HKU\\.DEFAULT"]) {
        assert.ok(!R.isBlockedPath(p), p);
    }
});

check("mask: names that look like secrets, in any case; ordinary names are not", () => {
    for (const n of ["DefaultPassword", "AltDefaultPassword", "password", "PASSWD", "Pass", "UserPwd_pass", "ClientSecret", "AccessToken", "token", "Credential", "Credentials", "ApiKey", "api_key", "PrivateKey", "private-key", "private key", "VncPassword", "LocalPasswordPolicy"]) assert.ok(R.isMaskedName(n), n);
    for (const n of ["", "DisplayName", "InstallDate", "Version", "Path", "DefaultUserName", "Start", "ImagePath", "Key"]) assert.ok(!R.isMaskedName(n), n);
});

check("mask: applied again to what the device sent, even when the script did not hide it", () => {
    const v = R.normaliseValue({ name: "DefaultPassword", type: "REG_SZ", size: 6, d: "hunter" });
    assert.deepEqual(v, { name: "DefaultPassword", display: "DefaultPassword", type: "REG_SZ", size: 6, data: null, masked: true });
    const k = R.parseRegistryKey({ ok: true, values: [{ name: "ApiKey", type: "REG_BINARY", size: 4, d: "de ad be ef" }, { name: "Plain", type: "REG_SZ", size: 2, d: "ok" }], subKeys: [] }, "HKLM\\SOFTWARE\\X");
    assert.equal(k.values[0].data, null); assert.equal(k.values[0].masked, true); assert.equal(k.values[0].hex, undefined); assert.equal(k.values[1].data, "ok");
    assert.ok(!JSON.stringify(k).includes("de ad be ef"));
});

check("values: every type is rendered", () => {
    const n = (o) => R.normaliseValue(o);
    assert.deepEqual(n({ name: "", type: "REG_SZ", size: 3, d: "abc" }), { name: "", display: "(Default)", type: "REG_SZ", size: 3, data: "abc" });
    assert.equal(n({ name: "p", type: "REG_EXPAND_SZ", size: 21, d: "%SystemRoot%\\x" }).data, "%SystemRoot%\\x", "not expanded");
    assert.deepEqual(n({ name: "m", type: "REG_MULTI_SZ", size: 4, d: ["a", "b c", ""] }).data, ["a", "b c", ""]);
    assert.deepEqual(n({ name: "m", type: "REG_MULTI_SZ", size: 1, d: "one" }).data, ["one"], "a single-item list printed as text");
    const dw = n({ name: "d", type: "REG_DWORD", size: 4, d: "4294967295" });
    assert.equal(dw.data, 4294967295); assert.equal(dw.hex, "0xFFFFFFFF");
    assert.equal(n({ name: "d", type: "REG_DWORD", size: 4, d: "10" }).hex, "0x0000000A");
    const qw = n({ name: "q", type: "REG_QWORD", size: 8, d: "18446744073709551615" });
    assert.equal(qw.data, "18446744073709551615"); assert.equal(qw.hex, "0xFFFFFFFFFFFFFFFF");
    assert.equal(n({ name: "q", type: "REG_QWORD", size: 8, d: "4096" }).data, 4096);
    assert.equal(n({ name: "d", type: "REG_DWORD", size: 4, d: "nonsense" }).unreadable, true);
    const bin = n({ name: "b", type: "REG_BINARY", size: 600, d: "00 01 ff", trunc: true });
    assert.equal(bin.data, "00 01 ff"); assert.equal(bin.truncated, true); assert.equal(bin.size, 600);
    assert.equal(n({ name: "b", type: "REG_BINARY", size: 600, d: "00" }).truncated, true, "size over the shown bytes means truncated");
    assert.equal(n({ name: "b", type: "REG_NONE", size: 0, d: "" }).data, "");
    assert.equal(n({ name: "b", type: "REG_UNKNOWN", size: 2, d: "0a 0b" }).type, "REG_UNKNOWN");
    assert.equal(n({ name: "b", type: "REG_WEIRD", size: 2, d: "0a 0b" }).type, "REG_UNKNOWN");
    const long = n({ name: "s", type: "REG_SZ", size: 9000, d: "x".repeat(9000), trunc: true });
    assert.equal(long.data.length, R.MAX_STRING_CHARS); assert.equal(long.truncated, true);
    assert.equal(n({ name: "s", type: "REG_SZ", size: 1, unreadable: true }).unreadable, true);
});

check("key listing: sub keys keep the blocked flag, a blocked child never claims children, last write is validated", () => {
    const k = R.parseRegistryKey({ ok: true, lastWrite: "2026-11-09T19:39:23.3336133Z", subKeyCount: 3, subKeysTruncated: false, valueCount: 0, valuesTruncated: false, subKeys: [{ name: "Policies", has: true }, { name: "Lsa", has: true }, { name: "x", has: false, blocked: false }], values: [] }, "HKLM\\SYSTEM\\CurrentControlSet\\Control");
    assert.deepEqual(k.subKeys.map((s) => [s.name, s.hasChildren, s.blocked]), [["Policies", true, false], ["Lsa", false, true], ["x", false, false]], "Lsa is blocked by the server even if the device did not say so");
    assert.equal(k.lastWrite, "2026-11-09T19:39:23.3336133Z");
    assert.equal(R.parseRegistryKey({ lastWrite: "garbage" }, "HKLM").lastWrite, null);
    const cut = R.parseRegistryKey({ subKeyCount: 5000, subKeysTruncated: true, subKeys: [{ name: "a" }], valueCount: 3000, valuesTruncated: true, values: [] }, "HKLM");
    assert.equal(cut.subKeyCount, 5000); assert.equal(cut.subKeysTruncated, true); assert.equal(cut.valueCount, 3000); assert.equal(cut.valuesTruncated, true);
    assert.deepEqual(R.parseRegistryKey({}, "HKLM").subKeys, []);
});

check("search results: blocked paths and secret-named data hits are dropped, cuts are reported", () => {
    const s = R.parseRegistrySearch({ ok: true, truncated: true, reason: "time", scanned: 10, seconds: 20, results: [
        { kind: "key", path: "HKLM\\SOFTWARE\\Run" },
        { kind: "key", path: "HKLM\\SAM\\x" },
        { kind: "value", path: "HKLM\\SOFTWARE\\A", name: "Password" },
        { kind: "data", path: "HKLM\\SOFTWARE\\A", name: "Password", type: "REG_SZ", preview: "hunter2" },
        { kind: "data", path: "HKLM\\SOFTWARE\\A", name: "Path", type: "REG_SZ", preview: "C:\\x" },
        { kind: "nonsense", path: "HKLM\\x" },
    ] });
    assert.deepEqual(s.results.map((r) => [r.kind, r.path, r.name]), [["key", "HKLM\\SOFTWARE\\Run", undefined], ["value", "HKLM\\SOFTWARE\\A", "Password"], ["data", "HKLM\\SOFTWARE\\A", "Path"]]);
    assert.ok(!JSON.stringify(s).includes("hunter2"));
    assert.equal(s.truncated, true); assert.equal(s.reason, "time");
    assert.equal(R.parseRegistrySearch({ results: [] }).truncated, false);
    assert.equal(R.parseRegistrySearch({ reason: "results", results: [] }).truncated, true);
});

check("roots: only well formed SIDs are listed, each with its HKU path", () => {
    const r = R.parseRegistryRoots({ users: [{ sid: "S-1-5-21-1-2-3-1001", account: "Ann" }, { sid: "S-1-5-18", account: "SYSTEM" }, { sid: ".DEFAULT", account: null }, { sid: "S-1-5-21-1-2-3-1001_Classes" }, { sid: "x\\y" }] });
    assert.deepEqual(r.roots.map((x) => x.key), ["HKLM", "HKU"]);
    assert.deepEqual(r.users.map((u) => u.path), ["HKU\\S-1-5-21-1-2-3-1001", "HKU\\S-1-5-18", "HKU\\.DEFAULT"]);
    assert.equal(r.users[0].account, "Ann"); assert.equal(r.users[2].account, null);
});

check("the device's answer: errors and cut-off output are explained (same reader as the other tools)", () => {
    bad(() => parseWindowsJson(JSON.stringify({ ok: false, error: "That registry key does not exist on this device." }), ""), /does not exist/);
    bad(() => parseWindowsJson("{\"ok\":true,\"subKeys\":[{\"na", ""), /cut short/);
    bad(() => parseWindowsJson("", "boom"), /boom/);
});

check("scripts: fixed text, no typed values, the blocklist and mask are in them, only .NET registry APIs (no WMI/CIM)", () => {
    for (const [k, s] of Object.entries(R.REGISTRY_SCRIPTS)) {
        assert.ok(!/Get-CimInstance|Get-WmiObject|Win32_|Get-ItemProperty|Get-ChildItem|Invoke-Expression|\biex\b|Add-Type/i.test(s), `${k} uses nothing slow or dynamic`);
        for (const b of R.BLOCKED_KEYS) assert.ok(s.includes(b.pattern), `${k} has ${b.pattern}`);
        assert.ok(s.includes(R.MASK_NAME_SOURCE), `${k} has the mask`);
        assert.ok(!s.includes("`"), "no backticks");
    }
    assert.ok(R.REGISTRY_SCRIPTS.key.includes("$env:RIQ_REG_PATH") && R.REGISTRY_SCRIPTS.search.includes("$env:RIQ_REG_PATH"), "the path comes from the environment");
    assert.ok(R.REGISTRY_SCRIPTS.search.includes("$env:RIQ_REG_TEXT"), "the search text comes from the environment");
    assert.ok(R.REGISTRY_SCRIPTS.key.includes("DoNotExpandEnvironmentNames"));
    assert.ok(R.REGISTRY_SCRIPTS.key.includes("OpenBaseKey"));
    assert.ok(R.REGISTRY_SCRIPTS.search.includes("IndexOf($text, [StringComparison]::OrdinalIgnoreCase)"), "plain substring, no -like / -match on the text");
    assert.ok(!/-like\s+\$text|-match\s+\$text|-contains\s+\$text/.test(R.REGISTRY_SCRIPTS.search));
    assert.ok(R.REGISTRY_SCRIPTS.search.includes(`${R.SEARCH_MAX_DEPTH}`) && R.REGISTRY_SCRIPTS.search.includes(`${R.SEARCH_MAX_RESULTS}`) && R.REGISTRY_SCRIPTS.search.includes(`${R.SEARCH_MAX_SECONDS}`));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
