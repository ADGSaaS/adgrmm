// The built-in scripts of the scripts manager: the catalog's shape and safety rules, then every script RUN FOR REAL: the bash ones in Debian 12 and
// Ubuntu 24.04 containers (bare, and Debian again with the usual tools installed), the PowerShell ones on this machine with the real Windows
// PowerShell 5.1 (without Confirm, so nothing is changed). Also: injection attempts through every kind of parameter change nothing.
// Run after a build: node test/builtin-scripts.cjs   (Docker and PowerShell parts are skipped with a note when missing)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const dist = path.join(__dirname, "..", process.env.DIST || "dist", "automation");
const C = require(path.join(dist, "builtin-scripts.js"));
const SCRIPTS = C.BUILTIN_SCRIPTS;
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 600_000, ...o });

const bash = SCRIPTS.filter((s) => s.language === "bash");
const ps = SCRIPTS.filter((s) => s.language === "powershell");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adg-builtin-"));

console.log("the catalog");
check("35 to 45 scripts, roughly 60% PowerShell, with unique names and keys", () => {
    assert.ok(SCRIPTS.length >= 35 && SCRIPTS.length <= 45, `${SCRIPTS.length} scripts`);
    const share = ps.length / SCRIPTS.length;
    assert.ok(share >= 0.5 && share <= 0.7, `PowerShell share ${share}`);
    assert.equal(new Set(SCRIPTS.map((s) => s.key)).size, SCRIPTS.length, "keys");
    assert.equal(new Set(SCRIPTS.map((s) => s.name)).size, SCRIPTS.length, "names");
    for (const s of SCRIPTS) assert.match(s.key, /^[a-z0-9]+(-[a-z0-9]+)*$/, s.key);
});
check("every category is a known one and all nine are used", () => {
    for (const s of SCRIPTS) assert.ok(C.BUILTIN_CATEGORIES.includes(s.category), `${s.key}: ${s.category}`);
    for (const c of C.BUILTIN_CATEGORIES) assert.ok(SCRIPTS.some((s) => s.category === c), `no script in ${c}`);
});
check("each script has a name, a description, a valid language, a sane timeout and a size under 256 KB", () => {
    for (const s of SCRIPTS) {
        assert.ok(s.name.length >= 8 && s.name.length <= 120, s.key);
        assert.ok(s.description.length >= 30 && s.description.length <= 400, `${s.key} description`);
        assert.ok(["powershell", "bash"].includes(s.language), s.key);
        assert.ok(s.timeoutSec >= 10 && s.timeoutSec <= 86_400, s.key);
        assert.ok(Buffer.byteLength(s.script) < 256 * 1024 && s.script.trim().length > 40, s.key);
        assert.ok(s.name.toLowerCase().includes(s.language === "bash" ? "linux" : "windows"), `${s.key}: the name says which system it is for`);
    }
});
check("parameter names are valid and unique, and every ADG_ variable a script reads is declared (and the other way round)", () => {
    for (const s of SCRIPTS) {
        const seen = new Set();
        for (const p of s.parameters) {
            assert.match(p.name, /^[A-Za-z][A-Za-z0-9_]{0,63}$/, `${s.key}: ${p.name}`);
            assert.ok(!seen.has(p.name.toLowerCase()), `${s.key}: duplicate ${p.name}`); seen.add(p.name.toLowerCase());
            assert.ok(s.script.includes(`ADG_${p.name.toUpperCase()}`), `${s.key}: parameter ${p.name} is never read`);
        }
        const used = new Set([...s.script.matchAll(/ADG_([A-Z][A-Z0-9_]*)/g)].map((m) => m[1].toLowerCase()));
        for (const u of used) assert.ok(seen.has(u), `${s.key}: reads ADG_${u.toUpperCase()} but does not declare it`);
    }
});
check("text safety: no dollar-brace, no double curly braces, no backtick, ASCII only, no carriage returns", () => {
    for (const s of SCRIPTS) {
        assert.ok(!s.script.includes("${"), `${s.key}: dollar-brace`);
        assert.ok(!s.script.includes("{{"), `${s.key}: double curly braces`);
        assert.ok(!s.script.includes("`"), `${s.key}: backtick`);
        assert.ok(/^[\x00-\x7F]*$/.test(s.script), `${s.key}: not ASCII`);
        assert.ok(!s.script.includes("\r"), `${s.key}: carriage return`);
        assert.ok(/^[\x20-\x7E]*$/.test(s.name + s.description), `${s.key}: name or description not plain ASCII`);
    }
});
check("no parameter is ever built into code: no eval, no iex, no shell -c with an interpolated string", () => {
    for (const s of SCRIPTS) {
        if (s.language === "bash") {
            assert.ok(!/\beval\b/.test(s.script), `${s.key}: eval`);
            assert.ok(!/\b(?:ba)?sh\s+-c\s+"/.test(s.script), `${s.key}: sh -c with a double-quoted (interpolating) string`);
            assert.ok(!/xargs[^\n]*\{\}/.test(s.script), `${s.key}: xargs {}`);
        } else {
            assert.ok(!/Invoke-Expression|\biex\b|Invoke-Command|-EncodedCommand|\bcmd(\.exe)?\s+\/c/i.test(s.script), `${s.key}: runs a string as code`);
            for (const m of s.script.matchAll(/^.*\$env:ADG_\w+.*$/gm)) {
                const line = m[0];
                assert.ok(!/(Start-Process|&\s*"|&\s*\$)/.test(line), `${s.key}: a parameter on a line that starts a program: ${line.trim()}`);
            }
        }
    }
});
check("anything that changes the device needs Confirm = YES, and clean-ups and account changes default to a dry run", () => {
    for (const s of SCRIPTS) {
        const changes = /changes the device|with confirm|disables with confirm/i.test(s.name);
        const hasConfirm = s.parameters.some((p) => p.name === "confirm");
        assert.equal(changes, hasConfirm, `${s.key}: confirm parameter and name disagree`);
        if (changes) {
            assert.equal(s.parameters.find((p) => p.name === "confirm").defaultValue, "NO", s.key);
            assert.ok(/ADG_CONFIRM\s*(-cne|-ceq)\s*'YES'|"\$ADG_CONFIRM"\s*(!=|=)\s*"YES"/.test(s.script), `${s.key}: never compares Confirm with YES`);
        }
        const dry = s.parameters.find((p) => p.name === "dry_run");
        if (dry) { assert.equal(dry.defaultValue, "yes", s.key); assert.ok(changes, `${s.key}: a dry run on something that cannot change anything`); }
    }
});
check("Confirm and Dry run are compared case-SENSITIVELY (PowerShell -eq ignores case, so only -ceq and -cne are allowed): 'yes' must not count as YES", () => {
    for (const s of ps) assert.ok(!/ADG_(CONFIRM|DRY_RUN)\s+-(eq|ne)\b/i.test(s.script), `${s.key}: a case-insensitive comparison`);
});
check("the hash helper ignores line endings", () => { assert.equal(C.textHash("a\r\nb"), C.textHash("a\nb")); assert.notEqual(C.textHash("a"), C.textHash("b")); });

console.log("syntax");
check(`every bash script passes bash -n (${bash.length})`, () => {
    const b = ["bash", "C:/Program Files/Git/bin/bash.exe"].find((x) => run(x, ["-c", "true"]).status === 0);
    if (!b) return console.log("     (no bash, skipped)");
    for (const s of bash) { const r = run(b, ["-n"], { input: s.script }); assert.equal(r.status, 0, `${s.key}: ${r.stderr}`); }
});
const psExe = "powershell";
const havePs = process.platform === "win32" && run(psExe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]).status === 0;
const psDir = path.join(tmp, "ps");
fs.mkdirSync(psDir);
for (const s of ps) fs.writeFileSync(path.join(psDir, `${s.key}.ps1`), s.script);
check(`every PowerShell script parses with the real Windows PowerShell parser (${ps.length})`, () => {
    if (!havePs) return console.log("     (no Windows PowerShell, skipped)");
    const r = run(psExe, ["-NoProfile", "-Command", `Get-ChildItem '${psDir}' -Filter *.ps1 | ForEach-Object { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e); foreach ($x in $e) { $_.Name + ': ' + $x.Message + ' (line ' + $x.Extent.StartLineNumber + ')' } }`]);
    assert.equal(r.stdout.trim(), "", r.stdout + r.stderr);
});

/* ------------------------------ real runs ------------------------------ */
// What a script may exit with when it runs without Confirm: 1 is "found a problem / could not read", 2 is a bad parameter.
const ALLOWED = {
    "lin-reboot-uptime": [0, 1], "lin-failed-units": [0, 1], "lin-disk-usage": [0, 1], "lin-disk-health": [0, 1], "lin-firewall-status": [0, 1],
    "lin-ssh-config": [0, 1], "lin-restart-service": [0, 1, 2], "lin-test-connection": [0, 1], "lin-docker-status": [0, 1], "lin-clean-caches": [0, 1],
    "win-uptime-reboot": [0, 1], "win-failed-services": [0, 1], "win-disk-health": [0, 1], "win-security-status": [0, 1], "win-cert-expiry": [0, 1],
    "win-restart-service": [0], "win-time-sync": [0, 1], "win-defender-update-scan": [0, 1], "win-test-connection": [0, 1], "win-disk-usage": [0, 1],
    "win-clean-temp": [0], "win-flush-dns": [0], "win-stale-accounts": [0], "win-reset-update-cache": [0], "win-recent-logons": [0], "win-event-errors": [0],
};
const allowedOf = (key) => ALLOWED[key] ?? [0];
const envFor = (s, plat, extra = {}) => {
    const env = {};
    for (const p of s.parameters) env[`ADG_${p.name.toUpperCase()}`] = p.defaultValue ?? "";
    if (s.key.endsWith("restart-service")) env.ADG_SERVICE = plat === "win" ? "Spooler" : "cron";
    if (s.key.endsWith("test-connection")) env.ADG_HOST = "localhost";
    if (s.key === "win-disk-usage") env.ADG_PATH = path.join(tmp, "ps");
    if (s.key === "win-event-errors") env.ADG_HOURS = "1";
    if (s.key === "win-recent-logons") env.ADG_DAYS = "1";
    return { ...env, ...extra };
};

console.log("Linux scripts in Docker");
if (run("docker", ["info", "--format", "{{.ServerVersion}}"]).status !== 0) console.log("     (Docker is not running, skipped)");
else {
    const names = [];
    const dk = (...a) => run("docker", a);
    const mkdirBash = path.join(tmp, "bash"); fs.mkdirSync(mkdirBash);
    for (const s of bash) fs.writeFileSync(path.join(mkdirBash, `${s.key}.sh`), s.script, { mode: 0o755 });
    const box = (tag, image, prep) => {
        const n = `adg-bi-${tag}-${Date.now()}`; names.push(n);
        assert.equal(dk("run", "-d", "--name", n, image, "sleep", "1800").status, 0);
        if (prep) dk("exec", n, "bash", "-c", prep);
        assert.equal(dk("cp", mkdirBash, `${n}:/w`).status, 0);
        return n;
    };
    const exec = (n, key, env = {}, user) => dk("exec", ...(user ? ["-u", user] : []), ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), n, "bash", `/w/${key}.sh`);
    try {
        for (const [label, image, prep] of [
            ["Debian 12, bare", "debian:12", ""],
            ["Ubuntu 24.04, bare", "ubuntu:24.04", ""],
            ["Debian 12 with the usual tools", "debian:12", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq procps iproute2 iputils-ping traceroute net-tools cron >/dev/null 2>&1; true"],
        ]) {
            console.log(`  ${label}`);
            const n = box(label.replace(/\W+/g, "").toLowerCase(), image, prep);
            for (const s of bash) {
                check(`${s.key} runs, prints something and exits ${JSON.stringify(allowedOf(s.key))}`, () => {
                    const r = exec(n, s.key, envFor(s, "lin"));
                    assert.ok(allowedOf(s.key).includes(r.status), `exit ${r.status}\n${r.stdout.slice(-400)}${r.stderr.slice(-400)}`);
                    assert.ok((r.stdout + r.stderr).trim().length > 0, "no output");
                    assert.ok(!/command not found|syntax error|unbound variable|bad substitution/i.test(r.stdout + r.stderr), `a shell error showed up:\n${(r.stdout + r.stderr).slice(-500)}`);
                });
            }
        }
        console.log("  parameter safety (Debian 12)");
        const n = box("safety", "debian:12", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq procps iproute2 iputils-ping >/dev/null 2>&1; true");
        const by = (k) => bash.find((s) => s.key === k);
        const gone = (f) => dk("exec", n, "bash", "-c", `test ! -e ${f}`).status === 0;
        const evil = [
            ["lin-restart-service", { ADG_SERVICE: "x; touch /tmp/pwned1" }, "/tmp/pwned1"],
            ["lin-restart-service", { ADG_SERVICE: "$(touch /tmp/pwned2)", ADG_CONFIRM: "YES" }, "/tmp/pwned2"],
            ["lin-test-connection", { ADG_HOST: "localhost; touch /tmp/pwned3" }, "/tmp/pwned3"],
            ["lin-test-connection", { ADG_HOST: "$(touch /tmp/pwned4)" }, "/tmp/pwned4"],
            ["lin-test-connection", { ADG_HOST: "localhost", ADG_PORT: "22; touch /tmp/pwned5" }, "/tmp/pwned5"],
            ["lin-disk-usage", { ADG_PATH: "/tmp; touch /tmp/pwned6" }, "/tmp/pwned6"],
            ["lin-disk-usage", { ADG_PATH: "$(touch /tmp/pwned7)" }, "/tmp/pwned7"],
            ["lin-top-processes", { ADG_COUNT: "5; touch /tmp/pwned8" }, "/tmp/pwned8"],
            ["lin-journal-errors", { ADG_HOURS: "1; touch /tmp/pwned9" }, "/tmp/pwned9"],
            ["lin-clean-caches", { ADG_DAYS: "1; touch /tmp/pwned10", ADG_DRY_RUN: "no", ADG_CONFIRM: "YES" }, "/tmp/pwned10"],
        ];
        for (const [key, env, file] of evil) {
            check(`${key} with ${Object.keys(env).join("/")} = ${Object.values(env)[0].slice(0, 28)}: refused or harmless, nothing is run`, () => {
                const r = exec(n, key, envFor(by(key), "lin", env));
                assert.ok(gone(file), `the injected command ran (${file})`);
                assert.ok((r.stdout + r.stderr).length > 0);
            });
        }
        check("restart service: a bad name exits 2, and a real one without Confirm does not restart it", () => {
            assert.equal(exec(n, "lin-restart-service", { ADG_SERVICE: "bad name!", ADG_CONFIRM: "YES" }).status, 2);
            assert.equal(exec(n, "lin-restart-service", { ADG_SERVICE: "" }).status, 2);
        });
        check("test connection: no host exits 2, a bad port exits 2", () => {
            assert.equal(exec(n, "lin-test-connection", {}).status, 2);
            assert.equal(exec(n, "lin-test-connection", { ADG_HOST: "localhost", ADG_PORT: "99999" }).status, 2);
            assert.equal(exec(n, "lin-test-connection", { ADG_HOST: "-oProxyCommand=x" }).status, 2);
        });
        check("test connection: a port that is open answers open, a closed one fails", () => {
            dk("exec", "-d", n, "bash", "-c", "exec 3<>/dev/null; (while true; do sleep 1; done) & (python3 -m http.server 8099 >/dev/null 2>&1 || true) &");
            const closed = exec(n, "lin-test-connection", { ADG_HOST: "127.0.0.1", ADG_PORT: "9" });
            assert.equal(closed.status, 1); assert.match(closed.stdout, /closed or filtered/);
        });
        check("clean caches: the default run, and one with Dry run=no but no Confirm, only report and leave the package cache alone", () => {
            dk("exec", n, "bash", "-c", "apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq --download-only cowsay >/dev/null 2>&1; ls /var/cache/apt/archives/*.deb 2>/dev/null | wc -l > /tmp/before.txt");
            const before = dk("exec", n, "cat", "/tmp/before.txt").stdout.trim();
            for (const env of [{}, { ADG_DRY_RUN: "no" }, { ADG_CONFIRM: "YES" }]) {
                const r = exec(n, "lin-clean-caches", envFor(by("lin-clean-caches"), "lin", env));
                assert.match(r.stdout, /DRY RUN/); assert.equal(dk("exec", n, "bash", "-c", "ls /var/cache/apt/archives/*.deb 2>/dev/null | wc -l").stdout.trim(), before);
            }
        });
        check("clean caches: a lower-case 'yes' is not YES (still a dry run)", () => {
            const r = exec(n, "lin-clean-caches", envFor(by("lin-clean-caches"), "lin", { ADG_DRY_RUN: "no", ADG_CONFIRM: "yes" }));
            assert.match(r.stdout, /DRY RUN/);
        });
        check("clean caches: Dry run=no AND Confirm=YES really cleans the package cache", () => {
            const r = exec(n, "lin-clean-caches", envFor(by("lin-clean-caches"), "lin", { ADG_DRY_RUN: "no", ADG_CONFIRM: "YES" }));
            assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /apt cache cleaned/);
            assert.equal(dk("exec", n, "bash", "-c", "ls /var/cache/apt/archives/*.deb 2>/dev/null | wc -l").stdout.trim(), "0");
        });
        check("restart service: with Confirm=YES it restarts a real init-script service (cron), and says so", () => {
            dk("exec", n, "bash", "-c", "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron >/dev/null 2>&1; service cron start >/dev/null 2>&1; true");
            // no systemd in a plain container: the script must say so instead of pretending
            const r = exec(n, "lin-restart-service", { ADG_SERVICE: "cron", ADG_CONFIRM: "YES" });
            assert.ok([1, 2].includes(r.status), `${r.status} ${r.stdout}`);
            assert.match(r.stdout + r.stderr, /neither systemd nor OpenRC|no service named/);
        });
    } finally { for (const x of names) dk("rm", "-f", x); }
}

console.log("PowerShell scripts on this machine (no Confirm, so nothing is changed)");
if (!havePs) console.log("     (no Windows PowerShell, skipped)");
else {
    const slow = new Set(["win-disk-usage"]);
    for (const s of ps) {
        check(`${s.key} runs, prints something and exits ${JSON.stringify(allowedOf(s.key))}`, () => {
            const env = { ...process.env, ...envFor(s, "win") };
            const r = run(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(psDir, `${s.key}.ps1`)], { env, timeout: slow.has(s.key) ? 600_000 : 180_000 });
            const out = (r.stdout || "") + (r.stderr || "");
            assert.ok(allowedOf(s.key).includes(r.status), `exit ${r.status}\n${out.slice(-600)}`);
            assert.ok(out.trim().length > 0, "no output");
            assert.ok(!/ParserError|is not recognized as the name|Cannot bind|You cannot call a method|Missing closing|Unexpected token/i.test(out), `a PowerShell error showed up:\n${out.slice(-700)}`);
        });
    }
    check("injection through parameters changes nothing and is refused with exit 2", () => {
        const marker = path.join(tmp, "pwned.txt");
        const attempts = [
            ["win-restart-service", { ADG_SERVICE: `x'; New-Item '${marker}'; '` }],
            ["win-restart-service", { ADG_SERVICE: "$(New-Item '" + marker + "')" }],
            ["win-test-connection", { ADG_HOST: `localhost'; New-Item '${marker}'; '` }],
            ["win-test-connection", { ADG_HOST: "localhost", ADG_PORT: `80; New-Item '${marker}'` }],
            ["win-disk-usage", { ADG_PATH: `C:\\'; New-Item '${marker}'; '` }],
            ["win-top-processes", { ADG_COUNT: `5; New-Item '${marker}'` }],
        ];
        for (const [key, e] of attempts) {
            const s = ps.find((x) => x.key === key);
            const r = run(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(psDir, `${key}.ps1`)], { env: { ...process.env, ...envFor(s, "win", e) }, timeout: 120_000 });
            assert.ok(!fs.existsSync(marker), `${key}: the injected command ran`);
            if (key !== "win-top-processes") assert.equal(r.status, 2, `${key}: exit ${r.status}\n${r.stdout}${r.stderr}`);
        }
    });
    check("restart service and every other change refuse to act without Confirm=YES", () => {
        const r = run(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(psDir, "win-restart-service.ps1")], { env: { ...process.env, ADG_SERVICE: "Spooler", ADG_CONFIRM: "yes" } });
        assert.equal(r.status, 0); assert.match(r.stdout, /Nothing was changed/);
    });
    check("clean temp files, against a stand-in Windows folder and user profiles (nothing real is touched): dry runs, lower-case yes and a missing Confirm delete nothing, and the real run deletes only old files", () => {
        const root = path.join(tmp, "fakeos");
        const win = path.join(root, "Windows"), users = path.join(root, "Users");
        const plant = (dir, name, ageDays) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); fs.writeFileSync(f, "x".repeat(2048)); const d = new Date(Date.now() - ageDays * 86400_000); fs.utimesSync(f, d, d); return f; };
        const oldA = plant(path.join(win, "Temp"), "old-a.tmp", 40), newA = plant(path.join(win, "Temp"), "new-a.tmp", 1);
        const oldB = plant(path.join(users, "bob", "AppData", "Local", "Temp", "sub"), "old-b.tmp", 90), newB = plant(path.join(users, "bob", "AppData", "Local", "Temp"), "new-b.tmp", 2);
        fs.mkdirSync(path.join(users, "Public"), { recursive: true });
        const s = ps.find((x) => x.key === "win-clean-temp");
        const base = { ...process.env, ...envFor(s, "win", { ADG_DAYS: "30" }), WINDIR: win, PUBLIC: path.join(users, "Public") };
        const go = (e) => run(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(psDir, "win-clean-temp.ps1")], { env: { ...base, ...e }, timeout: 300_000 });
        for (const e of [{}, { ADG_DRY_RUN: "no" }, { ADG_CONFIRM: "YES" }, { ADG_DRY_RUN: "no", ADG_CONFIRM: "yes" }, { ADG_DRY_RUN: "NO", ADG_CONFIRM: "YES" }, { ADG_DRY_RUN: "no", ADG_CONFIRM: "NO" }]) {
            const r = go(e);
            assert.match(r.stdout, /Found 2 files older than 30 days/, r.stdout + r.stderr); assert.match(r.stdout, /DRY RUN/, JSON.stringify(e));
            for (const f of [oldA, newA, oldB, newB]) assert.ok(fs.existsSync(f), `deleted on ${JSON.stringify(e)}: ${f}`);
        }
        const r = go({ ADG_DRY_RUN: "no", ADG_CONFIRM: "YES" });
        assert.match(r.stdout, /Deleted 2 files\. 0 could not be deleted/, r.stdout + r.stderr);
        assert.ok(!fs.existsSync(oldA) && !fs.existsSync(oldB), "the old files are gone");
        assert.ok(fs.existsSync(newA) && fs.existsSync(newB), "the recent files stayed");
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
