#!/usr/bin/env node
// EDR and antivirus consoles through the real HTTP API and a real database, against stand-ins for the four products (built from each product's
// documented request and answer shapes: sign-in, paging, headers): connecting, reading every page, matching endpoints to devices (a serial,
// a host name that is unique, a name that is on two customers' networks), coverage, alerts that raise and clear, wrong and refused credentials,
// a hostile next-page link, secrets that never come back, and the customer limit.
// The backend under test has to be started with (one stand-in, different paths):
//   EDR_MDE_LOGIN_BASE=http://127.0.0.1:4891/mdelogin EDR_MDE_API_BASE=http://127.0.0.1:4891/mde EDR_S1_BASE=http://127.0.0.1:4891/s1
//   EDR_HUNTRESS_BASE=http://127.0.0.1:4891/hn EDR_CS_BASE=http://127.0.0.1:4891/cs EDR_SYNC=false
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3977 DATABASE_URL=postgres://.../adg_edr_e2e JWT_SECRET=... node test/edr-http.e2e.cjs
"use strict";
const http = require("node:http");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4891, OTHER = 4892;
const BASE = `http://127.0.0.1:${PORT}`;
const ago = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
const GUID = "aaaaaaaa-1111-2222-3333-444444444444";

/* ------------------------------ the stand-ins ------------------------------ */

const hits = { stolen: 0 };
const S = {
    mde: { tenant: "contoso.example", appId: GUID, secret: "mde-secret", denied: false, evil: false, machines: [] },
    s1: { token: "s1-token-123", denied: false, agents: [] },
    hn: { key: "hk_test", secret: "hs_test", agents: [] },
    cs: { id: "cs-client", secret: "cs-secret", devices: [] },
};
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, BASE); let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const p = url.pathname, auth = req.headers.authorization || "";
        // Microsoft sign-in
        let m = p.match(/^\/mdelogin\/([^/]+)\/oauth2\/v2\.0\/token$/);
        if (m) {
            const f = new URLSearchParams(body);
            if (decodeURIComponent(m[1]) !== S.mde.tenant) return json(res, 400, { error: "invalid_request", error_description: "AADSTS90002: Tenant not found." });
            if (f.get("client_secret") !== S.mde.secret || f.get("client_id") !== S.mde.appId) return json(res, 401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
            if (f.get("scope") !== "https://api.securitycenter.microsoft.com/.default") return json(res, 400, { error: "invalid_scope" });
            return json(res, 200, { access_token: "mde-tok", token_type: "Bearer", expires_in: 3600 });
        }
        if (p === "/mde/api/machines") {
            if (auth !== "Bearer mde-tok") return json(res, 401, { error: { code: "InvalidAuthenticationToken", message: "bad token" } });
            if (S.mde.denied) return json(res, 403, { error: { code: "Forbidden", message: "Missing Machine.Read.All" } });
            const page = Number(url.searchParams.get("page") || 0); const size = 2;
            const slice = S.mde.machines.slice(page * size, page * size + size);
            const more = (page + 1) * size < S.mde.machines.length;
            return json(res, 200, { value: slice, ...(more ? { "@odata.nextLink": S.mde.evil ? `http://127.0.0.1:${OTHER}/steal` : `${BASE}/mde/api/machines?page=${page + 1}` } : {}) });
        }
        // SentinelOne
        if (p === "/s1/web/api/v2.1/agents") {
            if (auth !== `ApiToken ${S.s1.token}`) return json(res, 401, { errors: [{ code: 4010010, detail: "Authentication failed", title: "Authentication error" }] });
            if (S.s1.denied) return json(res, 403, { errors: [{ detail: "Insufficient permissions" }] });
            const start = Number(url.searchParams.get("cursor") || 0); const size = 2;
            const slice = S.s1.agents.slice(start, start + size); const next = start + size < S.s1.agents.length ? String(start + size) : null;
            return json(res, 200, { data: slice, pagination: { nextCursor: next, totalItems: S.s1.agents.length } });
        }
        // Huntress
        if (p === "/hn/v1/agents") {
            if (auth !== `Basic ${Buffer.from(`${S.hn.key}:${S.hn.secret}`).toString("base64")}`) return json(res, 401, { error: { message: "Invalid credentials" } });
            const page = Number(url.searchParams.get("page") || 1); const size = 2;
            const slice = S.hn.agents.slice((page - 1) * size, page * size);
            return json(res, 200, { agents: slice, pagination: { current_page: page, next_page: page * size < S.hn.agents.length ? page + 1 : null } });
        }
        // CrowdStrike
        if (p === "/cs/oauth2/token" && req.method === "POST") {
            const f = new URLSearchParams(body);
            if (f.get("client_id") !== S.cs.id || f.get("client_secret") !== S.cs.secret) return json(res, 401, { errors: [{ code: 401, message: "access denied, invalid bearer token" }] });
            return json(res, 201, { access_token: "cs-tok", token_type: "bearer", expires_in: 1799 });
        }
        if (p.startsWith("/cs/devices/")) {
            if (auth !== "Bearer cs-tok") return json(res, 401, { errors: [{ message: "access denied" }] });
            if (p === "/cs/devices/queries/devices/v1") {
                const offset = Number(url.searchParams.get("offset") || 0); const limit = 40;   // small pages: the reader must keep asking
                return json(res, 200, { resources: S.cs.devices.slice(offset, offset + limit).map((d) => d.device_id), meta: { pagination: { total: S.cs.devices.length, offset, limit } } });
            }
            if (p === "/cs/devices/entities/devices/v2" && req.method === "POST") {
                const ids = JSON.parse(body).ids; if (ids.length > 100) return json(res, 400, { errors: [{ message: "too many ids" }] });
                return json(res, 200, { resources: S.cs.devices.filter((d) => ids.includes(d.device_id)) });
            }
        }
        json(res, 404, { error: "not found" });
    });
});
const other = http.createServer((req, res) => { hits.stolen++; res.end("{}"); });

/* ------------------------------ the test ------------------------------ */

async function main() {
    await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
    await new Promise((r) => other.listen(OTHER, "127.0.0.1", r));
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `ED${Date.now()}`;
    const admin = await staffUser("ed-admin", ["settings.read", "settings.write", "devices.read", "alerts.read"]);
    const reader = await staffUser("ed-reader", ["devices.read"]);
    const limited = await staffUser("ed-limited", ["devices.read", "settings.write"]);
    const nobody = await staffUser("ed-nobody", ["tickets.read"]);
    const mkClient = async (n) => { const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id; made.clients.push(id); return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'HQ') RETURNING id`, [id])).rows[0].id }; };
    const A = await mkClient("Alpha"), B = await mkClient("Bravo");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const mk = async (c, host, extra = {}) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system, serial_number) VALUES ($1,$2,'Windows 11',$3) RETURNING id`, [c.site, host, extra.serial ?? null])).rows[0].id;
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.39', now(), '{"os":"windows"}')`, [uuid(), id, uuid()]);
        return id;
    };
    const d = {
        pc1: await mk(A, `${tag}-pc1`), pc2: await mk(A, `${tag}-pc2`), pc3: await mk(A, `${tag}-pc3`), serialDev: await mk(A, `${tag}-odd-name`, { serial: "SERIALXYZ99" }),
        none: await mk(A, `${tag}-nocover`), dupA: await mk(A, `${tag}-dup`), dupB: await mk(B, `${tag}-dup`), b1: await mk(B, `${tag}-b1`),
    };
    const allIds = Object.values(d);

    const mdeMachine = (host, o = {}) => ({ id: `mde-${host}`, computerDnsName: host, onboardingStatus: "Onboarded", healthStatus: "Active", lastSeen: ago(0), osPlatform: "Windows11", agentVersion: "10.8", riskScore: "None", ...o });
    const s1Agent = (host, o = {}) => ({ id: `s1-${host}`, computerName: host, isActive: true, infected: false, activeThreats: 0, isUpToDate: true, networkStatus: "connected", lastActiveDate: ago(0), agentVersion: "23.4", osName: "Windows 11", ...o });
    const hnAgent = (host, o = {}) => ({ id: Math.floor(Math.random() * 1e9), hostname: host, defender_status: "Healthy", firewall_status: "Enabled", last_callback_at: ago(0), version: "0.14", os: "Windows 11", ...o });
    S.mde.machines = [mdeMachine(`${tag}-pc1.corp.local`), mdeMachine(`${tag}-dup.corp.local`), mdeMachine("stranger-pc.corp.local"), mdeMachine("another-stranger")];
    S.s1.agents = [s1Agent(`${tag.toUpperCase()}-PC2`, { isUpToDate: false }), s1Agent(`${tag}-b1`), s1Agent("s1-only-host"), s1Agent(`${tag}-dup`)];
    S.hn.agents = [hnAgent(`${tag}-pc3`, { defender_status: "Unhealthy" }), hnAgent("hn-only-1"), hnAgent("hn-only-2")];
    S.cs.devices = Array.from({ length: 105 }, (_, i) => ({ device_id: `cs-dev-${i}`, hostname: `cs-host-${i}`, status: "normal", last_seen: ago(0), platform_name: "Windows", agent_version: "7.1", serial_number: i === 7 ? "SERIALXYZ99" : `CS-SN-${i}` }));

    const R = (method, p, body, t = admin) => call(`/api/edr${p}`, { method, token: t?.token, body });
    const ok = async (method, p, body, t = admin, want = 200) => { const r = await R(method, p, body, t); assert.equal(r.status, want, `${method} ${p}: ${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`); return r.json(); };
    const wait = async (id, pred = (c) => c.status !== "pending") => { for (let i = 0; i < 100; i++) { const c = (await ok("GET", "/connections")).items.find((x) => x.id === id); if (c && !c.syncing && c.lastSyncedAt && pred(c)) return c; await sleep(250); } throw new Error("the connection never got there"); };
    const connect = async (body, t = admin) => { const c = await ok("POST", "/connections", body, t, 201); return wait(c.id); };
    const cover = async (qs = "", t = reader) => ok("GET", `/coverage${qs}`, undefined, t);
    const verdict = async (id, t = reader) => (await cover("", t)).items.find((i) => i.deviceId === id)?.verdict;
    const alertOf = async (dev) => (await q(`SELECT state, severity, kind, title FROM alerts WHERE dedupe_key LIKE $1 ORDER BY first_seen_at DESC LIMIT 1`, [`edr:${dev}:%`])).rows[0];
    const conns = {};

    console.log("rights and what may be saved");
    await test("who may do what: devices.read to look, settings.write to connect, change, read now or disconnect", async () => {
        assert.equal((await R("GET", "/connections", undefined, nobody)).status, 403); assert.equal((await call("/api/edr/coverage")).status, 401);
        assert.equal((await R("POST", "/connections", { vendor: "huntress", apiKey: "k", secret: "s" }, reader)).status, 403);
        const v = await ok("GET", "/vendors", undefined, reader); assert.deepEqual(v.vendors.map((x) => x.key), ["mde", "sentinelone", "huntress", "crowdstrike"]); assert.ok(v.vendors.every((x) => x.fields.some((f) => f.secret)));
    });
    await test("bad input is refused with a reason, and a name can only be used once", async () => {
        const bad = async (body, re) => { const r = await R("POST", "/connections", body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(JSON.stringify(await r.json()), re); };
        await bad({ vendor: "nope" }, /Choose which product/); await bad({ vendor: "mde", tenant: "x", appId: GUID, secret: "s" }, /tenant/); await bad({ vendor: "sentinelone", subdomain: "evil.com/x", secret: "t" }, /console name/);
        await bad({ vendor: "huntress", apiKey: "k" }, /secret/); await bad({ vendor: "crowdstrike", cloud: "mars", apiClientId: "c", secret: "s" }, /cloud/); await bad({ vendor: "huntress", apiKey: "k", secret: "s", clientId: "nope" }, /customer/);
    });

    console.log("reading the four products");
    await test("Defender for Endpoint (bound to one customer): signs in, reads every page, and the secret never comes back", async () => {
        const c = await connect({ vendor: "mde", name: `${tag} MDE`, clientId: A.id, tenant: S.mde.tenant, appId: GUID, secret: S.mde.secret });
        conns.mde = c.id; assert.equal(c.status, "ok", JSON.stringify(c)); assert.equal(c.endpoints, 4, "the second page was not read"); assert.equal(c.customer, `${tag} Alpha`);
        const stored = (await q(`SELECT secret_enc, config FROM edr_connections WHERE id=$1`, [c.id])).rows[0];
        assert.ok(!stored.secret_enc.includes(S.mde.secret), "stored in the clear"); assert.ok(!JSON.stringify(stored.config).includes(S.mde.secret));
        assert.ok(!JSON.stringify(await ok("GET", "/connections")).includes(S.mde.secret), "the secret came back");
    });
    await test("SentinelOne, Huntress and CrowdStrike (for every customer): paging by cursor, by page number, and ids in chunks of a hundred", async () => {
        const s1 = await connect({ vendor: "sentinelone", name: `${tag} S1`, subdomain: "usea1-acme", secret: S.s1.token }); conns.s1 = s1.id; assert.equal(s1.status, "ok", JSON.stringify(s1)); assert.equal(s1.endpoints, 4);
        const hn = await connect({ vendor: "huntress", name: `${tag} Huntress`, apiKey: S.hn.key, secret: S.hn.secret }); conns.hn = hn.id; assert.equal(hn.status, "ok", JSON.stringify(hn)); assert.equal(hn.endpoints, 3);
        const cs = await connect({ vendor: "crowdstrike", name: `${tag} CS`, cloud: "us-1", apiClientId: S.cs.id, secret: S.cs.secret }); conns.cs = cs.id; assert.equal(cs.status, "ok", JSON.stringify(cs)); assert.equal(cs.endpoints, 105, "not every device was read");
        assert.equal(s1.customer, null);
        const dup = await R("POST", "/connections", { vendor: "huntress", name: `${tag} HUNTRESS`, apiKey: "k", secret: "s" }); assert.equal(dup.status, 409); assert.match(JSON.stringify(await dup.json()), /already a connection with that name/);
    });

    console.log("matching and coverage");
    await test("each device is matched the right way: a name without its domain, an upper-case name, a name no one else has, a serial number", async () => {
        const c = await cover();
        const by = (id) => c.items.find((i) => i.deviceId === id);
        assert.equal(by(d.pc1).verdict, "healthy"); assert.deepEqual(by(d.pc1).products.map((p) => p.vendor), ["mde"]);
        assert.equal(by(d.pc2).verdict, "warning"); assert.match(by(d.pc2).products[0].detail, /out of date/);
        assert.equal(by(d.pc3).verdict, "unhealthy"); assert.equal(by(d.pc3).products[0].vendor, "huntress");
        assert.equal(by(d.serialDev).verdict, "healthy"); assert.equal(by(d.serialDev).products[0].vendor, "crowdstrike");
        assert.equal(by(d.none).verdict, "none"); assert.deepEqual(by(d.none).products, []);
    });
    await test("a name that is on two customers' networks is nobody in particular for a console that covers everyone, but matches in the customer's own console", async () => {
        const c = await cover();
        assert.equal(c.items.find((i) => i.deviceId === d.dupB).verdict, "none"); assert.equal(c.items.find((i) => i.deviceId === d.b1).products.some((p) => p.vendor === "sentinelone"), true, "a unique name matches");
        assert.equal(c.items.find((i) => i.deviceId === d.dupA).verdict, "healthy", "the customer's own console matches the name inside that customer");
        assert.equal(c.items.find((i) => i.deviceId === d.dupA).products.length, 1);
    });
    await test("the summary counts each verdict and the share of devices some console knows; endpoints no device matches are listed", async () => {
        const c = await cover(`?clientId=${A.id}`); assert.equal(c.summary.total, 6);
        assert.deepEqual([c.summary.healthy, c.summary.warning, c.summary.unhealthy, c.summary.none], [3, 1, 1, 1], JSON.stringify(c.summary)); assert.equal(c.summary.coveredPercent, Math.round((100 * 5) / 6));
        const all = await cover(); const names = all.unmatched.map((u) => u.hostname);
        assert.ok(names.includes("stranger-pc.corp.local") && names.includes("s1-only-host") && names.includes("hn-only-1") && names.includes("cs-host-0"), names.slice(0, 10).join());
        assert.ok(!names.includes(`${tag}-pc1.corp.local`), "a matched endpoint is listed as unmatched"); assert.ok(all.unmatched.length <= 200);
        assert.equal((await cover(`?q=${encodeURIComponent(`${tag}-pc3`)}`)).items.length, 1);
    });

    console.log("alerts");
    await test("an unhealthy endpoint raises a warning alert on its device, and the alert clears when the console says it is fine", async () => {
        let a = await alertOf(d.pc3); assert.ok(a && a.state !== "RESOLVED" && a.kind === "edr" && a.severity === "WARN" && /unhealthy on /.test(a.title), JSON.stringify(a));
        assert.equal(await alertOf(d.pc1), undefined, "a healthy endpoint made an alert");
        S.hn.agents[0].defender_status = "Healthy";
        await ok("POST", `/connections/${conns.hn}/sync`); a = await alertOf(d.pc3); assert.equal(a.state, "RESOLVED"); assert.equal(await verdict(d.pc3), "healthy");
        S.hn.agents[0].defender_status = "Unhealthy"; await ok("POST", `/connections/${conns.hn}/sync`); a = await alertOf(d.pc3); assert.ok(a.state !== "RESOLVED", "it did not come back");
    });
    await test("disconnecting a console removes what it said and clears its alerts", async () => {
        await ok("DELETE", `/connections/${conns.hn}`);
        assert.equal((await alertOf(d.pc3)).state, "RESOLVED"); assert.equal(await verdict(d.pc3), "none");
        assert.equal((await q(`SELECT count(*)::int AS n FROM edr_endpoints WHERE connection_id=$1`, [conns.hn])).rows[0].n, 0);
    });

    console.log("when a console says no");
    await test("wrong credentials and refused credentials each say what is wrong, and the last good reading stays", async () => {
        S.s1.token = "rotated-token";
        const r = await ok("POST", `/connections/${conns.s1}/sync`); assert.equal(r.status, "error"); assert.match(r.error, /did not accept the credentials/); assert.equal(r.endpoints, 4, "the last reading was lost");
        assert.equal((await cover()).items.find((i) => i.deviceId === d.b1).products.some((p) => p.vendor === "sentinelone"), true, "the old reading disappeared");
        await ok("PATCH", `/connections/${conns.s1}`, { secret: "rotated-token" }); const fixed = await wait(conns.s1, (c) => c.status === "ok"); assert.equal(fixed.status, "ok");
        S.s1.denied = true; const denied = await ok("POST", `/connections/${conns.s1}/sync`); assert.match(denied.error, /not allowed to read endpoints/); S.s1.denied = false;
        S.mde.denied = true; const m = await ok("POST", `/connections/${conns.mde}/sync`); assert.match(m.error, /not allowed to read endpoints/); S.mde.denied = false;
        S.mde.secret = "new-mde-secret"; const m2 = await ok("POST", `/connections/${conns.mde}/sync`); assert.match(m2.error, /did not accept the credentials/); S.mde.secret = "mde-secret";
    });
    await test("a next-page link that points somewhere else is not followed and the token never leaves", async () => {
        S.mde.evil = true; const r = await ok("POST", `/connections/${conns.mde}/sync`); S.mde.evil = false;
        assert.equal(hits.stolen, 0, "the token was sent to another address"); assert.equal(r.status, "error"); assert.match(r.error, /link to somewhere else/);
    });
    await test("an unknown console name or cloud is a clear error, not a hang", async () => {
        S.hn.agents = S.hn.agents.slice(0, 1);
        const c = await ok("POST", "/connections", { vendor: "huntress", name: `${tag} bad`, apiKey: "wrong-key", secret: "x" }, admin, 201); const w = await wait(c.id); assert.equal(w.status, "error"); assert.match(w.error, /did not accept the credentials/);
        await ok("DELETE", `/connections/${c.id}`);
    });

    console.log("who sees what");
    await test("a limited person sees only their customer's devices and consoles bound to it, cannot add a console without a customer, and never sees endpoints of other customers", async () => {
        const c = await cover("", limited); const ids = c.items.map((i) => i.deviceId);
        assert.ok(ids.includes(d.pc1) && !ids.includes(d.b1) && !ids.includes(d.dupB), JSON.stringify(ids.length)); assert.deepEqual(c.unmatched, []);
        assert.deepEqual((await ok("GET", "/connections", undefined, limited)).items.map((i) => i.id), [conns.mde], "an all-customers console is shown to a limited person");
        const r = await R("POST", "/connections", { vendor: "huntress", name: `${tag} lim`, apiKey: "k", secret: "s" }, limited); assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /Choose the customer/);
        assert.equal((await R("POST", "/connections", { vendor: "huntress", name: `${tag} lim2`, apiKey: "k", secret: "s", clientId: B.id }, limited)).status, 403);
        assert.equal((await R("POST", `/connections/${conns.cs}/sync`, undefined, limited)).status, 404); assert.equal((await R("DELETE", `/connections/${conns.cs}`, undefined, limited)).status, 404);
    });

    await q(`DELETE FROM alerts WHERE dedupe_key LIKE 'edr:%' AND device_id = ANY($1::uuid[])`, [allIds]);
    await q(`DELETE FROM edr_connections WHERE organization_id=$1 AND name LIKE $2`, [org, `${tag}%`]);
    await cleanup();
    server.close(); other.close();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
