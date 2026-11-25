// backend/src/edr/edr.adapters.ts
//
// Reading the endpoints of an EDR or antivirus console. One function per product, read-only (only GET calls, plus the sign-in that every one
// of them needs, and CrowdStrike's "give me these devices by ID" which is a read made with POST). The addresses can be pointed elsewhere for
// a test (EDR_MDE_LOGIN_BASE, EDR_MDE_API_BASE, EDR_S1_BASE, EDR_HUNTRESS_BASE, EDR_CS_BASE). A "next page" address is only followed when it
// is on the product's own address, so a credential never goes anywhere else.
import { MAX_ENDPOINTS, fromCrowdStrike, fromHuntress, fromMde, fromSentinelOne, type Endpoint, type Vendor } from "./edr.core";

const TIMEOUT_MS = 25_000;
const MAX_PAGES = 60;

export class EdrError extends Error {
    constructor(message: string, public readonly status = 0) { super(message); }
}

const strip = (s: string) => s.replace(/\/+$/, "");
const mdeLogin = () => strip(process.env.EDR_MDE_LOGIN_BASE || "https://login.microsoftonline.com");
const mdeApi = () => strip(process.env.EDR_MDE_API_BASE || "https://api.securitycenter.microsoft.com");
const huntressBase = () => strip(process.env.EDR_HUNTRESS_BASE || "https://api.huntress.io");
const s1Base = (sub: string) => strip(process.env.EDR_S1_BASE || `https://${sub}.sentinelone.net`);
const CS_CLOUDS: Record<string, string> = { "us-1": "https://api.crowdstrike.com", "us-2": "https://api.us-2.crowdstrike.com", "eu-1": "https://api.eu-1.crowdstrike.com", "us-gov-1": "https://api.laggar.gcw.crowdstrike.com" };
const csBase = (cloud: string) => strip(process.env.EDR_CS_BASE || CS_CLOUDS[cloud] || CS_CLOUDS["us-1"]);

function friendly(vendor: string, status: number, said: string): string {
    if (status === 401) return `${vendor} did not accept the credentials. Check them, or make new ones.`;
    if (status === 403) return `${vendor} accepted the credentials, but they are not allowed to read endpoints. Give the API user or app the read permission.`;
    if (status === 429) return `${vendor} asked us to slow down. It will be tried again later.`;
    if (status >= 500) return `${vendor} had a problem. It will be tried again later.`;
    if (status === 404) return `${vendor} does not know that address. Check the console name or cloud.`;
    return `${vendor} answered with status ${status}${said ? `: ${said.slice(0, 160)}` : ""}.`;
}

async function call<T>(vendor: string, url: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
            res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
        } catch (e) {
            throw new EdrError(`${vendor} could not be reached (${(e as Error).message}).`);
        }
        if ((res.status === 429 || res.status === 503) && attempt < 2) {
            await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after")) || 2, 10) * 1000));
            continue;
        }
        const body = (await res.json().catch(() => null)) as any;
        if (!res.ok) {
            const said = body?.error_description ?? body?.error?.message ?? body?.errors?.[0]?.detail ?? body?.errors?.[0]?.message ?? body?.message ?? (typeof body?.error === "string" ? body.error : "");
            throw new EdrError(friendly(vendor, res.status, String(said || "")), res.status);
        }
        return body as T;
    }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const cap = <T>(list: T[]): T[] => list.slice(0, MAX_ENDPOINTS);

async function mde(config: Record<string, string>, secret: string): Promise<Endpoint[]> {
    const t = await call<{ access_token?: string }>("Microsoft Defender for Endpoint", `${mdeLogin()}/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "client_credentials", client_id: config.appId, client_secret: secret, scope: "https://api.securitycenter.microsoft.com/.default" }),
    });
    if (!t.access_token) throw new EdrError("Microsoft did not give a token.");
    const out: Endpoint[] = [];
    let url: string | undefined = `${mdeApi()}/api/machines?$top=10000`;
    for (let page = 0; url && page < MAX_PAGES && out.length < MAX_ENDPOINTS; page++) {
        if (!url.startsWith(`${mdeApi()}/`)) throw new EdrError("The console sent a link to somewhere else, and it was not followed.");
        const r: { value?: Array<Record<string, unknown>>; "@odata.nextLink"?: string } = await call("Microsoft Defender for Endpoint", url, { headers: { authorization: `Bearer ${t.access_token}`, accept: "application/json" } });
        for (const m of r.value ?? []) { const e = fromMde(m); if (e) out.push(e); }
        url = r["@odata.nextLink"];
    }
    return cap(out);
}

async function sentinelone(config: Record<string, string>, secret: string): Promise<Endpoint[]> {
    const base = s1Base(config.subdomain);
    const out: Endpoint[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES && out.length < MAX_ENDPOINTS; page++) {
        const r: { data?: Array<Record<string, unknown>>; pagination?: { nextCursor?: string | null } } = await call("SentinelOne", `${base}/web/api/v2.1/agents?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: { authorization: `ApiToken ${secret}`, accept: "application/json" } });
        for (const a of r.data ?? []) { const e = fromSentinelOne(a); if (e) out.push(e); }
        cursor = r.pagination?.nextCursor ?? null;
        if (!cursor) break;
    }
    return cap(out);
}

async function huntress(config: Record<string, string>, secret: string): Promise<Endpoint[]> {
    const auth = `Basic ${Buffer.from(`${config.apiKey}:${secret}`).toString("base64")}`;
    const out: Endpoint[] = [];
    for (let page = 1; page <= MAX_PAGES && out.length < MAX_ENDPOINTS; page++) {
        const r: { agents?: Array<Record<string, unknown>>; pagination?: { next_page?: number | null } } = await call("Huntress", `${huntressBase()}/v1/agents?limit=500&page=${page}`, { headers: { authorization: auth, accept: "application/json" } });
        for (const a of r.agents ?? []) { const e = fromHuntress(a); if (e) out.push(e); }
        if (!r.pagination?.next_page) break;
    }
    return cap(out);
}

async function crowdstrike(config: Record<string, string>, secret: string): Promise<Endpoint[]> {
    const base = csBase(config.cloud);
    const t = await call<{ access_token?: string }>("CrowdStrike", `${base}/oauth2/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form({ client_id: config.apiClientId, client_secret: secret }),
    });
    if (!t.access_token) throw new EdrError("CrowdStrike did not give a token.");
    const headers = { authorization: `Bearer ${t.access_token}`, accept: "application/json" };
    const ids: string[] = [];
    for (let offset = 0, page = 0; page < MAX_PAGES && ids.length < MAX_ENDPOINTS; page++) {
        const r: { resources?: string[]; meta?: { pagination?: { total?: number } } } = await call("CrowdStrike", `${base}/devices/queries/devices/v1?limit=500&offset=${offset}`, { headers });
        const got = r.resources ?? [];
        ids.push(...got);
        offset += got.length;
        if (!got.length || offset >= (r.meta?.pagination?.total ?? 0)) break;
    }
    const out: Endpoint[] = [];
    for (let i = 0; i < ids.length; i += 100) {
        const r: { resources?: Array<Record<string, unknown>> } = await call("CrowdStrike", `${base}/devices/entities/devices/v2`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ids: ids.slice(i, i + 100) }) });
        for (const d of r.resources ?? []) { const e = fromCrowdStrike(d); if (e) out.push(e); }
    }
    return cap(out);
}

/** Reads every endpoint the console knows. Throws an EdrError with words a person can act on. */
export async function fetchEndpoints(vendor: Vendor, config: Record<string, string>, secret: string): Promise<Endpoint[]> {
    if (vendor === "mde") return mde(config, secret);
    if (vendor === "sentinelone") return sentinelone(config, secret);
    if (vendor === "huntress") return huntress(config, secret);
    return crowdstrike(config, secret);
}
