// backend/src/web-monitors/web-monitors.core.ts
//
// Domain, DNS and certificate monitoring: the rules, with no network and no database so they can be tested alone.
// What a monitor can be, what an administrator may save, and how a result (what a probe read) becomes a state:
//   ok       nothing to do
//   warning  needs attention soon (a certificate or a domain that runs out, a DNS record that is not what it was)
//   failed   broken or about to be (expired, untrusted, wrong name, a record that is missing)
//   error    could not be checked (the probe itself failed); only reported after several tries in a row
import { BadRequestException } from "@nestjs/common";

export const MONITOR_KINDS = ["certificate", "domain", "dns"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];
export type MonitorStatus = "pending" | "ok" | "warning" | "failed" | "error";

export const DNS_TYPES = ["A", "AAAA", "MX", "NS", "TXT", "CNAME"] as const;
export type DnsType = (typeof DNS_TYPES)[number];

export const MAX_MONITORS = 500;
/** An error is reported only when the check failed this many times in a row (one bad answer from a registry is not news). */
export const ERROR_REPORT_AFTER = 3;
/** Minutes between checks; a monitor that could not be checked is tried again sooner. */
export const INTERVAL_MIN: Record<MonitorKind, number> = { certificate: 360, domain: 1440, dns: 15 };
export const RETRY_MIN = 15;

export const DEFAULTS = {
    certificate: { warnDays: 30, failDays: 7 },
    domain: { warnDays: 60, failDays: 14 },
};

/* ------------------------------ what may be saved ------------------------------ */

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_RE = /^(\d{1,3})(\.\d{1,3}){3}$/;

/** A host name or an IPv4 address, in lower case, with nothing around it (no scheme, path, port or user). */
export function cleanHost(v: unknown, kind: MonitorKind): string {
    let s = String(v ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!s) throw new BadRequestException("Enter a host name.");
    if (/^[a-z]+:\/\//.test(s)) throw new BadRequestException("Enter only the name, such as example.com, without https:// or a path.");
    if (/[\s/?#@:]/.test(s)) throw new BadRequestException("Enter only the name, such as example.com, without a path, port or user name.");
    if (IPV4_RE.test(s)) {
        if (kind !== "certificate") throw new BadRequestException("A domain or DNS monitor needs a name, not an address.");
        if (s.split(".").some((p) => Number(p) > 255)) throw new BadRequestException("That is not a valid address.");
        return s;
    }
    // names with accents are looked up in their ASCII form
    try { s = new URL(`https://${s}`).hostname; } catch { throw new BadRequestException("That is not a valid host name."); }
    if (!HOST_RE.test(s) || !s.includes(".")) throw new BadRequestException("That is not a valid host name. Use a full name such as example.com.");
    return s;
}

export function cleanName(v: unknown, fallback: string): string {
    const s = String(v ?? "").replace(/\s+/g, " ").trim() || fallback;
    if (s.length > 120) throw new BadRequestException("The name is too long (120 characters at most).");
    return s;
}

export function cleanPort(v: unknown, kind: MonitorKind): number {
    if (kind !== "certificate") return 443;
    if (v === undefined || v === null || v === "") return 443;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new BadRequestException("The port must be a whole number from 1 to 65535.");
    return n;
}

const days = (v: unknown, def: number, label: string): number => {
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 730) throw new BadRequestException(`${label} must be a whole number of days from 1 to 730.`);
    return n;
};

export type DnsRecordRule = { type: DnsType; expected?: string[] };
export type MonitorConfig = { warnDays?: number; failDays?: number; records?: DnsRecordRule[]; baseline?: Record<string, string[]> };

export function cleanConfig(kind: MonitorKind, raw: unknown): MonitorConfig {
    const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (kind === "certificate" || kind === "domain") {
        const d = DEFAULTS[kind];
        const warnDays = days(c.warnDays, d.warnDays, "Warn before");
        const failDays = days(c.failDays, d.failDays, "Fail before");
        if (failDays >= warnDays) throw new BadRequestException("The failing limit has to be fewer days than the warning limit.");
        return { warnDays, failDays };
    }
    const records = Array.isArray(c.records) && c.records.length ? c.records : [{ type: "A" }, { type: "MX" }, { type: "NS" }];
    if (records.length > 6) throw new BadRequestException("Watch at most six record types.");
    const seen = new Set<string>();
    const out: DnsRecordRule[] = [];
    for (const r of records) {
        const type = String((r as any)?.type ?? "").toUpperCase() as DnsType;
        if (!(DNS_TYPES as readonly string[]).includes(type)) throw new BadRequestException(`The record type must be one of ${DNS_TYPES.join(", ")}.`);
        if (seen.has(type)) throw new BadRequestException(`${type} is listed twice.`);
        seen.add(type);
        const exp = (r as any)?.expected;
        if (exp === undefined || exp === null || (Array.isArray(exp) && exp.length === 0)) { out.push({ type }); continue; }
        if (!Array.isArray(exp) || exp.length > 20) throw new BadRequestException(`The expected ${type} values must be a list of at most 20.`);
        const values = [...new Set(exp.map((x: unknown) => normalizeValue(type, String(x ?? ""))))].filter(Boolean);
        if (values.some((x) => x.length > 1000)) throw new BadRequestException("An expected value is too long.");
        out.push({ type, expected: values });
    }
    return { records: out, baseline: sanitizeBaseline(c.baseline) };
}

function sanitizeBaseline(v: unknown): Record<string, string[]> | undefined {
    if (!v || typeof v !== "object") return undefined;
    const out: Record<string, string[]> = {};
    for (const t of DNS_TYPES) {
        const a = (v as Record<string, unknown>)[t];
        if (Array.isArray(a)) out[t] = a.map((x) => String(x)).slice(0, 50);
    }
    return Object.keys(out).length ? out : undefined;
}

/* ------------------------------ comparing DNS values ------------------------------ */

/** One form for a value, so a trailing dot or capital letters never count as a change. TXT keeps its case (it is free text). */
export function normalizeValue(type: DnsType, v: string): string {
    const s = v.trim();
    if (type === "TXT") return s;
    if (type === "MX") {
        const m = s.match(/^(\d+)\s+(\S+)$/);
        return m ? `${Number(m[1])} ${m[2].toLowerCase().replace(/\.$/, "")}` : s.toLowerCase().replace(/\.$/, "");
    }
    if (type === "AAAA") return s.toLowerCase();
    return s.toLowerCase().replace(/\.$/, "");
}

const sorted = (a: string[]) => [...a].sort();
const same = (a: string[], b: string[]) => a.length === b.length && sorted(a).every((x, i) => x === sorted(b)[i]);

export type DnsResult = Record<string, string[]>;
export type Evaluation = { status: Exclude<MonitorStatus, "pending" | "error">; detail: string; expiresAt: Date | null };

/** What the records are, against what they should be (a list the person gave) or, with none given, against what they were. */
export function evalDns(current: DnsResult, cfg: MonitorConfig): Evaluation & { baselineToStore?: Record<string, string[]>; changed: string[] } {
    const rules = cfg.records ?? [];
    const problems: string[] = [];
    const warnings: string[] = [];
    const baseline = cfg.baseline;
    const toStore: Record<string, string[]> = { ...(baseline ?? {}) };
    let stored = false;
    for (const r of rules) {
        const now = (current[r.type] ?? []).map((x) => normalizeValue(r.type, x));
        if (r.expected && r.expected.length) {
            const want = r.expected;
            const missing = want.filter((x) => !now.includes(x));
            // TXT sets carry many unrelated entries: only the wanted ones have to be there. Other types must match exactly.
            const extra = r.type === "TXT" ? [] : now.filter((x) => !want.includes(x));
            if (missing.length) problems.push(`${r.type} is missing ${missing.join(", ")}`);
            if (extra.length) problems.push(`${r.type} has unexpected ${extra.join(", ")}`);
        } else if (baseline && baseline[r.type]) {
            if (!same(now, baseline[r.type])) {
                const was = baseline[r.type];
                const gone = was.filter((x) => !now.includes(x)), added = now.filter((x) => !was.includes(x));
                warnings.push(`${r.type} changed${gone.length ? `: no longer ${gone.join(", ")}` : ""}${added.length ? `${gone.length ? ";" : ":"} now also ${added.join(", ")}` : ""}`);
            }
        } else {
            toStore[r.type] = now;
            stored = true;
        }
    }
    const changed = [...problems, ...warnings];
    if (problems.length) return { status: "failed", detail: problems.join("; "), expiresAt: null, changed };
    if (warnings.length) return { status: "warning", detail: `${warnings.join("; ")}. If this was on purpose, accept the new records.`, expiresAt: null, changed };
    return { status: "ok", detail: "The records are as they should be.", expiresAt: null, changed, ...(stored ? { baselineToStore: toStore } : {}) };
}

/* ------------------------------ certificates and domains ------------------------------ */

export type CertificateResult = {
    subject?: string; issuer?: string; validFrom?: string; validTo?: string; names?: string[]; protocol?: string; fingerprint?: string;
    trusted: boolean; authError?: string | null; nameError?: string | null;
};

const DAY_MS = 86_400_000;
/** Whole days from now to a date; negative once it has passed (a moment ago is 0 days, so check `to < now` for "has passed"). */
export const daysLeft = (to: Date, now: Date) => Math.trunc((to.getTime() - now.getTime()) / DAY_MS);
const agoText = (left: number) => (left === 0 ? "today" : `${-left} ${-left === 1 ? "day" : "days"} ago`);

export function evalCertificate(r: CertificateResult, cfg: MonitorConfig, now = new Date()): Evaluation {
    const d = DEFAULTS.certificate;
    const warn = cfg.warnDays ?? d.warnDays, fail = cfg.failDays ?? d.failDays;
    const to = r.validTo ? new Date(r.validTo) : null;
    if (!to || Number.isNaN(to.getTime())) return { status: "failed", detail: "The server showed no certificate dates.", expiresAt: null };
    const left = daysLeft(to, now);
    const expired = to.getTime() < now.getTime();
    const problems: string[] = [];
    if (expired) problems.push(`expired ${agoText(left)}`);
    if (!r.trusted && !expired) problems.push(`not trusted (${r.authError || "unknown issuer"})`);
    else if (!r.trusted && r.authError && !/expired/i.test(r.authError)) problems.push(`not trusted (${r.authError})`);
    if (r.nameError) problems.push(`the name does not match: ${r.nameError}`);
    if (problems.length) return { status: "failed", detail: `The certificate is ${problems.join("; ")}.`, expiresAt: to };
    if (left <= fail) return { status: "failed", detail: `The certificate runs out in ${left} ${left === 1 ? "day" : "days"} (${to.toISOString().slice(0, 10)}).`, expiresAt: to };
    if (left <= warn) return { status: "warning", detail: `The certificate runs out in ${left} days (${to.toISOString().slice(0, 10)}).`, expiresAt: to };
    return { status: "ok", detail: `Valid for ${left} more days (until ${to.toISOString().slice(0, 10)}), issued by ${r.issuer || "an unknown issuer"}.`, expiresAt: to };
}

export type DomainResult = { expiresAt?: string | null; registrar?: string | null; status?: string[]; nameservers?: string[] };
/** RDAP statuses that mean the domain is already being taken away or has stopped working. */
const BAD_DOMAIN_STATUS = /^(client|server) ?hold$|pending ?delete|redemption ?period|pending ?restore/i;

export function evalDomain(r: DomainResult, cfg: MonitorConfig, now = new Date()): Evaluation {
    const d = DEFAULTS.domain;
    const warn = cfg.warnDays ?? d.warnDays, fail = cfg.failDays ?? d.failDays;
    const to = r.expiresAt ? new Date(r.expiresAt) : null;
    if (!to || Number.isNaN(to.getTime())) return { status: "warning", detail: "The registry does not say when this domain runs out.", expiresAt: null };
    const left = daysLeft(to, now);
    const expired = to.getTime() < now.getTime();
    const bad = (r.status ?? []).filter((s) => BAD_DOMAIN_STATUS.test(s.replace(/\s+/g, "")));
    const date = to.toISOString().slice(0, 10);
    if (expired) return { status: "failed", detail: `The domain expired ${agoText(left)} (${date}).`, expiresAt: to };
    if (bad.length) return { status: "failed", detail: `The registry marks this domain: ${bad.join(", ")}.`, expiresAt: to };
    if (left <= fail) return { status: "failed", detail: `The domain runs out in ${left} ${left === 1 ? "day" : "days"} (${date}).`, expiresAt: to };
    if (left <= warn) return { status: "warning", detail: `The domain runs out in ${left} days (${date}).`, expiresAt: to };
    return { status: "ok", detail: `Registered until ${date} (${left} more days)${r.registrar ? `, at ${r.registrar}` : ""}.`, expiresAt: to };
}

/* ------------------------------ from state to news ------------------------------ */

export type Transition = { next: MonitorStatus; errorCount: number; notify: "failed" | "recovered" | null; severity?: "warning" | "failed" | "error" };

/**
 * The state after a check, and whether anyone should hear about it. News is a change into warning or failed, a change out of them back to
 * ok, and an error that lasted (ERROR_REPORT_AFTER checks in a row). A single bad check that was an error does not change the state.
 */
export function transition(prev: MonitorStatus, prevErrors: number, outcome: { status: "ok" | "warning" | "failed" } | { error: string }): Transition {
    if ("error" in outcome) {
        const errorCount = prevErrors + 1;
        // keep showing the last good state until the errors last
        if (errorCount < ERROR_REPORT_AFTER) return { next: prev === "pending" ? "pending" : prev, errorCount, notify: null };
        return { next: "error", errorCount, notify: prev === "error" ? null : "failed", severity: "error" };
    }
    const s = outcome.status;
    const bad = (x: MonitorStatus) => x === "warning" || x === "failed" || x === "error";
    if (s === "ok") return { next: "ok", errorCount: 0, notify: bad(prev) ? "recovered" : null };
    // warning to failed is news again (it got worse); failed to warning is not
    const notify = prev === s ? null : prev === "failed" && s === "warning" ? null : "failed";
    return { next: s, errorCount: 0, notify, severity: s };
}

/** When to look again. */
export function nextCheckAfter(kind: MonitorKind, hadError: boolean, from = new Date()): Date {
    return new Date(from.getTime() + (hadError ? RETRY_MIN : INTERVAL_MIN[kind]) * 60_000);
}
