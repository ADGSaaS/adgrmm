// backend/src/device-tools/device-tools.scripts.ts
//
// The services, processes and event log tools (roadmap 1.16) are ordinary signed script jobs: no new agent code. This file
// holds everything that touches text going to or coming from a device, so it can be tested without a device:
//   - checking what a person typed (service names, process ids, log names, levels, hours, counts, search text),
//   - the fixed scripts (the script text never contains anything a person typed: values travel in environment variables,
//     which PowerShell and bash never parse as code),
//   - turning what a script printed into rows.
// Windows scripts print JSON with every non-ASCII character escaped, so the agent's output code page cannot garble it.
// Linux scripts print text that is parsed here (systemctl and ps have no JSON output; journalctl has).

import { BadRequestException } from "@nestjs/common";

export type Family = "windows" | "linux";

export const MAX_EVENTS = 500;
/** More events than are returned are read when a search text is given, because the filter runs after the read. */
export const SEARCH_SCAN = 5000;
const MAX_HOURS = 24 * 90;

/* ------------------------------ checking input ------------------------------ */

const WINDOWS_SERVICE = /^[A-Za-z0-9_.$@# -]{1,256}$/;
const LINUX_UNIT = /^[A-Za-z0-9:_.@\\-]{1,250}$/;
const WINDOWS_LOG = /^[A-Za-z0-9 _.\-/]{1,128}$/;
const LINUX_LOGS = ["system", "kernel", "security"] as const;

export type ServiceAction = "start" | "stop" | "restart" | "startup";
export type StartType = "automatic" | "delayed" | "manual" | "disabled";
export const SERVICE_ACTIONS: ServiceAction[] = ["start", "stop", "restart", "startup"];
export const START_TYPES: StartType[] = ["automatic", "delayed", "manual", "disabled"];

export function cleanServiceName(raw: unknown, family: Family): string {
    const name = String(raw ?? "").trim();
    if (!name) throw new BadRequestException("Say which service.");
    if (name.startsWith("-")) throw new BadRequestException("That is not a service name.");
    if (family === "windows") {
        // No wildcard, quote or shell characters: the name is matched exactly, and it also travels in an environment variable.
        if (!WINDOWS_SERVICE.test(name)) throw new BadRequestException("That is not a valid Windows service name.");
        return name;
    }
    const unit = name.endsWith(".service") ? name : `${name}.service`;
    if (!LINUX_UNIT.test(unit) || unit.includes("..")) throw new BadRequestException("That is not a valid service (unit) name.");
    return unit;
}

export function cleanPid(raw: unknown): number {
    const n = typeof raw === "number" ? raw : /^\d{1,9}$/.test(String(raw ?? "").trim()) ? Number(String(raw).trim()) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 4_194_304) throw new BadRequestException("That is not a valid process id.");
    if (n <= 4) throw new BadRequestException("That process belongs to the operating system and cannot be ended.");
    return n;
}

export function cleanLogName(raw: unknown, family: Family): string {
    const log = String(raw ?? "").trim() || (family === "windows" ? "Application" : "system");
    if (family === "windows") {
        if (!WINDOWS_LOG.test(log)) throw new BadRequestException("That is not a valid event log name.");
        return log;
    }
    const lower = log.toLowerCase();
    if (!(LINUX_LOGS as readonly string[]).includes(lower)) throw new BadRequestException("This system's logs are system, kernel or security.");
    return lower;
}

/** Windows event levels by their number (Critical 1, Error 2, Warning 3, Information 4, Verbose 5). */
export const LEVELS: Record<string, number> = { critical: 1, error: 2, warning: 3, information: 4, verbose: 5 };

export function cleanLevels(raw: unknown): number[] {
    const list = (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    const out = new Set<number>();
    for (const l of list) {
        const n = LEVELS[l];
        if (!n) throw new BadRequestException(`"${l}" is not an event level. Use critical, error, warning, information or verbose.`);
        out.add(n);
    }
    return [...out].sort();
}

export function cleanHours(raw: unknown): number {
    if (raw === undefined || raw === null || raw === "") return 24;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > MAX_HOURS) throw new BadRequestException(`Hours must be from 1 to ${MAX_HOURS}.`);
    return Math.floor(n);
}

export function cleanMax(raw: unknown): number {
    if (raw === undefined || raw === null || raw === "") return 200;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > MAX_EVENTS) throw new BadRequestException(`The number of events must be from 1 to ${MAX_EVENTS}.`);
    return Math.floor(n);
}

export function cleanSearch(raw: unknown): string {
    const text = String(raw ?? "").trim();
    if (text.length > 200) throw new BadRequestException("The search text is too long (200 characters at most).");
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new BadRequestException("The search text has characters that are not allowed.");
    return text;
}

/* ------------------------------ Windows scripts ------------------------------ */

// Every script ends in Out-Adg, which prints one JSON text made only of ASCII, so the agent's output code page cannot garble it.
const PS_HEAD = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function ConvertTo-Ascii([string]$s) {
  $bs = [string][char]92
  return [regex]::Replace($s, '[^\x00-\x7F]', { param($m) $bs + 'u' + ('{0:x4}' -f [int][char]$m.Value) })
}
function Out-Adg($obj) { [Console]::Out.Write((ConvertTo-Ascii ($obj | ConvertTo-Json -Compress -Depth 6))) }
function Fail($e) { Out-Adg @{ ok = $false; error = [string]$e.Exception.Message } }
`;

const psc = (body: string) => `${PS_HEAD}try {\n${body}\n} catch { Fail $_ }\n`;

// Asking for every property of Win32_Service can take about 90 seconds on some PCs (one of the computed ones is slow), so only the ones used are read.
const PS_SERVICE_ROWS = String.raw`$rows = @(Get-CimInstance -ClassName Win32_Service -Property Name,DisplayName,State,StartMode,DelayedAutoStart,StartName,ProcessId | ForEach-Object {
  @{ name = $_.Name; display = $_.DisplayName; state = [string]$_.State; startMode = [string]$_.StartMode; delayed = [bool]$_.DelayedAutoStart; account = [string]$_.StartName; pid = [int]$_.ProcessId }
})`;

export const WINDOWS = {
    servicesList: psc(`${PS_SERVICE_ROWS}\nOut-Adg @{ ok = $true; items = $rows }`),

    // The service name arrives in ADG_SERVICE and is matched exactly (a ServiceController, not a wildcard pattern).
    serviceAction: psc(String.raw`$name = $env:ADG_SERVICE
$action = $env:ADG_ACTION
$force = ($env:ADG_FORCE -eq '1')
$s = New-Object System.ServiceProcess.ServiceController($name)
$null = $s.Status
switch ($action) {
  'start'   { if ($s.Status -ne 'Running') { Start-Service -InputObject $s; $s.WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) } }
  'stop'    { if ($s.Status -ne 'Stopped') { if ($force) { Stop-Service -InputObject $s -Force } else { Stop-Service -InputObject $s }; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } }
  'restart' { if ($force) { Restart-Service -InputObject $s -Force } else { Restart-Service -InputObject $s }; $s.Refresh(); $s.WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) }
  'startup' {
    $mode = switch ($env:ADG_STARTTYPE) { 'automatic' { 'auto' } 'delayed' { 'delayed-auto' } 'manual' { 'demand' } 'disabled' { 'disabled' } default { throw 'Unknown start type.' } }
    $out = & sc.exe config $name start= $mode 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw ('sc.exe could not change the start type: ' + $out.Trim()) }
  }
  default   { throw 'Unknown action.' }
}
$s.Refresh()
$c = Get-CimInstance -ClassName Win32_Service -Property Name,StartMode,DelayedAutoStart -Filter ("Name='" + $name.Replace("'", "''") + "'")
Out-Adg @{ ok = $true; name = $name; state = [string]$s.Status; startMode = [string]$c.StartMode; delayed = [bool]$c.DelayedAutoStart }`),

    processesList: psc(String.raw`$procs = @(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | ForEach-Object {
  $cpu = $null; try { if ($_.CPU -ne $null) { $cpu = [math]::Round([double]$_.CPU, 1) } } catch { }
  @{ name = $_.ProcessName; pid = [int]$_.Id; cpuSeconds = $cpu; memoryMb = [math]::Round($_.WorkingSet64 / 1MB, 1); user = [string]$_.UserName }
})
Out-Adg @{ ok = $true; items = $procs }`),

    // The process id arrives in ADG_PID. Processes whose end stops Windows, and this agent's own, are refused here as well.
    processEnd: psc(String.raw`$procId = [int]$env:ADG_PID
if ($procId -le 4) { throw 'That process belongs to the operating system.' }
$p = Get-Process -Id $procId
$protected = @('system','idle','smss','csrss','wininit','winlogon','services','lsass','lsm','registry','memory compression','secure system')
if ($protected -contains $p.ProcessName.ToLower()) { throw ('Ending ' + $p.ProcessName + ' would stop Windows, so it is not allowed.') }
if ($p.ProcessName -like 'ADG RMM*') { throw 'This is the ADG RMM agent, which runs this tool. Update or restart it from the device actions instead.' }
$me = $PID; $guard = @($me)
try { $parent = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $me)).ParentProcessId; if ($parent) { $guard += [int]$parent } } catch { }
if ($guard -contains $procId) { throw 'That process is running this tool.' }
$name = $p.ProcessName
Stop-Process -Id $procId -Force
Out-Adg @{ ok = $true; pid = $procId; name = $name }`),

    // ADG_LOG, ADG_HOURS, ADG_MAX, ADG_LEVELS (numbers, comma separated), ADG_TEXT (a plain substring) and ADG_SCAN.
    eventLog: psc(String.raw`$log = $env:ADG_LOG
$hours = [int]$env:ADG_HOURS
$max = [int]$env:ADG_MAX
$text = $env:ADG_TEXT
$scan = [int]$env:ADG_SCAN
$filter = @{ LogName = $log; StartTime = (Get-Date).AddHours(-$hours) }
if ($env:ADG_LEVELS) { $filter.Level = [int[]]($env:ADG_LEVELS -split ',') }
$take = if ($text) { $scan } else { $max }
$events = @()
try { $events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents $take) }
catch {
  if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*' -or $_.Exception.Message -like 'No events were found*') { $events = @() }
  elseif ($_.Exception.Message -like '*Attempted to perform an unauthorized operation*') { throw 'The agent is not allowed to read this log.' }
  else { throw }
}
$parts = New-Object System.Collections.Generic.List[string]
$size = 0; $cut = $false; $matched = 0
foreach ($e in $events) {
  $msg = ''; try { $msg = [string]$e.Message } catch { }
  if ($text -and $msg.IndexOf($text, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and ([string]$e.ProviderName).IndexOf($text, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
  if ($msg.Length -gt 700) { $msg = $msg.Substring(0, 700) + '...' }
  $json = ConvertTo-Ascii (@{ time = $e.TimeCreated.ToUniversalTime().ToString('o'); id = [int]$e.Id; level = [string]$e.LevelDisplayName; levelNumber = [int]$e.Level; provider = [string]$e.ProviderName; message = $msg; record = [string]$e.RecordId } | ConvertTo-Json -Compress)
  if ($size + $json.Length -gt 150000) { $cut = $true; break }
  $parts.Add($json); $size += $json.Length + 1; $matched++
  if ($matched -ge $max) { if ($events.Count -gt $matched) { $cut = $true }; break }
}
[Console]::Out.Write('{"ok":true,"truncated":' + $cut.ToString().ToLower() + ',"scanned":' + $events.Count + ',"items":[' + ($parts -join ',') + ']}')`),
};

/* ------------------------------ Linux scripts ------------------------------ */

export const LINUX = {
    servicesList: `set -u
systemctl list-units --type=service --all --no-legend --no-pager --plain 2>&1 | head -c 400000
echo "---UNITFILES---"
systemctl list-unit-files --type=service --no-legend --no-pager 2>&1 | head -c 200000
`,

    // ADG_SERVICE is a validated unit name; ADG_ACTION is one of the fixed commands below. Neither is ever part of the script text.
    serviceAction: `set -u
case "$ADG_ACTION" in
  start|stop|restart|enable|disable|mask|unmask) ;;
  *) echo "ERR: unknown action"; exit 0 ;;
esac
out=$(systemctl "$ADG_ACTION" -- "$ADG_SERVICE" 2>&1)
rc=$?
if [ $rc -ne 0 ]; then echo "ERR: $out" | head -c 2000; exit 0; fi
echo "OK"
echo "$(systemctl is-active -- "$ADG_SERVICE" 2>&1)"
echo "$(systemctl is-enabled -- "$ADG_SERVICE" 2>&1)"
`,

    processesList: `set -u
ps -eo pid=,user:32=,rss=,time=,comm= --sort=-pcpu 2>&1 | head -c 400000
`,

    // ADG_PID is a validated number; ADG_FORCE=1 sends KILL instead of TERM.
    processEnd: `set -u
if [ "$ADG_PID" -le 1 ]; then echo "ERR: that process belongs to the operating system"; exit 0; fi
if [ "$ADG_PID" -eq "$$" ] || [ "$ADG_PID" -eq "$PPID" ]; then echo "ERR: that process is running this tool"; exit 0; fi
name=$(ps -p "$ADG_PID" -o comm= 2>/dev/null)
if [ -z "$name" ]; then echo "ERR: there is no process with that id"; exit 0; fi
case "$name" in adgrmm*) echo "ERR: this is the ADG RMM agent, which runs this tool"; exit 0 ;; esac
sig=TERM; [ "\${ADG_FORCE:-}" = "1" ] && sig=KILL
out=$(kill -"$sig" "$ADG_PID" 2>&1) || { echo "ERR: $out"; exit 0; }
echo "OK"
echo "$name"
`,

    // ADG_LOG (system, kernel, security), ADG_SINCE (epoch seconds), ADG_MAX, ADG_SCAN, ADG_PRIO (0 to 7, the least severe wanted), ADG_TEXT.
    eventLog: `set -u
since=$(date -u -d "@$ADG_SINCE" '+%Y-%m-%d %H:%M:%S')
args=(--no-pager -o json -r --since "$since" -n "$ADG_SCAN" --output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_SYSTEMD_UNIT,_COMM)
[ -n "\${ADG_PRIO:-}" ] && args+=(-p "$ADG_PRIO")
case "$ADG_LOG" in
  kernel) args+=(-k) ;;
  security) args+=(SYSLOG_FACILITY=4 SYSLOG_FACILITY=10) ;;
esac
if [ -n "\${ADG_TEXT:-}" ]; then
  journalctl "\${args[@]}" 2>&1 | grep -i -F -e "$ADG_TEXT" | head -n "$ADG_MAX" | head -c 190000
else
  journalctl "\${args[@]}" 2>&1 | head -n "$ADG_MAX" | head -c 190000
fi
`,
};

/* ------------------------------ reading what a device printed ------------------------------ */

export type ServiceRow = { name: string; display: string; state: string; startType: string; account: string | null; pid: number | null };
export type ProcessRow = { name: string; pid: number; cpuSeconds: number | null; memoryMb: number | null; user: string | null };
export type EventRow = { time: string; id: number | null; level: string; levelNumber: number | null; provider: string; message: string };

export class ToolOutputError extends Error { }

/** The JSON a Windows script printed, or the reason it did not print any. */
export function parseWindowsJson(stdout: string, stderr: string): any {
    const text = String(stdout ?? "").trim();
    if (!text) throw new ToolOutputError(stderr.trim() ? stderr.trim().slice(0, 400) : "The device printed nothing.");
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ToolOutputError("The device's answer could not be read. It may have been cut short because it was too large.");
    }
    if (parsed?.ok === false) throw new ToolOutputError(String(parsed.error || "The device reported an error.").slice(0, 500));
    return parsed;
}

const winState = (s: string) => ({ Running: "running", Stopped: "stopped", Paused: "paused", StartPending: "starting", StopPending: "stopping", ContinuePending: "starting", PausePending: "stopping" } as Record<string, string>)[s] ?? s.toLowerCase();
const winStart = (mode: string, delayed: boolean) => (mode === "Auto" ? (delayed ? "automatic (delayed)" : "automatic") : mode === "Manual" ? "manual" : mode === "Disabled" ? "disabled" : mode === "Boot" || mode === "System" ? "boot / system" : mode.toLowerCase());

export function windowsServices(parsed: any): ServiceRow[] {
    return (Array.isArray(parsed?.items) ? parsed.items : []).map((r: any) => ({
        name: String(r.name ?? ""),
        display: String(r.display ?? ""),
        state: winState(String(r.state ?? "")),
        startType: winStart(String(r.startMode ?? ""), !!r.delayed),
        account: r.account ? String(r.account) : null,
        pid: Number(r.pid) > 0 ? Number(r.pid) : null,
    })).sort((a: ServiceRow, b: ServiceRow) => a.display.localeCompare(b.display) || a.name.localeCompare(b.name));
}

export function windowsProcesses(parsed: any): ProcessRow[] {
    return (Array.isArray(parsed?.items) ? parsed.items : []).map((r: any) => ({
        name: String(r.name ?? ""),
        pid: Number(r.pid) || 0,
        cpuSeconds: typeof r.cpuSeconds === "number" ? r.cpuSeconds : null,
        memoryMb: typeof r.memoryMb === "number" ? r.memoryMb : null,
        user: r.user ? String(r.user) : null,
    })).sort((a: ProcessRow, b: ProcessRow) => (b.memoryMb ?? 0) - (a.memoryMb ?? 0));
}

export function windowsEvents(parsed: any): { items: EventRow[]; truncated: boolean; scanned: number } {
    const items = (Array.isArray(parsed?.items) ? parsed.items : []).map((r: any) => ({
        time: String(r.time ?? ""),
        id: Number.isFinite(Number(r.id)) ? Number(r.id) : null,
        level: String(r.level ?? ""),
        levelNumber: Number.isFinite(Number(r.levelNumber)) ? Number(r.levelNumber) : null,
        provider: String(r.provider ?? ""),
        message: String(r.message ?? ""),
    }));
    return { items, truncated: !!parsed?.truncated, scanned: Number(parsed?.scanned) || items.length };
}

/** "ERR: ..." as the first line is an error; "OK" is success. */
export function linuxOutcome(stdout: string, stderr: string): string[] {
    const lines = String(stdout ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
    const first = (lines[0] ?? "").trim();
    if (first.startsWith("ERR:")) throw new ToolOutputError(first.slice(4).trim().slice(0, 500) || "The device reported an error.");
    if (first !== "OK") throw new ToolOutputError(stderr.trim() ? stderr.trim().slice(0, 400) : "The device's answer could not be read.");
    return lines.slice(1);
}

const unitState = (active: string, sub: string) => ({ active: "running", inactive: "stopped", failed: "failed", activating: "starting", deactivating: "stopping", reloading: "running" } as Record<string, string>)[active] ?? (sub || active);
const unitStart = (s: string) => ({ enabled: "automatic", "enabled-runtime": "automatic", disabled: "manual", masked: "disabled", "masked-runtime": "disabled", static: "manual (static)", indirect: "manual (static)", generated: "manual (generated)", alias: "alias" } as Record<string, string>)[s] ?? (s || "unknown");

export function linuxServices(stdout: string): ServiceRow[] {
    const [unitsPart, filesPart = ""] = String(stdout ?? "").split("---UNITFILES---");
    const files = new Map<string, string>();
    for (const line of filesPart.split("\n")) {
        const [unit, state] = line.trim().split(/\s+/);
        if (unit && state && unit.endsWith(".service")) files.set(unit, state);
    }
    const rows: ServiceRow[] = [];
    for (const raw of unitsPart.split("\n")) {
        const line = raw.replace(/^[^A-Za-z0-9@_.\\:-]+/, "").trim();
        const m = /^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
        if (!m) continue;
        const [, unit, load, active, sub, description] = m;
        if (load === "not-found") continue;
        rows.push({ name: unit, display: description || unit, state: unitState(active, sub), startType: unitStart(files.get(unit) ?? ""), account: null, pid: null });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** ps time: [DD-]HH:MM:SS or MM:SS, as seconds. */
export function psSeconds(t: string): number | null {
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t.trim());
    if (!m) return null;
    return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export function linuxProcesses(stdout: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const line of String(stdout ?? "").split("\n")) {
        const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        rows.push({ pid: Number(m[1]), user: m[2], memoryMb: Math.round((Number(m[3]) / 1024) * 10) / 10, cpuSeconds: psSeconds(m[4]), name: m[5] });
    }
    return rows.sort((a, b) => (b.memoryMb ?? 0) - (a.memoryMb ?? 0));
}

const PRIORITY_NAMES = ["Emergency", "Alert", "Critical", "Error", "Warning", "Notice", "Information", "Debug"];
/** journalctl priority 0-7 as the Windows-style level numbers (Critical 1 ... Verbose 5). */
export function priorityLevel(p: number): number {
    return p <= 2 ? 1 : p === 3 ? 2 : p === 4 ? 3 : p <= 6 ? 4 : 5;
}
/** The least severe journal priority that still includes the chosen levels. */
export function maxPriorityFor(levels: number[]): string {
    if (!levels.length) return "";
    const worst = Math.max(...levels);
    return String(worst === 1 ? 2 : worst === 2 ? 3 : worst === 3 ? 4 : worst === 4 ? 6 : 7);
}

export function linuxEvents(stdout: string, levels: number[]): { items: EventRow[]; truncated: boolean; scanned: number } {
    const items: EventRow[] = [];
    let skipped = 0;
    for (const line of String(stdout ?? "").split("\n")) {
        if (!line.startsWith("{")) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { skipped++; continue; }
        const prio = Number(j.PRIORITY);
        const p = Number.isFinite(prio) ? prio : 6;
        const level = priorityLevel(p);
        if (levels.length && !levels.includes(level)) continue;
        const us = Number(j.__REALTIME_TIMESTAMP);
        const msg = Array.isArray(j.MESSAGE) ? new TextDecoder().decode(Uint8Array.from(j.MESSAGE as number[])) : String(j.MESSAGE ?? "");
        items.push({
            time: Number.isFinite(us) ? new Date(us / 1000).toISOString() : "",
            id: null,
            level: PRIORITY_NAMES[p] ?? "Information",
            levelNumber: level,
            provider: String(j.SYSLOG_IDENTIFIER || j._SYSTEMD_UNIT || j._COMM || ""),
            message: msg.length > 700 ? `${msg.slice(0, 700)}...` : msg,
        });
    }
    return { items, truncated: skipped > 0, scanned: items.length };
}

/** CSV with every cell forced to text when a spreadsheet would run it, as the audit export does. */
export function eventsCsv(items: EventRow[]): string {
    const cell = (v: unknown) => {
        let t = v === null || v === undefined ? "" : String(v);
        if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/.test(t)) t = `'${t}`;
        return `"${t.replace(/"/g, '""')}"`;
    };
    return `${["Time", "Level", "Id", "Source", "Message"].map(cell).join(",")}\r\n${items.map((e) => [e.time, e.level, e.id, e.provider, e.message].map(cell).join(",")).join("\r\n")}\r\n`;
}
