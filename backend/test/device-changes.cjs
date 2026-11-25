// What changed on a device between two reports: software and hardware. No database needed.
const path = require("node:path");
const { diffSoftware, diffDevice } = require(path.resolve(process.cwd(), "dist/agents/device-changes.js"));
const { parseRisk, parseThreats } = require(path.resolve(process.cwd(), "dist/reports/device-data.js"));

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const GB = 1024 ** 3;
const kinds = (c) => c.map((x) => x.kind).sort().join();

// software
let c = diffSoftware([{ name: "Chrome", version: "1" }], [{ name: "Chrome", version: "1" }]);
check("no change gives no entries", c.length === 0, c);
c = diffSoftware([{ name: "Chrome", version: "1" }], [{ name: "Chrome", version: "2" }]);
check("a new version is one update, not an install and a removal", c.length === 1 && c[0].kind === "software_updated" && c[0].summary === "Updated Chrome from 1 to 2", c);
c = diffSoftware([{ name: "Chrome", version: "1" }], [{ name: "Chrome", version: "1" }, { name: "Zoom", version: "5" }]);
check("a new program is an install", c.length === 1 && c[0].kind === "software_added" && c[0].summary === "Installed Zoom 5", c);
c = diffSoftware([{ name: "Chrome", version: "1" }, { name: "Skype", version: null }], [{ name: "Chrome", version: "1" }]);
check("a program that is gone is a removal, with no version when there was none", c.length === 1 && c[0].kind === "software_removed" && c[0].summary === "Removed Skype", c);
c = diffSoftware([{ name: "chrome", version: "1" }], [{ name: "Chrome", version: "1" }]);
check("names match whatever the capitals", c.length === 0, c);
c = diffSoftware([{ name: "VC++ Redist", version: "14" }], [{ name: "VC++ Redist", version: "14" }, { name: "VC++ Redist", version: "15" }]);
check("a second build with the same name is an install, not an update", kinds(c) === "software_added", c);
c = diffSoftware([], [{ name: "A", version: "1" }, { name: "B", version: "1" }]);
check("from nothing, everything is added", c.length === 2);

// hardware and Windows
const dev = (over = {}) => ({ hardware: { cpu: "i5", model: "Dell", ramBytes: 8 * GB }, disks: [{ mount: "C:", totalBytes: 500 * GB }], os: { name: "Windows 10 Pro", displayVersion: "22H2" }, ...over });
check("identical reports give no changes", diffDevice(dev(), dev()).length === 0);
check("no earlier report is not a change", diffDevice(null, dev()).length === 0 && diffDevice({}, dev()).length === 0);
c = diffDevice(dev(), dev({ hardware: { cpu: "i5", model: "Dell", ramBytes: 16 * GB } }));
check("more memory is noticed", c.length === 1 && c[0].kind === "hardware" && c[0].summary === "Memory changed from 8 GB to 16 GB", c);
c = diffDevice(dev(), dev({ hardware: { cpu: "i5", model: "Dell", ramBytes: 8.01 * GB } }));
check("rounding in the reported memory is not a change", c.length === 0, c);
c = diffDevice(dev(), dev({ disks: [{ mount: "C:", totalBytes: 500 * GB }, { mount: "D:", totalBytes: 1000 * GB }] }));
check("a new drive is noticed", c.length === 1 && /Drive D: added/.test(c[0].summary), c);
c = diffDevice(dev({ disks: [{ mount: "C:", totalBytes: 500 * GB }, { mount: "D:", totalBytes: 1000 * GB }] }), dev());
check("a missing drive is noticed", c.length === 1 && /Drive D: removed/.test(c[0].summary), c);
c = diffDevice(dev(), dev({ disks: [{ mount: "C:", totalBytes: 1000 * GB }] }));
check("a bigger drive is noticed", c.length === 1 && /size changed from 500 GB to 1000 GB/.test(c[0].summary), c);
c = diffDevice(dev(), dev({ disks: [] }));
check("a report with no disks at all is not treated as every drive being removed", c.length === 0, c);
c = diffDevice(dev(), dev({ os: { name: "Windows 10 Pro", displayVersion: "23H2" } }));
check("a Windows feature update is noticed", c.length === 1 && c[0].kind === "os" && /updated from 22H2 to 23H2/.test(c[0].summary), c);
c = diffDevice(dev(), dev({ os: { name: "Windows 11 Pro", displayVersion: "23H2" } }));
check("a new Windows edition is noticed", c.length === 1 && /changed from Windows 10 Pro to Windows 11 Pro/.test(c[0].summary), c);
c = diffDevice(dev(), dev({ hardware: { cpu: "i7", model: "Dell", ramBytes: 8 * GB } }));
check("a new processor is noticed", c.length === 1 && /Processor changed from i5 to i7/.test(c[0].summary), c);

// the risk facts
check("no risk data is null, not all clear", parseRisk({ device: {} }) === null && parseRisk({}) === null && parseRisk(null) === null);
const risk = parseRisk({ device: { risk: { rdp: { enabled: true, nla: false }, smb1Enabled: true, autoLogon: false, uacEnabled: true, guestEnabled: false, localAdmins: ["a", "b", ""], passwordPolicy: { minLength: 7, lockoutThreshold: 0 }, screenLockMinutes: 20 } } });
check("risk data is read field by field", risk.rdpEnabled === true && risk.rdpNla === false && risk.smb1Enabled === true && risk.autoLogon === false && risk.localAdmins.join() === "a,b" && risk.minPasswordLength === 7 && risk.lockoutThreshold === 0 && risk.screenLockMinutes === 20, risk);
const partial = parseRisk({ device: { risk: { uacEnabled: false } } });
check("fields that were not sent stay unknown", partial.uacEnabled === false && partial.rdpEnabled === null && partial.localAdmins === null && partial.minPasswordLength === null, partial);

// antivirus threats
check("no threat data is null, not clean", parseThreats({ device: {} }) === null && parseThreats(null) === null && parseThreats({ device: { threats: {} } }) === null);
const th = parseThreats({ device: { threats: { readAt: "2026-11-10T00:00:00Z", activeCount: 1, items: [{ name: "Trojan:X", severity: "severe", detectedAt: "2026-11-09T10:00:00Z", status: "active", action: "No action", resource: "C:\\x.exe", user: "bob" }, { name: "", detectedAt: "2026-11-09T10:00:00Z" }, { name: "NoDate" }, { name: "Odd", severity: "weird", detectedAt: "2026-11-08T10:00:00Z" }] } } });
check("threats are read, and entries without a name or a date are dropped", th.items.length === 2 && th.activeCount === 1 && th.items[0].name === "Trojan:X" && th.items[0].severity === "severe" && th.items[0].resource === "C:\\x.exe", th);
check("an unknown severity is kept as unknown, and a missing status as unknown", th.items[1].severity === null && th.items[1].status === "unknown", th.items[1]);
check("an empty list of threats is a clean report, not a missing one", parseThreats({ device: { threats: { readAt: "2026-11-10T00:00:00Z", activeCount: 0, items: [] } } }).items.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
