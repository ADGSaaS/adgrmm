// backend/src/demo/demo.service.ts
//
// Demo data: two sample customers with ten endpoints between them, each with full hardware, security, network and
// software facts, patch scans, alerts, remote sessions, tickets and asset records, so every report has something real-
// looking to show. Every top-level row it creates is recorded in demo_records, and turning demo data off deletes exactly
// those rows (everything under a demo device goes with it), so real data is never touched.
import { BadRequestException, Injectable } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PoliciesService } from "../policies/policies.service";

const GB = 1024 ** 3;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const DEMO_PREFIX = "Demo: ";

type DemoDevice = {
    host: string; customer: 0 | 1; site: string; kind: "workstation" | "server";
    os: { name: string; version: string; build: string };
    model: string; cpu: string; ramGb: number; diskGb: number; freePct: number; secondDisk?: { gb: number; freePct: number };
    biosDate: string; purchasedYearsAgo: number | null; warrantyMonths: number | null;
    tpm: { present: boolean; version: string; enabled: boolean } | null; secureBoot: boolean | null;
    av: { name: string; state: "on" | "off" | "snoozed"; upToDate: boolean } | null; sigAge: number | null;
    firewall: { domain: boolean; private: boolean; public: boolean } | null; bitlocker: "on" | "off" | null;
    lastSeenHoursAgo: number | null; bootDaysAgo: number; pendingReboot: boolean; user: string;
    ip: string; gateway: string; agent: string;
    patches: "clean" | "few" | "many" | "never" | "overdue";
    software: number; alerts: number; sessions: number; tickets: number;
};

const DEVICES: DemoDevice[] = [
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

const SOFTWARE: Array<[string, string, string[]]> = [
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

const PATCH_CATALOG = [
    { title: "2024-11 Cumulative Update for Windows (KB5046613)", severity: "Critical", requiresReboot: true, kb: "5046613" },
    { title: "Security Intelligence Update for Microsoft Defender Antivirus (KB2267602)", severity: "Important", requiresReboot: false, kb: "2267602" },
    { title: "2024-11 .NET Framework Security Update (KB5045934)", severity: "Important", requiresReboot: true, kb: "5045934" },
    { title: "Windows Malicious Software Removal Tool (KB890830)", severity: "Moderate", requiresReboot: false, kb: "890830" },
    { title: "2024-10 Security Update for Adobe Flash Player (KB4577586)", severity: "Critical", requiresReboot: false, kb: "4577586" },
    { title: "Servicing Stack Update (KB5044033)", severity: "Important", requiresReboot: true, kb: "5044033" },
    { title: "2024-11 Cumulative Update Preview (KB5046714)", severity: null, requiresReboot: true, kb: "5046714" },
    { title: "Intel - System driver update (31.0.101.5333)", severity: null, requiresReboot: false, kb: "" },
];

const ALERTS: Array<[string, string, string]> = [
    ["WARN", "Disk space low", "Free space is under 15% on C:"], ["CRIT", "Disk space critical", "Free space is under 10% on C:"],
    ["WARN", "CPU high for 10 minutes", "CPU stayed above 90%"], ["CRIT", "Service stopped: Spooler", "The Print Spooler service is not running"],
    ["WARN", "Memory pressure", "Available memory under 10%"], ["CRIT", "Backup failed", "Last nightly backup did not complete"],
    ["WARN", "Pending restart for 14 days", "Updates are waiting for a restart"], ["WARN", "Antivirus definitions old", "Definitions are over 7 days old"],
];

const SCRIPTS = ["Clear temp files", "Restart print spooler", "Install Windows updates", "Collect system report", "Reset network adapter", "Flush DNS cache", "Check disk health", "Remove old profiles"];

const SUBJECTS = ["Printer will not print", "Slow computer", "Cannot connect to VPN", "Outlook keeps asking for password", "New starter setup", "Email not syncing on phone", "Blue screen after update", "Shared drive missing", "Request: extra monitor", "Wi-Fi drops in the afternoon", "Install Adobe Acrobat", "Scanner not working"];

/** Compares dotted version numbers part by part. */
const cmpVersion = (a: string, b: string) => {
    const x = a.match(/\d+/g)?.map(Number) ?? [];
    const y = b.match(/\d+/g)?.map(Number) ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Share of the time each demo device is online, so availability differs between them. */
const AVAILABILITY: Record<string, number> = { "HAR-FRONT-01": 0.995, "HAR-CHAIR-02": 0.97, "HAR-XRAY-03": 0.86, "HAR-SRV-01": 0.999, "HAR-LAPTOP-04": 0.72, "SUM-PARTNER-01": 0.99, "SUM-PARALEGAL-02": 0.95, "SUM-INTAKE-03": 0.98, "SUM-FILE-01": 0.998, "SUM-REMOTE-04": 0.7 };
/** How many percentage points of free space each device lost over the 60 days. */
const DISK_DRIFT: Record<string, number> = { "HAR-CHAIR-02": 17, "SUM-FILE-01": 9, "SUM-PARALEGAL-02": 6, "HAR-SRV-01": 4, "HAR-FRONT-01": -2 };
const HARDWARE_CHANGES: Record<string, Array<{ kind: string; summary: string }>> = {
    "HAR-CHAIR-02": [{ kind: "hardware", summary: "Memory changed from 4 GB to 8 GB" }, { kind: "os", summary: "Windows 10 Pro updated from 21H2 to 22H2" }],
    "SUM-FILE-01": [{ kind: "hardware", summary: "Drive D: size changed from 2000 GB to 4000 GB" }],
    "HAR-LAPTOP-04": [{ kind: "os", summary: "Windows 11 Pro updated from 22H2 to 23H2" }],
};
/** The risky-configuration facts newer agents send. The last Summit device has none, as if its agent were old. */
const RISK: Record<string, Record<string, any>> = {
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
const THREATS: Record<string, Array<[string, string, number, string, string, string]>> = {
    "HAR-XRAY-03": [["Trojan:Win32/Wacatac.B!ml", "severe", 2, "active", "No action", "C:\\Users\\xray\\Downloads\\invoice_scan.exe"], ["PUA:Win32/InstallCore", "moderate", 9, "failed", "Quarantined", "C:\\Users\\xray\\AppData\\Local\\Temp\\setup.exe"]],
    "HAR-CHAIR-02": [["PUA:Win32/Presenoker", "low", 14, "cleaned", "Cleaned", "C:\\Program Files\\Updater\\u.exe"]],
    "SUM-PARALEGAL-02": [["Trojan:Script/Phonzy.A!ml", "high", 5, "quarantined", "Quarantined", "C:\\Users\\paralegal\\Downloads\\contract.js"], ["Behavior:Win32/Hive.A", "moderate", 21, "removed", "Removed", "C:\\Users\\paralegal\\AppData\\Roaming\\x.dll"]],
    "SUM-FILE-01": [["Exploit:Script/Foosace.A", "high", 11, "cleaned", "Cleaned", "D:\\Shared\\Intake\\form.html"]],
};

const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(a: T[]): T => a[rnd(a.length)];

export type DemoStatus = { enabled: boolean; since: string | null; counts: { customers: number; sites: number; devices: number; tickets: number; sessions: number; assets: number } };

@Injectable()
export class DemoService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    async status(): Promise<DemoStatus> {
        const rows = await this.prisma.demo_records.groupBy({ by: ["table_name"], _count: { _all: true }, _min: { created_at: true } });
        const n = (t: string) => rows.find((r) => r.table_name === t)?._count._all ?? 0;
        const since = rows.map((r) => r._min.created_at).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
        return { enabled: n("devices") > 0, since: since?.toISOString() ?? null, counts: { customers: n("clients"), sites: n("sites"), devices: n("devices"), tickets: n("tickets"), sessions: n("audit_events"), assets: n("assets") } };
    }

    /** Creates the demo fleet. Does nothing if it is already on. */
    /** Policies are read against the data the demo adds and removes, so they must look again afterwards. */
    async enable(): Promise<DemoStatus> {
        try {
            return await this.doEnable();
        } finally {
            PoliciesService.invalidate();
        }
    }

    async disable(): Promise<DemoStatus> {
        try {
            return await this.doDisable();
        } finally {
            PoliciesService.invalidate();
        }
    }

    private async doEnable(): Promise<DemoStatus> {
        if ((await this.status()).enabled) return this.status();
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const taken = await this.prisma.clients.findFirst({ where: { organization_id: organizationId, name: { startsWith: DEMO_PREFIX } }, select: { id: true } });
        if (taken) throw new BadRequestException(`A customer whose name starts with "${DEMO_PREFIX}" already exists. Rename or remove it before turning demo data on.`);

        const track: Array<{ table_name: string; record_id: string }> = [];
        const mark = (table_name: string, record_id: string) => { track.push({ table_name, record_id }); return record_id; };
        const now = Date.now();
        // Devices that are up to date run the newest agent in the organisation, so the demo does not look behind.
        const versions = (await this.prisma.agents.findMany({ select: { version: true }, distinct: ["version"] })).map((a) => a.version);
        const newestAgent = [...versions, "1.3.26"].sort((a, b) => cmpVersion(b, a))[0];

        try {
            // Customers and sites.
            const customerNames = [`${DEMO_PREFIX}Harbor Dental`, `${DEMO_PREFIX}Summit Law`];
            const clientIds: string[] = [];
            for (const name of customerNames) {
                const id = crypto.randomUUID();
                await this.prisma.clients.create({ data: { id, organization_id: organizationId, name, external_ref: "demo", contact: { email: "demo@example.invalid" } } });
                clientIds.push(mark("clients", id));
            }
            const siteIds = new Map<string, string>();
            for (const d of DEVICES) {
                const key = `${d.customer}/${d.site}`;
                if (siteIds.has(key)) continue;
                const id = crypto.randomUUID();
                await this.prisma.sites.create({ data: { id, client_id: clientIds[d.customer], name: d.site } });
                siteIds.set(key, mark("sites", id));
            }

            // The first ticket number we may use.
            const last = await this.prisma.tickets.aggregate({ where: { organization_id: organizationId }, _max: { ticket_number: true } });
            let ticketNumber = Number(last._max.ticket_number ?? 1000n);

            for (const d of DEVICES) {
                const deviceId = crypto.randomUUID();
                const seen = d.lastSeenHoursAgo === null ? null : new Date(now - d.lastSeenHoursAgo * HOUR - rnd(120) * 1000);
                await this.prisma.devices.create({
                    data: {
                        id: deviceId, site_id: siteIds.get(`${d.customer}/${d.site}`)!, hostname: d.host, operating_system: d.os.name, architecture: "x64",
                        serial_number: `DEMO${crypto.randomBytes(4).toString("hex").toUpperCase()}`, primary_user: d.user || null, last_seen_at: seen,
                        status: seen && now - seen.getTime() < 5 * 60_000 ? "online" : "offline",
                    },
                });
                mark("devices", deviceId);

                const disks = [{ mount: "C:", fs: "NTFS", totalBytes: d.diskGb * GB, freeBytes: Math.round(d.diskGb * GB * d.freePct / 100) }];
                if (d.secondDisk) disks.push({ mount: "D:", fs: "NTFS", totalBytes: d.secondDisk.gb * GB, freeBytes: Math.round(d.secondDisk.gb * GB * d.secondDisk.freePct / 100) });
                const mac = Array.from({ length: 6 }, () => crypto.randomBytes(1).toString("hex")).join(":").toUpperCase();
                const facts = {
                    os: "windows", arch: "x64", primary_ip: d.ip, logged_in_user: d.user || null,
                    device: {
                        hardware: { model: d.model, cpu: d.cpu, ram: `${d.ramGb} GB`, ramBytes: d.ramGb * GB, gpu: [/AMD/.test(d.cpu) ? "AMD Radeon Graphics" : "Intel(R) UHD Graphics"], serial: `DEMO-${d.host}` },
                        disks,
                        os: { name: d.os.name, displayVersion: d.os.version, version: d.os.version, build: d.os.build.split(".")[0], buildRevision: d.os.build },
                        boot: { lastBootAt: new Date(now - d.bootDaysAgo * DAY).toISOString(), pendingReboot: d.pendingReboot, pendingRebootReasons: d.pendingReboot ? ["Windows Update"] : [] },
                        bios: { vendor: d.model.split(" ")[0], version: `${1 + rnd(3)}.${rnd(20)}.${rnd(9)}`, releaseDate: d.biosDate },
                        security: {
                            ...(d.av ? { antivirus: [{ name: d.av.name, state: d.av.state, upToDate: d.av.upToDate }] } : {}),
                            ...(d.sigAge !== null ? { defender: { realTimeProtection: d.av?.state === "on", signatureAgeDays: d.sigAge, antivirusEnabled: d.av?.name === "Windows Defender" } } : {}),
                            ...(d.firewall ? { firewall: d.firewall } : {}),
                            ...(d.bitlocker ? { bitLocker: [{ mount: "C:", protection: d.bitlocker, status: d.bitlocker === "on" ? "FullyEncrypted" : "FullyDecrypted" }] } : {}),
                            ...(d.tpm ? { tpm: d.tpm } : {}),
                            ...(d.secureBoot !== null ? { secureBoot: d.secureBoot } : {}),
                        },
                        ...(RISK[d.host] ? { risk: RISK[d.host] } : {}),
                        ...(d.host !== "SUM-REMOTE-04" ? { threats: { readAt: new Date(now).toISOString(), activeCount: (THREATS[d.host] ?? []).filter((t) => t[3] === "active").length, items: (THREATS[d.host] ?? []).map(([name, severity, daysAgo, status, action, resource]) => ({ name, severity, detectedAt: new Date(now - daysAgo * DAY - rnd(10) * HOUR).toISOString(), status, action, resource, user: d.user })) } } : {}),
                        network: [{ description: d.kind === "server" ? "Intel(R) Ethernet Server Adapter" : /Surface|XPS|Latitude|ThinkPad/.test(d.model) ? "Intel(R) Wi-Fi 6E AX211" : "Intel(R) Ethernet Connection", mac, ipv4: [d.ip], gateway: d.gateway }],
                    },
                };
                const agent = await this.prisma.agents.create({ data: { device_id: deviceId, agent_uuid: crypto.randomUUID(), version: d.agent === "1.3.26" ? newestAgent : d.agent, last_check_in_at: seen, facts, hostname: d.host }, select: { id: true } });

                // Software: a spread of programs, some with old versions.
                const chosen = [...SOFTWARE].sort(() => Math.random() - 0.5).slice(0, d.software);
                await this.prisma.agent_software.createMany({
                    data: chosen.map(([name, publisher, versions]) => ({ agent_id: agent.id, name, publisher, version: pick(versions), install_date: new Date(now - (20 + rnd(700)) * DAY) })),
                });

                // Patch scans over the last weeks, so patches show up, hang around and get installed. The newest scan
                // is what is missing now; older scans carry patches that were fixed since.
                if (d.patches !== "never") {
                    const finalCount = d.patches === "clean" ? 0 : d.patches === "few" ? 2 + rnd(2) : d.patches === "many" ? 5 + rnd(3) : 3;
                    const newestAge = d.patches === "overdue" ? 19 : rnd(3);
                    const scanAges = [newestAge + 28, newestAge + 21, newestAge + 14, newestAge + 7, newestAge];
                    const shuffled = [...PATCH_CATALOG].sort(() => Math.random() - 0.5);
                    const current = shuffled.slice(0, finalCount).map((p, i) => ({ id: `demo-${d.host}-${i}`, p, firstAge: 1 + rnd(newestAge + 28) }));
                    const fixed = shuffled.slice(finalCount, finalCount + 3).map((p, i) => { const firstAge = newestAge + 8 + rnd(21); return { id: `demo-${d.host}-r${i}`, p, firstAge, fixedAge: Math.max(newestAge + 1, firstAge - (3 + rnd(18))) }; });
                    for (const age of scanAges) {
                        const missing = [
                            ...current.filter((c) => c.firstAge >= age),
                            ...fixed.filter((f) => f.firstAge >= age && age > f.fixedAge),
                        ].map(({ id, p }) => ({ id, title: p.title, severity: p.severity, requiresReboot: p.requiresReboot, kbIds: p.kb ? [p.kb] : [] }));
                        await this.recordTask(agent.id, "patch_scan", new Date(now - age * DAY - rnd(20) * HOUR), { patches: missing });
                    }
                    if (d.patches !== "overdue" && d.patches !== "clean") {
                        // A past install shows in the patch activity report.
                        await this.recordTask(agent.id, "patch_install", new Date(now - (newestAge + 4 + rnd(10)) * DAY), { installed: ["KB5043080", "KB5044284"], requiresReboot: false });
                    }
                }

                // Availability and disk history for the last 60 days, and a few changes noticed along the way.
                {
                    const profile = AVAILABILITY[d.host] ?? 0.98;
                    const totalBytes = disks.reduce((s, x) => s + x.totalBytes, 0);
                    const nowFree = disks.reduce((s, x) => s + x.freeBytes, 0);
                    const drift = DISK_DRIFT[d.host] ?? 0; // percentage points the free space has fallen over the 60 days
                    const today = new Date(now);
                    const daily: Array<{ device_id: string; day: Date; samples: number; online_samples: number; disk_free_pct_min: number; disk_total_bytes: bigint; disk_free_bytes: bigint; business_samples: number; business_online_samples: number }> = [];
                    for (let age = 60; age >= 0; age--) {
                        const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - age * DAY);
                        const samples = age === 0 ? Math.max(1, today.getUTCHours() * 4) : 96;
                        const gone = d.host === "SUM-REMOTE-04" && age <= 16;
                        const wobble = Math.min(0.06, (1 - profile) * 0.8);
                        const share = gone ? 0 : Math.min(1, Math.max(0, profile + (Math.random() - 0.5) * wobble - (profile < 0.99 && rnd(20) === 0 ? 0.3 : 0)));
                        const pctNow = (nowFree / totalBytes) * 100;
                        const pct = Math.max(1, pctNow + (drift * age) / 60 + (Math.random() - 0.5) * 0.6);
                        // Working-day checks (weekdays, 8 to 6, so 40 a day): machines are on more during work than overall.
                        const weekday = day.getUTCDay() >= 1 && day.getUTCDay() <= 5;
                        const businessSamples = weekday ? (age === 0 ? Math.min(40, Math.max(0, (today.getUTCHours() - 8) * 4)) : 40) : 0;
                        const businessShare = gone ? 0 : Math.min(1, share + (1 - share) * 0.8);
                        daily.push({ device_id: deviceId, day, samples, online_samples: Math.round(samples * share), business_samples: businessSamples, business_online_samples: Math.round(businessSamples * businessShare), disk_free_pct_min: round1(pct), disk_total_bytes: BigInt(totalBytes), disk_free_bytes: BigInt(Math.round((totalBytes * pct) / 100)) });
                    }
                    await this.prisma.device_daily.createMany({ data: daily });

                    const changes: Array<{ device_id: string; changed_at: Date; kind: string; summary: string }> = [];
                    const at = () => new Date(now - (1 + rnd(40)) * DAY - rnd(20) * HOUR);
                    for (let i = 0; i < 3 + rnd(5); i++) {
                        const [name, , versions] = pick(SOFTWARE);
                        const roll = rnd(4);
                        if (roll === 0) changes.push({ device_id: deviceId, changed_at: at(), kind: "software_added", summary: `Installed ${name} ${pick(versions)}` });
                        else if (roll === 1) changes.push({ device_id: deviceId, changed_at: at(), kind: "software_removed", summary: `Removed ${name} ${pick(versions)}` });
                        else changes.push({ device_id: deviceId, changed_at: at(), kind: "software_updated", summary: `Updated ${name} from ${versions[0]} to ${versions[versions.length - 1]}` });
                    }
                    for (const extra of HARDWARE_CHANGES[d.host] ?? []) changes.push({ device_id: deviceId, changed_at: at(), kind: extra.kind, summary: extra.summary });
                    await this.prisma.device_changes.createMany({ data: changes });
                }

                // Alerts, some still open and some resolved, over the last month.
                for (let i = 0; i < d.alerts; i++) {
                    const [severity, title, detail] = pick(ALERTS);
                    const first = new Date(now - (1 + rnd(28)) * DAY - rnd(20) * HOUR);
                    const resolved = i % 3 === 0 ? null : new Date(first.getTime() + (1 + rnd(30)) * HOUR);
                    await this.prisma.alerts.create({
                        data: { device_id: deviceId, kind: "check", dedupe_key: `demo-${crypto.randomUUID()}`, state: resolved ? "RESOLVED" : "OPEN", severity, title, detail, first_seen_at: first, last_seen_at: resolved ?? new Date(now - rnd(6) * HOUR), state_changed_at: resolved ?? first, resolved_at: resolved, open_count: 1 + rnd(5) },
                    });
                }

                // Script runs over the last month, most working and some failing.
                for (let i = 0; i < 4 + rnd(6); i++) {
                    const name = pick(SCRIPTS);
                    const at = new Date(now - (1 + rnd(28)) * DAY - rnd(20) * HOUR);
                    const failed = rnd(6) === 0;
                    const timedOut = !failed && rnd(25) === 0;
                    const status = failed ? "failed" : timedOut ? "timeout" : "succeeded";
                    const job = await this.prisma.jobs.create({
                        data: { agent_id: agent.id, type: "script", payload: { script: name }, status, created_at: at, dispatched_at: at, started_at: at, finished_at: new Date(at.getTime() + (3 + rnd(90)) * 1000) },
                        select: { id: true },
                    });
                    await this.prisma.job_results.create({
                        data: { job_id: job.id, exit_code: failed ? 1 + rnd(3) : timedOut ? -1 : 0, stdout: failed ? "" : "Completed.", stderr: failed ? pick(["Access is denied.", "The term 'Get-Thing' is not recognized as a cmdlet", "Service did not respond within 30 seconds", "Could not find a part of the path"]) : timedOut ? "Timed out waiting for the script to finish" : "", duration_ms: BigInt((3 + rnd(90)) * 1000) },
                    });
                    await this.prisma.script_runs.create({ data: { script_name: name, job_id: job.id, device_id: deviceId, created_at: at } });
                }

                // Remote sessions by technicians.
                for (let i = 0; i < d.sessions; i++) {
                    const id = crypto.randomUUID();
                    await this.prisma.audit_events.create({
                        data: { id, actor_email: pick(["alex@demo.invalid", "sam@demo.invalid", "riley@demo.invalid"]), action: pick(["remote.console.start", "remote.shell.start", "remote.desktop.start"]), category: "remote", target_type: "device", target_id: deviceId, target_label: d.host, ip: `198.51.100.${1 + rnd(200)}`, outcome: i === 0 && d.alerts > 4 ? "denied" : "success", created_at: new Date(now - (1 + rnd(27)) * DAY - rnd(20) * HOUR) },
                    });
                    mark("audit_events", id);
                }

                // Tickets for the device.
                for (let i = 0; i < d.tickets; i++) {
                    const id = crypto.randomUUID();
                    const created = new Date(now - (3 + rnd(37)) * DAY);
                    const status = pick(["open", "in_progress", "resolved", "closed", "pending"] as const);
                    const finished = status === "resolved" || status === "closed";
                    await this.prisma.tickets.create({
                        data: {
                            id, organization_id: organizationId, ticket_number: BigInt(++ticketNumber), device_id: deviceId, subject: `${pick(SUBJECTS)} (${d.host})`,
                            description: "Demo ticket created with the sample data.", status, priority: pick(["low", "normal", "normal", "high", "urgent"] as const),
                            created_at: created, updated_at: created, closed_at: finished ? new Date(created.getTime() + (2 + rnd(70)) * HOUR) : null, due_at: new Date(created.getTime() + 2 * DAY),
                        },
                    });
                    mark("tickets", id);
                }

                // Asset record, with purchase and warranty dates.
                if (d.purchasedYearsAgo !== null) {
                    const id = crypto.randomUUID();
                    const purchased = new Date(now - d.purchasedYearsAgo * 365.25 * DAY);
                    const expires = d.warrantyMonths ? new Date(purchased.getTime() + d.warrantyMonths * 30.4375 * DAY) : null;
                    await this.prisma.assets.create({
                        data: { id, organization_id: organizationId, client_id: clientIds[d.customer], device_id: deviceId, name: d.host, kind: d.kind === "server" ? "server" : "workstation", manufacturer: d.model.split(" ")[0], model: d.model, serial_number: `DEMO-${d.host}`, purchase_date: purchased, expires_at: expires, source: "demo", details: {} },
                    });
                    mark("assets", id);
                }
            }

            // Two service contracts, one renewing soon.
            for (const [i, months] of [[0, 2], [1, 11]] as const) {
                const id = crypto.randomUUID();
                await this.prisma.contracts.create({
                    data: { id, organization_id: organizationId, client_id: clientIds[i], name: `${customerNames[i]} managed services`, kind: "recurring", status: "active", billing_interval_months: 1, start_date: new Date(now - (12 - months) * 30 * DAY), end_date: new Date(now + months * 30 * DAY), next_invoice_date: new Date(now + 10 * DAY), price_cents: 49900 + i * 30000, quantity: 5 },
                });
                mark("contracts", id);
            }

            // Software each demo customer must and must not have, and one rule for everyone.
            for (const [clientIndex, kind, pattern] of [[null, "banned", "Adobe Flash"], [null, "banned", "Java 8"], [0, "required", "Windows Defender"], [0, "required", "Dentrix"], [1, "required", "Clio Manage"], [1, "banned", "TeamViewer"]] as const) {
                const id = crypto.randomUUID();
                await this.prisma.software_policies.create({ data: { id, organization_id: organizationId, client_id: clientIndex === null ? null : clientIds[clientIndex], kind, pattern, note: "Demo policy" } });
                mark("software_policies", id);
            }

            await this.prisma.demo_records.createMany({ data: track, skipDuplicates: true });
        } catch (err) {
            // Never leave half a demo behind: remove whatever was created so far.
            await this.prisma.demo_records.createMany({ data: track, skipDuplicates: true }).catch(() => undefined);
            await this.disable().catch(() => undefined);
            throw err;
        }
        return this.status();
    }

    /** A finished agent task, so the patch reports see a scan or an install. */
    private async recordTask(agentId: string, type: "patch_scan" | "patch_install", at: Date, artifacts: Record<string, unknown>) {
        const task = await this.prisma.agent_tasks.create({ data: { agent_id: agentId, type, payload: {}, status: "succeeded", queued_at: at, started_at: at, completed_at: new Date(at.getTime() + 60_000), created_at: at } });
        const run = await this.prisma.agent_task_runs.create({ data: { task_id: task.id, status: "succeeded", started_at: at, finished_at: new Date(at.getTime() + 60_000), output: { ok: true }, created_at: at } });
        await this.prisma.agent_task_results.create({ data: { run_id: run.id, stdout: "", stderr: "", artifacts: artifacts as object, created_at: at } });
    }

    /** Deletes exactly what demo data created, and nothing else. */
    private async doDisable(): Promise<DemoStatus> {
        const records = await this.prisma.demo_records.findMany({ select: { table_name: true, record_id: true } });
        const ids = (table: string) => records.filter((r) => r.table_name === table).map((r) => r.record_id);
        await this.prisma.$transaction(async (tx) => {
            // Children first. Everything under a device (agent, software, tasks, alerts) goes with the device.
            await tx.tickets.deleteMany({ where: { id: { in: ids("tickets") } } });
            await tx.audit_events.deleteMany({ where: { id: { in: ids("audit_events") } } });
            await tx.assets.deleteMany({ where: { id: { in: ids("assets") } } });
            await tx.contracts.deleteMany({ where: { id: { in: ids("contracts") } } });
            await tx.software_policies.deleteMany({ where: { id: { in: ids("software_policies") } } });
            await tx.devices.deleteMany({ where: { id: { in: ids("devices") } } });
            await tx.sites.deleteMany({ where: { id: { in: ids("sites") } } });
            await tx.clients.deleteMany({ where: { id: { in: ids("clients") } } });
            await tx.demo_records.deleteMany({});
        }, { timeout: 60_000 });
        return this.status();
    }
}
