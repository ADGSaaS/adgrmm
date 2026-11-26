// Service desk performance (per technician and team) in process against a throwaway database (name has "e2e").
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false"; process.env.NODE_ENV = "development";
let passed = 0, failed = 0;
const check = (name, ok, extra) => { ok ? passed++ : failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const P = require(path.join(dist, "service-desk/performance.service.js"));
    check("percent: nothing counted is not 0%", P.present({ responseMet: 0, responseMissed: 0, resolutionMet: 3, resolutionMissed: 1 }).responseMetPercent === null && P.present({ responseMet: 0, responseMissed: 0, resolutionMet: 3, resolutionMissed: 1 }).resolutionMetPercent === 75);

    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { PerformanceService } = P;
    const { TicketsService } = require(path.join(dist, "tickets/tickets.service.js"));
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const perf = app.get(PerformanceService, { strict: false });
    const tickets = app.get(TicketsService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const mkUser = async (n) => { const id = crypto.randomUUID(); await prisma.$executeRaw`INSERT INTO public.users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES (${id}::uuid, ${org.id}::uuid, ${`perf-${n}-${stamp}@example.test`}, ${n}, 'Tech', 'active', 'x')`; return { id }; };
    const ann = await mkUser("Ann"), bob = await mkUser("Bob");
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Perf ${stamp}` } });
    const other = await prisma.clients.create({ data: { organization_id: org.id, name: `Perf other ${stamp}` } });
    const req = { user: { organizationId: org.id, name: "Test" } };
    const mk = async (assignee, status, clientId, sla) => {
        const id = await tickets.create({ subject: `PERF ${stamp} ${Math.random()}`, description: "x", priority: "high" }, req, { source: "api" });
        await prisma.$executeRaw`UPDATE public.tickets SET assignee_user_id = ${assignee}::uuid, status = ${status}::ticket_status, client_id = ${clientId}::uuid WHERE id = ${id}::uuid`;
        await prisma.$executeRaw`DELETE FROM public.ticket_sla WHERE ticket_id = ${id}::uuid`;
        if (sla) await prisma.$executeRaw`INSERT INTO public.ticket_sla (ticket_id, policy_name, priority, status, response_met, response_done_at, response_used_ms, resolution_met, resolution_done_at, resolution_used_ms)
            VALUES (${id}::uuid, 'P', 'high', 'done', ${sla.rm}, now(), ${sla.rms}, ${sla.sm}, ${sla.sm === null ? null : new Date()}, ${sla.sms})`;
        return id;
    };
    await mk(ann.id, "resolved", client.id, { rm: true, rms: 10 * 60000, sm: true, sms: 120 * 60000 });
    await mk(ann.id, "closed", client.id, { rm: true, rms: 20 * 60000, sm: false, sms: 600 * 60000 });
    await mk(ann.id, "open", client.id, { rm: false, rms: 90 * 60000, sm: null, sms: 0 });
    await mk(bob.id, "resolved", client.id, { rm: true, rms: 30 * 60000, sm: true, sms: 60 * 60000 });
    await mk(null, "open", client.id, null);
    await mk(bob.id, "resolved", other.id, { rm: false, rms: 5 * 60000, sm: false, sms: 5 * 60000 });
    await prisma.$executeRaw`INSERT INTO public.time_entries (organization_id, user_id, client_id, work_date, minutes) VALUES (${org.id}::uuid, ${ann.id}::uuid, ${client.id}::uuid, current_date, 90), (${org.id}::uuid, ${bob.id}::uuid, ${client.id}::uuid, current_date, 45)`;

    const r = await perf.report(org.id, 30, client.id);
    const A = r.technicians.find((t) => t.userId === ann.id), B = r.technicians.find((t) => t.userId === bob.id), U = r.technicians.find((t) => t.userId === null);
    check("per technician: assigned, resolved and open", A.assigned === 3 && A.resolved === 2 && A.open === 1 && B.assigned === 1 && B.resolved === 1 && B.open === 0, [A, B]);
    check("SLA percentages count only tickets with a clock (a ticket with no resolution result is not a miss)", A.responseMetPercent === 67 && A.resolutionMetPercent === 50 && B.responseMetPercent === 100 && B.resolutionMetPercent === 100, [A.responseMetPercent, A.resolutionMetPercent]);
    check("average response and resolution time, in minutes (only tickets that reached that point)", A.avgResponseMinutes === 40 && A.avgResolutionMinutes === 360, [A.avgResponseMinutes, A.avgResolutionMinutes]);
    check("time logged is summed from time entries", A.minutesLogged === 90 && B.minutesLogged === 45 && r.team.minutesLogged === 135);
    check("unassigned tickets are listed last and the team row adds everything up", r.technicians[r.technicians.length - 1].userId === null && U.assigned === 1 && r.team.assigned === 5 && r.team.resolved === 3, r.team);
    check("a customer filter leaves out other customers' tickets", !r.technicians.some((t) => t.assigned > 3) && r.team.assigned === 5);
    const all = await perf.report(org.id, 30);
    check("without the filter the other customer's ticket is counted", all.technicians.find((t) => t.userId === bob.id).assigned === 2);
    check("the period is limited to 1..365 days and the priority table is there", (await perf.report(org.id, 99999)).days === 365 && (await perf.report(org.id, 0)).days === 30 && r.byPriority.some((p) => p.priority === "high" && p.tickets >= 5));

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
