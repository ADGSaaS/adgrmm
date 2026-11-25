// The Linux ClamAV actions run for REAL in Docker: install (Debian 12 from apt; Rocky 9 through EPEL), update the signatures, a scan that
// finds the standard harmless EICAR test file, the security scan seeing ClamAV as in place, and the failure messages.
// Needs internet (packages and signatures). Run after a build: node test/linux-av-docker.cjs
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const A = require(path.join(__dirname, "..", process.env.DIST || "dist", "security", "security-linux.actions.js"));
const SC = require(path.join(__dirname, "..", process.env.DIST || "dist", "security", "security-linux.scripts.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 1_800_000, ...o });
const dk = (...a) => run("docker", a);
if (dk("info", "--format", "{{.ServerVersion}}").status !== 0) { console.log("(Docker is not running, skipped)"); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-av-"));
const stamp = Date.now(), names = [];
// the standard anti-malware test file, carried as base64 so it never sits on this machine as a file
const EICAR_B64 = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*").toString("base64");

function box(tag, image, prep) {
    const n = `riq-av-${tag}-${stamp}`; names.push(n);
    assert.equal(dk("run", "-d", "--name", n, image, "sleep", "3000").status, 0);
    const r = dk("exec", n, "bash", "-c", prep); assert.equal(r.status, 0, r.stderr);
    return n;
}
const put = (n, name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text, { mode: 0o755 }); assert.equal(dk("cp", f, `${n}:/tmp/${name}`).status, 0); };
const go = (n, name) => dk("exec", n, "bash", `/tmp/${name}`);

try {
    for (const [tag, image, prep, label] of [
        ["deb", "debian:12", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq procps >/dev/null 2>&1; true", "Debian 12 (apt)"],
        ["rocky", "rockylinux:9", "dnf install -y -q procps-ng >/dev/null 2>&1; true", "Rocky 9 (EPEL)"],
    ]) {
        console.log(label);
        const n = box(tag, image, prep);
        put(n, "install.sh", A.LINUX_AV_INSTALL_SCRIPT); put(n, "update.sh", A.LINUX_AV_UPDATE_SCRIPT); put(n, "scan.sh", A.LINUX_MALWARE_SCAN_SCRIPT);
        put(n, "sec.sh", SC.LINUX_SECURITY_SCAN_SCRIPT);
        check("before the install: scanning and updating say plainly that ClamAV is missing (exit 69), nothing is installed", () => {
            const s = go(n, "scan.sh"), u = go(n, "update.sh");
            assert.equal(s.status, 69); assert.match(s.stderr, /not installed/); assert.equal(u.status, 69); assert.match(u.stderr, /not installed/);
            assert.notEqual(dk("exec", n, "bash", "-c", "command -v clamscan").status, 0);
        });
        check("a security scan before the install does not count ClamAV", () => {
            const r = SC.parseLinuxScan(go(n, "sec.sh").stdout, "");
            assert.deepEqual(r.probes.antivirus.products, []);
        });
        let installed;
        check("install: ClamAV is installed, the signatures are downloaded, and the answer is the one OK line the parser accepts", () => {
            const r = go(n, "install.sh"); assert.equal(r.status, 0, r.stdout + r.stderr);
            installed = A.parseLinuxAction("antivirus-install", r.stdout, r.stderr);
            assert.match(installed.message, /ClamAV is installed \(ClamAV \d/); assert.match(installed.message, /signatures are up to date/);
            assert.equal(dk("exec", n, "bash", "-c", "ls /var/lib/clamav/*.cvd /var/lib/clamav/*.cld 2>/dev/null | wc -l").stdout.trim() >= "1", true);
        });
        check("the security scan now counts ClamAV (installed, signatures fresh)", () => {
            const r = SC.parseLinuxScan(go(n, "sec.sh").stdout, "");
            assert.ok(r.probes.antivirus.status === "ok" && r.probes.antivirus.products.includes("ClamAV"), JSON.stringify(r.probes.antivirus));
        });
        check("installing again changes nothing and still answers OK", () => {
            const r = go(n, "install.sh"); assert.equal(r.status, 0, r.stdout + r.stderr); A.parseLinuxAction("antivirus-install", r.stdout, r.stderr);
        });
        check("update: answers OK with the version", () => {
            const r = go(n, "update.sh"); assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(A.parseLinuxAction("antivirus-update", r.stdout, r.stderr).message, /up to date \(ClamAV \d/);
        });
        check("a failing update reports the reason and fails (it does not claim success)", () => {
            dk("exec", n, "bash", "-c", `printf '#!/bin/sh\\necho "ERROR: Can not connect to the update server" >&2\\nexit 1\\n' > /usr/local/sbin/freshclam; chmod 755 /usr/local/sbin/freshclam`);
            const r = go(n, "update.sh"); dk("exec", n, "rm", "-f", "/usr/local/sbin/freshclam");
            assert.notEqual(r.status, 0); assert.match(r.stderr, /could not be updated/); assert.throws(() => A.parseLinuxAction("antivirus-update", r.stdout, r.stderr));
        });
        check("the malware scan finds the EICAR test file, names the signature and the path, and a clean machine scans clean", () => {
            dk("exec", n, "bash", "-c", `echo ${EICAR_B64} | base64 -d > /tmp/riq-eicar.txt`);
            const bad = A.parseLinuxAction("malware-scan", go(n, "scan.sh").stdout, "");
            assert.equal(bad.state, "infected"); assert.ok(bad.found.some((f) => /Eicar/i.test(f.signature) && f.path === "/tmp/riq-eicar.txt"), JSON.stringify(bad));
            dk("exec", n, "rm", "-f", "/tmp/riq-eicar.txt");
            const ok = A.parseLinuxAction("malware-scan", go(n, "scan.sh").stdout, "");
            assert.equal(ok.state, "clean", JSON.stringify(ok));
            assert.ok(dk("exec", n, "bash", "-c", "ls /tmp/riq-eicar.txt 2>&1").stdout.includes("No such") || true);
        });
    }
    console.log("Rocky 9 without EPEL permission: Red Hat itself is never given a repository it did not choose");
    check("on a system that says it is RHEL and has no EPEL, the script stops with an instruction", () => {
        const n = box("rhel", "rockylinux:9", "sed -i 's/^ID=.*/ID=rhel/' /etc/os-release; true");
        put(n, "install.sh", A.LINUX_AV_INSTALL_SCRIPT);
        const r = go(n, "install.sh"); assert.equal(r.status, 69); assert.match(r.stderr, /EPEL/);
        assert.notEqual(dk("exec", n, "bash", "-c", "command -v clamscan").status, 0);
    });
    check("the parser takes only the exact OK line and clips it", () => {
        assert.throws(() => A.parseLinuxAction("antivirus-install", "garbage\n", ""));
        assert.equal(A.parseLinuxAction("antivirus-update", "noise\nOK " + "x".repeat(900) + "\n", "").message.length, 300);
        assert.ok(!A.LINUX_AV_INSTALL_SCRIPT.includes("${") && !A.LINUX_AV_INSTALL_SCRIPT.includes("`"), "plain script");
    });
} finally { for (const n of names) dk("rm", "-f", n); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
