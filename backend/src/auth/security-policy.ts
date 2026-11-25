// backend/src/auth/security-policy.ts
// The rules from Administration > Security Policies, as plain functions so the places that enforce them
// (sign-in, password changes, the session checks, the sockets) all read one source.
import { BlockList, isIP } from "node:net";
import type { PrismaService } from "../storage/prisma.service";

export type SecurityPolicy = {
    passwordMinLength: number;
    passwordRequireNumbers: boolean;
    passwordRequireSpecial: boolean;
    passwordRequireUppercase: boolean;
    passwordHistory: number;
    /** Minutes a sign-in may last. 0 means no limit. */
    sessionTimeoutMins: number;
    /** Minutes without any request before a sign-in ends. 0 means no limit. */
    idleTimeoutMins: number;
    ipAllowlist: string;
    captchaEnabled: boolean;
    turnstileSiteKey: string;
    /** Encrypted. Never leaves the server. */
    turnstileSecret: string | null;
};

export const DEFAULT_POLICY: SecurityPolicy = {
    passwordMinLength: 8,
    passwordRequireNumbers: false,
    passwordRequireSpecial: false,
    passwordRequireUppercase: false,
    passwordHistory: 0,
    sessionTimeoutMins: 0,
    idleTimeoutMins: 0,
    ipAllowlist: "",
    captchaEnabled: false,
    turnstileSiteKey: "",
    turnstileSecret: null,
};

/** Limits the settings screen enforces. The floor of 8 matches what the account forms always required. */
export const LIMITS = {
    passwordMinLength: [8, 128],
    passwordHistory: [0, 10],
    sessionTimeoutMins: [15, 10080], // a sign-in cookie lasts 7 days at most
    idleTimeoutMins: [5, 10080],
} as const;

// ---- Reading the policy (cached, so every request does not hit the database) -----------------------------

const CACHE_MS = 5_000;
const cache = new Map<string, { at: number; policy: SecurityPolicy }>();

export function forgetPolicyCache(orgId?: string): void {
    if (orgId) cache.delete(orgId);
    else cache.clear();
}

export function fromRow(r: any | null | undefined): SecurityPolicy {
    if (!r) return { ...DEFAULT_POLICY };
    return {
        passwordMinLength: r.password_min_length,
        passwordRequireNumbers: r.password_require_numbers,
        passwordRequireSpecial: r.password_require_special,
        passwordRequireUppercase: r.password_require_uppercase,
        passwordHistory: r.password_history,
        sessionTimeoutMins: r.session_timeout_mins,
        idleTimeoutMins: r.idle_timeout_mins,
        ipAllowlist: r.ip_allowlist ?? "",
        captchaEnabled: r.captcha_enabled,
        turnstileSiteKey: r.turnstile_site_key ?? "",
        turnstileSecret: r.turnstile_secret ?? null,
    };
}

/**
 * The policy of an organization. When the database cannot be read this returns the defaults, which enforce
 * nothing new: a failed read must not sign everybody out.
 */
export async function loadPolicy(prisma: PrismaService, orgId: string | null | undefined): Promise<SecurityPolicy> {
    if (!orgId) return { ...DEFAULT_POLICY };
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.policy;
    try {
        const row = await prisma.security_policies.findUnique({ where: { organization_id: orgId } });
        const policy = fromRow(row);
        cache.set(orgId, { at: Date.now(), policy });
        return policy;
    } catch {
        return hit?.policy ?? { ...DEFAULT_POLICY };
    }
}

// ---- Sessions ---------------------------------------------------------------------------------------------

export type SessionEnd = "session_timeout" | "idle_timeout" | null;

/** Why a session has run out, or null when it may continue. */
export function sessionEnd(policy: SecurityPolicy, s: { created_at: Date; last_seen_at: Date }, now = Date.now()): SessionEnd {
    if (policy.sessionTimeoutMins > 0 && now - s.created_at.getTime() > policy.sessionTimeoutMins * 60_000) return "session_timeout";
    if (policy.idleTimeoutMins > 0 && now - s.last_seen_at.getTime() > policy.idleTimeoutMins * 60_000) return "idle_timeout";
    return null;
}

export const SESSION_END_MESSAGE: Record<Exclude<SessionEnd, null>, string> = {
    session_timeout: "Your session has expired. Sign in again.",
    idle_timeout: "You were signed out after being idle. Sign in again.",
};

// ---- Passwords --------------------------------------------------------------------------------------------

/** What is wrong with a password under the rules, as sentences. Empty when it is fine. */
export function passwordProblems(policy: SecurityPolicy, password: unknown): string[] {
    const pw = typeof password === "string" ? password : "";
    const out: string[] = [];
    if (pw.length < policy.passwordMinLength) out.push(`be at least ${policy.passwordMinLength} characters long`);
    if (policy.passwordRequireUppercase && !/[A-Z]/.test(pw)) out.push("contain an uppercase letter");
    if (policy.passwordRequireNumbers && !/[0-9]/.test(pw)) out.push("contain a number");
    if (policy.passwordRequireSpecial && !/[^A-Za-z0-9]/.test(pw)) out.push("contain a special character, such as ! or #");
    return out;
}

export function describePasswordRules(policy: SecurityPolicy): string {
    const parts = [`at least ${policy.passwordMinLength} characters`];
    if (policy.passwordRequireUppercase) parts.push("an uppercase letter");
    if (policy.passwordRequireNumbers) parts.push("a number");
    if (policy.passwordRequireSpecial) parts.push("a special character");
    if (policy.passwordHistory > 0) parts.push(`not one of your last ${policy.passwordHistory} passwords`);
    return parts.join(", ");
}

// ---- The address list -------------------------------------------------------------------------------------

export type AllowEntry = { raw: string; address: string; prefix: number; family: "ipv4" | "ipv6" };

/** Plain form of an address: IPv4-mapped IPv6 addresses (::ffff:1.2.3.4) are the IPv4 address. */
export function normalizeIp(value: unknown): string | null {
    if (typeof value !== "string") return null;
    let ip = value.trim();
    if (!ip) return null;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) ip = mapped[1];
    return isIP(ip) ? ip : null;
}

/** Parses the text box: one address or CIDR range per line. `#` starts a comment. Throws a sentence for the first bad line. */
export function parseAllowlist(text: string): AllowEntry[] {
    const entries: AllowEntry[] = [];
    const lines = String(text ?? "").split(/\r?\n/);
    lines.forEach((line, i) => {
        const clean = line.replace(/#.*$/, "").trim();
        if (!clean) return;
        const [addr, pfx, ...extra] = clean.split("/");
        const address = normalizeIp(addr);
        const bad = () => new Error(`Line ${i + 1} ("${clean.slice(0, 60)}") is not an IP address or a range such as 203.0.113.0/24.`);
        if (!address || extra.length) throw bad();
        const family = isIP(address) === 4 ? "ipv4" : "ipv6";
        const max = family === "ipv4" ? 32 : 128;
        let prefix = max;
        if (pfx !== undefined) {
            if (!/^\d{1,3}$/.test(pfx)) throw bad();
            prefix = Number(pfx);
            if (prefix > max) throw bad();
        }
        entries.push({ raw: clean, address, prefix, family });
    });
    return entries;
}

export function ipAllowed(entries: AllowEntry[], ip: unknown): boolean {
    if (entries.length === 0) return true;
    const addr = normalizeIp(ip);
    if (!addr) return false;
    const family = isIP(addr) === 4 ? "ipv4" : "ipv6";
    const list = new BlockList();
    for (const e of entries) {
        if (e.family === family) list.addSubnet(e.address, e.prefix, family);
    }
    return list.check(addr, family);
}
