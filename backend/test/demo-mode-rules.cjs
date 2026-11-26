// Checks the demo's rules: what a visitor may and may not do. Plain Node, no database: node test/demo-mode-rules.cjs
const path = require("node:path");
const { judge } = require(path.join(__dirname, "..", "dist", "demo-mode", "demo-mode.rules.js"));
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const v = (m, u) => judge(m, u);

// Reading ordinary screens is fine.
for (const u of ["/api/customers", "/api/devices", "/api/tickets?status=open", "/api/alerts", "/api/billing/invoices", "/api/kb/articles", "/api/reports/views", "/api/users/me", "/api/auth/me", "/api/admin/audit-events", "/api/admin/users", "/api/admin/workflows"]) check(`read ${u}`, v("GET", u) === "pass");

// How the server is set up stays hidden, even to reads.
for (const u of ["/api/admin/system", "/api/admin/diagnostics", "/api/admin/environment", "/api/admin/database", "/api/admin/migrations", "/api/admin/storage/connections", "/api/admin/backups/config", "/api/admin/sso", "/api/admin/email", "/api/admin/secrets-status", "/api/admin/integrations", "/api/admin/webhooks", "/api/admin/data/export/customers", "/api/admin/sessions", "/api/provisioning/enrollment-keys", "/api/provisioning/installer-bundles", "/api/users/me/tokens", "/api/devices/abc/secrets", "/api/notifications/channels", "/api/remote-recordings"]) check(`hidden ${u}`, v("GET", u) === "refuse");

// No device can be added, and no agent can enroll.
for (const [m, u] of [["POST", "/api/agent/enroll"], ["POST", "/api/provisioning/enrollment-keys"], ["POST", "/api/provisioning/installer-bundles"], ["POST", "/api/provisioning/endpoints"], ["POST", "/api/agent/ping"], ["POST", "/api/admin/agents"]]) check(`no ${m} ${u}`, v(m, u) === "refuse");

// Nothing that reaches outside or runs on a device.
for (const [m, u] of [["POST", "/api/admin/webhooks"], ["POST", "/api/admin/email/send-test"], ["POST", "/api/monitors/web"], ["POST", "/api/snmp/devices"], ["POST", "/api/network-discovery/scan"], ["POST", "/api/scripts/abc/run"], ["POST", "/api/devices/abc/actions/reboot"], ["POST", "/api/devices/abc/files/write"], ["POST", "/api/bulk/devices/reboot"], ["POST", "/api/bulk/devices/run-script"], ["POST", "/api/tools/command"], ["POST", "/api/billing/invoices/1/send"], ["POST", "/api/reports/schedules/1/send-now"], ["POST", "/api/tickets/1/attachments"], ["POST", "/api/branding/upload"], ["POST", "/api/users/me/password"], ["POST", "/api/users/me/tokens"], ["POST", "/api/admin/users/invite"], ["PUT", "/api/admin/security-policies"], ["POST", "/api/m365/tenants/1/sync"], ["POST", "/api/remote-console/sessions"]]) check(`no ${m} ${u}`, v(m, u) === "refuse");

// What a visitor may change, so the demo can be tried.
for (const [m, u] of [["POST", "/api/tickets"], ["PATCH", "/api/tickets/1"], ["POST", "/api/tickets/1/reply"], ["POST", "/api/tickets/1/note"], ["POST", "/api/ticket-timers/1/start"], ["POST", "/api/customers"], ["PATCH", "/api/customers/acme"], ["POST", "/api/alerts/1/ack"], ["POST", "/api/alerts/1/resolve"], ["POST", "/api/tags"], ["PUT", "/api/tags/devices/abc"], ["POST", "/api/kb/articles"], ["POST", "/api/billing/time"], ["POST", "/api/billing/invoices"], ["POST", "/api/reports/views"], ["PATCH", "/api/devices/abc/site"], ["POST", "/api/bulk/devices/tags"], ["PATCH", "/api/users/me"], ["POST", "/api/auth/logout"]]) check(`may ${m} ${u}`, v(m, u) === "write-ok");

// Tricks do not get round the rules.
for (const [m, u] of [["GET", "/API/ADMIN/DATABASE"], ["GET", "/api/admin/%64atabase"], ["GET", "/api/admin//database"], ["GET", "/api/customers/..%2fadmin/system"], ["GET", "/api/admin/database/"], ["POST", "/API/PROVISIONING/ENROLLMENT-KEYS"], ["POST", "/api/Tickets/1/Attachments"]]) check(`trick ${m} ${u}`, v(m, u) === "refuse");

// The demo's own routes and the web app's files are untouched.
check("demo routes pass", v("POST", "/api/demo/ping") === "pass");
check("web files pass", v("GET", "/_next/static/x.js") === "pass");
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
