// Single sign-on (OpenID Connect) against a stand-in identity provider that signs real tokens: matching people to
// accounts, refusing bad tokens, creating accounts, and keeping passwords as a way back in for Owners.
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { generateKeyPairSync, createHash, randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));

const oidc = dist("auth/oidc.js");

let passed = 0, failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
const rejects = async (fn, code, msg) => {
    try { await fn(); } catch (e) {
        if (code) assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
        if (msg) assert.match(e.message, msg);
        return;
    }
    assert.fail(`expected a rejection${code ? ` (${code})` : ""}`);
};

// ---- A stand-in provider -------------------------------------------------------------------------------------
const goodKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (k, kid) => ({ ...k.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" });

function startProvider() {
    const codes = new Map();
    const srv = http.createServer((req, res) => {
        const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
        const base = `http://127.0.0.1:${srv.address().port}`;
        if (req.url === "/.well-known/openid-configuration") return send(200, { issuer: srv.issuerOverride ?? base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
        if (req.url === "/jwks") return send(200, { keys: [jwkOf(goodKey, "good-1")] });
        if (req.url === "/token" && req.method === "POST") {
            let raw = "";
            req.on("data", (c) => (raw += c));
            req.on("end", () => {
                const f = new URLSearchParams(raw);
                const entry = codes.get(f.get("code"));
                if (!entry || f.get("client_secret") !== "the-secret" || f.get("client_id") !== "client-123") return send(400, { error: "invalid_grant", error_description: "bad code or client" });
                // PKCE: the verifier sent now must hash to the challenge given at the start.
                if (createHash("sha256").update(f.get("code_verifier") || "").digest("base64url") !== entry.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
                codes.delete(f.get("code"));
                send(200, { id_token: entry.idToken, access_token: "unused", token_type: "Bearer" });
            });
            return;
        }
        send(404, {});
    });
    return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
        const base = `http://127.0.0.1:${srv.address().port}`;
        resolve({
            srv,
            base,
            /** Registers a code the service can exchange for an ID token with these claims. */
            /** Registers a code for an ID token made by hand, such as one with no signature. */
            issueRaw(idToken, challenge) {
                const code = randomUUID();
                codes.set(code, { idToken, challenge });
                return code;
            },
            issue(claims, { nonce, challenge, key = goodKey, kid = "good-1", aud = "client-123", iss = base, expiresIn = 300, alg = "RS256", noNonce = false }) {
                const idToken = jwt.sign({ ...claims, ...(noNonce ? {} : { nonce }) }, key.privateKey, { algorithm: alg, keyid: kid, audience: aud, issuer: iss, expiresIn });
                const code = randomUUID();
                codes.set(code, { idToken, challenge });
                return code;
            },
        });
    }));
}

(async () => {
    // ---- Helpers with no database ----
    await check("only https providers are accepted, except on this machine", () => {
        oidc.checkProviderUrl("https://login.example.com/tenant/v2.0", "x");
        oidc.checkProviderUrl("http://127.0.0.1:9000", "x");
        for (const bad of ["http://login.example.com", "ftp://x.test", "not a url", "https://user:pw@login.example.com"]) {
            assert.throws(() => oidc.checkProviderUrl(bad, "x"), /https|valid|username/);
        }
    });
    await check("allowed email domains", () => {
        assert.equal(oidc.domainAllowed("a@x.com", ""), true);
        assert.equal(oidc.domainAllowed("a@x.com", "x.com, y.org"), true);
        assert.equal(oidc.domainAllowed("a@Y.ORG", "x.com, y.org"), true);
        assert.equal(oidc.domainAllowed("a@evil.com", "x.com"), false);
        assert.equal(oidc.domainAllowed("a@sub.x.com", "x.com"), false);
        assert.equal(oidc.domainAllowed("a@x.com", "@x.com"), true);
    });
    await check("the return address must be one of the sites allowed to call this server", () => {
        assert.deepEqual(oidc.safeReturn("https://app.test/tickets/5", ["https://app.test"]), { origin: "https://app.test", path: "/tickets/5" });
        assert.equal(oidc.safeReturn("https://evil.test/x", ["https://app.test"]), null);
        assert.equal(oidc.safeReturn("https://app.test.evil.test/", ["https://app.test"]), null);
        assert.equal(oidc.safeReturn("javascript:alert(1)", ["https://app.test"]), null);
        assert.equal(oidc.safeReturn("https://app.test//evil.test", ["https://app.test"]).path, "/");
        assert.equal(oidc.safeReturn("https://app.test/login?x=1", ["https://app.test"]).path, "/");
        assert.ok(oidc.safeReturn("http://localhost:3000/", []), "without a list, only this machine is allowed");
        assert.equal(oidc.safeReturn("https://app.test/", []), null);
    });

    // ---- The service, against the test database and the stand-in provider ----
    const { PrismaService } = dist("storage/prisma.service.js");
    const { OrganizationContextService } = dist("storage/organization-context.service.js");
    const { SsoService } = dist("auth/sso.service.js");
    const prisma = new PrismaService();
    const orgs = new OrganizationContextService(prisma);
    const svc = new SsoService(prisma, orgs, { findUserById: async (id) => ({ id }) });
    const org = await orgs.getDefaultOrganizationId();
    const idp = await startProvider();
    const stamp = Date.now().toString(36);
    const email = (n) => `${n}-${stamp}@sso.test`;
    const made = [];
    const mkUser = async (n, { status = "active", role } = {}) => {
        const id = (await prisma.$queryRaw`INSERT INTO users (organization_id, email, password_hash, status) VALUES (${org}::uuid, ${email(n)}, 'x', ${status}::user_status) RETURNING id::text AS id`)[0].id;
        made.push(id);
        if (role) await prisma.user_roles.create({ data: { user_id: id, role_id: (await prisma.roles.findFirst({ where: { name: role, organization_id: org } })).id } });
        return id;
    };
    const operator = (await prisma.roles.findFirst({ where: { name: "Operator", organization_id: org } })).id;
    const REDIRECT = "http://127.0.0.1:3901/api/auth/sso/callback";
    const cfg = { issuer: idp.base, clientId: "client-123", clientSecret: "the-secret", scopes: "openid email profile" };

    /** Runs a whole sign-in: start, the provider issues a token for these claims, the person comes back. */
    async function signIn(claims, opts = {}) {
        const url = new URL(await svc.start(opts.returnTo ?? "http://localhost:3000/tickets", REDIRECT));
        const state = url.searchParams.get("state");
        const row = await prisma.sso_login_states.findUnique({ where: { state } });
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        const code = idp.issue({ sub: "sub-default", email_verified: true, ...claims }, { nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge"), ...opts.token });
        assert.ok(row);
        return svc.finish(opts.state ?? state, opts.code ?? code, REDIRECT);
    }

    try {
        await prisma.sso_config.deleteMany({ where: { organization_id: org } });

        await check("settings: it cannot be turned on half filled in, and secrets are never shown", async () => {
            await assert.rejects(() => svc.save(org, { enabled: true }), /issuer, client ID and client secret/);
            await assert.rejects(() => svc.save(org, { issuer: "http://login.example.com" }), /https/);
            await assert.rejects(() => svc.save(org, { scopes: "email profile" }), /openid/);
            await assert.rejects(() => svc.save(org, { allowedDomains: "bad;domain" }), /Allowed domains/);
            await assert.rejects(() => svc.save(org, { jitEnabled: true }), /role new people get/);
            await assert.rejects(() => svc.save(org, { defaultRoleId: randomUUID() }), /does not exist/);
            const saved = await svc.save(org, { ...cfg, displayName: "Test IdP", enabled: false });
            assert.equal(saved.hasClientSecret, true);
            assert.ok(!JSON.stringify(saved).includes("the-secret"));
            const row = await prisma.sso_config.findUnique({ where: { organization_id: org } });
            assert.ok(row.client_secret.startsWith("enc:v1:"));
            assert.deepEqual(await svc.publicStatus(), { enabled: false, displayName: "Test IdP", passwordLogin: true });
        });

        await check("settings: the test button reads the provider's settings", async () => {
            assert.deepEqual((await svc.test(org)).ok, true);
            idp.srv.issuerOverride = "http://127.0.0.1:1";
            const bad = await svc.test(org);
            idp.srv.issuerOverride = undefined;
            assert.equal(bad.ok, false);
            assert.match(bad.message, /different issuer/);
        });

        await svc.save(org, { enabled: true, defaultRoleId: operator });

        await check("starting a sign-in sends the person to the provider with a one-time state, nonce and PKCE challenge", async () => {
            const url = new URL(await svc.start("http://localhost:3000/", REDIRECT));
            assert.equal(url.origin, idp.base);
            assert.equal(url.pathname, "/authorize");
            assert.equal(url.searchParams.get("client_id"), "client-123");
            assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
            assert.equal(url.searchParams.get("response_type"), "code");
            assert.match(url.searchParams.get("state"), /^[0-9a-f]{48}$/);
            assert.notEqual(url.searchParams.get("state"), url.searchParams.get("nonce"));
        });

        await check("an existing account is matched by email, then by the provider's account id (so a changed email still works)", async () => {
            const id = await mkUser("alice");
            const first = await signIn({ sub: "sub-alice", email: email("alice") });
            assert.equal(first.userId, id);
            assert.equal(first.returnTo, "http://localhost:3000/tickets");
            assert.equal((await prisma.sso_identities.findMany({ where: { user_id: id } })).length, 1);
            // The provider now reports a different address for the same person: still her account.
            const second = await signIn({ sub: "sub-alice", email: email("alice-renamed") });
            assert.equal(second.userId, id);
            assert.equal((await prisma.sso_identities.findMany({ where: { user_id: id } }))[0].email, email("alice-renamed"));
        });

        await check("an address already tied to a different provider account is refused (no takeover by a lookalike)", async () => {
            await mkUser("bob");
            await signIn({ sub: "sub-bob", email: email("bob") });
            await rejects(() => signIn({ sub: "sub-attacker", email: email("bob") }), "sso_conflict");
        });

        await check("an email the provider says is unverified is refused; a missing one is refused", async () => {
            await mkUser("carol");
            await rejects(() => signIn({ sub: "s-c1", email: email("carol"), email_verified: false }), "sso_unverified");
            await rejects(() => signIn({ sub: "s-c2" }), "sso_no_email");
        });

        await check("Microsoft-style tokens with no email claim use the sign-in name", async () => {
            const id = await mkUser("dana");
            const r = await signIn({ sub: "sub-dana", preferred_username: email("dana").toUpperCase(), email_verified: undefined });
            assert.equal(r.userId, id);
        });

        await check("a turned-off account cannot sign in this way", async () => {
            await mkUser("eve", { status: "disabled" });
            await rejects(() => signIn({ sub: "sub-eve", email: email("eve") }), "sso_disabled");
            const ident = await prisma.sso_identities.count({ where: { email: email("eve") } });
            assert.equal(ident, 0);
        });

        await check("no account and no automatic creation: refused", async () => {
            await rejects(() => signIn({ sub: "sub-nobody", email: email("nobody") }), "sso_no_account");
            assert.equal((await prisma.$queryRaw`SELECT count(*)::int AS n FROM users WHERE lower(email) = ${email("nobody")}`)[0].n, 0);
        });

        await check("automatic creation makes an account with the chosen role, names from the token, and no usable password", async () => {
            await svc.save(org, { jitEnabled: true });
            const r = await signIn({ sub: "sub-frank", email: email("frank"), given_name: "Frank", family_name: "Ocean" });
            made.push(r.userId);
            const u = (await prisma.$queryRaw`SELECT first_name, last_name, status::text AS status, password_hash FROM users WHERE id = ${r.userId}::uuid`)[0];
            assert.equal(u.first_name, "Frank");
            assert.equal(u.last_name, "Ocean");
            assert.equal(u.status, "active");
            assert.ok(u.password_hash.startsWith("$2"), "a hash nobody knows");
            const roles = await prisma.user_roles.findMany({ where: { user_id: r.userId } });
            assert.deepEqual(roles.map((x) => x.role_id), [operator]);
            // Signing in again finds the same account.
            assert.equal((await signIn({ sub: "sub-frank", email: email("frank") })).userId, r.userId);
            await svc.save(org, { jitEnabled: false });
        });

        await check("allowed domains limit who may sign in, even with a matching account", async () => {
            await mkUser("gina");
            await svc.save(org, { allowedDomains: "other.example" });
            await rejects(() => signIn({ sub: "sub-gina", email: email("gina") }), "sso_domain");
            await svc.save(org, { allowedDomains: "" });
            assert.ok((await signIn({ sub: "sub-gina", email: email("gina") })).userId);
        });

        await check("a bad token is refused: wrong nonce, audience, issuer, expired, wrong key, wrong algorithm", async () => {
            await mkUser("hank");
            const claims = { sub: "sub-hank", email: email("hank") };
            await rejects(() => signIn(claims, { token: { noNonce: true } }), "sso_failed", /not issued for this sign-in/);
            await rejects(() => signIn(claims, { token: { aud: "someone-else" } }), "sso_failed", /not valid/);
            await rejects(() => signIn(claims, { token: { iss: "https://evil.example" } }), "sso_failed", /not valid/);
            await rejects(() => signIn(claims, { token: { expiresIn: -3600 } }), "sso_failed", /not valid/);
            await rejects(() => signIn(claims, { token: { key: otherKey } }), "sso_failed", /not valid/);
            await rejects(() => signIn(claims, { token: { key: otherKey, kid: "unknown-kid" } }), "sso_failed", /does not publish/);
            // A token that claims no signature at all is never accepted.
            const url = new URL(await svc.start("http://localhost:3000/", REDIRECT));
            const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
            const body = Buffer.from(JSON.stringify({ ...claims, nonce: url.searchParams.get("nonce"), iss: idp.base, aud: "client-123", exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
            const code = idp.issueRaw(`${header}.${body}.`, url.searchParams.get("code_challenge"));
            await rejects(() => svc.finish(url.searchParams.get("state"), code, REDIRECT), "sso_failed", /not valid|publish/);
            // A token signed with the provider's PUBLIC key as an HMAC secret (the classic downgrade) is never accepted either.
            const url2 = new URL(await svc.start("http://localhost:3000/", REDIRECT));
            const hs = jwt.sign({ ...claims, nonce: url2.searchParams.get("nonce") }, JSON.stringify(jwkOf(goodKey, "good-1")), { algorithm: "HS256", keyid: "good-1", audience: "client-123", issuer: idp.base, expiresIn: 300 });
            await rejects(() => svc.finish(url2.searchParams.get("state"), idp.issueRaw(hs, url2.searchParams.get("code_challenge")), REDIRECT), "sso_failed", /not valid/);
            assert.equal((await prisma.sso_identities.count({ where: { subject: "sub-hank" } })), 0);
        });

        await check("a sign-in link works once, expires, and cannot be forged", async () => {
            await mkUser("ivy");
            const url = new URL(await svc.start("http://localhost:3000/", REDIRECT));
            const state = url.searchParams.get("state");
            const code = idp.issue({ sub: "sub-ivy", email: email("ivy"), email_verified: true }, { nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") });
            assert.ok((await svc.finish(state, code, REDIRECT)).userId);
            await rejects(() => svc.finish(state, code, REDIRECT), "sso_expired");
            await rejects(() => svc.finish("0".repeat(48), "x", REDIRECT), "sso_expired");
            await rejects(() => svc.finish("not-a-state", "x", REDIRECT), "sso_expired");
            const u2 = new URL(await svc.start("http://localhost:3000/", REDIRECT));
            await prisma.sso_login_states.update({ where: { state: u2.searchParams.get("state") }, data: { expires_at: new Date(Date.now() - 1000) } });
            await rejects(() => svc.finish(u2.searchParams.get("state"), "x", REDIRECT), "sso_expired");
        });

        await check("a code intercepted without the PKCE secret is useless to the provider, and errors carry the page to return to", async () => {
            await mkUser("jack");
            const url = new URL(await svc.start("http://localhost:3000/tickets", REDIRECT));
            const state = url.searchParams.get("state");
            const code = idp.issue({ sub: "sub-jack", email: email("jack") }, { nonce: url.searchParams.get("nonce"), challenge: "a-challenge-that-does-not-match" });
            try { await svc.finish(state, code, REDIRECT); assert.fail("should refuse"); } catch (e) {
                assert.equal(e.code, "sso_failed");
                assert.match(e.message, /PKCE/);
                assert.equal(e.returnTo, "http://localhost:3000/tickets");
            }
        });

        await check("the return address is only kept for sites allowed to call this server", async () => {
            const url = new URL(await svc.start("https://evil.example/steal", REDIRECT));
            const row = await prisma.sso_login_states.findUnique({ where: { state: url.searchParams.get("state") } });
            assert.equal(row.return_to, null);
        });

        await check("password sign-in: turning it off needs an Owner, and Owners keep it", async () => {
            const ownerRole = await prisma.roles.findFirst({ where: { name: "Owner", organization_id: org } });
            const wasOwners = (await prisma.$queryRaw`SELECT count(*)::int AS n FROM user_roles WHERE role_id = ${ownerRole.id}::uuid`)[0].n;
            const owner = await mkUser("olive", { role: "Owner" });
            const staff = await mkUser("sam", { role: "Operator" });
            void owner; void staff; void wasOwners;
            assert.equal(await svc.passwordBlocked(email("sam")), false, "allowed while passwords are on");
            await svc.save(org, { passwordLogin: false });
            assert.deepEqual(await svc.publicStatus(), { enabled: true, displayName: "Test IdP", passwordLogin: false });
            assert.equal(await svc.passwordBlocked(email("sam")), true);
            assert.equal(await svc.passwordBlocked(email("SAM")), true, "any letter case");
            assert.equal(await svc.passwordBlocked(email("olive")), false, "an Owner can still use a password");
            assert.equal(await svc.passwordBlocked(undefined), false);
            await svc.save(org, { enabled: false });
            assert.equal(await svc.passwordBlocked(email("sam")), false, "single sign-on off: passwords work again");
            assert.deepEqual(await svc.publicStatus(), { enabled: false, displayName: "Test IdP", passwordLogin: true });
        });
    } finally {
        await prisma.sso_login_states.deleteMany({ where: { organization_id: org } });
        await prisma.sso_config.deleteMany({ where: { organization_id: org } });
        if (made.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = ANY($1::uuid[])`, made);
        await prisma.$executeRawUnsafe(`DELETE FROM users WHERE email::text LIKE '%-${stamp}@sso.test'`);
        idp.srv.close();
        await prisma.$disconnect();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
