// backend/src/auth/turnstile.ts
// Cloudflare Turnstile: the server side check of the token the sign-in page's widget produced.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Where the check goes. Only tests (a stand-in server) and air-gapped proxies have a reason to change it. */
export function verifyUrl(): string {
    return (process.env.RIQ_TURNSTILE_VERIFY_URL || "").trim() || TURNSTILE_VERIFY_URL;
}

export type TurnstileResult =
    /** Cloudflare accepted the token. */
    | { kind: "ok" }
    /** Cloudflare looked at it and said no (a bot, an expired or reused token). */
    | { kind: "rejected"; codes: string[] }
    /** The keys are wrong: the secret key was refused. Nobody can pass until it is fixed. */
    | { kind: "misconfigured"; codes: string[] }
    /** Cloudflare could not be reached or answered nonsense. */
    | { kind: "unreachable"; detail: string };

const SECRET_ERRORS = new Set(["missing-input-secret", "invalid-input-secret"]);

export async function verifyTurnstile(secret: string, token: string, remoteIp?: string | null): Promise<TurnstileResult> {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    let res: Response;
    try {
        res = await fetch(verifyUrl(), {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
            signal: AbortSignal.timeout(6_000),
        });
    } catch (e: any) {
        return { kind: "unreachable", detail: String(e?.cause?.code ?? e?.name ?? "network error") };
    }
    let data: any;
    try {
        data = await res.json();
    } catch {
        return { kind: "unreachable", detail: `HTTP ${res.status} without a readable answer` };
    }
    const codes: string[] = Array.isArray(data?.["error-codes"]) ? data["error-codes"].map(String) : [];
    if (data?.success === true) return { kind: "ok" };
    if (codes.some((c) => SECRET_ERRORS.has(c))) return { kind: "misconfigured", codes };
    if (res.status >= 500) return { kind: "unreachable", detail: `HTTP ${res.status}` };
    return { kind: "rejected", codes };
}
