// The Overview page's summary, the parts that need no server or database: the "needs attention" rules and their ranking and
// wording, plain-language audit lines, the short cache (lifetime, shared loads, failures, size), the scope key that keeps one
// person's numbers from reaching another, and the cache-lifetime setting.
// Run after a build: node test/dashboard-units.cjs (DIST defaults to dist).
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "dashboard");
const C = require(path.join(dist, "dashboard.core.js"));
const { ttlFromEnv, DEFAULT_TTL_MS } = require(path.join(dist, "dashboard.service.js"));

let passed = 0, failed = 0;
const tests = [];
const check = (name, fn) => tests.push([name, fn]);

const everything = {
    alerts: { open: 9, openCritical: 4 },
    tickets: { breached: 2, warning: 3 },
    security: { attentionDevices: 5, neverScanned: 6 },
    devices: { offlineOver24h: 7, neverCheckedIn: 1 },
    patching: { installFailed: 2, needRestart: 8 },
    release: [{ os: "windows", version: "1.3.31" }],
};

check("nothing to do gives an empty list, also for parts the person may not see (null) or that are missing", () => {
    assert.deepEqual(C.buildAttention({}), []);
    assert.deepEqual(C.buildAttention({ alerts: null, tickets: null, security: null, devices: null, patching: null, release: null }), []);
    assert.deepEqual(C.buildAttention({ alerts: { open: 0, openCritical: 0 }, tickets: { breached: 0, warning: 0 }, devices: { offlineOver24h: 0, neverCheckedIn: 0 } }), []);
});

check("every rule appears when its number is above zero, with a sentence that holds the count", () => {
    const items = C.buildAttention(everything);
    assert.deepEqual(items.map((i) => i.id), [
        "alerts-critical", "sla-breached", "security-critical", "devices-offline", "alerts-open", "sla-risk", "update-failed",
        "needs-restart", "not-scanned", "never-checked-in", "release-windows",
    ]);
    const text = Object.fromEntries(items.map((i) => [i.id, i.text]));
    assert.equal(text["alerts-critical"], "4 critical alerts are open");
    assert.equal(text["alerts-open"], "5 other alerts are open", "the critical ones are not counted twice");
    assert.equal(text["sla-breached"], "2 tickets have breached their SLA");
    assert.equal(text["sla-risk"], "3 tickets are close to breaching their SLA");
    assert.equal(text["security-critical"], "5 devices have a critical security problem");
    assert.equal(text["devices-offline"], "7 devices have been offline for over a day");
    assert.equal(text["update-failed"], "2 devices failed their last update install");
    assert.equal(text["needs-restart"], "8 devices need a restart to finish updates");
    assert.equal(text["not-scanned"], "6 devices have never had a security scan");
    assert.equal(text["never-checked-in"], "1 device has never checked in");
    assert.equal(text["release-windows"], "Agent 1.3.31 for Windows is waiting to be promoted");
});

check("one of each reads correctly (singular)", () => {
    const one = C.buildAttention({
        alerts: { open: 1, openCritical: 1 }, tickets: { breached: 1, warning: 1 }, security: { attentionDevices: 1, neverScanned: 1 },
        devices: { offlineOver24h: 1, neverCheckedIn: 1 }, patching: { installFailed: 1, needRestart: 1 },
    });
    assert.deepEqual(one.map((i) => i.text), [
        "1 critical alert is open", "1 ticket has breached its SLA", "1 device has a critical security problem",
        "1 device has been offline for over a day", "1 ticket is close to breaching its SLA", "1 device failed its last update install",
        "1 device needs a restart to finish updates", "1 device has never had a security scan", "1 device has never checked in",
    ]);
});

check("ranking: red first, then amber, then housekeeping, and the order is the same on every call", () => {
    const items = C.buildAttention(everything);
    const levels = items.map((i) => i.severity);
    assert.deepEqual(levels, [...levels].sort((a, b) => C.SEVERITY_RANK[a] - C.SEVERITY_RANK[b]));
    assert.deepEqual(C.buildAttention(everything).map((i) => i.id), items.map((i) => i.id));
    // a lot of amber never pushes red down
    const lots = C.buildAttention({ ...everything, devices: { offlineOver24h: 9999, neverCheckedIn: 0 }, alerts: { open: 100000, openCritical: 1 } });
    assert.equal(lots[0].id, "alerts-critical");
    assert.equal(lots[2].id, "security-critical");
    assert.equal(lots[3].severity, "warning");
});

check("alerts: with no critical alert the open ones read as plain 'alerts', and the link has no severity", () => {
    const [x] = C.buildAttention({ alerts: { open: 3, openCritical: 0 } });
    assert.equal(x.text, "3 alerts are open");
    assert.deepEqual(x.query, {});
    assert.equal(x.route, "/alerts");
    assert.equal(x.severity, "warning");
});

check("each item says where to go: a page and the filters that show exactly those things", () => {
    const by = Object.fromEntries(C.buildAttention(everything).map((i) => [i.id, i]));
    assert.deepEqual([by["alerts-critical"].route, by["alerts-critical"].query], ["/alerts", { severity: "CRIT" }]);
    assert.deepEqual([by["sla-breached"].route, by["sla-breached"].query], ["/tickets", { sla: "breached" }]);
    assert.deepEqual([by["sla-risk"].route, by["sla-risk"].query], ["/tickets", { sla: "warning" }]);
    assert.deepEqual([by["security-critical"].route, by["security-critical"].query], ["/security", { sort: "critical" }]);
    assert.deepEqual([by["not-scanned"].route, by["not-scanned"].query], ["/security", { grade: "none" }]);
    assert.deepEqual([by["devices-offline"].route, by["devices-offline"].query], ["/customers", { status: "offline" }]);
    assert.equal(by["update-failed"].route, "/reports");
    assert.deepEqual([by["release-windows"].route, by["release-windows"].query], ["/administration", { tab: "agents" }]);
    for (const i of Object.values(by)) assert.ok(i.route.startsWith("/") && i.count > 0 && i.area);
});

check("bad numbers (negative, NaN, fractions, strings) are treated as nothing or rounded down, never shown", () => {
    assert.deepEqual(C.buildAttention({ alerts: { open: -4, openCritical: NaN }, tickets: { breached: "x", warning: undefined } }), []);
    const [x] = C.buildAttention({ devices: { offlineOver24h: 2.9, neverCheckedIn: 0 } });
    assert.equal(x.count, 2);
    const [y] = C.buildAttention({ alerts: { open: 2, openCritical: 5 } });
    assert.equal(y.id, "alerts-critical", "more critical than open never gives a negative 'other' count");
    assert.equal(C.buildAttention({ alerts: { open: 2, openCritical: 5 } }).length, 1);
});

check("only the parts that are given produce rows (a person without tickets rights never gets a ticket row)", () => {
    const noTickets = C.buildAttention({ ...everything, tickets: null });
    assert.ok(!noTickets.some((i) => i.area === "tickets"));
    const noRelease = C.buildAttention({ ...everything, release: null });
    assert.ok(!noRelease.some((i) => i.area === "agents"));
});

check("plural", () => {
    assert.equal(C.plural(1, "device"), "1 device");
    assert.equal(C.plural(0, "device"), "0 devices");
    assert.equal(C.plural(2, "ticket has", "tickets have"), "2 tickets have");
});

check("audit lines are plain words and carry the target, not the details", () => {
    assert.equal(C.describeAudit("device.reboot", "PC-12"), "restarted device PC-12");
    assert.equal(C.describeAudit("ticket.create", "Printer is down"), "created ticket Printer is down");
    assert.equal(C.describeAudit("ticket.update", null), "updated a ticket");
    assert.equal(C.describeAudit("settings.update", null), "updated settings");
    assert.equal(C.describeAudit("agents.release.promote", null, "success"), "promoted an agent release");
    assert.equal(C.describeAudit("user.delete", "ann@example.com", "failure"), "deleted user ann@example.com (did not work)");
    assert.equal(C.describeAudit("something.odd", null), "something odd");
    assert.equal(C.describeAudit("", null), "did something");
    assert.equal(C.describeAudit("device.reboot", "x".repeat(300)).length < 120, true, "a long label is cut");
    assert.ok(!/[\u0000-\u001f]/.test(C.describeAudit("device.reboot", "a\u0000b\nc")));
});

check("TtlCache: serves within the lifetime, reloads after it, shares one load, and forgets failures", async () => {
    let t = 1000;
    const cache = new C.TtlCache(30_000, 500, () => t);
    let loads = 0;
    const load = async () => ++loads;
    assert.equal(await cache.get("k", load), 1);
    t += 29_999;
    assert.equal(await cache.get("k", load), 1, "still fresh");
    t += 2;
    assert.equal(await cache.get("k", load), 2, "expired after 30 s");
    assert.equal(await cache.get("other", load), 3, "another key is another entry");
    // two requests at once, one load
    t += 100_000;
    let slow = 0;
    const gate = new Promise((r) => setTimeout(r, 30));
    const slowLoad = async () => { slow++; await gate; return "v"; };
    const both = await Promise.all([cache.get("s", slowLoad), cache.get("s", slowLoad)]);
    assert.deepEqual(both, ["v", "v"]);
    assert.equal(slow, 1);
    // a failure is not kept
    let tries = 0;
    await assert.rejects(cache.get("f", async () => { tries++; throw new Error("boom"); }));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await cache.get("f", async () => { tries++; return "ok"; }), "ok");
    assert.equal(tries, 2);
});

check("TtlCache: ttl 0 never serves old numbers; the size stays bounded", async () => {
    const off = new C.TtlCache(0);
    let n = 0;
    await off.get("a", async () => ++n);
    await off.get("a", async () => ++n);
    assert.equal(n, 2);
    let t = 0;
    const small = new C.TtlCache(1_000_000, 10, () => ++t);
    for (let i = 0; i < 100; i++) await small.get(`k${i}`, async () => i);
    assert.ok(small.size <= 10, `size ${small.size}`);
    assert.equal(await small.get("k99", async () => -1), 99, "the newest survive");
});

check("scopeKey: everyone unlimited shares a key; a limited person is separate, stable and order independent", () => {
    assert.equal(C.scopeKey(null, "u1"), "all");
    assert.equal(C.scopeKey(null, null), "all");
    const a = C.scopeKey({ clients: ["c2", "c1"], sites: [], tags: [] }, "u1");
    const b = C.scopeKey({ clients: ["c1", "c2", "c1"], sites: [], tags: [] }, "u1");
    assert.equal(a, b);
    assert.notEqual(a, "all");
    assert.notEqual(a, C.scopeKey({ clients: ["c1", "c2"], sites: [], tags: [] }, "u2"), "assigned tickets are per person");
    assert.notEqual(a, C.scopeKey({ clients: ["c1"], sites: [], tags: [] }, "u1"));
    assert.notEqual(C.scopeKey({ clients: ["c1"], sites: [], tags: [] }, "u1"), C.scopeKey({ clients: [], sites: ["c1"], tags: [] }, "u1"), "a customer is not a site");
});

check("cacheKey separates section, organisation, scope and customer filter", () => {
    const k = (...a) => C.cacheKey(...a);
    const all = new Set([k("devices", "o1", "all", null), k("devices", "o2", "all", null), k("devices", "o1", "limited:x", null), k("devices", "o1", "all", "c1"), k("alerts", "o1", "all", null)]);
    assert.equal(all.size, 5);
});

check("ttlFromEnv: 30 s by default, the setting when it is a sane number, 0 turns it off", () => {
    assert.equal(DEFAULT_TTL_MS, 30_000);
    const saved = process.env.DASHBOARD_CACHE_TTL_MS;
    delete process.env.DASHBOARD_CACHE_TTL_MS;
    try { assert.equal(ttlFromEnv(), 30_000, "no setting, 30 s"); } finally { if (saved !== undefined) process.env.DASHBOARD_CACHE_TTL_MS = saved; }
    assert.equal(ttlFromEnv(""), 30_000);
    assert.equal(ttlFromEnv("abc"), 30_000);
    assert.equal(ttlFromEnv("-5"), 30_000);
    assert.equal(ttlFromEnv("0"), 0);
    assert.equal(ttlFromEnv("2500"), 2500);
    assert.equal(ttlFromEnv("99999999"), 300_000);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log(`  ok    ${name}`); }
        catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
