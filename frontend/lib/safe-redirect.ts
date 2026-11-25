// lib/safe-redirect.ts
//
// A path taken from the address bar (?next=...) before the app navigates to it. Only a path on this same site gets through:
// "//evil.example", "/\evil.example" (browsers read a backslash as a slash), "https://..." and anything with control characters
// (tabs and newlines are dropped by the URL parser, so "/\t/evil.example" would become "//evil.example") fall back.

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

export function safeRedirectPath(raw: string | null | undefined, fallback = "/"): string {
    if (!raw) return fallback;
    if (UNSAFE_CHARS.test(raw)) return fallback;
    // exactly one leading slash
    if (raw[0] !== "/" || raw[1] === "/") return fallback;
    try {
        const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost.invalid";
        const url = new URL(raw, origin);
        if (url.origin !== origin) return fallback;
        return url.pathname + url.search + url.hash;
    } catch {
        return fallback;
    }
}
