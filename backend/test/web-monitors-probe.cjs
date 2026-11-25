// The server connects to names that people typed in, so it must not reach private networks (the database host, a cloud metadata address, a
// customer's internal servers) unless that is turned on on purpose. Run after a build: node test/web-monitors-probe.cjs
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist");
const P = require(path.join(dist, "web-monitors", "web-monitors.probe.js"));
const N = require(path.join(dist, "notifications", "notifications.service.js"));
let passed = 0, failed = 0;
const ok = (name) => { passed++; console.log(`ok   ${name}`); };
const bad = (name, why) => { failed++; console.log(`FAIL ${name}: ${why}`); };
const rejects = async (name, fn, re) => {
    try { await fn(); bad(name, "was accepted"); } catch (e) { if (re && !re.test(e.message)) bad(name, `wrong reason: ${e.message}`); else ok(name); }
};

(async () => {
    delete process.env.MONITOR_ALLOW_PRIVATE;
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.16.5.5", "169.254.169.254", "100.64.0.1", "::1"]) await rejects(`${a} is refused`, () => P.publicAddress(a), /private network/);
    await rejects("localhost is refused (it resolves to a loopback address)", () => P.publicAddress("localhost"), /private network/);
    await rejects("reading a certificate from a private address is refused before any connection is made", () => P.readCertificate("10.255.255.1", 443, 1000), /private network/);
    try { assert.equal(N.isPrivateAddress("93.184.216.34"), false); assert.equal(await P.publicAddress("93.184.216.34"), "93.184.216.34"); ok("a public address is allowed"); } catch (e) { bad("a public address is allowed", e.message); }
    process.env.MONITOR_ALLOW_PRIVATE = "true";
    try { assert.equal(await P.publicAddress("127.0.0.1"), "127.0.0.1"); ok("MONITOR_ALLOW_PRIVATE=true lets a private network be monitored on purpose"); } catch (e) { bad("allow private", e.message); }
    await rejects("a name that does not exist says so", () => P.publicAddress("no-such-name.invalid"), /does not exist|could not be looked up/);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
