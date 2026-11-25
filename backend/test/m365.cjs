// Microsoft 365 tenant management, the rules alone (no network, no database): what may be saved, plain licence names, and what is made of what
// Microsoft Graph said (findings, a health figure), and Microsoft's errors in words a person can act on. Run after a build: node test/m365.cjs
"use strict";
const path = require("node:path");
const assert = require("node:assert/strict");
const C = require(path.join(__dirname, "..", process.env.DIST || "dist", "m365", "m365.core.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const refused = (fn, re) => { try { fn(); } catch (e) { const m = JSON.stringify(e.response ?? e.message); if (re && !re.test(m)) throw new Error(`wrong refusal: ${m}`); return; } throw new Error("was accepted"); };
const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const GUID = "11111111-2222-3333-4444-555555555555";

console.log("what may be saved");
check("a tenant is a GUID or a domain, in lower case; anything else (a path, a scheme, spaces) is refused", () => {
    assert.equal(C.cleanTenant("  CONTOSO.onmicrosoft.com "), "contoso.onmicrosoft.com"); assert.equal(C.cleanTenant(GUID.toUpperCase()), GUID);
    for (const bad of ["", "contoso", "https://contoso.com", "contoso.com/oauth2", "a b.com", "contoso.com?x=1", "../etc", "-bad.com"]) refused(() => C.cleanTenant(bad));
});
check("the application ID is a GUID", () => { assert.equal(C.cleanAppId(GUID), GUID); for (const bad of ["", "abc", "11111111-2222-3333-4444-55555555555g"]) refused(() => C.cleanAppId(bad)); });
check("a secret is one token of at most 256 characters, with no spaces or control characters", () => {
    assert.equal(C.cleanSecret("  abc~DEF.123_xyz-456  "), "abc~DEF.123_xyz-456");
    for (const bad of ["", "   ", "has space", "tab\there", "x".repeat(257), "line\nbreak"]) refused(() => C.cleanSecret(bad));
});
check("licence codes become the names people know; unknown ones keep their code", () => {
    assert.equal(C.skuName("SPB"), "Microsoft 365 Business Premium"); assert.equal(C.skuName("O365_BUSINESS_PREMIUM"), "Microsoft 365 Business Standard"); assert.equal(C.skuName("SOME_NEW_SKU"), "SOME_NEW_SKU");
});

console.log("what is made of a reading");
const U = (n, over = {}) => ({ id: `u${n}`, displayName: `User ${n}`, userPrincipalName: `user${n}@contoso.example`, accountEnabled: true, userType: "Member", assignedLicenses: [{ skuId: "s1" }], createdDateTime: daysAgo(400), signInActivity: { lastSignInDateTime: daysAgo(3) }, ...over });
const healthy = () => ({
    org: { displayName: "Contoso Ltd", domains: ["contoso.example", "contoso.onmicrosoft.com"] },
    users: [U(1), U(2), U(3)],
    skus: [{ skuId: "s1", skuPartNumber: "SPB", consumedUnits: 3, prepaidUnits: { enabled: 3 } }],
    mfa: [1, 2, 3].map((n) => ({ userPrincipalName: `user${n}@contoso.example`, isMfaRegistered: true, isAdmin: n === 1 })),
    roles: [{ displayName: "Global Administrator", members: [{ id: "u1", displayName: "User 1", userPrincipalName: "user1@contoso.example" }, { id: "u2", displayName: "User 2", userPrincipalName: "user2@contoso.example" }] }],
    conditionalAccess: { total: 3, enabled: 3 }, securityDefaults: false, score: { current: 70, max: 100 }, notRead: {},
});
check("a healthy tenant has no findings and a health of 100", () => {
    const s = C.analyze(healthy(), NOW);
    assert.deepEqual(s.findings, []); assert.equal(s.health, 100); assert.equal(s.counts.users, 3); assert.equal(s.counts.licensed, 3); assert.equal(s.mfa.missing, 0); assert.equal(s.score.percent, 70);
    assert.equal(s.licenses[0].name, "Microsoft 365 Business Premium"); assert.equal(s.organization.name, "Contoso Ltd");
});
check("people without multi-factor sign-in: a warning below a quarter of people, critical from a quarter", () => {
    const g = healthy(); g.users = Array.from({ length: 10 }, (_, i) => U(i + 1)); g.mfa = g.users.map((u, i) => ({ userPrincipalName: u.userPrincipalName, isMfaRegistered: i >= 2 }));
    g.roles = [{ displayName: "Global Administrator", members: [{ id: "u9", userPrincipalName: "user9@contoso.example" }, { id: "u10", userPrincipalName: "user10@contoso.example" }] }];
    let f = C.analyze(g, NOW).findings.find((x) => x.id === "mfa.missing"); assert.equal(f.severity, "warning"); assert.match(f.title, /2 of 10 people/);
    g.mfa = g.users.map((u, i) => ({ userPrincipalName: u.userPrincipalName, isMfaRegistered: i >= 3 })); f = C.analyze(g, NOW).findings.find((x) => x.id === "mfa.missing"); assert.equal(f.severity, "critical");
});
check("an administrator without multi-factor sign-in is critical and named", () => {
    const g = healthy(); g.mfa[0].isMfaRegistered = false;
    const s = C.analyze(g, NOW); const f = s.findings.find((x) => x.id === "admins.mfa"); assert.equal(f.severity, "critical"); assert.match(f.detail, /User 1/);
    assert.equal(s.admins[0].members.find((m) => m.upn === "user1@contoso.example").mfa, false); assert.ok(s.health < 100);
});
check("global administrators: more than four warns, exactly one is advice, none read is a warning", () => {
    const g = healthy(); g.roles[0].members = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, displayName: `A${i}`, userPrincipalName: `a${i}@c.example` }));
    assert.ok(C.analyze(g, NOW).findings.some((f) => f.id === "admins.many" && f.severity === "warning"));
    g.roles[0].members = [{ id: "u1", userPrincipalName: "user1@contoso.example" }]; assert.ok(C.analyze(g, NOW).findings.some((f) => f.id === "admins.one" && f.severity === "info"));
    g.roles = [{ displayName: "Helpdesk Administrator", members: [{ id: "u1", userPrincipalName: "user1@contoso.example" }] }]; assert.ok(C.analyze(g, NOW).findings.some((f) => f.id === "admins.none"));
});
check("no conditional access and security defaults off is critical; security defaults on, or any policy on, is fine", () => {
    const g = healthy(); g.conditionalAccess = { total: 2, enabled: 0 }; g.securityDefaults = false;
    assert.ok(C.analyze(g, NOW).findings.some((f) => f.id === "signin.unprotected" && f.severity === "critical"));
    g.securityDefaults = true; assert.ok(!C.analyze(g, NOW).findings.some((f) => f.id === "signin.unprotected"));
    g.securityDefaults = false; g.conditionalAccess = { total: 2, enabled: 1 }; assert.ok(!C.analyze(g, NOW).findings.some((f) => f.id === "signin.unprotected"));
});
check("conditional access that could not be read never becomes a claim that nothing protects sign-in", () => {
    const g = healthy(); delete g.conditionalAccess; g.securityDefaults = false; g.notRead = { conditionalAccess: "not allowed" };
    const s = C.analyze(g, NOW); assert.ok(!s.findings.some((f) => f.id === "signin.unprotected")); assert.equal(s.conditionalAccess.enabled, 0);
    const h = healthy(); h.conditionalAccess = { total: 0, enabled: 0 }; delete h.securityDefaults; assert.ok(!C.analyze(h, NOW).findings.some((f) => f.id === "signin.unprotected"));
});
check("licences: a disabled account holding one, and licences bought and never given out (free ones do not count)", () => {
    const g = healthy(); g.users.push(U(4, { accountEnabled: false })); g.skus = [{ skuId: "s1", skuPartNumber: "SPB", consumedUnits: 3, prepaidUnits: { enabled: 5 } }, { skuId: "s2", skuPartNumber: "FLOW_FREE", consumedUnits: 0, prepaidUnits: { enabled: 10000 } }];
    g.mfa.push({ userPrincipalName: "user4@contoso.example", isMfaRegistered: false });
    const s = C.analyze(g, NOW); assert.equal(s.wasted.length, 1); assert.equal(s.wasted[0].name, "User 4");
    assert.ok(s.findings.some((f) => f.id === "licenses.disabled" && f.severity === "warning"));
    const unused = s.findings.find((f) => f.id === "licenses.unused"); assert.match(unused.detail, /2 of 5 Microsoft 365 Business Premium/); assert.ok(!/Power Automate/.test(unused.detail));
    assert.equal(s.mfa.checked, 3, "a disabled account is not counted in the sign-in protection");
});
check("inactive: licensed, enabled members with no sign-in for 90 days; new accounts and guests do not count; none when sign-ins could not be read", () => {
    const g = healthy(); g.users.push(U(4, { signInActivity: { lastSignInDateTime: daysAgo(120) } }), U(5, { signInActivity: { lastSignInDateTime: null }, createdDateTime: daysAgo(10) }), U(6, { userType: "Guest", signInActivity: { lastSignInDateTime: daysAgo(300) } }), U(7, { signInActivity: { lastSignInDateTime: null }, createdDateTime: daysAgo(200) }));
    const s = C.analyze(g, NOW); assert.deepEqual(s.inactive.map((i) => i.name).sort(), ["User 4", "User 7"]); assert.equal(s.counts.guests, 1);
    const none = healthy(); none.users = none.users.map((u) => { const { signInActivity, ...rest } = u; return rest; }); none.notRead = { signIns: "needs premium" };
    assert.deepEqual(C.analyze(none, NOW).inactive, []); assert.ok(!C.analyze(none, NOW).findings.some((f) => f.id === "users.inactive"));
});
check("a low Secure Score warns; a good one does not", () => {
    const g = healthy(); g.score = { current: 20, max: 100 }; assert.ok(C.analyze(g, NOW).findings.some((f) => f.id === "score.low"));
});
check("what could not be read is said so and nothing is made up from it: no MFA data means no MFA finding, and too little read means no health figure", () => {
    const g = healthy(); delete g.mfa; delete g.roles; g.notRead = { mfa: "not allowed", admins: "not allowed" };
    const s = C.analyze(g, NOW); assert.equal(s.mfa, null); assert.ok(!s.findings.some((f) => f.id.startsWith("mfa") || f.id.startsWith("admins"))); assert.equal(s.notRead.mfa, "not allowed");
    const bare = { org: { displayName: "x", domains: [] }, notRead: { users: "no" } }; const b = C.analyze(bare, NOW); assert.equal(b.health, null); assert.equal(b.counts, null);
});
check("findings are ordered critical first, and the health figure falls by 25 for each critical and 8 for each warning", () => {
    const g = healthy(); g.mfa[0].isMfaRegistered = false; g.conditionalAccess = { total: 0, enabled: 0 }; g.score = { current: 10, max: 100 };
    const s = C.analyze(g, NOW); assert.deepEqual(s.findings.map((f) => f.severity), [...s.findings.map((f) => f.severity)].sort((a, b) => ({ critical: 0, warning: 1, info: 2 })[a] - ({ critical: 0, warning: 1, info: 2 })[b]));
    const crit = s.findings.filter((f) => f.severity === "critical").length, warn = s.findings.filter((f) => f.severity === "warning").length; assert.equal(s.health, Math.max(0, 100 - crit * 25 - warn * 8));
});

console.log("Microsoft's errors in words");
check("the common sign-in and permission errors say what to do", () => {
    assert.match(C.explainGraphError(401, "invalid_client", "AADSTS7000215: Invalid client secret provided."), /secret is wrong/);
    assert.match(C.explainGraphError(401, "invalid_client", "AADSTS7000222: The provided client secret keys are expired."), /expired/);
    assert.match(C.explainGraphError(400, "unauthorized_client", "AADSTS700016: Application with identifier 'x' was not found in the directory"), /application \(client\) ID/);
    assert.match(C.explainGraphError(400, "invalid_request", "AADSTS90002: Tenant 'x' not found."), /tenant could not be found/);
    assert.match(C.explainGraphError(403, "Authorization_RequestDenied", "Insufficient privileges"), /admin consent/);
    assert.match(C.explainGraphError(429, undefined, undefined), /slow down/); assert.match(C.explainGraphError(503, undefined, undefined), /problem/);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
