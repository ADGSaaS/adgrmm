// backend/src/demo-mode/demo-fixtures.ts
//
// Sample answers for the administration pages that would otherwise show how the real server is set up (its database, disk, mail
// logins, storage, backups, sessions, install keys, ...). In the public demo the gate (demo-gate.middleware.ts) answers these routes
// from here BEFORE any real controller runs, so nothing real is read: this file never touches process.env, the file system or the
// database, and every host, key, address and number in it is made up. Hosts end in ".invalid" (they can never resolve).
//
// Only the exact routes listed in ROUTES are answered. Anything else keeps the rules in demo-mode.rules.ts. Reads return a sample;
// the few POSTs that "make" something (install key, installer, endpoint) return a sample too, so the flow can be walked through on
// screen, but they create nothing: no row is written, no real key, token, script or package exists.

export type FixtureReply = { status?: number; body: unknown; contentType?: string; headers?: Record<string, string> };
export type FixtureCtx = { method: string; path: string; query: URLSearchParams; body: unknown };
type Route = { method: "GET" | "POST"; re: RegExp; needsBody?: boolean; reply: (c: FixtureCtx, m: RegExpExecArray) => FixtureReply };

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const json = (body: unknown, status = 200): FixtureReply => ({ status, body });
const text = (body: string, contentType: string, filename?: string): FixtureReply => ({
    body, contentType, headers: filename ? { "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } : { "Cache-Control": "no-store" },
});
const str = (v: unknown, max = 120): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bad = (message: string): FixtureReply => json({ statusCode: 400, message, demo: true }, 400);

// The fake "free text" that marks every value here as a sample.
const DEMO_KEY = "demo-only-not-a-real-key";

/* ------------------------------ Email (SMTP) ------------------------------ */

function emailProfile(over: { fromAddress: string; imap?: boolean; enabled?: boolean }) {
    return {
        enabled: over.enabled ?? true,
        smtp: { host: "smtp.demo.invalid", port: 587, username: "demo-relay", password: "", useTLS: true, useSSL: false, fromAddress: over.fromAddress },
        imap: over.imap
            ? { host: "imap.demo.invalid", port: 993, username: "support@demo-msp.invalid", password: "", useSSL: true }
            : { host: "", port: "", username: "", password: "", useSSL: true },
        pop: { host: "", port: "", username: "", password: "", useSSL: true },
    };
}
const emailConfig = () => ({
    profiles: {
        alerts: emailProfile({ fromAddress: "alerts@demo-msp.invalid" }),
        invites: emailProfile({ fromAddress: "welcome@demo-msp.invalid" }),
        password_resets: emailProfile({ fromAddress: "no-reply@demo-msp.invalid" }),
        reports: emailProfile({ fromAddress: "reports@demo-msp.invalid" }),
        tickets: emailProfile({ fromAddress: "support@demo-msp.invalid", imap: true }),
    },
    dkim: { domain: "demo-msp.invalid", selector: "demo1", publicKey: "v=DKIM1; k=rsa; p=DEMO-SAMPLE-PUBLIC-KEY-NOT-REAL", status: "valid", lastCheckedAt: ago(3 * HOUR), lastResult: "Sample result: the record matches (demo)." },
    lastUpdated: ago(12 * DAY),
});

/* ------------------------------ Support mailbox, SSO ------------------------------ */

const supportMailbox = () => ({
    enabled: true, source: "microsoft", imapReady: true,
    tenantId: "00000000-0000-0000-0000-00000000d3a0", clientId: "00000000-0000-0000-0000-00000000c11e", hasClientSecret: true,
    connected: true, mailboxAddress: "support@demo-msp.invalid", connectedAt: ago(40 * DAY), lastPolledAt: ago(MIN), lastError: null, lastErrorAt: null,
    redirectUri: "https://demo.invalid/api/support-mailbox/callback",
});
const sso = () => ({
    enabled: false, displayName: "Demo single sign-on", passwordLogin: true,
    issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-00000000d3a0/v2.0", clientId: "00000000-0000-0000-0000-00000000c11e", hasClientSecret: true,
    scopes: "openid profile email", jitEnabled: true, defaultRoleId: null, allowedDomains: "demo-msp.invalid",
    redirectUri: "https://demo.invalid/api/auth/sso/callback",
});

/* ------------------------------ Helpdesk import ------------------------------ */

const importJob = () => ({
    id: "00000000-0000-4000-8000-0000000010b1", status: "completed", host: "demo-msp.freshdesk.invalid",
    options: { contacts: true, tickets: true, attachments: true, time: true },
    preview: {
        agents: { total: 6, matched: 5, unmatched: ["former.tech@demo-msp.invalid"] },
        companies: { total: 14, matched: 14, unmatched: [] },
        contacts: { total: 62 },
        tickets: { total: 420, alreadyImported: 0, byStatus: { Open: 18, Pending: 7, Resolved: 120, Closed: 275 }, unknownStatus: 0, firstCreatedAt: ago(700 * DAY), lastCreatedAt: ago(30 * DAY) },
    },
    progress: { phase: "done", contacts: { done: 62, skipped: 0, failed: 0 }, tickets: { total: 420, done: 418, skipped: 0, failed: 2 }, replies: 1730, notes: 412, attachments: { saved: 96, failed: 1 }, time: { done: 233, skipped: 0 } },
    errors: [{ kind: "ticket", id: "10412", message: "Sample problem: this ticket had no requester (demo)." }],
    message: null, createdAt: ago(35 * DAY), finishedAt: ago(35 * DAY - 22 * MIN),
});

/* ------------------------------ Install keys, installers (provisioning) ------------------------------ */

const FAKE_ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const installKeys = () => ({
    items: [
        { id: FAKE_ID(9001), name: "Front office PCs", clientName: "Sample Customer A", siteName: "Head office", createdAt: ago(20 * DAY), createdBy: "Demo Admin", expiresAt: ahead(10 * 365 * DAY), revokedAt: null, lastUsedAt: ago(2 * DAY), useCount: 14, status: "active" },
        { id: FAKE_ID(9002), name: "Warehouse laptops", clientName: "Sample Customer B", siteName: "Warehouse", createdAt: ago(9 * DAY), createdBy: "Demo Admin", expiresAt: ahead(5 * DAY), revokedAt: null, lastUsedAt: ago(8 * DAY), useCount: 3, status: "active" },
        { id: FAKE_ID(9003), name: "Spring rollout (finished)", clientName: "Sample Customer A", siteName: "Branch office", createdAt: ago(120 * DAY), createdBy: "Demo Admin", expiresAt: ago(90 * DAY), revokedAt: null, lastUsedAt: ago(100 * DAY), useCount: 8, status: "expired" },
        { id: FAKE_ID(9004), name: "Old trial key", clientName: "Sample Customer C", siteName: "Main site", createdAt: ago(200 * DAY), createdBy: "Demo Admin", expiresAt: ahead(160 * DAY), revokedAt: ago(150 * DAY), lastUsedAt: null, useCount: 0, status: "revoked" },
    ],
});

const DEMO_NOTICE_PS1 = [
    "# ADG RMM demo: this is a SAMPLE installer script. It does nothing.",
    "# The public demo cannot add devices. Nothing here downloads or installs an agent, and no enrollment key is inside it.",
    "Write-Host 'This is the ADG RMM demo. No agent was installed.'",
    "",
].join("\r\n");
const DEMO_NOTICE_SH = [
    "#!/bin/sh",
    "# ADG RMM demo: this is a SAMPLE installer script. It does nothing.",
    "# The public demo cannot add devices. Nothing here downloads or installs an agent, and no enrollment key is inside it.",
    "echo 'This is the ADG RMM demo. No agent was installed.'",
    "",
].join("\n");

function createKey(c: FixtureCtx): FixtureReply {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const clientId = str(b.clientId, 64), siteId = str(b.siteId, 64);
    if (!clientId) return bad("clientId is required");
    if (!siteId) return bad("siteId is required");
    const mins = Number(b.expiresMinutes ?? 10080);
    if (!Number.isFinite(mins) || mins < 1 || mins > 5_259_600) return bad("expiresMinutes must be between 1 and 5259600 (10 years)");
    return json({ enrollmentKey: `${DEMO_KEY}-0000`, tokenId: FAKE_ID(9100), expiresAt: ahead(Math.floor(mins) * MIN), clientId, siteId, name: str(b.name) || null });
}
function createBundle(c: FixtureCtx): FixtureReply {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const os = str(b.os, 12);
    if (os !== "windows" && os !== "linux") return bad("No agent is available for that system in the demo.");
    if (!str(b.enrollmentKey, 200)) return bad("enrollmentKey is required");
    const only = b.onlyIfMissing === true;
    const label = str(b.label, 40).replace(/[^a-zA-Z0-9-_]+/g, "-");
    const ext = os === "windows" ? "ps1" : "sh";
    const filename = `AdgRmm-Installer-Demo${only ? "-GPO" : ""}${label ? `-${label}` : ""}-${os === "windows" ? "Windows" : "Linux"}.${ext}`;
    const installCommand = os === "windows"
        ? `powershell -NoProfile -Command "iex (irm 'https://demo.invalid/install/DEMO-ONLY')"`
        : `curl -fsSL 'https://demo.invalid/install/DEMO-ONLY' | sudo bash`;
    return json({
        bundleId: FAKE_ID(os === "windows" ? 9201 : 9202), url: `/api/provisioning/installer-bundles/demo-${os}/download?token=DEMO-ONLY`,
        filename, expiresAt: ahead(7 * DAY), os, clientId: str(b.clientId, 64) || FAKE_ID(9301), siteId: str(b.siteId, 64) || FAKE_ID(9302), installCommand, onlyIfMissing: only,
    });
}
function createEndpoint(c: FixtureCtx): FixtureReply {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const deviceId = str(b.deviceId, 64);
    if (!deviceId) return bad("deviceId is required");
    if (!str(b.clientId, 64) || !str(b.siteId, 64)) return bad("clientId and siteId are required");
    const mins = Number(b.expiresMinutes ?? 30);
    return json({ deviceId, enrollmentSecret: `${DEMO_KEY}-secret`, expiresAt: ahead((Number.isFinite(mins) && mins >= 1 && mins <= 1440 ? Math.floor(mins) : 30) * MIN), installUrl: "https://demo.invalid/install/DEMO-ONLY" });
}

/* ------------------------------ Diagnostics, System, health, migrations, secrets ------------------------------ */

const DISKS = [
    { label: "application", totalGb: 120, freeGb: 74.2, freePercent: 61.8 },
    { label: "database", totalGb: 200, freeGb: 133.5, freePercent: 66.8 },
    { label: "backups", totalGb: 500, freeGb: 351.9, freePercent: 70.4 },
];
const appInfo = () => ({ packageVersion: "0.2.0", commit: "demo0000", node: "v22.0.0", platform: "linux", arch: "x64", nodeEnv: "production", uptimeSeconds: 9 * DAY / 1000 + 5400, serverTime: new Date().toISOString(), timezone: "UTC", memoryMb: { rss: 412 }, systemMemoryMb: { total: 8192, free: 3170 }, cpus: 4, loadAverage: [0.31, 0.27, 0.22] });
const MIGRATION_NAMES = [
    "20260114093000_initial_schema", "20260121141500_tickets_and_queues", "20260203101000_billing_invoices", "20260217120000_alerts_and_checks",
    "20260305154500_reports_and_schedules", "20260322090000_client_portal", "20260409113000_knowledge_base", "20260502100000_workflows",
    "20260519133000_install_keys_and_agents", "20260611084500_asset_provider", "20260704120000_system_health", "20260821100000_webhooks",
];
const diagnostics = () => ({
    generatedAt: new Date().toISOString(),
    findings: [
        { level: "info", area: "demo", message: "This is a sample report. The public demo never reads the real server." },
        { level: "warning", area: "backups", message: "The newest backup is 31 hours old (sample finding)." },
        { level: "info", area: "agents", message: "3 devices have not been seen for a day (sample finding)." },
    ],
    app: (() => { const a = appInfo(); return { packageVersion: a.packageVersion, commit: a.commit, node: a.node, platform: a.platform, nodeEnv: a.nodeEnv, uptimeSeconds: a.uptimeSeconds, memoryMb: a.memoryMb, systemMemoryMb: a.systemMemoryMb, cpus: a.cpus, loadAverage: a.loadAverage }; })(),
    database: { version: "PostgreSQL 16.4 (demo)", sizeMb: 842, connections: 14, migrations: { applied: MIGRATION_NAMES.length, unfinished: [] as string[] } },
    disk: DISKS,
    agents: { total: 24, online: 21, notSeenForADay: 3, byVersion: [{ version: "1.3.46", agents: 20, online: 18 }, { version: "1.3.39", agents: 4, online: 3 }] },
    tasks: { byStatus: { completed: 1840, pending: 2, failed: 5 }, oldestPendingMinutes: 1 },
    mailbox: { configured: true, enabled: true, source: "microsoft", connected: true, lastPolledAt: ago(MIN), lastError: null },
    sso: { configured: true, enabled: false, providerHost: "login.demo.invalid" },
});
const systemInfo = () => ({
    generatedAt: new Date().toISOString(),
    install: { mode: "docker", description: "In a container (sample)" },
    app: appInfo(),
    database: {
        version: "PostgreSQL 16.4 (demo)", sizeMb: 842, connections: 14,
        migrations: { applied: MIGRATION_NAMES.length, unfinished: [] as string[], rolledBack: [] as string[], latest: MIGRATION_NAMES.slice(-3).reverse().map((name, i) => ({ name, finishedAt: ago((20 + i * 30) * DAY) })) },
        approximateRows: { devices: 24, tickets: 420, alerts: 1260, audit_events: 18400, device_software: 5200 },
    },
    disk: DISKS,
    agents: { total: 24, online: 21, notSeenForADay: 3, packagesOnServer: { windows: { version: "1.3.46" }, linux: { version: "1.3.46" } } },
});
const systemHealth = () => ({
    overall: "ok", checkedAt: new Date().toISOString(),
    checks: [
        { key: "database", title: "Database", status: "ok", detail: "Answers in 4 ms.", since: null },
        { key: "disk", title: "Disk space", status: "ok", detail: "The fullest disk has 62% free.", since: null },
        { key: "memory", title: "Memory", status: "ok", detail: "61% of memory is free.", since: null },
        { key: "queue", title: "Job queue", status: "ok", detail: "2 tasks waiting, the oldest for 1 minute.", since: null },
        { key: "backups", title: "Backups", status: "ok", detail: "The newest backup finished 7 hours ago.", since: null },
        { key: "restore_test", title: "Monthly restore test", status: "ok", detail: "Last passed 12 days ago.", since: null },
    ],
    events: [
        { check: "Backups", from: "warn", to: "ok", detail: "The newest backup finished.", at: ago(7 * HOUR) },
        { check: "Disk space", from: "ok", to: "warn", detail: "Sample: the backup disk had 9% free.", at: ago(40 * DAY) },
    ],
    remoteSessions: { days: 30, sessions: 48, relayed: 12, relayGigabytes: 3.4, freeAllowanceGigabytes: 1000 },
    restores: [{ id: FAKE_ID(9401), status: "completed", requestedAt: ago(12 * DAY), finishedAt: ago(12 * DAY - 9 * MIN), error: null, verification: { verified: true, productionDatabaseChanged: false } }],
});
const migrations = () => ({
    generatedAt: new Date().toISOString(), folderFound: true,
    summary: { applied: MIGRATION_NAMES.length, pending: 0, failed: 0, latest: MIGRATION_NAMES[MIGRATION_NAMES.length - 1] },
    pending: [] as string[], failed: [] as string[],
    items: MIGRATION_NAMES.map((name, i) => ({ name, startedAt: ago((MIGRATION_NAMES.length - i) * 22 * DAY), appliedAt: ago((MIGRATION_NAMES.length - i) * 22 * DAY - 4000), appliedSteps: 1 + (i % 3), state: "applied" })).reverse(),
});
const SECRET_ROWS: [string, string, string, boolean, "required" | "recommended" | "optional", boolean, string][] = [
    ["DATABASE_URL", "Database", "How the server reaches its database.", true, "required", true, "the server's environment"],
    ["JWT_SECRET", "Security", "Signs sign-in cookies.", true, "required", true, "the server's environment"],
    ["AUTH_COOKIE_NAME", "Security", "Name of the sign-in cookie.", false, "optional", false, "the server's environment"],
    ["ADMIN_API_KEY", "Security", "Break-glass administrator key (leave unset to disable).", false, "optional", true, "the server's environment"],
    ["FRONTEND_ORIGINS", "Network", "Web addresses of the console, for cross-site requests.", false, "required", true, "the server's environment"],
    ["PUBLIC_API_BASE_URL", "Network", "The public address of this server, used in installer commands.", false, "recommended", true, "the server's environment"],
    ["SMTP_RATE_TOKENS", "Email", "How many test emails a minute may be sent.", false, "optional", false, "the server's environment"],
    ["CREDENTIAL_ENCRYPTION_KEY", "Security", "Encrypts saved mail and storage logins.", true, "required", true, "the server's environment"],
    ["BACKUP_ENCRYPTION_KEY", "Backups", "Encrypts backup files.", true, "recommended", true, "the server's environment"],
    ["STRIPE_SECRET_KEY", "Billing", "Takes card payments for invoices.", true, "optional", false, "the server's environment"],
    ["STRIPE_WEBHOOK_SECRET", "Billing", "Checks that payment messages are genuine.", true, "optional", false, "the server's environment"],
    ["TURN_SERVER_URL", "Remote tools", "Relay for remote sessions that cannot connect directly.", false, "optional", false, "the server's environment"],
    ["TURN_SHARED_SECRET", "Remote tools", "Shared secret for the relay.", true, "optional", false, "the server's environment"],
    ["PUBLIC_REGISTRATION", "Security", "Whether anyone may make an account.", false, "optional", true, "the server's environment"],
];
const secretsStatus = () => {
    // Every row is a sample: "set" is made up here, no real setting is looked at.
    const items = SECRET_ROWS.map(([key, category, description, secret, importance, set, configuredIn]) => ({ key, category, description, set, secret, importance, attention: !set && importance !== "optional", restartRequired: true, configuredIn }));
    return { generatedAt: new Date().toISOString(), summary: { total: items.length, set: items.filter((i) => i.set).length, unset: items.filter((i) => !i.set).length, secretsSet: items.filter((i) => i.set && i.secret).length, needAttention: items.filter((i) => i.attention).length }, items };
};

/* ------------------------------ Integrations, webhooks ------------------------------ */

const integrations = () => ({
    checkedAt: new Date().toISOString(),
    items: [
        { key: "email", name: "Outbound email", description: "Sends alerts, invitations, reports and ticket replies.", status: "ok", statusLabel: "Working", detail: "Sends through smtp.demo.invalid.", last: { at: ago(25 * MIN), ok: true, message: "Sent (sample)." }, link: { label: "Open email settings", tab: "smtp" } },
        { key: "mailbox", name: "Support mailbox", description: "Turns incoming mail into tickets.", status: "ok", statusLabel: "Working", detail: "Reading support@demo-msp.invalid.", last: { at: ago(MIN), ok: true, message: "Checked, nothing new (sample)." }, link: { label: "Open support mailbox", tab: "mailbox" } },
        { key: "sso", name: "Single sign-on", description: "Lets people sign in with the company's identity provider.", status: "off", statusLabel: "Off", detail: null, last: null, link: { label: "Open single sign-on", tab: "sso" } },
        { key: "storage", name: "Storage", description: "Where backups and exports can be kept.", status: "ok", statusLabel: "Working", detail: "2 connections, both healthy.", last: { at: ago(3 * HOUR), ok: true, message: "Test passed (sample)." }, link: { label: "Open storage", tab: "storage" } },
        { key: "backups", name: "Backups", description: "Scheduled copies of this system's data.", status: "attention", statusLabel: "Needs a look", detail: "The newest backup is 31 hours old (sample).", last: { at: ago(31 * HOUR), ok: true, message: "Finished (sample)." }, link: { label: "Open backups", tab: "backups" } },
        { key: "webhooks", name: "Webhooks", description: "Tell other tools when something happens.", status: "ok", statusLabel: "Working", detail: "2 webhooks on.", last: { at: ago(2 * HOUR), ok: true, message: "Delivered (sample)." }, link: { label: "Open webhooks", href: "#webhooks" } },
        { key: "payments", name: "Online payments", description: "Lets customers pay invoices by card.", status: "off", statusLabel: "Not set up", detail: null, last: null, link: { label: "Open billing", tab: "billing" } },
    ],
});
const WEBHOOK_EVENTS = [
    { key: "alert.created", label: "An alert is raised", description: "A check or monitor found a problem." },
    { key: "alert.resolved", label: "An alert clears", description: "The problem is gone." },
    { key: "ticket.created", label: "A ticket is opened", description: "A person or an email opened a ticket." },
    { key: "ticket.closed", label: "A ticket is closed", description: "A ticket was marked closed." },
    { key: "device.offline", label: "A device goes offline", description: "A device has not been seen for a while." },
];
const webhooks = () => ({
    events: WEBHOOK_EVENTS,
    items: [
        { id: FAKE_ID(9501), name: "Ops channel (Slack)", url: "https://hooks.slack.demo.invalid/services/T000/B000/DEMO", events: ["alert.created", "alert.resolved", "device.offline"], enabled: true, format: "auto", sends: "slack", last: { status: "delivered", event: "alert.created", at: ago(2 * HOUR), responseStatus: 200, error: null }, pending: 0, failedLast24h: 0, deliveredLast24h: 9 },
        { id: FAKE_ID(9502), name: "Automation service", url: "https://automation.demo.invalid/hooks/rmm", events: ["ticket.created", "ticket.closed"], enabled: true, format: "adgrmm", sends: "adgrmm", last: { status: "failed", event: "ticket.created", at: ago(5 * HOUR), responseStatus: 503, error: "The address answered 503 (sample)" }, pending: 1, failedLast24h: 2, deliveredLast24h: 14 },
    ],
});
const deliveries = () => ({
    items: [
        { id: FAKE_ID(9601), event: "alert.created", status: "delivered", attempts: 1, responseStatus: 200, error: null, createdAt: ago(2 * HOUR), deliveredAt: ago(2 * HOUR - 800), nextAttemptAt: null },
        { id: FAKE_ID(9602), event: "alert.resolved", status: "delivered", attempts: 1, responseStatus: 200, error: null, createdAt: ago(6 * HOUR), deliveredAt: ago(6 * HOUR - 700), nextAttemptAt: null },
        { id: FAKE_ID(9603), event: "ticket.created", status: "pending", attempts: 2, responseStatus: 503, error: "The address answered 503 (sample)", createdAt: ago(5 * HOUR), deliveredAt: null, nextAttemptAt: ahead(30 * MIN) },
    ],
});

/* ------------------------------ Database, storage, backups ------------------------------ */

const databaseConfig = () => ({
    enabled: true, engine: "postgresql", authMode: "fields", host: "demo-db.internal.invalid", port: 5432, dbName: "adgrmm_demo", username: "adgrmm_demo", password: "",
    ssl: true, poolMin: 2, poolMax: 20, readReplicas: "",
    mappings: { users: "users", roles: "roles", sessions: "sessions", audit_logs: "audit_events", devices: "devices", policies: "policies", email_queue: "email_queue" },
});
const STORAGE = [
    {
        id: FAKE_ID(9701), name: "Demo S3 backups", kind: "s3",
        config: { provider: "aws", region: "us-east-1", bucket: "demo-msp-backups", prefix: "adgrmm/", pathStyle: false, sse: "AES256", sessionDurationSec: 3600, bucketLifecycleSummary: "Sample: keeps 30 days." },
        meta: { environment: "prod", tags: ["backups", "demo"], defaultFor: { backups: true, exports: false, artifacts: false }, compression: "gzip", encryptionAtRest: true, concurrency: 4, createdBy: "Demo Admin", updatedBy: "Demo Admin", createdAt: ago(90 * DAY), updatedAt: ago(30 * DAY) },
        health: { status: "healthy", lastCheckedAt: ago(3 * HOUR), lastResult: "Sample: write, read and delete worked." },
        capabilities: { canUse: true, canEdit: true, canRotate: true, canDelete: true },
        hasSecret: { s3Credentials: true },
    },
    {
        id: FAKE_ID(9702), name: "Demo SFTP archive", kind: "sftp",
        config: { host: "archive.demo.invalid", port: 22, username: "demo-archive", path: "/srv/demo/backups", hostKeyFingerprint: "SHA256:DEMO-SAMPLE-FINGERPRINT-NOT-REAL" },
        meta: { environment: "prod", tags: ["archive"], defaultFor: { backups: false, exports: true, artifacts: false }, compression: "none", encryptionAtRest: false, createdBy: "Demo Admin", createdAt: ago(60 * DAY), updatedAt: ago(60 * DAY) },
        health: { status: "healthy", lastCheckedAt: ago(5 * HOUR), lastResult: "Sample: login and write worked." },
        capabilities: { canUse: true, canEdit: true, canRotate: true, canDelete: true },
        hasSecret: { sftpPassword: true },
    },
];
const backupConfig = () => ({
    backupKind: "postgresql", enabled: true, targets: ["users", "roles", "devices", "settings"], schedule: "daily", cronExpr: "0 3 * * *", retentionDays: 30,
    destination: { kind: "s3", connectionId: FAKE_ID(9701), bucket: "demo-msp-backups", prefix: "adgrmm/" },
    extraDestinations: [{ kind: "remote", connectionId: FAKE_ID(9702), path: "/srv/demo/backups", isPrimary: false, priority: 2 }],
    minSuccess: 1, parallelism: 2, notifications: { email: true, webhook: false, slack: false },
});
const backupHistory = (c: FixtureCtx) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const rows: { id: string; at: string; status: string; backupKind: string; note: string; sizeBytes: number; durationSec: number; verified: boolean }[] = [];
    for (let i = 0; i < 14; i++) {
        const d = new Date(Date.now() - (i * DAY + 7 * HOUR));
        const failed = i === 5;
        rows.push({
            id: `demo-backup-${String(14 - i).padStart(3, "0")}`, at: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} 03:00`,
            status: failed ? "failed" : "success", backupKind: "postgresql", note: failed ? "Sample failure: the SFTP archive did not answer." : "Scheduled backup (sample)",
            sizeBytes: failed ? 0 : 310_000_000 + i * 1_250_000, durationSec: failed ? 95 : 212 + i, verified: !failed && i % 3 === 0,
        });
    }
    const status = c.query.get("status"), q = (c.query.get("q") || "").toLowerCase();
    return { items: rows.filter((r) => (!status || r.status === status) && (!q || `${r.id} ${r.note}`.toLowerCase().includes(q))) };
};
const nextRuns = () => ({ next: [1, 2, 3, 4, 5].map((n) => { const d = new Date(Date.now() + n * DAY); d.setUTCHours(3, 0, 0, 0); return d.toISOString(); }) });

/* ------------------------------ Sessions ------------------------------ */

const SESSION_ROWS = [
    { email: "demo.admin@demo-msp.invalid", name: "Demo Admin", roles: ["Owner"], ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36", ip: "203.0.113.10", created: 2 * HOUR, seen: MIN, trusted: true, current: true },
    { email: "sam.tech@demo-msp.invalid", name: "Sam Technician", roles: ["Technician"], ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Safari/605.1.15", ip: "203.0.113.24", created: 5 * HOUR, seen: 12 * MIN, trusted: false, current: false },
    { email: "riley.support@demo-msp.invalid", name: "Riley Support", roles: ["Helpdesk"], ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/126.0 Safari/537.36", ip: "198.51.100.7", created: 26 * HOUR, seen: 45 * MIN, trusted: true, current: false },
    { email: "alex.billing@demo-msp.invalid", name: null, roles: ["Billing"], ua: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Firefox/127.0", ip: "198.51.100.33", created: 3 * DAY, seen: 6 * HOUR, trusted: false, current: false },
    { email: "jo.manager@demo-msp.invalid", name: "Jo Manager", roles: ["Manager"], ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1", ip: "192.0.2.58", created: 9 * HOUR, seen: 3 * HOUR, trusted: false, current: false },
];
const sessionsPage = (c: FixtureCtx) => {
    const search = (c.query.get("search") || "").toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(c.query.get("limit")) || 50)), offset = Math.max(0, Number(c.query.get("offset")) || 0);
    const all = SESSION_ROWS.map((s, i) => ({ id: FAKE_ID(9800 + i), userId: FAKE_ID(9850 + i), email: s.email, name: s.name, roles: s.roles, userAgent: s.ua, ip: s.ip, createdAt: ago(s.created), lastSeenAt: ago(s.seen), trusted: s.trusted, current: s.current }))
        .filter((s) => !search || `${s.email} ${s.name ?? ""} ${s.ip} ${s.userAgent}`.toLowerCase().includes(search));
    return { total: all.length, items: all.slice(offset, offset + limit) };
};

/* ------------------------------ Agents & endpoints ------------------------------ */

const agentSettings = () => ({
    installKeyExpiryMins: 10080, autoUpdate: true, updatesDisabledByServer: false,
    packages: [{ os: "windows", version: "1.3.46", sizeBytes: 48_300_000 }, { os: "linux", version: "1.3.46", sizeBytes: 31_900_000 }],
});
const slot = (version: string, size: number, modifiedAt: string) => ({ state: "valid", problem: null, version, sha256: "0".repeat(64), sizeBytes: size, modifiedAt });
const absentSlot = { state: "absent", problem: null, version: null, sha256: null, sizeBytes: null, modifiedAt: null };
const agentReleases = () => ({
    autoUpdate: true, updatesDisabledByServer: false, rings: { pilot: 1, stable: 23 }, canManage: true,
    systems: (["windows", "linux"] as const).map((os) => ({
        os, stable: slot("1.3.46", os === "windows" ? 48_300_000 : 31_900_000, ago(14 * DAY)), candidate: os === "windows" ? slot("1.3.47", 48_400_000, ago(DAY)) : absentSlot, previous: slot("1.3.39", os === "windows" ? 47_900_000 : 31_500_000, ago(60 * DAY)),
        candidateNotNewer: false, ringCounts: [{ version: "1.3.46", pilot: 0, stable: os === "windows" ? 20 : 3 }, { version: "1.3.47", pilot: os === "windows" ? 1 : 0, stable: 0 }],
        gate: os === "windows"
            ? { candidateVersion: "1.3.47", pilotTotal: 1, onCandidate: 1, onCandidateOnline: 1, seenOnlineAfterUpdate: 1, notYetUpdated: 0, offlineSinceUpdating: 0, updateFailed: 0, status: "healthy", message: "The pilot device updated and has been seen online since (sample).", blockers: [] as string[] }
            : { candidateVersion: null, pilotTotal: 0, onCandidate: 0, onCandidateOnline: 0, seenOnlineAfterUpdate: 0, notYetUpdated: 0, offlineSinceUpdating: 0, updateFailed: 0, status: "no_candidate", message: "There is no candidate build.", blockers: [] as string[] },
    })),
    recent: [{ at: ago(DAY), actorEmail: "demo.admin@demo-msp.invalid", action: "ring-device", os: "windows", version: "1.3.47", previousVersion: "1.3.46", forced: false, reason: null }],
});
const tray = () => ({
    enabled: true, helpEnabled: true, chatEnabled: true, supportPhone: "+1 555 0100", supportEmail: "support@demo-msp.invalid", greeting: "Hi, how can we help?",
    providerName: "Demo MSP", officeHours: "Mon-Fri 8:00-17:00", website: "https://demo-msp.invalid", contactName: "Service desk", afterHoursPhone: "+1 555 0199", notice: null,
});

/* ------------------------------ Demo data, client portal ------------------------------ */

const demoData = () => ({ enabled: true, since: ago(2 * HOUR), counts: { customers: 14, sites: 22, devices: 24, tickets: 420, sessions: 5, assets: 38 } });
const portalSettings = () => ({
    enabled: true, domain: "portal.demo.invalid", modules: ["dashboard", "tickets", "devices", "invoices", "knowledge"], allowTicketCreate: true,
    welcomeTitle: "Welcome to your support portal", welcomeText: "Follow your tickets, see your devices and pay invoices (sample text).", supportEmail: "support@demo-msp.invalid", supportPhone: "+1 555 0100",
});
const portalAccounts = (c: FixtureCtx) => {
    // Sample people at sample customers. A customer page asks for one customer's people: none of the samples belong to a real one.
    if (c.query.get("clientId")) return [];
    return [
        { id: FAKE_ID(9901), clientId: FAKE_ID(9951), clientName: "Sample Customer A", contactId: null, email: "pat.manager@customer-a.invalid", name: "Pat Manager", role: "manager", status: "active", lastLoginAt: ago(2 * DAY) },
        { id: FAKE_ID(9902), clientId: FAKE_ID(9951), clientName: "Sample Customer A", contactId: null, email: "lee.user@customer-a.invalid", name: "Lee User", role: "user", status: "active", lastLoginAt: ago(9 * DAY) },
        { id: FAKE_ID(9903), clientId: FAKE_ID(9952), clientName: "Sample Customer B", contactId: null, email: "kim.owner@customer-b.invalid", name: "Kim Owner", role: "manager", status: "invited", lastLoginAt: null },
    ];
};

/* ------------------------------ Import / Export (CSV samples) ------------------------------ */

const CSV: Record<string, string> = {
    customers: "name,email,phone,address,tags\nSample Customer A,office@customer-a.invalid,+1 555 0111,1 Example Street,priority\nSample Customer B,hello@customer-b.invalid,+1 555 0122,2 Example Road,\n",
    sites: "customer,name,address\nSample Customer A,Head office,1 Example Street\nSample Customer A,Branch office,9 Sample Avenue\nSample Customer B,Warehouse,2 Example Road\n",
    contacts: "customer,name,email,phone\nSample Customer A,Pat Manager,pat.manager@customer-a.invalid,+1 555 0112\nSample Customer B,Kim Owner,kim.owner@customer-b.invalid,+1 555 0123\n",
    devices: "name,customer,site,system,last seen\nDEMO-PC-001,Sample Customer A,Head office,Windows 11,sample\nDEMO-PC-002,Sample Customer A,Branch office,Windows 10,sample\nDEMO-SRV-01,Sample Customer B,Warehouse,Ubuntu 22.04,sample\n",
    users: "name,email,roles,two-factor\nDemo Admin,demo.admin@demo-msp.invalid,Owner,no\nSam Technician,sam.tech@demo-msp.invalid,Technician,yes\n",
    tickets: "number,subject,status,priority,customer,created\n1001,Sample ticket: printer offline,Open,Normal,Sample Customer A,2026-01-05\n1002,Sample ticket: new starter,Closed,Low,Sample Customer B,2026-01-07\n",
};
const TEMPLATES: Record<string, string> = {
    customers: "name,email,phone,address,tags\n",
    sites: "customer,name,address\n",
    contacts: "customer,name,email,phone\n",
};

/* ------------------------------ The routes ------------------------------ */

const ID = "[^/]+";
export const ROUTES: Route[] = [
    // Email
    { method: "GET", re: /^\/api\/admin\/email$/, reply: () => json(emailConfig()) },
    // Support mailbox, SSO
    { method: "GET", re: /^\/api\/support-mailbox$/, reply: () => json(supportMailbox()) },
    { method: "GET", re: /^\/api\/admin\/sso$/, reply: () => json(sso()) },
    // Helpdesk import
    { method: "GET", re: /^\/api\/admin\/import\/jobs$/, reply: () => json({ items: [importJob()] }) },
    { method: "GET", re: new RegExp(`^/api/admin/import/jobs/${ID}$`), reply: () => json(importJob()) },
    // Install keys and installers: samples only, nothing is made
    { method: "GET", re: /^\/api\/provisioning\/enrollment-key-defaults$/, reply: () => json({ expiresMinutes: 10080 }) },
    { method: "GET", re: /^\/api\/provisioning\/enrollment-keys$/, reply: () => json(installKeys()) },
    { method: "POST", re: /^\/api\/provisioning\/enrollment-keys$/, needsBody: true, reply: createKey },
    { method: "POST", re: /^\/api\/provisioning\/installer-bundles$/, needsBody: true, reply: createBundle },
    { method: "POST", re: /^\/api\/provisioning\/endpoints$/, needsBody: true, reply: createEndpoint },
    {
        method: "GET", re: new RegExp(`^/api/provisioning/installer-bundles/${ID}/download$`),
        reply: (_c, m) => /linux/i.test(m[0]) ? text(DEMO_NOTICE_SH, "text/x-shellscript; charset=utf-8", "AdgRmm-Installer-Demo-Linux.sh") : text(DEMO_NOTICE_PS1, "text/plain; charset=utf-8", "AdgRmm-Installer-Demo-Windows.ps1"),
    },
    {
        method: "GET", re: /^\/api\/provisioning\/agent-packages\/[^/]+$/,
        reply: () => text("This is the ADG RMM demo. This file stands in for the agent package and is not an installer.\n", "text/plain; charset=utf-8", "AdgRmm-Agent-DEMO-ONLY.txt"),
    },
    // Diagnostics (the downloadable report is not offered: it would be the real one)
    { method: "GET", re: /^\/api\/admin\/diagnostics$/, reply: (c) => c.query.has("download") ? json({ statusCode: 403, message: "The report download is switched off in the demo. The screen shows a sample.", demo: true }, 403) : json(diagnostics()) },
    // Integrations, webhooks
    { method: "GET", re: /^\/api\/admin\/integrations$/, reply: () => json(integrations()) },
    { method: "GET", re: /^\/api\/admin\/webhooks$/, reply: () => json(webhooks()) },
    { method: "GET", re: new RegExp(`^/api/admin/webhooks/${ID}/deliveries$`), reply: () => json(deliveries()) },
    // Database, storage, backups
    { method: "GET", re: /^\/api\/admin\/database$/, reply: () => json(databaseConfig()) },
    { method: "GET", re: /^\/api\/admin\/storage\/connections$/, reply: () => json({ items: STORAGE }) },
    { method: "GET", re: new RegExp(`^/api/admin/storage/connections/${ID}/dependents$`), reply: () => json({ features: [{ name: "Backups" }] }) },
    { method: "GET", re: /^\/api\/admin\/backups\/config$/, reply: () => json(backupConfig()) },
    { method: "GET", re: /^\/api\/admin\/backups\/permissions$/, reply: () => json({ restore: true, download: false }) },
    { method: "GET", re: /^\/api\/admin\/backups\/history$/, reply: (c) => json(backupHistory(c)) },
    { method: "GET", re: /^\/api\/admin\/backups\/next-runs$/, reply: () => json(nextRuns()) },
    { method: "GET", re: new RegExp(`^/api/admin/backups/restores/${ID}$`), reply: (_c, m) => json({ id: m[0].split("/").pop(), status: "completed", notes: "Sample restore test (demo).", error: null, restore_database: "demo_restore_scratch", verification: { mode: "isolated-verification", verified: true, productionDatabaseChanged: false, pgRestoreListValidated: true, pgRestoreCompleted: true, snapshotMigrationHistory: { count: MIGRATION_NAMES.length, exactMatch: true }, currentMigrationHistory: { count: MIGRATION_NAMES.length, exactMatch: true }, schema: { exactMatch: true }, application: { httpStatus: 200 } } }) },
    // System, health, migrations, secrets
    { method: "GET", re: /^\/api\/admin\/system$/, reply: () => json(systemInfo()) },
    { method: "GET", re: /^\/api\/admin\/system-health$/, reply: () => json(systemHealth()) },
    { method: "GET", re: /^\/api\/admin\/migrations$/, reply: () => json(migrations()) },
    { method: "GET", re: /^\/api\/admin\/secrets-status$/, reply: () => json(secretsStatus()) },
    // Import / Export: sample files
    { method: "GET", re: /^\/api\/admin\/data\/export\/(customers|sites|contacts|devices|users|tickets)$/, reply: (_c, m) => text(CSV[m[1]], "text/csv; charset=utf-8", `${m[1]}-demo.csv`) },
    { method: "GET", re: /^\/api\/admin\/data\/import\/(customers|sites|contacts)\/template$/, reply: (_c, m) => text(TEMPLATES[m[1]], "text/csv; charset=utf-8", `${m[1]}-import-template.csv`) },
    // Sessions
    { method: "GET", re: /^\/api\/admin\/sessions$/, reply: (c) => json(sessionsPage(c)) },
    // Agents & endpoints
    { method: "GET", re: /^\/api\/admin\/agent-settings$/, reply: () => json(agentSettings()) },
    { method: "GET", re: /^\/api\/admin\/agent-releases$/, reply: () => json(agentReleases()) },
    { method: "GET", re: /^\/api\/admin\/tray$/, reply: () => json(tray()) },
    // Demo data, client portal
    { method: "GET", re: /^\/api\/admin\/demo$/, reply: () => json(demoData()) },
    { method: "GET", re: /^\/api\/portal-admin\/settings$/, reply: () => json(portalSettings()) },
    { method: "GET", re: /^\/api\/portal-admin\/accounts$/, reply: (c) => json(portalAccounts(c)) },
];

export type FixtureHit = { route: Route; match: RegExpExecArray; query: URLSearchParams };

/** The sample that answers this request, if there is one. `path` is the cleaned path from normalizePath; refuses odd-looking paths. */
export function findFixture(method: string, path: string, rawUrl: string, suspicious: boolean): FixtureHit | null {
    if (suspicious) return null;
    const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
    for (const route of ROUTES) {
        if (route.method !== m) continue;
        const match = route.re.exec(path);
        if (!match) continue;
        const q = rawUrl.split("#")[0].split("?")[1] ?? "";
        return { route, match, query: new URLSearchParams(q) };
    }
    return null;
}

export function runFixture(hit: FixtureHit, method: string, path: string, body: unknown): FixtureReply {
    return hit.route.reply({ method, path, query: hit.query, body }, hit.match);
}
