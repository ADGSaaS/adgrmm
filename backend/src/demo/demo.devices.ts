// backend/src/demo/demo.devices.ts
//
// The demo fleet: forty fictional endpoints for six fictional customers (Windows workstations and servers, Linux servers
// and desktops), with the facts each agent would have sent. Nothing here is real: hostnames, models and users are made up
// and every address is in a private (RFC 1918) range.
export const GB = 1024 ** 3;

export type DemoDevice = {
    host: string; customer: number; site: string; kind: "workstation" | "server";
    /** Windows unless said otherwise. Linux devices use the same fields; `os.build` is then the kernel. */
    platform?: "windows" | "linux";
    /** Linux only: the distribution id (ubuntu, debian, rocky) and the names of the mounted volumes. */
    distro?: string; mounts?: [string, string];
    /** Graphics adapter, when it is not the processor's integrated one. */
    gpu?: string;
    /** Services this machine runs that are watched by a check, and one of them that is currently down. */
    services?: string[]; downService?: string;
    /** A resource that is running hot right now. */
    hot?: "cpu" | "memory" | "both";
    /** Alerts for things the facts do not show: [severity, title, detail, state, hours since it started]. */
    extraAlerts?: Array<["WARN" | "CRIT", string, string, "OPEN" | "ACKED" | "SILENCED" | "RESOLVED", number]>;
    /** Security score and grade of the last security scan, and how many programs have an update waiting. */
    score?: number; outdatedApps?: number;
    os: { name: string; version: string; build: string };
    model: string; cpu: string; ramGb: number; diskGb: number; freePct: number; secondDisk?: { gb: number; freePct: number };
    biosDate: string; purchasedYearsAgo: number | null; warrantyMonths: number | null;
    tpm: { present: boolean; version: string; enabled: boolean } | null; secureBoot: boolean | null;
    av: { name: string; state: "on" | "off" | "snoozed"; upToDate: boolean } | null; sigAge: number | null;
    firewall: { domain: boolean; private: boolean; public: boolean } | null; bitlocker: "on" | "off" | null;
    lastSeenHoursAgo: number | null; bootDaysAgo: number; pendingReboot: boolean; user: string;
    ip: string; gateway: string; agent: string;
    patches: "clean" | "few" | "many" | "never" | "overdue";
    software: number; alerts: number; sessions: number; tickets?: number;
};

export const DEVICES: DemoDevice[] = [
    { host: "HAR-FRONT-01", customer: 0, site: "Main clinic", kind: "workstation", os: { name: "Microsoft Windows 11 Pro", version: "25H2", build: "26200.6899" }, model: "Dell Latitude 7440", cpu: "Intel(R) Core(TM) i7-1365U", ramGb: 16, diskGb: 512, freePct: 54, biosDate: "2023-09-12", purchasedYearsAgo: 1.2, warrantyMonths: 36, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true, av: { name: "Windows Defender", state: "on", upToDate: true }, sigAge: 0, firewall: { domain: true, private: true, public: true }, bitlocker: "on", lastSeenHoursAgo: 0, bootDaysAgo: 3, pendingReboot: false, user: "reception", ip: "10.20.1.21", gateway: "10.20.1.1", agent: "1.3.26", patches: "clean", software: 22, alerts: 1, sessions: 2, tickets: 1 },
    { host: "HAR-CHAIR-02", customer: 0, site: "Main clinic", kind: "workstation", os: { name: "Microsoft Windows 10 Pro", version: "22H2", build: "19045.5131" }, model: "HP EliteDesk 800 G4", cpu: "Intel(R) Core(TM) i5-8500", ramGb: 8, diskGb: 256, freePct: 9, biosDate: "2019-02-20", purchasedYearsAgo: 6.8, warrantyMonths: 36, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true, av: { name: "Windows Defender", state: "on", upToDate: true }, sigAge: 1, firewall: { domain: true, private: true, public: true }, bitlocker: "off", lastSeenHoursAgo: 0, bootDaysAgo: 41, pendingReboot: true, user: "dr.patel", ip: "10.20.1.34", gateway: "10.20.1.1", agent: "1.3.26", patches: "many", software: 19, alerts: 4, sessions: 3, tickets: 2 },
    { host: "HAR-XRAY-03", customer: 0, site: "Main clinic", kind: "workstation", os: { name: "Microsoft Windows 10 Pro", version: "21H2", build: "19044.3930" }, model: "Dell OptiPlex 7050", cpu: "Intel(R) Core(TM) i5-6500", ramGb: 8, diskGb: 500, freePct: 31, biosDate: "2017-03-08", purchasedYearsAgo: 8.4, warrantyMonths: 36, tpm: { present: false, version: "", enabled: false }, secureBoot: false, av: { name: "Windows Defender", state: "on", upToDate: false }, sigAge: 19, firewall: { domain: true, private: false, public: true }, bitlocker: "off", lastSeenHoursAgo: 52, bootDaysAgo: 88, pendingReboot: false, user: "xray", ip: "10.20.1.40", gateway: "10.20.1.1", agent: "1.3.23", patches: "overdue", software: 14, alerts: 3, sessions: 1, tickets: 2 },
    { host: "HAR-SRV-01", customer: 0, site: "Main clinic", kind: "server", os: { name: "Microsoft Windows Server 2016 Standard", version: "1607", build: "14393.7515" }, model: "Dell PowerEdge T340", cpu: "Intel(R) Xeon(R) E-2234", ramGb: 32, diskGb: 1000, freePct: 22, secondDisk: { gb: 2000, freePct: 41 }, biosDate: "2020-06-30", purchasedYearsAgo: 5.5, warrantyMonths: 60, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true, av: { name: "Windows Defender", state: "on", upToDate: true }, sigAge: 2, firewall: { domain: true, private: true, public: true }, bitlocker: "on", lastSeenHoursAgo: 0, bootDaysAgo: 112, pendingReboot: true, user: "", ip: "10.20.1.5", gateway: "10.20.1.1", agent: "1.3.26", patches: "few", software: 17, alerts: 5, sessions: 4, tickets: 2 },
    { host: "HAR-LAPTOP-04", customer: 0, site: "Front desk", kind: "workstation", os: { name: "Microsoft Windows 11 Pro", version: "23H2", build: "22631.4460" }, model: "Lenovo ThinkPad T14 Gen 3", cpu: "AMD Ryzen 5 PRO 6650U", ramGb: 16, diskGb: 512, freePct: 63, biosDate: "2022-11-02", purchasedYearsAgo: 2.1, warrantyMonths: 36, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true, av: { name: "Windows Defender", state: "snoozed", upToDate: true }, sigAge: 0, firewall: { domain: true, private: true, public: true }, bitlocker: "on", lastSeenHoursAgo: 5, bootDaysAgo: 9, pendingReboot: false, user: "manager", ip: "10.20.2.18", gateway: "10.20.2.1", agent: "1.3.26", patches: "few", software: 24, alerts: 2, sessions: 2, tickets: 1 },
    { host: "SUM-PARTNER-01", customer: 1, site: "Downtown", kind: "workstation", os: { name: "Microsoft Windows 11 Pro", version: "25H2", build: "26200.6899" }, model: "Dell XPS 15 9530", cpu: "Intel(R) Core(TM) i9-13900H", ramGb: 32, diskGb: 1000, freePct: 47, biosDate: "2023-08-01", purchasedYearsAgo: 1.4, warrantyMonths: 36, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true, av: { name: "CrowdStrike Falcon", state: "on", upToDate: true }, sigAge: null, firewall: { domain: true, private: true, public: true }, bitlocker: "on", lastSeenHoursAgo: 0, bootDaysAgo: 2, pendingReboot: false, user: "j.summit", ip: "172.16.4.12", gateway: "172.16.4.1", agent: "1.3.26", patches: "clean", software: 26, alerts: 0, sessions: 1, tickets: 1 },
    { host: "SUM-PARALEGAL-02", customer: 1, site: "Downtown", kind: "workstation", os: { name: "Microsoft Windows 10 Pro", version: "22H2", build: "19045.5131" }, model: "HP ProDesk 600 G3", cpu: "Intel(R) Core(TM) i5-7500", ramGb: 8, diskGb: 256, freePct: 14, biosDate: "2018-01-15", purchasedYearsAgo: 7.6, warrantyMonths: 36, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: false, av: { name: "Windows Defender", state: "on", upToDate: true }, sigAge: 3, firewall: { domain: true, private: true, public: true }, bitlocker: "off", lastSeenHoursAgo: 1, bootDaysAgo: 27, pendingReboot: false, user: "paralegal", ip: "172.16.4.27", gateway: "172.16.4.1", agent: "1.3.25", patches: "many", software: 18, alerts: 3, sessions: 2, tickets: 2 },
    { host: "SUM-INTAKE-03", customer: 1, site: "Downtown", kind: "workstation", os: { name: "Microsoft Windows 10 Pro", version: "22H2", build: "19045.5131" }, model: "Dell OptiPlex 3070", cpu: "Intel(R) Core(TM) i3-9100", ramGb: 4, diskGb: 256, freePct: 38, biosDate: "2019-09-23", purchasedYearsAgo: 5.2, warrantyMonths: 36, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true, av: { name: "Windows Defender", state: "on", upToDate: true }, sigAge: 1, firewall: { domain: true, private: true, public: true }, bitlocker: "off", lastSeenHoursAgo: 0, bootDaysAgo: 14, pendingReboot: false, user: "intake", ip: "172.16.4.31", gateway: "172.16.4.1", agent: "1.3.26", patches: "few", software: 15, alerts: 2, sessions: 1, tickets: 1 },
    { host: "SUM-FILE-01", customer: 1, site: "Downtown", kind: "server", os: { name: "Microsoft Windows Server 2019 Standard", version: "1809", build: "17763.6659" }, model: "HPE ProLiant ML350 Gen10", cpu: "Intel(R) Xeon(R) Silver 4210", ramGb: 64, diskGb: 2000, freePct: 17, secondDisk: { gb: 4000, freePct: 8 }, biosDate: "2021-04-19", purchasedYearsAgo: 4.6, warrantyMonths: 48, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true, av: { name: "Windows Defender", state: "on", upToDate: true }, sigAge: 0, firewall: { domain: true, private: true, public: true }, bitlocker: "on", lastSeenHoursAgo: 0, bootDaysAgo: 63, pendingReboot: false, user: "", ip: "172.16.4.5", gateway: "172.16.4.1", agent: "1.3.26", patches: "few", software: 16, alerts: 6, sessions: 5, tickets: 3 },
    { host: "SUM-REMOTE-04", customer: 1, site: "Remote staff", kind: "workstation", os: { name: "Microsoft Windows 11 Home", version: "23H2", build: "22631.4460" }, model: "Microsoft Surface Laptop 5", cpu: "Intel(R) Core(TM) i7-1255U", ramGb: 16, diskGb: 512, freePct: 58, biosDate: "2022-10-18", purchasedYearsAgo: 2.3, warrantyMonths: 24, tpm: { present: true, version: "2.0", enabled: true }, secureBoot: true, av: { name: "Windows Defender", state: "on", upToDate: true }, sigAge: 0, firewall: { domain: true, private: true, public: true }, bitlocker: "on", lastSeenHoursAgo: 400, bootDaysAgo: 21, pendingReboot: false, user: "associate", ip: "192.168.1.44", gateway: "192.168.1.1", agent: "1.3.20", patches: "never", software: 20, alerts: 1, sessions: 0, tickets: 1 },
];

export const SOFTWARE: Array<[string, string, string[]]> = [
    ["Google Chrome", "Google LLC", ["124.0.6367", "125.0.6422", "126.0.6478"]], ["Mozilla Firefox", "Mozilla", ["125.0", "126.0.1", "127.0"]],
    ["Microsoft 365 Apps", "Microsoft Corporation", ["16.0.17328", "16.0.17628"]], ["Adobe Acrobat Reader", "Adobe", ["23.008", "24.002"]],
    ["Zoom Workplace", "Zoom Video Communications", ["5.17.5", "5.18.2"]], ["7-Zip", "Igor Pavlov", ["22.01", "23.01"]],
    ["Microsoft Teams", "Microsoft Corporation", ["24004", "24124"]], ["Slack", "Slack Technologies", ["4.36.140", "4.38.121"]],
    ["VLC media player", "VideoLAN", ["3.0.18", "3.0.20"]], ["Notepad++", "Notepad++ Team", ["8.5.8", "8.6.4"]],
    ["TeamViewer", "TeamViewer Germany GmbH", ["15.50.5", "15.52.3"]], ["Dropbox", "Dropbox, Inc.", ["194.4", "202.4"]],
    ["Java 8 Update", "Oracle Corporation", ["8.0.3810", "8.0.4110"]], ["Adobe Flash Player", "Adobe", ["32.0.0.465"]],
    ["QuickBooks Desktop", "Intuit", ["2023", "2024"]], ["Clio Manage", "Themis Solutions", ["2.4.1", "2.5.0"]],
    ["Dentrix", "Henry Schein", ["G7.6", "G7.8"]], ["Windows Defender", "Microsoft Corporation", ["4.18"]],
    ["Zoom Rooms", "Zoom Video Communications", ["5.17"]], ["Citrix Workspace", "Citrix Systems", ["2311", "2402"]],
    ["WinRAR", "win.rar GmbH", ["6.24", "7.00"]], ["Skype", "Microsoft Corporation", ["8.115"]], ["Python 3", "Python Software Foundation", ["3.11.8", "3.12.3"]],
    ["Visual Studio Code", "Microsoft Corporation", ["1.88", "1.90"]], ["Cisco AnyConnect", "Cisco Systems", ["4.10", "5.1"]],
    ["Bitdefender Endpoint", "Bitdefender", ["7.9"]], ["Foxit PDF Reader", "Foxit Software", ["12.1", "2024.2"]],
];

export const PATCH_CATALOG = [
    { title: "2024-11 Cumulative Update for Windows (KB5046613)", severity: "Critical", requiresReboot: true, kb: "5046613" },
    { title: "Security Intelligence Update for Microsoft Defender Antivirus (KB2267602)", severity: "Important", requiresReboot: false, kb: "2267602" },
    { title: "2024-11 .NET Framework Security Update (KB5045934)", severity: "Important", requiresReboot: true, kb: "5045934" },
    { title: "Windows Malicious Software Removal Tool (KB890830)", severity: "Moderate", requiresReboot: false, kb: "890830" },
    { title: "2024-10 Security Update for Adobe Flash Player (KB4577586)", severity: "Critical", requiresReboot: false, kb: "4577586" },
    { title: "Servicing Stack Update (KB5044033)", severity: "Important", requiresReboot: true, kb: "5044033" },
    { title: "2024-11 Cumulative Update Preview (KB5046714)", severity: null, requiresReboot: true, kb: "5046714" },
    { title: "Intel - System driver update (31.0.101.5333)", severity: null, requiresReboot: false, kb: "" },
];

export const ALERTS: Array<[string, string, string]> = [
    ["WARN", "Disk space low", "Free space is under 15% on C:"], ["CRIT", "Disk space critical", "Free space is under 10% on C:"],
    ["WARN", "CPU high for 10 minutes", "CPU stayed above 90%"], ["CRIT", "Service stopped: Spooler", "The Print Spooler service is not running"],
    ["WARN", "Memory pressure", "Available memory under 10%"], ["CRIT", "Backup failed", "Last nightly backup did not complete"],
    ["WARN", "Pending restart for 14 days", "Updates are waiting for a restart"], ["WARN", "Antivirus definitions old", "Definitions are over 7 days old"],
];

export const SCRIPTS = ["Clear temp files", "Restart print spooler", "Install Windows updates", "Collect system report", "Reset network adapter", "Flush DNS cache", "Check disk health", "Remove old profiles"];

export const SUBJECTS = ["Printer will not print", "Slow computer", "Cannot connect to VPN", "Outlook keeps asking for password", "New starter setup", "Email not syncing on phone", "Blue screen after update", "Shared drive missing", "Request: extra monitor", "Wi-Fi drops in the afternoon", "Install Adobe Acrobat", "Scanner not working"];

/** Compares dotted version numbers part by part. */
const cmpVersion = (a: string, b: string) => {
    const x = a.match(/\d+/g)?.map(Number) ?? [];
    const y = b.match(/\d+/g)?.map(Number) ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Share of the time each demo device is online, so availability differs between them. */
export const AVAILABILITY: Record<string, number> = { "HAR-FRONT-01": 0.995, "HAR-CHAIR-02": 0.97, "HAR-XRAY-03": 0.86, "HAR-SRV-01": 0.999, "HAR-LAPTOP-04": 0.72, "SUM-PARTNER-01": 0.99, "SUM-PARALEGAL-02": 0.95, "SUM-INTAKE-03": 0.98, "SUM-FILE-01": 0.998, "SUM-REMOTE-04": 0.7 };
/** How many percentage points of free space each device lost over the 60 days. */
export const DISK_DRIFT: Record<string, number> = { "HAR-CHAIR-02": 17, "SUM-FILE-01": 9, "SUM-PARALEGAL-02": 6, "HAR-SRV-01": 4, "HAR-FRONT-01": -2 };
export const HARDWARE_CHANGES: Record<string, Array<{ kind: string; summary: string }>> = {
    "HAR-CHAIR-02": [{ kind: "hardware", summary: "Memory changed from 4 GB to 8 GB" }, { kind: "os", summary: "Windows 10 Pro updated from 21H2 to 22H2" }],
    "SUM-FILE-01": [{ kind: "hardware", summary: "Drive D: size changed from 2000 GB to 4000 GB" }],
    "HAR-LAPTOP-04": [{ kind: "os", summary: "Windows 11 Pro updated from 22H2 to 23H2" }],
};
/** The risky-configuration facts newer agents send. The last Summit device has none, as if its agent were old. */
export const RISK: Record<string, Record<string, any>> = {
    "HAR-FRONT-01": { rdp: { enabled: false, nla: true }, smb1Enabled: false, autoLogon: false, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin"], passwordPolicy: { minLength: 12, lockoutThreshold: 5 }, screenLockMinutes: 10 },
    "HAR-CHAIR-02": { rdp: { enabled: true, nla: false }, smb1Enabled: false, autoLogon: true, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin", "dr.patel", "front", "temp-tech"], passwordPolicy: { minLength: 6, lockoutThreshold: 0 }, screenLockMinutes: 0 },
    "HAR-XRAY-03": { rdp: { enabled: true, nla: true }, smb1Enabled: true, autoLogon: false, uacEnabled: false, guestEnabled: true, localAdmins: ["Administrator", "xray", "vendor", "MSP-Admin"], passwordPolicy: { minLength: 4, lockoutThreshold: 0 }, screenLockMinutes: 30 },
    "HAR-SRV-01": { rdp: { enabled: true, nla: true }, smb1Enabled: false, autoLogon: false, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin", "backup-svc", "sql-svc", "vendor", "dr.patel"], passwordPolicy: { minLength: 10, lockoutThreshold: 5 }, screenLockMinutes: 15 },
    "HAR-LAPTOP-04": { rdp: { enabled: false, nla: true }, smb1Enabled: false, autoLogon: false, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin"], passwordPolicy: { minLength: 12, lockoutThreshold: 5 }, screenLockMinutes: 5 },
    "SUM-PARTNER-01": { rdp: { enabled: false, nla: true }, smb1Enabled: false, autoLogon: false, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin"], passwordPolicy: { minLength: 14, lockoutThreshold: 5 }, screenLockMinutes: 5 },
    "SUM-PARALEGAL-02": { rdp: { enabled: false, nla: true }, smb1Enabled: false, autoLogon: false, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin"], passwordPolicy: { minLength: 6, lockoutThreshold: 0 }, screenLockMinutes: 20 },
    "SUM-INTAKE-03": { rdp: { enabled: false, nla: true }, smb1Enabled: false, autoLogon: true, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin"], passwordPolicy: { minLength: 8, lockoutThreshold: 5 }, screenLockMinutes: 10 },
    "SUM-FILE-01": { rdp: { enabled: true, nla: true }, smb1Enabled: true, autoLogon: false, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin", "backup-svc"], passwordPolicy: { minLength: 10, lockoutThreshold: 5 }, screenLockMinutes: 15 },
};

/** Threats Defender found on some demo devices: [name, severity, days ago, status, action, where]. A device not listed has none; the last Summit one has no threat data at all. */
export const THREATS: Record<string, Array<[string, string, number, string, string, string]>> = {
    "HAR-XRAY-03": [["Trojan:Win32/Wacatac.B!ml", "severe", 2, "active", "No action", "C:\\Users\\xray\\Downloads\\invoice_scan.exe"], ["PUA:Win32/InstallCore", "moderate", 9, "failed", "Quarantined", "C:\\Users\\xray\\AppData\\Local\\Temp\\setup.exe"]],
    "HAR-CHAIR-02": [["PUA:Win32/Presenoker", "low", 14, "cleaned", "Cleaned", "C:\\Program Files\\Updater\\u.exe"]],
    "SUM-PARALEGAL-02": [["Trojan:Script/Phonzy.A!ml", "high", 5, "quarantined", "Quarantined", "C:\\Users\\paralegal\\Downloads\\contract.js"], ["Behavior:Win32/Hive.A", "moderate", 21, "removed", "Removed", "C:\\Users\\paralegal\\AppData\\Roaming\\x.dll"]],
    "SUM-FILE-01": [["Exploit:Script/Foosace.A", "high", 11, "cleaned", "Cleaned", "D:\\Shared\\Intake\\form.html"]],
};
