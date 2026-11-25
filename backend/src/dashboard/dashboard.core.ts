// backend/src/dashboard/dashboard.core.ts
//
// The parts of the Overview page's summary that need no database: the plain-language "needs attention" list and how it is
// ranked, readable lines for the audit log, the cache, and the key that keeps one person's numbers from reaching another.
// Pure, so it can be tested alone (test/dashboard-units.cjs).
import type { AccessScope } from "../reports/client-access.service";

export type Severity = "critical" | "warning" | "info";
export type Area = "alerts" | "tickets" | "security" | "devices" | "patching" | "agents";

export type AttentionItem = {
    /** Stable name of the rule, so the page can keep a row steady between refreshes. */
    id: string;
    severity: Severity;
    /** How many things the sentence is about (always more than zero). */
    count: number;
    /** One plain English sentence that already holds the count. */
    text: string;
    area: Area;
    /** The page that shows exactly these things, and the filters to open it with. */
    route: string;
    query: Record<string, string>;
};

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** "1 device" or "3 devices". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const n0 = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
};

/** What the rules look at. A part that is null is something the person may not see, so no rule about it runs. */
export type AttentionInput = {
    alerts?: { open: number; openCritical: number } | null;
    tickets?: { breached: number; warning: number } | null;
    security?: { attentionDevices: number; neverScanned: number } | null;
    devices?: { offlineOver24h: number; neverCheckedIn: number; removalRequests?: number } | null;
    patching?: { installFailed: number; needRestart: number } | null;
    /** Only given to people who may manage agent releases. */
    release?: Array<{ os: string; version: string }> | null;
};

type Rule = { id: string; severity: Severity; area: Area; route: string; query: Record<string, string>; count: number; text: (n: number) => string };

/**
 * Everything that needs doing, most urgent first: red things (a person is waiting or something is broken), then amber, then
 * housekeeping. Inside one level the order below is fixed, so the list does not shuffle between refreshes.
 */
export function buildAttention(input: AttentionInput): AttentionItem[] {
    const a = input.alerts;
    const t = input.tickets;
    const s = input.security;
    const d = input.devices;
    const p = input.patching;
    const openCritical = n0(a?.openCritical);
    const otherOpen = Math.max(0, n0(a?.open) - openCritical);
    const rules: Rule[] = [
        { id: "alerts-critical", severity: "critical", area: "alerts", route: "/alerts", query: { severity: "CRIT" }, count: openCritical,
          text: (n) => `${plural(n, "critical alert is", "critical alerts are")} open` },
        { id: "sla-breached", severity: "critical", area: "tickets", route: "/tickets", query: { sla: "breached" }, count: n0(t?.breached),
          text: (n) => `${plural(n, "ticket has", "tickets have")} breached ${n === 1 ? "its" : "their"} SLA` },
        { id: "security-critical", severity: "critical", area: "security", route: "/security", query: { sort: "critical" }, count: n0(s?.attentionDevices),
          text: (n) => `${plural(n, "device has", "devices have")} a critical security problem` },
        { id: "devices-offline", severity: "warning", area: "devices", route: "/customers", query: { status: "offline" }, count: n0(d?.offlineOver24h),
          text: (n) => `${plural(n, "device has", "devices have")} been offline for over a day` },
        { id: "alerts-open", severity: "warning", area: "alerts", route: "/alerts", query: openCritical > 0 ? { severity: "WARN" } : {}, count: otherOpen,
          text: (n) => (openCritical > 0 ? `${plural(n, "other alert is", "other alerts are")} open` : `${plural(n, "alert is", "alerts are")} open`) },
        { id: "sla-risk", severity: "warning", area: "tickets", route: "/tickets", query: { sla: "warning" }, count: n0(t?.warning),
          text: (n) => `${plural(n, "ticket is", "tickets are")} close to breaching ${n === 1 ? "its" : "their"} SLA` },
        { id: "update-failed", severity: "warning", area: "patching", route: "/reports", query: { report: "patch-compliance" }, count: n0(p?.installFailed),
          text: (n) => `${plural(n, "device failed its", "devices failed their")} last update install` },
        { id: "needs-restart", severity: "info", area: "patching", route: "/reports", query: { report: "patch-compliance" }, count: n0(p?.needRestart),
          text: (n) => `${plural(n, "device needs a restart", "devices need a restart")} to finish updates` },
        { id: "not-scanned", severity: "info", area: "security", route: "/security", query: { grade: "none" }, count: n0(s?.neverScanned),
          text: (n) => `${plural(n, "device has", "devices have")} never had a security scan` },
        { id: "removal-requests", severity: "warning", area: "devices", route: "/removal-requests", query: {}, count: n0(d?.removalRequests),
          text: (n) => `${plural(n, "device removal request is", "device removal requests are")} waiting for approval` },
        { id: "never-checked-in", severity: "info", area: "devices", route: "/customers", query: { status: "offline" }, count: n0(d?.neverCheckedIn),
          text: (n) => `${plural(n, "device has", "devices have")} never checked in` },
    ];
    const out: AttentionItem[] = rules
        .filter((r) => r.count > 0)
        .map((r) => ({ id: r.id, severity: r.severity, count: r.count, text: r.text(r.count), area: r.area, route: r.route, query: r.query }));
    for (const c of input.release ?? []) {
        out.push({
            id: `release-${c.os}`, severity: "info", count: 1, area: "agents", route: "/administration", query: { tab: "agents" },
            text: `Agent ${c.version} for ${c.os === "windows" ? "Windows" : c.os === "linux" ? "Linux" : c.os} is waiting to be promoted`,
        });
    }
    // Array.prototype.sort is stable, so the fixed order above breaks ties inside a level.
    return out.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
}

/* ------------------------------ audit log in plain words ------------------------------ */

const VERBS: Record<string, string> = {
    create: "created", add: "added", update: "updated", edit: "edited", delete: "deleted", remove: "removed", revoke: "revoked",
    reboot: "restarted", restart: "restarted", run: "ran", start: "started", stop: "stopped", cancel: "cancelled", approve: "approved",
    reject: "rejected", assign: "assigned", close: "closed", reopen: "reopened", resolve: "resolved", acknowledge: "acknowledged",
    silence: "silenced", promote: "promoted", withdraw: "withdrew", import: "imported", export: "exported", login: "signed in",
    signin: "signed in", signout: "signed out", download: "downloaded", upload: "uploaded", reveal: "revealed", reset: "reset",
    enable: "enabled", disable: "disabled", scan: "ran a scan on", install: "installed", uninstall: "uninstalled", move: "moved",
    send: "sent", test: "tested", restore: "restored", merge: "merged", publish: "published", invite: "invited", lock: "locked", unlock: "unlocked",
};

const NOUNS: Record<string, string> = {
    device: "device", ticket: "ticket", user: "user", role: "role", group: "group", customer: "customer", client: "customer", site: "site", policy: "policy",
    alert: "alert", script: "script", automation: "automation", backup: "backup", settings: "settings", invoice: "invoice", quote: "quote",
    visit: "visit", kb: "knowledge base article", article: "knowledge base article", agent: "agent", agents: "agent", release: "release",
    recording: "recording", vault: "stored password", docs: "document", asset: "asset", tag: "tag", queue: "queue", sla: "SLA policy",
};

/** "device.reboot" becomes "restarted"; the target is added by the caller. Unknown names fall back to the words themselves. */
export function describeAudit(action: string, targetLabel: string | null | undefined, outcome?: string | null): string {
    const parts = String(action ?? "").toLowerCase().split(/[._-]+/).filter(Boolean);
    const label = String(targetLabel ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
    let text: string;
    if (!parts.length) {
        text = "did something";
    } else {
        // The verb is usually last ("device.reboot", "ticket.create"); "agents.release.promote" ends in one too.
        let verbIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) if (VERBS[parts[i]]) { verbIdx = i; break; }
        if (verbIdx < 0) {
            text = parts.join(" ");
        } else {
            const verb = VERBS[parts[verbIdx]];
            const subject = parts.slice(0, verbIdx).filter((w) => w !== "admin" && w !== "api");
            const noun = subject.map((w) => NOUNS[w] ?? w).filter((w, i, all) => all.indexOf(w) === i).join(" ");
            const tail = parts.slice(verbIdx + 1).join(" ");
            if (label) text = `${verb} ${noun ? `${noun} ` : ""}${label}${tail ? ` ${tail}` : ""}`;
            else text = `${verb}${noun ? ` ${noun === "settings" ? "settings" : `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`}` : ""}${tail ? ` ${tail}` : ""}`;
        }
    }
    if (outcome && outcome !== "success") text += " (did not work)";
    return text.replace(/\s+/g, " ").trim();
}

/* ------------------------------ the short cache ------------------------------ */

/**
 * A small in-memory cache with one lifetime for everything. It never invalidates: numbers are at most `ttlMs` old. A request
 * that arrives while the same key is being computed waits for that answer instead of asking the database again.
 */
export class TtlCache<T> {
    private readonly items = new Map<string, { at: number; value: Promise<T> }>();
    constructor(private ttlMs: number, private readonly max = 500, private readonly now: () => number = Date.now) { }

    setTtl(ms: number) { this.ttlMs = ms; }
    get size() { return this.items.size; }
    clear() { this.items.clear(); }

    async get(key: string, load: () => Promise<T>): Promise<T> {
        const t = this.now();
        const hit = this.items.get(key);
        if (hit && t - hit.at < this.ttlMs) return hit.value;
        const value = load();
        this.items.set(key, { at: t, value });
        // A failed load is not kept, so the next request tries again.
        value.catch(() => { if (this.items.get(key)?.value === value) this.items.delete(key); });
        if (this.items.size > this.max) this.evict(t);
        return value;
    }

    private evict(t: number) {
        for (const [k, v] of this.items) if (t - v.at >= this.ttlMs) this.items.delete(k);
        // Still too many: drop the oldest first (Map keeps insertion order).
        while (this.items.size > this.max) {
            const first = this.items.keys().next();
            if (first.done) break;
            this.items.delete(first.value);
        }
    }
}

/**
 * Names what a person may see, so two people share cached numbers only when they would get the same answer.
 * Everyone unlimited shares one key. A limited person has their own, because tickets assigned to them also count.
 */
export function scopeKey(scope: AccessScope | null, userId: string | null): string {
    if (!scope) return "all";
    const sorted = (xs: string[]) => [...new Set(xs)].sort().join(",");
    return `limited:${userId ?? "none"}:c=${sorted(scope.clients)};s=${sorted(scope.sites)};t=${sorted(scope.tags)}`;
}

export const cacheKey = (section: string, orgId: string, scope: string, clientId: string | null, extra = "") =>
    [section, orgId, scope, clientId ?? "-", extra].join("|");
