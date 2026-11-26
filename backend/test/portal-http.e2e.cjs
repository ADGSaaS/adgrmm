#!/usr/bin/env node
// The client portal behind the real sign-in: its settings and domain, who gets an account, signing in and the links
// in emails, and above all that a customer's people see only their own company.
// Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... node test/portal-http.e2e.cjs
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3901";
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(new URL(DB_URL).pathname) || !SECRET) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1, JWT_SECRET, and a DATABASE_URL naming an e2e database.");
    process.exit(2);
}

const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`);
    }
}

const call = (path, { method = "GET", staff, portal, body } = {}) =>
    fetch(`${BASE}${path}`, {
        method,
        redirect: "manual",
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            cookie: [staff ? `${COOKIE}=${staff}` : "", portal ? `portal_token=${portal}` : ""].filter(Boolean).join("; "),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
const json = async (path, opts) => (await call(path, opts)).json().catch(() => null);
const portalCookie = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.match(/^portal_token=([^;]*)/)?.[1]).find((v) => v !== undefined);

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const stamp = Date.now();
    const domain = `portal-${stamp}.example.test`;

    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;
    for (const k of ["settings.read", "settings.write", "customers.read", "customers.write", "tickets.read", "tickets.write"]) {
        await q(`INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES ($1,$1,'x','x') ON CONFLICT DO NOTHING`, [k]);
    }
    const made = { users: [], roles: [], clients: [], accounts: [] };

    async function staffUser(label, permissions) {
        const id = uuid();
        made.users.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, org, email, label]);
        const role = uuid();
        made.roles.push(role);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [role, org, `e2e-${label}-${id}`]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role, p]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return { id, email, token: jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" }) };
    }

    const admin = await staffUser("padmin", ["settings.read", "settings.write", "customers.read", "customers.write", "tickets.read", "tickets.write"]);

    // Two customers, each with a site, a device and some invoices and tickets.
    const mk = async (name) => {
        const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${name} ${stamp}`])).rows[0].id;
        made.clients.push(client);
        const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'Main') RETURNING id`, [client])).rows[0].id;
        const device = (await q(`INSERT INTO devices (site_id, hostname) VALUES ($1,$2) RETURNING id`, [site, `${name}-PC-${stamp}`])).rows[0].id;
        await q(`INSERT INTO agents (id, device_id, agent_uuid, hostname, version, last_check_in_at, facts, agent_token, token) VALUES ($1,$2,$5,$3,'1.3.33', now(), '{}'::jsonb, $4, $4)`, [uuid(), device, `${name}-PC-${stamp}`, `t-${uuid()}`, uuid()]);
        return { client, site, device, name };
    };
    // Card payments are not set up for this run, whatever earlier test runs left behind.
    const stripeBefore = (await q(`SELECT stripe_secret_key, stripe_webhook_secret FROM billing_settings WHERE organization_id = $1`, [org])).rows[0];
    await q(`UPDATE billing_settings SET stripe_secret_key = NULL, stripe_webhook_secret = NULL WHERE organization_id = $1`, [org]);
    const A = await mk("Alpha");
    const B = await mk("Beta");

    let invNo = 0;
    const invoice = async (c, status, total = 10000, paid = 0) => (await q(
        `INSERT INTO invoices (organization_id, client_id, kind, number, status, currency, subtotal_cents, total_cents, paid_cents, issue_date, due_date)
         VALUES ($1,$2,'invoice',$3,$4,'USD',$5,$5,$6, CURRENT_DATE, CURRENT_DATE - 3) RETURNING id`, [org, c.client, `PT-${stamp}-${++invNo}`, status, total, paid])).rows[0].id;
    const invA = await invoice(A, "sent");
    const invADraft = await invoice(A, "draft");
    const invAVoid = await invoice(A, "void");
    const invB = await invoice(B, "sent");
    await q(`INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_cents, amount_cents) VALUES ($1,0,'Managed services',1,10000,10000)`, [invA]);

    const ticket = async (c, subject, { status = "open", account = null, device = null } = {}) => (await q(
        `INSERT INTO tickets (organization_id, ticket_number, subject, description, status, client_id, portal_account_id, device_id)
         VALUES ($1, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets WHERE organization_id = $1), $2,'Details',$3::ticket_status,$4,$5,$6) RETURNING id`,
        [org, subject, status, c.client, account, device])).rows[0].id;

    // People: a manager and a plain user at Alpha, a user at Beta. Passwords are set directly so the sign-in is what is tested.
    const PASS = "correct horse battery";
    const person = async (c, label, role) => {
        const email = `${label}-${stamp}@alpha.example.test`.replace("alpha", c.name.toLowerCase());
        const id = (await q(`INSERT INTO portal_accounts (organization_id, client_id, email, name, role, status, password_hash) VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id`,
            [org, c.client, email, `${label} person`, role, await bcrypt.hash(PASS, 4)])).rows[0].id;
        made.accounts.push(id);
        return { id, email, name: `${label} person` };
    };
    const mgrA = await person(A, "mgr", "manager");
    const userA = await person(A, "usr", "user");
    const userB = await person(B, "usr", "user");

    const login = async (p, password = PASS) => {
        const res = await call("/api/portal/auth/login", { method: "POST", body: { email: p.email, password } });
        return { res, token: portalCookie(res) };
    };

    // ------------------------------------------------------------------ settings and the domain
    console.log("settings and the domain");
    await test("the portal starts off, and the public config says so", async () => {
        await q(`DELETE FROM portal_settings`);
        const c = await json("/api/portal/config");
        assert.equal(c.enabled, false);
        assert.equal((await login(mgrA)).res.status, 403, "no sign-in while the portal is off");
    });
    await test("the address is checked, cleaned up, and needed before turning the portal on", async () => {
        const put = (body) => call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body });
        assert.equal((await put({ enabled: true })).status, 400, "no address yet");
        for (const bad of ["not a domain", "10.0.0.1", "localhost", "portal.example.com:8443", "http://"]) {
            assert.equal((await put({ domain: bad })).status, 400, bad);
        }
        assert.equal((await put({ domain: "x".repeat(300) + ".com" })).status, 400);
        const ok = await put({ domain: `  https://${domain.toUpperCase()}/some/path  ` });
        assert.equal(ok.status, 200);
        assert.equal((await ok.json()).domain, domain);
        assert.equal((await put({ modules: ["tickets", "billing-secrets"] })).status, 400);
        assert.equal((await put({ welcomeTitle: "x".repeat(121) })).status, 400);
    });
    await test("settings need permission", async () => {
        const nobody = await staffUser("pnobody", []);
        assert.equal((await call("/api/portal-admin/settings", { staff: nobody.token })).status, 403);
        assert.equal((await call("/api/portal-admin/settings", { method: "PUT", staff: nobody.token, body: { enabled: true } })).status, 403);
        assert.equal((await call("/api/portal-admin/settings")).status, 401);
    });
    await test("turning it on publishes the domain to the web app", async () => {
        const r = await call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body: { enabled: true, welcomeTitle: "Hello", supportEmail: "help@example.test" } });
        assert.equal(r.status, 200);
        const c = await json("/api/portal/config");
        assert.deepEqual({ enabled: c.enabled, domain: c.domain, welcomeTitle: c.welcomeTitle }, { enabled: true, domain, welcomeTitle: "Hello" });
        assert.deepEqual(c.modules.sort(), ["dashboard", "devices", "invoices", "knowledge", "reports", "tickets"]);
    });
    await test("checking an address that is not reachable says so without crashing", async () => {
        const r = await json("/api/portal-admin/settings/check", { method: "POST", staff: admin.token, body: { domain: "nothing-here.invalid" } });
        assert.equal(r.ok, false);
        assert.ok(r.message.length > 10);
        const bad = await json("/api/portal-admin/settings/check", { method: "POST", staff: admin.token, body: { domain: "10.1.1.1" } });
        assert.equal(bad.ok, false);
    });

    // ------------------------------------------------------------------ two separate worlds
    console.log("staff and portal sign-ins stay apart");
    let mgrTok, userATok, userBTok;
    await test("signing in works, wrong passwords and unknown people look the same", async () => {
        const good = await login(mgrA);
        assert.equal(good.res.status, 200);
        assert.ok(good.token && good.token.length > 40);
        const cookie = good.res.headers.getSetCookie().find((c) => c.startsWith("portal_token="));
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
        mgrTok = good.token;
        userATok = (await login(userA)).token;
        userBTok = (await login(userB)).token;
        const wrong = await login(mgrA, "nope-nope-nope");
        const ghost = await login({ email: `ghost-${stamp}@example.test` });
        assert.equal(wrong.res.status, 401);
        assert.equal(ghost.res.status, 401);
        assert.equal((await wrong.res.json()).message, (await ghost.res.json()).message);
    });
    await test("nothing opens without a portal sign-in", async () => {
        for (const p of ["dashboard", "tickets", "devices", "invoices", "auth/me"]) assert.equal((await call(`/api/portal/${p}`)).status, 401, p);
        assert.equal((await call("/api/portal/tickets", { portal: "garbage" })).status, 401);
    });
    await test("a staff sign-in is not a portal sign-in, and a portal one is not a staff sign-in", async () => {
        assert.equal((await call("/api/portal/tickets", { portal: admin.token })).status, 401, "staff token as portal cookie");
        assert.equal((await call("/api/portal/tickets", { staff: admin.token })).status, 401, "staff cookie alone");
        assert.equal((await call("/api/customers", { staff: mgrTok })).status, 401, "portal token as staff cookie");
        assert.equal((await call("/api/portal-admin/accounts", { staff: mgrTok })).status, 401);
        // Even a token signed with the staff secret that claims to be a portal one does not work.
        const forged = jwt.sign({ sub: mgrA.id, sid: uuid(), aud: "portal" }, SECRET, { expiresIn: "1h" });
        assert.equal((await call("/api/portal/auth/me", { portal: forged })).status, 401);
    });
    await test("who am I says what this person may open", async () => {
        const m = await json("/api/portal/auth/me", { portal: mgrTok });
        assert.equal(m.role, "manager");
        assert.equal(m.customer, `Alpha ${stamp}`);
        assert.deepEqual(m.modules.sort(), ["dashboard", "devices", "invoices", "knowledge", "reports", "tickets"]);
        const u = await json("/api/portal/auth/me", { portal: userATok });
        assert.deepEqual(u.modules.sort(), ["dashboard", "knowledge", "tickets"], "a plain user has no devices, invoices or reports (help articles are for everyone)");
    });

    // ------------------------------------------------------------------ tickets
    console.log("tickets");
    let tUserA, tOtherInA, tB, tClosed;
    await test("a user sees the tickets they opened; a manager sees the whole company; nobody sees another company", async () => {
        tUserA = await ticket(A, "From the user", { account: userA.id });
        tOtherInA = await ticket(A, "Opened by staff for Alpha");
        tB = await ticket(B, "Beta's secret", { account: userB.id });
        tClosed = await ticket(A, "Old and closed", { status: "closed", account: userA.id });
        const subjects = async (tok) => (await json("/api/portal/tickets", { portal: tok })).map((t) => t.subject).sort();
        assert.deepEqual(await subjects(userATok), ["From the user", "Old and closed"]);
        assert.deepEqual(await subjects(mgrTok), ["From the user", "Old and closed", "Opened by staff for Alpha"]);
        assert.deepEqual(await subjects(userBTok), ["Beta's secret"]);
    });
    await test("another company's ticket, or one a user did not open, cannot be opened by id", async () => {
        assert.equal((await call(`/api/portal/tickets/${tB}`, { portal: mgrTok })).status, 404);
        assert.equal((await call(`/api/portal/tickets/${tOtherInA}`, { portal: userATok })).status, 404);
        assert.equal((await call(`/api/portal/tickets/${tOtherInA}`, { portal: mgrTok })).status, 200);
        assert.equal((await call(`/api/portal/tickets/not-an-id`, { portal: mgrTok })).status, 404);
        assert.equal((await call(`/api/portal/tickets/${tB}/replies`, { method: "POST", portal: mgrTok, body: { body: "hi" } })).status, 404);
    });
    await test("the filters work: open, closed and search", async () => {
        const status = async (s) => (await json(`/api/portal/tickets?status=${s}`, { portal: userATok })).map((t) => t.subject);
        assert.deepEqual(await status("open"), ["From the user"]);
        assert.deepEqual(await status("closed"), ["Old and closed"]);
        assert.deepEqual((await json(`/api/portal/tickets?q=${encodeURIComponent("%")}`, { portal: userATok })), [], "a percent sign is just a character");
        assert.deepEqual((await json(`/api/portal/tickets?q=Old`, { portal: userATok })).map((t) => t.subject), ["Old and closed"]);
    });
    await test("the conversation shows public replies only, and never names or notes from the support team", async () => {
        const add = (kind, body, o) => q(`INSERT INTO ticket_activity (id, ticket_id, kind, body, author, is_internal, is_inbound) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [uuid(), tUserA, kind, body, o.author, o.internal ?? false, o.inbound ?? false]);
        await add("message", "We are looking into it.", { author: "tech@msp.example.test" });
        await add("note", "PRIVATE: customer is difficult", { author: "tech@msp.example.test", internal: true });
        await add("message", "PRIVATE reply flagged internal", { author: "tech@msp.example.test", internal: true });
        const t = await json(`/api/portal/tickets/${tUserA}`, { portal: userATok });
        assert.equal(t.description, "Details");
        assert.deepEqual(t.replies.map((r) => [r.fromSupport, r.author, r.body]), [[true, "Support team", "We are looking into it."]]);
        assert.ok(!JSON.stringify(t).includes("PRIVATE"));
        assert.ok(!JSON.stringify(t).includes("tech@msp"));
    });
    await test("a customer can open a ticket, and it belongs to their company", async () => {
        const r = await call("/api/portal/tickets", { method: "POST", portal: userATok, body: { subject: "Printer is down", description: "Third floor printer shows an error." } });
        assert.equal(r.status, 201);
        const t = await r.json();
        const row = (await q(`SELECT client_id, portal_account_id, status::text AS status, organization_id FROM tickets WHERE id = $1`, [t.id])).rows[0];
        assert.deepEqual(row, { client_id: A.client, portal_account_id: userA.id, status: "open", organization_id: org });
        assert.ok((await json("/api/portal/tickets", { portal: userATok })).some((x) => x.subject === "Printer is down"));
        assert.ok(!(await json("/api/portal/tickets", { portal: userBTok })).some((x) => x.subject === "Printer is down"));
    });
    await test("opening a ticket checks the input; only a manager can pick a device, and only one of theirs", async () => {
        const post = (tok, body) => call("/api/portal/tickets", { method: "POST", portal: tok, body });
        assert.equal((await post(userATok, { subject: "", description: "x" })).status, 400);
        assert.equal((await post(userATok, { subject: "x", description: "" })).status, 400);
        assert.equal((await post(userATok, { subject: "x".repeat(201), description: "x" })).status, 400);
        assert.equal((await post(userATok, { subject: "x", description: "x", deviceId: A.device })).status, 403);
        assert.equal((await post(mgrTok, { subject: "x", description: "x", deviceId: B.device })).status, 400, "another company's device");
        assert.equal((await post(mgrTok, { subject: "About my PC", description: "x", deviceId: A.device })).status, 201);
    });
    await test("a reply goes on the ticket as a customer reply and puts a waiting ticket back to open", async () => {
        await q(`UPDATE tickets SET status = 'pending' WHERE id = $1`, [tUserA]);
        const r = await call(`/api/portal/tickets/${tUserA}/replies`, { method: "POST", portal: userATok, body: { body: "Still broken, please call." } });
        assert.equal(r.status, 200);
        const last = (await q(`SELECT kind, body, author, is_inbound, is_internal FROM ticket_activity WHERE ticket_id = $1 AND body = 'Still broken, please call.'`, [tUserA])).rows[0];
        assert.deepEqual(last, { kind: "message", body: "Still broken, please call.", author: userA.name, is_inbound: true, is_internal: false });
        assert.equal((await q(`SELECT status::text AS s FROM tickets WHERE id = $1`, [tUserA])).rows[0].s, "open");
        assert.equal((await call(`/api/portal/tickets/${tUserA}/replies`, { method: "POST", portal: userATok, body: { body: "   " } })).status, 400);
        assert.equal((await call(`/api/portal/tickets/${tClosed}/replies`, { method: "POST", portal: userATok, body: { body: "hello?" } })).status, 409, "a closed ticket takes no replies");
    });
    await test("a staff ticket for a device belongs to that device's customer", async () => {
        const r = await call("/api/tickets", { method: "POST", staff: admin.token, body: { subject: "Staff made", deviceId: A.device } });
        assert.ok([200, 201].includes(r.status), `status ${r.status}`);
        const id = (await r.json()).id;
        assert.equal((await q(`SELECT client_id FROM tickets WHERE id = $1`, [id])).rows[0].client_id, A.client);
        assert.ok((await json("/api/portal/tickets", { portal: mgrTok })).some((t) => t.subject === "Staff made"));
    });

    await test("staff can set a ticket's customer when making it or later, and the portal follows", async () => {
        const made = await call("/api/tickets", { method: "POST", staff: admin.token, body: { subject: "No device, for Alpha", clientId: A.client } });
        assert.ok([200, 201].includes(made.status), `status ${made.status}`);
        const id = (await made.json()).id;
        assert.equal((await q(`SELECT client_id FROM tickets WHERE id = $1`, [id])).rows[0].client_id, A.client);
        assert.ok((await json("/api/portal/tickets", { portal: mgrTok })).some((t) => t.subject === "No device, for Alpha"));
        assert.ok(!(await json("/api/portal/tickets", { portal: userBTok })).some((t) => t.subject === "No device, for Alpha"));
        // Moving it to another customer takes it away from the first, and clearing it takes it away from everyone.
        assert.equal((await call(`/api/tickets/${id}`, { method: "PATCH", staff: admin.token, body: { clientId: B.client } })).status, 200);
        assert.ok(!(await json("/api/portal/tickets", { portal: mgrTok })).some((t) => t.subject === "No device, for Alpha"));
        assert.equal((await call(`/api/tickets/${id}`, { method: "PATCH", staff: admin.token, body: { clientId: null } })).status, 200);
        assert.equal((await q(`SELECT client_id FROM tickets WHERE id = $1`, [id])).rows[0].client_id, null);
        assert.equal((await call(`/api/tickets/${id}`, { method: "PATCH", staff: admin.token, body: { clientId: uuid() } })).status, 400, "a customer that does not exist");
        assert.equal((await call("/api/tickets", { method: "POST", staff: admin.token, body: { subject: "x", clientId: "nope" } })).status, 400);
        const shown = await json(`/api/tickets/${id}`, { staff: admin.token });
        assert.equal(shown.clientId ?? null, null);
    });

    console.log("new replies, where a reply came from, and where mail goes");
    await test("the portal points out replies from support that have not been seen, and opening the ticket marks them seen", async () => {
        const t = await ticket(A, "Needs a look", { account: userA.id });
        const unread = async (tok) => (await json("/api/portal/tickets", { portal: tok })).find((x) => x.id === t)?.unread;
        assert.equal(await unread(userATok), false, "no reply yet");
        await q(`INSERT INTO ticket_activity (id, ticket_id, kind, body, author, is_internal, is_inbound) VALUES ($1,$2,'message','We fixed it.','tech',false,false)`, [uuid(), t]);
        await q(`INSERT INTO ticket_activity (id, ticket_id, kind, body, author, is_internal, is_inbound) VALUES ($1,$2,'note','private','tech',true,false)`, [uuid(), t]);
        assert.equal(await unread(userATok), true);
        assert.equal((await json("/api/portal/auth/me", { portal: userATok })).unreadReplies >= 1, true);
        assert.equal((await json("/api/portal/dashboard", { portal: userATok })).unreadReplies >= 1, true);
        const first = await json(`/api/portal/tickets/${t}`, { portal: userATok });
        assert.deepEqual(first.replies.map((r) => [r.body, r.isNew]), [["We fixed it.", true]]);
        assert.equal(await unread(userATok), false, "seen");
        const second = await json(`/api/portal/tickets/${t}`, { portal: userATok });
        assert.deepEqual(second.replies.map((r) => r.isNew), [false]);
        // A private note alone never counts as a reply.
        await q(`INSERT INTO ticket_activity (id, ticket_id, kind, body, author, is_internal) VALUES ($1,$2,'note','another private','tech',true)`, [uuid(), t]);
        assert.equal(await unread(userATok), false);
    });
    await test("a reply written in the portal says so, and the technician is told about it until they open the ticket", async () => {
        const t = await ticket(A, "Customer will reply", { account: userA.id });
        const tech = await staffUser("ptech", ["tickets.read", "tickets.write", "customers.read"]);
        const listed = async () => (await json("/api/tickets?pageSize=200", { staff: tech.token })).find((x) => x.id === t);
        assert.equal((await listed()).hasNewReply, false, "nothing from the customer yet");
        assert.equal((await call(`/api/portal/tickets/${t}/replies`, { method: "POST", portal: userATok, body: { body: "Any update?" } })).status, 200);
        assert.equal((await q(`SELECT via FROM ticket_activity WHERE ticket_id = $1 AND body = 'Any update?'`, [t])).rows[0].via, "portal");
        const row = await listed();
        assert.equal(row.hasNewReply, true);
        assert.equal(row.requesterEmail, userA.email, "who asked is the portal person");
        assert.equal(row.requesterName, userA.name);
        const replies = await json(`/api/tickets/${t}/replies`, { staff: tech.token });
        assert.deepEqual(replies.filter((r) => r.isInbound).map((r) => r.via), ["portal"], "not shown as an email");
        assert.equal((await call(`/api/tickets/${t}/read`, { method: "POST", staff: tech.token })).status, 200);
        assert.equal((await listed()).hasNewReply, false, "read");
        assert.equal((await json(`/api/tickets/${t}`, { staff: tech.token })).hasNewReply, false);
        await call(`/api/portal/tickets/${t}/replies`, { method: "POST", portal: userATok, body: { body: "Hello again" } });
        assert.equal((await json(`/api/tickets/${t}`, { staff: tech.token })).hasNewReply, true, "a newer reply is new again");
        // Another technician has their own view of what is new.
        const other = await staffUser("ptech2", ["tickets.read"]);
        assert.equal((await json(`/api/tickets/${t}`, { staff: other.token })).hasNewReply, true);
    });
    await test("an emailed reply from the customer is still labelled as email", async () => {
        const t = await ticket(A, "By email");
        await q(`INSERT INTO ticket_activity (id, ticket_id, kind, body, author, is_internal, is_inbound) VALUES ($1,$2,'message','from my phone','Pat',false,true)`, [uuid(), t]);
        const replies = await json(`/api/tickets/${t}/replies`, { staff: admin.token });
        assert.deepEqual(replies.map((r) => r.via), ["email"]);
    });
    await test("people entered on a new customer are invited to the portal as managers", async () => {
        const make = (body) => call("/api/customers", { method: "POST", staff: admin.token, body });
        const r = await make({ name: `Delta ${stamp}`, contacts: [{ name: "Dana Boss", email: `dana-${stamp}@delta.example.test`, role: "other" }, { name: "No Email", email: "" }, { name: "Eli", email: `eli-${stamp}@delta.example.test` }] });
        assert.ok([200, 201].includes(r.status), `status ${r.status}`);
        const body = await r.json();
        made.clients.push(body.id);
        assert.equal(body.portalInvites.invited + body.portalInvites.failed, 2, "one for each person with an email");
        const accounts = (await q(`SELECT email::text AS email, role, status, contact_id IS NOT NULL AS linked FROM portal_accounts WHERE client_id = $1 ORDER BY email`, [body.id])).rows;
        assert.deepEqual(accounts, [
            { email: `dana-${stamp}@delta.example.test`, role: "manager", status: "invited", linked: true },
            { email: `eli-${stamp}@delta.example.test`, role: "manager", status: "invited", linked: true },
        ]);
        // An email that already has portal access is left alone, and with the portal off nobody is invited.
        const again = await make({ name: `Delta2 ${stamp}`, contacts: [{ name: "Dana Again", email: `dana-${stamp}@delta.example.test` }] });
        const second = await again.json();
        made.clients.push(second.id);
        assert.equal(second.portalInvites.invited + second.portalInvites.failed, 0);
        await call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body: { enabled: false } });
        const off = await (await make({ name: `Delta3 ${stamp}`, contacts: [{ name: "Fay", email: `fay-${stamp}@delta.example.test` }] })).json();
        made.clients.push(off.id);
        assert.deepEqual(off.portalInvites, { invited: 0, failed: 0 });
        assert.equal((await q(`SELECT count(*)::int AS n FROM portal_accounts WHERE client_id = $1`, [off.id])).rows[0].n, 0);
        await call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body: { enabled: true } });
    });
    await test("a technician's reply never goes to another contact on a portal ticket", async () => {
        const t = await ticket(A, "Reply goes where", { account: userA.id });
        const contact = (await q(`INSERT INTO contacts (organization_id, name, email) VALUES ($1,'Someone Else',$2) RETURNING id`, [org, `other-${stamp}@example.test`])).rows[0].id;
        await q(`UPDATE tickets SET requester_contact_id = $2 WHERE id = $1`, [t, contact]);
        // No mail is set up in this test system, so the answer is a reason; what matters is that it names nobody else.
        const r = await call(`/api/tickets/${t}/reply`, { method: "POST", staff: admin.token, body: { body: "On our way", notifyCustomer: true } });
        assert.ok([200, 201].includes(r.status));
        const out = (await r.json()).emailed;
        assert.equal(out?.sent, false);
        assert.ok(!JSON.stringify(out).includes(`other-${stamp}@`));
        await q(`DELETE FROM contacts WHERE id = $1`, [contact]);
    });
    await test("reports are for managers only, limited to their own company, and are real PDFs", async () => {
        const list = await json("/api/portal/reports", { portal: mgrTok });
        assert.deepEqual(list.map((r) => r.key).sort(), ["health", "quarterly-review"]);
        for (const key of ["health", "quarterly-review"]) {
            const res = await call(`/api/portal/reports/${key}/pdf?days=30`, { portal: mgrTok });
            assert.equal(res.status, 200, key);
            assert.match(res.headers.get("content-type") ?? "", /pdf/);
            assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
        }
        assert.equal((await call("/api/portal/reports/health/pdf", { portal: userATok })).status, 403, "a plain user");
        assert.equal((await call("/api/portal/reports", { portal: userATok })).status, 403);
        assert.equal((await call("/api/portal/reports/everything/pdf", { portal: mgrTok })).status, 404);
        assert.equal((await call("/api/portal/reports", {})).status, 401);
        await call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body: { modules: ["dashboard", "tickets"] } });
        assert.equal((await call("/api/portal/reports", { portal: mgrTok })).status, 403, "turned off by the administrator");
        await call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body: { modules: ["dashboard", "tickets", "devices", "invoices", "reports"] } });
    });

    // ------------------------------------------------------------------ devices and invoices
    console.log("devices and invoices");
    await test("only a manager sees devices, and only their own company's", async () => {
        const d = await json("/api/portal/devices", { portal: mgrTok });
        assert.deepEqual(d.map((x) => x.name), [`Alpha-PC-${stamp}`]);
        assert.equal(d[0].online, true);
        assert.deepEqual(Object.keys(d[0]).sort(), ["id", "lastSeen", "name", "online", "os", "site", "user"], "no tokens, addresses or other internals");
        assert.equal((await call("/api/portal/devices", { portal: userATok })).status, 403);
        assert.equal((await call("/api/portal/devices", { portal: userBTok })).status, 403);
    });
    await test("a manager sees sent invoices of their company, never drafts, voided ones or another company's", async () => {
        const list = await json("/api/portal/invoices", { portal: mgrTok });
        assert.deepEqual(list.map((i) => i.id), [invA]);
        assert.equal(list[0].dueCents, 10000);
        for (const id of [invADraft, invAVoid, invB]) assert.equal((await call(`/api/portal/invoices/${id}`, { portal: mgrTok })).status, 404, id);
        const one = await json(`/api/portal/invoices/${invA}`, { portal: mgrTok });
        assert.equal(one.lines[0].description, "Managed services");
        assert.equal(one.canPay, false, "no card payments are set up on this system");
        assert.equal((await call(`/api/portal/invoices/${invA}`, { portal: userATok })).status, 403);
        assert.equal((await call(`/api/portal/invoices/${invA}`, { portal: userBTok })).status, 403);
    });
    await test("the invoice PDF is only for the owner, and paying says plainly when it is not set up", async () => {
        const pdf = await call(`/api/portal/invoices/${invA}/pdf`, { portal: mgrTok });
        assert.equal(pdf.status, 200);
        assert.match(pdf.headers.get("content-type") ?? "", /pdf/);
        assert.equal((await call(`/api/portal/invoices/${invB}/pdf`, { portal: mgrTok })).status, 404);
        assert.equal((await call(`/api/portal/invoices/${invA}/checkout`, { method: "POST", portal: mgrTok })).status, 409);
        assert.equal((await call(`/api/portal/invoices/${invB}/checkout`, { method: "POST", portal: mgrTok })).status, 404);
    });
    await test("the dashboard counts only this person's view", async () => {
        const m = await json("/api/portal/dashboard", { portal: mgrTok });
        assert.equal(m.devices.total, 1);
        assert.deepEqual(m.invoices, { unpaid: 1, balanceCents: 10000, overdue: 1 });
        assert.ok(m.openTickets >= 3);
        const u = await json("/api/portal/dashboard", { portal: userATok });
        assert.equal(u.devices, undefined);
        assert.equal(u.invoices, undefined);
        assert.ok(u.openTickets >= 1 && u.openTickets < m.openTickets);
    });
    await test("areas the administrator turned off are closed to everyone", async () => {
        await call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body: { modules: ["dashboard", "tickets"], allowTicketCreate: false } });
        assert.equal((await call("/api/portal/devices", { portal: mgrTok })).status, 403);
        assert.equal((await call("/api/portal/invoices", { portal: mgrTok })).status, 403);
        assert.equal((await call("/api/portal/tickets", { method: "POST", portal: mgrTok, body: { subject: "x", description: "y" } })).status, 403);
        assert.equal((await call("/api/portal/tickets", { portal: mgrTok })).status, 200);
        const me = await json("/api/portal/auth/me", { portal: mgrTok });
        assert.deepEqual(me.modules.sort(), ["dashboard", "tickets"]);
        await call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body: { modules: ["dashboard", "tickets", "devices", "invoices", "reports"], allowTicketCreate: true } });
    });

    // ------------------------------------------------------------------ accounts
    console.log("accounts");
    let created;
    await test("the support team adds people to a customer; emails are unique and the contact must belong to the customer", async () => {
        const add = (body) => call("/api/portal-admin/accounts", { method: "POST", staff: admin.token, body });
        const contact = (await q(`INSERT INTO customer_contacts (client_id, name, email) VALUES ($1,'Pat Contact','pat@alpha.example.test') RETURNING id`, [A.client])).rows[0].id;
        const r = await add({ clientId: A.client, contactId: contact, email: `Pat-${stamp}@Alpha.Example.Test`, name: "Pat Contact", role: "manager" });
        assert.equal(r.status, 201);
        created = await r.json();
        made.accounts.push(created.account.id);
        assert.equal(created.account.email, `pat-${stamp}@alpha.example.test`, "lower-cased");
        assert.equal(created.account.status, "invited");
        assert.equal(created.account.role, "manager");
        assert.equal(created.invite.sent, false, "no email is set up in this test system, and the answer says so");
        assert.ok(created.invite.message);
        assert.equal((await add({ clientId: A.client, email: created.account.email, name: "Again" })).status, 409);
        assert.equal((await add({ clientId: B.client, email: created.account.email, name: "Elsewhere" })).status, 409);
        assert.equal((await add({ clientId: A.client, email: "not-an-email", name: "x" })).status, 400);
        assert.equal((await add({ clientId: A.client, email: `n-${stamp}@example.test`, name: "" })).status, 400);
        assert.equal((await add({ clientId: uuid(), email: `n-${stamp}@example.test`, name: "x" })).status, 404);
        const other = (await q(`INSERT INTO customer_contacts (client_id, name, email) VALUES ($1,'Not theirs','x@beta.example.test') RETURNING id`, [B.client])).rows[0].id;
        assert.equal((await add({ clientId: A.client, contactId: other, email: `m-${stamp}@example.test`, name: "x" })).status, 400);
    });
    await test("a person limited to some customers manages only those", async () => {
        const limited = await staffUser("plimited", ["customers.read", "customers.write"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);
        const seen = await json("/api/portal-admin/accounts", { staff: limited.token });
        assert.ok(seen.length > 0 && seen.every((a) => a.clientId === B.client));
        assert.equal((await call("/api/portal-admin/accounts", { method: "POST", staff: limited.token, body: { clientId: A.client, email: `x-${stamp}@example.test`, name: "x" } })).status, 404);
        assert.equal((await call(`/api/portal-admin/accounts/${mgrA.id}`, { method: "PATCH", staff: limited.token, body: { role: "user" } })).status, 404);
        assert.equal((await call(`/api/portal-admin/accounts/${mgrA.id}`, { method: "DELETE", staff: limited.token })).status, 404);
    });
    await test("an invitation link sets the first password once, then signs the person in", async () => {
        const token = crypto.randomBytes(24).toString("base64url");
        await q(`INSERT INTO portal_tokens (account_id, kind, token_hash, expires_at) VALUES ($1,'invite',$2, now() + interval '1 day')`, [created.account.id, sha256(token)]);
        const info = await json(`/api/portal/auth/link/${token}`);
        assert.deepEqual({ kind: info.kind, name: info.name }, { kind: "invite", name: "Pat Contact" });
        const set = (password) => call("/api/portal/auth/set-password", { method: "POST", body: { token, password } });
        assert.equal((await set("short")).status, 400);
        assert.equal((await set("aaaaaaaaaaaa")).status, 400, "one repeated character");
        const ok = await set("a good long password");
        assert.equal(ok.status, 200);
        const sessionTok = portalCookie(ok);
        assert.equal((await json("/api/portal/auth/me", { portal: sessionTok })).email, created.account.email);
        assert.equal((await set("another long password")).status, 404, "the link works once");
        assert.equal((await call(`/api/portal/auth/link/${token}`)).status, 404);
        assert.equal((await q(`SELECT status FROM portal_accounts WHERE id = $1`, [created.account.id])).rows[0].status, "active");
    });
    await test("a link that has expired or never existed is refused", async () => {
        const token = crypto.randomBytes(24).toString("base64url");
        await q(`INSERT INTO portal_tokens (account_id, kind, token_hash, expires_at) VALUES ($1,'reset',$2, now() - interval '1 minute')`, [created.account.id, sha256(token)]);
        assert.equal((await call(`/api/portal/auth/link/${token}`)).status, 404);
        assert.equal((await call("/api/portal/auth/set-password", { method: "POST", body: { token, password: "a good long password" } })).status, 404);
        assert.equal((await call("/api/portal/auth/link/nonsense")).status, 404);
    });
    await test("forgotten passwords answer the same for everyone and never reveal who has an account", async () => {
        const a = await call("/api/portal/auth/forgot", { method: "POST", body: { email: mgrA.email } });
        const b = await call("/api/portal/auth/forgot", { method: "POST", body: { email: `nobody-${stamp}@example.test` } });
        const c = await call("/api/portal/auth/forgot", { method: "POST", body: { email: "nonsense" } });
        assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
        assert.deepEqual(await a.json(), await b.json());
        // A real account gets a link recorded (the mail itself cannot be sent in this test system).
        assert.equal((await q(`SELECT count(*)::int AS n FROM portal_tokens WHERE account_id = $1 AND kind = 'reset' AND used_at IS NULL AND expires_at > now()`, [mgrA.id])).rows[0].n, 1);
    });
    await test("changing a password needs the current one and signs out the other browsers", async () => {
        const first = (await login(userA)).token;
        const second = (await login(userA)).token;
        const change = (body, tok) => call("/api/portal/auth/change-password", { method: "POST", portal: tok, body });
        assert.equal((await change({ current: "wrong wrong wrong", password: "a brand new password" }, first)).status, 400);
        assert.equal((await change({ current: PASS, password: "short" }, first)).status, 400);
        assert.equal((await change({ current: PASS, password: "a brand new password" }, first)).status, 200);
        assert.equal((await call("/api/portal/auth/me", { portal: first })).status, 200, "this browser stays signed in");
        assert.equal((await call("/api/portal/auth/me", { portal: second })).status, 401, "the other one does not");
        assert.equal((await login(userA)).res.status, 401, "the old password is gone");
        assert.equal((await login(userA, "a brand new password")).res.status, 200);
        await q(`UPDATE portal_accounts SET password_hash = $2 WHERE id = $1`, [userA.id, await bcrypt.hash(PASS, 4)]);
    });
    await test("signing out ends the session on the server", async () => {
        const tok = (await login(userB)).token;
        assert.equal((await call("/api/portal/auth/logout", { method: "POST", portal: tok })).status, 200);
        assert.equal((await call("/api/portal/auth/me", { portal: tok })).status, 401, "the same token no longer works");
    });
    await test("disabling a person stops them at once, and enabling brings them back", async () => {
        const tok = (await login(userB)).token;
        const patch = (body) => call(`/api/portal-admin/accounts/${userB.id}`, { method: "PATCH", staff: admin.token, body });
        assert.equal((await patch({ status: "disabled" })).status, 200);
        assert.equal((await call("/api/portal/tickets", { portal: tok })).status, 401);
        assert.equal((await login(userB)).res.status, 401);
        assert.equal((await patch({ status: "active" })).status, 200);
        assert.equal((await login(userB)).res.status, 200);
        assert.equal((await patch({ role: "chief" })).status, 400);
        assert.equal((await patch({ status: "weird" })).status, 400);
    });
    await test("changing a role takes effect at once", async () => {
        const tok = (await login(userA)).token;
        assert.equal((await call("/api/portal/devices", { portal: tok })).status, 403);
        await call(`/api/portal-admin/accounts/${userA.id}`, { method: "PATCH", staff: admin.token, body: { role: "manager" } });
        assert.equal((await call("/api/portal/devices", { portal: tok })).status, 401, "old sessions end so the new role is not mixed with the old one");
        const again = (await login(userA)).token;
        assert.equal((await call("/api/portal/devices", { portal: again })).status, 200);
        await call(`/api/portal-admin/accounts/${userA.id}`, { method: "PATCH", staff: admin.token, body: { role: "user" } });
    });
    await test("repeated wrong passwords lock the account for a while, even for the right password", async () => {
        const victim = await person(B, "lock", "user");
        for (let i = 0; i < 8; i++) assert.equal((await login(victim, `wrong-${i}-wrong-wrong`)).res.status, 401);
        assert.equal((await login(victim)).res.status, 429);
        await q(`UPDATE portal_accounts SET locked_until = NULL WHERE id = $1`, [victim.id]);
        assert.equal((await login(victim)).res.status, 200);
    });
    await test("an archived customer's people cannot sign in", async () => {
        const c = await mk("Gamma");
        const g = await person(c, "gam", "user");
        const tok = (await login(g)).token;
        assert.ok(tok);
        await q(`UPDATE clients SET archived_at = now() WHERE id = $1`, [c.client]);
        assert.equal((await call("/api/portal/auth/me", { portal: tok })).status, 401);
        assert.equal((await login(g)).res.status, 401);
    });
    await test("removing a person deletes their access and keeps their tickets", async () => {
        const doomed = await person(A, "doomed", "user");
        const tok = (await login(doomed)).token;
        const t = await ticket(A, "Doomed's ticket", { account: doomed.id });
        assert.equal((await call(`/api/portal-admin/accounts/${doomed.id}`, { method: "DELETE", staff: admin.token })).status, 200);
        assert.equal((await call("/api/portal/auth/me", { portal: tok })).status, 401);
        const row = (await q(`SELECT client_id, portal_account_id FROM tickets WHERE id = $1`, [t])).rows[0];
        assert.deepEqual(row, { client_id: A.client, portal_account_id: null });
    });
    await test("turning the portal off ends every session", async () => {
        const tok = (await login(mgrA)).token;
        assert.equal((await call("/api/portal/tickets", { portal: tok })).status, 200);
        await call("/api/portal-admin/settings", { method: "PUT", staff: admin.token, body: { enabled: false } });
        assert.equal((await call("/api/portal/tickets", { portal: tok })).status, 401);
        assert.equal((await login(mgrA)).res.status, 403);
        assert.equal((await json("/api/portal/config")).enabled, false);
    });

    // ------------------------------------------------------------------ clean up
    await q(`DELETE FROM portal_settings`);
    if (stripeBefore) await q(`UPDATE billing_settings SET stripe_secret_key = $2, stripe_webhook_secret = $3 WHERE organization_id = $1`, [org, stripeBefore.stripe_secret_key, stripeBefore.stripe_webhook_secret]);
    await q(`DELETE FROM tickets WHERE client_id = ANY($1::uuid[])`, [made.clients]);
    await q(`DELETE FROM invoices WHERE client_id = ANY($1::uuid[])`, [made.clients]);
    await q(`DELETE FROM agents WHERE device_id IN (SELECT d.id FROM devices d JOIN sites s ON s.id = d.site_id WHERE s.client_id = ANY($1::uuid[]))`, [made.clients]);
    await q(`DELETE FROM devices WHERE site_id IN (SELECT id FROM sites WHERE client_id = ANY($1::uuid[]))`, [made.clients]);
    await q(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [made.clients]);
    await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [made.users]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [made.users]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [made.users]);
    await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [made.roles]);
    await q(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [made.roles]);
    await db.end();

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.log(failures.map((f) => ` - ${f}`).join("\n"));
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
