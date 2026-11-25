// Runs the Linux package script and the two Linux security action scripts for real inside containers (Docker):
//   - installing and removing a package on Debian, Fedora, Rocky and SUSE (real package managers, real downloads), a removal that
//     would take another package with it is refused with nothing removed, and the name checks of the server;
//   - the firewall script with a stand-in ufw: SSH ports (from sshd -T, or 22) are allowed BEFORE the firewall is enabled, and with
//     no firewall installed it says which package to install;
//   - the malware script with a stand-in clamscan: clean, infected (what is reported, nothing removed) and a scanner error.
// Run after a build: node test/linux-actions-scripts.cjs   (it exits 0 with a note when Docker is not running)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1e8, timeout: 600_000, ...opts });
if (docker(["info", "--format", "{{.ServerVersion}}"]).status !== 0) { console.log("skipped: Docker is not running"); process.exit(0); }

const base = path.join(__dirname, "..", process.env.DIST || "dist");
const P = require(path.join(base, "device-tools", "linux-software.scripts.js"));
const A = require(path.join(base, "security", "security-linux.actions.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riq-lxact-"));
fs.writeFileSync(path.join(dir, "pkg.sh"), P.LINUX_PACKAGE_SCRIPT, { mode: 0o755 });
fs.writeFileSync(path.join(dir, "fw.sh"), A.LINUX_FIREWALL_ENABLE_SCRIPT, { mode: 0o755 });
fs.writeFileSync(path.join(dir, "mw.sh"), A.LINUX_MALWARE_SCAN_SCRIPT, { mode: 0o755 });
const mount = (p) => p.replace(/\\/g, "/");
const inBox = (image, body, env = {}) => {
    const args = ["run", "--rm", "-e", "MSYS_NO_PATHCONV=1", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "-v", `${mount(dir)}:/w:ro`, image, "bash", "-c", body];
    const r = docker(args);
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
};
const pkgRun = (image, action, pkg, before = "") => inBox(image, `${before}\nbash /w/pkg.sh; echo "EXIT=$?"`, { RIQ_PKG: pkg, RIQ_PKG_ACTION: action });
const exitOf = (r) => Number((/EXIT=(\d+)/.exec(r.stdout) || [])[1]);

console.log("name checks (server side)");
check("a good name passes, bad names and shell tricks are refused", () => {
    assert.equal(P.checkPackageName(" tree ", "install"), "tree");
    assert.equal(P.checkPackageName("libssl3:amd64", "install"), "libssl3:amd64");
    for (const bad of ["", "  ", "a b", "x;rm -rf /", "$(id)", "a`id`", "-rf", "../x", "x\ny", "a".repeat(101), 5, null, undefined, {}])
        assert.throws(() => P.checkPackageName(bad, "install"), /package|Say which/i, String(bad));
});
check("protected packages are never removed, but may be asked about by name only for install", () => {
    for (const p of ["openssh-server", "systemd", "sudo", "bash", "libc6", "apt", "dpkg", "rpm", "dnf", "linux-image-6.8.0-generic", "kernel-core", "grub-pc", "ufw", "firewalld", "remoteiq-agent", "remoteiq", "network-manager", "libssl3:amd64"])
        assert.throws(() => P.checkPackageName(p, "remove"), /not removed from here/, p);
    assert.equal(P.checkPackageName("tree", "remove"), "tree");
    assert.equal(P.checkPackageName("nginx", "remove"), "nginx");
    assert.throws(() => P.checkPackageName("remoteiq-agent", "install"), /installer/);
});
check("the scripts are plain: no template markers, no backticks, no secrets", () => {
    for (const s of [P.LINUX_PACKAGE_SCRIPT, A.LINUX_FIREWALL_ENABLE_SCRIPT, A.LINUX_MALWARE_SCAN_SCRIPT]) {
        assert.ok(!s.includes("{{") && !s.includes("`") && !s.includes("${"));
        assert.ok(!/\brm\s+-rf?\b/.test(s) && !/--remove|--delete|--move|freshclam/.test(s), "never deletes or moves files");
    }
    assert.ok(!/purge|autoremove/.test(P.LINUX_PACKAGE_SCRIPT), "only the package itself is removed");
});

console.log("package script, real package managers");
check("debian: refuses a name that is not a name, and an unknown action", () => {
    const r = pkgRun("debian:12", "install", "a b");
    assert.equal(exitOf(r), 64, r.stdout + r.stderr);
    assert.equal(exitOf(pkgRun("debian:12", "wipe", "tree")), 64);
});
check("debian: install, install again (already there), a removal that would take another package is refused, remove", () => {
    const r = inBox("debian:12", `
export RIQ_PKG_ACTION=install RIQ_PKG=cowsay
bash /w/pkg.sh >/tmp/a.out 2>&1; echo "INSTALL=$?"; tail -1 /tmp/a.out
bash /w/pkg.sh >/tmp/b.out 2>&1; echo "AGAIN=$?"; tail -1 /tmp/b.out
RIQ_PKG_ACTION=remove RIQ_PKG=perl bash /w/pkg.sh >/tmp/c.out 2>&1; echo "DEP=$?"; tail -1 /tmp/c.out
dpkg -s cowsay | grep -c 'install ok installed'
RIQ_PKG_ACTION=remove RIQ_PKG=cowsay bash /w/pkg.sh >/tmp/d.out 2>&1; echo "REMOVE=$?"; tail -1 /tmp/d.out
dpkg -s cowsay 2>&1 | grep -c 'install ok installed'
RIQ_PKG_ACTION=remove RIQ_PKG=cowsay bash /w/pkg.sh >/tmp/e.out 2>&1; echo "GONE=$?"; tail -1 /tmp/e.out`);
    assert.match(r.stdout, /INSTALL=0\nOK Installed cowsay\./, r.stdout + r.stderr);
    assert.match(r.stdout, /AGAIN=0\nOK cowsay is already installed\./);
    assert.match(r.stdout, /DEP=3\nRemoving perl would also remove: .*cowsay/);
    assert.match(r.stdout, /\n1\nREMOVE=0\nOK Removed cowsay\.\n0\nGONE=2\ncowsay is not installed\./, "cowsay stayed after the refused removal, then went");
});
for (const [image, pkg] of [["fedora:40", "tree"], ["rockylinux:9", "tree"], ["opensuse/leap:15.6", "tree"]]) {
    check(`${image}: install ${pkg}, remove it, and a removal that would break other packages is refused`, () => {
        const r = inBox(image, `
RIQ_PKG_ACTION=install RIQ_PKG=${pkg} bash /w/pkg.sh >/tmp/a.out 2>&1; echo "INSTALL=$?"; tail -1 /tmp/a.out
RIQ_PKG_ACTION=remove RIQ_PKG=bash bash /w/pkg.sh >/tmp/c.out 2>&1; echo "DEP=$?"; tail -1 /tmp/c.out | cut -c1-60
RIQ_PKG_ACTION=remove RIQ_PKG=${pkg} bash /w/pkg.sh >/tmp/d.out 2>&1; echo "REMOVE=$?"; tail -1 /tmp/d.out
rpm -q ${pkg} >/dev/null 2>&1 && echo STILL || echo GONE`);
        assert.match(r.stdout, new RegExp(`INSTALL=0\\nOK Installed ${pkg}\\.`), r.stdout + r.stderr);
        assert.match(r.stdout, /DEP=3\nRemoving bash would break/, r.stdout);
        assert.match(r.stdout, new RegExp(`REMOVE=0\\nOK Removed ${pkg}\\.\\nGONE`), r.stdout);
    });
}

console.log("firewall script");
check("with no firewall installed it says which package to install and changes nothing", () => {
    const r = inBox("debian:12", `bash /w/fw.sh; echo "EXIT=$?"`);
    assert.equal(exitOf(r), 69, r.stdout + r.stderr);
    assert.match(r.stderr, /No firewall is installed.*ufw.*firewalld/);
    assert.throws(() => A.parseLinuxAction("firewall-enable", r.stdout.replace(/EXIT=\d+/, ""), r.stderr), /No firewall is installed/);
});
const fakeUfw = `
mkdir -p /fake /var/lib/fake; : > /var/lib/fake/calls
cat > /usr/sbin/ufw <<'EOS'
#!/bin/bash
echo "$*" >> /var/lib/fake/calls
case "$1" in
  status) if [ -f /var/lib/fake/on ]; then echo "Status: active"; else echo "Status: inactive"; fi;;
  allow) echo "Rule added";;
  --force) [ "$2" = "enable" ] && touch /var/lib/fake/on;;
esac
exit 0
EOS
chmod +x /usr/sbin/ufw`;
check("ufw: SSH is allowed first (port 22 by default), then the firewall is enabled", () => {
    const r = inBox("debian:12", `${fakeUfw}\nbash /w/fw.sh; echo "EXIT=$?"; cat /var/lib/fake/calls`);
    assert.equal(exitOf(r), 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK The firewall \(ufw\) is on\. Incoming SSH \(port 22/);
    const calls = r.stdout.split("EXIT=0\n")[1].trim().split("\n");
    const allow = calls.findIndex((c) => c === "allow 22/tcp"), enable = calls.findIndex((c) => c === "--force enable");
    assert.ok(allow >= 0 && enable > allow, "allow before enable: " + calls.join(" | "));
    const parsed = A.parseLinuxAction("firewall-enable", r.stdout, r.stderr);
    assert.match(parsed.message, /ufw/);
});
check("ufw: the SSH port the server really uses is allowed (sshd -T says 2222)", () => {
    const r = inBox("debian:12", `${fakeUfw}
cat > /usr/sbin/sshd <<'EOS'
#!/bin/bash
printf 'port 2222\\nport 22022\\npermitrootlogin no\\n'
EOS
chmod +x /usr/sbin/sshd
bash /w/fw.sh; echo "EXIT=$?"; cat /var/lib/fake/calls`);
    assert.equal(exitOf(r), 0, r.stdout + r.stderr);
    assert.match(r.stdout, /allow 2222\/tcp/); assert.match(r.stdout, /allow 22022\/tcp/);
    assert.ok(!/allow 22\/tcp/.test(r.stdout), "22 is not opened when SSH listens elsewhere");
});
check("ufw already active: nothing is changed", () => {
    const r = inBox("debian:12", `${fakeUfw}\ntouch /var/lib/fake/on\nbash /w/fw.sh; echo "EXIT=$?"; cat /var/lib/fake/calls`);
    assert.match(r.stdout, /OK The firewall \(ufw\) was already on\./);
    assert.ok(!/allow|enable/.test(r.stdout.split("EXIT=0\n")[1] || ""), "no rule added");
});
check("if SSH cannot be allowed, the firewall is NOT turned on", () => {
    const r = inBox("debian:12", `${fakeUfw}\nsed -i 's/^  allow) echo "Rule added";;/  allow) exit 1;;/' /usr/sbin/ufw\nbash /w/fw.sh; echo "EXIT=$?"; [ -f /var/lib/fake/on ] && echo ON || echo OFF`);
    assert.equal(exitOf(r), 1, r.stdout + r.stderr);
    assert.match(r.stderr, /NOT turned on/); assert.match(r.stdout, /OFF/);
});

console.log("malware scan script");
check("no ClamAV: says so and nothing runs", () => {
    const r = inBox("debian:12", `bash /w/mw.sh; echo "EXIT=$?"`);
    assert.equal(exitOf(r), 69); assert.match(r.stderr, /ClamAV is not installed.*clamav/);
});
const fakeClam = (body) => `cat > /usr/bin/clamscan <<'EOS'\n#!/bin/bash\n${body}\nEOS\nchmod +x /usr/bin/clamscan; mkdir -p /home/x`;
check("clean: files scanned and time are reported", () => {
    const r = inBox("debian:12", `${fakeClam(`printf '\\n----------- SCAN SUMMARY -----------\\nScanned files: 4321\\nInfected files: 0\\n'; exit 0`)}\nbash /w/mw.sh`);
    const p = A.parseLinuxAction("malware-scan", r.stdout, r.stderr);
    assert.equal(p.state, "clean"); assert.equal(p.scannedFiles, 4321); assert.equal(p.infectedCount, 0); assert.deepEqual(p.found, []);
});
check("infected: signature and path are reported, and the files are left where they are", () => {
    const r = inBox("debian:12", `${fakeClam(`echo '/tmp/eicar.com: Eicar-Test-Signature FOUND'; echo '/home/x/a: b: Win.Test.EICAR_HDB-1 FOUND'; printf '\\nScanned files: 99\\nInfected files: 2\\n'; exit 1`)}\necho bad > /tmp/eicar.com\nbash /w/mw.sh; [ -f /tmp/eicar.com ] && echo STILLTHERE`);
    const p = A.parseLinuxAction("malware-scan", r.stdout.replace("STILLTHERE", ""), r.stderr);
    assert.equal(p.state, "infected"); assert.equal(p.infectedCount, 2);
    assert.equal(p.found[0].signature, "Eicar-Test-Signature"); assert.equal(p.found[0].path, "/tmp/eicar.com");
    assert.equal(p.found[1].signature, "Win.Test.EICAR_HDB-1");
    assert.match(r.stdout, /STILLTHERE/);
});
check("a scanner error (exit 2) is an error result with the scanner's own words, not a pass", () => {
    const r = inBox("debian:12", `${fakeClam(`echo 'LibClamAV Error: No supported database files found in /var/lib/clamav' >&2; exit 2`)}\nbash /w/mw.sh`);
    const p = A.parseLinuxAction("malware-scan", r.stdout, r.stderr);
    assert.equal(p.state, "error"); assert.match(p.message, /No supported database/);
});
check("hostile device output is cut down: odd lines ignored, texts clipped, at most 20 findings", () => {
    const lines = ["R infected 5 3 99", ...Array.from({ length: 40 }, (_, i) => `F Sig${i}|/p/${"x".repeat(400)}`), "garbage", "F |nothing"];
    const p = A.parseLinuxAction("malware-scan", lines.join("\n"), "");
    assert.equal(p.found.length, 20); assert.ok(p.found.every((f) => f.path.length <= 200)); assert.equal(p.infectedCount, 99);
    assert.throws(() => A.parseLinuxAction("malware-scan", "nothing useful", ""), /not a malware scan/);
    assert.throws(() => A.parseLinuxAction("malware-scan", "R sick x y z", ""), /could not be read/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
