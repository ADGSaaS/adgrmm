// lib/url-params.ts
//
// Pages the Overview links to open already filtered. Reads one query parameter once, without failing when there is no window
// (rendering on the server) or the value is not one the page knows.

/** The value of a query parameter when it is one of `allowed`; otherwise null. */
export function readParam<T extends string>(name: string, allowed: readonly T[]): T | null {
    if (typeof window === "undefined") return null;
    try {
        const v = new URLSearchParams(window.location.search).get(name);
        return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
    } catch {
        return null;
    }
}

/** A customer id from the address (a UUID), or null. */
export function readIdParam(name: string): string | null {
    if (typeof window === "undefined") return null;
    try {
        const v = new URLSearchParams(window.location.search).get(name);
        return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
    } catch {
        return null;
    }
}
