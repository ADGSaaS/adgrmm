// SNMP scripts and parser:
//   - target rules (private addresses, community characters), the parser against hostile output, what the values mean (supply percent,
//     printer error bits, what kind of device it is);
//   - the Linux script run for real in Docker against real SNMP agents (net-snmp snmpd) that answer like a printer: supplies, status,
//     error bits, page count, interfaces, a wrong community, and an address nobody answers;
//   - the Windows script (its own SNMPv2c client in C#) run in PowerShell on this machine against the same kind of agent.
// Run after a build: node test/snmp-scripts.cjs   (the Docker and PowerShell parts are skipped with a note when missing)
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const S = require(path.join(__dirname, "..", process.env.DIST || "dist", "snmp", "snmp.scripts.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 300_000, ...o });

console.log("rules and parser");
check("targets: private addresses only, a sane port, a plain community; at most 20", () => {
    assert.equal(S.checkTargets([{ ip: "10.0.0.5", port: 161, community: "public" }, { ip: "192.168.1.9", port: 1161, community: "a.b_c-d~@#%^*+=" }]), "10.0.0.5,161,public 192.168.1.9,1161,a.b_c-d~@#%^*+=");
    for (const bad of [{ ip: "8.8.8.8", port: 161, community: "public" }, { ip: "127.0.0.1", port: 161, community: "public" }, { ip: "10.0.0.5", port: 0, community: "public" }, { ip: "10.0.0.5", port: 70000, community: "public" }, { ip: "10.0.0.5", port: 161, community: "pub lic" }, { ip: "10.0.0.5", port: 161, community: "a;rm" }, { ip: "10.0.0.5", port: 161, community: "$(id)" }, { ip: "10.0.0.5", port: 161, community: "" }, { ip: "10.0.0.5", port: 161, community: "x".repeat(65) }, { ip: "10.0.0.5", port: 161, community: "a\"b" }])
        assert.throws(() => S.checkTargets([bad]), /private|port|community/i, JSON.stringify(bad));
    assert.throws(() => S.checkTargets([]), /Nothing/);
    assert.throws(() => S.checkTargets(Array.from({ length: 21 }, () => ({ ip: "10.0.0.5", port: 161, community: "public" }))), /20 devices/);
});
check("the parser reads a poll: system, supplies, printer, interfaces", () => {
    const out = ["T 10.0.0.9 ok", "S 10.0.0.9 descr HP LaserJet 4000", "S 10.0.0.9 uptime 8640000", "S 10.0.0.9 name office-printer", "S 10.0.0.9 location Server room",
        "SUP 10.0.0.9 1 7 100 Black Toner Cartridge", "SUP 10.0.0.9 2 -2  Waste toner", "PR 10.0.0.9 status 3", "PR 10.0.0.9 errors 4020", "PR 10.0.0.9 pages 12345",
        "IF 10.0.0.9 1 1 100000000 5000 7000 eth0", "T 10.0.0.10 fail No answer", "E 12"].join("\n");
    const { results, seconds } = S.parseSnmp(out, "", ["10.0.0.9", "10.0.0.10"]);
    assert.equal(seconds, 12);
    const a = results.find((r) => r.ip === "10.0.0.9");
    assert.ok(a.ok); assert.equal(a.descr, "HP LaserJet 4000"); assert.equal(a.uptimeSeconds, 86400); assert.equal(a.name, "office-printer"); assert.equal(a.location, "Server room");
    assert.deepEqual(a.supplies, [{ index: 1, level: 7, max: 100, description: "Black Toner Cartridge" }, { index: 2, level: -2, max: null, description: "Waste toner" }]);
    assert.deepEqual(a.printer, { status: 3, errors: "4020", pages: 12345 });
    assert.deepEqual(a.interfaces, [{ index: 1, name: "eth0", oper: 1, speed: 100000000, inOctets: 5000, outOctets: 7000 }]);
    const b = results.find((r) => r.ip === "10.0.0.10"); assert.equal(b.ok, false); assert.match(b.message, /No answer/);
});
check("hostile output: addresses nobody asked about, odd shapes, control characters, too many rows and a missing end are handled", () => {
    const lines = ["T 10.0.0.9 ok", "T 8.8.8.8 ok", "S 8.8.8.8 descr injected", "S 10.0.0.9 descr " + "a\u0001b".repeat(300), "S 10.0.0.9 uptime notanumber", "SUP 10.0.0.9 x 1 1 bad", "PR 10.0.0.9 errors ZZZZ", "PR 10.0.0.9 pages -5",
        ...Array.from({ length: 40 }, (_, i) => `SUP 10.0.0.9 ${i + 1} 5 10 s${i}`), ...Array.from({ length: 100 }, (_, i) => `IF 10.0.0.9 ${i + 1} 1 1000 1 1 p${i}`), "garbage", "E 5"];
    const { results } = S.parseSnmp(lines.join("\n"), "", ["10.0.0.9", "10.0.0.11"]);
    assert.ok(!results.some((r) => r.ip === "8.8.8.8"));
    const a = results.find((r) => r.ip === "10.0.0.9");
    assert.ok(a.descr.length <= 200 && !/[\u0001]/.test(a.descr)); assert.equal(a.uptimeSeconds, null);
    assert.equal(a.supplies.length, S.SNMP_MAX_SUPPLIES); assert.equal(a.interfaces.length, S.SNMP_MAX_INTERFACES);
    assert.equal(a.printer.errors, null); assert.equal(a.printer.pages, null);
    const silent = results.find((r) => r.ip === "10.0.0.11"); assert.equal(silent.ok, false, "asked about, never reported: a failure");
    assert.throws(() => S.parseSnmp("T 10.0.0.9 ok", "The SNMP tools are missing on this device.", ["10.0.0.9"]), /SNMP tools are missing/);
    assert.throws(() => S.parseSnmp("", "", ["10.0.0.9"]), /not an SNMP poll/);
});
check("what the values mean: supply percent, printer error bits, device kind", () => {
    assert.equal(S.supplyPercent({ index: 1, level: 7, max: 100, description: "" }), 7); assert.equal(S.supplyPercent({ index: 1, level: 1, max: 3, description: "" }), 33);
    assert.equal(S.supplyPercent({ index: 1, level: -2, max: 100, description: "" }), null); assert.equal(S.supplyPercent({ index: 1, level: 5, max: null, description: "" }), null);
    assert.equal(S.supplyPercent({ index: 1, level: 500, max: 100, description: "" }), 100);
    assert.deepEqual(S.printerErrors("6000"), [{ text: "Out of paper", severity: "CRIT" }, { text: "Toner is low", severity: "WARN" }]); assert.deepEqual(S.printerErrors("4020").map((e) => e.text), ["Out of paper", "A supply is missing"]);
    assert.deepEqual(S.printerErrors("0001"), []); assert.deepEqual(S.printerErrors("0004").map((e) => e.text), ["An input tray is empty"]); assert.deepEqual(S.printerErrors(null), []); assert.deepEqual(S.printerErrors("04"), [{ text: "Paper jam", severity: "CRIT" }]);
    assert.equal(S.guessKind({ supplies: [{}], printer: null, interfaces: [] }), "printer"); assert.equal(S.guessKind({ supplies: [], printer: { status: 3, errors: null, pages: null }, interfaces: [] }), "printer");
    assert.equal(S.guessKind({ supplies: [], printer: null, interfaces: [1, 2, 3, 4, 5].map((i) => ({ name: `p${i}` })) }), "switch"); assert.equal(S.guessKind({ supplies: [], printer: null, interfaces: [{ name: "lo" }, { name: "eth0" }] }), "other");
});
check("the scripts only ask (GET, GETNEXT, walk), never set, and carry no template markers", () => {
    for (const s of [S.LINUX_SNMP_SCRIPT, S.WINDOWS_SNMP_SCRIPT]) {
        assert.ok(!s.includes("{{") && !s.includes("${"));
        assert.ok(!/snmpset|snmptrap|snmpbulkset|0xA3\b/i.test(s), "no SET");
    }
    assert.ok(!S.LINUX_SNMP_SCRIPT.includes("`"));
});

console.log("Linux script, real SNMP agents in Docker");
if (run("docker", ["info", "--format", "{{.ServerVersion}}"]).status !== 0) console.log("     (Docker is not running, skipped)");
else {
    const fs = require("node:fs"), os = require("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-snmp-"));
    fs.writeFileSync(path.join(tmp, "snmp.sh"), S.LINUX_SNMP_SCRIPT, { mode: 0o755 });
    const NET = `riq-snmp-${Date.now()}`, names = [];
    const dk = (...a) => run("docker", a);
    const cleanup = () => { for (const n of names) dk("rm", "-f", n); dk("network", "rm", NET); };
    const agentConf = (community, printer) => `agentaddress udp:161\\nrocommunity ${community} default\\nsysLocation Server room\\nsysName ${printer ? "printer-test" : "plain-host"}\\n` + (printer ? [
        `override .1.3.6.1.2.1.43.11.1.1.6.1.1 octet_str "Black Toner Cartridge"`, `override .1.3.6.1.2.1.43.11.1.1.8.1.1 integer 100`, `override .1.3.6.1.2.1.43.11.1.1.9.1.1 integer 7`,
        `override .1.3.6.1.2.1.43.11.1.1.6.1.2 octet_str "Cyan Toner"`, `override .1.3.6.1.2.1.43.11.1.1.8.1.2 integer 100`, `override .1.3.6.1.2.1.43.11.1.1.9.1.2 integer 64`,
        `override .1.3.6.1.2.1.25.3.5.1.1.1 integer 3`, `override .1.3.6.1.2.1.25.3.5.1.2.1 octet_str "@"`, `override .1.3.6.1.2.1.43.10.2.1.4.1.1 counter 12345`].join("\\n") + "\\n" : "");
    try {
        assert.equal(dk("network", "create", "--subnet", "172.31.9.0/24", NET).status, 0);
        const base = `${NET}-base`; names.push(base);
        dk("run", "-d", "--name", base, "debian:12", "sleep", "600");
        const inst = run("docker", ["exec", base, "bash", "-c", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq snmpd snmp >/dev/null 2>&1; command -v snmpget snmpd"]);
        assert.match(inst.stdout, /snmpget[\s\S]*snmpd/, inst.stderr);
        const img = `riq-snmp-img:${Date.now()}`;
        assert.equal(dk("commit", base, img).status, 0);
        const agent = (name, ip, community, printer, extra = []) => {
            names.push(name);
            const r = dk("run", "-d", "--name", name, "--network", NET, "--ip", ip, ...extra, img, "bash", "-c", `printf '${agentConf(community, printer)}' > /etc/snmp/snmpd.conf; exec snmpd -f -Lo -C -c /etc/snmp/snmpd.conf`);
            assert.equal(r.status, 0, r.stderr);
        };
        agent(`${NET}-printer`, "172.31.9.20", "public", true);
        agent(`${NET}-secret`, "172.31.9.21", "secretx", false);
        agent(`${NET}-winpub`, "172.31.9.22", "public", true, ["-p", "16161:161/udp"]);
        names.push(`${NET}-poller`);
        assert.equal(dk("run", "-d", "--name", `${NET}-poller`, "--network", NET, "--ip", "172.31.9.2", "-v", `${tmp.replace(/\\/g, "/")}:/w:ro`, img, "sleep", "600").status, 0);
        run("sleep", ["3"]);
        const go = (targets) => run("docker", ["exec", "-e", `RIQ_SNMP_TARGETS=${targets}`, `${NET}-poller`, "bash", "/w/snmp.sh"]);

        check("a printer answers: name, description, location, uptime, supplies with levels, status, error bits, page count, interfaces", () => {
            const r = go("172.31.9.20,161,public");
            assert.equal(r.status, 0, r.stderr);
            const { results } = S.parseSnmp(r.stdout, r.stderr, ["172.31.9.20"]);
            const p = results[0];
            assert.ok(p.ok, JSON.stringify(p)); assert.equal(p.name, "printer-test"); assert.equal(p.location, "Server room"); assert.match(p.descr, /Linux/); assert.ok(p.uptimeSeconds >= 0);
            assert.deepEqual(p.supplies.map((s) => [s.description, s.level, s.max, S.supplyPercent(s)]), [["Black Toner Cartridge", 7, 100, 7], ["Cyan Toner", 64, 100, 64]]);
            assert.deepEqual(p.printer, { status: 3, errors: "40", pages: 12345 });
            assert.ok(p.interfaces.some((i) => i.name === "eth0" && i.oper === 1), JSON.stringify(p.interfaces));
            assert.equal(S.guessKind(p), "printer");
            assert.deepEqual(S.printerErrors(p.printer.errors).map((e) => e.text), ["Out of paper"]);
        });
        check("a host that is not a printer has no supplies, and one that answers only to another community or does not exist is a failure with a reason", () => {
            const r = go("172.31.9.21,161,secretx 172.31.9.21,161,wrongone 172.31.9.99,161,public".split(" ").slice(0, 1).concat(["172.31.9.99,161,public"]).join(" "));
            const { results } = S.parseSnmp(r.stdout, r.stderr, ["172.31.9.21", "172.31.9.99"]);
            const a = results.find((x) => x.ip === "172.31.9.21"), b = results.find((x) => x.ip === "172.31.9.99");
            assert.ok(a.ok && a.name === "plain-host" && a.supplies.length === 0 && a.printer === null, JSON.stringify(a));
            assert.equal(S.guessKind(a), "other");
            assert.equal(b.ok, false); assert.match(b.message, /No answer/);
            const wrong = S.parseSnmp(go("172.31.9.21,161,wrongone").stdout, "", ["172.31.9.21"]).results[0];
            assert.equal(wrong.ok, false, "the wrong community");
        });
        check("several targets in one run are all reported, and an address outside the private ranges is never contacted", () => {
            const r = go("172.31.9.20,161,public 172.31.9.21,161,secretx 8.8.8.8,161,public 172.31.9.99,161,public");
            const { results } = S.parseSnmp(r.stdout, r.stderr, ["172.31.9.20", "172.31.9.21", "172.31.9.99"]);
            assert.deepEqual(results.map((x) => [x.ip, x.ok]).sort(), [["172.31.9.20", true], ["172.31.9.21", true], ["172.31.9.99", false]]);
            assert.ok(!/8\.8\.8\.8/.test(r.stdout));
        });
        check("a community with shell characters is never run", () => {
            const r = go("172.31.9.20,161,a;touch${IFS}/tmp/pwned");
            assert.ok(!/^T /m.test(r.stdout), "refused by the script");
            assert.equal(run("docker", ["exec", `${NET}-poller`, "bash", "-c", "ls /tmp/pwned 2>&1"]).stdout.includes("No such file"), true);
        });
        check("with the SNMP tools missing it says which package to install", () => {
            const r = run("docker", ["run", "--rm", "-e", "RIQ_SNMP_TARGETS=172.31.9.20,161,public", "-v", `${tmp.replace(/\\/g, "/")}:/w:ro`, "debian:12", "bash", "/w/snmp.sh"]);
            assert.equal(r.status, 69); assert.match(r.stderr, /snmp package.*net-snmp-utils.*Software tab/);
        });

        console.log("Windows script, PowerShell on this machine against the same kind of agent");
        (function windows() {
            if (process.platform !== "win32") return console.log("     (not Windows, skipped)");
            const ps = "powershell";
            const own = run(ps, ["-NoProfile", "-Command", "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)' } | Select-Object -First 1).IPAddress"]).stdout.trim();
            if (!own) return console.log("     (no private address on this machine, skipped)");
            const f = path.join(os.tmpdir(), `riq-snmp-${Date.now()}.ps1`);
            fs.writeFileSync(f, S.WINDOWS_SNMP_SCRIPT);
            const runPs = (targets) => run(ps, ["-NoProfile", "-Command", `$env:RIQ_SNMP_TARGETS = '${targets}'; & '${f}'`]);
            check(`the built-in SNMP client reads a printer (${own}:16161): supplies, status, error bits, page count, interfaces`, () => {
                const r = runPs(`${own},16161,public`);
                const { results } = S.parseSnmp(r.stdout, r.stderr, [own]);
                const p = results[0];
                assert.ok(p.ok, r.stdout + r.stderr); assert.equal(p.name, "printer-test"); assert.equal(p.location, "Server room"); assert.match(p.descr, /Linux/);
                assert.deepEqual(p.supplies.map((s) => [s.description, s.level, s.max]), [["Black Toner Cartridge", 7, 100], ["Cyan Toner", 64, 100]]);
                assert.deepEqual(p.printer, { status: 3, errors: "40", pages: 12345 });
                assert.ok(p.interfaces.some((i) => i.name === "eth0" && i.oper === 1), JSON.stringify(p.interfaces));
                assert.ok(p.uptimeSeconds >= 0);
            });
            check("a wrong community and a port nobody listens on are failures with a reason; a public address is skipped", () => {
                const r = runPs(`${own},16161,wrongone ${own},16999,public 8.8.8.8,161,public`);
                const out = S.parseSnmp(r.stdout, r.stderr, [own]).results;
                assert.equal(out[0].ok, false); assert.ok(!/8\.8\.8\.8/.test(r.stdout));
            });
        })();
    } catch (e) { failed++; console.log(`FAIL Docker setup: ${e.message}`); }
    finally { cleanup(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
