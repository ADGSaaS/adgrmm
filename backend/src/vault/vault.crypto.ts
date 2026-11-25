// backend/src/vault/vault.crypto.ts
//
// Sealing device secrets. AES-256-GCM with a key DERIVED (HKDF) from the server's data-encryption key for this one purpose, so a vault
// key never equals the key of other stored secrets. The device id, the kind and the ref are bound in as associated data: a row
// copied to another device, another kind or another ref does not open. The stored text is "v1:<key id>:<base64(iv|tag|ciphertext)>";
// the key id (a short hash of the derived key) says which key sealed it, so a key change shows as "wrong key", not as garbage.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deriveDataKey } from "../common/secret-box";

export const VAULT_KEY_VERSION = 1;
const PREFIX = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT = Buffer.from("remoteiq-device-secrets-v1", "utf8");
const INFO = "device-secrets:aes-256-gcm";

export type SecretBinding = { deviceId: string; kind: string; ref: string };

export class VaultCryptoError extends Error {
    constructor(readonly code: "wrong_key" | "tampered" | "bad_format") {
        super(code === "wrong_key" ? "The secret was sealed with another key." : code === "bad_format" ? "The stored secret is not in a known format." : "The stored secret failed its integrity check.");
    }
}

const key = (): Buffer => deriveDataKey(SALT, INFO);
export const vaultKeyId = (): string => createHash("sha256").update(key()).digest("hex").slice(0, 8);
const aad = (b: SecretBinding): Buffer => Buffer.from(`riq-device-secret|v${VAULT_KEY_VERSION}|${b.deviceId.toLowerCase()}|${b.kind}|${b.ref}`, "utf8");

export function sealSecret(plain: string, binding: SecretBinding): { ciphertext: string; keyVersion: number; keyId: string } {
    const k = key();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", k, iv);
    cipher.setAAD(aad(binding));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const keyId = createHash("sha256").update(k).digest("hex").slice(0, 8);
    return { ciphertext: `${PREFIX}${keyId}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`, keyVersion: VAULT_KEY_VERSION, keyId };
}

export function openSecret(stored: string, binding: SecretBinding): string {
    const m = /^v1:([0-9a-f]{8}):([A-Za-z0-9+/]+={0,2})$/.exec(String(stored ?? ""));
    if (!m) throw new VaultCryptoError("bad_format");
    const k = key();
    if (createHash("sha256").update(k).digest("hex").slice(0, 8) !== m[1]) throw new VaultCryptoError("wrong_key");
    const data = Buffer.from(m[2], "base64");
    if (data.length < IV_BYTES + TAG_BYTES) throw new VaultCryptoError("bad_format");
    try {
        const d = createDecipheriv("aes-256-gcm", k, data.subarray(0, IV_BYTES));
        d.setAAD(aad(binding));
        d.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([d.update(data.subarray(IV_BYTES + TAG_BYTES)), d.final()]).toString("utf8");
    } catch {
        throw new VaultCryptoError("tampered");
    }
}
