// backend/src/common/secret-box.ts
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

/**
 * The key for secrets stored in the database, kept in a file outside it so a stolen database dump
 * does not reveal them. Losing the file means those secrets have to be entered again.
 */
function key(): Buffer {
    if (cachedKey) return cachedKey;

    const path = process.env.DATA_ENCRYPTION_KEY_FILE?.trim();
    const raw = (path ? readFileSync(path, "utf8") : process.env.DATA_ENCRYPTION_KEY ?? "").trim();
    if (!raw) throw new Error("DATA_ENCRYPTION_KEY_FILE is not set, so secrets cannot be stored safely.");

    // Hashed, so a key of any length or format yields the 32 bytes AES-256 needs.
    const derived: Buffer = createHash("sha256").update(Buffer.from(raw, "utf8")).digest();
    cachedKey = derived;
    return derived;
}

export function isEncrypted(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** Values saved before encryption existed are returned as they are, so they keep working until re-saved. */
export function decryptSecret(stored: string): string {
    if (!isEncrypted(stored)) return stored;

    const data = Buffer.from(stored.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, IV_BYTES));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

/** A separate key for one purpose, so what it protects never shares a key with stored secrets. */
export function deriveDataKey(salt: Buffer, info: string): Buffer {
    return Buffer.from(hkdfSync("sha256", key(), salt, info, 32));
}

/** Whether secrets can be encrypted right now. Starting up must not depend on it. */
export function hasDataKey(): boolean {
    try {
        key();
        return true;
    } catch {
        return false;
    }
}

/**
 * For the values of a JSON map of secrets, which can be objects as well as strings, such as a
 * Google service account. Encrypting them one by one keeps the keys readable, so "is this set?"
 * can be answered without the key.
 */
export function sealSecretValue(value: unknown): string {
    return encryptSecret(JSON.stringify(value));
}

/** The map as the code that uses the secrets needs it. Values from before encryption pass through. */
export function openSecretMap(stored: unknown): Record<string, any> {
    const out: Record<string, any> = {};
    if (!stored || typeof stored !== "object") return out;

    for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
        if (typeof value !== "string" || !isEncrypted(value)) {
            out[name] = value;
            continue;
        }
        try {
            out[name] = JSON.parse(decryptSecret(value));
        } catch {
            // The reason would not help and the value must stay out of logs.
            throw new Error("A stored secret could not be decrypted. Check DATA_ENCRYPTION_KEY_FILE.");
        }
    }
    return out;
}

/** For tests. */
export function resetSecretBoxForTests(): void {
    cachedKey = null;
}
