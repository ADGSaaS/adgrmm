// Talking to Microsoft's sign-in service and to Graph. Only what the support mailbox needs.

export const IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All";
export const GRAPH_SEND_SCOPE = "https://graph.microsoft.com/Mail.Send";

/** Asked for once, when a person signs in: IMAP to read mail, Graph to send, and a refresh token to stay signed in. */
export const CONSENT_SCOPES = ["openid", "profile", "email", "offline_access", IMAP_SCOPE, GRAPH_SEND_SCOPE];

/** A token request may name only ONE resource (Microsoft error AADSTS28000 otherwise), so the code is redeemed for the IMAP resource and Graph tokens are fetched later with the refresh token. */
export const TOKEN_EXCHANGE_SCOPES = ["openid", "profile", "email", "offline_access", IMAP_SCOPE];

const AUTHORITY = "https://login.microsoftonline.com";

/** A tenant is a GUID or a domain; anything else could change where the request goes. */
export function validTenant(tenant: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(tenant) && !tenant.includes("..");
}

export function validClientId(id: string): boolean {
    return /^[0-9a-fA-F-]{36}$/.test(id);
}

export function authorizeUrl(p: { tenant: string; clientId: string; redirectUri: string; state: string; loginHint?: string }): string {
    const q = new URLSearchParams({
        client_id: p.clientId,
        response_type: "code",
        redirect_uri: p.redirectUri,
        response_mode: "query",
        scope: CONSENT_SCOPES.join(" "),
        state: p.state,
        prompt: "select_account",
    });
    if (p.loginHint) q.set("login_hint", p.loginHint);
    return `${AUTHORITY}/${encodeURIComponent(p.tenant)}/oauth2/v2.0/authorize?${q.toString()}`;
}

export type TokenResult = { accessToken: string; refreshToken: string | null; idToken: string | null; expiresIn: number };

export class MicrosoftAuthError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
    }
    /** The saved sign-in no longer works and the person has to sign in again. */
    get needsReconnect(): boolean {
        return ["invalid_grant", "interaction_required", "consent_required", "login_required"].includes(this.code);
    }
}

async function tokenRequest(tenant: string, body: Record<string, string>): Promise<TokenResult> {
    const res = await fetch(`${AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
        const text = String(json.error_description ?? json.error ?? `HTTP ${res.status}`).split(/\r?\n/)[0].slice(0, 300);
        throw new MicrosoftAuthError(text, String(json.error ?? "token_error"));
    }
    return {
        accessToken: String(json.access_token),
        refreshToken: json.refresh_token ? String(json.refresh_token) : null,
        idToken: json.id_token ? String(json.id_token) : null,
        expiresIn: Number(json.expires_in) || 3600,
    };
}

export function exchangeCode(p: { tenant: string; clientId: string; clientSecret: string; code: string; redirectUri: string }) {
    return tokenRequest(p.tenant, {
        grant_type: "authorization_code",
        client_id: p.clientId,
        client_secret: p.clientSecret,
        code: p.code,
        redirect_uri: p.redirectUri,
        scope: TOKEN_EXCHANGE_SCOPES.join(" "),
    });
}

/** A token for one resource (IMAP or Graph). Microsoft may hand back a newer refresh token: keep it. */
export function refreshFor(p: { tenant: string; clientId: string; clientSecret: string; refreshToken: string; scope: string }) {
    return tokenRequest(p.tenant, {
        grant_type: "refresh_token",
        client_id: p.clientId,
        client_secret: p.clientSecret,
        refresh_token: p.refreshToken,
        scope: `${p.scope} offline_access`,
    });
}

/** The account that signed in, read from the ID token we just received over TLS from Microsoft. */
export function accountFromIdToken(idToken: string | null): string | null {
    if (!idToken) return null;
    try {
        const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
        const v = String(payload.preferred_username ?? payload.email ?? payload.upn ?? "").trim().toLowerCase();
        return /^[^\s@]+@[^\s@]+$/.test(v) ? v : null;
    } catch {
        return null;
    }
}

export async function graphSendMail(accessToken: string, mail: { to: string; subject: string; text: string }): Promise<void> {
    const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
            message: {
                subject: mail.subject,
                body: { contentType: "Text", content: mail.text },
                toRecipients: [{ emailAddress: { address: mail.to } }],
            },
            saveToSentItems: true,
        }),
        signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 202 || res.ok) return;
    const json: any = await res.json().catch(() => ({}));
    throw new Error(String(json?.error?.message ?? `Microsoft Graph returned HTTP ${res.status}`).slice(0, 300));
}
