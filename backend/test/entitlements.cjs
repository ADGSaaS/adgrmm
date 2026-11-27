// Seat limits (hosted plans): reading the file, failing open, caching, the banner and the refusals. Plain Node, no database:
//   node test/entitlements.cjs   (after `npx tsc -p tsconfig.json`)
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));
const { EntitlementsService, parseEntitlements, buildBanner } = dist("entitlements/entitlements.service.js");

let passed = 0, failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adg-ent-"));
const file = path.join(tmp, "entitlements.json");
process.env.ENTITLEMENTS_FILE = file;
delete process.env.DEMO_MODE;

// A stand-in database: counts are whatever the test says.
const counts = { agents: 0, users: 0, queries: 0 };
const prisma = {
    agents: { count: async () => { counts.queries++; return counts.agents; } },
    users: { count: async (args) => { counts.queries++; assert.deepEqual(args, { where: { status: { in: ["active", "invited"] } } }); return counts.users; } },
};
const put = (obj) => fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));
const body = (over = {}) => ({ version: 1, maxEndpoints: 10, maxTechnicians: 3, status: "active", upgradeUrl: "https://account.example.test", updatedAt: "2026-11-27T00:00:00Z", ...over });
const fresh = () => { const s = new EntitlementsService(prisma); let t = 1_000_000; s.now = () => t; s.advance = (ms) => { t += ms; }; return s; };
const code = async (fn) => { try { await fn(); } catch (e) { return { status: e.getStatus?.(), ...(e.getResponse?.() ?? {}) }; } return null; };

(async () => {
    await check("no file means no limits, and nothing is refused", async () => {
        const s = fresh();
        assert.equal(s.getLimits(), null);
        counts.agents = 9999; counts.users = 9999;
        assert.equal(await code(() => s.assertCanEnrollEndpoint()), null);
        assert.equal(await code(() => s.assertCanAddTechnicians(50)), null);
        assert.deepEqual(await s.summary(), { limits: null, usage: null, status: null, upgradeUrl: null, banner: null });
    });

    await check("a valid file is read, and nothing but the documented fields is kept", () => {
        put({ ...body(), secret: "x", extra: { a: 1 } });
        const l = fresh().getLimits();
        assert.deepEqual(l, { maxEndpoints: 10, maxTechnicians: 3, status: "active", upgradeUrl: "https://account.example.test/", updatedAt: "2026-11-27T00:00:00Z" });
    });

    await check("null (or a missing key) means unlimited for that seat type", async () => {
        put(body({ maxEndpoints: null }));
        let s = fresh();
        assert.equal(s.getLimits().maxEndpoints, null);
        counts.agents = 5000;
        assert.equal(await code(() => s.assertCanEnrollEndpoint()), null);
        put({ version: 1, status: "active" });
        s = fresh();
        assert.equal(s.getLimits().maxTechnicians, null);
        assert.equal(await code(() => s.assertCanAddTechnicians(1)), null);
    });

    await check("malformed files fail open and warn once per change, never throw", () => {
        const warnings = [];
        const { Logger } = require("@nestjs/common");
        const orig = Logger.prototype.warn;
        Logger.prototype.warn = function (m) { warnings.push(String(m)); };
        try {
            const s = fresh();
            const bad = ["{ not json", "[]", "null", '"text"', JSON.stringify(body({ maxEndpoints: "10" })), JSON.stringify(body({ maxTechnicians: -1 })), JSON.stringify(body({ maxEndpoints: 1.5 }))];
            let expected = 0;
            for (const b of bad) {
                put(b + " ".repeat(expected)); // a different size each time, so each is a change
                expected++;
                assert.equal(s.getLimits(), null, b);
                s.advance(20_000);
                assert.equal(s.getLimits(), null);        // re-read after the cache expires: same file, no second warning
                assert.equal(warnings.length, expected, `one warning for ${b}`);
            }
            assert.match(warnings[0], /treated as unlimited/);
        } finally { Logger.prototype.warn = orig; }
    });

    await check("an unreadable path (a folder) fails open", () => {
        process.env.ENTITLEMENTS_FILE = tmp;
        try { assert.equal(fresh().getLimits(), null); } finally { process.env.ENTITLEMENTS_FILE = file; }
    });

    await check("an unknown status reads as active; only web addresses are kept as the upgrade link", () => {
        assert.equal(parseEntitlements(JSON.stringify(body({ status: "weird" }))).limits.status, "active");
        for (const u of ["javascript:alert(1)", "ftp://x.test", "nonsense", 5, null]) {
            assert.equal(parseEntitlements(JSON.stringify(body({ upgradeUrl: u }))).limits.upgradeUrl, null, String(u));
        }
        assert.equal(parseEntitlements(JSON.stringify(body({ status: "suspended" }))).limits.status, "suspended");
    });

    await check("the file is cached for 15 seconds, and re-read at once when it changes", () => {
        put(body({ maxEndpoints: 10 }));
        const s = fresh();
        assert.equal(s.getLimits().maxEndpoints, 10);
        const reads = [];
        const orig = fs.readFileSync;
        fs.readFileSync = function (p, ...a) { if (p === file) reads.push(1); return orig.call(this, p, ...a); };
        try {
            s.getLimits(); s.advance(14_000); s.getLimits();
            assert.equal(reads.length, 0, "no re-read inside 15 seconds");
            s.advance(2_000); s.getLimits();
            assert.equal(reads.length, 1, "re-read after 15 seconds");
            put(body({ maxEndpoints: 11 }));
            fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
            assert.equal(s.getLimits().maxEndpoints, 11, "a changed file is picked up without waiting");
            fs.unlinkSync(file);
            assert.equal(s.getLimits(), null, "a removed file means unlimited again");
        } finally { fs.readFileSync = orig; }
    });

    await check("usage counts are cached for a few seconds, and fresh when enforcing", async () => {
        const s = fresh();
        counts.agents = 4; counts.users = 2; counts.queries = 0;
        assert.deepEqual(await s.getUsage(), { endpoints: 4, technicians: 2 });
        counts.agents = 5;
        assert.equal((await s.getUsage()).endpoints, 4, "cached");
        s.advance(6_000);
        assert.equal((await s.getUsage()).endpoints, 5, "expired");
        counts.agents = 6;
        assert.equal((await s.getUsage(true)).endpoints, 6, "fresh on request");
    });

    await check("endpoint refusal: code, 402, message with the plan limit and the upgrade link", async () => {
        put(body({ maxEndpoints: 3 }));
        const s = fresh();
        counts.agents = 2;
        assert.equal(await code(() => s.assertCanEnrollEndpoint()), null, "one seat left");
        counts.agents = 3;
        const e = await code(() => s.assertCanEnrollEndpoint());
        assert.equal(e.status, 402);
        assert.equal(e.code, "seat_limit_endpoints");
        assert.match(e.message, /endpoint limit \(3\) is reached/);
        assert.match(e.message, /https:\/\/account\.example\.test\//);
        counts.agents = 4;
        assert.equal((await code(() => s.assertCanEnrollEndpoint())).code, "seat_limit_endpoints", "over the limit is refused too");
    });

    await check("without an upgrade link the message still reads well", async () => {
        put(body({ maxEndpoints: 1, upgradeUrl: null }));
        counts.agents = 1;
        const e = await code(() => fresh().assertCanEnrollEndpoint());
        assert.match(e.message, /Ask your administrator/);
        assert.ok(!/undefined|null/.test(e.message));
    });

    await check("technician refusal and room", async () => {
        put(body({ maxTechnicians: 3 }));
        const s = fresh();
        counts.users = 2;
        assert.equal(await s.technicianRoom(), 1);
        assert.equal(await code(() => s.assertCanAddTechnicians(1)), null);
        const two = await code(() => s.assertCanAddTechnicians(2));
        assert.equal(two.code, "seat_limit_technicians");
        assert.equal(two.status, 402);
        counts.users = 3;
        assert.equal(await s.technicianRoom(), 0);
        assert.match((await code(() => s.assertCanAddTechnicians(1))).message, /technician limit \(3\)/);
    });

    await check("a limit of zero refuses everything", async () => {
        put(body({ maxEndpoints: 0, maxTechnicians: 0 }));
        counts.agents = 0; counts.users = 0;
        const s = fresh();
        assert.equal((await code(() => s.assertCanEnrollEndpoint())).code, "seat_limit_endpoints");
        assert.equal((await code(() => s.assertCanAddTechnicians(1))).code, "seat_limit_technicians");
    });

    await check("suspended and past_due never block adding by themselves", async () => {
        for (const status of ["suspended", "past_due"]) {
            put(body({ status, maxEndpoints: 100, maxTechnicians: 100 }));
            counts.agents = 1; counts.users = 1;
            const s = fresh();
            assert.equal(await code(() => s.assertCanEnrollEndpoint()), null);
            assert.equal(await code(() => s.assertCanAddTechnicians(1)), null);
        }
    });

    await check("banner thresholds: nothing below 90 percent, warn from 90, error at the limit or when payment failed", () => {
        const L = (o = {}) => ({ maxEndpoints: 100, maxTechnicians: 10, status: "active", upgradeUrl: null, updatedAt: null, ...o });
        assert.equal(buildBanner(null, { endpoints: 500, technicians: 500 }), null);
        assert.equal(buildBanner(L(), { endpoints: 89, technicians: 8 }), null);
        assert.equal(buildBanner(L(), { endpoints: 90, technicians: 8 }).level, "warn");
        assert.equal(buildBanner(L(), { endpoints: 10, technicians: 9 }).level, "warn");
        assert.equal(buildBanner(L(), { endpoints: 99, technicians: 0 }).level, "warn");
        assert.equal(buildBanner(L(), { endpoints: 100, technicians: 0 }).level, "error");
        assert.equal(buildBanner(L(), { endpoints: 130, technicians: 0 }).level, "error");
        assert.equal(buildBanner(L(), { endpoints: 0, technicians: 10 }).level, "error");
        assert.equal(buildBanner(L({ maxEndpoints: null, maxTechnicians: null }), { endpoints: 9e6, technicians: 9e6 }), null);
        const pd = buildBanner(L({ status: "past_due" }), { endpoints: 1, technicians: 1 });
        assert.equal(pd.level, "error");
        assert.match(pd.text, /Payment failed/);
        assert.equal(buildBanner(L({ status: "suspended" }), { endpoints: 1, technicians: 1 }), null);
        const both = buildBanner(L({ upgradeUrl: "https://a.test/" }), { endpoints: 100, technicians: 9 });
        assert.equal(both.level, "error");
        assert.match(both.text, /Endpoint limit reached \(100 of 100\)/);
        assert.match(both.text, /using 9 of 10 technician seats/);
        assert.match(both.text, /https:\/\/a\.test\//);
    });

    await check("the summary returns only limits, usage, status, link and banner", async () => {
        put({ ...body({ maxEndpoints: 10 }), secretField: "no" });
        counts.agents = 9; counts.users = 1;
        const r = await fresh().summary();
        assert.deepEqual(Object.keys(r).sort(), ["banner", "limits", "status", "upgradeUrl", "usage"]);
        assert.deepEqual(r.limits, { maxEndpoints: 10, maxTechnicians: 3 });
        assert.deepEqual(r.usage, { endpoints: 9, technicians: 1 });
        assert.equal(r.banner.level, "warn");
        assert.ok(!JSON.stringify(r).includes("secretField"));
    });

    await check("the public demo never has limits, even with a file present", async () => {
        put(body({ maxEndpoints: 0 }));
        process.env.DEMO_MODE = "1";
        try {
            const s = fresh();
            assert.equal(s.getLimits(), null);
            assert.equal((await s.summary()).limits, null);
            counts.agents = 50;
            assert.equal(await code(() => s.assertCanEnrollEndpoint()), null);
        } finally { delete process.env.DEMO_MODE; }
    });

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
