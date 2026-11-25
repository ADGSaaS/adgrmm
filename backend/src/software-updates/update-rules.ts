// backend/src/software-updates/update-rules.ts
//
// What may be updated, as plain functions with no database. A program is named by its package id (winget or
// Chocolatey). Two lists decide: "allowed to update on its own" and "never update", each for the whole organisation
// or for one customer. A never-update entry anywhere always wins.

export type UpdateSource = "winget" | "chocolatey";
export type UpdateRule = { source: string; appId: string; rule: "allow" | "block"; clientId: string | null };
export type AutoMode = "none" | "listed" | "all";

export const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/;
export const CHOCO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Agents older than this do not know the software_updates_scan task or the upgrade action. Raise it to the agent version that ships them. */
export const UPDATES_MIN_VERSION = "1.3.34";

export function versionAtLeast(have: string, need: string): boolean {
    const a = String(have).split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
    const b = String(need).split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    return true;
}

export const isSource = (s: unknown): s is UpdateSource => s === "winget" || s === "chocolatey";

export function validAppId(source: string, id: string): boolean {
    return source === "winget" ? WINGET_ID.test(id) : source === "chocolatey" ? CHOCO_ID.test(id) : false;
}

export const appKey = (source: string, appId: string) => `${source}\u0001${appId.toLowerCase()}`;

/** The rules that apply to one program on a device of this customer: the organisation's and that customer's own. */
export function rulesFor(rules: UpdateRule[], clientId: string | null, source: string, appId: string): UpdateRule[] {
    const key = appKey(source, appId);
    return rules.filter((r) => appKey(r.source, r.appId) === key && (r.clientId === null || r.clientId === clientId));
}

export type Decision = { update: boolean; reason: string; rule: UpdateRule | null };

/** A person asked for this update. Only a never-update entry stops it. */
export function manualDecision(rules: UpdateRule[], clientId: string | null, source: string, appId: string): Decision {
    const hit = rulesFor(rules, clientId, source, appId).find((r) => r.rule === "block");
    if (hit) return { update: false, reason: hit.clientId ? "It is on this customer's never-update list." : "It is on the never-update list.", rule: hit };
    return { update: true, reason: "", rule: null };
}

/** A policy wants to update this on its own: "none" never, "listed" only what is allowed, "all" everything not blocked. */
export function autoDecision(mode: AutoMode, rules: UpdateRule[], clientId: string | null, source: string, appId: string): Decision {
    if (mode === "none") return { update: false, reason: "Automatic updates are off.", rule: null };
    const mine = rulesFor(rules, clientId, source, appId);
    const block = mine.find((r) => r.rule === "block");
    if (block) return { update: false, reason: block.clientId ? "On this customer's never-update list." : "On the never-update list.", rule: block };
    if (mode === "all") return { update: true, reason: "", rule: null };
    const allow = mine.find((r) => r.rule === "allow");
    if (allow) return { update: true, reason: "", rule: allow };
    return { update: false, reason: "Not on the allowed list.", rule: null };
}

/**
 * Part of a program's name to look it up by in the installed-programs list. winget prints the version inside the name
 * ("7-Zip 25.01 (x64)"), and the version changes with the update, so the installed version is taken out.
 */
export function matchTextFor(name: string, installedVersion: string | null | undefined): string {
    let n = String(name ?? "").trim();
    const v = String(installedVersion ?? "").replace(/^[<>]\s*/, "").trim();
    if (v) n = n.split(v).join(" ");
    n = n.replace(/\s+version\s*$/i, "").replace(/\s{2,}/g, " ").replace(/[\s\-–(]+$/, "").trim();
    return (n || String(name ?? "").trim()).slice(0, 200);
}

/** The name without the installed version, for lists that show one row per program. */
export const displayName = (name: string, installedVersion: string | null | undefined) =>
    matchTextFor(name, installedVersion);

/** Why a device cannot be scanned or updated, or null when it can. */
export function whyNotSupported(a: { version: string; os: string; lastCheckInAt: Date | null }, nowMs = Date.now(), onlineWithinMs = 5 * 60_000): string | null {
    if (a.os !== "windows") return "Updating other programs only works on Windows devices for now. This device is not running Windows, so it is skipped.";
    if (!versionAtLeast(a.version, UPDATES_MIN_VERSION)) return `Its agent is ${a.version}; updating programs needs ${UPDATES_MIN_VERSION} or newer.`;
    if (!a.lastCheckInAt || nowMs - a.lastCheckInAt.getTime() > onlineWithinMs) return "It is offline right now.";
    return null;
}
