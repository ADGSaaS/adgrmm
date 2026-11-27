// backend/src/entitlements/entitlements.service.ts
//
// Seat limits for hosted ("Cloud") installs. A separate control plane writes entitlements.json into the tenant's install
// folder; this service reads it and refuses NEW endpoints and NEW technicians past the limits. See docs/entitlements.md.
//
// A missing, unreadable or malformed file means "unlimited" (a self-hosted install behaves exactly as without this feature).
// Nothing here ever disconnects an endpoint or signs a user out: it only says no to adding more.
import { HttpException, Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import { PrismaService } from "../storage/prisma.service";
import { isDemoMode } from "../demo-mode/demo-mode.rules";

export type EntitlementStatus = "active" | "past_due" | "suspended";

export type EntitlementLimits = {
    maxEndpoints: number | null;
    maxTechnicians: number | null;
    status: EntitlementStatus;
    upgradeUrl: string | null;
    updatedAt: string | null;
};

export type EntitlementUsage = { endpoints: number; technicians: number };
export type EntitlementBanner = { level: "info" | "warn" | "error"; text: string };

export const SEAT_LIMIT_ENDPOINTS = "seat_limit_endpoints";
export const SEAT_LIMIT_TECHNICIANS = "seat_limit_technicians";

const FILE_CACHE_MS = 15_000;
const USAGE_CACHE_MS = 5_000;
const DEFAULT_FILE = "/config/entitlements.json";

/** Parses the file text. An error means the file is malformed (the caller then treats the install as unlimited). */
export function parseEntitlements(raw: string): { limits: EntitlementLimits } | { error: string } {
    let doc: any;
    try {
        doc = JSON.parse(raw);
    } catch (e: any) {
        return { error: `not valid JSON (${String(e?.message ?? e).slice(0, 120)})` };
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { error: "not a JSON object" };

    const limit = (key: string): number | null | "bad" => {
        const v = doc[key];
        if (v === undefined || v === null) return null;
        return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : "bad";
    };
    const maxEndpoints = limit("maxEndpoints");
    const maxTechnicians = limit("maxTechnicians");
    if (maxEndpoints === "bad") return { error: "maxEndpoints must be a whole number or null" };
    if (maxTechnicians === "bad") return { error: "maxTechnicians must be a whole number or null" };

    // An unknown status is read as active: it must never lock anyone out by accident.
    const status: EntitlementStatus = doc.status === "past_due" || doc.status === "suspended" ? doc.status : "active";

    // The link is shown to staff, so only a plain web address is accepted.
    let upgradeUrl: string | null = null;
    if (typeof doc.upgradeUrl === "string") {
        try {
            const u = new URL(doc.upgradeUrl.trim());
            if (u.protocol === "https:" || u.protocol === "http:") upgradeUrl = u.toString();
        } catch { /* not a web address: ignored */ }
    }
    const updatedAt = typeof doc.updatedAt === "string" ? doc.updatedAt.slice(0, 40) : null;
    return { limits: { maxEndpoints, maxTechnicians, status, upgradeUrl, updatedAt } };
}

/** The banner shown in the web app. Pure, so it can be tested without a database. */
export function buildBanner(limits: EntitlementLimits | null, usage: EntitlementUsage): EntitlementBanner | null {
    if (!limits) return null;
    const parts: { level: "warn" | "error"; text: string }[] = [];
    const where = limits.upgradeUrl ? ` Manage your plan at ${limits.upgradeUrl}.` : "";

    if (limits.status === "past_due") {
        parts.push({ level: "error", text: `Payment failed. Update your payment details to keep your plan active.${where}` });
    }
    const seat = (label: string, used: number, max: number | null, what: string) => {
        if (max === null) return;
        if (used >= max) {
            parts.push({ level: "error", text: `${label} limit reached (${used} of ${max}). ${what}${where}` });
        } else if (used * 10 >= max * 9) {
            parts.push({ level: "warn", text: `You are using ${used} of ${max} ${label.toLowerCase()} seats.${where}` });
        }
    };
    seat("Endpoint", usage.endpoints, limits.maxEndpoints, "No new devices can be enrolled until you upgrade.");
    seat("Technician", usage.technicians, limits.maxTechnicians, "No more technicians can be added until you upgrade.");

    if (!parts.length) return null;
    const level = parts.some((p) => p.level === "error") ? "error" : "warn";
    return { level, text: parts.map((p) => p.text).join(" ") };
}

@Injectable()
export class EntitlementsService {
    private readonly log = new Logger("Entitlements");
    /** Replaceable in tests. */
    now: () => number = () => Date.now();

    private cached: { limits: EntitlementLimits | null; at: number; sig: string } | null = null;
    private warnedSig = "";
    private usageCache: { at: number; value: EntitlementUsage } | null = null;

    constructor(private readonly prisma: PrismaService) { }

    private filePath(): string {
        return (process.env.ENTITLEMENTS_FILE || "").trim() || DEFAULT_FILE;
    }

    /** The limits in force, or null when there are none (no file, unreadable, malformed, or the public demo). */
    getLimits(): EntitlementLimits | null {
        if (isDemoMode()) return null;
        const file = this.filePath();
        const now = this.now();
        let sig = "missing";
        try {
            const st = fs.statSync(file);
            sig = `${file}:${st.mtimeMs}:${st.size}`;
        } catch {
            sig = "missing";
        }
        if (this.cached && this.cached.sig === sig && now - this.cached.at < FILE_CACHE_MS) return this.cached.limits;

        let limits: EntitlementLimits | null = null;
        if (sig !== "missing") {
            try {
                const parsed = parseEntitlements(fs.readFileSync(file, "utf8"));
                if ("limits" in parsed) {
                    limits = parsed.limits;
                    this.warnedSig = "";
                } else {
                    this.warnOnce(file, sig, parsed.error);
                }
            } catch (e: any) {
                this.warnOnce(file, sig, `could not be read (${String(e?.message ?? e).slice(0, 120)})`);
            }
        } else {
            this.warnedSig = "";
        }
        this.cached = { limits, at: now, sig };
        return limits;
    }

    private warnOnce(file: string, sig: string, why: string) {
        if (this.warnedSig === sig) return;
        this.warnedSig = sig;
        this.log.warn(`${file} is ignored and this install is treated as unlimited: ${why}.`);
    }

    /** Endpoints = rows in agents. Technicians = users who are active or invited (disabled ones, and portal accounts, do not count). */
    async getUsage(fresh = false): Promise<EntitlementUsage> {
        const now = this.now();
        if (!fresh && this.usageCache && now - this.usageCache.at < USAGE_CACHE_MS) return this.usageCache.value;
        const [endpoints, technicians] = await Promise.all([
            this.prisma.agents.count(),
            this.prisma.users.count({ where: { status: { in: ["active", "invited"] } } }),
        ]);
        const value = { endpoints, technicians };
        this.usageCache = { at: now, value };
        return value;
    }

    /** What GET /api/entitlements returns. Nothing else from the file is exposed. */
    async summary() {
        const limits = this.getLimits();
        if (!limits) return { limits: null, usage: null, status: null, upgradeUrl: null, banner: null };
        const usage = await this.getUsage();
        return {
            limits: { maxEndpoints: limits.maxEndpoints, maxTechnicians: limits.maxTechnicians },
            usage,
            status: limits.status,
            upgradeUrl: limits.upgradeUrl,
            banner: buildBanner(limits, usage),
        };
    }

    private upgradeHint(limits: EntitlementLimits | null): string {
        return limits?.upgradeUrl ? ` Upgrade your plan at ${limits.upgradeUrl} to add more.` : " Ask your administrator to upgrade the plan.";
    }

    /**
     * Throws when one more endpoint would exceed the plan. Call only when the endpoint is new.
     * The error is 402 and not 403 because the enrollment rate limiter counts 401/403 as guesses, and this is not one.
     */
    async assertCanEnrollEndpoint(): Promise<void> {
        const limits = this.getLimits();
        if (!limits || limits.maxEndpoints === null) return;
        const { endpoints } = await this.getUsage(true);
        if (endpoints < limits.maxEndpoints) return;
        throw new HttpException(
            {
                statusCode: 402,
                error: "Payment Required",
                code: SEAT_LIMIT_ENDPOINTS,
                message: `Your plan's endpoint limit (${limits.maxEndpoints}) is reached, so this device was not enrolled.${this.upgradeHint(limits)}`,
                limit: limits.maxEndpoints,
                inUse: endpoints,
                upgradeUrl: limits.upgradeUrl,
            },
            402,
        );
    }

    /** How many more technicians fit (null = no limit). Counts fresh from the database. */
    async technicianRoom(): Promise<number | null> {
        const limits = this.getLimits();
        if (!limits || limits.maxTechnicians === null) return null;
        const { technicians } = await this.getUsage(true);
        return Math.max(0, limits.maxTechnicians - technicians);
    }

    technicianLimitError(): HttpException {
        const limits = this.getLimits();
        const max = limits?.maxTechnicians ?? 0;
        return new HttpException(
            {
                statusCode: 402,
                error: "Payment Required",
                code: SEAT_LIMIT_TECHNICIANS,
                message: `Your plan's technician limit (${max}) is reached, so no more technicians can be added or re-enabled.${this.upgradeHint(limits)}`,
                limit: max,
                upgradeUrl: limits?.upgradeUrl ?? null,
            },
            402,
        );
    }

    /** Throws when `count` more technicians would exceed the plan. */
    async assertCanAddTechnicians(count = 1): Promise<void> {
        const room = await this.technicianRoom();
        if (room === null || room >= count) return;
        throw this.technicianLimitError();
    }
}
