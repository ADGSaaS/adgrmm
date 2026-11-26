// backend/src/auto-repair/auto-repair.core.ts
//
// Automatic repair of problems people report from the tray app. A person picks a category (and, for "Software Issue", the program). Each
// category has its own checks, and each check can recognise problems whose repair is either a script, something the person is asked to do
// (advice), or something a technician has to look at (escalate). This file is the catalog of all of that and the words used for the ticket reply,
// the technician's note and the KB article. Pure, so it is tested without a database. The scripts themselves are in auto-repair.scripts.ts.
import { BadRequestException } from "@nestjs/common";

/** What a person picks first. Anything else is refused, so the ticket and the KB stay tidy. */
export const CATEGORIES = ["Software Issue", "Printing", "Internet or network", "Email", "Slow computer", "Sign-in or password", "Hardware", "Security concern", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Only this category asks which program, and it is what starts the software repair workflow. */
export const SOFTWARE_CATEGORY: Category = "Software Issue";
/** The choice at the end of the program list for a software problem that is not about one program. */
export const NO_APPLICATION = "Windows itself, or not sure";

export function cleanCategory(v: unknown): Category | null {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const hit = CATEGORIES.find((c) => c.toLowerCase() === s.toLowerCase());
    if (!hit) throw new BadRequestException("Please choose one of the categories in the list.");
    return hit;
}

export type AppInput = { name: string; publisher: string | null; version: string | null };

export function cleanApp(name: unknown, publisher: unknown, version: unknown): AppInput | null {
    const clean = (x: unknown, max: number) => String(x ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
    const n = clean(name, 120);
    if (!n) return null;
    return { name: n, publisher: clean(publisher, 120) || null, version: clean(version, 60) || null };
}

/* ------------------------------ the problems the checks recognise ------------------------------ */

export type IssueId =
    | "low-disk" | "pending-reboot" | "high-cpu-process"
    | "spooler-stopped" | "spooler-stuck-jobs"
    | "no-ip-address" | "dns-client-stopped" | "dns-failing" | "gateway-unreachable" | "no-internet" | "mail-unreachable"
    | "teams-crashing" | "app-crashing" | "outlook-crashing"
    | "time-not-synced" | "secure-channel-broken"
    | "defender-realtime-off" | "defender-signatures-old" | "firewall-off"
    | "disk-unhealthy" | "device-error"
    | "linux-low-disk" | "linux-pending-reboot" | "linux-time-not-synced" | "linux-dns-broken" | "linux-service-failed";

export type IssueKind = "repair" | "advice" | "escalate";

export type IssueDef = {
    id: IssueId;
    kind: IssueKind;
    title: string;
    /** What it means, for the person, in the reply. */
    plain: string;
    /** The signs, for the KB article. */
    signs: string;
    /** What the repair does (kind repair). */
    fix: string;
    /** What the person is asked to do (kind advice). */
    advice?: string;
    /** If it comes back. */
    ifItReturns: string;
    /** A problem that needs a technician's attention soon, whatever else happens. */
    urgent?: boolean;
};

const I = (d: IssueDef) => d;

export const ISSUES: Record<IssueId, IssueDef> = {
    /* ---- any category ---- */
    "low-disk": I({
        id: "low-disk", kind: "repair", title: "The computer is slow or misbehaving because the disk is nearly full",
        plain: "the disk was almost full, which slows Windows and makes programs fail",
        signs: "Windows and programs are slow, updates fail, programs say they cannot save. Less than 10 GB or 10 percent of the C: drive is free.",
        fix: "Deleted temporary files older than three days from the Windows and user temp folders. Documents, downloads and the recycle bin were not touched.",
        ifItReturns: "If the disk fills up again, something is using the space: look at the largest folders, old Windows update files and downloads. The disk may need cleaning up properly or replacing with a larger one.",
    }),
    "pending-reboot": I({
        id: "pending-reboot", kind: "advice", title: "Problems that go away after restarting the computer",
        plain: "the computer needs to be restarted (it has a waiting update or has been on for a long time)",
        signs: "Strange slowness or programs misbehaving on a computer that has not been restarted for weeks, or that Windows says is waiting for a restart.",
        fix: "", advice: "Please save your work and restart the computer (Start, then Power, then Restart: not Shut down), then test again.",
        ifItReturns: "If the problem is back soon after a restart, it needs a technician.",
    }),
    "high-cpu-process": I({
        id: "high-cpu-process", kind: "escalate", title: "One program is using almost all of the processor",
        plain: "one program was using almost all of the computer's processing power",
        signs: "The computer is slow and the fan runs loudly. One program shows as using most of the processor for a long time.",
        fix: "", ifItReturns: "Find out what the program is and why it is busy: it may be a scan, an update, a runaway program, or unwanted software.",
    }),
    /* ---- printing ---- */
    "spooler-stopped": I({
        id: "spooler-stopped", kind: "repair", title: "Printing does nothing because the Print Spooler service is stopped",
        plain: "the part of Windows that sends documents to printers (the Print Spooler) had stopped",
        signs: "Documents go to the printer queue but nothing prints, or printers show as offline on a computer whose printers are otherwise fine. The Print Spooler service is not running.",
        fix: "Started the Print Spooler service and set it to start by itself.",
        ifItReturns: "If the Print Spooler stops again soon after, a driver for one of the printers is probably crashing it. A technician should look at the installed printer drivers.",
    }),
    "spooler-stuck-jobs": I({
        id: "spooler-stuck-jobs", kind: "repair", title: "Printing is stuck behind print jobs that never finish",
        plain: "one or more print jobs were stuck in the queue and holding everything else up",
        signs: "A document that will not print, cannot be cancelled, and everything sent after it waits too. Files that have been waiting in the spool folder for more than ten minutes.",
        fix: "Stopped the Print Spooler, deleted the stuck print job files, and started it again.",
        ifItReturns: "If the same printer gets stuck again, the printer driver or the document is the cause. Update or reinstall the driver, or try printing the document as a PDF.",
    }),
    /* ---- internet and network ---- */
    "no-ip-address": I({
        id: "no-ip-address", kind: "repair", title: "No internet because the computer did not get a network address",
        plain: "the computer had not been given a proper network address, so it could not talk to the network",
        signs: "No internet and no access to shared drives, though the cable or Wi-Fi looks connected. The network adapter has an address starting with 169.254, or none at all.",
        fix: "Asked the network for a new address (renewed the lease).",
        ifItReturns: "If the computer keeps losing its address, check the router or DHCP server, the cable or the Wi-Fi signal.",
    }),
    "dns-client-stopped": I({
        id: "dns-client-stopped", kind: "repair", title: "Websites will not open because the DNS Client service is stopped",
        plain: "the part of Windows that looks up website names (the DNS Client service) had stopped",
        signs: "Websites and online programs fail with a name or server not found error, although the connection is up. The DNS Client service is not running.",
        fix: "Started the DNS Client service and cleared the DNS cache.",
        ifItReturns: "If the service stops again, something is stopping it: look for security software or a policy that disables it.",
    }),
    "dns-failing": I({
        id: "dns-failing", kind: "repair", title: "Websites will not open because name lookups fail",
        plain: "the computer could reach the internet but could not look up website names",
        signs: "Websites do not open ('server not found'), but pinging an internet address such as 1.1.1.1 works. Name lookups fail.",
        fix: "Cleared the DNS cache and restarted the DNS Client service.",
        ifItReturns: "If name lookups keep failing, the DNS servers the computer is told to use (from the router or the domain) are wrong or down.",
    }),
    "gateway-unreachable": I({
        id: "gateway-unreachable", kind: "advice", title: "The computer cannot reach the router",
        plain: "the computer could not reach the router (the device that connects it to the internet)",
        signs: "No internet or network access at all, even though the network shows as connected. The default gateway does not answer.",
        fix: "", advice: "Please check that the network cable is plugged in at both ends, or that Wi-Fi is on and shows a good signal, then test again. If other people are also offline, tell us.",
        ifItReturns: "Check the cable, the switch port and the router. If many computers are affected, the router or switch is the problem.",
    }),
    "no-internet": I({
        id: "no-internet", kind: "escalate", title: "The network works but there is no internet",
        plain: "the computer could reach the router but not the internet",
        signs: "Shared drives and local devices work but websites do not, and pinging an internet address fails. The router or the internet connection is down.",
        fix: "", ifItReturns: "Check the router and the internet connection, and whether other computers are also offline.",
    }),
    /* ---- email ---- */
    "mail-unreachable": I({
        id: "mail-unreachable", kind: "escalate", title: "Email will not connect although the internet works",
        plain: "the internet worked but the mail service could not be reached",
        signs: "Outlook shows Disconnected or Trying to connect while other websites work. The computer cannot connect to the mail service on port 443.",
        fix: "", ifItReturns: "Check whether a firewall, proxy or security software blocks the mail service, and check the service status of the mail provider.",
    }),
    "outlook-crashing": I({
        id: "outlook-crashing", kind: "escalate", title: "Outlook keeps closing unexpectedly",
        plain: "Outlook had been closing unexpectedly",
        signs: "Outlook closes by itself, freezes, or restarts. Windows has recorded Outlook closing unexpectedly more than once in the last week.",
        fix: "", ifItReturns: "Look at the add-ins Outlook loads, the size of the mail file (OST), and run an Office repair.",
    }),
    /* ---- software ---- */
    "teams-crashing": I({
        id: "teams-crashing", kind: "repair", title: "Microsoft Teams keeps closing or will not start",
        plain: "Microsoft Teams had been closing unexpectedly, which is usually caused by a damaged cache",
        signs: "Teams closes by itself, freezes on a white or blank screen, or will not start. Windows has recorded the Teams program closing unexpectedly more than once in the last week.",
        fix: "Closed Teams and cleared its cache folders (this does not remove chats, files or settings, which live in your account). Teams signs in and rebuilds the cache the next time it starts.",
        ifItReturns: "If Teams still crashes after clearing the cache, update or reinstall Teams, and check that Windows and the graphics driver are up to date.",
    }),
    "app-crashing": I({
        id: "app-crashing", kind: "escalate", title: "A program keeps closing unexpectedly",
        plain: "the program had been closing unexpectedly",
        signs: "The program closes by itself or freezes. Windows has recorded it closing unexpectedly more than once in the last week.",
        fix: "", ifItReturns: "Check for updates to the program, repair or reinstall it, and look at the event log for the faulting module.",
    }),
    /* ---- sign-in ---- */
    "time-not-synced": I({
        id: "time-not-synced", kind: "repair", title: "Sign-in problems because the computer's clock is wrong",
        plain: "the computer's clock had not been kept in step with the network, which breaks signing in",
        signs: "Sign-in fails, certificate or 'time' errors appear, or the domain says the computer cannot be trusted. The Windows Time service is stopped or has not synchronised for days.",
        fix: "Started the Windows Time service and synchronised the clock.",
        ifItReturns: "If the clock drifts again, check the time source (the domain controller or the internet time server) and the computer's battery for its clock.",
    }),
    "secure-channel-broken": I({
        id: "secure-channel-broken", kind: "escalate", title: "The computer has lost its trust relationship with the domain",
        plain: "the computer's connection of trust with the company network was broken",
        signs: "Domain users cannot sign in, with a message that the trust relationship between this workstation and the domain failed.",
        fix: "", urgent: true, ifItReturns: "The computer needs to be rejoined to the domain, or its secure channel repaired with a domain administrator's credentials.",
    }),
    /* ---- security ---- */
    "defender-realtime-off": I({
        id: "defender-realtime-off", kind: "repair", title: "Virus protection is switched off",
        plain: "Windows' real-time virus protection had been switched off",
        signs: "Windows Security shows 'Virus & threat protection' with a warning, and real-time protection is off with no other antivirus in charge.",
        fix: "Turned Microsoft Defender's real-time protection back on.",
        urgent: true, ifItReturns: "If it keeps turning off, something is switching it off: malware, a policy, or software that disables it. A technician should look into it.",
    }),
    "defender-signatures-old": I({
        id: "defender-signatures-old", kind: "repair", title: "Virus protection is out of date",
        plain: "the virus definitions were more than a week old",
        signs: "Windows Security says definitions are out of date. The antivirus signatures are older than seven days.",
        fix: "Updated Microsoft Defender's virus definitions.",
        ifItReturns: "If the definitions do not update, check the internet connection and Windows Update, and that nothing blocks Microsoft's update servers.",
    }),
    "firewall-off": I({
        id: "firewall-off", kind: "escalate", title: "The firewall is switched off",
        plain: "the Windows firewall was switched off for one or more networks",
        signs: "Windows Security shows the firewall is off for the domain, private or public network.",
        fix: "", urgent: true, ifItReturns: "Find out why it was switched off before turning it on: some software and some policies do this, and turning it on can break file sharing or remote access.",
    }),
    /* ---- hardware ---- */
    "disk-unhealthy": I({
        id: "disk-unhealthy", kind: "escalate", title: "A disk is reporting it is not healthy",
        plain: "one of the computer's disks reported that it is not healthy, and it could fail",
        signs: "Windows reports a physical disk as Warning or Unhealthy. The computer may freeze, files may fail to open, and the disk may fail without further notice.",
        fix: "", urgent: true, ifItReturns: "Back up the data now and replace the disk. A disk that reports it is unhealthy should not be trusted.",
    }),
    "device-error": I({
        id: "device-error", kind: "escalate", title: "Windows reports a device with an error",
        plain: "Windows reported a hardware device that is not working properly",
        signs: "A device (a camera, a network card, a USB device, a sound card) does not work, and Device Manager shows it with an error.",
        fix: "", ifItReturns: "Update or reinstall the driver for the device, try another USB port, and check whether the device itself has failed.",
    }),
    /* ---- Linux computers ---- */
    "linux-low-disk": I({
        id: "linux-low-disk", kind: "repair", title: "The computer is slow or misbehaving because the disk is nearly full",
        plain: "the disk was almost full, which slows the computer and makes programs and updates fail",
        signs: "Programs and updates fail, logs stop, the system is slow. Less than 5 GB or 10 percent of the main disk is free.",
        fix: "Deleted temporary files older than three days from /tmp and /var/tmp, cleaned the package cache and trimmed system logs older than a week. Home folders and documents were not touched.",
        ifItReturns: "If the disk fills up again, something is using the space: look at the largest folders (du -xh / | sort -h), old logs and container images. The disk may need cleaning up properly or a larger disk.",
    }),
    "linux-pending-reboot": I({
        id: "linux-pending-reboot", kind: "advice", title: "Problems that go away after restarting the computer",
        plain: "the computer needs to be restarted (updates are waiting for it)",
        signs: "A Linux computer that has installed updates but not been restarted: the system lists /var/run/reboot-required.",
        fix: "", advice: "Please save your work and restart the computer, then test again.",
        ifItReturns: "If the problem is back soon after a restart, it needs a technician.",
    }),
    "linux-time-not-synced": I({
        id: "linux-time-not-synced", kind: "repair", title: "The computer's clock is not synchronized",
        plain: "the computer's clock was not synchronized with a time server, which makes sign-in, certificates and secure connections fail",
        signs: "Websites report certificate errors, sign-in is refused, timedatectl shows NTP not synchronized.",
        fix: "Switched on time synchronization and restarted the time service.",
        ifItReturns: "If the clock drifts again, a time server may be blocked by the firewall (UDP port 123) or the time service is misconfigured.",
    }),
    "linux-dns-broken": I({
        id: "linux-dns-broken", kind: "repair", title: "The internet works but websites and servers cannot be found by name",
        plain: "the computer could reach the internet but could not look up names, so websites and servers did not open",
        signs: "Pinging an address works, pinging a name fails, browsers say the site cannot be found.",
        fix: "Restarted the name resolver (systemd-resolved or NetworkManager).",
        ifItReturns: "Check the DNS servers handed out by the network or set on the computer, and whether the router's DNS is working.",
    }),
    "linux-service-failed": I({
        id: "linux-service-failed", kind: "repair", title: "A service on the computer has stopped working",
        plain: "a service on the computer (a background program) had failed",
        signs: "systemctl --failed lists one or more units. Features that depend on the service do not work.",
        fix: "Restarted the failed services that are on the safe list (printing, networking, name resolution, time, remote login, web servers, and similar). Other failed services were reported and left alone.",
        ifItReturns: "Read the service's log (journalctl -u name) to find out why it keeps failing: a configuration error, a full disk or a missing dependency.",
    }),
};

export const isIssueId = (v: string): v is IssueId => Object.prototype.hasOwnProperty.call(ISSUES, v);

/* ------------------------------ what a category calls for ------------------------------ */

/** The checks to run for a ticket. Each category has its own; "crash" (look for the program closing unexpectedly) is added when a program is named. */
export function checksFor(category: Category | null, app: AppInput | null): string[] {
    const out = new Set<string>();
    switch (category) {
        case "Software Issue": out.add("disk"); out.add("reboot"); break;
        case "Printing": out.add("printing"); out.add("disk"); break;
        case "Internet or network": out.add("network"); break;
        case "Email": out.add("network"); out.add("mail"); out.add("disk"); out.add("outlook"); break;
        case "Slow computer": out.add("disk"); out.add("reboot"); out.add("cpu"); break;
        case "Sign-in or password": out.add("time"); out.add("network"); break;
        case "Hardware": out.add("hardware"); out.add("disk"); break;
        case "Security concern": out.add("security"); break;
        case "Other": out.add("disk"); out.add("reboot"); break;
        default: break;
    }
    if (category === SOFTWARE_CATEGORY && app && app.name !== NO_APPLICATION) {
        out.add("crash");
        if (/\bteams\b/i.test(app.name)) out.add("teams");
    }
    return [...out];
}

/**
 * For tickets that do not come from the tray (email, the customer portal, a technician): which category the words of the ticket are about, or null
 * when they are about nothing in particular or about two things equally. Security wording always wins (those tickets are looked at by a person).
 */
export function categoryFromText(subject: unknown, body: unknown): Category | null {
    const text = `${String(subject ?? "")} ${String(body ?? "").slice(0, 2000)}`.toLowerCase();
    const rules: Array<[Category, RegExp]> = [
        ["Security concern", /\b(virus|malware|ransomware|phish\w*|hacked?|compromised|suspicious|breach|scam)\b/g],
        ["Printing", /\b(print\w*|spooler|toner|scan(ner|ning)?)\b/g],
        ["Email", /\b(outlook|e-?mails?|mailbox|inbox|calendar invite)\b/g],
        ["Internet or network", /\b(internet|wi-?fi|network|vpn|dns|no connection|cannot connect|can'?t connect|offline)\b/g],
        ["Sign-in or password", /\b(password|sign[- ]?in|log[- ]?in|locked out|account (is )?locked|authenticat\w*)\b/g],
        ["Slow computer", /\b(slow|sluggish|freez\w*|frozen|laggy|lag|hangs?|takes forever)\b/g],
        ["Hardware", /\b(keyboard|mouse|monitor|battery|usb|webcam|headset|docking station)\b/g],
        ["Software Issue", /\b(crash\w*|not responding|won'?t (open|start|launch)|keeps closing|teams|excel|word|chrome|software|application|update failed)\b/g],
    ];
    const hits = rules.map(([c, re]) => [c, (text.match(re) ?? []).length] as const).filter(([, n]) => n > 0);
    if (!hits.length) return null;
    if (hits.some(([c]) => c === "Security concern")) return "Security concern";
    hits.sort((a, b) => b[1] - a[1]);
    if (hits.length > 1 && hits[0][1] === hits[1][1]) return null;
    return hits[0][0];
}

/** The checks that mean something on a Linux computer (the rest of the categories' checks are Windows-only and are left out), plus the failed-services check. */
export function checksForLinux(category: Category | null, app: AppInput | null): string[] {
    const keep = new Set(["disk", "reboot", "time", "network"]);
    const out = new Set(checksFor(category, app).filter((c) => keep.has(c)));
    if (category && ["Software Issue", "Printing", "Slow computer", "Other", "Email"].includes(category)) out.add("services");
    return [...out];
}

/** Which kind of script a computer gets, from what its agent and device record say about the operating system. */
export function platformOf(os: string | null | undefined, name: string | null | undefined): "windows" | "linux" | null {
    const text = `${os ?? ""} ${name ?? ""}`;
    if (/windows/i.test(text)) return "windows";
    if (/linux|ubuntu|debian|fedora|centos|red ?hat|rhel|alma|rocky|suse|alpine|mint|arch/i.test(text)) return "linux";
    return null;
}

/** Categories whose tickets a technician always looks at, however well the repair went. */
export const ALWAYS_REVIEWED: ReadonlySet<Category> = new Set<Category>(["Security concern", "Hardware"]);

/* ------------------------------ self-healing: which failed monitoring checks call for which checks ------------------------------ */

/**
 * A monitoring check that fails (an alert) can start the same find, repair and confirm loop as a ticket. This says which of the loop's checks to run for
 * a failed check, or null when nothing here knows how to help (the alert then goes its normal way). It only chooses what to LOOK at: what is repaired is
 * still decided by the problems found and the catalog above.
 */
export function healingPlan(check: { type: string; config: Record<string, unknown> | null }): { checks: string[]; why: string } | null {
    const cfg = check.config ?? {};
    const type = String(check.type ?? "").toLowerCase();
    const name = String(cfg.service ?? "").trim().toLowerCase();
    if (type === "service") {
        if (name === "spooler" || name === "print spooler") return { checks: ["printing"], why: "The Print Spooler service check failed, so the printing checks run." };
        if (name === "dnscache" || name === "dns client") return { checks: ["network"], why: "The DNS Client service check failed, so the network checks run." };
        if (name === "w32time" || name === "windows time") return { checks: ["time"], why: "The Windows Time service check failed, so the clock checks run." };
        return null;
    }
    if (type === "metric") {
        const metric = String(cfg.metric ?? "").toLowerCase();
        if (metric === "disk") return { checks: ["disk"], why: "The disk space check failed, so the disk check runs." };
        if (metric === "cpu") return { checks: ["cpu"], why: "The processor check failed, so the busiest program is looked for (it is reported, not changed)." };
        return null;
    }
    if (type === "ping") return { checks: ["network"], why: "A ping or port check failed, so the computer's own network checks run." };
    return null;
}

/* ------------------------------ what the scripts printed ------------------------------ */

export type Diagnosis = { issues: Array<{ id: IssueId; detail: string }>; info: Record<string, string>; complete: boolean };

const clip = (s: string, n: number) => s.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, n);

/** What a diagnostic script printed. Only lines of the known shapes count and only known problem ids; whatever else it printed is ignored. */
export function parseDiagnosis(stdout: string): Diagnosis {
    const out: Diagnosis = { issues: [], info: {}, complete: false };
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "DONE") { out.complete = true; continue; }
        const m = /^(ISSUE|INFO) ([a-z0-9_-]{1,40})\|(.*)$/.exec(line);
        if (!m) continue;
        if (m[1] === "INFO") { if (Object.keys(out.info).length < 40) out.info[m[2]] = clip(m[3], 300); continue; }
        if (isIssueId(m[2]) && !out.issues.some((i) => i.id === m[2])) out.issues.push({ id: m[2], detail: clip(m[3], 300) });
    }
    return out;
}

export type RepairLine = { id: IssueId; ok: boolean; message: string };

export function parseRepair(stdout: string): RepairLine[] {
    const out: RepairLine[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
        const m = /^(FIXED|FAILED) ([a-z0-9_-]{1,40})\|(.*)$/.exec(raw.trim());
        if (m && isIssueId(m[2]) && !out.some((r) => r.id === m[2])) out.push({ id: m[2], ok: m[1] === "FIXED", message: clip(m[3], 300) });
    }
    return out;
}

/* ------------------------------ the results report ------------------------------ */

/** Why a run went to a technician (stored as a short code), in words for the report. */
export const HANDOFF_REASONS: Record<string, string> = {
    nothing_found: "The checks found nothing they know about",
    needs_technician: "The problem found has no automatic repair (a technician is needed)",
    not_repaired: "A repair exists but was not run (repair switched off, or the daily limit for the computer)",
    repair_failed: "The repair ran but did not work",
    still_there: "The repair said it worked but the check still found the problem",
    could_not_run: "The checks could not run on the computer",
    too_long: "It took too long (the computer was probably offline)",
    person_says_not_fixed: "The person tested the repair and said the problem was still there",
    error: "The automatic repair stopped with an error",
};

/** A conservative estimate of the technician time one fix saves: a person finding the problem, fixing it and answering. */
export const MINUTES_SAVED_PER_FIX = 15;

export type ReportRun = {
    source: string; state: string; handoff_reason: string | null; category: string | null; app_name: string | null; repair_issues: string[];
    diagnosis: { issues?: Array<{ id: string }> } | null; created_at: Date; finished_at: Date | null;
};

/** The numbers of the report from the runs of a period. Pure, so it is tested without a database. */
export function summarizeRuns(runs: ReportRun[], days: number, now = new Date()) {
    const fixedStates = new Set(["confirmed_fixed", "healed"]);
    const handedStates = new Set(["needs_technician", "no_issue_found", "not_fixed"]);
    const out = {
        total: runs.length, tickets: 0, alerts: 0,
        fixed: 0, waiting: 0, handed: 0, inProgress: 0,
        fixedPercent: null as number | null, minutesSaved: 0, averageMinutesToFix: null as number | null,
        reasons: {} as Record<string, number>,
        byCategory: {} as Record<string, { total: number; fixed: number; handed: number }>,
        problemsFound: {} as Record<string, number>,
        problemsFixed: {} as Record<string, number>,
        problemsNotFixed: {} as Record<string, number>,
        handedNoRepair: {} as Record<string, number>,
        trend: [] as Array<{ day: string; fixed: number; handed: number; other: number }>,
    };
    const fixMs: number[] = [];
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const trend = new Map<string, { fixed: number; handed: number; other: number }>();
    for (let i = days - 1; i >= 0; i--) trend.set(day(new Date(now.getTime() - i * 86_400_000)), { fixed: 0, handed: 0, other: 0 });
    for (const r of runs) {
        if (r.source === "alert") out.alerts++; else out.tickets++;
        const cat = r.category ?? (r.source === "alert" ? "Failed monitoring check" : "Other");
        const c = (out.byCategory[cat] ??= { total: 0, fixed: 0, handed: 0 });
        c.total++;
        const t = trend.get(day(r.created_at));
        const isFixed = fixedStates.has(r.state), isHanded = handedStates.has(r.state);
        if (isFixed) { out.fixed++; c.fixed++; if (r.finished_at) fixMs.push(r.finished_at.getTime() - r.created_at.getTime()); if (t) t.fixed++; }
        else if (r.state === "awaiting_user") { out.waiting++; if (t) t.other++; }
        else if (isHanded) {
            out.handed++; c.handed++; if (t) t.handed++;
            const reason = r.state === "no_issue_found" ? "nothing_found" : r.state === "not_fixed" ? "person_says_not_fixed" : r.handoff_reason ?? "error";
            out.reasons[reason] = (out.reasons[reason] ?? 0) + 1;
            if (reason === "nothing_found") { const k = [r.category, r.app_name].filter(Boolean).join(": ") || "Not stated"; out.handedNoRepair[k] = (out.handedNoRepair[k] ?? 0) + 1; }
        } else { out.inProgress++; if (t) t.other++; }
        for (const i of r.diagnosis?.issues ?? []) {
            out.problemsFound[i.id] = (out.problemsFound[i.id] ?? 0) + 1;
            if (isHanded && ISSUES[i.id as IssueId]?.kind !== "repair") out.handedNoRepair[`Problem: ${i.id}`] = (out.handedNoRepair[`Problem: ${i.id}`] ?? 0) + 1;
        }
        const worked = isFixed || r.state === "awaiting_user";
        for (const id of r.repair_issues) {
            if (worked) out.problemsFixed[id] = (out.problemsFixed[id] ?? 0) + 1;
            else if (isHanded) out.problemsNotFixed[id] = (out.problemsNotFixed[id] ?? 0) + 1;
        }
    }
    const decided = out.fixed + out.handed;
    out.fixedPercent = decided ? Math.round((out.fixed / decided) * 100) : null;
    out.minutesSaved = out.fixed * MINUTES_SAVED_PER_FIX;
    out.averageMinutesToFix = fixMs.length ? Math.round((fixMs.reduce((a, b) => a + b, 0) / fixMs.length / 60_000) * 10) / 10 : null;
    out.trend = [...trend.entries()].map(([d, v]) => ({ day: d, ...v }));
    return out;
}

/* ------------------------------ words ------------------------------ */

export const AUTO_AUTHOR = "Automated repair";

const tidy = (lines: string[]) => lines.filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n");
const TEST_AGAIN = "Please try it again now. If it works, press \"It's fixed\" in this window (or just reply). If the problem is still there, press \"Still not working\" and a technician will take over.";

/** The reply to the person after a repair worked. `alsoNoticed` are problems found that a technician has to look at. */
export function fixedReply(fixed: IssueDef[], messages: string[], alsoNoticed: IssueDef[] = []): string {
    return tidy([
        `We looked at your computer and found that ${fixed.map((i) => i.plain).join(", and ")}.`,
        `What we did: ${fixed.map((i) => i.fix).filter(Boolean).join(" ")}`,
        messages.length ? `Result: ${messages.join(" ")}` : "",
        alsoNoticed.length ? `We also noticed that ${alsoNoticed.map((i) => i.plain).join(", and ")}. A technician will look at that and follow up.` : "",
        "",
        TEST_AGAIN,
    ]);
}

/** The reply when the only thing found is something the person has to do themselves. */
export function adviceReply(advice: IssueDef[], alsoNoticed: IssueDef[] = []): string {
    return tidy([
        `We looked at your computer and found that ${advice.map((i) => i.plain).join(", and ")}.`,
        advice.map((i) => i.advice).filter(Boolean).join(" "),
        alsoNoticed.length ? `We also noticed that ${alsoNoticed.map((i) => i.plain).join(", and ")}. A technician will look at that and follow up.` : "",
        "",
        "If that fixes it, press \"It's fixed\" in this window. If the problem is still there afterwards, press \"Still not working\" and a technician will take over.",
    ]);
}

/** The reply when something was found that only a technician can deal with, so the person knows it was seen. */
export function escalationReply(found: IssueDef[]): string {
    return tidy([
        `We looked at your computer and found that ${found.map((i) => i.plain).join(", and ")}.`,
        "This needs a technician, who has been given what we found and will follow up.",
    ]);
}

/** The internal note for technicians: what the automatic checks saw and did. */
export function technicianNote(parts: { app: string | null; category: string | null; checks: string[]; diagnosis: Diagnosis | null; repairs?: RepairLine[]; outcome: string }): string {
    const lines = [
        "Automatic checks and repair",
        parts.category || parts.app ? `They said: ${[parts.category, parts.app].filter(Boolean).join(", ")}.` : "",
        parts.checks.length ? `Checked: ${parts.checks.join(", ")}.` : "",
    ];
    const d = parts.diagnosis;
    if (d) {
        const info = Object.entries(d.info).filter(([k]) => k !== "host").map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
        if (info.length) lines.push(`Seen: ${info.join("; ")}.`);
        lines.push(d.issues.length ? `Found: ${d.issues.map((i) => `${ISSUES[i.id].title} (${i.detail})`).join("; ")}.` : "No known problem was found.");
    }
    for (const r of parts.repairs ?? []) lines.push(`Repair ${r.id}: ${r.ok ? "worked" : "did not work"}: ${r.message}`);
    lines.push(parts.outcome);
    return lines.filter(Boolean).join("\n");
}

/** The KB article for a problem a repair fixed. */
export function kbArticle(issue: IssueDef, appName: string | null): { title: string; body: string; tags: string[] } {
    const body = tidy([
        `# ${issue.title}`,
        "",
        "## What it looks like",
        issue.signs,
        "",
        "## What was found",
        `The automatic checks recognised this problem: ${issue.plain}.`,
        "",
        "## Known fix",
        issue.fix || (issue.advice ?? ""),
        appName && appName !== NO_APPLICATION ? `\nFirst seen with: ${appName}.` : "",
        "",
        "## If it comes back",
        issue.ifItReturns,
        "",
        "This article was written automatically the first time the automatic repair fixed this problem.",
    ]);
    return { title: issue.title, body, tags: ["auto-repair", kbTagOf(issue.id)] };
}

/** The tag that marks the KB article of a problem, so there is never a second one. */
export const kbTagOf = (id: IssueId) => `auto-repair-${id}`;

/* ------------------------------ the log technicians read on the ticket ------------------------------ */

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n... (${s.length - n} more characters not shown)` : s);

/** An internal note for the moment a script is sent to the computer: what it is for, how it runs, what it was given, and its full text. */
export function scriptStartNote(p: { step: string; purpose: string; jobId: string; language: string; env: Record<string, string>; script: string | null; scriptName: string }): string {
    const params = Object.entries(p.env).filter(([k]) => k !== "ADG_TOOL").map(([k, v]) => `${k}=${v === "" ? "(empty)" : v}`).join("; ") || "none";
    return [
        `Script sent to the computer: ${p.step}`,
        `Purpose: ${p.purpose}`,
        `Script: ${p.scriptName} (${p.language}), job ${p.jobId}. It runs on the computer as the ADG RMM agent, signed, with a time limit.`,
        `Given: ${params}`,
        p.script === null ? "Script text: the same as the first check above." : `Script text:\n${p.script.replace(/\s+$/, "")}`,
    ].join("\n");
}

/** An internal note for the moment a script has finished: how it ended and everything it printed. */
export function scriptResultNote(p: { step: string; jobId: string; status: string; exitCode: number | null; durationMs: string | null; startedAt: Date | null; finishedAt: Date | null; stdout: string; stderr: string }): string {
    const took = p.durationMs !== null && /^\d+$/.test(p.durationMs) ? `${(Number(p.durationMs) / 1000).toFixed(1)} s` : "unknown time";
    const when = p.finishedAt ? `finished ${p.finishedAt.toISOString().replace("T", " ").slice(0, 19)} UTC` : "";
    return [
        `Script result: ${p.step}`,
        `Job ${p.jobId}: ${p.status}${p.exitCode !== null ? `, exit code ${p.exitCode}` : ""}, took ${took}${when ? `, ${when}` : ""}.`,
        `Output:\n${p.stdout.trim() ? cap(p.stdout.trim(), 8000) : "(nothing)"}`,
        p.stderr.trim() ? `Errors:\n${cap(p.stderr.trim(), 2000)}` : "",
    ].filter(Boolean).join("\n");
}

/** What one computer may be repaired for: one repair of the same problem a day, and a few in all. */
export const SAME_ISSUE_PER_DAY = 1;
export const REPAIRS_PER_DEVICE_PER_DAY = 3;
/** A run that has not finished by now goes to a technician. */
export const RUN_LIMIT_MINUTES = 30;
/** An alert is healed only if it is this new: an old alert that has been sitting there is left for a person. */
export const HEAL_ALERT_WITHIN_MINUTES = 45;
