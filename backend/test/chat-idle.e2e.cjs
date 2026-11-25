// A chat nobody has written in for a while ends by itself and keeps its transcript. In-process, throwaway database only.
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret"; process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false"; process.env.NODE_ENV = "development"; process.env.CHAT_IDLE_MINUTES = "30";
(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { DeviceTrayService } = require(path.join(dist, "device-tray/device-tray.service.js"));
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false }); const tray = app.get(DeviceTrayService, { strict: false });
    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Idle ${Date.now()}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
    const dev = await prisma.devices.create({ data: { site_id: site.id, hostname: `IDLE-${Date.now()}`, operating_system: "Windows 11" } });
    const mk = async (v) => { const d = await prisma.devices.create({ data: { site_id: site.id, hostname: `IDLE-${v}-${Date.now()}`, operating_system: "Windows 11" } }); return (await prisma.agents.create({ data: { device_id: d.id, agent_uuid: crypto.randomUUID(), version: "1.3.44", last_check_in_at: new Date(), facts: { os: "windows" } } })).id; };
    await prisma.$executeRaw`INSERT INTO public.tray_settings (organization_id, enabled) VALUES (${org.id}::uuid, true) ON CONFLICT (organization_id) DO UPDATE SET enabled = true, chat_enabled = true`;
    const quiet = await mk("quiet"), busy = await mk("busy");
    await tray.sendFromDevice(quiet, { message: "anyone there?", user: "u", name: "Quinn", email: "q@x.example", phone: "555-0100" });
    await tray.sendFromDevice(busy, { message: "still talking", user: "u", name: "Bea", email: "b@x.example", phone: "555-0101" });
    await prisma.$executeRaw`UPDATE public.device_chat_sessions SET last_message_at = now() - interval '2 hours' WHERE contact_name = 'Quinn' AND ended_at IS NULL`;
    await tray.endIdleChats();
    const rows = await prisma.$queryRaw`SELECT contact_name, ended_at, ended_by, transcript, transcript_email_status FROM public.device_chat_sessions WHERE contact_name IN ('Quinn', 'Bea') ORDER BY contact_name`;
    const bea = rows.find((r) => r.contact_name === "Bea"), q = rows.find((r) => r.contact_name === "Quinn");
    let ok = true; const check = (n, c, x) => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : ": " + JSON.stringify(x)}`); if (!c) ok = false; };
    check("a quiet chat is ended by inactivity with its transcript kept", q.ended_at && q.ended_by === "idle" && /anyone there\?/.test(q.transcript) && /inactivity/.test(q.transcript), q);
    check("its transcript was handled (emailed, or says why not)", /^(sent|failed)/.test(q.transcript_email_status), q.transcript_email_status);
    check("a chat still being used is left open", !bea.ended_at, bea);
    await app.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
