// The Linux device-secrets scripts (managed local administrator password, LUKS recovery key) run for REAL in privileged Docker containers:
// the real useradd/chpasswd/PAM and a real login with the generated password; real LUKS2 volumes on loop devices and the real
// systemd-cryptenroll, with the recovery key it printed used to unlock the volume afterwards. Answers are read with the server's own parsers.
// Run after a build: node test/linux-secrets-docker.cjs   (needs Docker with privileged containers; skipped with a note otherwise)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const DIST = path.join(__dirname, "..", process.env.DIST || "dist", "vault");
const S = require(path.join(DIST, "vault.scripts.js"));
const P = require(path.join(DIST, "vault.parsers.js"));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 600_000, ...o });
const dk = (...a) => run("docker", a);

if (dk("info", "--format", "{{.ServerVersion}}").status !== 0) { console.log("(Docker is not running, skipped)"); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adg-linsec-"));
const names = [];
const stamp = Date.now();
// device-mapper names and loop devices belong to the host kernel and outlive a container, so each volume is closed before its container goes
const cleanup = () => {
    for (const n of names) {
        dk("exec", n, "bash", "-c", `for d in /mnt/a /mnt/b /mnt/c; do umount $d 2>/dev/null; done; for m in $(ls /dev/mapper 2>/dev/null | grep '^adg${stamp}'); do cryptsetup close $m 2>/dev/null; done; for f in /root/*.dev; do [ -f "$f" ] && losetup -d $(cat $f) 2>/dev/null; done; true`);
        dk("rm", "-f", n);
    }
};
const MAP = (id) => `adg${stamp}${id}`;

function container(tag, image, setup) {
    const n = `adg-${tag}-${stamp}`; names.push(n);
    assert.equal(dk("run", "-d", "--name", n, "--privileged", image, "sleep", "1200").status, 0);
    const r = dk("exec", n, "bash", "-c", setup);
    return { n, setup: r };
}
const put = (n, name, content) => { const f = path.join(tmp, name); fs.writeFileSync(f, content, { mode: 0o755 }); assert.equal(dk("cp", f, `${n}:/tmp/${name}`).status, 0); };
const exec = (n, cmd, o = {}) => dk("exec", ...(o.user ? ["-u", o.user] : []), ...Object.entries(o.env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]), n, "bash", "-c", cmd);
const script = (n, name, env = {}, user) => exec(n, `bash /tmp/${name}`, { env, user });

// a real interactive login with a password, on a pseudo terminal (python3 inside the container, run as an ordinary user)
const LOGIN_PY = `import os, pty, sys, time, select
user = sys.argv[1]; pw = sys.stdin.readline().rstrip("\\n")
pid, fd = pty.fork()
if pid == 0:
    os.execvp("su", ["su", "-", user, "-c", "id -un"])
buf = b""; sent = False; end = time.time() + 20
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: d = os.read(fd, 1024)
        except OSError: break
        if not d: break
        buf += d
        if not sent and b"assword" in buf: os.write(fd, (pw + "\\n").encode()); sent = True
    else:
        try:
            p, st = os.waitpid(pid, os.WNOHANG)
            if p: break
        except ChildProcessError: break
txt = buf.decode(errors="replace")
print("LOGIN_OK" if sent and txt.strip().endswith(user) else "LOGIN_FAILED")
`;
const canLogin = (n, user, pw) => {
    const r = run("docker", ["exec", "-i", "-u", "games", n, "python3", "/tmp/login.py", user], { input: pw + "\n" });
    return /LOGIN_OK/.test(r.stdout);
};

try {
    console.log("local administrator password, Debian 12 (yescrypt hashes, PAM)");
    const deb = container("laps-deb", "debian:12", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo python3 openssl >/dev/null 2>&1; echo done");
    put(deb.n, "laps.sh", S.LINUX_LAPS_ROTATE_SCRIPT); put(deb.n, "login.py", LOGIN_PY);
    exec(deb.n, "chmod 755 /tmp/login.py");
    const laps = (n, acct, len, extra = {}, user) => script(n, "laps.sh", { ADG_LAPS_ACCOUNT: acct, ADG_LAPS_LENGTH: String(len), ...extra }, user);
    const answer = (r, acct, len) => P.parseLapsResult(r.stdout, { account: acct, length: len });
    let first, second;
    check("a new account is created, made an administrator, given a password that the server's parser accepts and that PAM confirms", () => {
        const r = laps(deb.n, "adg-admin", 20); first = answer(r, "adg-admin", 20);
        assert.equal(first.created, true); assert.equal(first.verified, true, "the stored hash matches (python3 crypt)");
        assert.match(exec(deb.n, "id adg-admin; getent passwd adg-admin").stdout, /uid=\d{4,}.*groups=.*sudo/s);
        assert.equal(canLogin(deb.n, "adg-admin", first.password), true, "a real login with the password works");
        assert.equal(canLogin(deb.n, "adg-admin", first.password + "x"), false, "and a wrong password does not");
    });
    check("nothing but the answer is printed: no password on stderr, none in the process list afterwards", () => {
        const r = laps(deb.n, "adg-admin", 20); const a = answer(r, "adg-admin", 20);
        assert.ok(!r.stderr.includes(a.password), "stderr");
        assert.ok(!exec(deb.n, "ps aux; cat /var/log/*.log 2>/dev/null; true").stdout.includes(a.password));
        second = a;
    });
    check("a second rotation gives another password; the old one stops working, the new one works, and it is not 'created' again", () => {
        assert.notEqual(second.password, first.password); assert.equal(second.created, false);
        assert.equal(canLogin(deb.n, "adg-admin", first.password), false); assert.equal(canLogin(deb.n, "adg-admin", second.password), true);
    });
    check("an ordinary existing account is taken over (not created), and a system account is refused without being touched", () => {
        exec(deb.n, "useradd -m ordinaryjoe");
        const a = answer(laps(deb.n, "ordinaryjoe", 16), "ordinaryjoe", 16); assert.equal(a.created, false); assert.equal(canLogin(deb.n, "ordinaryjoe", a.password), true);
        const before = exec(deb.n, "getent shadow games").stdout;
        assert.throws(() => answer(laps(deb.n, "games", 16), "games", 16), (e) => e.code === "device_error" && e.reason === "system_account");
        assert.equal(exec(deb.n, "getent shadow games").stdout, before, "the system account was not changed");
    });
    check("bad input is refused before anything happens (reserved, odd characters, upper case, bad length)", () => {
        for (const [acct, len, reason] of [["root", 20, "reserved_account"], ["admin", 20, "reserved_account"], ["Bad", 20, "invalid_account"], ["a;b", 20, "invalid_account"], ["-x", 20, "invalid_account"], ["adg2", 13, "invalid_length"], ["adg2", 65, "invalid_length"], ["adg2", "ab", "invalid_length"]]) {
            assert.throws(() => answer(laps(deb.n, acct, len), acct, 20), (e) => e.code === "device_error" && e.reason === reason, `${acct}/${len} should be ${reason}`);
        }
        assert.notEqual(exec(deb.n, "id adg2").status, 0, "nothing was created");
    });
    check("a dry run changes nothing and says so (the parser refuses it as dry_run)", () => {
        const r = laps(deb.n, "adg-dry", 20, { ADG_DRY_RUN: "1" });
        assert.throws(() => answer(r, "adg-dry", 20), (e) => e.code === "dry_run"); assert.notEqual(exec(deb.n, "id adg-dry").status, 0);
    });
    check("not root: refused with a clear reason, nothing changed", () => {
        assert.throws(() => answer(laps(deb.n, "adg-nr", 20, {}, "games"), "adg-nr", 20), (e) => e.code === "device_error" && e.reason === "not_root");
    });
    check("30 dry-run passwords: right length, only the alphabet, one of every class, none repeated", () => {
        const seen = new Set();
        for (let i = 0; i < 30; i++) {
            const j = JSON.parse(laps(deb.n, "adg-dry", 24, { ADG_DRY_RUN: "1" }).stdout);
            assert.equal(P.isValidLapsPassword(j.password, 24), true, j.password); assert.ok(!seen.has(j.password)); seen.add(j.password);
        }
    });
    check("without python3 or a usable hash tool the password is still set, and reported as unconfirmed (never as confirmed)", () => {
        exec(deb.n, "mv /usr/bin/python3 /usr/bin/python3.off; mv /usr/bin/python3.11 /usr/bin/python3.11.off 2>/dev/null; true");
        const a = answer(laps(deb.n, "adg-admin", 20), "adg-admin", 20);
        assert.equal(a.verified, false, "yescrypt cannot be checked with openssl");
        exec(deb.n, "mv /usr/bin/python3.off /usr/bin/python3; mv /usr/bin/python3.11.off /usr/bin/python3.11 2>/dev/null; true");
        assert.equal(canLogin(deb.n, "adg-admin", a.password), true, "but it does work");
    });

    console.log("local administrator password, Rocky 9 (sha512 hashes, no python3: checked with openssl)");
    const rocky = container("laps-rocky", "rockylinux:9", "dnf install -y -q sudo openssl python3 shadow-utils >/dev/null 2>&1; echo done");
    put(rocky.n, "laps.sh", S.LINUX_LAPS_ROTATE_SCRIPT); put(rocky.n, "login.py", LOGIN_PY);
    check("the account is created in the wheel group, the sha512 hash is confirmed with openssl, and a real login works", () => {
        exec(rocky.n, "mv /usr/bin/python3 /usr/bin/python3.off 2>/dev/null; true");
        const a = answer(laps(rocky.n, "adg-admin", 20), "adg-admin", 20);
        assert.equal(a.created, true); assert.equal(a.verified, true, "openssl branch");
        assert.match(exec(rocky.n, "id adg-admin").stdout, /wheel/);
        exec(rocky.n, "mv /usr/bin/python3.off /usr/bin/python3 2>/dev/null; chmod 755 /tmp/login.py; true");
        assert.equal(canLogin(rocky.n, "adg-admin", a.password), true);
    });

    console.log("LUKS recovery keys, Debian 12 (real LUKS2 volumes on loop devices, real systemd-cryptenroll)");
    const lk = container("luks", "debian:12", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cryptsetup systemd util-linux e2fsprogs >/dev/null 2>&1; echo done");
    put(lk.n, "luks.sh", S.LINUX_LUKS_ESCROW_SCRIPT);
    const sh = (cmd) => { const r = exec(lk.n, cmd); assert.equal(r.status, 0, `${cmd}\n${r.stdout}${r.stderr}`); return r.stdout.trim(); };
    // volume A: unlocks with a key file named in /etc/crypttab, mounted at /mnt/a. B: passphrase only, mounted. C: LUKS1. D: key file, not mounted.
    const mk = (id, type, mount) => {
        sh(`truncate -s 48M /root/${id}.img; DEV=$(losetup -f --show /root/${id}.img); echo $DEV > /root/${id}.dev; head -c 64 /dev/urandom > /root/${id}.kf; ` +
            `cryptsetup luksFormat --type ${type} --batch-mode --pbkdf pbkdf2 --pbkdf-force-iterations 1000 --key-file /root/${id}.kf $DEV; cryptsetup open --key-file /root/${id}.kf $DEV ${MAP(id)}; ` +
            (mount ? `mkfs.ext4 -q /dev/mapper/${MAP(id)}; mkdir -p ${mount}; mount /dev/mapper/${MAP(id)} ${mount}` : "true"));
        return { dev: sh(`cat /root/${id}.dev`), uuid: sh(`cryptsetup luksUUID $(cat /root/${id}.dev)`) };
    };
    const A = mk("a", "luks2", "/mnt/a"), B = mk("b", "luks2", "/mnt/b"), C = mk("c", "luks1", "/mnt/c"), D = mk("d", "luks2", "");
    sh(`printf 'adga UUID=${A.uuid} /root/a.kf luks\\nadgd UUID=${D.uuid} /root/d.kf luks\\nadgb UUID=${B.uuid} none luks\\n' > /etc/crypttab`);
    const slots = (v) => Number(sh(`cryptsetup luksDump ${v.dev} | awk '/^Keyslots:/{f=1;next} /^[A-Z]/{f=0} f && /^ *[0-9]+: luks2/{n++} END{print n+0}'`));
    const before = { a: slots(A), b: slots(B), c: slots(C), d: slots(D) };
    let res1;
    const go = (have) => P.parseLuksResult(script(lk.n, "luks.sh", { ADG_LUKS_HAVE: have }).stdout);
    const state = (r, v) => r.volumes.find((x) => x.id === v.uuid)?.state;
    check("keys are added only where a volume unlocks without a passphrase: A and D enrolled, B has no way to unlock, C is LUKS1", () => {
        res1 = go("");
        assert.equal(state(res1, A), "enrolled"); assert.equal(state(res1, D), "enrolled"); assert.equal(state(res1, B), "no_unlock"); assert.equal(state(res1, C), "not_luks2");
        assert.deepEqual(res1.keys.map((k) => k.protectorId).sort(), [A.uuid, D.uuid].sort());
    });
    check("the mount point is the label, and a volume that is not mounted gets a short id label", () => {
        assert.equal(res1.keys.find((k) => k.protectorId === A.uuid).mount, "/mnt/a");
        assert.equal(res1.keys.find((k) => k.protectorId === D.uuid).mount, `luks-${D.uuid.slice(0, 8)}`);
    });
    check("each returned recovery key REALLY unlocks its volume (and the old key file still does: nothing was removed)", () => {
        for (const [k, v, id] of [[res1.keys.find((x) => x.protectorId === A.uuid), A, "a"], [res1.keys.find((x) => x.protectorId === D.uuid), D, "d"]]) {
            assert.equal(exec(lk.n, `printf '%s' '${k.recoveryPassword}' | cryptsetup open --test-passphrase --key-file=- ${v.dev}`).status, 0, "the recovery key unlocks " + v.uuid);
            assert.notEqual(exec(lk.n, `printf '%s' '${k.recoveryPassword.slice(0, -1)}x' | cryptsetup open --test-passphrase --key-file=- ${v.dev}`).status, 0, "a wrong key does not");
            assert.equal(exec(lk.n, `cryptsetup open --test-passphrase --key-file=/root/${id}.kf ${v.dev}`).status, 0, "the old key file still works");
            assert.equal(slots(v), before[id] + 1, "exactly one slot was added");
        }
    });
    check("untouched volumes keep their slots (B and C)", () => { assert.equal(slots(B), before.b); assert.equal(slots(C), before.c); });
    check("a second run with the stored volumes listed adds nothing (one slot per volume from ADG RMM)", () => {
        const r = go(`${A.uuid},${D.uuid}`);
        assert.equal(r.keys.length, 0); assert.equal(state(r, A), "have"); assert.equal(state(r, D), "have");
        assert.equal(slots(A), before.a + 1); assert.equal(slots(D), before.d + 1);
    });
    check("not root is refused, and a machine with no encrypted disk says so", () => {
        const r = script(lk.n, "luks.sh", { ADG_LUKS_HAVE: "" }, "games");
        assert.throws(() => P.parseLuksResult(r.stdout), (e) => e.code === "device_error" && e.reason === "not_root");
        const plain = container("nolux", "rockylinux:9", "dnf install -y -q cryptsetup util-linux >/dev/null 2>&1; echo done");
        put(plain.n, "luks.sh", S.LINUX_LUKS_ESCROW_SCRIPT);
        const r2 = script(plain.n, "luks.sh", { ADG_LUKS_HAVE: "" });
        assert.throws(() => P.parseLuksResult(r2.stdout), (e) => e.code === "device_error" && e.reason === "no_luks");
    });
    check("the parser refuses a garbled or hostile answer", () => {
        const bad = [
            '{"ok":true,"keys":[{"mount":"/","protectorId":"nope","recoveryPassword":"cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc"}],"volumes":[]}',
            `{"ok":true,"keys":[{"mount":"/x;rm","protectorId":"${A.uuid}","recoveryPassword":"cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc"}],"volumes":[]}`,
            `{"ok":true,"keys":[{"mount":"/","protectorId":"${A.uuid}","recoveryPassword":"short"}],"volumes":[]}`,
            `{"ok":true,"keys":[],"volumes":[{"id":"${A.uuid}","state":"hacked"}]}`, "not json", "",
        ];
        for (const b of bad) assert.throws(() => P.parseLuksResult(b), (e) => e.name === "Error" && /not usable/.test(e.message), b.slice(0, 60));
    });
} finally { cleanup(); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
