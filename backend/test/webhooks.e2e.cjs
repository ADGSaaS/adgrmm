// Outbound webhooks against a real database and a local receiver: creating, validating, signing, the events that are
// sent (ticket created and updated, alert opened and resolved, device offline), only to the webhooks that asked,
// retrying a failure, giving up, the delivery log, and that the secret is never shown again.
// Usage, from backend/ after building: DIST=dist ADG_E2E_ALLOW=1 DATABASE_URL=postgres://.../adg_x_e2e node test/webhooks.e2e.cjs
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}

process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.ALLOW_PRIVATE_WEBHOOKS = "true";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";
process.env.PUBLIC_CONSOLE_URL = "https://console.example.test";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), process.env.DIST || "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { AlertsService } = require(path.join(dist, "alerts/alerts.service.js"));
    const { TicketsService } = require(path.join(dist, "tickets/tickets.service.js"));
    const { WebhooksService } = require(path.join(dist, "webhooks/webhooks.service.js"));
    const core = require(path.join(dist, "webhooks/webhook-core.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const alerts = app.get(AlertsService, { strict: false });
    const tickets = app.get(TicketsService, { strict: false });
    const hooks = app.get(WebhooksService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const received = [];
    const hook = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            received.push({ path: req.url, headers: req.headers, body });
            res.statusCode = hook.status ?? 200;
            res.end();
        });
    });
    await new Promise((r) => hook.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${hook.address().port}`;
    const forPath = (p) => received.filter((r) => r.path === p);
    const settle = async () => { await sleep(400); await hooks.work(); await sleep(200); };

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `WH Customer ${Date.now()}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "Head Office" } });
    const device = await prisma.devices.create({ data: { site_id: site.id, hostname: "WH-PC-1" } });
    await prisma.webhook_endpoints.deleteMany({});

    /* ------------------------------ creating ------------------------------ */
    const everything = await hooks.create(org.id, { name: "Everything", url: `${base}/all`, events: core.EVENT_KEYS }, null);
    const alertsOnly = await hooks.create(org.id, { name: "Alerts only", url: `${base}/alerts`, events: ["alert.opened", "alert.resolved"] }, null);
    const off = await hooks.create(org.id, { name: "Switched off", url: `${base}/off`, events: core.EVENT_KEYS, enabled: false }, null);

    check("a new webhook reveals its signing secret once", /^whsec_/.test(everything.signingSecret || ""), everything);
    const stored = await prisma.webhook_endpoints.findUnique({ where: { id: everything.id } });
    check("the secret is encrypted at rest", String(stored.secret).startsWith("enc:v1:"), stored.secret);
    const listed = await hooks.list(org.id);
    check("listing never returns a secret", !JSON.stringify(listed).includes(everything.signingSecret) && !JSON.stringify(listed).includes("secret"));
    check("the list says which events exist", listed.events.length === core.EVENT_KEYS.length);

    const bad = async (input) => { try { await hooks.create(org.id, input, null); return null; } catch (e) { return e.message || String(e); } };
    check("a name is required", /name/i.test(await bad({ url: `${base}/x`, events: ["ticket.created"] }) || ""));
    check("an event is required, and must exist", /event/i.test(await bad({ name: "x", url: `${base}/x`, events: [] }) || "") && /Unknown event/.test(await bad({ name: "x", url: `${base}/x`, events: ["ticket.deleted"] }) || ""));
    check("only web addresses are accepted", /valid address|https/i.test(await bad({ name: "x", url: "ftp://example.test/x", events: ["ticket.created"] }) || "") && /valid address/i.test(await bad({ name: "x", url: "not a url", events: ["ticket.created"] }) || ""));
    check("a secret in the address is refused", /signature/i.test(await bad({ name: "x", url: "https://user:pass@example.test/x", events: ["ticket.created"] }) || ""));
    check("a name is unique", /already/.test(await bad({ name: "everything", url: `${base}/x`, events: ["ticket.created"] }) || ""));

    /* ------------------------------ the core rules ------------------------------ */
    const sig = core.sign("topsecret", "1700000000", '{"a":1}');
    check("a signature is sha256 of the time, a dot and the body", sig === `sha256=${crypto.createHmac("sha256", "topsecret").update('1700000000.{"a":1}').digest("hex")}`);
    check("a receiver can verify it, and a changed body, secret or a stale time fails", core.verify("topsecret", "1700000000", '{"a":1}', sig, 1700000100) && !core.verify("topsecret", "1700000000", '{"a":2}', sig, 1700000100) && !core.verify("other", "1700000000", '{"a":1}', sig, 1700000100) && !core.verify("topsecret", "1700000000", '{"a":1}', sig, 1700009999));
    check("retries wait 1, 5, 15, 60, 240 then 720 minutes, then give up", [1, 2, 3, 4, 5, 6, 7].map(core.retryDelay).join() === "1,5,15,60,240,720,");

    /* ------------------------------ ticket events ------------------------------ */
    const req = { user: { organizationId: org.id, name: "Tester" } };
    const ticketId = await tickets.create({ subject: "WH printer is down", priority: "high", clientId: client.id }, req);
    await settle();
    let got = forPath("/all").filter((r) => r.headers["x-adg-event"] === "ticket.created");
    check("a new ticket is sent to the webhook that asked for it", got.length === 1, received.length);
    const body = JSON.parse(got[0]?.body || "{}");
    check("the payload names the event and the ticket", body.event === "ticket.created" && body.data?.ticket?.id === ticketId && body.data.ticket.subject === "WH printer is down" && body.data.ticket.priority === "high" && body.data.ticket.customer === client.name && body.data.ticket.url === `https://console.example.test/tickets/${ticketId}`, body);
    const h = got[0].headers;
    check("it is signed and the signature verifies with the secret that was shown", core.verify(everything.signingSecret, h["x-adg-timestamp"], got[0].body, h["x-adg-signature"]));
    check("it carries the event and a delivery id", h["x-adg-event"] === "ticket.created" && h["x-adg-delivery"] === (await prisma.webhook_deliveries.findFirst({ where: { endpoint_id: everything.id, event: "ticket.created" } })).id);
    check("a webhook that did not ask for tickets did not get one", forPath("/alerts").length === 0);
    check("a switched-off webhook gets nothing", forPath("/off").length === 0 && (await prisma.webhook_deliveries.count({ where: { endpoint_id: off.id } })) === 0);

    await tickets.update(ticketId, { status: "in_progress", priority: "urgent" }, req);
    await settle();
    got = forPath("/all").filter((r) => r.headers["x-adg-event"] === "ticket.updated");
    const upd = JSON.parse(got[0]?.body || "{}");
    check("an update says what changed", got.length === 1 && upd.data.changes.some((c) => c.field === "status" && c.from === "open" && c.to === "in_progress") && upd.data.changes.some((c) => c.field === "priority" && c.to === "urgent") && upd.data.ticket.status === "in_progress", upd);
    await tickets.update(ticketId, { status: "in_progress" }, req);
    await settle();
    check("an edit that changes nothing sends nothing", forPath("/all").filter((r) => r.headers["x-adg-event"] === "ticket.updated").length === 1);

    /* ------------------------------ alert events ------------------------------ */
    const assignmentId = crypto.randomUUID();
    await alerts.onCheckRun({ deviceId: device.id, assignmentId, checkName: "Disk C:", status: "CRIT", severity: "CRIT", output: "disk at 99%" });
    await settle();
    let opened = [...forPath("/all"), ...forPath("/alerts")].filter((r) => r.headers["x-adg-event"] === "alert.opened");
    check("an alert that opens is sent to both webhooks that asked", opened.length === 2, opened.length);
    const ob = JSON.parse(opened[0].body);
    check("the payload has the alert and its device", ob.data.alert.title.includes("Disk C:") && ob.data.alert.severity === "CRIT" && ob.data.device.name === "WH-PC-1" && ob.data.device.customer === client.name && ob.data.device.site === "Head Office", ob.data);

    await alerts.onCheckRun({ deviceId: device.id, assignmentId, checkName: "Disk C:", status: "OK", severity: null, output: "" });
    await settle();
    const resolved = [...forPath("/all"), ...forPath("/alerts")].filter((r) => r.headers["x-adg-event"] === "alert.resolved");
    check("an alert that resolves is sent too", resolved.length === 2 && JSON.parse(resolved[0].body).data.alert.state === "RESOLVED", resolved.length);

    await alerts.raise({ maintenanceChecked: true, deviceId: device.id, kind: "offline", dedupeKey: `offline:${device.id}`, severity: "CRIT", title: "WH-PC-1 is offline", detail: "Last seen yesterday." });
    await settle();
    const offline = forPath("/all").filter((r) => r.headers["x-adg-event"] === "device.offline");
    check("a device going offline is a device.offline event, as well as an alert", offline.length === 1 && JSON.parse(offline[0].body).data.device.id === device.id, offline.length);
    check("a webhook that did not ask for it did not get device.offline", forPath("/alerts").filter((r) => r.headers["x-adg-event"] === "device.offline").length === 0);

    /* ------------------------------ failure, retry, give up ------------------------------ */
    hook.status = 500;
    const before = forPath("/all").length;
    await hooks.emit("ticket.created", { ticket: { id: "x", subject: "will fail" } }, org.id);
    await settle();
    let d = await prisma.webhook_deliveries.findFirst({ where: { endpoint_id: everything.id, payload: { path: ["data", "ticket", "subject"], equals: "will fail" } } });
    check("a failed delivery is kept to try again, with the reason", forPath("/all").length === before + 1 && d.status === "pending" && d.attempts === 1 && d.response_status === 500 && /status 500/.test(d.last_error) && d.next_attempt_at.getTime() > Date.now() + 30_000, d);

    hook.status = 200;
    await prisma.webhook_deliveries.update({ where: { id: d.id }, data: { next_attempt_at: new Date(Date.now() - 1000) } });
    await settle();
    d = await prisma.webhook_deliveries.findUnique({ where: { id: d.id } });
    check("the retry delivers it", d.status === "delivered" && d.attempts === 2 && d.response_status === 200 && d.last_error === null && !!d.delivered_at, d);

    hook.status = 500;
    await hooks.emit("ticket.created", { ticket: { id: "y", subject: "never works" } }, org.id);
    const doomed = await prisma.webhook_deliveries.findFirst({ where: { endpoint_id: everything.id, payload: { path: ["data", "ticket", "subject"], equals: "never works" } } });
    await prisma.webhook_deliveries.update({ where: { id: doomed.id }, data: { attempts: 6 } });
    await settle();
    const gone = await prisma.webhook_deliveries.findUnique({ where: { id: doomed.id } });
    check("after the last retry it gives up and says so", gone.status === "failed" && gone.attempts === 7, gone);
    hook.status = 200;

    /* ------------------------------ test, log, changes ------------------------------ */
    const t = await hooks.test(org.id, everything.id);
    check("a test sends a sample now and reports the answer", t.ok === true && t.status === 200 && received.some((r) => r.headers["x-adg-event"] === "webhook.test"), t);
    hook.status = 503;
    const t2 = await hooks.test(org.id, everything.id);
    check("a test against a failing address says why and is not retried", t2.ok === false && /503/.test(t2.message) && (await prisma.webhook_deliveries.count({ where: { endpoint_id: everything.id, event: "webhook.test", status: "pending" } })) === 0, t2);
    hook.status = 200;

    const log = await hooks.deliveries(org.id, everything.id);
    check("the log lists deliveries newest first with their outcome", log.items.length > 5 && log.items[0].createdAt >= log.items[log.items.length - 1].createdAt && log.items.some((i) => i.status === "failed" && i.error) && log.items.some((i) => i.status === "delivered"));
    const summary = (await hooks.list(org.id)).items.find((i) => i.id === everything.id);
    check("the list shows the last result and the counts", summary.last && summary.deliveredLast24h > 3 && summary.failedLast24h >= 2, summary);

    const rotated = await hooks.update(org.id, everything.id, { rotateSecret: true });
    check("rotating the secret shows the new one once and the old one stops matching", rotated.signingSecret && rotated.signingSecret !== everything.signingSecret);
    await hooks.test(org.id, everything.id);
    const lastTest = received.filter((r) => r.headers["x-adg-event"] === "webhook.test").pop();
    check("deliveries after that are signed with the new secret", core.verify(rotated.signingSecret, lastTest.headers["x-adg-timestamp"], lastTest.body, lastTest.headers["x-adg-signature"]) && !core.verify(everything.signingSecret, lastTest.headers["x-adg-timestamp"], lastTest.body, lastTest.headers["x-adg-signature"]));

    await hooks.update(org.id, off.id, { enabled: true });
    const n = forPath("/off").length;
    await hooks.emit("ticket.created", { ticket: { id: "z", subject: "now on" } }, org.id);
    await settle();
    check("turning a webhook on starts it receiving", forPath("/off").length === n + 1);

    try { await hooks.update(org.id, crypto.randomUUID(), { enabled: true }); check("an unknown webhook is not found", false); } catch (e) { check("an unknown webhook is not found", /not found/i.test(e.message)); }
    await hooks.remove(org.id, off.id);
    check("deleting removes its log too", (await prisma.webhook_deliveries.count({ where: { endpoint_id: off.id } })) === 0 && (await prisma.webhook_endpoints.count({ where: { id: off.id } })) === 0);

    // ------------------------------------------------------------------ clean up
    await prisma.webhook_endpoints.deleteMany({});
    await prisma.tickets.deleteMany({ where: { client_id: client.id } });
    await prisma.alerts.deleteMany({ where: { device_id: device.id } });
    await prisma.devices.delete({ where: { id: device.id } });
    await prisma.sites.delete({ where: { id: site.id } });
    await prisma.clients.delete({ where: { id: client.id } });
    hook.close();
    await app.close();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
