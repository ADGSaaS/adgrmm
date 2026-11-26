// {{agent.*}} in scripts, without a database: what is replaced, what stops the script, and what is never put into script text.
const path = require("node:path");
const assert = require("node:assert/strict");
const m = require(path.join(__dirname, "..", "dist", "jobs", "script-properties.js"));

let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };

const values = { hostname: "PC-01", name: "Front desk", id: "d1", uuid: "a1", os: "windows", osname: "Windows 11", user: "bob", customer: "Acme Dental", customer_id: "c1", site: "Main", site_id: "s1", tags: "vip,kiosk", version: "1.3.33", status: "online" };

check("a script with no properties is left alone", () => {
    assert.deepEqual(m.applyAgentProperties("powershell", "Get-Date", values), { used: false });
    assert.deepEqual(m.applyAgentProperties("bash", "echo {{other.thing}} {{ agentx.hostname }}", values), { used: false });
});

check("properties are filled in, in any case and with spaces inside the braces", () => {
    const r = m.applyAgentProperties("powershell", "Write-Output '{{agent.hostname}} / {{ Agent.CUSTOMER }} / {{agent.hostname}}'", values);
    assert.equal(r.ok, true);
    assert.equal(r.scriptText, "Write-Output 'PC-01 / Acme Dental / PC-01'");
});

check("every property is also an environment variable when a script uses any", () => {
    const r = m.applyAgentProperties("bash", "echo {{agent.hostname}}", values);
    assert.equal(r.env.ADG_AGENT_HOSTNAME, "PC-01");
    assert.equal(r.env.ADG_AGENT_CUSTOMER, "Acme Dental");
    assert.equal(r.env.ADG_AGENT_TAGS, "vip,kiosk");
    assert.equal(Object.keys(r.env).length, Object.keys(m.AGENT_PROPERTIES).length);
});

check("an unknown property stops the script and says which one", () => {
    const r = m.applyAgentProperties("powershell", "Write-Output {{agent.hostnam}}; Remove-Item C:\\important -Recurse", values);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /\{\{agent\.hostnam\}\} is not a property/);
    assert.ok(!r.scriptText.includes("Remove-Item"), "the author's script must not be sent");
    assert.match(r.scriptText, /did not run this script/);
    assert.match(r.scriptText, /exit 1/);
});

check("a property the device has no value for stops the script", () => {
    const r = m.applyAgentProperties("bash", "echo {{agent.user}} {{agent.site}}", { ...values, user: "", site: undefined });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems[0], /agent\.user\}\} has no value/);
    assert.match(r.problems[1], /agent\.site\}\} has no value/);
    assert.ok(!r.scriptText.includes("echo"));
});

check("values a shell could act on are never put into the text, and the message points to the environment variable", () => {
    for (const bad of ["O'Brien", "Smith & Sons", "a;b", "x$(calc)", "`id`", 'say "hi"', "a|b", "Dental (HQ)", "a<b", "{x}", "line\nbreak"]) {
        const r = m.applyAgentProperties("powershell", "Write-Output {{agent.customer}}", { ...values, customer: bad });
        assert.equal(r.ok, false, bad);
        assert.match(r.problems[0], /ADG_AGENT_CUSTOMER/, bad);
    }
    for (const good of ["Acme Dental", "PC-01", "Front desk #2", "user@example.com", "10.1.4.20", "C:\\Program Files", "a/b", "vip,kiosk", "Müller Praxis"]) {
        assert.equal(m.applyAgentProperties("bash", "echo {{agent.customer}}", { ...values, customer: good }).ok, true, good);
    }
});

check("the stop script holds only property names, never a value, and survives quotes in the message", () => {
    const ps = m.failureScript("powershell", "it's a 'test'");
    assert.match(ps, /WriteLine\('it''s a ''test'''\)/);
    const sh = m.failureScript("bash", "it's a 'test'");
    assert.match(sh, /printf '%s\\n' 'it'\\''s a '\\''test'\\''' >&2/);
    const r = m.applyAgentProperties("bash", "echo {{agent.customer}}", { ...values, customer: "SECRET'; rm -rf / #" });
    assert.ok(!r.scriptText.includes("SECRET"), "the unsafe value must not leak into the stop message");
});

check("a CMD script is stopped with a CMD script that cannot be broken out of", () => {
    const r = m.applyAgentProperties("cmd", "echo {{agent.nope}} & del /q C:\\x", values);
    assert.equal(r.ok, false);
    assert.ok(!r.scriptText.includes("del /q"));
    assert.match(r.scriptText, /^@echo off\r\necho ADG RMM did not run this script/);
    assert.match(r.scriptText, /exit \/b 1/);
    // the echoed message holds none of the characters CMD would act on (the 1>&2 after it is the redirect we add)
    const echoed = r.scriptText.split("\r\n")[1].replace(/^echo /, "").replace(/ 1>&2$/, "");
    assert.ok(!/[&|<>^%"]/.test(echoed), echoed);
});

check("the property names are the documented set", () => {
    assert.deepEqual(Object.keys(m.AGENT_PROPERTIES).sort(), ["customer", "customer_id", "hostname", "id", "name", "os", "osname", "site", "site_id", "status", "tags", "user", "uuid", "version"]);
    assert.deepEqual(m.referencedProperties("{{agent.A}} {{agent.a}} {{agent.b_c}}"), ["a", "b_c"]);
});

const custom = { account_manager: "Pat Lee", contract: "C-100", renewal: "2027-03-31", empty: "", risky: "a;b", signed: "true" };

check("a customer's custom fields are filled in, with spaces and any case inside the braces", () => {
    const r = m.applyAgentProperties("powershell", "Write-Output '{{customer.account_manager}} / {{ Customer.CONTRACT }} on {{agent.hostname}}'", values, custom);
    assert.equal(r.ok, true);
    assert.equal(r.scriptText, "Write-Output 'Pat Lee / C-100 on PC-01'");
});

check("a script that uses only customer fields still counts, and gets them as environment variables", () => {
    assert.deepEqual(m.referencedCustomFields("{{customer.A_b}} {{customer.a_b}} {{customer.x}} {{agent.id}}"), ["a_b", "x"]);
    const r = m.applyAgentProperties("bash", "echo {{customer.contract}}", values, custom);
    assert.equal(r.ok, true);
    assert.equal(r.env.ADG_CUSTOMER_CONTRACT, "C-100");
    assert.equal(r.env.ADG_CUSTOMER_ACCOUNT_MANAGER, "Pat Lee");
    assert.ok(!("ADG_AGENT_HOSTNAME" in r.env), "agent variables only when agent properties are used");
    assert.deepEqual(m.applyAgentProperties("bash", "echo {{custom.x}} {{customer}}", values, custom), { used: false });
});

check("a field that does not exist, or is empty for this customer, stops the script and says which", () => {
    let r = m.applyAgentProperties("powershell", "Write-Output '{{customer.nope}}'", values, custom);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /\{\{customer\.nope\}\} is not a custom field\. Custom fields: customer\.account_manager/);
    assert.ok(!r.scriptText.includes("Write-Output '{{customer.nope}}'"), "nothing the author wrote is run");
    r = m.applyAgentProperties("bash", "echo {{customer.empty}}", values, custom);
    assert.match(r.problems[0], /has no value for this device's customer/);
    r = m.applyAgentProperties("bash", "echo {{customer.x}}", values, {});
    assert.match(r.problems[0], /There are no custom fields yet/);
    r = m.applyAgentProperties("bash", "echo {{customer.x}}", values);
    assert.equal(r.ok, false);
});

check("a custom value that a shell could act on is never put into the script text", () => {
    const r = m.applyAgentProperties("bash", "echo {{customer.risky}} {{customer.contract}}", values, custom);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /ADG_CUSTOMER_RISKY/);
    assert.ok(!r.scriptText.includes("a;b"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
