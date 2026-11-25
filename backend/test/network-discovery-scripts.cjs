// Network discovery scripts and parser:
//   - range rules (private only, /22 to /32), the parser against hostile output, the guesses of what a host is;
//   - the Linux script run for real in a Docker network with a "printer", a "server" and an idle host: it finds them, their ports and MACs,
//     and never goes outside the range it was given;
//   - the Windows script run in PowerShell against this machine's own private address only (a listener on port 9100 is found).
// Run after a build: node test/network-discovery-scripts.cjs   (Docker and PowerShell parts are skipped with a note when missing)
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const D = require(path.join(__dirname, "..", process.env.DIST || "dist", "network-discovery", "discovery.scripts.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 300_000, ...o });

console.log("rules and parser");
check("ranges: private only, /22 to /32, host bits cleared, de-duplicated", () => {
    assert.deepEqual(D.checkRanges("192.168.1.77/24, 10.0.0.0/22"), ["192.168.1.0/24", "10.0.0.0/22"]);
    assert.deepEqual(D.checkRanges(["172.20.5.9/32", "172.20.5.9/32"]), ["172.20.5.9/32"]);
    assert.deepEqual(D.checkRanges([]), [], "empty means the scanner's own subnets");
    for (const bad of ["8.8.8.0/24", "1.1.1.1/32", "192.168.1.0/16", "10.0.0.0/21", "172.15.0.0/24", "172.32.0.0/24", "169.254.1.0/24", "127.0.0.1/32", "192.168.1.0", "192.168.1.0/33", "300.1.1.1/24", "192.168.1.0/24; rm -rf /", "$(id)/24", "0.0.0.0/0"])
        assert.throws(() => D.checkRanges(bad), /range|private|\/22/i, bad);
    assert.throws(() => D.checkRanges(["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24", "10.0.4.0/24"]), /4 ranges/);
});
check("private address test", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1"]) assert.ok(D.isPrivateV4(ip), ip);
    for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "256.1.1.1", "1.2.3", "", "10.0.0.0/8"]) assert.ok(!D.isPrivateV4(ip), ip);
});
check("the parser accepts the output of a scan and sorts hosts by address", () => {
    const out = ["R 192.168.1.0/24", "H 192.168.1.20 AA:BB:CC:00:11:22 printer1 9100,515,80", "H 192.168.1.5 - - -", "H 192.168.1.9 aa:bb:cc:00:11:33 nas.lan 445,22", "E 41"].join("\n");
    const s = D.parseDiscovery(out, "");
    assert.deepEqual(s.ranges, ["192.168.1.0/24"]); assert.equal(s.seconds, 41);
    assert.deepEqual(s.hosts.map((h) => h.ip), ["192.168.1.5", "192.168.1.9", "192.168.1.20"]);
    assert.deepEqual(s.hosts[2], { ip: "192.168.1.20", mac: "AA:BB:CC:00:11:22", hostname: "printer1", ports: [80, 515, 9100], nameSource: null });
    assert.equal(s.hosts[1].mac, "AA:BB:CC:00:11:33"); assert.equal(s.hosts[0].mac, null); assert.equal(s.hosts[0].hostname, null);
});
check("hostile output: outside addresses, bad MACs, odd names, unknown ports, duplicates and over-long lists are dropped or cut", () => {
    const lines = ["R 8.8.8.0/24", "R 10.0.0.0/24", "H 8.8.8.8 - - 80", "H 10.0.0.1 ZZ:ZZ:ZZ:ZZ:ZZ:ZZ evil;rm 22,99999,80,80,31337", "H 10.0.0.1 AA:AA:AA:AA:AA:AA second 22", "H 10.0.0.2 00:00:00:00:00:00 10.0.0.2 -", "H 10.0.0.3 FF:FF:FF:FF:FF:FF " + "a".repeat(64) + " 443", "H 10.0.0.4", "garbage", "H 10.0.0.5 - ok-name_1.lan 22 extra", "E 3"];
    const s = D.parseDiscovery(lines.join("\n"), "");
    assert.deepEqual(s.ranges, ["10.0.0.0/24"]);
    const by = Object.fromEntries(s.hosts.map((h) => [h.ip, h]));
    assert.ok(!by["8.8.8.8"], "outside address dropped");
    assert.deepEqual(by["10.0.0.1"], { ip: "10.0.0.1", mac: null, hostname: null, ports: [22, 80], nameSource: null }, "first line wins; bad MAC, name and ports cleaned");
    assert.equal(by["10.0.0.2"].mac, null); assert.equal(by["10.0.0.2"].hostname, null, "an address as a name is no name");
    assert.equal(by["10.0.0.3"].mac, null); assert.equal(by["10.0.0.3"].hostname, null);
    assert.ok(!by["10.0.0.4"], "a line with too few fields is dropped"); assert.equal(by["10.0.0.5"].hostname, "ok-name_1.lan"); assert.equal(by["10.0.0.5"].nameSource, null, "an unknown name source is ignored, not trusted");
    const many = Array.from({ length: 3000 }, (_, i) => `H 10.${Math.floor(i / 250)}.${i % 250}.1 - - -`).join("\n") + "\nE 1";
    assert.equal(D.parseDiscovery(many, "").hosts.length, D.DISCOVERY_MAX_HOSTS);
});
check("output with no end line is refused with the device's own words", () => {
    assert.throws(() => D.parseDiscovery("H 10.0.0.1 - - -", "This device has no private network address to scan from."), /no private network address/);
    assert.throws(() => D.parseDiscovery("", ""), /not a network scan/);
});
check("what a host probably is, from its ports and vendor", () => {
    assert.equal(D.classifyHost([80, 9100], null), "printer"); assert.equal(D.classifyHost([554, 80], null), "camera");
    assert.equal(D.classifyHost([135, 445, 3389], null), "windows"); assert.equal(D.classifyHost([22], null), "linux");
    assert.equal(D.classifyHost([22, 80], null), "linux"); assert.equal(D.classifyHost([80, 443], null), "web");
    assert.equal(D.classifyHost([161], null), "network"); assert.equal(D.classifyHost([80], "Ubiquiti"), "network");
    assert.equal(D.classifyHost([], "VMware"), "virtual"); assert.equal(D.classifyHost([445], "Synology"), "nas"); assert.equal(D.classifyHost([], null), "unknown");
    assert.equal(D.vendorOf("00:50:56:AA:BB:CC"), "VMware"); assert.equal(D.vendorOf("02:42:AC:11:00:02"), "Docker"); assert.equal(D.vendorOf(null), null); assert.equal(D.vendorOf("12:34:56:78:9A:BC"), null);
});
check("the scripts are plain: no template markers, no backticks in bash, no dollar-brace, no payloads or logins", () => {
    for (const s of [D.LINUX_DISCOVERY_SCRIPT, D.WINDOWS_DISCOVERY_SCRIPT]) {
        assert.ok(!s.includes("{{") && !s.includes("${"));
        assert.ok(!/nmap|masscan|ssh\s|sshpass|curl|wget|Invoke-WebRequest|Invoke-Command|password/i.test(s), "no login attempts, banners or downloads");
    }
    assert.ok(!D.LINUX_DISCOVERY_SCRIPT.includes("`"));
    assert.ok(D.LINUX_DISCOVERY_SCRIPT.includes(D.DISCOVERY_PORTS.join(" ")), "the bash port list is the server's list");
    assert.ok(D.WINDOWS_DISCOVERY_SCRIPT.includes(D.DISCOVERY_PORTS.join(",")), "the PowerShell port list is the server's list");
});

console.log("Linux script, real hosts in a Docker network");
if (run("docker", ["info", "--format", "{{.ServerVersion}}"]).status !== 0) console.log("     (Docker is not running, skipped)");
else {
    const fs = require("node:fs"), os = require("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-disc-"));
    fs.writeFileSync(path.join(tmp, "scan.sh"), D.LINUX_DISCOVERY_SCRIPT, { mode: 0o755 });
    const NET = `riq-disc-${Date.now()}`, names = [];
    const dk = (...a) => run("docker", a);
    const cleanup = () => { for (const n of names) dk("rm", "-f", n); dk("network", "rm", NET); };
    try {
        assert.equal(dk("network", "create", "--subnet", "172.29.7.0/24", NET).status, 0);
        // one image with the tools: ping, nc, ip
        const base = `riq-disc-base-${Date.now()}`; names.push(base);
        dk("run", "-d", "--name", base, "debian:12", "sleep", "600");
        const inst = run("docker", ["exec", base, "bash", "-c", "apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq iputils-ping netcat-openbsd iproute2 >/dev/null 2>&1; command -v ping nc ip"]);
        assert.match(inst.stdout, /ping[\s\S]*nc[\s\S]*ip/, inst.stderr);
        const img = `riq-disc-img:${Date.now()}`;
        assert.equal(dk("commit", base, img).status, 0);
        const start = (name, ip, cmd) => { names.push(name); const r = dk("run", "-d", "--name", name, "--network", NET, "--ip", ip, img, "bash", "-c", cmd); assert.equal(r.status, 0, r.stderr); };
        start(`${NET}-printer`, "172.29.7.20", "nc -lk 9100 >/dev/null & nc -lk 515 >/dev/null & sleep 600");
        start(`${NET}-server`, "172.29.7.30", "nc -lk 22 >/dev/null & nc -lk 443 >/dev/null & sleep 600");
        start(`${NET}-idle`, "172.29.7.40", "sleep 600");
        names.push(`${NET}-scanner`);
        assert.equal(dk("run", "-d", "--name", `${NET}-scanner`, "--network", NET, "--ip", "172.29.7.2", "--cap-add", "NET_RAW", "-v", `${tmp.replace(/\\/g, "/")}:/w:ro`, img, "sleep", "600").status, 0);
        run("sleep", ["2"]);
        const go = (ranges) => run("docker", ["exec", "-e", `RIQ_RANGES=${ranges}`, `${NET}-scanner`, "bash", "/w/scan.sh"]);

        check("it finds the printer, the server and the idle host with ports and MACs, and nothing else", () => {
            const r = go("172.29.7.0/24");
            assert.equal(r.status, 0, r.stderr);
            const s = D.parseDiscovery(r.stdout, r.stderr);
            assert.deepEqual(s.ranges, ["172.29.7.0/24"]);
            const by = Object.fromEntries(s.hosts.map((h) => [h.ip, h]));
            assert.deepEqual(by["172.29.7.20"].ports, [515, 9100]); assert.deepEqual(by["172.29.7.30"].ports, [22, 443]); assert.deepEqual(by["172.29.7.40"].ports, []);
            for (const ip of ["172.29.7.20", "172.29.7.30", "172.29.7.40"]) { assert.match(by[ip].mac || "", /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, `${ip} has a MAC: ${r.stdout}`); assert.match(by[ip].hostname || "", /printer|server|idle/, `${ip} has a name`); }
            assert.ok(by["172.29.7.1"], "the gateway is seen too");
            assert.ok(s.hosts.every((h) => h.ip.startsWith("172.29.7.")), "nothing outside the range");
            assert.equal(D.classifyHost(by["172.29.7.20"].ports, null), "printer"); assert.equal(D.classifyHost(by["172.29.7.30"].ports, null), "linux");
            assert.ok(s.seconds < 120, `${s.seconds} s`);
        });
        check("a single address is scanned alone, and a range it was not given is never touched", () => {
            const r = go("172.29.7.20/32");
            const s = D.parseDiscovery(r.stdout, r.stderr);
            assert.deepEqual(s.hosts.map((h) => h.ip), ["172.29.7.20"]);
        });
        check("a public or oversized range given to the script itself is ignored (it re-checks), so nothing is scanned and it says why", () => {
            for (const bad of ["8.8.8.0/24", "10.0.0.0/8", "172.29.7.0/16"]) {
                const r = go(bad);
                assert.notEqual(r.status, 0, bad); assert.match(r.stderr, /No address to scan|no private network address/, bad);
                assert.ok(!/^H /m.test(r.stdout), bad);
            }
        });
        check("with no range given it scans the subnet of its own card", () => {
            const r = run("docker", ["exec", `${NET}-scanner`, "bash", "/w/scan.sh"]);
            const s = D.parseDiscovery(r.stdout, r.stderr);
            assert.deepEqual(s.ranges, ["172.29.7.0/24"]); assert.ok(s.hosts.some((h) => h.ip === "172.29.7.20"));
        });
    } catch (e) { failed++; console.log(`FAIL Docker setup: ${e.message}`); }
    finally { cleanup(); }
}

console.log("Windows script, PowerShell on this machine's own address");
(function windows() {
    const ps = process.platform === "win32" ? "powershell" : null;
    if (!ps) return console.log("     (not Windows, skipped)");
    const fs = require("node:fs"), os = require("node:os");
    const own = run(ps, ["-NoProfile", "-Command", "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)' } | Select-Object -First 1).IPAddress"]).stdout.trim();
    if (!own) return console.log("     (no private address on this machine, skipped)");
    const f = path.join(os.tmpdir(), `riq-disc-${Date.now()}.ps1`);
    fs.writeFileSync(f, D.WINDOWS_DISCOVERY_SCRIPT);
    // a listener on 9100 (what a printer has), then the script is told to scan only this machine's own address
    const wrapper = `$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, 9100); $l.Start(); try { $env:RIQ_RANGES = '${own}/32'; $env:RIQ_INCLUDE_SELF = '1'; & '${f}' } finally { $l.Stop() }`;
    const wrapperPlain = `$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, 9100); $l.Start(); try { $env:RIQ_RANGES = '${own}/32'; & '${f}' } finally { $l.Stop() }`;
    check(`with the self-exclusion switched off for the test, it finds this machine (${own}) with port 9100 open, and prints a well formed scan`, () => {
        const r = run(ps, ["-NoProfile", "-Command", wrapper]);
        const s = D.parseDiscovery(r.stdout, r.stderr);
        assert.deepEqual(s.ranges, [`${own}/32`]);
        assert.deepEqual(s.hosts.map((h) => h.ip), [own]);
        assert.ok(s.hosts[0].ports.includes(9100), JSON.stringify(s.hosts[0]));
    });
    check("the scanner is not one of the hosts it finds: its own address is left out", () => {
        const r = run(ps, ["-NoProfile", "-Command", wrapperPlain]);
        const s = D.parseDiscovery(r.stdout, r.stderr);
        assert.deepEqual(s.hosts, [], "scanning only its own address finds nothing");
    });
    check("a public range given to the script is refused by the script itself", () => {
        const r = run(ps, ["-NoProfile", "-Command", `$env:RIQ_RANGES = '8.8.8.0/24'; & '${f}'; "EXIT=$LASTEXITCODE"`]);
        assert.match(r.stdout + r.stderr, /No address to scan/); assert.ok(!/^H /m.test(r.stdout));
    });
    check("with no range given it picks the subnets of its own cards (private only)", () => {
        const r = run(ps, ["-NoProfile", "-Command", `Remove-Item Env:RIQ_RANGES -ErrorAction SilentlyContinue; $env:RIQ_RANGES=''; $x = Get-Content '${f}' -Raw; $x = $x -replace '(?s)# ---- who is there.*$', 'Write-Output ''E 0'''; Invoke-Expression $x`]);
        const s = D.parseDiscovery(r.stdout, r.stderr);
        assert.ok(s.ranges.length >= 1 && s.ranges.every((x) => D.isPrivateV4(x.split("/")[0])), JSON.stringify(s.ranges));
    });
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
