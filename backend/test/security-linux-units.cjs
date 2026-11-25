// The security scan of Linux devices, with no database and no device: the parser and validator of what the script prints (realistic and
// hostile text), every baseline rule (pass, fail, unknown, not applicable), the operating system support table, the score and grade
// maths with the critical-failure caps, and the readable summaries. Run after a build:
//   node test/security-linux-units.cjs
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "security");
const S = require(path.join(dist, "security-linux.scripts.js"));
const B = require(path.join(dist, "security-linux.baseline.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const NOW = new Date("2026-11-16T12:00:00Z");

// A healthy Ubuntu 24.04 server, as the script prints it. `over` replaces whole lines by their "K <probe> <key>" prefix.
const HEALTHY = {
    "K os id": "ubuntu", "K os version": "24.04", "K os name": "Ubuntu 24.04.1 LTS", "K os kernel": "6.8.0-45-generic",
    "K firewall manager": "ufw", "K firewall active": "yes",
    "K encryption volumes": "/:on,",
    "K ssh installed": "yes", "K ssh running": "yes", "K ssh permitrootlogin": "prohibit-password", "K ssh passwordauthentication": "no", "K ssh permitemptypasswords": "no", "K ssh port": "22",
    "K accounts emptypassword": "", "K accounts extraroot": "", "K accounts admins": "alice,bob,",
    "K updates agedays": "3", "K autoupdates enabled": "yes", "K autoupdates by": "unattended-upgrades",
    "K reboot pending": "no", "K mac kind": "apparmor", "K mac mode": "enabled",
    "K time synchronized": "yes", "K exposure risky": "", "K disk rootusedpercent": "41",
    "K antivirus products": "ClamAV,", "K boot uefi": "yes", "K boot secureboot": "yes", "K boot tpm": "yes",
};
const text = (over = {}, drop = []) => {
    const m = { ...HEALTHY, ...over };
    for (const d of drop) delete m[d];
    const lines = Object.entries(m).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`.trimEnd());
    return lines.join("\n") + "\nE 2\n";
};
const scan = (over, drop, stderr = "") => S.parseLinuxScan(text(over, drop), stderr);
const run = (id, over, drop) => {
    const ev = B.evaluateLinuxScan(scan(over, drop), NOW);
    const r = ev.rules.find((x) => x.id === id);
    assert.ok(r, `rule ${id} exists`);
    return r;
};
const result = (id, over, drop) => run(id, over, drop).result;

/* ------------------------------ the script ------------------------------ */
console.log("script");
check("it has no dollar-brace or backtick (it lives in a template literal) and starts with a shebang", () => {
    assert.ok(S.LINUX_SECURITY_SCAN_SCRIPT.startsWith("#!/bin/bash"));
    assert.ok(!S.LINUX_SECURITY_SCAN_SCRIPT.includes("${"));
    assert.ok(!S.LINUX_SECURITY_SCAN_SCRIPT.includes("`"));
});
check("it reads only: no write, install or restart commands", () => {
    const code = S.LINUX_SECURITY_SCAN_SCRIPT.replace(/^\s*#.*$/gm, "");
    for (const bad of [/\brm\s/, /\bapt(-get)?\s+(install|remove|upgrade)/, /\bdnf\s+(install|remove|upgrade)/, /\bsystemctl\s+(start|stop|restart|enable|disable)/, /\bshutdown\b/, /(^|[;&|]\s*)reboot\b/m, /\bchmod\b/, /(^|[;&|]\s*)(useradd|usermod|passwd)\b/m, />\s*\/etc\//, /\bcurl\b|\bwget\b/])
        assert.ok(!bad.test(code), `found ${bad}`);
});
check("it never prints password hashes: /etc/shadow is only read to find empty fields", () => {
    const lines = S.LINUX_SECURITY_SCAN_SCRIPT.split("\n").filter((l) => l.includes("/etc/shadow"));
    assert.ok(lines.length >= 1);
    assert.ok(lines.every((l) => /\(\$2==""\)/.test(l) || /-r \/etc\/shadow/.test(l)), lines.join("|"));
});

/* ------------------------------ the parser ------------------------------ */
console.log("parser");
check("a healthy server's output is accepted, every probe ok", () => {
    const s = scan();
    assert.equal(s.v, 1);
    assert.equal(s.platform, "linux");
    for (const name of S.LINUX_PROBE_NAMES) assert.equal(s.probes[name].status, "ok", name);
    assert.equal(s.probes.os.name, "Ubuntu 24.04.1 LTS");
    assert.deepEqual(s.probes.accounts.admins, ["alice", "bob"]);
    assert.deepEqual(s.probes.encryption.volumes, [{ mount: "/", state: "on" }]);
    assert.equal(s.probes.ssh.port, 22);
    assert.equal(s.probes.boot.secureBoot, true);
});
check("a probe the device said it could not read keeps its reason and the others are untouched", () => {
    const s = S.parseLinuxScan(text({}, ["K time synchronized"]) + "U time timedatectl is not installed.\n", "");
    assert.equal(s.probes.time.status, "unknown");
    assert.equal(s.probes.time.reason, "timedatectl is not installed.");
    assert.equal(s.probes.firewall.status, "ok");
});
check("a probe that is missing becomes unknown with a plain reason", () => {
    const s = scan({}, ["K firewall manager", "K firewall active"]);
    assert.equal(s.probes.firewall.status, "unknown");
    assert.match(s.probes.firewall.reason, /did not report/);
});
check("a malformed value makes that one probe unknown, not the whole scan", () => {
    const s = scan({ "K disk rootusedpercent": "lots", "K reboot pending": "maybe" });
    assert.equal(s.probes.disk.status, "unknown");
    assert.equal(s.probes.reboot.status, "unknown");
    assert.equal(s.probes.ssh.status, "ok");
});
check("hostile text is cut down: control characters, long names, bad names, unknown keys and unknown probes are dropped", () => {
    const s = scan({
        "K accounts admins": "alice,<script>alert(1)</script>,;rm -rf /,bob,",
        "K os name": "Evil\u0007\u001b[31m OS" + "x".repeat(500),
        "K antivirus products": "ClamAV,TotallyRealAV,",
    }) ;
    assert.deepEqual(s.probes.accounts.admins, ["alice", "bob"]);
    assert.ok(s.probes.os.name.length <= 100);
    assert.ok(!/[\u0000-\u001f]/.test(s.probes.os.name));
    assert.deepEqual(s.probes.antivirus.products, ["ClamAV"]);
    const t = S.parseLinuxScan(text() + "K evil thing x\nK os secretkey abc\nU nothing why\nK __proto__ a b\n", "");
    assert.equal(Object.keys(t.probes).sort().join(), [...S.LINUX_PROBE_NAMES].sort().join());
    assert.equal(t.probes.os.secretkey, undefined);
});
check("output that is not a scan at all is refused with a message", () => {
    assert.throws(() => S.parseLinuxScan("hello world\nnothing here", ""), /not a security scan/);
    assert.throws(() => S.parseLinuxScan("", "bash: line 1: syntax error"), /did not run: bash: line 1/);
});
check("output far larger than expected is refused", () => {
    assert.throws(() => S.parseLinuxScan("K os id x\n".repeat(20000), ""), /far larger/);
});
check("a device with no SSH server reports installed no and the SSH rules do not apply", () => {
    const s = scan({ "K ssh installed": "no" }, ["K ssh running", "K ssh permitrootlogin", "K ssh passwordauthentication", "K ssh permitemptypasswords", "K ssh port"]);
    assert.equal(s.probes.ssh.installed, false);
    for (const id of ["lx.ssh.rootlogin", "lx.ssh.emptypw", "lx.ssh.password"])
        assert.equal(B.evaluateLinuxScan(s, NOW).rules.find((r) => r.id === id).result, "not_applicable", id);
});

/* ------------------------------ the rules ------------------------------ */
console.log("rules");
check("there are 18 rules, with unique ids, texts and a probe each", () => {
    assert.equal(B.LINUX_RULES.length, 18);
    assert.equal(new Set(B.LINUX_RULES.map((r) => r.id)).size, 18);
    for (const r of B.LINUX_RULES) {
        assert.ok(r.id.startsWith("lx."), r.id);
        assert.ok(r.title && r.checks && r.why && r.fix, r.id);
        assert.ok(r.uses.length >= 1 && r.weight > 0, r.id);
        assert.ok(S.LINUX_PROBE_NAMES.includes(r.uses[0]), r.id);
    }
});
check("a healthy server passes every rule and scores 100 / A", () => {
    const ev = B.evaluateLinuxScan(scan(), NOW);
    assert.deepEqual(ev.rules.filter((r) => r.result !== "pass").map((r) => r.id + ":" + r.result + ":" + r.detail), []);
    assert.equal(ev.score, 100);
    assert.equal(ev.grade, "A");
});
check("lx.fw.active: fails with no firewall", () => {
    assert.equal(result("lx.fw.active", { "K firewall active": "no", "K firewall manager": "none" }), "fail");
    assert.equal(run("lx.fw.active").result, "pass");
    assert.equal(result("lx.fw.active", {}, ["K firewall active"]), "unknown");
});
check("lx.ssh.rootlogin: yes fails; prohibit-password, no and forced-commands-only pass", () => {
    assert.equal(result("lx.ssh.rootlogin", { "K ssh permitrootlogin": "yes" }), "fail");
    for (const v of ["prohibit-password", "without-password", "no", "forced-commands-only"]) assert.equal(result("lx.ssh.rootlogin", { "K ssh permitrootlogin": v }), "pass", v);
});
check("lx.ssh.emptypw and lx.ssh.password", () => {
    assert.equal(result("lx.ssh.emptypw", { "K ssh permitemptypasswords": "yes" }), "fail");
    assert.equal(result("lx.ssh.password", { "K ssh passwordauthentication": "yes" }), "fail");
    assert.equal(result("lx.ssh.password", { "K ssh passwordauthentication": "no" }), "pass");
});
check("lx.acct.emptypw: names the accounts; unknown when the file could not be read", () => {
    const r = run("lx.acct.emptypw", { "K accounts emptypassword": "guest,temp," });
    assert.equal(r.result, "fail");
    assert.match(r.detail, /guest, temp/);
    assert.equal(result("lx.acct.emptypw", { "K accounts emptypassword": "" }), "pass");
    assert.equal(result("lx.acct.emptypw", {}, ["K accounts emptypassword"]), "unknown");
    const s = S.parseLinuxScan(text({}, ["K accounts emptypassword"]) + "U accounts The password file could not be read.\n", "");
    assert.equal(B.evaluateLinuxScan(s, NOW).rules.find((r) => r.id === "lx.acct.emptypw").result, "unknown");
});
check("lx.acct.uid0 and lx.acct.admins", () => {
    assert.equal(result("lx.acct.uid0", { "K accounts extraroot": "toor," }), "fail");
    assert.equal(result("lx.acct.admins", { "K accounts admins": "a,b,c," }), "pass");
    assert.equal(result("lx.acct.admins", { "K accounts admins": "a,b,c,d," }), "fail");
});
check("lx.net.exposed: telnet fails", () => {
    const r = run("lx.net.exposed", { "K exposure risky": "telnet,vnc," });
    assert.equal(r.result, "fail");
    assert.match(r.detail, /telnet, vnc/);
});
check("lx.os.support: supported, ending soon, ended, and unknown for a release not in the table", () => {
    assert.equal(result("lx.os.support"), "pass");
    assert.equal(result("lx.os.support", { "K os id": "ubuntu", "K os version": "18.04" }), "fail");
    assert.equal(result("lx.os.support", { "K os id": "debian", "K os version": "12" }), "pass");
    assert.equal(result("lx.os.support", { "K os id": "debian", "K os version": "11" }), "fail");
    assert.equal(result("lx.os.support", { "K os id": "arch", "K os version": "" }), "unknown");
    assert.equal(result("lx.os.support", { "K os id": "rocky", "K os version": "9.3" }), "pass");
    assert.equal(result("lx.os.support", { "K os id": "centos", "K os version": "7" }), "fail");
    const soon = B.linuxOsSupport("debian", "11", new Date("2026-07-15T00:00:00Z"));
    assert.equal(soon.status, "ending");
    assert.equal(soon.endsOn, "2026-08-31");
    assert.equal(B.linuxOsSupport("ubuntu", "99.99", NOW).status, "unknown");
});
check("lx.updates.recent: 45 days is the limit", () => {
    assert.equal(result("lx.updates.recent", { "K updates agedays": "45" }), "pass");
    assert.equal(result("lx.updates.recent", { "K updates agedays": "46" }), "fail");
});
check("lx.updates.auto, lx.reboot.pending, lx.time.sync, lx.av.present", () => {
    assert.equal(result("lx.updates.auto", { "K autoupdates enabled": "no" }), "fail");
    assert.equal(result("lx.reboot.pending", { "K reboot pending": "yes" }), "fail");
    assert.equal(result("lx.time.sync", { "K time synchronized": "no" }), "fail");
    assert.equal(result("lx.av.present", { "K antivirus products": "" }), "fail");
});
check("lx.mac.enabled: none fails; selinux permissive passes with a note", () => {
    assert.equal(result("lx.mac.enabled", { "K mac kind": "none", "K mac mode": "" }), "fail");
    const r = run("lx.mac.enabled", { "K mac kind": "selinux", "K mac mode": "Permissive" });
    assert.equal(r.result, "pass");
    assert.match(r.detail, /permissive/);
});
check("lx.enc.root: off fails, an unknown layout (a container) is unknown, not a failure", () => {
    assert.equal(result("lx.enc.root", { "K encryption volumes": "/:off,/home:on," }), "fail");
    assert.equal(result("lx.enc.root", { "K encryption volumes": "/:unknown," }), "unknown");
});
check("lx.disk.space: 90 percent is the limit", () => {
    assert.equal(result("lx.disk.space", { "K disk rootusedpercent": "89" }), "pass");
    assert.equal(result("lx.disk.space", { "K disk rootusedpercent": "90" }), "fail");
});
check("lx.boot.secureboot: off fails on UEFI; does not apply to legacy BIOS", () => {
    assert.equal(result("lx.boot.secureboot", { "K boot secureboot": "no" }), "fail");
    assert.equal(result("lx.boot.secureboot", { "K boot uefi": "no" }, ["K boot secureboot"]), "not_applicable");
    assert.equal(result("lx.boot.secureboot", {}, ["K boot secureboot"]), "unknown");
});

/* ------------------------------ scoring ------------------------------ */
console.log("scoring");
check("one failed critical rule caps the grade at D, two at F (the shared scoring)", () => {
    const one = B.evaluateLinuxScan(scan({ "K firewall active": "no" }), NOW);
    assert.equal(one.failedBySeverity.critical, 1);
    assert.ok(one.score <= 69 && one.grade === "D", `${one.score} ${one.grade}`);
    assert.equal(one.capped, true);
    const two = B.evaluateLinuxScan(scan({ "K firewall active": "no", "K ssh permitemptypasswords": "yes" }), NOW);
    assert.equal(two.failedBySeverity.critical, 2);
    assert.ok(two.score <= 59 && two.grade === "F", `${two.score} ${two.grade}`);
});
check("a typical untidy server lands in the middle, and unknown checks stay out of the score", () => {
    const ev = B.evaluateLinuxScan(scan({ "K ssh passwordauthentication": "yes", "K updates agedays": "80", "K autoupdates enabled": "no", "K antivirus products": "", "K encryption volumes": "/:unknown," }), NOW);
    assert.ok(ev.score >= 70 && ev.score < 100, String(ev.score));
    assert.equal(ev.counts.unknown, 1);
});

/* ------------------------------ highlights ------------------------------ */
console.log("highlights");
check("labels: firewall, encryption, antivirus", () => {
    const h = B.linuxHighlights(scan().probes, NOW);
    assert.deepEqual(h.firewall.label, { text: "On (ufw)", tone: "good" });
    assert.deepEqual(h.encryption.label, { text: "On", tone: "good" });
    assert.deepEqual(h.antivirus.label, { text: "ClamAV", tone: "good" });
    assert.equal(h.platform, "linux");
    assert.equal(h.os.support.status, "supported");
    assert.equal(h.accounts.adminCount, 2);
    const bad = B.linuxHighlights(scan({ "K firewall active": "no", "K encryption volumes": "/:off,", "K antivirus products": "" }).probes, NOW);
    assert.deepEqual(bad.firewall.label, { text: "Off", tone: "bad" });
    assert.deepEqual(bad.encryption.label, { text: "Off", tone: "bad" });
    assert.equal(bad.antivirus.label.tone, "unknown");
});
check("a mix of encrypted and plain volumes", () => {
    const h = B.linuxHighlights(scan({ "K encryption volumes": "/:on,/data:off," }).probes, NOW);
    assert.deepEqual(h.encryption.label, { text: "1 of 2 volumes on", tone: "warn" });
    const sys = B.linuxHighlights(scan({ "K encryption volumes": "/:off,/home:on," }).probes, NOW);
    assert.equal(sys.encryption.label.tone, "bad");
});
check("the readable list of what could not be read", () => {
    const s = S.parseLinuxScan(text({}, ["K time synchronized"]) + "U time no clock tool\n", "");
    const h = B.linuxHighlights(s.probes, NOW);
    assert.deepEqual(h.unreadable, [{ probe: "time", reason: "no clock tool" }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
