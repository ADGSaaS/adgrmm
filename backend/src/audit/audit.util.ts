// backend/src/audit/audit.util.ts
import { isIP } from "node:net";

const MAX_STRING = 500;
const MAX_ARRAY = 200;
const MAX_DEPTH = 4;

/**
 * A second net behind the per-route allow-lists: a field with one of these names is never kept,
 * even if someone adds it to an allow-list or passes it to record() by hand.
 */
const SENSITIVE_KEY =
    /pass(word|wd|phrase|code)?|secret|token|api[-_]?key|^key$|enrollmentkey|private|credential|authorization|cookie|^otp$|^code$|recovery|script|^env$|^args$|content|^body$/i;

export function cleanText(value: unknown, max: number): string | null {
    if (value === null || value === undefined) return null;
    // Postgres text and jsonb both reject NUL, which would otherwise lose the whole event.
    const text = String(value).replace(/\u0000/g, "").trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max) : text;
}

export function scrubDetails(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return cleanText(value, MAX_STRING);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (value instanceof Date) return value.toISOString();
    if (depth >= MAX_DEPTH) return null;
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY).map((item) => scrubDetails(item, depth + 1));
    }
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (SENSITIVE_KEY.test(key)) continue;
            const cleaned = scrubDetails(item, depth + 1);
            if (cleaned !== null) out[key] = cleaned;
        }
        return out;
    }
    return null;
}

const isPlain = (value: unknown) => ["string", "number", "boolean"].includes(typeof value);

/** Keeps only allow-listed fields, and only plain values or lists of them. */
export function pickFields(body: unknown, fields: readonly string[] | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!fields?.length || !body || typeof body !== "object") return out;
    for (const field of fields) {
        const value = (body as Record<string, unknown>)[field];
        if (isPlain(value) || (Array.isArray(value) && value.every(isPlain))) out[field] = value;
    }
    return out;
}

/** Same order as the sign-in rate limiter: the firewall only admits our own proxies. */
export function clientIpOf(req: { headers?: Record<string, unknown>; socket?: { remoteAddress?: string } }): string | null {
    const header = (name: string) => {
        const value = req.headers?.[name];
        return typeof value === "string" ? value : "";
    };
    const candidates = [
        header("cf-connecting-ip").trim(),
        (header("x-forwarded-for").split(",")[0] ?? "").trim(),
        req.socket?.remoteAddress ?? "",
    ];
    const ip = candidates.find((candidate) => isIP(candidate));
    // Node reports IPv4 clients on a dual-stack socket as ::ffff:1.2.3.4.
    return ip ? ip.replace(/^::ffff:(?=\d+\.)/i, "") : null;
}

/** Spreadsheets run a cell that starts with one of these, so it is forced to be plain text. */
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\n]/;

export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return '""';
    let text: string;
    if (value instanceof Date) text = value.toISOString();
    else if (typeof value === "object") text = JSON.stringify(value);
    else text = String(value);
    if (FORMULA_START.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(cells: unknown[]): string {
    return `${cells.map(csvCell).join(",")}\r\n`;
}
