// backend/src/security/security.highlights.ts
//
// The short, readable summaries of a scan that the Security tab, the fleet table and the report show next to the score:
// what Defender is doing, the BitLocker state, the firewall and the Windows version. Pure functions of the checked probes.
import { avPicture } from "./security.baseline";
import { osSupport, type Probes } from "./security.scripts";

export type Tone = "good" | "warn" | "bad" | "unknown";
export type Label = { text: string; tone: Tone };

const ago = (d: number | null) => (d === null ? "never" : d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`);

export function defenderLabel(p: Probes): Label {
    const a = avPicture(p);
    if (!a.known) return { text: "Not read", tone: "unknown" };
    if (a.defenderActive) {
        const d = a.defender!;
        if (d.threatCount > 0) return { text: `Defender: ${d.threatCount} active ${d.threatCount === 1 ? "threat" : "threats"}`, tone: "bad" };
        if (!d.realTimeProtection) return { text: "Defender: real-time protection off", tone: "bad" };
        if (d.signatureAgeDays !== null && d.signatureAgeDays > 3) return { text: `Defender: definitions ${d.signatureAgeDays} days old`, tone: "warn" };
        return { text: `Defender on${d.signatureAgeDays !== null ? `, definitions ${ago(d.signatureAgeDays)}` : ""}`, tone: "good" };
    }
    if (a.othersOn.length) return { text: `${a.othersOn[0].name}${a.othersOn[0].upToDate === false ? " (definitions out of date)" : ""}`, tone: a.othersOn[0].upToDate === false ? "warn" : "good" };
    if (a.defenderPassive) return { text: "Defender passive (another product in charge)", tone: "good" };
    return { text: "No antivirus on", tone: "bad" };
}

export function bitlockerLabel(p: Probes): Label {
    if (p.bitlocker.status !== "ok") return { text: "Not read", tone: "unknown" };
    const b = p.bitlocker;
    if (!b.volumes.length) return { text: "No fixed drives reported", tone: "unknown" };
    const on = b.volumes.filter((v) => v.protection === "on").length;
    const off = b.volumes.filter((v) => v.protection === "off").length;
    const sys = b.volumes.find((v) => v.drive === (b.systemDrive || "C:"));
    if (off === 0 && on === b.volumes.length) return { text: b.volumes.length === 1 ? "On" : `On for all ${b.volumes.length} drives`, tone: "good" };
    if (sys && sys.protection === "off") return { text: on ? `System drive off, ${on} of ${b.volumes.length} drives on` : "Off", tone: "bad" };
    if (off > 0) return { text: `${on} of ${b.volumes.length} drives on`, tone: "warn" };
    return { text: "Not known", tone: "unknown" };
}

export function firewallLabel(p: Probes): Label {
    if (p.firewall.status !== "ok") return { text: "Not read", tone: "unknown" };
    const f = p.firewall;
    const known = [["Domain", f.domain], ["Private", f.private], ["Public", f.public]] as const;
    const off = known.filter(([, v]) => v === false).map(([n]) => n);
    const on = known.filter(([, v]) => v === true);
    if (!off.length) return { text: "On", tone: "good" };
    if (!on.length) return { text: "Off", tone: "bad" };
    return { text: `Off for ${off.join(", ")}`, tone: "warn" };
}

/** Everything the Security tab shows besides the rules. */
export function highlights(p: Probes, now: Date = new Date()) {
    const a = avPicture(p);
    const sys = p.os.status === "ok" ? osSupport(p.os, now) : null;
    return {
        defender: {
            label: defenderLabel(p),
            read: p.defender.status === "ok",
            serviceState: p.defender.status === "ok" ? p.defender.serviceState : null,
            runningMode: p.defender.status === "ok" ? p.defender.runningMode : null,
            realTimeProtection: p.defender.status === "ok" ? p.defender.realTimeProtection : null,
            tamperProtected: p.defender.status === "ok" ? p.defender.tamperProtected : null,
            signatureVersion: p.defender.status === "ok" ? p.defender.signatureVersion : null,
            signatureAgeDays: p.defender.status === "ok" ? p.defender.signatureAgeDays : null,
            lastQuickScanDays: p.defender.status === "ok" ? p.defender.quickScanAgeDays : null,
            lastFullScanDays: p.defender.status === "ok" ? p.defender.fullScanAgeDays : null,
            threatCount: p.defender.status === "ok" ? p.defender.threatCount : null,
            threats: p.defender.status === "ok" ? p.defender.threats : [],
            reason: p.defender.status === "unknown" ? p.defender.reason : null,
            otherProducts: a.others,
            exclusions: p.defenderExclusions && p.defenderExclusions.status === "ok" ? { total: p.defenderExclusions.paths + p.defenderExclusions.extensions + p.defenderExclusions.processes, broad: p.defenderExclusions.broad } : null,
        },
        bitlocker: {
            label: bitlockerLabel(p),
            detail: p.bitlocker.status === "ok" ? p.bitlocker.detail : false,
            volumes: p.bitlocker.status === "ok" ? p.bitlocker.volumes : [],
            systemDrive: p.bitlocker.status === "ok" ? p.bitlocker.systemDrive : null,
            note: p.bitlocker.status === "ok" ? p.bitlocker.note : p.bitlocker.reason,
        },
        firewall: {
            label: firewallLabel(p),
            profiles: p.firewall.status === "ok" ? { domain: p.firewall.domain, private: p.firewall.private, public: p.firewall.public } : null,
        },
        os: p.os.status === "ok"
            ? { name: p.os.productName, displayVersion: p.os.displayVersion, build: p.os.build, ubr: p.os.ubr, edition: p.os.editionId, support: sys }
            : null,
        tpm: p.tpm.status === "ok" ? { present: p.tpm.present, ready: p.tpm.ready } : null,
        secureBoot: p.secureBoot.status === "ok" ? { supported: p.secureBoot.supported, enabled: p.secureBoot.enabled } : null,
        accounts: p.accounts.status === "ok" ? { adminCount: p.accounts.adminCount, adminNames: p.accounts.adminNames, builtinAdminEnabled: p.accounts.builtinAdminEnabled, guestEnabled: p.accounts.guestEnabled } : null,
        restartPending: p.reboot.status === "ok" ? p.reboot.pending : null,
        lastUpdate: p.lastUpdate.status === "ok" ? { at: p.lastUpdate.at, ageDays: p.lastUpdate.ageDays } : null,
        /** The checks the device could not read, with its own reason, so the page can say why. */
        unreadable: (Object.keys(p) as (keyof Probes)[]).flatMap((k) => (p[k].status === "unknown" ? [{ probe: k as string, reason: (p[k] as { reason: string }).reason }] : [])),
    };
}
