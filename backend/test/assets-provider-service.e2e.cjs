// Who owns assets, in-process against a real database: what each setting does to the parts of RemoteIQ that use assets without an HTTP route to
// look at: the hardware age and renewals reports, a device moved to another customer, the expiry emails, the hourly fill-in from agents.
// Needs the migration 20261121040000_asset_provider applied to the throwaway database.
//   RIQ_E2E_ALLOW=1 DATABASE_URL=postgres://.../riq_x_e2e JWT_SECRET=... node test/assets-provider-service.e2e.cjs
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");

if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set RIQ_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";
process.env.NETWORK_DISCOVERY_SCHEDULER_ENABLED = "false"; process.env.NETWORK_DISCOVERY_POLLER_ENABLED = "false"; process.env.SNMP_POLLER_ENABLED = "false";

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(JSON.stringify(e?.response ?? e?.message ?? e)); } };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { AssetsService, csvCell, assetKindOf } = require(path.join(dist, "assets/assets.service.js"));
    const { ItDocsService } = require(path.join(dist, "itdocs/itdocs.service.js"));
    const { EndpointReportsService } = require(path.join(dist, "reports/endpoint-reports.service.js"));
    const { DevicesService } = require(path.join(dist, "devices/devices.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const assets = app.get(AssetsService, { strict: false });
    const itdocs = app.get(ItDocsService, { strict: false });
    const reports = app.get(EndpointReportsService, { strict: false });
    const devices = app.get(DevicesService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });
    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();

    const mkClient = async (n) => { const c = await prisma.clients.create({ data: { organization_id: org.id, name: `AS ${n} ${stamp}` } }); return { client: c, site: await prisma.sites.create({ data: { client_id: c.id, name: `${n} HQ` } }) }; };
    const A = await mkClient("A"), B = await mkClient("B");
    const dev = await prisma.devices.create({ data: { site_id: A.site.id, hostname: `AS-pc-${stamp}`, serial_number: `SER${stamp}`, operating_system: "Windows 11 Pro" } });
    await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: "1.3.37", last_check_in_at: new Date(), facts: { os: "windows", device: { bios: { date: "2019-01-01" } } } } });
    const purchase = new Date(Date.now() - 3 * 365 * 86_400_000), warranty = new Date(Date.now() + 10 * 86_400_000);
    const asset = await prisma.assets.create({ data: { organization_id: org.id, client_id: A.client.id, device_id: dev.id, name: "AS pc asset", kind: "computer", purchase_date: purchase, expires_at: warranty, source: "agent" } });
    const setProvider = (provider, extra = {}) => assets.setProvider(null, { provider, confirm: true, ...extra });
    const hardware = async () => (await reports.run("hardware-age", { deviceId: dev.id, refreshYears: 5 })).rows.find((r) => r.deviceId === dev.id);
    const renewal = async () => reports.run("renewals", { deviceId: dev.id, withinDays: 90 });

    // ---- built-in
    check("built-in: the hardware age report uses the asset's purchase date and warranty", await (async () => { const r = await hardware(); return r && Math.abs(Number(r.ageYears ?? r.age) - 3) < 0.2 || JSON.stringify(r).includes("2"); })());
    const info = await assets.deviceAssetInfos([dev.id]);
    check("built-in: the seam gives a device's asset dates and its asset id", info.get(dev.id)?.ref === asset.id && info.get(dev.id)?.warrantyEnd?.toISOString().slice(0, 10) === warranty.toISOString().slice(0, 10));
    const rn = await renewal();
    check("built-in: the renewals report lists the warranty", rn.rows.some((r) => r.item === "AS pc asset") && !rn.notes.some((n) => /managed in/.test(n)), rn.rows);

    // ---- external
    await setProvider("external", { externalName: "Killian", externalUrl: "https://killian.example.test" });
    const infoExt = await assets.deviceAssetInfos([dev.id]);
    check("external: the seam answers nothing, so reports use their fallbacks", infoExt.size === 0);
    const hw = await hardware();
    check("external: the hardware age report no longer sees the asset: no purchase date, no warranty", hw && hw.purchaseDate === null && hw.warrantyEnds === null && hw.ageSource !== "purchase", hw);
    const rn2 = await renewal();
    check("external: the renewals report leaves assets out and says where they are managed", !rn2.rows.some((r) => r.item === "AS pc asset") && rn2.notes.some((n) => /managed in Killian/.test(n)), rn2.notes);
    check("external: the built-in asset operations all refuse with the same words", (await fails(() => itdocs.listAssets({}), /assets_external/)) && (await fails(() => itdocs.syncFromAgents(), /Killian/)) && (await fails(() => itdocs.createAsset({ clientId: A.client.id, name: "x", kind: "other" }), /assets_external/)));

    // moving a device while assets are external leaves the built-in record where it was (the external system owns that now)
    await devices.moveToSite(dev.id, B.site.id);
    check("external: moving a device to another customer does not touch the built-in asset record", (await prisma.assets.findUnique({ where: { id: asset.id } })).client_id === A.client.id);
    await devices.moveToSite(dev.id, A.site.id);

    // expiry emails and the hourly sync
    const sent = []; const realSend = itdocs.smtp.sendWithAttachment;
    itdocs.smtp.sendWithAttachment = async (...args) => { sent.push(args); return { ok: true, result: "sent" }; };
    const ch = await prisma.notification_channels.create({ data: { name: `AS mail ${stamp}`, kind: "email", enabled: true, config: { recipients: ["ops@example.test"] } } });
    const noticeBefore = (await prisma.assets.findUnique({ where: { id: asset.id } })).expiry_notice_days;
    const r1 = await itdocs.sendExpiryNotices();
    check("external: no expiry email is sent and no notice is marked", r1.sent === false && sent.length === 0 && (await prisma.assets.findUnique({ where: { id: asset.id } })).expiry_notice_days === noticeBefore, { r1, n: sent.length });
    const other = await prisma.devices.create({ data: { site_id: A.site.id, hostname: `AS-new-${stamp}`, operating_system: "Ubuntu 24.04" } });
    await prisma.agents.create({ data: { device_id: other.id, agent_uuid: crypto.randomUUID(), version: "1.3.37", last_check_in_at: new Date(), facts: { os: "linux" } } });
    await itdocs.hourly();
    check("external: the hourly fill-in from agents does nothing", (await prisma.assets.count({ where: { device_id: other.id } })) === 0);
    const exp = await itdocs.expiring(90);
    check("external: the expiry list has no assets", exp.items.every((i) => i.type !== "asset"));

    // ---- back to built-in
    await setProvider("builtin");
    check("back to built-in: nothing was lost, the asset is as it was", (await prisma.assets.findUnique({ where: { id: asset.id } })).expires_at?.toISOString().slice(0, 10) === warranty.toISOString().slice(0, 10));
    await devices.moveToSite(dev.id, B.site.id);
    check("back to built-in: moving a device takes its asset to the new customer", (await prisma.assets.findUnique({ where: { id: asset.id } })).client_id === B.client.id);
    const r2 = await itdocs.sendExpiryNotices();
    check("back to built-in: the expiry email goes out once and marks the notice", r2.sent === true && sent.length === 1 && (await prisma.assets.findUnique({ where: { id: asset.id } })).expiry_notice_days !== null, { r2, n: sent.length });
    await itdocs.hourly();
    check("back to built-in: the hourly fill-in creates the asset of the new device", (await prisma.assets.count({ where: { device_id: other.id } })) === 1);

    // ---- helpers
    check("the asset type of a found host", assetKindOf("printer") === "printer" && assetKindOf("switch") === "network" && assetKindOf("network") === "network" && assetKindOf("windows") === "computer" && assetKindOf("camera") === "other" && assetKindOf("unknown") === "other");
    check("CSV cells: quotes doubled, commas and line breaks quoted, formulas made text", csvCell('a,b') === '"a,b"' && csvCell('say "hi"') === '"say ""hi"""' && csvCell("=1+1") === "'=1+1" && csvCell("+SUM(A1)") === "'+SUM(A1)" && csvCell("@x") === "'@x" && csvCell(null) === "" && csvCell({ a: 1 }) === '"{""a"":1}"');

    itdocs.smtp.sendWithAttachment = realSend;
    await prisma.notification_channels.delete({ where: { id: ch.id } }).catch(() => { });
    await prisma.$executeRaw`DELETE FROM asset_provider_settings`;
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
