// lib/bulk-api.ts
//
// Bulk device actions (many devices, one action, from the device list) and the batches they leave behind.
import { deviceFilterParams, jfetch, type DeviceFilters, type DeviceSortKey } from "@/lib/api";

/** Most devices one request may carry; the server refuses more. */
export const MAX_BULK = 500;

export type BulkKind = "reboot" | "patch-scan" | "patch-install" | "update-agent" | "move-site" | "tags" | "delete-request" | "run-script" | "set-ring" | "security-scan" | "escrow-bitlocker" | "rotate-laps-password";
export type BulkItemStatus = "done" | "queued" | "skipped" | "failed";

export type BulkResult = {
    batchId: string;
    action: BulkKind;
    summary: string;
    requested: number;
    succeeded: number;
    skipped: number;
    failed: number;
    items: Array<{ id: string; deviceId: string; name: string; status: BulkItemStatus; reason: string | null; hasJob: boolean }>;
};

export type BatchSummary = { id: string; action: BulkKind; summary: string; requested: number; succeeded: number; skipped: number; failed: number; createdAt: string; by: string | null };

export type LiveState = "waiting" | "running" | "done" | "failed" | "timeout" | "cancelled";

export type BatchDetailData = BatchSummary & {
    progress: { waiting: number; running: number; done: number; failed: number };
    items: Array<{ id: string; deviceId: string; name: string; status: BulkItemStatus; reason: string | null; live: { state: LiveState; text: string } | null; hasOutput: boolean }>;
};

export function runBulk(kind: BulkKind, body: Record<string, unknown>): Promise<BulkResult> {
    return jfetch<BulkResult>(`/api/bulk/devices/${kind}`, { method: "POST", body });
}

export const fetchBatches = () => jfetch<{ items: BatchSummary[] }>("/api/bulk/batches?limit=50");
export const fetchBatch = (id: string) => jfetch<BatchDetailData>(`/api/bulk/batches/${encodeURIComponent(id)}`);
export const fetchBatchOutput = (id: string, itemId: string) =>
    jfetch<{ status: string; exitCode: number | null; stdout: string; stderr: string }>(`/api/bulk/batches/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/output`);

/** The devices a filter matches (at most 500, and how many match in all): what "select all N matching" uses. */
export async function fetchMatchingIds(filters: DeviceFilters, sort?: { sort?: DeviceSortKey; dir?: "asc" | "desc" }): Promise<{ items: Array<{ id: string; hostname: string }>; total: number; limit: number }> {
    const sp = new URLSearchParams();
    deviceFilterParams(sp, filters);
    if (sort?.sort) {
        sp.set("sort", sort.sort);
        sp.set("dir", sort.dir ?? "asc");
    }
    return await jfetch(`/api/devices/ids?${sp.toString()}`);
}

export const BULK_LABEL: Record<BulkKind, string> = {
    reboot: "Restart",
    "patch-scan": "Scan for updates",
    "patch-install": "Install updates",
    "update-agent": "Update agent",
    "move-site": "Move to site",
    tags: "Tag",
    "delete-request": "Request removal",
    "run-script": "Run script",
    "set-ring": "Set update ring",
    "security-scan": "Run security scan",
    "escrow-bitlocker": "Escrow BitLocker keys",
    "rotate-laps-password": "Rotate local admin password",
};

/** "Acme, Beta and 7 more". */
export function namesText(items: { name: string }[], shown = 5): string {
    const first = items.slice(0, shown).map((i) => i.name);
    const more = items.length - first.length;
    return more > 0 ? `${first.join(", ")} and ${more} more` : first.length > 1 ? `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}` : first[0] ?? "";
}

