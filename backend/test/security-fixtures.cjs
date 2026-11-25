// Shared by the security tests: what the security scan script prints for a healthy Windows 11 PC, and ways to make it worse.
// The shape is exactly what scripts print (status and ms on every probe), so the parser is tested on realistic text.
"use strict";

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");

/** A healthy, fully read PC. `over` replaces whole probes (deep merge is left to the callers: pass the probe you want). */
function healthy(over = {}) {
    const probes = {
        os: { status: "ok", ms: 12, productName: "Windows 10 Pro", displayVersion: "25H2", build: 26200, ubr: 8973, editionId: "Professional", installationType: "Client" },
        defender: {
            status: "ok", ms: 700, serviceState: "Running", antivirusEnabled: true, realTimeProtection: true, tamperProtected: true, runningMode: "Normal", productVersion: "4.18.26100.4",
            signatureVersion: "1.463.324.0", signatureUpdated: iso(1), signatureAgeDays: 1, quickScanAt: iso(3), quickScanAgeDays: 3, fullScanAt: iso(8), fullScanAgeDays: 8,
            threatCount: 0, threats: [],
        },
        defenderExclusions: { status: "ok", ms: 60, paths: 2, extensions: 0, processes: 0, broad: [] },
        securityCenter: { status: "ok", ms: 90, products: [{ name: "Windows Defender", state: 397568 }] },
        bitlocker: {
            status: "ok", ms: 400, detail: true, systemDrive: "C:",
            volumes: [{ drive: "C:", protection: "on", percent: 100, method: "XtsAes128", state: "Encrypted", protectors: ["TPM", "RecoveryPassword"] }],
        },
        firewall: { status: "ok", ms: 20, domain: true, private: true, public: true, serviceState: "Running" },
        uac: { status: "ok", ms: 3, enabled: true, adminPrompt: 5, secureDesktop: true },
        secureBoot: { status: "ok", ms: 2, supported: true, enabled: true },
        tpm: { status: "ok", ms: 80, present: true, ready: true, enabled: true, activated: true },
        autoLogon: { status: "ok", ms: 8, enabled: false, user: "" },
        accounts: { status: "ok", ms: 100, builtinAdminEnabled: false, builtinAdminName: "Administrator", guestEnabled: false, adminCount: 2, adminNames: ["PC1\\Administrator", "PC1\\ann"] },
        smb1: { status: "ok", ms: 300, enabled: false, source: "smb" },
        rdp: { status: "ok", ms: 8, enabled: false, nlaRequired: true },
        screenLock: { status: "ok", ms: 10, inactivityTimeoutSecs: 600, users: [] },
        passwordPolicy: { status: "ok", ms: 60, minLength: 12, maxAgeDays: 90, historyCount: 5, lockoutThreshold: 5, lockoutMinutes: 15 },
        reboot: { status: "ok", ms: 8, pending: false, servicing: false, windowsUpdate: false, fileRename: false },
        lastUpdate: { status: "ok", ms: 50, at: iso(10), ageDays: 10 },
    };
    return { ok: true, v: 1, ms: 2100, probes: { ...probes, ...over } };
}

const unknown = (reason = "Access denied", ms = 50) => ({ status: "unknown", reason, ms });
const text = (obj) => JSON.stringify(obj);

module.exports = { healthy, unknown, text, iso };
