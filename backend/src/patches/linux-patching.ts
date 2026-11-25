// backend/src/patches/linux-patching.ts
//
// What the server needs to know to patch Linux devices the same way it patches Windows ones: which devices can do it,
// and how their answers read. Linux agents run the same two signed tasks (patch_scan, patch_install) as Windows agents,
// so scans, installs, policies, maintenance windows and reports share one path; only the rows have a few more fields
// (the package's current and new version, and whether the update is a security update).

/** The first Linux agent that picks up signed tasks and so can scan and install updates. */
export const LINUX_PATCH_MIN_VERSION = "1.3.34";

/** The version the server asks for, which an operator can raise (never lower) through the environment. */
export function linuxPatchMinVersion(raw: string | undefined = process.env.LINUX_PATCH_MIN_AGENT_VERSION): string {
    const v = String(raw ?? "").trim();
    return /^\d+(\.\d+){1,3}$/.test(v) && !agentVersionAtLeast(LINUX_PATCH_MIN_VERSION, v) ? v : LINUX_PATCH_MIN_VERSION;
}

export function agentVersionAtLeast(have: string | null | undefined, need: string): boolean {
    const parse = (v: string) => String(v ?? "").trim().split(/[.+-]/).slice(0, 4).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : NaN));
    const a = parse(have ?? "");
    const b = parse(need);
    if (a.some((n) => Number.isNaN(n)) || a.length === 0) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    return true;
}

export type PatchOs = "windows" | "linux" | null;

/** Windows, Linux or neither, from what the agent reported and what the device record says. */
export function patchOs(facts: unknown, operatingSystem: string | null | undefined): PatchOs {
    const reported = String((facts as any)?.os ?? "").toLowerCase();
    if (reported === "windows" || reported === "linux") return reported;
    const recorded = String(operatingSystem ?? "").toLowerCase();
    if (recorded.startsWith("windows")) return "windows";
    if (/^(linux|ubuntu|debian|fedora|centos|rocky|alma|red hat|rhel|opensuse|suse|sles|oracle linux|amazon linux|mint|kali)/.test(recorded)) return "linux";
    return null;
}

/** True for a device whose agent can run patch tasks: any Windows agent, and a Linux agent new enough to. */
export function canPatch(os: PatchOs, agentVersion: string | null | undefined): boolean {
    return os === "windows" || (os === "linux" && agentVersionAtLeast(agentVersion, linuxPatchMinVersion()));
}

/** Names the security flag the way the screens do: Windows has severities, Linux has a security flag. */
export function isSecurityPatch(p: { security?: boolean; severity?: string | null }): boolean {
    if (p.security === true) return true;
    const s = String(p.severity ?? "").toLowerCase();
    return s === "critical" || s === "important";
}
