// backend/src/m365/m365.core.ts
//
// Microsoft 365 tenant management: what may be saved, and what is made of what Microsoft Graph said (findings, a health score, plain licence
// names). Pure (no database, no network) so it can be tested alone. Everything here is read-only: RemoteIQ reads a tenant and says what it sees;
// it never changes users, licences or policies.
import { BadRequestException } from "@nestjs/common";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** The tenant: its id (a GUID) or one of its domains (such as contoso.onmicrosoft.com). Nothing else may be put into the sign-in address. */
export function cleanTenant(v: unknown): string {
    const s = String(v ?? "").trim().toLowerCase();
    if (!s) throw new BadRequestException("Enter the tenant: its ID or a domain such as contoso.onmicrosoft.com.");
    if (!GUID.test(s) && !DOMAIN.test(s)) throw new BadRequestException("That is not a tenant ID (a GUID) or a domain name.");
    return s;
}

export function cleanAppId(v: unknown): string {
    const s = String(v ?? "").trim().toLowerCase();
    if (!GUID.test(s)) throw new BadRequestException("The application (client) ID is a GUID, such as 11111111-2222-3333-4444-555555555555.");
    return s;
}

export function cleanSecret(v: unknown): string {
    const s = String(v ?? "").trim();
    if (!s) throw new BadRequestException("Enter the client secret.");
    if (s.length > 256 || /[\s\u0000-\u001F]/.test(s)) throw new BadRequestException("That does not look like a client secret.");
    return s;
}

/** The names Microsoft gives licences are codes; these are the ones a small business meets. Anything else shows its code. */
const SKU_NAMES: Record<string, string> = {
    SPB: "Microsoft 365 Business Premium",
    O365_BUSINESS_PREMIUM: "Microsoft 365 Business Standard",
    O365_BUSINESS_ESSENTIALS: "Microsoft 365 Business Basic",
    O365_BUSINESS: "Microsoft 365 Apps for business",
    SMB_BUSINESS_PREMIUM: "Microsoft 365 Business Standard",
    SMB_BUSINESS_ESSENTIALS: "Microsoft 365 Business Basic",
    SPE_E3: "Microsoft 365 E3", SPE_E5: "Microsoft 365 E5", SPE_F1: "Microsoft 365 F3",
    ENTERPRISEPACK: "Office 365 E3", ENTERPRISEPREMIUM: "Office 365 E5", STANDARDPACK: "Office 365 E1", DESKLESSPACK: "Office 365 F3",
    EXCHANGESTANDARD: "Exchange Online (Plan 1)", EXCHANGEENTERPRISE: "Exchange Online (Plan 2)", EXCHANGEDESKLESS: "Exchange Online Kiosk",
    AAD_PREMIUM: "Microsoft Entra ID P1", AAD_PREMIUM_P2: "Microsoft Entra ID P2", EMS: "Enterprise Mobility + Security E3", EMSPREMIUM: "Enterprise Mobility + Security E5",
    POWER_BI_STANDARD: "Power BI (free)", POWER_BI_PRO: "Power BI Pro", FLOW_FREE: "Power Automate (free)", TEAMS_EXPLORATORY: "Microsoft Teams Exploratory",
    MCOEV: "Microsoft Teams Phone Standard", PHONESYSTEM_VIRTUALUSER: "Microsoft Teams Phone Resource Account", WINDOWS_STORE: "Windows Store for Business",
    PROJECTPREMIUM: "Project Plan 5", PROJECT_P1: "Project Plan 1", VISIOCLIENT: "Visio Plan 2", MCOMEETADV: "Microsoft 365 Audio Conferencing",
    DEFENDER_ENDPOINT_P1: "Microsoft Defender for Endpoint P1", WIN10_VDA_E3: "Windows 10/11 Enterprise E3", INTUNE_A: "Microsoft Intune Plan 1",
};
export const skuName = (code: string) => SKU_NAMES[code] ?? code;

/** Licences that cost nothing and are handed out freely: their unused count is not waste. */
const FREE_SKUS = new Set(["POWER_BI_STANDARD", "FLOW_FREE", "TEAMS_EXPLORATORY", "WINDOWS_STORE", "PHONESYSTEM_VIRTUALUSER", "MICROSOFT_BUSINESS_CENTER", "STREAM", "CCIBOTS_PRIVPREV_VIRAL"]);

/* ------------------------------ what Graph gave ------------------------------ */

export type GraphUser = {
    id: string; displayName?: string | null; userPrincipalName?: string | null; accountEnabled?: boolean | null; userType?: string | null;
    assignedLicenses?: Array<{ skuId: string }>; createdDateTime?: string | null; signInActivity?: { lastSignInDateTime?: string | null; lastNonInteractiveSignInDateTime?: string | null } | null;
};
export type GraphSku = { skuId: string; skuPartNumber: string; consumedUnits?: number; prepaidUnits?: { enabled?: number; suspended?: number; warning?: number } };
export type GraphMfa = { id?: string; userPrincipalName?: string; isMfaRegistered?: boolean; isMfaCapable?: boolean; isAdmin?: boolean; methodsRegistered?: string[] };
export type GraphRole = { displayName: string; members: Array<{ id: string; displayName?: string | null; userPrincipalName?: string | null }> };

/** What each part of the reading managed to get. A part a tenant did not allow is missing, and the findings that depend on it are not made up. */
export type Gathered = {
    org?: { displayName?: string; domains: string[] };
    users?: GraphUser[];
    skus?: GraphSku[];
    mfa?: GraphMfa[];
    roles?: GraphRole[];
    conditionalAccess?: { total: number; enabled: number };
    securityDefaults?: boolean;
    score?: { current: number; max: number };
    notRead: Record<string, string>;
};

export type Severity = "critical" | "warning" | "info";
export type Finding = { id: string; severity: Severity; title: string; detail: string };

export type Summary = {
    organization: { name: string | null; domains: string[] };
    counts: { users: number; members: number; guests: number; enabled: number; disabled: number; licensed: number } | null;
    licenses: Array<{ sku: string; name: string; enabled: number; consumed: number; available: number; free: boolean }>;
    mfa: { checked: number; registered: number; missing: number; missingList: Array<{ name: string; upn: string }> } | null;
    admins: Array<{ role: string; members: Array<{ name: string; upn: string; mfa: boolean | null }> }>;
    conditionalAccess: { total: number; enabled: number; securityDefaults: boolean | null } | null;
    score: { current: number; max: number; percent: number } | null;
    wasted: Array<{ name: string; upn: string; why: string }>;
    inactive: Array<{ name: string; upn: string; lastSignIn: string | null }>;
    findings: Finding[];
    health: number | null;
    notRead: Record<string, string>;
    readAt: string;
};

const INACTIVE_DAYS = 90;
const CAP = 100;
/** The role names that matter for the global administrator count. */
const GLOBAL_ADMIN = "global administrator";

/** Everything the findings and the page need, worked out from what Graph gave. */
export function analyze(g: Gathered, now = new Date()): Summary {
    const findings: Finding[] = [];
    const users = g.users;
    const name = (u: { displayName?: string | null; userPrincipalName?: string | null }) => u.displayName || u.userPrincipalName || "(no name)";
    const upn = (u: { userPrincipalName?: string | null }) => u.userPrincipalName ?? "";

    const members = users?.filter((u) => (u.userType ?? "Member") !== "Guest");
    const counts = users
        ? {
            users: users.length, members: members!.length, guests: users.length - members!.length,
            enabled: users.filter((u) => u.accountEnabled !== false).length, disabled: users.filter((u) => u.accountEnabled === false).length,
            licensed: users.filter((u) => (u.assignedLicenses?.length ?? 0) > 0).length,
        }
        : null;

    const licenses = (g.skus ?? []).map((s) => {
        const enabled = s.prepaidUnits?.enabled ?? 0, consumed = s.consumedUnits ?? 0;
        return { sku: s.skuPartNumber, name: skuName(s.skuPartNumber), enabled, consumed, available: Math.max(0, enabled - consumed), free: FREE_SKUS.has(s.skuPartNumber) };
    }).filter((l) => l.enabled > 0 || l.consumed > 0).sort((a, b) => b.consumed - a.consumed);

    // wasted: licences held by accounts that cannot sign in, and licences bought and never given out
    const wasted: Summary["wasted"] = [];
    for (const u of users ?? []) {
        if (u.accountEnabled === false && (u.assignedLicenses?.length ?? 0) > 0) wasted.push({ name: name(u), upn: upn(u), why: "The account is disabled but still holds a licence." });
    }
    const unused = licenses.filter((l) => !l.free && l.available > 0);
    if (unused.length) findings.push({ id: "licenses.unused", severity: "info", title: "Licences paid for and not given to anyone", detail: unused.map((l) => `${l.available} of ${l.enabled} ${l.name}`).join("; ") + "." });
    if (wasted.length) findings.push({ id: "licenses.disabled", severity: "warning", title: `${wasted.length} disabled ${wasted.length === 1 ? "account still holds" : "accounts still hold"} a licence`, detail: `${wasted.slice(0, 5).map((w) => w.name).join(", ")}${wasted.length > 5 ? " and more" : ""}. Taking the licence away saves its price.` });

    const inactive: Summary["inactive"] = [];
    const cutoff = now.getTime() - INACTIVE_DAYS * 86_400_000;
    const haveSignIns = users?.some((u) => u.signInActivity !== undefined && u.signInActivity !== null) ?? false;
    if (haveSignIns) {
        for (const u of members ?? []) {
            if (u.accountEnabled === false || (u.assignedLicenses?.length ?? 0) === 0) continue;
            const last = u.signInActivity?.lastSignInDateTime ?? u.signInActivity?.lastNonInteractiveSignInDateTime ?? null;
            const created = u.createdDateTime ? Date.parse(u.createdDateTime) : 0;
            // a new account that has not had time to sign in is not inactive
            if ((last ? Date.parse(last) : 0) < cutoff && created < cutoff) inactive.push({ name: name(u), upn: upn(u), lastSignIn: last });
        }
        if (inactive.length) findings.push({ id: "users.inactive", severity: "warning", title: `${inactive.length} licensed ${inactive.length === 1 ? "person has" : "people have"} not signed in for ${INACTIVE_DAYS} days`, detail: `${inactive.slice(0, 5).map((w) => w.name).join(", ")}${inactive.length > 5 ? " and more" : ""}. Their licences may be going to waste, or their accounts may be left over from people who left.` });
    }

    // sign-in protection
    let mfa: Summary["mfa"] = null;
    const mfaByUpn = new Map<string, boolean>();
    if (g.mfa) {
        for (const m of g.mfa) if (m.userPrincipalName) mfaByUpn.set(m.userPrincipalName.toLowerCase(), m.isMfaRegistered === true);
        const enabledMembers = (members ?? []).filter((u) => u.accountEnabled !== false);
        const rows = users ? enabledMembers.filter((u) => mfaByUpn.has(upn(u).toLowerCase())) : g.mfa.filter((m) => m.userPrincipalName);
        const missing = users ? rows.filter((u) => mfaByUpn.get(upn(u as GraphUser).toLowerCase()) !== true).map((u) => ({ name: name(u as GraphUser), upn: upn(u as GraphUser) }))
            : (rows as GraphMfa[]).filter((m) => m.isMfaRegistered !== true).map((m) => ({ name: m.userPrincipalName!, upn: m.userPrincipalName! }));
        mfa = { checked: rows.length, registered: rows.length - missing.length, missing: missing.length, missingList: missing.slice(0, CAP) };
        if (missing.length) {
            const pct = Math.round((100 * missing.length) / Math.max(1, rows.length));
            findings.push({ id: "mfa.missing", severity: pct >= 25 ? "critical" : "warning", title: `${missing.length} of ${rows.length} people have not set up multi-factor sign-in`, detail: `${missing.slice(0, 5).map((m) => m.name).join(", ")}${missing.length > 5 ? " and more" : ""}. A stolen password is enough to get into their mailbox.` });
        }
    }

    const admins: Summary["admins"] = (g.roles ?? []).filter((r) => r.members.length > 0).map((r) => ({
        role: r.displayName,
        members: r.members.slice(0, 50).map((m) => ({ name: name(m), upn: upn(m), mfa: g.mfa ? mfaByUpn.get(upn(m).toLowerCase()) ?? null : null })),
    }));
    if (g.roles) {
        const globals = new Set<string>();
        for (const r of g.roles) if (r.displayName.toLowerCase() === GLOBAL_ADMIN) for (const m of r.members) globals.add(m.id);
        if (globals.size > 4) findings.push({ id: "admins.many", severity: "warning", title: `${globals.size} people are global administrators`, detail: "Microsoft advises fewer than five. Each one is a way to take over everything." });
        else if (globals.size === 1) findings.push({ id: "admins.one", severity: "info", title: "Only one global administrator", detail: "If that person is locked out or leaves, nobody can fix the tenant. Microsoft advises at least two (one of them a break-glass account)." });
        else if (globals.size === 0) findings.push({ id: "admins.none", severity: "warning", title: "No global administrator could be read", detail: "The roles of this tenant were read, but none lists a global administrator." });
        if (g.mfa) {
            const bare = new Map<string, string>();
            for (const r of admins) for (const m of r.members) if (m.mfa === false) bare.set(m.upn, m.name);
            if (bare.size) findings.push({ id: "admins.mfa", severity: "critical", title: `${bare.size} ${bare.size === 1 ? "administrator has" : "administrators have"} no multi-factor sign-in`, detail: `${[...bare.values()].slice(0, 5).join(", ")}. An administrator account is the first thing attackers go for.` });
        }
    }

    const ca = g.conditionalAccess || g.securityDefaults !== undefined
        ? { total: g.conditionalAccess?.total ?? 0, enabled: g.conditionalAccess?.enabled ?? 0, securityDefaults: g.securityDefaults ?? null }
        : null;
    // only said when BOTH were read: a policy list the app may not read does not mean there are no policies
    if (g.conditionalAccess && g.securityDefaults !== undefined && ca && ca.enabled === 0 && ca.securityDefaults === false) {
        findings.push({ id: "signin.unprotected", severity: "critical", title: "Nothing requires multi-factor sign-in for the tenant", detail: "There are no active conditional access policies and security defaults are off, so multi-factor sign-in is not enforced for anyone." });
    }

    const score = g.score && g.score.max > 0 ? { current: g.score.current, max: g.score.max, percent: Math.round((100 * g.score.current) / g.score.max) } : null;
    if (score && score.percent < 40) findings.push({ id: "score.low", severity: "warning", title: `Microsoft Secure Score is ${score.percent}%`, detail: `${score.current} of ${score.max} points. Microsoft lists the actions that raise it in the Defender portal.` });

    const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);

    // a health figure only when enough was read to say anything: every critical finding costs 25, every warning 8
    const read = [users, g.mfa, g.roles, ca].filter((x) => x !== undefined && x !== null).length;
    const health = read >= 2 ? Math.max(0, 100 - findings.filter((f) => f.severity === "critical").length * 25 - findings.filter((f) => f.severity === "warning").length * 8) : null;

    return {
        organization: { name: g.org?.displayName ?? null, domains: g.org?.domains ?? [] },
        counts, licenses, mfa, admins, conditionalAccess: ca, score, wasted: wasted.slice(0, CAP), inactive: inactive.slice(0, CAP), findings, health, notRead: g.notRead, readAt: now.toISOString(),
    };
}

/** What a failed sign-in or read means, in words a person can act on (Microsoft's own codes are not). */
export function explainGraphError(status: number, code: string | undefined, message: string | undefined): string {
    const m = `${code ?? ""} ${message ?? ""}`;
    if (/AADSTS7000215|AADSTS7000222|invalid_client/i.test(m)) return /AADSTS7000222|expired/i.test(m) ? "The client secret has expired. Make a new one in the app registration and enter it here." : "The client secret is wrong. Copy its value (not its ID) when it is made.";
    if (/AADSTS700016|application.*not found/i.test(m)) return "No application with that ID exists in this tenant. Check the application (client) ID and the tenant.";
    if (/AADSTS90002|tenant.*not found|AADSTS900023/i.test(m)) return "That tenant could not be found. Check the tenant ID or domain.";
    if (/AADSTS7000112|disabled/i.test(m)) return "The application is disabled in the tenant.";
    if (status === 401) return "Microsoft did not accept the sign-in.";
    if (status === 403 || /Authorization_RequestDenied|Forbidden|Insufficient privileges/i.test(m)) return "The app is not allowed to read this. Add the permission (as an application permission) and grant admin consent.";
    if (status === 429) return "Microsoft asked us to slow down. It will be tried again later.";
    if (status >= 500) return "Microsoft had a problem. It will be tried again later.";
    return (message ?? `Microsoft answered with status ${status}.`).slice(0, 200);
}
