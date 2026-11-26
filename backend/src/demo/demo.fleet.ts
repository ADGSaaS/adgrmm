// backend/src/demo/demo.fleet.ts
//
// The thirty devices added to the original ten, built from a few hardware presets so each line only says what makes the
// machine different: where it is, how old, how full its disk is, whether it is offline, what is wrong with it.
import { DEVICES, DemoDevice, RISK, THREATS, AVAILABILITY, DISK_DRIFT, HARDWARE_CHANGES, SOFTWARE } from "./demo.devices";

type Preset = Pick<DemoDevice, "kind" | "os" | "model" | "cpu" | "ramGb" | "diskGb" | "biosDate" | "purchasedYearsAgo" | "warrantyMonths"> & { platform?: "windows" | "linux"; distro?: string; gpu?: string; secondDisk?: DemoDevice["secondDisk"]; mounts?: [string, string] };

const W11 = (build: string, v = "24H2", name = "Microsoft Windows 11 Pro") => ({ name, version: v, build });
const PRESETS: Record<string, Preset> = {
    w11a: { kind: "workstation", os: W11("26100.2605"), model: "Dell Latitude 5440", cpu: "Intel(R) Core(TM) i5-1345U", ramGb: 16, diskGb: 512, biosDate: "2024-02-14", purchasedYearsAgo: 0.9, warrantyMonths: 36 },
    w11b: { kind: "workstation", os: W11("22631.4460", "23H2"), model: "Lenovo ThinkPad E14 Gen 5", cpu: "AMD Ryzen 5 7530U", ramGb: 16, diskGb: 512, biosDate: "2023-10-05", purchasedYearsAgo: 1.6, warrantyMonths: 36 },
    w11c: { kind: "workstation", os: W11("26100.2605"), model: "HP EliteBook 840 G10", cpu: "Intel(R) Core(TM) i7-1355U", ramGb: 32, diskGb: 1000, biosDate: "2023-11-20", purchasedYearsAgo: 1.4, warrantyMonths: 36 },
    w11d: { kind: "workstation", os: W11("26100.2605"), model: "HP ProDesk 400 G9", cpu: "Intel(R) Core(TM) i5-12500", ramGb: 16, diskGb: 512, biosDate: "2022-09-10", purchasedYearsAgo: 2.6, warrantyMonths: 36 },
    w10a: { kind: "workstation", os: { name: "Microsoft Windows 10 Pro", version: "22H2", build: "19045.5131" }, model: "Dell OptiPlex 3060", cpu: "Intel(R) Core(TM) i5-8500", ramGb: 8, diskGb: 256, biosDate: "2018-11-19", purchasedYearsAgo: 6.2, warrantyMonths: 36 },
    w10b: { kind: "workstation", os: { name: "Microsoft Windows 10 Pro", version: "21H2", build: "19044.3930" }, model: "HP ProDesk 600 G4", cpu: "Intel(R) Core(TM) i5-8500T", ramGb: 8, diskGb: 500, biosDate: "2018-05-22", purchasedYearsAgo: 6.8, warrantyMonths: 36 },
    cad: { kind: "workstation", os: { name: "Microsoft Windows 11 Pro for Workstations", version: "24H2", build: "26100.2605" }, model: "Dell Precision 3660 Tower", cpu: "Intel(R) Core(TM) i9-12900", ramGb: 64, diskGb: 1000, biosDate: "2022-12-01", purchasedYearsAgo: 2.3, warrantyMonths: 36, gpu: "NVIDIA RTX A2000" },
    pos: { kind: "workstation", os: W11("22631.4460", "23H2"), model: "Dell OptiPlex 3000 Micro", cpu: "Intel(R) Core(TM) i3-12100T", ramGb: 8, diskGb: 256, biosDate: "2022-08-03", purchasedYearsAgo: 2.2, warrantyMonths: 36 },
    s2022: { kind: "server", os: { name: "Microsoft Windows Server 2022 Standard", version: "21H2", build: "20348.2762" }, model: "Dell PowerEdge R350", cpu: "Intel(R) Xeon(R) E-2336", ramGb: 64, diskGb: 1000, secondDisk: { gb: 4000, freePct: 46 }, biosDate: "2022-05-10", purchasedYearsAgo: 2.8, warrantyMonths: 60 },
    s2019: { kind: "server", os: { name: "Microsoft Windows Server 2019 Standard", version: "1809", build: "17763.6659" }, model: "HPE ProLiant DL20 Gen10 Plus", cpu: "Intel(R) Xeon(R) E-2314", ramGb: 32, diskGb: 1000, secondDisk: { gb: 2000, freePct: 38 }, biosDate: "2021-08-16", purchasedYearsAgo: 4.2, warrantyMonths: 48 },
    s2016: { kind: "server", os: { name: "Microsoft Windows Server 2016 Standard", version: "1607", build: "14393.7515" }, model: "Dell PowerEdge T330", cpu: "Intel(R) Xeon(R) E3-1230 v6", ramGb: 16, diskGb: 500, secondDisk: { gb: 1000, freePct: 27 }, biosDate: "2017-04-12", purchasedYearsAgo: 8.4, warrantyMonths: 36 },
    ub22: { platform: "linux", distro: "ubuntu", kind: "server", os: { name: "Ubuntu 22.04.5 LTS", version: "22.04", build: "5.15.0-125-generic" }, model: "Dell PowerEdge R250", cpu: "Intel(R) Xeon(R) E-2314, 4C/4T", ramGb: 32, diskGb: 1000, biosDate: "2023-01-24", purchasedYearsAgo: 1.9, warrantyMonths: 60 },
    ub24: { platform: "linux", distro: "ubuntu", kind: "server", os: { name: "Ubuntu 24.04.1 LTS", version: "24.04", build: "6.8.0-49-generic" }, model: "HPE ProLiant DL20 Gen11", cpu: "Intel(R) Xeon(R) E-2434, 4C/8T", ramGb: 32, diskGb: 960, biosDate: "2024-03-12", purchasedYearsAgo: 0.8, warrantyMonths: 60 },
    ub20: { platform: "linux", distro: "ubuntu", kind: "server", os: { name: "Ubuntu 20.04.6 LTS", version: "20.04", build: "5.4.0-200-generic" }, model: "Dell PowerEdge R240", cpu: "Intel(R) Xeon(R) E-2124, 4C/4T", ramGb: 16, diskGb: 500, biosDate: "2019-03-02", purchasedYearsAgo: 6.4, warrantyMonths: 36 },
    deb12: { platform: "linux", distro: "debian", kind: "server", os: { name: "Debian GNU/Linux 12 (bookworm)", version: "12", build: "6.1.0-27-amd64" }, model: "Supermicro SYS-5019C-MR", cpu: "Intel(R) Xeon(R) E-2278G, 8C/16T", ramGb: 32, diskGb: 960, biosDate: "2021-02-18", purchasedYearsAgo: 4.0, warrantyMonths: 36 },
    rocky9: { platform: "linux", distro: "rocky", kind: "server", os: { name: "Rocky Linux 9.4 (Blue Onyx)", version: "9.4", build: "5.14.0-427.28.1.el9_4.x86_64" }, model: "Dell PowerEdge R450", cpu: "Intel(R) Xeon(R) Silver 4310, 12C/24T", ramGb: 128, diskGb: 1900, mounts: ["/", "/var/lib/pgsql"], secondDisk: { gb: 3800, freePct: 24 }, biosDate: "2022-03-30", purchasedYearsAgo: 3.1, warrantyMonths: 60 },
    ubdesk: { platform: "linux", distro: "ubuntu", kind: "workstation", os: { name: "Ubuntu 24.04.1 LTS", version: "24.04", build: "6.8.0-49-generic" }, model: "LENOVO ThinkCentre M70q Gen 3", cpu: "12th Gen Intel(R) Core(TM) i5-12400T, 6C/12T", ramGb: 16, diskGb: 512, biosDate: "2023-02-06", purchasedYearsAgo: 1.9, warrantyMonths: 36 },
};

const gatewayOf = (ip: string) => ip.replace(/\.\d+$/, ".1");

function dev(host: string, customer: number, site: string, preset: keyof typeof PRESETS, ip: string, user: string, o: Partial<DemoDevice> = {}): DemoDevice {
    const p = PRESETS[preset];
    const linux = p.platform === "linux";
    const server = p.kind === "server";
    return {
        host, customer, site, ...p, ip, gateway: gatewayOf(ip), user,
        freePct: 50, tpm: linux ? null : { present: true, version: "2.0", enabled: true }, secureBoot: true,
        av: linux ? null : { name: "Windows Defender", state: "on", upToDate: true }, sigAge: linux ? null : 0,
        firewall: { domain: true, private: true, public: true }, bitlocker: linux ? (server ? "off" : "on") : server ? "off" : "on",
        lastSeenHoursAgo: 0, bootDaysAgo: 3 + (host.length * 7) % 30, pendingReboot: false, agent: "1.3.26",
        patches: "few", software: linux ? (server ? 14 : 12) : server ? 15 : 18, alerts: 2, sessions: 1,
        ...o,
    };
}

const NEW: DemoDevice[] = [
    // Harbor Dental and Summit Law get a Linux server each.
    dev("HAR-LNX-BACKUP01", 0, "Main clinic", "ub22", "10.20.1.8", "", { secondDisk: { gb: 8000, freePct: 11 }, mounts: ["/", "/srv/backup"], freePct: 61, bootDaysAgo: 118, patches: "few", services: ["borgmatic", "cron"], alerts: 3, sessions: 2, score: 82, extraAlerts: [["CRIT", "Backup job failed", "The nightly offsite sync to the backup bucket did not complete (exit code 23).", "OPEN", 20]] }),
    dev("SUM-LNX-DMS01", 1, "Downtown", "deb12", "172.16.4.9", "", { freePct: 58, pendingReboot: true, bootDaysAgo: 94, patches: "few", services: ["nginx", "postgresql"], alerts: 2, sessions: 2, score: 88 }),

    // Brightwater Accounting Partners: head office and a small branch.
    dev("BRW-PARTNER-01", 2, "Head office", "w11c", "10.40.1.11", "ewhitfield", { freePct: 52, patches: "clean", sessions: 1, score: 94, software: 26 }),
    dev("BRW-ACCT-02", 2, "Head office", "w10a", "10.40.1.23", "dpereira", { freePct: 8, secureBoot: false, bitlocker: "off", av: { name: "Windows Defender", state: "on", upToDate: true }, sigAge: 4, patches: "many", bootDaysAgo: 52, pendingReboot: true, agent: "1.3.44", alerts: 3, sessions: 2, score: 58, outdatedApps: 6, software: 21 }),
    dev("BRW-ACCT-03", 2, "Head office", "w11a", "10.40.1.24", "cnakamura", { freePct: 61, patches: "few", score: 91, software: 23 }),
    dev("BRW-ACCT-04", 2, "Branch office", "w11b", "10.40.2.12", "lharrow", { freePct: 44, lastSeenHoursAgo: 200, patches: "overdue", bootDaysAgo: 33, alerts: 2, sessions: 0, score: 71, software: 20 }),
    dev("BRW-SRV-01", 2, "Head office", "s2019", "10.40.1.5", "", { freePct: 19, pendingReboot: true, bootDaysAgo: 71, patches: "few", services: ["MSSQL$QBMGR", "QuickBooksDB32"], alerts: 5, sessions: 3, score: 76, software: 17, extraAlerts: [["CRIT", "Backup failed", "The last nightly backup of the QuickBooks company files did not complete.", "OPEN", 31], ["WARN", "Memory pressure", "Available memory has been under 10% for an hour.", "ACKED", 52]], hot: "memory" }),

    // Larkspur Outfitters: two shops and a warehouse.
    dev("LRK-POS-01", 3, "Store 1", "pos", "10.50.1.31", "kiosk", { freePct: 66, patches: "few", sessions: 1, score: 85, software: 12 }),
    dev("LRK-POS-02", 3, "Store 1", "pos", "10.50.1.32", "kiosk", { freePct: 63, av: { name: "Windows Defender", state: "snoozed", upToDate: true }, agent: "1.3.44", patches: "many", bootDaysAgo: 46, alerts: 2, sessions: 1, score: 66, software: 12 }),
    dev("LRK-POS-03", 3, "Store 2", "pos", "10.50.2.31", "kiosk", { freePct: 59, lastSeenHoursAgo: 130, patches: "overdue", alerts: 1, sessions: 0, score: 69, software: 11 }),
    dev("LRK-BACKOFFICE-01", 3, "Store 1", "w11d", "10.50.1.20", "manager", { freePct: 37, patches: "clean", score: 90, software: 19 }),
    dev("LRK-SRV-01", 3, "Warehouse", "s2016", "10.50.3.5", "", { freePct: 31, av: null, sigAge: null, firewall: { domain: false, private: true, public: true }, tpm: { present: false, version: "", enabled: false }, secureBoot: false, bitlocker: null, patches: "overdue", pendingReboot: true, bootDaysAgo: 206, agent: "1.3.41", alerts: 5, sessions: 3, score: 38, software: 15, services: ["Spooler", "W32Time"], downService: "Spooler", extraAlerts: [["CRIT", "No antivirus found", "No antivirus product reports in on this server.", "OPEN", 90]] }),
    dev("LRK-WEB-01", 3, "Warehouse", "ub20", "10.50.3.10", "", { freePct: 29, patches: "many", pendingReboot: true, bootDaysAgo: 188, agent: "1.3.52", services: ["nginx", "php8.1-fpm"], alerts: 3, sessions: 2, score: 52, extraAlerts: [["WARN", "Operating system out of standard support", "Ubuntu 20.04 no longer receives free security updates.", "SILENCED", 400]] }),

    // Ironbridge Fabrication: office, plant floor, servers.
    dev("IRB-CAD-01", 4, "Office", "cad", "10.60.1.41", "tkowalski", { freePct: 47, patches: "few", sessions: 1, score: 89, software: 24 }),
    dev("IRB-CAD-02", 4, "Office", "cad", "10.60.1.42", "rbaptiste", { freePct: 4, patches: "few", bootDaysAgo: 24, alerts: 3, sessions: 2, score: 74, software: 25, hot: "cpu" }),
    dev("IRB-PLANT-PC-01", 4, "Plant", "w10b", "10.60.2.21", "shopfloor", { freePct: 40, tpm: { present: false, version: "", enabled: false }, secureBoot: false, bitlocker: "off", sigAge: 9, av: { name: "Windows Defender", state: "on", upToDate: false }, patches: "many", bootDaysAgo: 120, pendingReboot: true, agent: "1.3.36", alerts: 3, sessions: 1, score: 47, outdatedApps: 4, software: 13 }),
    dev("IRB-PLANT-PC-02", 4, "Plant", "w10b", "10.60.2.22", "shopfloor", { freePct: 35, tpm: { present: false, version: "", enabled: false }, secureBoot: false, bitlocker: "off", lastSeenHoursAgo: 96, patches: "overdue", agent: "1.3.36", alerts: 2, sessions: 0, score: 49, software: 13 }),
    dev("IRB-OFFICE-01", 4, "Office", "w11a", "10.60.1.30", "dhale", { freePct: 56, patches: "clean", score: 93, software: 22 }),
    dev("IRB-DC-01", 4, "Office", "s2022", "10.60.1.2", "", { freePct: 64, patches: "few", bootDaysAgo: 27, services: ["NTDS", "DNS", "Netlogon"], alerts: 2, sessions: 2, score: 92, software: 14 }),
    dev("IRB-ERP-01", 4, "Office", "s2019", "10.60.1.6", "", { freePct: 23, patches: "overdue", pendingReboot: true, bootDaysAgo: 143, services: ["MSSQLSERVER", "SQLSERVERAGENT"], downService: "SQLSERVERAGENT", alerts: 5, sessions: 4, score: 63, software: 18, hot: "both", extraAlerts: [["CRIT", "Windows updates failing", "The last three update installs failed with error 0x80073712.", "OPEN", 140], ["WARN", "Pending restart for 30 days", "Updates are waiting for a restart.", "OPEN", 700]] }),
    dev("IRB-LNX-DB01", 4, "Office", "rocky9", "10.60.1.7", "", { freePct: 22, patches: "few", bootDaysAgo: 77, services: ["postgresql-16", "chronyd", "sshd"], alerts: 3, sessions: 3, score: 86, hot: "memory" }),
    dev("IRB-LNX-FILE01", 4, "Plant", "ub22", "10.60.2.8", "", { freePct: 35, secondDisk: { gb: 4000, freePct: 42 }, mounts: ["/", "/srv/shares"], patches: "few", services: ["smbd", "nmbd"], alerts: 2, sessions: 1, score: 84 }),
    dev("IRB-LNX-WS01", 4, "Office", "ubdesk", "10.60.1.35", "engineer", { freePct: 68, patches: "few", sessions: 1, score: 87 }),

    // Maple Grove Academy: main building, science wing.
    dev("MGA-LAB-01", 5, "Science wing", "w11d", "10.70.2.51", "student", { freePct: 72, patches: "clean", bootDaysAgo: 1, score: 88, software: 16 }),
    dev("MGA-LAB-02", 5, "Science wing", "w11d", "10.70.2.52", "student", { freePct: 70, patches: "few", bootDaysAgo: 1, score: 87, software: 16 }),
    dev("MGA-LAB-03", 5, "Science wing", "w11d", "10.70.2.53", "student", { freePct: 69, lastSeenHoursAgo: 300, patches: "never", alerts: 1, sessions: 0, score: 60, software: 15 }),
    dev("MGA-TEACH-01", 5, "Main building", "w11b", "10.70.1.61", "mrosales", { freePct: 51, lastSeenHoursAgo: 72, patches: "few", alerts: 1, sessions: 1, score: 83, software: 21 }),
    dev("MGA-ADMIN-01", 5, "Main building", "w11a", "10.70.1.20", "registrar", { freePct: 45, patches: "few", sessions: 2, score: 90, software: 24 }),
    dev("MGA-SRV-01", 5, "Main building", "s2022", "10.70.1.5", "", { freePct: 58, patches: "few", bootDaysAgo: 45, services: ["DHCPServer", "DNS"], alerts: 2, sessions: 2, score: 85, software: 14 }),
    dev("MGA-LNX-PROXY01", 5, "Main building", "deb12", "10.70.1.9", "", { freePct: 71, agent: "1.3.52", patches: "many", services: ["squid", "chrony"], alerts: 2, sessions: 1, score: 79 }),
];

export const FLEET: DemoDevice[] = [...DEVICES, ...NEW];

/** Windows risk facts for the new machines: sensible by default, poor where the story says so. */
const risk = (o: Record<string, any> = {}) => ({ rdp: { enabled: false, nla: true }, smb1Enabled: false, autoLogon: false, uacEnabled: true, guestEnabled: false, localAdmins: ["Administrator", "MSP-Admin"], passwordPolicy: { minLength: 12, lockoutThreshold: 5 }, screenLockMinutes: 10, ...o });
Object.assign(RISK, {
    "BRW-PARTNER-01": risk({ passwordPolicy: { minLength: 14, lockoutThreshold: 5 }, screenLockMinutes: 5 }),
    "BRW-ACCT-02": risk({ rdp: { enabled: true, nla: false }, localAdmins: ["Administrator", "MSP-Admin", "dpereira", "temp-tech"], passwordPolicy: { minLength: 6, lockoutThreshold: 0 }, screenLockMinutes: 0 }),
    "BRW-ACCT-03": risk(),
    "BRW-ACCT-04": risk({ screenLockMinutes: 5 }),
    "BRW-SRV-01": risk({ rdp: { enabled: true, nla: true }, localAdmins: ["Administrator", "MSP-Admin", "qb-svc", "backup-svc"], passwordPolicy: { minLength: 10, lockoutThreshold: 5 }, screenLockMinutes: 15 }),
    "LRK-POS-01": risk({ autoLogon: true, screenLockMinutes: 0 }),
    "LRK-POS-02": risk({ autoLogon: true, screenLockMinutes: 0 }),
    "LRK-POS-03": risk({ autoLogon: true, screenLockMinutes: 0 }),
    "LRK-BACKOFFICE-01": risk(),
    "LRK-SRV-01": risk({ rdp: { enabled: true, nla: false }, smb1Enabled: true, uacEnabled: false, guestEnabled: true, localAdmins: ["Administrator", "vendor", "MSP-Admin", "pos-admin"], passwordPolicy: { minLength: 4, lockoutThreshold: 0 }, screenLockMinutes: 30 }),
    "IRB-CAD-01": risk(),
    "IRB-CAD-02": risk({ screenLockMinutes: 15 }),
    "IRB-PLANT-PC-01": risk({ smb1Enabled: true, autoLogon: true, uacEnabled: false, passwordPolicy: { minLength: 4, lockoutThreshold: 0 }, screenLockMinutes: 0 }),
    "IRB-PLANT-PC-02": risk({ smb1Enabled: true, autoLogon: true, passwordPolicy: { minLength: 4, lockoutThreshold: 0 }, screenLockMinutes: 0 }),
    "IRB-OFFICE-01": risk(),
    "IRB-DC-01": risk({ rdp: { enabled: true, nla: true }, localAdmins: ["Administrator", "MSP-Admin"], passwordPolicy: { minLength: 14, lockoutThreshold: 5 }, screenLockMinutes: 10 }),
    "IRB-ERP-01": risk({ rdp: { enabled: true, nla: true }, localAdmins: ["Administrator", "MSP-Admin", "sql-svc", "erp-vendor"], passwordPolicy: { minLength: 10, lockoutThreshold: 5 }, screenLockMinutes: 15 }),
    "MGA-LAB-01": risk({ screenLockMinutes: 15 }),
    "MGA-LAB-02": risk({ screenLockMinutes: 15 }),
    "MGA-LAB-03": risk({ screenLockMinutes: 15 }),
    "MGA-TEACH-01": risk(),
    "MGA-ADMIN-01": risk({ passwordPolicy: { minLength: 14, lockoutThreshold: 5 } }),
    "MGA-SRV-01": risk({ rdp: { enabled: true, nla: true }, passwordPolicy: { minLength: 12, lockoutThreshold: 5 } }),
});

Object.assign(THREATS, {
    "BRW-ACCT-02": [["PUA:Win32/Presenoker", "low", 6, "cleaned", "Cleaned", "C:\\Users\\dpereira\\AppData\\Local\\Temp\\upd.exe"]],
    "LRK-SRV-01": [["Trojan:Win32/Emotet.RPK!MTB", "severe", 3, "active", "No action", "D:\\Share\\Invoices\\scan_0042.doc.exe"]],
    "IRB-PLANT-PC-01": [["Trojan:Win32/Wacatac.C!ml", "high", 8, "quarantined", "Quarantined", "C:\\Users\\shopfloor\\Downloads\\drawing_viewer.exe"], ["PUA:Win32/Softcnapp", "moderate", 15, "failed", "Quarantined", "C:\\Users\\shopfloor\\AppData\\Roaming\\toolbar.dll"]],
    "MGA-LAB-02": [["PUA:Win32/InstallCore", "moderate", 4, "removed", "Removed", "C:\\Users\\student\\Downloads\\game_setup.exe"]],
});

Object.assign(AVAILABILITY, {
    "HAR-LNX-BACKUP01": 0.999, "SUM-LNX-DMS01": 0.997, "BRW-PARTNER-01": 0.985, "BRW-ACCT-02": 0.96, "BRW-ACCT-03": 0.98, "BRW-ACCT-04": 0.55, "BRW-SRV-01": 0.996,
    "LRK-POS-01": 0.97, "LRK-POS-02": 0.93, "LRK-POS-03": 0.6, "LRK-BACKOFFICE-01": 0.98, "LRK-SRV-01": 0.985, "LRK-WEB-01": 0.99,
    "IRB-CAD-01": 0.97, "IRB-CAD-02": 0.97, "IRB-PLANT-PC-01": 0.9, "IRB-PLANT-PC-02": 0.7, "IRB-OFFICE-01": 0.98, "IRB-DC-01": 0.999, "IRB-ERP-01": 0.99, "IRB-LNX-DB01": 0.9995, "IRB-LNX-FILE01": 0.998, "IRB-LNX-WS01": 0.96,
    "MGA-LAB-01": 0.94, "MGA-LAB-02": 0.94, "MGA-LAB-03": 0.5, "MGA-TEACH-01": 0.8, "MGA-ADMIN-01": 0.98, "MGA-SRV-01": 0.998, "MGA-LNX-PROXY01": 0.995,
});

Object.assign(DISK_DRIFT, { "BRW-ACCT-02": 11, "IRB-CAD-02": 14, "HAR-LNX-BACKUP01": 8, "IRB-LNX-DB01": 5, "BRW-SRV-01": 6, "LRK-WEB-01": 3 });

Object.assign(HARDWARE_CHANGES, {
    "IRB-CAD-02": [{ kind: "hardware", summary: "Graphics adapter changed from NVIDIA T400 to NVIDIA RTX A2000" }],
    "BRW-SRV-01": [{ kind: "hardware", summary: "Drive D: size changed from 1000 GB to 2000 GB" }],
    "MGA-TEACH-01": [{ kind: "os", summary: "Windows 11 Pro updated from 22H2 to 23H2" }],
    "IRB-LNX-DB01": [{ kind: "hardware", summary: "Memory changed from 64 GB to 128 GB" }],
});

/** Programs found on Linux machines (package names, as the agent lists them). */
export const LINUX_SOFTWARE: Array<[string, string, string[]]> = [
    ["openssh-server", "Ubuntu", ["1:8.9p1-3ubuntu0.10", "1:9.6p1-3ubuntu13"]], ["openssl", "Ubuntu", ["3.0.2-0ubuntu1.18", "3.0.13-0ubuntu3.4"]], ["curl", "Ubuntu", ["7.81.0-1ubuntu1.18", "8.5.0-2ubuntu10.5"]],
    ["nginx", "nginx", ["1.18.0-6ubuntu14.5", "1.24.0-2ubuntu7"]], ["postgresql", "PostgreSQL Global Development Group", ["14.13", "16.4"]], ["python3", "Python Software Foundation", ["3.10.12", "3.12.3"]],
    ["docker-ce", "Docker, Inc.", ["26.1.4", "27.3.1"]], ["fail2ban", "Fail2Ban", ["0.11.2", "1.0.2"]], ["ufw", "Ubuntu", ["0.36.1", "0.36.2"]], ["chrony", "Chrony", ["4.2", "4.5"]],
    ["rsync", "Samba Team", ["3.2.7", "3.2.7"]], ["samba", "Samba Team", ["4.15.13", "4.19.5"]], ["git", "Git", ["2.34.1", "2.43.0"]], ["vim", "Vim", ["8.2.3995", "9.1.0016"]],
    ["unattended-upgrades", "Ubuntu", ["2.8ubuntu1", "2.9.1"]], ["cron", "Ubuntu", ["3.0pl1-137", "3.0pl1-184"]], ["htop", "htop", ["3.0.5", "3.3.0"]], ["bind9", "ISC", ["9.18.28", "9.18.30"]],
    ["clamav", "Cisco", ["0.103.12", "1.0.7"]], ["borgbackup", "BorgBackup", ["1.2.0", "1.2.7"]], ["firefox", "Mozilla", ["131.0", "132.0"]], ["libreoffice", "The Document Foundation", ["7.3.7", "24.2.4"]],
];

export const LINUX_PATCHES = [
    { title: "Security update: linux-image kernel packages", severity: "Critical", requiresReboot: true, kb: "" },
    { title: "Security update: openssl, libssl3", severity: "Important", requiresReboot: false, kb: "" },
    { title: "Security update: openssh-server, openssh-client", severity: "Important", requiresReboot: false, kb: "" },
    { title: "Security update: curl, libcurl4", severity: "Moderate", requiresReboot: false, kb: "" },
    { title: "Security update: sudo", severity: "Important", requiresReboot: false, kb: "" },
    { title: "Security update: glibc (libc6)", severity: "Critical", requiresReboot: true, kb: "" },
    { title: "Update: tzdata", severity: null, requiresReboot: false, kb: "" },
    { title: "Update: systemd, udev", severity: "Moderate", requiresReboot: true, kb: "" },
];

export const WINDOWS_ONLY_SCRIPTS = ["Restart print spooler", "Install Windows updates", "Reset network adapter", "Flush DNS cache", "Remove old profiles"];
export const LINUX_SCRIPTS = ["Clear package cache", "Restart a service", "Install security updates", "Collect system report", "Check disk health", "Rotate logs"];

// Programs that belong to the new customers' trades, added to the Windows list.
SOFTWARE.push(
    ["Example CAD Suite", "Example CAD Vendor", ["2024.1", "2025.0"]], ["Example Tax Software Pro", "Example Tax Software", ["2026.3", "2027.1"]],
    ["Retail Point of Sale Client", "Example POS Systems", ["8.2", "8.4"]], ["School Gradebook Client", "Example Education Software", ["5.1", "5.2"]],
    ["Machine Shop Controller", "Example Machine Co.", ["7.4", "7.6"]],
);
