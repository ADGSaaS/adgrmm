// Customer satisfaction surveys, the parts that need no database: the signed link, the rules for the settings, the
// scores. Pure, so it can be tested alone.
import { BadRequestException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getJwtSecret } from "../auth/jwt-secret";

export const SURVEY_STATUSES = ["resolved", "closed"] as const;
export const COMMENT_MAX = 2000;
export const MAX_ALERT_PEOPLE = 20;
export const MAX_CLIENTS = 500;

export const STAR_LABELS: Record<number, string> = { 1: "Very unhappy", 2: "Unhappy", 3: "Okay", 4: "Happy", 5: "Very happy" };

/** Survey links are signed with a key of their own, derived from the server secret, so nothing else's token can pass as one. */
function surveyKey(): string {
    return createHmac("sha256", getJwtSecret()).update("remoteiq:ticket-survey:v1").digest("hex");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mac(id: string, expSec: number): string {
    return createHmac("sha256", surveyKey()).update(`survey:${id}:${expSec}`).digest("base64url");
}

/** `id.expiry.signature`: the signature covers both, so neither can be changed. A link works once, which the database enforces. */
export function signSurveyToken(id: string, expiresAt: Date): string {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    return `${id}.${exp}.${mac(id, exp)}`;
}

export type TokenCheck = { ok: true; id: string; expired: boolean } | { ok: false };

/** Checks shape and signature (in constant time). An expired link is still a genuine one, so it can be told apart from a forged one. */
export function readSurveyToken(token: unknown, nowMs = Date.now()): TokenCheck {
    if (typeof token !== "string" || token.length > 200) return { ok: false };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false };
    const [id, expRaw, sig] = parts;
    if (!UUID.test(id) || !/^\d{1,12}$/.test(expRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false };
    const exp = Number(expRaw);
    const want = Buffer.from(mac(id, exp));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false };
    return { ok: true, id, expired: exp * 1000 <= nowMs };
}

export type SurveySettings = {
    enabled: boolean;
    triggerStatuses: string[];
    delayMinutes: number;
    scope: "all" | "selected";
    clientIds: string[];
    throttleDays: number;
    reminderEnabled: boolean;
    reminderAfterDays: number;
    expiryDays: number;
    scale: "stars" | "thumbs";
    lowThreshold: number;
    alertUserIds: string[];
    alertGroupIds: string[];
};

export const DEFAULT_SETTINGS: SurveySettings = {
    enabled: false,
    triggerStatuses: ["resolved", "closed"],
    delayMinutes: 60,
    scope: "all",
    clientIds: [],
    throttleDays: 14,
    reminderEnabled: false,
    reminderAfterDays: 3,
    expiryDays: 30,
    scale: "stars",
    lowThreshold: 2,
    alertUserIds: [],
    alertGroupIds: [],
};

function int(v: unknown, label: string, min: number, max: number): number {
    const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
    if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${label} must be a whole number from ${min} to ${max}.`);
    return n;
}

function uuids(v: unknown, label: string, max: number): string[] {
    if (!Array.isArray(v)) throw new BadRequestException(`${label} must be a list.`);
    const out = [...new Set(v.map((x) => String(x).toLowerCase()))];
    if (out.some((x) => !UUID.test(x))) throw new BadRequestException(`${label} has an entry that is not valid.`);
    if (out.length > max) throw new BadRequestException(`${label} can have ${max} entries at most.`);
    return out;
}

/** What is saved: the current settings with what was sent on top, each part checked. */
export function mergeSettings(cur: SurveySettings, input: Record<string, unknown>): SurveySettings {
    const next: SurveySettings = { ...cur };
    if (input.enabled !== undefined) next.enabled = input.enabled === true;
    if (input.triggerStatuses !== undefined) {
        const list = Array.isArray(input.triggerStatuses) ? [...new Set(input.triggerStatuses.map(String))] : [];
        if (!list.length || list.some((s) => !(SURVEY_STATUSES as readonly string[]).includes(s))) throw new BadRequestException("Choose when to ask: Resolved, Closed or both.");
        next.triggerStatuses = SURVEY_STATUSES.filter((s) => list.includes(s));
    }
    if (input.delayMinutes !== undefined) next.delayMinutes = int(input.delayMinutes, "The delay", 0, 14 * 24 * 60);
    if (input.scope !== undefined) {
        if (input.scope !== "all" && input.scope !== "selected") throw new BadRequestException("Choose all customers or selected customers.");
        next.scope = input.scope;
    }
    if (input.clientIds !== undefined) next.clientIds = uuids(input.clientIds, "The customers", MAX_CLIENTS);
    if (input.throttleDays !== undefined) next.throttleDays = int(input.throttleDays, "The days between surveys", 0, 365);
    if (input.reminderEnabled !== undefined) next.reminderEnabled = input.reminderEnabled === true;
    if (input.reminderAfterDays !== undefined) next.reminderAfterDays = int(input.reminderAfterDays, "The reminder time", 1, 60);
    if (input.expiryDays !== undefined) next.expiryDays = int(input.expiryDays, "The days a link works", 1, 90);
    if (input.scale !== undefined) {
        if (input.scale !== "stars" && input.scale !== "thumbs") throw new BadRequestException("Choose stars or thumbs.");
        next.scale = input.scale;
    }
    if (input.lowThreshold !== undefined) next.lowThreshold = int(input.lowThreshold, "The low score", 1, 4);
    if (input.alertUserIds !== undefined) next.alertUserIds = uuids(input.alertUserIds, "The people to tell", MAX_ALERT_PEOPLE);
    if (input.alertGroupIds !== undefined) next.alertGroupIds = uuids(input.alertGroupIds, "The groups to tell", MAX_ALERT_PEOPLE);
    if (next.reminderEnabled && next.reminderAfterDays >= next.expiryDays) throw new BadRequestException("The reminder must come before the link stops working.");
    if (next.scope === "selected" && next.clientIds.length === 0 && next.enabled) throw new BadRequestException("Choose at least one customer, or ask all customers.");
    return next;
}

/** A score from a person: stars 1 to 5, or thumbs where only 1 (down) and 5 (up) are allowed. */
export function cleanScore(v: unknown, scale: "stars" | "thumbs"): number {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d\s*$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new BadRequestException("Choose a rating.");
    if (scale === "thumbs" && n !== 1 && n !== 5) throw new BadRequestException("Choose thumbs up or thumbs down.");
    return n;
}

/** The comment as plain text: control characters out, trimmed, limited. It is shown as text everywhere, never as markup. */
export function cleanComment(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new BadRequestException("The comment must be text.");
    // eslint-disable-next-line no-control-regex
    const s = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    if (s.length > COMMENT_MAX) throw new BadRequestException(`Keep the comment under ${COMMENT_MAX} characters.`);
    return s || null;
}

/** Why a ticket gets no survey, or null when it does. */
export function skipReason(s: SurveySettings, p: { email: string | null; clientId: string | null; recentlyAsked: boolean }): string | null {
    if (!p.email) return "no_recipient";
    if (s.scope === "selected" && !(p.clientId && s.clientIds.includes(p.clientId))) return "customer_not_included";
    if (p.recentlyAsked) return "throttled";
    return null;
}

export const ratingLinks = (base: string, token: string, scale: "stars" | "thumbs"): string =>
    (scale === "thumbs"
        ? [`Thumbs up: ${base}/survey?t=${token}&r=5`, `Thumbs down: ${base}/survey?t=${token}&r=1`]
        : [5, 4, 3, 2, 1].map((n) => `${n} - ${STAR_LABELS[n]}: ${base}/survey?t=${token}&r=${n}`)
    ).join("\n");
