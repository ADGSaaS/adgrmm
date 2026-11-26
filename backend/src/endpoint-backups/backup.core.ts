// backend/src/endpoint-backups/backup.core.ts
//
// Backup status of customers' computers: what a device's report is allowed to say, how it is judged, and what an administrator may set.
// Pure (no database, no network) so it can be tested alone. A device reports, product by product, what protects it and when that last worked;
// ADG RMM judges the age. Backup software that does not let anyone read its results from the device is reported as present but "unknown":
// that is not the same as protected, and it is not a fault either.
import { BadRequestException } from "@nestjs/common";

export const PRODUCT_KINDS = ["image", "file", "snapshot", "cloud", "agent"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];
export type ReportedState = "ok" | "warning" | "failed" | "unknown";
export type Overall = "ok" | "warning" | "failed" | "unknown" | "none";

export type Product = { product: string; kind: ProductKind; state: ReportedState; lastSuccessAt: Date | null; lastAttemptAt: Date | null; detail: string };

export type Settings = { enabled: boolean; warnHours: number; failHours: number; checkHours: number; alerts: boolean };
export const DEFAULT_SETTINGS: Settings = { enabled: false, warnHours: 48, failHours: 168, checkHours: 6, alerts: true };

export const MAX_PRODUCTS = 40;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export class BackupOutputError extends Error { }

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * What a device printed. One line per product: P|product|kind|last success|last attempt|state|detail, times as 2026-01-31T08:00:00Z or empty,
 * and a last line D|ok. Anything that is not in that shape is refused, so a script that printed something else (or was cut off) is an error
 * and never a backup status.
 */
export function parseBackupOutput(stdout: string): Product[] {
    const lines = String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const done = lines.findIndex((l) => l === "D|ok");
    const err = lines.find((l) => l.startsWith("E|"));
    if (err) throw new BackupOutputError(clean(err.slice(2), 300) || "The device could not check its backups.");
    if (done < 0) throw new BackupOutputError("The device did not finish checking its backups.");
    const out: Product[] = [];
    const seen = new Set<string>();
    for (const l of lines) {
        if (!l.startsWith("P|")) continue;
        const f = l.split("|");
        if (f.length < 7) throw new BackupOutputError("The device reported a backup in a form that could not be read.");
        const [, product, kind, success, attempt, state] = f;
        const detail = f.slice(6).join("|");
        const name = clean(product, 120);
        if (!name) throw new BackupOutputError("The device reported a backup with no name.");
        if (!(PRODUCT_KINDS as readonly string[]).includes(kind)) throw new BackupOutputError(`The device reported an unknown kind of backup (${clean(kind, 20)}).`);
        if (!["ok", "warning", "failed", "unknown"].includes(state)) throw new BackupOutputError(`The device reported an unknown state (${clean(state, 20)}).`);
        const date = (v: string): Date | null => {
            if (!v) return null;
            if (!ISO.test(v)) throw new BackupOutputError("The device reported a time that could not be read.");
            const d = new Date(v);
            if (Number.isNaN(d.getTime())) throw new BackupOutputError("The device reported a time that could not be read.");
            return d;
        };
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ product: name, kind: kind as ProductKind, state: state as ReportedState, lastSuccessAt: date(success), lastAttemptAt: date(attempt), detail: clean(detail, 300) });
    }
    return out.slice(0, MAX_PRODUCTS);
}

export type Judged = Product & { status: Overall; ageHours: number | null; why: string };

const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;
const ago = (h: number) => (h < 1 ? "less than an hour ago" : h < 48 ? `${Math.floor(h)} hours ago` : `${Math.floor(h / 24)} days ago`);

/** One product against the thresholds. */
export function judgeProduct(p: Product, s: Pick<Settings, "warnHours" | "failHours">, now = new Date()): Judged {
    const age = p.lastSuccessAt ? Math.max(0, hoursBetween(p.lastSuccessAt, now)) : null;
    const base = { ...p, ageHours: age };
    if (p.state === "unknown") return { ...base, status: "unknown", why: p.detail || "Installed, but its results cannot be read from the computer." };
    if (age === null) return { ...base, status: p.state === "failed" ? "failed" : "warning", why: p.state === "failed" ? `The last backup failed${p.detail ? `: ${p.detail}` : ""}.` : p.detail || "No successful backup was found." };
    const stale = age > s.failHours ? "failed" : age > s.warnHours ? "warning" : "ok";
    // a last attempt that failed after the last success is worth saying even while the success is still recent
    const failedSince = p.state === "failed" && (!p.lastAttemptAt || p.lastAttemptAt.getTime() >= (p.lastSuccessAt as Date).getTime());
    const status: Overall = failedSince ? (stale === "ok" ? "warning" : "failed") : p.state === "warning" && stale === "ok" ? "warning" : stale;
    const why = failedSince ? `The last attempt failed${p.detail ? ` (${p.detail})` : ""}; the last success was ${ago(age)}.`
        : status === "ok" ? `Last success ${ago(age)}.` : `Last success ${ago(age)}.${p.state === "warning" && p.detail ? ` ${p.detail}` : ""}`;
    return { ...base, status, why };
}

export type DeviceVerdict = { overall: Overall; detail: string; lastSuccessAt: Date | null; products: Judged[] };

const RANK: Record<Overall, number> = { ok: 0, warning: 1, failed: 2, unknown: 3, none: 4 };

/**
 * The device as a whole. It is protected when some real backup (not just restore points on the same disk) worked recently. Restore points
 * alone are a warning. Software that does not show its results is "unknown". Nothing at all is "none".
 */
export function judgeDevice(products: Product[], s: Pick<Settings, "warnHours" | "failHours">, now = new Date()): DeviceVerdict {
    if (products.length === 0) return { overall: "none", detail: "No backup software or restore points were found on this computer.", lastSuccessAt: null, products: [] };
    const judged = products.map((p) => judgeProduct(p, s, now));
    const last = judged.reduce<Date | null>((m, j) => (j.lastSuccessAt && (!m || j.lastSuccessAt > m) ? j.lastSuccessAt : m), null);
    const real = judged.filter((j) => j.kind !== "snapshot" && j.status !== "unknown");
    const readable = judged.filter((j) => j.status !== "unknown");
    if (real.some((j) => j.status === "ok")) return { overall: "ok", detail: real.filter((j) => j.status === "ok").map((j) => `${j.product}: ${j.why}`).join(" "), lastSuccessAt: last, products: judged };
    if (real.length) {
        const worst = real.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
        return { overall: worst.status, detail: `${worst.product}: ${worst.why}`, lastSuccessAt: last, products: judged };
    }
    if (readable.length) return { overall: "warning", detail: `Only restore points on this computer's own disk were found (${readable.map((j) => j.product).join(", ")}). They do not survive a failed disk or a ransomware attack.`, lastSuccessAt: last, products: judged };
    return { overall: "unknown", detail: `${judged.map((j) => j.product).join(", ")} found, but its results cannot be read from the computer. Check it in its own console.`, lastSuccessAt: last, products: judged };
}

/** What to tell people: a computer that is not protected (a problem to act on), as opposed to one that is merely unreadable. */
export const needsAttention = (o: Overall) => o === "failed" || o === "none" || o === "warning";

export function cleanSettings(input: Partial<Record<keyof Settings, unknown>>, before: Settings): Settings {
    const out = { ...before };
    for (const k of ["enabled", "alerts"] as const) {
        if (input[k] === undefined) continue;
        if (typeof input[k] !== "boolean") throw new BadRequestException(`${k} must be true or false.`);
        out[k] = input[k] as boolean;
    }
    const num = (k: "warnHours" | "failHours" | "checkHours", min: number, max: number, label: string) => {
        if (input[k] === undefined) return;
        const n = Number(input[k]);
        if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${label} must be a whole number from ${min} to ${max}.`);
        out[k] = n;
    };
    num("warnHours", 1, 8760, "The warning age (hours)");
    num("failHours", 1, 8760, "The failing age (hours)");
    num("checkHours", 1, 168, "How often to check (hours)");
    if (out.failHours <= out.warnHours) throw new BadRequestException("The failing age has to be longer than the warning age.");
    return out;
}
