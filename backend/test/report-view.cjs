// Filtering, sorting, grouping, charts and column choice for reports. Plain rows in, rows out: no database.
"use strict";

const path = require("node:path");
require("reflect-metadata");
const v = require(path.resolve(process.cwd(), "dist/reports/report-view.js"));

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

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 10, 12);
const ago = (days) => new Date(now - days * DAY);

const columns = [
    { key: "id", label: "Id", internal: true },
    { key: "customer", label: "Customer" },
    { key: "name", label: "Device" },
    { key: "status", label: "Status", type: "status" },
    { key: "os", label: "OS" },
    { key: "ram", label: "RAM", type: "number" },
    { key: "free", label: "Disk free", type: "percent" },
    { key: "seen", label: "Last seen", type: "date" },
    { key: "note", label: "Note", visible: false },
];
const rows = [
    { id: "1", customer: "Acme", name: "alpha", status: "Online", os: "windows", ram: 16, free: 40.5, seen: ago(0), note: "ok" },
    { id: "2", customer: "Acme", name: "Bravo", status: "Offline", os: "linux", ram: 4, free: 8, seen: ago(10), note: null },
    { id: "3", customer: "Zed", name: "charlie", status: "Online", os: "windows", ram: 32, free: 75, seen: ago(2), note: "" },
    { id: "4", customer: "Zed", name: "delta", status: "Offline", os: "windows", ram: null, free: null, seen: null, note: "old box" },
    { id: "5", customer: "", name: "echo", status: "Online", os: "mac", ram: 8, free: 22, seen: ago(5), note: "x" },
];
const names = (list) => list.map((r) => r.name).join(",");
const run = (filter) => names(v.applyFilter(rows, v.checkView({ filter }, columns).filter, columns, now));
const all = (...conditions) => ({ match: "all", conditions });
const any = (...conditions) => ({ match: "any", conditions });

// ---- text and status
check("contains ignores case", run(all({ field: "name", op: "contains", value: "ALP" })) === "alpha");
check("not contains", run(all({ field: "os", op: "notContains", value: "win" })) === "Bravo,echo");
check("equals ignores case", run(all({ field: "status", op: "eq", value: "offline" })) === "Bravo,delta");
check("not equals", run(all({ field: "status", op: "neq", value: "Online" })) === "Bravo,delta");
check("starts with", run(all({ field: "customer", op: "startsWith", value: "ac" })) === "alpha,Bravo");
check("in a list", run(all({ field: "os", op: "in", value: ["LINUX", "mac"] })) === "Bravo,echo");
check("not in a list", run(all({ field: "os", op: "notIn", value: ["windows"] })) === "Bravo,echo");
check("empty finds blanks and missing values", run(all({ field: "note", op: "empty" })) === "Bravo,charlie", run(all({ field: "note", op: "empty" })));
check("not empty", run(all({ field: "customer", op: "notEmpty" })) === "alpha,Bravo,charlie,delta");

// ---- numbers and percentages
check("greater than", run(all({ field: "ram", op: "gt", value: 8 })) === "alpha,charlie");
check("at least", run(all({ field: "ram", op: "gte", value: 8 })) === "alpha,charlie,echo");
check("less than leaves out unknowns", run(all({ field: "ram", op: "lt", value: 8 })) === "Bravo", run(all({ field: "ram", op: "lt", value: 8 })));
check("equals a number", run(all({ field: "ram", op: "eq", value: 32 })) === "charlie");
check("not equal counts an unknown as different", run(all({ field: "ram", op: "neq", value: 32 })) === "alpha,Bravo,delta,echo");
check("between is inclusive", run(all({ field: "ram", op: "between", value: [8, 16] })) === "alpha,echo");
check("between is forgiving about order", run(all({ field: "ram", op: "between", value: [16, 8] })) === "alpha,echo");
check("a percentage filters like a number", run(all({ field: "free", op: "lt", value: 25 })) === "Bravo,echo");
check("a missing number is empty", run(all({ field: "ram", op: "empty" })) === "delta");

// ---- dates
check("seen within days", run(all({ field: "seen", op: "withinDays", value: 3 })) === "alpha,charlie");
check("not seen for days includes never seen", run(all({ field: "seen", op: "olderThanDays", value: 7 })) === "Bravo,delta", run(all({ field: "seen", op: "olderThanDays", value: 7 })));
check("before a date", run(all({ field: "seen", op: "before", value: "2026-11-07" })) === "Bravo,echo", run(all({ field: "seen", op: "before", value: "2026-11-07" })));
check("after a date means after the whole day", run(all({ field: "seen", op: "after", value: "2026-11-08" })) === "alpha", run(all({ field: "seen", op: "after", value: "2026-11-08" })));
check("a date range includes its last day", run(all({ field: "seen", op: "between", value: ["2026-11-05", "2026-11-08"] })) === "charlie,echo", run(all({ field: "seen", op: "between", value: ["2026-11-05", "2026-11-08"] })));
check("an unknown date never matches a range", !run(all({ field: "seen", op: "between", value: ["2000-01-01", "2030-01-01"] })).includes("delta"));

// ---- combining
check("all of", run(all({ field: "os", op: "eq", value: "windows" }, { field: "free", op: "lt", value: 50 })) === "alpha");
check("any of", run(any({ field: "os", op: "eq", value: "mac" }, { field: "ram", op: "gt", value: 20 })) === "charlie,echo");
check("groups nest", run(all({ field: "customer", op: "eq", value: "Acme" }, any({ field: "ram", op: "lt", value: 5 }, { field: "free", op: "gt", value: 40 }))) === "alpha,Bravo");
check("an empty filter keeps everything", v.applyFilter(rows, undefined, columns, now).length === 5 && v.applyFilter(rows, { match: "all", conditions: [] }, columns, now).length === 5);

// ---- refusing a bad view
throwsMessage("an unknown column is refused", () => v.checkView({ filter: all({ field: "nope", op: "eq", value: 1 }) }, columns), /does not exist/);
throwsMessage("an internal column cannot be used", () => v.checkView({ filter: all({ field: "id", op: "eq", value: "1" }) }, columns), /does not exist/);
throwsMessage("an operator that does not suit the column is refused", () => v.checkView({ filter: all({ field: "name", op: "gt", value: 1 }) }, columns), /cannot be filtered that way/);
throwsMessage("a date column refuses text operators", () => v.checkView({ filter: all({ field: "seen", op: "contains", value: "x" }) }, columns), /cannot be filtered that way/);
throwsMessage("a number needs a number", () => v.checkView({ filter: all({ field: "ram", op: "gt", value: "lots" }) }, columns), /needs a number/);
throwsMessage("a date needs a date", () => v.checkView({ filter: all({ field: "seen", op: "after", value: "yesterday" }) }, columns), /needs a date/);
throwsMessage("a list needs something in it", () => v.checkView({ filter: all({ field: "os", op: "in", value: [] }) }, columns), /at least one value/);
throwsMessage("a range needs two ends", () => v.checkView({ filter: all({ field: "ram", op: "between", value: [1] }) }, columns), /start and an end|two numbers/);
throwsMessage("contains needs text", () => v.checkView({ filter: all({ field: "name", op: "contains", value: "" }) }, columns), /Type something/);
throwsMessage("negative days are refused", () => v.checkView({ filter: all({ field: "seen", op: "withinDays", value: -1 }) }, columns), /number of days/);
throwsMessage("too much nesting is refused", () => v.checkView({ filter: all(any(all(any({ field: "os", op: "eq", value: "x" })))) }, columns), /nested too deeply/);
throwsMessage("too many conditions are refused", () => v.checkView({ filter: all(...Array.from({ length: 31 }, () => ({ field: "os", op: "eq", value: "x" }))) }, columns), /Too many conditions/);
throwsMessage("a very long value is refused", () => v.checkView({ filter: all({ field: "name", op: "contains", value: "x".repeat(201) }) }, columns), /too long/);
throwsMessage("a view that is not JSON is refused", () => v.checkView("{nope", columns), /could not be read/);
throwsMessage("a huge view is refused", () => v.checkView("x".repeat(9000), columns), /too large/);
throwsMessage("sorting by too many columns is refused", () => v.checkView({ sort: [{ key: "name" }, { key: "os" }, { key: "ram" }, { key: "free" }] }, columns), /at most 3/);
throwsMessage("grouping by an unknown column is refused", () => v.checkView({ groupBy: "nope" }, columns), /does not exist/);
throwsMessage("an empty column list is refused", () => v.checkView({ columns: [] }, columns), /at least one column/);
check("no view at all is fine", Object.keys(v.checkView(undefined, columns)).length === 0 && Object.keys(v.checkView("", columns)).length === 0);
check("a view can arrive as a JSON string", v.checkView(JSON.stringify({ sort: [{ key: "name", dir: "desc" }] }), columns).sort[0].dir === "desc");
check("what survives checking is only what was understood", !("evil" in v.checkView({ evil: 1, groupBy: "os" }, columns)) && v.checkView({ groupBy: "os" }, columns).groupBy === "os");

// ---- sorting and grouping
const sorted = (sort, group) => names(v.applySort(rows, sort, group));
check("sorts text ignoring case", sorted([{ key: "name", dir: "asc" }]) === "alpha,Bravo,charlie,delta,echo");
check("sorts descending", sorted([{ key: "name", dir: "desc" }]) === "echo,delta,charlie,Bravo,alpha");
check("sorts numbers as numbers", sorted([{ key: "ram", dir: "asc" }]) === "Bravo,echo,alpha,charlie,delta", sorted([{ key: "ram", dir: "asc" }]));
check("empty values go last whichever way it is sorted", sorted([{ key: "ram", dir: "desc" }]).endsWith(",delta") && sorted([{ key: "ram", dir: "asc" }]).endsWith(",delta"));
check("sorts dates", sorted([{ key: "seen", dir: "desc" }]) === "alpha,charlie,echo,Bravo,delta", sorted([{ key: "seen", dir: "desc" }]));
check("then by a second column", sorted([{ key: "customer", dir: "asc" }, { key: "name", dir: "desc" }]) === "Bravo,alpha,delta,charlie,echo" || sorted([{ key: "customer", dir: "asc" }, { key: "name", dir: "desc" }]) === "Bravo,alpha,delta,charlie,echo", sorted([{ key: "customer", dir: "asc" }, { key: "name", dir: "desc" }]));
check("grouping keeps each group together", sorted([{ key: "name", dir: "asc" }], "customer") === "alpha,Bravo,charlie,delta,echo", sorted([{ key: "name", dir: "asc" }], "customer"));
check("sorting does not change the original", names(rows) === "alpha,Bravo,charlie,delta,echo");
const groups = v.groupCounts(v.applySort(rows, [], "os"), "os");
check("groups are counted in order", JSON.stringify(groups) === JSON.stringify([{ value: "linux", count: 1 }, { value: "mac", count: 1 }, { value: "windows", count: 3 }]), groups);
check("rows with no value form their own group", v.groupCounts(v.applySort(rows, [], "customer"), "customer").some((g) => g.value === "(none)" && g.count === 1));
check("no grouping, no groups", v.groupCounts(rows, null).length === 0);

// ---- charts
const charts = v.buildCharts(rows, [
    { key: "os", title: "OS", kind: "donut", field: "os" },
    { key: "top", title: "Top", kind: "bar", field: "customer", top: 1 },
    { key: "ram", title: "RAM", kind: "bar", field: "ram", buckets: [{ label: "small", max: 8 }, { label: "mid", min: 8, max: 20 }, { label: "big", min: 20 }] },
    { key: "w", title: "Weighted", kind: "bar", field: "os", weight: "ram" },
    { key: "f", title: "Flags", kind: "bar", flags: [{ field: "flagA", label: "A" }, { field: "flagB", label: "B" }] },
]);
check("a facet counts values, biggest first", charts[0].data[0].label === "windows" && charts[0].data[0].value === 3 && charts[0].kind === "donut", charts[0]);
check("a facet folds the tail into Other", charts[1].data.length === 2 && charts[1].data[1].label === "Other", charts[1].data);
check("blank values are named, not dropped", v.buildCharts(rows, [{ key: "c", title: "c", kind: "bar", field: "customer", top: 10 }])[0].data.some((d) => d.label === "(none)"));
check("buckets sort numbers into ranges and count the unknown", JSON.stringify(charts[2].data) === JSON.stringify([{ label: "small", value: 1 }, { label: "mid", value: 2 }, { label: "big", value: 1 }, { label: "Not reported", value: 1 }]), charts[2].data);
check("a weighted facet adds up the weight", charts[3].data[0].label === "windows" && charts[3].data[0].value === 48, charts[3].data);
const flagged = v.buildCharts([{ flagA: true }, { flagA: true, flagB: true }, {}], [{ key: "f", title: "f", kind: "bar", flags: [{ field: "flagA", label: "A" }, { field: "flagB", label: "B" }, { field: "flagC", label: "C" }] }])[0];
check("flags count the true ones and skip the empty", JSON.stringify(flagged.data) === JSON.stringify([{ label: "A", value: 2 }, { label: "B", value: 1 }]), flagged.data);
const line = v.buildCharts([{ t: new Date("2026-11-01T10:00:00Z") }, { t: new Date("2026-11-01T11:00:00Z") }, { t: new Date("2026-11-04T09:00:00Z") }, { t: null }], [{ key: "l", title: "l", kind: "line", field: "t", days: 60 }])[0];
check("a daily chart fills the quiet days with zero", JSON.stringify(line.data) === JSON.stringify([{ label: "2026-11-01", value: 2 }, { label: "2026-11-02", value: 0 }, { label: "2026-11-03", value: 0 }, { label: "2026-11-04", value: 1 }]), line.data);
const longLine = v.buildCharts(Array.from({ length: 100 }, (_, i) => ({ t: new Date(Date.UTC(2026, 0, 1) + i * DAY) })), [{ key: "l", title: "l", kind: "line", field: "t", days: 30 }])[0];
check("a daily chart keeps only the last days asked for", longLine.data.length === 30 && longLine.data[29].label === "2026-04-10", [longLine.data.length, longLine.data[longLine.data.length - 1]]);
check("an empty chart is just empty", v.buildCharts([], [{ key: "l", title: "l", kind: "line", field: "t", days: 30 }, { key: "o", title: "o", kind: "bar", field: "os" }]).every((c) => c.data.length === 0));

// ---- columns to export
check("the default columns skip internal and hidden ones", v.exportColumns(columns).map((c) => c.key).join() === "customer,name,status,os,ram,free,seen");
check("chosen columns come in the order asked", v.exportColumns(columns, ["note", "name"]).map((c) => c.key).join() === "note,name");
check("an internal column cannot be exported", !v.exportColumns(columns, ["id", "name"]).some((c) => c.key === "id"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
