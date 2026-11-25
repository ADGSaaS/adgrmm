// "Recover agents" restart scripts, run for real: the Linux script in a systemd container and in an OpenRC (Alpine) container against a
// stand-in service called like the agent (the service name switch RIQ_AGENT_SERVICE is for tests only), checking the process really is
// replaced a few seconds later and that the restart does not depend on the job that asked for it; the Windows script is parsed with the real
// PowerShell parser and its dry run is run here (a real restart needs an administrator and a service to restart).
// Run after a build: node test/recover-agent-scripts.cjs   (Docker and PowerShell parts are skipped with a note when missing)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const R = require(path.join(__dirname, "..", process.env.DIST || "dist", "bulk", "recover-agent.scripts.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 300_000, ...o });
const dk = (...a) => run("docker", a);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-recover-"));

console.log("the scripts");
check("they are plain: no dollar-brace sequence, no backtick, ASCII, no input from a person", () => {
    for (const s of [R.WINDOWS_RECOVER_SCRIPT, R.LINUX_RECOVER_SCRIPT]) { assert.ok(!s.includes("${") && !s.includes("`")); assert.ok(!/[^\x00-\x7f]/.test(s)); }
    assert.equal(spawnSync("bash", ["-n"], { input: R.LINUX_RECOVER_SCRIPT, encoding: "utf8" }).status, 0);
});

console.log("Windows (the real PowerShell parser and the dry run)");
if (process.platform !== "win32") console.log("     (not Windows, skipped)");
else {
    const f = path.join(tmp, "recover.ps1"); fs.writeFileSync(f, R.WINDOWS_RECOVER_SCRIPT);
    check("it parses without errors", () => {
        const r = run("powershell", ["-NoProfile", "-Command", `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.Message }; exit 1 }; 'parsed'`]);
        assert.equal(r.status, 0, r.stdout + r.stderr);
    });
    check("the scheduled-task commands it uses exist on this Windows", () => {
        const r = run("powershell", ["-NoProfile", "-Command", "foreach ($c in 'New-ScheduledTaskAction','New-ScheduledTaskPrincipal','Register-ScheduledTask','Start-ScheduledTask','Unregister-ScheduledTask') { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { 'missing ' + $c; exit 1 } }; 'all there'"]);
        assert.equal(r.status, 0, r.stdout + r.stderr);
    });
    const ps = (env) => run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { env: { ...process.env, ...env } });
    check("a dry run against a service that exists says what it would do and changes nothing", () => {
        const r = ps({ RIQ_AGENT_SERVICE: "Winmgmt", RIQ_DRY_RUN: "1" });
        assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^OK Dry run: the service Winmgmt would be restarted/m);
        assert.ok(!run("powershell", ["-NoProfile", "-Command", "if (Get-ScheduledTask -TaskName 'RemoteIQ Agent Recover' -ErrorAction SilentlyContinue) { 'exists' }"]).stdout.includes("exists"), "no task was made");
    });
    check("a service that does not exist, and a bad service name, stop it with a reason", () => {
        const a = ps({ RIQ_AGENT_SERVICE: "NoSuchServiceHere", RIQ_DRY_RUN: "1" }); assert.notEqual(a.status, 0); assert.match(a.stderr + a.stdout, /was not found/);
        const b = ps({ RIQ_AGENT_SERVICE: "x; calc", RIQ_DRY_RUN: "1" }); assert.equal(b.status, 2); assert.match(b.stderr + b.stdout, /not valid/);
    });
}

console.log("Linux in Docker");
if (dk("info", "--format", "{{.ServerVersion}}").status !== 0) console.log("     (Docker is not running, skipped)");
else {
    const stamp = Date.now(), names = [];
    const put = (n, name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text, { mode: 0o755 }); assert.equal(dk("cp", f, `${n}:/tmp/${name}`).status, 0); };
    const sh = (n, cmd, env = {}, user) => dk("exec", ...(user ? ["-u", user] : []), ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), n, "sh", "-c", cmd);
    const pidOf = (n, cmd) => sh(n, cmd).stdout.trim();
    const wait = (ms) => run("sleep", [String(ms / 1000)]);
    try {
        // ---- systemd
        const sd = `riq-rec-sd-${stamp}`; names.push(sd);
        assert.equal(dk("run", "-d", "--name", sd, "--privileged", "--cgroupns=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", "jrei/systemd-debian:12").status, 0);
        for (let i = 0; i < 30 && !/running|degraded/.test(sh(sd, "systemctl is-system-running").stdout); i++) wait(2000);
        sh(sd, "printf '[Service]\\nExecStart=/bin/sleep infinity\\n' > /etc/systemd/system/riq-dummy.service && systemctl daemon-reload && systemctl start riq-dummy");
        put(sd, "rec.sh", R.LINUX_RECOVER_SCRIPT);
        check("systemd: the service is restarted a few seconds after the job ends, by something that is not the job", () => {
            const before = pidOf(sd, "systemctl show -p MainPID --value riq-dummy"); assert.ok(Number(before) > 0, "running");
            const r = sh(sd, "bash /tmp/rec.sh", { RIQ_AGENT_SERVICE: "riq-dummy" });
            assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^OK The agent service riq-dummy restarts in a few seconds/m);
            assert.equal(pidOf(sd, "systemctl show -p MainPID --value riq-dummy"), before, "not yet: the restart waits a moment so the answer can be sent");
            let after = before; for (let i = 0; i < 20 && after === before; i++) { wait(1000); after = pidOf(sd, "systemctl show -p MainPID --value riq-dummy"); }
            assert.notEqual(after, before, "the process was replaced"); assert.ok(Number(after) > 0, "and it is running");
            assert.match(sh(sd, "systemctl is-active riq-dummy").stdout, /^active/);
        });
        check("systemd: a restart does not need the caller to stay alive (the caller is killed right after it answers)", () => {
            const before = pidOf(sd, "systemctl show -p MainPID --value riq-dummy");
            sh(sd, "(bash /tmp/rec.sh; kill -9 $$) >/dev/null 2>&1", { RIQ_AGENT_SERVICE: "riq-dummy" });
            let after = before; for (let i = 0; i < 20 && after === before; i++) { wait(1000); after = pidOf(sd, "systemctl show -p MainPID --value riq-dummy"); }
            assert.notEqual(after, before);
        });
        check("systemd: dry run changes nothing; a missing service, a bad name and a non-root caller are refused", () => {
            const before = pidOf(sd, "systemctl show -p MainPID --value riq-dummy");
            const d = sh(sd, "bash /tmp/rec.sh", { RIQ_AGENT_SERVICE: "riq-dummy", RIQ_DRY_RUN: "1" }); assert.equal(d.status, 0); assert.match(d.stdout, /Dry run/);
            wait(5000); assert.equal(pidOf(sd, "systemctl show -p MainPID --value riq-dummy"), before);
            const m = sh(sd, "bash /tmp/rec.sh", { RIQ_AGENT_SERVICE: "nope-service" }); assert.equal(m.status, 1); assert.match(m.stderr, /was not found/);
            const b = sh(sd, "bash /tmp/rec.sh", { RIQ_AGENT_SERVICE: "x; reboot" }); assert.equal(b.status, 2);
            const n = sh(sd, "bash /tmp/rec.sh", { RIQ_AGENT_SERVICE: "riq-dummy" }, "nobody"); assert.equal(n.status, 77);
        });

        // ---- OpenRC on Alpine
        const al = `riq-rec-al-${stamp}`; names.push(al);
        assert.equal(dk("run", "-d", "--init", "--name", al, "--privileged", "alpine:3.20", "sh", "-c",
            "apk add --no-cache openrc bash >/dev/null 2>&1 && mkdir -p /run/openrc && touch /run/openrc/softlevel && echo 'rc_provide=\"loopback net\"' >> /etc/rc.conf && rc-status -a >/dev/null 2>&1 && printf '#!/sbin/openrc-run\\nsupervisor=supervise-daemon\\ncommand=/bin/sleep\\ncommand_args=\"infinity\"\\n' > /etc/init.d/riq-dummy && chmod +x /etc/init.d/riq-dummy && rc-service riq-dummy start && exec sleep 100000").status, 0);
        for (let i = 0; i < 40 && !/started/.test(sh(al, "rc-service riq-dummy status 2>&1").stdout); i++) wait(2000);
        put(al, "rec.sh", R.LINUX_RECOVER_SCRIPT);
        const apid = () => pidOf(al, "pidof sleep | tr ' ' '\\n' | sort -n | head -1");
        check("OpenRC (Alpine): the service is restarted a few seconds after the job ends", () => {
            const before = pidOf(al, "cat /run/supervise-riq-dummy.pid 2>/dev/null || pidof sleep"); assert.ok(before, "running");
            const r = sh(al, "bash /tmp/rec.sh", { RIQ_AGENT_SERVICE: "riq-dummy" }); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^OK /m);
            let after = before; for (let i = 0; i < 25 && after === before; i++) { wait(1000); after = pidOf(al, "cat /run/supervise-riq-dummy.pid 2>/dev/null || pidof sleep"); }
            assert.notEqual(after, before); assert.match(sh(al, "rc-service riq-dummy status 2>&1").stdout, /started/);
        });
        check("OpenRC: a missing service is refused", () => { const m = sh(al, "bash /tmp/rec.sh", { RIQ_AGENT_SERVICE: "nope-service" }); assert.equal(m.status, 1); assert.match(m.stderr, /was not found/); });
    } catch (e) { failed++; console.log(`FAIL Docker setup: ${e.message}`); }
    finally { for (const n of names) dk("rm", "-f", n); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
