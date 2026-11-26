// Runs the Linux security scan script for real inside containers (Docker), parses what it prints with the same function the server uses,
// and scores it. Two parts:
//   1. Stock images of five distributions: the script must finish fast, print nothing the parser rejects, and every probe it can read
//      here must come back ok (a container has no firewall, SSH server or encrypted disk, so those say so honestly).
//   2. A Debian container with stand-in tools (ufw, sshd -T, lsblk, systemctl, ss, getent ...) that print what a real, well kept server
//      and a badly kept one would print, so the rules are checked end to end on real script output.
// Run after a build: node test/security-linux-scripts.cjs   (it exits 0 with a note when Docker is not running)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1e8, timeout: 300_000, ...opts });
if (docker(["info", "--format", "{{.ServerVersion}}"]).status !== 0) { console.log("skipped: Docker is not running"); process.exit(0); }

const dist = path.join(__dirname, "..", process.env.DIST || "dist", "security");
const S = require(path.join(dist, "security-linux.scripts.js"));
const B = require(path.join(dist, "security-linux.baseline.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adg-lxsec-"));
const scriptFile = path.join(dir, "scan.sh");
fs.writeFileSync(scriptFile, S.LINUX_SECURITY_SCAN_SCRIPT, { mode: 0o755 });
const mount = (p) => p.replace(/\\/g, "/");

function runIn(image, prelude = "") {
    const t0 = Date.now();
    const r = docker(["run", "--rm", "-e", "MSYS_NO_PATHCONV=1", "-v", `${mount(dir)}:/w:ro`, image, "bash", "-c", `${prelude}\nbash /w/scan.sh`]);
    return { ms: Date.now() - t0, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

console.log("stock distributions");
for (const image of ["debian:12", "ubuntu:22.04", "fedora:40", "rockylinux:9", "opensuse/leap:15.6"]) {
    check(`${image}: the script runs, its output is accepted and the OS is recognised`, () => {
        const r = runIn(image);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.trim().endsWith("E " + r.stdout.trim().split("E ").pop()), "ends with the E line");
        const scan = S.parseLinuxScan(r.stdout, r.stderr);
        assert.equal(scan.probes.os.status, "ok");
        assert.equal(scan.probes.firewall.status, "ok");
        assert.equal(scan.probes.firewall.active, false, "no firewall in a bare container");
        assert.equal(scan.probes.ssh.status, "ok");
        assert.equal(scan.probes.ssh.installed, false);
        assert.equal(scan.probes.accounts.status, "ok");
        assert.equal(scan.probes.disk.status, "ok");
        assert.equal(scan.probes.boot.status, "ok");
        const ev = B.evaluateLinuxScan(scan);
        assert.ok(ev.score !== null, "scored");
        assert.ok(ev.rules.every((x) => ["pass", "fail", "unknown", "not_applicable"].includes(x.result)));
    });
}
check("the script finishes well inside the 90 second job limit on a stock image", () => {
    const r = runIn("debian:12");
    assert.ok(r.ms < 60_000, `${r.ms} ms`);
});

console.log("stand-in tools");
function fakes(files) {
    const out = path.join(dir, "fake");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(out, name), body, { mode: 0o755 });
    return out;
}
const sh = (body) => `#!/bin/sh\n${body}\n`;
function runFaked(files, extraPrelude = "") {
    const f = fakes(files);
    const r = docker(["run", "--rm", "-e", "MSYS_NO_PATHCONV=1", "-v", `${mount(dir)}:/w:ro`, "-v", `${mount(f)}:/fake:ro`, "debian:12", "bash", "-c",
        `cp /fake/* /usr/local/bin/ && chmod +x /usr/local/bin/*\n${extraPrelude}\nbash /w/scan.sh`]);
    assert.equal(r.status, 0, r.stderr);
    return S.parseLinuxScan(r.stdout, r.stderr);
}

const GOOD = {
    ufw: sh('echo "Status: active"'),
    // "sshd -T" prints lower-case keys; a hostkey-less container would print nothing, so the stand-in prints what a real one does.
    sshd: sh('[ "$1" = "-T" ] && printf "port 22\\npermitrootlogin prohibit-password\\npasswordauthentication no\\npermitemptypasswords no\\nx11forwarding no\\n"'),
    systemctl: sh('case "$1:$2" in is-active:ssh|is-active:clamav-daemon) echo active; exit 0;; is-enabled:unattended-upgrades) echo enabled; exit 0;; esac; echo inactive; exit 3'),
    findmnt: sh('echo /dev/mapper/vg-root'),
    lsblk: sh('printf "part crypto_LUKS\\ncrypt LVM2_member\\nlvm ext4\\n"'),
    timedatectl: sh('echo yes'),
    getenforce: sh('echo Enforcing'),
    ss: sh('printf "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\\nLISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\\n"'),
    getent: sh('[ "$2" = sudo ] && echo "sudo:x:27:alice,bob"; exit 0'),
};
check("a well kept server: firewall, key-only SSH, LUKS under LVM, SELinux, clock, ClamAV, automatic updates", () => {
    const scan = S.parseLinuxScan(runFakedOutput(GOOD, "mkdir -p /etc/apt/apt.conf.d && echo 'APT::Periodic::Unattended-Upgrade \"1\";' > /etc/apt/apt.conf.d/20auto-upgrades"), "");
    const by = Object.fromEntries(B.evaluateLinuxScan(scan, new Date("2026-11-16T12:00:00Z")).rules.map((r) => [r.id, r.result + ": " + r.detail]));
    assert.match(by["lx.fw.active"], /^pass/);
    assert.match(by["lx.ssh.rootlogin"], /^pass/);
    assert.match(by["lx.ssh.password"], /^pass/);
    assert.match(by["lx.enc.root"], /^pass/);
    assert.match(by["lx.mac.enabled"], /^pass/);
    assert.match(by["lx.time.sync"], /^pass/);
    assert.match(by["lx.av.present"], /^pass/);
    assert.match(by["lx.updates.auto"], /^pass/);
    assert.match(by["lx.net.exposed"], /^pass/);
    assert.match(by["lx.acct.admins"], /^pass: 2 accounts can use sudo: alice, bob/);
});
function runFakedOutput(files, extraPrelude = "") {
    const f = fakes(files);
    const r = docker(["run", "--rm", "-e", "MSYS_NO_PATHCONV=1", "-v", `${mount(dir)}:/w:ro`, "-v", `${mount(f)}:/fake:ro`, "debian:12", "bash", "-c",
        `cp /fake/* /usr/local/bin/ && chmod +x /usr/local/bin/*\n${extraPrelude}\nbash /w/scan.sh`]);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}

const BAD = {
    ufw: sh('echo "Status: inactive"'),
    sshd: sh('[ "$1" = "-T" ] && printf "port 22\\npermitrootlogin yes\\npasswordauthentication yes\\npermitemptypasswords yes\\n"'),
    systemctl: sh("echo inactive; exit 3"),
    findmnt: sh("echo /dev/sda2"),
    lsblk: sh('printf "part ext4\\n"'),
    timedatectl: sh("echo no"),
    ss: sh('printf "LISTEN 0 128 0.0.0.0:23 0.0.0.0:*\\nLISTEN 0 128 [::]:21 [::]:*\\nLISTEN 0 128 127.0.0.1:5900 0.0.0.0:*\\n"'),
    getent: sh('[ "$2" = sudo ] && echo "sudo:x:27:a,b,c,d,e"; exit 0'),
};
check("a badly kept server: no firewall, root and passwords over SSH, plain disk, telnet and ftp, no clock sync, five sudo users", () => {
    const prelude = "echo 'guest::19000:0:99999:7:::' >> /etc/shadow; echo 'toor:x:0:0::/root:/bin/bash' >> /etc/passwd";
    const scan = S.parseLinuxScan(runFakedOutput(BAD, prelude), "");
    const ev = B.evaluateLinuxScan(scan, new Date("2026-11-16T12:00:00Z"));
    const by = Object.fromEntries(ev.rules.map((r) => [r.id, r.result + ": " + r.detail]));
    assert.match(by["lx.fw.active"], /^fail/);
    assert.match(by["lx.ssh.rootlogin"], /^fail/);
    assert.match(by["lx.ssh.password"], /^fail/);
    assert.match(by["lx.ssh.emptypw"], /^fail/);
    assert.match(by["lx.enc.root"], /^fail/);
    assert.match(by["lx.time.sync"], /^fail/);
    assert.match(by["lx.acct.emptypw"], /^fail.*guest/);
    assert.match(by["lx.acct.uid0"], /^fail.*toor/);
    assert.match(by["lx.net.exposed"], /^fail.*telnet, ftp/, by["lx.net.exposed"]);
    assert.doesNotMatch(by["lx.net.exposed"], /vnc/, "VNC on localhost only is not exposed");
    assert.match(by["lx.acct.admins"], /^fail/);
    assert.equal(ev.grade, "F");
    assert.ok(ev.score <= 59);
});
check("password hashes never appear in the output", () => {
    const out = runFakedOutput(GOOD, "echo 'alice:$6$salt$HASHHASHHASH:19000:0:99999:7:::' >> /etc/shadow");
    assert.ok(!out.includes("HASHHASHHASH") && !out.includes("$6$"));
});
check("a tool that hangs costs one probe, not the scan (the script uses timeout)", () => {
    const t0 = Date.now();
    const out = runFakedOutput({ ...GOOD, ufw: sh("sleep 120") });
    assert.ok(Date.now() - t0 < 60_000, `${Date.now() - t0} ms`);
    const scan = S.parseLinuxScan(out, "");
    assert.equal(scan.probes.os.status, "ok");
    assert.equal(scan.probes.disk.status, "ok");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
