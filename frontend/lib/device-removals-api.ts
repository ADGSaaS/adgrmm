// lib/device-removals-api.ts
//
// The removal request queue: devices someone asked to have removed, waiting for a person with the right to delete devices.
import { jfetch } from "@/lib/api";

export type RemovalRequest = {
    deviceId: string;
    name: string;
    hostname: string;
    customer: string | null;
    clientId: string | null;
    site: string | null;
    os: string | null;
    online: boolean;
    reason: string | null;
    requestedAt: string;
    requestedBy: string | null;
    requestedById: string | null;
    ticketId: string | null;
};

export type RemovalAnswer = {
    decision: "approve" | "decline";
    done: number;
    items: Array<{ deviceId: string; name: string; status: "deleted" | "declined" | "skipped" | "failed"; reason: string | null }>;
};

export const removals = {
    list: () => jfetch<{ total: number; items: RemovalRequest[] }>("/api/device-removals"),
    approve: (deviceIds: string[]) => jfetch<RemovalAnswer>("/api/device-removals/approve", { method: "POST", body: { deviceIds } }),
    decline: (deviceIds: string[]) => jfetch<RemovalAnswer>("/api/device-removals/decline", { method: "POST", body: { deviceIds } }),
};
