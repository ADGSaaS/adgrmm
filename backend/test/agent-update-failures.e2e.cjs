// Why an agent update failed after the agent accepted it: the agent reports it with its update check, the console can read it, and it goes away
// once the agent runs that version. In process against a throwaway database (name has "e2e").
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false"; process.env.NODE_ENV = "development";
let passed = 0, failed = 0;
const check = (name, ok, extra) => { ok ? passed++ : failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { AgentUpdatesService } = require(path.join(dist, "agents/agent-updates.service.js"));
    const { FailuresService } = require(path.join(dist, "automation/failures.service.js"));
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const ups = app.get(AgentUpdatesService, { strict: false });
    const failures = app.get(FailuresService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `UpdFail ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
    const device = await prisma.devices.create({ data: { site_id: site.id, hostname: `UPD-${stamp}`, operating_system: "Windows 11" } });
    const agent = await prisma.agents.create({ data: { device_id: device.id, agent_uuid: crypto.randomUUID(), version: "1.3.50", last_check_in_at: new Date(), facts: {}, hostname: device.hostname } });
    const row = async () => (await prisma.$queryRaw`SELECT version, outcome, detail FROM public.agent_update_failures WHERE agent_id = ${agent.id}::uuid`)[0] ?? null;

    await ups.noteResult(agent.id, "1.3.50", {});
    check("an ordinary check records nothing", (await row()) === null);
    await ups.noteResult(agent.id, "1.3.50", { version: "1.3.51", outcome: "rolled_back", detail: "The new agent did not start.\nIt went back." });
    let r = await row();
    check("a reported failure is kept with its version, outcome and reason (control characters removed)", r && r.version === "1.3.51" && r.outcome === "rolled_back" && r.detail === "The new agent did not start. It went back.", r);
    await ups.noteResult(agent.id, "1.3.50", { version: "1.3.51", outcome: "rolled_back", detail: "Again" });
    check("reporting it again updates the one row", (await prisma.$queryRaw`SELECT count(*)::int AS n FROM public.agent_update_failures WHERE agent_id = ${agent.id}::uuid`)[0].n === 1 && (await row()).detail === "Again");
    await ups.noteResult(agent.id, "1.3.50", { version: "1.3.51", outcome: "exploded", detail: "x" });
    await ups.noteResult(agent.id, "1.3.50", { version: "banana", outcome: "failed", detail: "x" });
    check("an unknown outcome or a malformed version changes nothing", (await row()).detail === "Again");
    await ups.noteResult(agent.id, "1.3.52", { version: "1.3.51", outcome: "failed", detail: "stale" });
    check("a failure for a version the agent already runs or passed is not recorded and clears the old one", (await row()) === null);
    await ups.noteResult(agent.id, "1.3.50", { version: "1.3.51", outcome: "rollback_failed", detail: "x".repeat(900) });
    r = await row();
    check("a long reason is cut to 500 characters", r && r.detail.length === 500);

    const list = await failures.list({ kind: "action" }, null, org.id);
    const items = list.items ?? list;
    check("the failures list shows it as an agent update with the reason", items.some((i) => i.title === "Agent update" && i.device === device.hostname && /did not finish.*rollback failed/.test(i.reason)), items.slice(0, 2));

    await ups.noteResult(agent.id, "1.3.51", {});
    check("when the agent reports that it runs the failed version, the failure is cleared", (await row()) === null);

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
