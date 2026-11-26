// Assets and links, against a real database. (There is no password vault in ADG RMM: customer passwords belong in the owner's other software.)
// Usage, from backend/ after building: ADG_E2E_ALLOW=1 DATABASE_URL=postgres://.../adg_e2e node test/itdocs.e2e.cjs
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
    const { ItDocsService } = require(path.join(dist, "itdocs/itdocs.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { AUDIT_ROUTES } = (() => {
        try { return require(path.join(dist, "audit/audit-routes.js")); } catch { return {}; }
    })();

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const docs = app.get(ItDocsService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Delta ${stamp}` } });
    const other = await prisma.clients.create({ data: { organization_id: org.id, name: `Epsilon ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "Main" } });

    // ---- assets from agents
    const device = await prisma.devices.create({ data: { site_id: site.id, hostname: `SRV-${stamp}`, serial_number: "ABC123", operating_system: "Windows Server 2022" } });
    await prisma.agents.create({ data: { device_id: device.id, agent_uuid: crypto.randomUUID(), version: "1.3.5", facts: { device: { model: "Dell R740", cpu: "Xeon", ram: "64 GB" } } } });
    await prisma.devices.create({ data: { site_id: site.id, hostname: `NOAGENT-${stamp}` } });

    const first = await docs.syncFromAgents();
    check("a device with an agent becomes an asset", first.created >= 1, first);
    let assets = await docs.listAssets({ clientId: client.id });
    check("only devices with an agent appear", assets.items.length === 1, assets.items.map((a) => a.name));
    const synced = assets.items[0];
    check("it fills in what the agent reports", synced.kind === "server" && synced.model === "Dell R740" && synced.serialNumber === "ABC123" && synced.details.ram === "64 GB" && synced.source === "agent", synced);

    await docs.updateAsset(synced.id, { clientId: client.id, name: synced.name, kind: "server", location: "Rack 4", expiresAt: "2030-05-01", notes: "Warranty with Dell", model: "typed over" });
    await prisma.agents.update({ where: { device_id: device.id }, data: { facts: { device: { model: "Dell R750", ram: "128 GB" } } } });
    const second = await docs.syncFromAgents();
    assets = await docs.listAssets({ clientId: client.id });
    const again = assets.items[0];
    check("syncing again adds no duplicate", second.created === 0 && assets.items.length === 1, second);
    check("the agent's fields update", again.model === "Dell R750" && again.details.ram === "128 GB", again.model);
    check("a technician's fields survive", again.location === "Rack 4" && again.expiresAt === "2030-05-01" && again.notes === "Warranty with Dell", again);
    await rejects("an agent's asset cannot be deleted alone", () => docs.deleteAsset(again.id), /Remove the device/);

    // ---- manual assets and expiry
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const domain = await docs.createAsset({ clientId: client.id, name: `delta-${stamp}.example`, kind: "domain", expiresAt: soon });
    await rejects("types are checked", () => docs.createAsset({ clientId: client.id, name: "x", kind: "spaceship" }), /type/);
    await rejects("dates are checked", () => docs.createAsset({ clientId: client.id, name: "x", kind: "other", expiresAt: "soon" }), /Dates/);
    const expiring = await docs.expiring(30);
    check("expiring lists it", expiring.items.some((e) => e.id === domain.id && e.expiresAt === soon));
    check("items past the window stay out", !expiring.items.some((e) => e.id === again.id));

    const noMail = await docs.sendExpiryNotices();
    check("with no recipients nothing is marked as told", noMail.sent === false && (await prisma.assets.findUnique({ where: { id: domain.id } })).expiry_notice_days === null, noMail);
    await prisma.notification_channels.create({ data: { name: `Expiry ${stamp}`, kind: "email", enabled: true, config: { recipients: ["ops@example.test"] } } });
    const failedMail = await docs.sendExpiryNotices();
    check("a mail failure leaves it to try again", failedMail.sent === false && (await prisma.assets.findUnique({ where: { id: domain.id } })).expiry_notice_days === null, failedMail);

    // ---- links
    const link = await docs.addLink({ fromType: "asset", fromId: domain.id, toType: "asset", toId: again.id }, null);
    await rejects("the same pair cannot link twice, either way round", () => docs.addLink({ fromType: "asset", fromId: again.id, toType: "asset", toId: domain.id }, null), /already linked/);
    await rejects("a link cannot point at nothing", () => docs.addLink({ fromType: "asset", fromId: domain.id, toType: "asset", toId: crypto.randomUUID() }, null), /no longer exists/);
    await rejects("nothing links to itself", () => docs.addLink({ fromType: "asset", fromId: domain.id, toType: "asset", toId: domain.id }, null), /itself/);
    await rejects("there are no documents or stored passwords to link to", () => docs.addLink({ fromType: "asset", fromId: domain.id, toType: "document", toId: crypto.randomUUID() }, null), /./);
    const fromDomain = await docs.listLinks("asset", domain.id);
    const fromAgain = await docs.listLinks("asset", again.id);
    check("a link shows from both sides", fromDomain.items[0]?.label === again.name && fromAgain.items[0]?.label === `delta-${stamp}.example`, { fromDomain, fromAgain });
    const targets = await docs.linkTargets("asset", "delta");
    check("the picker finds assets", targets.items.some((t) => t.id === domain.id));

    await docs.deleteAsset(domain.id);
    check("deleting removes its links", (await docs.listLinks("asset", again.id)).items.length === 0);
    await rejects("a removed link is gone", () => docs.removeLink(link.id), /Not found/);

    void other;
    void AUDIT_ROUTES;
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
