// Business hours: whether a moment falls in the working day. No database needed.
const path = require("node:path");
const { inBusinessHours, DEFAULT_BUSINESS_HOURS } = require(path.resolve(process.cwd(), "dist/reports/report-settings.service.js"));

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const at = (iso) => new Date(iso).getTime();
const h = DEFAULT_BUSINESS_HOURS; // Monday to Friday, 08:00 to 18:00, UTC

// 2026-11-09 is a Monday, 2026-11-14 a Saturday
check("a weekday morning is working time", inBusinessHours(at("2026-11-09T10:00:00Z"), h));
check("the start of the day counts", inBusinessHours(at("2026-11-09T08:00:00Z"), h));
check("a minute before the start does not", !inBusinessHours(at("2026-11-09T07:59:00Z"), h));
check("the end of the day does not count", !inBusinessHours(at("2026-11-09T18:00:00Z"), h));
check("the last minute does", inBusinessHours(at("2026-11-09T17:59:00Z"), h));
check("a Saturday does not", !inBusinessHours(at("2026-11-14T10:00:00Z"), h));

const la = { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", timezone: "America/Los_Angeles" };
check("the zone decides: 17:00 UTC is mid-morning in Los Angeles", inBusinessHours(at("2026-11-09T17:00:00Z"), la));
check("and 03:00 UTC is the evening before there", !inBusinessHours(at("2026-11-09T03:00:00Z"), la));
check("a Monday 02:00 UTC is still Sunday night in Los Angeles, so not working", !inBusinessHours(at("2026-11-09T02:00:00Z"), la));

const night = { days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00", timezone: "UTC" };
check("an overnight day: Monday 23:00 counts", inBusinessHours(at("2026-11-09T23:00:00Z"), night));
check("Tuesday 03:00 belongs to Monday's shift", inBusinessHours(at("2026-11-10T03:00:00Z"), night));
check("Saturday 03:00 belongs to Friday's shift", inBusinessHours(at("2026-11-14T03:00:00Z"), night));
check("Monday 03:00 belongs to Sunday's, which is not worked", !inBusinessHours(at("2026-11-09T03:00:00Z"), night));
check("Saturday 23:00 starts a shift on a day that is not worked", !inBusinessHours(at("2026-11-14T23:00:00Z"), night));
check("midday is outside an overnight shift", !inBusinessHours(at("2026-11-10T12:00:00Z"), night));

const allDay = { days: [1, 2], start: "00:00", end: "00:00", timezone: "UTC" };
check("equal start and end means the whole day, on working days", inBusinessHours(at("2026-11-09T13:00:00Z"), allDay) && !inBusinessHours(at("2026-11-11T13:00:00Z"), allDay));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
