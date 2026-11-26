// backend/src/assets/asset-provider.ts
//
// The seam between ADG RMM and whatever owns assets. Everything in ADG RMM that touches assets goes through AssetsService, which asks the
// provider that is switched on: the built-in asset manager (the `assets` table) or an external one (the owner's Killian software, an adapter
// that is written when Killian's API exists). See docs/design/asset-provider.md.

export type AssetProviderId = "builtin" | "external";

/** What a report needs to know about a device's asset: where it lives and its dates. */
export type DeviceAssetInfo = { ref: string; purchaseDate: Date | null; warrantyEnd: Date | null };

/** A host with no agent (a found host or an SNMP device) that should be recorded as an asset. */
export type HostAsset = {
    organizationId: string;
    siteId: string;
    name: string;
    ip: string;
    mac: string | null;
    vendor: string | null;
    /** A guess from the ports: printer, camera, windows, linux, network, nas, virtual, web, switch, other, unknown. */
    guess: string;
    ports: number[];
    description: string | null;
    source: "discovery" | "snmp";
};

export type AssetLink = { provider: AssetProviderId; ref: string; alreadyLinked: boolean };

export type AssetSettings = { provider: AssetProviderId; externalName: string | null; externalUrl: string | null; changedAt: string | null; changedBy: string | null };

export const EXTERNAL_DEFAULT_NAME = "another system";
