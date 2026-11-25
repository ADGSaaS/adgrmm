// OpenID Connect pieces that need no database: finding the provider's endpoints, proof keys for the code exchange,
// and checking an ID token. Kept apart so they can be tested against a stand-in provider.
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import * as jwt from "jsonwebtoken";

export type Discovery = {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
};

export class OidcError extends Error {
    constructor(message: string, readonly code: string = "sso_failed") {
        super(message);
    }
}

/** The provider is reached over https, except on this machine (used by tests and local setups). */
export function checkProviderUrl(raw: string, what: string): URL {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new OidcError(`${what} is not a valid address.`, "sso_misconfigured");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
        throw new OidcError(`${what} must start with https://`, "sso_misconfigured");
    }
    if (u.username || u.password) throw new OidcError(`${what} must not contain a username or password.`, "sso_misconfigured");
    return u;
}

async function getJson(url: string, what: string): Promise<any> {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new OidcError(`${what} returned HTTP ${res.status}.`, "sso_unreachable");
    const text = await res.text();
    if (text.length > 1_000_000) throw new OidcError(`${what} sent too much data.`, "sso_unreachable");
    try {
        return JSON.parse(text);
    } catch {
        throw new OidcError(`${what} did not send valid JSON.`, "sso_unreachable");
    }
}

/** Reads the provider's published settings. The issuer it names must be the one that was entered. */
export async function discover(issuer: string): Promise<Discovery> {
    const base = checkProviderUrl(issuer, "The issuer");
    const url = `${base.toString().replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const d = await getJson(url, "The provider's settings page");
    if (String(d.issuer ?? "").replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
        throw new OidcError("The provider says it is a different issuer than the one entered.", "sso_misconfigured");
    }
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        if (typeof d[k] !== "string") throw new OidcError(`The provider's settings have no ${k}.`, "sso_misconfigured");
        checkProviderUrl(d[k], k);
    }
    return { issuer: String(d.issuer), authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri };
}

const b64url = (b: Buffer) => b.toString("base64url");

/** A fresh secret for one sign-in, and the challenge made from it (PKCE, S256). */
export function newPkce() {
    const verifier = b64url(randomBytes(48));
    return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString("hex");

export function authorizationUrl(d: Discovery, p: { clientId: string; redirectUri: string; scopes: string; state: string; nonce: string; challenge: string }): string {
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set("client_id", p.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", p.redirectUri);
    u.searchParams.set("scope", p.scopes);
    u.searchParams.set("state", p.state);
    u.searchParams.set("nonce", p.nonce);
    u.searchParams.set("code_challenge", p.challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
}

export async function exchangeCode(d: Discovery, p: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string }): Promise<{ idToken: string }> {
    const res = await fetch(d.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: p.code,
            redirect_uri: p.redirectUri,
            client_id: p.clientId,
            client_secret: p.clientSecret,
            code_verifier: p.verifier,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof json.id_token !== "string") {
        const why = String(json.error_description ?? json.error ?? `HTTP ${res.status}`).split(/\r?\n/)[0].slice(0, 200);
        throw new OidcError(`The provider refused the sign-in: ${why}`, "sso_failed");
    }
    return { idToken: json.id_token };
}

export type Claims = {
    sub: string;
    email: string | null;
    emailVerified: boolean | null;
    name: string | null;
    givenName: string | null;
    familyName: string | null;
};

const ALGORITHMS: jwt.Algorithm[] = ["RS256", "RS384", "RS512", "PS256", "ES256"];

/** Checks the signature against the provider's published keys, and who the token is from, for and meant for. */
export async function verifyIdToken(d: Discovery, idToken: string, p: { clientId: string; nonce: string }): Promise<Claims> {
    const decoded = jwt.decode(idToken, { complete: true });
    const kid = (decoded as any)?.header?.kid as string | undefined;
    if (!decoded || typeof decoded === "string") throw new OidcError("The ID token could not be read.");
    const jwks = await getJson(d.jwks_uri, "The provider's key list");
    const keys: any[] = Array.isArray(jwks?.keys) ? jwks.keys : [];
    const candidates = keys.filter((k) => (kid ? k.kid === kid : true) && (k.use === undefined || k.use === "sig"));
    if (candidates.length === 0) throw new OidcError("The ID token was signed with a key the provider does not publish.");

    let payload: any = null;
    let lastError = "";
    for (const jwk of candidates) {
        try {
            payload = jwt.verify(idToken, createPublicKey({ key: jwk, format: "jwk" }), {
                algorithms: ALGORITHMS,
                issuer: d.issuer,
                audience: p.clientId,
                clockTolerance: 60,
            });
            break;
        } catch (e: any) {
            lastError = String(e?.message ?? e);
        }
    }
    if (!payload) throw new OidcError(`The ID token is not valid: ${lastError}`);
    if (payload.nonce !== p.nonce) throw new OidcError("The ID token was not issued for this sign-in.");
    if (typeof payload.sub !== "string" || !payload.sub) throw new OidcError("The ID token has no subject.");

    // Microsoft puts the sign-in name in preferred_username and may leave email out.
    const candidate = String(payload.email ?? payload.preferred_username ?? payload.upn ?? "").trim().toLowerCase();
    return {
        sub: payload.sub,
        email: /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : null,
        emailVerified: typeof payload.email_verified === "boolean" ? payload.email_verified : payload.email_verified === "true" ? true : payload.email_verified === "false" ? false : null,
        name: typeof payload.name === "string" ? payload.name : null,
        givenName: typeof payload.given_name === "string" ? payload.given_name : null,
        familyName: typeof payload.family_name === "string" ? payload.family_name : null,
    };
}

/** The domain part of an address is on the allowed list, or the list is empty. */
export function domainAllowed(email: string, allowed: string): boolean {
    const list = allowed.split(/[,\s]+/).map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    if (list.length === 0) return true;
    return list.includes(email.split("@")[1]?.toLowerCase() ?? "");
}

/** Where to send the browser after sign-in: a path on one of the sites allowed to call this server. */
export function safeReturn(raw: unknown, allowedOrigins: string[]): { origin: string; path: string } | null {
    try {
        const u = new URL(String(raw ?? ""));
        const local = ["localhost", "127.0.0.1"].includes(u.hostname);
        const allowed = allowedOrigins.length > 0 ? allowedOrigins.some((o) => o.replace(/\/+$/, "") === u.origin) : local;
        if (!allowed) return null;
        const path = u.pathname + u.search;
        if (!path.startsWith("/") || path.startsWith("//") || /^\/(login|auth\/login)/.test(path)) return { origin: u.origin, path: "/" };
        return { origin: u.origin, path };
    } catch {
        return null;
    }
}
