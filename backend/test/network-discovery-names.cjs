// Host names from the hosts themselves (NetBIOS and mDNS), against REAL responders: Samba's nmbd answers the NetBIOS question and Avahi
// answers the mDNS question, in Docker containers. The Linux script is run in a container on the same network; the Windows script is run in
// PowerShell on this machine against the same responders through published UDP ports (the script's test-only switches RIQ_NB_PORT,
// RIQ_MDNS_PORT, RIQ_NO_DNS and RIQ_INCLUDE_SELF point it at them). Also the parser's handling of the name source.
// Run after a build: node test/network-discovery-names.cjs   (Docker and PowerShell parts are skipped with a note when missing)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const D = require(path.join(__dirname, "..", process.env.DIST || "dist", "network-discovery", "discovery.scripts.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 300_000, ...o });

console.log("the parser");
check("the name source is read, kept only next to a name, and ignored when unknown or missing (an older script)", () => {
    const out = ["H 10.0.0.1 - fileserver 445 nbns", "H 10.0.0.2 - printer.local 9100 mdns", "H 10.0.0.3 - dnsname 22 dns", "H 10.0.0.4 - old-script 22", "H 10.0.0.5 - evil 22 telepathy", "H 10.0.0.6 - - 22 nbns", "E 1"].join("\n");
    const by = Object.fromEntries(D.parseDiscovery(out, "").hosts.map((h) => [h.ip, h]));
    assert.equal(by["10.0.0.1"].nameSource, "nbns"); assert.equal(by["10.0.0.2"].nameSource, "mdns"); assert.equal(by["10.0.0.3"].nameSource, "dns");
    assert.equal(by["10.0.0.4"].nameSource, null); assert.equal(by["10.0.0.5"].nameSource, null); assert.equal(by["10.0.0.6"].nameSource, null, "no name, no source");
    assert.equal(by["10.0.0.4"].hostname, "old-script");
});
check("the scripts ask names with read-only questions only and stay plain", () => {
    for (const s of [D.LINUX_DISCOVERY_SCRIPT, D.WINDOWS_DISCOVERY_SCRIPT]) { assert.ok(!s.includes("{{") && !s.includes("${")); assert.ok(!/nbtstat|nmblookup|smbclient|password/i.test(s)); }
    assert.ok(!D.LINUX_DISCOVERY_SCRIPT.includes("`"));
});

console.log("real responders in Docker");
if (run("docker", ["info", "--format", "{{.ServerVersion}}"]).status !== 0) console.log("     (Docker is not running, skipped)");
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-names-"));
    fs.writeFileSync(path.join(tmp, "scan.sh"), D.LINUX_DISCOVERY_SCRIPT, { mode: 0o755 });
    const NET = `riq-names-${Date.now()}`, names = [];
    const dk = (...a) => run("docker", a);
    const cleanup = () => { for (const n of names) dk("rm", "-f", n); dk("network", "rm", NET); };
    try {
        assert.equal(dk("network", "create", "--subnet", "172.28.5.0/24", NET).status, 0);
        const base = `${NET}-base`; names.push(base);
        dk("run", "-d", "--name", base, "debian:12", "sleep", "900");
        const inst = run("docker", ["exec", base, "bash", "-c", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iputils-ping iproute2 samba avahi-daemon >/dev/null 2>&1; command -v nmbd avahi-daemon ping"]);
        assert.match(inst.stdout, /nmbd[\s\S]*avahi-daemon[\s\S]*ping/, inst.stderr);
        const img = `riq-names-img:${Date.now()}`;
        assert.equal(dk("commit", base, img).status, 0);
        const nmbCmd = `printf '[global]\\nworkgroup = TESTGRP\\nnetbios name = FILESRV01\\nserver role = standalone server\\n' > /etc/samba/smb.conf; mkdir -p /var/log/samba /run/samba; exec nmbd -F --no-process-group -s /etc/samba/smb.conf`;
        const avahiCmd = `printf '[server]\\nhost-name=bonjour-printer\\nuse-ipv4=yes\\nuse-ipv6=no\\nenable-dbus=no\\nallow-interfaces=eth0\\n[publish]\\npublish-addresses=yes\\npublish-hinfo=no\\npublish-workstation=no\\n[rlimits]\\n' > /etc/avahi/avahi-daemon.conf; mkdir -p /run/avahi-daemon; exec avahi-daemon --no-drop-root --no-chroot --no-rlimits -f /etc/avahi/avahi-daemon.conf`;
        const start = (name, ip, cmd, extra = []) => { names.push(name); const r = dk("run", "-d", "--name", name, "--network", NET, "--ip", ip, ...extra, img, "bash", "-c", cmd); assert.equal(r.status, 0, r.stderr); };
        start(`${NET}-nb`, "172.28.5.20", nmbCmd, ["-p", "13737:137/udp"]);
        start(`${NET}-mdns`, "172.28.5.30", avahiCmd, ["-p", "15353:5353/udp"]);
        start(`${NET}-quiet`, "172.28.5.40", "sleep 900");
        names.push(`${NET}-scanner`);
        assert.equal(dk("run", "-d", "--name", `${NET}-scanner`, "--network", NET, "--ip", "172.28.5.2", "-v", `${tmp.replace(/\\/g, "/")}:/w:ro`, img, "sleep", "900").status, 0);
        run("sleep", ["6"]);
        const scan = (env = {}) => {
            const r = run("docker", ["exec", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "-e", "RIQ_RANGES=172.28.5.0/24", `${NET}-scanner`, "bash", "/w/scan.sh"]);
            assert.equal(r.status, 0, r.stderr);
            return Object.fromEntries(D.parseDiscovery(r.stdout, r.stderr).hosts.map((h) => [h.ip, h]));
        };

        check("with no DNS: a NetBIOS answer names the host (FILESRV01, from nmbd), and says it came from NetBIOS", () => {
            const by = scan({ RIQ_NO_DNS: "1" });
            assert.equal(by["172.28.5.20"].hostname, "FILESRV01", JSON.stringify(by["172.28.5.20"])); assert.equal(by["172.28.5.20"].nameSource, "nbns");
        });
        check("with no DNS: an mDNS answer names the host (bonjour-printer.local, from Avahi), and says it came from mDNS", () => {
            const by = scan({ RIQ_NO_DNS: "1" });
            assert.match(by["172.28.5.30"].hostname || "", /^bonjour-printer(\.local)?$/, JSON.stringify(by["172.28.5.30"])); assert.equal(by["172.28.5.30"].nameSource, "mdns");
        });
        check("a host that answers neither stays without a name (no invented names)", () => {
            const by = scan({ RIQ_NO_DNS: "1" });
            assert.equal(by["172.28.5.40"].hostname, null); assert.equal(by["172.28.5.40"].nameSource, null);
        });
        check("when DNS knows the host (Docker's own DNS does here) its name is used and the hosts are not asked again", () => {
            const by = scan();
            assert.equal(by["172.28.5.20"].nameSource, "dns", JSON.stringify(by["172.28.5.20"])); assert.match(by["172.28.5.20"].hostname, /-nb/);
            assert.equal(by["172.28.5.30"].nameSource, "dns");
        });
        check("the scan with the two extra questions still finishes quickly", () => {
            const t0 = Date.now(); scan({ RIQ_NO_DNS: "1" }); assert.ok(Date.now() - t0 < 60_000, `${Date.now() - t0} ms`);
        });

        console.log("Windows script, PowerShell on this machine, against the same responders");
        (function windows() {
            if (process.platform !== "win32") return console.log("     (not Windows, skipped)");
            const ps = "powershell";
            const own = run(ps, ["-NoProfile", "-Command", "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)' } | Select-Object -First 1).IPAddress"]).stdout.trim();
            if (!own) return console.log("     (no private address on this machine, skipped)");
            const f = path.join(os.tmpdir(), `riq-names-${Date.now()}.ps1`);
            fs.writeFileSync(f, D.WINDOWS_DISCOVERY_SCRIPT);
            const go = (nbPort, mdnsPort) => {
                const r = run(ps, ["-NoProfile", "-Command", `$env:RIQ_RANGES = '${own}/32'; $env:RIQ_INCLUDE_SELF = '1'; $env:RIQ_NO_DNS = '1'; $env:RIQ_NB_PORT = '${nbPort}'; $env:RIQ_MDNS_PORT = '${mdnsPort}'; & '${f}'`]);
                return D.parseDiscovery(r.stdout, r.stderr).hosts[0];
            };
            check(`a NetBIOS answer names the host (asked at ${own}:13737, answered by nmbd)`, () => { const h = go(13737, 1); assert.equal(h.hostname, "FILESRV01", JSON.stringify(h)); assert.equal(h.nameSource, "nbns"); });
            check("the Windows mDNS parser reads a REAL Avahi reply (captured from the responder container) and names the host", () => {
                const label = (x) => Buffer.concat([Buffer.from([x.length]), Buffer.from(x)]);
                const question = Buffer.concat([Buffer.alloc(12, 0), label("30"), label("5"), label("28"), label("172"), label("in-addr"), label("arpa"), Buffer.from([0, 0, 12, 0, 1])]);
                question[5] = 1;
                const f = path.join(tmp, "mq.bin"); fs.writeFileSync(f, question);
                assert.equal(dk("cp", f, `${NET}-scanner:/tmp/mq.bin`).status, 0);
                const cap = run("docker", ["exec", `${NET}-scanner`, "bash", "-c", "exec 4<>/dev/udp/172.28.5.30/5353; cat /tmp/mq.bin >&4; timeout 2 dd bs=1500 count=1 <&4 2>/dev/null | od -An -tx1 -v"]);
                const bytes = cap.stdout.trim().split(/\s+/).map((h) => parseInt(h, 16));
                assert.ok(bytes.length > 40, "captured a reply: " + cap.stdout + cap.stderr);
                const src = D.WINDOWS_DISCOVERY_SCRIPT;
                const funcs = src.slice(src.indexOf("function SkipName"), src.indexOf("function NbQuery")) + src.slice(src.indexOf("function MdnsParse"), src.indexOf("# one question to many hosts at once"));
                const r = run(ps, ["-NoProfile", "-Command", `${funcs}\n[byte[]]$b = ${bytes.join(",")}\nMdnsParse $b`]);
                assert.match(r.stdout.trim(), /^bonjour-printer(\.local)?$/, r.stdout + r.stderr);
            });
            check("with neither answering the host stays without a name", () => { const h = go(1, 2); assert.equal(h.hostname, null); assert.equal(h.nameSource, null); });
        })();
    } catch (e) { failed++; console.log(`FAIL Docker setup: ${e.message}`); }
    finally { cleanup(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
