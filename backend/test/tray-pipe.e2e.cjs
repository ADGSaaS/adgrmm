#!/usr/bin/env node
// The tray app on a Windows computer, with the REAL agent program: its pipe and its call to the server (AdgRmm.Agent.exe --tray-bridge-test)
// against a real backend and database, and the real tray process (AdgRmm.Agent.exe --tray) on this machine's desktop talking to that pipe.
// Windows only. Needs the Release build of the agent:
//   AGENT_EXE=<path to AdgRmm.Agent.exe> ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3977 DATABASE_URL=postgres://.../adg_tray_e2e JWT_SECRET=... node test/tray-pipe.e2e.cjs
"use strict";
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");

if (process.platform !== "win32") { console.log("Windows only, skipped."); process.exit(0); }
const EXE = process.env.AGENT_EXE;
if (!EXE) { console.log("Set AGENT_EXE to the built AdgRmm.Agent.exe, skipped."); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `TP${Date.now()}`;
    const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
    const admin = await staffUser("tp-admin", ["settings.read", "settings.write", "devices.read", "devices.actions"]);
    const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} Acme`])).rows[0].id; made.clients.push(client);
    const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [client, "HQ"])).rows[0].id;
    const device = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Windows 11') RETURNING id`, [site, `${tag}-pc`])).rows[0].id;
    const token = `tok-${crypto.randomBytes(12).toString("hex")}`;
    await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts, agent_token) VALUES ($1,$2,$3,'1.3.39', now(), '{}', $4)`, [uuid(), device, uuid(), sha(token)]);
    const settings = (body) => call("/api/admin/tray", { method: "PUT", token: admin.token, body });
    await settings({ enabled: false });

    const PIPE = `adg-tray-test-${process.pid}`;
    const procs = [];
    const start = (args, env = {}) => { const p = spawn(EXE, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); procs.push(p); p.out = ""; p.stdout.on("data", (d) => (p.out += d)); p.stderr.on("data", (d) => (p.out += d)); p.exited = new Promise((r) => p.once("exit", (c) => r(c))); return p; };
    const bridge = start(["--tray-bridge-test", process.env.BASE_URL, token, PIPE]);
    for (let i = 0; i < 100 && !bridge.out.includes("ready"); i++) await sleep(100);
    assert.ok(bridge.out.includes("ready"), `the bridge did not start: ${bridge.out}`);
    await sleep(500);

    /** One request on the pipe: write what is given, read the one line answer. */
    const ask = (text, pipe = PIPE) => new Promise((resolve, reject) => {
        const s = net.connect(`\\\\.\\pipe\\${pipe}`);
        let buf = "";
        const timer = setTimeout(() => { s.destroy(); reject(new Error("no answer in 20 seconds")); }, 20000);
        s.on("connect", () => s.write(text));
        s.on("data", (d) => { buf += d; if (buf.includes("\n")) { clearTimeout(timer); s.destroy(); resolve(JSON.parse(buf.split("\n")[0])); } });
        s.on("error", (e) => { clearTimeout(timer); reject(e); });
        s.on("close", () => { clearTimeout(timer); if (!buf.includes("\n")) resolve(null); });
    });
    const op = (o) => ask(JSON.stringify(o) + "\n");

    console.log("the pipe and the server");
    await test("status through the pipe is the server's answer: off until it is turned on", async () => {
        const r = await op({ op: "status" });
        assert.equal(r.ok, true); assert.equal(r.status, 200); assert.equal(r.body.enabled, false); assert.equal(r.body.device, undefined);
    });
    await test("turned on, the status shows the computer; help and chat are refused while they are off", async () => {
        await settings({ enabled: true, helpEnabled: false, chatEnabled: false, supportPhone: "555-0100" });
        const s = await op({ op: "status" });
        assert.equal(s.body.enabled, true); assert.equal(s.body.device.name, `${tag}-pc`); assert.equal(s.body.support.phone, "555-0100");
        const h = await op({ op: "help", message: "hi", user: "x" }); assert.equal(h.ok, false); assert.equal(h.status, 403); assert.match(h.error, /not turned on/);
        const c = await op({ op: "chat.send", message: "hi" }); assert.equal(c.ok, false); assert.equal(c.status, 403);
        await settings({ helpEnabled: true, chatEnabled: true });
    });
    await test("a help request through the pipe becomes a ticket for the computer, naming who asked", async () => {
        const r = await op({ op: "help", message: "The printer is jammed", user: "ACME\\sam", urgent: true });
        assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(r.body.ticket.number > 0);
        const t = (await q(`SELECT subject, priority::text AS priority, device_id FROM tickets WHERE ticket_number=$1 AND organization_id=$2`, [r.body.ticket.number, org])).rows[0];
        assert.match(t.subject, /^URGENT help request from ACME\\sam on /); assert.equal(t.priority, "high"); assert.equal(t.device_id, device);
    });
    await test("chat both ways: a line from the computer reaches the technicians, and their answer comes back through the pipe once", async () => {
        const sent = await op({ op: "chat.send", message: "Is anyone there?", user: "ACME\\sam" }); assert.equal(sent.ok, true);
        const thread = await (await call(`/api/device-chat/${device}`, { token: admin.token })).json();
        assert.equal(thread.messages.at(-1).text, "Is anyone there?"); assert.equal(thread.messages.at(-1).sender, "ACME\\sam");
        const reply = await call(`/api/device-chat/${device}`, { method: "POST", token: admin.token, body: { message: "Yes, what is wrong?" } }); assert.equal(reply.status, 200);
        const got = await op({ op: "chat.get" });
        assert.equal(got.ok, true); assert.deepEqual(got.body.messages.map((m) => [m.from, m.text]), [["you", "Is anyone there?"], ["support", "Yes, what is wrong?"]]);
        const later = await op({ op: "chat.get", after: got.body.messages.at(-1).at }); assert.deepEqual(later.body.messages, []);
        assert.equal((await op({ op: "status" })).body.unreadMessages, 0);
    });

    console.log("what the pipe refuses");
    await test("an unknown operation, no operation, empty and over-long text and bad JSON are refused before anything is sent on", async () => {
        const before = (await q(`SELECT count(*)::int AS n FROM tickets WHERE organization_id=$1`, [org])).rows[0].n;
        for (const bad of [{ op: "delete" }, {}, { op: "help", message: "  " }, { op: "chat.send", message: "x".repeat(2001) }, { op: "help", message: "ok", user: "u".repeat(201) }, { op: "chat.get", after: "z".repeat(41) }]) {
            const r = await op(bad); assert.equal(r.ok, false, JSON.stringify(bad)); assert.equal(r.status, 400, JSON.stringify([bad, r]));
        }
        const junk = await ask("this is not json\n"); assert.equal(junk.ok, false); assert.equal(junk.status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM tickets WHERE organization_id=$1`, [org])).rows[0].n, before, "a refused request made a ticket");
    });
    await test("a request over 16 KB is refused without being parsed, and the pipe keeps working", async () => {
        const huge = await ask(JSON.stringify({ op: "chat.send", message: "a".repeat(40_000) }) + "\n");
        assert.equal(huge.ok, false); assert.equal(huge.status, 400);
        assert.equal((await op({ op: "status" })).ok, true);
    });
    await test("many at once are answered (eight at a time are served, the rest are turned away, never stuck)", async () => {
        const all = await Promise.all(Array.from({ length: 20 }, () => op({ op: "status" }).then((r) => r?.ok === true, () => false)));
        assert.ok(all.filter(Boolean).length >= 8, `${all.filter(Boolean).length} of 20 answered`);
        assert.equal((await op({ op: "status" })).ok, true);
    });
    await test("a client that connects and says nothing does not hold the pipe: others are still served", async () => {
        const idle = net.connect(`\\\\.\\pipe\\${PIPE}`);
        await sleep(300);
        assert.equal((await op({ op: "status" })).ok, true);
        idle.destroy();
    });

    console.log("the tray program on this desktop");
    await test("with the tray off, it starts, hears so and closes by itself", async () => {
        await settings({ enabled: false });
        const tray = start(["--tray", "--tray-pipe", PIPE], { ADG_TRAY_POLL_SECONDS: "1" });
        const code = await Promise.race([tray.exited, sleep(15000).then(() => "still running")]);
        if (code === "still running") tray.kill();
        assert.equal(code, 0, `it did not close: ${tray.out}`);
    });
    await test("with the tray on, it keeps running; one tray per person (a second one closes at once); turning it off closes it", async () => {
        await settings({ enabled: true });
        const tray = start(["--tray", "--tray-pipe", PIPE], { ADG_TRAY_POLL_SECONDS: "1" });
        await sleep(5000);
        assert.equal(tray.exitCode, null, `it closed by itself while on: ${tray.out}`);
        const second = start(["--tray", "--tray-pipe", PIPE], { ADG_TRAY_POLL_SECONDS: "1" });
        assert.equal(await Promise.race([second.exited, sleep(10000).then(() => "still running")]), 0, "a second tray stayed open");
        await settings({ enabled: false });
        const code = await Promise.race([tray.exited, sleep(20000).then(() => "still running")]);
        if (code === "still running") tray.kill();
        assert.equal(code, 0, "it stayed open after support turned it off");
    });
    await test("when the agent is not there it waits quietly instead of closing or crashing", async () => {
        await settings({ enabled: true });
        const tray = start(["--tray", "--tray-pipe", "adg-tray-no-such-pipe"], { ADG_TRAY_POLL_SECONDS: "1" });
        await sleep(6000);
        const alive = tray.exitCode === null;
        tray.kill();
        assert.ok(alive, `it closed on its own: ${tray.out}`);
    });

    for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
    await q(`DELETE FROM tickets WHERE organization_id=$1 AND subject LIKE '%help request%'`, [org]);
    await q(`DELETE FROM tray_settings WHERE organization_id=$1`, [org]);
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
