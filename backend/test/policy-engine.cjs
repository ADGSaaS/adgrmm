// The rules for combining policies, with no database: who wins, what is blocked, what is left out, and why.
"use strict";

const path = require("node:path");
require("reflect-metadata");
const E = require(path.resolve(process.cwd(), "dist/policies/policy-engine.js"));

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message ?? e)); } };

const dev = { deviceId: "d1", clientId: "c1", siteId: "s1", os: "windows" };
let n = 0;
const pol = (name, assign, sections, o = {}) => ({
    id: `p${++n}`, name, enabled: true, priority: 100, os: "any", enforced: false, sections,
    assignments: assign.map((a) => (typeof a === "string" ? { level: a, targetId: a === "global" ? null : a === "customer" ? "c1" : a === "site" ? "s1" : "d1", exclude: false } : a)),
    ...o,
});
const alert = (m) => ({ alerting: { offlineAfterMinutes: m } });
const val = (e, k = "alerting.offlineAfterMinutes") => e.scalars[k]?.value;
const src = (e, k = "alerting.offlineAfterMinutes") => e.scalars[k]?.source;
const baseline = { scalars: { "alerting.offlineAfterMinutes": { value: 15, label: "Alert settings" }, "remote.consent": { value: "notice", label: "Remote access notice" } }, lists: { "software.required": [{ item: "Old AV", label: "Software policies (everyone)" }] } };

// ---- nothing applies
let e = E.resolve(dev, [], baseline);
check("with no policies a device gets the old settings", val(e) === 15 && src(e).kind === "default" && src(e).label === "Alert settings", e.scalars);
check("and nothing is applied or skipped", e.applied.length === 0 && e.skipped.length === 0);
e = E.resolve(dev, [pol("Other customer", [{ level: "customer", targetId: "c9", exclude: false }], alert(5))], baseline);
check("a policy for someone else changes nothing", val(e) === 15 && e.applied.length === 0);

// ---- most specific wins
const all = pol("All", ["global"], alert(30));
const cust = pol("Customer", ["customer"], alert(20));
const site = pol("Site", ["site"], alert(10));
const one = pol("Device", ["device"], alert(5));
e = E.resolve(dev, [one, all, site, cust], baseline);
check("the most specific policy wins", val(e) === 5 && src(e).name === "Device" && src(e).level === "device", e.scalars);
check("it remembers what it replaced, newest first", e.scalars["alerting.offlineAfterMinutes"].overrode.map((o) => o.value).join() === "10,20,30,15", e.scalars["alerting.offlineAfterMinutes"].overrode);
check("applied lists broadest first", e.applied.map((a) => a.name).join() === "All,Customer,Site,Device", e.applied);
check("a site beats a customer", val(E.resolve(dev, [cust, site], baseline)) === 10);
check("a customer beats everyone", val(E.resolve(dev, [all, cust], baseline)) === 20);

// ---- priority within a level
const lo = pol("Low number", ["customer"], alert(11), { priority: 10 });
const hi = pol("High number", ["customer"], alert(22), { priority: 200 });
check("at one level a lower priority number wins", val(E.resolve(dev, [hi, lo], baseline)) === 11);
check("whatever order they are listed in", val(E.resolve(dev, [lo, hi], baseline)) === 11);
const t1 = pol("Tie A", ["customer"], alert(1), { id: "aaa" });
const t2 = pol("Tie B", ["customer"], alert(2), { id: "bbb" });
check("a tie is settled the same way every time", val(E.resolve(dev, [t1, t2], baseline)) === val(E.resolve(dev, [t2, t1], baseline)));

// ---- settings only apply when the policy says something
const hoursOnly = pol("Hours only", ["customer"], { hours: { days: [1], start: "09:00", end: "17:00", timezone: "UTC" } });
e = E.resolve(dev, [hoursOnly], baseline);
check("a policy that is silent on a setting leaves it alone", val(e) === 15 && e.scalars.hours.source.name === "Hours only");

// ---- enforced
const base = pol("Baseline", ["global"], alert(15), { enforced: true });
e = E.resolve(dev, [base, cust], baseline);
check("an enforced policy cannot be overridden by a more specific one", val(e) === 15 && src(e).name === "Baseline", e.scalars);
check("the blocked attempt is recorded", e.scalars["alerting.offlineAfterMinutes"].blocked.length === 1 && e.scalars["alerting.offlineAfterMinutes"].blocked[0].value === 20 && e.scalars["alerting.offlineAfterMinutes"].blocked[0].source.name === "Customer");
check("a blocked policy still applies elsewhere", E.resolve(dev, [base, pol("Cust two", ["customer"], { remote: { consent: "consent" } })], baseline).scalars["remote.consent"].value === "consent");
const enfCust = pol("Customer enforced", ["customer"], alert(7), { enforced: true });
check("an enforced policy higher up beats an enforced one below it", val(E.resolve(dev, [base, enfCust], baseline)) === 15);
const enfSame = pol("Enforced same level", ["customer"], alert(9), { enforced: true });
const plainSame = pol("Plain same level", ["customer"], alert(3), { priority: 1 });
check("at one level enforced beats one that is not, even with a better priority", val(E.resolve(dev, [plainSame, enfSame], baseline)) === 9);
check("two enforced at one level fall back to priority", val(E.resolve(dev, [enfSame, pol("Enforced strong", ["customer"], alert(4), { enforced: true, priority: 1 })], baseline)) === 4);
check("an enforced policy beats the old settings", val(E.resolve(dev, [base], baseline)) === 15 && src(E.resolve(dev, [pol("B", ["global"], alert(40), { enforced: true })], baseline)).name === "B");

// ---- exclusions, switched off, system
const excl = pol("Dental", [{ level: "customer", targetId: "c1", exclude: false }, { level: "global", targetId: null, exclude: false }], alert(50));
excl.assignments.push({ level: "device", targetId: "d1", exclude: true });
e = E.resolve(dev, [excl], baseline);
check("a policy can be switched off for one device", e.applied.length === 0 && val(e) === 15);
check("and says why", e.skipped.length === 1 && /Switched off for this device/.test(e.skipped[0].reason), e.skipped);
const exclSite = pol("Exclude site", [{ level: "global", targetId: null, exclude: false }, { level: "site", targetId: "s1", exclude: true }], alert(50));
check("or for a site", E.resolve(dev, [exclSite], baseline).skipped.length === 1);
check("an exclusion elsewhere does not apply", E.resolve(dev, [pol("Other site off", [{ level: "global", targetId: null, exclude: false }, { level: "site", targetId: "s9", exclude: true }], alert(50))], baseline).applied.length === 1);
e = E.resolve(dev, [pol("Off", ["global"], alert(50), { enabled: false })], baseline);
check("a switched-off policy does nothing, and says so", val(e) === 15 && e.skipped[0].reason === "The policy is switched off", e.skipped);
e = E.resolve(dev, [pol("Linux only", ["global"], alert(50), { os: "linux" })], baseline);
check("an operating system filter skips other systems", val(e) === 15 && /linux devices only/.test(e.skipped[0].reason), e.skipped);
check("and applies to the right one", val(E.resolve({ ...dev, os: "linux" }, [pol("Linux only", ["global"], alert(50), { os: "linux" })], baseline)) === 50);
e = E.resolve({ ...dev, os: "unknown" }, [pol("Win", ["global"], alert(50), { os: "windows" })], baseline);
check("a device with an unknown system is skipped, with the reason", e.applied.length === 0 && /not known/.test(e.skipped[0].reason), e.skipped);
check("a policy for any system reaches an unknown one", E.resolve({ ...dev, os: "unknown" }, [pol("Any", ["global"], alert(50))], baseline).applied.length === 1);

// ---- a policy assigned twice counts at its most specific level
const twice = pol("Twice", ["global", "site"], alert(6));
e = E.resolve(dev, [twice, cust], baseline);
check("a policy assigned at two levels acts at the most specific", val(e) === 6 && e.applied.find((a) => a.name === "Twice").level === "site");

// ---- lists
const sw1 = pol("Everyone sw", ["global"], { software: { required: ["Antivirus X", "Backup Y"], banned: ["Torrent"] } });
const sw2 = pol("Customer sw", ["customer"], { software: { required: ["backup y", "PDF Z"] } });
e = E.resolve(dev, [sw1, sw2], baseline);
check("lists are added together", e.lists["software.required"].map((x) => x.value).join() === "Antivirus X,backup y,Old AV,PDF Z", e.lists["software.required"].map((x) => x.value));
check("the same entry is credited to the more specific policy", e.lists["software.required"].find((x) => x.value.toLowerCase() === "backup y").source.name === "Customer sw");
check("old settings are kept in the list", e.lists["software.required"].some((x) => x.value === "Old AV" && x.source.kind === "default"));
check("banned entries are kept", e.lists["software.banned"].map((x) => x.value).join() === "Torrent");

// ---- waive
const allow = pol("Allow torrent", ["customer"], { software: { waive: ["torrent", "Old AV"] } });
e = E.resolve(dev, [sw1, allow], baseline);
check("a more specific policy can allow something a broader one banned", e.lists["software.banned"].length === 0, e.lists["software.banned"]);
check("and drop an old requirement", !e.lists["software.required"].some((x) => x.value === "Old AV"));
check("what was removed is explained", e.removed.some((r) => r.item === "Torrent" && r.why === "allowed" && r.by.name === "Allow torrent" && r.was.name === "Everyone sw"), e.removed);
const strictBan = pol("Strict ban", ["global"], { software: { banned: ["Torrent"] } }, { enforced: true });
e = E.resolve(dev, [strictBan, allow], baseline);
check("an enforced ban cannot be allowed by a lower policy", e.lists["software.banned"].map((x) => x.value).join() === "Torrent" && e.lists["software.banned"][0].blocked.length === 1);
const readd = pol("Reads it", ["site"], { software: { banned: ["Torrent"] } });
check("a still more specific policy can add it back", E.resolve(dev, [sw1, allow, readd], baseline).lists["software.banned"].length === 1);

// ---- a ban beats a requirement
const both = pol("Both", ["customer"], { software: { required: ["Game"], banned: ["game"] } });
e = E.resolve(dev, [both], baseline);
check("something both required and banned is banned", !e.lists["software.required"].some((x) => x.value === "Game") && e.lists["software.banned"].some((x) => x.value === "game"), e.lists);
check("and the removal is explained", e.removed.some((r) => r.item === "Game" && r.why === "banned"));

// ---- checks list
e = E.resolve(dev, [pol("Servers", ["customer"], { checks: { profileIds: ["11111111-1111-4111-8111-111111111111"] } })], baseline);
check("check profiles come through as a list", E.valuesOf(e).list("checks.profiles").join() === "11111111-1111-4111-8111-111111111111");

// ---- hash and diff
const h1 = E.resolve(dev, [cust], baseline);
check("the hash is stable", E.resolve(dev, [cust], baseline).hash === h1.hash);
check("it does not depend on policy order", E.resolve(dev, [all, cust], baseline).hash === E.resolve(dev, [cust, all], baseline).hash);
check("it changes when a value changes", E.resolve(dev, [site], baseline).hash !== h1.hash);
check("it ignores which policy supplied the same value", E.resolve(dev, [pol("Same value", ["site"], alert(20))], baseline).hash === h1.hash);
const d = E.diffEffective(E.resolve(dev, [cust], baseline), E.resolve(dev, [cust, sw1], baseline));
check("the difference between two answers is listed by setting", d.map((x) => x.key).join() === "software.required,software.banned", d);
check("and is empty when nothing changed", E.diffEffective(h1, E.resolve(dev, [cust], baseline)).length === 0);
const rows = E.explain(E.resolve(dev, [cust, sw1], baseline));
check("the explanation is one row per setting and list entry", rows.some((r) => r.key === "alerting.offlineAfterMinutes" && r.source.name === "Customer") && rows.filter((r) => r.key === "software.required").length === 3, rows.map((r) => r.key + ":" + r.value));

// ---- what may be saved
const tz = (z) => { try { new Intl.DateTimeFormat("en", { timeZone: z }); return true; } catch { return false; } };
check("valid settings are accepted", JSON.stringify(E.cleanSections({ alerting: { offlineAfterMinutes: "20", autoTicket: true }, remote: { consent: "consent" }, hours: { days: [5, 1, 1], start: "08:00", end: "17:30", timezone: "America/Chicago" } }, tz)) === JSON.stringify({ alerting: { offlineAfterMinutes: 20, autoTicket: true }, hours: { days: [1, 5], start: "08:00", end: "17:30", timezone: "America/Chicago" }, remote: { consent: "consent" } }));
check("empty sections are dropped", Object.keys(E.cleanSections({ alerting: {}, software: { required: ["", "  "] }, checks: { profileIds: [] } }, tz)).length === 0);
check("an unknown section is refused", throws(() => E.cleanSections({ nonsense: {} }, tz), /do not know: nonsense/));
check("an unknown setting is refused", throws(() => E.cleanSections({ alerting: { shout: 1 } }, tz), /do not know: shout/));
check("minutes out of range are refused", throws(() => E.cleanSections({ alerting: { offlineAfterMinutes: 0 } }, tz), /Minutes offline/) && throws(() => E.cleanSections({ alerting: { offlineAfterMinutes: 5000 } }, tz), /Minutes offline/));
check("a fraction is refused", throws(() => E.cleanSections({ alerting: { offlineAfterMinutes: 2.5 } }, tz), /whole number/));
check("a bad severity is refused", throws(() => E.cleanSections({ alerting: { autoTicketMinSeverity: "LOUD" } }, tz), /WARN or CRIT/));
check("a non-boolean switch is refused", throws(() => E.cleanSections({ alerting: { autoTicket: "yes" } }, tz), /on or off/));
check("hours need a day", throws(() => E.cleanSections({ hours: { days: [], start: "08:00", end: "17:00", timezone: "UTC" } }, tz), /working day/));
check("hours need real times", throws(() => E.cleanSections({ hours: { days: [1], start: "8am", end: "17:00", timezone: "UTC" } }, tz), /Times must/));
check("hours need a real time zone", throws(() => E.cleanSections({ hours: { days: [1], start: "08:00", end: "17:00", timezone: "Mars/Base" } }, tz), /time zone/));
check("a bad remote access choice is refused", throws(() => E.cleanSections({ remote: { consent: "maybe" } }, tz), /off.*notice.*consent/));
check("software names are trimmed and repeats dropped", JSON.stringify(E.cleanSections({ software: { required: [" A ", "a", "B"] } }, tz).software.required) === JSON.stringify(["A", "B"]));
check("a software name that is too long is refused", throws(() => E.cleanSections({ software: { banned: ["x".repeat(101)] } }, tz), /too long/));
check("a bad check profile id is refused", throws(() => E.cleanSections({ checks: { profileIds: ["nope"] } }, tz), /not valid/));
check("a section that is not an object is refused", throws(() => E.cleanSections({ alerting: "fast" }, tz), /not valid/));

// ---- maintenance windows and patching
const T = require(path.resolve(process.cwd(), "dist/policies/time-window.js"));
const at = (iso) => Date.parse(iso);
const nightly = { name: "Nightly", days: [1, 2, 3, 4, 5], start: "02:00", end: "04:00", timezone: "UTC" };
check("a moment inside a window is inside", T.inWindow(at("2026-11-10T03:00:00Z"), nightly));
check("the start counts and the end does not", T.inWindow(at("2026-11-10T02:00:00Z"), nightly) && !T.inWindow(at("2026-11-10T04:00:00Z"), nightly));
check("a day that is not listed is outside (a Sunday)", !T.inWindow(at("2026-11-08T03:00:00Z"), nightly));
const overnight = { name: "Overnight", days: [5], start: "22:00", end: "06:00", timezone: "UTC" };
check("an overnight window belongs to the day it starts on", T.inWindow(at("2026-11-13T23:00:00Z"), overnight) && T.inWindow(at("2026-11-14T05:00:00Z"), overnight));
check("and ends in the morning", !T.inWindow(at("2026-11-14T06:00:00Z"), overnight) && !T.inWindow(at("2026-11-13T21:00:00Z"), overnight) && !T.inWindow(at("2026-11-15T05:00:00Z"), overnight));
check("the same start and end means the whole day", T.inWindow(at("2026-11-10T13:37:00Z"), { name: "All", days: [2], start: "00:00", end: "00:00", timezone: "UTC" }));
check("the time zone is respected", T.inWindow(at("2026-11-10T08:30:00Z"), { name: "Chicago", days: [2], start: "02:00", end: "03:00", timezone: "America/Chicago" }) && !T.inWindow(at("2026-11-10T03:30:00Z"), { name: "Chicago", days: [2], start: "02:00", end: "03:00", timezone: "America/Chicago" }));
check("the first open window is found among several", T.activeWindow([nightly, overnight], at("2026-11-13T23:00:00Z"))?.name === "Overnight" && T.activeWindow([nightly], at("2026-11-08T03:00:00Z")) === null);
const nx = T.nextWindowStart([nightly], at("2026-11-10T12:00:00Z"));
check("the next window start is found to the minute", nx && new Date(nx.at).toISOString() === "2026-11-11T02:00:00.000Z" && nx.window.name === "Nightly", nx && new Date(nx.at).toISOString());
check("it skips the weekend", new Date(T.nextWindowStart([nightly], at("2026-11-13T12:00:00Z")).at).toISOString() === "2026-11-16T02:00:00.000Z");
check("a window that is open now has no next start", T.nextWindowStart([nightly], at("2026-11-10T03:00:00Z")) === null);
check("no windows means no next start", T.nextWindowStart([], at("2026-11-10T03:00:00Z")) === null && T.nextWindowStart(undefined, 0) === null);
const odd = { name: "Odd", days: [2], start: "02:10", end: "02:50", timezone: "UTC" };
check("a start that is not on a quarter hour is still exact", new Date(T.nextWindowStart([odd], at("2026-11-10T01:00:00Z")).at).toISOString() === "2026-11-10T02:10:00.000Z");

const maint = (name, w) => pol(name, ["customer"], { maintenance: { windows: [w], muteAlerts: true } });
e = E.resolve(dev, [pol("Global windows", ["global"], { maintenance: { windows: [nightly], muteAlerts: true } }), maint("Customer windows", overnight)], baseline);
check("maintenance windows from the most specific policy replace broader ones", e.scalars.maintenance.value.windows[0].name === "Overnight" && e.scalars.maintenance.overrode.length === 1);
e = E.resolve(dev, [pol("Strict", ["global"], { maintenance: { windows: [nightly], muteAlerts: true } }, { enforced: true }), maint("Customer windows", overnight)], baseline);
check("an enforced window cannot be replaced", e.scalars.maintenance.value.windows[0].name === "Nightly" && e.scalars.maintenance.blocked.length === 1);
e = E.resolve(dev, [pol("Patch all", ["global"], { patching: { approve: "all", reboot: "maintenance" } }), pol("Patch customer", ["customer"], { patching: { approve: "critical" } })], { scalars: { "patching.approve": { value: "none", label: "Manual patching" }, "patching.reboot": { value: "never", label: "Manual patching" } }, lists: {} });
check("each patching setting merges on its own", e.scalars["patching.approve"].value === "critical" && e.scalars["patching.reboot"].value === "maintenance" && e.scalars["patching.approve"].overrode.length === 2);
check("with no policy the patching settings stay manual", E.resolve(dev, [], { scalars: { "patching.approve": { value: "none", label: "Manual patching" } }, lists: {} }).scalars["patching.approve"].source.kind === "default");
check("a patching change shows in the preview diff", E.diffEffective(E.resolve(dev, [], baseline), E.resolve(dev, [pol("P", ["global"], { patching: { approve: "all" } })], baseline)).some((d) => d.key === "patching.approve"));
check("sections for maintenance and patching are cleaned", JSON.stringify(E.cleanSections({ maintenance: { windows: [{ name: " Night ", days: [3, 1, 1], start: "02:00", end: "04:00", timezone: "UTC" }] }, patching: { approve: "critical", installIn: "maintenance", reboot: "never" } }, tz)) === JSON.stringify({ maintenance: { windows: [{ name: "Night", days: [1, 3], start: "02:00", end: "04:00", timezone: "UTC" }], muteAlerts: true }, patching: { approve: "critical", installIn: "maintenance", reboot: "never" } }));
check("a maintenance section with no windows is dropped", Object.keys(E.cleanSections({ maintenance: { windows: [] } }, tz)).length === 0);
check("21 windows are too many", throws(() => E.cleanSections({ maintenance: { windows: Array.from({ length: 21 }, (_, i) => ({ name: `w${i}`, days: [1], start: "01:00", end: "02:00", timezone: "UTC" })) } }, tz), /20 maintenance windows/));
check("an unknown patching setting is refused", throws(() => E.cleanSections({ patching: { speed: 1 } }, tz), /do not know: speed/));

// ---- security scan schedule (security.scanHours: 0 means never, default 24 from the baseline)
const secBase = { scalars: { "security.scanHours": { value: 24, label: "Default: a security scan every day" } }, lists: {} };
check("the security section is cleaned: 0, 6 and text digits are whole hours", JSON.stringify(E.cleanSections({ security: { scanHours: 6 } }, tz)) === JSON.stringify({ security: { scanHours: 6 } }) && E.cleanSections({ security: { scanHours: 0 } }, tz).security.scanHours === 0 && E.cleanSections({ security: { scanHours: "12" } }, tz).security.scanHours === 12);
check("an empty security section is dropped", Object.keys(E.cleanSections({ security: {} }, tz)).length === 0 && Object.keys(E.cleanSections({ security: { scanHours: null } }, tz)).length === 0);
check("security scan hours must be a whole number from 0 to 720", throws(() => E.cleanSections({ security: { scanHours: 721 } }, tz), /whole number from 0 to 720/) && throws(() => E.cleanSections({ security: { scanHours: -1 } }, tz), /whole number from 0 to 720/) && throws(() => E.cleanSections({ security: { scanHours: 2.5 } }, tz), /whole number/) && throws(() => E.cleanSections({ security: { scanHours: "x" } }, tz), /whole number/));
check("an unknown security setting is refused, and so is a security section that is not an object", throws(() => E.cleanSections({ security: { disableDefender: true } }, tz), /do not know: disableDefender/) && throws(() => E.cleanSections({ security: [1] }, tz), /Security is not valid/));
check("with no policy the security scan keeps the baseline's every 24 hours", val(E.resolve(dev, [], secBase), "security.scanHours") === 24 && src(E.resolve(dev, [], secBase), "security.scanHours").kind === "default");
e = E.resolve(dev, [pol("Scan often", ["global"], { security: { scanHours: 6 } }), pol("Never here", ["customer"], { security: { scanHours: 0 } })], secBase);
check("the most specific policy wins for the scan hours, and 0 (never) really wins over 6", val(e, "security.scanHours") === 0 && e.scalars["security.scanHours"].overrode.length === 2 && src(e, "security.scanHours").name === "Never here");
check("a security change shows in the preview diff and has a readable label", E.diffEffective(E.resolve(dev, [], secBase), E.resolve(dev, [pol("P", ["global"], { security: { scanHours: 12 } })], secBase)).some((d) => d.key === "security.scanHours") && E.SETTING_LABEL["security.scanHours"] === "Security scan every (hours)" && E.SCALAR_KEYS.includes("security.scanHours"));

// ---- device secrets (stage 2): security.bitlockerEscrow and the laps section; everything defaults OFF
const vaultBase = { scalars: { "security.bitlockerEscrow": { value: "off", label: "Default: recovery keys are not stored" }, "laps.enabled": { value: false, label: "Default" }, "laps.account": { value: "adg-admin", label: "Default account name" }, "laps.passwordLength": { value: 20, label: "d" }, "laps.rotateDays": { value: 30, label: "d" }, "laps.rotateAfterRevealMinutes": { value: 60, label: "d" } }, lists: {} };
check("escrow and laps are cleaned: off/on, booleans, whole numbers, and kept next to scanHours", JSON.stringify(E.cleanSections({ security: { scanHours: 6, bitlockerEscrow: "on" }, laps: { enabled: true, account: " adg-admin ", passwordLength: "24", rotateDays: 7, rotateAfterRevealMinutes: 0 } }, tz)) === JSON.stringify({ security: { scanHours: 6, bitlockerEscrow: "on" }, laps: { enabled: true, account: "adg-admin", passwordLength: 24, rotateDays: 7, rotateAfterRevealMinutes: 0 } }));
check("an empty laps section is dropped", Object.keys(E.cleanSections({ laps: {} }, tz)).length === 0 && Object.keys(E.cleanSections({ laps: { enabled: null } }, tz)).length === 0);
check("escrow must be exactly off or on", throws(() => E.cleanSections({ security: { bitlockerEscrow: "yes" } }, tz), /off.*on/) && throws(() => E.cleanSections({ security: { bitlockerEscrow: true } }, tz), /off.*on/) && throws(() => E.cleanSections({ security: { bitlockerEscrow: "ON" } }, tz), /off.*on/));
check("laps account: 1 to 20 of A-Za-z0-9._- and not reserved (Administrator, Guest, DefaultAccount, SYSTEM, any case)", ["a", "My.Admin_01-x", "x".repeat(20)].every((a) => E.cleanSections({ laps: { account: a } }, tz).laps.account === a) && ["", " ", "a".repeat(21), "bad name", "a;b", "a\\b", "\u00e9", "a/b", "a\"b"].every((a) => throws(() => E.cleanSections({ laps: { account: a } }, tz), /1 to 20/)) && ["Administrator", "ADMINISTRATOR", "guest", "DefaultAccount", "system", "SYSTEM", "WDAGUtilityAccount", "krbtgt"].every((a) => throws(() => E.cleanSections({ laps: { account: a } }, tz), /reserved/)) && throws(() => E.cleanSections({ laps: { account: 5 } }, tz), /1 to 20/));
check("laps ranges: length 14..64, days 1..365, reveal minutes 0..10080, enabled boolean only", E.cleanSections({ laps: { passwordLength: 14 } }, tz).laps.passwordLength === 14 && E.cleanSections({ laps: { passwordLength: 64 } }, tz).laps.passwordLength === 64 && throws(() => E.cleanSections({ laps: { passwordLength: 13 } }, tz), /14 to 64/) && throws(() => E.cleanSections({ laps: { passwordLength: 65 } }, tz), /14 to 64/) && E.cleanSections({ laps: { rotateDays: 1 } }, tz).laps.rotateDays === 1 && E.cleanSections({ laps: { rotateDays: 365 } }, tz).laps.rotateDays === 365 && throws(() => E.cleanSections({ laps: { rotateDays: 0 } }, tz), /1 to 365/) && throws(() => E.cleanSections({ laps: { rotateDays: 366 } }, tz), /1 to 365/) && E.cleanSections({ laps: { rotateAfterRevealMinutes: 0 } }, tz).laps.rotateAfterRevealMinutes === 0 && throws(() => E.cleanSections({ laps: { rotateAfterRevealMinutes: -1 } }, tz), /0 to 10080/) && throws(() => E.cleanSections({ laps: { rotateAfterRevealMinutes: 10081 } }, tz), /0 to 10080/) && throws(() => E.cleanSections({ laps: { enabled: "true" } }, tz), /on or off/) && throws(() => E.cleanSections({ laps: { enabled: 1 } }, tz), /on or off/) && throws(() => E.cleanSections({ laps: { rotateDays: 2.5 } }, tz), /whole number/) && throws(() => E.cleanSections({ laps: { unknown: 1 } }, tz), /do not know/));
const vEff = E.resolve(dev, [], vaultBase);
check("with no policy everything is OFF: escrow off, laps off, with the baseline's defaults", val(vEff, "security.bitlockerEscrow") === "off" && val(vEff, "laps.enabled") === false && val(vEff, "laps.account") === "adg-admin" && val(vEff, "laps.passwordLength") === 20 && val(vEff, "laps.rotateDays") === 30 && val(vEff, "laps.rotateAfterRevealMinutes") === 60 && src(vEff, "laps.enabled").kind === "default");
e = E.resolve(dev, [pol("All on", ["global"], { security: { bitlockerEscrow: "on" }, laps: { enabled: true, rotateDays: 10 } }), pol("Customer off", ["customer"], { security: { bitlockerEscrow: "off" }, laps: { account: "c-admin" } }), pol("Device days", ["device"], { laps: { rotateDays: 3 } })], vaultBase);
check("the most specific policy wins for each setting separately (customer turns escrow off, device changes the days, the account comes from the customer, enabled from global)", val(e, "security.bitlockerEscrow") === "off" && src(e, "security.bitlockerEscrow").name === "Customer off" && val(e, "laps.enabled") === true && src(e, "laps.enabled").name === "All on" && val(e, "laps.rotateDays") === 3 && src(e, "laps.rotateDays").name === "Device days" && val(e, "laps.account") === "c-admin" && val(e, "laps.passwordLength") === 20);
check("the new settings have labels and show in the preview diff", E.diffEffective(vEff, E.resolve(dev, [pol("P", ["global"], { laps: { enabled: true } })], vaultBase)).some((d) => d.key === "laps.enabled") && ["security.bitlockerEscrow", "laps.enabled", "laps.account", "laps.passwordLength", "laps.rotateDays", "laps.rotateAfterRevealMinutes"].every((k) => E.SETTING_LABEL[k] && E.SCALAR_KEYS.includes(k)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
