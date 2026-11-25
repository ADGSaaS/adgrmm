// The rules for custom fields on customers, without a database.
const path = require("node:path");
const assert = require("node:assert/strict");
const m = require(path.join(__dirname, "..", "dist", "customers", "custom-fields.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };

const def = (type, extra = {}) => ({ id: "x", key: "f", label: "Field", type, options: [], required: false, help: "", sortOrder: 1, active: true, ...extra });
const bad = (fn, msg) => assert.throws(fn, (e) => (msg ? msg.test(e.message) : true));

check("a field's key comes from its name and is always valid", () => {
    assert.equal(m.keyFromLabel("Account manager"), "account_manager");
    assert.equal(m.keyFromLabel("  Renewal date (2026)! "), "renewal_date_2026");
    assert.equal(m.keyFromLabel("Café Naïve"), "cafe_naive");
    assert.equal(m.keyFromLabel("2nd contact"), "f_2nd_contact");
    assert.equal(m.keyFromLabel("日本語"), "f");
    assert.equal(m.keyFromLabel("!!!"), "f");
    assert.ok(m.keyFromLabel("x".repeat(100)).length <= 40);
    for (const l of ["A", "9", "a b c", "ß", "x_".repeat(30)]) assert.match(m.keyFromLabel(l), /^[a-z][a-z0-9_]{0,39}$/, l);
});

check("names, choices and help text are checked", () => {
    assert.equal(m.cleanLabel("  Account   manager "), "Account manager");
    bad(() => m.cleanLabel("  "), /Give the field a name/);
    bad(() => m.cleanLabel("x".repeat(81)), /too long/);
    assert.deepEqual(m.cleanOptions("dropdown", " Gold \nsilver\nGOLD\n\n"), ["Gold", "silver"]);
    assert.deepEqual(m.cleanOptions("dropdown", ["A", "B"]), ["A", "B"]);
    assert.deepEqual(m.cleanOptions("text", ["ignored"]), []);
    bad(() => m.cleanOptions("dropdown", []), /at least one choice/);
    bad(() => m.cleanOptions("dropdown", Array.from({ length: 51 }, (_, i) => `o${i}`)), /50 choices/);
    bad(() => m.cleanHelp("x".repeat(201)), /too long/);
});

check("text values are trimmed, limited, and empty clears the field", () => {
    assert.equal(m.cleanValue(def("text"), "  Pat   Lee ", undefined), "Pat Lee");
    assert.equal(m.cleanValue(def("text"), "   ", undefined), undefined);
    assert.equal(m.cleanValue(def("text"), null, undefined), undefined);
    bad(() => m.cleanValue(def("text"), "x".repeat(501), undefined), /too long/);
    assert.equal(m.cleanValue(def("longtext"), "line one\r\nline two  ", undefined), "line one\nline two");
    bad(() => m.cleanValue(def("longtext"), "x".repeat(4001), undefined), /too long/);
});

check("numbers accept digits and thousands separators, and nothing else", () => {
    assert.equal(m.cleanValue(def("number"), "1,200.5", undefined), 1200.5);
    assert.equal(m.cleanValue(def("number"), 42, undefined), 42);
    assert.equal(m.cleanValue(def("number"), "-3", undefined), -3);
    assert.equal(m.cleanValue(def("number"), "", undefined), undefined);
    for (const v of ["abc", "1e999", "NaN", Infinity, "12 users"]) bad(() => m.cleanValue(def("number"), v, undefined), /must be a number/);
});

check("dates must be real calendar dates", () => {
    assert.equal(m.cleanValue(def("date"), "2026-11-11", undefined), "2026-11-11");
    for (const v of ["2026-02-30", "2026-13-01", "11/11/2026", "2026-1-1", "tomorrow"]) bad(() => m.cleanValue(def("date"), v, undefined), /must be a date/);
    assert.equal(m.cleanValue(def("date"), "", undefined), undefined);
});

check("a dropdown takes one of its choices (any case), or the value already saved", () => {
    const d = def("dropdown", { options: ["Gold", "Silver"] });
    assert.equal(m.cleanValue(d, "gold", undefined), "Gold");
    bad(() => m.cleanValue(d, "Bronze", undefined), /one of its choices/);
    assert.equal(m.cleanValue(d, "Bronze", "Bronze"), "Bronze", "a choice that was removed later may stay");
    assert.equal(m.cleanValue(d, "", "Gold"), undefined);
});

check("checkboxes are true or false, and false is a real value", () => {
    assert.equal(m.cleanValue(def("checkbox"), true, undefined), true);
    assert.equal(m.cleanValue(def("checkbox"), "false", undefined), false);
    assert.equal(m.cleanValue(def("checkbox"), false, undefined), false);
    bad(() => m.cleanValue(def("checkbox"), "maybe", undefined), /checked or not/);
});

check("web addresses are made proper, and only http and https are kept", () => {
    assert.equal(m.cleanValue(def("url"), "example.com/portal", undefined), "https://example.com/portal");
    assert.equal(m.cleanValue(def("url"), "http://example.com/", undefined), "http://example.com");
    for (const v of ["javascript:alert(1)", "not a url", "ftp://x.test", "localhost"]) bad(() => m.cleanValue(def("url"), v, undefined), /web address/);
});

check("merging applies only the changes sent, clears with empty, and refuses unknown or archived fields", () => {
    const defs = [def("text", { key: "manager", label: "Manager" }), def("number", { key: "seats", label: "Seats" }), def("text", { key: "old", label: "Old", active: false })];
    assert.deepEqual(m.mergeValues(defs, { manager: " Pat " }, { seats: 5, old: "kept" }, false), { manager: "Pat", seats: 5, old: "kept" });
    assert.deepEqual(m.mergeValues(defs, { seats: "" }, { seats: 5, manager: "Pat" }, false), { manager: "Pat" });
    assert.deepEqual(m.mergeValues(defs, undefined, { seats: 5 }, false), { seats: 5 });
    bad(() => m.mergeValues(defs, { nope: "x" }, {}, false), /no custom field "nope"/);
    bad(() => m.mergeValues(defs, { old: "x" }, {}, false), /no custom field "old"/);
    bad(() => m.mergeValues(defs, { seats: "many" }, {}, false), /Seats must be a number/);
});

check("required fields must have a value, and a required checkbox must be checked", () => {
    const defs = [def("text", { key: "contract", label: "Contract number", required: true }), def("checkbox", { key: "signed", label: "Contract signed", required: true }), def("text", { key: "arch", label: "Archived", required: true, active: false })];
    bad(() => m.mergeValues(defs, {}, {}, true), /Contract number is required/);
    bad(() => m.mergeValues(defs, { contract: "C-1" }, {}, true), /Contract signed must be checked/);
    bad(() => m.mergeValues(defs, { contract: "C-1", signed: false }, {}, true), /must be checked/);
    assert.deepEqual(m.mergeValues(defs, { contract: "C-1", signed: true }, {}, true), { contract: "C-1", signed: true });
    assert.deepEqual(m.mergeValues(defs, { contract: "C-2" }, { contract: "C-1", signed: true }, true), { contract: "C-2", signed: true });
    bad(() => m.mergeValues(defs, { contract: "" }, { contract: "C-1", signed: true }, true), /Contract number is required/);
    assert.deepEqual(m.mergeValues(defs, {}, {}, false), {}, "not checked when nothing is being saved");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
