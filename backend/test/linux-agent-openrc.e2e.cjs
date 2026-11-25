// The real Linux agent on ALPINE (musl, OpenRC, busybox), installed by the real installer script, enrolling against a local throwaway
// server, then updating itself through the real update path (the OpenRC updater, the musl program swapped in) and being uninstalled.
// Needs Docker, the built agent package in AGENT_PKG_DIR (linux/remoteiq-agent-linux-x64.tar.gz + version.json, the package that holds
// BOTH the glibc and the musl program), and for the update step a newer build in AGENT_PKG_NEXT_DIR (same layout), and a server started
// with AGENT_PKG_DIR set and listening on all interfaces (the container reaches it as host.docker.internal).
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3973 PUBLIC_URL=http://host.docker.internal:3973 AGENT_PKG_DIR=... AGENT_PKG_NEXT_DIR=... DATABASE_URL=postgres://.../riq_x_e2e JWT_SECRET=... node test/linux-agent-openrc.e2e.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { assert, call, runner, setup } = require("./groupc-helpers.cjs");

const docker = (args, o = {}) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1e8, timeout: 600_000, ...o });
if (docker(["info", "--format", "{{.ServerVersion}}"]).status !== 0) { console.log("skipped: Docker is not running"); process.exit(0); }
const PKG_DIR = process.env.AGENT_PKG_DIR;
const tar = PKG_DIR && path.join(PKG_DIR, "linux", "remoteiq-agent-linux-x64.tar.gz");
if (!tar || !fs.existsSync(tar)) { console.log("skipped: AGENT_PKG_DIR has no linux package"); process.exit(0); }

const IMAGE = process.env.ALPINE_IMAGE || "alpine:3.20";
const NAME = `riq-alp-${Date.now()}`;
const why = async (r) => (r.status < 400 ? "" : r.text());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => docker(["exec", NAME, "sh", "-c", cmd]);
const until = async (what, fn, ms = 180_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(2000); } };
const versionOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "linux", "version.json"), "utf8")).version;

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `ALP${Date.now()}`;
    const admin = await staffUser("alp-admin", ["customers.read", "customers.write", "devices.read", "devices.actions", "software.install", "automation.run"]);
    const clientId = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, tag])).rows[0].id;
    made.clients.push(clientId);
    const siteId = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'HQ') RETURNING id`, [clientId])).rows[0].id;
    let deviceId = null;
    const saved = new Map();
    const firstVersion = versionOf(PKG_DIR);

    try {
        await test("an Alpine container with OpenRC starts and has what a small Alpine has (bash and curl, the way a person would add them)", async () => {
            const r = docker(["run", "-d", "--init", "--name", NAME, "--privileged", "--add-host", "host.docker.internal:host-gateway", IMAGE, "sh", "-c",
                "apk add --no-cache openrc >/dev/null 2>&1 && mkdir -p /run/openrc && touch /run/openrc/softlevel && echo 'rc_provide=\"loopback net\"' >> /etc/rc.conf && echo ready && exec sleep 100000"]);
            assert.equal(r.status, 0, r.stderr);
            await until("openrc", () => /started|stopped|Runlevel|Dynamic/.test(sh("rc-status -a 2>&1").stdout || ""), 120_000);
            const i = sh("apk add --no-cache bash curl >/dev/null 2>&1; command -v bash && command -v curl && ls /lib/ld-musl-x86_64.so.1 && test ! -e /lib64/ld-linux-x86-64.so.2 && echo musl-only");
            assert.match(i.stdout, /bash[\s\S]*curl[\s\S]*musl-only/, i.stdout + i.stderr);
        });

        let installLog = "";
        await test("the installer adds what Alpine lacks, installs the MUSL program, writes an OpenRC service and enrolls the device", async () => {
            const kr = await call("/api/provisioning/enrollment-keys", { method: "POST", token: admin.token, body: { clientId, siteId, name: tag, expiresMinutes: 60 } });
            assert.equal(kr.status, 201, await why(kr));
            const key = (await kr.json()).enrollmentKey;
            const { linuxInstallerScript } = require(path.join(__dirname, "..", process.env.DIST || "dist", "provisioning", "installer-scripts.js"));
            const sha = crypto.createHash("sha256").update(fs.readFileSync(tar)).digest("hex");
            const f = path.join(os.tmpdir(), `${NAME}.sh`);
            fs.writeFileSync(f, linuxInstallerScript({ baseUrl: process.env.PUBLIC_URL, enrollmentKey: key, packageSha256: sha, onlyIfMissing: false }));
            assert.equal(docker(["cp", f, `${NAME}:/install.sh`]).status, 0);
            const r = sh("bash /install.sh 2>&1");
            installLog = (r.stdout || "") + (r.stderr || "");
            assert.match(installLog, /Done\. This device is now enrolled as agent /, installLog.slice(-800));
            assert.match(sh("rc-service remoteiq-agent status 2>&1").stdout, /started/);
            assert.match(sh("rc-update show default 2>&1").stdout, /remoteiq-agent/);
            assert.ok(!sh("ls /opt/remoteiq-agent").stdout.includes("remoteiq-agent-musl"), "the spare program was moved into place, not left beside it");
            assert.match(sh("ls -l /opt/remoteiq-agent/remoteiq-agent").stdout, /rwx/);
            const row = (await q(`SELECT d.id FROM devices d JOIN agents a ON a.device_id = d.id WHERE d.site_id = $1`, [siteId])).rows[0];
            assert.ok(row, "the device exists");
            deviceId = row.id;
        });

        await test("the service is supervised: killing the agent brings it back", async () => {
            const pid = () => sh("cat /run/supervise-remoteiq-agent.pid 2>/dev/null; pidof remoteiq-agent").stdout.trim().split(/\s+/).pop();
            const before = pid(); assert.ok(before, "running");
            sh("kill -9 " + before);
            await until("a new agent process", () => { const p = pid(); return p && p !== before ? p : null; }, 90_000);
        });

        await test("a second run of the installer keeps the same device (no duplicate)", async () => {
            const r = sh("bash /install.sh 2>&1");
            assert.match(r.stdout, /Done\. This device is now enrolled/, r.stdout.slice(-500));
            assert.equal((await q(`SELECT count(*)::int AS n FROM devices WHERE site_id = $1`, [siteId])).rows[0].n, 1);
        });

        await test("the agent reports Alpine, musl and OpenRC, a model and a processor with its counts", async () => {
            const facts = await until("facts", async () => { const a = (await q(`SELECT facts FROM agents WHERE device_id = $1`, [deviceId])).rows[0]; return a?.facts?.device?.os && a.facts.device.libc ? a.facts : null; });
            assert.match(String(facts.device.os.name), /Alpine/);
            assert.equal(facts.os, "linux"); assert.equal(facts.device.libc, "musl"); assert.equal(facts.device.init, "openrc");
            const hw = (await q(`SELECT facts->'device'->'hardware' AS h FROM agents WHERE device_id = $1`, [deviceId])).rows[0].h;
            console.log("       hardware:", JSON.stringify(hw));
            assert.ok(hw && (hw.cpu || hw.model), "hardware facts are present");
            if (hw.cpu && /\d+C\/\d+T/.test(hw.cpu)) assert.match(hw.cpu, /, \d+C\/\d+T$/);
        });

        await test("a script runs on the device through the real agent (bash from Alpine's package)", async () => {
            const marker = `riq-alpine-${Date.now()}`;
            const r = await call("/api/bulk/devices/run-script", { method: "POST", token: admin.token, body: { deviceIds: [deviceId], script: `echo ${marker} $(uname -s) $(. /etc/os-release; echo $ID)`, shell: "bash", timeoutSec: 60 } });
            assert.equal(r.status, 200, await why(r));
            const out = await until("the script result", async () => {
                const row = (await q(`SELECT jr.stdout, j.status FROM jobs j JOIN agents a ON a.id = j.agent_id LEFT JOIN job_results jr ON jr.job_id = j.id WHERE a.device_id = $1 AND j.payload::text LIKE $2 ORDER BY j.created_at DESC LIMIT 1`, [deviceId, `%${marker}%`])).rows[0];
                return row && ["succeeded", "failed", "timeout"].includes(row.status) ? row : null;
            }, 120_000);
            assert.equal(out.status, "succeeded"); assert.match(out.stdout, new RegExp(`${marker} Linux alpine`));
        });

        await test("the software list is read from apk, and a package is installed and removed by name through the real agent (apk)", async () => {
            const n = await until("software", async () => { const c = (await q(`SELECT count(*)::int AS n FROM agent_software s JOIN agents a ON a.id = s.agent_id WHERE a.device_id = $1`, [deviceId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n; return c > 12 ? c : 0; }, 240_000);
            assert.ok(n > 12, `${n} packages`);
            const names = (await q(`SELECT s.name FROM agent_software s JOIN agents a ON a.id = s.agent_id WHERE a.device_id = $1`, [deviceId])).rows.map((x) => x.name);
            assert.ok(names.includes("busybox") && names.includes("musl"), "the base packages are listed by their plain names: " + names.slice(0, 8).join(","));
            const jobDone = async (jobId) => until(`job ${jobId}`, async () => { const j = (await q(`SELECT status FROM jobs WHERE id = $1`, [jobId])).rows[0]; return ["succeeded", "failed", "timeout"].includes(j?.status) ? j.status : null; }, 600_000);
            let r = await call(`/api/devices/${deviceId}/actions/install-package`, { method: "POST", token: admin.token, body: { name: "tree" } });
            assert.equal(r.status, 202, await why(r));
            assert.equal(await jobDone((await r.json()).jobId), "succeeded");
            assert.match(sh("apk info -e tree && echo yes").stdout, /yes/);
            r = await call(`/api/devices/${deviceId}/actions/uninstall`, { method: "POST", token: admin.token, body: { name: "tree" } });
            assert.equal(await jobDone((await r.json()).jobId), "succeeded");
            assert.doesNotMatch(sh("apk info -e tree && echo yes").stdout, /yes/);
            r = await call(`/api/devices/${deviceId}/actions/uninstall`, { method: "POST", token: admin.token, body: { name: "busybox" } });
            assert.equal(r.status, 400, "protected packages are refused before any job exists");
        });

        await test("a security scan runs on Alpine and reads back (no systemd tools needed, the checks that cannot read say so)", async () => {
            const r = await call(`/api/devices/${deviceId}/security/scan`, { method: "POST", token: admin.token, body: {} });
            assert.equal(r.status, 200, await why(r));
            const v = await until("the scan", async () => { const x = await (await call(`/api/devices/${deviceId}/security`, { token: admin.token })).json(); return x.state === "scanned" && !x.pending ? x : null; });
            assert.ok(v.scan.score !== null, "scored");
            assert.ok(v.scan.rules.length > 10, "rules were evaluated");
        });

        const nextDir = process.env.AGENT_PKG_NEXT_DIR;
        await test("the agent updates itself through the OpenRC updater: the new MUSL program is swapped in, the service comes back on the new version, the updater removes itself", async () => {
            if (!nextDir || !fs.existsSync(path.join(nextDir, "linux", "remoteiq-agent-linux-x64.tar.gz"))) { console.log("       (no AGENT_PKG_NEXT_DIR, skipped)"); return; }
            const nextVersion = versionOf(nextDir);
            assert.notEqual(nextVersion, firstVersion);
            // the slot is put back afterwards, so the test can run again
            for (const f of ["remoteiq-agent-linux-x64.tar.gz", "version.json"]) { saved.set(f, fs.readFileSync(path.join(PKG_DIR, "linux", f))); fs.copyFileSync(path.join(nextDir, "linux", f), path.join(PKG_DIR, "linux", f)); }
            const r = await call(`/api/devices/${deviceId}/actions/update-agent`, { method: "POST", token: admin.token, body: {} });
            assert.equal(r.status, 202, await why(r));
            const j = await r.json(); assert.equal(j.status, "started", JSON.stringify(j));
            await until(`the agent to report ${nextVersion}`, async () => (await q(`SELECT version FROM agents WHERE device_id = $1`, [deviceId])).rows[0].version === nextVersion ? true : null, 420_000);
            assert.match(sh("rc-service remoteiq-agent status 2>&1").stdout, /started/);
            await until("the updater to clean up", () => !sh("ls /etc/init.d/remoteiq-agent-update 2>&1").stdout.includes("remoteiq-agent-update") || sh("ls /etc/init.d/remoteiq-agent-update 2>&1").stdout.includes("No such") ? true : null, 180_000);
            assert.ok(sh("ls /etc/init.d/remoteiq-agent-update 2>&1").stdout.includes("No such"), "the updater service is gone");
            assert.ok(!sh("rc-update show default 2>&1").stdout.includes("remoteiq-agent-update"), "and not enabled at boot");
            assert.ok(sh("ls /opt/remoteiq-agent").stdout.includes("remoteiq-agent") && !sh("ls /opt/remoteiq-agent").stdout.includes("-musl"), "only the one program is installed");
            assert.ok(!sh("ls -d /opt/remoteiq-agent.prev /opt/remoteiq-agent.update 2>&1").stdout.match(/^\/opt/m), "no leftovers");
            const res = sh("cat /etc/remoteiq/update/result.json 2>/dev/null").stdout;
            assert.match(res, /"outcome":"succeeded"/, res + sh("cat /etc/remoteiq/update/apply.log 2>&1 | tail -20").stdout);
            // the agent is still the same device after the swap
            assert.equal((await q(`SELECT count(*)::int AS n FROM devices WHERE site_id = $1`, [siteId])).rows[0].n, 1);
        });

        await test("uninstalling the agent removes the OpenRC service, the log and the folders", async () => {
            const r = sh("bash /opt/remoteiq-agent/uninstall.sh 2>&1; rc-service remoteiq-agent status 2>&1; ls /etc/init.d/remoteiq-agent /opt/remoteiq-agent /etc/remoteiq /var/log/remoteiq-agent.log 2>&1");
            assert.match(r.stdout, /RemoteIQ agent removed/);
            assert.doesNotMatch(r.stdout, /started/);
            assert.ok((r.stdout.match(/No such file/g) || []).length >= 3, r.stdout);
            assert.equal(sh("pidof remoteiq-agent; echo done").stdout.trim(), "done", "the process is gone");
        });
    } finally {
        for (const [f, buf] of saved) fs.writeFileSync(path.join(PKG_DIR, "linux", f), buf);
        if (process.env.KEEP_CONTAINER !== "1") docker(["rm", "-f", NAME]);
        await q(`DELETE FROM devices WHERE site_id = $1`, [siteId]).catch(() => { });
        await cleanup();
        finish();
    }
}
main().catch((e) => { console.error(e); docker(["rm", "-f", NAME]); process.exit(1); });
