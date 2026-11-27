// Fixes for the code scanning findings: linear-time string helpers, the address guard, path checks and escaping. No database.
"use strict";

const path = require("node:path");
const http = require("node:http");
require("reflect-metadata");
const dist = (p) => require(path.resolve(process.cwd(), "dist", p));
const text = dist("common/text-util.js");
const guard = dist("common/ssrf-guard.js");
const portalUtil = dist("portal/portal.util.js");
const tokenUtil = dist("common/agent-token.util.js");
const freshdesk = dist("imports/freshdesk.js");
const storage = dist("backups/storage-clients.js");
const localPath = dist("backups/local-path.js");
const { PortalSettingsService } = dist("portal/portal-settings.service.js");

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const ms = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message)); } };
const BS = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

(async () => {
    // ---- trim helpers
    check("trimTrailing removes a run", text.trimTrailing("a///", "/") === "a");
    check("trimTrailing leaves the rest", text.trimTrailing("/a/b", "/") === "/a/b");
    check("trimBoth removes both ends", text.trimBoth("//a/b//", "/") === "a/b");
    check("trimBoth of only slashes is empty", text.trimBoth("////", "/") === "");
    const longSlashes = "/".repeat(200_000);
    const t1 = ms(() => text.trimBoth(longSlashes + "x" + longSlashes, "/"));
    check("a 400,000 character run is trimmed at once", t1.r === "x" && t1.ms < 200, t1.ms);
    const t1b = ms(() => text.trimTrailing("a" + longSlashes + "x", "/"));
    check("a long run in the middle costs nothing", t1b.ms < 200, t1b.ms);

    // ---- email shape: same answers as the old patterns
    const OLD = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    const OLD_TLD2 = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const samples = ["a@b.co", "a@b.c", "a@b", "a@.c", "a@b.", "@b.co", "a@@b.co", "a b@c.de", "a@b c.de", "a@b..c", "a.b@c.d.e", "x@y.z\n", "a@b.c ", " a@b.co", "a@b.co ", "a@b.cc\t", "a@.co", "a@..", "a@a.b.c", "", "plain", "a@b.cde.", "a@bc.d", "　a@b.co"];
    const bad = samples.filter((s) => text.looksLikeEmail(s) !== OLD.test(s) || text.looksLikeEmail(s, 2) !== OLD_TLD2.test(s));
    check("looksLikeEmail answers like the old pattern", bad.length === 0, bad);
    check("looksLikeEmail refuses non-strings", !text.looksLikeEmail(undefined) && !text.looksLikeEmail(5));
    const evil = "a@" + "a".repeat(100_000);
    const t2 = ms(() => text.looksLikeEmail(evil));
    check("a 100,000 character address is refused at once", t2.r === false && t2.ms < 50, t2.ms);
    const t2b = ms(() => text.looksLikeEmail("a@" + "a.".repeat(100) + "!"));
    check("a normal-size dotted address is fast", t2b.ms < 50, t2b.ms);

    // ---- portal domain
    check("domain: scheme and path are dropped", portalUtil.normalizeDomain("https://Portal.Example.com/path?x=1").domain === "portal.example.com");
    check("domain: trailing dot is dropped", portalUtil.normalizeDomain("portal.example.com.").domain === "portal.example.com");
    check("domain: a port is refused", !!portalUtil.normalizeDomain("portal.example.com:8443").error);
    check("domain: an IP is refused", !!portalUtil.normalizeDomain("10.0.0.1").error);
    check("domain: localhost is refused", !!portalUtil.normalizeDomain("localhost").error);
    check("domain: a line break is refused", !!portalUtil.normalizeDomain("a.example.com/x\ny").error);
    const t3 = ms(() => portalUtil.normalizeDomain("/".repeat(100_000) + "\n"));
    check("domain: a long run of slashes is refused at once", !!t3.r.error && t3.ms < 50, t3.ms);

    // ---- bearer token
    check("bearer: normal", tokenUtil.bearerToken("Bearer abc.def") === "abc.def");
    check("bearer: extra white space", tokenUtil.bearerToken("Bearer \t abc") === "abc");
    check("bearer: no space is refused", tokenUtil.bearerToken("Bearerabc") === null);
    check("bearer: other scheme is refused", tokenUtil.bearerToken("Basic abc") === null && tokenUtil.bearerToken("bearer abc") === null);
    check("bearer: empty token is refused", tokenUtil.bearerToken("Bearer    ") === null);
    const t4 = ms(() => tokenUtil.bearerToken("Bearer" + " ".repeat(100_000) + "\n"));
    check("bearer: a long run of spaces is refused at once", t4.r === null && t4.ms < 50, t4.ms);

    // ---- freshdesk
    check("freshdesk host: trailing dots", freshdesk.freshdeskHost("https://acme.freshdesk.com./helpdesk") === "acme.freshdesk.com");
    check("freshdesk host: only freshdesk", throws(() => freshdesk.freshdeskHost("evil.example.com"), /not a Freshdesk address/));
    check("html to text: tags and line breaks", freshdesk.htmlToText("<p>Hi<br>there</p><b>x</b>") === "Hi\nthere\nx");
    const rebuilt = freshdesk.htmlToText("<scr<script></script>ipt>alert(1)</scr<script></script>ipt>");
    check("html to text: no tag is rebuilt from the pieces", !/<\/?script/i.test(rebuilt), rebuilt);
    check("html to text: script bodies are removed", freshdesk.htmlToText("a<script>bad()</script>b<style>x{}</style>c") === "abc");

    // ---- Google Drive query value
    check("drive query: quote is escaped", storage.escapeDriveQueryValue("it's") === "it" + BS + "'s");
    check("drive query: backslash is escaped first", storage.escapeDriveQueryValue("a" + BS + "' or name contains '") === "a" + BS + BS + BS + "' or name contains " + BS + "'");
    check("drive query: plain text is unchanged", storage.escapeDriveQueryValue("Backups 2026") === "Backups 2026");

    // ---- local backup folder
    check("local path: normalised", localPath.sanitizeLocalPath("/var//backups/./a/", "") === "/var/backups/a/");
    check("local path: relative refused", throws(() => localPath.sanitizeLocalPath("backups", ""), /absolute/));
    check("local path: .. refused", throws(() => localPath.sanitizeLocalPath("/var/../etc", ""), /Invalid/));
    check("local path: NUL refused", throws(() => localPath.sanitizeLocalPath("/var/a" + NUL + "b", ""), /Invalid/));
    check("local path: windows drive path kept", localPath.sanitizeLocalPath("D:" + BS + "Backups" + BS + "x", "") === "D:" + BS + "Backups" + BS + "x");
    check("local path: inside an allowed folder", localPath.sanitizeLocalPath("/srv/backups/clients/a", "/srv/backups, /mnt/nas") === "/srv/backups/clients/a");
    check("local path: the allowed folder itself", localPath.sanitizeLocalPath("/srv/backups", "/srv/backups") === "/srv/backups");
    check("local path: outside the allowed folders refused", throws(() => localPath.sanitizeLocalPath("/etc", "/srv/backups,/mnt/nas"), /not one of the folders/));
    check("local path: a sibling with the same prefix refused", throws(() => localPath.sanitizeLocalPath("/srv/backups-old", "/srv/backups"), /not one of the folders/));
    check("local path: a name starting with dots is not a way out", throws(() => localPath.sanitizeLocalPath("/srv/backups/..x", "/srv/backups"), /Invalid/));

    // ---- recording folder
    process.env.RECORDINGS_DIR = path.join(require("node:os").tmpdir(), "adg-rec-test");
    const rec = dist("recordings/recording-store.js");
    const id = "0a1b2c3d-0000-4000-8000-0123456789ab";
    check("recording dir: a valid id is inside the root", rec.recordingDir(id) === path.join(path.resolve(process.env.RECORDINGS_DIR), id));
    check("recording dir: traversal refused", throws(() => rec.recordingDir("../../etc/passwd"), /Invalid recording id/));
    check("recording dir: an upper-case id is the same folder", rec.recordingDir(id.toUpperCase()) === rec.recordingDir(id));
    const badSeq = (n) => rec.readPiece(id, n).then(() => false, (e) => /Invalid recording piece/.test(e.message));
    check("recording piece: bad numbers refused", (await badSeq(-1)) && (await badSeq(1.5)));

    // ---- address guard
    check("lan: 10/8, 172.16/12, 192.168/16, 100.64/10 and fc00::/7 are LAN", ["10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.1.1", "fd12::1", "::ffff:192.168.0.5"].every(guard.isLanAddress));
    check("lan: loopback, metadata and public are not LAN", ["127.0.0.1", "::1", "169.254.169.254", "fe80::1", "8.8.8.8", "0.0.0.0", "224.0.0.1", "::ffff:127.0.0.1", "172.32.0.1"].every((a) => !guard.isLanAddress(a)));
    check("private: unchanged", guard.isPrivateAddress("10.0.0.1") && guard.isPrivateAddress("127.0.0.1") && !guard.isPrivateAddress("8.8.8.8"));

    const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ path: req.url, modules: [] })); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const outcome = (url, init) => guard.safeGet(url, { timeoutMs: 3000, ...init }).then(() => "answered", (e) => e.code || e.message);
    check("safeGet: a loopback address is refused", /private network/.test(await outcome(`http://127.0.0.1:${port}/x`)));
    check("safeGet: loopback is refused even with allowLan", /private network/.test(await outcome(`http://127.0.0.1:${port}/x`, { allowLan: true })));
    check("safeGet: localhost by name is refused", (await outcome(`http://localhost:${port}/x`, { allowLan: true })) === "EPRIVATEADDRESS");
    check("safeGet: metadata address is refused", /private network/.test(await outcome("http://169.254.169.254/latest/meta-data/", { allowLan: true })));
    check("safeGet: other schemes are refused", /Only http and https/.test(await outcome("file:///etc/passwd")));
    check("safeGet: a LAN literal is refused without allowLan, tried with it", /private network/.test(await outcome("http://192.168.1.1:1/", {})) && (await outcome("http://192.168.1.1:1/", { allowLan: true, timeoutMs: 500 })) !== "answered");
    server.close();

    // ---- the portal address check
    const svc = new PortalSettingsService({}, {});
    const r1 = await svc.checkReachable("localhost");
    check("portal check: localhost is refused as an address", r1.ok === false && /domain name/.test(r1.message), r1);
    const r2 = await svc.checkReachable("not a name");
    check("portal check: a bad name is explained", r2.ok === false, r2);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
