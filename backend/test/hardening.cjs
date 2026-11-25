// Security hardening, the pure parts: the admin API key check and constant-time compare, the private-address rules that stop
// webhooks and monitors reaching internal networks (including IPv4 hidden in IPv6), and the upload type/extension allowlists.
// No database. Needs a build: DIST_DIR=dist node test/hardening.cjs
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const dist = (p) => require(path.join(__dirname, "..", process.env.DIST_DIR || "dist", p));

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message}`); }
}

const { assertAdminApiKeyConfig, safeEqual, adminKeyMatches } = dist("common/admin-key.js");
const { isPrivateAddress, parseV6, safePost } = dist("common/ssrf-guard.js");
const { safeAttachmentExtension, brandingImageExtension, staticFileHeaders } = dist("common/upload-safety.js");

const GOOD_KEY = "9f3c1a7e5b2d8f4a6c0e1b3d5f7a9c2e4b6d8f0a";

/* ------------------------------ admin key ------------------------------ */
check("admin key: the .env.example placeholder is refused", () => {
    assert.throws(() => assertAdminApiKeyConfig("CHANGE_ME_GENERATE_A_LONG_RANDOM_SECRET"), /placeholder/);
    assert.throws(() => assertAdminApiKeyConfig("changeme-changeme-changeme-changeme"), /placeholder/);
    assert.throws(() => assertAdminApiKeyConfig("replace_me_with_a_real_long_value_please"), /placeholder/);
    assert.throws(() => assertAdminApiKeyConfig("this-is-an-example-admin-key-value-xyz"), /placeholder/);
    assert.throws(() => assertAdminApiKeyConfig("e2e-admin"), /placeholder/);
});
check("admin key: a short key is refused", () => {
    assert.throws(() => assertAdminApiKeyConfig("abc123"), /at least 24/);
    assert.throws(() => assertAdminApiKeyConfig("x".repeat(23)), /at least 24/);
    assert.throws(() => assertAdminApiKeyConfig(` ${GOOD_KEY}`), /whitespace/);
});
check("admin key: a long random key is accepted", () => {
    assertAdminApiKeyConfig(GOOD_KEY);
    assertAdminApiKeyConfig("a".repeat(12) + "b".repeat(12));
});
check("admin key: unset or blank is accepted (the admin key is simply disabled)", () => {
    assertAdminApiKeyConfig(undefined);
    assertAdminApiKeyConfig("");
    assertAdminApiKeyConfig("   ");
    const saved = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
        assertAdminApiKeyConfig();
        assert.equal(adminKeyMatches("anything"), false);
        assert.equal(adminKeyMatches(""), false);
        assert.equal(adminKeyMatches(undefined), false);
    } finally { if (saved !== undefined) process.env.ADMIN_API_KEY = saved; }
});
check("constant-time compare: equal, different, different length, non-strings", () => {
    assert.equal(safeEqual(GOOD_KEY, GOOD_KEY), true);
    assert.equal(safeEqual(GOOD_KEY, GOOD_KEY.slice(0, -1) + "1"), false);
    assert.equal(safeEqual(GOOD_KEY, GOOD_KEY + "x"), false);
    assert.equal(safeEqual("", GOOD_KEY), false);
    assert.equal(safeEqual("", ""), true);
    assert.equal(safeEqual(undefined, GOOD_KEY), false);
    assert.equal(safeEqual(["a"], "a"), false);
    assert.equal(safeEqual("ü", "ü"), true);
});
check("admin key match: needs a configured key and an exact header", () => {
    assert.equal(adminKeyMatches(GOOD_KEY, GOOD_KEY), true);
    assert.equal(adminKeyMatches(GOOD_KEY.toUpperCase(), GOOD_KEY), false);
    assert.equal(adminKeyMatches([GOOD_KEY], GOOD_KEY), false);
    assert.equal(adminKeyMatches("", ""), false);
    assert.equal(adminKeyMatches(GOOD_KEY, ""), false);
});

/* ---------------------------- private addresses ---------------------------- */
const PRIVATE = [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3",
    "192.0.0.8", "198.18.0.1", "198.19.255.255", "224.0.0.1", "255.255.255.255", "192.0.2.1",
    "::", "::1", "[::1]", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::FFFF:10.0.0.1", "0:0:0:0:0:ffff:c0a8:0101",
    "::127.0.0.1", "::7f00:1", "::ffff:0:7f00:1",
    "64:ff9b::7f00:1", "64:ff9b::169.254.169.254", "64:ff9b::a00:1", "64:ff9b:1::1",
    "2002:7f00:1::1", "2002:a9fe:a9fe::", "2002:c0a8:101::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "100::1",
    "not-an-ip", "", "1.2.3", "999.1.1.1", "1:2:3:4:5:6:7:8:9",
];
const PUBLIC = [
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1",
    "169.253.255.255", "198.17.255.255", "198.20.0.1", "192.0.1.1", "11.0.0.1", "223.255.255.254",
    "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1", "[2606:4700:4700::1001]",
];
check(`isPrivateAddress: ${PRIVATE.length} private, local, special or unreadable addresses are refused`, () => {
    const missed = PRIVATE.filter((a) => isPrivateAddress(a) !== true);
    assert.deepEqual(missed, []);
});
check(`isPrivateAddress: ${PUBLIC.length} genuine public addresses stay allowed`, () => {
    const blocked = PUBLIC.filter((a) => isPrivateAddress(a) !== false);
    assert.deepEqual(blocked, []);
});
check("the URL parser's normalised form of [::ffff:127.0.0.1] is refused", () => {
    const host = new URL("https://[::ffff:127.0.0.1]/x").hostname;
    assert.equal(host, "[::ffff:7f00:1]");
    assert.equal(isPrivateAddress(host), true);
    assert.equal(isPrivateAddress(new URL("https://[64:ff9b::127.0.0.1]/").hostname), true);
});
check("parseV6 reads compressed, full and dotted forms into 16 bytes", () => {
    assert.deepEqual(parseV6("::1"), [...Array(15).fill(0), 1]);
    assert.deepEqual(parseV6("::ffff:1.2.3.4").slice(10), [0xff, 0xff, 1, 2, 3, 4]);
    assert.deepEqual(parseV6("2001:db8:0:0:0:0:0:1").slice(0, 4), [0x20, 0x01, 0x0d, 0xb8]);
    assert.equal(parseV6("1::2::3"), null);
    assert.equal(parseV6("12345::1"), null);
});
check("the notifications and web monitor modules use the same fixed check", () => {
    const N = dist("notifications/notifications.service.js");
    assert.equal(N.isPrivateAddress, isPrivateAddress);
    assert.equal(N.isPrivateAddress("::ffff:7f00:1"), true);
});

/* ------------------------------ uploads ------------------------------ */
check("attachment extension: known-safe ones are kept, active ones become .bin", () => {
    assert.equal(safeAttachmentExtension("report.PDF"), ".pdf");
    assert.equal(safeAttachmentExtension("photo.jpeg"), ".jpeg");
    assert.equal(safeAttachmentExtension("logs.zip"), ".zip");
    for (const n of ["x.html", "x.htm", "x.svg", "x.js", "x.mjs", "x.xhtml", "x.xml", "x.shtml", "x.php", "noext", "", null, ".htaccess", "a.pdf.html", "x.svgz"]) {
        assert.equal(safeAttachmentExtension(n), ".bin", String(n));
    }
});
check("branding image type: png, jpeg, gif, webp and ico only; svg and others refused", () => {
    assert.equal(brandingImageExtension("image/png"), ".png");
    assert.equal(brandingImageExtension("image/jpeg"), ".jpg");
    assert.equal(brandingImageExtension("image/gif"), ".gif");
    assert.equal(brandingImageExtension("image/webp"), ".webp");
    assert.equal(brandingImageExtension("image/x-icon"), ".ico");
    assert.equal(brandingImageExtension("image/vnd.microsoft.icon"), ".ico");
    for (const m of ["image/svg+xml", "text/html", "image/", "application/octet-stream", "", undefined]) assert.equal(brandingImageExtension(m), null, String(m));
});
check("static headers: nosniff everywhere; uploads sandboxed; non-images are downloads", () => {
    assert.deepEqual(staticFileHeaders("agent/install.ps1"), { "X-Content-Type-Options": "nosniff" });
    const img = staticFileHeaders("uploads/123_logo.png");
    assert.equal(img["X-Content-Type-Options"], "nosniff");
    assert.equal(img["Content-Security-Policy"], "sandbox; default-src 'none'");
    assert.equal(img["Content-Disposition"], undefined);
    for (const f of ["uploads/tickets/a.html", "uploads/tickets/a.bin", "uploads/old.svg", "uploads\\tickets\\a.pdf", "uploads/tickets/noext"]) {
        const h = staticFileHeaders(f);
        assert.equal(h["Content-Disposition"], "attachment", f);
        assert.equal(h["Content-Security-Policy"], "sandbox; default-src 'none'", f);
    }
});

/* ------------------- safePost: connect-time address check ------------------- */
(async () => {
    const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.writeHead(201, { "x-echo": "1" }); res.end(`got:${b}`); }); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
        try {
            await safePost(`http://localhost:${port}/hook`, { headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 3000 });
            failed++; console.log("FAIL safePost: a name resolving to loopback was connected to");
        } catch (e) {
            if (/private network/.test(e.message)) { passed++; console.log("ok   safePost: a name that resolves to loopback is refused at connect time"); }
            else { failed++; console.log(`FAIL safePost: wrong reason: ${e.message}`); }
        }
        try {
            await safePost(`http://127.0.0.1:${port}/hook`, { headers: {}, body: "{}", timeoutMs: 3000 });
            failed++; console.log("FAIL safePost: a literal private IP was connected to");
        } catch (e) { passed++; console.log("ok   safePost: a literal private IP is refused"); }
        const r = await safePost(`http://localhost:${port}/hook`, { headers: { "Content-Type": "application/json" }, body: '{"a":1}', timeoutMs: 3000, allowPrivate: true });
        assert.equal(r.status, 201); assert.equal(r.ok, true); assert.equal(r.headers.get("X-Echo"), "1"); assert.equal(await r.text(), 'got:{"a":1}');
        passed++; console.log("ok   safePost: with private addresses allowed on purpose, the request goes through");
    } catch (e) {
        failed++; console.log(`FAIL safePost: ${e.message}`);
    } finally {
        server.close();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
