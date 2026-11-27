// Install keys for Group Policy and other mass installs: long-lived, listed, revocable, counted, and an installer
// script that leaves a machine alone when the agent is already there.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));

const scripts = dist("provisioning/installer-scripts.js");

let passed = 0, failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

(async () => {
    const values = { baseUrl: "https://api.example.test", enrollmentKey: "KEY_abc-123", packageSha256: "a".repeat(64) };

    await check("the Windows script reinstalls by default, and only when the agent is missing for a startup script", () => {
        const normal = scripts.windowsInstallerScript(values);
        assert.match(normal, /^\$OnlyIfMissing = \$false$/m);
        const gpo = scripts.windowsInstallerScript({ ...values, onlyIfMissing: true });
        assert.match(gpo, /^\$OnlyIfMissing = \$true$/m);
        for (const s of [normal, gpo]) {
            assert.ok(!s.includes("__"), "every placeholder is filled in");
            assert.equal(s.split("KEY_abc-123").length - 1, 1);
            assert.match(s, /already installed and enrolled\. Nothing to do\./);
            // A startup script has no keyboard, so it must never wait for one.
            assert.match(s, /-not \$OnlyIfMissing -and -not \[Console\]::IsInputRedirected/);
        }
        // The check comes before anything on the machine is touched.
        assert.ok(gpo.indexOf("Nothing to do.") < gpo.indexOf("New-Item -ItemType Directory"));
        assert.ok(gpo.indexOf("Nothing to do.") < gpo.indexOf("Stop-Service"));
    });
    await check("the Linux script does the same", () => {
        const normal = scripts.linuxInstallerScript(values);
        assert.match(normal, /^ONLY_IF_MISSING=0$/m);
        const gpo = scripts.linuxInstallerScript({ ...values, onlyIfMissing: true });
        assert.match(gpo, /^ONLY_IF_MISSING=1$/m);
        assert.ok(!gpo.includes("__"));
        assert.ok(gpo.indexOf("Nothing to do.") < gpo.indexOf("\nsvc_stop\n"), "the stop of a working agent comes after the nothing-to-do exit");
    });
    await check("nothing in a value is read as a replacement pattern", () => {
        const odd = scripts.windowsInstallerScript({ ...values, enrollmentKey: "a$&b$'c$`d", onlyIfMissing: true });
        assert.ok(odd.includes("a$&b$'c$`d"));
    });
    await check("both scripts are valid syntax", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adg-scripts-"));
        try {
            const sh = path.join(tmp, "i.sh");
            fs.writeFileSync(sh, scripts.linuxInstallerScript({ ...values, onlyIfMissing: true }));
            const bash = spawnSync("bash", ["-n", sh], { encoding: "utf8" });
            if (bash.error) return console.log("     (bash not available, skipped)");
            assert.equal(bash.status, 0, bash.stderr);
            const ps = path.join(tmp, "i.ps1");
            fs.writeFileSync(ps, scripts.windowsInstallerScript({ ...values, onlyIfMissing: true }));
            const cmd = `$e = $null; $t = $null; [System.Management.Automation.Language.Parser]::ParseFile('${ps.replace(/'/g, "''")}', [ref]$t, [ref]$e) | Out-Null; if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`;
            const r = spawnSync(process.platform === "win32" ? "powershell" : "pwsh", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
            if (r.error) return console.log("     (PowerShell not available, skipped)");
            assert.equal(r.status, 0, r.stdout + r.stderr);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    // ---- Keys, against the test database ----
    const { PrismaService } = dist("storage/prisma.service.js");
    const { ProvisioningService } = dist("provisioning/provisioning.service.js");
    const { AuthService } = dist("auth/auth.service.js");
    const prisma = new PrismaService();
    const prov = new ProvisioningService(prisma);
    const auth = new AuthService(prisma, { assertCanEnrollEndpoint: async () => { } });
    const org = (await prisma.$queryRaw`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)[0].id;
    const stamp = Date.now().toString(36);
    const mkClient = async (name) => {
        const c = await prisma.clients.create({ data: { organization_id: org, name: `${name} ${stamp}` }, select: { id: true } });
        const s = await prisma.sites.create({ data: { client_id: c.id, name: `${name} HQ` }, select: { id: true } });
        return { client: c.id, site: s.id };
    };
    const A = await mkClient("KeysA");
    const B = await mkClient("KeysB");
    const userId = (await prisma.$queryRaw`INSERT INTO users (organization_id, email, password_hash, first_name, last_name, status) VALUES (${org}::uuid, ${`keys-${stamp}@x.test`}, 'x', 'Kay', 'Admin', 'active') RETURNING id::text AS id`)[0].id;
    const keys = [];
    const devices = [];
    const make = async (site, client, extra = {}) => {
        const r = await prov.createEnrollmentKey({ clientId: client, siteId: site, ...extra }, userId);
        keys.push(r.tokenId);
        return r;
    };
    const scopeA = { clients: [A.client], sites: [], tags: [] };
    const scopeB = { clients: [B.client], sites: [], tags: [] };
    const find = async (scope, id) => (await prov.listEnrollmentKeys(scope)).find((k) => k.id === id);

    try {
        let long;
        await check("a key can last up to ten years, and no longer", async () => {
            long = await make(A.site, A.client, { name: "GPO key", expiresMinutes: 5_259_600 });
            const years = (new Date(long.expiresAt).getTime() - Date.now()) / (365 * 86_400_000);
            assert.ok(years > 9.9 && years < 10.1, `${years} years`);
            await assert.rejects(() => prov.createEnrollmentKey({ clientId: A.client, siteId: A.site, expiresMinutes: 5_259_601 }, userId), /between 1 and 5259600/);
            await assert.rejects(() => prov.createEnrollmentKey({ clientId: B.client, siteId: A.site, expiresMinutes: 60 }, userId), /site/i, "the site must belong to the customer");
        });

        await check("keys are listed with their customer, site, maker, dates, use and status, never the key itself", async () => {
            const k = await find(null, long.tokenId);
            assert.equal(k.name, "GPO key");
            assert.equal(k.clientName, `KeysA ${stamp}`);
            assert.equal(k.siteName, "KeysA HQ");
            assert.equal(k.createdBy, "Kay Admin");
            assert.equal(k.status, "active");
            assert.equal(k.useCount, 0);
            assert.equal(k.lastUsedAt, null);
            assert.ok(!JSON.stringify(await prov.listEnrollmentKeys(null)).includes(long.enrollmentKey));
            assert.ok(!("token_hash" in k) && !("tokenHash" in k));
        });

        await check("someone limited to a customer sees and changes only that customer's keys", async () => {
            const forB = await make(B.site, B.client, { name: "B key", expiresMinutes: 60 });
            assert.ok(await find(scopeA, long.tokenId));
            assert.equal(await find(scopeA, forB.tokenId), undefined);
            assert.ok(await find(scopeB, forB.tokenId));
            await assert.rejects(() => prov.revokeEnrollmentKey(forB.tokenId, scopeA), /not found/);
            await assert.rejects(() => prov.renameEnrollmentKey(forB.tokenId, "mine now", scopeA), /not found/);
            await assert.rejects(() => prov.revokeEnrollmentKey("not-a-uuid", null), /not found/);
            await assert.rejects(() => prov.revokeEnrollmentKey(randomUUID(), null), /not found/);
            assert.equal((await find(null, forB.tokenId)).status, "active");
            assert.equal((await find(null, forB.tokenId)).name, "B key");
        });

        await check("a device enrolling with a key is counted, and the key is shown as used", async () => {
            const id = randomUUID();
            devices.push(id);
            const r = await auth.enrollAgent({ enrollmentKey: long.enrollmentKey, deviceId: id, hostname: `KEYS-PC-${stamp}`, os: "windows", arch: "x64", version: "1.3.33" });
            assert.ok(r.agentToken);
            const k = await find(null, long.tokenId);
            assert.equal(k.useCount, 1);
            assert.ok(k.lastUsedAt);
            const placed = (await prisma.$queryRaw`SELECT s.client_id::text AS client FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ${id}::uuid`)[0];
            assert.equal(placed.client, A.client, "the device lands at the key's customer");
        });

        await check("a site key cannot take over a device whose agent is still checking in; a quiet one can be reinstalled, and that is audited", async () => {
            const own = await make(A.site, A.client, { name: "Reenroll key" });
            const id = randomUUID();
            devices.push(id);
            const host = `KEYS-RE-${stamp}`;
            const first = await auth.enrollAgent({ enrollmentKey: own.enrollmentKey, deviceId: id, hostname: host, os: "windows", arch: "x64", version: "1.3.33" });
            // Right after enrolling the agent is online: the same key must not replace its token.
            await assert.rejects(
                () => auth.enrollAgent({ enrollmentKey: own.enrollmentKey, deviceId: id, hostname: host, os: "windows", arch: "x64", version: "1.3.33" }),
                /online and already enrolled/,
            );
            const stillFirst = (await prisma.$queryRaw`SELECT agent_token FROM agents WHERE device_id = ${id}::uuid`)[0].agent_token;
            assert.ok(stillFirst, "the original token is untouched");
            // Once the agent has been quiet for longer than the reinstall window, re-enrolling works.
            await prisma.$executeRaw`UPDATE agents SET last_check_in_at = now() - interval '10 minutes' WHERE device_id = ${id}::uuid`;
            const again = await auth.enrollAgent({ enrollmentKey: own.enrollmentKey, deviceId: id, hostname: host, os: "windows", arch: "x64", version: "1.3.34" });
            assert.ok(again.agentToken && again.agentToken !== first.agentToken, "a new token is issued");
            const rows = await prisma.$queryRaw`SELECT count(*)::int AS n FROM audit_events WHERE action = 'agent.reenrolled' AND target_id = ${id}`;
            assert.equal(rows[0].n, 1, "the re-enrollment is in the audit log");
        });

        await check("renaming works, and a revoked key stops enrolling new devices at once", async () => {
            await prov.renameEnrollmentKey(long.tokenId, "  Renamed key  ", null);
            assert.equal((await find(null, long.tokenId)).name, "Renamed key");
            await prov.renameEnrollmentKey(long.tokenId, "   ", null);
            assert.equal((await find(null, long.tokenId)).name, "");
            assert.deepEqual(await prov.revokeEnrollmentKey(long.tokenId, scopeA), { ok: true });
            const k = await find(null, long.tokenId);
            assert.equal(k.status, "revoked");
            assert.ok(k.revokedAt);
            const again = await prov.revokeEnrollmentKey(long.tokenId, null);
            assert.deepEqual(again, { ok: true });
            assert.equal((await find(null, long.tokenId)).revokedAt, k.revokedAt, "revoking twice changes nothing");
            const id = randomUUID();
            devices.push(id);
            await assert.rejects(() => auth.enrollAgent({ enrollmentKey: long.enrollmentKey, deviceId: id, hostname: `KEYS-PC2-${stamp}`, os: "windows", arch: "x64", version: "1.3.33" }), /Invalid enrollment secret/);
            assert.equal((await find(null, long.tokenId)).useCount, 1, "a refused attempt is not counted");
            // The device that enrolled earlier is not touched by the revocation.
            assert.equal((await prisma.devices.count({ where: { id: devices[0] } })), 1);
            // The agent download is refused too.
            await assert.rejects(() => prov.getAgentPackageDownload("windows", long.enrollmentKey), /revoked|expired|Invalid/);
        });

        await check("an expired key shows as expired and does not enroll", async () => {
            const k = await make(A.site, A.client, { name: "short", expiresMinutes: 1 });
            await prisma.site_enrollment_keys.update({ where: { id: k.tokenId }, data: { expires_at: new Date(Date.now() - 1000) } });
            assert.equal((await find(null, k.tokenId)).status, "expired");
            const id = randomUUID();
            devices.push(id);
            await assert.rejects(() => auth.enrollAgent({ enrollmentKey: k.enrollmentKey, deviceId: id, hostname: `KEYS-PC3-${stamp}`, os: "windows", arch: "x64", version: "1.3.33" }), /Invalid enrollment secret/);
        });

        await check("the list is newest first", async () => {
            const items = (await prov.listEnrollmentKeys(null)).filter((k) => keys.includes(k.id));
            const times = items.map((i) => i.createdAt);
            assert.deepEqual(times, [...times].sort().reverse());
        });
    } finally {
        await prisma.$executeRawUnsafe(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, devices);
        await prisma.$executeRawUnsafe(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, devices);
        await prisma.$executeRawUnsafe(`DELETE FROM site_enrollment_keys WHERE id = ANY($1::uuid[])`, keys);
        await prisma.$executeRawUnsafe(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [A.client, B.client]);
        await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = '${userId}'`);
        await prisma.$disconnect();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
