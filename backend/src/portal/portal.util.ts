import { createHash, createHmac, randomBytes } from "node:crypto";
import { getJwtSecret } from "../auth/jwt-secret";

export const PORTAL_COOKIE = "portal_token";
export const PORTAL_MODULES = ["dashboard", "tickets", "devices", "invoices", "reports", "knowledge"] as const;
export type PortalModule = (typeof PORTAL_MODULES)[number];

export const SESSION_DAYS = 14;
export const INVITE_DAYS = 7;
export const RESET_HOURS = 2;
export const MIN_PASSWORD = 10;

/**
 * Portal sign-ins are signed with a key derived from the server secret but different from the one staff tokens use,
 * so a portal token is never accepted as a staff token (or the other way round), even by mistake.
 */
export function portalSecret(): string {
    return createHmac("sha256", getJwtSecret()).update("adgrmm:client-portal:v1").digest("hex");
}

export function newToken(): string {
    return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Turns what a person typed ("https://Portal.Example.com/") into a bare host name, or says why it cannot be used.
 * An empty value means "no domain set".
 */
export function normalizeDomain(input: unknown): { domain: string | null; error?: string } {
    let v = String(input ?? "").trim().toLowerCase();
    if (!v) return { domain: null };
    // Longer than any host name (253), so the pattern work below is bounded; the checks after it reject anything odd.
    if (v.length > 300 || /[\r\n]/.test(v)) return { domain: null, error: "That is not a valid domain name. Use something like portal.example.com." };
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    const slash = v.indexOf("/");
    if (slash >= 0) v = v.slice(0, slash);
    if (v.endsWith(".")) v = v.slice(0, -1);
    if (/:\d+$/.test(v)) return { domain: null, error: "Leave the port off: use just the name, like portal.example.com." };
    if (!HOST.test(v)) return { domain: null, error: "That is not a valid domain name. Use something like portal.example.com." };
    if (/^\d+(\.\d+){3}$/.test(v) || v === "localhost") return { domain: null, error: "Use a domain name, not an IP address." };
    return { domain: v };
}

export function passwordProblem(password: unknown): string | null {
    const p = String(password ?? "");
    if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
    if (p.length > 128) return "Use at most 128 characters.";
    if (/^(.)\1+$/.test(p)) return "Choose a password that is not one repeated character.";
    return null;
}

export function validEmail(v: unknown): string | null {
    const e = String(v ?? "").trim().toLowerCase();
    return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

export const STATUS_LABEL: Record<string, string> = {
    open: "Open",
    in_progress: "In progress",
    pending: "Waiting",
    resolved: "Resolved",
    closed: "Closed",
};
