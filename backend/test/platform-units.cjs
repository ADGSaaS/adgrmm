// The pure parts of the platform screens: the CSV reader, the secrets status, the Windows support list and
// install detection. Needs a build: DIST_DIR=dist node test/platform-units.cjs
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = (p) => require(path.join(__dirname, "..", process.env.DIST_DIR || "dist", p));

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message}`); }
}

const { parseCsv, undefuse } = dist("data-exchange/csv.js");
const { secretsStatus, describeEnvironmentKey } = dist("admin/environment.descriptions.js");
const { ENVIRONMENT_DEFINITIONS } = dist("admin/environment.registry.js");
const { unsupportedWindows } = dist("compliance/compliance.service.js");
const { installMode } = dist("admin/platform-info.service.js");

check("csv: quotes, doubled quotes, commas and line breaks inside cells", () => {
    const r = parseCsv('Name,Notes\r\n"Smith, J","He said ""hi""\nsecond line"\r\nPlain,x\r\n', { maxRows: 10 });
    assert.deepEqual(r.header, ["name", "notes"]);
    assert.deepEqual(r.rows, [["Smith, J", 'He said "hi"\nsecond line'], ["Plain", "x"]]);
    assert.deepEqual(r.lines, [2, 4]);
});
check("csv: a byte order mark, LF endings, blank lines and header spelling are tolerated", () => {
    const r = parseCsv("﻿Account Number,Customer-Since\n\n1,2020-01-01\n\n", { maxRows: 10 });
    assert.deepEqual(r.header, ["account_number", "customer_since"]);
    assert.deepEqual(r.rows, [["1", "2020-01-01"]]);
});
check("csv: an unclosed quote, a repeated column, an empty file and too many rows are refused", () => {
    assert.throws(() => parseCsv('a\n"oops', { maxRows: 10 }), /never closed/);
    assert.throws(() => parseCsv("a,a\n1,2", { maxRows: 10 }), /same name/);
    assert.throws(() => parseCsv("", { maxRows: 10 }), /empty/);
    assert.throws(() => parseCsv(`a\n${"1\n".repeat(11)}`, { maxRows: 10 }), /more than 10 rows/);
    assert.throws(() => parseCsv(Array.from({ length: 70 }, (_, i) => `c${i}`).join(",") + "\n1", { maxRows: 10 }), /more than 60 columns/);
    assert.equal(parseCsv("a\n1\n2\n3", { maxRows: 3 }).rows.length, 3);
});
check("csv: a cell exported with a defusing quote is restored", () => {
    assert.equal(undefuse("'+1 555"), "+1 555");
    assert.equal(undefuse("'=SUM(A1)"), "=SUM(A1)");
    assert.equal(undefuse("'hello"), "'hello");
    assert.equal(undefuse("O'Brien"), "O'Brien");
});

check("secrets: every registry setting has its own description", () => {
    for (const d of ENVIRONMENT_DEFINITIONS) assert.ok(!/deployment documentation/.test(describeEnvironmentKey(d.key)), d.key);
});
check("secrets: only set or not set is reported, never a value", () => {
    const env = { JWT_SECRET: "super-secret-value-123", DATABASE_URL: "postgres://u:hunter2@h/db", PORT: "49152", NODE_ENV: "zz-node-env-value", PGHOST: "" };
    const s = secretsStatus(env);
    const text = JSON.stringify(s);
    for (const v of ["super-secret-value-123", "hunter2", "49152", "zz-node-env-value", "postgres://"]) assert.ok(!text.includes(v), v);
    assert.equal(s.items.find((i) => i.key === "PORT").set, true);
    assert.equal(s.items.find((i) => i.key === "PGHOST").set, false, "an empty value counts as not set");
    assert.equal(s.items.find((i) => i.key === "PGPASSWORD").secret, true);
    assert.equal(s.summary.set + s.summary.unset, s.summary.total);
});
check("secrets: a missing required setting needs attention, unless its alternative is set", () => {
    const none = secretsStatus({});
    assert.equal(none.items.find((i) => i.key === "JWT_SECRET").attention, true);
    assert.equal(none.items.find((i) => i.key === "DATABASE_URL").attention, true);
    assert.equal(none.items.find((i) => i.key === "SWAGGER").attention, false, "optional");
    const alt = secretsStatus({ JWT_SECRET: "x", PGHOST: "db", DATA_ENCRYPTION_KEY_FILE: "/k" });
    assert.equal(alt.items.find((i) => i.key === "DATABASE_URL").attention, false);
    assert.equal(alt.items.find((i) => i.key === "DATA_ENCRYPTION_KEY").attention, false);
});

check("compliance: Windows releases past the end of support, by name only", () => {
    for (const n of ["Microsoft Windows 7 Professional", "Windows XP", "Windows 8.1 Pro", "Microsoft Windows 10 Pro", "Windows Vista", "Microsoft Windows Server 2012 R2 Standard", "Windows Server 2008 R2"]) assert.ok(unsupportedWindows(n), n);
    for (const n of ["Microsoft Windows 11 Pro", "Microsoft Windows Server 2019 Standard", "Microsoft Windows Server 2022", "Ubuntu 24.04", "macOS 14", null, ""]) assert.equal(unsupportedWindows(n), null, String(n));
    assert.equal(unsupportedWindows("Windows 10 Pro"), "Windows 10");
    assert.equal(unsupportedWindows("Windows Server 2012 R2"), "Windows Server 2012 R2");
    assert.equal(unsupportedWindows("Windows 8.1"), "Windows 8.1");
});
check("system: how the server was started, from markers the process can see", () => {
    assert.equal(installMode({}, () => true).mode, "docker");
    assert.equal(installMode({ INVOCATION_ID: "abc" }, () => false).mode, "systemd");
    assert.equal(installMode({}, () => false).mode, "manual");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
