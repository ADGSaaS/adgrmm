#!/usr/bin/env node
// Device-secrets vault, pure tests (no database, no server): vault crypto (round trip, tamper, wrong AAD, wrong key), the strict parsers
// with hostile output, the password generator (run for real in PowerShell: charset, length, classes, uniqueness, no modulo bias),
// the scripts (every one is parsed with the PowerShell parser; lapsRotate is run ONLY with RIQ_DRY_RUN=1, which changes nothing; the
// BitLocker script is never run here, it needs SYSTEM), the limiter and the password / reason checks.
//
//   npx tsc -p tsconfig.json   (in backend/)    then    node test/vault-units.cjs
"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_ENCRYPTION_KEY = "unit-test-data-key";
const dist = path.join(__dirname, "..", process.env.DIST || "dist");
const box = require(path.join(dist, "common/secret-box"));
const C = require(path.join(dist, "vault/vault.crypto"));
const P = require(path.join(dist, "vault/vault.parsers"));
const S = require(path.join(dist, "vault/vault.scripts"));
const L = require(path.join(dist, "vault/vault.limiter"));
const V = require(path.join(dist, "vault/vault.service"));
const J = require(path.join(dist, "jobs/secret-jobs"));

let passed = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok    ${name}`); } catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); }
}
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof P.VaultParseError && e.code === code, `expected ${code}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-vault-"));
const PS = process.env.POWERSHELL || "powershell.exe";
function ps(file, env = {}, timeout = 120000) {
    const t0 = Date.now();
    const r = spawnSync(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { env: { ...process.env, ...env }, encoding: "utf8", timeout });
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", ms: Date.now() - t0 };
}
const writePs = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text, "utf8"); return f; };

const DEV = "11111111-2222-4333-8444-555555555555";
const B1 = { deviceId: DEV, kind: "bitlocker_recovery", ref: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };

async function main() {
    console.log("vault crypto");
    await test("round trip; the stored text is versioned, carries a key id and holds no plaintext", () => {
        const s = C.sealSecret("123456-234567-345678-456789-567890-678901-789012-890123", B1);
        assert.match(s.ciphertext, /^v1:[0-9a-f]{8}:[A-Za-z0-9+/]+={0,2}$/);
        assert.equal(s.keyVersion, 1); assert.equal(s.keyId, C.vaultKeyId());
        assert.ok(!s.ciphertext.includes("123456"));
        assert.equal(C.openSecret(s.ciphertext, B1), "123456-234567-345678-456789-567890-678901-789012-890123");
        assert.notEqual(C.sealSecret("x", B1).ciphertext, C.sealSecret("x", B1).ciphertext, "a fresh nonce every time");
    });
    await test("the vault key is not the key of other stored secrets", () => {
        const sealedElsewhere = box.encryptSecret("same plaintext");
        assert.ok(sealedElsewhere.startsWith("enc:v1:"));
        assert.throws(() => C.openSecret(sealedElsewhere, B1), (e) => e.code === "bad_format");
    });
    await test("tamper detection: flipping any byte of the ciphertext, tag or nonce fails to open", () => {
        const s = C.sealSecret("secret-value-1", B1).ciphertext;
        const [, id, b64] = s.split(":");
        const raw = Buffer.from(b64, "base64");
        for (const i of [0, 5, 12, 20, raw.length - 1]) {
            const t = Buffer.from(raw); t[i] ^= 1;
            assert.throws(() => C.openSecret(`v1:${id}:${t.toString("base64")}`, B1), (e) => e.code === "tampered", `byte ${i}`);
        }
        assert.throws(() => C.openSecret(`v1:${id}:${raw.subarray(0, 20).toString("base64")}`, B1), (e) => e.code === "bad_format");
    });
    await test("wrong associated data: another device, another kind, another ref all fail", () => {
        const s = C.sealSecret("secret-value-2", B1).ciphertext;
        for (const bad of [{ ...B1, deviceId: "99999999-2222-4333-8444-555555555555" }, { ...B1, kind: "local_admin" }, { ...B1, ref: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef" }]) {
            assert.throws(() => C.openSecret(s, bad), (e) => e.code === "tampered");
        }
        assert.equal(C.openSecret(s, { ...B1, deviceId: DEV.toUpperCase() }), "secret-value-2", "the device id is bound case-insensitively");
    });
    await test("wrong key: a different DATA_ENCRYPTION_KEY says wrong_key, and the original key opens it again", () => {
        const s = C.sealSecret("secret-value-3", B1).ciphertext;
        process.env.DATA_ENCRYPTION_KEY = "another-key"; box.resetSecretBoxForTests();
        assert.throws(() => C.openSecret(s, B1), (e) => e.code === "wrong_key");
        process.env.DATA_ENCRYPTION_KEY = "unit-test-data-key"; box.resetSecretBoxForTests();
        assert.equal(C.openSecret(s, B1), "secret-value-3");
    });
    await test("garbage is bad_format, never a crash with content in the message", () => {
        for (const g of ["", null, undefined, "enc:v1:abc", "v1:zz:abc", "v1:00000000:", "plain password"]) assert.throws(() => C.openSecret(g, B1), (e) => e instanceof C.VaultCryptoError && !/password/.test(e.message));
    });

    console.log("BitLocker parser (strict)");
    const GOOD = "123456-234567-345678-456789-567890-678901-789012-890123";
    const key = (o = {}) => ({ mount: "C:", protectorId: "{0A1B2C3D-0000-4000-8000-ABCDEFABCDEF}", recoveryPassword: GOOD, ...o });
    await test("a good answer: mount upper-cased, protector id lower case without braces, several volumes", () => {
        const keys = P.parseBitlockerKeys(JSON.stringify({ ok: true, keys: [key({ mount: "c:" }), key({ mount: "D:", protectorId: "1b2c3d4e-0000-4000-8000-abcdefabcdef" })] }));
        assert.deepEqual(keys.map((k) => [k.mount, k.protectorId]), [["C:", "0a1b2c3d-0000-4000-8000-abcdefabcdef"], ["D:", "1b2c3d4e-0000-4000-8000-abcdefabcdef"]]);
        assert.equal(P.parseBitlockerKeys(JSON.stringify({ ok: true, keys: [] })).length, 0, "a device with no keys is a successful empty read");
    });
    await test("hostile and garbage output is refused with a fixed code", () => {
        throwsCode(() => P.parseBitlockerKeys(""), "empty");
        throwsCode(() => P.parseBitlockerKeys("   \n"), "empty");
        throwsCode(() => P.parseBitlockerKeys("Recovery password: " + GOOD), "not_json");
        throwsCode(() => P.parseBitlockerKeys("[1,2]"), "bad_shape");
        throwsCode(() => P.parseBitlockerKeys('{"ok":true}'), "bad_shape");
        throwsCode(() => P.parseBitlockerKeys(JSON.stringify({ ok: true, keys: "x" })), "bad_shape");
        throwsCode(() => P.parseBitlockerKeys(JSON.stringify({ ok: true, keys: Array.from({ length: 65 }, (_, i) => key({ protectorId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })) })), "bad_shape");
        throwsCode(() => P.parseBitlockerKeys("x".repeat(200000)), "bad_shape");
        for (const bad of [
            key({ recoveryPassword: "12345-234567-345678-456789-567890-678901-789012-890123" }),
            key({ recoveryPassword: GOOD + "-111111" }),
            key({ recoveryPassword: GOOD.replace(/-/g, "") }),
            key({ recoveryPassword: GOOD.replace("1", "a") }),
            key({ recoveryPassword: GOOD + "\n" }),
            key({ recoveryPassword: ` ${GOOD}` }),
            key({ recoveryPassword: 123456 }),
            key({ protectorId: "not-a-guid" }), key({ protectorId: "{0A1B2C3D-0000-4000-8000-ABCDEFABCDE}" }), key({ protectorId: "{0A1B2C3D-0000-4000-8000-ABCDEFABCDEG}" }),
            key({ protectorId: "0a1b2c3d-0000-4000-8000-abcdefabcdef'; DROP" }), key({ protectorId: null }),
            key({ mount: "C:\\" }), key({ mount: "CC:" }), key({ mount: "1:" }), key({ mount: "" }), key({ mount: "\\\\?\\Volume{x}" }),
            null, "text", 5,
        ]) throwsCode(() => P.parseBitlockerKeys(JSON.stringify({ ok: true, keys: [bad] })), "bad_key");
        throwsCode(() => P.parseBitlockerKeys(JSON.stringify({ ok: true, keys: [key(), key({ mount: "D:" })] })), "bad_key");
    });
    await test("one bad entry rejects the whole answer (nothing is partly stored)", () => {
        throwsCode(() => P.parseBitlockerKeys(JSON.stringify({ ok: true, keys: [key(), key({ protectorId: "1b2c3d4e-0000-4000-8000-abcdefabcdef", recoveryPassword: "nope" })] })), "bad_key");
    });
    await test("a device error keeps only a whitelisted reason code, never the device's text", () => {
        try { P.parseBitlockerKeys(JSON.stringify({ ok: false, reason: "access_denied", error: GOOD })); assert.fail("no throw"); } catch (e) { assert.equal(e.code, "device_error"); assert.equal(e.reason, "access_denied"); assert.ok(!e.message.includes("123456")); }
        try { P.parseBitlockerKeys(JSON.stringify({ ok: false, reason: `evil ${GOOD}` })); } catch (e) { assert.equal(e.reason, "other"); assert.ok(!e.message.includes("123456")); }
    });

    console.log("LAPS result parser and password check");
    const PW = "Ab3!Ab3!Ab3!Ab3!Ab3!";
    const lr = (o = {}) => JSON.stringify({ ok: true, account: "riq-admin", created: false, verified: true, password: PW, ...o });
    const exp = { account: "riq-admin", length: 20 };
    await test("a good answer; verified false is kept as such", () => {
        assert.deepEqual(P.parseLapsResult(lr(), exp), { account: "riq-admin", created: false, verified: true, password: PW });
        assert.equal(P.parseLapsResult(lr({ verified: false, created: true }), exp).verified, false);
    });
    await test("refused: a dry run, another account, another length, characters outside the alphabet, a missing class, wrong types", () => {
        throwsCode(() => P.parseLapsResult(lr({ dryRun: true }), exp), "dry_run");
        throwsCode(() => P.parseLapsResult(lr({ account: "Administrator" }), exp), "mismatch");
        throwsCode(() => P.parseLapsResult(lr(), { account: "riq-admin", length: 21 }), "bad_password");
        for (const pw of ["Ab3!Ab3!Ab3!Ab3!Ab3 ", "Ab3!Ab3!Ab3!Ab3!Ab3\"", "Ab3!Ab3!Ab3!Ab3!Ab3\\", "Il3!Il3!Il3!Il3!Il3!", "Ob3!Ob3!Ob3!Ob3!Ob3!", "abcdefghijkmnpqrstuv", "ABCDEFGHJKLMNPQRSTUV", "23456789234567892345", "!#%&*+=?@^_!#%&*+=?@^", "Abcdefghijkmnpqrs23!".replace("!", "$"), 12345678901234567890, null]) throwsCode(() => P.parseLapsResult(lr({ password: pw }), exp), "bad_password");
        throwsCode(() => P.parseLapsResult(lr({ created: "yes" }), exp), "bad_shape");
        throwsCode(() => P.parseLapsResult(lr({ verified: 1 }), exp), "bad_shape");
        throwsCode(() => P.parseLapsResult("Password: " + PW, exp), "not_json");
        throwsCode(() => P.parseLapsResult("", exp), "empty");
    });
    await test("device errors carry only a whitelisted reason and never the text; every reason has a user-readable sentence", () => {
        try { P.parseLapsResult(JSON.stringify({ ok: false, reason: "set_failed", hr: "80070005", password: PW }), exp); } catch (e) { assert.equal(e.reason, "set_failed"); assert.ok(!e.message.includes(PW)); }
        try { P.parseLapsResult(JSON.stringify({ ok: false, reason: PW }), exp); } catch (e) { assert.equal(e.reason, "other"); }
        for (const r of ["set_failed", "create_failed", "group_failed", "domain_controller", "reserved_account", "access_denied", "no_bitlocker"]) assert.ok(P.DEVICE_REASONS[r].length > 20);
    });
    await test("isValidLapsPassword bounds: 14 to 64 only", () => {
        for (const n of [13, 65, 0]) assert.equal(P.isValidLapsPassword("Ab3!".repeat(20).slice(0, n), n), false);
        for (const n of [14, 15, 64]) assert.equal(P.isValidLapsPassword(("Ab3!" + "k".repeat(70)).slice(0, n), n), true);
    });

    console.log("reason, limiter, retention texts");
    await test("cleanReason: 5 to 300 characters trimmed, no control characters", () => {
        assert.equal(V.cleanReason("  ticket 4411, lost key  "), "ticket 4411, lost key");
        assert.equal(V.cleanReason("12345"), "12345");
        assert.equal(V.cleanReason("a".repeat(300)).length, 300);
        for (const bad of [undefined, null, 5, "", "abcd", "    abcd   ", "a".repeat(301), "line1\nline2", "tab\there", "nul\u0000x...", "bell\u0007xx", "del\u007fxxxx", "sep\u2028xxxx"]) assert.throws(() => V.cleanReason(bad), (e) => e.getStatus?.() === 400, JSON.stringify(bad));
    });
    await test("limiter: the 11th reveal in a minute is refused, refused attempts count too, and the window slides", () => {
        let now = 1_000_000;
        const l = L.VaultLimiters.custom(() => now);
        for (let i = 0; i < 10; i++) l.reveal.take("u1", `d${i}`);
        let err; try { l.reveal.take("u1", "dx"); } catch (e) { err = e; }
        assert.equal(err.getStatus(), 429); assert.equal(err.getResponse().code, "rate_limited"); assert.ok(err.getResponse().retryAfterSec >= 1);
        now += 59_000;
        for (let i = 0; i < 12; i++) assert.throws(() => l.reveal.take("u1", "dy" + i), (e) => e.getStatus() === 429, "still blocked, and each refused attempt counts too");
        now += 2_000; assert.throws(() => l.reveal.take("u1", "dz"), (e) => e.getStatus() === 429, "the first burst has expired but the refused attempts keep it blocked");
        now += 61_000; l.reveal.take("u1", "da"); // a quiet minute clears it
        l.reveal.take("u2", "d-other"); // another person is not affected
    });
    await test("limiter: 30 per device per hour, per device only", () => {
        let now = 5_000_000;
        const l = L.VaultLimiters.custom(() => now);
        for (let i = 0; i < 30; i++) { l.reveal.take(`user${i % 9}-${Math.floor(i / 9)}`, "dev1"); now += 1000; }
        assert.throws(() => l.reveal.take("fresh", "dev1"), (e) => e.getStatus() === 429 && /device/.test(e.getResponse().message));
        l.reveal.take("fresh2", "dev2");
        now += 3_700_000; l.reveal.take("fresh3", "dev1");
    });
    await test("only the newest of several unconfirmed/previous states warns correctly", () => {
        assert.match(V.lapsWarning("unconfirmed", "local_admin", true), /7 days/);
        assert.match(V.lapsWarning("previous", "local_admin", true), /may still be the one that works/);
        assert.match(V.lapsWarning("previous", "local_admin", false), /replaced/);
        assert.equal(V.lapsWarning("current", "local_admin", false), null);
    });
    await test("secret-job env marker and redaction texts are fixed", () => {
        assert.equal(J.REDACTED_TEXT, "(secret output removed)");
        assert.equal(J.isSecretJobEnv({ RIQ_SECRET_JOB: "1" }), true);
        for (const e of [{ RIQ_SECRET_JOB: "0" }, {}, null, [], "1"]) assert.equal(J.isSecretJobEnv(e), false);
    });

    console.log("scripts: PowerShell parser");
    const all = { bitlockerKeys: S.BITLOCKER_KEYS_SCRIPT, lapsRotate: S.LAPS_ROTATE_SCRIPT };
    const sec = require(path.join(dist, "security/security.scripts"));
    all.securityScan = sec.SECURITY_SCAN_SCRIPT;
    for (const [k, v] of Object.entries(sec.DEFENDER_SCRIPTS ?? {})) all[`defender.${k}`] = v;
    const reg = require(path.join(dist, "device-tools/device-registry.scripts"));
    for (const [k, v] of Object.entries(reg.REGISTRY_SCRIPTS ?? {})) if (typeof v === "string") all[`registry.${k}`] = v;
    for (const [k, v] of Object.entries(reg.REGISTRY_WRITE_SCRIPTS ?? {})) if (typeof v === "string") all[`registrywrite.${k}`] = v;
    const dt = require(path.join(dist, "device-tools/device-tools.scripts"));
    for (const [k, v] of Object.entries(dt.WINDOWS ?? {})) if (typeof v === "string") all[`tools.${k}`] = v;
    await test("every script of the vault, security, registry and tools parses with no syntax error, and every printed text is ASCII", () => {
        const files = Object.entries(all).map(([k, v]) => { assert.ok(!/[^\x00-\x7F]/.test(v), `${k} has non-ASCII text`); return writePs(`${k.replace(/[^\w.]/g, "_")}.ps1`, v); });
        const checker = writePs("parse-check.ps1", `$bad = 0; foreach ($f in $args) { $e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e); if ($e.Count -gt 0) { $bad++; Write-Output ('SYNTAX ' + $f + ': ' + $e[0].Message + ' at ' + $e[0].Extent.StartLineNumber) } }; Write-Output ('checked ' + $args.Count + ' bad ' + $bad)`);
        const r = spawnSync(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", checker, ...files], { encoding: "utf8", timeout: 120000 });
        console.log(`        ${r.stdout.trim().split(/\r?\n/).slice(-1)[0]} (${files.length} scripts)`);
        assert.match(r.stdout, /bad 0\s*$/, r.stdout);
    });
    await test("the vault scripts print the secret to stdout only: never to stderr, a file, a command line or a cmdlet parameter", () => {
        for (const [name, text] of [["bitlockerKeys", S.BITLOCKER_KEYS_SCRIPT], ["lapsRotate", S.LAPS_ROTATE_SCRIPT]]) {
            assert.ok(!/Write-Error|Write-Host|Write-Output|Write-Warning|Write-Verbose|Write-Debug|Out-File|Set-Content|Add-Content|Start-Transcript|Tee-Object|>>?\s*\$|ConvertTo-Json|Add-Type|Invoke-Expression|\biex\b|net\s+user|Start-Process|Out-String/i.test(text.replace(/#.*$/gm, "")), `${name} uses a forbidden way of printing or running`);
            assert.ok(/Out-Raw/.test(text) && text.includes("[Console]::Out.Write"));
        }
        assert.ok(!/RIQ_[A-Z_]+\s*=/.test(S.LAPS_ROTATE_SCRIPT), "no environment is set by the script");
        assert.ok(!/Remove-LocalUser|Disable-LocalUser|Remove-Item|\.Delete\(|net user .* \/delete|Disable|Enable-LocalUser/i.test(S.LAPS_ROTATE_SCRIPT.replace(/#.*$/gm, "")), "the rotation script never deletes or disables an account");
    });

    console.log("password generator (the real PowerShell function)");
    const gen = writePs("gen.ps1", `${S.LAPS_GENERATOR}
foreach ($len in 14, 20, 64) { for ($i = 0; $i -lt 2500; $i++) { [Console]::Out.WriteLine($len.ToString() + ' ' + (New-RiqPassword $len)) } }
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
foreach ($n in 4, 10, 24, 67, 200) { $c = New-Object int[] $n; for ($i = 0; $i -lt 40000; $i++) { $c[(Get-RiqIndex $rng $n)]++ }; [Console]::Out.WriteLine('IDX ' + $n + ' ' + ($c -join ',')) }
foreach ($p in 'Ab3!Ab3!Ab3!Ab3!Ab3!', 'ab3!ab3!ab3!ab3!ab3!', 'Ab3Ab3Ab3Ab3Ab3Ab3', 'Ab!Ab!Ab!Ab!Ab!Ab!', 'AbcAbc!Abc!Abc!Abc!', 'Il3!Il3!Il3!Il3!Il3!', 'Ab3!Ab3!Ab3!Ab3!Ab3 ', 'Ab3!Ab3!Ab3!Ab3!Ab3') { [Console]::Out.WriteLine('TEST ' + (Test-RiqPassword $p 20) + ' ' + $p) }
`);
    let genOut;
    await test("generates 7500 passwords at lengths 14, 20 and 64 in one run", () => {
        const r = ps(gen); assert.equal(r.code, 0, r.err);
        genOut = r.out.split(/\r?\n/).filter(Boolean);
        console.log(`        generated in ${r.ms} ms`);
        assert.ok(genOut.filter((l) => /^\d+ /.test(l) && !l.startsWith("IDX")).length >= 7500);
    });
    const pws = () => genOut.filter((l) => /^(14|20|64) /.test(l)).map((l) => l.split(" "));
    await test("every password has the asked length, only characters of the alphabet, and at least one of each class", () => {
        const list = pws(); assert.equal(list.length, 7500);
        for (const [len, pw] of list) {
            assert.equal(pw.length, Number(len)); assert.ok(P.isValidLapsPassword(pw, Number(len)), pw);
            assert.ok(!/[IOl0-1"'\\ `$]/.test(pw), `look-alike or unsafe character in ${pw}`);
        }
        assert.equal(P.LAPS_ALPHABET.length, 67);
    });
    await test("all 7500 are different, and the class characters do not always come first (the shuffle works)", () => {
        const list = pws().map((x) => x[1]);
        assert.equal(new Set(list).size, list.length);
        const startsUpper = list.filter((p) => /^[A-Z]/.test(p)).length / list.length;
        assert.ok(startsUpper > 0.25 && startsUpper < 0.5, `first character is upper case ${startsUpper}`);
        const lens20 = list.filter((p) => p.length === 20); const pos = [0, 1, 2, 3].map((i) => new Set(lens20.map((p) => p[i])).size);
        assert.ok(pos.every((n) => n >= 55), `position variety ${pos}`);
    });
    await test("no modulo bias: the index picker is uniform for n = 4, 10, 24, 67, 200 (chi-square, 40000 draws each)", () => {
        // 99.99th percentile of chi-square for df = n - 1 (Wilson-Hilferty), so a fair picker practically never fails
        const crit = (df) => { const z = 3.72; const h = 2 / (9 * df); return df * Math.pow(1 - h + z * Math.sqrt(h), 3); };
        for (const l of genOut.filter((x) => x.startsWith("IDX "))) {
            const [, n, counts] = l.split(" "); const c = counts.split(",").map(Number); const N = c.reduce((a, b) => a + b, 0);
            assert.equal(c.length, Number(n)); assert.equal(N, 40000);
            const e = N / c.length; const chi = c.reduce((a, o) => a + (o - e) ** 2 / e, 0);
            assert.ok(chi < crit(c.length - 1), `n=${n}: chi-square ${chi.toFixed(1)} vs ${crit(c.length - 1).toFixed(1)}`);
            console.log(`        n=${n}: chi-square ${chi.toFixed(1)} (limit ${crit(c.length - 1).toFixed(1)})`);
        }
        // and the reason a naive byte % n would fail: for n = 67 the first 55 values would be 25 percent more likely
        const naive = 256 / 67; assert.ok(Math.ceil(naive) / Math.floor(naive) > 1.2);
    });
    await test("the device-side check (Test-RiqPassword) accepts a good one and rejects missing classes, look-alikes, spaces and the wrong length", () => {
        const t = genOut.filter((l) => l.startsWith("TEST ")).map((l) => l.split(" ")[1]);
        assert.deepEqual(t, ["True", "False", "False", "False", "False", "False", "False", "False"]);
    });

    console.log("lapsRotate run for real, ONLY with RIQ_DRY_RUN=1 (changes nothing)");
    const lapsFile = writePs("lapsRotate.ps1", S.LAPS_ROTATE_SCRIPT);
    await test("dry run: exit 0, ASCII JSON in the real result shape, the server parser refuses it as a dry run and nothing is stored; time is measured", () => {
        const r = ps(lapsFile, { RIQ_DRY_RUN: "1", RIQ_LAPS_ACCOUNT: "riq-admin", RIQ_LAPS_LENGTH: "20", RIQ_TOOL: "vault.laps", RIQ_SECRET_JOB: "1" });
        console.log(`        dry run took ${r.ms} ms (exit ${r.code})`);
        assert.equal(r.code, 0, r.err); assert.equal(r.err.trim(), "", "nothing on stderr");
        assert.ok(!/[^\x00-\x7F]/.test(r.out));
        const j = JSON.parse(r.out);
        assert.deepEqual(Object.keys(j).sort(), ["account", "created", "dryRun", "ok", "password", "verified"]);
        assert.equal(j.ok, true); assert.equal(j.dryRun, true); assert.equal(j.account, "riq-admin"); assert.equal(j.created, false); assert.equal(j.verified, false);
        assert.ok(P.isValidLapsPassword(j.password, 20));
        throwsCode(() => P.parseLapsResult(r.out, { account: "riq-admin", length: 20 }), "dry_run");
        // the same text without the dry-run flag would be accepted (so the parser is what stops a dry run being stored)
        const live = P.parseLapsResult(JSON.stringify({ ...j, dryRun: undefined }), { account: "riq-admin", length: 20 });
        assert.equal(live.password, j.password);
    });
    await test("dry run: other lengths and account names work, bad ones are refused with a reason code, exit 1 and no password", () => {
        for (const [len, acct] of [["14", "a"], ["64", "My.Admin_01-x"], ["33", "x".repeat(20)]]) {
            const r = ps(lapsFile, { RIQ_DRY_RUN: "1", RIQ_LAPS_ACCOUNT: acct, RIQ_LAPS_LENGTH: len });
            assert.equal(r.code, 0, `${len} ${acct}: ${r.err}`);
            assert.ok(P.isValidLapsPassword(JSON.parse(r.out).password, Number(len)));
        }
        for (const [len, acct, reason] of [["20", "Administrator", "reserved_account"], ["20", "GUEST", "reserved_account"], ["20", "SYSTEM", "reserved_account"], ["20", "DefaultAccount", "reserved_account"], ["20", "", "invalid_account"], ["20", "x".repeat(21), "invalid_account"], ["20", "bad name", "invalid_account"], ["20", "a;b", "invalid_account"], ["20", "a\"b", "invalid_account"], ["13", "riq-admin", "invalid_length"], ["65", "riq-admin", "invalid_length"], ["abc", "riq-admin", "invalid_length"], ["", "riq-admin", "invalid_length"]]) {
            const r = ps(lapsFile, { RIQ_DRY_RUN: "1", RIQ_LAPS_ACCOUNT: acct, RIQ_LAPS_LENGTH: len });
            assert.equal(r.code, 1, `${len} ${acct}`);
            const j = JSON.parse(r.out); assert.equal(j.ok, false); assert.equal(j.reason, reason); assert.ok(!("password" in j));
        }
    });
    await test("two dry runs give different passwords (the generator is fresh each time)", () => {
        const a = JSON.parse(ps(lapsFile, { RIQ_DRY_RUN: "1", RIQ_LAPS_ACCOUNT: "riq-admin", RIQ_LAPS_LENGTH: "20" }).out).password;
        const b = JSON.parse(ps(lapsFile, { RIQ_DRY_RUN: "1", RIQ_LAPS_ACCOUNT: "riq-admin", RIQ_LAPS_LENGTH: "20" }).out).password;
        assert.notEqual(a, b);
    });

    console.log(`\n${passed} passed, ${failures.length} failed`);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
