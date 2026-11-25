// Session recordings: the list page's calls and the pieces the recorder in the console uses.
import { apiUrl, jfetch } from "@/lib/api";

export type RecordingStatus = "recording" | "complete" | "interrupted" | "failed";

export type RecordingRow = {
    id: string;
    sessionId: string;
    deviceId: string | null;
    deviceName: string | null;
    clientId: string | null;
    clientName: string | null;
    technicianId: string | null;
    technicianName: string | null;
    status: RecordingStatus;
    startedAt: string;
    endedAt: string | null;
    durationMs: number;
    sizeBytes: number;
    expiresAt: string;
};

export type RecordingList = { items: RecordingRow[]; total: number; sizeBytes: number; limit: number; offset: number };
export type RecordingFacets = { clients: { id: string; name: string }[]; technicians: { id: string; name: string }[] };
export type RecordingSettings = { retentionDays: number; maxRecordingMb: number; quotaGb: number; usedBytes: number; recordings: number };

export type RecordingFilters = { clientId?: string; deviceId?: string; technicianId?: string; from?: string; to?: string; status?: string; limit?: number; offset?: number };

function qs(f: Record<string, unknown>) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
}

export const recordings = {
    list: (f: RecordingFilters) => jfetch<RecordingList>(`/api/remote-recordings${qs(f)}`),
    facets: () => jfetch<RecordingFacets>("/api/remote-recordings/facets"),
    settings: () => jfetch<RecordingSettings>("/api/remote-recordings/settings"),
    saveSettings: (s: Partial<Pick<RecordingSettings, "retentionDays" | "maxRecordingMb" | "quotaGb">>) => jfetch<RecordingSettings>("/api/remote-recordings/settings", { method: "PATCH", body: s }),
    remove: (id: string) => jfetch<{ ok: true }>(`/api/remote-recordings/${encodeURIComponent(id)}`, { method: "DELETE" }),
    cleanup: () => jfetch<{ expired: number; interrupted: number; orphans: number }>("/api/remote-recordings/cleanup", { method: "POST", body: {} }),
    /** The playback address: the browser sends the sign-in cookie with it, so it needs no separate link. */
    streamUrl: (id: string, download = false) => apiUrl(`/api/remote-recordings/${encodeURIComponent(id)}/stream${download ? "?download=1" : ""}`),

    // used by the recorder in the console
    start: (sessionId: string) => jfetch<{ id: string; nextSeq: number; maxPieceBytes: number; maxRecordingBytes: number }>("/api/remote-recordings", { method: "POST", body: { sessionId } }),
    finish: (id: string, durationMs: number, keepalive = false) =>
        jfetch<{ status: string }>(`/api/remote-recordings/${encodeURIComponent(id)}/finish`, { method: "POST", body: { durationMs }, keepalive }),
};

export class PieceRefused extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

/** Sends one piece. A 4xx other than "slow down" means the server will never take it. */
export async function uploadPiece(id: string, seq: number, data: Blob): Promise<{ nextSeq: number; sizeBytes: number; duplicate: boolean }> {
    const res = await fetch(apiUrl(`/api/remote-recordings/${encodeURIComponent(id)}/chunks?seq=${seq}`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
    });
    if (!res.ok) {
        let msg = `The server answered ${res.status}.`;
        try {
            const j = await res.json();
            if (j?.message) msg = String(j.message);
        } catch {
            // keep the generic text
        }
        throw new PieceRefused(msg, res.status);
    }
    return res.json();
}
