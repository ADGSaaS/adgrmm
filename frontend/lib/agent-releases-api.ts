// lib/agent-releases-api.ts
//
// Staged rollout of agent updates: update rings, the candidate / stable / previous builds, the pilot health gate, promote and withdraw.
import { apiUrl, jfetch } from "@/lib/api";

export type Ring = "pilot" | "stable";
export type ReleaseOs = "windows" | "linux";

export const RING_LABEL: Record<Ring, string> = { pilot: "Pilot", stable: "Everyone" };

export type SlotView = {
    state: "absent" | "valid" | "problem";
    problem: string | null;
    version: string | null;
    sha256: string | null;
    sizeBytes: number | null;
    modifiedAt: string | null;
};

export type GateStatus = "no_candidate" | "no_pilot_devices" | "not_updated_yet" | "offline_since_update" | "just_updated" | "healthy";

export type Gate = {
    candidateVersion: string | null;
    pilotTotal: number;
    onCandidate: number;
    onCandidateOnline: number;
    seenOnlineAfterUpdate: number;
    notYetUpdated: number;
    offlineSinceUpdating: number;
    updateFailed: number;
    status: GateStatus;
    message: string;
    blockers: string[];
};

export type SystemRelease = {
    os: ReleaseOs;
    stable: SlotView;
    candidate: SlotView;
    previous: SlotView;
    candidateNotNewer: boolean;
    ringCounts: Array<{ version: string; pilot: number; stable: number }>;
    gate: Gate;
};

export type ReleaseLogEntry = {
    at: string;
    actorEmail: string | null;
    action: "ring-device" | "ring-customer" | "ring-bulk" | "promote" | "withdraw";
    os: string | null;
    version: string | null;
    previousVersion: string | null;
    forced: boolean;
    reason: string | null;
};

export type ReleaseStatus = {
    autoUpdate: boolean;
    updatesDisabledByServer: boolean;
    rings: { pilot: number; stable: number };
    systems: SystemRelease[];
    recent: ReleaseLogEntry[];
    canManage: boolean;
};

export const fetchReleases = () => jfetch<ReleaseStatus>("/api/admin/agent-releases");

/** An error from promote / withdraw that keeps the server's code and the reasons, which jfetch would flatten. */
export class ReleaseError extends Error {
    constructor(message: string, readonly code: string | null, readonly blockers: string[], readonly status: number) {
        super(message);
    }
}

async function send<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
    const res = await fetch(apiUrl(path), { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
        const m = Array.isArray(data?.message) ? data.message.join(" ") : data?.message;
        throw new ReleaseError(m || `Request failed (${res.status}).`, typeof data?.code === "string" ? data.code : null, Array.isArray(data?.blockers) ? data.blockers.map(String) : [], res.status);
    }
    return data as T;
}

export const promoteRelease = (os: ReleaseOs, candidateVersion: string, force?: { reason: string }) =>
    send<{ ok: true; version: string; previousVersion: string | null; forced: boolean; status: ReleaseStatus }>("/api/admin/agent-releases/promote", "POST", {
        os, candidateVersion, ...(force ? { force: true, reason: force.reason } : {}),
    });

export const withdrawRelease = (os: ReleaseOs, candidateVersion: string) =>
    send<{ ok: true; version: string | null; pilotDevicesOnCandidate: number; note: string; status: ReleaseStatus }>("/api/admin/agent-releases/withdraw", "POST", { os, candidateVersion });

/** ring null = follow the customer's default. */
export const setDeviceRing = (deviceId: string, ring: Ring | null) =>
    send<{ deviceId: string; updateRing: Ring; updateRingOwn: Ring | null }>(`/api/admin/agent-releases/devices/${encodeURIComponent(deviceId)}/ring`, "PATCH", { ring });

export const fetchCustomerRing = (clientId: string) =>
    jfetch<{ clientId: string; defaultUpdateRing: Ring; devicesFollowingTheDefault: number }>(`/api/admin/agent-releases/customers/${encodeURIComponent(clientId)}/ring`);

export const setCustomerRing = (clientId: string, ring: Ring) =>
    send<{ clientId: string; defaultUpdateRing: Ring; devicesFollowingTheDefault: number }>(`/api/admin/agent-releases/customers/${encodeURIComponent(clientId)}/ring`, "PATCH", { ring });

/** Plain-language label and tone for the health gate's status. */
export const GATE_STATUS: Record<GateStatus, { label: string; tone: "ok" | "warn" | "bad" | "idle" }> = {
    no_candidate: { label: "No candidate build", tone: "idle" },
    no_pilot_devices: { label: "Not tried on any pilot device", tone: "bad" },
    not_updated_yet: { label: "Waiting for pilot devices to update", tone: "warn" },
    offline_since_update: { label: "A pilot device went quiet after updating", tone: "bad" },
    just_updated: { label: "Updated, not yet seen again", tone: "warn" },
    healthy: { label: "Looks healthy", tone: "ok" },
};

export const OS_NAME: Record<ReleaseOs, string> = { windows: "Windows", linux: "Linux" };

export function sizeText(n: number | null): string {
    if (n == null) return "";
    return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function logText(e: ReleaseLogEntry): string {
    const os = e.os ? (OS_NAME[e.os as ReleaseOs] ?? e.os) : "";
    switch (e.action) {
        case "promote": return `Promoted ${os} ${e.version ?? ""} to everyone${e.previousVersion ? ` (was ${e.previousVersion})` : ""}${e.forced ? `, anyway: ${e.reason ?? ""}` : ""}`;
        case "withdraw": return `Withdrew the ${os} candidate ${e.version ?? ""}`;
        case "ring-device": return "Changed the update ring of a device";
        case "ring-customer": return "Changed a customer's default update ring";
        default: return "Changed the update ring of several devices";
    }
}
