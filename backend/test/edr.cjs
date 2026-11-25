// EDR and antivirus consoles, the rules alone (no network, no database): what a connection is made of, how each product's endpoint becomes one
// shape with a verdict, how endpoints are matched to devices, and what coverage means. Run after a build: node test/edr.cjs
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const C = require(path.join(__dirname, "..", process.env.DIST || "dist", "edr", "edr.core.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const refused = (fn, re) => { try { fn(); } catch (e) { const m = JSON.stringify(e.response ?? e.message); if (re && !re.test(m)) throw new Error(`wrong refusal: ${m}`); return; } throw new Error("was accepted"); };
const NOW = new Date("2026-06-10T12:00:00Z");
const ago = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const GUID = "11111111-2222-3333-4444-555555555555";

console.log("a connection");
check("Defender for Endpoint needs a tenant (GUID or domain), an app ID (GUID) and a secret", () => {
    const c = C.cleanConnection({ vendor: "mde", tenant: " CONTOSO.onmicrosoft.com ", appId: GUID, secret: "s3cret" }, { editing: false });
    assert.deepEqual([c.vendor, c.name, c.config, c.secret], ["mde", "Microsoft Defender for Endpoint", { tenant: "contoso.onmicrosoft.com", appId: GUID }, "s3cret"]);
    refused(() => C.cleanConnection({ vendor: "mde", tenant: "https://x.com", appId: GUID, secret: "s" }, { editing: false })); refused(() => C.cleanConnection({ vendor: "mde", tenant: GUID, appId: "x", secret: "s" }, { editing: false }));
});
check("SentinelOne needs the console name (the first part of its address) and a token", () => {
    assert.equal(C.cleanConnection({ vendor: "sentinelone", subdomain: "USEA1-Acme.sentinelone.net", secret: "t" }, { editing: false }).config.subdomain, "usea1-acme");
    for (const bad of ["", "a b", "evil.com/x", "-x", "x@y"]) refused(() => C.cleanConnection({ vendor: "sentinelone", subdomain: bad, secret: "t" }, { editing: false }));
});
check("Huntress needs a key and a secret; CrowdStrike a cloud, a client ID and a secret", () => {
    assert.deepEqual(C.cleanConnection({ vendor: "huntress", apiKey: "hk_1", secret: "x" }, { editing: false }).config, { apiKey: "hk_1" });
    assert.deepEqual(C.cleanConnection({ vendor: "crowdstrike", cloud: "eu-1", apiClientId: "cid", secret: "x" }, { editing: false }).config, { cloud: "eu-1", apiClientId: "cid" });
    refused(() => C.cleanConnection({ vendor: "crowdstrike", cloud: "mars-1", apiClientId: "cid", secret: "x" }, { editing: false })); refused(() => C.cleanConnection({ vendor: "huntress", apiKey: "has space", secret: "x" }, { editing: false }));
});
check("a secret is needed to make a connection, and left empty on an edit it keeps the old one; an unknown product is refused", () => {
    refused(() => C.cleanConnection({ vendor: "huntress", apiKey: "k" }, { editing: false }), /secret/);
    assert.equal(C.cleanConnection({ apiKey: "k", secret: "" }, { editing: true, vendor: "huntress" }).secret, null);
    refused(() => C.cleanConnection({ vendor: "nope" }, { editing: false }), /Choose which product/);
    refused(() => C.cleanConnection({ vendor: "huntress", apiKey: "k", secret: "x", name: "n".repeat(121) }, { editing: false }), /too long/);
});

console.log("one shape and one verdict");
check("Defender for Endpoint: onboarded and active is healthy; not onboarded or inactive is unhealthy; other sensor states warn; a high risk warns", () => {
    const m = (o) => C.fromMde({ id: "m1", computerDnsName: "pc-1.corp.local", onboardingStatus: "Onboarded", healthStatus: "Active", lastSeen: ago(0), osPlatform: "Windows11", agentVersion: "10.8", riskScore: "None", ...o }, NOW);
    assert.equal(m({}).health, "healthy"); assert.equal(m({ onboardingStatus: "CanBeOnboarded" }).health, "unhealthy"); assert.match(m({ onboardingStatus: "CanBeOnboarded" }).detail, /can be onboarded but is not/);
    assert.equal(m({ healthStatus: "Inactive" }).health, "unhealthy"); assert.equal(m({ healthStatus: "ImpairedCommunication" }).health, "warning"); assert.equal(m({ riskScore: "High" }).health, "warning");
    assert.equal(C.fromMde({ id: "x" }, NOW), null); assert.equal(m({}).hostname, "pc-1.corp.local");
});
check("SentinelOne: active threats are unhealthy; inactive, out of date or long disconnected warn; clean is healthy", () => {
    const a = (o) => C.fromSentinelOne({ id: "a1", computerName: "PC-2", isActive: true, infected: false, activeThreats: 0, isUpToDate: true, networkStatus: "connected", lastActiveDate: ago(0), serialNumber: "SN12345", agentVersion: "23.4", osName: "Windows 11", ...o }, NOW);
    assert.equal(a({}).health, "healthy"); assert.equal(a({ infected: true, activeThreats: 2 }).health, "unhealthy"); assert.match(a({ activeThreats: 1, infected: true }).detail, /1 active threat\b/);
    assert.equal(a({ isActive: false }).health, "warning"); assert.equal(a({ isUpToDate: false }).health, "warning");
    assert.equal(a({ networkStatus: "disconnected", lastActiveDate: ago(5) }).health, "warning"); assert.equal(a({ networkStatus: "disconnected", lastActiveDate: ago(1) }).health, "healthy");
    assert.equal(a({}).serial, "SN12345"); assert.equal(C.fromSentinelOne({ id: "z", computerName: "x" }, NOW).health, "unknown");
});
check("Huntress: Defender not healthy or no call-in for days is a problem; healthy and recent is fine", () => {
    const h = (o) => C.fromHuntress({ id: 7, hostname: "pc-3", defender_status: "Healthy", firewall_status: "Enabled", last_callback_at: ago(0), version: "0.14", os: "Windows 11", ...o }, NOW);
    assert.equal(h({}).health, "healthy"); assert.equal(h({}).vendorId, "7"); assert.equal(h({ defender_status: "Unhealthy" }).health, "unhealthy"); assert.equal(h({ defender_status: "Not available" }).health, "warning");
    assert.equal(h({ firewall_status: "Disabled" }).health, "warning"); assert.equal(h({ last_callback_at: ago(5) }).health, "warning"); assert.equal(h({ last_callback_at: ago(20) }).health, "unhealthy"); assert.equal(h({ last_callback_at: null }).health, "unknown");
});
check("CrowdStrike: contained warns; not seen for days warns, for weeks is unhealthy; normal and recent is healthy", () => {
    const d = (o) => C.fromCrowdStrike({ device_id: "d1", hostname: "PC-4", status: "normal", last_seen: ago(0), platform_name: "Windows", agent_version: "7.1", serial_number: "SER-9", ...o }, NOW);
    assert.equal(d({}).health, "healthy"); assert.equal(d({ status: "contained" }).health, "warning"); assert.match(d({ status: "containment_pending" }).detail, /containment pending/);
    assert.equal(d({ last_seen: ago(5) }).health, "warning"); assert.equal(d({ last_seen: ago(30) }).health, "unhealthy");
});

console.log("matching and coverage");
check("a computer name is compared without its domain, case or the $ of a machine account", () => { assert.equal(C.hostKey("PC-1.Corp.Local"), "pc-1"); assert.equal(C.hostKey("WS01$"), "ws01"); assert.equal(C.hostKey(""), ""); assert.equal(C.hostKey(null), ""); });
const dev = (id, host, client, extra = {}) => ({ id, hostname: host, clientId: client, serial: null, alias: null, ...extra });
const ep = (id, host, serial = null) => ({ vendorId: id, hostname: host, serial });
check("a same serial number matches; otherwise a host name matches only when exactly one device has it", () => {
    const m = C.matchEndpoints([ep("e1", "pc-1.corp.local"), ep("e2", "LAPTOP-X", "SERIAL-777"), ep("e3", "dup-pc"), ep("e4", "nobody")], [dev("d1", "PC-1", "A"), dev("d2", "WHATEVER", "A", { serial: "serial-777" }), dev("d3", "DUP-PC", "A"), dev("d4", "dup-pc", "B")], null);
    assert.equal(m.get("e1"), "d1"); assert.equal(m.get("e2"), "d2", "serial"); assert.equal(m.has("e3"), false, "a name on two customers' networks is nobody in particular"); assert.equal(m.has("e4"), false);
});
check("a console for one customer only matches that customer's devices, so the same name elsewhere is not in the way", () => {
    const m = C.matchEndpoints([ep("e3", "dup-pc")], [dev("d3", "DUP-PC", "A"), dev("d4", "dup-pc", "B")], "A"); assert.equal(m.get("e3"), "d3");
});
check("a placeholder serial number never matches (the same one is on thousands of machines)", () => {
    const m = C.matchEndpoints([ep("e1", "x1", "To Be Filled By O.E.M."), ep("e2", "x2", "0000")], [dev("d1", "a", "A", { serial: "To Be Filled By O.E.M." }), dev("d2", "b", "A", { serial: "0000" })], null); assert.equal(m.size, 0);
});
check("the alias counts as a name too", () => { assert.equal(C.matchEndpoints([ep("e1", "reception")], [dev("d1", "DESKTOP-9F3", "A", { alias: "Reception" })], null).get("e1"), "d1"); });
check("coverage is the worst of what the consoles say, ignoring 'unknown' when something is known; none when no console knows the device", () => {
    const p = (health) => ({ vendor: "huntress", connection: "c", health, detail: "", lastSeenAt: null });
    assert.equal(C.coverageOf([]), "none"); assert.equal(C.coverageOf([p("healthy")]), "healthy"); assert.equal(C.coverageOf([p("healthy"), p("warning")]), "warning");
    assert.equal(C.coverageOf([p("healthy"), p("unhealthy"), p("warning")]), "unhealthy"); assert.equal(C.coverageOf([p("unknown")]), "unknown"); assert.equal(C.coverageOf([p("unknown"), p("healthy")]), "healthy");
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
