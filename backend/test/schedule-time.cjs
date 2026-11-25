// When scheduled reports send: days, times and time zones, including daylight saving. Pure date arithmetic: no database.
"use strict";

const path = require("node:path");
require("reflect-metadata");
const s = require(path.resolve(process.cwd(), "dist/reports/schedule-time.js"));

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
function throwsMessage(name, fn, pattern) {
    try {
        fn();
        check(name, false, "it was accepted");
    } catch (err) {
        check(name, pattern.test(err.message), err.message);
    }
}
const iso = (d) => (d ? d.toISOString() : null);
const utc = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const NY = "America/New_York";

// ---- a wall clock time becomes an instant
check("winter in New York is five hours behind", s.zonedTimeToUtc(2026, 1, 15, 9, 0, NY) === utc(2026, 1, 15, 14));
check("summer in New York is four hours behind", s.zonedTimeToUtc(2026, 7, 15, 9, 0, NY) === utc(2026, 7, 15, 13));
check("UTC is itself", s.zonedTimeToUtc(2026, 5, 5, 7, 30, "UTC") === utc(2026, 5, 5, 7, 30));
check("a half hour zone", s.zonedTimeToUtc(2026, 3, 1, 9, 0, "Asia/Kolkata") === utc(2026, 3, 1, 3, 30));
check("Sydney in January is eleven hours ahead", s.zonedTimeToUtc(2026, 1, 15, 9, 0, "Australia/Sydney") === utc(2026, 1, 14, 22));
check("Sydney in July is ten hours ahead", s.zonedTimeToUtc(2026, 7, 15, 9, 0, "Australia/Sydney") === utc(2026, 7, 14, 23));
check("a time that exists just before clocks go forward", s.zonedTimeToUtc(2026, 3, 8, 1, 30, NY) === utc(2026, 3, 8, 6, 30));
check("a time skipped when clocks go forward lands just after the gap", s.zonedTimeToUtc(2026, 3, 8, 2, 30, NY) === utc(2026, 3, 8, 7, 30), iso(new Date(s.zonedTimeToUtc(2026, 3, 8, 2, 30, NY))));
check("a time that happens twice when clocks go back uses the first", s.zonedTimeToUtc(2026, 11, 1, 1, 30, NY) === utc(2026, 11, 1, 5, 30), iso(new Date(s.zonedTimeToUtc(2026, 11, 1, 1, 30, NY))));
check("the gap works in the southern hemisphere too", s.zonedTimeToUtc(2026, 10, 4, 2, 30, "Australia/Sydney") === utc(2026, 10, 3, 16, 30), iso(new Date(s.zonedTimeToUtc(2026, 10, 4, 2, 30, "Australia/Sydney"))));
const lp = s.localParts(utc(2026, 3, 8, 7, 0), NY);
check("the wall clock is read back correctly across a change", lp.hour === 3 && lp.day === 8 && lp.weekday === 0, lp);
check("midnight is hour zero, not 24", s.localParts(utc(2026, 1, 15, 5, 0), NY).hour === 0);
check("zones are validated", s.isValidTimezone(NY) && s.isValidTimezone("UTC") && !s.isValidTimezone("Mars/Base") && !s.isValidTimezone("") && !s.isValidTimezone("x".repeat(80)));

// ---- daily
const daily = { kind: "daily", time: "09:00", timezone: NY };
check("daily: later today if the time has not come", iso(s.nextRun(daily, new Date(utc(2026, 11, 9, 12)))) === "2026-11-09T14:00:00.000Z");
check("daily: tomorrow once it has passed", iso(s.nextRun(daily, new Date(utc(2026, 11, 9, 14)))) === "2026-11-10T14:00:00.000Z");
check("daily: the same wall time on both sides of the clocks going forward", iso(s.nextRun(daily, new Date(utc(2026, 3, 7, 15)))) === "2026-03-08T13:00:00.000Z" && iso(s.nextRun(daily, new Date(utc(2026, 3, 7, 13)))) === "2026-03-07T14:00:00.000Z");
check("daily: a time in the skipped hour is sent just after it", iso(s.nextRun({ ...daily, time: "02:30" }, new Date(utc(2026, 3, 8, 0)))) === "2026-03-08T07:30:00.000Z");
check("daily: a repeated hour is sent once, the first time", iso(s.nextRun({ ...daily, time: "01:30" }, new Date(utc(2026, 11, 1, 0)))) === "2026-11-01T05:30:00.000Z" && iso(s.nextRun({ ...daily, time: "01:30" }, new Date(utc(2026, 11, 1, 5, 31)))) === "2026-11-02T06:30:00.000Z");
check("the date is the date where the customer is, not in UTC", iso(s.nextRun({ kind: "daily", time: "23:00", timezone: "Asia/Tokyo" }, new Date(utc(2026, 6, 1, 0)))) === "2026-06-01T14:00:00.000Z");

// ---- weekly, on chosen days
const monThu = { kind: "weekly", time: "09:00", timezone: NY, daysOfWeek: [1, 4] };
check("weekly: the next chosen day (Tuesday to Thursday)", iso(s.nextRun(monThu, new Date(utc(2026, 11, 10, 12)))) === "2026-11-12T14:00:00.000Z");
check("weekly: skips to the following Monday after Thursday", iso(s.nextRun(monThu, new Date(utc(2026, 11, 12, 15)))) === "2026-11-16T14:00:00.000Z");
check("weekly: one day a week", iso(s.nextRun({ ...monThu, daysOfWeek: [0] }, new Date(utc(2026, 11, 9, 12)))) === "2026-11-15T14:00:00.000Z");
check("weekly: weekends only", s.previewRuns({ ...monThu, daysOfWeek: [0, 6] }, 4, new Date(utc(2026, 11, 9, 12))).map(iso).join() === "2026-11-14T14:00:00.000Z,2026-11-15T14:00:00.000Z,2026-11-21T14:00:00.000Z,2026-11-22T14:00:00.000Z");
check("weekly: weekdays skip the weekend", s.previewRuns({ ...monThu, daysOfWeek: [1, 2, 3, 4, 5] }, 3, new Date(utc(2026, 11, 13, 15))).map(iso).join() === "2026-11-16T14:00:00.000Z,2026-11-17T14:00:00.000Z,2026-11-18T14:00:00.000Z");

// ---- monthly, on a day
const m = (extra) => ({ kind: "monthly", time: "08:00", timezone: "UTC", ...extra });
check("monthly: the 15th", s.previewRuns(m({ dayOfMonth: 15 }), 3, new Date(utc(2026, 1, 20))).map(iso).join() === "2026-02-15T08:00:00.000Z,2026-03-15T08:00:00.000Z,2026-04-15T08:00:00.000Z");
check("monthly: the 31st becomes the last day in shorter months", s.previewRuns(m({ dayOfMonth: 31 }), 4, new Date(utc(2026, 1, 31, 9))).map(iso).join() === "2026-02-28T08:00:00.000Z,2026-03-31T08:00:00.000Z,2026-04-30T08:00:00.000Z,2026-05-31T08:00:00.000Z");
check("monthly: the 30th in a leap year February", iso(s.nextRun(m({ dayOfMonth: 30 }), new Date(utc(2028, 2, 1)))) === "2028-02-29T08:00:00.000Z");
check("monthly: the last day, including leap years", s.previewRuns(m({ dayOfMonth: -1 }), 3, new Date(utc(2028, 1, 31, 9))).map(iso).join() === "2028-02-29T08:00:00.000Z,2028-03-31T08:00:00.000Z,2028-04-30T08:00:00.000Z");
check("monthly: the 1st rolls over the year", iso(s.nextRun(m({ dayOfMonth: 1 }), new Date(utc(2026, 12, 15)))) === "2027-01-01T08:00:00.000Z");
check("monthly: today if the time has not come", iso(s.nextRun(m({ dayOfMonth: 10 }), new Date(utc(2026, 11, 10, 7)))) === "2026-11-10T08:00:00.000Z");

// ---- monthly, on "the second Tuesday"
check("monthly: the second Tuesday", s.previewRuns(m({ nth: { week: 2, weekday: 2 } }), 2, new Date(utc(2026, 11, 1))).map(iso).join() === "2026-11-10T08:00:00.000Z,2026-12-08T08:00:00.000Z");
check("monthly: the last Friday", s.previewRuns(m({ nth: { week: -1, weekday: 5 } }), 3, new Date(utc(2026, 11, 1))).map(iso).join() === "2026-11-27T08:00:00.000Z,2026-12-25T08:00:00.000Z,2027-01-29T08:00:00.000Z");
check("monthly: the first Monday when the month starts midweek", iso(s.nextRun(m({ nth: { week: 1, weekday: 1 } }), new Date(utc(2026, 12, 1)))) === "2026-12-07T08:00:00.000Z");
check("monthly: the fourth Thursday", iso(s.nextRun(m({ nth: { week: 4, weekday: 4 } }), new Date(utc(2026, 11, 1)))) === "2026-11-26T08:00:00.000Z");

// ---- once
const once = { kind: "once", time: "09:00", timezone: NY, onceDate: "2026-12-15" };
check("once: on that date", iso(s.nextRun(once, new Date(utc(2026, 11, 9)))) === "2026-12-15T14:00:00.000Z");
check("once: never again after it", s.nextRun(once, new Date(utc(2026, 12, 15, 15))) === null && s.previewRuns(once, 5, new Date(utc(2026, 11, 9))).length === 1);
check("once: a date already past never runs", s.nextRun({ ...once, onceDate: "2020-01-01" }, new Date(utc(2026, 11, 9))) === null);

// ---- the same instant is never returned twice
const runs = s.previewRuns({ kind: "daily", time: "01:30", timezone: NY }, 5, new Date(utc(2026, 10, 30, 12)));
check("previews are strictly increasing, even across a repeated hour", runs.every((d, i) => i === 0 || d > runs[i - 1]) && runs.length === 5, runs.map(iso));

// ---- checking a rule
throwsMessage("a rule needs a kind", () => s.checkRule({ time: "09:00" }), /daily, weekly, monthly or once/);
throwsMessage("a made-up kind is refused", () => s.checkRule({ kind: "hourly" }), /daily, weekly, monthly or once/);
throwsMessage("a time zone must exist", () => s.checkRule({ kind: "daily", timezone: "Mars/Base" }), /time zone/);
throwsMessage("a time must be 24 hour HH:MM", () => s.checkRule({ kind: "daily", time: "9:00" }), /09:30/);
throwsMessage("there is no 25 o'clock", () => s.checkRule({ kind: "daily", time: "25:00" }), /09:30/);
throwsMessage("no such minute", () => s.checkRule({ kind: "daily", time: "09:60" }), /09:30/);
throwsMessage("weekly needs a day", () => s.checkRule({ kind: "weekly", daysOfWeek: [] }), /at least one day/);
throwsMessage("a day of the week is 0 to 6", () => s.checkRule({ kind: "weekly", daysOfWeek: [7] }), /at least one day/);
throwsMessage("a day of the month is 1 to 31", () => s.checkRule({ kind: "monthly", dayOfMonth: 32 }), /1 to 31/);
throwsMessage("not zero either", () => s.checkRule({ kind: "monthly", dayOfMonth: 0 }), /1 to 31/);
throwsMessage("there is no fifth Monday option", () => s.checkRule({ kind: "monthly", nth: { week: 5, weekday: 1 } }), /weekday of the month/);
throwsMessage("a one-off needs a date", () => s.checkRule({ kind: "once" }), /date to send on/);
throwsMessage("and a real one", () => s.checkRule({ kind: "once", onceDate: "2026-02-30" }), /does not exist/);
const ok = s.checkRule({ kind: "weekly", daysOfWeek: [4, 1, 4], time: "17:45", timezone: "Europe/London" });
check("a good rule is tidied: days sorted, no repeats", ok.daysOfWeek.join() === "1,4" && ok.time === "17:45" && ok.timezone === "Europe/London", ok);
check("defaults are Monday at 07:00 UTC", (() => { const r = s.checkRule({ kind: "weekly" }); return r.daysOfWeek.join() === "1" && r.time === "07:00" && r.timezone === "UTC"; })());
check("monthly defaults to the 1st", s.checkRule({ kind: "monthly" }).dayOfMonth === 1);
check("extra fields are dropped", !("daysOfWeek" in s.checkRule({ kind: "daily", daysOfWeek: [1] })) && !("onceDate" in s.checkRule({ kind: "daily", onceDate: "2026-01-01" })));

// ---- in plain words
check("describes every day", s.describeRule(daily) === "Every day at 9:00 AM (America/New_York)");
check("describes weekdays", s.describeRule({ ...monThu, daysOfWeek: [1, 2, 3, 4, 5] }) === "Every weekday at 9:00 AM (America/New_York)");
check("describes chosen days", s.describeRule(monThu) === "Every Monday and Thursday at 9:00 AM (America/New_York)");
check("describes three days", s.describeRule({ ...monThu, daysOfWeek: [1, 3, 5], time: "17:05" }) === "Every Monday, Wednesday and Friday at 5:05 PM (America/New_York)");
check("describes midnight and noon", s.describeRule({ ...daily, time: "00:15" }).startsWith("Every day at 12:15 AM") && s.describeRule({ ...daily, time: "12:00" }).startsWith("Every day at 12:00 PM"));
check("describes a day of the month", s.describeRule(m({ dayOfMonth: 1 })).startsWith("The 1st of every month") && s.describeRule(m({ dayOfMonth: 22 })).startsWith("The 22nd") && s.describeRule(m({ dayOfMonth: 11 })).startsWith("The 11th") && s.describeRule(m({ dayOfMonth: 23 })).startsWith("The 23rd"));
check("describes the last day and the nth weekday", s.describeRule(m({ dayOfMonth: -1 })).startsWith("The last day of every month") && s.describeRule(m({ nth: { week: 2, weekday: 2 } })).startsWith("The second Tuesday of every month") && s.describeRule(m({ nth: { week: -1, weekday: 5 } })).startsWith("The last Friday"));
check("describes a one-off", s.describeRule(once) === "Once, on 2026-12-15 at 9:00 AM (America/New_York)");
check("local date is the date where the customer is", s.localDate(new Date(utc(2026, 11, 10, 3)), NY) === "2026-11-09" && s.localDate(new Date(utc(2026, 11, 10, 3)), "Asia/Tokyo") === "2026-11-10");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
