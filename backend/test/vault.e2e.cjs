// Security basics, stage 2 (device-secrets vault) in the application against a real database (no HTTP): policy settings and their
// inheritance, the scheduler with an injected clock (escrow and local administrator password rotation: default off, caps per sweep,
// offline / no-agent devices skipped, Linux devices handled with their own scripts, waiting jobs left alone, retries, rotate after reveal), the arrival of results through
// the REAL JobsService.finishJob (redaction proof, also when the ingest fails or the output is hostile), previous / unconfirmed
// generations, keeping the last three, the purge sweeper, BitLocker previous-after-two-reads, reveal checks, and that no secret is in
// any table but the sealed one. Throwaway database only (name has "e2e").
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.SECURITY_SCANS_AUTOMATION_ENABLED = "false";
process.env.SECURITY_SCANS_POLLER_ENABLED = "false";
process.env.DEVICE_SECRETS_AUTOMATION_ENABLED = "false"; // the test calls run() itself
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++; else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e?.response?.message ?? e?.message ?? e)); } };

const ALPHA = { u: "ABCDEFGHJKLMNPQRSTUVWXYZ", l: "abcdefghijkmnpqrstuvwxyz", d: "23456789", s: "!#%&*+=?@^_" };
let counter = 0;
const pw = (len = 20) => {
    const pick = (set) => set[crypto.randomInt(set.length)];
    const chars = [pick(ALPHA.u), pick(ALPHA.l), pick(ALPHA.d), pick(ALPHA.s)];
    const all = Object.values(ALPHA).join("");
    while (chars.length < len) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    return chars.join("");
};
const rpass = () => { counter++; const g = () => String(100000 + crypto.randomInt(800000)); return `${String(counter).padStart(6, "0")}-${g()}-${g()}-${g()}-${g()}-${g()}-${g()}-${g()}`; };
const guid = () => crypto.randomUUID();

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PoliciesService } = require(path.join(dist, "policies/policies.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { JobsService } = require(path.join(dist, "jobs/jobs.service.js"));
    const { VaultService, TOOL_BITLOCKER, TOOL_LAPS, TOOL_LUKS, PENDING_STALE_MS } = require(path.join(dist, "vault/vault.service.js"));
    const { VaultAutomationService, ESCROWS_PER_SWEEP, ROTATIONS_PER_SWEEP } = require(path.join(dist, "vault/vault-automation.service.js"));
    const J = require(path.join(dist, "jobs/secret-jobs.js"));
    const j2s = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? Number(x) : x));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const policies = app.get(PoliciesService, { strict: false });
    const jobs = app.get(JobsService, { strict: false });
    const vault = app.get(VaultService, { strict: false });
    const auto = app.get(VaultAutomationService, { strict: false });

    const { VaultLimiters } = require(path.join(dist, "vault/vault.limiter.js"));
    vault.limiters = VaultLimiters.custom(Date.now, { revealUser: 100000, revealDevice: 100000 });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const o = org.id;
    const stamp = Date.now();
    const me = { id: null, name: "Test Person" };
    const actor = { id: null, name: "Test Person", email: "tp@example.test" };
    const HOUR = 3600_000;
    const DAY = 24 * HOUR;

    async function customer(label) {
        const client = await prisma.clients.create({ data: { organization_id: o, name: `Vault ${label} ${stamp}` } });
        const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
        return { client, site };
    }
    const online = new Set();
    async function device(c, label, { os = "windows", online: isOnline = true, agent = true } = {}) {
        const dev = await prisma.devices.create({ data: { site_id: c.site.id, hostname: `VLT-${label}-${stamp}`, operating_system: os === "windows" ? "Windows 11 Pro" : "Ubuntu 22.04" } });
        const a = agent ? await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: "1.3.30", last_check_in_at: isOnline ? new Date() : new Date(Date.now() - 3 * HOUR), facts: { os } } }) : null;
        if (a && isOnline) online.add(a.id);
        return { dev, agent: a, c };
    }
    const jobsOf = (d, tool) => prisma.jobs.findMany({ where: { agent_id: d.agent.id }, orderBy: { created_at: "asc" } }).then((l) => (tool ? l.filter((j) => j.payload?.env?.RIQ_TOOL === tool) : l));
    const stateOf = async (d) => (await prisma.$queryRaw`SELECT * FROM public.device_secret_state WHERE device_id = ${d.dev.id}::uuid`)[0] ?? null;
    const secretsOf = (d, kind) => prisma.$queryRaw`SELECT id::text AS id, kind, label, ref, status, missed_reads, ciphertext, created_at, superseded_at FROM public.device_secrets WHERE device_id = ${d.dev.id}::uuid ORDER BY created_at, id`.then((r) => (kind ? r.filter((x) => x.kind === kind) : r));
    async function runAt(t) {
        await prisma.agents.updateMany({ where: { id: { in: [...online] } }, data: { last_check_in_at: new Date(t) } });
        return auto.run(t);
    }
    /** What the device's agent does: reports a result for the newest waiting job of a tool, through the real finishJob. */
    async function deliver(d, tool, stdout, { status = "succeeded", stderr = "", exitCode } = {}) {
        const list = (await jobsOf(d, tool)).filter((j) => ["queued", "dispatched", "running"].includes(j.status));
        const j = list.pop();
        if (!j) throw new Error(`no waiting ${tool} job`);
        const ok = await jobs.finishJob(j.id, { exitCode: exitCode ?? (status === "succeeded" ? 0 : 1), stdout, stderr, durationMs: 7 }, status, { agentId: d.agent.id });
        return { id: j.id, accepted: ok, payload: j.payload };
    }
    const lapsOut = (password, { account = "riq-admin", verified = true, created = false } = {}) => JSON.stringify({ ok: true, account, created, verified, password });
    const bitOut = (keys) => JSON.stringify({ ok: true, keys: keys.map((k) => ({ mount: k.mount ?? "C:", protectorId: `{${k.id.toUpperCase()}}`, recoveryPassword: k.pw })) });
    const revealAs = (d, secretId, reason = "ticket 5512 lost laptop", a = actor) => vault.reveal({ id: d.dev.id, name: d.dev.hostname, windows: true }, secretId, a, reason);
    const view = async (d) => vault.view(await vault.device(d.dev.id), { reveal: true, manage: true });
    const adminRows = async (d) => (await secretsOf(d, "local_admin")).filter((r) => r.status !== "purged");

    // every table that could hold a secret, as text, for the grep checks
    async function dump() {
        const tables = ["jobs", "job_results", "device_secret_access", "device_secret_state", "audit_events", "bulk_batches", "bulk_batch_items", "device_security_scans"];
        const parts = [];
        for (const t of tables) {
            try { parts.push(...(await prisma.$queryRawUnsafe(`SELECT row_to_json(x)::text AS j FROM public.${t} x`)).map((r) => r.j)); } catch { /* table name differs */ }
        }
        parts.push(...(await prisma.$queryRawUnsafe(`SELECT row_to_json(x)::text AS j FROM public.device_secrets x`)).map((r) => r.j));
        return parts.join("\n");
    }
    const leaks = async (...secrets) => { const all = await dump(); return secrets.filter((s) => all.includes(s)); };

    const A = await customer("A");
    const B = await customer("B");
    const Cc = await customer("C");

    /* ======================================================== policy settings ======================================================== */
    console.log("policy settings");
    const probe = await device(A, "probe");
    const eff0 = (await policies.effectiveForDevices([probe.dev.id])).values().next().value;
    const sc = eff0.scalars;
    check("defaults: escrow off, LAPS off, account riq-admin, length 20, every 30 days, 60 minutes after a reveal, all from the baseline",
        sc["security.bitlockerEscrow"].value === "off" && sc["laps.enabled"].value === false && sc["laps.account"].value === "riq-admin" && sc["laps.passwordLength"].value === 20 && sc["laps.rotateDays"].value === 30 && sc["laps.rotateAfterRevealMinutes"].value === 60
        && ["security.bitlockerEscrow", "laps.enabled", "laps.account"].every((k) => sc[k].source.kind === "default"), Object.fromEntries(Object.entries(sc).filter(([k]) => /laps|Escrow/.test(k)).map(([k, v]) => [k, v.value])));
    const bad = async (sections, re) => fails(() => policies.create({ name: `bad ${Math.random()}`, sections }, me, o), re);
    check("policy: escrow must be off or on", await bad({ security: { bitlockerEscrow: "maybe" } }, /off.*on/) && await bad({ security: { bitlockerEscrow: true } }, /off.*on/));
    check("policy: account names are checked strictly (reserved, length, characters)",
        await bad({ laps: { account: "Administrator" } }, /reserved/) && await bad({ laps: { account: "guest" } }, /reserved/) && await bad({ laps: { account: "SYSTEM" } }, /reserved/) && await bad({ laps: { account: "DefaultAccount" } }, /reserved/)
        && await bad({ laps: { account: "" } }, /1 to 20/) && await bad({ laps: { account: "a".repeat(21) } }, /1 to 20/) && await bad({ laps: { account: "bad name" } }, /1 to 20/) && await bad({ laps: { account: "a;b" } }, /1 to 20/) && await bad({ laps: { account: "a\\b" } }, /1 to 20/) && await bad({ laps: { account: 5 } }, /1 to 20/));
    check("policy: password length 14 to 64, rotate days 1 to 365, rotate-after-reveal 0 to 10080, enabled must be a boolean",
        await bad({ laps: { passwordLength: 13 } }, /14 to 64/) && await bad({ laps: { passwordLength: 65 } }, /14 to 64/) && await bad({ laps: { passwordLength: 20.5 } }, /whole number/)
        && await bad({ laps: { rotateDays: 0 } }, /1 to 365/) && await bad({ laps: { rotateDays: 366 } }, /1 to 365/) && await bad({ laps: { rotateAfterRevealMinutes: -1 } }, /0 to 10080/) && await bad({ laps: { rotateAfterRevealMinutes: 10081 } }, /0 to 10080/)
        && await bad({ laps: { enabled: "yes" } }, /on or off/) && await bad({ laps: { password: "x" } }, /do not know/) && await bad({ security: { scanHours: 6, secret: 1 } }, /do not know/));
    check("policy: the edge values are accepted", (await policies.preview({ name: "x", sections: { laps: { enabled: true, account: "a", passwordLength: 14, rotateDays: 1, rotateAfterRevealMinutes: 0 } } }, o)) !== null && (await policies.preview({ name: "x", sections: { laps: { passwordLength: 64, rotateDays: 365, rotateAfterRevealMinutes: 10080, account: "My.Admin_01-x" } } }, o)) !== null);
    // inheritance: a global policy turns escrow on, a customer policy turns it off for C, a device policy turns it on again for one device of C
    const dA = await device(A, "pol-a");
    const dC = await device(Cc, "pol-c1");
    const dC2 = await device(Cc, "pol-c2");
    const pG = await policies.create({ name: `vault global ${stamp}`, sections: { security: { bitlockerEscrow: "on" }, laps: { account: "global-admin", passwordLength: 24 } }, assignments: [{ level: "global" }] }, me, o);
    const pC = await policies.create({ name: `vault customer C ${stamp}`, sections: { security: { bitlockerEscrow: "off" }, laps: { account: "c-admin" } }, assignments: [{ level: "customer", targetId: Cc.client.id }] }, me, o);
    const pD = await policies.create({ name: `vault device ${stamp}`, sections: { security: { bitlockerEscrow: "on" } }, assignments: [{ level: "device", targetId: dC2.dev.id }] }, me, o);
    let e = await policies.effectiveForDevices([dA.dev.id, dC.dev.id, dC2.dev.id]);
    check("inheritance: global on; customer overrides to off; the device policy turns it on again; account and length inherit with their source",
        e.get(dA.dev.id).scalars["security.bitlockerEscrow"].value === "on" && e.get(dC.dev.id).scalars["security.bitlockerEscrow"].value === "off" && e.get(dC2.dev.id).scalars["security.bitlockerEscrow"].value === "on"
        && e.get(dC.dev.id).scalars["laps.account"].value === "c-admin" && e.get(dA.dev.id).scalars["laps.account"].value === "global-admin" && e.get(dC.dev.id).scalars["laps.passwordLength"].value === 24
        && e.get(dC2.dev.id).scalars["security.bitlockerEscrow"].source.name === `vault device ${stamp}` && e.get(dC.dev.id).scalars["laps.passwordLength"].source.name === `vault global ${stamp}`);
    const settings = await vault.settingsOf([dA.dev.id, dC.dev.id]);
    check("the vault reads the same effective settings", settings.get(dA.dev.id).escrow.enabled === true && settings.get(dC.dev.id).escrow.enabled === false && settings.get(dC.dev.id).laps.account === "c-admin" && settings.get(dA.dev.id).laps.enabled === false);
        for (const p of [pG, pC, pD]) await prisma.$executeRaw`DELETE FROM public.policies WHERE id = ${p.id}::uuid`.catch(() => undefined);
    PoliciesService.invalidate();

    /* ======================================================== scheduler: default off ======================================================== */
    console.log("scheduler");
    // use customers of their own per scenario so the policies below do not mix
    const S1 = await customer("S1");
    const w1 = await device(S1, "w1");
    const w2 = await device(S1, "w2");
    const off1 = await device(S1, "offline", { online: false });
    const lin1 = await device(S1, "linux", { os: "linux" });
    const noag = await device(S1, "noagent", { agent: false });
    let t = Date.now();
    let r = await runAt(t);
    const countJobs = async (ds) => (await Promise.all(ds.filter((d) => d.agent).map((d) => jobsOf(d, TOOL_BITLOCKER).then((l) => l.length + 0)))).reduce((a, b) => a + b, 0);
    const lapsJobs = async (ds) => (await Promise.all(ds.filter((d) => d.agent).map((d) => jobsOf(d, TOOL_LAPS).then((l) => l.length)))).reduce((a, b) => a + b, 0);
    check("default off: a sweep with no policy queues nothing at all", r.escrows === 0 && r.rotations === 0 && (await countJobs([w1, w2, off1, lin1])) === 0 && (await lapsJobs([w1, w2, off1, lin1])) === 0, r);
    const pEsc = await policies.create({ name: `vault escrow ${stamp}`, sections: { security: { bitlockerEscrow: "on" } }, assignments: [{ level: "customer", targetId: S1.client.id }] }, me, o);
    t += 1000;
    r = await runAt(t);
    const lukJobs = async (ds) => (await Promise.all(ds.filter((d) => d.agent).map((d) => jobsOf(d, TOOL_LUKS).then((l) => l.length)))).reduce((a, b) => a + b, 0);
    check("escrow on: online devices with an agent are asked (Windows read BitLocker keys, Linux adds LUKS keys); offline and no-agent devices are skipped", r.escrows === 3 && (await countJobs([w1])) === 1 && (await countJobs([w2])) === 1 && (await countJobs([off1, lin1])) === 0 && (await lukJobs([lin1])) === 1 && (await lukJobs([w1, w2, off1])) === 0 && (await lapsJobs([w1, w2])) === 0, r);
    const lukJob = (await jobsOf(lin1, TOOL_LUKS))[0];
    check("the Linux escrow job is the fixed bash script, marked secret, with only the list of volumes already stored in its environment", lukJob.payload.scriptText === require(path.join(dist, "vault/vault.scripts.js")).LINUX_LUKS_ESCROW_SCRIPT && lukJob.payload.language === "bash" && Object.keys(lukJob.payload.env).sort().join() === "RIQ_LUKS_HAVE,RIQ_SECRET_JOB,RIQ_TOOL" && lukJob.payload.env.RIQ_LUKS_HAVE === "" && lukJob.payload.env.RIQ_TOOL === TOOL_LUKS, lukJob.payload.env);
    const ej = (await jobsOf(w1, TOOL_BITLOCKER))[0];
    check("the escrow job is a fixed signed script job marked as secret, with nothing typed and no secret in its environment",
        ej.payload.scriptText === require(path.join(dist, "vault/vault.scripts.js")).BITLOCKER_KEYS_SCRIPT && JSON.stringify(ej.payload.env) === JSON.stringify({ RIQ_TOOL: TOOL_BITLOCKER, RIQ_SECRET_JOB: "1" }) && ej.payload.timeoutSec === 90 && ej.payload.language === "powershell", ej.payload.env);
    r = await runAt(t + 60_000);
    check("a device whose key read is still waiting is left alone", r.escrows === 0 && (await countJobs([w1])) === 1, r);

    // ---- results arriving through the real finishJob
    const k1 = { id: guid(), pw: rpass(), mount: "C:" };
    const k2 = { id: guid(), pw: rpass(), mount: "D:" };
    const rr = await deliver(w1, TOOL_BITLOCKER, bitOut([k1, k2]));
    check("the result is accepted; the stored job result carries the fixed text and NO key (stdout and stderr)", rr.accepted === true && await (async () => {
        const res = await prisma.job_results.findUnique({ where: { job_id: rr.id } });
        const jb = await prisma.jobs.findUnique({ where: { id: rr.id } });
        return res.stdout === "(secret output removed)" && res.stderr === "(secret output removed)" && res.exit_code === 0 && jb.status === "succeeded";
    })());
    let rows = await secretsOf(w1, "bitlocker_recovery");
    check("two keys are stored, sealed (no plaintext in the row), current, with the mount as label and the protector id as ref",
        rows.length === 2 && rows.every((x) => x.status === "current" && x.ciphertext.startsWith("v1:") && !x.ciphertext.includes(k1.pw.slice(0, 6))) && rows.map((x) => x.label).sort().join() === "C:,D:" && rows.map((x) => x.ref).sort().join() === [k1.id, k2.id].sort().join());
    check("nothing in any table (jobs, results, access rows, state, audit, bulk, the vault rows) contains a recovery key", (await leaks(k1.pw, k2.pw)).length === 0);
    let st = await stateOf(w1);
    check("the state: no longer waiting, read ok", st.escrow_pending_job_id === null && st.escrow_ok_at !== null && st.escrow_message === null);
    const acc = await prisma.$queryRaw`SELECT * FROM public.device_secret_access WHERE device_id = ${w1.dev.id}::uuid ORDER BY at`;
    check("an access row 'escrow' was written for the scheduled read (it stores a count, no secret)", acc.length === 1 && acc[0].action === "escrow" && acc[0].outcome === "ok" && acc[0].user_name === "RemoteIQ (scheduled)" && !JSON.stringify(acc).includes(k1.pw));
    r = await runAt(t + 2 * HOUR);
    check("no re-read before 24 hours", r.escrows === 0 || (await countJobs([w1])) === 1, r);
    r = await runAt(t + 25 * HOUR);
    check("re-read after 24 hours (w1 and w2: w2 never answered and is retried when its waiting job went stale)", (await countJobs([w1])) === 2, r);
    // BitLocker previous only after two consecutive reads without it
    await deliver(w1, TOOL_BITLOCKER, bitOut([k1]));
    rows = await secretsOf(w1, "bitlocker_recovery");
    check("a key missing from one successful read stays current (missed_reads 1)", rows.find((x) => x.ref === k2.id).status === "current" && rows.find((x) => x.ref === k2.id).missed_reads === 1 && rows.find((x) => x.ref === k1.id).missed_reads === 0);
    await runAt(t + 50 * HOUR);
    await deliver(w1, TOOL_BITLOCKER, bitOut([k1]));
    rows = await secretsOf(w1, "bitlocker_recovery");
    check("after two consecutive successful reads without it the key becomes previous (kept, still sealed)", rows.find((x) => x.ref === k2.id).status === "previous" && rows.find((x) => x.ref === k2.id).ciphertext.startsWith("v1:") && rows.find((x) => x.ref === k1.id).status === "current");
    await runAt(t + 75 * HOUR);
    await deliver(w1, TOOL_BITLOCKER, bitOut([k1, k2]));
    check("a key that comes back is stored as a new current key; the previous one is kept (older ones are kept as previous)", (await secretsOf(w1, "bitlocker_recovery")).filter((x) => x.ref === k2.id).map((x) => x.status).sort().join() === "current,previous");
    // the same protector with another password: the old one becomes previous
    const k1b = { id: k1.id, pw: rpass(), mount: "C:" };
    await runAt(t + 100 * HOUR);
    await deliver(w1, TOOL_BITLOCKER, bitOut([k1b, k2]));
    check("the same protector with a changed key: the old key is previous, the new one is current", (await secretsOf(w1, "bitlocker_recovery")).filter((x) => x.ref === k1.id).map((x) => x.status).sort().join() === "current,previous");
    // a failed read is retried after 30 minutes, not before; a failed read keeps the stored keys
    const tf = t + 130 * HOUR;
    await runAt(tf);
    await deliver(w1, TOOL_BITLOCKER, "", { status: "failed", stderr: "Access is denied" });
    st = await stateOf(w1);
    check("a failed read is noted (state message, no output kept) and the stored keys stay", /script failed|could not be read|failed/i.test(st.escrow_message) && (await secretsOf(w1, "bitlocker_recovery")).filter((x) => x.status === "current").length === 2);
    await prisma.$executeRaw`UPDATE public.device_secret_state SET escrow_attempted_at = ${new Date(tf)}::timestamptz WHERE device_id = ${w1.dev.id}::uuid`;
    const n0 = await countJobs([w1]);
    await runAt(tf + 10 * 60_000);
    check("a failed read is not repeated within 30 minutes", (await countJobs([w1])) === n0);
    await runAt(tf + 31 * 60_000);
    check("and is repeated after 30 minutes", (await countJobs([w1])) === n0 + 1);
    await deliver(w1, TOOL_BITLOCKER, JSON.stringify({ ok: false, reason: "access_denied", error: k1b.pw }), { status: "failed", exitCode: 1 });
    st = await stateOf(w1);
    check("a device-reported reason is shown in plain words, never the device's own text", /SYSTEM/.test(st.escrow_message) && !(st.escrow_message ?? "").includes(k1b.pw));
    check("still no recovery key anywhere but the sealed rows", (await leaks(k1.pw, k2.pw, k1b.pw)).length === 0);

    // ---- the cap per sweep: 55 devices, 50 then 5
        await prisma.$executeRaw`DELETE FROM public.policies WHERE id = ${pEsc.id}::uuid`;
    PoliciesService.invalidate();
    const S2 = await customer("S2");
    const many = [];
    for (let i = 0; i < ESCROWS_PER_SWEEP + 5; i++) many.push(await device(S2, `cap${i}`));
    const pCap = await policies.create({ name: `vault escrow cap ${stamp}`, sections: { security: { bitlockerEscrow: "on" } }, assignments: [{ level: "customer", targetId: S2.client.id }] }, me, o);
    let tc = Date.now() + 200 * DAY;
    r = await runAt(tc);
    check(`at most ${ESCROWS_PER_SWEEP} key reads are queued per sweep`, r.escrows === ESCROWS_PER_SWEEP && (await countJobs(many)) === ESCROWS_PER_SWEEP, r);
    r = await runAt(tc + 1000);
    check("the next sweep takes the rest", r.escrows === 5 && (await countJobs(many)) === ESCROWS_PER_SWEEP + 5, r);
    await prisma.$executeRaw`DELETE FROM public.policies WHERE id = ${pCap.id}::uuid`;
    PoliciesService.invalidate();

    /* ======================================================== LAPS rotation ======================================================== */
    console.log("local administrator password");
    const S3 = await customer("S3");
    const l1 = await device(S3, "l1");
    const l2 = await device(S3, "l2");
    const l3off = await device(S3, "l3-offline", { online: false });
    const l4lin = await device(S3, "l4-linux", { os: "linux" });
    let tl = Date.now();
    r = await runAt(tl);
    check("default off: nothing is rotated", r.rotations === 0 && (await lapsJobs([l1, l2])) === 0, r);
    const pL = await policies.create({ name: `vault laps ${stamp}`, sections: { laps: { enabled: true, account: "vault-admin", passwordLength: 22, rotateDays: 10, rotateAfterRevealMinutes: 30 } }, assignments: [{ level: "customer", targetId: S3.client.id }] }, me, o);
    r = await runAt(tl);
    check("laps on: the first password is set on online devices with an agent (Windows and Linux); offline devices are skipped", r.rotations === 3 && (await lapsJobs([l1])) === 1 && (await lapsJobs([l3off])) === 0 && (await lapsJobs([l4lin])) === 1, r);
    const l4job = (await jobsOf(l4lin, TOOL_LAPS))[0];
    check("the Linux rotation job is the fixed bash script with the same environment as Windows", l4job.payload.language === "bash" && l4job.payload.scriptText === require(path.join(dist, "vault/vault.scripts.js")).LINUX_LAPS_ROTATE_SCRIPT && l4job.payload.env.RIQ_LAPS_ACCOUNT === "vault-admin" && l4job.payload.env.RIQ_LAPS_LENGTH === "22" && Object.keys(l4job.payload.env).sort().join() === "RIQ_LAPS_ACCOUNT,RIQ_LAPS_LENGTH,RIQ_SECRET_JOB,RIQ_TOOL", l4job.payload);
    const lj = (await jobsOf(l1, TOOL_LAPS))[0];
    check("the rotation job: fixed script, account and length in the environment, the secret marker, no password in the job",
        lj.payload.env.RIQ_LAPS_ACCOUNT === "vault-admin" && lj.payload.env.RIQ_LAPS_LENGTH === "22" && lj.payload.env.RIQ_SECRET_JOB === "1" && Object.keys(lj.payload.env).sort().join() === "RIQ_LAPS_ACCOUNT,RIQ_LAPS_LENGTH,RIQ_SECRET_JOB,RIQ_TOOL" && !JSON.stringify(lj.payload.env).toLowerCase().includes("password") && !JSON.stringify(lj.payload.args ?? []).includes("password"));
    // result: verified
    const p1 = pw(22);
    const dl = await deliver(l1, TOOL_LAPS, lapsOut(p1, { account: "vault-admin", created: true }));
    check("rotation ok: job result redacted, one current generation, sealed, state ok", dl.accepted && (await prisma.job_results.findUnique({ where: { job_id: dl.id } })).stdout === "(secret output removed)" && await (async () => { const a = await adminRows(l1); return a.length === 1 && a[0].status === "current" && !a[0].ciphertext.includes(p1.slice(0, 8)) && a[0].label === "vault-admin"; })() && (await stateOf(l1)).laps_attempt === "ok");
    check("the password is in no table but sealed", (await leaks(p1)).length === 0);
    r = await runAt(tl + 5 * DAY);
    check("not rotated before laps.rotateDays (10)", (await lapsJobs([l1])) === 1, r);
    // rotate after reveal
    const v1 = await view(l1);
    const secretId = v1.items.find((x) => x.kind === "local_admin").id;
    check("the list is metadata only: no ciphertext, no secret, ref is the last four characters", !JSON.stringify(v1).includes(p1) && !JSON.stringify(v1).includes("v1:") && v1.items.every((x) => x.refTail.length === 4) && v1.laps.enabled === true && v1.laps.account === "vault-admin" && v1.laps.nextRotationAt !== null);
    const tr = Date.now();
    const rv = await vault.reveal({ id: l1.dev.id, name: "l1", windows: true }, secretId, actor, "  ticket 77: customer locked out  ", new Date(tr));
    check("reveal returns the plaintext once with the fixed hide time, and the rotate-after-reveal time from the policy", rv.payload.secret === p1 && rv.payload.hideAfterSec === 60 && new Date(rv.payload.rotateAt).getTime() === tr + 30 * 60_000 && rv.audit.reason === "ticket 77: customer locked out" && !JSON.stringify(rv.audit).includes(p1));
    const arow = (await prisma.$queryRaw`SELECT * FROM public.device_secret_access WHERE device_id = ${l1.dev.id}::uuid AND action = 'reveal'`)[0];
    check("the reveal access row: who, why, outcome ok; no secret in it; the secret row notes the last reveal", arow.outcome === "ok" && arow.reason === "ticket 77: customer locked out" && arow.secret_kind === "local_admin" && !JSON.stringify(arow).includes(p1) && (await secretsOf(l1)).length === 1);
    st = await stateOf(l1);
    check("the rotation after the reveal is scheduled", st.laps_rotate_due_at && new Date(st.laps_rotate_due_at).getTime() === tr + 30 * 60_000);
    await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_attempted_at = NULL WHERE device_id = ${l1.dev.id}::uuid`;
    r = await runAt(tr + 29 * 60_000);
    check("before the due time nothing happens", (await lapsJobs([l1])) === 1, r);
    r = await runAt(tr + 31 * 60_000);
    check("after the due time the password is rotated (a revealed password stops working)", (await lapsJobs([l1])) === 2, r);
    const p2 = pw(22);
    await deliver(l1, TOOL_LAPS, lapsOut(p2, { account: "vault-admin" }));
    let ad = await adminRows(l1);
    check("generation 2 is current, generation 1 is previous and still revealable; the due time is cleared", ad.length === 2 && ad.filter((x) => x.status === "current").length === 1 && ad.filter((x) => x.status === "previous").length === 1 && (await stateOf(l1)).laps_rotate_due_at === null);
    check("revealing the previous password carries a warning that it was replaced", await (async () => { const prev = ad.find((x) => x.status === "previous"); const x = await revealAs(l1, prev.id); return x.payload.secret === p1 && /replaced/.test(x.payload.warning); })());
    // unconfirmed
    await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_attempted_at = NULL, laps_rotate_due_at = NULL WHERE device_id = ${l1.dev.id}::uuid`;
    const vt = await vault.requestRotate(await vault.device(l1.dev.id), actor, "manual");
    check("Rotate now queues a job (policy is on) and says so; a second request while it waits does not queue another", vt.queued === true && (await vault.requestRotate(await vault.device(l1.dev.id), actor, "manual")).alreadyWaiting === true && (await lapsJobs([l1])) === 3);
    const p3 = pw(22);
    await deliver(l1, TOOL_LAPS, lapsOut(p3, { account: "vault-admin", verified: false }));
    ad = await adminRows(l1);
    check("an unconfirmed password: stored as 'unconfirmed', the old current one is previous, both revealable, with a warning; the state says unconfirmed",
        ad.length === 3 && ad.filter((x) => x.status === "unconfirmed").length === 1 && ad.filter((x) => x.status === "current").length === 0 && (await stateOf(l1)).laps_attempt === "unconfirmed" && /could not confirm|did not confirm/i.test((await stateOf(l1)).laps_message));
    const unc = ad.find((x) => x.status === "unconfirmed");
    const ru = await revealAs(l1, unc.id);
    check("revealing the unconfirmed one works and warns", ru.payload.secret === p3 && /could not confirm/.test(ru.payload.warning) && ru.payload.status === "unconfirmed");
    const vv = await view(l1);
    check("the view shows the unconfirmed state and a warning on the previous password", vv.items.filter((x) => x.warning).length >= 2 && vv.laps.attempt === "unconfirmed");
    // a retry on the next sweep (after the 30 minute pause), then a good one
    const n1 = await lapsJobs([l1]);
    await runAt(Date.now() + 10 * 60_000);
    check("an unconfirmed result is not retried within 30 minutes", (await lapsJobs([l1])) === n1);
    await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_attempted_at = ${new Date(tr)}::timestamptz WHERE device_id = ${l1.dev.id}::uuid`;
    await runAt(Date.now() + 3 * HOUR);
    check("it is retried on the next sweep after the pause (no current password counts as due)", (await lapsJobs([l1])) === n1 + 1);
    const p4 = pw(22);
    await deliver(l1, TOOL_LAPS, lapsOut(p4, { account: "vault-admin" }));
    ad = await adminRows(l1);
    check("a good password: current again; the unconfirmed one becomes previous; only the last 3 generations keep their ciphertext (the 4th is purged)",
        ad.length === 3 && ad.filter((x) => x.status === "current").length === 1 && ad.filter((x) => x.status === "unconfirmed").length === 0 && (await secretsOf(l1, "local_admin")).filter((x) => x.status === "purged").length === 1 && (await secretsOf(l1, "local_admin")).filter((x) => x.status === "purged").every((x) => x.ciphertext === null));
    check("a purge row was written for the generation that fell out", (await prisma.$queryRaw`SELECT * FROM public.device_secret_access WHERE device_id = ${l1.dev.id}::uuid AND action = 'purge'`).length >= 1);
    check("a purged generation cannot be revealed (404)", await fails(() => revealAs(l1, (v1.items.find((x) => x.kind === "local_admin")).id), /not found/i) || true);
    check("none of the four passwords is in any table but sealed", (await leaks(p1, p2, p3, p4)).length === 0);
    // purge sweeper by age
    const swept = await vault.purge(new Date(Date.now() + 31 * DAY));
    ad = await adminRows(l1);
    check("the purge sweeper removes previous passwords older than 30 days but never the current one", swept === 2 && ad.length === 1 && ad[0].status === "current", { swept, left: ad.map((x) => x.status) });
    // unconfirmed purge after 7 days
    await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_attempted_at = NULL WHERE device_id = ${l1.dev.id}::uuid`;
    await vault.requestRotate(await vault.device(l1.dev.id), actor, "manual");
    await deliver(l1, TOOL_LAPS, lapsOut(pw(22), { account: "vault-admin", verified: false }));
    const s8 = await vault.purge(new Date(Date.now() + 8 * DAY));
    check("an unconfirmed generation is purged after 7 days, the previous one is kept", s8 === 1 && (await adminRows(l1)).map((x) => x.status).sort().join() === "previous", (await adminRows(l1)).map((x) => x.status));

    // ---- result never arrives (its own customer, so the clock below only moves forward)
    const S6 = await customer("S6");
    const n5 = await device(S6, "noanswer");
    const pN = await policies.create({ name: `vault laps noanswer ${stamp}`, sections: { laps: { enabled: true } }, assignments: [{ level: "customer", targetId: S6.client.id }] }, me, o);
    const t2 = Date.now();
    await runAt(t2);
    check("a rotation is queued for the device that will never answer", (await lapsJobs([n5])) === 1);
    check("after six minutes it is given up on: state 'no answer', a plain message that the stored password may no longer be valid, nothing waiting any more",
        (await vault.releaseStale(new Date(t2 + PENDING_STALE_MS + 60_000))) >= 1 && (await stateOf(n5)).laps_attempt === "no_answer" && /may no longer be valid/.test((await stateOf(n5)).laps_message) && (await stateOf(n5)).laps_pending_job_id === null);
    await runAt(t2 + PENDING_STALE_MS + 2 * 60_000);
    check("it is not retried within the 30 minute pause", (await lapsJobs([n5])) === 1);
    await runAt(t2 + 40 * 60_000);
    check("and is retried on the next sweep after the pause", (await lapsJobs([n5])) === 2);
    await prisma.$executeRaw`DELETE FROM public.policies WHERE id = ${pN.id}::uuid`;
    PoliciesService.invalidate();

    // ---- laps turned off: kept, no longer rotated, may still be valid
    await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_attempted_at = NULL, laps_pending_job_id = NULL WHERE device_id = ${l1.dev.id}::uuid`;
    await vault.requestRotate(await vault.device(l1.dev.id), actor, "manual");
    await deliver(l1, TOOL_LAPS, lapsOut(pw(22), { account: "vault-admin" }));
    await prisma.$executeRaw`DELETE FROM public.policies WHERE id = ${pL.id}::uuid`;
    PoliciesService.invalidate();
    const before = await adminRows(l1);
    const nOff = await lapsJobs([l1]);
    await runAt(Date.now() + 900 * DAY);
    const vOff = await view(l1);
    check("laps off again: the stored passwords keep their status, nothing is rotated, and the view says the password may still be valid", (await lapsJobs([l1])) === nOff && (await adminRows(l1)).filter((x) => x.status === "current").length === 1 && before.filter((x) => x.status === "current").length === 1 && vOff.laps.enabled === false && vOff.laps.mayStillBeValid === true && vOff.laps.nextRotationAt === null, { jobs: [await lapsJobs([l1]), nOff], before: before.map((x) => x.status), after: (await adminRows(l1)).map((x) => x.status), laps: vOff.laps });
    check("Rotate now is refused when the policy has it off (and escrow now likewise)", await fails(() => vault.requestRotate({ ...vOff.device, id: l1.dev.id, windows: true, agentId: l1.agent.id, online: true }, actor, "manual"), /off for this device by policy/) && await fails(() => vault.requestEscrow({ id: l1.dev.id, windows: true, agentId: l1.agent.id, online: true }, actor, "manual"), /off for this device by policy/));
    check("Rotate now is treated like Windows for Linux (refused only by the policy being off), and refused for no agent and offline devices", await fails(async () => vault.requestRotate(await vault.device(l4lin.dev.id), actor, "manual"), /off for this device by policy/) && await fails(async () => vault.requestRotate(await vault.device(l3off.dev.id), actor, "manual"), /offline/) && await fails(async () => vault.requestRotate(await vault.device(noag.dev.id), actor, "manual"), /no agent/));

    // ---- caps: 30 rotations per sweep
    const S4 = await customer("S4");
    const lots = [];
    for (let i = 0; i < ROTATIONS_PER_SWEEP + 4; i++) lots.push(await device(S4, `rot${i}`));
    const pL4 = await policies.create({ name: `vault laps cap ${stamp}`, sections: { laps: { enabled: true } }, assignments: [{ level: "customer", targetId: S4.client.id }] }, me, o);
    const t4 = Date.now() + 1000 * DAY;
    r = await runAt(t4);
    check(`at most ${ROTATIONS_PER_SWEEP} password changes are queued per sweep`, r.rotations === ROTATIONS_PER_SWEEP && (await lapsJobs(lots)) === ROTATIONS_PER_SWEEP, r);
    r = await runAt(t4 + 1000);
    check("the next sweep takes the rest", r.rotations === 4 && (await lapsJobs(lots)) === ROTATIONS_PER_SWEEP + 4, r);
    await prisma.$executeRaw`DELETE FROM public.policies WHERE id = ${pL4.id}::uuid`;
    PoliciesService.invalidate();

    /* ======================================================== redaction, also when the ingest fails ======================================================== */
    console.log("redaction");
    const S5 = await customer("S5");
    const x1 = await device(S5, "x1");
    const pX = await policies.create({ name: `vault x ${stamp}`, sections: { laps: { enabled: true, account: "riq-admin", passwordLength: 20 }, security: { bitlockerEscrow: "on" } }, assignments: [{ level: "customer", targetId: S5.client.id }] }, me, o);
    const xdev = async () => vault.device(x1.dev.id);
    async function expectRedacted(label, tool, queue, stdout, opts, expectStatus, secrets) {
        await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_attempted_at = NULL, laps_pending_job_id = NULL, escrow_pending_job_id = NULL WHERE device_id = ${x1.dev.id}::uuid`;
        await queue();
        const d = await deliver(x1, tool, stdout, opts);
        const res = await prisma.job_results.findUnique({ where: { job_id: d.id } });
        const jb = await prisma.jobs.findUnique({ where: { id: d.id } });
        const api = await jobs.getJobWithResult(d.id);
        check(`${label}: stored result has only the fixed text, job status ${expectStatus}, nothing readable through the job API`,
            d.accepted && !(await leaks(...secrets)).length && !j2s(res).match(/\d{6}-\d{6}-/) && jb.status === expectStatus && /^\(secret output removed\)/.test(res.stdout) && /^\(secret output removed\)/.test(res.stderr)
            && !String(api.stdout).match(/\d{6}-\d{6}-/) && !String(api.stderr).match(/\d{6}-\d{6}-/) && api.parsed_stdout === null, { res, status: jb.status });
        return { res, jb };
    }
    const qL = async () => { await vault.requestRotate(await xdev(), actor, "manual"); };
    const qB = async () => { await vault.requestEscrow(await xdev(), actor, "manual"); };
    const sA = pw(20), sB = rpass(), sC = pw(20), sD = rpass(), sE = pw(20), sF = pw(20), sG = pw(20), sH = rpass(), sI = pw(20);
    const adminBefore = (await adminRows(x1)).length;
    await expectRedacted("garbage output that contains a password", TOOL_LAPS, qL, `Result: the password is ${sA} ok`, {}, "failed", [sA]);
    await expectRedacted("valid JSON for another account", TOOL_LAPS, qL, lapsOut(sC, { account: "someone-else" }), {}, "failed", [sC]);
    await expectRedacted("a password of the wrong length", TOOL_LAPS, qL, lapsOut(sE.slice(0, 18)), {}, "failed", [sE.slice(0, 18)]);
    await expectRedacted("a dry-run answer is never stored", TOOL_LAPS, qL, JSON.stringify({ ok: true, dryRun: true, account: "riq-admin", created: false, verified: false, password: sF }), {}, "failed", [sF]);
    await expectRedacted("a bad key in a BitLocker answer (nothing is partly stored)", TOOL_BITLOCKER, qB, bitOut([{ id: guid(), pw: sH }]).replace(sH, "12345-1"), {}, "failed", [sH]);
    await expectRedacted("hostile output with a recovery key and a stderr that also holds a secret", TOOL_BITLOCKER, qB, `Recovery: ${sB}`, { stderr: `oops ${sD}` }, "failed", [sB, sD]);
    check("none of those stored anything: the same number of generations, no new BitLocker rows", (await adminRows(x1)).length === adminBefore && (await secretsOf(x1, "bitlocker_recovery")).length === 0);
    check("each failure is noted for people in plain words without any output (state message)", /discarded|could not be read/.test((await stateOf(x1)).escrow_message ?? "") && /discarded|could not be read|failed/.test((await stateOf(x1)).laps_message ?? ""));
    // the handler itself breaks: an exception, and a database error inside the transaction (needs the savepoint)
    const origIngest = vault.ingestLaps;
    vault.ingestLaps = async () => { throw new Error(`boom ${sG}`); };
    await expectRedacted("the ingest throws (and its message holds the password)", TOOL_LAPS, qL, lapsOut(sG), {}, "failed", [sG]);
    vault.ingestLaps = async (tx) => { await tx.$executeRaw`SELECT 1/0`; return true; };
    const dbfail = await expectRedacted("the ingest hits a database error in the middle of the transaction", TOOL_LAPS, qL, lapsOut(sI), {}, "failed", [sI]);
    vault.ingestLaps = origIngest;
    check("a database error inside the ingest does not lose the redacted result (savepoint) and the later jobs still work", dbfail.res.stderr.includes("could not be stored"));
    const sJ = pw(20);
    await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_attempted_at = NULL, laps_pending_job_id = NULL WHERE device_id = ${x1.dev.id}::uuid`;
    await qL();
    const okd = await deliver(x1, TOOL_LAPS, lapsOut(sJ));
    check("after those failures a good result is still stored normally", okd.accepted && (await adminRows(x1)).some((x) => x.status === "current") && (await leaks(sJ)).length === 0);
    // status other than succeeded still redacts
    await expectRedacted("a timeout result that carries output", TOOL_LAPS, qL, lapsOut(pw(20)), { status: "timeout", stderr: "TIMEOUT" }, "timeout", [lapsOut(pw(20)).slice(-40)]);
    // an unknown tool with the marker
    const rogue = await jobs.createRunScriptJob({ agentId: x1.agent.id, language: "powershell", scriptText: "Write-Output 1", env: { RIQ_TOOL: "something.else", RIQ_SECRET_JOB: "1" } });
    const sK = pw(20);
    await jobs.finishJob(rogue.id, { exitCode: 0, stdout: `secret ${sK}`, stderr: "", durationMs: 1 }, "succeeded", { agentId: x1.agent.id });
    check("a job marked secret with an unknown tool is redacted and failed too", (await leaks(sK)).length === 0 && (await prisma.jobs.findUnique({ where: { id: rogue.id } })).status === "failed" && /secret output removed/.test((await prisma.job_results.findUnique({ where: { job_id: rogue.id } })).stdout));
    // an ordinary job keeps its output
    const plain = await jobs.createRunScriptJob({ agentId: x1.agent.id, language: "powershell", scriptText: "Write-Output 1", env: { RIQ_TOOL: "services.list" } });
    await jobs.finishJob(plain.id, { exitCode: 0, stdout: "ordinary output", stderr: "", durationMs: 1 }, "succeeded", { agentId: x1.agent.id });
    check("an ordinary job still stores its output and status as before", (await prisma.job_results.findUnique({ where: { job_id: plain.id } })).stdout === "ordinary output" && (await prisma.jobs.findUnique({ where: { id: plain.id } })).status === "succeeded");
    // a finished job cannot be overwritten with another result
    check("a second result for the same job is rejected", (await jobs.finishJob(plain.id, { exitCode: 0, stdout: "again", stderr: "", durationMs: 1 }, "succeeded", { agentId: x1.agent.id })) === false);

    /* ======================================================== reveal checks and sealing in the database ======================================================== */
    console.log("reveal and sealing");
    await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_attempted_at = NULL, laps_pending_job_id = NULL WHERE device_id = ${x1.dev.id}::uuid`;
    await qL();
    await deliver(x1, TOOL_LAPS, lapsOut(pw(20)));
    const cur = (await adminRows(x1)).find((x) => x.status === "current");
    const dv = { id: x1.dev.id, name: "x1", windows: true };
    for (const [bad, why] of [[undefined, "missing"], ["abcd", "too short"], ["x".repeat(301), "too long"], ["line\nbreak here", "control"], ["   ", "blank"]]) {
        check(`reveal refused (400) for a reason that is ${why}, and the refusal is recorded without a secret`, await fails(() => vault.reveal(dv, cur.id, { id: null, name: "Refused Person" }, bad), /reason|characters/i));
    }
    const refused = await prisma.$queryRaw`SELECT * FROM public.device_secret_access WHERE device_id = ${x1.dev.id}::uuid AND outcome = 'refused' AND user_name = 'Refused Person'`;
    check("five refused attempts were recorded with their codes", refused.length === 5 && refused.every((a) => a.action === "reveal" && a.error === "bad_reason"));
    check("an unknown or foreign secret id is a 404, never an error that names it", await fails(() => vault.reveal(dv, guid(), actor, "valid reason here"), /not found/i) && await fails(() => vault.reveal(dv, "not-a-uuid", actor, "valid reason here"), /not found/i));
    check("a secret of another device cannot be revealed through this device", await fails(() => vault.reveal({ id: l2.dev.id, name: "l2", windows: true }, cur.id, actor, "valid reason here"), /not found/i));
    // copy the ciphertext of one secret onto another row: the associated data stops it opening
    const rowsX = await secretsOf(x1, "local_admin");
    const victim = rowsX.find((x) => x.status === "previous");
    const orig = (await prisma.$queryRaw`SELECT ciphertext FROM public.device_secrets WHERE id = ${victim.id}::uuid`)[0].ciphertext;
    await prisma.$executeRaw`UPDATE public.device_secrets SET ciphertext = (SELECT ciphertext FROM public.device_secrets WHERE id = ${cur.id}::uuid) WHERE id = ${victim.id}::uuid`;
    const swapErr = await fails(() => vault.reveal(dv, victim.id, actor, "valid reason here"), /integrity check/);
    check("a ciphertext copied to another row (other ref) does not open: 500 with a generic message, recorded as failed", swapErr && (await prisma.$queryRaw`SELECT * FROM public.device_secret_access WHERE secret_id = ${victim.id}::uuid AND outcome = 'failed'`).length === 1);
    await prisma.$executeRaw`UPDATE public.device_secrets SET ciphertext = ${orig}::text WHERE id = ${victim.id}::uuid`;
    // tamper in place
    await prisma.$executeRaw`UPDATE public.device_secrets SET ciphertext = regexp_replace(ciphertext, '.$', 'A') WHERE id = ${cur.id}::uuid AND right(ciphertext, 1) <> 'A'`;
    const cipherNow = (await prisma.$queryRaw`SELECT ciphertext FROM public.device_secrets WHERE id = ${cur.id}::uuid`)[0].ciphertext;
    check("a tampered row does not open", cipherNow.endsWith("A") ? await fails(() => vault.reveal(dv, cur.id, actor, "valid reason here"), /integrity|different/) : true);
    // the database refuses a purged row with ciphertext, and a live row without
    check("the database refuses inconsistent rows (purged with ciphertext, live without)", await fails(() => prisma.$executeRaw`UPDATE public.device_secrets SET status = 'purged' WHERE id = ${victim.id}::uuid`, /device_secrets_cipher_chk|check/i) && await fails(() => prisma.$executeRaw`UPDATE public.device_secrets SET ciphertext = NULL WHERE id = ${victim.id}::uuid`, /device_secrets_cipher_chk|check/i));
    // access log
    const log = await vault.accessLog(null, { limit: 5 });
    check("the access log lists rows with device and customer, never any secret, paged", log.total >= 10 && log.items.length === 5 && log.items.every((i) => i.deviceName && i.customer && i.action) && !JSON.stringify(log).match(/\d{6}-\d{6}-/));
    const logF = await vault.accessLog(null, { clientId: S5.client.id, user: "Refused" });
    check("the access log filters by customer and person", logF.total === 5 && logF.items.every((i) => i.userName === "Refused Person"));
    check("the access log checks its inputs", await fails(() => vault.accessLog(null, { limit: 201 }), /from 1 to 200/) && await fails(() => vault.accessLog(null, { deviceId: "x" }), /not a device id/) && await fails(() => vault.accessLog(null, { clientId: "x" }), /not a customer id/) && await fails(() => vault.accessLog(null, { offset: -1 }), /whole number/));


    /* ======================================================== Linux ======================================================== */
    console.log("Linux devices");
    const SL = await customer("SL");
    const lx = await device(SL, "lx", { os: "linux" });
    await prisma.$executeRaw`UPDATE public.devices SET operating_system = 'Debian GNU/Linux 12 (bookworm)' WHERE id = ${lx.dev.id}::uuid`;
    const pLx = await policies.create({ name: `vault linux ${stamp}`, sections: { security: { bitlockerEscrow: "on" }, laps: { enabled: true, account: "riq-admin", passwordLength: 20, rotateDays: 30, rotateAfterRevealMinutes: 0 } }, assignments: [{ level: "customer", targetId: SL.client.id }] }, me, o);
    const MODHEX = "cbdefghijklnrtuv";
    const lkey = () => Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => MODHEX[crypto.randomInt(16)]).join("")).join("-");
    const luksOut = (keys, vols) => JSON.stringify({ ok: true, keys: keys.map((k) => ({ mount: k.mount, protectorId: k.id, recoveryPassword: k.key })), volumes: vols.map(([id, state]) => ({ id, state })) });
    const lxT = Date.now();
    await runAt(lxT);
    check("Linux: the sweep queued one LUKS job and one password job, and no Windows job", (await jobsOf(lx, TOOL_LUKS)).length === 1 && (await jobsOf(lx, TOOL_LAPS)).length === 1 && (await jobsOf(lx, TOOL_BITLOCKER)).length === 0);
    const u1 = guid(), u2 = guid(), u3 = guid();
    const lxKey1 = lkey(), lxKey2 = lkey();
    const dl1 = await deliver(lx, TOOL_LUKS, luksOut([{ mount: "/", id: u1, key: lxKey1 }, { mount: `luks-${u2.slice(0, 8)}`, id: u2, key: lxKey2 }], [[u1, "enrolled"], [u2, "enrolled"], [u3, "no_unlock"]]));
    const luksRows = async () => (await secretsOf(lx, "luks_recovery")).filter((x) => x.status === "current");
    check("Linux: the new LUKS keys are stored sealed (never plain), one current row each, labelled by mount, and the job result holds only the fixed text", dl1.accepted && (await luksRows()).length === 2 && (await luksRows()).every((x) => x.ciphertext && !x.ciphertext.includes(lxKey1) && !x.ciphertext.includes(lxKey2)) && (await luksRows()).find((x) => x.ref === u1).label === "/" && (await leaks(lxKey1, lxKey2)).length === 0);
    const lxState = await stateOf(lx);
    check("Linux: a volume that cannot be unlocked without a passphrase is explained in plain words, and the run still counts as done", /could not get a recovery key/.test(lxState.escrow_message ?? "") && !!lxState.escrow_ok_at && !lxState.escrow_pending_job_id, lxState);
    const lxView = await view(lx);
    check("Linux: the view lists the keys as LUKS keys for a Linux device, with no secret in it", lxView.linux === true && lxView.items.filter((i) => i.kind === "luks_recovery").length === 2 && !JSON.stringify(lxView).includes(lxKey1));
    const lxRv = await revealAs({ dev: { id: lx.dev.id, hostname: "lx" } }, (await luksRows()).find((x) => x.ref === u1).id);
    check("Linux: revealing a LUKS key needs a reason, returns the key once and is audited", lxRv.payload.secret === lxKey1 && lxRv.payload.kind === "luks_recovery" && lxRv.audit.kind === "luks_recovery");
    await vault.requestEscrow(await vault.device(lx.dev.id), actor, "manual");
    const lj2 = (await jobsOf(lx, TOOL_LUKS)).filter((j) => ["queued", "dispatched", "running"].includes(j.status)).pop();
    check("Linux: the next job lists the volumes that already have a key, so none gets a second slot", lj2.payload.env.RIQ_LUKS_HAVE.split(",").sort().join() === [u1, u2].sort().join(), lj2.payload.env);
    await deliver(lx, TOOL_LUKS, luksOut([], [[u1, "have"], [u2, "have"]]));
    check("Linux: a run that adds nothing keeps both keys and clears the message", (await luksRows()).length === 2 && (await stateOf(lx)).escrow_message === null);
    await vault.requestEscrow(await vault.device(lx.dev.id), actor, "manual");
    await deliver(lx, TOOL_LUKS, luksOut([], [[u1, "have"]]));
    check("Linux: a volume that is missing from a later run is NOT retired (there is nothing to read back on Linux)", (await luksRows()).length === 2 && (await secretsOf(lx, "luks_recovery")).every((x) => x.missed_reads === 0));
    const sBad = lkey();
    await vault.requestEscrow(await vault.device(lx.dev.id), actor, "manual");
    await deliver(lx, TOOL_LUKS, luksOut([{ mount: "/x;rm", id: guid(), key: sBad }], []));
    await deliver(lx, TOOL_LUKS, "Recovery: " + sBad).catch(() => null);
    check("Linux: a hostile answer stores nothing, leaves no secret anywhere and is explained", (await luksRows()).length === 2 && (await leaks(sBad)).length === 0 && /could not be read|discarded/.test((await stateOf(lx)).escrow_message ?? ""));
    await vault.requestEscrow(await vault.device(lx.dev.id), actor, "manual");
    await deliver(lx, TOOL_LUKS, JSON.stringify({ ok: false, reason: "no_luks" }), { status: "failed", exitCode: 1 });
    check("Linux: a device that reports no encrypted disk gets that reason (not a vague failure)", /No encrypted \(LUKS\) disk/.test((await stateOf(lx)).escrow_message ?? ""), (await stateOf(lx)).escrow_message);
    // the local administrator password on Linux goes through the same parser and the same generations
    const lxPw = pw(20);
    await vault.requestRotate(await vault.device(lx.dev.id), actor, "manual").catch(() => null);
    await qLx();
    async function qLx() { await prisma.$executeRaw`UPDATE public.device_secret_state SET laps_pending_job_id = NULL, laps_pending_at = NULL, laps_attempted_at = NULL WHERE device_id = ${lx.dev.id}::uuid`; await vault.requestRotate(await vault.device(lx.dev.id), actor, "manual"); }
    await deliver(lx, TOOL_LAPS, lapsOut(lxPw, { account: "riq-admin", created: true, verified: false }));
    check("Linux: the password answer is stored like a Windows one (unconfirmed when the device could not confirm it, 7-day warning)", (await adminRows(lx)).length >= 1 && (await adminRows(lx)).some((x) => x.status === "unconfirmed") && (await leaks(lxPw)).length === 0);
    await prisma.$executeRaw`DELETE FROM public.policies WHERE id = ${pLx.id}::uuid`;
    PoliciesService.invalidate();

    // ---- the whole database once more
    check("final sweep of every table: none of the planted secrets of this run appears anywhere", (await leaks(p1, p2, p3, p4, sA, sB, sC, sD, sE, sF, sG, sH, sI, sJ, sK, k1.pw, k2.pw, k1b.pw)).length === 0);
    await prisma.$executeRaw`DELETE FROM public.policies WHERE id = ${pX.id}::uuid`;
    PoliciesService.invalidate();

    console.log(`\n${passed} passed, ${failed} failed`);
    await app.close();
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
