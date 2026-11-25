// backend/src/security/security.baseline.ts
//
// The security BASELINE (roadmap 8.5): a fixed list of rules, each with a weight, a severity, plain-language "why it matters" and
// "how to fix" text, and a function that turns what a scan found into pass, fail, unknown or not applicable. Pure functions with no
// database, so every rule and the scoring can be tested without a device.
//
// Scoring: the score is the weighted share of PASSED rules among the rules that apply and could be read (pass + fail). A rule that
// could not be read ("unknown") counts as neither, and one that does not apply to the device is left out. The grade comes from the
// score (A 90+, B 80+, C 70+, D 60+, F below), and a failed CRITICAL rule caps it: one critical failure means no better than D
// (score at most 69), two or more mean F (at most 59). So a PC with no antivirus cannot look healthy because it does everything else
// right. The score shown is the capped one; the uncapped score is kept so the page can explain the cap.
import {
    decodeProductState, isDefenderName, osSupport, type DefenderData, type ProbeName, type Probes, type ScanData,
} from "./security.scripts";

export type Severity = "critical" | "high" | "medium" | "low";
export type RuleResult = "pass" | "fail" | "unknown" | "not_applicable";
export type Grade = "A" | "B" | "C" | "D" | "F";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export type Outcome = { result: RuleResult; detail: string };
type Ctx = { p: Probes; now: Date };

export interface RuleDef {
    id: string;
    group: "Antivirus" | "Firewall" | "Encryption" | "Accounts" | "Network" | "System";
    title: string;
    severity: Severity;
    weight: number;
    /** What it looks at, in one sentence. */
    checks: string;
    why: string;
    fix: string;
    /** The scan probes it needs (for "could not be read" explanations). */
    uses: ProbeName[];
    evaluate: (c: Ctx) => Outcome;
}

const pass = (detail: string): Outcome => ({ result: "pass", detail });
const fail = (detail: string): Outcome => ({ result: "fail", detail });
const unknown = (detail: string): Outcome => ({ result: "unknown", detail });
const na = (detail: string): Outcome => ({ result: "not_applicable", detail });

/** The reason a probe could not be read, for the rule that needed it. */
function why(p: Probes, name: ProbeName): string {
    const x = p[name];
    return x.status === "unknown" ? x.reason : "";
}
const cannot = (p: Probes, name: ProbeName, what: string): Outcome => unknown(`${what} could not be read. ${why(p, name)}`.trim());

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const agoText = (d: number) => (d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`);

/* ------------------------------ antivirus picture ------------------------------ */

export type AvPicture = {
    /** The Defender probe, when it was read. */
    defender: DefenderData | null;
    /** Defender is the product in charge: its antivirus is on and it is not in passive mode. */
    defenderActive: boolean;
    defenderPassive: boolean;
    /** Products other than Defender registered in Windows Security Center. */
    others: { name: string; state: ReturnType<typeof decodeProductState>["state"]; upToDate: boolean | null }[];
    othersOn: { name: string; upToDate: boolean | null }[];
    /** At least one of the two sources was read. */
    known: boolean;
    securityCenterRead: boolean;
};

export function avPicture(p: Probes): AvPicture {
    const d = p.defender.status === "ok" ? p.defender : null;
    const passive = !!d && /passive/i.test(d.runningMode);
    const sc = p.securityCenter.status === "ok" ? p.securityCenter : null;
    const others = (sc?.products ?? []).filter((x) => !isDefenderName(x.name)).map((x) => ({ name: x.name, ...decodeProductState(x.state) }));
    return {
        defender: d,
        defenderActive: !!d && d.antivirusEnabled && !passive,
        defenderPassive: passive,
        others,
        othersOn: others.filter((o) => o.state === "on").map((o) => ({ name: o.name, upToDate: o.upToDate })),
        known: !!d || !!sc,
        securityCenterRead: !!sc,
    };
}

const MAX_SIGNATURE_AGE_DAYS = 3;
const MAX_SCAN_AGE_DAYS = 14;
const MAX_UPDATE_AGE_DAYS = 60;
const MAX_IDLE_LOCK_SECS = 900;

const FIREWALL_PROFILES = [["domain", "Domain"], ["private", "Private"], ["public", "Public"]] as const;

function firewallStates(p: Probes) {
    if (p.firewall.status !== "ok") return null;
    const f = p.firewall;
    return FIREWALL_PROFILES.map(([k, label]) => ({ label, on: f[k] })).filter((x) => x.on !== null) as { label: string; on: boolean }[];
}

function systemVolume(p: Probes) {
    if (p.bitlocker.status !== "ok") return null;
    const b = p.bitlocker;
    const drive = b.systemDrive || "C:";
    return { b, vol: b.volumes.find((v) => v.drive === drive), drive };
}

/* ------------------------------ the rules ------------------------------ */

export const RULES: RuleDef[] = [
    {
        id: "av.present", group: "Antivirus", title: "Antivirus protection is on", severity: "critical", weight: 10, uses: ["defender", "securityCenter"],
        checks: "Microsoft Defender, or another antivirus registered in Windows Security Center, is turned on.",
        why: "A PC with no antivirus running is open to ordinary malware, ransomware and drive-by downloads. This is the single most important protection on a PC.",
        fix: "Turn on Microsoft Defender Antivirus in Windows Security, or install and activate the antivirus product your company uses. If another product expired, renew or remove it so Defender takes over.",
        evaluate: ({ p }) => {
            const a = avPicture(p);
            if (!a.known) return cannot(p, "defender", "The antivirus state");
            if (a.defenderActive) return pass("Microsoft Defender is on.");
            if (a.othersOn.length) return pass(`${a.othersOn[0].name} is on.`);
            if (a.defenderPassive && !a.others.length) return pass("Microsoft Defender is in passive mode, which means another security product is in charge.");
            const listed = a.others.length ? ` Windows Security Center lists ${a.others.map((o) => `${o.name} (${o.state})`).join(", ")}.` : "";
            return fail(`No antivirus is turned on.${listed}`);
        },
    },
    {
        id: "av.realtime", group: "Antivirus", title: "Real-time protection is on", severity: "critical", weight: 8, uses: ["defender", "securityCenter"],
        checks: "Microsoft Defender scans files as they are opened and downloaded (or another registered antivirus is on).",
        why: "Without real-time protection, malware is only found when a scan happens to run, which can be days after it arrives.",
        fix: "Open Windows Security > Virus & threat protection > Manage settings and turn Real-time protection on. If a policy turned it off, change that policy.",
        evaluate: ({ p }) => {
            const a = avPicture(p);
            if (a.defenderActive) return a.defender!.realTimeProtection ? pass("Microsoft Defender real-time protection is on.") : fail("Microsoft Defender real-time protection is off.");
            if (a.othersOn.length) return pass(`Protection is provided by ${a.othersOn[0].name}, which Windows reports as on.`);
            if (a.defenderPassive) return na("Microsoft Defender is in passive mode; another product is in charge.");
            if (a.defender) return fail("Microsoft Defender is not protecting this PC and no other antivirus is on.");
            return cannot(p, "defender", "The real-time protection state");
        },
    },
    {
        id: "av.threats", group: "Antivirus", title: "No active threats", severity: "critical", weight: 8, uses: ["defender"],
        checks: "Microsoft Defender lists no threat that is still active on the PC.",
        why: "An active threat means malware, a hacking tool or unwanted software was found and has not been removed.",
        fix: "Open Windows Security > Virus & threat protection > Protection history, review each threat and choose Remove or Quarantine, then run a full scan. If you do not recognise the program, treat the PC as compromised.",
        evaluate: ({ p }) => {
            if (p.defender.status !== "ok") return cannot(p, "defender", "The threat list");
            const d = p.defender;
            if (d.threatsUnknown) return unknown("Microsoft Defender's threat list could not be read.");
            if (d.threatCount === 0) return pass("Microsoft Defender reports no active threats.");
            const names = d.threats.slice(0, 3).join(", ");
            return fail(`${plural(d.threatCount, "active threat")}${names ? `: ${names}${d.threatCount > 3 ? ", ..." : ""}` : ""}.`);
        },
    },
    {
        id: "fw.some", group: "Firewall", title: "Windows Firewall is on", severity: "critical", weight: 6, uses: ["firewall"],
        checks: "Windows Firewall is on for at least one network type (domain, private, public).",
        why: "With the firewall off on every network type, every service on the PC is reachable from the network it is on. A PC that has a different firewall product in charge may show this as failed.",
        fix: "Open Windows Security > Firewall & network protection and turn the firewall on for each network, or set it with a Group Policy or an Intune profile. If another firewall product is deliberately in charge, note it as an exception.",
        evaluate: ({ p }) => {
            const s = firewallStates(p);
            if (!s) return cannot(p, "firewall", "The firewall state");
            return s.some((x) => x.on) ? pass(`On for: ${s.filter((x) => x.on).map((x) => x.label).join(", ")}.`) : fail("The firewall is off for every network type.");
        },
    },
    {
        id: "av.signatures", group: "Antivirus", title: "Virus definitions are up to date", severity: "high", weight: 6, uses: ["defender", "securityCenter"],
        checks: `Microsoft Defender's definitions are at most ${MAX_SIGNATURE_AGE_DAYS} days old (or the other antivirus says its own are current).`,
        why: "Antivirus finds only the malware it knows about. Old definitions miss recent threats.",
        fix: "Use Update signatures on this tab, or open Windows Security > Virus & threat protection > Protection updates. If it keeps failing, check that the PC can reach Microsoft's update servers and that Windows Update is not blocked.",
        evaluate: ({ p }) => {
            const a = avPicture(p);
            if (!a.known) return cannot(p, "defender", "The definitions age");
            if (a.defenderActive) {
                const age = a.defender!.signatureAgeDays;
                if (age === null) return unknown("Microsoft Defender did not say when its definitions were updated.");
                return age <= MAX_SIGNATURE_AGE_DAYS ? pass(`Definitions updated ${agoText(age)} (${a.defender!.signatureVersion}).`) : fail(`Definitions are ${age} days old (${a.defender!.signatureVersion}).`);
            }
            if (a.othersOn.length) {
                const o = a.othersOn[0];
                if (o.upToDate === null) return unknown(`${o.name} did not say whether its definitions are current.`);
                return o.upToDate ? pass(`${o.name} reports its definitions as up to date.`) : fail(`${o.name} reports its definitions as out of date.`);
            }
            return na("No antivirus is in charge, which is reported separately.");
        },
    },
    {
        id: "fw.all", group: "Firewall", title: "Firewall is on for every network type", severity: "high", weight: 6, uses: ["firewall"],
        checks: "Windows Firewall is on for the domain, private and public profiles.",
        why: "A PC moves between networks. A profile that is off protects nothing the day the laptop joins that kind of network, such as a hotel or cafe Wi-Fi (the public profile).",
        fix: "Turn the firewall on for the listed profiles in Windows Security > Firewall & network protection, or fix the policy that turns it off.",
        evaluate: ({ p }) => {
            const s = firewallStates(p);
            if (!s) return cannot(p, "firewall", "The firewall state");
            const off = s.filter((x) => !x.on);
            return off.length ? fail(`Off for: ${off.map((x) => x.label).join(", ")}.`) : pass(`On for: ${s.map((x) => x.label).join(", ")}.`);
        },
    },
    {
        id: "uac.on", group: "System", title: "User Account Control is on", severity: "high", weight: 6, uses: ["uac"],
        checks: "User Account Control (EnableLUA) is enabled.",
        why: "UAC is what stops a program you opened from quietly changing the whole system. With it off, any malware you run has full control at once.",
        fix: "Set the policy 'User Account Control: Run all administrators in Admin Approval Mode' to Enabled (or set EnableLUA to 1 under HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System) and restart the PC.",
        evaluate: ({ p }) => (p.uac.status !== "ok" ? cannot(p, "uac", "The UAC setting") : p.uac.enabled ? pass("User Account Control is on.") : fail("User Account Control is turned off.")),
    },
    {
        id: "bl.system", group: "Encryption", title: "The system drive is encrypted (BitLocker)", severity: "high", weight: 8, uses: ["bitlocker"],
        checks: "BitLocker protection is on for the drive Windows is installed on.",
        why: "If a laptop or PC is lost or stolen, an unencrypted drive can be read by anyone, including saved passwords, mail and customer files.",
        fix: "Turn on BitLocker (or Device encryption on Windows Home): Settings > Privacy & security > Device encryption, or Control Panel > BitLocker Drive Encryption. Make sure the recovery key is saved in your company's records.",
        evaluate: ({ p }) => {
            const s = systemVolume(p);
            if (!s) return cannot(p, "bitlocker", "The BitLocker state");
            if (!s.vol) return unknown(`BitLocker did not report the system drive (${s.drive}).`);
            const v = s.vol;
            if (v.protection === "on") return pass(`BitLocker is on for ${v.drive}${v.method && v.method !== "None" ? ` (${v.method})` : ""}${v.state === "Encrypting" && v.percent !== null ? `, still encrypting: ${v.percent}%` : ""}.`);
            if (v.protection === "off") return fail(`BitLocker is off for ${v.drive}${v.state === "Encrypting" ? " (encryption started but protection is not on yet)" : ""}.`);
            return unknown(`BitLocker's state for ${v.drive} is not known.`);
        },
    },
    {
        id: "logon.auto", group: "Accounts", title: "Windows does not sign in on its own", severity: "high", weight: 5, uses: ["autoLogon"],
        checks: "Automatic sign-in (Winlogon AutoAdminLogon) is not configured. Only whether it is on is read, never the stored password.",
        why: "With automatic sign-in, anyone who turns the PC on is signed in as that user, and the password is kept on the PC.",
        fix: "Turn it off: run netplwiz and tick 'Users must enter a user name and password', or set AutoAdminLogon to 0 and remove DefaultPassword under HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon. Kiosks and signage PCs that need it should be recorded as exceptions.",
        evaluate: ({ p }) => (p.autoLogon.status !== "ok" ? cannot(p, "autoLogon", "The automatic sign-in setting") : p.autoLogon.enabled ? fail(`Automatic sign-in is on${p.autoLogon.user ? ` for ${p.autoLogon.user}` : ""}.`) : pass("Automatic sign-in is not configured.")),
    },
    {
        id: "smb1.off", group: "Network", title: "SMBv1 is off", severity: "high", weight: 5, uses: ["smb1"],
        checks: "The old SMB version 1 file-sharing protocol is disabled on the PC's file-sharing service.",
        why: "SMBv1 has no modern protections and was used by the WannaCry and NotPetya worms to spread between PCs.",
        fix: "Run, as administrator: Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol (and Set-SmbServerConfiguration -EnableSMB1Protocol $false), then restart. Replace any old device that still needs SMBv1.",
        evaluate: ({ p }) => (p.smb1.status !== "ok" ? cannot(p, "smb1", "The SMBv1 setting") : p.smb1.enabled ? fail("SMBv1 is enabled.") : pass("SMBv1 is disabled.")),
    },
    {
        id: "rdp.nla", group: "Network", title: "Remote Desktop is off, or needs Network Level Authentication", severity: "high", weight: 5, uses: ["rdp"],
        checks: "If Remote Desktop is turned on, it requires Network Level Authentication (NLA).",
        why: "Remote Desktop is a favourite way in for attackers. NLA makes a person prove who they are before a session starts, which blocks several attacks and brute-force noise.",
        fix: "Turn Remote Desktop off if it is not used (Settings > System > Remote Desktop). If it is needed, tick 'Require devices to use Network Level Authentication' there, and do not expose it to the internet.",
        evaluate: ({ p }) => {
            if (p.rdp.status !== "ok") return cannot(p, "rdp", "The Remote Desktop setting");
            if (!p.rdp.enabled) return pass("Remote Desktop is off.");
            if (p.rdp.nlaRequired === null) return unknown("Remote Desktop is on and the NLA setting could not be read.");
            return p.rdp.nlaRequired ? pass("Remote Desktop is on and requires NLA.") : fail("Remote Desktop is on and does not require NLA.");
        },
    },
    {
        id: "os.supported", group: "System", title: "Windows version is still supported", severity: "high", weight: 8, uses: ["os"],
        checks: "The Windows build still receives security updates from Microsoft (from a table of end-of-support dates kept on the server).",
        why: "A version that is out of support gets no security fixes. Every new flaw found stays open for good.",
        fix: "Upgrade to a supported version of Windows (for example Windows 11 25H2), or, if the PC cannot, replace it. Paid Extended Security Updates, if you have them, are not taken into account here.",
        evaluate: ({ p, now }) => {
            if (p.os.status !== "ok") return cannot(p, "os", "The Windows version");
            const s = osSupport(p.os, now);
            if (s.status === "unknown") return unknown(`${s.name} (build ${p.os.build}) is not in the table of support dates.`);
            if (s.status === "ended") return fail(`${s.name} reached end of support on ${s.endsOn}.`);
            if (s.status === "ending") return pass(`${s.name}: support ends on ${s.endsOn} (in ${plural(Math.max(s.daysLeft ?? 0, 0), "day")}).`);
            return pass(`${s.name}: supported until ${s.endsOn}.`);
        },
    },
    {
        id: "av.tamper", group: "Antivirus", title: "Tamper protection is on", severity: "medium", weight: 3, uses: ["defender"],
        checks: "Microsoft Defender's Tamper Protection is on, so its settings cannot be changed by malware.",
        why: "Without Tamper Protection, malware (or a person who has gained administrator rights) can simply switch Defender off.",
        fix: "Open Windows Security > Virus & threat protection > Manage settings > Tamper Protection and turn it on. In a managed company it is usually set in Microsoft Intune or Defender for Endpoint.",
        evaluate: ({ p }) => {
            const a = avPicture(p);
            if (a.defenderActive) return a.defender!.tamperProtected ? pass("Tamper Protection is on.") : fail("Tamper Protection is off.");
            if (a.defender || a.securityCenterRead) return na("Microsoft Defender is not the product in charge.");
            return cannot(p, "defender", "The Tamper Protection state");
        },
    },
    {
        id: "uac.prompt", group: "System", title: "Administrators are asked before a program gets higher rights", severity: "medium", weight: 2, uses: ["uac"],
        checks: "The elevation prompt for administrators is not set to 'Elevate without prompting'.",
        why: "If administrators are never asked, programs they run gain full rights silently.",
        fix: "Set the policy 'User Account Control: Behavior of the elevation prompt for administrators in Admin Approval Mode' to 'Prompt for consent on the secure desktop'.",
        evaluate: ({ p }) => {
            if (p.uac.status !== "ok") return cannot(p, "uac", "The UAC prompt setting");
            if (!p.uac.enabled) return na("User Account Control is off, which is reported separately.");
            if (p.uac.adminPrompt === null) return unknown("The elevation prompt setting is not set explicitly, so Windows uses its default.");
            return p.uac.adminPrompt === 0 ? fail("Administrators are elevated without being asked.") : pass("Administrators are asked before a program is elevated.");
        },
    },
    {
        id: "bl.data", group: "Encryption", title: "Other fixed drives are encrypted", severity: "medium", weight: 3, uses: ["bitlocker"],
        checks: "BitLocker protection is on for every fixed drive except the system drive.",
        why: "Data drives hold the same kind of files as the system drive and are just as readable if the PC is stolen.",
        fix: "Right-click the drive in File Explorer > Turn on BitLocker, or use manage-bde -on D: from an elevated prompt. Keep the recovery key in your company's records.",
        evaluate: ({ p }) => {
            const s = systemVolume(p);
            if (!s) return cannot(p, "bitlocker", "The BitLocker state");
            const others = s.b.volumes.filter((v) => v.drive !== s.drive);
            if (!others.length) return na("The PC has no other fixed drive.");
            const off = others.filter((v) => v.protection === "off");
            if (off.length) return fail(`BitLocker is off for ${off.map((v) => v.drive).join(", ")}.`);
            if (others.some((v) => v.protection === "unknown")) return unknown("BitLocker's state for another drive is not known.");
            return pass(`BitLocker is on for ${others.map((v) => v.drive).join(", ")}.`);
        },
    },
    {
        id: "bl.recovery", group: "Encryption", title: "The encrypted system drive has a recovery key", severity: "medium", weight: 2, uses: ["bitlocker"],
        checks: "BitLocker has a recovery password protector on the system drive. Only the type of protector is read, never the key itself.",
        why: "Without a recovery key, a BitLocker drive can become unreadable after a hardware change or a firmware update, and the data is lost.",
        fix: "Add a recovery key: manage-bde -protectors -add C: -RecoveryPassword, and save it somewhere safe (your directory, your IT documentation, or the Microsoft account).",
        evaluate: ({ p }) => {
            const s = systemVolume(p);
            if (!s) return cannot(p, "bitlocker", "The BitLocker state");
            if (!s.vol || s.vol.protection !== "on") return na("The system drive is not protected by BitLocker, which is reported separately.");
            if (!s.b.detail) return unknown(`The key protectors could not be read. ${s.b.note ?? ""}`.trim());
            return s.vol.protectors.includes("RecoveryPassword") ? pass(`Protectors: ${s.vol.protectors.join(", ")}.`) : fail(`There is no recovery password protector (protectors: ${s.vol.protectors.join(", ") || "none"}).`);
        },
    },
    {
        id: "boot.secure", group: "System", title: "Secure Boot is on", severity: "medium", weight: 4, uses: ["secureBoot"],
        checks: "The PC starts in UEFI mode with Secure Boot enabled.",
        why: "Secure Boot stops software that is not signed (such as boot-level malware) from loading before Windows.",
        fix: "Turn on Secure Boot in the PC's UEFI (BIOS) settings. A PC that starts in legacy BIOS mode may need its disk converted first (mbr2gpt).",
        evaluate: ({ p }) => {
            if (p.secureBoot.status !== "ok") return cannot(p, "secureBoot", "The Secure Boot state");
            if (!p.secureBoot.supported) return na("This PC does not start in UEFI mode (legacy BIOS or a virtual machine), so Secure Boot does not apply.");
            return p.secureBoot.enabled ? pass("Secure Boot is on.") : fail("Secure Boot is supported but turned off.");
        },
    },
    {
        id: "tpm.ready", group: "System", title: "A TPM is present and ready", severity: "medium", weight: 3, uses: ["tpm"],
        checks: "The PC has a Trusted Platform Module and it is ready to use.",
        why: "The TPM protects encryption keys and sign-in secrets in hardware. Windows 11 needs one.",
        fix: "Turn on the TPM (often called fTPM or PTT) in the UEFI settings. If the PC has none, it cannot take part in hardware-backed protection.",
        evaluate: ({ p }) => {
            if (p.tpm.status !== "ok") return cannot(p, "tpm", "The TPM state");
            if (!p.tpm.present) return fail("No TPM was found.");
            return p.tpm.ready ? pass("A TPM is present and ready.") : fail("A TPM is present but not ready to use.");
        },
    },
    {
        id: "admin.builtin", group: "Accounts", title: "The built-in Administrator account is off", severity: "medium", weight: 3, uses: ["accounts"],
        checks: "The local account named Administrator (the built-in one, found by its well-known id, not its name) is disabled.",
        why: "Everyone knows this account exists, so attackers try passwords against it first, and it is not tied to a person in the logs.",
        fix: "Disable it: net user Administrator /active:no (use the account's real name if it was renamed), after making sure another administrator can sign in.",
        evaluate: ({ p }) => {
            if (p.accounts.status !== "ok") return cannot(p, "accounts", "The local accounts");
            if (p.accounts.builtinAdminEnabled === null) return unknown("The built-in Administrator account was not found in the account list.");
            return p.accounts.builtinAdminEnabled ? fail(`The built-in Administrator account${p.accounts.builtinAdminName ? ` (${p.accounts.builtinAdminName})` : ""} is enabled.`) : pass("The built-in Administrator account is disabled.");
        },
    },
    {
        id: "guest.off", group: "Accounts", title: "The Guest account is off", severity: "medium", weight: 3, uses: ["accounts"],
        checks: "The local Guest account is disabled.",
        why: "An enabled Guest account lets anyone use the PC without being identified.",
        fix: "Disable it: net user Guest /active:no.",
        evaluate: ({ p }) => {
            if (p.accounts.status !== "ok") return cannot(p, "accounts", "The local accounts");
            if (p.accounts.guestEnabled === null) return unknown("The Guest account was not found in the account list.");
            return p.accounts.guestEnabled ? fail("The Guest account is enabled.") : pass("The Guest account is disabled.");
        },
    },
    {
        id: "lock.screen", group: "Accounts", title: "The screen locks when the PC is left alone", severity: "medium", weight: 3, uses: ["screenLock"],
        checks: `A policy or a password-protected screen saver locks the PC after at most ${MAX_IDLE_LOCK_SECS / 60} minutes of no use.`,
        why: "An unlocked PC left alone lets anyone who walks past read mail and open customer systems as that person.",
        fix: `Set the policy 'Interactive logon: Machine inactivity limit' to ${MAX_IDLE_LOCK_SECS} seconds or less, or set a screen saver with 'On resume, display logon screen' and a wait of 15 minutes or less.`,
        evaluate: ({ p }) => {
            if (p.screenLock.status !== "ok") return cannot(p, "screenLock", "The screen lock setting");
            const s = p.screenLock;
            if (s.inactivityTimeoutSecs !== null && s.inactivityTimeoutSecs > 0) {
                const m = Math.round(s.inactivityTimeoutSecs / 60);
                return s.inactivityTimeoutSecs <= MAX_IDLE_LOCK_SECS ? pass(`The machine locks after ${m} minutes (policy).`) : fail(`The machine locks only after ${m} minutes (policy).`);
            }
            if (!s.users.length) return unknown("No lock policy is set and nobody is signed in whose screen saver could be checked.");
            const bad = s.users.filter((u) => !(u.secure && u.timeoutSecs !== null && u.timeoutSecs <= MAX_IDLE_LOCK_SECS));
            return bad.length ? fail(`No inactivity lock policy, and ${plural(bad.length, "signed-in user")} ${bad.length === 1 ? "has" : "have"} no password-protected screen saver within ${MAX_IDLE_LOCK_SECS / 60} minutes.`) : pass("The signed-in users have a password-protected screen saver that starts within 15 minutes.");
        },
    },
    {
        id: "pw.length", group: "Accounts", title: "Passwords must be at least 8 characters", severity: "medium", weight: 3, uses: ["passwordPolicy"],
        checks: "The local account policy (net accounts) requires a minimum password length of 8 or more. Domain accounts follow the domain's policy instead.",
        why: "With no minimum length, local accounts can have empty or very short passwords.",
        fix: "Set the minimum password length with the policy 'Minimum password length' (Local Security Policy > Account Policies > Password Policy, or net accounts /minpwlen:12), or through your domain or Intune policy.",
        evaluate: ({ p }) => {
            if (p.passwordPolicy.status !== "ok") return cannot(p, "passwordPolicy", "The password policy");
            const n = p.passwordPolicy.minLength;
            if (n === null) return unknown("The minimum password length could not be read.");
            return n >= 8 ? pass(`The minimum password length is ${n}.`) : fail(`The minimum password length is ${n}.`);
        },
    },
    {
        id: "pw.lockout", group: "Accounts", title: "Accounts lock after repeated wrong passwords", severity: "medium", weight: 3, uses: ["passwordPolicy"],
        checks: "The local account policy locks an account after 1 to 10 wrong passwords (net accounts).",
        why: "With no lockout, an attacker can try passwords against local accounts without limit.",
        fix: "Set 'Account lockout threshold' to 5 to 10 invalid attempts (Local Security Policy > Account Policies > Account Lockout Policy, or net accounts /lockoutthreshold:10), or through your domain or Intune policy.",
        evaluate: ({ p }) => {
            if (p.passwordPolicy.status !== "ok") return cannot(p, "passwordPolicy", "The password policy");
            // net accounts prints Never (a word) when there is no lockout, which the script leaves empty.
            const n = p.passwordPolicy.lockoutThreshold ?? 0;
            if (n === 0) return fail("Accounts are never locked out.");
            return n <= 10 ? pass(`Accounts lock after ${plural(n, "wrong password")}.`) : fail(`Accounts lock only after ${n} wrong passwords.`);
        },
    },
    {
        id: "updates.recent", group: "System", title: `Windows updates were installed in the last ${MAX_UPDATE_AGE_DAYS} days`, severity: "medium", weight: 3, uses: ["lastUpdate"],
        checks: "The Windows Update history shows an update installed within 60 days (the daily Defender definition updates are not counted).",
        why: "Windows ships security fixes every month. A PC that has installed nothing for two months is missing known fixes.",
        fix: "Open Settings > Windows Update and install what is waiting, restart, or check that the PC is not blocked from reaching Windows Update. Use the Patch tab to scan and install.",
        evaluate: ({ p }) => {
            if (p.lastUpdate.status !== "ok") return cannot(p, "lastUpdate", "The last update date");
            const d = p.lastUpdate.ageDays;
            if (d === null) return unknown("The Windows Update history has no usable date.");
            return d <= MAX_UPDATE_AGE_DAYS ? pass(`The last update was installed ${agoText(d)}.`) : fail(`The last update was installed ${d} days ago.`);
        },
    },
    {
        id: "av.scan", group: "Antivirus", title: "A virus scan ran in the last 14 days", severity: "low", weight: 2, uses: ["defender"],
        checks: "Microsoft Defender finished a quick or full scan within 14 days.",
        why: "Real-time protection catches most things, but a regular scan finds what slipped in while the PC was off or while protection was not yet updated.",
        fix: "Use Quick scan or Full scan on this tab, or leave the PC on at the time Defender's scheduled scan runs.",
        evaluate: ({ p }) => {
            const a = avPicture(p);
            if (!a.defenderActive) return a.known ? na("Microsoft Defender is not the product in charge.") : cannot(p, "defender", "The last scan");
            const ages = [a.defender!.quickScanAgeDays, a.defender!.fullScanAgeDays].filter((x): x is number => x !== null);
            if (!ages.length) return fail("Microsoft Defender has never completed a scan.");
            const best = Math.min(...ages);
            return best <= MAX_SCAN_AGE_DAYS ? pass(`The last scan finished ${agoText(best)}.`) : fail(`The last scan finished ${best} days ago.`);
        },
    },
    {
        id: "av.exclusions", group: "Antivirus", title: "Antivirus is not told to skip risky places", severity: "medium", weight: 3, uses: ["defenderExclusions", "defender", "securityCenter"],
        checks: "Microsoft Defender has no exclusion for a whole drive, a system folder, a whole user profile, a temp or downloads folder, program or script file types, or a script engine such as powershell.exe.",
        why: "Anything an exclusion covers is never scanned. Malware looks for a broad exclusion and runs from it. Narrow exclusions for one application's own folder are normal and are not flagged.",
        fix: "Open Windows Security > Virus & threat protection > Manage settings > Add or remove exclusions and remove the broad ones, or change the policy that adds them. Exclude only the single folder or program that really needs it.",
        evaluate: ({ p }) => {
            const x = p.defenderExclusions;
            if (!x) return unknown("This scan was made before this check existed. Scan the device again.");
            const a = avPicture(p);
            if (!a.defenderActive && a.othersOn.length) return na("Microsoft Defender is not the product in charge.");
            if (x.status !== "ok") return cannot(p, "defenderExclusions", "The exclusion list");
            const total = x.paths + x.extensions + x.processes;
            if (x.broad.length) return fail(`Microsoft Defender is told not to scan: ${x.broad.slice(0, 4).join(", ")}${x.broad.length > 4 ? ", ..." : ""} (${plural(total, "exclusion")} in all).`);
            return pass(total === 0 ? "Microsoft Defender has no exclusions." : `${plural(total, "exclusion")}, none of them broad.`);
        },
    },
    {
        id: "admin.count", group: "Accounts", title: "Few local administrators", severity: "low", weight: 2, uses: ["accounts"],
        checks: "At most 3 accounts (not counting a disabled built-in Administrator) are in the local Administrators group.",
        why: "Every administrator is another account whose theft hands over the whole PC.",
        fix: "Remove accounts that do not need administrator rights from the Administrators group (Computer Management > Local Users and Groups > Groups, or net localgroup Administrators <name> /delete).",
        evaluate: ({ p }) => {
            if (p.accounts.status !== "ok") return cannot(p, "accounts", "The Administrators group");
            const a = p.accounts;
            const builtinOff = a.builtinAdminEnabled === false && a.builtinAdminName
                ? a.adminNames.filter((n) => n.toLowerCase().endsWith(`\\${a.builtinAdminName.toLowerCase()}`)).length
                : 0;
            const n = Math.max(a.adminCount - builtinOff, 0);
            const who = a.adminNames.slice(0, 6).join(", ");
            return n <= 3 ? pass(`${plural(n, "administrator")}${who ? `: ${who}` : ""}.`) : fail(`${plural(n, "administrator")} in the local Administrators group${who ? `: ${who}${a.adminCount > 6 ? ", ..." : ""}` : ""}.`);
        },
    },
    {
        id: "reboot.pending", group: "System", title: "No restart is waiting", severity: "low", weight: 2, uses: ["reboot"],
        checks: "Windows is not waiting for a restart to finish installing updates.",
        why: "Updates that wait for a restart are not protecting the PC yet.",
        fix: "Restart the PC (the Patch tab can restart it when it suits the user).",
        evaluate: ({ p }) => {
            if (p.reboot.status !== "ok") return cannot(p, "reboot", "The restart flag");
            const r = p.reboot;
            if (!r.pending) return pass("No restart is waiting.");
            return fail(`A restart is waiting (${[r.servicing ? "Windows servicing" : "", r.windowsUpdate ? "Windows Update" : ""].filter(Boolean).join(", ")}).`);
        },
    },
];

export const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/* ------------------------------ scoring ------------------------------ */

export type RuleOutcome = Outcome & { id: string };

export type Evaluation = {
    score: number | null;
    uncappedScore: number | null;
    grade: Grade | null;
    capped: boolean;
    capReason: string | null;
    counts: { pass: number; fail: number; unknown: number; notApplicable: number };
    /** Failed rules by severity. */
    failedBySeverity: Record<Severity, number>;
    failedIds: string[];
    unknownIds: string[];
    rules: Array<RuleOutcome & { title: string; group: string; severity: Severity; weight: number }>;
};

export function gradeFor(score: number): Grade {
    return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}
/** The best score a grade allows. */
export const GRADE_CAP_SCORE: Record<"D" | "F", number> = { D: 69, F: 59 };

/** Score and grade from rule outcomes (pure: the tests feed it hand-made outcomes). */
export function scoreOutcomes(outcomes: RuleOutcome[], defs: Map<string, { severity: Severity; weight: number }> = RULE_BY_ID): Pick<Evaluation, "score" | "uncappedScore" | "grade" | "capped" | "capReason" | "counts" | "failedBySeverity" | "failedIds" | "unknownIds"> {
    const counts = { pass: 0, fail: 0, unknown: 0, notApplicable: 0 };
    const failedBySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    const failedIds: string[] = [];
    const unknownIds: string[] = [];
    let earned = 0;
    let possible = 0;
    for (const o of outcomes) {
        const def = defs.get(o.id);
        if (!def) continue;
        if (o.result === "pass") { counts.pass++; earned += def.weight; possible += def.weight; }
        else if (o.result === "fail") { counts.fail++; possible += def.weight; failedBySeverity[def.severity]++; failedIds.push(o.id); }
        else if (o.result === "unknown") { counts.unknown++; unknownIds.push(o.id); }
        else counts.notApplicable++;
    }
    if (possible === 0) return { score: null, uncappedScore: null, grade: null, capped: false, capReason: null, counts, failedBySeverity, failedIds, unknownIds };
    const uncapped = Math.round((earned / possible) * 100);
    let score = uncapped;
    let capReason: string | null = null;
    const crit = failedBySeverity.critical;
    if (crit >= 2) { score = Math.min(score, GRADE_CAP_SCORE.F); capReason = `${crit} critical checks failed, so the grade cannot be better than F.`; }
    else if (crit === 1) { score = Math.min(score, GRADE_CAP_SCORE.D); capReason = "A critical check failed, so the grade cannot be better than D."; }
    return { score, uncappedScore: uncapped, grade: gradeFor(score), capped: score < uncapped, capReason: score < uncapped ? capReason : null, counts, failedBySeverity, failedIds, unknownIds };
}

/** Runs every rule on a scan. A rule that throws is reported as unknown, so one bug never loses the whole result. */
export function evaluateScan(scan: ScanData, now: Date = new Date()): Evaluation {
    const rules = RULES.map((r) => {
        let o: Outcome;
        try { o = r.evaluate({ p: scan.probes, now }); } catch { o = unknown("This check could not be worked out."); }
        return { id: r.id, result: o.result, detail: o.detail, title: r.title, group: r.group, severity: r.severity, weight: r.weight };
    });
    return { ...scoreOutcomes(rules), rules };
}
