#!/usr/bin/env node
// Domain, DNS and certificate monitoring through the real HTTP API and a real database, against stand-ins for the internet that are real servers:
// a TLS server whose certificate is swapped (made by a test CA with openssl: valid, running out, expired, wrong name, self-signed), a registry
// that speaks RDAP, and a DNS server that answers over UDP and whose records can be changed. Rights, the customer limit, the state changes and
// the news they make (webhook events), the error rule (three in a row), accepting changed DNS records, and the scheduled run.
//
// The backend under test has to be started with:
//   MONITOR_ALLOW_PRIVATE=true RDAP_BASE_URL=http://127.0.0.1:4871/domain/ MONITOR_DNS_SERVERS=127.0.0.1:4872
//   NODE_EXTRA_CA_CERTS=<tmp>/adg-wm-e2e/ca.pem      (create the CA first: node test/web-monitors-http.e2e.cjs --prepare)
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3977 DATABASE_URL=postgres://.../adg_wm_e2e JWT_SECRET=... node test/web-monitors-http.e2e.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dgram = require("node:dgram");
const http = require("node:http");
const tls = require("node:tls");
const { spawnSync } = require("node:child_process");

const DIR = path.join(os.tmpdir(), "adg-wm-e2e");
const sh = (args) => { const r = spawnSync("openssl", args, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`openssl ${args.join(" ")}: ${r.stderr}`); };
function prepare() {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(path.join(DIR, "ca.pem"))) {
        sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(DIR, "ca.key"), "-out", path.join(DIR, "ca.pem"), "-days", "3650", "-subj", "/CN=Adg Test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    }
}
if (process.argv.includes("--prepare")) { prepare(); console.log(path.join(DIR, "ca.pem")); process.exit(0); }

const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");
const RDAP_PORT = 4871, DNS_PORT = 4872;

/* ------------------------------ stand-ins for the internet ------------------------------ */

const fmt = (d) => d.toISOString().replace(/[-:T]/g, "").replace(/\.\d+Z$/, "Z");
let n = 0;
/** A certificate and key. `ca` signs it unless `self`; `san` is the subjectAltName; valid from `fromDays` to `toDays` (from now). */
function makeCert({ san = "IP:127.0.0.1", fromDays = -1, toDays = 90, self = false }) {
    const id = `c${++n}`;
    const key = path.join(DIR, `${id}.key`), pem = path.join(DIR, `${id}.pem`), csr = path.join(DIR, `${id}.csr`), ext = path.join(DIR, `${id}.ext`);
    if (self) {
        sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", pem, "-days", String(Math.max(toDays, 1)), "-subj", "/CN=self-signed", "-addext", `subjectAltName=${san}`]);
    } else {
        sh(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=adg-test-leaf"]);
        fs.writeFileSync(ext, `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
        const day = 86_400_000;
        sh(["x509", "-req", "-in", csr, "-CA", path.join(DIR, "ca.pem"), "-CAkey", path.join(DIR, "ca.key"), "-CAcreateserial", "-out", pem, "-extfile", ext,
            "-not_before", fmt(new Date(Date.now() + fromDays * day)), "-not_after", fmt(new Date(Date.now() + toDays * day))]);
    }
    return { key: fs.readFileSync(key), cert: fs.readFileSync(pem) };
}
const tlsServers = [];
const serveTls = (creds) => new Promise((resolve) => {
    const s = tls.createServer(creds, (sock) => { sock.on("error", () => { }); sock.end(); });
    s.listen(0, "127.0.0.1", () => { tlsServers.push(s); resolve({ port: s.address().port, swap: (c) => s.setSecureContext(c) }); });
});

const registry = {};
const rdap = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || "").replace(/^\/domain\//, ""));
    const r = registry[name];
    if (!r) { res.writeHead(404, { "content-type": "application/rdap+json" }); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/rdap+json" });
    res.end(JSON.stringify({
        events: [{ eventAction: "registration", eventDate: "2015-01-01T00:00:00Z" }, ...(r.expires ? [{ eventAction: "expiration", eventDate: r.expires }] : [])],
        status: r.status ?? ["client transfer prohibited"],
        entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Stub Registrar"]]] }],
        nameservers: [{ ldhName: "ns1.stub.test" }],
    }));
});

const zone = {};
const enc = (name) => Buffer.concat([...name.replace(/\.$/, "").split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const rdata = (type, v) => {
    if (type === "A") return Buffer.from(v.split(".").map(Number));
    if (type === "AAAA") { const parts = v.split(":"); const b = Buffer.alloc(16); parts.forEach((p, i) => b.writeUInt16BE(parseInt(p || "0", 16), i * 2)); return b; }
    if (type === "NS" || type === "CNAME") return enc(v);
    if (type === "MX") { const [p, h] = v.split(" "); return Buffer.concat([Buffer.from([Number(p) >> 8, Number(p) & 255]), enc(h)]); }
    return Buffer.concat([Buffer.from([Buffer.byteLength(v)]), Buffer.from(v)]); // TXT
};
const QT = { 1: "A", 2: "NS", 5: "CNAME", 15: "MX", 16: "TXT", 28: "AAAA" };
const TT = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const dnsServer = dgram.createSocket("udp4");
dnsServer.on("message", (msg, rinfo) => {
    let o = 12; const labels = [];
    while (msg[o] !== 0) { labels.push(msg.slice(o + 1, o + 1 + msg[o]).toString()); o += msg[o] + 1; }
    const qtype = msg.readUInt16BE(o + 1); const question = msg.slice(12, o + 5);
    const name = labels.join(".").toLowerCase(); const type = QT[qtype];
    const known = zone[name]; const answers = known && type ? (known[type] ?? []) : [];
    const head = Buffer.alloc(12); msg.copy(head, 0, 0, 2);
    head.writeUInt16BE(0x8180 | (known ? 0 : 3), 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(answers.length, 6);
    const rr = answers.map((v) => { const d = rdata(type, v); const h = Buffer.alloc(12); h.writeUInt16BE(0xc00c, 0); h.writeUInt16BE(TT[type], 2); h.writeUInt16BE(1, 4); h.writeUInt32BE(60, 6); h.writeUInt16BE(d.length, 10); return Buffer.concat([h, d]); });
    dnsServer.send(Buffer.concat([head, question, ...rr]), rinfo.port, rinfo.address);
});

/* ------------------------------ the test ------------------------------ */

async function main() {
    prepare();
    await new Promise((r) => rdap.listen(RDAP_PORT, "127.0.0.1", r));
    await new Promise((r) => dnsServer.bind(DNS_PORT, "127.0.0.1", r));
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `WM${Date.now()}`;

    const ops = await staffUser("wm-ops", ["checks.read", "checks.write", "checks.delete", "checks.run"]);
    const reader = await staffUser("wm-reader", ["checks.read"]);
    const limited = await staffUser("wm-limited", ["checks.read", "checks.write", "checks.delete", "checks.run"]);
    const mkClient = async (nm) => { const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${nm}`])).rows[0].id; made.clients.push(id); return id; };
    const A = await mkClient("Alpha"), B = await mkClient("Bravo");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A]);

    const W = (p, t, body, method = "POST") => call(`/api/monitors/web${p}`, { method, token: t?.token, body });
    const ok = async (p, t, body, method = "POST", want = 200) => { const r = await W(p, t, body, method); assert.equal(r.status, want, `${method} ${p}: ${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`); return r.json(); };
    const list = async (t, qs = "") => (await ok(qs, t, undefined, "GET")).items;
    const events = async (id) => (await q(`SELECT event, payload FROM webhook_deliveries WHERE event LIKE 'monitor.%' AND payload->'data'->'monitor'->>'id' = $1 ORDER BY created_at`, [id])).rows;
    // a webhook endpoint that wants the monitor events, so that news is queued
    const hook = await q(`INSERT INTO webhook_endpoints (organization_id, name, url, events, secret, enabled) VALUES ($1,$2,'https://example.invalid/hook',$3,'x',true) RETURNING id`, [org, `${tag} hook`, ["monitor.failed", "monitor.recovered"]]);
    const cleanMonitors = async () => { await q(`DELETE FROM web_monitors WHERE organization_id=$1 AND name LIKE $2`, [org, `${tag}%`]); await q(`DELETE FROM webhook_endpoints WHERE id=$1`, [hook.rows[0].id]); };

    console.log("rights and the list");
    await test("signing in is needed; reading needs checks.read; making needs checks.write; deleting needs checks.delete; running needs checks.run", async () => {
        assert.equal((await W("", undefined, undefined, "GET")).status, 401);
        assert.equal((await W("", reader, undefined, "GET")).status, 200);
        assert.equal((await W("", reader, { kind: "domain", host: "rights.test", name: `${tag} r` })).status, 403);
        const m = await ok("", ops, { kind: "domain", host: "rights.test", name: `${tag} rights` }, "POST", 201);
        assert.equal((await W(`/${m.id}/run`, reader)).status, 403);
        assert.equal((await W(`/${m.id}`, reader, undefined, "DELETE")).status, 403);
        assert.equal((await W(`/${m.id}`, ops, undefined, "DELETE")).status, 200);
    });

    console.log("what may be saved");
    await test("bad kinds, names, ports, limits and record types are refused with a reason; a repeat is a 409; the customer has to exist", async () => {
        const bad = async (body, re, status = 400) => { const r = await W("", ops, { name: `${tag} bad`, ...body }); assert.equal(r.status, status, JSON.stringify(body)); if (re) assert.match(JSON.stringify(await r.json()), re); };
        await bad({ kind: "ping", host: "a.example" }, /certificate, a domain or DNS/);
        await bad({ kind: "certificate", host: "https://a.example" }, /without https/);
        await bad({ kind: "certificate", host: "a.example/path" }, /without a path/);
        await bad({ kind: "domain", host: "localhost" }, /valid host name/);
        await bad({ kind: "domain", host: "10.1.1.1" }, /not an address/);
        await bad({ kind: "certificate", host: "a.example", port: 70000 }, /port/);
        await bad({ kind: "certificate", host: "a.example", config: { warnDays: 5, failDays: 9 } }, /fewer days/);
        await bad({ kind: "dns", host: "a.example", config: { records: [{ type: "SRV" }] } }, /must be one of/);
        await bad({ kind: "domain", host: "a.example", clientId: uuid() }, /does not exist/);
        await bad({ kind: "domain", host: "a.example", clientId: "nope" }, /Choose a customer/);
        const first = await ok("", ops, { kind: "domain", host: `dup-${n}.example`, name: `${tag} dup` }, "POST", 201);
        const again = await W("", ops, { kind: "domain", host: `DUP-${n}.example.`, name: `${tag} dup2` }); assert.equal(again.status, 409);
        assert.match(JSON.stringify(await again.json()), /already monitored/);
        await ok(`/${first.id}`, ops, undefined, "DELETE");
    });

    console.log("certificates");
    const certCase = async (name, creds, cfg, expectStatus, re, port) => {
        const srv = port ? { port } : await serveTls(creds);
        const m = await ok("", ops, { kind: "certificate", host: "127.0.0.1", port: srv.port, name: `${tag} ${name}`, ...(cfg ? { config: cfg } : {}) }, "POST", 201);
        const r = await ok(`/${m.id}/run`, ops);
        assert.equal(r.status, expectStatus, `${name}: ${r.status} ${r.detail}`);
        if (re) assert.match(r.detail, re);
        return { m: r, srv };
    };
    await test("a trusted certificate with plenty of time is ok, with its dates, issuer and names", async () => {
        const { m } = await certCase("good", makeCert({ toDays: 120 }), null, "ok", /more days/);
        assert.ok(m.daysLeft >= 118 && m.daysLeft <= 120, String(m.daysLeft)); assert.ok(m.expiresAt);
        assert.equal(m.result.trusted, true); assert.ok(m.result.names.includes("127.0.0.1")); assert.ok(m.lastCheckedAt);
    });
    await test("a certificate with 20 days left warns, with 3 days left fails, an expired one fails and says how long ago", async () => {
        await certCase("warn", makeCert({ toDays: 20 }), null, "warning", /runs out in 19|runs out in 20/);
        await certCase("soon", makeCert({ toDays: 3 }), null, "failed", /runs out in/);
        await certCase("expired", makeCert({ fromDays: -40, toDays: -5 }), null, "failed", /expired/);
    });
    await test("the limits can be set per monitor: 20 days is fine with a 10-day warning", async () => {
        await certCase("custom", makeCert({ toDays: 20 }), { warnDays: 10, failDays: 3 }, "ok");
    });
    await test("a self-signed certificate and one made for another name fail with the reason", async () => {
        await certCase("self", makeCert({ self: true, toDays: 60 }), null, "failed", /not trusted/);
        await certCase("wrongname", makeCert({ san: "IP:10.9.9.9" }), null, "failed", /name does not match/);
    });

    console.log("news: a change of state is announced once, in both directions");
    let swapCase;
    await test("ok, then a certificate that runs out: one monitor.failed (warning); checking again says nothing new; a renewed certificate gives one monitor.recovered", async () => {
        swapCase = await certCase("swap", makeCert({ toDays: 100 }), null, "ok");
        assert.equal((await events(swapCase.m.id)).length, 0, "an ok monitor made news");
        swapCase.srv.swap(makeCert({ toDays: 12 }));
        const w = await ok(`/${swapCase.m.id}/run`, ops); assert.equal(w.status, "warning");
        let ev = await events(swapCase.m.id); assert.equal(ev.length, 1); assert.equal(ev[0].event, "monitor.failed");
        assert.equal(ev[0].payload.data.severity, "warning"); assert.match(ev[0].payload.data.detail, /runs out/); assert.equal(ev[0].payload.data.monitor.host, "127.0.0.1");
        await ok(`/${swapCase.m.id}/run`, ops); assert.equal((await events(swapCase.m.id)).length, 1, "the same warning was announced twice");
        swapCase.srv.swap(makeCert({ toDays: 3 }));
        assert.equal((await ok(`/${swapCase.m.id}/run`, ops)).status, "failed");
        ev = await events(swapCase.m.id); assert.equal(ev.length, 2, "warning to failed is news again"); assert.equal(ev[1].payload.data.severity, "failed");
        swapCase.srv.swap(makeCert({ toDays: 365 }));
        assert.equal((await ok(`/${swapCase.m.id}/run`, ops)).status, "ok");
        ev = await events(swapCase.m.id); assert.equal(ev.length, 3); assert.equal(ev[2].event, "monitor.recovered");
        await ok(`/${swapCase.m.id}/run`, ops); assert.equal((await events(swapCase.m.id)).length, 3);
        const row = (await list(ops)).find((x) => x.id === swapCase.m.id); assert.equal(row.status, "ok"); assert.ok(row.statusSince);
    });
    await test("a server that cannot be reached is an error only after three checks in a row, announced once, and the earlier state stays until then", async () => {
        const dead = await serveTls(makeCert({ toDays: 100 }));
        const m = await ok("", ops, { kind: "certificate", host: "127.0.0.1", port: dead.port, name: `${tag} dying` }, "POST", 201);
        assert.equal((await ok(`/${m.id}/run`, ops)).status, "ok");
        await new Promise((r) => tlsServers.find((s) => s.address()?.port === dead.port).close(r));
        let r = await ok(`/${m.id}/run`, ops); assert.equal(r.status, "ok", "one bad check changed the state"); assert.equal((await events(m.id)).length, 0);
        r = await ok(`/${m.id}/run`, ops); assert.equal(r.status, "ok");
        r = await ok(`/${m.id}/run`, ops); assert.equal(r.status, "error"); assert.match(r.detail, /refused|Could not connect/);
        assert.equal((await events(m.id)).length, 1); assert.equal((await events(m.id))[0].payload.data.severity, "error");
        await ok(`/${m.id}/run`, ops); assert.equal((await events(m.id)).length, 1, "the error was announced twice");
    });

    console.log("domains");
    const iso = (d) => new Date(Date.now() + d * 86_400_000).toISOString();
    const domainCase = async (host, entry, status, re) => {
        if (entry) registry[host] = entry;
        const m = await ok("", ops, { kind: "domain", host, name: `${tag} ${host}` }, "POST", 201);
        const r = await ok(`/${m.id}/run`, ops); assert.equal(r.status, status, `${host}: ${r.status} ${r.detail}`); if (re) assert.match(r.detail, re); return r;
    };
    await test("a domain far from expiry is ok with its registrar; 30 days warns; 8 days and an expired date fail; a hold fails whatever the date", async () => {
        const r = await domainCase("fine.test", { expires: iso(300) }, "ok", /at Stub Registrar/); assert.ok(r.daysLeft >= 298); assert.equal(r.result.registrar, "Stub Registrar");
        await domainCase("warn.test", { expires: iso(30) }, "warning", /runs out in 2\d days|runs out in 30 days/);
        await domainCase("soon.test", { expires: iso(8) }, "failed", /runs out in/);
        await domainCase("gone.test", { expires: iso(-4) }, "failed", /expired 4 days ago/);
        await domainCase("held.test", { expires: iso(300), status: ["clientHold"] }, "failed", /clientHold/);
    });
    await test("a name the registry does not know is an error that says to use the registered domain", async () => {
        const m = await ok("", ops, { kind: "domain", host: "www.unknown.test", name: `${tag} unknown` }, "POST", 201);
        const r = await ok(`/${m.id}/run`, ops); assert.equal(r.status, "pending", "the first error must not show as a state"); assert.match(r.detail ?? "", /no record|registered domain/);
    });

    console.log("DNS records");
    zone["site.test"] = { A: ["192.0.2.1"], MX: ["10 mail.site.test"], NS: ["ns1.site.test", "ns2.site.test"], TXT: ["v=spf1 -all", "other=1"] };
    let dnsId;
    await test("with nothing expected, the first look is remembered and the records are ok; the result lists them", async () => {
        const m = await ok("", ops, { kind: "dns", host: "site.test", name: `${tag} site` }, "POST", 201); dnsId = m.id;
        const r = await ok(`/${m.id}/run`, ops); assert.equal(r.status, "ok");
        assert.deepEqual(r.result.records.A, ["192.0.2.1"]); assert.deepEqual(r.result.records.MX, ["10 mail.site.test"]); assert.deepEqual(r.result.records.NS, ["ns1.site.test", "ns2.site.test"]);
        assert.deepEqual(r.config.baseline.A, ["192.0.2.1"]);
    });
    await test("a change is a warning that names what went and what came, announced once; accepting the new records makes it ok and announces the recovery", async () => {
        zone["site.test"].A = ["198.51.100.20"];
        const r = await ok(`/${dnsId}/run`, ops); assert.equal(r.status, "warning"); assert.match(r.detail, /A changed: no longer 192\.0\.2\.1; now also 198\.51\.100\.20/);
        assert.equal((await events(dnsId)).length, 1); await ok(`/${dnsId}/run`, ops); assert.equal((await events(dnsId)).length, 1);
        const acc = await ok(`/${dnsId}/accept`, ops); assert.equal(acc.status, "ok"); assert.deepEqual(acc.config.baseline.A, ["198.51.100.20"]);
        const ev = await events(dnsId); assert.equal(ev.length, 2); assert.equal(ev[1].event, "monitor.recovered");
    });
    await test("expected values: a record that is not there fails; TXT only needs the wanted entry; the right values are ok", async () => {
        // the same name and kind can only be monitored once, so each case uses its own name served by the stand-in
        zone["exp-ok.test"] = { MX: ["10 mail.exp-ok.test"], TXT: ["v=spf1 -all", "other=1"] };
        zone["exp-bad.test"] = { MX: ["10 mail.exp-bad.test"], TXT: ["other=1"] };
        const a = await ok("", ops, { kind: "dns", host: "exp-ok.test", name: `${tag} exp-ok`, config: { records: [{ type: "MX", expected: ["10 MAIL.exp-ok.test."] }, { type: "TXT", expected: ["v=spf1 -all"] }] } }, "POST", 201);
        assert.equal((await ok(`/${a.id}/run`, ops)).status, "ok");
        const b = await ok("", ops, { kind: "dns", host: "exp-bad.test", name: `${tag} exp-bad`, config: { records: [{ type: "TXT", expected: ["v=spf1 -all"] }, { type: "A" }] } }, "POST", 201);
        const rb = await ok(`/${b.id}/run`, ops); assert.equal(rb.status, "failed"); assert.match(rb.detail, /TXT is missing v=spf1 -all/);
        assert.equal((await events(b.id))[0].payload.data.severity, "failed");
    });
    await test("changing what is watched forgets what was remembered", async () => {
        const r = await ok(`/${dnsId}`, ops, { config: { records: [{ type: "A" }] } }, "PATCH");
        assert.equal(r.config.baseline, undefined, JSON.stringify(r.config)); assert.deepEqual(r.config.records, [{ type: "A" }]);
    });

    console.log("who sees what");
    await test("a limited person sees only their customers' monitors, cannot reach another customer's by id, and has to name one of their own customers", async () => {
        const a = await ok("", limited, { kind: "domain", host: "alpha-only.test", name: `${tag} alpha`, clientId: A }, "POST", 201);
        registry["bravo-only.test"] = { expires: iso(300) };
        const b = await ok("", ops, { kind: "domain", host: "bravo-only.test", name: `${tag} bravo`, clientId: B }, "POST", 201);
        const none = await ok("", ops, { kind: "domain", host: "no-customer.test", name: `${tag} nobody` }, "POST", 201);
        const mine = (await list(limited)).map((x) => x.id);
        assert.ok(mine.includes(a.id)); assert.ok(!mine.includes(b.id)); assert.ok(!mine.includes(none.id), "a monitor of no customer is visible to a limited person");
        assert.equal((await W(`/${b.id}/run`, limited)).status, 404); assert.equal((await W(`/${b.id}`, limited, { name: "x" }, "PATCH")).status, 404); assert.equal((await W(`/${b.id}`, limited, undefined, "DELETE")).status, 404);
        assert.equal((await W("", limited, { kind: "domain", host: "sneaky.test", clientId: B })).status, 403, "created for another customer");
        const without = await W("", limited, { kind: "domain", host: "sneaky2.test" }); assert.equal(without.status, 400); assert.match(JSON.stringify(await without.json()), /Choose the customer/);
        assert.equal((await W(`/${a.id}`, limited, { clientId: B }, "PATCH")).status, 403, "moved to another customer");
        const all = (await list(ops)).map((x) => x.id); assert.ok(all.includes(a.id) && all.includes(b.id) && all.includes(none.id));
        const only = await list(ops, `?clientId=${B}`); assert.ok(only.length >= 1 && only.every((x) => x.clientId === B));
        const failed = (await ok("?status=failed", ops, undefined, "GET")).items; assert.ok(failed.every((x) => x.status === "failed"));
    });
    await test("the list says how many are ok, warning and failed, worst first", async () => {
        const r = await ok("", ops, undefined, "GET");
        assert.equal(r.summary.total, r.items.length); assert.equal(r.summary.ok + r.summary.warning + r.summary.failed + r.summary.pending, r.items.length);
        const rank = { failed: 0, error: 1, warning: 2, pending: 3, ok: 4 }; const ranks = r.items.map((x) => rank[x.status]); assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    });

    console.log("the schedule");
    await test("a monitor that is due is checked by the schedule within a couple of minutes (and one that is turned off is not)", async () => {
        const srv = await serveTls(makeCert({ toDays: 100 }));
        const mk = async (name, enabled) => (await q(`INSERT INTO web_monitors (organization_id, kind, name, host, port, config, enabled, next_check_at) VALUES ($1,'certificate',$2,'127.0.0.1',$3,'{}',$4, now() - interval '1 minute') RETURNING id`, [org, `${tag} ${name}`, srv.port + (enabled ? 0 : 0), enabled])).rows[0].id;
        const srv2 = await serveTls(makeCert({ toDays: 100 }));
        const on = await mk("due", true);
        const off = (await q(`INSERT INTO web_monitors (organization_id, kind, name, host, port, config, enabled, next_check_at) VALUES ($1,'certificate',$2,'127.0.0.1',$3,'{}',false, now() - interval '1 minute') RETURNING id`, [org, `${tag} off`, srv2.port])).rows[0].id;
        const deadline = Date.now() + 130_000;
        let row;
        while (Date.now() < deadline) { row = (await q(`SELECT status, last_checked_at, next_check_at FROM web_monitors WHERE id=$1`, [on])).rows[0]; if (row.last_checked_at) break; await new Promise((r) => setTimeout(r, 3000)); }
        assert.ok(row.last_checked_at, "the schedule never checked it"); assert.equal(row.status, "ok");
        assert.ok(new Date(row.next_check_at) > new Date(Date.now() + 5 * 3600_000), "the next check is about 6 hours away");
        assert.equal((await q(`SELECT last_checked_at FROM web_monitors WHERE id=$1`, [off])).rows[0].last_checked_at, null, "a turned-off monitor was checked");
    });

    await cleanMonitors();
    await cleanup();
    for (const s of tlsServers) s.close();
    rdap.close(); dnsServer.close();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
