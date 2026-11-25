// lib/device-os.ts

export type DeviceFamily = "windows" | "linux" | null;

/** Agents report "windows" or "linux", and devices added by hand can hold fuller names. Null means not known. */
export function deviceFamily(os?: string | null): DeviceFamily {
    const s = String(os ?? "").trim().toLowerCase();
    if (!s || s === "unknown") return null;
    return s.includes("windows") ? "windows" : "linux";
}
