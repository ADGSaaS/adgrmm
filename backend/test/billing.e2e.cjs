// Money paths against a real database: totals, recurring invoices, payments and Stripe webhooks.
// Usage, from backend/ after building: ADG_E2E_ALLOW=1 DATABASE_URL=postgres://.../adg_e2e node test/billing.e2e.cjs
const crypto = require("node:crypto");
const http = require("node:http");
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
    const { BillingService } = require(path.join(dist, "billing/billing.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const util = require(path.join(dist, "billing/billing.util.js"));

    // ---- arithmetic
    check("a line rounds half up", util.lineAmount(1.5, 3333) === 5000, util.lineAmount(1.5, 3333));
    check("binary fractions do not leak in", util.lineAmount(0.07, 100) === 7, util.lineAmount(0.07, 100));
    const totals = util.computeTotals([{ quantity: 3, unitPriceCents: 1999, taxable: true }, { quantity: 1, unitPriceCents: 500, taxable: false }], 825);
    check("tax applies only to taxable lines", totals.subtotalCents === 6497 && totals.taxCents === 495 && totals.totalCents === 6992, totals);
    check("the 31st becomes the end of February", util.toDateOnly(util.addMonths(new Date("2027-01-31T00:00:00Z"), 1)) === "2027-02-28");
    check("the anchor day returns after a short month", util.toDateOnly(util.addMonths(new Date("2027-02-28T00:00:00Z"), 1, 31)) === "2027-03-31");
    check("a formula in a cell is defused", util.csvCell("=HYPERLINK(1)") === "'=HYPERLINK(1)");
    check("quotes in a cell are escaped", util.csvCell('a"b,c') === '"a""b,c"');

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const billing = app.get(BillingService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Gamma ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "Main" } });
    for (let i = 0; i < 3; i++) {
        const device = await prisma.devices.create({ data: { site_id: site.id, hostname: `G-${stamp}-${i}` } });
        await prisma.agents.create({ data: { device_id: device.id, agent_uuid: crypto.randomUUID(), version: "1.3.5" } });
    }
    // A device with no agent is not a managed device, and is not billed.
    await prisma.devices.create({ data: { site_id: site.id, hostname: `G-${stamp}-noagent` } });

    const role = await prisma.users.findFirst({ select: { id: true } });
    const user = role ?? (await prisma.users.create({ data: { email: `tech${stamp}@example.test`, password_hash: "x", organization_id: org.id } }));

    await billing.saveSettings({ taxRateBps: 1000, paymentTermsDays: 15, defaultHourlyRateCents: 10000, laborCostCents: 4000, publicBaseUrl: "https://console.example/" });

    // ---- invoices
    await rejects("an invoice needs a line", () => billing.createInvoice({ clientId: client.id, lines: [] }), /at least one/);
    const { id: draftId } = await billing.createInvoice({ clientId: client.id, lines: [{ description: "Setup", quantity: 2, unitPriceCents: 5000 }] });
    let invoice = await billing.getInvoice(draftId);
    check("a draft has no number yet", invoice.number === null && invoice.status === "draft");
    check("a draft's totals include tax", invoice.subtotalCents === 10000 && invoice.taxCents === 1000 && invoice.totalCents === 11000, invoice);

    await billing.updateInvoice(draftId, { clientId: client.id, lines: [{ description: "Setup", quantity: 1, unitPriceCents: 5000 }, { description: "Parts", quantity: 1, unitPriceCents: 1000, taxable: false }] });
    invoice = await billing.getInvoice(draftId);
    check("editing a draft recalculates", invoice.totalCents === 6500 && invoice.lines.length === 2, invoice.totalCents);

    await rejects("a sent invoice needs an address", () => billing.send(draftId, "not-an-email"), /email address/);
    const sent = await billing.send(draftId, "billing@example.test");
    check("sending assigns a number and due date", /^INV-\d+$/.test(sent.number) && sent.status === "sent" && !!sent.dueDate, sent);
    check("a failed email is reported, not hidden", sent.emailed === false && !!sent.emailError, sent.emailError);
    await rejects("a sent invoice cannot be edited", () => billing.updateInvoice(draftId, { clientId: client.id, lines: [{ description: "x", quantity: 1, unitPriceCents: 1 }] }), /Only a draft/);
    await rejects("a sent invoice cannot be deleted", () => billing.deleteInvoice(draftId), /Only a draft/);
    const again = await billing.send(draftId, "billing@example.test");
    check("sending again keeps the number", again.number === sent.number, again.number);

    const pdf = await billing.pdf(draftId);
    check("the PDF is a real PDF", pdf.data.subarray(0, 5).toString() === "%PDF-" && pdf.data.length > 500 && pdf.filename.endsWith(".pdf"), pdf.filename);

    // ---- payments
    await rejects("a payment cannot exceed what is owed", () => billing.recordPayment(draftId, { amountCents: 99999, method: "check" }, user.id), /more than is owed/);
    let paid = await billing.recordPayment(draftId, { amountCents: 2500, method: "check", reference: "101" }, user.id);
    check("a part payment leaves a balance", paid.status === "partial" && paid.paidCents === 2500, paid.status);
    await rejects("a paid invoice cannot be voided", () => billing.voidInvoice(draftId), /payments/);
    paid = await billing.removePayment(draftId, paid.payments[0].id);
    check("removing a payment restores the balance", paid.status === "sent" && paid.paidCents === 0, paid.status);
    paid = await billing.recordPayment(draftId, { amountCents: 6500, method: "transfer" }, user.id);
    check("full payment marks it paid", paid.status === "paid", paid.status);

    // ---- time
    const from = util.toDateOnly(new Date());
    await rejects("time must be a sensible amount", () => billing.createTime({ workDate: from, minutes: 0, clientId: client.id }, user.id), /between/);
    await rejects("time needs a real date", () => billing.createTime({ workDate: "2026-02-31", minutes: 30, clientId: client.id }, user.id), /does not exist/);
    const t1 = await billing.createTime({ workDate: from, minutes: 90, clientId: client.id, note: "Fix" }, user.id);
    const t2 = await billing.createTime({ workDate: from, minutes: 30, clientId: client.id }, user.id);
    await billing.createTime({ workDate: from, minutes: 60, clientId: client.id, billable: false }, user.id);

    const someoneElse = crypto.randomUUID();
    await rejects("another technician cannot change your time", () => billing.updateTime(t1.id, { workDate: from, minutes: 1 }, someoneElse, false), /your own/);

    const { id: laborId } = await billing.createInvoice({ clientId: client.id, lines: [{ description: "Base", quantity: 1, unitPriceCents: 100 }] });
    const unapproved = await billing.addUnbilledTime(laborId);
    check("unapproved time is not billed", unapproved.added === 0, unapproved);
    await billing.approveTime([t1.id, t2.id], user.id, true);
    await rejects("approved time is locked to its owner", () => billing.updateTime(t1.id, { workDate: from, minutes: 1 }, user.id, false), /already approved/);
    const added = await billing.addUnbilledTime(laborId);
    check("approved billable time is billed once", added.added === 2 && added.hours === 2, added);
    const labor = await billing.getInvoice(laborId);
    check("labor lands on the invoice with tax", labor.lines.some((l) => l.amountCents === 20000) && labor.totalCents === 22110, labor.totalCents);
    check("nothing is left to bill", (await billing.addUnbilledTime(laborId)).added === 0);
    await rejects("billed time cannot be changed", () => billing.deleteTime(t1.id, user.id, true), /already on an invoice/);
    await billing.deleteInvoice(laborId);
    const freed = await billing.listTime({ clientId: client.id, status: "approved" });
    check("deleting a draft frees its time", freed.items.every((e) => !e.invoiced), freed.items);

    // ---- recurring
    const today = new Date();
    const lastMonth = util.toDateOnly(util.addMonths(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), -1));
    const perDevice = await billing.createContract({ clientId: client.id, name: "Managed devices", kind: "per_device", billingIntervalMonths: 1, startDate: lastMonth, priceCents: 2500 });
    await rejects("per user needs a count", () => billing.createContract({ clientId: client.id, name: "Bad", kind: "per_user", billingIntervalMonths: 1, startDate: lastMonth }), /how many users/);

    const run1 = await billing.generateDueInvoices(today);
    const created = await billing.listInvoices({ clientId: client.id, status: "draft" });
    const contractDrafts = created.items.filter((i) => i.contractId === perDevice.id);
    check("missed periods catch up one invoice each", run1.created >= 2 && contractDrafts.length === 2, { run1, n: contractDrafts.length });
    const first = await billing.getInvoice(contractDrafts[contractDrafts.length - 1].id);
    check("it bills today's agent count, not all devices", first.lines[0].quantity === 3 && first.subtotalCents === 7500, first.lines[0]);
    check("recurring invoices wait as drafts", first.status === "draft" && first.number === null);

    const run2 = await billing.generateDueInvoices(today);
    const after = await billing.listInvoices({ clientId: client.id, status: "draft" });
    check("running again bills nothing twice", run2.created === 0 && after.items.filter((i) => i.contractId === perDevice.id).length === 2, run2);

    let doubleBilled = false;
    try {
        await prisma.invoices.create({ data: { organization_id: org.id, client_id: client.id, contract_id: perDevice.id, period_start: new Date(`${lastMonth}T00:00:00Z`) } });
        doubleBilled = true;
    } catch { /* refused */ }
    check("the database itself refuses a second invoice for a period", !doubleBilled);

    const ended = await billing.createContract({ clientId: client.id, name: "Old", kind: "flat", billingIntervalMonths: 1, startDate: "2020-01-15", endDate: "2020-02-20", priceCents: 1000 });
    await billing.generateDueInvoices(today);
    const endedRow = await prisma.contracts.findUnique({ where: { id: ended.id } });
    check("a contract stops at its end date", endedRow.status === "ended" && (await prisma.invoices.count({ where: { contract_id: ended.id } })) === 2, endedRow.status);

    const hourly = await billing.createContract({ clientId: client.id, name: "Hourly", kind: "hourly", billingIntervalMonths: 1, startDate: from, hourlyRateCents: 15000 });
    await billing.generateDueInvoices(today);
    const hourlyInvoices = await prisma.invoices.findMany({ where: { contract_id: hourly.id }, include: { invoice_lines: true } });
    check("hourly contracts bill approved time", hourlyInvoices.length === 1 && hourlyInvoices[0].subtotal_cents === 30000, hourlyInvoices[0]?.subtotal_cents);

    await rejects("a contract with invoices cannot be deleted", () => billing.deleteContract(perDevice.id), /End it instead/);

    // ---- quotes
    const { id: quoteId } = await billing.createInvoice({ kind: "quote", clientId: client.id, lines: [{ description: "Laptop", quantity: 2, unitPriceCents: 100000 }] });
    const quote = await billing.send(quoteId, "buyer@example.test");
    check("quotes have their own numbers", /^QUO-\d+$/.test(quote.number), quote.number);
    await rejects("a quote cannot be paid", () => billing.recordPayment(quoteId, { amountCents: 1, method: "cash" }, user.id), /cannot be paid/);
    const converted = await billing.convertQuote(quoteId);
    const convertedAgain = await billing.convertQuote(quoteId);
    check("converting twice makes one invoice", converted.id === convertedAgain.id);
    const fromQuote = await billing.getInvoice(converted.id);
    check("the invoice copies the quote", fromQuote.kind === "invoice" && fromQuote.totalCents === 220000 && fromQuote.status === "draft", fromQuote.totalCents);

    // ---- public links, using a token captured by sending
    const { id: payId } = await billing.createInvoice({ clientId: client.id, lines: [{ description: "Monthly", quantity: 1, unitPriceCents: 10000 }] });
    await billing.send(payId, "pay@example.test");
    const payRow = await prisma.invoices.findUnique({ where: { id: payId } });
    check("only a hash of the link is stored", /^[0-9a-f]{64}$/.test(payRow.public_token_hash));
    const realToken = crypto.randomBytes(32).toString("base64url");
    await prisma.invoices.update({ where: { id: payId }, data: { public_token_hash: crypto.createHash("sha256").update(realToken).digest("hex") } });

    await rejects("a wrong link finds nothing", () => billing.publicView("not-a-real-token"), /not valid/);
    const view = await billing.publicView(realToken);
    check("a link shows the invoice", view.totalCents === 11000 && view.lines.length === 1 && view.canPay === false, view);
    check("a link reveals no internal ids", !JSON.stringify(view).includes(client.id) && !JSON.stringify(view).includes(payId));
    await rejects("checkout needs Stripe set up", () => billing.createCheckout(realToken), /not set up/);

    // ---- Stripe, against a local stand-in, since no real account is available here
    const stripeCalls = [];
    const stripe = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            stripeCalls.push({ auth: req.headers.authorization, body: new URLSearchParams(body) });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ id: "cs_test_1", url: "https://checkout.example/cs_test_1" }));
        });
    });
    await new Promise((r) => stripe.listen(0, "127.0.0.1", r));
    process.env.STRIPE_API_BASE = `http://127.0.0.1:${stripe.address().port}`;

    const webhookSecret = "whsec_e2e";
    const saved = await billing.saveSettings({ stripeSecretKey: "sk_test_e2e", stripeWebhookSecret: webhookSecret });
    check("saved keys are never sent back", saved.stripeConfigured === true && !JSON.stringify(saved).includes("sk_test_e2e"));
    const storedSettings = await prisma.billing_settings.findUnique({ where: { organization_id: org.id } });
    check("saved keys are encrypted at rest", storedSettings.stripe_secret_key.startsWith("enc:v1:") && storedSettings.stripe_webhook_secret.startsWith("enc:v1:"));

    const checkout = await billing.createCheckout(realToken);
    check("checkout goes to Stripe's hosted page", checkout.url.startsWith("https://checkout.example/"));
    check("it asks for what is still owed, with the secret key", stripeCalls[0].body.get("line_items[0][price_data][unit_amount]") === "11000" && stripeCalls[0].auth === "Bearer sk_test_e2e" && stripeCalls[0].body.get("metadata[invoice_id]") === payId);

    const event = (id, amount = 11000) => Buffer.from(JSON.stringify({ type: "checkout.session.completed", data: { object: { id, payment_status: "paid", amount_total: amount, metadata: { invoice_id: payId } } } }));
    const sign = (raw, secret = webhookSecret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

    const raw = event("cs_test_1");
    await rejects("an unsigned webhook is refused", () => billing.handleStripeWebhook(raw, undefined), /Bad signature/);
    await rejects("a webhook signed with another key is refused", () => billing.handleStripeWebhook(raw, sign(raw, "whsec_wrong")), /Bad signature/);
    await rejects("an old webhook is refused", () => billing.handleStripeWebhook(raw, sign(raw, webhookSecret, Math.floor(Date.now() / 1000) - 3600)), /Bad signature/);
    await rejects("a changed webhook is refused", () => billing.handleStripeWebhook(event("cs_test_1", 1), sign(raw)), /Bad signature/);
    check("none of those recorded a payment", (await billing.getInvoice(payId)).paidCents === 0);

    await billing.handleStripeWebhook(raw, sign(raw));
    let settled = await billing.getInvoice(payId);
    check("a signed event pays the invoice", settled.status === "paid" && settled.paidCents === 11000, settled.status);
    await billing.handleStripeWebhook(raw, sign(raw));
    settled = await billing.getInvoice(payId);
    check("the same event twice counts once", settled.paidCents === 11000 && settled.payments.length === 1, settled.payments);

    // ---- reports
    const report = await billing.profitability({ from: "2000-01-01", to: "2100-01-01" });
    const line = report.items.find((r) => r.clientId === client.id);
    check("profitability counts revenue before tax", !!line && line.revenueCents > 0 && line.hours === 3 && line.billableHours === 2, line);
    check("margin subtracts labor cost", line.laborCostCents === 12000 && line.marginCents === line.revenueCents - 12000, line);

    const csv = await billing.exportInvoicesCsv({ from: "2000-01-01", to: "2100-01-01" });
    check("the export has a row per line", csv.split("\r\n")[0].startsWith("InvoiceNo,Customer") && csv.includes(sent.number), csv.slice(0, 80));
    check("drafts stay out of the export", !csv.includes("Managed devices:"));

    stripe.close();
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
