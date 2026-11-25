// The rules for editing and filling in the system emails, without a database or a server.
// Run after a build: DIST=dist-groupc node test/email-template-registry.cjs (DIST defaults to dist).
const path = require("node:path");
const assert = require("node:assert/strict");
const m = require(path.join(__dirname, "..", process.env.DIST || "dist", "templates", "email-template-registry.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const def = (key) => m.templateDef(key);

check("every built-in wording uses only its own variables and keeps the ones it needs", () => {
    for (const d of m.EMAIL_TEMPLATES) {
        const w = m.checkWording(d, d.subject, d.body);
        assert.equal(w.subject, d.subject);
        const names = new Set(d.variables.map((v) => v.name));
        for (const n of m.variablesIn(d.subject + d.body)) assert.ok(names.has(n), `${d.key} uses {{${n}}}`);
        for (const v of d.variables) assert.ok(v.sample.length > 0, `${d.key}.${v.name} has a sample`);
    }
});

check("variables are filled in once, whatever spacing and case they are written with", () => {
    assert.equal(m.renderText("Hi {{ name }} and {{NAME}}", { name: "Pat" }), "Hi Pat and Pat");
    // A value that looks like a variable is not filled in again.
    assert.equal(m.renderText("Hi {{name}}", { name: "{{link}}", link: "SECRET" }), "Hi {{link}}");
    assert.equal(m.renderText("{{missing}} gone", {}), "gone");
});

check("empty variables leave no gaps and the ends are trimmed", () => {
    const out = m.renderText("Title\n{{a}}\n\n{{b}}\n\n{{c}}\nEnd\n\n", { a: "", b: "", c: "x" });
    assert.equal(out, "Title\n\nx\nEnd");
});

check("a subject is one line, so a value with a line break cannot add a header", () => {
    assert.equal(m.renderSubject("Hello {{name}}", { name: "Pat\r\nBcc: evil@example.test" }), "Hello Pat Bcc: evil@example.test");
});

check("saving refuses an unknown variable, a missing required one, and empty or huge text", () => {
    const d = def("portal_invite");
    assert.throws(() => m.checkWording(d, "Hi {{nope}}", "Go {{link}}"), /\{\{nope\}\} is not a variable/);
    assert.throws(() => m.checkWording(d, "Hi", "No link here"), /must include \{\{link\}\}/);
    assert.throws(() => m.checkWording(d, "", "Go {{link}}"), /subject/);
    assert.throws(() => m.checkWording(d, "Hi", "   "), /text/);
    assert.throws(() => m.checkWording(d, "x".repeat(m.SUBJECT_MAX + 1), "{{link}}"), /too long/);
    assert.throws(() => m.checkWording(d, "Hi", "{{link}}" + "x".repeat(m.BODY_MAX)), /too long/);
    assert.deepEqual(m.checkWording(d, "  Hi\n there ", "Go\r\n{{ link }}"), { subject: "Hi there", body: "Go\n{{ link }}" });
    assert.throws(() => m.templateDef("nothing"), /no such/);
});

check("the sample preview of each built-in wording reads as a finished email", () => {
    for (const d of m.EMAIL_TEMPLATES) {
        const subject = m.renderSubject(d.subject, m.sampleValues(d));
        const body = m.renderText(d.body, m.sampleValues(d));
        assert.ok(!/\{\{/.test(subject + body), `${d.key} has no leftover variables`);
        assert.ok(!subject.includes("\n"));
    }
    const alert = def("alert");
    assert.equal(m.renderSubject(alert.subject, m.sampleValues(alert)), "[Critical] Disk C: is 96% full on FRONTDESK-PC");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
