// Alert notification webhooks against a real database and a local receiver: the message is written the way Slack, Discord and Teams expect
// (chosen from the address, or set by hand), ADG RMM's own signed JSON is unchanged for any other address, a receiver that refuses the
// message (a 400) is not asked again, a busy one (429, 5xx, a timeout) is, and no sooner than it said. Throwaway database only.
// Usage, from backend/ after building: ADG_E2E_ALLOW=1 DATABASE_URL=postgres://.../adg_x_e2e node test/notification-delivery.e2e.cjs
"use strict";
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

let passed = 0, failed = 0;
function check(name, ok, extra) {
    if (ok) passed++; else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e.message ?? e)); } };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { AlertsService } = require(path.join(dist, "alerts/alerts.service.js"));
    const N = require(path.join(dist, "notifications/notifications.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const alerts = app.get(AlertsService, { strict: false });
    const notifications = app.get(N.NotificationsService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    /* ------------------------------ the pure parts ------------------------------ */
    check("the format follows the address: Slack, Discord, Teams, otherwise ADG RMM's own", N.webhookFormatFor("https://hooks.slack.com/services/T0/B0/xxx") === "slack"
        && N.webhookFormatFor("https://discord.com/api/webhooks/123/abc") === "discord" && N.webhookFormatFor("https://discordapp.com/api/webhooks/123/abc") === "discord"
        && N.webhookFormatFor("https://contoso.webhook.office.com/webhookb2/abc") === "teams" && N.webhookFormatFor("https://prod-12.westus.logic.azure.com/workflows/abc") === "teams"
        && N.webhookFormatFor("https://example.com/hook") === "adgrmm" && N.webhookFormatFor("not a url") === "adgrmm"
        && N.webhookFormatFor("https://discord.com/channels/1/2") === "adgrmm");
    check("a format chosen by hand wins over the address, and a wrong one is ignored", N.webhookFormatFor("https://example.com/hook", "slack") === "slack" && N.webhookFormatFor("https://hooks.slack.com/x", "adgrmm") === "adgrmm" && N.webhookFormatFor("https://hooks.slack.com/x", "pigeon") === "slack");
    const alert = { id: "a1", title: "Disk C: is 95% full", severity: "CRIT", state: "OPEN", detail: "Only 12 GB left", device: { id: "d1", name: "PC-7", customer: "Acme", site: "HQ" } };
    const text = N.webhookText({ event: "opened", alert }, "https://console.example.test");
    check("the chat text says what, where and gives a link", /^Critical alert: Disk C: is 95% full on PC-7 \(Acme \/ HQ\)\nOnly 12 GB left\nOpen the device: https:\/\/console\.example\.test\/devices\/d1$/.test(text), text);
    check("labels: warning, resolved, still open, test", /^Warning:/.test(N.webhookText({ event: "opened", alert: { ...alert, severity: "WARN" } })) && /^Resolved:/.test(N.webhookText({ event: "resolved", alert })) && /^Still open:/.test(N.webhookText({ event: "reminder", alert })) && /^Test:/.test(N.webhookText({ event: "test", alert: { title: "t" } })));
    const slack = N.webhookBody("slack", { event: "opened", alert });
    const discord = N.webhookBody("discord", { event: "opened", alert: { ...alert, detail: "x".repeat(5000) } });
    const teams = N.webhookBody("teams", { event: "opened", alert });
    const own = N.webhookBody("adgrmm", { event: "opened", alert }, "", "2026-11-18T00:00:00.000Z");
    check("each body has the shape its service accepts", typeof slack.text === "string" && typeof discord.content === "string" && discord.content.length <= 1900 && discord.allowed_mentions.parse.length === 0
        && teams.type === "message" && teams.attachments[0].contentType === "application/vnd.microsoft.card.adaptive" && teams.attachments[0].content.body[0].type === "TextBlock", { slack, teams });
    check("ADG RMM's own body is the event, the alert and the time, as before", own.event === "opened" && own.alert.id === "a1" && own.sentAt === "2026-11-18T00:00:00.000Z" && Object.keys(own).sort().join() === "alert,event,sentAt");
    check("an @everyone in an alert title cannot ping a Discord channel", N.webhookBody("discord", { event: "opened", alert: { ...alert, title: "@everyone look" } }).allowed_mentions.parse.length === 0);
    check("which answers are final: 400, 401, 403, 404, 410 are; 408, 425, 429, 500, 502, 503 are not", [400, 401, 403, 404, 410].every((s) => new N.WebhookRejected(s, "x").permanent) && [408, 425, 429, 500, 502, 503].every((s) => !new N.WebhookRejected(s, "x").permanent));

    /* ------------------------------ a receiver ------------------------------ */
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            seen.push({ url: req.url, headers: req.headers, body });
            const r = server.reply ?? { status: 200 };
            res.statusCode = r.status;
            for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
            res.end(r.body ?? "");
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    /* ------------------------------ what each channel sends ------------------------------ */
    const slackCh = await notifications.createChannel({ name: "S", kind: "webhook", url: `${base}/slack`, format: "slack", enabled: false });
    const discordCh = await notifications.createChannel({ name: "D", kind: "webhook", url: `${base}/discord`, format: "discord", enabled: false });
    const teamsCh = await notifications.createChannel({ name: "T", kind: "webhook", url: `${base}/teams`, format: "teams", enabled: false });
    const ownCh = await notifications.createChannel({ name: "O", kind: "webhook", url: `${base}/own`, enabled: false });
    check("listing shows the format each channel will use", (await notifications.listChannels()).items.filter((c) => [slackCh.id, discordCh.id, teamsCh.id, ownCh.id].includes(c.id)).map((c) => c.format).sort().join() === "discord,adgrmm,slack,teams");
    check("a format that does not exist is refused when creating and updating", await fails(() => notifications.createChannel({ name: "X", kind: "webhook", url: `${base}/x`, format: "pigeon" }), /message format/) && await fails(() => notifications.updateChannel(ownCh.id, { format: "pigeon" }), /message format/));
    const choice = async (id) => (await notifications.listChannels()).items.find((c) => c.id === id);
    check("the list says what was chosen (null means follow the address) and what is used", (await choice(slackCh.id)).formatChosen === "slack" && (await choice(ownCh.id)).formatChosen === null && (await choice(ownCh.id)).format === "adgrmm");
    await notifications.updateChannel(ownCh.id, { format: "discord" });
    const picked = await choice(ownCh.id);
    await notifications.updateChannel(ownCh.id, { format: "auto" });
    const back = await choice(ownCh.id);
    check("choosing Automatic again clears the choice and the address decides", picked.formatChosen === "discord" && picked.format === "discord" && back.formatChosen === null && back.format === "adgrmm", { picked, back });
    const autoCreated = await notifications.createChannel({ name: "Auto", kind: "webhook", url: "https://hooks.slack.com/services/T0/B0/abc", format: "auto", enabled: false });
    check("creating with Automatic stores no choice, and a Slack address then uses Slack", autoCreated.formatChosen === null && autoCreated.format === "slack", autoCreated);
    check("a format can be changed later", (await notifications.updateChannel(ownCh.id, { format: "slack" })).format === "slack" && (await notifications.updateChannel(ownCh.id, { format: "adgrmm" })).format === "adgrmm");

    for (const [ch, key, name] of [[slackCh, "text", "Slack"], [discordCh, "content", "Discord"]]) {
        seen.length = 0; server.reply = { status: 200 };
        const r = await notifications.testChannel(ch.id);
        const b = JSON.parse(seen[0]?.body ?? "{}");
        check(`the test message to a ${name} channel is the ${name} shape`, r.ok === true && typeof b[key] === "string" && /^Test:/.test(b[key]) && !("event" in b), { r, b });
    }
    seen.length = 0;
    await notifications.testChannel(teamsCh.id);
    check("the test message to a Teams channel is an adaptive card message", JSON.parse(seen[0]?.body ?? "{}").type === "message");
    seen.length = 0;
    await notifications.testChannel(ownCh.id);
    const ownBody = JSON.parse(seen[0]?.body ?? "{}");
    check("the test message to any other address is ADG RMM's own signed JSON", ownBody.event === "test" && !!ownBody.sentAt && /^sha256=[0-9a-f]{64}$/.test(seen[0].headers["x-adg-signature"]) && seen[0].headers["x-adg-event"] === "test", seen[0]?.headers);
    server.reply = { status: 400, body: JSON.stringify({ message: "Cannot send an empty message", code: 50006 }) };
    const refused = await notifications.testChannel(discordCh.id);
    check("the test says what the receiver said, not just the number", refused.ok === false && /status 400: .*Cannot send an empty message/.test(refused.message), refused);

    /* ------------------------------ delivery: final answers and busy receivers ------------------------------ */
    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Notify ${Date.now()}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
    let n = 0;
    async function deliver(reply, format = "slack") {
        // only this channel is on while the alert opens, so only it gets a delivery
        const ch = await notifications.createChannel({ name: `Case ${++n}`, kind: "webhook", url: `${base}/case${n}`, format, minSeverity: "WARN" });
        const device = await prisma.devices.create({ data: { site_id: site.id, hostname: `NOTIFY-${Date.now()}-${n}` } });
        server.reply = reply;
        seen.length = 0;
        await alerts.onCheckRun({ deviceId: device.id, assignmentId: crypto.randomUUID(), checkName: "Disk C:", status: "CRIT", severity: "CRIT", output: "disk at 95%" });
        await notifications.work();
        const rows = await prisma.notification_deliveries.findMany({ where: { channel_id: ch.id } });
        await notifications.updateChannel(ch.id, { enabled: false });
        return { rows, requests: seen.length, ch };
    }

    let r = await deliver({ status: 400, body: "Bad payload" });
    check("a 400 is final: one try, failed at once, with the reason, and it is not scheduled again", r.rows.length === 1 && r.rows[0].status === "failed" && r.rows[0].attempts === 1 && /status 400: Bad payload/.test(r.rows[0].last_error) && r.requests === 1, r.rows);
    r = await deliver({ status: 404, body: "Unknown Webhook" });
    check("a 404 is final too", r.rows[0].status === "failed" && r.rows[0].attempts === 1, r.rows);
    r = await deliver({ status: 429, headers: { "Retry-After": "7200" }, body: "rate limited" });
    const wait = r.rows[0].next_attempt_at.getTime() - Date.now();
    check("a 429 is asked again, and no sooner than the receiver said (2 hours, not the usual minute)", r.rows[0].status === "pending" && r.rows[0].attempts === 1 && wait > 119 * 60_000 && wait <= 121 * 60_000, { wait: Math.round(wait / 60_000), row: r.rows[0] });
    r = await deliver({ status: 429, body: "rate limited" });
    const wait2 = r.rows[0].next_attempt_at.getTime() - Date.now();
    check("a 429 with no Retry-After uses the usual first delay (1 minute)", r.rows[0].status === "pending" && wait2 > 30_000 && wait2 <= 61_000, Math.round(wait2 / 1000));
    r = await deliver({ status: 500, body: "oops" });
    check("a 500 is asked again", r.rows[0].status === "pending" && r.rows[0].attempts === 1 && /status 500/.test(r.rows[0].last_error), r.rows);
    r = await deliver({ status: 408 });
    check("a 408 is asked again", r.rows[0].status === "pending", r.rows);
    r = await deliver({ status: 200 }, "discord");
    check("a good answer is delivered, once", r.rows[0].status === "delivered" && r.rows[0].attempts === 1 && r.requests === 1 && typeof JSON.parse(seen[0].body).content === "string", r.rows);
    r = await deliver({ status: 200 }, "slack");
    const sent = JSON.parse(seen[0].body);
    check("a real alert reaches Slack as readable text with the customer, the site and the link", /^Critical alert: Disk C: .* on NOTIFY-\d+-\d+ \(Notify \d+ \/ HQ\)/.test(sent.text) && /Open the device: https:\/\/console\.example\.test\/devices\//.test(sent.text), sent);

    server.close();
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
