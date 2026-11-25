// lib/security-api.ts
//
// Security basics (stage 1): a device's last security scan, the Defender actions, and the fleet view. Everything the device says is
// checked on the server before it gets here; nothing here handles a secret (no keys, no passwords are ever collected).
import { jfetch } from "@/lib/api";

export type Severity = "critical" | "high" | "medium" | "low";
export type RuleResult = "pass" | "fail" | "unknown" | "not_applicable";
export type Grade = "A" | "B" | "C" | "D" | "F";
export type Tone = "good" | "warn" | "bad" | "unknown";
export type Label = { text: string; tone: Tone };

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];
export const SEVERITY_TEXT: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const RESULT_TEXT: Record<RuleResult, string> = { pass: "Pass", fail: "Fail", unknown: "Could not read", not_applicable: "Not applicable" };

export type RuleView = {
    id: string; title: string; group: string; severity: Severity; weight: number; result: RuleResult; detail: string;
    checks: string; why: string; fix: string;
};

export type Highlights = {
    defender: {
        label: Label; read: boolean; serviceState: string | null; runningMode: string | null; realTimeProtection: boolean | null; tamperProtected: boolean | null;
        signatureVersion: string | null; signatureAgeDays: number | null; lastQuickScanDays: number | null; lastFullScanDays: number | null;
        threatCount: number | null; threats: string[]; reason: string | null; otherProducts: Array<{ name: string; state: string; upToDate: boolean | null }>;
        /** What Defender is told not to scan: how many exclusions, and the broad kinds. Null on a scan made before this was checked. */
        exclusions?: { total: number; broad: string[] } | null;
    };
    bitlocker: {
        label: Label; detail: boolean; systemDrive: string | null; note: string | null;
        volumes: Array<{ drive: string; protection: "on" | "off" | "unknown"; percent: number | null; method: string | null; state: string | null; protectors: string[] }>;
    };
    firewall: { label: Label; profiles: { domain: boolean | null; private: boolean | null; public: boolean | null } | null };
    os: { name: string; displayVersion: string; build: number; ubr: number; edition: string; support: { status: "supported" | "ending" | "ended" | "unknown"; name: string; endsOn: string | null; daysLeft: number | null } } | null;
    tpm: { present: boolean; ready: boolean } | null;
    secureBoot: { supported: boolean; enabled: boolean } | null;
    accounts: { adminCount: number; adminNames: string[]; builtinAdminEnabled: boolean | null; guestEnabled: boolean | null } | null;
    restartPending: boolean | null;
    lastUpdate: { at: string | null; ageDays: number | null } | null;
    unreadable: Array<{ probe: string; reason: string }>;
};

/** What the Security tab shows for a Linux device besides the checks. */
export type LinuxHighlights = {
    platform: "linux";
    antivirus: { label: Label; products: string[]; reason: string | null };
    encryption: { label: Label; volumes: Array<{ mount: string; state: "on" | "off" | "unknown" }>; note: string | null };
    firewall: { label: Label; manager: string | null };
    ssh: { installed: boolean; running: boolean | null; permitRootLogin: string | null; passwordAuth: boolean | null; port: number | null } | null;
    accounts: { admins: string[]; adminCount: number; emptyPassword: string[] | null; extraRoot: string[] } | null;
    os: { name: string; id: string; version: string; kernel: string; support: { status: "supported" | "ending" | "ended" | "unknown"; name: string; endsOn: string | null; daysLeft: number | null } } | null;
    mac: { kind: "selinux" | "apparmor" | "none"; mode: string } | null;
    secureBoot: boolean | null;
    tpm: boolean | null;
    restartPending: boolean | null;
    lastUpdate: { ageDays: number } | null;
    autoUpdates: { enabled: boolean; by: string } | null;
    diskUsedPercent: number | null;
    unreadable: Array<{ probe: string; reason: string }>;
};

export type ScanView = {
    score: number | null; uncappedScore: number | null; grade: Grade | null; capped: boolean; capReason: string | null;
    counts: { pass: number; fail: number; unknown: number; notApplicable: number };
    failedBySeverity: Record<Severity, number>;
    unreadable: number; unreadableText: string | null;
    rules: RuleView[]; highlights: Highlights | LinuxHighlights; scanMs: number;
};

export type DeviceSecurity = {
    device: { id: string; name: string; customer: string | null; site: string | null };
    online: boolean; windows: boolean; linux?: boolean; hasAgent: boolean;
    state: "scanned" | "not_scanned" | "offline" | "no_agent" | "unsupported";
    reason: string | null;
    scannedAt: string | null; attemptedAt: string | null; lastAttemptFailed: boolean; message: string | null; pending: boolean; stale: boolean;
    scan: ScanView | null;
    /** Linux only: what RemoteIQ last learned about ClamAV (installed or not, and the last malware scan). */
    clamav?: ClamavState | null;
};

export type ClamavState = {
    installed: boolean | null; signaturesAt: string | null;
    lastScan: { at: string; state: "clean" | "infected" | "error" | null; scannedFiles: number | null; seconds: number | null; infectedCount: number; found: Array<{ signature: string; path: string }>; message: string | null } | null;
};

export type DefenderAction = "update" | "quick-scan" | "full-scan";
export type DefenderOutcome =
    | { before: string; after: string; updatedAt: string | null; changed: boolean }
    | { scanType: "QuickScan" | "FullScan"; started: true };

export type FleetRow = {
    deviceId: string; name: string; hostname: string; customer: string; clientId: string; site: string | null;
    hasAgent: boolean; online: boolean; scannedAt: string | null; attemptedAt: string | null; stale: boolean; lastAttemptFailed: boolean; message: string | null; pending: boolean;
    score: number | null; grade: Grade | null; criticalFailed: number; highFailed: number; unknown: number;
    defender: Label | null; bitlocker: Label | null; firewall: Label | null;
};
export type FleetPage = { total: number; limit: number; offset: number; sort: string; items: FleetRow[] };
export type FleetSort = "worst" | "best" | "name" | "customer" | "scanned" | "critical";

export type FleetSummary = {
    windowsDevices: number; withAgent: number; noAgent: number; scanned: number; neverScanned: number; stale: number; lastScanFailed: number;
    averageScore: number | null; devicesWithCriticalFailures: number;
    grades: Record<Grade | "none", number>;
    topFailingRules: Array<{ id: string; title: string; severity: Severity; group: string; devices: number }>;
};

/** The actions of a Linux device: turn on the firewall (SSH is allowed first), a ClamAV malware scan (reports only), install ClamAV, update its signatures. */
export type LinuxAction = "firewall-enable" | "malware-scan" | "antivirus-install" | "antivirus-update";
export type LinuxOutcome =
    | { action: "firewall-enable"; message: string }
    | { action: "antivirus-install"; message: string }
    | { action: "antivirus-update"; message: string }
    | { action: "malware-scan"; state: "clean" | "infected" | "error"; scannedFiles: number | null; seconds: number | null; infectedCount: number; found: Array<{ signature: string; path: string }>; message: string | null };
export type LinuxStart = { jobId: string; pending: true } | { jobId: string; pending: false; result: LinuxOutcome };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = (id: string) => `/api/devices/${encodeURIComponent(id)}/security`;

export const security = {
    device: (id: string) => jfetch<DeviceSecurity>(base(id)),
    scan: (id: string) => jfetch<{ queued: boolean; alreadyWaiting: boolean; jobId: string }>(`${base(id)}/scan`, { method: "POST", body: {} }),

    /** Runs a Defender action; a slow device answers "pending" with a job, which is asked about until it ends. */
    async defender(id: string, action: DefenderAction): Promise<DefenderOutcome> {
        let r = await jfetch<any>(`${base(id)}/defender/${action}`, { method: "POST", body: {} });
        for (let i = 0; i < 60 && r?.pending; i++) {
            await sleep(1500);
            r = await jfetch<any>(`${base(id)}/jobs/${encodeURIComponent(r.jobId)}`);
        }
        if (r?.pending) throw new Error("The device has not answered yet. Check its Security tab again in a moment.");
        return r.result as DefenderOutcome;
    },

    /** Starts a Linux action. A slow one (a malware scan) answers "pending" with a job id to ask about with linuxWait. */
    linuxStart: (id: string, action: LinuxAction) => jfetch<LinuxStart>(`${base(id)}/linux/${action}`, { method: "POST", body: {} }),
    /** Asks about a Linux action's job every few seconds until it ends, or until `stop()` says the page is gone. */
    async linuxWait(id: string, jobId: string, stop: () => boolean, tries = 1300): Promise<LinuxOutcome | null> {
        for (let i = 0; i < tries && !stop(); i++) {
            await sleep(1500);
            const r = await jfetch<any>(`${base(id)}/jobs/${encodeURIComponent(jobId)}`);
            if (!r?.pending) return r.result as LinuxOutcome;
        }
        return null;
    },

    fleet(p: { clientId?: string; q?: string; grade?: string; sort?: FleetSort; limit?: number; offset?: number }) {
        const sp = new URLSearchParams();
        if (p.clientId) sp.set("clientId", p.clientId);
        if (p.q?.trim()) sp.set("q", p.q.trim());
        if (p.grade) sp.set("grade", p.grade);
        if (p.sort) sp.set("sort", p.sort);
        sp.set("limit", String(p.limit ?? 25));
        sp.set("offset", String(p.offset ?? 0));
        return jfetch<FleetPage>(`/api/security/fleet?${sp.toString()}`);
    },
    summary: (clientId?: string) => jfetch<FleetSummary>(`/api/security/summary${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`),
};

/** "3 hours ago", "yesterday", "12 days ago". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
    if (!iso) return "never";
    const ms = now - Date.parse(iso);
    if (!Number.isFinite(ms)) return "never";
    const m = Math.round(ms / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
    const d = Math.round(h / 24);
    return d === 1 ? "yesterday" : `${d} days ago`;
}

/** The colour classes of a grade (used by the score ring and the badges). */
export function gradeClass(g: Grade | null): string {
    if (g === "A" || g === "B") return "text-emerald-600 dark:text-emerald-400";
    if (g === "C") return "text-amber-600 dark:text-amber-400";
    if (g === "D" || g === "F") return "text-red-600 dark:text-red-400";
    return "text-muted-foreground";
}
