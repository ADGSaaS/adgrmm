import { apiUrl } from "@/lib/api";
// adgrmm-frontend/lib/device-deletion.ts

type Json = any;

async function api<T = Json>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(apiUrl(path), {
        ...init,
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...(init?.headers ?? {}),
        },
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `Request failed (${res.status})`);
    }

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
}

/** Asks for a device to be removed. The reason is required; a ticket can be opened for the approval. */
export async function requestDeviceDeletion(deviceId: string, body: { reason: string; createTicket?: boolean }) {
    const id = String(deviceId ?? "").trim();
    if (!id) throw new Error("deviceId is required");
    return api<{ deviceId: string; status: string; ticketId: string | null }>(`/api/devices/${encodeURIComponent(id)}/deletion-requests`, { method: "POST", body: JSON.stringify(body) });
}

export type DeletionRequest = { status: "pending"; reason: string | null; requestedAt: string; requestedBy: string | null; ticketId: string | null };

/** What an approver sees before approving: who asked, why, and the ticket if one was opened. */
export async function getDeviceDeletionRequest(deviceId: string) {
    const id = String(deviceId ?? "").trim();
    if (!id) throw new Error("deviceId is required");
    return api<{ request: DeletionRequest | null }>(`/api/devices/${encodeURIComponent(id)}/deletion-requests`);
}

export async function approveDeviceDeletion(deviceId: string) {
    const id = String(deviceId ?? "").trim();
    if (!id) throw new Error("deviceId is required");
    return api(`/api/devices/${encodeURIComponent(id)}/deletion-requests/approve`, { method: "POST" });
}
