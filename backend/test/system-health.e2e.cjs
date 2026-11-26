// Health of the ADG RMM servers and the monthly restore test, in process against a throwaway database (name has "e2e").
"use strict";
const path = require("node:path");
if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.PUBLIC_CONSOLE_URL ||= "http://127.0.0.1:9"; process.env.IMAP_POLL_ENABLED = "false"; process.env.NODE_ENV = "development";
let passed = 0, failed = 0;
const check = (name, ok, extra) => { ok ? passed++ : failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const H = require(path.join(dist, "system-health/system-health.core.js"));
    const now = new Date("2026-12-01T12:00:00Z");
    const ago = (h) => new Date(+now - h * 3600_000);

    // --- the rules ---
    check("database: fast ok, slow warn, very slow or down critical", H.databaseCheck(20).status === "ok" && H.databaseCheck(900).status === "warn" && H.databaseCheck(3000).status === "critical" && H.databaseCheck(null, "boom").status === "critical");
    check("disk: plenty ok, under 15% warn, under 5% or 1 GB critical", H.diskCheck(50e9, 100e9, "/").status === "ok" && H.diskCheck(10e9, 100e9, "/").status === "warn" && H.diskCheck(4e9, 100e9, "/").status === "critical" && H.diskCheck(0.5e9, 1000e9, "/").status === "critical" && H.diskCheck(null, null, "/").status === "warn");
    check("memory: thresholds", H.memoryCheck(50, 100).status === "ok" && H.memoryCheck(8, 100).status === "warn" && H.memoryCheck(2, 100).status === "critical");
    check("queue: only a very large backlog warns", H.queueCheck(3).status === "ok" && H.queueCheck(500).status === "warn");
    check("backup: fresh ok, over 36 h warn, over 72 h or none critical", H.backupCheck(ago(5), now, null).status === "ok" && H.backupCheck(ago(40), now, null).status === "warn" && H.backupCheck(ago(100), now, null).status === "critical" && H.backupCheck(null, now, null).status === "critical");
    const f = (o) => ({ testableBackup: true, lastGoodAt: null, lastFailedAt: null, lastError: null, running: false, ...o });
    check("restore check: recent success ok, 40 days old warn, never warn, failed after success critical (with the reason)", H.restoreCheck(f({ lastGoodAt: ago(24 * 5) }), now).status === "ok" && H.restoreCheck(f({ lastGoodAt: ago(24 * 40) }), now).status === "warn" && H.restoreCheck(f({}), now).status === "warn" && H.restoreCheck(f({ lastGoodAt: ago(500), lastFailedAt: ago(2), lastError: "pg_restore: out of space" }), now).detail.includes("out of space") && H.restoreCheck(f({ lastGoodAt: ago(500), lastFailedAt: ago(2) }), now).status === "critical");
    check("restore check: a failure older than the last success does not count", H.restoreCheck(f({ lastGoodAt: ago(2), lastFailedAt: ago(500) }), now).status === "ok");
    check("restore schedule: never tested starts; under 30 days waits; over 30 days starts; running waits; no backup waits", H.shouldStartRestore(f({}), now) && !H.shouldStartRestore(f({ lastGoodAt: ago(24 * 10) }), now) && H.shouldStartRestore(f({ lastGoodAt: ago(24 * 31) }), now) && !H.shouldStartRestore(f({ running: true }), now) && !H.shouldStartRestore(f({ testableBackup: false }), now));
    check("restore schedule: after a failure it retries only after 24 hours", !H.shouldStartRestore(f({ lastGoodAt: ago(24 * 40), lastFailedAt: ago(3) }), now) && H.shouldStartRestore(f({ lastGoodAt: ago(24 * 40), lastFailedAt: ago(30) }), now));
    check("messages: first fine reading is silent, a change speaks once, recovery speaks", H.changeMessage({ key: "x", title: "X", status: "ok", detail: "" }, null) === null && H.changeMessage({ key: "x", title: "X", status: "critical", detail: "d" }, "ok").subject.includes("CRITICAL") && H.changeMessage({ key: "x", title: "X", status: "critical", detail: "d" }, "critical") === null && H.changeMessage({ key: "x", title: "X", status: "ok", detail: "" }, "critical").subject.includes("recovered"));

    const MB = 1024 * 1024;
    check("backup size: a backup under half the usual size warns, a tiny one warns, a normal one does not", H.sizeWarning([2 * MB, 5 * MB, 5 * MB, 5.2 * MB]) !== null && H.sizeWarning([4 * MB, 5 * MB, 5 * MB]) === null && /too small/.test(H.sizeWarning([2000])) && H.sizeWarning([5 * MB]) === null && H.sizeWarning([]) === null);
    check("backup size turns a fresh backup's check to warn but leaves a critical one critical", H.backupCheck(ago(5), now, null, [1 * MB, 5 * MB, 5 * MB]).status === "warn" && H.backupCheck(ago(5), now, null, [5 * MB, 5 * MB]).status === "ok" && H.backupCheck(ago(100), now, null, [1 * MB, 5 * MB]).status === "critical");
    check("web checks: answers ok, error critical, down critical, slow warn", H.webCheck("frontend", "Web", "https://x", 200, 50).status === "ok" && H.webCheck("frontend", "Web", "https://x", 502, 50).status === "critical" && H.webCheck("frontend", "Web", "https://x", null, null, "ENOTFOUND").detail.includes("ENOTFOUND") && H.webCheck("frontend", "Web", "https://x", 200, 4000).status === "warn" && H.webCheck("agentport", "Agents", "https://x", 404, 5).status === "warn");
    check("agents: none enrolled is fine, silent after recent contact critical, silent for a day warn, active ok", H.agentsCheck(0, 0, 0).status === "ok" && H.agentsCheck(5, 0, 3).status === "critical" && H.agentsCheck(5, 0, 0).status === "warn" && H.agentsCheck(5, 2, 4).status === "ok");

    // --- against the database ---
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { SystemHealthService } = require(path.join(dist, "system-health/system-health.service.js"));
    const { RestoreWorkerService } = require(path.join(dist, "backups/restore-worker.service.js"));
    const { NotifierService } = require(path.join(dist, "backups/notifier.service.js"));
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const svc = app.get(SystemHealthService, { strict: false });
    const sent = [];
    app.get(NotifierService, { strict: false }).send = async (_c, subject, body) => { sent.push({ subject, body }); };
    // The restore itself is covered by the backups tests; here only the decision to start one is.
    app.get(RestoreWorkerService, { strict: false }).runOneIfAny = async () => { };

    await prisma.$executeRaw`DELETE FROM public.backup_restores`; await prisma.$executeRaw`DELETE FROM public.backup_jobs`;
    let st = await svc.status();
    const keys = st.checks.map((c) => c.key).sort().join(",");
    check("status reads every check", keys === "agents,backup,database,disk,frontend,memory,queue,restore", keys);
    check("a console address that does not answer is critical (PUBLIC_CONSOLE_URL points at a closed port in this test)", st.checks.find((c) => c.key === "frontend").status === "critical");
    check("a database that works reports ok and with no backups at all the backup check is critical", st.checks.find((c) => c.key === "database").status === "ok" && st.checks.find((c) => c.key === "backup").status === "critical" && st.overall === "critical");
    check("the Owner is told about the missing backup once", sent.filter((s) => /Backups/.test(s.subject)).length === 1);
    await svc.status();
    check("and not again on the next reading", sent.filter((s) => /Backups/.test(s.subject)).length === 1);
    check("no restore test is started while there is no verified PostgreSQL backup", (await svc.maybeStartRestore()).started === false && (await prisma.$queryRaw`SELECT 1 FROM public.backup_restores`).length === 0);

    const sum = "a".repeat(64);
    const [job] = await prisma.$queryRaw`INSERT INTO public.backup_jobs (status, verified, backup_kind, checksum, finished_at) VALUES ('completed', true, 'postgresql', ${sum}, now() - interval '2 hours') RETURNING id`;
    await prisma.$queryRaw`INSERT INTO public.backup_jobs (status, verified, backup_kind, checksum, finished_at) VALUES ('completed', true, 'logical', ${sum}, now() - interval '1 hour')`;
    st = await svc.status();
    check("with a fresh backup the backup check recovers (and the Owner is told)", st.checks.find((c) => c.key === "backup").status === "ok" && sent.some((s) => /recovered: Backups/.test(s.subject)));
    const r1 = await svc.maybeStartRestore();
    check("a restore test starts on the verified PostgreSQL backup, not the logical one", r1.started && (await prisma.$queryRaw`SELECT backup_job_id FROM public.backup_restores WHERE id = ${r1.restoreId}::uuid`)[0].backup_job_id === job.id);
    check("while it is queued, no second one starts", (await svc.maybeStartRestore()).started === false);
    check("and the check shows that the first test is running", (await svc.status()).checks.find((c) => c.key === "restore").detail.includes("running"));

    await prisma.$executeRaw`UPDATE public.backup_restores SET status = 'failed', finished_at = now(), error = 'scratch database could not be created' WHERE id = ${r1.restoreId}::uuid`;
    st = await svc.status();
    check("a failed restore test is critical and says why", st.checks.find((c) => c.key === "restore").status === "critical" && st.checks.find((c) => c.key === "restore").detail.includes("scratch database"));
    check("the Owner is told", sent.some((s) => /CRITICAL: Restore test/.test(s.subject)));
    check("it is not retried within 24 hours", (await svc.maybeStartRestore()).started === false);
    await prisma.$executeRaw`UPDATE public.backup_restores SET finished_at = now() - interval '30 hours'`;
    const r2 = await svc.maybeStartRestore();
    check("it is retried after 24 hours", r2.started === true);
    await prisma.$executeRaw`UPDATE public.backup_restores SET status = 'completed', finished_at = now(), error = NULL WHERE id = ${r2.restoreId}::uuid`;
    st = await svc.status();
    check("a successful restore test makes the check ok again", st.checks.find((c) => c.key === "restore").status === "ok" && sent.some((s) => /recovered: Restore test/.test(s.subject)));
    check("and none is due for 30 days", (await svc.maybeStartRestore()).started === false);
    await prisma.$executeRaw`UPDATE public.backup_restores SET finished_at = now() - interval '31 days'`;
    check("after 30 days the next one starts by itself", (await svc.maybeStartRestore()).started === true);
    await prisma.$executeRaw`UPDATE public.backup_restores SET status = 'completed', finished_at = now() - interval '31 days'`;
    check("force starts one on request", (await svc.maybeStartRestore(new Date(), true)).started === true);
    st = await svc.status();
    check("the history records each change of state", st.events.length >= 4 && st.events.some((e) => e.check === "restore" && e.to === "critical"), st.events.length);
    // --- how remote sessions reached the computers ---
    const { RemoteConsoleService } = require(path.join(dist, "remote-console/remote-console.service.js"));
    const rcs = app.get(RemoteConsoleService, { strict: false });
    await prisma.$executeRaw`DELETE FROM public.remote_session_transport`;
    await rcs.noteTransport("sess-direct-1", null, false, 50 * 1024 * 1024);
    await rcs.noteTransport("sess-relay-1", null, true, 2 * 1024 ** 3);
    await rcs.noteTransport("sess-relay-1", null, false, 3 * 1024 ** 3);
    check("a session that was seen on the relay stays a relay session, and the data only grows", (await prisma.$queryRaw`SELECT relay, bytes_received::float8 AS b FROM public.remote_session_transport WHERE session_id = 'sess-relay-1'`)[0].relay === true && (await prisma.$queryRaw`SELECT bytes_received::float8 AS b FROM public.remote_session_transport WHERE session_id = 'sess-relay-1'`)[0].b === 3 * 1024 ** 3);
    check("a bad session id or an absurd size is refused or clamped", (await rcs.noteTransport("x", null, true, 5)).ok === false && (await rcs.noteTransport("sess-big-1", null, true, 1e18)).ok === true && (await prisma.$queryRaw`SELECT bytes_received::float8 AS b FROM public.remote_session_transport WHERE session_id = 'sess-big-1'`)[0].b === 5e12);
    const tr = await rcs.transportReport(30);
    check("the relay report counts sessions, the share through the relay and the data", tr.sessions === 3 && tr.relayedSessions === 2 && tr.relayedPercent === 67 && tr.relayGigabytes > 3 && tr.freeAllowanceGigabytes === 1000);
    check("the health view carries the same numbers", (await svc.status()).remoteSessions.sessions === 3);

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
