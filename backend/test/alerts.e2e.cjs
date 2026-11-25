// Runs the alert flow against a real database, with every migration applied.
// Usage, from backend/ after building: RIQ_E2E_ALLOW=1 DATABASE_URL=postgres://.../riq_e2e node test/alerts.e2e.cjs
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}

process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.ALLOW_PRIVATE_WEBHOOKS = "true";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { AlertsService } = require(path.join(dist, "alerts/alerts.service.js"));
    const { NotificationsService } = require(path.join(dist, "notifications/notifications.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const alerts = app.get(AlertsService, { strict: false });
    const notifications = app.get(NotificationsService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const received = [];
    const hook = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            received.push({ headers: req.headers, body });
            res.statusCode = hook.failNext ? 500 : 200;
            hook.failNext = false;
            res.end();
        });
    });
    await new Promise((r) => hook.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${hook.address().port}/hook`;

    const org = await prisma.organizations.upsert({
        where: { slug: "default" },
        create: { name: "Default Organization", slug: "default" },
        update: {},
    });
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Acme ${Date.now()}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "Head Office" } });
    const device = await prisma.devices.create({ data: { site_id: site.id, hostname: "E2E-PC-1" } });
    const assignmentId = crypto.randomUUID();

    const channel = await notifications.createChannel({ name: "Hook", kind: "webhook", url, minSeverity: "WARN" });
    check("a new webhook reveals its signing secret once", !!channel.signingSecret);
    const stored = await prisma.notification_channels.findUnique({ where: { id: channel.id } });
    check("the signing secret is encrypted at rest", String(stored.config.secret).startsWith("enc:v1:"), stored.config);
    const listed = await notifications.listChannels();
    check("listing channels never returns the secret", !JSON.stringify(listed).includes("secret") && !JSON.stringify(listed).includes(channel.signingSecret));

    const run = (status, severity, output = "disk at 95%") =>
        alerts.onCheckRun({ deviceId: device.id, assignmentId, checkName: "Disk C:", status, severity, output });

    await run("WARN", "WARN");
    let open = await alerts.list({ deviceId: device.id, state: "OPEN" });
    check("a failing check opens an alert", open.items.length === 1, open.items);
    check("the alert shows the customer and site", open.items[0]?.device.client === client.name && open.items[0]?.device.site === "Head Office", open.items[0]?.device);

    await run("WARN", "WARN");
    open = await alerts.list({ deviceId: device.id, state: "OPEN" });
    check("the same problem does not open a second alert", open.items.length === 1, open.items.length);

    await run("CRIT", "CRIT");
    open = await alerts.list({ deviceId: device.id, state: "OPEN" });
    check("a worse result raises the severity", open.items[0]?.severity === "CRIT", open.items[0]?.severity);
    const id = open.items[0].id;

    await notifications.work();
    await new Promise((r) => setTimeout(r, 200));
    check("the webhook received opened and escalated", received.length === 2, received.length);
    const first = received[0];
    const expected = crypto.createHmac("sha256", channel.signingSecret).update(`${first?.headers["x-remoteiq-timestamp"]}.${first?.body}`).digest("hex");
    check("the webhook signature verifies", first?.headers["x-remoteiq-signature"] === `sha256=${expected}`);

    const summary = await alerts.summary();
    check("the summary counts it", summary.open === 1 && summary.openCritical === 1, summary);

    await alerts.ack(id, null, "Looking at it");
    check("it can be acknowledged", (await alerts.list({ deviceId: device.id, state: "ACKED" })).items.length === 1);

    await alerts.silence(id, null, "Known", new Date(Date.now() + 3_600_000).toISOString());
    check("it can be silenced", (await alerts.list({ deviceId: device.id, state: "SILENCED" })).items.length === 1);
    await alerts.silence(id, null, null, new Date(Date.now() + 50).toISOString());
    await new Promise((r) => setTimeout(r, 120));
    await alerts.sweep();
    check("it reopens when the silence ends", (await alerts.list({ deviceId: device.id, state: "OPEN" })).items.length === 1);

    const ticketId = await alerts.openTicket(id);
    check("it can open a ticket", !!ticketId);
    check("asking again returns the same ticket", (await alerts.openTicket(id)) === ticketId);
    const ticket = await prisma.tickets.findUnique({ where: { id: ticketId } });
    check("the ticket is linked to the device and is high priority", ticket.device_id === device.id && ticket.priority === "high", ticket.priority);

    await run("OK", null, "");
    check("a passing check resolves it", (await alerts.list({ deviceId: device.id, state: "RESOLVED" })).items.length === 1);
    const closed = await prisma.tickets.findUnique({ where: { id: ticketId } });
    check("its untouched ticket is resolved too", closed.status === "resolved", closed.status);

    const timeline = await alerts.getTimeline(id);
    const types = timeline.items.map((e) => e.type);
    check("the timeline records each step", ["opened", "escalated", "acknowledged", "silenced", "silence-ended", "ticket-opened", "resolved"].every((t) => types.includes(t)), types);

    await run("WARN", "WARN");
    open = await alerts.list({ deviceId: device.id, state: "OPEN" });
    check("the problem returning is a new alert", open.items.length === 1 && open.items[0].id !== id);
    await alerts.resolve(open.items[0].id, null, "Fixed");
    await notifications.work();

    // A failed delivery is retried later instead of being lost.
    await prisma.notification_deliveries.updateMany({ data: { status: "delivered" } });
    hook.failNext = true;
    await run("WARN", "WARN");
    await notifications.work();
    await new Promise((r) => setTimeout(r, 200));
    const retrying = await prisma.notification_deliveries.findFirst({ where: { status: "pending" } });
    check("a failed delivery is kept for retry", retrying?.attempts === 1 && retrying?.next_attempt_at > new Date(), retrying);

    const unreachable = await notifications.createChannel({ name: "Dead", kind: "webhook", url: "http://127.0.0.1:9/none", minSeverity: "CRIT" });
    const test = await notifications.testChannel(unreachable.id);
    check("a test of a dead channel reports the failure", test.ok === false, test);
    await notifications.deleteChannel(unreachable.id);

    // Offline: the sweep waits out the startup window, which this skips.
    const agent = await prisma.agents.create({
        data: { device_id: device.id, agent_uuid: crypto.randomUUID(), version: "1.3.4", last_check_in_at: new Date(Date.now() - 3_600_000) },
    });
    alerts.startedAt = 0;
    await alerts.sweep();
    let offline = await alerts.list({ deviceId: device.id, state: "OPEN" });
    check("an offline device raises an alert", offline.items.some((a) => a.kind === "offline"), offline.items.map((a) => a.kind));
    await prisma.agents.update({ where: { id: agent.id }, data: { last_check_in_at: new Date() } });
    await alerts.sweep();
    offline = await alerts.list({ deviceId: device.id, state: "OPEN" });
    check("it resolves when the device returns", !offline.items.some((a) => a.kind === "offline"));

    const bulk = await alerts.bulk("ack", [offline.items[0]?.id, crypto.randomUUID()].filter(Boolean), null);
    check("bulk actions report what failed", bulk.updated === 1 && bulk.failed.length === 1, bulk);

    await alerts.updateSettings({ autoTicket: true, autoTicketMinSeverity: "CRIT" });
    await alerts.raise({ deviceId: device.id, kind: "check", dedupeKey: `check:${crypto.randomUUID()}`, severity: "CRIT", title: "Auto ticket test" });
    const auto = await alerts.list({ deviceId: device.id, q: "Auto ticket test" });
    check("automatic tickets open at the set severity", !!auto.items[0]?.ticketId, auto.items[0]);
    await alerts.updateSettings({ autoTicket: false });

    hook.close();
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
