// backend/src/edr/edr.core.ts
//
// EDR and antivirus consoles: what a connection is made of, how what each console says about an endpoint becomes one shape (and one verdict),
// how endpoints are matched to devices, and what coverage means. Pure (no database, no network) so it can be tested alone.
// Everything is read-only toward the console. The vendors' fields are read the way their documentation gives them; a field that is missing
// makes the verdict "unknown" and is never guessed.
import { BadRequestException } from "@nestjs/common";

export type Vendor = "mde" | "sentinelone" | "huntress" | "crowdstrike";
export const VENDORS: Array<{ key: Vendor; label: string; fields: Array<{ name: string; label: string; secret?: boolean; help: string; options?: string[] }> }> = [
    {
        key: "mde", label: "Microsoft Defender for Endpoint",
        fields: [
            { name: "tenant", label: "Tenant ID or domain", help: "The customer's Microsoft Entra tenant." },
            { name: "appId", label: "Application (client) ID", help: "An app registration with the Microsoft Threat Protection permission Machine.Read.All (application), admin consent given." },
            { name: "secret", label: "Client secret (value)", secret: true, help: "Shown once when the secret is made." },
        ],
    },
    {
        key: "sentinelone", label: "SentinelOne",
        fields: [
            { name: "subdomain", label: "Console name", help: "The first part of the console address: for https://usea1-acme.sentinelone.net it is usea1-acme." },
            { name: "secret", label: "API token", secret: true, help: "A service user's API token with the Viewer role is enough: nothing is changed." },
        ],
    },
    {
        key: "huntress", label: "Huntress",
        fields: [
            { name: "apiKey", label: "API key", help: "From Huntress: Account Settings > API Credentials." },
            { name: "secret", label: "API secret", secret: true, help: "Shown once when the key is made." },
        ],
    },
    {
        key: "crowdstrike", label: "CrowdStrike Falcon",
        fields: [
            { name: "cloud", label: "Cloud", help: "The Falcon cloud the account lives in.", options: ["us-1", "us-2", "eu-1", "us-gov-1"] },
            { name: "apiClientId", label: "API client ID", help: "An API client with the Hosts scope set to Read." },
            { name: "secret", label: "API client secret", secret: true, help: "Shown once when the client is made." },
        ],
    },
];

export const MAX_CONNECTIONS = 50;
export const MAX_ENDPOINTS = 20_000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export type CleanConnection = { vendor: Vendor; name: string; config: Record<string, string>; secret: string | null };

const text = (v: unknown, label: string, max = 200): string => {
    const s = String(v ?? "").trim();
    if (!s) throw new BadRequestException(`Enter ${label}.`);
    if (s.length > max || /[\s\u0000-\u001F]/.test(s)) throw new BadRequestException(`${label[0].toUpperCase()}${label.slice(1)} does not look right.`);
    return s;
};

/** Checks what a person typed for a vendor. A secret left empty on an edit keeps the old one (secret is then null). */
export function cleanConnection(input: Record<string, unknown>, opts: { editing: boolean; vendor?: Vendor }): CleanConnection {
    const vendor = (opts.vendor ?? String(input.vendor ?? "")) as Vendor;
    if (!VENDORS.some((v) => v.key === vendor)) throw new BadRequestException("Choose which product this is.");
    const name = String(input.name ?? "").replace(/\s+/g, " ").trim() || VENDORS.find((v) => v.key === vendor)!.label;
    if (name.length > 120) throw new BadRequestException("The name is too long (120 characters at most).");
    const config: Record<string, string> = {};
    if (vendor === "mde") {
        const tenant = String(input.tenant ?? "").trim().toLowerCase();
        if (!GUID.test(tenant) && !DOMAIN.test(tenant)) throw new BadRequestException("The tenant is an ID (a GUID) or a domain such as contoso.onmicrosoft.com.");
        const appId = String(input.appId ?? "").trim().toLowerCase();
        if (!GUID.test(appId)) throw new BadRequestException("The application (client) ID is a GUID.");
        config.tenant = tenant; config.appId = appId;
    } else if (vendor === "sentinelone") {
        const sub = String(input.subdomain ?? "").trim().toLowerCase().replace(/\.sentinelone\.net$/, "");
        if (!/^[a-z0-9]([a-z0-9-]{0,60}[a-z0-9])?$/.test(sub)) throw new BadRequestException("The console name is the first part of its address, such as usea1-acme.");
        config.subdomain = sub;
    } else if (vendor === "huntress") {
        config.apiKey = text(input.apiKey, "the API key", 120);
    } else {
        const cloud = String(input.cloud ?? "");
        if (!["us-1", "us-2", "eu-1", "us-gov-1"].includes(cloud)) throw new BadRequestException("Choose the Falcon cloud: us-1, us-2, eu-1 or us-gov-1.");
        config.cloud = cloud;
        config.apiClientId = text(input.apiClientId, "the API client ID", 120);
    }
    const raw = input.secret;
    const secret = raw === undefined || raw === null || String(raw) === "" ? null : text(raw, "the secret", 400);
    if (!secret && !opts.editing) throw new BadRequestException(`Enter ${vendor === "sentinelone" ? "the API token" : "the secret"}.`);
    return { vendor, name, config, secret };
}

/* ------------------------------ one shape ------------------------------ */

export type Health = "healthy" | "warning" | "unhealthy" | "unknown";
export type Endpoint = { vendorId: string; hostname: string; serial: string | null; os: string | null; agentVersion: string | null; lastSeenAt: Date | null; health: Health; detail: string; threats: number | null };

const DAY = 86_400_000;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown): Date | null => { const s = str(v); if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
const ageDays = (d: Date | null, now: Date) => (d ? (now.getTime() - d.getTime()) / DAY : null);
const worst = (a: Health, b: Health): Health => (["healthy", "unknown", "warning", "unhealthy"].indexOf(b) > ["healthy", "unknown", "warning", "unhealthy"].indexOf(a) ? b : a);

/** Microsoft Defender for Endpoint: GET /api/machines. */
export function fromMde(m: Record<string, unknown>, now = new Date()): Endpoint | null {
    const hostname = str(m.computerDnsName); const id = str(m.id);
    if (!hostname || !id) return null;
    const last = date(m.lastSeen);
    let health: Health = "unknown"; const why: string[] = [];
    const onboarding = str(m.onboardingStatus), hs = str(m.healthStatus), risk = str(m.riskScore);
    if (onboarding && onboarding !== "Onboarded") { health = "unhealthy"; why.push(onboarding === "CanBeOnboarded" ? "The computer can be onboarded but is not" : `Onboarding status is ${onboarding}`); }
    else if (hs === "Active") health = "healthy";
    else if (hs === "Inactive") { health = "unhealthy"; why.push("The sensor has not reported for a while"); }
    else if (hs) { health = "warning"; why.push(`Sensor health is ${hs}`); }
    if (risk === "High") { health = worst(health === "unknown" ? "healthy" : health, "warning"); why.push("Risk score is High"); }
    return { vendorId: id, hostname, serial: null, os: str(m.osPlatform), agentVersion: str(m.agentVersion) ?? str(m.version), lastSeenAt: last, health, detail: why.join("; ") || (health === "healthy" ? "Reporting normally." : "Not enough was reported to say."), threats: null };
}

/** SentinelOne: GET /web/api/v2.1/agents. */
export function fromSentinelOne(a: Record<string, unknown>, now = new Date()): Endpoint | null {
    const hostname = str(a.computerName); const id = str(a.id);
    if (!hostname || !id) return null;
    const last = date(a.lastActiveDate);
    const threats = typeof a.activeThreats === "number" ? a.activeThreats : null;
    let health: Health = "healthy"; const why: string[] = [];
    if (a.infected === true || (threats ?? 0) > 0) { health = "unhealthy"; why.push(`${threats ?? "Active"} active ${threats === 1 ? "threat" : "threats"}`); }
    if (a.isActive === false) { health = worst(health, "warning"); why.push("The agent is not active"); }
    if (a.isUpToDate === false) { health = worst(health, "warning"); why.push("The agent is out of date"); }
    const age = ageDays(last, now);
    if (a.networkStatus === "disconnected" && age !== null && age > 3) { health = worst(health, "warning"); why.push(`Not connected for ${Math.floor(age)} days`); }
    if (a.networkStatus === undefined && a.isActive === undefined && a.infected === undefined) health = "unknown";
    return { vendorId: id, hostname, serial: str(a.serialNumber), os: str(a.osName) ?? str(a.osType), agentVersion: str(a.agentVersion), lastSeenAt: last, health, detail: why.join("; ") || "Protected and reporting.", threats };
}

/** Huntress: GET /v1/agents. */
export function fromHuntress(a: Record<string, unknown>, now = new Date()): Endpoint | null {
    const hostname = str(a.hostname); const id = a.id === undefined || a.id === null ? null : String(a.id);
    if (!hostname || !id) return null;
    const last = date(a.last_callback_at);
    let health: Health = "healthy"; const why: string[] = [];
    const defender = str(a.defender_status);
    if (defender && !/^(healthy|protected|ok)$/i.test(defender)) { health = /unhealthy|disabled|off/i.test(defender) ? "unhealthy" : "warning"; why.push(`Microsoft Defender is ${defender.toLowerCase()}`); }
    const fw = str(a.firewall_status);
    if (fw && /disabled|off/i.test(fw)) { health = worst(health, "warning"); why.push("The firewall is off"); }
    const age = ageDays(last, now);
    if (age !== null && age > 3) { health = worst(health, age > 14 ? "unhealthy" : "warning"); why.push(`The agent has not called in for ${Math.floor(age)} days`); }
    if (!last) health = health === "healthy" ? "unknown" : health;
    return { vendorId: id, hostname, serial: str(a.serial_number), os: str(a.os) ?? str(a.platform), agentVersion: str(a.version), lastSeenAt: last, health, detail: why.join("; ") || (health === "unknown" ? "No check-in time was given." : "Reporting normally."), threats: null };
}

/** CrowdStrike Falcon: POST /devices/entities/devices/v2. */
export function fromCrowdStrike(d: Record<string, unknown>, now = new Date()): Endpoint | null {
    const hostname = str(d.hostname); const id = str(d.device_id);
    if (!hostname || !id) return null;
    const last = date(d.last_seen);
    let health: Health = "healthy"; const why: string[] = [];
    const status = str(d.status);
    if (status && status !== "normal") { health = "warning"; why.push(`Network containment is ${status.replace(/_/g, " ")}`); }
    const age = ageDays(last, now);
    if (age !== null && age > 3) { health = worst(health, age > 14 ? "unhealthy" : "warning"); why.push(`Not seen for ${Math.floor(age)} days`); }
    if (!last) health = health === "healthy" ? "unknown" : health;
    return { vendorId: id, hostname, serial: str(d.serial_number), os: str(d.platform_name) ?? str(d.os_version), agentVersion: str(d.agent_version), lastSeenAt: last, health, detail: why.join("; ") || (health === "unknown" ? "No last-seen time was given." : "Sensor reporting normally."), threats: null };
}

/* ------------------------------ matching and coverage ------------------------------ */

/** A computer name in one form: lower case, without its domain, without the $ of a machine account. */
export const hostKey = (name: string | null | undefined): string => String(name ?? "").trim().toLowerCase().replace(/\$$/, "").split(".")[0];

export type DeviceRef = { id: string; hostname: string; alias?: string | null; serial?: string | null; clientId: string | null };

/**
 * Which device each endpoint is. A serial number that is the same is a match. Otherwise the host name is, but only when exactly one device
 * has that name (in the customer the connection is for, when it is for one): "DESKTOP-ABC12" on two customers' networks is nobody in particular.
 */
export function matchEndpoints(endpoints: Array<{ vendorId: string; hostname: string; serial: string | null }>, devices: DeviceRef[], boundClient: string | null): Map<string, string> {
    const pool = boundClient ? devices.filter((d) => d.clientId === boundClient) : devices;
    const bySerial = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    for (const d of pool) {
        const s = d.serial?.trim().toLowerCase();
        if (s && s.length >= 4 && !/^(0+|none|n\/a|default string|to be filled by o\.e\.m\.|system serial number)$/.test(s)) bySerial.set(s, [...(bySerial.get(s) ?? []), d.id]);
        for (const n of new Set([hostKey(d.hostname), hostKey(d.alias)].filter(Boolean))) byName.set(n, [...(byName.get(n) ?? []), d.id]);
    }
    const out = new Map<string, string>();
    for (const e of endpoints) {
        const s = e.serial?.trim().toLowerCase();
        const bySer = s ? bySerial.get(s) : undefined;
        if (bySer?.length === 1) { out.set(e.vendorId, bySer[0]); continue; }
        const byNm = byName.get(hostKey(e.hostname));
        if (byNm?.length === 1) out.set(e.vendorId, byNm[0]);
    }
    return out;
}

export type DeviceCover = { deviceId: string; products: Array<{ vendor: Vendor; connection: string; health: Health; detail: string; lastSeenAt: Date | null }> };

/** The verdict for a device from what the consoles said: the worst of them, or "none" when no console knows it. */
export function coverageOf(products: DeviceCover["products"]): "healthy" | "warning" | "unhealthy" | "unknown" | "none" {
    if (products.length === 0) return "none";
    return products.map((p) => p.health).reduce<Health>((a, b) => (a === "unknown" && b !== "unknown" ? b : b === "unknown" ? a : worst(a, b)), "unknown");
}
