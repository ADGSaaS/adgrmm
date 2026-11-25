import { TextEncoder } from "node:util";

const MIN_JWT_SECRET_BYTES = 32;

const KNOWN_UNSAFE_VALUES = new Set([
    "dev-secret",
    "secret",
    "changeme",
    "change-me",
    "change_me",
    "replace-me",
    "replace_me",
]);

export function getJwtSecret(): string {
    const raw = process.env.JWT_SECRET;

    if (!raw || raw.trim().length === 0) {
        throw new Error(
            "JWT_SECRET is required. RemoteIQ refuses to start without an explicit JWT signing secret.",
        );
    }

    if (raw !== raw.trim()) {
        throw new Error(
            "JWT_SECRET must not contain leading or trailing whitespace.",
        );
    }

    const byteLength = new TextEncoder().encode(raw).byteLength;

    if (byteLength < MIN_JWT_SECRET_BYTES) {
        throw new Error(
            `JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes.`,
        );
    }

    const normalized = raw.toLowerCase();

    if (
        KNOWN_UNSAFE_VALUES.has(normalized) ||
        normalized.startsWith("changeme") ||
        normalized.startsWith("change_me") ||
        normalized.startsWith("change-me") ||
        normalized.startsWith("replace_me") ||
        normalized.startsWith("replace-me")
    ) {
        throw new Error(
            "JWT_SECRET uses an unsafe placeholder value.",
        );
    }

    return raw;
}
