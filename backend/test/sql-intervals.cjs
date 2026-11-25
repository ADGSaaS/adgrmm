// A guard for a bug that ran in production for a day: make_interval(days => $1) with a number from JavaScript fails ("function
// make_interval(days => bigint) does not exist"), because Prisma sends whole numbers as bigint and the unit arguments are integers. Every
// make_interval(days|hours|mins|weeks|months|years => ${value}) in the source must cast the value with ::int. (secs takes a double, which a
// bigint converts to, and a column name needs no cast.)
// Run: node test/sql-intervals.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const bad = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) check(p); } };
const check = (p) => {
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => { for (const m of l.matchAll(/make_interval\(\s*(days|hours|mins|weeks|months|years)\s*=>\s*\$\{([^}]*)\}\s*(::\w+)?/g)) if (!/^::int/.test(m[3] ?? "")) bad.push(`${path.relative(process.cwd(), p)}:${i + 1}: ${m[0]}`); });
};
walk(path.join(__dirname, "..", "src"));
if (bad.length) { console.log(`FAIL ${bad.length} make_interval call(s) pass a number without ::int:\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log("ok   every make_interval with a number from code casts it to int\n\n1 passed, 0 failed");
