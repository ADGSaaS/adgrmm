// backend/src/policies/policy-engine.ts
//
// Policies, as plain functions with no database: what a policy may contain, and how the ones that apply to a
// device combine into the one answer that device gets, with the reason for every value. See docs/design/POLICIES.md.
import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";

/* ------------------------------ what a policy holds ------------------------------ */

export const LEVELS = ["global", "customer", "site", "tag", "device"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_RANK: Record<Level, number> = { global: 0, customer: 1, site: 2, tag: 3, device: 4 };
export const LEVEL_LABEL: Record<Level, string> = { global: "Everyone", customer: "Customer", site: "Site", tag: "Tag", device: "Device" };

export const OS_CHOICES = ["any", "windows", "linux", "macos"] as const;
export type OsChoice = (typeof OS_CHOICES)[number];
export type DeviceOs = "windows" | "linux" | "macos" | "unknown";

export type Sections = {
    alerting?: { offlineAfterMinutes?: number; renotifyAfterHours?: number; autoTicket?: boolean; autoTicketMinSeverity?: "WARN" | "CRIT"; autoResolveTicket?: boolean; holdMinutes?: number; reopenWithinMinutes?: number };
    hours?: { days: number[]; start: string; end: string; timezone: string };
    remote?: { consent?: "off" | "notice" | "consent"; record?: boolean };
    software?: { required?: string[]; banned?: string[]; waive?: string[] };
    checks?: { profileIds: string[] };
    maintenance?: { windows: { name: string; days: number[]; start: string; end: string; timezone: string }[]; muteAlerts: boolean };
    patching?: { approve?: "none" | "critical" | "all"; installIn?: "anytime" | "maintenance"; reboot?: "never" | "maintenance" | "always"; appScanHours?: number; appUpdate?: "none" | "listed" | "all"; appUpdateIn?: "anytime" | "maintenance" };
    security?: { scanHours?: number; bitlockerEscrow?: "off" | "on" };
    laps?: { enabled?: boolean; account?: string; passwordLength?: number; rotateDays?: number; rotateAfterRevealMinutes?: number };
};

/** Settings that hold one value: the most specific policy that sets one wins. */
export const SCALAR_KEYS = [
    "alerting.offlineAfterMinutes",
    "alerting.renotifyAfterHours",
    "alerting.autoTicket",
    "alerting.autoTicketMinSeverity",
    "alerting.autoResolveTicket",
    "alerting.holdMinutes",
    "alerting.reopenWithinMinutes",
    "hours",
    "remote.consent",
    "remote.record",
    "maintenance",
    "patching.approve",
    "patching.installIn",
    "patching.reboot",
    "patching.appScanHours",
    "patching.appUpdate",
    "patching.appUpdateIn",
    "security.scanHours",
    "security.bitlockerEscrow",
    "laps.enabled",
    "laps.account",
    "laps.passwordLength",
    "laps.rotateDays",
    "laps.rotateAfterRevealMinutes",
] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];

/** Settings that are lists: what every matching policy adds is kept. */
export const LIST_KEYS = ["software.required", "software.banned", "checks.profiles"] as const;
export type ListKey = (typeof LIST_KEYS)[number];

export const SETTING_LABEL: Record<string, string> = {
    "alerting.offlineAfterMinutes": "Minutes offline before an alert",
    "alerting.renotifyAfterHours": "Hours between reminders",
    "alerting.autoTicket": "Open a ticket for an alert",
    "alerting.autoTicketMinSeverity": "Lowest severity that opens a ticket",
    "alerting.autoResolveTicket": "Close the ticket when the alert clears",
    "alerting.holdMinutes": "Minutes a check must keep failing before it alerts",
    "alerting.reopenWithinMinutes": "Minutes a cleared alert is reopened instead of starting a new one",
    hours: "Business hours",
    "remote.consent": "Remote access notice",
    "remote.record": "Record remote sessions",
    maintenance: "Maintenance windows",
    "patching.approve": "Install updates automatically",
    "patching.installIn": "When updates are installed",
    "patching.reboot": "Restarting for updates",
    "patching.appScanHours": "Scan for outdated programs every (hours)",
    "patching.appUpdate": "Update other programs automatically",
    "patching.appUpdateIn": "When other programs are updated",
    "security.scanHours": "Security scan every (hours)",
    "security.bitlockerEscrow": "Store disk recovery keys (BitLocker, LUKS) on this server",
    "laps.enabled": "Manage the local administrator password",
    "laps.account": "Managed local administrator account",
    "laps.passwordLength": "Local administrator password length",
    "laps.rotateDays": "Change the local administrator password every (days)",
    "laps.rotateAfterRevealMinutes": "Change the password after it was revealed (minutes, 0 = never)",
    "software.required": "Required software",
    "software.banned": "Banned software",
    "checks.profiles": "Check profiles",
};

const UUID_LOOSE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string) {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new BadRequestException(`${where} has a setting we do not know: ${k}.`);
}

function whole(v: unknown, min: number, max: number, label: string): number {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${label} must be a whole number from ${min} to ${max}.`);
    return n;
}

function bool(v: unknown, label: string): boolean {
    if (typeof v !== "boolean") throw new BadRequestException(`${label} must be on or off.`);
    return v;
}

function names(v: unknown, label: string): string[] {
    if (!Array.isArray(v)) throw new BadRequestException(`${label} must be a list.`);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of v) {
        const s = String(raw ?? "").trim();
        if (!s) continue;
        if (s.length > 100) throw new BadRequestException(`An entry in ${label} is too long (100 characters at most).`);
        if (seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        out.push(s);
    }
    if (out.length > 200) throw new BadRequestException(`${label} can have 200 entries at most.`);
    return out;
}

/** Names the managed account may not have: the built-in and well-known accounts RemoteIQ must never touch. */
export const RESERVED_ACCOUNT_NAMES = ["administrator", "guest", "defaultaccount", "system", "wdagutilityaccount", "krbtgt", "localservice", "networkservice", "root", "admin", "administrators", "users"];
const LAPS_ACCOUNT = /^[A-Za-z0-9._-]{1,20}$/;

/** The name of the account RemoteIQ manages: 1 to 20 characters of letters, digits, dot, underscore and hyphen, not a reserved name. */
export function cleanLapsAccount(v: unknown): string {
    const s = typeof v === "string" ? v.trim() : "";
    if (!LAPS_ACCOUNT.test(s)) throw new BadRequestException("The account name must be 1 to 20 characters: letters, digits, dot, underscore or hyphen.");
    if (RESERVED_ACCOUNT_NAMES.includes(s.toLowerCase()) || /^[.-]|[.]$/.test(s)) throw new BadRequestException("That account name is reserved or not allowed. RemoteIQ never manages the built-in Administrator or other system accounts; choose another name.");
    return s;
}

/** Check what a person sent for the sections. Empty sections are dropped, unknown ones are refused. */
export function cleanSections(input: unknown, isTimezone: (tz: string) => boolean): Sections {
    if (input === undefined || input === null) return {};
    if (!isObject(input)) throw new BadRequestException("The settings are not valid.");
    onlyKeys(input, ["alerting", "hours", "remote", "software", "checks", "maintenance", "patching", "security", "laps"], "The policy");
    const out: Sections = {};

    if (input.alerting !== undefined) {
        if (!isObject(input.alerting)) throw new BadRequestException("Alerting is not valid.");
        const a = input.alerting;
        onlyKeys(a, ["offlineAfterMinutes", "renotifyAfterHours", "autoTicket", "autoTicketMinSeverity", "autoResolveTicket", "holdMinutes", "reopenWithinMinutes"], "Alerting");
        const r: NonNullable<Sections["alerting"]> = {};
        if (a.offlineAfterMinutes !== undefined && a.offlineAfterMinutes !== null) r.offlineAfterMinutes = whole(a.offlineAfterMinutes, 1, 1440, "Minutes offline");
        if (a.renotifyAfterHours !== undefined && a.renotifyAfterHours !== null) r.renotifyAfterHours = whole(a.renotifyAfterHours, 0, 720, "Hours between reminders");
        if (a.autoTicket !== undefined && a.autoTicket !== null) r.autoTicket = bool(a.autoTicket, "Open a ticket");
        if (a.autoTicketMinSeverity !== undefined && a.autoTicketMinSeverity !== null) {
            if (a.autoTicketMinSeverity !== "WARN" && a.autoTicketMinSeverity !== "CRIT") throw new BadRequestException("The lowest severity that opens a ticket must be WARN or CRIT.");
            r.autoTicketMinSeverity = a.autoTicketMinSeverity;
        }
        if (a.autoResolveTicket !== undefined && a.autoResolveTicket !== null) r.autoResolveTicket = bool(a.autoResolveTicket, "Close the ticket");
        if (a.holdMinutes !== undefined && a.holdMinutes !== null) r.holdMinutes = whole(a.holdMinutes, 0, 1440, "Minutes a check must keep failing");
        if (a.reopenWithinMinutes !== undefined && a.reopenWithinMinutes !== null) r.reopenWithinMinutes = whole(a.reopenWithinMinutes, 0, 1440, "Minutes to reopen a cleared alert");
        if (Object.keys(r).length) out.alerting = r;
    }

    if (input.hours !== undefined && input.hours !== null) {
        if (!isObject(input.hours)) throw new BadRequestException("Business hours are not valid.");
        const h = input.hours;
        onlyKeys(h, ["days", "start", "end", "timezone"], "Business hours");
        const days = Array.isArray(h.days) ? [...new Set(h.days.map(Number))].sort((x, y) => x - y) : [];
        if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequestException("Choose at least one working day.");
        if (typeof h.start !== "string" || typeof h.end !== "string" || !TIME.test(h.start) || !TIME.test(h.end)) throw new BadRequestException("Times must look like 08:00.");
        if (typeof h.timezone !== "string" || !isTimezone(h.timezone)) throw new BadRequestException("That time zone is not one we know.");
        out.hours = { days, start: h.start, end: h.end, timezone: h.timezone };
    }

    if (input.remote !== undefined && input.remote !== null) {
        if (!isObject(input.remote)) throw new BadRequestException("Remote access is not valid.");
        onlyKeys(input.remote, ["consent", "record"], "Remote access");
        const c = input.remote.consent;
        const rec = input.remote.record;
        if (c !== undefined && c !== null) {
            if (c !== "off" && c !== "notice" && c !== "consent") throw new BadRequestException('Remote access must be "off", "notice" or "consent".');
            out.remote = { consent: c };
        }
        if (rec !== undefined && rec !== null) {
            if (typeof rec !== "boolean") throw new BadRequestException("Recording remote sessions must be on or off.");
            out.remote = { ...(out.remote ?? {}), record: rec };
        }
    }

    if (input.software !== undefined && input.software !== null) {
        if (!isObject(input.software)) throw new BadRequestException("Software is not valid.");
        const s = input.software;
        onlyKeys(s, ["required", "banned", "waive"], "Software");
        const r: NonNullable<Sections["software"]> = {};
        if (s.required !== undefined) { const v = names(s.required, "Required software"); if (v.length) r.required = v; }
        if (s.banned !== undefined) { const v = names(s.banned, "Banned software"); if (v.length) r.banned = v; }
        if (s.waive !== undefined) { const v = names(s.waive, "Allowed software"); if (v.length) r.waive = v; }
        if (Object.keys(r).length) out.software = r;
    }

    if (input.checks !== undefined && input.checks !== null) {
        if (!isObject(input.checks)) throw new BadRequestException("Checks are not valid.");
        onlyKeys(input.checks, ["profileIds"], "Checks");
        const ids = input.checks.profileIds;
        if (ids !== undefined) {
            if (!Array.isArray(ids)) throw new BadRequestException("Check profiles must be a list.");
            const list = [...new Set(ids.map((x) => String(x ?? "").toLowerCase()))];
            if (list.some((x) => !UUID_LOOSE.test(x))) throw new BadRequestException("A check profile is not valid.");
            if (list.length > 100) throw new BadRequestException("A policy can use 100 check profiles at most.");
            if (list.length) out.checks = { profileIds: list };
        }
    }

    if (input.maintenance !== undefined && input.maintenance !== null) {
        if (!isObject(input.maintenance)) throw new BadRequestException("Maintenance windows are not valid.");
        const m = input.maintenance;
        onlyKeys(m, ["windows", "muteAlerts"], "Maintenance windows");
        const raw = m.windows;
        if (raw !== undefined && !Array.isArray(raw)) throw new BadRequestException("Maintenance windows must be a list.");
        const list = (raw ?? []) as unknown[];
        if (list.length > 20) throw new BadRequestException("A policy can have 20 maintenance windows at most.");
        const names = new Set<string>();
        const windows = list.map((w, i) => {
            if (!isObject(w)) throw new BadRequestException(`Maintenance window ${i + 1} is not valid.`);
            onlyKeys(w, ["name", "days", "start", "end", "timezone"], `Maintenance window ${i + 1}`);
            const name = String(w.name ?? "").trim();
            if (!name) throw new BadRequestException(`Maintenance window ${i + 1} needs a name.`);
            if (name.length > 60) throw new BadRequestException(`The name of maintenance window ${i + 1} is too long (60 characters at most).`);
            if (names.has(name.toLowerCase())) throw new BadRequestException(`Two maintenance windows are called "${name}".`);
            names.add(name.toLowerCase());
            const days = Array.isArray(w.days) ? [...new Set(w.days.map(Number))].sort((x, y) => x - y) : [];
            if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequestException(`Choose at least one day for "${name}".`);
            if (typeof w.start !== "string" || typeof w.end !== "string" || !TIME.test(w.start) || !TIME.test(w.end)) throw new BadRequestException(`Times for "${name}" must look like 02:00.`);
            if (typeof w.timezone !== "string" || !isTimezone(w.timezone)) throw new BadRequestException(`The time zone for "${name}" is not one we know.`);
            return { name, days, start: w.start, end: w.end, timezone: w.timezone };
        });
        let mute = true;
        if (m.muteAlerts !== undefined && m.muteAlerts !== null) mute = bool(m.muteAlerts, "Muting alerts");
        if (windows.length) out.maintenance = { windows, muteAlerts: mute };
    }

    if (input.patching !== undefined && input.patching !== null) {
        if (!isObject(input.patching)) throw new BadRequestException("Patching is not valid.");
        const p = input.patching;
        onlyKeys(p, ["approve", "installIn", "reboot", "appScanHours", "appUpdate", "appUpdateIn"], "Patching");
        const r: NonNullable<Sections["patching"]> = {};
        if (p.approve !== undefined && p.approve !== null) {
            if (p.approve !== "none" && p.approve !== "critical" && p.approve !== "all") throw new BadRequestException('Automatic installs must be "none", "critical" or "all".');
            r.approve = p.approve;
        }
        if (p.installIn !== undefined && p.installIn !== null) {
            if (p.installIn !== "anytime" && p.installIn !== "maintenance") throw new BadRequestException('Installs must happen "anytime" or in a "maintenance" window.');
            r.installIn = p.installIn;
        }
        if (p.reboot !== undefined && p.reboot !== null) {
            if (p.reboot !== "never" && p.reboot !== "maintenance" && p.reboot !== "always") throw new BadRequestException('Restarts must be "never", "maintenance" or "always".');
            r.reboot = p.reboot;
        }
        if (p.appScanHours !== undefined && p.appScanHours !== null) r.appScanHours = whole(p.appScanHours, 0, 720, "Hours between scans for outdated programs");
        if (p.appUpdate !== undefined && p.appUpdate !== null) {
            if (p.appUpdate !== "none" && p.appUpdate !== "listed" && p.appUpdate !== "all") throw new BadRequestException('Automatic program updates must be "none", "listed" or "all".');
            r.appUpdate = p.appUpdate;
        }
        if (p.appUpdateIn !== undefined && p.appUpdateIn !== null) {
            if (p.appUpdateIn !== "anytime" && p.appUpdateIn !== "maintenance") throw new BadRequestException('Program updates must happen "anytime" or in a "maintenance" window.');
            r.appUpdateIn = p.appUpdateIn;
        }
        if (Object.keys(r).length) out.patching = r;
    }

    if (input.security !== undefined && input.security !== null) {
        if (!isObject(input.security)) throw new BadRequestException("Security is not valid.");
        const p = input.security;
        onlyKeys(p, ["scanHours", "bitlockerEscrow"], "Security");
        const r: NonNullable<Sections["security"]> = {};
        if (p.scanHours !== undefined && p.scanHours !== null) r.scanHours = whole(p.scanHours, 0, 720, "Hours between security scans");
        if (p.bitlockerEscrow !== undefined && p.bitlockerEscrow !== null) {
            if (p.bitlockerEscrow !== "off" && p.bitlockerEscrow !== "on") throw new BadRequestException('Storing BitLocker recovery keys must be "off" or "on".');
            r.bitlockerEscrow = p.bitlockerEscrow;
        }
        if (Object.keys(r).length) out.security = r;
    }

    if (input.laps !== undefined && input.laps !== null) {
        if (!isObject(input.laps)) throw new BadRequestException("Local administrator password settings are not valid.");
        const p = input.laps;
        onlyKeys(p, ["enabled", "account", "passwordLength", "rotateDays", "rotateAfterRevealMinutes"], "Local administrator password");
        const r: NonNullable<Sections["laps"]> = {};
        if (p.enabled !== undefined && p.enabled !== null) r.enabled = bool(p.enabled, "Managing the local administrator password");
        if (p.account !== undefined && p.account !== null) r.account = cleanLapsAccount(p.account);
        if (p.passwordLength !== undefined && p.passwordLength !== null) r.passwordLength = whole(p.passwordLength, 14, 64, "The password length");
        if (p.rotateDays !== undefined && p.rotateDays !== null) r.rotateDays = whole(p.rotateDays, 1, 365, "Days between password changes");
        if (p.rotateAfterRevealMinutes !== undefined && p.rotateAfterRevealMinutes !== null) r.rotateAfterRevealMinutes = whole(p.rotateAfterRevealMinutes, 0, 10080, "Minutes before a revealed password is changed");
        if (Object.keys(r).length) out.laps = r;
    }
    return out;
}

/* ------------------------------ working out what a device gets ------------------------------ */

export type Assignment = { level: Level; targetId: string | null; exclude: boolean };
export type PolicyRecord = { id: string; name: string; enabled: boolean; priority: number; os: OsChoice; enforced: boolean; sections: Sections; assignments: Assignment[] };
export type DeviceContext = { deviceId: string; clientId: string | null; siteId: string | null; os: DeviceOs; tagIds?: string[] };

export type Source =
    | { kind: "policy"; policyId: string; name: string; level: Level; enforced: boolean; priority: number }
    | { kind: "default"; label: string };

export type Baseline = { scalars: Partial<Record<ScalarKey, { value: unknown; label: string }>>; lists: Partial<Record<ListKey, { item: string; label: string }[]>> };

export type Held<T> = {
    value: T;
    source: Source;
    /** What this replaced, newest first. */
    overrode: { value: T; source: Source }[];
    /** More specific policies that tried to change it and were not allowed to, because this one is enforced. */
    blocked: { value: T; source: Source }[];
};

export type Effective = {
    scalars: Partial<Record<ScalarKey, Held<unknown>>>;
    lists: Record<ListKey, Held<string>[]>;
    /** Entries a policy removed on purpose, and ones a ban removed from the required list. */
    removed: { list: ListKey; item: string; by: Source; was: Source; why: "allowed" | "banned" }[];
    applied: { policyId: string; name: string; level: Level; priority: number; enforced: boolean }[];
    skipped: { policyId: string; name: string; reason: string }[];
    hash: string;
};

const sourceRank = (s: Source): number => (s.kind === "policy" ? LEVEL_RANK[s.level] : -1);

/** Whether what is already held may not be changed by a challenger, because the holder is enforced. */
function isBlocked(holder: Source, challenger: Source): boolean {
    if (holder.kind !== "policy" || !holder.enforced) return false;
    const h = sourceRank(holder);
    const c = sourceRank(challenger);
    if (h < c) return true;
    // At the same level an enforced policy still beats one that is not.
    return h === c && !(challenger.kind === "policy" && challenger.enforced);
}

function matchesTarget(a: Assignment, device: DeviceContext): boolean {
    if (a.level === "global") return true;
    if (a.targetId === null) return false;
    const target = a.targetId.toLowerCase();
    if (a.level === "customer") return device.clientId?.toLowerCase() === target;
    if (a.level === "site") return device.siteId?.toLowerCase() === target;
    if (a.level === "tag") return (device.tagIds ?? []).some((t) => t.toLowerCase() === target);
    return device.deviceId.toLowerCase() === target;
}

export function flatten(sections: Sections): { scalars: Partial<Record<ScalarKey, unknown>>; lists: Partial<Record<ListKey, string[]>>; waive: string[] } {
    const scalars: Partial<Record<ScalarKey, unknown>> = {};
    const a = sections.alerting;
    if (a) for (const k of ["offlineAfterMinutes", "renotifyAfterHours", "autoTicket", "autoTicketMinSeverity", "autoResolveTicket", "holdMinutes", "reopenWithinMinutes"] as const) if (a[k] !== undefined) scalars[`alerting.${k}` as ScalarKey] = a[k];
    if (sections.hours) scalars.hours = sections.hours;
    if (sections.remote?.consent) scalars["remote.consent"] = sections.remote.consent;
    if (sections.remote?.record !== undefined) scalars["remote.record"] = sections.remote.record;
    if (sections.maintenance) scalars.maintenance = sections.maintenance;
    if (sections.patching?.approve) scalars["patching.approve"] = sections.patching.approve;
    if (sections.patching?.installIn) scalars["patching.installIn"] = sections.patching.installIn;
    if (sections.patching?.reboot) scalars["patching.reboot"] = sections.patching.reboot;
    if (sections.patching?.appScanHours !== undefined) scalars["patching.appScanHours"] = sections.patching.appScanHours;
    if (sections.patching?.appUpdate) scalars["patching.appUpdate"] = sections.patching.appUpdate;
    if (sections.patching?.appUpdateIn) scalars["patching.appUpdateIn"] = sections.patching.appUpdateIn;
    if (sections.security?.scanHours !== undefined) scalars["security.scanHours"] = sections.security.scanHours;
    if (sections.security?.bitlockerEscrow) scalars["security.bitlockerEscrow"] = sections.security.bitlockerEscrow;
    if (sections.laps) for (const k of ["enabled", "account", "passwordLength", "rotateDays", "rotateAfterRevealMinutes"] as const) if (sections.laps[k] !== undefined) scalars[`laps.${k}` as ScalarKey] = sections.laps[k];
    const lists: Partial<Record<ListKey, string[]>> = {};
    if (sections.software?.required?.length) lists["software.required"] = sections.software.required;
    if (sections.software?.banned?.length) lists["software.banned"] = sections.software.banned;
    if (sections.checks?.profileIds.length) lists["checks.profiles"] = sections.checks.profileIds;
    return { scalars, lists, waive: sections.software?.waive ?? [] };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const itemKey = (item: string) => item.trim().toLowerCase();

/** Policies that apply to this device, in the order they are combined: broadest first, weakest first within a level. */
export function applicablePolicies(device: DeviceContext, policies: PolicyRecord[]) {
    const applied: { policy: PolicyRecord; level: Level }[] = [];
    const skipped: Effective["skipped"] = [];
    for (const p of policies) {
        const hits = p.assignments.filter((a) => !a.exclude && matchesTarget(a, device));
        if (!hits.length) continue;
        const excluded = p.assignments.find((a) => a.exclude && a.level !== "global" && matchesTarget(a, device));
        if (excluded) { skipped.push({ policyId: p.id, name: p.name, reason: `Switched off for this ${LEVEL_LABEL[excluded.level].toLowerCase()}` }); continue; }
        if (!p.enabled) { skipped.push({ policyId: p.id, name: p.name, reason: "The policy is switched off" }); continue; }
        if (p.os !== "any" && p.os !== device.os) { skipped.push({ policyId: p.id, name: p.name, reason: device.os === "unknown" ? `For ${p.os} devices; this device's system is not known` : `For ${p.os} devices only` }); continue; }
        const level = hits.reduce<Level>((best, a) => (LEVEL_RANK[a.level] > LEVEL_RANK[best] ? a.level : best), "global");
        applied.push({ policy: p, level });
    }
    applied.sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level] || y.policy.priority - x.policy.priority || x.policy.id.localeCompare(y.policy.id));
    return { applied, skipped };
}

/** What one device gets: every setting with its value, where it came from and what it replaced. */
export function resolve(device: DeviceContext, policies: PolicyRecord[], baseline: Baseline = { scalars: {}, lists: {} }): Effective {
    const { applied, skipped } = applicablePolicies(device, policies);
    const scalars: Effective["scalars"] = {};
    const maps: Record<ListKey, Map<string, Held<string>>> = { "software.required": new Map(), "software.banned": new Map(), "checks.profiles": new Map() };
    const removed: Effective["removed"] = [];

    for (const key of SCALAR_KEYS) {
        const b = baseline.scalars[key];
        if (b) scalars[key] = { value: b.value, source: { kind: "default", label: b.label }, overrode: [], blocked: [] };
    }
    for (const key of LIST_KEYS) {
        for (const e of baseline.lists[key] ?? []) {
            if (!maps[key].has(itemKey(e.item))) maps[key].set(itemKey(e.item), { value: e.item, source: { kind: "default", label: e.label }, overrode: [], blocked: [] });
        }
    }

    for (const { policy, level } of applied) {
        const source: Source = { kind: "policy", policyId: policy.id, name: policy.name, level, enforced: policy.enforced, priority: policy.priority };
        const flat = flatten(policy.sections);

        for (const key of SCALAR_KEYS) {
            if (!(key in flat.scalars)) continue;
            const value = flat.scalars[key];
            const held = scalars[key];
            if (!held) { scalars[key] = { value, source, overrode: [], blocked: [] }; continue; }
            if (isBlocked(held.source, source)) { if (!same(held.value, value)) held.blocked.push({ value, source }); continue; }
            scalars[key] = { value, source, overrode: [{ value: held.value, source: held.source }, ...held.overrode], blocked: [] };
        }

        // Anything a policy waives is taken out of what the broader ones put in, unless that was enforced.
        for (const w of flat.waive) {
            for (const key of ["software.required", "software.banned"] as ListKey[]) {
                const held = maps[key].get(itemKey(w));
                if (!held) continue;
                if (isBlocked(held.source, source)) { held.blocked.push({ value: w, source }); continue; }
                maps[key].delete(itemKey(w));
                removed.push({ list: key, item: held.value, by: source, was: held.source, why: "allowed" });
            }
        }

        for (const key of LIST_KEYS) {
            for (const item of flat.lists[key] ?? []) {
                const held = maps[key].get(itemKey(item));
                if (!held) { maps[key].set(itemKey(item), { value: item, source, overrode: [], blocked: [] }); continue; }
                if (isBlocked(held.source, source)) continue;
                maps[key].set(itemKey(item), { value: item, source, overrode: [{ value: held.value, source: held.source }, ...held.overrode], blocked: [] });
            }
        }
    }

    // Something both required and banned is banned: a ban always wins.
    for (const [k, req] of [...maps["software.required"]]) {
        const ban = maps["software.banned"].get(k);
        if (!ban) continue;
        maps["software.required"].delete(k);
        removed.push({ list: "software.required", item: req.value, by: ban.source, was: req.source, why: "banned" });
    }

    const lists = Object.fromEntries(LIST_KEYS.map((k) => [k, [...maps[k].values()].sort((a, b) => a.value.localeCompare(b.value))])) as Effective["lists"];
    const hashInput = JSON.stringify({
        s: SCALAR_KEYS.map((k) => [k, scalars[k]?.value ?? null]),
        l: LIST_KEYS.map((k) => [k, lists[k].map((e) => e.value.toLowerCase())]),
    });
    return {
        scalars,
        lists,
        removed,
        applied: applied.map(({ policy, level }) => ({ policyId: policy.id, name: policy.name, level, priority: policy.priority, enforced: policy.enforced })),
        skipped,
        hash: createHash("sha256").update(hashInput).digest("hex").slice(0, 16),
    };
}

/** The values alone, for code that only wants the answer. */
export function valuesOf(e: Effective) {
    return {
        scalar: <T>(key: ScalarKey): T | undefined => e.scalars[key]?.value as T | undefined,
        list: (key: ListKey): string[] => e.lists[key].map((x) => x.value),
    };
}

/** What changes between two answers for the same device, setting by setting. */
export function diffEffective(before: Effective, after: Effective): { key: string; label: string; from: unknown; to: unknown }[] {
    const out: { key: string; label: string; from: unknown; to: unknown }[] = [];
    for (const key of SCALAR_KEYS) {
        const a = before.scalars[key]?.value ?? null;
        const b = after.scalars[key]?.value ?? null;
        if (!same(a, b)) out.push({ key, label: SETTING_LABEL[key] ?? key, from: a, to: b });
    }
    for (const key of LIST_KEYS) {
        const a = before.lists[key].map((x) => x.value).sort();
        const b = after.lists[key].map((x) => x.value).sort();
        if (!same(a, b)) out.push({ key, label: SETTING_LABEL[key] ?? key, from: a, to: b });
    }
    return out;
}

/** The effective policy as a plain list of rows, easiest for a screen to show. */
export function explain(e: Effective) {
    const rows: { key: string; label: string; kind: "value" | "list"; value: unknown; source: Source; overrode: { value: unknown; source: Source }[]; blocked: { value: unknown; source: Source }[] }[] = [];
    for (const key of SCALAR_KEYS) {
        const h = e.scalars[key];
        if (h) rows.push({ key, label: SETTING_LABEL[key] ?? key, kind: "value", value: h.value, source: h.source, overrode: h.overrode, blocked: h.blocked });
    }
    for (const key of LIST_KEYS) {
        for (const h of e.lists[key]) rows.push({ key, label: SETTING_LABEL[key] ?? key, kind: "list", value: h.value, source: h.source, overrode: h.overrode, blocked: h.blocked });
    }
    return rows;
}
