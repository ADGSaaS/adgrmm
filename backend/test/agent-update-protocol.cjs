#!/usr/bin/env node
// Runs the real update and check controllers, guard, signer and validation with a fake database,
// then drives them with the real agent code. It needs no database and installs nothing.
//
//   npx tsc -p tsconfig.json          (in backend/)
//   AGENT_PKG_DIR=<output of build-packages.ps1> node test/agent-update-protocol.cjs
//
// Not covered, because it needs Postgres: the raw SQL behind the Checks tab and run cleanup.
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("reflect-metadata");
const { Module, ValidationPipe } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");

const dist = path.join(__dirname, "..", "dist");
const { PrismaService } = require(path.join(dist, "storage/prisma.service"));
const { AgentTokenGuard, hashAgentToken } = require(path.join(dist, "common/agent-token.util"));
const { JobSignerService } = require(path.join(dist, "common/job-signer.service"));
const { UiSocketRegistry } = require(path.join(dist, "common/ui-socket-registry.service"));
const { ProvisioningService } = require(path.join(dist, "provisioning/provisioning.service"));
const { AgentUpdatesController } = require(path.join(dist, "agents/agent-updates.controller"));
const { AgentUpdatesService, manifestCanonical } = require(path.join(dist, "agents/agent-updates.service"));
const { ChecksIngestController } = require(path.join(dist, "checks/checks.ingest.controller"));
const { ChecksRuntimeService } = require(path.join(dist, "checks/checks.runtime.service"));
const { AlertsService } = require(path.join(dist, "alerts/alerts.service"));
const { PoliciesService } = require(path.join(dist, "policies/policies.service"));
const { buildCheckPlan, parseCheckSchedule } = require(path.join(dist, "checks/check-plan.util"));
const { ENVIRONMENT_KEYS } = require(path.join(dist, "admin/environment.registry"));

const PKG_DIR = process.env.AGENT_PKG_DIR;
if (!PKG_DIR) {
    console.error("Set AGENT_PKG_DIR to the output of agents/build-packages.ps1.");
    process.exit(2);
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_DEVICE_ASSIGNMENT = "33333333-3333-4333-8333-333333333333";
const TOKEN = "agent-token";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "riq-protocol-"));
process.env.JOB_SIGNING_KEY_FILE = path.join(work, "job-signing.pem");

// Package folders this test can break without touching the real output.
const pkgCopy = path.join(work, "packages");
fs.cpSync(PKG_DIR, pkgCopy, { recursive: true });
process.env.AGENT_PKG_DIR = pkgCopy;

const db = { assignments: [], runs: [], customChecks: [] };
const fakePrisma = {
    agents: {
        findFirst: async ({ where }) =>
            where.agent_token === hashAgentToken(TOKEN) ? { id: AGENT_ID, device_id: DEVICE_ID } : null,
        findUnique: async ({ where }) => (where.id === AGENT_ID ? { device_id: DEVICE_ID } : null),
    },
    devices: {
        findUnique: async ({ where }) =>
            where.id === DEVICE_ID
                ? { id: DEVICE_ID, site_id: null, sites: null }
                : null,
    },
    check_assignments: {
        createMany: ({ data }) => {
            for (const row of data) {
                if (!db.assignments.some((a) => a.dedupe_key === row.dedupe_key)) {
                    db.assignments.push({ ...row, id: crypto.randomUUID() });
                }
            }
            return Promise.resolve({ count: data.length });
        },
        updateMany: () => Promise.resolve({ count: 1 }),
        findMany: async ({ where }) =>
            where.check_id
                ? db.customChecks.map((checks) => ({ checks }))
                : db.assignments.filter((a) => where.dedupe_key.in.includes(a.dedupe_key)),
    },
    check_runs: {
        createMany: async ({ data }) => {
            db.runs.push(...data);
            return { count: data.length };
        },
    },
    $transaction: (ops) => Promise.all(ops),
};

let passed = 0;
function check(name, ok, detail) {
    assert.ok(ok, `${name}${detail ? `: ${detail}` : ""}`);
    passed++;
    console.log(`pass  ${name}`);
}

async function main() {
    class TestModule { }
    Module({
        controllers: [AgentUpdatesController, ChecksIngestController],
        providers: [
            { provide: PrismaService, useValue: fakePrisma },
            { provide: UiSocketRegistry, useValue: { broadcastToDevice: () => 0 } },
            AgentTokenGuard,
            JobSignerService,
            ProvisioningService,
            AgentUpdatesService,
            ChecksRuntimeService,
            // ChecksRuntimeService grew these two dependencies after this test was written; the update protocol needs neither.
            { provide: AlertsService, useValue: { evaluateRun: async () => undefined, onCheckResult: async () => undefined } },
            // No policies in this fake database: every device gets the defaults.
            { provide: PoliciesService, useValue: { effectiveForDevice: async () => null } },
        ],
    })(TestModule);

    const app = await NestFactory.create(TestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, forbidUnknownValues: true }));
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();

    const get = (url, token = TOKEN) =>
        fetch(`${base}${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const checkUrl = (version, osName = "windows", arch = "x64") =>
        `/api/agent/updates/check?os=${osName}&arch=${arch}&version=${version}`;

    const pem = app.get(JobSignerService).publicKeyPem();
    const pemFile = path.join(work, "public.pem");
    fs.writeFileSync(pemFile, pem);

    const versionFile = path.join(pkgCopy, "windows", "version.json");
    const zip = path.join(pkgCopy, "windows", "remoteiq-agent-windows.zip");
    const original = JSON.parse(fs.readFileSync(versionFile, "utf8"));

    // ── Routes and auth ──
    check("check without a token is 401", (await get(checkUrl("1.0.0"), null)).status === 401);
    check("check with a bad token is 401", (await get(checkUrl("1.0.0"), "wrong")).status === 401);
    check("download without a token is 401", (await get("/api/agent/updates/download/windows", null)).status === 401);
    check("an enrollment key header is not accepted", (await fetch(`${base}/api/agent/updates/download/windows`, { headers: { "x-enrollment-key": "x" } })).status === 401);

    // ── Offering ──
    check("the same version gets 204", (await get(checkUrl(original.version))).status === 204);
    check("a newer agent gets 204, so never a downgrade", (await get(checkUrl("99.0.0"))).status === 204);
    check("1.10.0 is compared numerically", (await get(checkUrl("1.10.0"))).status === 204);
    check("a bad version is 400", (await get(checkUrl("abc"))).status === 400);
    check("no version is 400", (await get("/api/agent/updates/check?os=windows&arch=x64")).status === 400);
    check("an unknown OS gets 204", (await get(checkUrl("1.0.0", "plan9"))).status === 204);
    check("another architecture gets 204", (await get(checkUrl("1.0.0", "linux", "arm64"))).status === 204);

    const res = await get(checkUrl("1.0.0"));
    check("an old agent gets 200", res.status === 200);
    const m = await res.json();
    check("the manifest carries the version from the version file", m.version === original.version);
    check("the URL is relative, so the token stays on this server", m.url === "/api/agent/updates/download/windows");

    const verify = (text) => crypto.verify("sha256", Buffer.from(text), {
        key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
    }, Buffer.from(m.signature, "base64"));
    check("the signature verifies against the job signing key", verify(manifestCanonical(m.version, m.sha256, m.url)));
    check("the signature covers the version", !verify(manifestCanonical("9.9.9", m.sha256, m.url)));
    check("the signature covers the hash", !verify(manifestCanonical(m.version, "0".repeat(64), m.url)));
    check("the signature covers the URL", !verify(manifestCanonical(m.version, m.sha256, "/elsewhere")));

    const dl = await get(m.url);
    const bytes = Buffer.from(await dl.arrayBuffer());
    check("the download is the package", dl.status === 200 && crypto.createHash("sha256").update(bytes).digest("hex") === m.sha256);
    const lin = await (await get(checkUrl("1.0.0", "linux"))).json();
    check("linux gets its own package", lin.url === "/api/agent/updates/download/linux" && lin.sha256 !== m.sha256);
    check("an unknown download is 404", (await get("/api/agent/updates/download/plan9")).status === 404);

    // ── Refusing to offer ──
    fs.writeFileSync(versionFile, JSON.stringify({ version: "9.9.9", sha256: "0".repeat(64) }));
    check("a version file for another package offers nothing", (await get(checkUrl("1.0.0"))).status === 204);
    fs.writeFileSync(versionFile, JSON.stringify({ version: "not-a-version", sha256: original.sha256 }));
    check("an invalid version offers nothing", (await get(checkUrl("1.0.0"))).status === 204);
    fs.writeFileSync(versionFile, "{ broken");
    check("a broken version file offers nothing", (await get(checkUrl("1.0.0"))).status === 204);
    fs.rmSync(versionFile);
    check("no version file offers nothing", (await get(checkUrl("1.0.0"))).status === 204);
    fs.writeFileSync(versionFile, JSON.stringify(original));
    const parked = `${zip}.parked`;
    fs.renameSync(zip, parked);
    check("no package offers nothing, without a server error", (await get(checkUrl("1.0.0"))).status === 204);
    fs.renameSync(parked, zip);

    // ── Kill switch ──
    for (const off of ["false", "0", "off", "FALSE"]) {
        process.env.AGENT_UPDATES_ENABLED = off;
        check(`kill switch ${off} stops offers`, (await get(checkUrl("1.0.0"))).status === 204);
    }
    process.env.AGENT_UPDATES_ENABLED = "false";
    check("kill switch stops downloads", (await get(m.url)).status === 503);
    process.env.AGENT_UPDATES_ENABLED = "true";
    check("turning it back on offers again", (await get(checkUrl("1.0.0"))).status === 200);
    delete process.env.AGENT_UPDATES_ENABLED;
    check("it is on by default", (await get(checkUrl("1.0.0"))).status === 200);
    check("the setting is registered", ENVIRONMENT_KEYS.includes("AGENT_UPDATES_ENABLED") && ENVIRONMENT_KEYS.includes("CHECK_RUNS_RETENTION_DAYS"));

    // ── Check plan and ingest ──
    const envelope = await (await get("/api/agent/ingest/check-plan")).json();
    const planBytes = Buffer.from(envelope.payload, "base64");
    check("the plan is signed", crypto.verify("sha256", planBytes, {
        key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
    }, Buffer.from(envelope.sig, "base64")));
    const plan = JSON.parse(planBytes.toString("utf8"));
    check("no custom assignment means defaults", plan.mode === "default" && plan.agentId === AGENT_ID);
    check("the plan needs a token", (await get("/api/agent/ingest/check-plan", null)).status === 401);

    db.customChecks = [{ id: "c1", name: "Is nginx up", type: "service", schedule: "2m", config: { service: "nginx" } }];
    const custom = JSON.parse(Buffer.from((await (await get("/api/agent/ingest/check-plan")).json()).payload, "base64").toString("utf8"));
    check("a custom assignment replaces the defaults", custom.mode === "custom" && custom.checks[0].service === "nginx" && custom.checks[0].intervalSec === 120);
    db.customChecks = [];

    check("script checks are never handed to the runner", buildCheckPlan([{ id: "s", name: "x", type: "script", schedule: "60", config: { script: "rm -rf /" } }]).mode === "default");
    check("an option-like service name is refused", buildCheckPlan([{ id: "s", name: "x", type: "service", schedule: "60", config: { service: "--help" } }]).mode === "default");
    check("metric config maps to a disk check", buildCheckPlan([{ id: "d", name: "x", type: "metric", schedule: "5m", config: { metric: "disk", path: "C:\\", warn: 20, crit: 10 } }]).checks[0].warn === 20);
    check("a schedule is kept within limits", parseCheckSchedule("1") === 60 && parseCheckSchedule("99h") === 86400 && parseCheckSchedule("junk") === 300);

    const post = (body) => fetch(`${base}/api/agent/ingest/check-runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const now = new Date().toISOString();
    check("another device's id is refused", (await post({ deviceId: AGENT_ID, runs: [{ status: "OK" }] })).status === 403);
    check("a bad date is refused rather than a server error", (await post({ deviceId: DEVICE_ID, runs: [{ status: "OK", startedAt: "yesterday" }] })).status === 400);
    check("an oversized batch is refused", (await post({ deviceId: DEVICE_ID, runs: Array(201).fill({ status: "OK" }) })).status === 400);

    const hijack = await post({ deviceId: DEVICE_ID, runs: [{ assignmentId: OTHER_DEVICE_ASSIGNMENT, dedupeKey: "mine", status: "OK", startedAt: now, finishedAt: now }] });
    check("a run is accepted", hijack.status === 201);
    check("an assignment id in the request cannot write to another device", !db.runs.some((r) => r.assignment_id === OTHER_DEVICE_ASSIGNMENT));
    db.runs.length = 0;

    // ── The real agent code against all of the above ──
    const agents = path.join(__dirname, "..", "..", "agents", "tests", "AgentCoreTests");
    // Asynchronous, because this same process has to keep answering the agent's requests.
    const code = await new Promise((resolve, reject) => {
        const child = spawn("dotnet", ["run", "--project", agents, "--", base, pemFile, "RemoteIQ.Agent.exe", AGENT_ID, DEVICE_ID, original.version], { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", resolve);
    });
    check("the agent code passed against this server", code === 0, `exit code ${code}`);

    check("the agent's results reached the database layer", db.runs.length >= 5);
    check("each result is tied to an assignment for this device", db.runs.every((r) => db.assignments.some((a) => a.id === r.assignment_id && a.target_id === DEVICE_ID)));
    const disk = db.assignments.find((a) => a.check_type === "DISK");
    check("a disk result arrived with a usable name", Boolean(disk?.check_name?.startsWith("Disk free")));
    const diskRun = db.runs.find((r) => r.assignment_id === disk?.id);
    check("metrics and limits came through", typeof diskRun?.metrics?.freePercent === "number" && diskRun.metrics.thresholds?.warn === 10);

    await app.close();
}

main().then(() => {
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`${passed} protocol checks passed`);
    process.exit(0);
}).catch((e) => {
    console.error(e);
    process.exit(1);
});
