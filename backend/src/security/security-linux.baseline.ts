// backend/src/security/security-linux.baseline.ts
//
// The security BASELINE for LINUX devices: the same idea and the same scoring as the Windows baseline (security.baseline.ts), with
// rules that mean something on a server or a workstation running Linux. Pure functions of what a scan found, with no database, so
// every rule can be tested without a device. Scoring, grades and the cap for failed critical rules are the shared ones (scoreOutcomes).
//
// Rules here are about what an attacker uses on Linux: a firewall that is off, SSH that lets root in with a password, accounts with no
// password, services that should not face the network, an operating system that no longer gets fixes, and updates nobody installs.
// A malware scanner is a low-weight rule because plenty of well-run servers have none.
import { scoreOutcomes, type Evaluation, type Outcome, type RuleOutcome, type Severity } from "./security.baseline";
import type { LinuxProbeName, LinuxProbes, LinuxScanData } from "./security-linux.scripts";

export interface LinuxRuleDef {
    id: string;
    group: "Firewall" | "Encryption" | "Accounts" | "Network" | "System" | "Antivirus";
    title: string;
    severity: Severity;
    weight: number;
    checks: string;
    why: string;
    fix: string;
    uses: LinuxProbeName[];
    evaluate: (c: { p: LinuxProbes; now: Date }) => Outcome;
}

const pass = (detail: string): Outcome => ({ result: "pass", detail });
const fail = (detail: string): Outcome => ({ result: "fail", detail });
const unknown = (detail: string): Outcome => ({ result: "unknown", detail });
const na = (detail: string): Outcome => ({ result: "not_applicable", detail });
const reason = (p: LinuxProbes, name: LinuxProbeName) => (p[name].status === "unknown" ? (p[name] as { reason: string }).reason : "");
const cannot = (p: LinuxProbes, name: LinuxProbeName, what: string): Outcome => unknown(`${what} could not be read. ${reason(p, name)}`.trim());
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const agoText = (d: number) => (d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`);

const MAX_UPDATE_AGE_DAYS = 45;
const MAX_ADMINS = 3;
const MAX_DISK_PERCENT = 90;

/* ------------------------------ operating system support ------------------------------ */

// End of standard support of the releases people actually run. Dates are the end of free security fixes; paid extensions (Ubuntu Pro,
// RHEL ELS, Debian ELTS) are not counted. Checked against endoflife.date (which follows the vendors' lifecycle pages) on 2026-11-18;
// re-check when a new release ships. A release that is not listed is "unknown", never "ended".
type Support = { name: string; ends: string };
const SUPPORT: Record<string, Record<string, string>> = {
    ubuntu: { "18.04": "2023-05-31", "20.04": "2025-05-31", "22.04": "2027-06-01", "24.04": "2029-05-31", "25.04": "2026-01-17", "25.10": "2026-07-01", "26.04": "2031-05-29", "26.10": "2027-07-01" },
    debian: { "10": "2024-06-30", "11": "2026-08-31", "12": "2028-06-30", "13": "2030-06-30" },
    rhel: { "7": "2024-06-30", "8": "2029-05-31", "9": "2032-05-31", "10": "2035-05-31" },
    rocky: { "8": "2029-05-31", "9": "2032-05-31", "10": "2035-05-31" },
    almalinux: { "8": "2029-05-31", "9": "2032-05-31", "10": "2035-05-31" },
    centos: { "7": "2024-06-30", "8": "2021-12-31" },
    fedora: { "38": "2024-05-21", "39": "2024-11-26", "40": "2025-05-13", "41": "2025-12-15", "42": "2026-05-27", "43": "2026-12-01", "44": "2027-06-02", "45": "2027-12-08" },
    alpine: { "3.17": "2024-11-22", "3.18": "2025-05-09", "3.19": "2025-11-01", "3.20": "2026-04-01", "3.21": "2026-11-01", "3.22": "2027-05-01", "3.23": "2027-11-01", "3.24": "2028-06-01" },
    "opensuse-leap": { "15.4": "2023-12-07", "15.5": "2024-12-31", "15.6": "2026-04-30", "16.0": "2027-10-31" },
};
const FAMILY: Record<string, string> = { ol: "rhel", oraclelinux: "rhel", "rhel": "rhel", centos: "centos", rocky: "rocky", almalinux: "almalinux" };

export type LinuxOsSupport = { status: "supported" | "ending" | "ended" | "unknown"; name: string; endsOn: string | null; daysLeft: number | null };

export function linuxOsSupport(id: string, version: string, now: Date = new Date()): LinuxOsSupport {
    const key = FAMILY[id] ?? id;
    // RHEL-family versions are "9.3": the major version decides.
    // Alpine's VERSION_ID is "3.20.3": the release is "3.20".
    const v = ["rhel", "rocky", "almalinux", "centos"].includes(key) ? version.split(".")[0] : key === "alpine" ? version.split(".").slice(0, 2).join(".") : version;
    const ends = SUPPORT[key]?.[v];
    const name = [id, version].filter(Boolean).join(" ");
    if (!ends) return { status: "unknown", name, endsOn: null, daysLeft: null };
    const left = Math.floor((Date.parse(`${ends}T23:59:59Z`) - now.getTime()) / 86_400_000);
    return { status: left < 0 ? "ended" : left <= 90 ? "ending" : "supported", name, endsOn: ends, daysLeft: left };
}

/* ------------------------------ the rules ------------------------------ */

export const LINUX_RULES: LinuxRuleDef[] = [
    {
        id: "lx.fw.active", group: "Firewall", title: "A firewall is on", severity: "critical", weight: 8, uses: ["firewall"],
        checks: "ufw, firewalld, nftables or iptables has rules that filter incoming traffic.",
        why: "With no firewall, every service listening on the machine can be reached from the network it is on. A single forgotten database or admin page is then open to anyone who can reach it.",
        fix: "Turn on the firewall your distribution uses: sudo ufw enable (Ubuntu, Debian) or sudo systemctl enable --now firewalld (Red Hat family, SUSE), and allow only the ports you need (SSH first, so you do not lock yourself out). If the machine sits behind a cloud or network firewall by design, note that as an exception.",
        evaluate: ({ p }) => {
            if (p.firewall.status !== "ok") return cannot(p, "firewall", "The firewall state");
            return p.firewall.active ? pass(`${p.firewall.manager} is filtering incoming traffic.`) : fail("No firewall is filtering incoming traffic.");
        },
    },
    {
        id: "lx.ssh.rootlogin", group: "Network", title: "Root cannot log in over SSH with a password", severity: "high", weight: 7, uses: ["ssh"],
        checks: "The SSH server's PermitRootLogin is not 'yes'.",
        why: "Every machine on the internet is tried with the user name root and common passwords all day. Allowing root to log in with a password means one guess is all it takes.",
        fix: "Set PermitRootLogin prohibit-password (or no) in /etc/ssh/sshd_config, then sudo systemctl reload sshd. Log in as a normal user with a key and use sudo.",
        evaluate: ({ p }) => {
            if (p.ssh.status !== "ok") return cannot(p, "ssh", "The SSH settings");
            if (!p.ssh.installed) return na("There is no SSH server on this device.");
            if (!p.ssh.permitRootLogin) return unknown("The SSH server did not say whether root may log in.");
            return p.ssh.permitRootLogin === "yes" ? fail("PermitRootLogin is yes, so root can log in with a password.") : pass(`PermitRootLogin is ${p.ssh.permitRootLogin}.`);
        },
    },
    {
        id: "lx.ssh.emptypw", group: "Network", title: "SSH does not allow empty passwords", severity: "critical", weight: 8, uses: ["ssh"],
        checks: "The SSH server's PermitEmptyPasswords is not 'yes'.",
        why: "If an account has no password and SSH allows it, anyone who can reach the machine can log in as that account without knowing anything.",
        fix: "Set PermitEmptyPasswords no in /etc/ssh/sshd_config and reload sshd.",
        evaluate: ({ p }) => {
            if (p.ssh.status !== "ok") return cannot(p, "ssh", "The SSH settings");
            if (!p.ssh.installed) return na("There is no SSH server on this device.");
            if (p.ssh.emptyPasswords === null) return unknown("The SSH server did not say whether empty passwords are allowed.");
            return p.ssh.emptyPasswords ? fail("PermitEmptyPasswords is yes.") : pass("Empty passwords are not allowed over SSH.");
        },
    },
    {
        id: "lx.ssh.password", group: "Network", title: "SSH logins use keys, not passwords", severity: "medium", weight: 4, uses: ["ssh"],
        checks: "The SSH server's PasswordAuthentication is off.",
        why: "A password can be guessed or reused; a key cannot. Turning passwords off ends brute-force attacks on SSH.",
        fix: "Put your public keys in ~/.ssh/authorized_keys, then set PasswordAuthentication no in /etc/ssh/sshd_config and reload sshd. Keep one working session open while you test, so a mistake does not lock you out.",
        evaluate: ({ p }) => {
            if (p.ssh.status !== "ok") return cannot(p, "ssh", "The SSH settings");
            if (!p.ssh.installed) return na("There is no SSH server on this device.");
            if (p.ssh.passwordAuth === null) return unknown("The SSH server did not say whether passwords are allowed.");
            return p.ssh.passwordAuth ? fail("PasswordAuthentication is yes.") : pass("Passwords are not accepted over SSH.");
        },
    },
    {
        id: "lx.acct.emptypw", group: "Accounts", title: "No account has an empty password", severity: "critical", weight: 8, uses: ["accounts"],
        checks: "No account in /etc/shadow has an empty password field.",
        why: "An account with an empty password can be logged into by anyone, at the console and wherever the service allows it.",
        fix: "Give each listed account a password (sudo passwd <name>) or lock it (sudo passwd -l <name>).",
        evaluate: ({ p }) => {
            if (p.accounts.status !== "ok") return cannot(p, "accounts", "The accounts");
            const a = p.accounts.emptyPassword;
            if (a === null) return unknown("The password file could not be read.");
            return a.length ? fail(`${plural(a.length, "account")} with no password: ${a.slice(0, 5).join(", ")}${a.length > 5 ? ", ..." : ""}.`) : pass("Every account has a password or is locked.");
        },
    },
    {
        id: "lx.acct.uid0", group: "Accounts", title: "Only root has user id 0", severity: "high", weight: 6, uses: ["accounts"],
        checks: "No other account has user id 0 in /etc/passwd.",
        why: "Any account with user id 0 is root under another name. Attackers add one to keep access after they are found out.",
        fix: "Check why each listed account exists. If you did not create it, treat the machine as compromised. Otherwise remove it or give it a normal user id.",
        evaluate: ({ p }) => {
            if (p.accounts.status !== "ok") return cannot(p, "accounts", "The accounts");
            const a = p.accounts.extraRoot;
            return a.length ? fail(`${plural(a.length, "account")} besides root with user id 0: ${a.slice(0, 5).join(", ")}.`) : pass("Only root has user id 0.");
        },
    },
    {
        id: "lx.net.exposed", group: "Network", title: "No old remote-access service is listening", severity: "high", weight: 6, uses: ["exposure"],
        checks: "Telnet, FTP, rsh, rlogin, rexec and VNC are not listening for other machines.",
        why: "These services send passwords in clear text or have a long record of break-ins. Nothing needs them any more: SSH and SFTP replace them.",
        fix: "Stop and disable the service (sudo systemctl disable --now <service>), remove the package, and use SSH or SFTP instead. If VNC is needed, put it behind an SSH tunnel or a VPN.",
        evaluate: ({ p }) => {
            if (p.exposure.status !== "ok") return cannot(p, "exposure", "The listening services");
            const r = p.exposure.risky;
            return r.length ? fail(`Listening for other machines: ${r.join(", ")}.`) : pass("None of these services is listening for other machines.");
        },
    },
    {
        id: "lx.os.support", group: "System", title: "The operating system still gets security fixes", severity: "high", weight: 6, uses: ["os"],
        checks: "The release is within its vendor's standard support period.",
        why: "A release that is out of support gets no security fixes. Every new hole stays open for good.",
        fix: "Upgrade to a supported release (do-release-upgrade on Ubuntu, a new install or a distribution upgrade elsewhere), or buy the vendor's extended support if you cannot move yet.",
        evaluate: ({ p, now }) => {
            if (p.os.status !== "ok") return cannot(p, "os", "The operating system");
            const s = linuxOsSupport(p.os.id, p.os.version, now);
            if (s.status === "unknown") return unknown(`The support end date of ${p.os.name || s.name} is not known.`);
            if (s.status === "ended") return fail(`${p.os.name || s.name} stopped getting free security fixes on ${s.endsOn}.`);
            return pass(`${p.os.name || s.name} is supported until ${s.endsOn}${s.status === "ending" ? " (soon)" : ""}.`);
        },
    },
    {
        id: "lx.updates.recent", group: "System", title: `Packages were updated in the last ${MAX_UPDATE_AGE_DAYS} days`, severity: "medium", weight: 4, uses: ["updates"],
        checks: "The package manager's log shows activity within 45 days.",
        why: "Distributions ship security fixes every week. A machine that has installed nothing for months is missing known fixes.",
        fix: "Use the Patch tab to scan and install, or run the package manager's upgrade (apt upgrade, dnf upgrade, zypper patch). Turn on automatic security updates so it does not depend on someone remembering.",
        evaluate: ({ p }) => {
            if (p.updates.status !== "ok") return cannot(p, "updates", "The last package activity");
            const d = p.updates.ageDays;
            return d <= MAX_UPDATE_AGE_DAYS ? pass(`The package manager last did something ${agoText(d)}.`) : fail(`The package manager last did something ${d} days ago.`);
        },
    },
    {
        id: "lx.updates.auto", group: "System", title: "Automatic security updates are on", severity: "low", weight: 2, uses: ["autoUpdates"],
        checks: "unattended-upgrades or dnf-automatic is enabled.",
        why: "Security fixes that install themselves close the window between a fix being published and a person getting round to it. On servers that must not change unattended, a patch schedule in RemoteIQ does the same job.",
        fix: "On Ubuntu and Debian: sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades. On the Red Hat family: sudo dnf install dnf-automatic and enable dnf-automatic-install.timer. Or use a patch policy in RemoteIQ.",
        evaluate: ({ p }) => {
            if (p.autoUpdates.status !== "ok") return cannot(p, "autoUpdates", "Automatic updates");
            return p.autoUpdates.enabled ? pass(`Automatic updates are on (${p.autoUpdates.by}).`) : fail("Automatic security updates are not turned on.");
        },
    },
    {
        id: "lx.mac.enabled", group: "System", title: "SELinux or AppArmor is protecting the system", severity: "medium", weight: 3, uses: ["mac"],
        checks: "SELinux is enforcing or permissive, or AppArmor is loaded.",
        why: "These limit what a program can do even when it is taken over, so one flawed web server does not mean the whole machine is lost.",
        fix: "Ubuntu, Debian and SUSE ship AppArmor: sudo apt install apparmor (and enable it at boot). The Red Hat family ships SELinux: set SELINUX=enforcing in /etc/selinux/config and restart.",
        evaluate: ({ p }) => {
            if (p.mac.status !== "ok") return cannot(p, "mac", "SELinux and AppArmor");
            if (p.mac.kind === "none") return fail("Neither SELinux nor AppArmor is active.");
            return p.mac.mode === "Permissive" ? pass("SELinux is on but only logging (permissive).") : pass(`${p.mac.kind === "selinux" ? "SELinux is enforcing" : "AppArmor is loaded"}.`);
        },
    },
    {
        id: "lx.enc.root", group: "Encryption", title: "The system disk is encrypted", severity: "medium", weight: 3, uses: ["encryption"],
        checks: "The volume holding / sits on LUKS encryption (also found under LVM).",
        why: "An unencrypted disk can be read by anyone who takes the machine or a copy of its disk. This matters most for laptops and for machines in places other people can reach. A server in a locked rack or a cloud provider that encrypts its disks may not need it.",
        fix: "Encrypt at installation (LUKS), since an existing system disk cannot be encrypted in place easily. For cloud servers, turn on the provider's disk encryption.",
        evaluate: ({ p }) => {
            if (p.encryption.status !== "ok") return cannot(p, "encryption", "Disk encryption");
            const root = p.encryption.volumes.find((v) => v.mount === "/");
            if (!root || root.state === "unknown") return unknown("Whether the system disk is encrypted could not be told (a container, or a storage layout the scan does not know).");
            return root.state === "on" ? pass("The system disk is encrypted (LUKS).") : fail("The system disk is not encrypted.");
        },
    },
    {
        id: "lx.time.sync", group: "System", title: "The clock is kept in sync", severity: "low", weight: 2, uses: ["time"],
        checks: "systemd reports the clock as synchronised with a time server.",
        why: "A clock that drifts breaks logs, certificates, two-step login codes and the signatures RemoteIQ uses to trust jobs.",
        fix: "Turn on time sync: sudo timedatectl set-ntp true (and install systemd-timesyncd or chrony if neither is present).",
        evaluate: ({ p }) => {
            if (p.time.status !== "ok") return cannot(p, "time", "The clock state");
            return p.time.synchronized ? pass("The clock is synchronised.") : fail("The clock is not synchronised with a time server.");
        },
    },
    {
        id: "lx.disk.space", group: "System", title: `The system disk is less than ${MAX_DISK_PERCENT}% full`, severity: "medium", weight: 3, uses: ["disk"],
        checks: `The file system holding / is under ${MAX_DISK_PERCENT}% used.`,
        why: "A full disk stops logging, breaks updates and databases, and takes services down. Logs that cannot be written also hide an attack.",
        fix: "Find what is using the space (sudo du -xh / | sort -h | tail) and clear old logs, caches and unused packages (apt autoremove, journalctl --vacuum-size=200M), or add storage.",
        evaluate: ({ p }) => {
            if (p.disk.status !== "ok") return cannot(p, "disk", "The disk usage");
            const d = p.disk.rootUsedPercent;
            return d < MAX_DISK_PERCENT ? pass(`The system disk is ${d}% full.`) : fail(`The system disk is ${d}% full.`);
        },
    },
    {
        id: "lx.acct.admins", group: "Accounts", title: "Few accounts can use sudo", severity: "low", weight: 2, uses: ["accounts"],
        checks: `At most ${MAX_ADMINS} accounts (besides root) are in the sudo, wheel or admin group.`,
        why: "Every account that can use sudo is another account whose theft hands over the whole machine.",
        fix: "Remove people who do not need administrator rights from the group (sudo gpasswd -d <name> sudo, or wheel on the Red Hat family).",
        evaluate: ({ p }) => {
            if (p.accounts.status !== "ok") return cannot(p, "accounts", "The administrators");
            const a = p.accounts.admins;
            const who = a.slice(0, 6).join(", ");
            return a.length <= MAX_ADMINS ? pass(`${plural(a.length, "account")} can use sudo${who ? `: ${who}` : ""}.`) : fail(`${plural(a.length, "account")} can use sudo: ${who}${a.length > 6 ? ", ..." : ""}.`);
        },
    },
    {
        id: "lx.reboot.pending", group: "System", title: "No restart is waiting", severity: "low", weight: 2, uses: ["reboot"],
        checks: "The system is not waiting for a restart (a new kernel or core library was installed).",
        why: "Updates that need a restart are not protecting the machine until it has restarted.",
        fix: "Restart the machine when it suits the users (the Patch tab can do it).",
        evaluate: ({ p }) => {
            if (p.reboot.status !== "ok") return cannot(p, "reboot", "The restart flag");
            return p.reboot.pending ? fail("A restart is waiting.") : pass("No restart is waiting.");
        },
    },
    {
        id: "lx.av.present", group: "Antivirus", title: "A malware scanner is installed and current", severity: "low", weight: 1, uses: ["antivirus"],
        checks: "ClamAV (with signatures less than a week old) or another endpoint protection product is installed and running.",
        why: "Plenty of well-run Linux servers have none, so this counts for very little. It matters most on a machine that handles files from other people (mail, file shares, upload forms).",
        fix: "Use Install ClamAV on this device's Security tab (it also keeps the definitions updating), or install your company's endpoint product.",
        evaluate: ({ p }) => {
            if (p.antivirus.status !== "ok") return cannot(p, "antivirus", "The malware scanner");
            const a = p.antivirus.products;
            return a.length ? pass(`${a.join(", ")} is in place.`) : fail("No malware scanner is installed and current.");
        },
    },
    {
        id: "lx.boot.secureboot", group: "System", title: "Secure Boot is on", severity: "low", weight: 1, uses: ["boot"],
        checks: "The machine starts in UEFI mode with Secure Boot enabled.",
        why: "Secure Boot stops software that is not signed from loading before the operating system, which blocks a class of attacks that survive reinstalling.",
        fix: "Turn Secure Boot on in the firmware settings (the distribution's kernel is signed). Virtual machines and older hardware may not have it.",
        evaluate: ({ p }) => {
            if (p.boot.status !== "ok") return cannot(p, "boot", "The firmware mode");
            if (!p.boot.uefi) return na("This machine does not start in UEFI mode, so Secure Boot does not apply.");
            if (p.boot.secureBoot === null) return unknown("Whether Secure Boot is on could not be read.");
            return p.boot.secureBoot ? pass("Secure Boot is on.") : fail("Secure Boot is off.");
        },
    },
];

export const LINUX_RULE_BY_ID = new Map(LINUX_RULES.map((r) => [r.id, r]));

/** Runs every rule on a Linux scan. A rule that throws is reported as unknown, so one bug never loses the whole result. */
export function evaluateLinuxScan(scan: LinuxScanData, now: Date = new Date()): Evaluation {
    const rules = LINUX_RULES.map((r) => {
        let o: Outcome;
        try { o = r.evaluate({ p: scan.probes, now }); } catch { o = unknown("This check could not be worked out."); }
        return { id: r.id, result: o.result, detail: o.detail, title: r.title, group: r.group, severity: r.severity, weight: r.weight };
    });
    return { ...scoreOutcomes(rules as RuleOutcome[], LINUX_RULE_BY_ID), rules };
}

/* ------------------------------ highlights ------------------------------ */

export type Tone = "good" | "warn" | "bad" | "unknown";
export type Label = { text: string; tone: Tone };

export function linuxFirewallLabel(p: LinuxProbes): Label {
    if (p.firewall.status !== "ok") return { text: "Not read", tone: "unknown" };
    return p.firewall.active ? { text: `On (${p.firewall.manager})`, tone: "good" } : { text: "Off", tone: "bad" };
}

export function linuxEncryptionLabel(p: LinuxProbes): Label {
    if (p.encryption.status !== "ok") return { text: "Not read", tone: "unknown" };
    const known = p.encryption.volumes.filter((v) => v.state !== "unknown");
    if (!known.length) return { text: "Not known", tone: "unknown" };
    const on = known.filter((v) => v.state === "on").length;
    const root = known.find((v) => v.mount === "/");
    if (on === known.length) return { text: known.length === 1 ? "On" : `On for all ${known.length} volumes`, tone: "good" };
    if (root && root.state === "off") return { text: on ? `System disk off, ${on} of ${known.length} volumes on` : "Off", tone: "bad" };
    return { text: `${on} of ${known.length} volumes on`, tone: "warn" };
}

export function linuxAntivirusLabel(p: LinuxProbes): Label {
    if (p.antivirus.status !== "ok") return { text: "Not read", tone: "unknown" };
    return p.antivirus.products.length ? { text: p.antivirus.products.join(", "), tone: "good" } : { text: "No scanner running", tone: "unknown" };
}

/** Everything the Security tab shows for a Linux device besides the rules. */
export function linuxHighlights(p: LinuxProbes, now: Date = new Date()) {
    const ok = <K extends LinuxProbeName>(k: K) => (p[k].status === "ok" ? (p[k] as Extract<LinuxProbes[K], { status: "ok" }>) : null);
    const os = ok("os");
    const ssh = ok("ssh");
    const accounts = ok("accounts");
    const boot = ok("boot");
    return {
        platform: "linux" as const,
        antivirus: { label: linuxAntivirusLabel(p), products: ok("antivirus")?.products ?? [], reason: p.antivirus.status === "unknown" ? p.antivirus.reason : null },
        encryption: { label: linuxEncryptionLabel(p), volumes: ok("encryption")?.volumes ?? [], note: p.encryption.status === "unknown" ? p.encryption.reason : null },
        firewall: { label: linuxFirewallLabel(p), manager: ok("firewall")?.manager ?? null },
        ssh: ssh ? { installed: ssh.installed, running: ssh.running, permitRootLogin: ssh.permitRootLogin || null, passwordAuth: ssh.passwordAuth, port: ssh.port } : null,
        accounts: accounts ? { admins: accounts.admins, adminCount: accounts.admins.length, emptyPassword: accounts.emptyPassword, extraRoot: accounts.extraRoot } : null,
        os: os ? { name: os.name, id: os.id, version: os.version, kernel: os.kernel, support: linuxOsSupport(os.id, os.version, now) } : null,
        mac: ok("mac") ? { kind: ok("mac")!.kind, mode: ok("mac")!.mode } : null,
        secureBoot: boot && boot.uefi ? boot.secureBoot : null,
        tpm: boot ? boot.tpm : null,
        restartPending: ok("reboot")?.pending ?? null,
        lastUpdate: ok("updates") ? { ageDays: ok("updates")!.ageDays } : null,
        autoUpdates: ok("autoUpdates") ? { enabled: ok("autoUpdates")!.enabled, by: ok("autoUpdates")!.by } : null,
        diskUsedPercent: ok("disk")?.rootUsedPercent ?? null,
        unreadable: (Object.keys(p) as LinuxProbeName[]).flatMap((k) => (p[k].status === "unknown" ? [{ probe: k as string, reason: (p[k] as { reason: string }).reason }] : [])),
    };
}
