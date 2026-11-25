// The built-in scripts made for Windows, Linux AND macOS (builtin-scripts.cross.ts): one entry, three texts.
// Checked here: the catalog's shape and the safety rules on ALL THREE texts; the Windows texts parsed and RUN with the real Windows PowerShell on
// this machine (without Confirm, so nothing changes); the Linux texts RUN in Debian 12 and Ubuntu 24.04 containers; the macOS texts checked for
// bash 3.2 and BSD habits (no GNU-only options, no `timeout`, no associative arrays), parsed with bash -n, and their parameter checks run on
// Linux (they refuse bad input before they touch any macOS tool). What is NOT tried: the macOS texts on a real Mac (none is available).
// Run after a build: node test/builtin-scripts-cross.cjs   (Docker and PowerShell parts are skipped with a note when missing)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const dist = path.join(__dirname, "..", process.env.DIST || "dist", "automation");
const C = require(path.join(dist, "builtin-scripts.js"));
const CROSS = C.CROSS_SCRIPTS;
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1e8, timeout: 600_000, ...o });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riq-cross-"));
const texts = (s) => [["windows", s.script], ["linux", s.linuxScript], ["macos", s.macosScript]];

console.log("the catalog");
check("every cross script has all three texts, a platform of all, and is part of what is shipped", () => {
    assert.ok(CROSS.length >= 20, `${CROSS.length} scripts`);
    for (const s of CROSS) {
        assert.equal(s.platform, "all", s.key); assert.equal(s.language, "powershell", s.key);
        for (const [sys, t] of texts(s)) assert.ok(typeof t === "string" && t.trim().length > 40, `${s.key}: no ${sys} text`);
        assert.ok(C.ALL_BUILTIN_SCRIPTS.includes(s), `${s.key} not shipped`);
    }
    assert.equal(C.ALL_BUILTIN_SCRIPTS.length, C.BUILTIN_SCRIPTS.length + CROSS.length);
});
check("keys and names are unique across the whole shipped catalog, keys start with all-, names say all systems", () => {
    const A = C.ALL_BUILTIN_SCRIPTS;
    assert.equal(new Set(A.map((s) => s.key)).size, A.length); assert.equal(new Set(A.map((s) => s.name)).size, A.length);
    for (const s of CROSS) { assert.match(s.key, /^all-[a-z0-9]+(-[a-z0-9]+)*$/, s.key); assert.ok(s.name.toLowerCase().includes("all systems"), s.key); }
});
check("categories are known, descriptions and timeouts sane, ASCII only in name and description", () => {
    for (const s of CROSS) {
        assert.ok(C.BUILTIN_CATEGORIES.includes(s.category), s.key);
        assert.ok(s.description.length >= 30 && s.description.length <= 400, `${s.key} description ${s.description.length}`);
        assert.ok(s.timeoutSec >= 10 && s.timeoutSec <= 86_400, s.key);
        assert.ok(/^[\x20-\x7E]*$/.test(s.name + s.description), `${s.key}: not plain ASCII`);
    }
});
check("parameters: valid unique names; every one is read by EVERY text, and no text reads one that is not declared", () => {
    for (const s of CROSS) {
        const seen = new Set();
        for (const p of s.parameters) {
            assert.match(p.name, /^[A-Za-z][A-Za-z0-9_]{0,63}$/, `${s.key}: ${p.name}`);
            assert.ok(!seen.has(p.name.toLowerCase()), `${s.key}: duplicate ${p.name}`); seen.add(p.name.toLowerCase());
        }
        for (const [sys, t] of texts(s)) {
            for (const p of s.parameters) assert.ok(t.includes(`RIQ_${p.name.toUpperCase()}`), `${s.key}: the ${sys} text never reads ${p.name}`);
            for (const m of t.matchAll(/RIQ_([A-Z][A-Z0-9_]*)/g)) assert.ok(seen.has(m[1].toLowerCase()), `${s.key}: the ${sys} text reads RIQ_${m[1]} but it is not declared`);
        }
    }
});
check("text safety on all three texts: no dollar-brace, no double curly braces, no backtick, ASCII only, no carriage returns, no eval", () => {
    for (const s of CROSS) for (const [sys, t] of texts(s)) {
        assert.ok(!t.includes("${"), `${s.key}/${sys}: dollar-brace`); assert.ok(!t.includes("{{"), `${s.key}/${sys}: double curly braces`);
        assert.ok(!t.includes("`"), `${s.key}/${sys}: backtick`); assert.ok(/^[\x00-\x7F]*$/.test(t), `${s.key}/${sys}: not ASCII`);
        assert.ok(!t.includes("\r"), `${s.key}/${sys}: carriage return`);
        if (sys === "windows") {
            assert.ok(!/Invoke-Expression|\biex\b|Invoke-Command|-EncodedCommand|\bcmd(\.exe)?\s+\/c/i.test(t), `${s.key}: runs a string as code`);
            for (const m of t.matchAll(/^.*\$env:RIQ_\w+.*$/gm)) assert.ok(!/(Start-Process|&\s*"|&\s*\$)/.test(m[0]), `${s.key}: a parameter on a line that starts a program`);
        } else {
            assert.ok(!/\beval\b/.test(t), `${s.key}/${sys}: eval`); assert.ok(!/\b(?:ba)?sh\s+-c\s+"/.test(t), `${s.key}/${sys}: sh -c with an interpolating string`);
            assert.ok(!/xargs[^\n]*\{\}/.test(t), `${s.key}/${sys}: xargs {}`);
        }
    }
});
check("anything that changes the device needs Confirm = YES (default NO) in all three texts; the name says so; dry run defaults to yes", () => {
    for (const s of CROSS) {
        const changes = /changes the device/i.test(s.name), hasConfirm = s.parameters.some((p) => p.name === "confirm");
        assert.equal(changes, hasConfirm, `${s.key}: confirm parameter and name disagree`);
        if (changes) {
            assert.equal(s.parameters.find((p) => p.name === "confirm").defaultValue, "NO", s.key);
            assert.ok(/RIQ_CONFIRM\s*(-cne|-ceq)\s*'YES'/.test(s.script), `${s.key}: the Windows text never compares Confirm with YES (case-sensitively)`);
            for (const [sys, t] of texts(s).slice(1)) assert.ok(/"\$RIQ_CONFIRM"\s*(!=|=)\s*"YES"/.test(t), `${s.key}: the ${sys} text never compares Confirm with YES`);
        }
        const dry = s.parameters.find((p) => p.name === "dry_run");
        if (dry) assert.equal(dry.defaultValue, "yes", s.key);
        assert.ok(!/RIQ_(CONFIRM|DRY_RUN|CANCEL)\s+-(eq|ne)\b/i.test(s.script), `${s.key}: a case-insensitive comparison`);
    }
});
check("macOS texts keep to bash 3.2 and the BSD tools (no GNU-only habits, no Linux-only files or tools)", () => {
    const bad = [
        [/\bdeclare\s+-A\b/, "associative array"], [/\bmapfile\b|\breadarray\b/, "mapfile"], [/\$\{[^}]*(,,|\^\^)/, "case change expansion"],
        [/(^|[\s|;(])timeout\s/m, "timeout command"], [/\bsed\s+-i\b/, "sed -i"], [/\bdate\s+-d\b/, "date -d"], [/\breadlink\s+-f\b/, "readlink -f"],
        [/\bgrep\s+(-[a-zA-Z]*P|--perl)/, "grep -P"], [/\bstat\s+-c\b/, "stat -c"], [/\bxargs\s+-r\b/, "xargs -r"], [/--max-depth/, "du --max-depth"],
        [/-printf\b/, "find -printf"], [/\/proc\//, "/proc"], [/\bsystemctl\b|\bjournalctl\b|\btimedatectl\b|\bgetent\b|\blsblk\b|\bip\s+-?[a-z]/, "a Linux-only tool"],
        [/\bsha256sum\b/, "sha256sum"], [/\bfree\s+-/, "free"], [/&>>?|\|&/, "bash 4 redirect"],
    ];
    for (const s of CROSS) for (const [re, what] of bad) assert.ok(!re.test(s.macosScript), `${s.key}: the macOS text uses ${what}`);
});
check("the Linux texts do not call macOS-only tools, and the Windows texts hold no bash", () => {
    for (const s of CROSS) {
        assert.ok(!/\bsw_vers\b|\bdscacheutil\b|\blaunchctl\b|\bdiskutil\b|\bpmset\b|\bsystemsetup\b/.test(s.linuxScript), `${s.key}: Linux text uses a macOS tool`);
        assert.ok(!/^#!/.test(s.script), `${s.key}: the Windows text starts like bash`);
        assert.ok(s.linuxScript.startsWith("#!/bin/bash") && s.macosScript.startsWith("#!/bin/bash"), s.key);
    }
});

console.log("syntax");
const bashExe = ["bash", "C:/Program Files/Git/bin/bash.exe"].find((x) => run(x, ["-c", "true"]).status === 0);
check(`every Linux and macOS text passes bash -n (${CROSS.length * 2})`, () => {
    if (!bashExe) return console.log("     (no bash, skipped)");
    for (const s of CROSS) for (const [sys, t] of texts(s).slice(1)) { const r = run(bashExe, ["-n"], { input: t }); assert.equal(r.status, 0, `${s.key}/${sys}: ${r.stderr}`); }
});
const psExe = "powershell";
const havePs = process.platform === "win32" && run(psExe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]).status === 0;
const psDir = path.join(tmp, "ps"); fs.mkdirSync(psDir);
for (const s of CROSS) fs.writeFileSync(path.join(psDir, `${s.key}.ps1`), s.script);
check(`every Windows text parses with the real Windows PowerShell parser (${CROSS.length})`, () => {
    if (!havePs) return console.log("     (no Windows PowerShell, skipped)");
    const r = run(psExe, ["-NoProfile", "-Command", `Get-ChildItem '${psDir}' -Filter *.ps1 | ForEach-Object { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e); if ($e.Count) { $_.Name + ': ' + ($e | ForEach-Object { $_.Message }) -join '; ' } }`]);
    assert.equal(r.stdout.trim(), "", r.stdout + r.stderr);
});

/* ------------------------------ real runs ------------------------------ */
const ALLOWED = { "all-uptime-restart": [0, 1], "all-disk-usage": [0, 1], "all-test-connection": [0, 1], "all-firewall-status": [0, 1], "all-time-status": [0, 1], "all-restart-service": [0, 1, 2], "all-stop-process": [0, 1], "all-dns-lookup": [0, 1], "all-listening-ports": [0, 1] };
const allowedOf = (k) => ALLOWED[k] ?? [0];
const envFor = (s, sys, extra = {}) => {
    const env = {};
    for (const p of s.parameters) env[`RIQ_${p.name.toUpperCase()}`] = p.defaultValue ?? "";
    if (s.key === "all-restart-service") env.RIQ_SERVICE = sys === "windows" ? "Spooler" : "cron";
    if (s.key === "all-test-connection") env.RIQ_HOST = "localhost";
    if (s.key === "all-dns-lookup") env.RIQ_NAME = "localhost";
    if (s.key === "all-stop-process") env.RIQ_PROCESS = "riq-no-such-program";
    if (s.key === "all-recent-errors") env.RIQ_HOURS = "1";
    if (s.key === "all-disk-usage") env.RIQ_PATH = sys === "windows" ? psDir : "/etc";
    if (s.key === "all-file-hash") env.RIQ_PATH = sys === "windows" ? path.join(psDir, "all-file-hash.ps1") : "/etc/hostname";
    return { ...env, ...extra };
};
const badOutput = (o) => /command not found|syntax error|unbound variable|bad substitution|ParserError|is not recognized as the name/i.test(o);

console.log("Windows texts run for real (Windows PowerShell, no Confirm)");
if (!havePs) console.log("     (no Windows PowerShell, skipped)");
else for (const s of CROSS) {
    check(`${s.key} runs and exits ${JSON.stringify(allowedOf(s.key))}`, () => {
        const env = envFor(s, "windows");
        const r = run(psExe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(psDir, `${s.key}.ps1`)], { env: { ...process.env, ...env } });
        assert.ok(allowedOf(s.key).includes(r.status), `exit ${r.status}\n${r.stdout.slice(-400)}${r.stderr.slice(-400)}`);
        assert.ok((r.stdout + r.stderr).trim().length > 0, "no output");
        assert.ok(!badOutput(r.stdout + r.stderr), `a shell error showed up:\n${(r.stdout + r.stderr).slice(-500)}`);
    });
}
if (havePs) {
    const ps = (key, env) => run(psExe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(psDir, `${key}.ps1`)], { env: { ...process.env, ...env } });
    const by = (k) => CROSS.find((s) => s.key === k);
    check("Windows: bad names and paths exit 2, injected text is not run, the refused-process list holds", () => {
        const marker = path.join(tmp, "pwned-ps"); const q = marker.replace(/\\/g, "/");
        assert.equal(ps("all-dns-lookup", { RIQ_NAME: "x; New-Item " + q }).status, 2);
        assert.equal(ps("all-stop-process", { RIQ_PROCESS: "x; New-Item " + q, RIQ_CONFIRM: "YES" }).status, 2);
        assert.equal(ps("all-stop-process", { RIQ_PROCESS: "lsass", RIQ_CONFIRM: "YES" }).status, 2);
        assert.equal(ps("all-stop-process", { RIQ_PROCESS: "RemoteIQ.Agent", RIQ_CONFIRM: "YES" }).status, 2);
        assert.equal(ps("all-file-hash", { RIQ_PATH: path.join(tmp, "no-such-file") }).status, 2);
        assert.equal(ps("all-restart-service", { RIQ_SERVICE: "bad;name" }).status, 2);
        assert.ok(!fs.existsSync(marker) && !fs.existsSync(q), "the injected command ran");
        assert.ok(by("all-schedule-restart"));
    });
    check("Windows: file hash is the real SHA-256 of the file", () => {
        const f = path.join(tmp, "hash-me.txt"); fs.writeFileSync(f, "hello cross platform");
        const want = require("node:crypto").createHash("sha256").update("hello cross platform").digest("hex");
        const r = ps("all-file-hash", { RIQ_PATH: f }); assert.equal(r.status, 0); assert.ok(r.stdout.includes(want), r.stdout);
    });
    check("Windows: stop-process without Confirm lists a real process and stops nothing", () => {
        const r = ps("all-stop-process", { RIQ_PROCESS: "powershell", RIQ_CONFIRM: "NO" });
        assert.equal(r.status, 0); assert.match(r.stdout, /Nothing was stopped/);
    });
    check("Windows: schedule-restart without Confirm changes nothing (and never starts a restart)", () => {
        const r = ps("all-schedule-restart", { RIQ_MINUTES: "5", RIQ_CONFIRM: "NO", RIQ_CANCEL: "NO" });
        assert.equal(r.status, 0); assert.match(r.stdout, /Nothing was changed/);
        const c = ps("all-schedule-restart", { RIQ_MINUTES: "5", RIQ_CONFIRM: "NO", RIQ_CANCEL: "YES" }); assert.match(c.stdout, /Nothing was changed/);
    });
}

console.log("Linux texts in Docker");
const have = run("docker", ["info", "--format", "{{.ServerVersion}}"]).status === 0;
if (!have) console.log("     (Docker is not running, skipped)");
else {
    const names = [];
    const dk = (...a) => run("docker", a);
    const dirs = {};
    for (const sys of ["linux", "macos"]) {
        dirs[sys] = path.join(tmp, sys); fs.mkdirSync(dirs[sys]);
        for (const s of CROSS) fs.writeFileSync(path.join(dirs[sys], `${s.key}.sh`), sys === "linux" ? s.linuxScript : s.macosScript, { mode: 0o755 });
    }
    const box = (tag, image, prep) => {
        const n = `riq-cross-${tag}-${Date.now()}`; names.push(n);
        assert.equal(dk("run", "-d", "--name", n, image, "sleep", "1800").status, 0);
        if (prep) dk("exec", n, "bash", "-c", prep);
        assert.equal(dk("cp", dirs.linux, `${n}:/w`).status, 0); assert.equal(dk("cp", dirs.macos, `${n}:/m`).status, 0);
        return n;
    };
    const exec = (n, dir, key, env = {}) => dk("exec", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), n, "bash", `/${dir}/${key}.sh`);
    try {
        for (const [label, image, prep] of [
            ["Debian 12, bare", "debian:12", ""],
            ["Ubuntu 24.04, bare", "ubuntu:24.04", ""],
            ["Debian 12 with the usual tools", "debian:12", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq procps iproute2 iputils-ping traceroute net-tools cron util-linux >/dev/null 2>&1; true"],
        ]) {
            console.log(`  ${label}`);
            const n = box(label.replace(/\W+/g, "").toLowerCase(), image, prep);
            for (const s of CROSS) {
                check(`${s.key} (Linux text) runs, prints something and exits ${JSON.stringify(allowedOf(s.key))}`, () => {
                    const r = exec(n, "w", s.key, envFor(s, "linux"));
                    assert.ok(allowedOf(s.key).includes(r.status), `exit ${r.status}\n${r.stdout.slice(-400)}${r.stderr.slice(-400)}`);
                    assert.ok((r.stdout + r.stderr).trim().length > 0, "no output");
                    assert.ok(!badOutput(r.stdout + r.stderr), `a shell error showed up:\n${(r.stdout + r.stderr).slice(-500)}`);
                });
            }
        }
        console.log("  parameter safety and real effects (Debian 12, Linux texts)");
        const n = box("safety", "debian:12", "apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq procps iproute2 iputils-ping util-linux >/dev/null 2>&1; true");
        const gone = (f) => dk("exec", n, "bash", "-c", `test ! -e ${f}`).status === 0;
        const by = (k) => CROSS.find((s) => s.key === k);
        const evil = [
            ["all-restart-service", { RIQ_SERVICE: "x; touch /tmp/pwned1" }, "/tmp/pwned1"],
            ["all-restart-service", { RIQ_SERVICE: "$(touch /tmp/pwned2)", RIQ_CONFIRM: "YES" }, "/tmp/pwned2"],
            ["all-test-connection", { RIQ_HOST: "localhost; touch /tmp/pwned3" }, "/tmp/pwned3"],
            ["all-test-connection", { RIQ_HOST: "localhost", RIQ_PORT: "22; touch /tmp/pwned4" }, "/tmp/pwned4"],
            ["all-disk-usage", { RIQ_PATH: "/tmp; touch /tmp/pwned5" }, "/tmp/pwned5"],
            ["all-top-processes", { RIQ_COUNT: "5; touch /tmp/pwned6" }, "/tmp/pwned6"],
            ["all-recent-errors", { RIQ_HOURS: "1; touch /tmp/pwned7" }, "/tmp/pwned7"],
            ["all-clean-temp", { RIQ_DAYS: "1; touch /tmp/pwned8", RIQ_DRY_RUN: "no", RIQ_CONFIRM: "YES" }, "/tmp/pwned8"],
            ["all-stop-process", { RIQ_PROCESS: "x; touch /tmp/pwned9", RIQ_CONFIRM: "YES" }, "/tmp/pwned9"],
            ["all-stop-process", { RIQ_PROCESS: "$(touch /tmp/pwned10)", RIQ_CONFIRM: "YES" }, "/tmp/pwned10"],
            ["all-dns-lookup", { RIQ_NAME: "localhost; touch /tmp/pwned11" }, "/tmp/pwned11"],
            ["all-dns-lookup", { RIQ_NAME: "$(touch /tmp/pwned12)" }, "/tmp/pwned12"],
            ["all-file-hash", { RIQ_PATH: "/etc/hostname; touch /tmp/pwned13" }, "/tmp/pwned13"],
            ["all-schedule-restart", { RIQ_MINUTES: "5; touch /tmp/pwned14", RIQ_CONFIRM: "NO" }, "/tmp/pwned14"],
        ];
        for (const dir of ["w", "m"]) for (const [key, env, file] of evil) {
            check(`${dir === "w" ? "Linux" : "macOS"} text of ${key} with ${Object.keys(env)[0]} = ${Object.values(env)[0].slice(0, 26)}: refused or harmless, nothing is run`, () => {
                const r = exec(n, dir, key, envFor(by(key), "linux", env));
                assert.ok(gone(file), `the injected command ran (${file})`); assert.ok((r.stdout + r.stderr).length > 0);
            });
        }
        check("bad input exits 2 in the Linux and the macOS text: service name, host, process, name, file, port", () => {
            for (const dir of ["w", "m"]) {
                assert.equal(exec(n, dir, "all-restart-service", { RIQ_SERVICE: "bad name!", RIQ_CONFIRM: "YES" }).status, 2, `${dir} restart`);
                assert.equal(exec(n, dir, "all-test-connection", {}).status, 2, `${dir} host`);
                assert.equal(exec(n, dir, "all-test-connection", { RIQ_HOST: "localhost", RIQ_PORT: "99999" }).status, 2, `${dir} port`);
                assert.equal(exec(n, dir, "all-stop-process", { RIQ_PROCESS: "" }).status, 2, `${dir} process`);
                assert.equal(exec(n, dir, "all-stop-process", { RIQ_PROCESS: dir === "w" ? "systemd" : "launchd", RIQ_CONFIRM: "YES" }).status, 2, `${dir} refused process`);
                assert.equal(exec(n, dir, "all-stop-process", { RIQ_PROCESS: "RemoteIQ-Agent", RIQ_CONFIRM: "YES" }).status, 2, `${dir} refused RemoteIQ`);
                assert.equal(exec(n, dir, "all-dns-lookup", {}).status, 2, `${dir} name`);
                assert.equal(exec(n, dir, "all-file-hash", { RIQ_PATH: "/no/such/file" }).status, 2, `${dir} file`);
                assert.equal(exec(n, dir, "all-disk-usage", { RIQ_PATH: "/no/such/folder" }).status, 2, `${dir} path`);
            }
        });
        check("Linux: file hash is the real SHA-256; DNS lookup resolves localhost", () => {
            dk("exec", n, "bash", "-c", "printf 'hello cross platform' > /tmp/hash-me.txt");
            const want = require("node:crypto").createHash("sha256").update("hello cross platform").digest("hex");
            const r = exec(n, "w", "all-file-hash", { RIQ_PATH: "/tmp/hash-me.txt" }); assert.equal(r.status, 0); assert.ok(r.stdout.includes(want), r.stdout);
            const d = exec(n, "w", "all-dns-lookup", { RIQ_NAME: "localhost" }); assert.equal(d.status, 0, d.stdout); assert.match(d.stdout, /127\.0\.0\.1|::1/);
        });
        check("Linux: clean temp removes ONLY old files and only with Dry run no AND Confirm YES", () => {
            dk("exec", n, "bash", "-c", "mkdir -p /tmp/riq-ct && echo old > /tmp/riq-ct/old.txt && echo new > /tmp/riq-ct/new.txt && touch -d '40 days ago' /tmp/riq-ct/old.txt");
            const exists = (f) => dk("exec", n, "bash", "-c", `test -e ${f}`).status === 0;
            exec(n, "w", "all-clean-temp", { RIQ_DAYS: "7", RIQ_DRY_RUN: "yes", RIQ_CONFIRM: "YES" }); assert.ok(exists("/tmp/riq-ct/old.txt"), "a dry run deleted");
            exec(n, "w", "all-clean-temp", { RIQ_DAYS: "7", RIQ_DRY_RUN: "no", RIQ_CONFIRM: "NO" }); assert.ok(exists("/tmp/riq-ct/old.txt"), "no confirm but it deleted");
            exec(n, "w", "all-clean-temp", { RIQ_DAYS: "7", RIQ_DRY_RUN: "no", RIQ_CONFIRM: "yes" }); assert.ok(exists("/tmp/riq-ct/old.txt"), "a lower-case yes counted as YES");
            const r = exec(n, "w", "all-clean-temp", { RIQ_DAYS: "7", RIQ_DRY_RUN: "no", RIQ_CONFIRM: "YES" }); assert.equal(r.status, 0, r.stdout);
            assert.ok(!exists("/tmp/riq-ct/old.txt"), "the old file is still there"); assert.ok(exists("/tmp/riq-ct/new.txt"), "the new file was deleted");
        });
        check("Linux: stop-process lists, stops only with Confirm YES, and never touches itself", () => {
            dk("exec", "-d", n, "bash", "-c", "exec -a riqsleeper sleep 600");
            dk("exec", "-d", n, "bash", "-c", "cp /bin/sleep /tmp/riqsleeper && exec /tmp/riqsleeper 600");
            const alive = () => dk("exec", n, "pgrep", "-x", "riqsleeper").status === 0;
            assert.ok(alive(), "the test process did not start");
            const a = exec(n, "w", "all-stop-process", { RIQ_PROCESS: "riqsleeper", RIQ_CONFIRM: "NO" }); assert.equal(a.status, 0); assert.match(a.stdout, /Nothing was stopped/); assert.ok(alive());
            const b = exec(n, "w", "all-stop-process", { RIQ_PROCESS: "riqsleeper", RIQ_CONFIRM: "YES" }); assert.equal(b.status, 0, b.stdout + b.stderr);
            assert.ok(!alive(), "it is still running");
        });
        check("Linux: schedule-restart without Confirm changes nothing; cancel without Confirm changes nothing", () => {
            assert.match(exec(n, "w", "all-schedule-restart", { RIQ_MINUTES: "5", RIQ_CONFIRM: "NO" }).stdout, /Nothing was changed/);
            assert.match(exec(n, "w", "all-schedule-restart", { RIQ_CANCEL: "YES", RIQ_CONFIRM: "NO" }).stdout, /Nothing was changed/);
        });
    } finally {
        for (const n of names) dk("rm", "-f", n);
    }
}
console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
