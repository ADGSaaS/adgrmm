// lib/assets-provider-api.ts
//
// Who owns assets: the built-in asset manager (the default) or an external one (the owner's Killian software). When it is external the
// built-in asset manager is switched off and nothing is deleted. See docs/design/asset-provider.md in the backend repository.
import { API_BASE, jfetch } from "@/lib/api";

export type AssetProviderInfo = { provider: "builtin" | "external"; externalName: string | null; externalUrl: string | null; changedAt: string | null; canSwitch: boolean };

export type AssetPreflight = {
    assets: number; fromAgents: number; enteredByHand: number; withWarrantyDate: number; expiringWithin30Days: number; linkedHosts: number; linkedSnmpDevices: number;
    willStop: string[]; staysTheSame: string[];
};

export type AssetLink = { provider: string | null; ref: string; alreadyLinked: boolean };

export const assetProvider = {
    get: () => jfetch<AssetProviderInfo>("/api/assets/provider"),
    preflight: () => jfetch<AssetPreflight>("/api/assets/provider/preflight"),
    switchTo: (body: { provider: "builtin" | "external"; externalName?: string; externalUrl?: string; confirm: boolean }) => jfetch<AssetProviderInfo>("/api/assets/provider", { method: "PUT", body }),
    /** Downloads every built-in asset (JSON or CSV) through the person's own sign-in. */
    async download(format: "json" | "csv"): Promise<void> {
        const base = API_BASE ? API_BASE.replace(/\/+$/, "") : "";
        const res = await fetch(`${base}/api/assets/export?format=${format}`, { credentials: "include" });
        if (!res.ok) throw new Error(`The export failed (${res.status}).`);
        const blob = await res.blob();
        const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `remoteiq-assets.${format}`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    },
    addHost: (hostId: string) => jfetch<AssetLink>(`/api/network-discovery/hosts/${encodeURIComponent(hostId)}/asset`, { method: "POST", body: {} }),
    addSnmpDevice: (id: string) => jfetch<AssetLink>(`/api/snmp/devices/${encodeURIComponent(id)}/asset`, { method: "POST", body: {} }),
};
