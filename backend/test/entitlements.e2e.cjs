// Seat limits enforced by the real services against a real database: enrolling an endpoint, creating, inviting (one and many),
// and re-enabling a technician, plus the case with no limits file at all. Run against a throwaway database only:
//
//   ADG_E2E_ALLOW=1 DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... DATA_ENCRYPTION_KEY=... node test/entitlements.e2e.cjs
//
// Limits are set relative to what the database already holds, so other tests' rows do not matter.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(new URL(process.env.DATABASE_URL || "postgres://x/none").pathname)) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1 and a DATABASE_URL naming an e2e database.");
    process.exit(2);
}

let passed = 0, failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message}`); }
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const refusal = async (fn) => { try { await fn(); } catch (e) { return { status: e.getStatus?.(), ...(e.getResponse?.() ?? {}) }; } return null; };

(async () => {
    const { PrismaService } = dist("storage/prisma.service.js");
    const { EntitlementsService } = dist("entitlements/entitlements.service.js");
    const { AuthService } = dist("auth/auth.service.js");
    const { UsersService } = dist("users/users.service.js");
    const { ProvisioningService } = dist("provisioning/provisioning.service.js");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adg-ent-e2e-"));
    const file = path.join(tmp, "entitlements.json");
    process.env.ENTITLEMENTS_FILE = file;
    delete process.env.DEMO_MODE;

    const prisma = new PrismaService();
    const ent = new EntitlementsService(prisma);
    const auth = new AuthService(prisma, ent);
    let org = (await prisma.$queryRaw`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)[0]?.id;
    if (!org) org = (await prisma.$queryRaw`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') RETURNING id::text AS id`)[0].id;
    const users = new UsersService(prisma, { getDefaultOrganizationId: async () => org }, undefined, ent);
    const prov = new ProvisioningService(prisma);
    const owner = { id: null, perms: new Set(), owner: true };
    const stamp = Date.now().toString(36);

    const write = (o) => { fs.writeFileSync(file, JSON.stringify(o) + " ".repeat(Math.floor(Math.random() * 40))); fs.utimesSync(file, new Date(), new Date(Date.now() + Math.random() * 1e6)); };
    const limits = (o) => write({ version: 1, maxEndpoints: null, maxTechnicians: null, status: "active", upgradeUrl: "https://account.example.test", updatedAt: new Date().toISOString(), ...o });
    const counts = async () => ({
        agents: Number((await prisma.$queryRaw`SELECT count(*) AS n FROM agents`)[0].n),
        techs: Number((await prisma.$queryRaw`SELECT count(*) AS n FROM users WHERE status IN ('active','invited')`)[0].n),
    });

    // one customer + site, a reusable install key
    const client = await prisma.clients.create({ data: { organization_id: org, name: `Ent ${stamp}` }, select: { id: true } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" }, select: { id: true } });
    const key = await prov.createEnrollmentKey({ clientId: client.id, siteId: site.id, expiresMinutes: 60 }, null);
    const enroll = (deviceId, extra = {}) => auth.enrollAgent({ enrollmentKey: key.enrollmentKey, deviceId, hostname: `ENT-${deviceId.slice(0, 8)}`, os: "windows", arch: "x64", version: "1.3.40", ...extra });
    let mail = 0;
    const email = () => `ent-${stamp}-${++mail}@example.test`;
    const PASSWORD = "Str0ng!Passw0rd#2026";

    try {
        // ---------------------------------------------------------------- endpoints
        let known;
        await check("no file: enrolling works exactly as before", async () => {
            assert.ok(!fs.existsSync(file));
            known = crypto.randomUUID();
            const r = await enroll(known);
            assert.ok(r.agentToken && r.agentId);
        });

        await check("over the endpoint limit: a NEW device is refused with seat_limit_endpoints (402) and creates nothing", async () => {
            const c = await counts();
            limits({ maxEndpoints: c.agents }); // exactly at the limit
            const id = crypto.randomUUID();
            const e = await refusal(() => enroll(id));
            assert.equal(e?.status, 402);
            assert.equal(e.code, "seat_limit_endpoints");
            assert.match(e.message, /endpoint limit/);
            assert.match(e.message, /account\.example\.test/);
            assert.equal((await counts()).agents, c.agents, "no agent row");
            assert.equal((await prisma.devices.findUnique({ where: { id } })), null, "no device row");
        });

        await check("at the limit, re-enrolling a device that already has an agent still works and gets a new token", async () => {
            const c = await counts();
            limits({ maxEndpoints: c.agents });
            const before = (await prisma.agents.findUnique({ where: { device_id: known }, select: { agent_token: true } })).agent_token;
            await prisma.agents.update({ where: { device_id: known }, data: { last_check_in_at: new Date(Date.now() - 10 * 60_000) } }); // quiet long enough to be a reinstall
            const r = await enroll(known);
            assert.ok(r.agentToken);
            const after = (await prisma.agents.findUnique({ where: { device_id: known }, select: { agent_token: true } })).agent_token;
            assert.notEqual(before, after);
            assert.equal((await counts()).agents, c.agents);
        });

        await check("a refused one-time token is given back, so the same command works after an upgrade", async () => {
            const c = await counts();
            const device = crypto.randomUUID();
            await prisma.$executeRaw`INSERT INTO devices (id, site_id, hostname) VALUES (${device}::uuid, ${site.id}::uuid, ${"one-" + device})`;
            const token = `one-${crypto.randomUUID()}`;
            await prisma.$executeRaw`INSERT INTO endpoint_enrollments (client_id, site_id, device_id, os, alias, token_hash, expires_at) VALUES (${client.id}::uuid, ${site.id}::uuid, ${device}::uuid, 'windows', 'one', ${sha256(token)}, now() + interval '1 hour')`;
            limits({ maxEndpoints: c.agents });
            const e = await refusal(() => auth.enrollAgent({ enrollmentSecret: token, deviceId: device, hostname: "one", os: "windows", arch: "x64", version: "1.3.40" }));
            assert.equal(e?.code, "seat_limit_endpoints");
            const row = (await prisma.$queryRaw`SELECT used_at FROM endpoint_enrollments WHERE token_hash = ${sha256(token)}`)[0];
            assert.equal(row.used_at, null, "token not consumed");
            limits({ maxEndpoints: c.agents + 1 });
            const ok = await auth.enrollAgent({ enrollmentSecret: token, deviceId: device, hostname: "one", os: "windows", arch: "x64", version: "1.3.40" });
            assert.ok(ok.agentToken);
        });

        await check("one seat left: the next new device enrolls, the one after is refused; null means unlimited again", async () => {
            const c = await counts();
            limits({ maxEndpoints: c.agents + 1 });
            assert.ok((await enroll(crypto.randomUUID())).agentToken);
            assert.equal((await refusal(() => enroll(crypto.randomUUID())))?.code, "seat_limit_endpoints");
            limits({ maxEndpoints: null });
            assert.ok((await enroll(crypto.randomUUID())).agentToken);
        });

        await check("a malformed or removed file never blocks enrolling", async () => {
            fs.writeFileSync(file, "{ broken");
            assert.ok((await enroll(crypto.randomUUID())).agentToken);
            fs.rmSync(file);
            assert.ok((await enroll(crypto.randomUUID())).agentToken);
        });

        // ---------------------------------------------------------------- technicians
        let first;
        await check("no file: creating and inviting technicians works as before", async () => {
            first = (await users.createOne(owner, { email: email(), name: "First Tech", password: PASSWORD })).id;
            assert.ok((await users.inviteOne(owner, { email: email() })).id);
        });

        await check("over the technician limit: create is refused with seat_limit_technicians (402); nothing is written", async () => {
            const c = await counts();
            limits({ maxTechnicians: c.techs });
            const addr = email();
            const e = await refusal(() => users.createOne(owner, { email: addr, name: "Nope", password: PASSWORD }));
            assert.equal(e?.status, 402);
            assert.equal(e.code, "seat_limit_technicians");
            assert.match(e.message, /technician limit/);
            assert.equal(await prisma.users.findFirst({ where: { email: addr } }), null);
            assert.equal((await counts()).techs, c.techs);
        });

        await check("over the limit: a single invite is refused, but a switched-off account can still be created (it holds no seat)", async () => {
            const c = await counts();
            limits({ maxTechnicians: c.techs });
            assert.equal((await refusal(() => users.inviteOne(owner, { email: email() })))?.code, "seat_limit_technicians");
            const off = await users.createOne(owner, { email: email(), name: "Parked", password: PASSWORD, status: "suspended" });
            assert.ok(off.id);
            assert.equal((await counts()).techs, c.techs);
        });

        await check("re-sending an invite to someone already invited is not a new seat", async () => {
            const addr = email();
            limits({ maxTechnicians: null });
            await users.inviteOne(owner, { email: addr });
            const c = await counts();
            limits({ maxTechnicians: c.techs });
            assert.ok((await users.inviteOne(owner, { email: addr })).id);
        });

        await check("disabled users are not counted, and re-enabling one is refused at the limit but allowed with room", async () => {
            limits({ maxTechnicians: null });
            const u = (await users.createOne(owner, { email: email(), name: "Will Leave", password: PASSWORD })).id;
            await users.setSuspended(owner, u, true);
            const c = await counts();
            limits({ maxTechnicians: c.techs });
            assert.equal((await ent.getUsage(true)).technicians, c.techs, "the disabled user holds no seat");
            const e = await refusal(() => users.setSuspended(owner, u, false));
            assert.equal(e?.code, "seat_limit_technicians");
            assert.equal((await prisma.users.findUnique({ where: { id: u }, select: { status: true } })).status, "disabled");
            // suspending somebody never needs a seat, and frees one
            await users.setSuspended(owner, first, true);
            limits({ maxTechnicians: c.techs });
            await users.setSuspended(owner, u, false);
            assert.equal((await prisma.users.findUnique({ where: { id: u }, select: { status: true } })).status, "active");
            await users.setSuspended(owner, u, true); // suspending never needs a seat and frees this one
            await users.setSuspended(owner, first, false); // so there is room to bring the first one back
        });

        await check("bulk invite: as many as fit are sent in order, the rest are listed as skipped with the plan message", async () => {
            const c = await counts();
            limits({ maxTechnicians: c.techs + 2 });
            const emails = [email(), email(), email(), email()];
            const r = await users.inviteBulk(owner, { invites: emails.map((e) => ({ email: e })) });
            assert.equal(r.created, 2);
            assert.deepEqual(r.skipped.map((s) => s.email), emails.slice(2));
            for (const s of r.skipped) assert.match(s.reason, /technician limit/);
            assert.equal((await counts()).techs, c.techs + 2);
            assert.ok(await prisma.users.findFirst({ where: { email: emails[1] } }));
            assert.equal(await prisma.users.findFirst({ where: { email: emails[2] } }), null);
        });

        await check("bulk invite with no file sends everything", async () => {
            fs.rmSync(file, { force: true });
            const emails = [email(), email(), email()];
            const r = await users.inviteBulk(owner, { invites: emails.map((e) => ({ email: e })) });
            assert.equal(r.created, 3);
            assert.equal(r.skipped.length, 0);
        });

        await check("portal accounts are not technicians (they hold no seat)", async () => {
            const before = (await ent.getUsage(true)).technicians;
            await prisma.$executeRaw`INSERT INTO portal_accounts (organization_id, client_id, email, name, status) VALUES (${org}::uuid, ${client.id}::uuid, ${`portal-${stamp}@example.test`}, 'Portal Person', 'active')`;
            assert.equal((await ent.getUsage(true)).technicians, before);
        });

        await check("past_due and suspended never refuse by themselves", async () => {
            for (const status of ["past_due", "suspended"]) {
                limits({ status, maxEndpoints: 100000, maxTechnicians: 100000 });
                assert.ok((await enroll(crypto.randomUUID())).agentToken);
                assert.ok((await users.inviteOne(owner, { email: email() })).id);
            }
        });
    } finally {
        // Leave nothing behind: other tests count agents and people.
        const clean = async (fn) => { try { await fn(); } catch (e) { console.log(`     (cleanup: ${String(e.message).slice(0, 100)})`); } };
        await clean(() => prisma.$executeRaw`DELETE FROM agents WHERE device_id IN (SELECT id FROM devices WHERE site_id = ${site.id}::uuid)`);
        await clean(() => prisma.$executeRaw`DELETE FROM devices WHERE site_id = ${site.id}::uuid`);
        await clean(() => prisma.$executeRaw`DELETE FROM clients WHERE id = ${client.id}::uuid`);
        await clean(() => prisma.$executeRaw`DELETE FROM users WHERE email LIKE ${`ent-${stamp}-%`}`);
        fs.rmSync(tmp, { recursive: true, force: true });
        await prisma.$disconnect();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
