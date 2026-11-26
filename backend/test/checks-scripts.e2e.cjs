// Check definitions, the agent's real result path, and scripts, against a real database.
// Usage, from backend/ after building: ADG_E2E_ALLOW=1 DATABASE_URL=postgres://.../adg_e2e node test/checks-scripts.e2e.cjs
const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}

process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
async function rejects(name, fn, pattern) {
    try {
        await fn();
        check(name, false, "it was accepted");
    } catch (err) {
        check(name, !pattern || pattern.test(err.message), err.message);
    }
}

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { AlertsService } = require(path.join(dist, "alerts/alerts.service.js"));
    const { CheckDefinitionsService } = require(path.join(dist, "checks/check-definitions.service.js"));
    const { ChecksRuntimeService } = require(path.join(dist, "checks/checks.runtime.service.js"));
    const { ScriptsService } = require(path.join(dist, "automation/scripts.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const alerts = app.get(AlertsService, { strict: false });
    const defs = app.get(CheckDefinitionsService, { strict: false });
    const runtime = app.get(ChecksRuntimeService, { strict: false });
    const scripts = app.get(ScriptsService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Beta ${Date.now()}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "Main" } });
    const windows = await prisma.devices.create({ data: { site_id: site.id, hostname: "WIN-1", operating_system: "windows" } });
    const linux = await prisma.devices.create({ data: { site_id: site.id, hostname: "LNX-1", operating_system: "linux" } });
    const winAgent = await prisma.agents.create({ data: { device_id: windows.id, agent_uuid: crypto.randomUUID(), version: "1.3.4", facts: { os: "windows" } } });
    const lnxAgent = await prisma.agents.create({ data: { device_id: linux.id, agent_uuid: crypto.randomUUID(), version: "1.3.4", facts: { os: "linux" } } });

    // ---- the path an agent's results really take
    await runtime.ingestAgentRuns({ agentId: winAgent.id, deviceId: windows.id, runs: [{ dedupeKey: "disk|c:", checkType: "DISK", checkName: "Disk C:", status: "CRIT", output: "97% used" }] });
    let open = await alerts.list({ deviceId: windows.id, state: "OPEN" });
    check("a real failing result opens an alert", open.items.length === 1 && open.items[0].title.includes("Disk C:"), open.items);
    check("its severity follows the result", open.items[0]?.severity === "CRIT", open.items[0]?.severity);

    await runtime.ingestAgentRuns({ agentId: winAgent.id, deviceId: windows.id, runs: [{ dedupeKey: "disk|c:", checkType: "DISK", checkName: "Disk C:", status: "OK", output: "40% used" }] });
    check("a real passing result resolves it", (await alerts.list({ deviceId: windows.id, state: "OPEN" })).items.length === 0);

    // ---- check definitions
    const base = { kind: "disk", warn: 80, crit: 90, intervalMinutes: 5 };
    await rejects("a check needs somewhere to run", () => defs.create({ ...base, name: "No targets", targets: [] }, null), /where/);
    await rejects("limits must be in order", () => defs.create({ ...base, name: "Backwards", warn: 95, crit: 90, targets: [{ type: "organization" }] }, null), /below/);
    await rejects("a service name cannot carry odd characters", () => defs.create({ name: "Bad", kind: "service", service: "x;rm -rf", targets: [{ type: "organization" }] }, null), /not valid/);

    const everywhere = await defs.create({ ...base, name: "Disk space", targets: [{ type: "organization" }] }, null);
    const forSite = await defs.create({ name: "Spooler", kind: "service", service: "Spooler", severity: "WARN", targets: [{ type: "site", id: site.id }] }, null);
    const forClient = await defs.create({ name: "Web port", kind: "port", host: "example.com", port: 443, targets: [{ type: "client", id: client.id }] }, null);
    await rejects("names are unique", () => defs.create({ ...base, name: "Disk space", targets: [{ type: "organization" }] }, null), /already exists/);

    let plan = await runtime.getCheckPlan(windows.id);
    check("a device gets checks from every level above it", plan.checks.length === 3, plan.checks.map((c) => c.name));
    check("custom checks keep the built-in ones", plan.includeDefaults === true && plan.mode === "custom", plan);
    check("the disk check carries its limits", plan.checks.find((c) => c.name === "Disk space")?.warn === 80);
    check("the port check is a port probe", plan.checks.find((c) => c.name === "Web port")?.type === "PORT");

    const listed = await defs.list();
    const label = listed.items.find((c) => c.id === forSite.id)?.targets[0]?.label;
    check("targets show readable names", label?.endsWith("/ Main"), label);
    check("a kind survives the round trip", listed.items.find((c) => c.id === forClient.id)?.kind === "port");

    await defs.update(everywhere.id, { ...base, name: "Disk space", enabled: false, targets: [{ type: "organization" }] });
    plan = await runtime.getCheckPlan(windows.id);
    check("a turned off check leaves the plan", plan.checks.length === 2, plan.checks.map((c) => c.name));

    await runtime.ingestAgentRuns({ agentId: winAgent.id, deviceId: windows.id, runs: [{ dedupeKey: `check:${forSite.id}`, checkType: "SERVICE", checkName: "Spooler", status: "WARN", output: "stopped" }] });
    open = await alerts.list({ deviceId: windows.id, state: "OPEN" });
    check("a custom check raises its alert", open.items.length === 1 && open.items[0].severity === "WARN", open.items);
    await defs.remove(forSite.id);
    open = await alerts.list({ deviceId: windows.id, state: "OPEN" });
    check("deleting a check clears what it raised", open.items.length === 0, open.items);

    await defs.remove(everywhere.id);
    await defs.remove(forClient.id);
    plan = await runtime.getCheckPlan(windows.id);
    check("with no checks left a device runs the built-in set", plan.mode === "default" && plan.checks.length === 0, plan);

    // ---- scripts
    await rejects("a script needs content", () => scripts.create({ name: "Empty", language: "powershell", script: "  " }, null), /empty/);
    await rejects("parameter names are restricted", () => scripts.create({ name: "Bad", language: "powershell", script: "x", parameters: [{ name: "a b" }] }, null), /parameter name/);

    const script = await scripts.create({ name: "Greet", language: "powershell", script: "Write-Output $env:ADG_WHO", parameters: [{ name: "who", required: true }] }, null);
    await rejects("required parameters are enforced", () => scripts.run(script.id, [windows.id], {}, null), /required/);

    const result = await scripts.run(script.id, [windows.id, linux.id], { who: "world; rm -rf /" }, null);
    check("it runs where the language fits", result.started.length === 1 && result.started[0].deviceId === windows.id, result);
    check("it says why it skipped the rest", result.skipped.length === 1 && /does not run/.test(result.skipped[0].reason), result.skipped);

    const job = await prisma.jobs.findUnique({ where: { id: result.started[0].jobId } });
    check("a value travels as an environment variable", job.payload.env.ADG_WHO === "world; rm -rf /" && !job.payload.scriptText.includes("world"), job.payload);

    const history = await scripts.history({ automationId: script.id });
    check("the run appears in the history", history.items.length === 1 && history.items[0].device.name === "WIN-1", history.items);

    // ---- schedules
    await rejects("a schedule cannot run too often", () => scripts.createSchedule({ automationId: script.id, name: "Fast", targetType: "organization", intervalMinutes: 1 }, null), /at most/);
    const past = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const schedule = await scripts.createSchedule({ automationId: script.id, name: "Hourly", targetType: "site", targetId: site.id, intervalMinutes: 60, startAt: past, parameters: { who: "scheduled" } }, null);

    await scripts.runDueSchedules();
    const after = (await scripts.listSchedules()).items.find((s) => s.id === schedule.id);
    check("a due schedule moves to a future time", new Date(after.nextRunAt) > new Date(), after.nextRunAt);
    const scheduled = (await scripts.history({ automationId: script.id })).items.filter((r) => r.scheduled);
    check("a missed backlog runs once, on what fits", scheduled.length === 1, scheduled.length);

    await scripts.runDueSchedules();
    check("it does not run again until it is due", (await scripts.history({ automationId: script.id })).items.filter((r) => r.scheduled).length === 1);

    await scripts.remove(script.id);
    check("removing a script removes its schedules", (await scripts.listSchedules()).items.every((s) => s.id !== schedule.id));
    check("its history is kept", (await prisma.script_runs.count({ where: { script_name: "Greet" } })) >= 2);

    await app.close();
    void lnxAgent;
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
