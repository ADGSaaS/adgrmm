// Outbound webhooks to Slack, Discord and Microsoft Teams: the message each service accepts (and nothing else, since they answer anything
// else with a 400), made from real ticket, alert and monitor events, delivered to local receivers, with text that cannot mention everyone,
// the format chosen from the address or by hand, and failures that are retried only when retrying could help.
// Usage, from backend/ after building: DIST=dist RIQ_E2E_ALLOW=1 DATABASE_URL=postgres://.../riq_x_e2e node test/webhook-chat.e2e.cjs
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
process.env.PUBLIC_CONSOLE_URL = "https://console.example.test";

let passed = 0, failed = 0;
function check(name, ok, extra) {
    if (ok) passed++; else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra).slice(0, 600)}` : ""}`);
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
    const chat = require(path.join(dist, "webhooks/webhook-chat.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    /* ------------------------------ the messages alone ------------------------------ */
    const ticketEnv = (over = {}) => ({ id: "1", event: "ticket.created", createdAt: "2026-01-01T00:00:00Z", data: { ticket: { id: "t1", number: 42, subject: "Printer is down", status: "open", priority: "high", customer: "Acme", url: "https://console.example.test/tickets/t1", ...over } } });
    const evil = ticketEnv({ subject: "<!channel> <@U123> & <https://evil.example|click> **bold** `tick`", customer: "<!everyone>" });
    const sl = chat.chatBody("slack", evil);
    check("Slack: the subject cannot mention everyone or hide a link: < > & are entities, and the link is ours", !/<!channel>|<@U123>|<!everyone>|<https:\/\/evil/.test(sl.text) && sl.text.includes("&lt;!channel&gt;") && sl.text.includes("&amp;") && sl.text.includes("<https://console.example.test/tickets/t1|Open the ticket>"), sl.text);
    check("Slack: a headline in bold, the details and the link; links are not unfurled", /^\*New ticket: #42 /.test(chat.chatBody("slack", ticketEnv()).text) && chat.chatBody("slack", ticketEnv()).unfurl_links === false);
    const di = chat.chatBody("discord", evil);
    check("Discord: nobody can be mentioned (allowed_mentions is empty), and the text is under the 2000 limit", Array.isArray(di.allowed_mentions.parse) && di.allowed_mentions.parse.length === 0 && di.content.length <= 1900);
    const longEnv = ticketEnv({ subject: "x".repeat(5000) });
    check("long text is cut for every service", chat.chatBody("discord", longEnv).content.length <= 1900 && chat.chatBody("slack", longEnv).text.length <= 3000 && JSON.stringify(chat.chatBody("teams", longEnv)).length < 28_000);
    const te = chat.chatBody("teams", ticketEnv());
    const card = te.attachments?.[0]?.content;
    check("Teams: a message with an adaptive card, a bold headline and an Open button", te.type === "message" && te.attachments[0].contentType === "application/vnd.microsoft.card.adaptive" && card.type === "AdaptiveCard" && card.body[0].weight === "Bolder" && card.actions?.[0]?.type === "Action.OpenUrl" && card.actions[0].url === "https://console.example.test/tickets/t1", te);
    const noLink = chat.chatBody("teams", ticketEnv({ url: "javascript:alert(1)" }));
    check("Teams: a link that is not http or https never becomes a button", !noLink.attachments[0].content.actions);
    check("RemoteIQ's own format is left as it was (no chat body)", chat.chatBody("remoteiq", ticketEnv()) === null);
    check("the format comes from the address when it is auto, and from the choice when there is one", chat.formatFor("https://hooks.slack.com/services/T/B/x", "auto") === "slack" && chat.formatFor("https://discord.com/api/webhooks/1/x", null) === "discord" && chat.formatFor("https://x.webhook.office.com/webhookb2/y", "auto") === "teams" && chat.formatFor("https://prod-1.westus.logic.azure.com/workflows/z", undefined) === "teams" && chat.formatFor("https://example.com/hook", "auto") === "remoteiq" && chat.formatFor("https://example.com/hook", "slack") === "slack" && chat.formatFor("https://hooks.slack.com/x", "remoteiq") === "remoteiq");
    const m = (event, data) => chat.chatMessage({ event, data });
    check("a ticket update says what changed and who changed it", (() => { const x = m("ticket.updated", { ...ticketEnv().data, changes: [{ field: "status", from: "open", to: "in_progress" }, { field: "assignee", from: null, to: "Sam" }], changedBy: "Sam" }); return x.title.startsWith("Ticket updated: #42") && x.lines.join("|").includes("status: open to in_progress") && x.lines.join("|").includes("assignee: none to Sam") && x.lines.join("|").includes("By Sam"); })());
    check("a device offline, a monitor problem and a recovery read as plain sentences", (() => {
        const a = m("device.offline", { device: { id: "d", name: "PC-1", customer: "Acme", site: "HQ" }, url: "https://console.example.test/devices/d" });
        const b = m("monitor.failed", { monitor: { kind: "certificate", host: "www.acme.example", port: 443, customer: "Acme", url: "https://console.example.test/monitoring/web" }, severity: "failed", detail: "The certificate runs out in 3 days." });
        const c = m("monitor.recovered", { monitor: { kind: "domain", host: "acme.example", customer: "Acme" }, severity: "ok", detail: "Registered until 2027-01-01." });
        return a.title === "Device offline: PC-1" && a.lines.includes("Acme / HQ") && b.title === "Problem: Certificate of www.acme.example" && b.lines.includes("The certificate runs out in 3 days.") && c.title === "Recovered: Domain of acme.example" && !c.link;
    })());
    check("an event with no special wording still gives a readable message", chat.chatMessage({ event: "future.thing", data: { a: 1 } }).title === "future.thing");

    /* ------------------------------ delivered for real ------------------------------ */
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const alerts = app.get(AlertsService, { strict: false });
    const tickets = app.get(TicketsService, { strict: false });
    const hooks = app.get(WebhooksService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const received = [];
    const status = {};
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            received.push({ path: req.url, headers: req.headers, body });
            const s = status[req.url] ?? 200;
            res.statusCode = s;
            res.end(s === 400 ? "Cannot send an empty message" : "");
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const at = (p, event) => received.filter((r) => r.path === p && (!event || r.headers["x-remoteiq-event"] === event));
    const settle = async () => { await sleep(400); await hooks.work(); await sleep(200); };

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Chat Customer ${Date.now()}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "Head Office" } });
    const device = await prisma.devices.create({ data: { site_id: site.id, hostname: "CHAT-PC-1" } });
    await prisma.webhook_endpoints.deleteMany({});
    const EVENTS = ["ticket.created", "ticket.updated", "alert.opened", "alert.resolved", "device.offline", "monitor.failed", "monitor.recovered"];

    const refuses = async (input) => { try { await hooks.create(org.id, { name: "x", url: `${base}/x`, events: EVENTS, ...input }, null); return false; } catch (e) { return /format/i.test(e.message); } };
    check("a message format that is not one of the five is refused", await refuses({ format: "whatsapp" }));
    const plain = await hooks.create(org.id, { name: "Plain", url: `${base}/plain`, events: EVENTS }, null);
    check("the format is auto unless chosen, and the list says what it will send (from the address: RemoteIQ's own)", plain.format === "auto" && plain.sends === "remoteiq", plain);
    const eps = {};
    for (const f of ["slack", "teams", "discord", "remoteiq"]) eps[f] = await hooks.create(org.id, { name: `Chat ${f}`, url: `${base}/${f}`, events: EVENTS, format: f }, null);
    check("a chosen format is kept and shown", eps.slack.format === "slack" && eps.slack.sends === "slack" && eps.teams.sends === "teams");
    const lookalike = await hooks.create(org.id, { name: "Lookalike", url: "http://hooks.slack.com.attacker.invalid/x", events: ["ticket.created"] }, null);
    check("an address that only looks like Slack's (hooks.slack.com.attacker...) is not treated as Slack", lookalike.sends === "remoteiq", lookalike);

    const req = { user: { organizationId: org.id, name: "Tester" } };
    const ticketId = await tickets.create({ subject: "Chat <!channel> printer is down", priority: "high", clientId: client.id }, req);
    await settle();
    const tk = (f) => JSON.parse(at(`/${f}`, "ticket.created")[0]?.body || "{}");
    check("Slack gets a message with text, the ticket in it, and the mention made harmless", /\*New ticket: #\d+ Chat &lt;!channel&gt; printer is down\*/.test(tk("slack").text || "") && !/<!channel>/.test(tk("slack").text || ""), tk("slack"));
    check("Teams gets an adaptive card message", tk("teams").type === "message" && tk("teams").attachments?.[0]?.content?.body?.[0]?.text?.startsWith("New ticket: #"), tk("teams"));
    check("Discord gets content and no mentions", /^\*\*New ticket: #\d+/.test(tk("discord").content || "") && tk("discord").allowed_mentions?.parse?.length === 0, tk("discord"));
    check("a webhook that asks for RemoteIQ's format, and one left on auto at an ordinary address, still get the signed envelope", tk("remoteiq").event === "ticket.created" && tk("remoteiq").data?.ticket?.id === ticketId && JSON.parse(at("/plain", "ticket.created")[0]?.body || "{}").event === "ticket.created");
    check("every send is still signed and carries the event name, whatever the message looks like", received.filter((r) => r.path === "/slack").every((r) => /^sha256=[0-9a-f]{64}$/.test(r.headers["x-remoteiq-signature"] || "") && r.headers["x-remoteiq-event"]));
    check("each webhook got the ticket once", ["slack", "teams", "discord", "remoteiq", "plain"].every((f) => at(`/${f}`, "ticket.created").length === 1));

    await tickets.update(ticketId, { status: "in_progress" }, req);
    await settle();
    const upd = JSON.parse(at("/slack", "ticket.updated")[0]?.body || "{}");
    check("an update reaches Slack with what changed", /Ticket updated: #\d+/.test(upd.text || "") && /status: \w+ to in_progress/.test(upd.text || ""), upd);

    const assignmentId = crypto.randomUUID();
    await alerts.onCheckRun({ deviceId: device.id, assignmentId, checkName: "Disk C:", status: "CRIT", severity: "CRIT", output: "disk at 99%" });
    await settle();
    const ao = JSON.parse(at("/slack", "alert.opened")[0]?.body || "{}");
    check("an alert reaches Slack: critical, on which device, for which customer, with a link to the device", /Critical alert: .*Disk C:.* on CHAT-PC-1/.test(ao.text || "") && (ao.text || "").includes(client.name) && (ao.text || "").includes(`<https://console.example.test/devices/${device.id}|Open the device>`), ao);
    const aoT = JSON.parse(at("/teams", "alert.opened")[0]?.body || "{}");
    check("and Teams gets the same alert with an Open button", aoT.attachments?.[0]?.content?.actions?.[0]?.url === `https://console.example.test/devices/${device.id}`, aoT);
    await alerts.onCheckRun({ deviceId: device.id, assignmentId, checkName: "Disk C:", status: "OK", severity: null, output: "" });
    await settle();
    check("the resolution reaches Slack", /Alert resolved: /.test(JSON.parse(at("/slack", "alert.resolved")[0]?.body || "{}").text || ""));
    const raw = JSON.parse(at("/remoteiq", "alert.opened")[0]?.body || "{}");
    check("the RemoteIQ-format alert still has the alert, the device and (new) a link", raw.data?.alert?.title && raw.data?.device?.name === "CHAT-PC-1" && raw.data?.url === `https://console.example.test/devices/${device.id}`, raw.data);

    await hooks.emit("monitor.failed", { monitor: { id: "m1", kind: "certificate", name: "Acme site", host: "www.acme.example", port: 443, customer: "Acme", url: "https://console.example.test/monitoring/web" }, severity: "failed", detail: "The certificate runs out in 3 days (2027-01-01)." }, org.id);
    await hooks.emit("monitor.recovered", { monitor: { id: "m1", kind: "certificate", name: "Acme site", host: "www.acme.example", port: 443, customer: "Acme", url: "https://console.example.test/monitoring/web" }, severity: "ok", detail: "Valid for 90 more days." }, org.id);
    await settle();
    const mf = JSON.parse(at("/slack", "monitor.failed")[0]?.body || "{}"), mr = JSON.parse(at("/discord", "monitor.recovered")[0]?.body || "{}");
    check("a monitor problem and its recovery reach Slack and Discord in words", /Problem: Certificate of www\.acme\.example/.test(mf.text || "") && (mf.text || "").includes("runs out in 3 days") && /Recovered: Certificate of www\.acme\.example/.test(mr.content || ""), [mf, mr]);

    const t = await hooks.test(org.id, eps.slack.id);
    const testMsg = JSON.parse(at("/slack", "webhook.test")[0]?.body || "{}");
    check("the test button sends Slack a readable test message", t.ok === true && /Test from RemoteIQ/.test(testMsg.text || "") && (testMsg.text || "").includes("Chat slack"), [t, testMsg]);

    /* ------------------------------ when the service says no ------------------------------ */
    status["/slack"] = 400;
    await hooks.emit("ticket.created", { ticket: { id: "z", number: 1, subject: "rejected", status: "open", priority: "low" } }, org.id);
    status["/remoteiq"] = 400;
    await settle();
    const log = async (id, ev) => (await prisma.webhook_deliveries.findMany({ where: { endpoint_id: id, event: ev }, orderBy: { created_at: "desc" } }));
    const rej = (await log(eps.slack.id, "ticket.created"))[0];
    check("a chat service that rejects the message (400) is not retried, and what it said is in the log", rej.status === "failed" && rej.attempts === 1 && /status 400: Cannot send an empty message/.test(rej.last_error || ""), rej);
    const rem = (await log(eps.remoteiq.id, "ticket.created"))[0];
    check("RemoteIQ's own format keeps its old rule: a failure is tried again later", rem.status === "pending" && rem.attempts >= 1 || rem.status === "delivered", rem);
    status["/teams"] = 429;
    await hooks.emit("ticket.created", { ticket: { id: "y", number: 2, subject: "busy", status: "open", priority: "low" } }, org.id);
    await settle();
    const busy = (await log(eps.teams.id, "ticket.created"))[0];
    check("a busy chat service (429) is tried again", busy.status === "pending" && busy.attempts === 1 && /429/.test(busy.last_error || ""), busy);

    const upd2 = await hooks.update(org.id, plain.id, { format: "teams" });
    check("the format can be changed later, and a bad one is refused", upd2.format === "teams" && upd2.sends === "teams" && (await hooks.update(org.id, plain.id, { format: "nope" }).then(() => false, (e) => /format/i.test(e.message))));

    // ------------------------------------------------------------------ clean up
    await prisma.webhook_endpoints.deleteMany({});
    await prisma.tickets.deleteMany({ where: { client_id: client.id } });
    await prisma.alerts.deleteMany({ where: { device_id: device.id } });
    await prisma.devices.delete({ where: { id: device.id } });
    await prisma.sites.delete({ where: { id: site.id } });
    await prisma.clients.delete({ where: { id: client.id } });
    server.close();
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
