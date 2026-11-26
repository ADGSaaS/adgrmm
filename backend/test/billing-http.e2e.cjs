// Billing routes as the outside world reaches them. Runs after billing.e2e.cjs, which saves the Stripe
// webhook secret, against a backend running in production mode.
"use strict";

const crypto = require("node:crypto");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3901";
const DB_URL = process.env.DATABASE_URL || "";

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(DB_URL)) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}

(async () => {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();

    const org = (await db.query(`select id from organizations limit 1`)).rows[0];
    const client = (await db.query(`insert into clients (organization_id, name) values ($1, $2) returning id`, [org.id, `Http ${Date.now()}`])).rows[0];
    const token = crypto.randomBytes(32).toString("base64url");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const invoice = (
        await db.query(
            `insert into invoices (organization_id, client_id, number, status, subtotal_cents, total_cents, public_token_hash)
             values ($1, $2, $3, 'sent', 5000, 5000, $4) returning id`,
            [org.id, client.id, `HTTP-${Date.now()}`, hash]
        )
    ).rows[0];

    // ---- no account needed for a valid link, and nothing without one
    let res = await fetch(`${BASE}/api/public/billing/documents/${token}`);
    let body = await res.json().catch(() => null);
    check("the customer link opens with no account", res.status === 200 && body?.totalCents === 5000, { status: res.status, body });

    res = await fetch(`${BASE}/api/public/billing/documents/${crypto.randomBytes(32).toString("base64url")}`);
    check("a wrong link is not found", res.status === 404, res.status);

    res = await fetch(`${BASE}/api/public/billing/documents/${token}/pdf`);
    const pdf = Buffer.from(await res.arrayBuffer());
    check("the customer can download the PDF", res.status === 200 && pdf.subarray(0, 5).toString() === "%PDF-", res.status);

    // ---- staff routes stay closed
    for (const [method, path] of [["GET", "/api/billing/invoices"], ["GET", "/api/billing/settings"], ["POST", "/api/billing/contracts/run"], ["GET", "/api/billing/reports/invoices.csv?from=2020-01-01&to=2030-01-01"]]) {
        res = await fetch(`${BASE}${path}`, { method, headers: { Origin: process.env.CONSOLE_ORIGIN || "http://console.test" } });
        check(`${method} ${path.split("?")[0]} needs a sign-in`, res.status === 401 || res.status === 403, res.status);
    }

    // ---- the webhook sees the exact bytes Stripe signed
    const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: `cs_http_${Date.now()}`, payment_status: "paid", amount_total: 5000, metadata: { invoice_id: invoice.id } } } }, null, 2);
    const t = Math.floor(Date.now() / 1000);
    const sign = (secret) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
    const post = (signature) =>
        fetch(`${BASE}/api/public/billing/stripe-webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...(signature ? { "Stripe-Signature": signature } : {}) }, body: raw });

    res = await post(null);
    check("an unsigned webhook is refused", res.status === 400, res.status);
    res = await post(sign("whsec_wrong"));
    check("a wrongly signed webhook is refused", res.status === 400, res.status);

    res = await post(sign("whsec_e2e"));
    check("a signed webhook arrives through the real parser", res.status === 200, { status: res.status, body: await res.text() });
    let row = (await db.query(`select status, paid_cents from invoices where id = $1`, [invoice.id])).rows[0];
    check("it pays the invoice", row.status === "paid" && row.paid_cents === 5000, row);

    res = await post(sign("whsec_e2e"));
    row = (await db.query(`select paid_cents from invoices where id = $1`, [invoice.id])).rows[0];
    check("a repeat is accepted and counts once", res.status === 200 && row.paid_cents === 5000, row);

    // ---- other JSON routes still parse normally after the raw parser went in
    res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: process.env.CONSOLE_ORIGIN || "http://console.test" }, body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-1" }) });
    check("normal JSON routes are unaffected", res.status === 401, res.status);

    // ---- limits
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) {
        const r = await fetch(`${BASE}/api/public/billing/documents/not-a-real-token-${i}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
        if (r.status === 429) limited = true;
    }
    check("one address cannot keep guessing links", limited);

    await db.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
