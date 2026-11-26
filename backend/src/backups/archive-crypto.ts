// backend/src/backups/archive-crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { deriveDataKey } from "../common/secret-box";

/*
 * Encrypted archive format, version 1:
 *
 *   header:  magic (8) | chunk size, big endian (4) | salt (32) | nonce prefix (7)
 *   chunks:  ciphertext | GCM tag (16), repeated
 *
 * Archives can be far larger than memory, so each chunk is encrypted and authenticated by itself,
 * and only released once it has passed. Every chunk holds exactly the chunk size except the last,
 * which may hold less, down to nothing.
 *
 * Each chunk's nonce is the prefix, its position, and a flag saying whether it is the last, and the
 * header is authenticated with every chunk. So chunks cannot be reordered or moved between archives,
 * and an archive cut short anywhere fails, because the chunk it now ends on was not sealed as last.
 *
 * Each archive gets its own key from the salt, so nonces can never repeat under one key.
 */
const MAGIC = Buffer.from("RIQBKP1\n", "latin1");
const SALT_BYTES = 32;
const NONCE_PREFIX_BYTES = 7;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 4 + SALT_BYTES + NONCE_PREFIX_BYTES;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
// A damaged header must not make the reader buffer an absurd amount before it fails.
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const KEY_INFO = "remoteiq-backup-archive-v1";

export const ARCHIVE_ENCRYPTION_FORMAT = "riq-stream-aes-256-gcm-v1";
export const ENCRYPTED_ARCHIVE_SUFFIX = ".enc";

const DECRYPT_FAILED =
    "The encrypted archive could not be decrypted: it is damaged or cut short, or DATA_ENCRYPTION_KEY_FILE is not the key it was made with.";

function chunkNonce(prefix: Buffer, index: number, last: boolean): Buffer {
    if (index > 0xffffffff) throw new Error("The archive is too large to encrypt.");
    const nonce = Buffer.alloc(12);
    prefix.copy(nonce, 0);
    nonce.writeUInt32BE(index, NONCE_PREFIX_BYTES);
    nonce[11] = last ? 1 : 0;
    return nonce;
}

/** Collects stream pieces without copying them until a whole chunk can be taken. */
class ByteQueue {
    private parts: Buffer[] = [];
    length = 0;

    push(part: Buffer): void {
        this.parts.push(part);
        this.length += part.length;
    }

    take(count: number): Buffer {
        const joined = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
        const taken = joined.subarray(0, count);
        const rest = joined.subarray(count);
        this.parts = rest.length > 0 ? [rest] : [];
        this.length = rest.length;
        return taken;
    }
}

export function createArchiveEncryptStream(chunkBytes = DEFAULT_CHUNK_BYTES): Transform {
    if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
        throw new Error("Invalid archive chunk size");
    }

    const salt = randomBytes(SALT_BYTES);
    const prefix = randomBytes(NONCE_PREFIX_BYTES);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(chunkBytes, 0);
    const header = Buffer.concat([MAGIC, size, salt, prefix]);
    const key = deriveDataKey(salt, KEY_INFO);

    const queue = new ByteQueue();
    let index = 0;
    let wroteHeader = false;

    const seal = (plain: Buffer, last: boolean): Buffer => {
        const cipher = createCipheriv("aes-256-gcm", key, chunkNonce(prefix, index++, last));
        cipher.setAAD(header);
        const body = Buffer.concat([cipher.update(plain), cipher.final()]);
        return Buffer.concat([body, cipher.getAuthTag()]);
    };

    return new Transform({
        transform(data: Buffer, _encoding, done: TransformCallback) {
            try {
                if (!wroteHeader) {
                    this.push(header);
                    wroteHeader = true;
                }
                queue.push(data);
                // Strictly more than a chunk, because the last chunk is only known at the end.
                while (queue.length > chunkBytes) this.push(seal(queue.take(chunkBytes), false));
                done();
            } catch (e) {
                done(e as Error);
            }
        },
        flush(done: TransformCallback) {
            try {
                if (!wroteHeader) this.push(header);
                this.push(seal(queue.take(queue.length), true));
                done();
            } catch (e) {
                done(e as Error);
            }
        },
    });
}

export function createArchiveDecryptStream(): Transform {
    const queue = new ByteQueue();
    let header: Buffer | null = null;
    let key: Buffer;
    let prefix: Buffer;
    let frameBytes = 0;
    let index = 0;

    const readHeader = (): void => {
        const raw = queue.take(HEADER_BYTES);
        if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) {
            throw new Error("This file is not an encrypted ADG RMM archive.");
        }
        const chunkBytes = raw.readUInt32BE(MAGIC.length);
        if (chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) throw new Error(DECRYPT_FAILED);

        const saltEnd = MAGIC.length + 4 + SALT_BYTES;
        key = deriveDataKey(raw.subarray(MAGIC.length + 4, saltEnd), KEY_INFO);
        prefix = raw.subarray(saltEnd, HEADER_BYTES);
        frameBytes = chunkBytes + TAG_BYTES;
        header = raw;
    };

    const open = (frame: Buffer, last: boolean): Buffer => {
        if (frame.length < TAG_BYTES) throw new Error(DECRYPT_FAILED);
        const decipher = createDecipheriv("aes-256-gcm", key, chunkNonce(prefix, index++, last));
        decipher.setAAD(header as Buffer);
        decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
        try {
            const body = decipher.update(frame.subarray(0, frame.length - TAG_BYTES));
            return Buffer.concat([body, decipher.final()]);
        } catch {
            throw new Error(DECRYPT_FAILED);
        }
    };

    return new Transform({
        transform(data: Buffer, _encoding, done: TransformCallback) {
            try {
                queue.push(data);
                if (!header && queue.length >= HEADER_BYTES) readHeader();
                if (header) {
                    while (queue.length > frameBytes) this.push(open(queue.take(frameBytes), false));
                }
                done();
            } catch (e) {
                done(e as Error);
            }
        },
        flush(done: TransformCallback) {
            try {
                if (!header) {
                    // Reached only by a file shorter than the header, whatever its first bytes are.
                    if (queue.length >= MAGIC.length && !queue.take(MAGIC.length).equals(MAGIC)) {
                        throw new Error("This file is not an encrypted ADG RMM archive.");
                    }
                    throw new Error(DECRYPT_FAILED);
                }
                const plain = open(queue.take(queue.length), true);
                if (plain.length > 0) this.push(plain);
                done();
            } catch (e) {
                done(e as Error);
            }
        },
    });
}

async function transformFile(input: string, output: string, stage: Transform): Promise<void> {
    try {
        await pipeline(
            fs.createReadStream(input),
            stage,
            fs.createWriteStream(output, { mode: 0o600, flags: "wx" }),
        );
    } catch (e: any) {
        // Part of an archive that failed to decrypt must not be mistaken for the whole thing.
        // EEXIST means the file was there first, and is not this run's to remove.
        if (e?.code !== "EEXIST") await fsp.rm(output, { force: true }).catch(() => undefined);
        throw e;
    }
}

export async function encryptArchiveFile(input: string, output: string, chunkBytes?: number): Promise<void> {
    return transformFile(input, output, createArchiveEncryptStream(chunkBytes));
}

export async function decryptArchiveFile(input: string, output: string): Promise<void> {
    return transformFile(input, output, createArchiveDecryptStream());
}

/** Looks at the file itself, so a restore does not have to trust the database about it. */
export async function isEncryptedArchiveFile(file: string): Promise<boolean> {
    const handle = await fsp.open(file, "r");
    try {
        const head = Buffer.alloc(MAGIC.length);
        const { bytesRead } = await handle.read(head, 0, MAGIC.length, 0);
        return bytesRead === MAGIC.length && head.equals(MAGIC);
    } finally {
        await handle.close();
    }
}

/** What the manifest records about an encrypted artifact. It holds nothing secret. */
export function archiveEncryptionManifest() {
    return { format: ARCHIVE_ENCRYPTION_FORMAT, keySource: "DATA_ENCRYPTION_KEY_FILE" };
}
