// backend/src/common/admin-key.ts
//
// The break-glass admin API key (x-admin-api-key). Unset means the feature is off: no request is ever accepted on a key.
// A configured key must be long and must not be a placeholder copied from .env.example, and it is compared in constant time.
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_ADMIN_API_KEY_LENGTH = 24;

const PLACEHOLDER_MARKERS = [
    "change_me", "change-me", "changeme",
    "replace_me", "replace-me", "replaceme",
    "example", "placeholder", "your_", "your-", "generate_a", "generate-a",
];
const UNSAFE_EXACT = new Set(["secret", "admin", "password", "dev-secret", "e2e-admin", "test"]);

/** Throws when ADMIN_API_KEY is set to something unsafe. An unset or blank key is fine: the admin key is then disabled. */
export function assertAdminApiKeyConfig(raw: string | undefined = process.env.ADMIN_API_KEY): void {
    if (raw === undefined || raw.trim() === "") return;
    if (raw !== raw.trim()) throw new Error("ADMIN_API_KEY must not contain leading or trailing whitespace.");
    const lower = raw.toLowerCase();
    if (UNSAFE_EXACT.has(lower) || PLACEHOLDER_MARKERS.some((m) => lower.includes(m))) {
        throw new Error("ADMIN_API_KEY uses a placeholder value. Generate a long random secret (for example `openssl rand -hex 32`) or leave it unset to disable the admin key.");
    }
    if (raw.length < MIN_ADMIN_API_KEY_LENGTH) {
        throw new Error(`ADMIN_API_KEY must be at least ${MIN_ADMIN_API_KEY_LENGTH} characters, or left unset to disable the admin key.`);
    }
}

/**
 * Constant-time string comparison. Both sides are hashed first, so the comparison runs on equal-length buffers
 * and its time does not reveal the length of the expected value either.
 */
export function safeEqual(provided: unknown, expected: unknown): boolean {
    if (typeof provided !== "string" || typeof expected !== "string") return false;
    // The hash only makes both sides the same length for timingSafeEqual; nothing is stored. The key is a long random secret (see
    // assertAdminApiKeyConfig), not a person's password, so a slow password hash would add cost and no protection here.
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b) && provided.length === expected.length;
}

/** True only when an admin key is configured and the header value matches it exactly. */
export function adminKeyMatches(provided: unknown, expected: string | undefined = process.env.ADMIN_API_KEY): boolean {
    if (!expected || !expected.trim()) return false;
    if (Array.isArray(provided)) return false;
    if (typeof provided !== "string" || provided.length === 0) return false;
    return safeEqual(provided, expected);
}
