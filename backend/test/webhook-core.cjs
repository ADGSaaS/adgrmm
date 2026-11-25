// The rules for outbound webhooks, without a database or a server.
// Run after a build: DIST=dist-groupc node test/webhook-core.cjs (DIST defaults to dist).
const path = require("node:path");
const assert = require("node:assert/strict");
const m = require(path.join(__dirname, "..", process.env.DIST || "dist", "webhooks", "webhook-core.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };

check("the events exist, each with a label and a description", () => {
    // Other features add their own ticket events; these are the ones every build has, in this order.
    assert.deepEqual(m.EVENT_KEYS.filter((k) => !k.startsWith("ticket.survey")), ["ticket.created", "ticket.updated", "ticket.sla_warning", "ticket.sla_breached", "alert.opened", "alert.resolved", "device.chat_message", "monitor.failed", "monitor.recovered", "device.offline"]);
    for (const e of m.WEBHOOK_EVENTS) assert.ok(e.label && e.description);
});
check("events are checked, de-duplicated and put in the usual order", () => {
    assert.deepEqual(m.cleanEvents(["device.offline", "ticket.created", "ticket.created"]), ["ticket.created", "device.offline"]);
    assert.throws(() => m.cleanEvents([]), /at least one/);
    assert.throws(() => m.cleanEvents("ticket.created"), /at least one/);
    assert.throws(() => m.cleanEvents(["ticket.deleted"]), /Unknown event: ticket.deleted/);
});
check("an address must be a web address without a password in it", () => {
    assert.equal(m.cleanUrl(" https://hooks.example.com/in?x=1 "), "https://hooks.example.com/in?x=1");
    assert.throws(() => m.cleanUrl(""), /Enter/);
    assert.throws(() => m.cleanUrl("javascript:alert(1)"), /https/);
    assert.throws(() => m.cleanUrl("file:///etc/passwd"), /https/);
    assert.throws(() => m.cleanUrl("nope"), /valid/);
    assert.throws(() => m.cleanUrl("https://a:b@example.com/"), /signature/);
});
check("a name is trimmed and limited", () => {
    assert.equal(m.cleanName("  Slack   bridge "), "Slack bridge");
    assert.throws(() => m.cleanName("  "), /name/);
    assert.throws(() => m.cleanName("x".repeat(81)), /too long/);
});
check("the signature covers the time and the exact body", () => {
    const s = m.sign("k", "100", "body");
    assert.match(s, /^sha256=[0-9a-f]{64}$/);
    assert.notEqual(s, m.sign("k", "101", "body"));
    assert.notEqual(s, m.sign("k", "100", "body "));
    assert.equal(m.verify("k", "100", "body", s, 100), true);
    assert.equal(m.verify("k", "100", "body", s, 100 + 301), false, "too old");
    assert.equal(m.verify("k", "abc", "body", s, 100), false);
    assert.equal(m.verify("k", "100", "body", "sha256=short", 100), false);
});
check("retries back off and then stop", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(m.retryDelay), [1, 5, 15, 60, 240, 720]);
    assert.equal(m.retryDelay(7), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
