// backend/src/device-tools/device-registry.scripts.ts
//
// The remote registry browser (read-only in phase 1, safe writing in phase 2) is, like the services / processes / event log tools, made of ordinary
// signed script jobs: no agent code. Everything that touches text going to or coming from a device is in this file so it can
// be tested without a device:
//   - checking the path, view and search text a person typed,
//   - THE BLOCKLIST (keys that are never read) and THE MASK (values whose name suggests a secret): the one place both are defined.
//     The scripts get the same lists, interpolated from here into the fixed script text (never anything a person typed),
//     and the server applies them again to what the device answered,
//   - the fixed PowerShell scripts (.NET registry classes only: WMI/CIM is slow on some PCs, see the services list),
//   - turning what a script printed into the rows the page shows.
// Phase 2 (writing) adds, in the same style: the WRITE blocklist (WRITE_BLOCKED_KEYS, next to BLOCKED_KEYS), checking of value
// names / types / data, four fixed write scripts (set value, delete value, create key, delete key: .NET registry classes only,
// never a recursive delete) and the parsing of their answers.
// User input travels only in environment variables (RIQ_REG_*). Windows only.

import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ToolOutputError } from "./device-tools.scripts";

/* ------------------------------ limits ------------------------------ */

export const MAX_SUBKEYS = 2000;
export const MAX_VALUES = 2000;
export const MAX_BINARY_BYTES = 512;
export const MAX_STRING_CHARS = 2048;
export const MAX_MULTI_STRINGS = 100;
export const SEARCH_MAX_DEPTH = 6;
export const SEARCH_MAX_RESULTS = 200;
export const SEARCH_MAX_SECONDS = 20;
export const MAX_PATH_CHARS = 1024;
export const MAX_SEGMENT_CHARS = 255;
export const MAX_SEGMENTS = 64;
export const MAX_SEARCH_TEXT = 200;
/** The agent keeps 200000 characters of a script's output; the scripts stop adding rows well before that. */
export const OUTPUT_BUDGET_CHARS = 150_000;

/* ------------------------------ roots ------------------------------ */

export type RegistryRoot = "HKLM" | "HKU";
export const ROOTS: { key: RegistryRoot; name: string }[] = [
    { key: "HKLM", name: "HKEY_LOCAL_MACHINE" },
    { key: "HKU", name: "HKEY_USERS" },
];
const ROOT_ALIASES: Record<string, RegistryRoot> = { hklm: "HKLM", hkey_local_machine: "HKLM", hku: "HKU", hkey_users: "HKU" };
const REFUSED_ROOTS: Record<string, string> = {
    hkcu: "HKEY_CURRENT_USER on the device is the hive of the account the agent runs as (SYSTEM), not of a person. Open HKU and choose that person's account instead.",
    hkey_current_user: "HKEY_CURRENT_USER on the device is the hive of the account the agent runs as (SYSTEM), not of a person. Open HKU and choose that person's account instead.",
    hkcr: "HKEY_CLASSES_ROOT is not available yet. Open HKLM\\SOFTWARE\\Classes instead.",
    hkey_classes_root: "HKEY_CLASSES_ROOT is not available yet. Open HKLM\\SOFTWARE\\Classes instead.",
    hkcc: "HKEY_CURRENT_CONFIG is not available yet.",
    hkey_current_config: "HKEY_CURRENT_CONFIG is not available yet.",
};

/* ------------------------------ the blocklist ------------------------------ */

/**
 * Keys that are never read, listed or searched, and everything below them. Patterns are matched, ignoring case, against the
 * normalised path "HKLM\sub\key" or "HKU\sub\key" (short root name, single backslashes). One list for the server and the scripts.
 *   - SAM, SECURITY: the account database and the security policy (password hashes, LSA secrets).
 *   - ...\Control\Lsa: LSA settings and secrets, in the live control set and every numbered one.
 *   - ...\Authentication\LogonUI: the sign-in screen's last user and background data.
 *   - Protected Storage System Provider: the old per-user store of saved passwords.
 * Winlogon is not blocked as a whole (it holds ordinary settings); its DefaultPassword / AltDefaultPassword values are
 * hidden by the value-name mask below, like every other value that looks like a secret.
 */
export const BLOCKED_KEYS: { pattern: string; why: string }[] = [
    { pattern: String.raw`^HKLM\\SAM(\\|$)`, why: "the account database" },
    { pattern: String.raw`^HKLM\\SECURITY(\\|$)`, why: "the security policy and LSA secrets" },
    { pattern: String.raw`^HKLM\\SYSTEM\\(CurrentControlSet|ControlSet\d{3})\\Control\\Lsa(\\|$)`, why: "the Local Security Authority" },
    { pattern: String.raw`^HKLM\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI(\\|$)`, why: "the sign-in screen data" },
    { pattern: String.raw`^HKU\\[^\\]+\\Software\\Microsoft\\Protected Storage System Provider(\\|$)`, why: "saved passwords" },
];
const BLOCKED_RES = BLOCKED_KEYS.map((b) => new RegExp(b.pattern, "i"));

export function blockedReason(path: string): string | null {
    const i = BLOCKED_RES.findIndex((r) => r.test(path));
    return i < 0 ? null : BLOCKED_KEYS[i].why;
}
export const isBlockedPath = (path: string) => blockedReason(path) !== null;

/**
 * THE WRITE BLOCKLIST. Writing is stricter than reading: everything in BLOCKED_KEYS above is refused for writing too, and so is
 * everything below. Patterns are matched, ignoring case, against the normalised path (same spelling as BLOCKED_KEYS, so the same
 * path is refused in the 64-bit and the 32-bit view: WOW6432Node is optional where it can matter). An entry with `values` only
 * refuses those VALUE NAMES (pattern is then the one exact key) and, for that key, deleting the key itself; an entry without
 * `values` refuses every change at or below the key. `why` completes the sentence "This change is blocked: <why>."
 * The scripts get this same list (interpolated into the fixed script text) and the server applies it before any job is made.
 */
export const WRITE_BLOCKED_KEYS: { pattern: string; why: string; values?: string }[] = [
    { pattern: String.raw`^(HKLM|HKU)(\\[^\\]+)?$`, why: "registry roots and top-level keys (HKLM, HKU, HKLM\\SOFTWARE, HKLM\\SYSTEM, HKU\\<account>) cannot be created, deleted or given values" },
    { pattern: String.raw`^HKLM\\SYSTEM\\Setup(\\|$)`, why: "HKLM\\SYSTEM\\Setup drives Windows setup and recovery" },
    { pattern: String.raw`^HKLM\\SYSTEM\\(CurrentControlSet|ControlSet\d{3})\\Control\\SafeBoot(\\|$)`, why: "SafeBoot decides what loads in Safe Mode" },
    { pattern: String.raw`^HKLM\\SYSTEM\\(CurrentControlSet|ControlSet\d{3})\\Control\\Session Manager(\\|$)`, why: "Session Manager runs at every start of Windows (boot-time programs, memory and driver settings)" },
    { pattern: String.raw`^HKLM\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows NT\\CurrentVersion\\Winlogon$`, values: String.raw`^(Shell|Userinit|AppSetup|Taskman)$`, why: "the Winlogon values Shell, Userinit, AppSetup and Taskman decide what runs at sign-in, and a wrong value locks everyone out" },
    { pattern: String.raw`^HKLM\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows NT\\CurrentVersion\\(Image File Execution Options|SilentProcessExit)(\\|$)`, why: "Image File Execution Options and SilentProcessExit can hijack any program (debugger redirection), a common way for malware to persist" },
    { pattern: String.raw`^HKLM\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Policies\\System$`, values: String.raw`^(EnableLUA|ConsentPromptBehaviorAdmin|LocalAccountTokenFilterPolicy)$`, why: "EnableLUA, ConsentPromptBehaviorAdmin and LocalAccountTokenFilterPolicy switch off User Account Control protections" },
    { pattern: String.raw`^HKLM\\SOFTWARE\\(WOW6432Node\\)?(Policies\\)?Microsoft\\(Windows Defender|Windows Defender Security Center|Windows Advanced Threat Protection)(\\|$)`, why: "Windows Defender protects the device and its settings are not changed here" },
    { pattern: String.raw`^HKLM\\SYSTEM\\(CurrentControlSet|ControlSet\d{3})\\Services\\(WinDefend|WdFilter|WdBoot|WdNisDrv|WdNisSvc|Sense)(\\|$)`, why: "the Windows Defender services protect the device and are not changed here" },
    // Startup entries: where malware most often makes itself start again after a restart. A technician who needs a program to start
    // uses a scheduled task or a script job, which are recorded and can be undone.
    { pattern: String.raw`^(HKLM|HKU\\[^\\]+)\\SOFTWARE\\(WOW6432Node\\)?(Microsoft\\Windows\\CurrentVersion\\(Run|RunOnce|RunServices|RunServicesOnce|RunOnceEx)|Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer\\Run|Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\(Notify|GPExtensions))(\\|$)`, why: "the Run keys start programs at every sign-in and restart, which is where malware most often hides to come back" },
    { pattern: String.raw`^HKLM\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows NT\\CurrentVersion\\Windows$`, values: String.raw`^(AppInit_DLLs|LoadAppInit_DLLs|RequireSignedAppInit_DLLs|Load|Run)$`, why: "AppInit_DLLs loads a program into every application that starts, a way for malware to run inside everything" },
    { pattern: String.raw`^HKLM\\SOFTWARE\\.*RemoteIQ`, why: "RemoteIQ's own agent settings are not changed here, so a technician cannot cripple the agent" },
    { pattern: String.raw`^HKLM\\SYSTEM\\(CurrentControlSet|ControlSet\d{3})\\Services\\RemoteIQ`, why: "the RemoteIQ agent's service is not changed here, so a technician cannot cripple the agent" },
];
const WRITE_BLOCKED_RES = WRITE_BLOCKED_KEYS.map((b) => ({ key: new RegExp(b.pattern, "i"), values: b.values ? new RegExp(b.values, "i") : null, why: b.why }));

export type WriteOp = "value" | "createkey" | "deletekey";

/** Why a change at this key (to this value name, for a value) is refused, or null when it may go ahead. */
export function writeBlockedReason(path: string, op: WriteOp, valueName = ""): string | null {
    for (const b of WRITE_BLOCKED_RES) {
        if (!b.key.test(path)) continue;
        if (!b.values) return b.why;
        if (op === "value" && b.values.test(valueName)) return b.why;
        if (op === "deletekey") return b.why;
    }
    const read = blockedReason(path);
    return read ? `it holds ${read}, which the registry browser never opens or changes` : null;
}

/** Throws a 403 with the reason when a change at this key (or to this value) is on the write blocklist. */
export function assertWritable(path: string, op: WriteOp, valueName = ""): void {
    const why = writeBlockedReason(path, op, valueName);
    if (why) throw new ForbiddenException(`This change is blocked: ${why}.`);
}

export const MASKED_WRITE_WHY = "values whose name looks like a password, secret, token, credential or key are never changed or deleted here";
/** Values whose NAME matches the mask are never written or deleted here, and their data is never recorded. */
export function assertNameNotMasked(name: string): void {
    if (isMaskedName(name)) throw new ForbiddenException(`This change is blocked: ${MASKED_WRITE_WHY}.`);
}

/* ------------------------------ the mask ------------------------------ */

/** A value whose NAME matches is shown as "(hidden)" with its type and size only. */
export const MASK_NAME_SOURCE = String.raw`pass(word|wd)?|secret|token|credential|apikey|api_key|private.?key`;
const MASK_RE = new RegExp(MASK_NAME_SOURCE, "i");
export const isMaskedName = (name: string) => MASK_RE.test(name);

/* ------------------------------ checking input ------------------------------ */

/**
 * "HKLM\SOFTWARE\Microsoft" in any of the accepted spellings, as the normalised path ("HKLM" / "HKU" for a root).
 * An empty path is the list of roots and is returned as "". Wildcards, control characters, empty or dot segments and
 * roots other than HKLM / HKU are refused.
 */
export function cleanRegistryPath(raw: unknown, { allowEmpty = true }: { allowEmpty?: boolean } = {}): string {
    const text = String(raw ?? "");
    if (text.length > MAX_PATH_CHARS) throw new BadRequestException(`The key path is too long (${MAX_PATH_CHARS} characters at most).`);
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new BadRequestException("The key path has characters that are not allowed.");
    if (/[*?]/.test(text)) throw new BadRequestException("Wildcards (* and ?) are not allowed in a key path.");
    if (text.includes("/") && !text.includes("\\") && /^(hk|hkey)/i.test(text.trim())) throw new BadRequestException("Separate the parts of the key path with backslashes.");
    const trimmed = text.trim().replace(/^\\+|\\+$/g, "");
    if (!trimmed) {
        if (!allowEmpty) throw new BadRequestException("Say which key.");
        return "";
    }
    const parts = trimmed.split("\\");
    if (parts.length > MAX_SEGMENTS) throw new BadRequestException("The key path is too deep.");
    for (const p of parts) {
        if (!p || !p.trim()) throw new BadRequestException("The key path has an empty part. Separate the parts with a single backslash.");
        if (p === "." || p === "..") throw new BadRequestException("\".\" and \"..\" are not allowed in a key path.");
        if (p.length > MAX_SEGMENT_CHARS) throw new BadRequestException(`A part of the key path is too long (${MAX_SEGMENT_CHARS} characters at most).`);
    }
    const rootName = parts[0].trim().toLowerCase();
    const root = ROOT_ALIASES[rootName];
    if (!root) {
        throw new BadRequestException(REFUSED_ROOTS[rootName] ?? "The path must start with HKLM (HKEY_LOCAL_MACHINE) or HKU (HKEY_USERS).");
    }
    return [root, ...parts.slice(1)].join("\\");
}

/** Throws a 403 with the reason when the key is on the blocklist. */
export function assertNotBlocked(path: string): void {
    const why = blockedReason(path);
    if (why) throw new ForbiddenException(`Reading this key is blocked: it holds ${why}. It is never shown by the registry browser.`);
}

export type RegistryView = "64" | "32";
export function cleanView(raw: unknown): RegistryView {
    const v = String(raw ?? "").trim();
    if (v === "" || v === "64") return "64";
    if (v === "32") return "32";
    throw new BadRequestException("The view must be 64 or 32.");
}

export type SearchIn = "keys" | "values" | "data";
export const SEARCH_INS: SearchIn[] = ["keys", "values", "data"];
export function cleanSearchIn(raw: unknown): SearchIn {
    const v = String(raw ?? "").trim().toLowerCase();
    if (!v) return "keys";
    if ((SEARCH_INS as string[]).includes(v)) return v as SearchIn;
    throw new BadRequestException("Search in keys, values or data.");
}

export function cleanRegistrySearchText(raw: unknown): string {
    const text = String(raw ?? "").trim();
    if (!text) throw new BadRequestException("Say what to look for.");
    if (text.length > MAX_SEARCH_TEXT) throw new BadRequestException(`The search text is too long (${MAX_SEARCH_TEXT} characters at most).`);
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new BadRequestException("The search text has characters that are not allowed.");
    return text;
}

/* ------------------------------ Windows scripts ------------------------------ */

// Same ASCII-only JSON approach as device-tools.scripts.ts. The fixed lists are interpolated here from the constants above.
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

const PS_REG_HEAD = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function ConvertTo-Ascii([string]$s) {
  $bs = [string][char]92
  return [regex]::Replace($s, '[^\x00-\x7F]', { param($m) $bs + 'u' + ('{0:x4}' -f [int][char]$m.Value) })
}
function Out-Riq($obj) { [Console]::Out.Write((ConvertTo-Ascii ($obj | ConvertTo-Json -Compress -Depth 6))) }
function Fail($e) { Out-Riq @{ ok = $false; error = [string]$e.Exception.Message } }
$blockRes = @(${BLOCKED_KEYS.map((b) => psq(b.pattern)).join(", ")})
$maskRe = ${psq(MASK_NAME_SOURCE)}
$BS = [char]92
function Test-Blocked([string]$p) { foreach ($re in $blockRes) { if ([regex]::IsMatch($p, $re, 'IgnoreCase')) { return $true } }; return $false }
function Test-Masked([string]$n) { return [regex]::IsMatch($n, $maskRe, 'IgnoreCase') }
function Get-View { if ($env:RIQ_REG_VIEW -eq '32') { return [Microsoft.Win32.RegistryView]::Registry32 } else { return [Microsoft.Win32.RegistryView]::Registry64 } }
function Open-Root([string]$root) {
  if ($root -eq 'HKLM') { return [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, (Get-View)) }
  if ($root -eq 'HKU') { return [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::Users, [Microsoft.Win32.RegistryView]::Registry64) }
  throw 'Only HKLM and HKU can be read.'
}
# The key at a normalised path ("HKLM\SOFTWARE\x"), or $null when it does not exist.
function Open-Path([string]$path) {
  $i = $path.IndexOf($BS)
  $root = if ($i -lt 0) { $path } else { $path.Substring(0, $i) }
  $base = Open-Root $root
  if ($i -lt 0) { return $base }
  return $base.OpenSubKey($path.Substring($i + 1), $false)
}
function Get-TypeName($kind) {
  switch ([string]$kind) { 'String' { 'REG_SZ' } 'ExpandString' { 'REG_EXPAND_SZ' } 'MultiString' { 'REG_MULTI_SZ' } 'DWord' { 'REG_DWORD' } 'QWord' { 'REG_QWORD' } 'Binary' { 'REG_BINARY' } 'None' { 'REG_NONE' } default { 'REG_UNKNOWN' } }
}
# One value as a row. The data of a value whose name looks like a secret is read for its size only and never printed.
function Get-ValueRow($key, [string]$n) {
  $kind = $key.GetValueKind($n)
  $raw = $key.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $row = @{ name = $n; type = (Get-TypeName $kind) }
  $masked = Test-Masked $n
  switch ([string]$kind) {
    { $_ -in 'String', 'ExpandString' } {
      $s = [string]$raw; $row.size = $s.Length
      if (-not $masked) { if ($s.Length -gt ${MAX_STRING_CHARS}) { $row.d = $s.Substring(0, ${MAX_STRING_CHARS}); $row.trunc = $true } else { $row.d = $s } }
    }
    'MultiString' {
      $arr = @([string[]]$raw); $tot = 0; foreach ($x in $arr) { $tot += $x.Length }; $row.size = $tot
      if (-not $masked) {
        $take = New-Object System.Collections.Generic.List[string]
        foreach ($x in $arr) { if ($take.Count -ge ${MAX_MULTI_STRINGS}) { $row.trunc = $true; break }; if ($x.Length -gt ${MAX_STRING_CHARS}) { $take.Add($x.Substring(0, ${MAX_STRING_CHARS})); $row.trunc = $true } else { $take.Add($x) } }
        $row.d = $take.ToArray()
      }
    }
    'DWord' { $row.size = 4; if (-not $masked) { $row.d = [string][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$raw), 0) } }
    'QWord' { $row.size = 8; if (-not $masked) { $row.d = [string][BitConverter]::ToUInt64([BitConverter]::GetBytes([long]$raw), 0) } }
    default {
      $b = [byte[]]$raw; $row.size = $b.Length
      if (-not $masked) {
        $k = [math]::Min($b.Length, ${MAX_BINARY_BYTES})
        $row.d = if ($k -gt 0) { [BitConverter]::ToString($b, 0, $k).Replace('-', ' ').ToLower() } else { '' }
        if ($b.Length -gt $k) { $row.trunc = $true }
      }
    }
  }
  if ($masked) { $row.masked = $true }
  return $row
}
`;

// The key's last write time has no .NET API; RegQueryInfoKey is called through a dynamic (no compiler needed, so fast) P/Invoke.
const PS_LASTWRITE = String.raw`function Get-LastWrite($key) {
  try {
    $t = $null
    foreach ($a in [AppDomain]::CurrentDomain.GetAssemblies()) { $t = $a.GetType('RiqRegNative', $false); if ($t) { break } }
    if (-not $t) {
      $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName('RiqRegDyn')), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
      $tb = $ab.DefineDynamicModule('RiqRegDyn').DefineType('RiqRegNative', 'Public,Class')
      $p = @([IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [IntPtr], [long].MakeByRefType())
      $m = $tb.DefinePInvokeMethod('RegQueryInfoKeyW', 'advapi32.dll', 'Public,Static,PinvokeImpl', [System.Reflection.CallingConventions]::Standard, [int], $p, [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Unicode)
      $m.SetImplementationFlags($m.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig)
      $t = $tb.CreateType()
    }
    $ft = [long]0; $z = [IntPtr]::Zero
    $rc = $t::RegQueryInfoKeyW($key.Handle.DangerousGetHandle(), $z, $z, $z, $z, $z, $z, $z, $z, $z, $z, [ref]$ft)
    if ($rc -eq 0 -and $ft -gt 0) { return [DateTime]::FromFileTimeUtc($ft).ToString('o') }
  } catch { }
  return $null
}
`;

const psr = (body: string) => `${PS_REG_HEAD}try {\n${body}\n} catch { Fail $_ }\n`;

export const REGISTRY_SCRIPTS = {
    // RIQ_REG_PATH (normalised, validated, never in the script text) and RIQ_REG_VIEW (64 or 32).
    key: `${PS_REG_HEAD}${PS_LASTWRITE}try {\n${String.raw`$path = $env:RIQ_REG_PATH
if (Test-Blocked $path) { throw 'That key is blocked.' }
$key = Open-Path $path
if (-not $key) { throw 'That registry key does not exist on this device.' }
$names = @($key.GetSubKeyNames())
$subs = New-Object System.Collections.Generic.List[string]
$size = 0; $subCut = $false
foreach ($sn in $names) {
  if ($subs.Count -ge ${MAX_SUBKEYS} -or $size -gt ${Math.floor(OUTPUT_BUDGET_CHARS * 0.4)}) { $subCut = $true; break }
  $cp = $path + $BS + $sn
  $hc = $false; $blocked = $false
  if (Test-Blocked $cp) { $blocked = $true }
  else { try { $c = $key.OpenSubKey($sn, $false); if ($c) { $hc = ($c.SubKeyCount -gt 0); $c.Close() } } catch { } }
  $j = ConvertTo-Ascii (@{ name = $sn; has = $hc; blocked = $blocked } | ConvertTo-Json -Compress)
  $subs.Add($j); $size += $j.Length + 1
}
$vnames = @($key.GetValueNames())
$vals = New-Object System.Collections.Generic.List[string]
$vsize = 0; $valCut = $false
foreach ($vn in $vnames) {
  if ($vals.Count -ge ${MAX_VALUES} -or $vsize -gt ${Math.floor(OUTPUT_BUDGET_CHARS * 0.5)}) { $valCut = $true; break }
  try { $row = Get-ValueRow $key $vn } catch { $row = @{ name = $vn; type = 'REG_UNKNOWN'; size = 0; unreadable = $true } }
  $j = ConvertTo-Ascii ($row | ConvertTo-Json -Compress -Depth 4)
  $vals.Add($j); $vsize += $j.Length + 1
}
$lw = Get-LastWrite $key
$lwj = if ($lw) { '"' + $lw + '"' } else { 'null' }
[Console]::Out.Write('{"ok":true,"lastWrite":' + $lwj + ',"subKeyCount":' + $names.Count + ',"subKeysTruncated":' + $subCut.ToString().ToLower() + ',"valueCount":' + $vnames.Count + ',"valuesTruncated":' + $valCut.ToString().ToLower() + ',"subKeys":[' + ($subs -join ',') + '],"values":[' + ($vals -join ',') + ']}')`}\n} catch { Fail $_ }\n`,

    // RIQ_REG_PATH, RIQ_REG_VIEW, RIQ_REG_TEXT (a plain substring), RIQ_REG_IN (keys, values or data). Bounded by depth, results and seconds.
    search: psr(String.raw`$start = $env:RIQ_REG_PATH
$text = $env:RIQ_REG_TEXT
$in = $env:RIQ_REG_IN
if (Test-Blocked $start) { throw 'That key is blocked.' }
$root = Open-Path $start
if (-not $root) { throw 'That registry key does not exist on this device.' }
$sw = [Diagnostics.Stopwatch]::StartNew()
$script:results = New-Object System.Collections.Generic.List[string]
$script:size = 0; $script:scanned = 0; $script:reason = ''
function Has([string]$s) { return ($s -ne $null -and $s.IndexOf($text, [StringComparison]::OrdinalIgnoreCase) -ge 0) }
function Add-Hit($h) {
  $j = ConvertTo-Ascii ($h | ConvertTo-Json -Compress)
  $script:results.Add($j); $script:size += $j.Length + 1
  if ($script:results.Count -ge ${SEARCH_MAX_RESULTS} -or $script:size -gt ${OUTPUT_BUDGET_CHARS}) { $script:reason = 'results' }
}
function Search-Key($key, [string]$path, [int]$depth) {
  if ($script:reason) { return }
  if ($sw.Elapsed.TotalSeconds -gt ${SEARCH_MAX_SECONDS}) { $script:reason = 'time'; return }
  $script:scanned++
  if ($in -eq 'values' -or $in -eq 'data') {
    foreach ($vn in $key.GetValueNames()) {
      if ($script:reason) { return }
      $masked = Test-Masked $vn
      if ($in -eq 'values') { if (Has $vn) { Add-Hit @{ kind = 'value'; path = $path; name = $vn } } }
      elseif (-not $masked) {
        try {
          $kind = [string]$key.GetValueKind($vn)
          if ($kind -eq 'String' -or $kind -eq 'ExpandString' -or $kind -eq 'MultiString' -or $kind -eq 'DWord' -or $kind -eq 'QWord') {
            $raw = $key.GetValue($vn, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $s = if ($kind -eq 'MultiString') { (@([string[]]$raw) -join ' | ') } elseif ($kind -eq 'DWord') { [string][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$raw), 0) } elseif ($kind -eq 'QWord') { [string][BitConverter]::ToUInt64([BitConverter]::GetBytes([long]$raw), 0) } else { [string]$raw }
            if (Has $s) { Add-Hit @{ kind = 'data'; path = $path; name = $vn; type = (Get-TypeName $kind); preview = $(if ($s.Length -gt 160) { $s.Substring(0, 160) } else { $s }) } }
          }
        } catch { }
      }
    }
  }
  if ($depth -ge ${SEARCH_MAX_DEPTH}) { return }
  foreach ($sn in $key.GetSubKeyNames()) {
    if ($script:reason) { return }
    $cp = $path + $BS + $sn
    if (Test-Blocked $cp) { continue }
    if ($in -eq 'keys' -and (Has $sn)) { Add-Hit @{ kind = 'key'; path = $cp }; if ($script:reason) { return } }
    $c = $null
    try { $c = $key.OpenSubKey($sn, $false) } catch { }
    if ($c) { try { Search-Key $c $cp ($depth + 1) } finally { $c.Close() } }
  }
}
Search-Key $root $start 0
[Console]::Out.Write('{"ok":true,"truncated":' + ([bool]$script:reason).ToString().ToLower() + ',"reason":"' + $script:reason + '","scanned":' + $script:scanned + ',"seconds":' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + ',"results":[' + ($script:results -join ',') + ']}')`),

    // The accounts that have a loaded hive: HKU's SID keys, named from the profile list (a local read: no directory lookup that could hang).
    roots: psr(String.raw`$u = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::Users, [Microsoft.Win32.RegistryView]::Registry64)
$pl = $null
try { $pl = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64).OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList', $false) } catch { }
$known = @{ 'S-1-5-18' = 'SYSTEM'; 'S-1-5-19' = 'LOCAL SERVICE'; 'S-1-5-20' = 'NETWORK SERVICE'; '.DEFAULT' = 'Default profile (.DEFAULT)' }
$rows = @(foreach ($sid in $u.GetSubKeyNames()) {
  if ($sid -notmatch '^(S-1-\d+(-\d+)+|\.DEFAULT)$') { continue }
  $name = $known[$sid]
  if (-not $name -and $pl) {
    try { $pk = $pl.OpenSubKey($sid, $false); if ($pk) { $img = [string]$pk.GetValue('ProfileImagePath', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if ($img) { $name = $img.Substring($img.LastIndexOf($BS) + 1) }; $pk.Close() } } catch { }
  }
  @{ sid = $sid; account = $(if ($name) { [string]$name } else { $null }) }
})
Out-Riq @{ ok = $true; users = $rows }`),
};

/* ------------------------------ reading what a device printed ------------------------------ */

export type RegistryType = "REG_SZ" | "REG_EXPAND_SZ" | "REG_MULTI_SZ" | "REG_DWORD" | "REG_QWORD" | "REG_BINARY" | "REG_NONE" | "REG_UNKNOWN";
const TYPES: RegistryType[] = ["REG_SZ", "REG_EXPAND_SZ", "REG_MULTI_SZ", "REG_DWORD", "REG_QWORD", "REG_BINARY", "REG_NONE", "REG_UNKNOWN"];

export type RegistryValueRow = {
    name: string;
    /** The name as shown: the default value has an empty name. */
    display: string;
    type: RegistryType;
    size: number;
    /** string (text, or hex bytes for binary), number / digits (dword, qword), list (multi string); null when hidden. */
    data: string | number | string[] | null;
    /** Numbers also as hex. */
    hex?: string;
    truncated?: boolean;
    masked?: boolean;
    unreadable?: boolean;
};
export type RegistrySubKeyRow = { name: string; hasChildren: boolean; blocked: boolean };
export type RegistryKeyResult = {
    path: string;
    lastWrite: string | null;
    subKeys: RegistrySubKeyRow[];
    subKeyCount: number;
    subKeysTruncated: boolean;
    values: RegistryValueRow[];
    valueCount: number;
    valuesTruncated: boolean;
};
export type RegistryHit = { kind: "key" | "value" | "data"; path: string; name?: string; type?: RegistryType; preview?: string };
export type RegistrySearchResult = { results: RegistryHit[]; truncated: boolean; reason: "results" | "time" | null; scanned: number; seconds: number };
export type RegistryRootsResult = { roots: { key: RegistryRoot; name: string }[]; users: { sid: string; account: string | null; path: string }[] };

const num = (v: unknown, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

const hex = (digits: string, width: number) => {
    if (!/^\d+$/.test(digits)) return undefined;
    return `0x${BigInt(digits).toString(16).toUpperCase().padStart(width, "0")}`;
};

/** One value row as the page gets it. The mask is applied here again, whatever the device sent. */
export function normaliseValue(r: any): RegistryValueRow {
    const name = str(r?.name);
    const type: RegistryType = TYPES.includes(r?.type) ? r.type : "REG_UNKNOWN";
    const base = { name, display: name === "" ? "(Default)" : name, type, size: Math.max(0, num(r?.size)) };
    if (r?.unreadable) return { ...base, data: null, unreadable: true };
    if (isMaskedName(name) || r?.masked) return { ...base, data: null, masked: true };
    const truncated = r?.trunc ? true : undefined;
    const d = r?.d;
    switch (type) {
        case "REG_DWORD": {
            const digits = str(d);
            const n = /^\d{1,10}$/.test(digits) ? Number(digits) : NaN;
            return Number.isFinite(n) ? { ...base, data: n, hex: hex(digits, 8) } : { ...base, data: null, unreadable: true };
        }
        case "REG_QWORD": {
            const digits = str(d);
            if (!/^\d{1,20}$/.test(digits)) return { ...base, data: null, unreadable: true };
            const n = Number(digits);
            return { ...base, data: Number.isSafeInteger(n) ? n : digits, hex: hex(digits, 16) };
        }
        case "REG_MULTI_SZ":
            return { ...base, data: (Array.isArray(d) ? d : d === undefined || d === null ? [] : [d]).slice(0, MAX_MULTI_STRINGS).map((x: unknown) => str(x).slice(0, MAX_STRING_CHARS)), ...(truncated ? { truncated } : {}) };
        case "REG_SZ":
        case "REG_EXPAND_SZ":
            return { ...base, data: str(d).slice(0, MAX_STRING_CHARS), ...(truncated ? { truncated } : {}) };
        default: {
            const h = str(d).toLowerCase().replace(/[^0-9a-f ]/g, "").slice(0, MAX_BINARY_BYTES * 3);
            return { ...base, data: h, ...(truncated || base.size > MAX_BINARY_BYTES ? { truncated: true } : {}) };
        }
    }
}

const child = (path: string, name: string) => `${path}\\${name}`;

export function parseRegistryKey(parsed: any, path: string): RegistryKeyResult {
    const subKeys = (Array.isArray(parsed?.subKeys) ? parsed.subKeys : []).slice(0, MAX_SUBKEYS).map((r: any): RegistrySubKeyRow => {
        const name = str(r?.name);
        const blocked = !!r?.blocked || isBlockedPath(child(path, name));
        return { name, hasChildren: !blocked && !!r?.has, blocked };
    });
    const values = (Array.isArray(parsed?.values) ? parsed.values : []).slice(0, MAX_VALUES).map(normaliseValue);
    const lw = str(parsed?.lastWrite);
    return {
        path,
        lastWrite: lw && !Number.isNaN(Date.parse(lw)) ? lw : null,
        subKeys,
        subKeyCount: Math.max(subKeys.length, num(parsed?.subKeyCount)),
        subKeysTruncated: !!parsed?.subKeysTruncated,
        values,
        valueCount: Math.max(values.length, num(parsed?.valueCount)),
        valuesTruncated: !!parsed?.valuesTruncated,
    };
}

export function parseRegistrySearch(parsed: any): RegistrySearchResult {
    const results: RegistryHit[] = [];
    for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
        const kind = r?.kind === "key" || r?.kind === "value" || r?.kind === "data" ? r.kind : null;
        const path = str(r?.path);
        if (!kind || !path || isBlockedPath(path)) continue;
        const name = r?.name === undefined ? undefined : str(r.name);
        // A value with a secret-looking name is never reported by its data (the script skips them; this is the second check).
        if (kind === "data" && name !== undefined && isMaskedName(name)) continue;
        results.push({
            kind,
            path,
            ...(name !== undefined ? { name } : {}),
            ...(kind === "data" ? { type: TYPES.includes(r?.type) ? r.type : "REG_UNKNOWN", preview: str(r?.preview).slice(0, 160) } : {}),
        });
    }
    const reason = parsed?.reason === "time" ? "time" : parsed?.reason === "results" ? "results" : null;
    return { results: results.slice(0, SEARCH_MAX_RESULTS), truncated: !!parsed?.truncated || reason !== null, reason, scanned: num(parsed?.scanned), seconds: num(parsed?.seconds) };
}

export function parseRegistryRoots(parsed: any): RegistryRootsResult {
    const users = (Array.isArray(parsed?.users) ? parsed.users : [])
        .map((u: any) => ({ sid: str(u?.sid), account: u?.account ? str(u.account) : null }))
        .filter((u: { sid: string }) => /^(S-1-\d+(-\d+)+|\.DEFAULT)$/.test(u.sid))
        .map((u: { sid: string; account: string | null }) => ({ ...u, path: `HKU\\${u.sid}` }));
    return { roots: ROOTS, users };
}

/* ------------------------------ writing: checking input ------------------------------ */

export const WRITE_MAX_STRING_CHARS = 8192;
export const WRITE_MAX_MULTI_ITEMS = 100;
/** All the items of a REG_MULTI_SZ together (an environment variable of the job holds them, and Windows caps one at 32767 characters). */
export const WRITE_MAX_MULTI_CHARS = 8192;
export const WRITE_MAX_BINARY_BYTES = 4096;
export const MAX_VALUE_NAME_CHARS = 16383;
/** A key is deleted only when everything in it can be recorded (and put back by Undo): at most this many values and this much data. */
export const KEY_DELETE_MAX_VALUES = 100;
export const KEY_DELETE_MAX_WEIGHT = 8000;

export type WriteType = "REG_SZ" | "REG_EXPAND_SZ" | "REG_MULTI_SZ" | "REG_DWORD" | "REG_QWORD" | "REG_BINARY";
export const WRITE_TYPES: WriteType[] = ["REG_SZ", "REG_EXPAND_SZ", "REG_MULTI_SZ", "REG_DWORD", "REG_QWORD", "REG_BINARY"];

export function cleanWriteType(raw: unknown): WriteType {
    const v = String(raw ?? "").trim().toUpperCase();
    if ((WRITE_TYPES as string[]).includes(v)) return v as WriteType;
    throw new BadRequestException(`The type must be one of ${WRITE_TYPES.join(", ")}.`);
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const hasLoneSurrogate = (s: string) => LONE_SURROGATE.test(s);

/** A value name: empty is the (Default) value. Up to 16383 characters, no control characters. */
export function cleanValueName(raw: unknown): string {
    if (raw !== undefined && raw !== null && typeof raw !== "string") throw new BadRequestException("The value name must be text.");
    const name = (raw as string | undefined | null) ?? "";
    if (name.length > MAX_VALUE_NAME_CHARS) throw new BadRequestException(`The value name is too long (${MAX_VALUE_NAME_CHARS} characters at most).`);
    if (/[\u0000-\u001f\u007f]/.test(name) || hasLoneSurrogate(name)) throw new BadRequestException("The value name has characters that are not allowed.");
    return name;
}

function cleanText(raw: unknown, what: string, max = WRITE_MAX_STRING_CHARS): string {
    if (typeof raw !== "string") throw new BadRequestException(`${what} must be text.`);
    if (raw.length > max) throw new BadRequestException(`${what} is too long (${max} characters at most).`);
    if (raw.includes("\u0000")) throw new BadRequestException(`${what} cannot contain a NUL character.`);
    if (hasLoneSurrogate(raw)) throw new BadRequestException(`${what} has characters that cannot be stored.`);
    return raw;
}

/** Decimal digits or 0x hex (or a whole JavaScript number), within 0..max; returned as decimal digits. */
export function cleanUnsigned(raw: unknown, max: bigint, what: string): string {
    let n: bigint;
    if (typeof raw === "number") {
        if (!Number.isSafeInteger(raw) || raw < 0) throw new BadRequestException(`${what} must be a whole number from 0 to ${max}.`);
        n = BigInt(raw);
    } else if (typeof raw === "string") {
        const t = raw.trim();
        if (/^\d{1,20}$/.test(t)) n = BigInt(t);
        else if (/^0x[0-9a-f]{1,16}$/i.test(t)) n = BigInt(t);
        else throw new BadRequestException(`${what} must be a whole number (decimal, or hex starting with 0x) from 0 to ${max}.`);
    } else throw new BadRequestException(`${what} must be a number.`);
    if (n < 0n || n > max) throw new BadRequestException(`${what} must be from 0 to ${max}.`);
    return n.toString();
}
const DWORD_MAX = 0xffffffffn;
const QWORD_MAX = 0xffffffffffffffffn;

/** Bytes as hex: pairs of hex digits separated by single spaces, or one run of pairs. Returned as lower case pairs separated by spaces. */
export function cleanHexBytes(raw: unknown): string {
    if (typeof raw !== "string") throw new BadRequestException("Binary data must be hex bytes (for example 0a 1b 2c).");
    const t = raw.trim();
    if (t === "") return "";
    let pairs: string[];
    if (/^[0-9a-f]{2}( [0-9a-f]{2})*$/i.test(t)) pairs = t.split(" ");
    else if (/^([0-9a-f]{2})+$/i.test(t)) pairs = t.match(/../g) as string[];
    else throw new BadRequestException("Binary data must be hex bytes: pairs of the digits 0-9 and a-f (for example 0a 1b 2c), with nothing else and no odd digit.");
    if (pairs.length > WRITE_MAX_BINARY_BYTES) throw new BadRequestException(`Binary data is too long (${WRITE_MAX_BINARY_BYTES} bytes at most).`);
    return pairs.join(" ").toLowerCase();
}

/** The data for a type, checked and normalised: text, a list of text, decimal digits (numbers) or lower case hex pairs (binary). */
export type NewData = string | string[];
export function cleanValueData(type: WriteType, raw: unknown): NewData {
    switch (type) {
        case "REG_SZ":
        case "REG_EXPAND_SZ":
            return cleanText(raw, "The data");
        case "REG_MULTI_SZ": {
            if (!Array.isArray(raw)) throw new BadRequestException("The data of a list must be a list of lines.");
            if (raw.length > WRITE_MAX_MULTI_ITEMS) throw new BadRequestException(`A list can have ${WRITE_MAX_MULTI_ITEMS} lines at most.`);
            let total = 0;
            const items = raw.map((x, i) => {
                const t = cleanText(x, `Line ${i + 1}`);
                if (t === "") throw new BadRequestException(`Line ${i + 1} is empty: a list cannot have empty lines.`);
                total += t.length;
                return t;
            });
            if (total > WRITE_MAX_MULTI_CHARS) throw new BadRequestException(`The lines of a list can hold ${WRITE_MAX_MULTI_CHARS} characters in all.`);
            return items;
        }
        case "REG_DWORD":
            return cleanUnsigned(raw, DWORD_MAX, "A DWORD");
        case "REG_QWORD":
            return cleanUnsigned(raw, QWORD_MAX, "A QWORD");
        case "REG_BINARY":
            return cleanHexBytes(raw);
    }
}

/** What the person saw before changing: the check that nothing changed since. `size` and `data` are optional parts of it. */
export type Expected = { exists: false } | { exists: true; type: RegistryType; size?: number; data?: NewData };
export function cleanExpected(raw: unknown): Expected | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("The expected old value is not valid.");
    const r = raw as Record<string, unknown>;
    if (typeof r.exists !== "boolean") throw new BadRequestException("The expected old value must say whether the value exists.");
    if (!r.exists) return { exists: false };
    const type = String(r.type ?? "").toUpperCase() as RegistryType;
    if (!TYPES.includes(type)) throw new BadRequestException("The expected old value has an unknown type.");
    const out: { exists: true; type: RegistryType; size?: number; data?: NewData } = { exists: true, type };
    if (r.size !== undefined && r.size !== null) {
        const n = Number(r.size);
        if (!Number.isSafeInteger(n) || n < 0) throw new BadRequestException("The expected old size is not valid.");
        out.size = n;
    }
    if (r.data !== undefined && r.data !== null) {
        if (!(WRITE_TYPES as string[]).includes(type)) throw new BadRequestException("The expected old value has data of a type that cannot be compared.");
        out.data = cleanValueData(type as WriteType, r.data);
    }
    return out;
}

const sArg = (s: string) => `s:${s}`;
/** The data as the job's environment variable carries it: JSON where every text is prefixed "s:" (so no parser can turn text into a date or number). */
export function dataArg(type: WriteType, data: NewData): string {
    return JSON.stringify({ v: type === "REG_MULTI_SZ" ? (data as string[]).map(sArg) : sArg(data as string) });
}
export function expectArg(e: Expected | null): string {
    if (!e) return "";
    if (!e.exists) return JSON.stringify({ exists: false });
    return JSON.stringify({
        exists: true, type: e.type, ...(e.size !== undefined ? { size: e.size } : {}),
        hasData: e.data !== undefined, ...(e.data !== undefined ? { v: Array.isArray(e.data) ? e.data.map(sArg) : sArg(e.data) } : {}),
    });
}
export type RestoreValue = { name: string; type: WriteType; data: NewData };
export function valuesArg(values: RestoreValue[]): string {
    return JSON.stringify({ items: values.map((v) => ({ n: sArg(v.name), t: v.type, v: v.type === "REG_MULTI_SZ" ? (v.data as string[]).map(sArg) : sArg(v.data as string) })) });
}

/** The key's parent path and last name ("HKLM\\SOFTWARE\\a\\b" gives "HKLM\\SOFTWARE\\a" and "b"). */
export function splitKeyPath(path: string): { parent: string; leaf: string } {
    const i = path.lastIndexOf("\\");
    return { parent: i < 0 ? "" : path.slice(0, i), leaf: path.slice(i + 1) };
}
export const hiveOf = (path: string): RegistryRoot => (path.split("\\")[0] === "HKU" ? "HKU" : "HKLM");

/* ------------------------------ writing: Windows scripts ------------------------------ */

const PS_WRITE_HEAD = String.raw`$writeBlock = @(${WRITE_BLOCKED_KEYS.map((b) => `@(${psq(b.pattern)}, ${psq(b.values ?? "")}, ${psq(b.why)})`).join(", ")})
function Test-WriteBlocked([string]$p, [string]$op, [string]$n) {
  foreach ($b in $writeBlock) {
    if (-not [regex]::IsMatch($p, [string]$b[0], 'IgnoreCase')) { continue }
    if (-not $b[1]) { return [string]$b[2] }
    if ($op -eq 'value' -and [regex]::IsMatch($n, [string]$b[1], 'IgnoreCase')) { return [string]$b[2] }
    if ($op -eq 'deletekey') { return [string]$b[2] }
  }
  foreach ($re in $blockRes) { if ([regex]::IsMatch($p, $re, 'IgnoreCase')) { return 'it holds a protected security secret, which the registry browser never opens or changes' } }
  return $null
}
# A refusal is an answer, not an error: the change was not made, and nothing was changed.
function Refuse([string]$reason, [string]$msg, $old) {
  $o = @{ ok = $true; status = 'refused'; reason = $reason; message = $msg }
  if ($old) { $o.old = $old }
  Out-Riq $o
  exit 0
}
function Refuse-Blocked([string]$p, [string]$op, [string]$n) {
  $why = Test-WriteBlocked $p $op $n
  if ($why) { Refuse 'blocked' ('This change is blocked: ' + $why + '.') $null }
}
function Un-S($x) {
  $s = [string]$x
  if (-not $s.StartsWith('s:', [StringComparison]::Ordinal)) { throw 'The request data is malformed.' }
  return $s.Substring(2)
}
function Open-Writable([string]$path) {
  $i = $path.IndexOf($BS)
  if ($i -lt 0) { throw 'A registry root cannot be changed.' }
  $base = Open-Root $path.Substring(0, $i)
  return $base.OpenSubKey($path.Substring($i + 1), $true)
}
function Find-ValueName($key, [string]$n) {
  foreach ($x in $key.GetValueNames()) { if ([string]::Equals($x, $n, [StringComparison]::OrdinalIgnoreCase)) { return [string]$x } }
  return $null
}
# The whole value (up to the sizes that can be recorded and put back by Undo): tooBig / unsupported when it is not recordable.
function Read-Full($key, [string]$n) {
  $real = Find-ValueName $key $n
  if ($null -eq $real) { return @{ exists = $false } }
  $kind = $key.GetValueKind($real)
  $raw = $key.GetValue($real, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $row = @{ exists = $true; name = [string]$real; type = (Get-TypeName $kind) }
  switch ([string]$kind) {
    { $_ -in 'String', 'ExpandString' } {
      $s = [string]$raw; $row.size = $s.Length
      if ($s.Length -gt ${WRITE_MAX_STRING_CHARS}) { $row.tooBig = $true } else { $row.d = $s }
    }
    'MultiString' {
      $arr = @([string[]]$raw); $tot = 0; $big = ($arr.Count -gt ${WRITE_MAX_MULTI_ITEMS})
      foreach ($x in $arr) { $tot += $x.Length }
      if ($tot -gt ${WRITE_MAX_MULTI_CHARS}) { $big = $true }
      $row.size = $tot
      if ($big) { $row.tooBig = $true } else { $row.d = $arr }
    }
    'DWord' { $row.size = 4; $row.d = [string][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$raw), 0) }
    'QWord' { $row.size = 8; $row.d = [string][BitConverter]::ToUInt64([BitConverter]::GetBytes([long]$raw), 0) }
    'Binary' {
      $b = [byte[]]$raw; $row.size = $b.Length
      if ($b.Length -gt ${WRITE_MAX_BINARY_BYTES}) { $row.tooBig = $true } else { $row.d = $(if ($b.Length -gt 0) { [BitConverter]::ToString($b).Replace('-', ' ').ToLower() } else { '' }) }
    }
    default { $row.size = 0; $row.unsupported = $true }
  }
  return $row
}
# Optimistic concurrency: the value as the person saw it (type, size and data when given) against the value now.
function Test-Expect($old, $exp) {
  if ($null -eq $exp) { return $true }
  if (-not [bool]$exp.exists) { return (-not $old.exists) }
  if (-not $old.exists) { return $false }
  if ([string]$exp.type -cne [string]$old.type) { return $false }
  if ($null -ne $exp.size -and [long]$exp.size -ne [long]$old.size) { return $false }
  if ([bool]$exp.hasData) {
    if ($old.tooBig -or $old.unsupported) { return $false }
    if ([string]$old.type -eq 'REG_MULTI_SZ') {
      $a = @(@($exp.v) | ForEach-Object { Un-S $_ }); $b = @($old.d)
      if ($a.Count -ne $b.Count) { return $false }
      for ($i = 0; $i -lt $a.Count; $i++) { if ([string]$a[$i] -cne [string]$b[$i]) { return $false } }
      return $true
    }
    if ([string]$old.type -eq 'REG_BINARY') { return ((Un-S $exp.v).ToLower() -ceq [string]$old.d) }
    return ((Un-S $exp.v) -ceq [string]$old.d)
  }
  return $true
}
# Turns the checked request data into what SetValue takes (the server has checked it already; this is the second check).
function Convert-Data([string]$type, $v) {
  $K = [Microsoft.Win32.RegistryValueKind]
  switch ($type) {
    'REG_SZ' { $s = Un-S $v; if ($s.Length -gt ${WRITE_MAX_STRING_CHARS}) { throw 'The data is too long.' }; return @{ kind = $K::String; val = $s } }
    'REG_EXPAND_SZ' { $s = Un-S $v; if ($s.Length -gt ${WRITE_MAX_STRING_CHARS}) { throw 'The data is too long.' }; return @{ kind = $K::ExpandString; val = $s } }
    'REG_MULTI_SZ' {
      $l = New-Object 'System.Collections.Generic.List[string]'; $tot = 0
      if ($null -ne $v) { foreach ($x in @($v)) { $t = Un-S $x; if ($t.Length -eq 0) { throw 'A list cannot have empty lines.' }; $tot += $t.Length; $l.Add($t) } }
      if ($l.Count -gt ${WRITE_MAX_MULTI_ITEMS} -or $tot -gt ${WRITE_MAX_MULTI_CHARS}) { throw 'The list is too long.' }
      return @{ kind = $K::MultiString; val = $l.ToArray() }
    }
    'REG_DWORD' { $u = [uint32]::Parse((Un-S $v), [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture); return @{ kind = $K::DWord; val = [BitConverter]::ToInt32([BitConverter]::GetBytes($u), 0) } }
    'REG_QWORD' { $u = [uint64]::Parse((Un-S $v), [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture); return @{ kind = $K::QWord; val = [BitConverter]::ToInt64([BitConverter]::GetBytes($u), 0) } }
    'REG_BINARY' {
      $h = (Un-S $v).Replace(' ', '')
      if ($h -notmatch '^([0-9a-fA-F]{2})*$' -or $h.Length -gt ${WRITE_MAX_BINARY_BYTES * 2}) { throw 'The binary data is not valid hex.' }
      $b = New-Object byte[] ($h.Length / 2)
      for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = [Convert]::ToByte($h.Substring(2 * $i, 2), 16) }
      return @{ kind = $K::Binary; val = $b }
    }
    default { throw 'That type cannot be written.' }
  }
}
function Split-Key([string]$path) {
  $i = $path.LastIndexOf($BS)
  return @{ parent = $path.Substring(0, $i); leaf = $path.Substring($i + 1) }
}
function Test-NameOk([string]$name) {
  if (Test-Masked $name) { Refuse 'masked' ${psq(`This change is blocked: ${MASKED_WRITE_WHY}.`)} $null }
  if ($name.Length -gt ${MAX_VALUE_NAME_CHARS}) { throw 'The value name is too long.' }
}
`;

const psw = (body: string) => `${PS_REG_HEAD}${PS_WRITE_HEAD}try {\n${body}\n} catch { Fail $_ }\n`;

const CHANGED_MSG = "The value was changed on the device since you looked at it, so nothing was changed. Refresh the key and look again.";

/**
 * The four write scripts. Environment: RIQ_REG_PATH (normalised key path; for the key scripts the key itself), RIQ_REG_VIEW,
 * RIQ_REG_NAME (value name), RIQ_REG_TYPE, RIQ_REG_DATA ({"v":...} see dataArg), RIQ_REG_EXPECT (see expectArg), RIQ_REG_VALUES
 * (createKey, to put back the values of a deleted key). They print one JSON answer: { ok, status: done | refused, ... } with the old
 * and new state read back from the registry. There is no recursive delete anywhere in them: DeleteSubKey fails on a key with sub keys.
 */
export const REGISTRY_WRITE_SCRIPTS = {
    set: psw(String.raw`$path = $env:RIQ_REG_PATH
$name = [string]$env:RIQ_REG_NAME
$type = [string]$env:RIQ_REG_TYPE
Refuse-Blocked $path 'value' $name
Test-NameOk $name
$data = Convert-Data $type (($env:RIQ_REG_DATA | ConvertFrom-Json).v)
$exp = $null
if ($env:RIQ_REG_EXPECT) { $exp = $env:RIQ_REG_EXPECT | ConvertFrom-Json }
$key = Open-Writable $path
if (-not $key) { throw 'That registry key does not exist on this device.' }
$old = Read-Full $key $name
if ($old.exists -and ($old.tooBig -or $old.unsupported)) { Refuse 'unrecordable' 'The value that is there now is too large (or of a type) that cannot be recorded, so it could not be undone. It was not changed.' $null }
if (-not (Test-Expect $old $exp)) { Refuse 'changed' ${psq(CHANGED_MSG)} $old }
$key.SetValue($name, $data.val, $data.kind)
$new = Read-Full $key $name
$key.Close()
Out-Riq @{ ok = $true; status = 'done'; old = $old; new = $new }`),

    deleteValue: psw(String.raw`$path = $env:RIQ_REG_PATH
$name = [string]$env:RIQ_REG_NAME
Refuse-Blocked $path 'value' $name
Test-NameOk $name
$exp = $null
if ($env:RIQ_REG_EXPECT) { $exp = $env:RIQ_REG_EXPECT | ConvertFrom-Json }
$key = Open-Writable $path
if (-not $key) { throw 'That registry key does not exist on this device.' }
$old = Read-Full $key $name
if (-not $old.exists) { Refuse 'missing' 'That value does not exist (any more), so there is nothing to delete.' $old }
if ($old.tooBig -or $old.unsupported) { Refuse 'unrecordable' 'This value is too large (or of a type) that cannot be recorded, so deleting it could not be undone. It was not deleted.' $null }
if (-not (Test-Expect $old $exp)) { Refuse 'changed' ${psq(CHANGED_MSG)} $old }
$key.DeleteValue($old.name, $true)
$key.Close()
Out-Riq @{ ok = $true; status = 'done'; old = $old; new = @{ exists = $false } }`),

    createKey: psw(String.raw`$path = $env:RIQ_REG_PATH
Refuse-Blocked $path 'createkey' ''
$sp = Split-Key $path
$parent = Open-Writable $sp.parent
if (-not $parent) { Refuse 'missing' 'The key above it does not exist, so the key cannot be created.' $null }
$vals = @()
if ($env:RIQ_REG_VALUES) { $vals = @(@(($env:RIQ_REG_VALUES | ConvertFrom-Json).items)) }
$todo = New-Object System.Collections.Generic.List[object]
foreach ($it in $vals) {
  $n = Un-S $it.n
  Refuse-Blocked $path 'value' $n
  Test-NameOk $n
  $todo.Add(@{ name = $n; d = (Convert-Data ([string]$it.t) $it.v) })
}
$existing = $parent.OpenSubKey($sp.leaf, $false)
if ($existing) { $existing.Close(); Refuse 'exists' 'That key already exists, so nothing was created.' $null }
$k = $parent.CreateSubKey($sp.leaf)
$made = 0
try {
  foreach ($t in $todo) { $k.SetValue($t.name, $t.d.val, $t.d.kind); $made++ }
} catch {
  $why = $_.Exception.Message
  foreach ($t in $todo) { try { $k.DeleteValue($t.name, $false) } catch { } }
  $k.Close()
  try { $parent.DeleteSubKey($sp.leaf, $false) } catch { }
  throw ('The key could not be filled, so it was removed again: ' + $why)
}
$k.Close(); $parent.Close()
Out-Riq @{ ok = $true; status = 'done'; created = $true; valueCount = $made }`),

    deleteKey: psw(String.raw`$path = $env:RIQ_REG_PATH
Refuse-Blocked $path 'deletekey' ''
$sp = Split-Key $path
$parent = Open-Writable $sp.parent
if (-not $parent) { Refuse 'missing' 'That key does not exist on this device.' $null }
$k = $parent.OpenSubKey($sp.leaf, $false)
if (-not $k) { Refuse 'missing' 'That key does not exist (any more), so there is nothing to delete.' $null }
$subs = $k.SubKeyCount
if ($subs -gt 0) { Refuse 'hassubkeys' ('This key has ' + $subs + ' sub key' + $(if ($subs -eq 1) { '' } else { 's' }) + '. Only a key without sub keys can be deleted: delete the sub keys first, one at a time.') $null }
$names = @($k.GetValueNames())
if ($names.Count -gt ${KEY_DELETE_MAX_VALUES}) { Refuse 'toolarge' ('This key holds ' + $names.Count + ' values, more than the ${KEY_DELETE_MAX_VALUES} that can be recorded so that the deletion can be undone. It was not deleted.') $null }
$rows = New-Object System.Collections.Generic.List[object]
$weight = 0
foreach ($vn in $names) {
  if (Test-Masked $vn) { Refuse 'masked' 'This change is blocked: this key holds a value whose name looks like a password, secret, token, credential or key, and those are never deleted here, not even with their key.' $null }
  $r = Read-Full $k $vn
  if ($r.tooBig -or $r.unsupported) { Refuse 'unrecordable' ('The value ' + $(if ($vn -eq '') { '(Default)' } else { $vn }) + ' is too large (or of a type) that cannot be recorded, so deleting the key could not be undone. It was not deleted.') $null }
  $weight += $vn.Length + 40
  if ($r.type -eq 'REG_BINARY') { $weight += 3 * $r.size } else { $weight += $r.size }
  $rows.Add($r)
}
if ($weight -gt ${KEY_DELETE_MAX_WEIGHT}) { Refuse 'toolarge' 'This key holds more data than can be recorded so that the deletion can be undone. Delete its values one at a time first. It was not deleted.' $null }
if ($env:RIQ_REG_EXPECT) {
  $exp = $env:RIQ_REG_EXPECT | ConvertFrom-Json
  if ($null -ne $exp.values -and [int]$exp.values -ne $names.Count) { Refuse 'changed' 'The key was changed on the device since you looked at it (its values are not the same any more), so nothing was deleted. Refresh and look again.' $null }
}
$k.Close()
$parent.DeleteSubKey($sp.leaf, $true)
$parent.Close()
Out-Riq @{ ok = $true; status = 'done'; values = @($rows.ToArray()) }`),
};

/* ------------------------------ writing: reading what a device printed ------------------------------ */

/** A value as a change record keeps it: the reader's rendering (text, list of text, decimal digits, lower case hex), whole. */
export type RecordedValue = { exists: false } | { exists: true; type: RegistryType; size: number; data: NewData | null; masked?: boolean };
export type RecordedKeyValue = { name: string; type: RegistryType; size: number; data: NewData | null; masked?: boolean };
export type WriteAnswer = {
    status: "done" | "refused";
    reason?: string;
    message?: string;
    old?: RecordedValue;
    new?: RecordedValue;
    /** delete key: the values the key held. */
    values?: RecordedKeyValue[];
    /** create key: how many values were put back. */
    valueCount?: number;
};

/** One value of a script's answer, with the mask applied again whatever the device sent. */
export function normaliseRecorded(name: string, r: any): RecordedValue {
    if (!r || r.exists === false) return { exists: false };
    const type: RegistryType = TYPES.includes(r.type) ? r.type : "REG_UNKNOWN";
    const size = Math.max(0, num(r.size));
    if (isMaskedName(name)) return { exists: true, type, size, data: null, masked: true };
    const d = r.d;
    switch (type) {
        case "REG_DWORD": return { exists: true, type, size, data: /^\d{1,10}$/.test(str(d)) ? str(d) : null };
        case "REG_QWORD": return { exists: true, type, size, data: /^\d{1,20}$/.test(str(d)) ? str(d) : null };
        case "REG_MULTI_SZ": return { exists: true, type, size, data: Array.isArray(d) ? d.slice(0, WRITE_MAX_MULTI_ITEMS).map((x: unknown) => str(x).slice(0, WRITE_MAX_STRING_CHARS)) : d === undefined || d === null ? null : [str(d)] };
        case "REG_SZ":
        case "REG_EXPAND_SZ": return { exists: true, type, size, data: d === undefined || d === null ? null : str(d).slice(0, WRITE_MAX_STRING_CHARS) };
        case "REG_BINARY": return { exists: true, type, size, data: d === undefined || d === null ? null : str(d).toLowerCase().replace(/[^0-9a-f ]/g, "").slice(0, WRITE_MAX_BINARY_BYTES * 3) };
        default: return { exists: true, type, size, data: null };
    }
}

export function parseRegistryWrite(p: any): WriteAnswer {
    const nameOf = (r: any) => str(r?.name);
    if (p?.status === "refused") {
        return { status: "refused", reason: str(p.reason).slice(0, 40), message: str(p.message).slice(0, 500), ...(p.old ? { old: normaliseRecorded(nameOf(p.old), p.old) } : {}) };
    }
    if (p?.status !== "done") throw new ToolOutputError("The device's answer could not be understood.");
    const out: WriteAnswer = { status: "done" };
    if (p.old !== undefined) out.old = normaliseRecorded(nameOf(p.old), p.old);
    if (p.new !== undefined) out.new = normaliseRecorded(nameOf(p.new), p.new);
    if (Array.isArray(p.values)) {
        out.values = p.values.slice(0, KEY_DELETE_MAX_VALUES).map((r: any): RecordedKeyValue => {
            const name = nameOf(r);
            const v = normaliseRecorded(name, r);
            return v.exists ? { name, type: v.type, size: v.size, data: v.data, ...(v.masked ? { masked: true } : {}) } : { name, type: "REG_UNKNOWN", size: 0, data: null };
        });
    }
    if (p.valueCount !== undefined) out.valueCount = Math.max(0, num(p.valueCount));
    return out;
}

/** A recorded value the way the page shows data (numbers as numbers, hex next to them), with the mask applied again. */
export function recordedForDisplay(name: string, v: RecordedValue | null | undefined) {
    if (!v) return null;
    if (!v.exists) return { exists: false as const };
    if (isMaskedName(name) || v.masked) return { exists: true as const, type: v.type, size: v.size, data: null, masked: true as const };
    if ((v.type === "REG_DWORD" || v.type === "REG_QWORD") && typeof v.data === "string") {
        const n = Number(v.data);
        return { exists: true as const, type: v.type, size: v.size, data: v.type === "REG_DWORD" || Number.isSafeInteger(n) ? n : v.data, hex: hex(v.data, v.type === "REG_DWORD" ? 8 : 16) };
    }
    return { exists: true as const, type: v.type, size: v.size, data: v.data };
}

export { ToolOutputError };
