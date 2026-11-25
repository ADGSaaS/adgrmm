// lib/vault-api.ts
//
// Security basics (stage 2): the device secrets vault. BitLocker recovery keys and the local administrator password (LAPS style) are
// stored encrypted on the server and shown only to people with devices.secrets.reveal. This client never keeps a revealed secret:
// reveal() hands it to the caller once and nothing here stores, caches or logs it.
//
// It does its own fetch (not jfetch) because the server's 429 answer carries a retry time and a code that jfetch would drop.
import { apiUrl } from "@/lib/api";

export type SecretKind = "bitlocker_recovery" | "luks_recovery" | "local_admin";
export type SecretStatus = "current" | "previous" | "unconfirmed";
export type AccessAction = "reveal" | "escrow" | "rotate" | "rotate-requested" | "purge";

export type SecretItem = {
    id: string; kind: SecretKind; label: string; refTail: string; status: SecretStatus;
    createdAt: string; rotatedAt: string | null; lastRevealedAt: string | null; lastRevealedBy: string | null; warning: string | null;
};

export type SecretsView = {
    device: { id: string; name: string };
    windows: boolean; linux?: boolean; online: boolean; hasAgent: boolean; canReveal: boolean; canManage: boolean;
    escrow: { enabled: boolean; source: string | null; pending: boolean; lastOkAt: string | null; lastAttemptAt: string | null; message: string | null };
    laps: {
        enabled: boolean; source: string | null; account: string; passwordLength: number; rotateDays: number; rotateAfterRevealMinutes: number;
        pending: boolean; lastOkAt: string | null; lastAttemptAt: string | null; attempt: "ok" | "failed" | "unconfirmed" | "no_answer" | null;
        message: string | null; nextRotationAt: string | null; rotateDueAt: string | null; mayStillBeValid: boolean;
    };
    items: SecretItem[];
    recentAccess: Array<{ id: string; at: string; userName: string | null; action: AccessAction; label: string | null; reason: string | null; outcome: string }>;
};

export type RevealResult = {
    secret: string; kind: SecretKind; label: string; refTail: string; status: SecretStatus; warning: string | null;
    revealedAt: string; hideAfterSec: number; rotateAt: string | null;
};

export type AccessRow = {
    id: string; at: string; deviceId: string; deviceName: string; customer: string | null; secretKind: SecretKind | null; label: string | null;
    userId: string | null; userName: string | null; action: AccessAction; reason: string | null; outcome: string; error: string | null;
};
export type AccessPage = { total: number; limit: number; offset: number; items: AccessRow[] };

/** A failed call: the HTTP status, the server's readable message, and for a rate limit the code and the wait. */
export class VaultError extends Error {
    status: number;
    code: string | null;
    retryAfterSec: number | null;
    constructor(status: number, message: string, code: string | null = null, retryAfterSec: number | null = null) {
        super(message);
        this.name = "VaultError";
        this.status = status;
        this.code = code;
        this.retryAfterSec = retryAfterSec;
    }
}

async function vfetch<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const res = await fetch(apiUrl(path), {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
        let message = "";
        let code: string | null = null;
        let retry: number | null = null;
        try {
            const d = (await res.json()) as { message?: string | string[]; code?: string; retryAfterSec?: number };
            message = Array.isArray(d.message) ? d.message.join(" ") : d.message ?? "";
            code = typeof d.code === "string" ? d.code : null;
            retry = typeof d.retryAfterSec === "number" ? d.retryAfterSec : null;
        } catch {
            /* not JSON */
        }
        if (retry === null && res.status === 429) {
            const h = Number(res.headers.get("Retry-After"));
            if (Number.isFinite(h) && h > 0) retry = h;
        }
        throw new VaultError(res.status, message || `Request failed (${res.status})`, code, retry);
    }
    return (await res.json()) as T;
}

const base = (id: string) => `/api/devices/${encodeURIComponent(id)}/secrets`;

export const vault = {
    device: (id: string) => vfetch<SecretsView>(base(id)),
    reveal: (id: string, secretId: string, reason: string) => vfetch<RevealResult>(`${base(id)}/${encodeURIComponent(secretId)}/reveal`, { method: "POST", body: { reason } }),
    escrow: (id: string) => vfetch<{ queued: boolean; alreadyWaiting: boolean }>(`${base(id)}/escrow`, { method: "POST", body: {} }),
    rotate: (id: string) => vfetch<{ queued: boolean; alreadyWaiting: boolean }>(`${base(id)}/rotate`, { method: "POST", body: {} }),
    access(p: { clientId?: string; deviceId?: string; user?: string; limit?: number; offset?: number }) {
        const sp = new URLSearchParams();
        if (p.clientId) sp.set("clientId", p.clientId);
        if (p.deviceId?.trim()) sp.set("deviceId", p.deviceId.trim());
        if (p.user?.trim()) sp.set("user", p.user.trim());
        sp.set("limit", String(p.limit ?? 50));
        sp.set("offset", String(p.offset ?? 0));
        return vfetch<AccessPage>(`/api/security/secret-access?${sp.toString()}`);
    },
};

/** Why a reason is not acceptable yet, or null. The server checks the same rules (5 to 300 characters, trimmed, no control characters). */
export function reasonProblem(reason: string): string | null {
    const t = reason.trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(t)) return "Use plain text on one line, without line breaks or control characters.";
    if (t.length < 5) return `Write at least 5 characters (${t.length} so far).`;
    if (t.length > 300) return `Keep it to 300 characters (${t.length} now).`;
    return null;
}

export const ACTION_TEXT: Record<AccessAction, string> = {
    reveal: "Revealed",
    escrow: "Keys escrowed",
    rotate: "Password rotated",
    "rotate-requested": "Rotation requested",
    purge: "Purged",
};

export const KIND_TEXT: Record<SecretKind, string> = { bitlocker_recovery: "BitLocker recovery key", luks_recovery: "Disk (LUKS) recovery key", local_admin: "Local administrator password" };

export const STATUS_TEXT: Record<SecretStatus, string> = { current: "Current", previous: "Replaced", unconfirmed: "Not confirmed" };
