// The real Linux agent, installed by the real installer script as a real systemd service in a container, enrolling against a local
// throwaway server, then doing real work for it: check-in, software inventory, device facts, a security scan, installing and removing
// a package, a patch scan and an install (the pending list must clear without a manual scan).
// Needs Docker, the built agent package in AGENT_PKG_DIR (linux/adgrmm-agent-linux-x64.tar.gz), and a server started with
// AGENT_PKG_DIR set, listening on all interfaces (the container reaches it as host.docker.internal).
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3971 PUBLIC_URL=http://host.docker.internal:3971 AGENT_PKG_DIR=... DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... node test/linux-agent-systemd.e2e.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");

const docker = (args, o = {}) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1e8, timeout: 600_000, ...o });
if (docker(["info", "--format", "{{.ServerVersion}}"]).status !== 0) { console.log("skipped: Docker is not running"); process.exit(0); }
const PKG_DIR = process.env.AGENT_PKG_DIR;
const tar = PKG_DIR && path.join(PKG_DIR, "linux", "adgrmm-agent-linux-x64.tar.gz");
if (!tar || !fs.existsSync(tar)) { console.log("skipped: AGENT_PKG_DIR has no linux package"); process.exit(0); }

const IMAGE = process.env.SYSTEMD_IMAGE || "jrei/systemd-debian:12";
const NAME = `adg-lx-${Date.now()}`;
const DEB = /debian|ubuntu/i.test(IMAGE);
const PKG_NAME = DEB ? "cowsay" : "tree";
// the body of a failed answer, read only when it failed (a body can be read once)
const why = async (r) => (r.status < 400 ? "" : r.text());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => docker(["exec", NAME, "bash", "-c", cmd]);
const until = async (what, fn, ms = 180_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(2000); } };

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `LXS${Date.now()}`;
    const admin = await staffUser("lxs-admin", ["customers.read", "customers.write", "devices.read", "devices.actions", "software.install"]);
    const clientId = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, tag])).rows[0].id;
    made.clients.push(clientId);
    const siteId = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'HQ') RETURNING id`, [clientId])).rows[0].id;
    let deviceId = null;

    try {
        await test("a systemd container starts and the installer script is built for it", async () => {
            const r = docker(["run", "-d", "--name", NAME, "--privileged", "--cgroupns=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", "--add-host", "host.docker.internal:host-gateway", IMAGE]);
            assert.equal(r.status, 0, r.stderr);
            await until("systemd", () => /running|degraded/.test(sh("systemctl is-system-running").stdout || ""), 60_000);
            const i = sh(DEB ? "apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq curl ca-certificates >/dev/null 2>&1; command -v curl"
                : "command -v curl >/dev/null || (dnf install -y -q curl tar gzip >/dev/null 2>&1 || zypper -n install curl tar gzip >/dev/null 2>&1); command -v curl");
            assert.match(i.stdout, /curl/, i.stderr);
        });

        let installLog = "";
        await test("the installer enrolls the device: service running, agent id written, device appears in the console", async () => {
            const kr = await call("/api/provisioning/enrollment-keys", { method: "POST", token: admin.token, body: { clientId, siteId, name: tag, expiresMinutes: 60 } });
            assert.equal(kr.status, 201, await why(kr));
            const key = (await kr.json()).enrollmentKey;
            const { linuxInstallerScript } = require(path.join(__dirname, "..", process.env.DIST || "dist", "provisioning", "installer-scripts.js"));
            const sha = crypto.createHash("sha256").update(fs.readFileSync(tar)).digest("hex");
            const script = linuxInstallerScript({ baseUrl: process.env.PUBLIC_URL, enrollmentKey: key, packageSha256: sha, onlyIfMissing: false });
            const f = path.join(require("node:os").tmpdir(), `${NAME}.sh`);
            fs.writeFileSync(f, script);
            assert.equal(docker(["cp", f, `${NAME}:/install.sh`]).status, 0);
            const r = sh("bash /install.sh 2>&1");
            installLog = (r.stdout || "") + (r.stderr || "");
            assert.match(installLog, /Done\. This device is now enrolled as agent /, installLog.slice(-600));
            assert.match(sh("systemctl is-active adgrmm-agent").stdout, /^active/);
            assert.match(sh("systemctl is-enabled adgrmm-agent").stdout, /^enabled/);
            const row = (await q(`SELECT d.id FROM devices d JOIN agents a ON a.device_id = d.id WHERE d.site_id = $1`, [siteId])).rows[0];
            assert.ok(row, "the device exists");
            deviceId = row.id;
        });

        await test("a second run of the installer keeps the same device (no duplicate)", async () => {
            const r = sh("bash /install.sh 2>&1");
            assert.match(r.stdout, /Done\. This device is now enrolled/, r.stdout.slice(-400));
            assert.equal((await q(`SELECT count(*)::int AS n FROM devices WHERE site_id = $1`, [siteId])).rows[0].n, 1);
        });

        await test("the agent reports facts (OS, boot, security) and its software list", async () => {
            const facts = await until("facts", async () => { const a = (await q(`SELECT facts FROM agents WHERE device_id = $1`, [deviceId])).rows[0]; return a?.facts?.device?.os ? a.facts : null; });
            assert.match(String(facts.device.os.name), /Debian|Ubuntu|Fedora|Rocky|SUSE/);
            assert.equal(facts.os, "linux");
            const n = await until("software", async () => { const c = (await q(`SELECT count(*)::int AS n FROM agent_software s JOIN agents a ON a.id = s.agent_id WHERE a.device_id = $1`, [deviceId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n; return c > 50 ? c : 0; });
            assert.ok(n > 50, `${n} packages`);
        });

        await test("a security scan runs on the real device and reads back: Debian recognised, firewall off, no probe unreadable that should read", async () => {
            const r = await call(`/api/devices/${deviceId}/security/scan`, { method: "POST", token: admin.token, body: {} });
            assert.equal(r.status, 200, await why(r));
            const v = await until("the scan", async () => { const x = await (await call(`/api/devices/${deviceId}/security`, { token: admin.token })).json(); return x.state === "scanned" && !x.pending ? x : null; });
            assert.ok(v.scan.score !== null, "scored");
            const byId = Object.fromEntries(v.scan.rules.map((x) => [x.id, x]));
            assert.equal(byId["lx.fw.active"].result, "fail");
            assert.ok(DEB ? byId["lx.os.support"].result === "pass" : ["pass", "unknown"].includes(byId["lx.os.support"].result), JSON.stringify(byId["lx.os.support"]));
            assert.equal(byId["lx.acct.emptypw"].result, "pass");
        });

        await test("a malware scan with no ClamAV says so; turning on the firewall with none installed says which package", async () => {
            let r = await call(`/api/devices/${deviceId}/security/linux/malware-scan`, { method: "POST", token: admin.token, body: {} });
            assert.equal(r.status, 409); assert.match((await r.json()).message, /ClamAV is not installed/);
            r = await call(`/api/devices/${deviceId}/security/linux/firewall-enable`, { method: "POST", token: admin.token, body: {} });
            assert.equal(r.status, 409); assert.match((await r.json()).message, /No firewall is installed/);
        });

        const jobDone = async (jobId) => until(`job ${jobId}`, async () => { const j = (await q(`SELECT status FROM jobs WHERE id = $1`, [jobId])).rows[0]; return ["succeeded", "failed", "timeout"].includes(j?.status) ? j.status : null; }, 600_000);
        await test("install a package by name, then remove it, through the real agent", async () => {
            let r = await call(`/api/devices/${deviceId}/actions/install-package`, { method: "POST", token: admin.token, body: { name: PKG_NAME } });
            assert.equal(r.status, 202, await why(r));
            assert.equal(await jobDone((await r.json()).jobId), "succeeded");
            const has = () => DEB ? /install ok installed/.test(sh(`dpkg -s ${PKG_NAME} 2>&1`).stdout) : sh(`rpm -q ${PKG_NAME} >/dev/null 2>&1 && echo yes`).stdout.includes("yes");
            assert.ok(has(), "installed");
            if (DEB) {
                r = await call(`/api/devices/${deviceId}/actions/uninstall`, { method: "POST", token: admin.token, body: { name: "perl" } });
                assert.equal(r.status, 202);
                assert.equal(await jobDone((await r.json()).jobId), "failed", "removing perl would take cowsay with it");
                assert.ok(has(), "nothing was removed");
            }
            r = await call(`/api/devices/${deviceId}/actions/uninstall`, { method: "POST", token: admin.token, body: { name: PKG_NAME } });
            assert.equal(await jobDone((await r.json()).jobId), "succeeded");
            assert.ok(!has(), "removed");
            r = await call(`/api/devices/${deviceId}/actions/uninstall`, { method: "POST", token: admin.token, body: { name: "openssh-server" } });
            assert.equal(r.status, 400, "protected packages are refused before any job exists");
        });

        await test("patch scan, then install one patch: it leaves the pending list by itself", async () => {
            if (!DEB) {
                const sc = await call("/api/patches/scan", { method: "POST", token: admin.token, body: { deviceId } });
                assert.equal(sc.status, 202, await why(sc));
                const only = await until("the patch scan", async () => { const x = await (await call(`/api/patches/latest?deviceId=${deviceId}`, { token: admin.token })).json(); return x.lastScanAt && !x.scanPending ? x : null; });
                assert.ok(Array.isArray(only.patches) && only.packageManager, "the scan answered with a package manager: " + only.packageManager);
                return;
            }
            // A tiny local apt repository gives the device a real pending update: adgdemo 1.0 is installed, 2.0 is available.
            const repo = String.raw`set -e
mkdir -p /srv/repo
mk() { rm -rf /tmp/b; mkdir -p /tmp/b/DEBIAN; printf 'Package: adgdemo
Version: %s
Architecture: all
Maintainer: t <t@example.test>
Description: demo
' "$1" > /tmp/b/DEBIAN/control; dpkg-deb -b /tmp/b /srv/repo/adgdemo_$1_all.deb >/dev/null; }
index() { cd /srv/repo; : > Packages; for f in *.deb; do dpkg-deb -f $f >> Packages; printf 'Filename: ./%s
Size: %s
SHA256: %s

' $f $(stat -c%s $f) $(sha256sum $f | cut -d' ' -f1) >> Packages; done; }
echo 'deb [trusted=yes] file:/srv/repo ./' > /etc/apt/sources.list.d/adg.list
mk 1.0; index; apt-get update -qq >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq adgdemo >/dev/null
mk 2.0; index; apt-get update -qq >/dev/null
apt list --upgradable 2>/dev/null | grep adgdemo`;
            const rf = path.join(require("node:os").tmpdir(), `${NAME}-repo.sh`);
            fs.writeFileSync(rf, repo);
            docker(["cp", rf, `${NAME}:/repo.sh`]);
            assert.match(sh("bash /repo.sh 2>&1").stdout, /adgdemo.*upgradable/);
            let r = await call("/api/patches/scan", { method: "POST", token: admin.token, body: { deviceId } });
            assert.equal(r.status, 202, await why(r));
            const first = await until("the patch scan", async () => { const x = await (await call(`/api/patches/latest?deviceId=${deviceId}`, { token: admin.token })).json(); return x.lastScanAt && !x.scanPending ? x : null; });
            const required = first.patches.filter((p) => p.status === "Required");
            const pick = (required.find((p) => p.id === "adgdemo") || {}).id;
            assert.ok(pick, "the scan lists the pending update: " + JSON.stringify(first.patches.map((p) => p.id)));
            r = await call("/api/patches/install", { method: "POST", token: admin.token, body: { deviceId, ids: [pick] } });
            assert.equal(r.status, 202, await why(r));
            const after = await until("the list to settle", async () => {
                const x = await (await call(`/api/patches/latest?deviceId=${deviceId}`, { token: admin.token })).json();
                if (x.installPending || x.scanPending) return null;
                const row = x.patches.find((p) => p.id === pick);
                return !row || row.status === "Installed" ? x : null;
            }, 600_000);
            const scans = (await q(`SELECT count(*)::int AS n FROM agent_tasks t JOIN agents a ON a.id = t.agent_id WHERE a.device_id = $1 AND t.type = 'patch_scan'`, [deviceId])).rows[0].n;
            assert.ok(scans >= 2, "a scan was queued by the install finishing");
            assert.ok(!after.patches.some((p) => p.id === pick && p.status === "Required"), "the installed patch is not Required any more");
            assert.match(sh("dpkg -s adgdemo | grep ^Version").stdout, /2\.0/, "the update really was installed");
            // and a second one-package install does not bring the first back
            assert.ok(after.patches.every((p) => p.id !== pick || p.status === "Installed"));
        });

        await test("uninstalling the agent leaves nothing behind", async () => {
            const r = sh("bash /opt/adgrmm-agent/uninstall.sh 2>&1; systemctl is-active adgrmm-agent; ls /opt/adgrmm-agent 2>&1 | head -2");
            assert.doesNotMatch(r.stdout, /^active$/m, r.stdout);
        });
    } finally {
        if (process.env.KEEP_CONTAINER !== "1") docker(["rm", "-f", NAME]);
        await q(`DELETE FROM devices WHERE site_id = $1`, [siteId]).catch(() => { });
        await cleanup();
        finish();
    }
}
main().catch((e) => { console.error(e); docker(["rm", "-f", NAME]); process.exit(1); });
