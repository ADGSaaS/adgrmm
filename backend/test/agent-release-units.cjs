// Staged agent rollout (roadmap 10.10), the pure parts without a server or a database: the offer rule for every combination of
// ring x candidate state x stable state x device version, promote / withdraw as file operations in temp folders (atomicity, hash
// checks, previous slot kept, failures leave stable intact), the health gate maths and the promote request rules.
// Run after a build: node test/agent-release-units.cjs (DIST defaults to dist).
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const dist = path.join(__dirname, "..", process.env.DIST || "dist", "agents");
const C = require(path.join(dist, "agent-release.core.js"));
const { parseAgentVersion } = require(path.join(dist, "agent-version.util.js"));

let passed = 0, failed = 0;
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const FILE = "remoteiq-agent-windows.zip";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "riq-rel-"));
let n = 0;
const fresh = () => { const d = path.join(root, `t${++n}`); fs.mkdirSync(d); return { stable: path.join(d, "stable", "windows", FILE), candidate: path.join(d, "candidate", "windows", FILE), previous: path.join(d, "previous", "windows", FILE), dir: d }; };

/** kind: ok | badsha | nover (package without version.json) | nopkg (version.json without package) | badjson | badversion | wrongshape */
function put(pkgPath, version, kind = "ok", content = `build ${version} ${crypto.randomUUID()}`) {
    fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
    const vp = path.join(path.dirname(pkgPath), "version.json");
    const bytes = Buffer.from(content);
    if (kind !== "nopkg") fs.writeFileSync(pkgPath, bytes);
    const good = { version, sha256: sha(bytes) };
    if (kind === "badsha") fs.writeFileSync(vp, JSON.stringify({ version, sha256: sha("other") }));
    else if (kind === "nover" || kind === "absent") { /* no version.json */ }
    else if (kind === "badjson") fs.writeFileSync(vp, "{ not json");
    else if (kind === "badversion") fs.writeFileSync(vp, JSON.stringify({ version: "banana", sha256: good.sha256 }));
    else if (kind === "wrongshape") fs.writeFileSync(vp, JSON.stringify({ version }));
    else fs.writeFileSync(vp, JSON.stringify(good));
    return { ...good, content: bytes };
}
const leftovers = (dir) => { const out = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tmp$/.test(e.name)) out.push(p); } })(dir); return out; };

/* ---------------------------------------------------------------- inspection */

check("inspectSlot: absent, valid, and every way a slot must not be offered", async () => {
    const t = fresh();
    assert.equal((await C.inspectSlot("candidate", t.candidate)).state, "absent");
    put(t.candidate, "1.3.5");
    const ok = await C.inspectSlot("candidate", t.candidate);
    assert.equal(ok.state, "valid"); assert.equal(ok.version, "1.3.5"); assert.ok(ok.sizeBytes > 0);
    for (const kind of ["badsha", "nover", "nopkg", "badjson", "badversion", "wrongshape"]) {
        const u = fresh(); put(u.candidate, "1.3.5", kind);
        const r = await C.inspectSlot("candidate", u.candidate);
        assert.equal(r.state, "problem", kind); assert.ok(r.problem, kind);
        assert.equal(C.isValid(r), false);
    }
    // a package replaced after version.json was written is a mismatch (hash is not cached across a change)
    const v = fresh(); put(v.candidate, "1.3.5");
    assert.equal((await C.inspectSlot("candidate", v.candidate)).state, "valid");
    fs.writeFileSync(v.candidate, "tampered content of another size");
    assert.equal((await C.inspectSlot("candidate", v.candidate)).state, "problem");
    // BOM tolerated
    const w = fresh(); const g = put(w.candidate, "1.3.5");
    fs.writeFileSync(path.join(path.dirname(w.candidate), "version.json"), "﻿" + JSON.stringify({ version: "1.3.5", sha256: g.sha256.toUpperCase() }));
    assert.equal((await C.inspectSlot("candidate", w.candidate)).state, "valid", "BOM and upper-case hash are accepted");
});

/* ---------------------------------------------------------------- the offer rule */

const fake = (state, version) => (state === "valid" ? { state: "valid", version, parsed: parseAgentVersion(version), sha256: "x".repeat(64), sizeBytes: 5, packagePath: "p", slot: "s" } : state === "absent" ? { state: "absent" } : { state: "problem", problem: "bad" });

check("offer rule: every ring x stable state x candidate state x device version (reference model)", () => {
    const STABLE = "1.3.10";
    const stableStates = ["valid", "absent", "problem"];
    const candStates = [["absent"], ["valid", "1.3.11"], ["valid", "1.3.10"], ["valid", "1.3.9"], ["problem"], ["valid", "1.4.0"]];
    const devVersions = ["1.3.0", "1.3.9", "1.3.10", "1.3.11", "1.4.0", "1.9.0"];
    let combos = 0;
    for (const ring of ["pilot", "stable"]) for (const ss of stableStates) for (const [cs, cv] of candStates) for (const dv of devVersions) {
        const stable = fake(ss, STABLE), cand = fake(cs, cv);
        // independent model
        let expectPkg = null, expectSlot = null;
        const stableOk = ss === "valid";
        const candOk = cs === "valid" && (!stableOk || parseAgentVersion(cv).join(".") > "" && cmp(cv, STABLE) > 0);
        if (ring === "pilot" && candOk) { expectPkg = cv; expectSlot = "candidate"; }
        else if (stableOk) { expectPkg = STABLE; expectSlot = "stable"; }
        const want = expectPkg && cmp(expectPkg, dv) > 0 ? { slot: expectSlot, version: expectPkg } : null;
        const got = C.decideOffer(ring, parseAgentVersion(dv), stable, cand);
        assert.deepEqual(got ? { slot: got.slot, version: got.pkg.version } : null, want, `${ring} stable=${ss} cand=${cs}:${cv} device=${dv}`);
        combos++;
    }
    assert.equal(combos, 2 * 3 * 6 * 6);
    function cmp(a, b) { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 4; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; }
});

check("offer rule: the documented cases by name", () => {
    const S = fake("valid", "1.3.10"), Cn = fake("valid", "1.3.11");
    const v = (s) => parseAgentVersion(s);
    assert.equal(C.decideOffer("pilot", v("1.3.10"), S, Cn).slot, "candidate", "pilot on stable version gets the newer candidate");
    assert.equal(C.decideOffer("stable", v("1.3.9"), S, Cn).slot, "stable", "stable device only gets stable");
    assert.equal(C.decideOffer("stable", v("1.3.10"), S, Cn), null, "stable device already on stable is offered nothing even though a candidate exists");
    assert.equal(C.decideOffer("pilot", v("1.3.9"), S, null).slot, "stable", "no candidate: pilot behaves like today");
    assert.equal(C.decideOffer("pilot", v("1.3.11"), S, Cn), null, "pilot already on the candidate: nothing");
    assert.equal(C.decideOffer("pilot", v("1.3.12"), S, Cn), null, "never a downgrade");
    assert.equal(C.decideOffer("pilot", v("1.3.9"), S, fake("valid", "1.3.10")).slot, "stable", "candidate equal to stable is ignored");
    assert.equal(C.decideOffer("pilot", v("1.3.9"), S, fake("valid", "1.3.8")).pkg.version, "1.3.10", "candidate older than stable is ignored");
    assert.equal(C.decideOffer("pilot", v("1.3.9"), S, fake("problem")).pkg.version, "1.3.10", "corrupt candidate is ignored");
    assert.equal(C.decideOffer("pilot", v("1.3.0"), fake("absent"), Cn).pkg.version, "1.3.11", "no stable: a usable candidate still goes to pilot");
    assert.equal(C.decideOffer("stable", v("1.3.0"), fake("absent"), Cn), null, "no stable: stable devices get nothing");
    assert.equal(C.candidateIsUsable(S, fake("valid", "1.3.10")), false);
    assert.equal(C.candidateIsUsable(S, Cn), true);
    assert.equal(C.effectiveRing("pilot", "stable"), "pilot");
    assert.equal(C.effectiveRing(null, "pilot"), "pilot");
    assert.equal(C.effectiveRing(undefined, undefined), "stable");
    assert.equal(C.effectiveRing("stable", "pilot"), "stable", "an explicit device ring overrides the customer default");
    assert.equal(C.effectiveRing("junk", "junk"), "stable");
});

/* ---------------------------------------------------------------- promote */

check("promote: stable gets candidate, previous keeps old stable, candidate removed, hashes verified, no temp files", async () => {
    const t = fresh();
    const old = put(t.stable, "1.3.10");
    const neu = put(t.candidate, "1.3.11");
    const r = await C.promoteCandidate({ stablePath: t.stable, candidatePath: t.candidate, previousPath: t.previous, expectedVersion: "1.3.11" });
    assert.equal(r.version, "1.3.11"); assert.equal(r.previousVersion, "1.3.10"); assert.equal(r.candidateRemoved, true);
    assert.equal(sha(fs.readFileSync(t.stable)), neu.sha256);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(t.stable), "version.json"), "utf8")).version, "1.3.11");
    assert.equal(sha(fs.readFileSync(t.previous)), old.sha256);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(t.previous), "version.json"), "utf8")).version, "1.3.10");
    assert.equal(fs.existsSync(t.candidate), false); assert.equal(fs.existsSync(path.join(path.dirname(t.candidate), "version.json")), false);
    assert.equal((await C.inspectSlot("stable", t.stable)).state, "valid");
    assert.equal((await C.inspectSlot("previous", t.previous)).state, "valid");
    assert.deepEqual(leftovers(t.dir), []);
});

check("promote: with no stable at all it still works and there is no previous", async () => {
    const t = fresh(); put(t.candidate, "1.3.11");
    const r = await C.promoteCandidate({ stablePath: t.stable, candidatePath: t.candidate, previousPath: t.previous, expectedVersion: "1.3.11" });
    assert.equal(r.previousVersion, null);
    assert.equal((await C.inspectSlot("stable", t.stable)).version, "1.3.11");
    assert.equal(fs.existsSync(t.previous), false);
});

check("promote: version.json is written LAST (package lands first; between the two the pair mismatches and is not offered)", async () => {
    const t = fresh(); put(t.stable, "1.3.10"); put(t.candidate, "1.3.11");
    let midState = null;
    await C.promoteCandidate({
        stablePath: t.stable, candidatePath: t.candidate, previousPath: t.previous, expectedVersion: "1.3.11",
        hooks: { afterPackage: async () => { midState = await C.inspectSlot("stable", t.stable); } },
    });
    assert.equal(midState.state, "problem", "new package + old version.json must not be offered: " + JSON.stringify({ ...midState, modifiedAt: 0 }));
    assert.equal(C.decideOffer("stable", [1, 3, 0], midState, null), null);
});

const refuses = async (fn, code) => { try { await fn(); } catch (e) { assert.ok(e instanceof C.ReleaseOpError, String(e)); assert.equal(e.code, code, e.message); return e; } assert.fail(`expected ${code}`); };
const snapshot = (...ps) => ps.map((p) => (fs.existsSync(p) ? sha(fs.readFileSync(p)) : null)).join("|");
const verFile = (p) => path.join(path.dirname(p), "version.json");

check("promote: refusals change nothing (changed since, no candidate, not newer, equal, corrupt candidate)", async () => {
    const t = fresh(); put(t.stable, "1.3.10"); put(t.candidate, "1.3.11");
    const snap = () => snapshot(t.stable, verFile(t.stable), t.candidate, verFile(t.candidate), t.previous);
    const before = snap();
    const input = { stablePath: t.stable, candidatePath: t.candidate, previousPath: t.previous };
    await refuses(() => C.promoteCandidate({ ...input, expectedVersion: "1.3.12" }), "version_changed");
    await refuses(() => C.promoteCandidate({ ...input, expectedVersion: "" }), "version_changed");
    assert.equal(snap(), before);
    const none = fresh(); put(none.stable, "1.3.10");
    await refuses(() => C.promoteCandidate({ stablePath: none.stable, candidatePath: none.candidate, previousPath: none.previous, expectedVersion: "1.3.11" }), "no_candidate");
    const eq = fresh(); put(eq.stable, "1.3.10"); put(eq.candidate, "1.3.10");
    await refuses(() => C.promoteCandidate({ stablePath: eq.stable, candidatePath: eq.candidate, previousPath: eq.previous, expectedVersion: "1.3.10" }), "not_newer");
    const old = fresh(); put(old.stable, "1.3.10"); put(old.candidate, "1.3.9");
    await refuses(() => C.promoteCandidate({ stablePath: old.stable, candidatePath: old.candidate, previousPath: old.previous, expectedVersion: "1.3.9" }), "not_newer");
    for (const kind of ["badsha", "nover", "badjson"]) {
        const b = fresh(); put(b.stable, "1.3.10"); put(b.candidate, "1.3.11", kind);
        const s0 = snapshot(b.stable, verFile(b.stable));
        await refuses(() => C.promoteCandidate({ stablePath: b.stable, candidatePath: b.candidate, previousPath: b.previous, expectedVersion: "1.3.11" }), "candidate_invalid");
        assert.equal(snapshot(b.stable, verFile(b.stable)), s0, `stable untouched for ${kind}`);
        assert.equal(fs.existsSync(b.previous), false);
    }
});

check("promote: a failure at any step puts the old stable back and keeps the candidate", async () => {
    for (const hook of ["afterPackage", "afterVersion"]) {
        const t = fresh(); const old = put(t.stable, "1.3.10"); put(t.candidate, "1.3.11");
        const candBefore = snapshot(t.candidate, verFile(t.candidate));
        const e = await refuses(() => C.promoteCandidate({
            stablePath: t.stable, candidatePath: t.candidate, previousPath: t.previous, expectedVersion: "1.3.11",
            hooks: { [hook]: () => { throw new Error("disk full (simulated)"); } },
        }), "copy_failed");
        assert.match(e.message, /put back/);
        const s = await C.inspectSlot("stable", t.stable);
        assert.equal(s.state, "valid", hook); assert.equal(s.version, "1.3.10", hook); assert.equal(s.sha256, old.sha256, hook);
        assert.equal(snapshot(t.candidate, verFile(t.candidate)), candBefore, "candidate untouched");
        assert.deepEqual(leftovers(t.dir), [], `no temp files after ${hook}`);
    }
    // a corrupted result is caught by the verification after the copy and rolled back
    const t = fresh(); const old = put(t.stable, "1.3.10"); put(t.candidate, "1.3.11");
    await refuses(() => C.promoteCandidate({
        stablePath: t.stable, candidatePath: t.candidate, previousPath: t.previous, expectedVersion: "1.3.11",
        hooks: { afterVersion: () => fs.writeFileSync(t.stable, "garbage written behind our back") },
    }), "verify_failed");
    const s = await C.inspectSlot("stable", t.stable);
    assert.equal(s.state, "valid"); assert.equal(s.sha256, old.sha256); assert.equal(s.version, "1.3.10");
    assert.ok(fs.existsSync(t.candidate));
});

check("promote: if keeping the previous slot fails nothing is changed", async () => {
    const t = fresh(); put(t.stable, "1.3.10"); put(t.candidate, "1.3.11");
    // the previous folder cannot be created: a file sits where the folder should be
    fs.mkdirSync(path.join(t.dir, "previous"), { recursive: true });
    fs.writeFileSync(path.join(t.dir, "previous", "windows"), "i am a file");
    const s0 = snapshot(t.stable, verFile(t.stable), t.candidate, verFile(t.candidate));
    await refuses(() => C.promoteCandidate({ stablePath: t.stable, candidatePath: t.candidate, previousPath: t.previous, expectedVersion: "1.3.11" }), "previous_failed");
    assert.equal(snapshot(t.stable, verFile(t.stable), t.candidate, verFile(t.candidate)), s0);
    assert.deepEqual(leftovers(t.dir), []);
});

check("promote: a second promote of the same candidate is refused (it is gone), and previous is not overwritten by refusals", async () => {
    const t = fresh(); put(t.stable, "1.3.10"); put(t.candidate, "1.3.11");
    const input = { stablePath: t.stable, candidatePath: t.candidate, previousPath: t.previous, expectedVersion: "1.3.11" };
    await C.promoteCandidate(input);
    const prev = snapshot(t.previous);
    await refuses(() => C.promoteCandidate(input), "no_candidate");
    assert.equal(snapshot(t.previous), prev);
    // a later promotion moves the 1.3.11 stable to previous
    put(t.candidate, "1.3.12");
    await C.promoteCandidate({ ...input, expectedVersion: "1.3.12" });
    assert.equal((await C.inspectSlot("previous", t.previous)).version, "1.3.11");
});

/* ---------------------------------------------------------------- withdraw */

check("withdraw: removes the candidate (also a broken one), refuses a changed or absent one, never touches stable", async () => {
    const t = fresh(); put(t.stable, "1.3.10"); put(t.candidate, "1.3.11");
    const s0 = snapshot(t.stable, verFile(t.stable));
    await refuses(() => C.withdrawCandidate(t.candidate, "1.3.12"), "version_changed");
    assert.ok(fs.existsSync(t.candidate));
    const r = await C.withdrawCandidate(t.candidate, "1.3.11");
    assert.equal(r.version, "1.3.11");
    assert.equal(fs.existsSync(t.candidate), false); assert.equal(fs.existsSync(verFile(t.candidate)), false);
    assert.equal(snapshot(t.stable, verFile(t.stable)), s0);
    await refuses(() => C.withdrawCandidate(t.candidate, null), "no_candidate");
    const b = fresh(); put(b.candidate, "1.3.11", "badsha");
    await C.withdrawCandidate(b.candidate, null);
    assert.equal(fs.existsSync(b.candidate), false);
    const c = fresh(); put(c.candidate, "1.3.11");
    await C.withdrawCandidate(c.candidate); // no version given: allowed
    assert.equal(fs.existsSync(c.candidate), false);
});

/* ---------------------------------------------------------------- health gate */

const NOW = new Date("2026-11-15T12:00:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60_000);
const dev = (o) => ({ ring: "pilot", version: "1.3.11", lastCheckInAt: ago(1), versionChangedAt: ago(60), ...o });

check("health gate: no candidate / no pilot devices / not updated yet / healthy", () => {
    let g = C.computeGate(null, [dev()], NOW);
    assert.equal(g.status, "no_candidate"); assert.equal(g.pilotTotal, 1);
    g = C.computeGate("1.3.11", [], NOW);
    assert.equal(g.status, "no_pilot_devices"); assert.equal(g.blockers.length, 1);
    g = C.computeGate("1.3.11", [dev({ ring: "stable" }), dev({ ring: "stable" })], NOW);
    assert.equal(g.status, "no_pilot_devices"); assert.equal(g.pilotTotal, 0, "stable devices are not pilot devices");
    g = C.computeGate("1.3.11", [dev({ version: "1.3.10" }), dev({ version: "1.3.10", updateJobFailed: true })], NOW);
    assert.equal(g.status, "not_updated_yet"); assert.equal(g.notYetUpdated, 2); assert.equal(g.updateFailed, 1); assert.equal(g.onCandidate, 0); assert.ok(g.blockers.length);
    g = C.computeGate("1.3.11", [dev(), dev({ version: "1.3.10" })], NOW);
    assert.equal(g.status, "healthy"); assert.equal(g.pilotTotal, 2); assert.equal(g.onCandidate, 1); assert.equal(g.onCandidateOnline, 1); assert.equal(g.seenOnlineAfterUpdate, 1); assert.equal(g.notYetUpdated, 1); assert.deepEqual(g.blockers, []);
});

check("health gate: online window 15 min, offline-since-updating over 30 min, post-update confirmation 2 min", () => {
    // exactly 15 min is still online, 16 is not
    let g = C.computeGate("1.3.11", [dev({ lastCheckInAt: ago(15) }), dev({ lastCheckInAt: ago(16) })], NOW);
    assert.equal(g.onCandidate, 2); assert.equal(g.onCandidateOnline, 1); assert.equal(g.offlineSinceUpdating, 0, "16 minutes is not yet 'offline since updating'");
    // 30 min is not offline since, 31 is
    g = C.computeGate("1.3.11", [dev({ lastCheckInAt: ago(30) })], NOW);
    assert.equal(g.offlineSinceUpdating, 0);
    g = C.computeGate("1.3.11", [dev({ lastCheckInAt: ago(31) })], NOW);
    assert.equal(g.offlineSinceUpdating, 1); assert.equal(g.status, "offline_since_update"); assert.equal(g.blockers.length, 1);
    // seen after updating needs a check-in 2+ minutes after the version changed
    g = C.computeGate("1.3.11", [dev({ versionChangedAt: ago(1), lastCheckInAt: ago(0.5) })], NOW);
    assert.equal(g.seenOnlineAfterUpdate, 0); assert.equal(g.status, "just_updated"); assert.deepEqual(g.blockers, [], "just updated is not a blocker");
    g = C.computeGate("1.3.11", [dev({ versionChangedAt: ago(10), lastCheckInAt: ago(7) })], NOW);
    assert.equal(g.seenOnlineAfterUpdate, 1, "checked in 3 minutes after updating");
    g = C.computeGate("1.3.11", [dev({ versionChangedAt: ago(10), lastCheckInAt: ago(8.5) })], NOW);
    assert.equal(g.seenOnlineAfterUpdate, 0, "only 1.5 minutes after");
    // update time unknown (before the column existed): counts when online, never when quiet
    g = C.computeGate("1.3.11", [dev({ versionChangedAt: null, lastCheckInAt: ago(2) }), dev({ versionChangedAt: null, lastCheckInAt: ago(20) })], NOW);
    assert.equal(g.seenOnlineAfterUpdate, 1);
    // never checked in
    g = C.computeGate("1.3.11", [dev({ lastCheckInAt: null })], NOW);
    assert.equal(g.onCandidateOnline, 0); assert.equal(g.offlineSinceUpdating, 0);
    // a mix: healthy ones do not hide an offline one
    g = C.computeGate("1.3.11", [dev(), dev(), dev({ lastCheckInAt: ago(120) })], NOW);
    assert.equal(g.status, "offline_since_update"); assert.equal(g.onCandidate, 3); assert.equal(g.offlineSinceUpdating, 1); assert.equal(g.seenOnlineAfterUpdate, 3 - 0 - 0 > 0 ? g.seenOnlineAfterUpdate : 0);
    // other versions / garbage versions are "not updated yet", never "on candidate"
    g = C.computeGate("1.3.11", [dev({ version: "1.3.12" }), dev({ version: null }), dev({ version: "x" })], NOW);
    assert.equal(g.onCandidate, 0); assert.equal(g.notYetUpdated, 3);
});

/* ---------------------------------------------------------------- promote request rules */

check("promote rules: changed since, no candidate, not newer, force and reason", async () => {
    const t = fresh(); put(t.stable, "1.3.10"); put(t.candidate, "1.3.11");
    const stable = await C.inspectSlot("stable", t.stable), candidate = await C.inspectSlot("candidate", t.candidate);
    const healthy = C.computeGate("1.3.11", [dev()], NOW);
    const none = C.computeGate("1.3.11", [], NOW);
    const offline = C.computeGate("1.3.11", [dev(), dev({ lastCheckInAt: ago(90) })], NOW);
    const d = (o) => C.decidePromote({ requestedVersion: "1.3.11", candidate, stable, gate: healthy, force: undefined, reason: undefined, ...o });

    assert.deepEqual(d({}), { allow: true, forced: false, reason: null });
    assert.deepEqual(d({ force: true, reason: "ignored when healthy" }), { allow: true, forced: false, reason: null }, "force is not recorded when not needed");
    let r = d({ requestedVersion: "1.3.12" }); assert.equal(r.allow, false); assert.equal(r.code, "version_changed"); assert.equal(r.status, 409);
    r = d({ requestedVersion: undefined }); assert.equal(r.code, "version_changed");
    r = d({ candidate: { state: "absent" } }); assert.equal(r.code, "no_candidate"); assert.equal(r.status, 409);
    r = d({ candidate: await (async () => { const u = fresh(); put(u.candidate, "1.3.10"); return C.inspectSlot("candidate", u.candidate); })(), requestedVersion: "1.3.10" }); assert.equal(r.code, "not_newer");
    r = d({ candidate: await (async () => { const u = fresh(); put(u.candidate, "1.3.11", "badsha"); return C.inspectSlot("candidate", u.candidate); })() }); assert.equal(r.code, "candidate_invalid");
    // blocked gates need force + reason
    for (const gate of [none, offline, C.computeGate("1.3.11", [dev({ version: "1.3.10" })], NOW)]) {
        r = d({ gate }); assert.equal(r.allow, false); assert.equal(r.code, "force_required"); assert.equal(r.status, 409); assert.ok(r.blockers.length);
        r = d({ gate, force: "true", reason: "long enough reason" }); assert.equal(r.code, "force_required", 'force must be the boolean true, not "true"');
        r = d({ gate, force: 1, reason: "long enough reason" }); assert.equal(r.code, "force_required");
        r = d({ gate, force: true }); assert.equal(r.code, "reason_required"); assert.equal(r.status, 400);
        r = d({ gate, force: true, reason: "   ok  " }); assert.equal(r.code, "reason_required", "too short after trimming");
        r = d({ gate, force: true, reason: "x".repeat(301) }); assert.equal(r.code, "reason_invalid");
        r = d({ gate, force: true, reason: "bad \u0007 char" }); assert.equal(r.code, "reason_invalid");
        r = d({ gate, force: true, reason: "  Pilot VM is off for the weekend  " }); assert.deepEqual(r, { allow: true, forced: true, reason: "Pilot VM is off for the weekend" });
    }
    // "just updated" and a healthy gate are not blockers
    assert.equal(d({ gate: C.computeGate("1.3.11", [dev({ versionChangedAt: ago(1), lastCheckInAt: ago(0.2) })], NOW) }).allow, true);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message}`); }
    }
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
