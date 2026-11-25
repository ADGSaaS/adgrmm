// backend/src/vault/vault.parsers.ts
//
// What a device printed is never trusted, and what is checked here never ends up in an error message: every failure is a fixed code
// (VaultParseError.code), so a hostile or garbled output cannot carry a secret, or anything else, into a log or an API answer.
export const LAPS_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const LAPS_LOWER = "abcdefghijkmnpqrstuvwxyz";
export const LAPS_DIGITS = "23456789";
export const LAPS_SYMBOLS = "!#%&*+=?@^_";
export const LAPS_ALPHABET = LAPS_UPPER + LAPS_LOWER + LAPS_DIGITS + LAPS_SYMBOLS;
export const LAPS_MIN_LENGTH = 14;
export const LAPS_MAX_LENGTH = 64;
export const MAX_BITLOCKER_KEYS = 64;

export type ParseCode = "empty" | "not_json" | "bad_shape" | "device_error" | "bad_key" | "bad_password" | "dry_run" | "mismatch";
export class VaultParseError extends Error {
    constructor(readonly code: ParseCode, readonly reason?: string) {
        super(`The device's answer was not usable (${code}).`);
    }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECOVERY_PASSWORD = /^\d{6}(-\d{6}){7}$/;
const MOUNT = /^[A-Z]:$/;
const LUKS_LABEL = /^(\/[A-Za-z0-9_./-]{0,40}|luks-[0-9a-f]{8})$/;
const LUKS_KEY = /^[cbdefghijklnrtuv]{8}(-[cbdefghijklnrtuv]{8}){7}$/;
export const LUKS_VOLUME_STATES = ["have", "enrolled", "not_luks2", "no_cryptenroll", "no_unlock", "unreadable", "later"] as const;
export type LuksVolumeState = (typeof LUKS_VOLUME_STATES)[number];
/** Reason codes a script may report. Anything else is shown as "other". */
export const DEVICE_REASONS: Record<string, string> = {
    no_bitlocker: "BitLocker is not available on this device (the BitLocker feature is not installed).",
    access_denied: "The device would not let the agent read BitLocker keys (it needs to run as SYSTEM).",
    read_failed: "The device could not be read (BitLocker keys on Windows, account details on Linux).",
    not_root: "The agent on this device does not run as root, so it cannot do this.",
    no_tools: "A tool this needs (chpasswd, useradd or lsblk) is missing on the device.",
    system_account: "That account is a system account (its user id is below the first ordinary user), so it was not touched.",
    no_luks: "No encrypted (LUKS) disk was found on this device.",
    invalid_account: "The account name was not accepted by the device.",
    reserved_account: "The account name is a reserved Windows account.",
    invalid_length: "The password length was not accepted by the device.",
    domain_controller: "This is a domain controller. Local accounts do not exist there, so nothing was changed.",
    generate_failed: "The device could not generate a password. Nothing was changed.",
    create_failed: "The device could not create the account. Nothing was changed.",
    group_failed: "The account was created but could not be added to the local Administrators group.",
    set_failed: "The device could not set the new password. The old password is still valid.",
    other: "The device reported an error.",
};
const reasonCode = (v: unknown): string => (typeof v === "string" && Object.prototype.hasOwnProperty.call(DEVICE_REASONS, v) ? v : "other");

function json(stdout: string): any {
    const text = String(stdout ?? "").trim();
    if (!text) throw new VaultParseError("empty");
    if (text.length > 100_000) throw new VaultParseError("bad_shape");
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new VaultParseError("not_json"); }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new VaultParseError("bad_shape");
    return v;
}

/** A protector id as {guid} or guid, in any case, returned lower case without braces. */
export function cleanProtectorId(v: unknown): string | null {
    const s = typeof v === "string" ? v.trim().replace(/^\{|\}$/g, "").toLowerCase() : "";
    return GUID.test(s) ? s : null;
}
export const isRecoveryPassword = (v: unknown): v is string => typeof v === "string" && RECOVERY_PASSWORD.test(v);

export type BitlockerKey = { mount: string; protectorId: string; recoveryPassword: string };

/** Strict: one bad entry rejects the whole answer (nothing is stored from a garbled read). */
export function parseBitlockerKeys(stdout: string): BitlockerKey[] {
    const p = json(stdout);
    if (p.ok === false) throw new VaultParseError("device_error", reasonCode(p.reason));
    if (p.ok !== true || !Array.isArray(p.keys) || p.keys.length > MAX_BITLOCKER_KEYS) throw new VaultParseError("bad_shape");
    const seen = new Set<string>();
    const out: BitlockerKey[] = [];
    for (const k of p.keys) {
        if (!k || typeof k !== "object") throw new VaultParseError("bad_key");
        const mount = typeof k.mount === "string" ? k.mount.trim().toUpperCase() : "";
        const id = cleanProtectorId(k.protectorId);
        if (!MOUNT.test(mount) || !id || !isRecoveryPassword(k.recoveryPassword) || seen.has(id)) throw new VaultParseError("bad_key");
        seen.add(id);
        out.push({ mount, protectorId: id, recoveryPassword: k.recoveryPassword });
    }
    return out;
}

/** Whether a password is what the generator makes: the asked length, only the alphabet, at least one of each class. */
export function isValidLapsPassword(pw: unknown, length: number): pw is string {
    if (typeof pw !== "string" || pw.length !== length || length < LAPS_MIN_LENGTH || length > LAPS_MAX_LENGTH) return false;
    for (const ch of pw) if (!LAPS_ALPHABET.includes(ch)) return false;
    return [LAPS_UPPER, LAPS_LOWER, LAPS_DIGITS, LAPS_SYMBOLS].every((set) => [...pw].some((ch) => set.includes(ch)));
}

export type LapsResult = { account: string; created: boolean; verified: boolean; password: string };

/** The answer of the rotation script. `expected` is what was asked for; an answer for another account or length is refused. */
export function parseLapsResult(stdout: string, expected: { account: string; length: number }): LapsResult {
    const p = json(stdout);
    if (p.ok === false) throw new VaultParseError("device_error", reasonCode(p.reason));
    if (p.ok !== true) throw new VaultParseError("bad_shape");
    if (p.dryRun === true) throw new VaultParseError("dry_run");
    if (typeof p.account !== "string" || p.account !== expected.account) throw new VaultParseError("mismatch");
    if (typeof p.created !== "boolean" || typeof p.verified !== "boolean") throw new VaultParseError("bad_shape");
    if (!isValidLapsPassword(p.password, expected.length)) throw new VaultParseError("bad_password");
    return { account: p.account, created: p.created, verified: p.verified, password: p.password };
}

export type LuksKey = { mount: string; protectorId: string; recoveryPassword: string };
export type LuksResult = { keys: LuksKey[]; volumes: { id: string; state: LuksVolumeState }[] };

/** The answer of the LUKS script: the recovery keys it just added (strict, like the BitLocker read) and what became of each volume. */
export function parseLuksResult(stdout: string): LuksResult {
    const p = json(stdout);
    if (p.ok === false) throw new VaultParseError("device_error", reasonCode(p.reason));
    if (p.ok !== true || !Array.isArray(p.keys) || !Array.isArray(p.volumes) || p.keys.length > 8 || p.volumes.length > 32) throw new VaultParseError("bad_shape");
    const seen = new Set<string>();
    const keys: LuksKey[] = [];
    for (const k of p.keys) {
        if (!k || typeof k !== "object") throw new VaultParseError("bad_key");
        const id = cleanProtectorId(k.protectorId);
        if (!id || typeof k.mount !== "string" || !LUKS_LABEL.test(k.mount) || typeof k.recoveryPassword !== "string" || !LUKS_KEY.test(k.recoveryPassword) || seen.has(id)) throw new VaultParseError("bad_key");
        seen.add(id);
        keys.push({ mount: k.mount, protectorId: id, recoveryPassword: k.recoveryPassword });
    }
    const volumes: LuksResult["volumes"] = [];
    for (const v of p.volumes) {
        const id = cleanProtectorId(v?.id);
        if (!id || !LUKS_VOLUME_STATES.includes(v?.state)) throw new VaultParseError("bad_shape");
        volumes.push({ id, state: v.state });
    }
    return { keys, volumes };
}
