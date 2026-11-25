// Reading the agent's health facts, and judging them. Plain data in, answers out: no database.
"use strict";

const path = require("node:path");
const d = require(path.resolve(process.cwd(), "dist/reports/device-data.js"));

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}

// exactly the shape the 1.3.26 agent sends (taken from a real machine)
const real = {
    os: "windows",
    device: {
        os: { name: "Windows 11 Pro", edition: "Professional", version: "10.0.26200", displayVersion: "25H2", build: "26200", buildRevision: "26200.8973", architecture: "64-bit" },
        boot: { lastBootAt: "2026-11-09T14:39:01.5-05:00", pendingReboot: true, pendingRebootReasons: ["Pending file changes"] },
        bios: { vendor: "American Megatrends Inc.", version: "1413", releaseDate: "2023-04-25" },
        security: {
            antivirus: [{ name: "Windows Defender", state: "on", upToDate: true }],
            defender: { serviceEnabled: true, antivirusEnabled: true, realTimeProtection: true, signatureAgeDays: 0, quickScanAgeDays: 0, tamperProtected: false },
            firewall: { domain: false, private: true, public: true },
            bitLocker: [{ mount: "c:", protection: "on", status: "encrypted" }, { mount: "D:", protection: "off", status: "decrypted" }],
            tpm: { present: true, enabled: true, activated: true, version: "2.0" },
            secureBoot: true,
        },
        network: [{ description: "Wi-Fi", mac: "C8:94:02:70:7E:35", ipv4: ["192.168.4.90"], gateway: "192.168.4.1", dhcp: true }],
    },
};

const h = d.parseDeviceHealth(real);
check("the OS is read", h.osName === "Windows 11 Pro" && h.osVersion === "25H2" && h.osBuild === "26200.8973", h);
check("the build revision wins over the plain build", d.parseDeviceHealth({ device: { os: { build: "22631" } } }).osBuild === "22631");
check("the last boot and the restart notes are read", h.lastBootAt instanceof Date && h.pendingReboot === true && h.pendingRebootReasons[0] === "Pending file changes", h);
check("the firmware date is read", h.biosDate === "2023-04-25" && h.biosVendor === "American Megatrends Inc.");
check("antivirus is read", h.antivirus.length === 1 && h.antivirus[0].state === "on" && h.antivirus[0].upToDate === true);
check("firewall profiles are read", h.firewall.private === true && h.firewall.domain === false);
check("BitLocker drive letters are upper-cased", h.bitlocker[0].mount === "C:" && h.bitlocker[0].protection === "on");
check("the TPM is read", h.tpm.present === true && h.tpm.version === "2.0");
check("Secure Boot and the adapters are read", h.secureBoot === true && h.nics[0].ipv4[0] === "192.168.4.90" && h.nics[0].gateway === "192.168.4.1");

// ---- an older agent, or junk, never crashes
for (const [name, facts] of [["nothing", undefined], ["null", null], ["a string", "x"], ["an array", []], ["no device", { os: "windows" }], ["a device of the wrong type", { device: "x" }]]) {
    const e = d.parseDeviceHealth(facts);
    check(`${name} reads as nothing known`, e.osName === null && e.antivirus === null && e.bitlocker === null && e.tpm === null && e.firewall === null && e.nics.length === 0 && e.lastBootAt === null && e.pendingReboot === null);
}
const junk = d.parseDeviceHealth({ device: { os: { name: 5 }, boot: { lastBootAt: "not a date", pendingReboot: "yes", pendingRebootReasons: [1, "ok"] }, bios: { releaseDate: "2023" }, security: { antivirus: [{ name: "" }, "x", { name: "Real", state: "weird" }], bitLocker: [{ protection: "on" }], firewall: {}, tpm: {} }, network: [null, { ipv4: ["1.1.1.1", 5] }] } });
check("wrong types are ignored, not trusted", junk.osName === null && junk.lastBootAt === null && junk.pendingReboot === null && junk.pendingRebootReasons.join() === "ok" && junk.biosDate === null, junk);
check("an unknown antivirus state is kept as unknown", junk.antivirus.length === 1 && junk.antivirus[0].state === "unknown");
check("an encryption entry with no drive is dropped", junk.bitlocker.length === 0);
check("an empty firewall or TPM block is nothing", junk.firewall === null && junk.tpm === null);
check("only text addresses are kept", junk.nics[1].ipv4.join() === "1.1.1.1");

// ---- age and uptime
const now = Date.UTC(2026, 10, 10);
check("age comes from the firmware date", d.ageYears("2023-04-25", now) === 3.5, d.ageYears("2023-04-25", now));
check("a placeholder date is not an age", d.ageYears("1970-01-01", now) === null && d.ageYears("2000-06-01", now) === null);
check("a date in the future is not an age", d.ageYears("2030-01-01", now) === null);
check("no date, no age", d.ageYears(null, now) === null);
check("uptime in whole days", d.uptimeDays(new Date(now - 45.9 * 86_400_000), now) === 45);
check("no boot time, no uptime", d.uptimeDays(null, now) === null);

// ---- antivirus verdicts
const base = (over) => ({ ...d.parseDeviceHealth({}), ...over });
check("Defender on and current is fine", d.avVerdict(base({ antivirus: [{ name: "Windows Defender", state: "on", upToDate: true }], defender: { realTimeProtection: true, signatureAgeDays: 1, enabled: true } }), 7).state === "ok");
check("nothing switched on is a problem", d.avVerdict(base({ antivirus: [{ name: "Windows Defender", state: "off", upToDate: true }] }), 7).state === "off");
check("a snoozed product is called out", /snoozed/i.test(d.avVerdict(base({ antivirus: [{ name: "X", state: "snoozed", upToDate: true }] }), 7).text));
check("out-of-date definitions are flagged", d.avVerdict(base({ antivirus: [{ name: "Sophos", state: "on", upToDate: false }] }), 7).state === "old");
check("Defender definitions older than the limit are flagged", d.avVerdict(base({ antivirus: [{ name: "Windows Defender", state: "on", upToDate: true }], defender: { realTimeProtection: true, signatureAgeDays: 12, enabled: true } }), 7).state === "old");
check("the limit can be loosened", d.avVerdict(base({ antivirus: [{ name: "Windows Defender", state: "on", upToDate: true }], defender: { realTimeProtection: true, signatureAgeDays: 12, enabled: true } }), 30).state === "ok");
check("real-time protection off on Defender is flagged", d.avVerdict(base({ antivirus: [{ name: "Windows Defender", state: "on", upToDate: true }], defender: { realTimeProtection: false, signatureAgeDays: 0, enabled: true } }), 7).state === "off");
check("another product on beside a quiet Defender is fine", d.avVerdict(base({ antivirus: [{ name: "Windows Defender", state: "off", upToDate: true }, { name: "Sophos", state: "on", upToDate: true }] }), 7).state === "ok");
check("a server with only Defender is judged on Defender", d.avVerdict(base({ defender: { realTimeProtection: true, signatureAgeDays: 2, enabled: true } }), 7).state === "ok" && d.avVerdict(base({ defender: { realTimeProtection: false, signatureAgeDays: 2, enabled: true } }), 7).state === "off");
check("nothing known is unknown, not a failure", d.avVerdict(base({}), 7).state === "unknown");

// ---- firewall and encryption
check("firewall lists private and public that are off", d.firewallOff(base({ firewall: { domain: false, private: false, public: false } })).join() === "Private,Public");
check("a domain profile that is off is not flagged", d.firewallOff(base({ firewall: { domain: false, private: true, public: true } })).length === 0);
check("no firewall data flags nothing", d.firewallOff(base({})).length === 0);
check("the system drive decides encryption", d.encryptionVerdict(h).state === "protected");
check("an unencrypted system drive is flagged", d.encryptionVerdict(base({ bitlocker: [{ mount: "C:", protection: "off", status: "decrypted" }] })).state === "unprotected");
check("a data drive being off does not count against a protected system drive", d.encryptionVerdict(base({ bitlocker: [{ mount: "D:", protection: "off", status: null }, { mount: "C:", protection: "on", status: null }] })).state === "protected");
check("no BitLocker data is unknown", d.encryptionVerdict(base({})).state === "unknown" && d.encryptionVerdict(base({ bitlocker: [] })).state === "unknown");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
