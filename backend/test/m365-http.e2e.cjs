#!/usr/bin/env node
// Microsoft 365 tenants through the real HTTP API and a real database, against a stand-in for Microsoft (a sign-in server and a Graph server
// that answer like the real ones in the shapes the documentation gives): connecting, reading with paging, parts the app may not read, wrong and
// expired secrets, a "next page" link that points somewhere else, the secret never coming back or reaching the audit log, the customer
// limit, and news (a new critical finding goes to the webhooks).
// The backend under test has to be started with:
//   M365_LOGIN_BASE=http://127.0.0.1:4881 M365_GRAPH_BASE=http://127.0.0.1:4881 M365_SYNC=false
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3977 DATABASE_URL=postgres://.../adg_m365_e2e JWT_SECRET=... node test/m365-http.e2e.cjs
"use strict";
const http = require("node:http");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4881, OTHER = 4882;
const BASE = `http://127.0.0.1:${PORT}`;

/* ------------------------------ the stand-in for Microsoft ------------------------------ */

const tenants = {};          // tenant name -> scenario
const hits = { token: 0, graph: 0, stolen: 0 };
const seenSecrets = [];
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const user = (n, over = {}) => ({ id: `u${n}`, displayName: `Person ${n}`, userPrincipalName: `person${n}@contoso.example`, accountEnabled: true, userType: "Member", assignedLicenses: [{ skuId: "s-spb" }], createdDateTime: daysAgo(500), signInActivity: { lastSignInDateTime: daysAgo(2) }, ...over });
const contoso = () => ({
    secret: "good-secret-value", denied: [], noSignIns: false, evilNext: false,
    org: { displayName: "Contoso Ltd", verifiedDomains: [{ name: "contoso.example" }, { name: "contoso.onmicrosoft.com" }] },
    users: [user(1), user(2), user(3), user(4, { accountEnabled: false }), user(5, { signInActivity: { lastSignInDateTime: daysAgo(200) } }), user(6, { userType: "Guest", assignedLicenses: [] })],
    skus: [{ skuId: "s-spb", skuPartNumber: "SPB", consumedUnits: 5, prepaidUnits: { enabled: 8 } }],
    mfaRegistered: { 1: true, 2: true, 3: false, 4: false, 5: true },
    admins: ["u1", "u2"], ca: { policies: [{ id: "p1", state: "enabled" }, { id: "p2", state: "disabled" }], defaults: false }, score: { currentScore: 61, maxScore: 100 },
});
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const ms = http.createServer((req, res) => {
    const url = new URL(req.url, BASE);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const tm = url.pathname.match(/^\/([^/]+)\/oauth2\/v2\.0\/token$/);
        if (tm && req.method === "POST") {
            hits.token++;
            const form = new URLSearchParams(body); const t = tenants[decodeURIComponent(tm[1])];
            seenSecrets.push(form.get("client_secret"));
            if (!t) return json(res, 400, { error: "invalid_request", error_description: "AADSTS90002: Tenant not found." });
            if (form.get("client_id") !== t.appId) return json(res, 400, { error: "unauthorized_client", error_description: "AADSTS700016: Application not found in the directory." });
            if (form.get("client_secret") === "expired-secret") return json(res, 401, { error: "invalid_client", error_description: "AADSTS7000222: The provided client secret keys are expired." });
            if (form.get("client_secret") !== t.secret) return json(res, 401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
            if (form.get("scope") !== "https://graph.microsoft.com/.default" || form.get("grant_type") !== "client_credentials") return json(res, 400, { error: "invalid_request" });
            return json(res, 200, { access_token: `tok:${decodeURIComponent(tm[1])}`, expires_in: 3600, token_type: "Bearer" });
        }
        hits.graph++;
        const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
        const t = tenants[tok.replace(/^tok:/, "")];
        if (!t || !tok.startsWith("tok:")) return json(res, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty or invalid." } });
        const p = url.pathname;
        const deny = (key) => t.denied.includes(key) ? (json(res, 403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." } }), true) : false;
        if (p === "/v1.0/organization") return json(res, 200, { value: [t.org] });
        if (p === "/v1.0/users") {
            if (deny("users")) return;
            const select = url.searchParams.get("$select") || "";
            if (select.includes("signInActivity") && t.noSignIns) return json(res, 403, { error: { code: "Authentication_RequestFromNonPremiumTenantOrB2CTenant", message: "Neither tenant is B2C or tenant doesn't have premium license" } });
            const strip = (u) => { const c = { ...u }; if (!select.includes("signInActivity")) delete c.signInActivity; return c; };
            const page = Number(url.searchParams.get("$skiptoken") || 0);
            const size = 4, slice = t.users.slice(page * size, page * size + size).map(strip);
            const more = (page + 1) * size < t.users.length;
            const next = more ? (t.evilNext ? `http://127.0.0.1:${OTHER}/steal?x=1` : `${BASE}/v1.0/users?$select=${select}&$top=999&$skiptoken=${page + 1}`) : undefined;
            return json(res, 200, { value: slice, ...(next ? { "@odata.nextLink": next } : {}) });
        }
        if (p === "/v1.0/subscribedSkus") return deny("licenses") || json(res, 200, { value: t.skus });
        if (p === "/v1.0/reports/authenticationMethods/userRegistrationDetails") {
            if (deny("mfa")) return;
            return json(res, 200, { value: Object.entries(t.mfaRegistered).map(([n, reg]) => ({ id: `u${n}`, userPrincipalName: `person${n}@contoso.example`, isMfaRegistered: reg, isMfaCapable: reg })) });
        }
        if (p === "/v1.0/directoryRoles") return deny("admins") || json(res, 200, { value: [{ id: "r-ga", displayName: "Global Administrator" }, { id: "r-ua", displayName: "User Administrator" }] });
        const rm = p.match(/^\/v1\.0\/directoryRoles\/([^/]+)\/members$/);
        if (rm) return json(res, 200, { value: rm[1] === "r-ga" ? t.admins.map((id) => ({ "@odata.type": "#microsoft.graph.user", id, displayName: `Person ${id.slice(1)}`, userPrincipalName: `person${id.slice(1)}@contoso.example` })) : [] });
        if (p === "/v1.0/identity/conditionalAccess/policies") return deny("conditionalAccess") || json(res, 200, { value: t.ca.policies });
        if (p === "/v1.0/policies/identitySecurityDefaultsEnforcementPolicy") return deny("securityDefaults") || json(res, 200, { isEnabled: t.ca.defaults });
        if (p === "/v1.0/security/secureScores") return deny("secureScore") || json(res, 200, { value: [t.score] });
        return json(res, 404, { error: { code: "Request_ResourceNotFound", message: "Not found" } });
    });
});
const other = http.createServer((req, res) => { hits.stolen++; res.end("{}"); });

/* ------------------------------ the test ------------------------------ */

async function main() {
    await new Promise((r) => ms.listen(PORT, "127.0.0.1", r));
    await new Promise((r) => other.listen(OTHER, "127.0.0.1", r));
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `M3${Date.now()}`;
    const mgr = await staffUser("m3-mgr", ["customers.read", "customers.write"]);
    const reader = await staffUser("m3-reader", ["customers.read"]);
    const limited = await staffUser("m3-limited", ["customers.read", "customers.write"]);
    const nobody = await staffUser("m3-nobody", ["tickets.read"]);
    const mkClient = async (n) => { const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id; made.clients.push(id); return id; };
    const A = await mkClient("Alpha"), B = await mkClient("Bravo");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A]);

    const APP = "aaaaaaaa-1111-2222-3333-444444444444";
    const T = (method, p, body, t = mgr) => call(`/api/m365/tenants${p}`, { method, token: t?.token, body });
    const ok = async (method, p, body, t = mgr, want = 200) => { const r = await T(method, p, body, t); assert.equal(r.status, want, `${method} ${p}: ${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`); return r.json(); };
    const wait = async (id, pred) => { for (let i = 0; i < 80; i++) { const d = await ok("GET", `/${id}`, undefined, mgr); if (!d.syncing && d.lastSyncedAt && pred(d)) return d; await sleep(250); } throw new Error(`never got there: ${JSON.stringify(await ok("GET", `/${id}`))}`); };
    const connect = async (domain, scenario, clientId = A, secret = scenario.secret) => { tenants[domain] = { appId: APP, ...scenario }; return ok("POST", "", { clientId, tenant: domain, appId: APP, secret }, mgr, 201); };

    console.log("rights and what may be saved");
    await test("who may do what: customers.read to look, customers.write to connect, change, read now or disconnect", async () => {
        assert.equal((await T("GET", "", undefined, nobody)).status, 403); assert.equal((await call("/api/m365/tenants")).status, 401);
        assert.equal((await T("POST", "", { clientId: A, tenant: "x.example", appId: APP, secret: "s" }, reader)).status, 403);
        assert.equal((await T("GET", "", undefined, reader)).status, 200);
    });
    await test("bad input is refused with a reason: no customer, an unknown customer, a bad tenant, a bad application ID, an empty secret", async () => {
        const bad = async (body, re) => { const r = await T("POST", "", { clientId: A, tenant: "bad.example", appId: APP, secret: "s", ...body }); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(JSON.stringify(await r.json()), re); };
        await bad({ clientId: "nope" }, /Choose the customer/); await bad({ clientId: uuid() }, /does not exist/); await bad({ tenant: "https://x.com/y" }, /tenant ID/);
        await bad({ appId: "abc" }, /GUID/); await bad({ secret: "" }, /client secret/); await bad({ secret: "has space" }, /client secret/);
    });

    console.log("reading a tenant");
    let contosoId;
    await test("connecting reads the tenant (every page of users), and the findings are in plain words", async () => {
        const created = await connect("contoso.example", contoso());
        assert.equal(created.status, "pending"); contosoId = created.id;
        const d = await wait(created.id, (x) => x.status !== "pending");
        assert.equal(d.status, "ok", JSON.stringify(d)); const s = d.summary;
        assert.equal(d.name, "Contoso Ltd"); assert.equal(s.counts.users, 6, "the second page of users was not read"); assert.equal(s.counts.guests, 1); assert.equal(s.counts.disabled, 1);
        assert.equal(s.licenses[0].name, "Microsoft 365 Business Premium"); assert.equal(s.licenses[0].available, 3);
        assert.deepEqual(s.organization.domains, ["contoso.example", "contoso.onmicrosoft.com"]); assert.equal(s.score.percent, 61); assert.equal(s.conditionalAccess.enabled, 1);
        const ids = s.findings.map((f) => f.id);
        assert.ok(ids.includes("mfa.missing") && ids.includes("licenses.disabled") && ids.includes("users.inactive") && ids.includes("licenses.unused"), ids.join());
        assert.ok(!ids.includes("admins.mfa"), "both administrators have multi-factor sign-in"); assert.ok(d.health < 100 && d.health >= 50, String(d.health));
        assert.equal(d.users, 6); assert.equal(d.customer, `${tag} Alpha`);
    });
    await test("the client secret is stored encrypted and never comes back: not in the list, the detail, the audit trail or anywhere in a response", async () => {
        const stored = (await q(`SELECT secret_enc FROM m365_tenants WHERE id=$1`, [contosoId])).rows[0].secret_enc;
        assert.ok(stored && !stored.includes("good-secret-value"), "the secret is stored in the clear");
        for (const body of [await ok("GET", ""), await ok("GET", `/${contosoId}`)]) assert.ok(!JSON.stringify(body).includes("good-secret-value") && !JSON.stringify(body).toLowerCase().includes("secret_enc"), "the secret came back");
        const audit = await q(`SELECT metadata::text AS m FROM audit_events WHERE action LIKE 'm365.%'`).catch(() => ({ rows: [] }));
        assert.ok(audit.rows.every((r) => !String(r.m).includes("good-secret-value")), "the secret reached the audit trail");
        assert.ok(seenSecrets.includes("good-secret-value"), "the stand-in never saw the real secret");
    });
    await test("a tenant that is already connected is a 409, the same tenant in another case too", async () => {
        const r = await T("POST", "", { clientId: B, tenant: "CONTOSO.example", appId: APP, secret: "good-secret-value" }); assert.equal(r.status, 409);
    });
    await test("parts the app may not read are said so and the rest still shows: the status is partial and no finding is invented", async () => {
        const created = await connect("partial.example", { ...contoso(), denied: ["mfa", "conditionalAccess", "secureScore"] });
        const d = await wait(created.id, (x) => x.status !== "pending"); assert.equal(d.status, "partial", JSON.stringify(d));
        assert.match(d.summary.notRead.mfa, /not allowed to read this/); assert.ok(d.summary.notRead.conditionalAccess); assert.equal(d.summary.mfa, null);
        assert.ok(!d.summary.findings.some((f) => f.id.startsWith("mfa") || f.id === "admins.mfa" || f.id === "signin.unprotected"), JSON.stringify(d.summary.findings));
        assert.equal(d.summary.counts.users, 6);
    });
    await test("without a premium licence sign-in times cannot be read: the people still are, with a note, and the status stays ok", async () => {
        const created = await connect("nosignins.example", { ...contoso(), noSignIns: true });
        const d = await wait(created.id, (x) => x.status !== "pending"); assert.equal(d.status, "ok", JSON.stringify(d));
        assert.match(d.summary.notRead.signIns, /Entra ID P1/); assert.equal(d.summary.counts.users, 6); assert.deepEqual(d.summary.inactive, []);
    });
    await test("an app with no permissions at all is an error that says what to do, not an empty tenant", async () => {
        const created = await connect("locked.example", { ...contoso(), denied: ["users", "licenses", "mfa", "admins"] });
        const d = await wait(created.id, (x) => x.status !== "pending"); assert.equal(d.status, "error"); assert.match(d.error, /admin consent/);
    });
    await test("a wrong secret, an expired secret, an unknown application and an unknown tenant each say what is wrong", async () => {
        const cases = [["wrongsecret.example", "not-the-secret", /secret is wrong/], ["expired.example", "expired-secret", /expired/]];
        for (const [domain, secret, re] of cases) { const c = await connect(domain, contoso(), A, secret); const d = await wait(c.id, (x) => x.status !== "pending"); assert.equal(d.status, "error", domain); assert.match(d.error, re, domain); }
        tenants["wrongapp.example"] = { ...contoso(), appId: "bbbbbbbb-1111-2222-3333-444444444444" };
        const c = await ok("POST", "", { clientId: A, tenant: "wrongapp.example", appId: APP, secret: "good-secret-value" }, mgr, 201); const d = await wait(c.id, (x) => x.status !== "pending"); assert.match(d.error, /application \(client\) ID/);
        const u = await ok("POST", "", { clientId: A, tenant: "nosuchtenant.example", appId: APP, secret: "x" }, mgr, 201); const du = await wait(u.id, (x) => x.status !== "pending"); assert.match(du.error, /tenant could not be found/);
    });
    await test("a new secret fixes it, and the old good reading stays shown while a later reading fails", async () => {
        const c = await connect("fixme.example", contoso(), A, "expired-secret"); await wait(c.id, (x) => x.status === "error");
        await ok("PATCH", `/${c.id}`, { secret: "good-secret-value" }); const fixed = await wait(c.id, (x) => x.status === "ok"); assert.equal(fixed.summary.counts.users, 6);
        tenants["fixme.example"].secret = "rotated-by-the-customer";
        const r = await ok("POST", `/${c.id}/sync`); assert.equal(r.status, "error"); assert.match(r.error, /secret is wrong/); assert.equal(r.summary.counts.users, 6, "the last good reading was lost");
    });
    await test("a next-page link that points somewhere else is not followed, and the token never leaves", async () => {
        const c = await connect("evil.example", { ...contoso(), evilNext: true });
        const d = await wait(c.id, (x) => x.status !== "pending");
        assert.equal(hits.stolen, 0, "the token was sent to another address"); assert.ok(d.status === "partial" || d.status === "error", d.status);
        assert.match(JSON.stringify(d), /link to somewhere else|not followed/);
    });

    console.log("news and who sees what");
    await test("a critical finding that was not there before goes to the webhooks once; the first reading is a baseline and says nothing", async () => {
        const hook = await q(`INSERT INTO webhook_endpoints (organization_id, name, url, events, secret, enabled) VALUES ($1,$2,'https://example.invalid/h',$3,'x',true) RETURNING id`, [org, `${tag} hook`, ["monitor.failed"]]);
        try {
            const sc = contoso(); const c = await connect("news.example", sc); await wait(c.id, (x) => x.status === "ok");
            await sleep(500); assert.equal((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id=$1`, [hook.rows[0].id])).rows[0].n, 0, "the baseline made news");
            tenants["news.example"].mfaRegistered[1] = false;   // an administrator loses multi-factor sign-in
            await ok("POST", `/${c.id}/sync`); await sleep(800);
            const ev = (await q(`SELECT payload FROM webhook_deliveries WHERE endpoint_id=$1`, [hook.rows[0].id])).rows;
            assert.equal(ev.length, 1, JSON.stringify(ev)); assert.equal(ev[0].payload.data.monitor.kind, "microsoft365"); assert.match(ev[0].payload.data.detail, /no multi-factor sign-in/); assert.equal(ev[0].payload.data.monitor.customer, `${tag} Alpha`);
            await ok("POST", `/${c.id}/sync`); await sleep(500); assert.equal((await q(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id=$1`, [hook.rows[0].id])).rows[0].n, 1, "the same finding was announced twice");
        } finally { await q(`DELETE FROM webhook_endpoints WHERE id=$1`, [hook.rows[0].id]); }
    });
    await test("a limited person sees and manages only their customers' tenants", async () => {
        tenants["bravo.example"] = { appId: APP, ...contoso() };
        const b = await ok("POST", "", { clientId: B, tenant: "bravo.example", appId: APP, secret: "good-secret-value" }, mgr, 201);
        const mine = (await ok("GET", "", undefined, limited)).items.map((i) => i.id);
        assert.ok(mine.includes(contosoId)); assert.ok(!mine.includes(b.id), "another customer's tenant is listed");
        assert.equal((await T("GET", `/${b.id}`, undefined, limited)).status, 404); assert.equal((await T("POST", `/${b.id}/sync`, undefined, limited)).status, 404); assert.equal((await T("DELETE", `/${b.id}`, undefined, limited)).status, 404);
        assert.equal((await T("POST", "", { clientId: B, tenant: "sneaky.example", appId: APP, secret: "s" }, limited)).status, 403);
    });
    await test("disconnecting removes the tenant and what was read", async () => {
        const c = await connect("gone.example", contoso()); await wait(c.id, (x) => x.status === "ok");
        await ok("DELETE", `/${c.id}`); assert.equal((await T("GET", `/${c.id}`)).status, 404);
        assert.equal((await q(`SELECT count(*)::int AS n FROM m365_tenants WHERE id=$1`, [c.id])).rows[0].n, 0);
    });

    await q(`DELETE FROM m365_tenants WHERE organization_id=$1 AND client_id = ANY($2::uuid[])`, [org, [A, B]]);
    await cleanup();
    ms.close(); other.close();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
