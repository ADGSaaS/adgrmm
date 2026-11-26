// Security basics, stage 1, with no database and no device: the parser and validator of what a device prints (realistic and hostile
// text), the Security Center productState decoding, the Windows support table, every baseline rule (pass, fail, unknown, not applicable),
// the score and grade maths including the caps for critical failures, and the readable summaries. Run after a build:
//   node test/security-units.cjs
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "security");
const S = require(path.join(dist, "security.scripts.js"));
const B = require(path.join(dist, "security.baseline.js"));
const H = require(path.join(dist, "security.highlights.js"));
const { healthy, unknown, text, iso } = require("./security-fixtures.cjs");

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const throws = (fn, re) => { try { fn(); } catch (e) { return re.test(String(e.message)); } return false; };

const scan = (over) => S.parseSecurityScan(text(healthy(over)), "");
const NOW = new Date("2026-11-16T12:00:00Z");
const rule = (id, over, now = NOW) => {
    const ev = B.evaluateScan(scan(over), now);
    const r = ev.rules.find((x) => x.id === id);
    assert.ok(r, `rule ${id} exists`);
    return r;
};
const result = (id, over) => rule(id, over).result;

/* ------------------------------ the parser ------------------------------ */
console.log("parser");
check("a healthy PC's output is accepted, every probe ok", () => {
    const s = scan();
    assert.equal(s.v, 1);
    for (const name of S.PROBE_NAMES) assert.equal(s.probes[name].status, "ok", name);
    assert.equal(s.probes.defender.signatureVersion, "1.463.324.0");
    assert.deepEqual(s.probes.bitlocker.volumes[0].protectors, ["TPM", "RecoveryPassword"]);
});
check("there are 17 probes and the script prints each one", () => {
    assert.equal(S.PROBE_NAMES.length, 17);
    for (const n of S.PROBE_NAMES) assert.ok(S.SECURITY_SCAN_SCRIPT.includes(`Probe '${n}'`), n);
});
check("a probe the device marked unknown keeps its reason, and the other probes are untouched", () => {
    const s = scan({ tpm: unknown("The TPM can only be read with administrator rights."), bitlocker: unknown("Access denied") });
    assert.equal(s.probes.tpm.status, "unknown");
    assert.equal(s.probes.tpm.reason, "The TPM can only be read with administrator rights.");
    assert.equal(s.probes.defender.status, "ok");
});
check("a probe that is missing becomes unknown", () => {
    const o = healthy(); delete o.probes.rdp;
    const s = S.parseSecurityScan(text(o), "");
    assert.equal(s.probes.rdp.status, "unknown");
    assert.match(s.probes.rdp.reason, /did not report/);
});
check("unknown fields are dropped at every level", () => {
    const o = healthy();
    o.extra = "x"; o.probes.os.secret = "hunter2"; o.probes.defender.exclusions = ["C:\\"]; o.probes.bitlocker.volumes[0].recoveryPassword = "111111-222222"; o.probes.bogus = { status: "ok" };
    const s = S.parseSecurityScan(text(o), "");
    const j = JSON.stringify(s);
    assert.ok(!j.includes("hunter2") && !j.includes("exclusions") && !j.includes("111111") && !j.includes("bogus") && !j.includes("extra"));
});
check("key material can never be stored: only the known protector TYPES survive", () => {
    const o = healthy();
    o.probes.bitlocker.volumes[0].protectors = ["TPM", "RecoveryPassword", "123456-234567-345678-456789-567890-678901-789012-890123", "{A1B2C3D4-0000-0000-0000-000000000000}", "Password: abc", 42, null, { id: "x" }];
    const s = S.parseSecurityScan(text(o), "");
    assert.deepEqual(s.probes.bitlocker.volumes[0].protectors, ["TPM", "RecoveryPassword"]);
});
check("wrong types make that probe unknown, not the whole scan", () => {
    const o = healthy();
    o.probes.defender.antivirusEnabled = "yes"; o.probes.uac.enabled = 1; o.probes.os.build = "26200"; o.probes.accounts.adminCount = -3;
    const s = S.parseSecurityScan(text(o), "");
    for (const n of ["defender", "uac", "os", "accounts"]) { assert.equal(s.probes[n].status, "unknown", n); assert.match(s.probes[n].reason, /unexpected answer/); }
    assert.equal(s.probes.firewall.status, "ok");
});
check("sizes are bounded: threat names, admin names, volumes, products, users", () => {
    const o = healthy();
    o.probes.defender.threats = Array.from({ length: 100 }, (_, i) => "Trojan:Win32/" + "x".repeat(400) + i);
    o.probes.accounts.adminNames = Array.from({ length: 100 }, (_, i) => "D\\" + "u".repeat(300) + i);
    o.probes.bitlocker.volumes = Array.from({ length: 50 }, (_, i) => ({ drive: String.fromCharCode(67 + (i % 20)) + ":", protection: "on", protectors: [] }));
    o.probes.securityCenter.products = Array.from({ length: 80 }, (_, i) => ({ name: "AV" + i, state: 266240 }));
    o.probes.screenLock.users = Array.from({ length: 80 }, () => ({ secure: true, timeoutSecs: 300 }));
    const s = S.parseSecurityScan(text(o), "");
    assert.equal(s.probes.defender.threats.length, 10);
    assert.ok(s.probes.defender.threats.every((t) => t.length <= 100));
    assert.equal(s.probes.accounts.adminNames.length, 20);
    assert.ok(s.probes.accounts.adminNames.every((t) => t.length <= 80));
    assert.equal(s.probes.bitlocker.volumes.length, 8);
    assert.equal(s.probes.securityCenter.products.length, 10);
    assert.equal(s.probes.screenLock.users.length, 10);
});
check("control characters are stripped and text is trimmed", () => {
    const o = healthy();
    o.probes.defender.threats = ["Bad\u0000Thing\n\u001b[31m red"];
    o.probes.autoLogon = { status: "ok", ms: 1, enabled: true, user: "  \tann\r\n" };
    const s = S.parseSecurityScan(text(o), "");
    assert.ok(!/[\u0000-\u001f]/.test(s.probes.defender.threats[0]));
    assert.equal(s.probes.autoLogon.user, "ann");
});
check("a __proto__ or constructor key cannot pollute or replace a probe", () => {
    const raw = '{"ok":true,"v":1,"ms":5,"probes":{"__proto__":{"status":"ok","polluted":true},"constructor":{"status":"ok"},"os":{"status":"ok","build":26200,"productName":"Windows 11 Pro"}}}';
    const s = S.parseSecurityScan(raw, "");
    assert.equal({}.polluted, undefined);
    assert.equal(s.probes.os.status, "ok");
    assert.equal(s.probes.defender.status, "unknown");
    assert.deepEqual(Object.keys(s.probes).sort(), [...S.PROBE_NAMES].sort());
});
check("dates must be strict UTC timestamps in a sane range; days are never negative", () => {
    const o = healthy();
    o.probes.defender.signatureUpdated = "yesterday"; o.probes.defender.quickScanAt = "1601-01-01T00:00:00Z"; o.probes.defender.signatureAgeDays = -1; o.probes.defender.fullScanAgeDays = 1e12;
    const d = S.parseSecurityScan(text(o), "").probes.defender;
    assert.equal(d.signatureUpdated, null); assert.equal(d.quickScanAt, null); assert.equal(d.signatureAgeDays, 0); assert.equal(d.fullScanAgeDays, null);
});
check("the build number must be a number, and the BitLocker drive a drive letter", () => {
    const o = healthy();
    o.probes.bitlocker.volumes = [{ drive: "C:\\Windows", protection: "on", protectors: [] }, { drive: "D:", protection: "maybe", protectors: [], method: "ROT13", state: "Weird", percent: 900 }];
    o.probes.bitlocker.systemDrive = "../etc";
    const b = S.parseSecurityScan(text(o), "").probes.bitlocker;
    assert.equal(b.volumes.length, 1);
    assert.equal(b.volumes[0].protection, "unknown"); assert.equal(b.volumes[0].method, null); assert.equal(b.volumes[0].state, null); assert.equal(b.volumes[0].percent, null);
    assert.equal(b.systemDrive, "");
});
check("bad JSON, empty output, a failed script and a huge output are refused with a plain reason", () => {
    assert.ok(throws(() => S.parseSecurityScan("{not json", ""), /could not be read/));
    assert.ok(throws(() => S.parseSecurityScan("", "boom"), /boom/));
    assert.ok(throws(() => S.parseSecurityScan(JSON.stringify({ ok: false, error: "Access is denied" }), ""), /Access is denied/));
    assert.ok(throws(() => S.parseSecurityScan("x".repeat(250_000), ""), /larger than expected/));
    assert.ok(throws(() => S.parseSecurityScan("[1,2,3]", ""), /not a security scan/));
    assert.ok(throws(() => S.parseSecurityScan('{"ok":true,"probes":[1]}', ""), /not a security scan/));
    assert.ok(throws(() => S.parseSecurityScan('{"ok":true}', ""), /not a security scan/));
});
check("an empty probes object gives sixteen unknown probes and an empty score", () => {
    const s = S.parseSecurityScan('{"ok":true,"v":1,"ms":1,"probes":{}}', "");
    assert.ok(S.PROBE_NAMES.every((n) => s.probes[n].status === "unknown"));
    const ev = B.evaluateScan(s, NOW);
    assert.equal(ev.score, null); assert.equal(ev.grade, null);
    assert.equal(ev.counts.pass + ev.counts.fail, 0);
});
check("the Defender action answers are parsed strictly", () => {
    assert.deepEqual(S.parseDefenderScan('{"ok":true,"action":"scan","scanType":"QuickScan","started":true}', ""), { scanType: "QuickScan", started: true });
    assert.ok(throws(() => S.parseDefenderScan('{"ok":true,"scanType":"Evil","started":true}', ""), /did not say/));
    assert.ok(throws(() => S.parseDefenderScan('{"ok":true,"scanType":"FullScan","started":false}', ""), /did not say/));
    assert.ok(throws(() => S.parseDefenderScan('{"ok":false,"error":"Microsoft Defender is not running on this device, so it cannot scan."}', ""), /not running/));
    const u = S.parseDefenderUpdate(JSON.stringify({ ok: true, before: "1.1.1.0", after: "1.1.2.0", updatedAt: "2026-11-16T10:00:00Z" }), "");
    assert.equal(u.changed, true); assert.equal(u.after, "1.1.2.0");
    assert.equal(S.parseDefenderUpdate(JSON.stringify({ ok: true, before: "1.1.1.0", after: "1.1.1.0", updatedAt: "nope" }), "").changed, false);
});

/* ------------------------------ the scripts ------------------------------ */
console.log("scripts");
check("every script is ASCII, has no backtick or ${ (it lives in a template string), and ends in one JSON write", () => {
    for (const [n, t] of Object.entries({ scan: S.SECURITY_SCAN_SCRIPT, update: S.DEFENDER_SCRIPTS.update, defScan: S.DEFENDER_SCRIPTS.scan })) {
        assert.ok(/^[\x00-\x7f]*$/.test(t), `${n} ascii`);
        assert.ok(!t.includes("`") && !t.includes("${"), `${n} no backtick`);
        assert.ok(t.includes("Out-Adg"), n);
    }
});
check("nothing secret is ever asked for: no key id, recovery password, key, DefaultPassword, hash, manage-bde, Get-BitLockerVolume", () => {
    const t = S.SECURITY_SCAN_SCRIPT;
    const code = t.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.ok(!/GetKeyProtectorNumericalPassword|GetKeyProtectorExternalKey|NumericalPassword|RecoveryPasswordValue|ExternalKey'?\)? *\{/.test(code) || !/Invoke-CimMethod[^\n]*Numerical/.test(code));
    assert.ok(!/Numerical/.test(code), "no Numerical* method");
    assert.ok(!/'DefaultPassword'/.test(code), "DefaultPassword not read");
    assert.ok(!/Get-BitLockerVolume|manage-bde|Get-LocalUser|PasswordHash|\bsam\b/i.test(code));
    // the only BitLocker methods used read the state, the method and the TYPE of each protector
    const methods = [...code.matchAll(/-MethodName (\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual([...new Set(methods)], ["GetConversionStatus", "GetEncryptionMethod", "GetKeyProtectorType", "GetKeyProtectors"]);
    // the key protector ids are used to ask for the type and are never copied into the answer
    assert.ok(!/\$row\.\w+ *= *.*\$id\b/.test(code));
});
check("every WMI/CIM query names its properties (a query for all of them once took 90 seconds)", () => {
    for (const m of S.SECURITY_SCAN_SCRIPT.matchAll(/Get-CimInstance[^\n]*/g)) assert.ok(/-Property /.test(m[0]), m[0]);
    assert.ok(!/Get-WmiObject|gwmi|Win32_Product|Get-HotFix|Get-WindowsOptionalFeature|Win32_QuickFixEngineering/i.test(S.SECURITY_SCAN_SCRIPT));
});
check("the scripts contain nothing a person types and nothing that turns protection off", () => {
    const all = S.SECURITY_SCAN_SCRIPT + S.DEFENDER_SCRIPTS.update + S.DEFENDER_SCRIPTS.scan;
    assert.ok(!/Set-MpPreference|Add-MpPreference|Remove-MpPreference|Disable-|DisableRealtimeMonitoring|-ExclusionPath|-ExclusionExtension|-ExclusionProcess|Remove-MpThreat|Set-NetFirewall|netsh/i.test(all));
    // Exclusions are only READ (the property of Get-MpPreference), never added, changed or removed.
    assert.ok(/Get-MpPreference/.test(S.SECURITY_SCAN_SCRIPT) && !/(Set|Add|Remove)-MpPreference/i.test(S.SECURITY_SCAN_SCRIPT));
    assert.ok(/\$env:ADG_SCAN_TYPE/.test(S.DEFENDER_SCRIPTS.scan));
    assert.ok(!/\$env:ADG_SCAN_TYPE[^\n]*Command/.test(S.DEFENDER_SCRIPTS.scan.replace(/\$type = \$env:ADG_SCAN_TYPE/, "")));
});

/* ------------------------------ Security Center ------------------------------ */
console.log("Security Center productState");
const D = S.decodeProductState;
check("known values decode: Defender on 397568 (0x061000), on and old 397584, off 393216, third party on 266240, out of date 266256", () => {
    assert.deepEqual(D(397568), { state: "on", upToDate: true });
    assert.deepEqual(D(397584), { state: "on", upToDate: false });
    assert.deepEqual(D(393216), { state: "off", upToDate: true });
    assert.deepEqual(D(266240), { state: "on", upToDate: true });
    assert.deepEqual(D(266256), { state: "on", upToDate: false });
    assert.deepEqual(D(262144), { state: "off", upToDate: true });
    assert.deepEqual(D(0x062000), { state: "snoozed", upToDate: true });
    assert.deepEqual(D(0x063000), { state: "expired", upToDate: true });
});
check("junk decodes to unknown", () => {
    for (const v of [-1, 1.5, NaN, "266240", null, undefined, 0x1000000, {}, [], Infinity]) assert.deepEqual(D(v), { state: "unknown", upToDate: null }, String(v));
    assert.deepEqual(D(0x064000), { state: "unknown", upToDate: true });
});
check("Defender is recognised by name in either spelling", () => {
    assert.ok(S.isDefenderName("Windows Defender") && S.isDefenderName("Microsoft Defender Antivirus") && S.isDefenderName("  windows defender  "));
    assert.ok(!S.isDefenderName("Sophos Intercept X") && !S.isDefenderName("Defender Pro 2000"));
});

/* ------------------------------ Windows support ------------------------------ */
console.log("Windows support table");
const sup = (build, edition = "Professional", type = "Client", name = "Windows 10 Pro", now = NOW) => S.osSupport({ build, editionId: edition, installationType: type, productName: name }, now);
check("Windows 10 22H2 ended on 2025-10-14", () => {
    const s = sup(19045);
    assert.equal(s.status, "ended"); assert.equal(s.endsOn, "2025-10-14"); assert.equal(s.name, "Windows 10 22H2");
    assert.equal(sup(19045, "Professional", "Client", "Windows 10 Pro", new Date("2025-10-14T12:00:00Z")).status, "ending", "on the last day it is still supported");
    assert.equal(sup(19045, "Professional", "Client", "Windows 10 Pro", new Date("2025-10-15T00:30:00Z")).status, "ended");
});
check("Windows 11 builds: 21H2, 22H2, 23H2, 24H2 and 25H2, Home or Pro against Enterprise", () => {
    assert.deepEqual([sup(22000).status, sup(22000).endsOn], ["ended", "2023-10-10"]);
    assert.equal(sup(22000, "Enterprise").endsOn, "2024-10-08");
    assert.equal(sup(22621).endsOn, "2024-10-08"); assert.equal(sup(22621, "Education").endsOn, "2025-10-14");
    assert.equal(sup(22631).endsOn, "2025-11-11"); assert.equal(sup(22631, "Enterprise").endsOn, "2026-11-10");
    assert.equal(sup(22631, "Enterprise", "Client", "Windows 11 Enterprise", new Date("2026-11-01T00:00:00Z")).status, "ending");
    assert.equal(sup(26100).endsOn, "2026-10-13"); assert.equal(sup(26100).status, "ended");
    assert.equal(sup(26100, "Enterprise").endsOn, "2027-10-12"); assert.equal(sup(26100, "Enterprise").status, "supported");
    const s = sup(26200); assert.deepEqual([s.status, s.endsOn, s.name], ["supported", "2027-10-12", "Windows 11 25H2"]);
});
check("LTSC editions use their own date, and servers their own table", () => {
    assert.equal(sup(17763, "EnterpriseS").endsOn, "2029-01-09"); assert.equal(sup(17763, "EnterpriseS").status, "supported");
    assert.equal(sup(17763, "Professional").status, "ended");
    assert.equal(sup(19044, "EnterpriseS").endsOn, "2027-01-12"); assert.equal(sup(19044, "IoTEnterpriseS").endsOn, "2027-01-12");
    const srv = sup(20348, "ServerStandard", "Server", "Windows Server 2022 Standard");
    assert.deepEqual([srv.status, srv.endsOn, srv.name], ["supported", "2031-10-14", "Windows Server 2022"]);
    assert.equal(sup(14393, "ServerStandard", "Server", "Windows Server 2016 Standard").endsOn, "2027-01-12");
    assert.equal(sup(26100, "ServerStandard", "Server", "Windows Server 2025 Standard").endsOn, "2034-11-14");
    assert.equal(sup(9600, "ServerStandard", "Server", "Windows Server 2012 R2").status, "ended");
});
check("a build that is not in the table is unknown, never guessed", () => {
    for (const b of [12345, 99999, 1, 22500]) { const s = sup(b); assert.equal(s.status, "unknown"); assert.equal(s.endsOn, null); assert.equal(s.daysLeft, null); }
    assert.equal(sup(20348).status, "unknown", "20348 is a server build, not a client one");
});
check("tables are sorted data: unique builds, valid dates, enterprise never earlier than the standard date", () => {
    for (const t of [S.CLIENT_SUPPORT, S.SERVER_SUPPORT]) {
        assert.equal(new Set(t.map((r) => r.build)).size, t.length);
        for (const r of t) { for (const d of [r.ends, r.endsEnterprise, r.ltsc].filter(Boolean)) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)), `${r.name} ${d}`); if (r.endsEnterprise) assert.ok(r.endsEnterprise >= r.ends, r.name); }
    }
});

/* ------------------------------ the rules ------------------------------ */
console.log("rules");
check("av.exclusions: no exclusions and narrow ones pass, broad ones fail and are named", () => {
    assert.equal(result("av.exclusions", { defenderExclusions: { status: "ok", ms: 5, paths: 0, extensions: 0, processes: 0, broad: [] } }), "pass");
    assert.match(rule("av.exclusions", { defenderExclusions: { status: "ok", ms: 5, paths: 0, extensions: 0, processes: 0, broad: [] } }).detail, /no exclusions/);
    assert.match(rule("av.exclusions").detail, /2 exclusions, none of them broad/);
    const r = rule("av.exclusions", { defenderExclusions: { status: "ok", ms: 5, paths: 3, extensions: 1, processes: 1, broad: ["a whole drive", "program or script files (.exe)", "a script or system program (powershell.exe)"] } });
    assert.equal(r.result, "fail");
    assert.match(r.detail, /a whole drive, program or script files \(\.exe\), a script or system program \(powershell\.exe\)/);
    assert.match(r.detail, /5 exclusions in all/);
    assert.equal(B.RULE_BY_ID.get("av.exclusions").severity, "medium");
});
check("av.exclusions: another antivirus in charge means it does not apply; unreadable and old scans are unknown, not failures", () => {
    const other = { defender: { status: "ok", ms: 1, serviceState: "Running", antivirusEnabled: false, realTimeProtection: false, tamperProtected: false, runningMode: "Passive", productVersion: "1", signatureVersion: "1", signatureUpdated: null, signatureAgeDays: null, quickScanAt: null, quickScanAgeDays: null, fullScanAt: null, fullScanAgeDays: null, threatCount: 0, threats: [] }, securityCenter: { status: "ok", ms: 1, products: [{ name: "Contoso AV", state: 397568 }] }, defenderExclusions: { status: "ok", ms: 5, paths: 1, extensions: 0, processes: 0, broad: ["a whole drive"] } };
    assert.equal(result("av.exclusions", other), "not_applicable");
    assert.equal(result("av.exclusions", { defenderExclusions: unknown("The exclusions can only be read with administrator rights.") }), "unknown");
    const old = scan(); delete old.probes.defenderExclusions;
    assert.equal(B.evaluateScan(old, NOW).rules.find((x) => x.id === "av.exclusions").result, "unknown");
});
check("the parser keeps only the known kinds of broad exclusion, never a path", () => {
    const s = scan({ defenderExclusions: { status: "ok", ms: 5, paths: 2, extensions: 0, processes: 0, broad: ["a whole drive", "C:\\Users\\ann\\secret-project", "program or script files (.exe)", "<b>x</b>", "a script or system program (evil.exe; rm)"] } });
    assert.deepEqual(s.probes.defenderExclusions.broad, ["a whole drive", "program or script files (.exe)"]);
    const bad = scan({ defenderExclusions: { status: "ok", ms: 5, paths: "many", extensions: 0, processes: 0, broad: [] } });
    assert.equal(bad.probes.defenderExclusions.status, "unknown");
    assert.ok(S.SECURITY_SCAN_SCRIPT.includes("Probe 'defenderExclusions'"));
});
check("the baseline has 28 rules with unique ids, weights, severities, texts and a way to evaluate", () => {
    assert.equal(B.RULES.length, 28);
    assert.equal(new Set(B.RULES.map((r) => r.id)).size, 28);
    for (const r of B.RULES) {
        assert.ok(["critical", "high", "medium", "low"].includes(r.severity), r.id);
        assert.ok(Number.isInteger(r.weight) && r.weight >= 1 && r.weight <= 10, r.id);
        assert.ok(r.title.length > 5 && r.checks.length > 20 && r.why.length > 30 && r.fix.length > 20, r.id);
        assert.ok(r.uses.length >= 1, r.id);
    }
    assert.deepEqual(B.RULES.filter((r) => r.severity === "critical").map((r) => r.id).sort(), ["av.present", "av.realtime", "av.threats", "fw.some"]);
});
check("a healthy PC passes everything that applies: score 100, grade A, nothing capped", () => {
    const ev = B.evaluateScan(scan(), NOW);
    assert.equal(ev.counts.fail, 0, JSON.stringify(ev.rules.filter((r) => r.result === "fail")));
    assert.equal(ev.counts.unknown, 0);
    assert.equal(ev.score, 100); assert.equal(ev.grade, "A"); assert.equal(ev.capped, false);
});
// antivirus
check("av.present: Defender on passes; nothing on fails; another AV on passes; passive Defender passes; both probes unknown is unknown", () => {
    assert.equal(result("av.present"), "pass");
    assert.equal(result("av.present", { defender: { ...healthy().probes.defender, antivirusEnabled: false } }), "fail");
    const other = { status: "ok", ms: 1, products: [{ name: "Windows Defender", state: 393216 }, { name: "Sophos Intercept X", state: 266240 }] };
    const dOff = { ...healthy().probes.defender, antivirusEnabled: false, runningMode: "Passive Mode", realTimeProtection: false };
    assert.equal(result("av.present", { defender: dOff, securityCenter: other }), "pass");
    assert.match(rule("av.present", { defender: dOff, securityCenter: other }).detail, /Sophos/);
    assert.equal(result("av.present", { defender: dOff, securityCenter: { status: "ok", ms: 1, products: [{ name: "Windows Defender", state: 393216 }] } }), "pass", "passive and nothing else registered: another product is in charge");
    assert.equal(result("av.present", { defender: { ...dOff, runningMode: "Normal" }, securityCenter: { status: "ok", ms: 1, products: [{ name: "Sophos", state: 262144 }] } }), "fail", "the registered product is off");
    assert.equal(result("av.present", { defender: unknown(), securityCenter: unknown() }), "unknown");
    assert.equal(result("av.present", { defender: unknown("no cmdlet"), securityCenter: { status: "ok", ms: 1, products: [] } }), "fail");
});
check("av.realtime: Defender real-time off fails; a third-party AV on means it passes", () => {
    const d = healthy().probes.defender;
    assert.equal(result("av.realtime", { defender: { ...d, realTimeProtection: false } }), "fail");
    const sophos = { status: "ok", ms: 1, products: [{ name: "Sophos", state: 266240 }] };
    assert.equal(result("av.realtime", { defender: { ...d, antivirusEnabled: false, runningMode: "Passive Mode", realTimeProtection: false }, securityCenter: sophos }), "pass");
    assert.equal(result("av.realtime", { defender: { ...d, antivirusEnabled: false, runningMode: "Passive Mode" } }), "not_applicable");
    assert.equal(result("av.realtime", { defender: unknown(), securityCenter: unknown() }), "unknown");
    assert.equal(result("av.realtime", { defender: { ...d, antivirusEnabled: false, realTimeProtection: false } }), "fail");
});
check("av.signatures: 3 days passes, 4 fails; a third-party AV uses its own up-to-date flag; no age is unknown", () => {
    const d = healthy().probes.defender;
    assert.equal(result("av.signatures", { defender: { ...d, signatureAgeDays: 3 } }), "pass");
    assert.equal(result("av.signatures", { defender: { ...d, signatureAgeDays: 4 } }), "fail");
    assert.equal(result("av.signatures", { defender: { ...d, signatureAgeDays: null } }), "unknown");
    const passive = { ...d, antivirusEnabled: false, runningMode: "Passive Mode" };
    assert.equal(result("av.signatures", { defender: passive, securityCenter: { status: "ok", ms: 1, products: [{ name: "Sophos", state: 266256 }] } }), "fail");
    assert.equal(result("av.signatures", { defender: passive, securityCenter: { status: "ok", ms: 1, products: [{ name: "Sophos", state: 266240 }] } }), "pass");
    assert.equal(result("av.signatures", { defender: { ...d, antivirusEnabled: false }, securityCenter: { status: "ok", ms: 1, products: [] } }), "not_applicable");
    assert.equal(result("av.signatures", { defender: unknown(), securityCenter: unknown() }), "unknown");
});
check("av.threats: any active threat fails (with names), none passes, unreadable list is unknown", () => {
    const d = healthy().probes.defender;
    const r = rule("av.threats", { defender: { ...d, threatCount: 11, threats: ["HackTool:Win32/Crack", "Trojan:Win32/Vigorf.A"] } });
    assert.equal(r.result, "fail"); assert.match(r.detail, /11 active threats: HackTool:Win32\/Crack/);
    assert.equal(result("av.threats"), "pass");
    assert.equal(result("av.threats", { defender: { ...d, threatsUnknown: true } }), "unknown");
    assert.equal(result("av.threats", { defender: unknown() }), "unknown");
});
check("av.tamper and av.scan apply only when Defender is in charge", () => {
    const d = healthy().probes.defender;
    assert.equal(result("av.tamper", { defender: { ...d, tamperProtected: false } }), "fail");
    assert.equal(result("av.tamper", { defender: { ...d, antivirusEnabled: false, runningMode: "Passive Mode" } }), "not_applicable");
    assert.equal(result("av.tamper", { defender: unknown(), securityCenter: unknown() }), "unknown");
    assert.equal(result("av.scan", { defender: { ...d, quickScanAgeDays: 14, fullScanAgeDays: 40 } }), "pass");
    assert.equal(result("av.scan", { defender: { ...d, quickScanAgeDays: 15, fullScanAgeDays: 40 } }), "fail");
    assert.equal(result("av.scan", { defender: { ...d, quickScanAgeDays: null, fullScanAgeDays: 2 } }), "pass");
    assert.equal(result("av.scan", { defender: { ...d, quickScanAgeDays: null, fullScanAgeDays: null } }), "fail");
    assert.equal(result("av.scan", { defender: { ...d, antivirusEnabled: false, runningMode: "Passive Mode" } }), "not_applicable");
});
// firewall
check("fw.some / fw.all: all off is critical, one off is high, unread profiles are ignored, unreadable probe is unknown", () => {
    const f = (o) => ({ status: "ok", ms: 1, domain: true, private: true, public: true, serviceState: "Running", ...o });
    assert.deepEqual([result("fw.some", { firewall: f({}) }), result("fw.all", { firewall: f({}) })], ["pass", "pass"]);
    assert.deepEqual([result("fw.some", { firewall: f({ public: false }) }), result("fw.all", { firewall: f({ public: false }) })], ["pass", "fail"]);
    assert.match(rule("fw.all", { firewall: f({ public: false, domain: false }) }).detail, /Domain, Public/);
    assert.deepEqual([result("fw.some", { firewall: f({ domain: false, private: false, public: false }) }), result("fw.all", { firewall: f({ domain: false, private: false, public: false }) })], ["fail", "fail"]);
    assert.deepEqual([result("fw.some", { firewall: f({ domain: null, private: false, public: null }) }), result("fw.all", { firewall: f({ domain: null, private: true, public: null }) })], ["fail", "pass"]);
    assert.deepEqual([result("fw.some", { firewall: unknown() }), result("fw.all", { firewall: unknown() })], ["unknown", "unknown"]);
});
// uac
check("uac.on and uac.prompt", () => {
    const u = (o) => ({ status: "ok", ms: 1, enabled: true, adminPrompt: 5, secureDesktop: true, ...o });
    assert.equal(result("uac.on", { uac: u({ enabled: false }) }), "fail");
    assert.equal(result("uac.on", { uac: unknown() }), "unknown");
    assert.equal(result("uac.prompt", { uac: u({ adminPrompt: 0 }) }), "fail");
    assert.equal(result("uac.prompt", { uac: u({ adminPrompt: 2 }) }), "pass");
    assert.equal(result("uac.prompt", { uac: u({ adminPrompt: null }) }), "unknown");
    assert.equal(result("uac.prompt", { uac: u({ enabled: false, adminPrompt: 0 }) }), "not_applicable");
});
// bitlocker
check("bl.system / bl.data / bl.recovery", () => {
    const b = (vols, o = {}) => ({ status: "ok", ms: 1, detail: true, systemDrive: "C:", volumes: vols, note: null, ...o });
    const v = (drive, protection, protectors = ["TPM", "RecoveryPassword"], o = {}) => ({ drive, protection, percent: protection === "on" ? 100 : null, method: "XtsAes128", state: null, protectors, ...o });
    assert.equal(result("bl.system", { bitlocker: b([v("C:", "off")]) }), "fail");
    assert.equal(result("bl.system", { bitlocker: b([v("C:", "on")]) }), "pass");
    assert.equal(result("bl.system", { bitlocker: b([v("C:", "unknown")]) }), "unknown");
    assert.equal(result("bl.system", { bitlocker: b([v("D:", "on")]) }), "unknown", "the system drive was not reported");
    assert.equal(result("bl.system", { bitlocker: b([]) }), "unknown");
    assert.equal(result("bl.system", { bitlocker: unknown() }), "unknown");
    assert.match(rule("bl.system", { bitlocker: b([v("C:", "on", [], { state: "Encrypting", percent: 40 })]) }).detail, /still encrypting: 40%/);
    assert.equal(result("bl.data", { bitlocker: b([v("C:", "on")]) }), "not_applicable");
    assert.equal(result("bl.data", { bitlocker: b([v("C:", "on"), v("D:", "off")]) }), "fail");
    assert.equal(result("bl.data", { bitlocker: b([v("C:", "on"), v("D:", "on"), v("E:", "on")]) }), "pass");
    assert.equal(result("bl.data", { bitlocker: b([v("C:", "on"), v("D:", "unknown")]) }), "unknown");
    assert.equal(result("bl.recovery", { bitlocker: b([v("C:", "on", ["TPM"])]) }), "fail");
    assert.equal(result("bl.recovery", { bitlocker: b([v("C:", "on")]) }), "pass");
    assert.equal(result("bl.recovery", { bitlocker: b([v("C:", "off", [])]) }), "not_applicable");
    assert.equal(result("bl.recovery", { bitlocker: b([v("C:", "on", [])], { detail: false, note: "Detail not readable: Access denied" }) }), "unknown");
});
check("secure boot, TPM", () => {
    assert.equal(result("boot.secure", { secureBoot: { status: "ok", ms: 1, supported: true, enabled: false } }), "fail");
    assert.equal(result("boot.secure", { secureBoot: { status: "ok", ms: 1, supported: false, enabled: false } }), "not_applicable");
    assert.equal(result("boot.secure", { secureBoot: unknown() }), "unknown");
    const t = (o) => ({ status: "ok", ms: 1, present: true, ready: true, enabled: true, activated: true, ...o });
    assert.equal(result("tpm.ready", { tpm: t({}) }), "pass");
    assert.equal(result("tpm.ready", { tpm: t({ ready: false }) }), "fail");
    assert.equal(result("tpm.ready", { tpm: t({ present: false, ready: false }) }), "fail");
    assert.equal(result("tpm.ready", { tpm: unknown("administrator rights") }), "unknown");
});
check("accounts: automatic sign-in, built-in Administrator, Guest, administrator count", () => {
    assert.equal(result("logon.auto", { autoLogon: { status: "ok", ms: 1, enabled: true, user: "kiosk" } }), "fail");
    assert.match(rule("logon.auto", { autoLogon: { status: "ok", ms: 1, enabled: true, user: "kiosk" } }).detail, /kiosk/);
    assert.equal(result("logon.auto", { autoLogon: unknown() }), "unknown");
    const a = (o) => ({ ...healthy().probes.accounts, ...o });
    assert.equal(result("admin.builtin", { accounts: a({ builtinAdminEnabled: true }) }), "fail");
    assert.equal(result("admin.builtin", { accounts: a({ builtinAdminEnabled: null }) }), "unknown");
    assert.equal(result("guest.off", { accounts: a({ guestEnabled: true }) }), "fail");
    assert.equal(result("guest.off", { accounts: a({ guestEnabled: null }) }), "unknown");
    assert.equal(result("guest.off", { accounts: unknown() }), "unknown");
    // a disabled built-in Administrator in the group does not count
    assert.equal(result("admin.count", { accounts: a({ adminCount: 4, adminNames: ["PC\\Administrator", "PC\\a", "PC\\b", "PC\\c"] }) }), "pass");
    assert.equal(result("admin.count", { accounts: a({ adminCount: 4, builtinAdminEnabled: true, adminNames: ["PC\\Administrator", "PC\\a", "PC\\b", "PC\\c"] }) }), "fail");
    assert.equal(result("admin.count", { accounts: a({ adminCount: 9, adminNames: ["PC\\x"] }) }), "fail");
});
check("smb1, rdp", () => {
    assert.equal(result("smb1.off", { smb1: { status: "ok", ms: 1, enabled: true, source: "registry" } }), "fail");
    assert.equal(result("smb1.off", { smb1: unknown("access denied") }), "unknown");
    const r = (o) => ({ status: "ok", ms: 1, enabled: true, nlaRequired: true, ...o });
    assert.equal(result("rdp.nla", { rdp: r({ enabled: false, nlaRequired: false }) }), "pass");
    assert.equal(result("rdp.nla", { rdp: r({}) }), "pass");
    assert.equal(result("rdp.nla", { rdp: r({ nlaRequired: false }) }), "fail");
    assert.equal(result("rdp.nla", { rdp: r({ nlaRequired: null }) }), "unknown");
    assert.equal(result("rdp.nla", { rdp: unknown() }), "unknown");
});
check("screen lock: policy or password-protected screen saver within 15 minutes", () => {
    const l = (o) => ({ status: "ok", ms: 1, inactivityTimeoutSecs: null, users: [], ...o });
    assert.equal(result("lock.screen", { screenLock: l({ inactivityTimeoutSecs: 900 }) }), "pass");
    assert.equal(result("lock.screen", { screenLock: l({ inactivityTimeoutSecs: 901 }) }), "fail");
    assert.equal(result("lock.screen", { screenLock: l({}) }), "unknown");
    assert.equal(result("lock.screen", { screenLock: l({ users: [{ secure: true, timeoutSecs: 600 }] }) }), "pass");
    assert.equal(result("lock.screen", { screenLock: l({ users: [{ secure: true, timeoutSecs: 600 }, { secure: false, timeoutSecs: 600 }] }) }), "fail");
    assert.equal(result("lock.screen", { screenLock: l({ users: [{ secure: true, timeoutSecs: 1800 }] }) }), "fail");
    assert.equal(result("lock.screen", { screenLock: l({ users: [{ secure: true, timeoutSecs: null }] }) }), "fail");
    assert.equal(result("lock.screen", { screenLock: l({ inactivityTimeoutSecs: 0, users: [{ secure: true, timeoutSecs: 300 }] }) }), "pass", "0 means not set");
    assert.equal(result("lock.screen", { screenLock: unknown() }), "unknown");
});
check("password and lockout policy", () => {
    const p = (o) => ({ status: "ok", ms: 1, minLength: 12, maxAgeDays: 90, historyCount: 5, lockoutThreshold: 5, lockoutMinutes: 15, ...o });
    assert.equal(result("pw.length", { passwordPolicy: p({ minLength: 8 }) }), "pass");
    assert.equal(result("pw.length", { passwordPolicy: p({ minLength: 7 }) }), "fail");
    assert.equal(result("pw.length", { passwordPolicy: p({ minLength: 0 }) }), "fail");
    assert.equal(result("pw.length", { passwordPolicy: p({ minLength: null }) }), "unknown");
    assert.equal(result("pw.lockout", { passwordPolicy: p({ lockoutThreshold: 10 }) }), "pass");
    assert.equal(result("pw.lockout", { passwordPolicy: p({ lockoutThreshold: 11 }) }), "fail");
    assert.equal(result("pw.lockout", { passwordPolicy: p({ lockoutThreshold: 0 }) }), "fail");
    assert.equal(result("pw.lockout", { passwordPolicy: p({ lockoutThreshold: null }) }), "fail", "Never is a word, which the script leaves empty");
    assert.equal(result("pw.lockout", { passwordPolicy: unknown() }), "unknown");
});
check("os.supported, restart and updates", () => {
    const o = (build, ed = "Professional") => ({ status: "ok", ms: 1, productName: "Windows 11 Pro", displayVersion: "x", build, ubr: 1, editionId: ed, installationType: "Client" });
    assert.equal(result("os.supported", { os: o(19045) }), "fail");
    assert.equal(result("os.supported", { os: o(26200) }), "pass");
    assert.equal(result("os.supported", { os: o(55555) }), "unknown");
    assert.equal(result("os.supported", { os: unknown() }), "unknown");
    assert.match(rule("os.supported", { os: o(26100, "Enterprise") }, new Date("2027-08-01T00:00:00Z")).detail, /support ends on 2027-10-12 \(in 72 days\)/);
    assert.equal(result("reboot.pending", { reboot: { status: "ok", ms: 1, pending: true, servicing: true, windowsUpdate: false, fileRename: false } }), "fail");
    assert.equal(result("reboot.pending", { reboot: { status: "ok", ms: 1, pending: false, servicing: false, windowsUpdate: false, fileRename: true } }), "pass", "a pending file rename alone is noise");
    assert.equal(result("updates.recent", { lastUpdate: { status: "ok", ms: 1, at: iso(60), ageDays: 60 } }), "pass");
    assert.equal(result("updates.recent", { lastUpdate: { status: "ok", ms: 1, at: iso(61), ageDays: 61 } }), "fail");
    assert.equal(result("updates.recent", { lastUpdate: { status: "ok", ms: 1, at: null, ageDays: null } }), "unknown");
    assert.equal(result("updates.recent", { lastUpdate: unknown("no history") }), "unknown");
});
check("an unreadable probe gives the device's own reason in the rule's detail", () => {
    const r = rule("tpm.ready", { tpm: unknown("The TPM can only be read with administrator rights.") });
    assert.equal(r.result, "unknown"); assert.match(r.detail, /administrator rights/);
});
check("a rule that throws is reported as unknown and does not lose the others", () => {
    const s = scan();
    s.probes.accounts.adminNames = null; // not something the parser can produce, but a rule must not be able to break the scan
    s.probes.screenLock.users = null;
    const ev = B.evaluateScan(s, NOW);
    assert.equal(ev.rules.length, 28);
    assert.ok(ev.rules.every((r) => ["pass", "fail", "unknown", "not_applicable"].includes(r.result)));
});

/* ------------------------------ scoring ------------------------------ */
console.log("scoring and grades");
const out = (map) => Object.entries(map).map(([id, result]) => ({ id, result, detail: "" }));
const W = (id) => B.RULE_BY_ID.get(id).weight;
check("score is the weighted pass share of pass + fail, rounded", () => {
    const all = Object.fromEntries(B.RULES.map((r) => [r.id, "pass"]));
    all["uac.on"] = "fail"; // high, weight 6
    const total = B.RULES.reduce((s, r) => s + r.weight, 0);
    const r = B.scoreOutcomes(out(all));
    assert.equal(r.uncappedScore, Math.round(((total - W("uac.on")) / total) * 100));
    assert.equal(r.score, r.uncappedScore);
    assert.equal(r.grade, B.gradeFor(r.score));
    assert.deepEqual(r.failedIds, ["uac.on"]); assert.equal(r.failedBySeverity.high, 1);
});
check("unknown counts as neither pass nor fail, not applicable is left out", () => {
    const base = { "uac.on": "pass", "smb1.off": "fail" };
    const a = B.scoreOutcomes(out(base));
    const b = B.scoreOutcomes(out({ ...base, "tpm.ready": "unknown", "av.scan": "not_applicable", "guest.off": "unknown" }));
    assert.equal(a.score, b.score);
    assert.equal(a.score, Math.round((W("uac.on") / (W("uac.on") + W("smb1.off"))) * 100));
    assert.equal(b.counts.unknown, 2); assert.equal(b.counts.notApplicable, 1); assert.deepEqual(b.unknownIds.sort(), ["guest.off", "tpm.ready"]);
});
check("no rule that passed or failed means no score and no grade", () => {
    const r = B.scoreOutcomes(out({ "uac.on": "unknown", "av.scan": "not_applicable" }));
    assert.equal(r.score, null); assert.equal(r.grade, null); assert.equal(r.capped, false);
    assert.equal(B.scoreOutcomes([]).score, null);
});
check("grade thresholds: 90 A, 80 B, 70 C, 60 D, below F", () => {
    const g = B.gradeFor;
    assert.deepEqual([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(g), ["A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]);
});
check("one failed critical rule caps the score at 69 and the grade at D, even when everything else passes", () => {
    const all = Object.fromEntries(B.RULES.map((r) => [r.id, "pass"]));
    all["av.present"] = "fail";
    const r = B.scoreOutcomes(out(all));
    assert.ok(r.uncappedScore > 80, `uncapped ${r.uncappedScore}`);
    assert.equal(r.score, 69); assert.equal(r.grade, "D"); assert.equal(r.capped, true); assert.match(r.capReason, /no better than D|cannot be better than D/);
});
check("two failed critical rules cap at 59 and grade F", () => {
    const all = Object.fromEntries(B.RULES.map((r) => [r.id, "pass"]));
    all["av.present"] = "fail"; all["fw.some"] = "fail";
    const r = B.scoreOutcomes(out(all));
    assert.equal(r.score, 59); assert.equal(r.grade, "F"); assert.equal(r.capped, true); assert.match(r.capReason, /2 critical/);
    all["av.threats"] = "fail"; all["av.realtime"] = "fail";
    assert.equal(B.scoreOutcomes(out(all)).grade, "F");
});
check("a cap never raises a low score, and is not reported as a cap when the score was already lower", () => {
    const all = Object.fromEntries(B.RULES.map((r) => [r.id, "fail"]));
    const r = B.scoreOutcomes(out(all));
    assert.equal(r.score, 0); assert.equal(r.grade, "F"); assert.equal(r.capped, false); assert.equal(r.capReason, null);
    const mid = Object.fromEntries(B.RULES.map((r, i) => [r.id, i % 2 ? "pass" : "fail"]));
    mid["av.present"] = "fail";
    const m = B.scoreOutcomes(out(mid));
    assert.ok(m.score <= 69);
});
check("high failures reduce the score but do not cap the grade by themselves", () => {
    const all = Object.fromEntries(B.RULES.map((r) => [r.id, "pass"]));
    for (const id of ["fw.all", "uac.on"]) all[id] = "fail";
    const r = B.scoreOutcomes(out(all));
    assert.equal(r.capped, false); assert.ok(r.grade === "A" || r.grade === "B", r.grade);
});
check("a critical rule that is unknown does not cap", () => {
    const all = Object.fromEntries(B.RULES.map((r) => [r.id, "pass"]));
    all["av.present"] = "unknown";
    const r = B.scoreOutcomes(out(all));
    assert.equal(r.capped, false); assert.equal(r.score, 100); assert.equal(r.counts.unknown, 1);
});
check("a PC with no antivirus gets D at best even though the rest is healthy (end to end)", () => {
    const d = healthy().probes.defender;
    const ev = B.evaluateScan(scan({ defender: { ...d, antivirusEnabled: false, realTimeProtection: false }, securityCenter: { status: "ok", ms: 1, products: [{ name: "Windows Defender", state: 393216 }] } }), NOW);
    assert.equal(ev.rules.find((r) => r.id === "av.present").result, "fail");
    assert.ok(ev.score <= 59, `two critical failures (no antivirus, no real-time): ${ev.score}`);
    assert.equal(ev.grade, "F");
});
check("firewall off everywhere, and active threats, each cap the grade", () => {
    const f = { status: "ok", ms: 1, domain: false, private: false, public: false, serviceState: "Running" };
    const e1 = B.evaluateScan(scan({ firewall: f }), NOW);
    assert.equal(e1.failedBySeverity.critical, 1); assert.equal(e1.grade, "D"); assert.equal(e1.score, 69);
    const d = healthy().probes.defender;
    const e2 = B.evaluateScan(scan({ defender: { ...d, threatCount: 2, threats: ["A", "B"] } }), NOW);
    assert.equal(e2.grade, "D");
    const e3 = B.evaluateScan(scan({ defender: { ...d, threatCount: 2, threats: ["A"] }, firewall: f }), NOW);
    assert.equal(e3.grade, "F");
});
check("the real PC of the developer (non-elevated read) scores something sensible and lists what could not be read", () => {
    const o = healthy({ tpm: unknown("The TPM can only be read with administrator rights."), lastUpdate: unknown("No installed Windows update"), bitlocker: { status: "ok", ms: 5000, detail: false, systemDrive: "C:", note: "Detail not readable: Access denied", volumes: [{ drive: "C:", protection: "off", percent: null, method: null, state: null, protectors: [] }, { drive: "D:", protection: "off", percent: null, method: null, state: null, protectors: [] }] } });
    const ev = B.evaluateScan(S.parseSecurityScan(text(o), ""), NOW);
    assert.ok(ev.counts.unknown >= 2);
    assert.equal(ev.rules.find((r) => r.id === "bl.system").result, "fail");
    assert.equal(ev.rules.find((r) => r.id === "bl.recovery").result, "not_applicable");
});

/* ------------------------------ summaries ------------------------------ */
console.log("summaries");
check("Defender, BitLocker and firewall labels", () => {
    assert.deepEqual(H.defenderLabel(scan().probes), { text: "Defender on, definitions 1 day ago", tone: "good" });
    const d = healthy().probes.defender;
    assert.equal(H.defenderLabel(scan({ defender: { ...d, signatureAgeDays: 9 } }).probes).tone, "warn");
    assert.equal(H.defenderLabel(scan({ defender: { ...d, threatCount: 3 } }).probes).text, "Defender: 3 active threats");
    assert.equal(H.defenderLabel(scan({ defender: { ...d, realTimeProtection: false } }).probes).tone, "bad");
    assert.equal(H.defenderLabel(scan({ defender: { ...d, antivirusEnabled: false, runningMode: "Passive Mode" }, securityCenter: { status: "ok", ms: 1, products: [{ name: "Sophos Intercept X", state: 266240 }] } }).probes).text, "Sophos Intercept X");
    assert.equal(H.defenderLabel(scan({ defender: unknown(), securityCenter: unknown() }).probes).tone, "unknown");
    assert.equal(H.bitlockerLabel(scan().probes).text, "On");
    assert.equal(H.bitlockerLabel(scan({ bitlocker: unknown() }).probes).tone, "unknown");
    const bl = (vols) => ({ status: "ok", ms: 1, detail: true, systemDrive: "C:", note: null, volumes: vols });
    const v = (drive, protection) => ({ drive, protection, percent: null, method: null, state: null, protectors: [] });
    assert.equal(H.bitlockerLabel(scan({ bitlocker: bl([v("C:", "off"), v("D:", "on")]) }).probes).tone, "bad");
    assert.equal(H.bitlockerLabel(scan({ bitlocker: bl([v("C:", "on"), v("D:", "off")]) }).probes).text, "1 of 2 drives on");
    const f = (o) => ({ status: "ok", ms: 1, domain: true, private: true, public: true, serviceState: "x", ...o });
    assert.equal(H.firewallLabel(scan({ firewall: f({ public: false }) }).probes).text, "Off for Public");
    assert.equal(H.firewallLabel(scan({ firewall: f({ domain: false, private: false, public: false }) }).probes).text, "Off");
});
check("highlights carry no raw secret-like field and list the unreadable probes", () => {
    const h = H.highlights(scan({ tpm: unknown("admin only") }).probes, NOW);
    assert.deepEqual(h.unreadable, [{ probe: "tpm", reason: "admin only" }]);
    assert.equal(h.os.support.status, "supported");
    const j = JSON.stringify(h);
    assert.ok(!/password|secret|recoveryKey|keyId/i.test(j.replace(/RecoveryPassword/g, "")));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
