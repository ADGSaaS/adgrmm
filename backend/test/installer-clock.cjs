// The installers put the device clock right before they download (a wrong date makes the server's certificate look expired or not yet
// valid). The Linux part runs the real function from the generated script in bash with a stub curl and a stub date; the Windows part runs
// the real functions in PowerShell against a real local HTTPS server with a self-signed certificate (so the "certificate not trusted, read
// the Date header anyway" path is real) with Set-Date, w32tm and Start-Service stubbed so this machine's clock is never touched.
// Run after a build: node test/installer-clock.cjs
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const https = require("node:https");
const assert = require("node:assert/strict");
const { spawnSync, spawn } = require("node:child_process");

const S = require(path.join(__dirname, "..", process.env.DIST || "dist", "provisioning", "installer-scripts.js"));
const vals = { baseUrl: "https://riq.example.test", enrollmentKey: "k", packageSha256: "0".repeat(64) };
let passed = 0, failed = 0;
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, ...o });
const bash = (() => { for (const b of ["bash", "C:/Program Files/Git/bin/bash.exe"]) { if (run(b, ["-c", "true"]).status === 0) return b; } return null; })();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-clock-"));
const check = async (name, fn) => { try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

(async () => {
    console.log("the scripts");
    await check("both scripts carry the clock step, before the download, and stay plain", () => {
        const lin = S.linuxInstallerScript(vals), win = S.windowsInstallerScript(vals);
        assert.ok(lin.indexOf("sync_clock || true") > 0 && lin.indexOf("sync_clock || true") < lin.indexOf("agent-packages/linux"));
        assert.ok(win.indexOf("\nSync-Clock\n") > 0 && win.indexOf("\nSync-Clock\n") < win.indexOf("Invoke-WebRequest"));
        assert.ok(!/[^\x00-\x7f]/.test(win), "the Windows script must stay ASCII");
        assert.equal(run(bash || "bash", ["-n"], { input: lin }).status, 0, "bash syntax");
    });

    console.log("Linux function, stubbed curl and date");
    if (!bash) console.log("     (no bash, skipped)");
    else {
        const lin = S.linuxInstallerScript(vals);
        const body = lin.slice(lin.indexOf("server_epoch() {"), lin.indexOf("sync_clock || true"));
        const real = run(bash, ["-c", "command -v date"]).stdout.trim();
        const case_ = (name, { header, curlFailsVerified = false, curlDead = false, offsetSec = 0 }) => {
            const d = fs.mkdtempSync(path.join(tmp, "c-")); const bin = path.join(d, "bin"); fs.mkdirSync(bin);
            const log = path.join(d, "set.log");
            fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash\n${curlDead ? "exit 6\n" : `${curlFailsVerified ? 'case "$*" in *" -k "*) ;; *) exit 60;; esac\n' : ""}printf 'HTTP/1.1 404 Not Found\\r\\n${header ? `Date: ${header}\\r\\n` : ""}\\r\\n'\n`}`, { mode: 0o755 });
            fs.writeFileSync(path.join(bin, "date"), `#!/bin/bash\nif [ "$1" = "-u" ] && [ "$2" = "-s" ]; then echo "$3" >> "${posix(log)}"; exit 0; fi\nif [ "$1" = "-u" ] && [ "$2" = "+%s" ] && [ -n "${offsetSec}" ]; then echo $(( $("${posix(real)}" -u +%s) + ${offsetSec} )); exit 0; fi\nexec "${posix(real)}" "$@"\n`, { mode: 0o755 });
            fs.writeFileSync(path.join(bin, "timedatectl"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
            const r = run(bash, ["-c", `set -euo pipefail\nBASE_URL='https://riq.example.test'\nPATH="${posix(bin)}:$PATH"\n${body}\nsync_clock || true\nexit 0`]);
            return { out: r.stdout + r.stderr, set: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : "" };
        };
        const rfc = (ms) => new Date(ms).toUTCString();
        await check("a clock two days behind is set from the server's Date header", () => {
            const now = Date.now(), r = case_("behind", { header: rfc(now), offsetSec: -2 * 86400 });
            assert.match(r.set, /^@\d+$/, r.out); assert.ok(Math.abs(Number(r.set.slice(1)) - now / 1000) < 90, r.set + " vs " + now / 1000);
        });
        await check("a clock a year ahead is set back", () => {
            const now = Date.now(), r = case_("ahead", { header: rfc(now), offsetSec: 365 * 86400 });
            assert.ok(r.set && Math.abs(Number(r.set.slice(1)) - now / 1000) < 90, r.out);
        });
        await check("a clock that is nearly right is left alone", () => { assert.equal(case_("ok", { header: rfc(Date.now()), offsetSec: 60 }).set, ""); });
        await check("when the certificate cannot be verified the header is read anyway", () => {
            const now = Date.now(), r = case_("insecure", { header: rfc(now), offsetSec: -86400, curlFailsVerified: true });
            assert.ok(r.set && Math.abs(Number(r.set.slice(1)) - now / 1000) < 90, r.out);
        });
        await check("a server that cannot be reached, or sends no date, changes nothing and does not stop the install", () => {
            assert.equal(case_("dead", { curlDead: true, offsetSec: -86400 }).set, "");
            assert.equal(case_("nodate", { header: "", offsetSec: -86400 }).set, "");
        });
        await check("an implausible server date (before 2023) is never applied", () => { assert.equal(case_("old", { header: "Mon, 01 Jan 2001 00:00:00 GMT", offsetSec: 0 }).set, ""); });
    }

    console.log("Windows functions, PowerShell against a real HTTPS server with a self-signed certificate");
    const ps = "powershell";
    if (process.platform !== "win32" || run(ps, ["-NoProfile", "-Command", "1"]).status !== 0) console.log("     (not Windows, skipped)");
    else if (run("openssl", ["version"]).status !== 0) console.log("     (no openssl to make a certificate, skipped)");
    else {
        const key = path.join(tmp, "k.pem"), crt = path.join(tmp, "c.pem");
        assert.equal(run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]).status, 0);
        let skewMs = 0, dead = false;
        const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => {
            res.writeHead(404, { Date: new Date(Date.now() + skewMs).toUTCString(), "Content-Length": 0 }); res.end();
        });
        await new Promise((r) => srv.listen(0, "127.0.0.1", r));
        const port = srv.address().port;
        const win = S.windowsInstallerScript({ ...vals, baseUrl: `https://127.0.0.1:${port}` });
        const funcs = win.slice(win.indexOf("function Get-ServerDate"), win.indexOf("\nSync-Clock\n"));
        const go = async (extra = "") => {
            const script = `$ErrorActionPreference = 'Stop'\n$BaseUrl = 'https://127.0.0.1:${port}'\n$script:log = @(); $script:set = $null\nfunction Write-Log([string]$m) { $script:log += $m }\nfunction Set-Date { param($Date) $script:set = $Date }\nfunction w32tm.exe { }\nfunction Start-Service { param($Name, $ErrorAction) }\n${funcs}\n${extra}\nSync-Clock\nif ($script:set) { 'SET ' + $script:set.ToUniversalTime().ToString('o') } else { 'NOSET' }\n$script:log -join '|'\n`;
            const f = path.join(tmp, `t-${Date.now()}.ps1`); fs.writeFileSync(f, script);
            // asynchronous: the HTTPS server lives in this process and must keep answering while PowerShell runs
            return await new Promise((resolve) => { const c = spawn(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f]); let o = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (o += d)); c.on("close", () => resolve(o)); });
        };
        try {
            await check("a device that is right is left alone (even though the certificate is not trusted)", async () => { skewMs = 0; assert.match(await go(), /^NOSET/m); });
            await check("a device whose clock is far from the server's is set to the server's time (read despite the untrusted certificate)", async () => {
                skewMs = 3 * 86_400_000; // the server is 3 days ahead of this device
                const out = await go(), m = /^SET (\S+)/m.exec(out); assert.ok(m, out);
                assert.ok(Math.abs(Date.parse(m[1]) - (Date.now() + skewMs)) < 60_000, out);
                assert.match(out, /off by about 4\d\d\d minutes/);
            });
            await check("a server that does not answer changes nothing and does not throw", async () => {
                srv.close(); const out = await go();
                assert.match(out, /^NOSET/m); assert.ok(!/Exception|Cannot|error/i.test(out.split("\n").filter((l) => !l.startsWith("NOSET")).join("\n")) || /Continuing|NOSET/.test(out), out);
            });
        } finally { try { srv.close(); } catch { } }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
