// Encrypts existing plain credentials in a real database, then shows the app can still read them.
// Usage, from backend/ after building: RIQ_E2E_ALLOW=1 DATABASE_URL=postgres://.../riq_e2e node test/secrets-at-rest.e2e.cjs
const path = require("node:path");

if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}

process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { SecretsAtRestService } = require(path.join(dist, "common/secrets-at-rest.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { decryptSecret } = require(path.join(dist, "common/secret-box.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const secrets = app.get(SecretsAtRestService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });

    await prisma.email_settings.upsert({
        where: { purpose: "alerts" },
        create: { purpose: "alerts", smtp_password: "plain-smtp-password" },
        update: { smtp_password: "plain-smtp-password" },
    });
    const storage = await prisma.storage_connections.create({
        data: {
            organization_id: org.id,
            name: `e2e-${Date.now()}`,
            kind: "sftp",
            config: { host: "example.test", username: "backup", privateKey: "plain-key-in-config" },
            secrets: { password: "plain-storage-password" },
        },
    });

    const first = await secrets.encryptExisting();
    check("it reports what it encrypted", Object.values(first).some((n) => Number(n) > 0), first);

    const email = await prisma.email_settings.findUnique({ where: { purpose: "alerts" } });
    check("mail passwords are no longer plain", email.smtp_password.startsWith("enc:v1:"), email.smtp_password.slice(0, 8));
    check("they still decrypt to the original", decryptSecret(email.smtp_password) === "plain-smtp-password");

    const after = await prisma.storage_connections.findUnique({ where: { id: storage.id } });
    check("storage secrets are no longer plain", String(after.secrets.password).startsWith("enc:v1:"), after.secrets);
    check("a key left in the config is moved out of it", after.config.privateKey === undefined, Object.keys(after.config));
    check("the moved key is encrypted", String(after.secrets.privateKey).startsWith("enc:v1:"), Object.keys(after.secrets));

    const before = JSON.stringify(after.secrets);
    await secrets.encryptExisting();
    const again = await prisma.storage_connections.findUnique({ where: { id: storage.id } });
    check("running again changes nothing", JSON.stringify(again.secrets) === before);

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
