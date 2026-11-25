#!/usr/bin/env node
// Round trips the real archive encryption on real files, and attacks the result. It also runs the
// real backup worker and restore step with a fake database. It needs no database and installs nothing.
//
//   npx tsc -p tsconfig.json          (in backend/)
//   node test/backup-archive-encryption.cjs
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

require("reflect-metadata");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-archive-enc-"));
const keyFile = path.join(tmp, "data.key");
fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"));
const otherKeyFile = path.join(tmp, "other.key");
fs.writeFileSync(otherKeyFile, crypto.randomBytes(32).toString("hex"));

const dist = path.join(__dirname, "..", "dist");
const box = require(path.join(dist, "common/secret-box"));
const archive = require(path.join(dist, "backups/archive-crypto"));
const { WorkerService } = require(path.join(dist, "backups/worker.service"));
const { RestoreWorkerService } = require(path.join(dist, "backups/restore-worker.service"));
const { BackupsService } = require(path.join(dist, "backups/backups.service"));

function useKey(file) {
    delete process.env.DATA_ENCRYPTION_KEY;
    if (file) process.env.DATA_ENCRYPTION_KEY_FILE = file;
    else delete process.env.DATA_ENCRYPTION_KEY_FILE;
    box.resetSecretBoxForTests();
}

const CHUNK = 64 * 1024;
const HEADER = 8 + 4 + 32 + 7;
const TAG = 16;

let counter = 0;
const file = (name) => path.join(tmp, `${counter++}-${name}`);
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function randomFile(size) {
    const p = file("plain");
    fs.writeFileSync(p, crypto.randomBytes(size));
    return p;
}

async function sealed(plain) {
    const out = file("enc");
    await archive.encryptArchiveFile(plain, out, CHUNK);
    return out;
}

async function refuses(encrypted, why, pattern = /could not be decrypted/) {
    const out = file("out");
    await assert.rejects(archive.decryptArchiveFile(encrypted, out), pattern, why);
    assert.equal(fs.existsSync(out), false, `${why}: partial output must not be left behind`);
}

let checks = 0;
async function check(name, fn) {
    await fn();
    checks++;
    console.log(`pass  ${name}`);
}

(async () => {
    try {
        useKey(keyFile);

        for (const [label, size] of [
            ["empty", 0],
            ["one byte", 1],
            ["one less than a chunk", CHUNK - 1],
            ["exactly one chunk", CHUNK],
            ["one more than a chunk", CHUNK + 1],
            ["exactly three chunks", CHUNK * 3],
            ["many chunks", CHUNK * 7 + 1234],
        ]) {
            await check(`round trip: ${label}`, async () => {
                const plain = randomFile(size);
                const enc = await sealed(plain);
                const expectedChunks = Math.max(1, Math.ceil(size / CHUNK));
                assert.equal(fs.statSync(enc).size, HEADER + size + expectedChunks * TAG, "the format has no surprises");
                assert.equal(await archive.isEncryptedArchiveFile(enc), true);
                const out = file("out");
                await archive.decryptArchiveFile(enc, out);
                assert.equal(sha(out), sha(plain));
            });
        }

        await check("the default chunk size works too, and the file does not contain the plaintext", async () => {
            const plain = file("plain");
            const marker = "PLAINTEXT-MARKER-".repeat(200000);
            fs.writeFileSync(plain, marker);
            const enc = file("enc");
            await archive.encryptArchiveFile(plain, enc);
            assert.ok(!fs.readFileSync(enc).includes("PLAINTEXT-MARKER"));
            const out = file("out");
            await archive.decryptArchiveFile(enc, out);
            assert.equal(sha(out), sha(plain));
        });

        await check("a 300 MB file passes with memory staying well below its size", async () => {
            const plain = file("big");
            const block = crypto.randomBytes(1024 * 1024);
            const fd = fs.openSync(plain, "w");
            for (let i = 0; i < 300; i++) fs.writeSync(fd, block);
            fs.closeSync(fd);

            let peak = 0;
            const before = process.memoryUsage().rss;
            const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
            const enc = file("big-enc");
            const out = file("big-out");
            await archive.encryptArchiveFile(plain, enc);
            await archive.decryptArchiveFile(enc, out);
            clearInterval(timer);

            assert.equal(sha(out), sha(plain));
            const grewMb = (peak - before) / 1024 / 1024;
            assert.ok(grewMb < 150, `memory grew ${grewMb.toFixed(0)} MB`);
            console.log(`      (memory grew ${grewMb.toFixed(0)} MB)`);
            for (const p of [plain, enc, out]) fs.rmSync(p);
        });

        const plain = randomFile(CHUNK * 4 + 100);
        const enc = await sealed(plain);
        const original = fs.readFileSync(enc);
        const frame = CHUNK + TAG;

        const tampered = (mutate) => {
            const copy = Buffer.from(original);
            const result = mutate(copy) ?? copy;
            const p = file("tampered");
            fs.writeFileSync(p, result);
            return p;
        };

        await check("tamper: a flipped bit in any chunk fails", async () => {
            for (const offset of [HEADER + 5, HEADER + frame + 5, HEADER + frame * 4 + 5]) {
                await refuses(tampered((b) => { b[offset] ^= 1; }), `offset ${offset}`);
            }
        });

        await check("tamper: a flipped bit in a tag fails", () =>
            refuses(tampered((b) => { b[HEADER + CHUNK + 3] ^= 1; }), "tag"));

        await check("tamper: every part of the header is protected", async () => {
            await refuses(tampered((b) => { b[8 + 3] ^= 1; }), "chunk size");
            await refuses(tampered((b) => { b[8 + 4 + 2] ^= 1; }), "salt");
            await refuses(tampered((b) => { b[8 + 4 + 32 + 2] ^= 1; }), "nonce prefix");
            await refuses(tampered((b) => { b[0] ^= 1; }), "magic", /not an encrypted RemoteIQ archive/);
        });

        await check("reorder: swapping two chunks fails", () =>
            refuses(tampered((b) => {
                const a = Buffer.from(b.subarray(HEADER, HEADER + frame));
                b.copy(b, HEADER, HEADER + frame, HEADER + frame * 2);
                a.copy(b, HEADER + frame);
            }), "swap"));

        await check("reorder: dropping a chunk from the middle fails", () =>
            refuses(tampered((b) => Buffer.concat([b.subarray(0, HEADER + frame), b.subarray(HEADER + frame * 2)])), "drop"));

        await check("reorder: repeating a chunk fails", () =>
            refuses(tampered((b) => Buffer.concat([b.subarray(0, HEADER + frame), b.subarray(HEADER, HEADER + frame), b.subarray(HEADER + frame)])), "repeat"));

        await check("truncation: cut exactly at each chunk boundary fails", async () => {
            for (let n = 0; n <= 4; n++) {
                await refuses(tampered((b) => b.subarray(0, HEADER + frame * n)), `${n} chunks`);
            }
        });

        await check("truncation: cut inside a chunk, inside a tag, or inside the header fails", async () => {
            await refuses(tampered((b) => b.subarray(0, HEADER + 100)), "inside a chunk");
            await refuses(tampered((b) => b.subarray(0, b.length - 1)), "last byte");
            await refuses(tampered((b) => b.subarray(0, b.length - 8)), "inside the last tag");
            await refuses(tampered((b) => b.subarray(0, 20)), "inside the header");
            await refuses(tampered((b) => b.subarray(0, 0)), "empty file");
        });

        await check("extension: bytes added after the end fail", () =>
            refuses(tampered((b) => Buffer.concat([b, Buffer.from("more")])), "appended"));

        await check("a chunk from another archive under the same key fails", async () => {
            const other = fs.readFileSync(await sealed(randomFile(CHUNK * 4 + 100)));
            await refuses(tampered((b) => {
                other.copy(b, HEADER + frame, HEADER + frame, HEADER + frame * 2);
            }), "spliced");
        });

        await check("two encryptions of one file share nothing", async () => {
            const again = fs.readFileSync(await sealed(plain));
            assert.ok(!again.subarray(HEADER, HEADER + 32).equals(original.subarray(HEADER, HEADER + 32)));
        });

        await check("the wrong key fails clearly, and no key fails clearly", async () => {
            useKey(otherKeyFile);
            await refuses(enc, "wrong key");
            useKey(null);
            await refuses(enc, "no key", /DATA_ENCRYPTION_KEY_FILE/);
            await assert.rejects(archive.encryptArchiveFile(plain, file("out")), /DATA_ENCRYPTION_KEY_FILE/);
            useKey(keyFile);
        });

        await check("a plain file is recognised as plain, and refused by decrypt", async () => {
            const notEnc = randomFile(1000);
            assert.equal(await archive.isEncryptedArchiveFile(notEnc), false);
            const empty = file("empty");
            fs.writeFileSync(empty, "");
            assert.equal(await archive.isEncryptedArchiveFile(empty), false);
            await refuses(notEnc, "plain", /not an encrypted RemoteIQ archive/);
        });

        await check("a file already at the output path is neither overwritten nor removed", async () => {
            const existing = file("existing");
            fs.writeFileSync(existing, "keep me");
            await assert.rejects(archive.decryptArchiveFile(enc, existing), /EEXIST/);
            assert.equal(fs.readFileSync(existing, "utf8"), "keep me");
        });

        await check("the manual decrypt script works and reports failure", () => {
            const script = path.join(__dirname, "..", "scripts", "decrypt-backup.cjs");
            const out = file("script-out");
            const ok = spawnSync(process.execPath, [script, enc, out], { env: process.env, encoding: "utf8" });
            assert.equal(ok.status, 0, ok.stderr);
            assert.equal(sha(out), sha(plain));
            const bad = spawnSync(process.execPath, [script, plain, file("x")], { env: process.env, encoding: "utf8" });
            assert.equal(bad.status, 1);
            assert.match(bad.stderr, /not an encrypted RemoteIQ archive/);
        });

        // ------ the real worker, writing to a local destination ------
        const destDir = path.join(tmp, "dest");

        function fakeWorkerDb(snapshot) {
            const state = { job: null, artifact: null, manifest: null };
            const db = {
                state,
                backup_jobs: {
                    findUnique: async () => ({ backup_kind: "logical", config_snapshot: snapshot, backup_policies: null }),
                    updateMany: async ({ data }) => { state.job = data; return { count: 1 }; },
                },
                backup_job_manifests: { upsert: async ({ create }) => { state.manifest = create.manifest; } },
                backup_job_artifacts: { create: async ({ data }) => { state.artifact = data; } },
                users: { findMany: async () => [{ id: "u1" }] },
                roles: { findMany: async () => [{ id: "r1" }] },
                $executeRaw: async () => 1,
                $queryRaw: async () => [{ oid: "users" }],
            };
            return db;
        }

        const runBackup = async (encrypt) => {
            const db = fakeWorkerDb({
                destination: { kind: "local", path: destDir },
                targets: ["users", "roles"],
                notifications: {},
                encrypt,
            });
            const worker = new WorkerService(db, { send: async () => undefined });
            worker.log = { log() { }, error() { }, warn() { } };
            await worker.process("job-1");
            return db.state;
        };

        await check("worker: an encrypted logical backup stores only the encrypted file", async () => {
            const state = await runBackup(true);
            assert.equal(state.job.status, "completed", state.job.error ?? undefined);
            assert.match(state.job.archive_name, /\.tar\.gz\.enc$/);
            const stored = path.join(destDir, state.job.archive_name);
            assert.equal(await archive.isEncryptedArchiveFile(stored), true);
            assert.equal(sha(stored), state.job.checksum, "the checksum describes the stored file");
            assert.equal(state.manifest.artifact.encryption.format, archive.ARCHIVE_ENCRYPTION_FORMAT);
            assert.equal(Number(state.job.size_bytes), fs.statSync(stored).size);

            const out = file("logical.tar.gz");
            await archive.decryptArchiveFile(stored, out);
            assert.equal(fs.readFileSync(out).subarray(0, 2).toString("hex"), "1f8b", "it decrypts to a gzip file");
            fs.rmSync(stored);
        });

        await check("worker: encryption stays off unless asked for, as before", async () => {
            const state = await runBackup(false);
            assert.equal(state.job.status, "completed");
            assert.match(state.job.archive_name, /\.tar\.gz$/);
            assert.equal(state.manifest.artifact.encryption, undefined);
            const stored = path.join(destDir, state.job.archive_name);
            assert.equal(await archive.isEncryptedArchiveFile(stored), false);
            fs.rmSync(stored);
        });

        await check("worker: asking for encryption with no key fails the job and stores nothing", async () => {
            useKey(null);
            const before = fs.existsSync(destDir) ? fs.readdirSync(destDir).length : 0;
            const state = await runBackup(true);
            useKey(keyFile);
            assert.equal(state.job.status, "failed");
            assert.match(state.job.error, /DATA_ENCRYPTION_KEY_FILE/);
            assert.equal(fs.readdirSync(destDir).length, before);
        });

        // ------ the real restore step ------
        const restore = new RestoreWorkerService({});
        const prepare = (manifestEncryption, input) => {
            const copy = file("artifact");
            fs.copyFileSync(input, copy);
            const dump = file("dump");
            return {
                dump,
                run: () => restore.prepareDump(
                    { manifest: { artifact: manifestEncryption ? { encryption: { format: "x" } } : {} } },
                    copy,
                    dump,
                ),
            };
        };

        await check("restore: an encrypted artifact is decrypted for pg_restore", async () => {
            const { dump, run } = prepare(true, enc);
            assert.equal(await run(), true);
            assert.equal(sha(dump), sha(plain));
        });

        await check("restore: a plain artifact from before this change still works", async () => {
            const { dump, run } = prepare(false, plain);
            assert.equal(await run(), false);
            assert.equal(sha(dump), sha(plain));
        });

        await check("restore: the manifest and the file must agree, either way", async () => {
            await assert.rejects(prepare(true, plain).run(), /says this artifact is encrypted, but the file is not/);
            await assert.rejects(prepare(false, enc).run(), /says this artifact is not encrypted, but the file is/);
        });

        await check("restore: a damaged artifact stops before pg_restore, and leaves no dump", async () => {
            const cut = file("cut");
            fs.writeFileSync(cut, original.subarray(0, HEADER + frame * 2));
            const { dump, run } = prepare(true, cut);
            await assert.rejects(run(), /could not be decrypted/);
            assert.equal(fs.existsSync(dump), false);
        });

        // ------ the option ------
        const service = (policyOptions) => {
            const svc = Object.create(BackupsService.prototype);
            svc.fetchDefaultPolicy = async () => policyOptions;
            return svc;
        };

        await check("config: the save is refused without a key, and accepted past that check with one", async () => {
            const cfg = { encrypt: true, targets: [], schedule: "cron", destination: { kind: "local", path: "/x" } };
            useKey(null);
            await assert.rejects(service(null).saveConfig(cfg), /DATA_ENCRYPTION_KEY_FILE/);
            useKey(keyFile);
            // Past the key check it goes on to validate the rest, which this config fails on purpose.
            await assert.rejects(service(null).saveConfig(cfg), (e) => !/DATA_ENCRYPTION_KEY_FILE|not implemented/.test(e.message));
        });

        await check("config: reports what is saved and whether encryption is available", async () => {
            const parse = BackupsService.prototype.parsePolicy;
            const row = (options) => ({ id: "p", backup_kind: "postgresql", schedule: "daily", retention: { days: 1 }, options, destination_configuration: {} });
            const svc = Object.create(BackupsService.prototype);
            assert.equal(parse.call(svc, row({ encrypt: true })).encrypt, true);
            assert.equal(parse.call(svc, row({})).encrypt, false);

            assert.equal((await service(null).getConfig()).encryptionSupported, true);
            const saved = await service({ backupKind: "postgresql", enabled: true, targets: [], schedule: "daily", retentionDays: 1, encrypt: true, notifications: {} }).getConfig();
            assert.equal(saved.encrypt, true);
            useKey(null);
            assert.equal((await service(null).getConfig()).encryptionSupported, false);
            useKey(keyFile);
        });

        console.log(`\nAll ${checks} backup archive encryption checks passed.`);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})();
