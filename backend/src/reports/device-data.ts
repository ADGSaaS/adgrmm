// backend/src/reports/device-data.ts
//
// Reads what the agent reports about a device (the facts blob) into something the reports can use. Everything is
// optional: an older agent, a server without Security Center, or a failed probe just leaves a field empty, and the
// reports say "not reported" for it rather than guessing.

export type Av = { name: string; state: "on" | "off" | "snoozed" | "unknown"; upToDate: boolean | null };

export type DeviceHealthData = {
    osName: string | null;
    osVersion: string | null;
    osBuild: string | null;
    lastBootAt: Date | null;
    pendingReboot: boolean | null;
    pendingRebootReasons: string[];
    biosVendor: string | null;
    biosVersion: string | null;
    biosDate: string | null;
    antivirus: Av[] | null;
    defender: { realTimeProtection: boolean | null; signatureAgeDays: number | null; enabled: boolean | null } | null;
    firewall: { domain: boolean | null; private: boolean | null; public: boolean | null } | null;
    bitlocker: Array<{ mount: string; protection: "on" | "off" | "unknown"; status: string | null }> | null;
    tpm: { present: boolean | null; version: string | null; enabled: boolean | null } | null;
    secureBoot: boolean | null;
    nics: Array<{ description: string | null; mac: string | null; ipv4: string[]; gateway: string | null }>;
};

const rec = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const date = (v: unknown): Date | null => {
    if (typeof v !== "string") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

/** Reads the device section of the facts, which the agent keeps under `device`. */
export function parseDeviceHealth(facts: unknown): DeviceHealthData {
    const device = rec(rec(facts).device);
    const os = rec(device.os);
    const boot = rec(device.boot);
    const bios = rec(device.bios);
    const security = rec(device.security);

    const avRaw = Array.isArray(security.antivirus) ? security.antivirus : null;
    const antivirus = avRaw
        ? avRaw
            .map((a: unknown): Av | null => {
                const r = rec(a);
                const name = str(r.name);
                if (!name) return null;
                const state = r.state === "on" || r.state === "off" || r.state === "snoozed" ? r.state : "unknown";
                return { name, state, upToDate: bool(r.upToDate) };
            })
            .filter((a: Av | null): a is Av => !!a)
        : null;

    const def = rec(security.defender);
    const defender = Object.keys(def).length
        ? { realTimeProtection: bool(def.realTimeProtection), signatureAgeDays: int(def.signatureAgeDays), enabled: bool(def.antivirusEnabled) }
        : null;

    const fw = rec(security.firewall);
    const firewall = Object.keys(fw).length ? { domain: bool(fw.domain), private: bool(fw.private), public: bool(fw.public) } : null;

    const blRaw = Array.isArray(security.bitLocker) ? security.bitLocker : null;
    const bitlocker = blRaw
        ? blRaw
            .map((v: unknown) => {
                const r = rec(v);
                const mount = str(r.mount);
                if (!mount) return null;
                const protection: "on" | "off" | "unknown" = r.protection === "on" || r.protection === "off" ? r.protection : "unknown";
                return { mount: mount.toUpperCase(), protection, status: str(r.status) };
            })
            .filter((v: unknown): v is NonNullable<DeviceHealthData["bitlocker"]>[number] => !!v)
        : null;

    const tpmRaw = rec(security.tpm);
    const tpm = Object.keys(tpmRaw).length ? { present: bool(tpmRaw.present), version: str(tpmRaw.version), enabled: bool(tpmRaw.enabled) } : null;

    const nics = (Array.isArray(device.network) ? device.network : []).map((n: unknown) => {
        const r = rec(n);
        return { description: str(r.description), mac: str(r.mac), ipv4: Array.isArray(r.ipv4) ? r.ipv4.filter((x: unknown): x is string => typeof x === "string") : [], gateway: str(r.gateway) };
    });

    return {
        osName: str(os.name),
        osVersion: str(os.displayVersion) ?? str(os.version),
        osBuild: str(os.buildRevision) ?? str(os.build),
        lastBootAt: date(boot.lastBootAt),
        pendingReboot: bool(boot.pendingReboot),
        pendingRebootReasons: Array.isArray(boot.pendingRebootReasons) ? boot.pendingRebootReasons.filter((x: unknown): x is string => typeof x === "string") : [],
        biosVendor: str(bios.vendor),
        biosVersion: str(bios.version),
        biosDate: /^\d{4}-\d{2}-\d{2}$/.test(String(bios.releaseDate ?? "")) ? String(bios.releaseDate) : null,
        antivirus,
        defender,
        firewall,
        bitlocker,
        tpm,
        secureBoot: bool(security.secureBoot),
        nics,
    };
}

/* ------------------------------ judgements ------------------------------ */

/** How many whole years old the firmware date says a machine is. Null when the date is missing or absurd. */
export function ageYears(biosDate: string | null, now = Date.now()): number | null {
    if (!biosDate) return null;
    const t = new Date(biosDate).getTime();
    if (Number.isNaN(t) || t > now) return null;
    const years = (now - t) / (365.25 * 86_400_000);
    // Some firmware reports 1970 or 2000 as a placeholder.
    return biosDate < "2001-01-01" ? null : Math.round(years * 10) / 10;
}

export function uptimeDays(lastBootAt: Date | null, now = Date.now()): number | null {
    if (!lastBootAt) return null;
    const days = (now - lastBootAt.getTime()) / 86_400_000;
    return days < 0 ? null : Math.floor(days);
}

export type AvVerdict = { state: "ok" | "off" | "old" | "unknown"; text: string };

/**
 * Whether the machine is protected. Security Center is authoritative where it exists; servers have no Security Center,
 * so Defender's own answer is used. Nothing known means "unknown", not a failure.
 */
export function avVerdict(h: DeviceHealthData, maxDefinitionAgeDays: number): AvVerdict {
    const products = h.antivirus ?? [];
    if (products.length) {
        const on = products.filter((p) => p.state === "on");
        if (!on.length) return { state: "off", text: products.some((p) => p.state === "snoozed") ? "Antivirus snoozed" : "No antivirus is switched on" };
        const stale = on.find((p) => p.upToDate === false);
        const defenderAge = h.defender?.signatureAgeDays ?? null;
        if (stale) return { state: "old", text: `${stale.name} definitions are out of date` };
        if (on.length === 1 && /defender/i.test(on[0].name) && defenderAge !== null && defenderAge > maxDefinitionAgeDays) return { state: "old", text: `Defender definitions are ${defenderAge} days old` };
        if (h.defender?.realTimeProtection === false && on.some((p) => /defender/i.test(p.name)) && on.length === 1) return { state: "off", text: "Real-time protection is off" };
        return { state: "ok", text: on.map((p) => p.name).join(", ") };
    }
    if (h.defender) {
        if (h.defender.enabled === false || h.defender.realTimeProtection === false) return { state: "off", text: "Defender real-time protection is off" };
        if (h.defender.signatureAgeDays !== null && h.defender.signatureAgeDays > maxDefinitionAgeDays) return { state: "old", text: `Defender definitions are ${h.defender.signatureAgeDays} days old` };
        return { state: "ok", text: "Windows Defender" };
    }
    return { state: "unknown", text: "" };
}

/** The firewall profiles that matter on a laptop or a server: private and public. A domain profile that is off is common and is not flagged. */
export function firewallOff(h: DeviceHealthData): string[] {
    if (!h.firewall) return [];
    const off: string[] = [];
    if (h.firewall.private === false) off.push("Private");
    if (h.firewall.public === false) off.push("Public");
    return off;
}

export type EncryptionVerdict = { state: "protected" | "unprotected" | "unknown"; text: string };

/** The system drive is the one that matters; the C: drive is assumed when the agent did not say which one holds Windows. */
export function encryptionVerdict(h: DeviceHealthData): EncryptionVerdict {
    if (!h.bitlocker) return { state: "unknown", text: "" };
    const system = h.bitlocker.find((v) => v.mount.startsWith("C")) ?? h.bitlocker[0];
    if (!system) return { state: "unknown", text: "" };
    return system.protection === "on" ? { state: "protected", text: `${system.mount} protected` } : system.protection === "off" ? { state: "unprotected", text: `${system.mount} is not encrypted` } : { state: "unknown", text: "" };
}

/* ------------------------------ risky configuration ------------------------------ */

/** What the agent reports about how a device is set up, from `device.risk`. Every field is optional. */
export type RiskData = {
    rdpEnabled: boolean | null;
    rdpNla: boolean | null;
    smb1Enabled: boolean | null;
    autoLogon: boolean | null;
    uacEnabled: boolean | null;
    guestEnabled: boolean | null;
    localAdmins: string[] | null;
    minPasswordLength: number | null;
    lockoutThreshold: number | null;
    screenLockMinutes: number | null;
};

/** Null when the agent has not sent any (an older agent), which is different from sending "all fine". */
export function parseRisk(facts: unknown): RiskData | null {
    const risk = rec(rec(rec(facts).device).risk);
    if (!Object.keys(risk).length) return null;
    const rdp = rec(risk.rdp);
    const policy = rec(risk.passwordPolicy);
    return {
        rdpEnabled: bool(rdp.enabled),
        rdpNla: bool(rdp.nla),
        smb1Enabled: bool(risk.smb1Enabled),
        autoLogon: bool(risk.autoLogon),
        uacEnabled: bool(risk.uacEnabled),
        guestEnabled: bool(risk.guestEnabled),
        localAdmins: Array.isArray(risk.localAdmins) ? risk.localAdmins.filter((x: unknown): x is string => typeof x === "string" && !!x.trim()) : null,
        minPasswordLength: int(policy.minLength),
        lockoutThreshold: int(policy.lockoutThreshold),
        screenLockMinutes: int(risk.screenLockMinutes),
    };
}

/* ------------------------------ antivirus threats ------------------------------ */

export type ThreatItem = { name: string; severity: "low" | "moderate" | "high" | "severe" | null; detectedAt: Date; status: string; action: string | null; resource: string | null; user: string | null };
export type ThreatData = { readAt: Date | null; activeCount: number | null; items: ThreatItem[] };

/** What Defender found recently, from `device.threats`. Null when the agent has not sent it, which is not the same as clean. */
export function parseThreats(facts: unknown): ThreatData | null {
    const t = rec(rec(rec(facts).device).threats);
    if (!Object.keys(t).length || !Array.isArray(t.items)) return null;
    const items = (t.items as unknown[])
        .map((raw): ThreatItem | null => {
            const x = rec(raw);
            const detectedAt = date(x.detectedAt);
            const name = str(x.name);
            if (!detectedAt || !name) return null;
            const severity = x.severity === "low" || x.severity === "moderate" || x.severity === "high" || x.severity === "severe" ? x.severity : null;
            return { name, severity, detectedAt, status: str(x.status) ?? "unknown", action: str(x.action), resource: str(x.resource), user: str(x.user) };
        })
        .filter((x): x is ThreatItem => !!x);
    return { readAt: date(t.readAt), activeCount: int(t.activeCount), items };
}
