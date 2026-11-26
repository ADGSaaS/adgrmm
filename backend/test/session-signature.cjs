#!/usr/bin/env node
// Runs the real session services and signer with a fake database and fake sockets, then has the
// agents' real verifier judge what they sent. It needs no database and installs nothing.
//
//   npx tsc -p tsconfig.json          (in backend/)
//   node test/session-signature.cjs
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("reflect-metadata");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adg-session-sig-"));
process.env.JOB_SIGNING_KEY_FILE = path.join(tmp, "job-signing.pem");
process.env.NODE_ENV = "development";
// No relay is needed, and the session must not depend on one.
process.env.TURN_PROVIDER = "none";

const dist = path.join(__dirname, "..", "dist");
const { JobSignerService } = require(path.join(dist, "common/job-signer.service"));
const { RemoteConsoleService } = require(path.join(dist, "remote-console/remote-console.service"));
const { RemoteShellGateway } = require(path.join(dist, "remote-shell/remote-shell.gateway"));
const { RemoteDesktopTunnelService } = require(path.join(dist, "remote-desktop/remote-desktop-tunnel.service"));
const { RemoteDesktopService } = require(path.join(dist, "remote-desktop/remote-desktop.service"));

// agents.id, which agents sign against, deliberately differs from the uuid shell sockets are keyed by.
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_UUID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";

class FakeSocket {
    constructor() { this.readyState = 1; this.sent = []; this.handlers = {}; }
    send(data) { if (typeof data === "string") this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    on(event, fn) { this.handlers[event] = fn; }
    frames(type) { return this.sent.filter((m) => m.type === type); }
}

async function waitFor(check, what) {
    for (let i = 0; i < 200; i++) {
        const value = check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function payloadOf(frame) {
    return JSON.parse(Buffer.from(frame.signed.payload, "base64").toString("utf8"));
}

let checks = 0;
function pass(name) { checks++; console.log(`pass  ${name}`); }

async function consoleFrames(signer) {
    const prisma = {
        agents: { findFirst: async () => ({ id: AGENT_ID }) },
    };
    const svc = new RemoteConsoleService(prisma, signer, undefined, { assertDevice: async () => undefined });
    const agentWs = new FakeSocket();
    const techWs = new FakeSocket();

    await svc.handleWsMessage(agentWs, JSON.stringify({ type: "hello", kind: "agent", agentUuid: AGENT_ID, agentToken: "t" }), false);
    const { sessionId, sessionToken } = await svc.createSession(AGENT_ID, { id: "tech", name: "Tech" });
    await svc.handleWsMessage(techWs, JSON.stringify({ type: "hello", kind: "tech", sessionId, sessionToken }), false);

    const ready = agentWs.frames("session.ready")[0];
    assert.ok(ready?.signed, "the agent's session.ready carries the envelope");
    assert.equal(ready.sessionId, sessionId, "existing fields stay for older agents");
    assert.ok("iceServers" in ready, "existing fields stay for older agents");
    assert.equal(payloadOf(ready).kind, "console");
    assert.equal(techWs.frames("session.ready")[0].signed, undefined, "the technician gets no envelope");
    pass("console: session.ready is signed for agents.id, and keeps its existing fields");

    // Only the agent the session belongs to can end it this way.
    const stranger = new FakeSocket();
    stranger.__rcAuthed = true;
    stranger.__rcKind = "agent";
    stranger.__rcAgentId = OTHER_AGENT;
    await svc.handleWsMessage(stranger, JSON.stringify({ type: "session.refused", sessionId, reason: "no" }), false);
    assert.equal(techWs.frames("session.closed").length, 0);
    await svc.handleWsMessage(techWs, JSON.stringify({ type: "session.refused", sessionId, reason: "no" }), false);
    assert.equal(techWs.frames("session.closed").length, 0);
    pass("console: another agent or a technician cannot report a refusal");

    await svc.handleWsMessage(agentWs, JSON.stringify({ type: "session.refused", sessionId, reason: "Check this device's clock." }), false);
    const closed = techWs.frames("session.closed")[0];
    assert.equal(closed?.reason, "agent_refused");
    assert.equal(closed?.message, "Check this device's clock.");
    pass("console: the agent's refusal reaches the technician with its reason");

    return ready;
}

async function shellFrame(signer) {
    const wsAuth = {
        authenticateAgent: async () => ({ id: AGENT_ID, agentUuid: AGENT_UUID, deviceId: "d" }),
        authenticateUser: async () => ({ id: "tech", permissions: new Set(["devices.actions"]) }),
        isOriginAllowed: () => true,
        resolveAgentUuid: async () => AGENT_UUID,
        resolveAgent: async () => ({ agentUuid: AGENT_UUID, deviceId: "d" }),
    };
    const access = { scopeFor: async () => null, canSeeDevice: async () => true };
    const gateway = new RemoteShellGateway(wsAuth, signer, { record: async () => undefined, lookupLabel: async () => null }, access);
    const agentWs = new FakeSocket();
    const uiWs = new FakeSocket();

    gateway.handleConnection(agentWs, { url: `/ws/shell?role=agent&agentUuid=${AGENT_ID}`, headers: { host: "x" } });
    gateway.handleConnection(uiWs, { url: `/ws/shell?role=ui&agentUuid=${AGENT_ID}`, headers: { host: "x" } });
    await waitFor(() => uiWs.frames("status").length, "the UI to connect");

    await uiWs.handlers.message(JSON.stringify({ type: "open", cols: 80, rows: 24, runAs: "user" }));
    const open = await waitFor(() => agentWs.frames("shell.open")[0], "shell.open");

    assert.ok(open.signed, "shell.open carries the envelope");
    assert.equal(open.runAs, "user", "existing fields stay for older agents");
    const contents = payloadOf(open);
    assert.equal(contents.agentId, AGENT_ID, "signed for agents.id, not the socket's uuid");
    assert.equal(contents.runAs, "user", "who the shell runs as is signed");
    pass("shell: shell.open is signed for agents.id, with runAs inside the signature");

    return open;
}

async function desktopFrames(signer) {
    const tunnels = new RemoteDesktopTunnelService(signer);
    const agentWs = new FakeSocket();
    tunnels.registerAgent(AGENT_ID, agentWs);

    const opening = tunnels.openTunnel(AGENT_ID, { host: "127.0.0.1", port: 3390 });
    const open = await waitFor(() => agentWs.frames("rdp.open")[0], "rdp.open");
    assert.ok(open.signed, "rdp.open carries the envelope");
    assert.equal(open.port, 3390, "existing fields stay for older agents");
    assert.equal(payloadOf(open).port, 3390, "the port is signed");
    tunnels.handleAgentText(AGENT_ID, { type: "rdp.ready", sessionId: open.sessionId });
    await opening;
    await tunnels.closeTunnel(open.sessionId, "test");
    pass("desktop: rdp.open is signed, with the port inside the signature");

    // A refusal from the agent has to fail the request with the agent's words.
    const refused = tunnels.openTunnel(AGENT_ID, { host: "127.0.0.1", port: 3389 });
    const second = await waitFor(() => agentWs.frames("rdp.open")[1], "the second rdp.open");
    tunnels.handleAgentText(AGENT_ID, { type: "rdp.error", sessionId: second.sessionId, code: "SESSION_REFUSED", message: "not signed" });
    await assert.rejects(refused, /not signed/);
    pass("desktop: the agent's refusal reaches the caller with its reason");

    const legacy = new RemoteDesktopService(signer);
    const legacyWs = new FakeSocket();
    legacy.registerAgent(AGENT_ID, legacyWs);
    const { sessionId } = await legacy.createTunnelSession(AGENT_ID, "127.0.0.1", 3389);
    assert.ok(legacyWs.frames("rdp.open")[0].signed, "the older service signs too");
    legacy.endSession(sessionId, "test");
    pass("desktop: the older tunnel service signs too");

    return open;
}

function atTime(offsetMs, fn) {
    const real = Date.now;
    Date.now = () => real() + offsetMs;
    try { return fn(); } finally { Date.now = real; }
}

function buildVectors(signer, pem, otherSigner, frames) {
    const sid = () => crypto.randomUUID();
    const start = (agentId, kind, sessionId, bound) => ({
        type: "start",
        sessionId,
        ...signer.sessionStartField(agentId, kind, sessionId, bound),
    });
    const vectors = [];
    const add = (name, message, kind, sessionId, expect, extra = {}) =>
        vectors.push({ name, message, kind, sessionId, expect, agentId: AGENT_ID, publicKeyPem: pem, ...extra });

    add("real console frame verifies", frames.console, "console", frames.console.sessionId, "ok");
    add("real shell frame verifies", frames.shell, "shell", frames.shell.sessionId, "ok", { expectField: { runAs: "user" } });
    add("real desktop frame verifies", frames.desktop, "desktop", frames.desktop.sessionId, "ok", { expectField: { port: "3390" } });
    add("a captured frame cannot be replayed", frames.shell, "shell", frames.shell.sessionId, "already used");

    const a = sid();
    const reused = start(AGENT_ID, "shell", a, { runAs: "system" });
    add("wrong session id is refused", reused, "shell", sid(), "different session");
    add("a refusal does not use up the nonce", reused, "shell", a, "ok");

    const b = sid();
    add("wrong agent is refused", start(OTHER_AGENT, "shell", b), "shell", b, "different agent");
    const c = sid();
    add("wrong kind is refused", start(AGENT_ID, "desktop", c), "shell", c, "different kind");

    const d = sid();
    add("expired by 16 minutes is refused", atTime(-16 * 60_000, () => start(AGENT_ID, "console", d)), "console", d, "expired");
    const e = sid();
    add("16 minutes in the future is refused", atTime(16 * 60_000, () => start(AGENT_ID, "console", e)), "console", e, "expired");
    const f = sid();
    add("14 minutes old still verifies", atTime(-14 * 60_000, () => start(AGENT_ID, "console", f)), "console", f, "ok");

    const g = sid();
    const tamperedPayload = start(AGENT_ID, "shell", g, { runAs: "user" });
    const changed = JSON.parse(Buffer.from(tamperedPayload.signed.payload, "base64").toString("utf8"));
    changed.runAs = "system";
    tamperedPayload.signed.payload = Buffer.from(JSON.stringify(changed)).toString("base64");
    add("tampered payload is refused", tamperedPayload, "shell", g, "signature is invalid");

    const h = sid();
    const tamperedSig = start(AGENT_ID, "shell", h);
    const sigBytes = Buffer.from(tamperedSig.signed.sig, "base64");
    sigBytes[10] ^= 0xff;
    tamperedSig.signed.sig = sigBytes.toString("base64");
    add("tampered signature is refused", tamperedSig, "shell", h, "signature is invalid");

    const i = sid();
    const outside = start(AGENT_ID, "shell", i, { runAs: "user" });
    outside.runAs = "system";
    add("a field changed outside the signature has no effect", outside, "shell", i, "ok", { expectField: { runAs: "user" } });

    const j = sid();
    add("unsigned start is refused", { type: "shell.open", sessionId: j, runAs: "system" }, "shell", j, "not signed");

    const k = sid();
    add("signed with another key is refused", {
        sessionId: k,
        ...otherSigner.sessionStartField(AGENT_ID, "shell", k),
    }, "shell", k, "signature is invalid");

    const l = sid();
    add("a signed job cannot start a session", {
        sessionId: l,
        signed: signer.seal(AGENT_ID, { t: "job_run_script", jobId: sid(), sessionId: l, kind: "shell", nonce: sid() }),
    }, "shell", l, "not a session start");

    const m = sid();
    add("agent without a key refuses", start(AGENT_ID, "shell", m), "shell", m, "no signing key", { publicKeyPem: "" });

    const n = sid();
    add("garbage is refused", { sessionId: n, signed: { payload: "%%%", sig: "%%%" } }, "shell", n, "could not be read");

    const o = sid();
    add("agent id case does not matter", start(AGENT_ID, "shell", o), "shell", o, "ok", { agentId: AGENT_ID.toUpperCase() });

    // An agent reconnecting mid-setup is announced the same session again, under a new nonce.
    const p = sid();
    add("first announcement of a session", start(AGENT_ID, "console", p), "console", p, "ok");
    add("a new announcement of that session", start(AGENT_ID, "console", p), "console", p, "ok");

    return vectors;
}

(async () => {
    try {
        const signer = new JobSignerService();
        const pem = signer.publicKeyPem();

        process.env.JOB_SIGNING_KEY_FILE = path.join(tmp, "other.pem");
        const otherSigner = new JobSignerService();
        otherSigner.publicKeyPem();

        const frames = {
            console: await consoleFrames(signer),
            shell: await shellFrame(signer),
            desktop: await desktopFrames(signer),
        };

        const failing = new JobSignerService();
        failing.seal = () => { throw new Error("no key"); };
        assert.deepEqual(failing.sessionStartField(AGENT_ID, "shell", "x"), {}, "older agents keep working");
        pass("a signing failure leaves the message unsigned rather than failing the request");

        const vectorFile = path.join(tmp, "vectors.json");
        fs.writeFileSync(vectorFile, JSON.stringify(buildVectors(signer, pem, otherSigner, frames)));

        const project = path.join(__dirname, "..", "..", "agents", "tests", "SessionStartCheck");
        const run = spawnSync("dotnet", ["run", "--project", project, "-c", "Release", "--", vectorFile], {
            stdio: "inherit",
        });
        assert.equal(run.status, 0, "the agent's verifier disagreed with an expected result");

        console.log(`\nAll backend checks passed (${checks}), and the agent's verifier agreed on every vector.`);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})();
