// Domain, DNS and certificate monitoring, the rules alone (no network, no database): what may be saved, how a certificate, a domain or a set of
// DNS records becomes ok / warning / failed, and when a change of state is news. Run after a build: node test/web-monitors.cjs
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "web-monitors");
const C = require(path.join(dist, "web-monitors.core.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const refused = (fn, re) => { try { fn(); } catch (e) { const m = JSON.stringify(e.response ?? e.message); if (re && !re.test(m)) throw new Error(`wrong refusal: ${m}`); return; } throw new Error("was accepted"); };
const NOW = new Date("2026-06-01T12:00:00Z");
const inDays = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

console.log("what may be saved");
check("a host is lower-cased, trimmed, and a trailing dot goes; an accented name becomes its ASCII form", () => {
    assert.equal(C.cleanHost("  Example.COM. ", "domain"), "example.com");
    assert.equal(C.cleanHost("bücher.example", "domain"), "xn--bcher-kva.example");
});
check("a scheme, a path, a port, a user name, a space or a query are refused with a plain reason", () => {
    for (const bad of ["https://example.com", "example.com/path", "example.com:8443", "me@example.com", "exa mple.com", "example.com?x=1", "example.com#a", ""]) refused(() => C.cleanHost(bad, "certificate"));
});
check("a name needs a dot and valid labels; localhost, dashes at the ends and over-long labels are refused", () => {
    for (const bad of ["localhost", "-a.example", "a-.example", `${"a".repeat(64)}.example`, "a..example", "exa_mple.com"]) refused(() => C.cleanHost(bad, "dns"));
});
check("an IPv4 address is fine for a certificate only, and must be a real address", () => {
    assert.equal(C.cleanHost("192.0.2.10", "certificate"), "192.0.2.10");
    refused(() => C.cleanHost("192.0.2.10", "domain"), /name, not an address/); refused(() => C.cleanHost("192.0.2.10", "dns"));
    refused(() => C.cleanHost("999.1.1.1", "certificate"));
});
check("ports: 443 by default, 1 to 65535 for a certificate, and ignored for the other kinds", () => {
    assert.equal(C.cleanPort(undefined, "certificate"), 443); assert.equal(C.cleanPort("8443", "certificate"), 8443); assert.equal(C.cleanPort(25, "domain"), 443);
    for (const bad of [0, 65536, 1.5, "x", -1]) refused(() => C.cleanPort(bad, "certificate"));
});
check("certificate and domain limits: defaults, whole days from 1 to 730, and failing has to be sooner than warning", () => {
    assert.deepEqual(C.cleanConfig("certificate", {}), { warnDays: 30, failDays: 7 });
    assert.deepEqual(C.cleanConfig("domain", { warnDays: 90, failDays: 30 }), { warnDays: 90, failDays: 30 });
    refused(() => C.cleanConfig("certificate", { warnDays: 5, failDays: 10 }), /fewer days/); refused(() => C.cleanConfig("domain", { warnDays: 0 }));
    refused(() => C.cleanConfig("domain", { warnDays: 731 })); refused(() => C.cleanConfig("certificate", { warnDays: 20.5 }));
});
check("DNS config: record types are checked, listed once, expected values are normalized, at most six types", () => {
    assert.deepEqual(C.cleanConfig("dns", {}).records.map((r) => r.type), ["A", "MX", "NS"]);
    const c = C.cleanConfig("dns", { records: [{ type: "mx", expected: ["10 MAIL.Example.com."] }, { type: "txt", expected: ["v=spf1 -all"] }] });
    assert.deepEqual(c.records, [{ type: "MX", expected: ["10 mail.example.com"] }, { type: "TXT", expected: ["v=spf1 -all"] }]);
    refused(() => C.cleanConfig("dns", { records: [{ type: "SRV" }] }), /must be one of/); refused(() => C.cleanConfig("dns", { records: [{ type: "A" }, { type: "a" }] }), /twice/);
    refused(() => C.cleanConfig("dns", { records: ["A", "AAAA", "MX", "NS", "TXT", "CNAME", "A"].map((type) => ({ type })) }));
});

console.log("certificates");
const cert = (days, extra = {}) => ({ validTo: inDays(days), issuer: "Test CA", trusted: true, authError: null, nameError: null, ...extra });
check("far from expiry and trusted is ok, and says until when and who issued it", () => {
    const e = C.evalCertificate(cert(90), {}, NOW); assert.equal(e.status, "ok"); assert.match(e.detail, /90 more days/); assert.match(e.detail, /Test CA/); assert.equal(e.expiresAt.toISOString(), inDays(90));
});
check("the warning and failing limits are inclusive and can be changed", () => {
    assert.equal(C.evalCertificate(cert(31), {}, NOW).status, "ok"); assert.equal(C.evalCertificate(cert(30), {}, NOW).status, "warning");
    assert.equal(C.evalCertificate(cert(8), {}, NOW).status, "warning"); assert.equal(C.evalCertificate(cert(7), {}, NOW).status, "failed");
    assert.equal(C.evalCertificate(cert(45), { warnDays: 60, failDays: 50 }, NOW).status, "failed");
    assert.equal(C.evalCertificate(cert(45), { warnDays: 40, failDays: 10 }, NOW).status, "ok");
});
check("expired, untrusted and wrong-name certificates fail with the reason, even with plenty of time left", () => {
    const exp = C.evalCertificate(cert(-3, { trusted: false, authError: "CERT_HAS_EXPIRED" }), {}, NOW); assert.equal(exp.status, "failed"); assert.match(exp.detail, /expired 3 days ago/);
    const un = C.evalCertificate(cert(200, { trusted: false, authError: "DEPTH_ZERO_SELF_SIGNED_CERT" }), {}, NOW); assert.equal(un.status, "failed"); assert.match(un.detail, /not trusted \(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
    const nm = C.evalCertificate(cert(200, { nameError: "Host: a.example. is not in the cert's altnames" }), {}, NOW); assert.equal(nm.status, "failed"); assert.match(nm.detail, /name does not match/);
});
check("a certificate with no dates fails instead of passing", () => { assert.equal(C.evalCertificate({ trusted: true }, {}, NOW).status, "failed"); assert.equal(C.evalCertificate({ trusted: true, validTo: "nonsense" }, {}, NOW).status, "failed"); });

console.log("domains");
check("a domain is ok, warning, failed by days left, with the registrar named", () => {
    const ok = C.evalDomain({ expiresAt: inDays(200), registrar: "Reg Inc" }, {}, NOW); assert.equal(ok.status, "ok"); assert.match(ok.detail, /at Reg Inc/);
    assert.equal(C.evalDomain({ expiresAt: inDays(60) }, {}, NOW).status, "warning"); assert.equal(C.evalDomain({ expiresAt: inDays(14) }, {}, NOW).status, "failed");
    const gone = C.evalDomain({ expiresAt: inDays(-2) }, {}, NOW); assert.equal(gone.status, "failed"); assert.match(gone.detail, /expired 2 days ago/);
});
check("a hold, a redemption period or a pending delete fails no matter the date; harmless statuses do not", () => {
    for (const s of ["clientHold", "server hold", "pendingDelete", "redemptionPeriod", "pending restore"]) assert.equal(C.evalDomain({ expiresAt: inDays(300), status: [s] }, {}, NOW).status, "failed", s);
    assert.equal(C.evalDomain({ expiresAt: inDays(300), status: ["client transfer prohibited", "active"] }, {}, NOW).status, "ok");
});
check("a registry that gives no expiry date is a warning, not a pass", () => { const e = C.evalDomain({ expiresAt: null }, {}, NOW); assert.equal(e.status, "warning"); assert.equal(e.expiresAt, null); });

console.log("DNS records");
const cfg = (records, baseline) => ({ records, baseline });
check("expected values: all present and nothing extra is ok; missing or extra is failed and says which", () => {
    const rules = [{ type: "A", expected: ["192.0.2.1"] }];
    assert.equal(C.evalDns({ A: ["192.0.2.1"] }, cfg(rules)).status, "ok");
    const m = C.evalDns({ A: [] }, cfg(rules)); assert.equal(m.status, "failed"); assert.match(m.detail, /A is missing 192\.0\.2\.1/);
    const x = C.evalDns({ A: ["192.0.2.1", "198.51.100.9"] }, cfg(rules)); assert.equal(x.status, "failed"); assert.match(x.detail, /unexpected 198\.51\.100\.9/);
});
check("TXT: the wanted entries only have to be there, other entries are fine", () => {
    const rules = [{ type: "TXT", expected: ["v=spf1 -all"] }];
    assert.equal(C.evalDns({ TXT: ["google-site=abc", "v=spf1 -all"] }, cfg(rules)).status, "ok");
    assert.equal(C.evalDns({ TXT: ["google-site=abc"] }, cfg(rules)).status, "failed");
});
check("case, trailing dots and order never count as a change (MX priority does)", () => {
    const rules = [{ type: "MX", expected: ["10 mail.example.com", "20 b.example.com"] }];
    assert.equal(C.evalDns({ MX: ["20 B.example.com.", "10 Mail.Example.com"] }, cfg(rules)).status, "ok");
    assert.equal(C.evalDns({ MX: ["30 b.example.com", "10 mail.example.com"] }, cfg(rules)).status, "failed");
});
check("with nothing expected, the first look is remembered; the same records later are ok", () => {
    const first = C.evalDns({ A: ["192.0.2.1"], NS: ["ns1.example.com"] }, cfg([{ type: "A" }, { type: "NS" }]));
    assert.equal(first.status, "ok"); assert.deepEqual(first.baselineToStore, { A: ["192.0.2.1"], NS: ["ns1.example.com"] });
    const later = C.evalDns({ A: ["192.0.2.1"], NS: ["ns1.example.com"] }, cfg([{ type: "A" }, { type: "NS" }], first.baselineToStore)); assert.equal(later.status, "ok"); assert.equal(later.baselineToStore, undefined);
});
check("a change from what was remembered is a warning that says what went and what came, and tells how to accept it", () => {
    const e = C.evalDns({ A: ["198.51.100.7"] }, cfg([{ type: "A" }], { A: ["192.0.2.1"] }));
    assert.equal(e.status, "warning"); assert.match(e.detail, /A changed: no longer 192\.0\.2\.1; now also 198\.51\.100\.7/); assert.match(e.detail, /accept the new records/); assert.equal(e.changed.length, 1);
});
check("a failed rule outranks a changed one", () => {
    const e = C.evalDns({ A: [], MX: ["10 x.example.com"] }, cfg([{ type: "A", expected: ["192.0.2.1"] }, { type: "MX" }], { MX: ["10 y.example.com"] })); assert.equal(e.status, "failed");
});

console.log("when a change is news");
check("ok to warning or failed is news; staying the same is not; failed to warning is not (it got better, not fixed)", () => {
    assert.deepEqual(C.transition("ok", 0, { status: "warning" }), { next: "warning", errorCount: 0, notify: "failed", severity: "warning" });
    assert.equal(C.transition("warning", 0, { status: "warning" }).notify, null); assert.equal(C.transition("failed", 0, { status: "failed" }).notify, null);
    assert.equal(C.transition("warning", 0, { status: "failed" }).notify, "failed"); assert.equal(C.transition("failed", 0, { status: "warning" }).notify, null);
    assert.equal(C.transition("pending", 0, { status: "failed" }).notify, "failed"); assert.equal(C.transition("pending", 0, { status: "ok" }).notify, null);
});
check("back to ok after a problem (warning, failed or error) is news once", () => {
    for (const was of ["warning", "failed", "error"]) { const t = C.transition(was, 4, { status: "ok" }); assert.equal(t.notify, "recovered", was); assert.equal(t.errorCount, 0); assert.equal(t.next, "ok"); }
    assert.equal(C.transition("ok", 0, { status: "ok" }).notify, null);
});
check("an error is news only after three in a row, once, and until then the earlier state stays", () => {
    let t = C.transition("ok", 0, { error: "x" }); assert.deepEqual([t.next, t.errorCount, t.notify], ["ok", 1, null]);
    t = C.transition("ok", 1, { error: "x" }); assert.deepEqual([t.next, t.errorCount, t.notify], ["ok", 2, null]);
    t = C.transition("ok", 2, { error: "x" }); assert.deepEqual([t.next, t.errorCount, t.notify, t.severity], ["error", 3, "failed", "error"]);
    t = C.transition("error", 3, { error: "x" }); assert.deepEqual([t.next, t.errorCount, t.notify], ["error", 4, null]);
    assert.equal(C.transition("pending", 0, { error: "x" }).next, "pending");
});
check("a good result in between resets the error count", () => { assert.equal(C.transition("ok", 2, { status: "ok" }).errorCount, 0); });
check("the next look: certificates every 6 hours, domains daily, DNS every 15 minutes, and sooner after an error", () => {
    const f = new Date("2026-01-01T00:00:00Z");
    assert.equal(C.nextCheckAfter("certificate", false, f) - f, 360 * 60_000); assert.equal(C.nextCheckAfter("domain", false, f) - f, 1440 * 60_000);
    assert.equal(C.nextCheckAfter("dns", false, f) - f, 15 * 60_000); assert.equal(C.nextCheckAfter("domain", true, f) - f, 15 * 60_000);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
