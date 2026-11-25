// backend/src/m365/m365.graph.ts
//
// Reading a Microsoft 365 tenant through Microsoft Graph, read-only, with an app that the customer (or the MSP) registered in Entra ID and
// gave application permissions. The sign-in and the Graph addresses can be pointed elsewhere with M365_LOGIN_BASE and M365_GRAPH_BASE (a test
// does). A "next page" address that Graph gives is only followed when it is on the Graph address: the token never goes anywhere else.
import {
    explainGraphError, type Gathered, type GraphMfa, type GraphRole, type GraphSku, type GraphUser,
} from "./m365.core";

const loginBase = () => (process.env.M365_LOGIN_BASE || "https://login.microsoftonline.com").replace(/\/+$/, "");
const graphBase = () => (process.env.M365_GRAPH_BASE || "https://graph.microsoft.com").replace(/\/+$/, "");
const TIMEOUT_MS = 25_000;
const MAX_USERS = 5000;
const MAX_PAGES = 40;

export class GraphError extends Error {
    constructor(public readonly status: number, public readonly code: string | undefined, public readonly raw: string | undefined) {
        super(explainGraphError(status, code, raw));
    }
}

/** An application token for Graph (client credentials). The secret is sent once, in the body, and not kept. */
export async function getToken(tenant: string, appId: string, secret: string): Promise<string> {
    let res: Response;
    try {
        res = await fetch(`${loginBase()}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "client_credentials", client_id: appId, client_secret: secret, scope: "https://graph.microsoft.com/.default" }).toString(),
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: "error",
        });
    } catch (e) {
        throw new GraphError(0, "network", `Microsoft could not be reached (${(e as Error).message}).`);
    }
    const j = (await res.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string } | null;
    if (!res.ok || !j?.access_token) throw new GraphError(res.status, j?.error, j?.error_description);
    return j.access_token;
}

async function get<T>(token: string, url: string): Promise<T> {
    const full = url.startsWith("http") ? url : `${graphBase()}${url}`;
    // never send the token to an address that is not Graph's own, whatever a "next page" link says
    if (!full.startsWith(`${graphBase()}/`)) throw new GraphError(0, "bad-link", "Microsoft sent a link to somewhere else, and it was not followed.");
    for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
            res = await fetch(full, { headers: { authorization: `Bearer ${token}`, accept: "application/json", consistencylevel: "eventual" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
        } catch (e) {
            throw new GraphError(0, "network", `Microsoft could not be reached (${(e as Error).message}).`);
        }
        if ((res.status === 429 || res.status === 503) && attempt < 2) {
            const wait = Math.min(Number(res.headers.get("retry-after")) || 2, 10);
            await new Promise((r) => setTimeout(r, wait * 1000));
            continue;
        }
        const j = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
        if (!res.ok) throw new GraphError(res.status, j?.error?.code, j?.error?.message);
        return j as T;
    }
}

/** Every page of a list, up to a limit. */
async function all<T>(token: string, first: string, max: number): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = first;
    for (let page = 0; url && page < MAX_PAGES && out.length < max; page++) {
        const r: { value?: T[]; "@odata.nextLink"?: string } = await get(token, url);
        out.push(...(r.value ?? []));
        url = r["@odata.nextLink"];
    }
    return out.slice(0, max);
}

/** Reads what can be read. A part that the app is not allowed to read is left out and said so; it does not stop the rest. */
export async function gather(token: string): Promise<Gathered> {
    const g: Gathered = { notRead: {} };
    const attempt = async <T>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
        try { return await fn(); } catch (e) { g.notRead[key] = e instanceof GraphError ? e.message : (e as Error).message; return undefined; }
    };

    await attempt("organization", async () => {
        const r = await get<{ value?: Array<{ displayName?: string; verifiedDomains?: Array<{ name?: string }> }> }>(token, "/v1.0/organization?$select=displayName,verifiedDomains");
        const o = r.value?.[0];
        if (o) g.org = { displayName: o.displayName, domains: (o.verifiedDomains ?? []).map((d) => d.name ?? "").filter(Boolean).slice(0, 20) };
    });

    const base = "id,displayName,userPrincipalName,accountEnabled,userType,assignedLicenses,createdDateTime";
    g.users = await attempt("users", async () => {
        try {
            return await all<GraphUser>(token, `/v1.0/users?$select=${base},signInActivity&$top=999`, MAX_USERS);
        } catch (e) {
            // sign-in times need a premium Entra licence and the AuditLog permission; without them the people are still read
            if (e instanceof GraphError && (e.status === 403 || e.status === 400)) {
                const users = await all<GraphUser>(token, `/v1.0/users?$select=${base}&$top=999`, MAX_USERS);
                g.notRead.signIns = "Sign-in times could not be read (they need Microsoft Entra ID P1 and the AuditLog.Read.All permission), so inactive people are not listed.";
                return users;
            }
            throw e;
        }
    });

    g.skus = await attempt("licenses", async () => (await get<{ value?: GraphSku[] }>(token, "/v1.0/subscribedSkus")).value ?? []);
    g.mfa = await attempt("mfa", () => all<GraphMfa>(token, "/v1.0/reports/authenticationMethods/userRegistrationDetails?$top=999", MAX_USERS));

    g.roles = await attempt("admins", async () => {
        const roles = await all<{ id: string; displayName: string }>(token, "/v1.0/directoryRoles", 100);
        const out: GraphRole[] = [];
        for (const r of roles.slice(0, 60)) {
            try {
                const members = await all<{ id: string; displayName?: string | null; userPrincipalName?: string | null; "@odata.type"?: string }>(token, `/v1.0/directoryRoles/${encodeURIComponent(r.id)}/members?$select=id,displayName,userPrincipalName`, 200);
                out.push({ displayName: r.displayName, members: members.filter((m) => !m["@odata.type"] || m["@odata.type"].endsWith("user")).map(({ id, displayName, userPrincipalName }) => ({ id, displayName, userPrincipalName })) });
            } catch { /* a role that cannot be read is left out */ }
        }
        return out;
    });

    const ca = await attempt("conditionalAccess", async () => {
        const policies = await all<{ id: string; state?: string }>(token, "/v1.0/identity/conditionalAccess/policies?$select=id,state", 500);
        return { total: policies.length, enabled: policies.filter((p) => p.state === "enabled").length };
    });
    if (ca) g.conditionalAccess = ca;
    const defaults = await attempt("securityDefaults", async () => (await get<{ isEnabled?: boolean }>(token, "/v1.0/policies/identitySecurityDefaultsEnforcementPolicy")).isEnabled === true);
    if (defaults !== undefined) g.securityDefaults = defaults;

    const score = await attempt("secureScore", async () => (await get<{ value?: Array<{ currentScore?: number; maxScore?: number }> }>(token, "/v1.0/security/secureScores?$top=1")).value?.[0]);
    if (score && typeof score.currentScore === "number" && typeof score.maxScore === "number") g.score = { current: score.currentScore, max: score.maxScore };
    return g;
}
