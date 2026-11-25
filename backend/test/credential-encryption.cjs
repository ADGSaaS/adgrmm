#!/usr/bin/env node
// Runs the real credential code with an in-memory database: saving, using, returning through the
// API, and the startup step that encrypts old values. It needs no database and installs nothing.
//
//   npx tsc -p tsconfig.json          (in backend/)
//   node test/credential-encryption.cjs
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("reflect-metadata");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-cred-enc-"));
const keyFile = path.join(tmp, "data.key");
fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"));
const otherKeyFile = path.join(tmp, "other.key");
fs.writeFileSync(otherKeyFile, crypto.randomBytes(32).toString("hex"));

const imapflow = require("imapflow");
const imapLogins = [];
class FakeImap {
    constructor(options) { imapLogins.push(options.auth); }
    async connect() { throw new Error("stop here"); }
    async logout() { }
    close() { }
}
imapflow.ImapFlow = FakeImap;

const dist = path.join(__dirname, "..", "dist");
const box = require(path.join(dist, "common/secret-box"));
const { SecretsAtRestService } = require(path.join(dist, "common/secrets-at-rest.service"));
const { SmtpRepository } = require(path.join(dist, "smtp/smtp.repository"));
const { DkimRepository } = require(path.join(dist, "smtp/dkim.repository"));
const { SmtpService } = require(path.join(dist, "smtp/smtp.service"));
const { SmtpController } = require(path.join(dist, "smtp/smtp.controller"));
const { ImapPollerService } = require(path.join(dist, "imap/imap-poller.service"));
const { StorageConnectionsService } = require(path.join(dist, "storage/storage-connections.service"));
const { findStorageConnection } = require(path.join(dist, "backups/storage-connection-lookup"));

function useKey(file) {
    delete process.env.DATA_ENCRYPTION_KEY;
    if (file) process.env.DATA_ENCRYPTION_KEY_FILE = file;
    else delete process.env.DATA_ENCRYPTION_KEY_FILE;
    box.resetSecretBoxForTests();
}

const same = (actual, wanted) =>
    wanted && typeof wanted === "object" && "equals" in wanted
        ? JSON.stringify(actual) === JSON.stringify(wanted.equals)
        : actual === wanted;

class FakeTable {
    constructor(idField, rows = []) { this.idField = idField; this.rows = rows; }
    matches(row, where = {}) { return Object.entries(where).every(([k, v]) => same(row[k], v)); }
    pick(row, select) {
        if (!select) return structuredClone(row);
        return Object.fromEntries(Object.keys(select).map((k) => [k, structuredClone(row[k])]));
    }
    async findMany(args = {}) { return this.rows.filter((r) => this.matches(r, args.where)).map((r) => this.pick(r, args.select)); }
    async findFirst(args = {}) {
        const row = this.rows.find((r) => this.matches(r, args.where));
        return row ? this.pick(row, args.select) : null;
    }
    async findUnique(args) { return this.findFirst(args); }
    async updateMany({ where, data }) {
        const hit = this.rows.filter((r) => this.matches(r, where));
        for (const r of hit) Object.assign(r, structuredClone(data));
        return { count: hit.length };
    }
    async create({ data, select }) {
        const row = { [this.idField]: crypto.randomUUID(), updated_at: new Date(), ...structuredClone(data) };
        this.rows.push(row);
        return this.pick(row, select);
    }
    async upsert({ where, create, update }) {
        const row = this.rows.find((r) => this.matches(r, where));
        if (row) Object.assign(row, structuredClone(update));
        else this.rows.push(structuredClone(create));
    }
}

const PLAIN = {
    smtp: "smtp-plain-Secret!",
    imap: "imap-plain-Secret!",
    pop: "pop-plain-Secret!",
    dkim: "-----BEGIN PRIVATE KEY-----\nplain-dkim\n-----END PRIVATE KEY-----",
    dkimKeys: "-----BEGIN PRIVATE KEY-----\nplain-dkim-keys\n-----END PRIVATE KEY-----",
    nextcloud: "nextcloud-plain-Secret!",
    s3: "s3-plain-Secret!",
    channelSmtp: "channel-smtp-plain!",
    channelImap: "channel-imap-plain!",
    leaked: "-----BEGIN KEY-----leaked-in-config",
};

function oldDatabase() {
    const updated = new Date("2026-01-01T00:00:00Z");
    return {
        email_settings: new FakeTable("purpose", [{
            purpose: "alerts", enabled: true,
            smtp_host: "mail.test", smtp_port: 587, smtp_username: "u", smtp_password: PLAIN.smtp,
            smtp_use_tls: true, smtp_use_ssl: false, smtp_from_address: "a@test",
            imap_host: "imap.test", imap_port: 993, imap_username: "u", imap_password: PLAIN.imap, imap_use_ssl: true,
            pop_host: "pop.test", pop_port: 995, pop_username: "u", pop_password: PLAIN.pop, pop_use_ssl: true,
            updated_at: updated,
        }, {
            purpose: "reports", enabled: true,
            smtp_host: "", smtp_port: null, smtp_username: "", smtp_password: null,
            smtp_use_tls: true, smtp_use_ssl: false, smtp_from_address: "",
            imap_host: "", imap_port: null, imap_username: "", imap_password: "", imap_use_ssl: true,
            pop_host: "", pop_port: null, pop_username: "", pop_password: null, pop_use_ssl: true,
            updated_at: updated,
        }]),
        dkim_settings: new FakeTable("id", [{ id: 1, domain: "test", selector: "s1", private_key: PLAIN.dkim, updated_at: updated }]),
        dkim_keys: new FakeTable("id", [{ id: "k1", private_key: PLAIN.dkimKeys }]),
        email_channels: new FakeTable("id", [{
            id: "c1",
            smtp_settings: { host: "h", password: PLAIN.channelSmtp, port: 25 },
            imap_settings: { host: "h", auth: { pass: PLAIN.channelImap, user: "u" } },
            updated_at: updated,
        }]),
        storage_connections: new FakeTable("id", [{
            id: "10000000-0000-4000-8000-000000000001", organization_id: "org", name: "nc", kind: "nextcloud",
            config: { webdavUrl: "https://x", username: "u", path: "/x" },
            secrets: { password: PLAIN.nextcloud },
            meta: {}, capabilities: {}, health: {}, updated_at: updated,
        }, {
            id: "10000000-0000-4000-8000-000000000002", organization_id: "org", name: "gd", kind: "gdrive",
            config: { folderId: "root" },
            secrets: { serviceAccountJson: { type: "service_account", private_key: "sa-key" } },
            meta: {}, capabilities: {}, health: {}, updated_at: updated,
        }, {
            id: "10000000-0000-4000-8000-000000000003", organization_id: "org", name: "sftp", kind: "sftp",
            config: { host: "h", username: "u", path: "/x", privateKey: PLAIN.leaked },
            secrets: {},
            meta: {}, capabilities: {}, health: {}, updated_at: updated,
        }]),
    };
}

const orgCtx = { getDefaultOrganizationId: async () => "org" };
const quiet = { log() { }, error() { }, warn() { }, debug() { }, verbose() { } };

let checks = 0;
async function check(name, fn) {
    await fn();
    checks++;
    console.log(`pass  ${name}`);
}

const dump = (db) => JSON.stringify(Object.fromEntries(Object.entries(db).map(([k, t]) => [k, t.rows])));

function services(db) {
    const repo = new SmtpRepository(db);
    const dkim = new DkimRepository(db);
    const smtp = new SmtpService(repo, dkim);
    smtp.log = quiet;
    return {
        repo, dkim, smtp,
        storage: new StorageConnectionsService(db, orgCtx),
        controller: new SmtpController(smtp, dkim),
        startup: Object.assign(new SecretsAtRestService(db), { log: quiet }),
    };
}

const req = { headers: {}, ip: "127.0.0.1" };
const silentAudit = (fn) => async (...args) => {
    const real = console.log;
    console.log = () => { };
    try { return await fn(...args); } finally { console.log = real; }
};

(async () => {
    try {
        await check("secret box round trip, and legacy plain values pass through", () => {
            useKey(keyFile);
            const sealed = box.encryptSecret("value");
            assert.ok(box.isEncrypted(sealed));
            assert.equal(box.decryptSecret(sealed), "value");
            assert.equal(box.decryptSecret("old plain value"), "old plain value");
            const map = { a: box.sealSecretValue({ type: "x" }), b: box.sealSecretValue("text"), c: "old", d: null };
            assert.deepEqual(box.openSecretMap(map), { a: { type: "x" }, b: "text", c: "old", d: null });
        });

        await check("everything keeps working on plain values before the startup step has run", async () => {
            useKey(keyFile);
            const db = oldDatabase();
            const { smtp } = services(db);
            const built = await smtp.buildTransport((await smtp.repo.getAllRaw()).alerts);
            assert.equal(built.opts.auth.pass, PLAIN.smtp);
            assert.equal(built.opts.dkim.privateKey, PLAIN.dkim);
            const row = await findStorageConnection(db, "10000000-0000-4000-8000-000000000001", "nextcloud");
            assert.equal(row.secrets.password, PLAIN.nextcloud);
        });

        await check("with no key, the startup step leaves everything untouched and does not throw", async () => {
            useKey(null);
            const db = oldDatabase();
            const { startup, smtp } = services(db);
            const before = dump(db);
            await startup.onApplicationBootstrap();
            assert.equal(dump(db), before);
            const built = await smtp.buildTransport((await smtp.repo.getAllRaw()).alerts);
            assert.equal(built.opts.auth.pass, PLAIN.smtp, "plain values still work without the key");
        });

        await check("with no key, saving a new secret is refused rather than stored plain", async () => {
            useKey(null);
            const db = oldDatabase();
            const { storage, dkim } = services(db);
            const before = dump(db);
            await assert.rejects(dkim.save({ domain: "d", selector: "s", privateKey: "k" }), /DATA_ENCRYPTION_KEY_FILE/);
            await assert.rejects(storage.create({
                name: "new", kind: "nextcloud",
                config: { webdavUrl: "https://x", username: "u", path: "/x", password: "p" },
            }), /DATA_ENCRYPTION_KEY_FILE/);
            assert.equal(dump(db), before);
        });

        useKey(keyFile);
        const db = oldDatabase();
        const svc = services(db);

        await check("the startup step encrypts every old value and nothing else changes", async () => {
            const stampBefore = db.email_settings.rows[0].updated_at;
            const counts = await svc.startup.encryptExisting();
            assert.deepEqual(counts.failedTables, []);
            // 3 email + 1 dkim_settings + 1 dkim_keys + 2 channel + nextcloud + gdrive + the config leak
            assert.equal(counts.encrypted, 10);

            const text = dump(db);
            for (const [name, plain] of Object.entries(PLAIN)) {
                assert.ok(!text.includes(JSON.stringify(plain).slice(1, -1)), `${name} is still readable`);
            }
            assert.ok(!text.includes("sa-key"), "service account is still readable");

            const alerts = db.email_settings.rows[0];
            assert.equal(alerts.smtp_host, "mail.test");
            assert.equal(alerts.updated_at, stampBefore, "the UI's last-saved time does not move");
            assert.equal(db.email_settings.rows[1].smtp_password, null, "nothing is invented for an empty password");
            assert.equal(db.email_settings.rows[1].imap_password, "", "an empty password stays empty");
            assert.equal(db.email_channels.rows[0].smtp_settings.port, 25);
            assert.equal(db.email_channels.rows[0].imap_settings.auth.user, "u");
        });

        await check("running it again changes nothing", async () => {
            const before = dump(db);
            const counts = await svc.startup.encryptExisting();
            assert.equal(counts.encrypted, 0);
            assert.equal(counts.alreadyEncrypted, 10);
            assert.equal(counts.undecryptable, 0);
            assert.equal(dump(db), before);
        });

        await check("a save made while it runs is not overwritten", async () => {
            const racing = oldDatabase();
            const realUpdate = racing.email_settings.updateMany.bind(racing.email_settings);
            let raced = false;
            racing.email_settings.updateMany = async (args) => {
                if (!raced) {
                    raced = true;
                    racing.email_settings.rows[0].smtp_password = "saved-by-an-admin";
                }
                return realUpdate(args);
            };
            await services(racing).startup.encryptExisting();
            assert.equal(racing.email_settings.rows[0].smtp_password, "saved-by-an-admin");
        });

        await check("a save to a JSON column made while it runs is not overwritten", async () => {
            const racing = oldDatabase();
            const realUpdate = racing.storage_connections.updateMany.bind(racing.storage_connections);
            let raced = false;
            racing.storage_connections.updateMany = async (args) => {
                if (!raced) {
                    raced = true;
                    racing.storage_connections.rows[0].secrets = { password: "saved-by-an-admin" };
                }
                return realUpdate(args);
            };
            await services(racing).startup.encryptExisting();
            assert.deepEqual(racing.storage_connections.rows[0].secrets, { password: "saved-by-an-admin" });
        });

        await check("the real Prisma client accepts every query the startup step makes", async () => {
            // Validation happens before connecting, so a refused connection means the query was accepted.
            const { PrismaClient, Prisma } = require("@prisma/client");
            const real = new PrismaClient({ datasources: { db: { url: "postgresql://none:none@127.0.0.1:1/none" } } });
            const source = oldDatabase();
            const outcomes = [];
            const tables = Object.fromEntries(Object.keys(source).map((name) => [name, {
                findMany: (args) => source[name].findMany(args),
                updateMany: async (args) => {
                    try {
                        await real[name].updateMany(args);
                        outcomes.push(`${name}: unexpectedly reached a database`);
                    } catch (e) {
                        if (e instanceof Prisma.PrismaClientValidationError) outcomes.push(`${name}: ${e.message}`);
                        else outcomes.push("accepted");
                    }
                    return { count: 1 };
                },
            }]));
            const counts = await new SecretsAtRestService(tables).encryptExisting();
            await real.$disconnect().catch(() => { });
            assert.deepEqual(counts.failedTables, []);
            assert.ok(outcomes.length >= 7, `${outcomes.length} updates`);
            assert.deepEqual([...new Set(outcomes)], ["accepted"]);
        });

        await check("SMTP, DKIM and IMAP get the decrypted values at the point of use", async () => {
            const built = await svc.smtp.buildTransport((await svc.repo.getAllRaw()).alerts);
            assert.equal(built.opts.auth.pass, PLAIN.smtp);
            assert.equal(built.opts.dkim.privateKey, PLAIN.dkim);

            const poller = new ImapPollerService(svc.repo, { });
            poller.log = quiet;
            await poller.pollOnce().catch(() => { });
            assert.ok(imapLogins.length > 0, "the poller tried to log in");
            assert.equal(imapLogins.at(-1).pass, PLAIN.imap);
        });

        await check("storage connections get the decrypted values at the point of use", async () => {
            const nc = await findStorageConnection(db, "10000000-0000-4000-8000-000000000001", "nextcloud");
            assert.equal(nc.secrets.password, PLAIN.nextcloud);
            const gd = await findStorageConnection(db, "10000000-0000-4000-8000-000000000002", "gdrive");
            assert.deepEqual(gd.secrets.serviceAccountJson, { type: "service_account", private_key: "sa-key" });
            const sftp = await findStorageConnection(db, "10000000-0000-4000-8000-000000000003", "sftp");
            assert.equal(sftp.secrets.privateKey, PLAIN.leaked, "a credential found in config moved to secrets");
            assert.equal(sftp.config.privateKey, undefined);
        });

        await check("saves encrypt, an unchanged secret stays as it was, and a clear removes it", async () => {
            await svc.smtp.saveConfig({
                profiles: {
                    alerts: {
                        enabled: true,
                        smtp: { host: "mail.test", port: 587, username: "u", password: "new-smtp", useTLS: true, useSSL: false, fromAddress: "a@test" },
                        imap: { host: "imap.test", port: 993, username: "u", useSSL: true },
                        pop: { host: "pop.test", port: 995, username: "u", useSSL: true },
                    },
                },
            });
            const row = db.email_settings.rows[0];
            assert.ok(box.isEncrypted(row.smtp_password));
            assert.equal(box.decryptSecret(row.smtp_password), "new-smtp");
            assert.equal(box.decryptSecret(row.imap_password), PLAIN.imap, "an omitted password is kept");

            await svc.dkim.save({ domain: "test", selector: "s1", privateKey: "new-dkim" });
            assert.ok(box.isEncrypted(db.dkim_settings.rows[0].private_key));
            assert.equal(box.decryptSecret(db.dkim_settings.rows[0].private_key), "new-dkim");
            const stored = db.dkim_settings.rows[0].private_key;
            await svc.dkim.save({ domain: "test", selector: "s2" });
            assert.equal(db.dkim_settings.rows[0].private_key, stored, "an omitted key is kept");

            const { id } = await svc.storage.create({
                name: "created", kind: "nextcloud",
                config: { webdavUrl: "https://x", username: "u", path: "/x", password: "created-secret" },
            });
            const created = db.storage_connections.rows.find((r) => r.id === id);
            assert.ok(box.isEncrypted(created.secrets.password));
            assert.ok(!JSON.stringify(created).includes("created-secret"));

            const sealed = created.secrets.password;
            const update = (config) => svc.storage.update(id, {
                name: "created", kind: "nextcloud",
                config: { webdavUrl: "https://x", username: "u", path: "/x", ...config },
            });
            await update({ password: "****" });
            assert.equal(db.storage_connections.rows.find((r) => r.id === id).secrets.password, sealed, "masked means unchanged");
            await update({ password: "enc:v1:looks-encrypted" });
            const lookalike = await findStorageConnection(db, id, "nextcloud");
            assert.equal(lookalike.secrets.password, "enc:v1:looks-encrypted", "a password that looks encrypted survives");
            await update({ password: null });
            assert.equal(db.storage_connections.rows.find((r) => r.id === id).secrets.password, undefined);

            // A key sent the way the older screen did is never returned again.
            const made = await svc.storage.create({
                name: "sftp2", kind: "sftp",
                config: { host: "h", username: "u", path: "/x", privateKey: "sftp2-key" },
            });
            const sftp2 = db.storage_connections.rows.find((r) => r.id === made.id);
            assert.equal(sftp2.config.privateKey, undefined);
            assert.ok(box.isEncrypted(sftp2.secrets.privateKey));
        });

        await check("API responses never contain a secret, plain or encrypted", async () => {
            const secretsRe = /enc:v1:|plain|new-smtp|new-dkim|sa-key|leaked|created-secret|sftp2-key/;

            const config = await svc.smtp.getConfig();
            assert.ok(!secretsRe.test(JSON.stringify(config)), JSON.stringify(config));

            const dkim = await silentAudit(() => svc.controller.getDkim(req))();
            assert.ok(!secretsRe.test(JSON.stringify(dkim)));
            assert.equal(dkim.hasPrivateKey, true);

            // A row that still has a credential in config, as an older save could leave it.
            db.storage_connections.rows.push({
                id: "10000000-0000-4000-8000-000000000009", organization_id: "org", name: "old", kind: "sftp",
                config: { host: "h", username: "u", path: "/x", privateKey: "leaked", password: "plain" },
                secrets: {}, meta: {}, capabilities: {}, health: {}, updated_at: new Date(),
            });
            const list = await svc.storage.list();
            assert.ok(!secretsRe.test(JSON.stringify(list)), JSON.stringify(list));
            db.storage_connections.rows.pop();

            const nc = list.items.find((i) => i.name === "nc");
            assert.equal(nc.hasSecret.nextcloudPassword, true, "'is it set?' still works");
            const gd = list.items.find((i) => i.name === "gd");
            assert.equal(gd.hasSecret.gdriveServiceAccountJson, true);
            const sftp = list.items.find((i) => i.name === "sftp");
            assert.equal(sftp.hasSecret.sftpPrivateKey, true);
        });

        await check("listing works without the key, because it does not decrypt", async () => {
            useKey(null);
            const list = await svc.storage.list();
            assert.equal(list.items.find((i) => i.name === "nc").hasSecret.nextcloudPassword, true);
            const config = await svc.smtp.getConfig();
            assert.equal(config.profiles.alerts.smtp.host, "mail.test");
            useKey(keyFile);
        });

        await check("the wrong key fails with a clear message and no secret, and is counted at startup", async () => {
            useKey(otherKeyFile);
            const built = await svc.smtp.buildTransport((await svc.repo.getAllRaw()).alerts);
            assert.equal(built.opts, null);
            assert.match(built.message, /could not be decrypted/);

            await assert.rejects(
                findStorageConnection(db, "10000000-0000-4000-8000-000000000001", "nextcloud"),
                (e) => /could not be decrypted/.test(e.message) && !e.message.includes(PLAIN.nextcloud),
            );

            const before = dump(db);
            const counts = await svc.startup.encryptExisting();
            assert.ok(counts.undecryptable > 0);
            assert.equal(counts.encrypted, 0);
            assert.equal(dump(db), before, "values under another key are left alone");
            useKey(keyFile);
        });

        await check("a database failure on one table does not stop the others or the backend", async () => {
            const broken = oldDatabase();
            broken.email_channels.findMany = async () => { throw Object.assign(new Error("boom"), { code: "P2021" }); };
            const { startup } = services(broken);
            await startup.onApplicationBootstrap();
            assert.ok(box.isEncrypted(broken.email_settings.rows[0].smtp_password));
            assert.ok(box.isEncrypted(broken.dkim_keys.rows[0].private_key));
        });

        console.log(`\nAll ${checks} credential encryption checks passed.`);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})();
