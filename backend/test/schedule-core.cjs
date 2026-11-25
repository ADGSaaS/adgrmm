// The schedule rules that need no database: ranges, time zones, working hours, overlaps and the calendar file.
// Run after a build: DIST=dist node test/schedule-core.cjs
const path = require("node:path");
const assert = require("node:assert/strict");
const m = require(path.join(__dirname, "..", process.env.DIST || "dist", "schedule", "schedule-core.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };

const hours = m.defaultHours();

check("a range needs a start before the end and at most a day", () => {
    assert.throws(() => m.parseRange("2026-11-16T10:00:00Z", "2026-11-16T09:00:00Z"));
    assert.throws(() => m.parseRange("nope", "2026-11-16T09:00:00Z"));
    assert.throws(() => m.parseRange(undefined, undefined));
    assert.throws(() => m.parseRange("2026-11-16T10:00:00Z", "2026-11-17T10:00:01Z"));
    assert.throws(() => m.parseRange("1999-01-01T10:00:00Z", "1999-01-01T11:00:00Z"));
    const r = m.parseRange("2026-11-16T09:00:00Z", "2026-11-16T10:30:00Z");
    assert.equal(r.end - r.start, 90 * 60000);
});

check("time zones are checked", () => {
    assert.equal(m.isValidTimeZone("Europe/London"), true);
    assert.equal(m.isValidTimeZone("Mars/Base"), false);
    assert.equal(m.isValidTimeZone(""), false);
    assert.equal(m.isValidTimeZone(5), false);
});

check("working hours are read in the technician's own zone", () => {
    // Monday 16 Nov 2026, 09:00-10:00 in London (UTC+0 in winter) is inside 08:00-17:00.
    assert.equal(m.withinWorkingHours(new Date("2026-11-16T09:00:00Z"), new Date("2026-11-16T10:00:00Z"), "Europe/London", hours), true);
    // The same instant is 04:00 in New York: outside.
    assert.equal(m.withinWorkingHours(new Date("2026-11-16T09:00:00Z"), new Date("2026-11-16T10:00:00Z"), "America/New_York", hours), false);
    // Ends exactly at closing time: fine. One minute past: not.
    assert.equal(m.withinWorkingHours(new Date("2026-11-16T16:00:00Z"), new Date("2026-11-16T17:00:00Z"), "Europe/London", hours), true);
    assert.equal(m.withinWorkingHours(new Date("2026-11-16T16:00:00Z"), new Date("2026-11-16T17:01:00Z"), "Europe/London", hours), false);
    // Saturday is off. A span over midnight is outside.
    assert.equal(m.withinWorkingHours(new Date("2026-11-21T10:00:00Z"), new Date("2026-11-21T11:00:00Z"), "Europe/London", hours), false);
    assert.equal(m.withinWorkingHours(new Date("2026-11-16T16:30:00Z"), new Date("2026-11-16T23:30:00Z"), "Europe/London", hours), false);
});

check("summer time moves the local hours", () => {
    // 15 Jul 2026, 08:00 UTC is 09:00 in London (BST).
    assert.deepEqual(m.localParts(new Date("2026-07-15T08:00:00Z"), "Europe/London"), { weekday: 2, minutes: 540, date: "2026-07-15" });
});

check("overlap is half open: back to back visits do not clash", () => {
    const d = (s) => new Date(`2026-11-16T${s}:00Z`);
    assert.equal(m.overlaps(d("09:00"), d("10:00"), d("10:00"), d("11:00")), false);
    assert.equal(m.overlaps(d("09:00"), d("10:00"), d("09:59"), d("11:00")), true);
});

check("working hours input is validated", () => {
    assert.equal(m.parseHours(hours).length, 7);
    assert.throws(() => m.parseHours([]));
    assert.throws(() => m.parseHours(hours.map((h, i) => (i === 0 ? { on: true, start: "17:00", end: "08:00" } : h))));
    assert.throws(() => m.parseHours(hours.map((h, i) => (i === 0 ? { on: true, start: "8am", end: "5pm" } : h))));
});

check("the calendar file is valid, escaped, folded and cancels with a higher sequence", () => {
    const ics = m.buildIcs({ id: "abc", title: "Fix; the, printer\nnow", description: "x".repeat(200), location: "12 High St", startsAt: new Date("2026-11-16T09:00:00Z"), endsAt: new Date("2026-11-16T10:30:00Z"), sequence: 2, cancelled: false, updatedAt: new Date("2026-11-15T00:00:00Z") });
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
    assert.ok(ics.includes("DTSTART:20261116T090000Z") && ics.includes("DTEND:20261116T103000Z"));
    assert.ok(ics.includes("SUMMARY:Fix\\; the\\, printer\\nnow"));
    assert.ok(ics.includes("UID:abc@remoteiq") && ics.includes("SEQUENCE:2") && ics.includes("METHOD:PUBLISH"));
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line.length}`);
    const c = m.buildIcs({ id: "abc", title: "t", startsAt: new Date("2026-11-16T09:00:00Z"), endsAt: new Date("2026-11-16T10:00:00Z"), sequence: 3, cancelled: true });
    assert.ok(c.includes("METHOD:CANCEL") && c.includes("STATUS:CANCELLED") && c.includes("SEQUENCE:3"));
});

check("a span is described in the visit's own time zone", () => {
    const s = m.describeSpan(new Date("2026-11-17T09:00:00Z"), new Date("2026-11-17T10:30:00Z"), "America/New_York");
    assert.ok(s.includes("04:00 to 05:30") && s.includes("America/New_York") && s.includes("17 Nov 2026"), s);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
