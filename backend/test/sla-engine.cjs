// SLA clocks without a database or a server: working-time arithmetic (weekends, holidays, daylight saving, time zones)
// and how a ticket's clocks react to waiting on the customer, replies, resolving, reopening and priority changes.
// Run after a build: DIST=node_modules/.p3a-dist node test/sla-engine.cjs (DIST defaults to dist).
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "service-desk");
const cal = require(path.join(dist, "sla-calendar.js"));
const eng = require(path.join(dist, "sla-engine.js"));
const { isValidTimezone } = require(path.join(__dirname, "..", process.env.DIST || "dist", "reports", "schedule-time.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const iso = (ms) => new Date(ms).toISOString();
const t = (s) => Date.parse(s);
const H = 3_600_000, M = 60_000;

const NY = { timezone: "America/New_York", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", holidays: [] };

check("around the clock, working time is plain time", () => {
    assert.equal(cal.addWorkingMs(t("2026-11-13T10:00:00Z"), 5 * H, null), t("2026-11-13T15:00:00Z"));
    assert.equal(cal.workingMsBetween(t("2026-11-13T10:00:00Z"), t("2026-11-14T10:00:00Z"), null), 24 * H);
    assert.equal(cal.workingMsBetween(t("2026-11-14T10:00:00Z"), t("2026-11-13T10:00:00Z"), null), 0);
});
check("a Friday afternoon target carries over the weekend to Monday morning", () => {
    // Friday 16:00 in New York is 21:00 UTC (standard time). One hour is left on Friday, one more on Monday.
    assert.equal(iso(cal.addWorkingMs(t("2026-11-13T21:00:00Z"), 2 * H, NY)), "2026-11-16T15:00:00.000Z");
});
check("a ticket opened on a Saturday starts counting on Monday at opening time", () => {
    assert.equal(iso(cal.addWorkingMs(t("2026-11-14T15:00:00Z"), 1 * H, NY)), "2026-11-16T15:00:00.000Z");
});
check("a ticket opened before opening time counts from opening time; after closing, from the next day", () => {
    assert.equal(iso(cal.addWorkingMs(t("2026-11-16T10:00:00Z"), 30 * M, NY)), "2026-11-16T14:30:00.000Z"); // 05:00 local -> 09:00 + 30 min
    assert.equal(iso(cal.addWorkingMs(t("2026-11-16T23:00:00Z"), 30 * M, NY)), "2026-11-17T14:30:00.000Z"); // 18:00 local -> next day 09:30
});
check("a holiday is skipped", () => {
    const c = { ...NY, holidays: ["2026-11-16"] };
    assert.equal(iso(cal.addWorkingMs(t("2026-11-13T21:00:00Z"), 2 * H, c)), "2026-11-17T15:00:00.000Z");
    assert.equal(cal.workingMsBetween(t("2026-11-13T21:00:00Z"), t("2026-11-17T15:00:00Z"), c), 2 * H);
});
check("working time between two instants adds up the open hours only", () => {
    assert.equal(cal.workingMsBetween(t("2026-11-13T21:00:00Z"), t("2026-11-16T15:00:00Z"), NY), 2 * H);
    // a whole week: five 8-hour days
    assert.equal(cal.workingMsBetween(t("2026-11-09T00:00:00Z"), t("2026-11-16T00:00:00Z"), NY), 40 * H);
    assert.equal(cal.workingMsBetween(t("2026-11-14T00:00:00Z"), t("2026-11-15T23:00:00Z"), NY), 0);
});
check("daylight saving changes do not shift the opening time", () => {
    // Friday 2026-10-30 16:00 EDT (20:00 UTC); clocks go back on Sunday 1 November. Monday opens at 09:00 EST (14:00 UTC).
    assert.equal(iso(cal.addWorkingMs(t("2026-10-30T20:00:00Z"), 2 * H, NY)), "2026-11-02T15:00:00.000Z");
    assert.equal(cal.workingMsBetween(t("2026-10-30T20:00:00Z"), t("2026-11-02T15:00:00Z"), NY), 2 * H);
});
check("another time zone works from its own clock, and 24:00 means a full day", () => {
    const tokyo = { timezone: "Asia/Tokyo", days: [1, 2, 3, 4, 5, 6, 0], start: "00:00", end: "24:00", holidays: [] };
    assert.equal(cal.addWorkingMs(t("2026-11-13T10:00:00Z"), 48 * H, tokyo), t("2026-11-15T10:00:00Z"));
    assert.equal(cal.workingMsBetween(t("2026-11-13T00:00:00Z"), t("2026-11-14T00:00:00Z"), tokyo), 24 * H);
});
check("calendar input is checked", () => {
    const ok = cal.cleanCalendarInput({ timezone: "Europe/London", days: [5, 1, 1, 2], start: "08:30", end: "17:30", holidays: [{ date: "2026-12-25", name: " Christmas " }, { date: "2026-12-25" }, { date: "2026-01-01", name: "New Year" }] }, isValidTimezone);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value.days, [1, 2, 5]);
    assert.deepEqual(ok.value.holidays.map((h) => h.date), ["2026-01-01", "2026-12-25"]);
    const bad = (o) => cal.cleanCalendarInput({ timezone: "UTC", days: [1], start: "09:00", end: "17:00", ...o }, isValidTimezone);
    assert.equal(bad({ timezone: "Mars/Base" }).ok, false);
    assert.equal(bad({ days: [] }).ok, false);
    assert.equal(bad({ days: [7] }).ok, false);
    assert.equal(bad({ end: "08:00" }).ok, false);
    assert.equal(bad({ start: "9am" }).ok, false);
    assert.equal(bad({ start: "24:00" }).ok, false);
    assert.equal(bad({ end: "24:00" }).ok, true);
    assert.equal(bad({ holidays: [{ date: "2026-02-30" }] }).ok, false);
    assert.equal(bad({ holidays: "x" }).ok, false);
});

// ---- clocks ----
const policy = (over = {}) => ({
    id: "p1", name: "Standard", pauseStatuses: ["pending"], warnPercent: 80, createdAt: 0,
    targets: { low: { response: 480, resolution: 4320 }, medium: { response: 240, resolution: 1440 }, high: { response: 60, resolution: 480 }, urgent: { response: 15, resolution: 120 } },
    ...over,
});
const base = (over = {}) => ({ now: t("2026-11-16T14:00:00Z"), createdAt: t("2026-11-16T14:00:00Z"), status: "open", priority: "medium", policy: policy(), calendar: null, respondedAt: null, ...over });

check("a new ticket gets both clocks with due times and a warning point", () => {
    const s = eng.reconcile(null, base());
    assert.equal(s.response.targetMin, 240);
    assert.equal(iso(s.response.dueAt), "2026-11-16T18:00:00.000Z");
    assert.equal(iso(s.response.warnAt), "2026-11-16T17:12:00.000Z"); // 80% of 4 hours
    assert.equal(iso(s.resolution.dueAt), "2026-11-17T14:00:00.000Z");
    assert.equal(s.paused, false);
});
check("running reconcile again with nothing changed changes nothing", () => {
    const s = eng.reconcile(null, base());
    const again = eng.reconcile(s, base({ now: t("2026-11-16T15:00:00Z") }));
    assert.deepEqual(again, s);
});
check("waiting on the customer stops the clocks and resuming moves the due time by the wait", () => {
    const s0 = eng.reconcile(null, base());
    // after 1 hour the ticket goes pending for 3 hours
    const s1 = eng.reconcile(s0, base({ now: t("2026-11-16T15:00:00Z"), status: "pending" }));
    assert.equal(s1.paused, true);
    assert.equal(s1.resolution.runningSince, null);
    assert.equal(s1.resolution.dueAt, null);
    assert.equal(s1.resolution.usedMs, 1 * H);
    assert.equal(eng.clockState(s1.resolution, s1.paused), "paused");
    assert.equal(eng.levelOf(s1.resolution, s1.paused, t("2026-12-01T00:00:00Z")), "paused"); // a paused clock never breaches
    const s2 = eng.reconcile(s1, base({ now: t("2026-11-16T18:00:00Z"), status: "open" }));
    assert.equal(s2.paused, false);
    assert.equal(iso(s2.resolution.dueAt), "2026-11-17T17:00:00.000Z"); // 24h target + 3h wait
    assert.equal(iso(s2.response.dueAt), "2026-11-16T21:00:00.000Z");
});
check("the first reply finishes the response clock as met or missed", () => {
    const s0 = eng.reconcile(null, base());
    const met = eng.reconcile(s0, base({ now: t("2026-11-16T15:00:00Z"), respondedAt: t("2026-11-16T15:00:00Z") }));
    assert.equal(met.response.met, true);
    assert.equal(met.response.runningSince, null);
    assert.equal(eng.clockState(met.response, false), "met");
    assert.equal(met.resolution.runningSince !== null, true);
    const late = eng.reconcile(s0, base({ now: t("2026-11-16T19:00:00Z"), respondedAt: t("2026-11-16T19:00:00Z") }));
    assert.equal(late.response.met, false);
    assert.equal(eng.levelOf(late.response, false, t("2026-11-16T19:00:00Z")), "breached");
});
check("resolving finishes the resolution clock, and reopening starts it again with what was used", () => {
    const s0 = eng.reconcile(null, base());
    const done = eng.reconcile(s0, base({ now: t("2026-11-16T20:00:00Z"), status: "resolved" }));
    assert.equal(done.resolution.met, true);
    assert.equal(done.resolution.usedMs, 6 * H);
    assert.equal(done.response.doneAt !== null, true); // closing out also ends the response clock
    const back = eng.reconcile(done, base({ now: t("2026-11-17T09:00:00Z"), status: "open", respondedAt: t("2026-11-16T20:00:00Z") }));
    assert.equal(back.resolution.doneAt, null);
    assert.equal(back.resolution.usedMs, 6 * H);
    assert.equal(iso(back.resolution.dueAt), "2026-11-18T03:00:00.000Z"); // 18 hours left from 09:00
});
check("a resolution after the due time is a miss", () => {
    const s0 = eng.reconcile(null, base());
    const done = eng.reconcile(s0, base({ now: t("2026-11-18T14:00:00Z"), status: "closed" }));
    assert.equal(done.resolution.met, false);
    assert.equal(done.resolution.breachedAt !== null, true);
});
check("a priority change re-aims the clocks, keeping the time already used", () => {
    const s0 = eng.reconcile(null, base());
    // after 2 hours the ticket becomes urgent: response 15 min (already used 2h), resolution 2h (used 2h)
    const up = eng.reconcile(s0, base({ now: t("2026-11-16T16:00:00Z"), priority: "urgent" }));
    assert.equal(up.priority, "urgent");
    assert.equal(up.resolution.targetMin, 120);
    assert.equal(iso(up.resolution.dueAt), "2026-11-16T16:00:00.000Z"); // already due
    assert.equal(eng.levelOf(up.resolution, false, t("2026-11-16T16:00:00Z")), "breached");
    // down to low: 72 hour target, 2 hours used
    const down = eng.reconcile(s0, base({ now: t("2026-11-16T16:00:00Z"), priority: "low" }));
    assert.equal(iso(down.resolution.dueAt), "2026-11-19T14:00:00.000Z");
});
check("changing the policy takes the new targets; no policy target for a priority means no clock", () => {
    const s0 = eng.reconcile(null, base());
    const p2 = policy({ id: "p2", name: "Gold", targets: { medium: { response: 30 } } });
    const s1 = eng.reconcile(s0, base({ now: t("2026-11-16T14:10:00Z"), policy: p2 }));
    assert.equal(s1.policyId, "p2");
    assert.equal(s1.response.targetMin, 30);
    assert.equal(iso(s1.response.dueAt), "2026-11-16T14:30:00.000Z");
    assert.equal(s1.resolution.targetMin, null);
    assert.equal(eng.clockState(s1.resolution, false), "none");
    assert.equal(eng.levelOf(s1.resolution, false, 0), "none");
});
check("editing a target in the same policy is picked up, and a clock that gains a target counts from the ticket's creation", () => {
    const s0 = eng.reconcile(null, base());
    const edited = policy({ targets: { medium: { response: 120, resolution: 1440 } } });
    const s1 = eng.reconcile(s0, base({ now: t("2026-11-16T15:00:00Z"), policy: edited }));
    assert.equal(iso(s1.response.dueAt), "2026-11-16T16:00:00.000Z");
    const none = eng.reconcile(null, base({ priority: "medium", policy: policy({ targets: { medium: { resolution: 600 } } }) }));
    assert.equal(none.response.targetMin, null);
    const gained = eng.reconcile(none, base({ now: t("2026-11-16T16:00:00Z"), policy: policy() }));
    assert.equal(gained.response.targetMin, 240);
    assert.equal(iso(gained.response.dueAt), "2026-11-16T18:00:00.000Z"); // 2 hours had already passed
});
check("a ticket older than its policy starts its clocks when the policy began", () => {
    const s = eng.reconcile(null, base({ createdAt: t("2026-11-10T10:00:00Z"), policy: policy({ createdAt: t("2026-11-16T13:00:00Z") }) }));
    assert.equal(iso(s.response.dueAt), "2026-11-16T17:00:00.000Z");
});
check("business hours: the due time skips the night and the warning point is in working time", () => {
    const s = eng.reconcile(null, base({ now: t("2026-11-16T20:00:00Z"), createdAt: t("2026-11-16T20:00:00Z"), calendar: NY, priority: "high" })); // 15:00 local Monday, response 60 min
    assert.equal(iso(s.response.warnAt), "2026-11-16T20:48:00.000Z");
    assert.equal(iso(s.response.dueAt), "2026-11-16T21:00:00.000Z");
    const late = eng.reconcile(null, base({ now: t("2026-11-16T21:30:00Z"), createdAt: t("2026-11-16T21:30:00Z"), calendar: NY, priority: "high" })); // 16:30 local, 30 min today, 30 tomorrow
    assert.equal(iso(late.response.dueAt), "2026-11-17T14:30:00.000Z");
});
check("clock levels: ok, warning, breached", () => {
    const s = eng.reconcile(null, base({ priority: "high" })); // response 60 min from 14:00
    assert.equal(eng.levelOf(s.response, false, t("2026-11-16T14:30:00Z")), "ok");
    assert.equal(eng.levelOf(s.response, false, t("2026-11-16T14:48:00Z")), "warning");
    assert.equal(eng.levelOf(s.response, false, t("2026-11-16T15:00:00Z")), "breached");
    assert.equal(eng.overallLevel("ok", "warning"), "warning");
    assert.equal(eng.overallLevel("breached", "met"), "breached");
    assert.equal(eng.overallLevel("paused", "ok"), "paused");
});
check("pausing a clock that has nothing running keeps it paused; a policy that pauses nothing never pauses", () => {
    const s = eng.reconcile(null, base({ status: "pending" }));
    assert.equal(s.paused, true);
    assert.equal(s.resolution.runningSince, null);
    const none = eng.reconcile(null, base({ status: "pending", policy: policy({ pauseStatuses: [] }) }));
    assert.equal(none.paused, false);
    assert.notEqual(none.resolution.runningSince, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
