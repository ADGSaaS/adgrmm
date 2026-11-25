// The diagnostics report: complete, honest about what failed, and never holding a secret.
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));

let passed = 0, failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 2).join(" | ") ?? e.message}`); }
}

(async () => {
    const { DiagnosticsService, safe } = dist("admin/diagnostics.service.js");
    const { EnvironmentService } = dist("admin/environment.service.js");
    const { PrismaService } = dist("storage/prisma.service.js");
    const prisma = new PrismaService();
    const env = new EnvironmentService();
    const svc = new DiagnosticsService(prisma, env);
    const org = (await prisma.$queryRaw`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)[0].id;
    const stamp = Date.now().toString(36);

    await check("a part that fails is reported as failed, and does not stop the others", async () => {
        assert.deepEqual(await safe(() => 5), 5);
        assert.deepEqual(await safe(async () => { throw new Error("db down\nstack line"); }), { error: "db down" });
        const broken = new DiagnosticsService(
            { $queryRaw: async () => { throw new Error("connection refused"); }, support_mailbox: { findUnique: async () => null }, sso_config: { findUnique: async () => null }, import_jobs: { findMany: async () => [] } },
            env
        );
        const r = await broken.report(org, "a@b.test");
        assert.deepEqual(r.database, { error: "connection refused" });
        assert.deepEqual(r.agents, { error: "connection refused" });
        assert.ok(r.app.packageVersion, "the parts that need no database still arrive");
        assert.ok(Array.isArray(r.environment));
        const msgs = r.findings.filter((f) => f.level === "warning").map((f) => f.message);
        assert.ok(msgs.some((m) => /could not be collected: connection refused/.test(m)));
    });

    let report;
    await check("the report covers the server, database, disk, agents, tasks, email, mailbox, sign-on, imports, audit and settings", async () => {
        report = await svc.report(org, "tester@example.test");
        for (const k of ["app", "database", "disk", "agents", "tasks", "email", "mailbox", "sso", "imports", "audit", "environment", "findings"]) assert.ok(k in report, k);
        for (const k of ["app", "database", "disk", "agents", "tasks", "email", "audit"]) assert.ok(!("error" in report[k]) || Array.isArray(report[k]), `${k} collected: ${JSON.stringify(report[k]).slice(0, 120)}`);
        assert.equal(report.requestedBy, "tester@example.test");
        assert.equal(report.app.name, "remoteiq-backend");
        assert.match(report.app.node, /^v\d+/);
        assert.ok(report.database.migrations.applied > 20);
        assert.deepEqual(report.database.migrations.unfinished, []);
        assert.ok(report.database.sizeMb >= 0 && report.database.connections >= 1);
        assert.ok("devices" in report.database.approximateRows || Object.keys(report.database.approximateRows).length > 0);
        assert.ok(report.disk.length >= 1);
        assert.equal(typeof report.agents.total, "number");
        assert.ok(Array.isArray(report.findings) && report.findings.length >= 1);
        assert.doesNotThrow(() => JSON.stringify(report), "it can be written to a file (no big integers)");
    });

    await check("no secret ever appears: not in settings, not in the mailbox or sign-on status", async () => {
        await prisma.support_mailbox.upsert({
            where: { organization_id: org },
            create: { organization_id: org, enabled: true, source: "microsoft", client_secret: "enc:v1:CLIENTSECRET-" + stamp, refresh_token: "enc:v1:REFRESHTOKEN-" + stamp, mailbox_address: "support@msp.test", tenant_id: "TENANT-" + stamp, client_id: "11111111-2222-3333-4444-555555555555", last_error: "Sign-in expired", last_error_at: new Date() },
            update: { enabled: true, client_secret: "enc:v1:CLIENTSECRET-" + stamp, refresh_token: "enc:v1:REFRESHTOKEN-" + stamp, mailbox_address: "support@msp.test", last_error: "Sign-in expired", last_error_at: new Date() },
        });
        await prisma.sso_config.upsert({
            where: { organization_id: org },
            create: { organization_id: org, enabled: true, issuer: "https://login.example.test/tenant-" + stamp, client_id: "cid", client_secret: "enc:v1:SSOSECRET-" + stamp },
            update: { enabled: true, issuer: "https://login.example.test/tenant-" + stamp, client_secret: "enc:v1:SSOSECRET-" + stamp },
        });
        try {
            const r = await svc.report(org, null);
            const text = JSON.stringify(r);
            for (const secret of [process.env.JWT_SECRET, process.env.DATA_ENCRYPTION_KEY, process.env.ADMIN_API_KEY, "CLIENTSECRET-" + stamp, "REFRESHTOKEN-" + stamp, "SSOSECRET-" + stamp, "TENANT-" + stamp, "riq:riq@"].filter(Boolean)) {
                assert.ok(!text.includes(secret), `leaked: ${String(secret).slice(0, 12)}…`);
            }
            // What is shown is a yes or no, and the host of the provider.
            assert.deepEqual({ ...r.mailbox, lastPolledAt: null, lastErrorAt: null }, { configured: true, enabled: true, source: "microsoft", connected: true, address: "support@msp.test", lastPolledAt: null, lastError: "Sign-in expired", lastErrorAt: null });
            assert.equal(r.sso.providerHost, "login.example.test");
            assert.equal(r.sso.hasClientSecret, true);
            // A setting that is a secret says only that it is set.
            const jwt = r.environment.find((e) => e.key === "JWT_SECRET");
            assert.ok(jwt && jwt.configured === true && !("value" in jwt));
            const nodeEnv = r.environment.find((e) => e.key === "NODE_ENV");
            assert.ok(nodeEnv);
            // And the mailbox problem is the first thing to look at.
            assert.equal(r.findings[0].level, "problem");
            assert.match(r.findings.find((f) => f.area === "mailbox").message, /Sign-in expired/);
        } finally {
            await prisma.support_mailbox.deleteMany({ where: { organization_id: org } });
            await prisma.sso_config.deleteMany({ where: { organization_id: org } });
        }
    });

    await check("findings say what to look at, worst first", async () => {
        const base = {
            database: { migrations: { unfinished: [], rolledBack: [] }, connections: 5 },
            disk: [{ label: "application", freeGb: 3, freePercent: 40 }],
            agents: { total: 10, online: 9, notSeenForADay: 0, neverCheckedIn: 0, byVersion: [{ version: "1.3.33", agents: 10, online: 9 }] },
            tasks: { oldestPendingMinutes: 1, last24Hours: [] },
            mailbox: { configured: false }, sso: { configured: false }, imports: [], audit: { last24Hours: { events: 5, failures: 0 } },
            app: { nodeEnv: "production", systemMemoryMb: { free: 4000 } },
        };
        const f = (patch) => svc.findings({ ...base, ...patch });
        assert.deepEqual(f({}), [{ level: "info", area: "summary", message: "Nothing needs attention." }]);
        assert.equal(f({ disk: [{ label: "application", freeGb: 0.4, freePercent: 3 }] })[0].level, "problem");
        assert.equal(f({ disk: [{ label: "uploads", freeGb: 5, freePercent: 8 }] })[0].level, "warning");
        assert.match(f({ database: { migrations: { unfinished: ["2026_x"], rolledBack: [] }, connections: 5 } })[0].message, /did not finish: 2026_x/);
        assert.match(f({ agents: { ...base.agents, notSeenForADay: 7 } })[0].message, /7 of 10 agents have not checked in/);
        assert.match(f({ tasks: { oldestPendingMinutes: 200, last24Hours: [] } })[0].message, /200 minutes/);
        assert.match(f({ tasks: { oldestPendingMinutes: 1, last24Hours: [{ type: "script", status: "failed", n: 30 }] } })[0].message, /30 agent tasks failed/);
        assert.equal(f({ tasks: { oldestPendingMinutes: 1, last24Hours: [{ type: "script", status: "failed", n: 30 }] } })[0].level, "warning");
        assert.match(f({ imports: [{ status: "failed", message: "key refused" }] })[0].message, /key refused/);
        assert.match(f({ app: { nodeEnv: "development", systemMemoryMb: { free: 4000 } } })[0].message, /NODE_ENV is development/);
        const mixed = f({ disk: [{ label: "application", freeGb: 0.1, freePercent: 1 }], agents: { ...base.agents, neverCheckedIn: 2 } });
        assert.deepEqual(mixed.map((x) => x.level), ["problem", "info"]);
    });

    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
