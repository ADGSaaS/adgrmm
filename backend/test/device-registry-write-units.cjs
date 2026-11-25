// The registry editor's pure parts (phase 2), without a device or a database: the WRITE blocklist, the secret-name mask for writes,
// the checking and parsing of value names, types and data (limits, ranges, strict hex), the "expected old value" and the job
// environment, the rate limiter, how a script's answer is read, and that the fixed write scripts hold nothing a person typed and
// no recursive delete. The scripts are run for real by test/device-registry-write-scripts.cjs (Windows only).
// Run after a build: node test/device-registry-write-units.cjs (DIST defaults to dist).
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "device-tools");
const R = require(path.join(dist, "device-registry.scripts.js"));
const L = require(path.join(dist, "device-registry.limiter.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const bad = (fn, re) => assert.throws(fn, (e) => (re ? re.test(String(e.message)) : true));
const refused = (p, op = "value", name = "x") => R.writeBlockedReason(p, op, name);

check("write blocklist: roots and top-level keys cannot be created, deleted or given values (any spelling, both ops)", () => {
    for (const p of ["HKLM", "HKU", "HKLM\\SOFTWARE", "HKLM\\SYSTEM", "HKLM\\SAM", "HKU\\S-1-5-21-1-2-3-1001", "HKU\\.DEFAULT", "hklm\\software", "HKU\\S-1-5-18"]) {
        for (const op of ["value", "createkey", "deletekey"]) assert.ok(refused(p, op), `${p} ${op}`);
    }
    assert.ok(!refused("HKLM\\SOFTWARE\\Vendor"), "a key one level further is fine");
    assert.ok(!refused("HKU\\S-1-5-21-1-2-3-1001\\Software\\RemoteIQ-Test"), "a user hive's Software key is fine (also a key named RemoteIQ-Test under HKU)");
    assert.ok(!refused("HKU\\S-1-5-21-1-2-3-1001\\Software"));
});

check("write blocklist: Setup, SafeBoot and Session Manager in the live and every numbered control set, with everything below them", () => {
    for (const cs of ["CurrentControlSet", "ControlSet001", "ControlSet002", "controlset003"]) {
        for (const tail of ["Control\\SafeBoot", "Control\\SafeBoot\\Minimal\\x", "Control\\Session Manager", "Control\\Session Manager\\Memory Management", "Control\\session manager\\Environment"]) {
            for (const op of ["value", "createkey", "deletekey"]) assert.ok(refused(`HKLM\\SYSTEM\\${cs}\\${tail}`, op), `${cs} ${tail} ${op}`);
        }
    }
    for (const p of ["HKLM\\SYSTEM\\Setup", "HKLM\\SYSTEM\\Setup\\Status", "hklm\\system\\setup\\a\\b"]) assert.ok(refused(p), p);
    assert.ok(!refused("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session ManagerX"), "a sibling with a longer name is not the key");
    assert.ok(!refused("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print"), "other Control keys are allowed");
    assert.ok(!refused("HKLM\\SYSTEM\\CurrentControlSet\\Services\\Spooler"), "services in general are allowed");
    assert.ok(!refused("HKLM\\SYSTEM\\SetupX"), "SetupX is not Setup");
});

check("write blocklist: Winlogon Shell / Userinit / AppSetup / Taskman values (any case, 32 and 64-bit), nothing else in Winlogon", () => {
    const k = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon";
    for (const n of ["Shell", "shell", "USERINIT", "AppSetup", "Taskman"]) assert.ok(refused(k, "value", n), n);
    assert.ok(refused(k.replace("SOFTWARE\\", "SOFTWARE\\WOW6432Node\\"), "value", "Shell"), "WOW6432Node too");
    for (const n of ["DefaultUserName", "LegalNoticeText", "ShellX", "MyShell", "Shell2", ""]) assert.ok(!refused(k, "value", n), `${n} is allowed`);
    assert.ok(refused(k, "deletekey"), "the Winlogon key itself cannot be deleted");
    
    assert.ok(!refused(k + "\\Notifications", "value", "Shell"), "a sub key of Winlogon is not the Winlogon key");
    assert.ok(!refused(k + "\\Notifications", "deletekey"));
});

check("write blocklist: Image File Execution Options and SilentProcessExit (debugger hijack), 64 and 32-bit, with everything below", () => {
    for (const base of ["HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion"]) {
        for (const tail of ["Image File Execution Options", "Image File Execution Options\\notepad.exe", "SilentProcessExit", "SilentProcessExit\\x\\y", "image file execution options\\a"]) {
            for (const op of ["value", "createkey", "deletekey"]) assert.ok(refused(`${base}\\${tail}`, op), `${base} ${tail} ${op}`);
        }
        assert.ok(!refused(`${base}\\Image File Execution OptionsX`), "sibling name");
        assert.ok(!refused(`${base}\\ProfileList`), "other keys of CurrentVersion are allowed");
    }
});

check("write blocklist: the Run keys (HKLM and any user's hive, 64 and 32-bit) and everything below them", () => {
    const sid = "S-1-5-21-111-222-333-1001";
    const bases = ["HKLM\\SOFTWARE", "HKLM\\SOFTWARE\\WOW6432Node", `HKU\\${sid}\\SOFTWARE`, `HKU\\${sid}\\SOFTWARE\\WOW6432Node`];
    for (const base of bases) {
        for (const tail of ["Run", "RunOnce", "RunServices", "RunServicesOnce", "RunOnceEx", "run", "Run\\Sub", "Policies\\Explorer\\Run"]) {
            for (const op of ["value", "createkey", "deletekey"]) assert.ok(refused(`${base}\\Microsoft\\Windows\\CurrentVersion\\${tail}`, op), `${base} ${tail} ${op}`);
        }
        assert.ok(!refused(`${base}\\Microsoft\\Windows\\CurrentVersion\\RunX`), "a sibling name is allowed");
        assert.ok(!refused(`${base}\\Microsoft\\Windows\\CurrentVersion\\Explorer`), "other CurrentVersion keys are allowed");
    }
    assert.ok(refused("HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\Notify\\x", "createkey"));
    assert.ok(!refused("HKLM\\SOFTWARE\\Contoso\\Run", "value"), "an application's own key called Run is not the Windows one");
});

check("write blocklist: AppInit_DLLs and its companions in the Windows key (64 and 32-bit), the other values stay writable", () => {
    for (const base of ["HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows", "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Windows"]) {
        for (const name of ["AppInit_DLLs", "LoadAppInit_DLLs", "RequireSignedAppInit_DLLs", "Load", "Run", "appinit_dlls"]) assert.ok(refused(base, "value", name), `${base} ${name}`);
        assert.ok(refused(base, "deletekey"), "the key itself cannot be deleted");
        assert.ok(!refused(base, "value", "DeviceNotSelectedTimeout"), "an ordinary value of the key is allowed");
        assert.ok(!refused(base + "\\Sub", "value", "AppInit_DLLs"), "a sub key is not the Windows key");
    }
});

check("write blocklist: Policies\\System EnableLUA / ConsentPromptBehaviorAdmin / LocalAccountTokenFilterPolicy only", () => {
    const k = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System";
    for (const n of ["EnableLUA", "enablelua", "ConsentPromptBehaviorAdmin", "LocalAccountTokenFilterPolicy"]) assert.ok(refused(k, "value", n), n);
    for (const n of ["DisableCAD", "ConsentPromptBehaviorUser", "EnableLUAX", "legalnoticecaption"]) assert.ok(!refused(k, "value", n), n);
    assert.ok(refused(k, "deletekey")); assert.ok(!refused(k + "\\Sub", "value", "EnableLUA"));
    assert.ok(refused(k.replace("SOFTWARE\\", "SOFTWARE\\WOW6432Node\\"), "value", "EnableLUA"));
});

check("write blocklist: Windows Defender (settings, policies and services) and RemoteIQ's own keys (HKLM\\SOFTWARE anywhere, Services\\RemoteIQ*)", () => {
    for (const p of ["HKLM\\SOFTWARE\\Microsoft\\Windows Defender", "HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Exclusions\\Paths", "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection",
        "HKLM\\SOFTWARE\\Microsoft\\Windows Defender Security Center\\x", "HKLM\\SOFTWARE\\Microsoft\\Windows Advanced Threat Protection",
        "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WinDefend", "HKLM\\SYSTEM\\ControlSet001\\Services\\WdFilter\\Parameters", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Sense", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WdBoot",
        "HKLM\\SOFTWARE\\RemoteIQ", "HKLM\\SOFTWARE\\RemoteIQ\\Agent", "HKLM\\SOFTWARE\\WOW6432Node\\RemoteIQ", "HKLM\\SOFTWARE\\Vendor\\RemoteIQ Agent", "HKLM\\SOFTWARE\\remoteiq", "HKLM\\SOFTWARE\\Acme\\Deep\\xRemoteIQx",
        "HKLM\\SYSTEM\\CurrentControlSet\\Services\\RemoteIQAgent", "HKLM\\SYSTEM\\ControlSet002\\Services\\RemoteIQ.Agent\\Parameters", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\remoteiq"]) {
        for (const op of ["value", "createkey", "deletekey"]) assert.ok(refused(p, op), `${p} ${op}`);
    }
    assert.ok(!refused("HKLM\\SOFTWARE\\Microsoft\\Windows DefenderX\\a"));
    assert.ok(!refused("HKLM\\SYSTEM\\CurrentControlSet\\Services\\WinDefendX"));
    assert.ok(!refused("HKLM\\SOFTWARE\\Vendor"));
    assert.ok(!refused("HKU\\S-1-5-21-1\\Software\\RemoteIQ"), "the agent's keys are under HKLM; a user hive's RemoteIQ key is not blocked");
});

check("write blocklist: everything the read blocklist has is refused for writing too (with a reason)", () => {
    for (const p of ["HKLM\\SAM\\SAM", "HKLM\\SECURITY\\Policy", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa", "HKLM\\SYSTEM\\ControlSet001\\Control\\Lsa\\Data",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI\\x", "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI", "HKU\\S-1-5-21-1\\Software\\Microsoft\\Protected Storage System Provider\\a"]) {
        for (const op of ["value", "createkey", "deletekey"]) { const why = refused(p, op); assert.ok(why && /holds/.test(why), `${p} ${op}: ${why}`); }
    }
    for (const b of R.BLOCKED_KEYS) assert.ok(new RegExp(b.pattern, "i"), b.pattern);
});

check("write blocklist: ONE list next to BLOCKED_KEYS; every entry compiles, has a reason, and the scripts get the same list", () => {
    assert.ok(R.WRITE_BLOCKED_KEYS.length >= 13);
    for (const b of R.WRITE_BLOCKED_KEYS) {
        assert.ok(b.why && b.why.length > 20, b.pattern); new RegExp(b.pattern, "i"); if (b.values) new RegExp(b.values, "i");
        assert.ok(!/[.!]$/.test(b.why), "the sentence ends with a full stop added by the message, not the reason");
    }
    for (const kind of Object.keys(R.REGISTRY_WRITE_SCRIPTS)) {
        const text = R.REGISTRY_WRITE_SCRIPTS[kind];
        for (const b of R.WRITE_BLOCKED_KEYS) assert.ok(text.includes(b.pattern.replace(/'/g, "''")), `${kind} has ${b.pattern}`);
        for (const b of R.BLOCKED_KEYS) assert.ok(text.includes(b.pattern.replace(/'/g, "''")), `${kind} has the read blocklist ${b.pattern}`);
        assert.ok(text.includes(R.MASK_NAME_SOURCE), `${kind} has the mask`);
    }
    assert.throws(() => R.assertWritable("HKLM\\SYSTEM\\Setup", "value", "a"), /This change is blocked: /);
    assert.doesNotThrow(() => R.assertWritable("HKLM\\SOFTWARE\\Vendor", "value", "a"));
    try { R.assertWritable("HKLM\\SOFTWARE", "createkey"); assert.fail("no throw"); } catch (e) { assert.equal(e.getStatus(), 403); }
});

check("the secret-name mask: such values are never written or deleted (403, with the reason), nothing else is masked", () => {
    for (const n of ["Password", "DefaultPassword", "apikey", "API_KEY", "ClientSecret", "AccessToken", "Credential", "private key", "PrivateKey", "passwd"]) {
        assert.throws(() => R.assertNameNotMasked(n), (e) => e.getStatus() === 403 && /blocked/.test(e.message) && /password, secret, token/.test(e.message), n);
    }
    for (const n of ["", "Path", "Flags", "Description", "Shell"]) assert.doesNotThrow(() => R.assertNameNotMasked(n), n);
});

check("value names: empty is (Default); up to 16383 characters; no control characters or lone surrogates", () => {
    assert.equal(R.cleanValueName(""), ""); assert.equal(R.cleanValueName(undefined), ""); assert.equal(R.cleanValueName(null), "");
    assert.equal(R.cleanValueName("caf\u00e9 \u4e2d\ud83d\ude00 \"q\" 'a' \\ b"), "caf\u00e9 \u4e2d\ud83d\ude00 \"q\" 'a' \\ b");
    assert.equal(R.cleanValueName("a".repeat(16383)).length, 16383);
    bad(() => R.cleanValueName("a".repeat(16384)), /too long/);
    for (const n of ["a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\ud83d", "\ude00b"]) bad(() => R.cleanValueName(n), /not allowed/);
    bad(() => R.cleanValueName(5), /text/); bad(() => R.cleanValueName(["a"]), /text/);
});

check("types: the six writable types (any case); nothing else", () => {
    for (const t of ["REG_SZ", "REG_EXPAND_SZ", "REG_MULTI_SZ", "REG_DWORD", "REG_QWORD", "REG_BINARY"]) assert.equal(R.cleanWriteType(t.toLowerCase()), t);
    for (const t of ["REG_NONE", "REG_LINK", "REG_UNKNOWN", "", undefined, "REG_SZ; calc", "SZ"]) bad(() => R.cleanWriteType(t), /type must be/);
});

check("text data (REG_SZ, REG_EXPAND_SZ): up to 8192 characters, text only, no NUL, no lone surrogates; unicode, quotes, newlines kept", () => {
    const wild = "caf\u00e9 \u4e2d\ud83d\ude00 \"q\" 'a' \\ back\r\nline2\t$(calc) `n %PATH%";
    for (const t of ["REG_SZ", "REG_EXPAND_SZ"]) {
        assert.equal(R.cleanValueData(t, wild), wild); assert.equal(R.cleanValueData(t, ""), "");
        assert.equal(R.cleanValueData(t, "x".repeat(8192)).length, 8192);
        bad(() => R.cleanValueData(t, "x".repeat(8193)), /too long/);
        bad(() => R.cleanValueData(t, "a\u0000b"), /NUL/); bad(() => R.cleanValueData(t, "a\ud83d"), /cannot be stored/);
        bad(() => R.cleanValueData(t, 5), /text/); bad(() => R.cleanValueData(t, ["a"]), /text/); bad(() => R.cleanValueData(t, null), /text/);
    }
});

check("list data (REG_MULTI_SZ): a list of non-empty text, up to 100 lines, 8192 characters in all", () => {
    assert.deepEqual(R.cleanValueData("REG_MULTI_SZ", []), []);
    assert.deepEqual(R.cleanValueData("REG_MULTI_SZ", ["a", "b c", "caf\u00e9"]), ["a", "b c", "caf\u00e9"]);
    assert.equal(R.cleanValueData("REG_MULTI_SZ", Array.from({ length: 100 }, (_, i) => `l${i}`)).length, 100);
    bad(() => R.cleanValueData("REG_MULTI_SZ", Array.from({ length: 101 }, () => "x")), /100 lines/);
    bad(() => R.cleanValueData("REG_MULTI_SZ", ["a", "", "b"]), /Line 2 is empty/);
    bad(() => R.cleanValueData("REG_MULTI_SZ", ["x".repeat(8192), "y"]), /8192 characters in all/);
    assert.equal(R.cleanValueData("REG_MULTI_SZ", ["x".repeat(8192)])[0].length, 8192);
    bad(() => R.cleanValueData("REG_MULTI_SZ", "a\nb"), /list of lines/); bad(() => R.cleanValueData("REG_MULTI_SZ", [1]), /text/); bad(() => R.cleanValueData("REG_MULTI_SZ", ["a\u0000"]), /NUL/);
});

check("numbers: REG_DWORD 0..4294967295 and REG_QWORD 0..18446744073709551615, decimal or 0x hex, returned as decimal digits", () => {
    assert.equal(R.cleanValueData("REG_DWORD", "0"), "0"); assert.equal(R.cleanValueData("REG_DWORD", 255), "255"); assert.equal(R.cleanValueData("REG_DWORD", " 4294967295 "), "4294967295");
    assert.equal(R.cleanValueData("REG_DWORD", "0xFF"), "255"); assert.equal(R.cleanValueData("REG_DWORD", "0xffffffff"), "4294967295"); assert.equal(R.cleanValueData("REG_DWORD", "007"), "7");
    for (const v of ["4294967296", -1, "-1", "0x100000000", "", "abc", "1e3", "0x", "0xZZ", "1.5", 1.5, "12 34", "+5", "٣", null, undefined, {}, [1], true, 2 ** 53, "99999999999999999999999"]) bad(() => R.cleanValueData("REG_DWORD", v), undefined);
    assert.equal(R.cleanValueData("REG_QWORD", "18446744073709551615"), "18446744073709551615"); assert.equal(R.cleanValueData("REG_QWORD", "0xFFFFFFFFFFFFFFFF"), "18446744073709551615");
    assert.equal(R.cleanValueData("REG_QWORD", "4294967296"), "4294967296"); assert.equal(R.cleanValueData("REG_QWORD", 9007199254740991), "9007199254740991");
    for (const v of ["18446744073709551616", "0x10000000000000000", -5, "9".repeat(21), 2 ** 53]) bad(() => R.cleanValueData("REG_QWORD", v), undefined);
});

check("binary: pairs of hex digits, spaced or compact, strict; up to 4096 bytes; returned lower case with spaces", () => {
    assert.equal(R.cleanValueData("REG_BINARY", ""), ""); assert.equal(R.cleanValueData("REG_BINARY", "   "), "");
    assert.equal(R.cleanValueData("REG_BINARY", "0A 1b FF"), "0a 1b ff"); assert.equal(R.cleanValueData("REG_BINARY", "0A1bFF"), "0a 1b ff"); assert.equal(R.cleanValueData("REG_BINARY", " 00 "), "00");
    assert.equal(R.cleanValueData("REG_BINARY", "ab".repeat(4096)).split(" ").length, 4096);
    bad(() => R.cleanValueData("REG_BINARY", "ab".repeat(4097)), /too long/); bad(() => R.cleanValueData("REG_BINARY", "ab ".repeat(4097).trim()), /too long/);
    for (const v of ["0", "abc", "0a 1", "0a  1b", "0a,1b", "0x0a", "gg", "0a-1b", "0a\n1b", "0a 1b ", "0a1", "zz zz", "12 345", 5, null, ["00"], "0a 1b 2"]) {
        if (v === "0a 1b ") continue; // trailing space is trimmed
        bad(() => R.cleanValueData("REG_BINARY", v), /hex bytes|Binary data/);
    }
});

check("expected old value: whether it existed, its type, optionally size and data (normalised); nothing else", () => {
    assert.equal(R.cleanExpected(undefined), null); assert.equal(R.cleanExpected(null), null);
    assert.deepEqual(R.cleanExpected({ exists: false }), { exists: false });
    assert.deepEqual(R.cleanExpected({ exists: true, type: "reg_sz", data: "a", size: 1 }), { exists: true, type: "REG_SZ", size: 1, data: "a" });
    assert.deepEqual(R.cleanExpected({ exists: true, type: "REG_DWORD", data: "0xFF" }), { exists: true, type: "REG_DWORD", data: "255" });
    assert.deepEqual(R.cleanExpected({ exists: true, type: "REG_BINARY", data: "AB CD" }), { exists: true, type: "REG_BINARY", data: "ab cd" });
    assert.deepEqual(R.cleanExpected({ exists: true, type: "REG_MULTI_SZ", data: ["a"] }), { exists: true, type: "REG_MULTI_SZ", data: ["a"] });
    assert.deepEqual(R.cleanExpected({ exists: true, type: "REG_NONE", size: 3 }), { exists: true, type: "REG_NONE", size: 3 });
    for (const v of ["x", [], 1, {}, { exists: "yes" }, { exists: true }, { exists: true, type: "REG_BOGUS" }, { exists: true, type: "REG_SZ", size: -1 }, { exists: true, type: "REG_SZ", size: 1.5 }, { exists: true, type: "REG_NONE", data: "a" }, { exists: true, type: "REG_DWORD", data: "x" }]) {
        bad(() => R.cleanExpected(v), undefined);
    }
});

check("job environment: every text is prefixed s: so no parser can turn it into a date or number; the arguments are JSON; nothing is put into the script", () => {
    const hostile = "2026-01-01T00:00:00Z \"; Remove-Item C:\\x -Recurse; $(calc) '";
    const d = JSON.parse(R.dataArg("REG_SZ", hostile)); assert.equal(d.v, `s:${hostile}`);
    assert.deepEqual(JSON.parse(R.dataArg("REG_MULTI_SZ", ["a", "2026-01-01"])).v, ["s:a", "s:2026-01-01"]);
    assert.equal(JSON.parse(R.dataArg("REG_DWORD", "5")).v, "s:5");
    assert.equal(R.expectArg(null), ""); assert.deepEqual(JSON.parse(R.expectArg({ exists: false })), { exists: false });
    assert.deepEqual(JSON.parse(R.expectArg({ exists: true, type: "REG_SZ", size: 3, data: "abc" })), { exists: true, type: "REG_SZ", size: 3, hasData: true, v: "s:abc" });
    assert.deepEqual(JSON.parse(R.expectArg({ exists: true, type: "REG_SZ", size: 9000 })), { exists: true, type: "REG_SZ", size: 9000, hasData: false });
    const big = JSON.parse(R.dataArg("REG_SZ", "\"\\".repeat(4096))); assert.equal(big.v.length, 8194);
    assert.ok(R.dataArg("REG_SZ", "\"\\".repeat(4096)).length < 32767 && R.dataArg("REG_BINARY", "ab ".repeat(4095) + "ab").length < 32767, "fits an environment variable");
    assert.ok(R.dataArg("REG_MULTI_SZ", Array.from({ length: 100 }, () => "\"".repeat(81))).length < 32767);
    assert.deepEqual(JSON.parse(R.valuesArg([{ name: "n", type: "REG_SZ", data: "x" }, { name: "", type: "REG_MULTI_SZ", data: ["a"] }])), { items: [{ n: "s:n", t: "REG_SZ", v: "s:x" }, { n: "s:", t: "REG_MULTI_SZ", v: ["s:a"] }] });
    assert.deepEqual(R.splitKeyPath("HKLM\\SOFTWARE\\a\\b"), { parent: "HKLM\\SOFTWARE\\a", leaf: "b" }); assert.equal(R.hiveOf("HKU\\S-1"), "HKU"); assert.equal(R.hiveOf("HKLM\\x"), "HKLM");
});

check("the write scripts: fixed text, no typed text, no WMI, no recursive delete, no evaluation of text, one key and one value per run", () => {
    for (const [kind, text] of Object.entries(R.REGISTRY_WRITE_SCRIPTS)) {
        assert.ok(!/DeleteSubKeyTree|Remove-Item|Remove-ItemProperty|Get-CimInstance|Get-WmiObject|Win32_|Invoke-Expression|\biex\b|Invoke-Command|Start-Process|Add-Type|reg\.exe|\breg\s+(delete|add|import)/i.test(text), `${kind} has a forbidden command`);
        assert.ok(/^[\x00-\x7f]*$/.test(text), `${kind} is ASCII only (no BOM trouble)`);
        assert.ok(text.includes("$env:RIQ_REG_PATH"), kind);
        assert.ok(text.length < 30000, kind);
    }
    assert.ok(R.REGISTRY_WRITE_SCRIPTS.deleteKey.includes("DeleteSubKey($sp.leaf, $true)"), "delete key uses the non-recursive call that fails on sub keys");
    assert.ok(R.REGISTRY_WRITE_SCRIPTS.deleteKey.includes("SubKeyCount"), "and checks the sub keys itself first");
    assert.ok(R.REGISTRY_WRITE_SCRIPTS.set.includes("Test-Expect") && R.REGISTRY_WRITE_SCRIPTS.deleteValue.includes("Test-Expect"), "optimistic concurrency");
    assert.ok(R.REGISTRY_WRITE_SCRIPTS.set.includes("Read-Full") && R.REGISTRY_WRITE_SCRIPTS.set.includes("old = $old; new = $new"), "reads old first and new back");
});

check("reading a script's answer: done / refused, the mask applied again, unknown shapes are errors", () => {
    const done = R.parseRegistryWrite({ ok: true, status: "done", old: { exists: true, name: "Flags", type: "REG_DWORD", size: 4, d: "5" }, new: { exists: true, name: "Flags", type: "REG_DWORD", size: 4, d: "6" } });
    assert.equal(done.status, "done"); assert.deepEqual(done.old, { exists: true, type: "REG_DWORD", size: 4, data: "5" }); assert.deepEqual(done.new.data, "6");
    const none = R.parseRegistryWrite({ ok: true, status: "done", old: { exists: false }, new: { exists: true, name: "N", type: "REG_SZ", size: 1, d: "x" } });
    assert.deepEqual(none.old, { exists: false });
    const sec = R.parseRegistryWrite({ ok: true, status: "done", old: { exists: true, name: "MyPassword", type: "REG_SZ", size: 6, d: "hunter" }, new: { exists: true, name: "MyPassword", type: "REG_SZ", size: 6, d: "hunter" } });
    assert.equal(sec.old.data, null); assert.equal(sec.old.masked, true); assert.ok(!JSON.stringify(sec).includes("hunter"));
    const ref = R.parseRegistryWrite({ ok: true, status: "refused", reason: "changed", message: "The value was changed.", old: { exists: true, name: "A", type: "REG_SZ", size: 1, d: "z" } });
    assert.equal(ref.status, "refused"); assert.equal(ref.reason, "changed"); assert.equal(ref.old.data, "z");
    const key = R.parseRegistryWrite({ ok: true, status: "done", values: [{ exists: true, name: "A", type: "REG_SZ", size: 1, d: "z" }, { exists: true, name: "ApiKey", type: "REG_SZ", size: 3, d: "abc" }] });
    assert.deepEqual(key.values.map((v) => [v.name, v.data, !!v.masked]), [["A", "z", false], ["ApiKey", null, true]]);
    assert.equal(R.parseRegistryWrite({ ok: true, status: "done", valueCount: 3 }).valueCount, 3);
    bad(() => R.parseRegistryWrite({ ok: true }), /could not be understood/); bad(() => R.parseRegistryWrite(null), /could not be understood/);
    const m = R.parseRegistryWrite({ ok: true, status: "done", old: { exists: true, name: "M", type: "REG_MULTI_SZ", size: 3, d: ["a", "bc"] }, new: { exists: true, name: "M", type: "REG_BINARY", size: 2, d: "AB CD zz" } });
    assert.deepEqual(m.old.data, ["a", "bc"]); assert.equal(m.new.data, "ab cd ");
});

check("recorded data is shown as the reader shows it: numbers with hex, text as is, hidden when the name looks like a secret", () => {
    assert.deepEqual(R.recordedForDisplay("Flags", { exists: true, type: "REG_DWORD", size: 4, data: "255" }), { exists: true, type: "REG_DWORD", size: 4, data: 255, hex: "0x000000FF" });
    const q = R.recordedForDisplay("Big", { exists: true, type: "REG_QWORD", size: 8, data: "18446744073709551615" });
    assert.equal(q.data, "18446744073709551615"); assert.equal(q.hex, "0xFFFFFFFFFFFFFFFF");
    assert.equal(R.recordedForDisplay("N", { exists: true, type: "REG_SZ", size: 2, data: "hi" }).data, "hi");
    const s = R.recordedForDisplay("Password", { exists: true, type: "REG_SZ", size: 2, data: "hi" }); assert.equal(s.data, null); assert.equal(s.masked, true);
    assert.deepEqual(R.recordedForDisplay("X", { exists: false }), { exists: false }); assert.equal(R.recordedForDisplay("X", null), null);
});

check("rate limit: 10 changes a minute per device, 30 per person, a sliding window, one audit row per burst", () => {
    let now = 1_000_000;
    const l = L.RegistryWriteLimiter.custom(() => now);
    for (let i = 0; i < 10; i++) assert.equal(l.check("u1", "d1").ok, true, `change ${i + 1}`);
    const over = l.check("u1", "d1"); assert.equal(over.ok, false); assert.equal(over.scope, "device"); assert.equal(over.first, true); assert.ok(over.retryAfterSec >= 1 && over.retryAfterSec <= 60);
    assert.equal(l.check("u1", "d1").first, false, "the burst is reported once");
    assert.equal(l.check("u1", "d2").ok, true, "another device is not limited (refused attempts count nothing)");
    assert.equal(l.check("u2", "d1").ok, false, "the device limit is for everyone");
    now += 30_000; assert.equal(l.check("u1", "d1").ok, false, "still inside the window");
    now += 30_001; assert.equal(l.check("u1", "d1").ok, true, "the window slides: the first ten are older than a minute");
    // per person: 30
    const u = L.RegistryWriteLimiter.custom(() => now);
    for (let i = 0; i < 30; i++) assert.equal(u.check("busy", `dev${i}`).ok, true);
    const v = u.check("busy", "dev99"); assert.equal(v.ok, false); assert.equal(v.scope, "user");
    assert.equal(u.check("other", "dev1").ok, true, "another person is not limited");
    assert.throws(() => u.take("busy", "dev100"), (e) => e.getStatus() === 429 && /30 registry changes/.test(e.getResponse().message) && /Wait \d+ second/.test(e.getResponse().message));
    let calls = 0;
    const d = L.RegistryWriteLimiter.custom(() => now, 100, 2);
    d.take("x", "dd"); d.take("x", "dd");
    for (let i = 0; i < 3; i++) { try { d.take("x", "dd", () => calls++); } catch (e) { assert.equal(e.getStatus(), 429); assert.match(e.getResponse().message, /2 registry changes were made on this device/); } }
    assert.equal(calls, 1);
    assert.equal(L.WRITES_PER_USER_PER_MINUTE, 30); assert.equal(L.WRITES_PER_DEVICE_PER_MINUTE, 10);
    const w = new L.SlidingWindow(1, 1000, () => now); w.add("k"); assert.ok(w.wait("k") >= 1); now += 1001; assert.equal(w.wait("k"), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
