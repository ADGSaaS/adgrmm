// lib/itdocs-api.ts
import { jfetch } from "@/lib/api";

export type AssetKind = "computer" | "server" | "network" | "printer" | "mobile" | "licence" | "domain" | "certificate" | "other";

export type Asset = {
    id: string;
    client: { id: string; name: string };
    deviceId: string | null;
    name: string;
    kind: AssetKind;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    location: string | null;
    purchaseDate: string | null;
    expiresAt: string | null;
    notes: string | null;
    details: { os?: string | null; cpu?: string | null; ram?: string | null; ip?: string | null; mac?: string | null };
    source: "manual" | "agent" | "discovery" | "snmp";
    lastSyncedAt: string | null;
};

export type ExpiringItem = { type: "asset"; id: string; name: string; kind: string; client: string; expiresAt: string };

export type LinkType = "ticket" | "device" | "asset";
export type EntityLink = { linkId: string; type: LinkType; id: string; label: string };

const query = (params: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    const text = sp.toString();
    return text ? `?${text}` : "";
};

export const itdocs = {
    assets: (params: { clientId?: string; kind?: string; q?: string }) => jfetch<{ items: Asset[] }>(`/api/docs/assets${query(params)}`),
    saveAsset: (id: string | null, body: Record<string, unknown>) => jfetch<{ id: string }>(id ? `/api/docs/assets/${id}` : "/api/docs/assets", { method: id ? "PUT" : "POST", body }),
    deleteAsset: (id: string) => jfetch(`/api/docs/assets/${id}`, { method: "DELETE" }),
    syncAssets: () => jfetch<{ created: number; updated: number }>("/api/docs/assets/sync", { method: "POST", body: {} }),

    expiring: (days: number) => jfetch<{ items: ExpiringItem[] }>(`/api/docs/expiring?days=${days}`),

    links: (type: LinkType, id: string) => jfetch<{ items: EntityLink[] }>(`/api/docs/links?type=${type}&id=${id}`),
    targets: (type: LinkType, q: string) => jfetch<{ items: Array<{ id: string; label: string }> }>(`/api/docs/link-targets?type=${type}&q=${encodeURIComponent(q)}`),
    addLink: (body: { fromType: LinkType; fromId: string; toType: LinkType; toId: string }) => jfetch("/api/docs/links", { method: "POST", body }),
    removeLink: (id: string) => jfetch(`/api/docs/links/${id}`, { method: "DELETE" }),
};
