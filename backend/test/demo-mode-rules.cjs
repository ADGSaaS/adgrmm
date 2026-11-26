// Checks the demo's rules: what a visitor may and may not do. Plain Node, no database: node test/demo-mode-rules.cjs
const path = require("node:path");
const { judge, decide } = require(path.join(__dirname, "..", "dist", "demo-mode", "demo-mode.rules.js"));
const { ROUTES, runFixture } = require(path.join(__dirname, "..", "dist", "demo-mode", "demo-fixtures.js"));
const { createDemoGate } = require(path.join(__dirname, "..", "dist", "demo-mode", "demo-gate.middleware.js"));
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };
const v = (m, u) => judge(m, u);

// Reading ordinary screens is fine.
for (const u of ["/api/customers", "/api/devices", "/api/tickets?status=open", "/api/alerts", "/api/billing/invoices", "/api/kb/articles", "/api/reports/views", "/api/users/me", "/api/auth/me", "/api/admin/audit-events", "/api/admin/users", "/api/admin/workflows"]) check(`read ${u}`, v("GET", u) === "pass");

// How the server is set up stays hidden: judge() refuses these reads, so the real controllers are never reached. The pages that show them get a SAMPLE instead (further down).
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

// ---------------------------------------------------------------------------------------------------------------------------
// Sample answers (demo-fixtures.ts): every administration page is viewable, with made-up data.
const fx = (m, u, body) => { const d = decide(m, u); return d.kind === "fixture" ? runFixture(d.hit, d.method, d.path, body) : null; };
const has = (o, ...keys) => !!o && typeof o === "object" && keys.every((k) => k in o);
const arr = (a) => Array.isArray(a);

// URL -> checker of the keys the page reads (found by reading each tab's component).
const SHAPES = {
    "/api/admin/email": (b) => has(b, "profiles", "dkim") && ["alerts", "invites", "password_resets", "reports", "tickets"].every((k) => has(b.profiles[k], "smtp", "imap", "pop", "enabled") && b.profiles[k].smtp.password === ""),
    "/api/support-mailbox": (b) => has(b, "enabled", "source", "imapReady", "tenantId", "clientId", "hasClientSecret", "connected", "mailboxAddress", "connectedAt", "lastPolledAt", "lastError", "lastErrorAt", "redirectUri"),
    "/api/admin/sso": (b) => has(b, "enabled", "displayName", "passwordLogin", "issuer", "clientId", "hasClientSecret", "scopes", "jitEnabled", "defaultRoleId", "allowedDomains", "redirectUri"),
    "/api/admin/import/jobs": (b) => arr(b.items) && b.items.every((j) => has(j, "id", "status", "host", "options", "preview", "progress", "errors", "message", "createdAt", "finishedAt") && has(j.preview, "agents", "companies", "contacts", "tickets") && arr(j.errors)),
    "/api/provisioning/enrollment-key-defaults": (b) => b.expiresMinutes >= 1,
    "/api/provisioning/enrollment-keys": (b) => arr(b.items) && b.items.every((k) => has(k, "id", "name", "clientName", "siteName", "createdAt", "createdBy", "expiresAt", "revokedAt", "lastUsedAt", "useCount", "status")),
    "/api/admin/diagnostics": (b) => arr(b.findings) && has(b, "app", "database", "disk", "agents", "tasks", "mailbox", "sso") && arr(b.disk) && arr(b.agents.byVersion) && has(b.database.migrations, "applied", "unfinished") && arr(b.app.loadAverage) && has(b.app.memoryMb, "rss") && has(b.app.systemMemoryMb, "total", "free"),
    "/api/admin/integrations": (b) => arr(b.items) && typeof b.checkedAt === "string" && b.items.every((c) => has(c, "key", "name", "description", "status", "statusLabel", "detail", "last", "link") && has(c.link, "label")),
    "/api/admin/webhooks": (b) => arr(b.items) && arr(b.events) && b.items.every((h) => has(h, "id", "name", "url", "events", "enabled", "format", "sends", "last", "pending", "failedLast24h", "deliveredLast24h") && arr(h.events)),
    "/api/admin/webhooks/abc/deliveries": (b) => arr(b.items) && b.items.every((d) => has(d, "id", "event", "status", "attempts", "responseStatus", "error", "createdAt", "deliveredAt", "nextAttemptAt")),
    "/api/admin/database": (b) => has(b, "enabled", "engine", "authMode", "ssl", "poolMin", "poolMax", "mappings") && ["users", "roles", "sessions", "audit_logs", "devices", "policies", "email_queue"].every((k) => k in b.mappings),
    "/api/admin/storage/connections": (b) => arr(b.items) && b.items.every((c) => has(c, "id", "name", "kind", "config", "meta", "health", "capabilities", "hasSecret") && arr(c.meta.tags)),
    "/api/admin/storage/connections/abc/dependents": (b) => arr(b.features),
    "/api/admin/backups/config": (b) => has(b, "backupKind", "enabled", "targets", "schedule", "retentionDays", "destination") && arr(b.targets) && arr(b.extraDestinations),
    "/api/admin/backups/permissions": (b) => has(b, "restore", "download"),
    "/api/admin/backups/history?status=success": (b) => arr(b.items) && b.items.length > 0 && b.items.every((r) => r.status === "success" && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(r.at) && has(r, "id", "backupKind", "sizeBytes", "durationSec")),
    "/api/admin/backups/next-runs?cron=0%203%20*%20*%20*&tz=UTC": (b) => arr(b.next) && b.next.length === 5,
    "/api/admin/backups/restores/abc": (b) => has(b, "id", "status", "verification"),
    "/api/admin/system": (b) => has(b, "generatedAt", "install", "app", "database", "disk", "agents") && has(b.install, "mode", "description") && arr(b.database.migrations.latest) && arr(b.database.migrations.rolledBack) && has(b.database, "approximateRows") && has(b.agents.packagesOnServer.windows, "version") && has(b.app, "arch", "timezone", "serverTime"),
    "/api/admin/system-health": (b) => has(b, "overall", "checkedAt", "checks", "events", "restores", "remoteSessions") && arr(b.checks) && b.checks.every((c) => has(c, "key", "title", "status", "detail", "since")) && arr(b.events) && arr(b.restores),
    "/api/admin/migrations": (b) => has(b, "generatedAt", "folderFound", "summary", "pending", "failed", "items") && arr(b.pending) && arr(b.failed) && b.items.every((m) => has(m, "name", "startedAt", "appliedAt", "appliedSteps", "state")) && b.items.length === b.summary.applied,
    "/api/admin/secrets-status": (b) => has(b, "generatedAt", "summary", "items") && b.items.length === b.summary.total && b.items.every((i) => has(i, "key", "category", "description", "set", "secret", "importance", "attention", "restartRequired", "configuredIn")),
    "/api/admin/sessions?limit=50&offset=0": (b) => typeof b.total === "number" && arr(b.items) && b.items.every((s) => has(s, "id", "userId", "email", "name", "roles", "userAgent", "ip", "createdAt", "lastSeenAt", "trusted", "current") && arr(s.roles)),
    "/api/admin/agent-settings": (b) => has(b, "installKeyExpiryMins", "autoUpdate", "updatesDisabledByServer", "packages") && arr(b.packages),
    "/api/admin/agent-releases": (b) => has(b, "autoUpdate", "updatesDisabledByServer", "rings", "systems", "recent", "canManage") && b.systems.every((s) => has(s, "os", "stable", "candidate", "previous", "candidateNotNewer", "ringCounts", "gate") && has(s.gate, "status", "message", "blockers", "pilotTotal")) && arr(b.recent),
    "/api/admin/tray": (b) => has(b, "enabled", "helpEnabled", "chatEnabled", "supportPhone", "supportEmail", "greeting", "providerName", "officeHours", "website", "contactName", "afterHoursPhone", "notice"),
    "/api/admin/demo": (b) => has(b, "enabled", "since", "counts") && has(b.counts, "customers", "sites", "devices", "tickets", "sessions", "assets"),
    "/api/portal-admin/settings": (b) => has(b, "enabled", "domain", "modules", "allowTicketCreate", "welcomeTitle", "welcomeText", "supportEmail", "supportPhone") && arr(b.modules),
    "/api/portal-admin/accounts": (b) => arr(b) && b.every((a) => has(a, "id", "clientId", "clientName", "contactId", "email", "name", "role", "status", "lastLoginAt")),
};
for (const [u, ok] of Object.entries(SHAPES)) {
    const r = fx("GET", u);
    check(`sample GET ${u} is 200 with the shape the page reads`, !!r && (r.status ?? 200) === 200 && ok(r.body));
}
// File samples: CSV exports, import templates, installer script, agent package.
for (const k of ["customers", "sites", "contacts", "devices", "users", "tickets"]) { const r = fx("GET", `/api/admin/data/export/${k}?from=2026-01-01`); check(`sample export ${k} is a CSV`, !!r && /csv/.test(r.contentType) && r.body.split("\n")[0].includes(",")); }
for (const k of ["customers", "sites", "contacts"]) { const r = fx("GET", `/api/admin/data/import/${k}/template`); check(`sample template ${k} is a CSV`, !!r && /csv/.test(r.contentType)); }
check("no sample for import templates of other kinds", fx("GET", "/api/admin/data/import/users/template") === null);
check("diagnostics download is refused", (fx("GET", "/api/admin/diagnostics?download=1") || {}).status === 403);
{ const r = fx("GET", "/api/provisioning/installer-bundles/demo-windows/download?token=x"); check("sample installer script does nothing and says so", !!r && /does nothing/i.test(r.body) && !/enroll(ment)?[-_ ]?key\s*[:=]/i.test(r.body)); }
{ const r = fx("GET", "/api/provisioning/installer-bundles/demo-linux/download?token=x"); check("sample linux installer is a demo script", !!r && /^#!\/bin\/sh/.test(r.body) && /does nothing/i.test(r.body)); }
{ const r = fx("GET", "/api/provisioning/agent-packages/windows"); check("sample agent package is a text file", !!r && /text\/plain/.test(r.contentType) && /demo/i.test(r.body)); }
{ const r = fx("GET", "/api/admin/sessions?limit=50&offset=0&search=sam"); check("sessions search works on the sample", r.body.total === 1 && r.body.items[0].email.startsWith("sam.")); }
{ const r = fx("GET", "/api/portal-admin/accounts?clientId=real-customer-id"); check("portal accounts of one real customer: none of the samples", arr(r.body) && r.body.length === 0); }

// The install flow completes on screen with sample values, and makes nothing.
{
    const k = fx("POST", "/api/provisioning/enrollment-keys", { clientId: "c1", siteId: "s1", name: "Test", expiresMinutes: 60 });
    check("sample install key", !!k && has(k.body, "enrollmentKey", "tokenId", "expiresAt", "clientId", "siteId", "name") && /^demo-only/.test(k.body.enrollmentKey) && k.body.clientId === "c1" && k.body.name === "Test");
    check("install key needs a site", fx("POST", "/api/provisioning/enrollment-keys", { clientId: "c1" }).status === 400);
    const b = fx("POST", "/api/provisioning/installer-bundles", { os: "windows", enrollmentKey: k.body.enrollmentKey });
    check("sample installer (windows)", has(b.body, "url", "filename", "expiresAt", "bundleId", "installCommand") && b.body.installCommand === `powershell -NoProfile -Command "iex (irm 'https://demo.invalid/install/DEMO-ONLY')"` && /\/download\?token=DEMO-ONLY$/.test(b.body.url) && !JSON.stringify(b.body).includes(k.body.enrollmentKey));
    const l = fx("POST", "/api/provisioning/installer-bundles", { os: "linux", enrollmentKey: "x", onlyIfMissing: true });
    check("sample installer (linux, group policy)", /demo\.invalid/.test(l.body.installCommand) && l.body.onlyIfMissing === true);
    check("no sample installer for macos or without a key", fx("POST", "/api/provisioning/installer-bundles", { os: "macos", enrollmentKey: "x" }).status === 400 && fx("POST", "/api/provisioning/installer-bundles", { os: "linux" }).status === 400);
    const e = fx("POST", "/api/provisioning/endpoints", { clientId: "c1", siteId: "s1", os: "windows", deviceId: "d1", alias: "a", expiresMinutes: 30 });
    check("sample endpoint", has(e.body, "deviceId", "enrollmentSecret", "expiresAt") && /^demo-only/.test(e.body.enrollmentSecret));
}

// Only reads have a sample, apart from the three "make" calls; every write elsewhere on those routes stays refused.
const MAKE = new Set(["/api/provisioning/enrollment-keys", "/api/provisioning/installer-bundles", "/api/provisioning/endpoints"]);
for (const r of ROUTES) check(`route ${r.method} ${r.re.source} is a read or a known "make" call`, r.method === "GET" || (r.method === "POST" && MAKE.has(r.re.source.replace(/\\\//g, "/").replace(/^\^|\$$/g, ""))));
for (const u of Object.keys(SHAPES)) {
    const plain = u.split("?")[0];
    for (const m of ["PUT", "PATCH", "DELETE"]) check(`${m} ${plain} stays refused`, decide(m, plain).kind === "refuse");
    if (!MAKE.has(plain)) check(`POST ${plain} stays refused`, decide("POST", plain).kind === "refuse");
    check(`judge still refuses GET ${plain} (the real controller is never reached)`, v("GET", plain) === "refuse");
}
for (const [m, u] of [["PUT", "/api/admin/sso"], ["POST", "/api/admin/sso/test"], ["PUT", "/api/support-mailbox"], ["POST", "/api/support-mailbox/connect"], ["POST", "/api/admin/email/save"], ["POST", "/api/admin/email/send-test"], ["POST", "/api/admin/database/save"], ["POST", "/api/admin/storage/connections"], ["POST", "/api/admin/storage/test"], ["PUT", "/api/admin/backups/config"], ["POST", "/api/admin/backups/run"], ["POST", "/api/admin/backups/abc/restore"], ["GET", "/api/admin/backups/abc/download"], ["GET", "/api/admin/backups/abc/log"], ["GET", "/api/admin/backups/abc/manifest"], ["POST", "/api/admin/sessions/user/abc/revoke"], ["DELETE", "/api/admin/sessions/abc"], ["PUT", "/api/admin/agent-settings"], ["POST", "/api/admin/agent-releases/promote"], ["POST", "/api/admin/webhooks"], ["POST", "/api/admin/webhooks/abc/test"], ["POST", "/api/provisioning/enrollment-keys/abc/revoke"], ["PATCH", "/api/provisioning/enrollment-keys/abc"], ["POST", "/api/admin/import/freshdesk/preview"], ["POST", "/api/admin/data/import/customers"], ["PUT", "/api/admin/flags/x"], ["PUT", "/api/portal-admin/settings"], ["POST", "/api/portal-admin/accounts"], ["POST", "/api/admin/demo/enable"], ["GET", "/api/admin/environment"], ["GET", "/api/admin/data/export/secrets"], ["GET", "/api/admin/tray/extra"], ["GET", "/api/admin/sso/extra"]]) check(`still refused ${m} ${u}`, decide(m, u).kind === "refuse");

// Agents can never enroll, and nothing else reaches a real installer or package.
for (const [m, u] of [["POST", "/api/agent/enroll"], ["POST", "/api/agents/enroll"], ["POST", "/api/agent/heartbeat"], ["GET", "/api/agent/updates/windows"], ["GET", "/api/provisioning/installer-bundles"], ["GET", "/api/provisioning/installer-bundles/abc"], ["GET", "/api/provisioning/installer-bundles/abc/def/download"], ["GET", "/api/provisioning/agent-packages"], ["GET", "/api/provisioning/agent-packages/windows/extra"]]) check(`never real ${m} ${u}`, decide(m, u).kind === "refuse");
for (const u of ["/api/provisioning/installer-bundles/..%2fenrollment-keys/download", "/api/provisioning/installer-bundles/../download", "/api/admin/system%00", "/api/admin//system"]) check(`trick GET ${u} is refused`, decide("GET", u).kind === "refuse");
check("encoded letters never reach the real handler", decide("GET", "/api/admin/%73ystem").kind !== "pass");
check("trailing slash and upper case still get the sample, not the real one", decide("GET", "/API/ADMIN/SYSTEM/").kind === "fixture");

// No real value leaks: the samples are built without reading the environment, and every address in them is made up.
{
    process.env.DATABASE_URL = "postgresql://leakcheck:s3cr3t-leak-value@real-db.example.net:5432/real";
    process.env.JWT_SECRET = "jwt-leak-check-value-123456";
    const everything = JSON.stringify(Object.keys(SHAPES).map((u) => fx("GET", u)));
    const more = ["/api/provisioning/installer-bundles/demo-windows/download", "/api/provisioning/agent-packages/linux", "/api/admin/data/export/users", "/api/admin/data/export/devices"].map((u) => fx("GET", u).body).join("\n");
    const blob = everything + more;
    check("no DATABASE_URL in the samples", !blob.includes("s3cr3t-leak-value") && !blob.includes("real-db.example.net") && !blob.includes("leakcheck"));
    check("no JWT secret in the samples", !blob.includes("jwt-leak-check-value"));
    const envValues = Object.entries(process.env).filter(([k, val]) => val && val.length >= 10 && !/^(PATH|PATHEXT|PROCESSOR_IDENTIFIER|COMSPEC|OS|USERNAME|USERDOMAIN|COMPUTERNAME|SystemRoot|windir)$/i.test(k) && /[A-Za-z]/.test(val) && /[^\w ]/.test(val)).map(([, val]) => val);
    check("no environment value (10+ chars) appears in the samples", envValues.every((val) => !blob.includes(val)));
    const hosts = [...blob.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
    const badHosts = hosts.filter((h) => !h.endsWith(".invalid") && h !== "login.microsoftonline.com");
    check(`every web address in the samples is made up (${hosts.length} checked)${badHosts.length ? ": " + badHosts.join(",") : ""}`, badHosts.length === 0);
    const mails = [...blob.matchAll(/[\w.+-]+@([a-z0-9.-]*[a-z0-9])/gi)].map((m) => m[1].toLowerCase());
    const badMail = mails.filter((h) => !h.endsWith(".invalid"));
    check(`every email address in the samples is made up (${mails.length} checked)${badMail.length ? ": " + badMail.join(",") : ""}`, badMail.length === 0);
    check("no private-looking key material", !/BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{12,}|xox[bp]-/.test(blob));
    delete process.env.DATABASE_URL; delete process.env.JWT_SECRET;
}

// The real gate, end to end on a throwaway server: samples are answered by the gate, the "real" handler behind it is never reached for them.
async function gateTests() {
    const express = require("express");
    const app = express();
    let dirty = 0;
    app.use(createDemoGate({ markDirty: () => { dirty++; } }));
    app.use((req, res) => res.status(200).json({ real: true, path: req.path }));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, url, body) => fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, type: r.headers.get("content-type") || "", disp: r.headers.get("content-disposition") || "", text: await r.text() }));
    try {
        let r = await call("GET", "/api/admin/system");
        check("gate: GET /api/admin/system is the sample, not the real handler", r.status === 200 && /json/.test(r.type) && !r.text.includes('"real":true') && JSON.parse(r.text).install.mode === "docker");
        r = await call("GET", "/api/admin/environment"); check("gate: GET /api/admin/environment is refused", r.status === 403 && JSON.parse(r.text).demo === true);
        r = await call("POST", "/api/admin/database/save", { a: 1 }); check("gate: POST /api/admin/database/save is refused with the friendly message", r.status === 403 && /switched off in the demo/.test(r.text));
        r = await call("GET", "/api/customers"); check("gate: ordinary reads reach the app", r.status === 200 && r.text.includes('"real":true'));
        r = await call("POST", "/api/provisioning/enrollment-keys", { clientId: "c1", siteId: "s1", name: "From a visitor" });
        check("gate: install key is a sample echoing the chosen site", r.status === 200 && JSON.parse(r.text).siteId === "s1" && /^demo-only/.test(JSON.parse(r.text).enrollmentKey));
        r = await call("POST", "/api/provisioning/installer-bundles", { os: "windows", enrollmentKey: "demo-only-not-a-real-key-0000" });
        check("gate: installer is a sample command", r.status === 200 && JSON.parse(r.text).installCommand.includes("https://demo.invalid/install/DEMO-ONLY"));
        r = await call("GET", JSON.parse(r.text).url);
        check("gate: installer download is a text file that says it is a demo", r.status === 200 && /attachment; filename=/.test(r.disp) && /does nothing/i.test(r.text));
        r = await call("POST", "/api/provisioning/enrollment-keys", undefined); check("gate: install key without a body is a 400, not a crash", r.status === 400);
        r = await call("POST", "/api/agent/enroll", { x: 1 }); check("gate: agent enroll is refused", r.status === 403);
        r = await call("GET", "/api/admin/diagnostics?download=1"); check("gate: diagnostics download is refused", r.status === 403);
        r = await call("GET", "/api/admin/backups/x/download"); check("gate: backup download is refused", r.status === 403);
        check("gate: samples do not mark the demo dirty", dirty === 0);
    } finally { server.close(); }
}

gateTests().then(() => {
    console.log(failed ? `\n${failed} FAILED` : "\nall passed");
    process.exit(failed ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
