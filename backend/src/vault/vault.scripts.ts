// backend/src/vault/vault.scripts.ts
//
// The two fixed signed scripts of the device-secrets vault. Neither contains anything a person typed: the only inputs travel in
// environment variables (RIQ_LAPS_ACCOUNT, RIQ_LAPS_LENGTH, RIQ_DRY_RUN), which PowerShell never parses as code. No secret is ever SENT
// to a device: the recovery keys are read there, and the local administrator password is generated there.
//
// What the agent does with a script (agents/windows ScriptExecutor.cs, TaskWorker.cs): the script text is written to
// %TEMP%\RemoteIQ\job-<guid>.ps1 (C:\Windows\Temp\RemoteIQ for the SYSTEM service) and deleted afterwards; stdout and stderr go through
// redirected pipes into memory and are sent to the server in the job result; the agent's own log (ProgramData\RemoteIQ\Logs) records job
// ids and warnings, never the output; the environment goes into the child process only. So these scripts print their secret to stdout
// only, never to stderr and never to a file, build the JSON by hand (no cmdlet ever receives the secret as a parameter, so PowerShell
// module logging has nothing to record), and pass no secret on any command line.
//
// Windows PowerShell 5.1 compatible. Output is ASCII (every printed value is validated against a strict pattern first).

const HEAD = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Out-Raw([string]$s) { [Console]::Out.Write($s) }
function Fail([string]$reason, [string]$hr) {
  $h = ''
  if ($hr -match '^[0-9A-Fa-f]{1,8}$') { $h = ',"hr":"' + $hr + '"' }
  Out-Raw ('{"ok":false,"reason":"' + $reason + '"' + $h + '}')
  exit 1
}
function HrOf($e) { try { return ('{0:X8}' -f [uint32]($e.Exception.HResult -band 0xFFFFFFFF)) } catch { return '' } }
`;

/** Password generator: OS random numbers, rejection sampling (no modulo bias), one of every class, Fisher-Yates shuffle. */
export const LAPS_GENERATOR = String.raw`function Get-RiqIndex($rng, [int]$n) {
  $limit = 256 - (256 % $n)
  $b = New-Object byte[] 1
  do { $rng.GetBytes($b) } while ($b[0] -ge $limit)
  return [int]($b[0] % $n)
}
function New-RiqPassword([int]$len) {
  $sets = @('ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!#%&*+=?@^_')
  $all = ($sets -join '')
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $chars = New-Object System.Collections.Generic.List[char]
    foreach ($s in $sets) { $chars.Add($s[(Get-RiqIndex $rng $s.Length)]) }
    while ($chars.Count -lt $len) { $chars.Add($all[(Get-RiqIndex $rng $all.Length)]) }
    for ($i = $chars.Count - 1; $i -gt 0; $i--) {
      $j = Get-RiqIndex $rng ($i + 1)
      $t = $chars[$i]; $chars[$i] = $chars[$j]; $chars[$j] = $t
    }
    return (-join $chars)
  } finally { $rng.Dispose() }
}
function Test-RiqPassword([string]$pw, [int]$len) {
  if ($pw.Length -ne $len) { return $false }
  if ($pw -cnotmatch '^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#%&*+=?@^_]+$') { return $false }
  return ($pw -cmatch '[A-HJ-NP-Z]') -and ($pw -cmatch '[a-km-z]') -and ($pw -cmatch '[2-9]') -and ($pw -cmatch '[!#%&*+=?@^_]')
}
`;

const BITLOCKER_BODY = String.raw`
try {
  if (-not (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue)) { Fail 'no_bitlocker' '' }
  $fixed = @{}
  foreach ($d in @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -Property DeviceID)) { $fixed[([string]$d.DeviceID).ToUpper()] = $true }
  try { $vols = @(Get-BitLockerVolume) } catch { Fail 'access_denied' (HrOf $_) }
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($v in $vols) {
    $mount = ([string]$v.MountPoint).Trim().ToUpper()
    if ($mount -notmatch '^[A-Z]:$' -or -not $fixed.ContainsKey($mount)) { continue }
    foreach ($kp in @($v.KeyProtector)) {
      if ([string]$kp.KeyProtectorType -ne 'RecoveryPassword') { continue }
      $id = ([string]$kp.KeyProtectorId).Trim().Trim('{', '}').ToLower()
      $pw = [string]$kp.RecoveryPassword
      if ($id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { continue }
      if ($pw -notmatch '^[0-9]{6}(-[0-9]{6}){7}$') { continue }
      $items.Add('{"mount":"' + $mount + '","protectorId":"' + $id + '","recoveryPassword":"' + $pw + '"}')
    }
  }
  Out-Raw ('{"ok":true,"keys":[' + ($items -join ',') + ']}')
} catch { Fail 'read_failed' (HrOf $_) }
`;

export const BITLOCKER_KEYS_SCRIPT = HEAD + BITLOCKER_BODY;

const LAPS_BODY = String.raw`
$dry = ($env:RIQ_DRY_RUN -eq '1')
$acct = [string]$env:RIQ_LAPS_ACCOUNT
$lenText = [string]$env:RIQ_LAPS_LENGTH
if ($acct -notmatch '^[A-Za-z0-9._-]{1,20}$') { Fail 'invalid_account' '' }
if (@('administrator', 'guest', 'defaultaccount', 'system', 'wdagutilityaccount', 'krbtgt', 'localservice', 'networkservice', 'root', 'admin', 'administrators', 'users') -contains $acct.ToLower()) { Fail 'reserved_account' '' }
if ($lenText -notmatch '^[0-9]{2}$') { Fail 'invalid_length' '' }
$len = [int]$lenText
if ($len -lt 14 -or $len -gt 64) { Fail 'invalid_length' '' }

try {
  $pw = New-RiqPassword $len
  if (-not (Test-RiqPassword $pw $len)) { Fail 'generate_failed' '' }
} catch { Fail 'generate_failed' (HrOf $_) }

if ($dry) {
  # Nothing is changed and nothing is looked up: only the shape of the answer, with a password that is never applied.
  Out-Raw ('{"ok":true,"dryRun":true,"account":"' + $acct + '","created":false,"verified":false,"password":"' + $pw + '"}')
  exit 0
}

try { if ([int](Get-CimInstance -ClassName Win32_ComputerSystem -Property DomainRole).DomainRole -ge 4) { Fail 'domain_controller' '' } } catch { Fail 'read_failed' (HrOf $_) }

$comp = $env:COMPUTERNAME
$path = 'WinNT://' + $comp + '/' + $acct + ',user'
$created = $false
try {
  if (-not [ADSI]::Exists($path)) {
    # The password is set only after the account exists. If anything fails the account (or the old password) is left as it was.
    $computer = [ADSI]('WinNT://' + $comp + ',computer')
    $u = $computer.Create('user', $acct)
    $u.SetInfo()
    $created = $true
  }
} catch { Fail 'create_failed' (HrOf $_) }

try {
  $user = [ADSI]$path
  $user.SetPassword($pw)
  if ($created) {
    $user.UserFlags = ([int]$user.UserFlags.Value -bor 0x10000)
    $user.Description = 'Managed by RemoteIQ'
  }
  $user.SetInfo()
} catch { Fail 'set_failed' (HrOf $_) }

if ($created) {
  try {
    $gname = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value.Split([char]92)[-1]
    $group = [ADSI]('WinNT://' + $comp + '/' + $gname + ',group')
    try { $group.Add('WinNT://' + $comp + '/' + $acct) } catch { if (([uint32]($_.Exception.HResult -band 0xFFFFFFFF)) -ne 0x80070562) { throw } }
  } catch { Fail 'group_failed' (HrOf $_) }
}

# Verify with a real local logon (LogonUserW through a dynamic P/Invoke: no compiler, nothing on a command line).
$verified = $false
try {
  $t = $null
  foreach ($a in [AppDomain]::CurrentDomain.GetAssemblies()) { $t = $a.GetType('RiqLapsNative', $false); if ($t) { break } }
  if (-not $t) {
    $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName('RiqLapsDyn')), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $tb = $ab.DefineDynamicModule('RiqLapsDyn').DefineType('RiqLapsNative', 'Public,Class')
    $m1 = $tb.DefinePInvokeMethod('LogonUserW', 'advapi32.dll', 'Public,Static,PinvokeImpl', [System.Reflection.CallingConventions]::Standard, [bool], @([string], [string], [string], [int], [int], [IntPtr].MakeByRefType()), [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Unicode)
    $m1.SetImplementationFlags($m1.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig)
    $m2 = $tb.DefinePInvokeMethod('CloseHandle', 'kernel32.dll', 'Public,Static,PinvokeImpl', [System.Reflection.CallingConventions]::Standard, [bool], @([IntPtr]), [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Unicode)
    $m2.SetImplementationFlags($m2.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig)
    $t = $tb.CreateType()
  }
  foreach ($type in @(3, 2)) {
    $h = [IntPtr]::Zero
    if ($t::LogonUserW($acct, $comp, $pw, $type, 0, [ref]$h)) { $null = $t::CloseHandle($h); $verified = $true; break }
  }
} catch { $verified = $false }

# The password is printed to stdout only, built by hand: it is never given to a cmdlet as a parameter and never written anywhere else.
$cs = 'false'; if ($created) { $cs = 'true' }
$vs = 'false'; if ($verified) { $vs = 'true' }
Out-Raw ('{"ok":true,"account":"' + $acct + '","created":' + $cs + ',"verified":' + $vs + ',"password":"' + $pw + '"}')
`;

export const LAPS_ROTATE_SCRIPT = HEAD + LAPS_GENERATOR + LAPS_BODY;

/* ------------------------------ Linux ------------------------------ */
// The same two jobs for Linux devices, as fixed bash scripts that print the same JSON answers. The same rules hold: the only inputs
// are environment variables (RIQ_LAPS_ACCOUNT, RIQ_LAPS_LENGTH, RIQ_DRY_RUN, RIQ_LUKS_HAVE), no secret is ever sent to the device, the
// secret is printed to stdout only (never stderr, never a file), and it never appears on a command line (printf is a shell builtin and
// the password travels through a pipe). These scripts live in template literals: no dollar-brace sequence and no backtick inside.

const LINUX_HEAD = String.raw`#!/bin/bash
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
umask 077
fail() { printf '{"ok":false,"reason":"%s"}' "$1"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
`;

export const LINUX_LAPS_ROTATE_SCRIPT = LINUX_HEAD + String.raw`
ACCT="$RIQ_LAPS_ACCOUNT"
LEN="$RIQ_LAPS_LENGTH"
printf '%s' "$ACCT" | grep -Eq '^[a-z_][a-z0-9_-]{0,19}$' || fail invalid_account
case "$ACCT" in root|admin|administrator|guest|system|daemon|bin|sys|sync|nobody|operator|adm|wheel|sudo|users|krbtgt) fail reserved_account;; esac
printf '%s' "$LEN" | grep -Eq '^[0-9]{2}$' || fail invalid_length
[ "$LEN" -ge 14 ] && [ "$LEN" -le 64 ] || fail invalid_length

# Password: the operating system's random numbers; tr keeps only bytes of the alphabet, so every character is equally likely (no modulo
# bias). One of every class is required, so a password that lacks one is thrown away and drawn again.
PW=""
N=0
while [ "$N" -lt 60 ]; do
  N=$((N + 1))
  C=$(tr -dc 'A-HJ-NP-Za-km-np-z2-9!#%&*+=?@^_' </dev/urandom 2>/dev/null | head -c "$LEN")
  LL=$(printf '%s' "$C" | wc -c)
  [ "$LL" -eq "$LEN" ] || continue
  printf '%s' "$C" | grep -q '[A-HJ-NP-Z]' || continue
  printf '%s' "$C" | grep -q '[a-km-np-z]' || continue
  printf '%s' "$C" | grep -q '[2-9]' || continue
  printf '%s' "$C" | grep -q '[!#%&*+=?@^_]' || continue
  PW="$C"; break
done
[ -n "$PW" ] || fail generate_failed

if [ "$RIQ_DRY_RUN" = "1" ]; then
  # Nothing is changed and nothing is looked up: only the shape of the answer, with a password that is never applied.
  printf '{"ok":true,"dryRun":true,"account":"%s","created":false,"verified":false,"password":"%s"}' "$ACCT" "$PW"
  exit 0
fi

[ "$(id -u)" = "0" ] || fail not_root
have chpasswd || fail no_tools
UIDMIN=$(awk '$1=="UID_MIN"{print $2; exit}' /etc/login.defs 2>/dev/null)
case "$UIDMIN" in ''|*[!0-9]*) UIDMIN=1000;; esac

CREATED=false
if id "$ACCT" >/dev/null 2>&1; then
  # An existing account is only taken over when it is an ordinary one: never a system account.
  U=$(id -u "$ACCT" 2>/dev/null)
  case "$U" in ''|*[!0-9]*) fail read_failed;; esac
  [ "$U" -ge "$UIDMIN" ] || fail system_account
else
  have useradd || fail no_tools
  # The password is set only after the account exists. If anything fails the account (or the old password) is left as it was.
  useradd -m -s /bin/bash -c 'Managed by RemoteIQ' "$ACCT" >/dev/null 2>&1 || fail create_failed
  CREATED=true
  G=""
  for X in sudo wheel; do getent group "$X" >/dev/null 2>&1 && G="$X" && break; done
  if [ -n "$G" ]; then
    usermod -aG "$G" "$ACCT" >/dev/null 2>&1 || fail group_failed
  elif [ -d /etc/sudoers.d ] && have visudo; then
    F="/etc/sudoers.d/90-riq-admin"
    printf '%s ALL=(ALL) ALL\n' "$ACCT" > "$F.tmp" && chmod 440 "$F.tmp" && visudo -cf "$F.tmp" >/dev/null 2>&1 && mv -f "$F.tmp" "$F" || { rm -f "$F.tmp"; fail group_failed; }
  else
    fail group_failed
  fi
fi

printf '%s:%s\n' "$ACCT" "$PW" | chpasswd >/dev/null 2>&1 || fail set_failed
# a password that never expires, so an administrator is never locked out by an old policy
have chage && chage -M -1 -I -1 -E -1 "$ACCT" >/dev/null 2>&1

# Verify: the stored hash must be the hash of the new password. Neither the password nor the hash goes on a command line.
VERIFIED=false
HASH=$(getent shadow "$ACCT" 2>/dev/null | cut -d: -f2)
case "$HASH" in
  '$'*)
    if have python3 && printf '%s\n%s\n' "$PW" "$HASH" | python3 -c 'import sys,crypt
pw=sys.stdin.readline().rstrip("\n")
h=sys.stdin.readline().rstrip("\n")
sys.exit(0 if h and crypt.crypt(pw,h)==h else 1)' >/dev/null 2>&1; then
      VERIFIED=true
    elif have openssl; then
      case "$HASH" in
        '$6$'*|'$5$'*|'$1$'*)
          ALGO=$(printf '%s' "$HASH" | cut -d'$' -f2)
          SALT=$(printf '%s' "$HASH" | cut -d'$' -f3)
          NEW=$(printf '%s\n' "$PW" | openssl passwd -"$ALGO" -salt "$SALT" -stdin 2>/dev/null)
          [ -n "$NEW" ] && [ "$NEW" = "$HASH" ] && VERIFIED=true;;
      esac
    fi;;
esac

printf '{"ok":true,"account":"%s","created":%s,"verified":%s,"password":"%s"}' "$ACCT" "$CREATED" "$VERIFIED" "$PW"
`;

// LUKS has no recovery key to read back: the passphrase is never stored on the machine. What can be done without anyone typing the
// passphrase is to ADD a new recovery key slot, which systemd-cryptenroll can do when the volume unlocks with the machine's TPM2 or with a
// key file listed in /etc/crypttab. The new key is printed once, here, and stored encrypted by the server. A volume that already has a
// stored key (RIQ_LUKS_HAVE lists their LUKS UUIDs) is not touched again, so a volume gets at most one slot from RemoteIQ. Nothing else
// on the volume changes: no slot is removed and no existing passphrase is read.
export const LINUX_LUKS_ESCROW_SCRIPT = LINUX_HEAD + String.raw`
[ "$(id -u)" = "0" ] || fail not_root
have cryptsetup || fail no_luks
have lsblk || fail no_tools
HAVE=",$RIQ_LUKS_HAVE,"

LIST=""
for NAME in $(lsblk -rno NAME,TYPE 2>/dev/null | awk '$2=="crypt"{print $1}'); do
  PARENT=$(cryptsetup status "$NAME" 2>/dev/null | awk '$1=="device:"{print $2; exit}')
  [ -n "$PARENT" ] && [ -b "$PARENT" ] || continue
  case " $LIST " in *" $PARENT "*) continue;; esac
  LIST="$LIST $PARENT"
done
[ -n "$LIST" ] || fail no_luks

KEYS=""; VOLS=""; COUNT=0
vol() { if [ -n "$VOLS" ]; then VOLS="$VOLS,"; fi; VOLS="$VOLS{\"id\":\"$1\",\"state\":\"$2\"}"; }
for DEV in $LIST; do
  UUID=$(cryptsetup luksUUID "$DEV" 2>/dev/null | tr 'A-Z' 'a-z')
  printf '%s' "$UUID" | grep -Eq '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' || continue
  case "$HAVE" in *",$UUID,"*) vol "$UUID" have; continue;; esac
  VER=$(cryptsetup luksDump "$DEV" 2>/dev/null | awk '$1=="Version:"{print $2; exit}')
  [ "$VER" = "2" ] || { vol "$UUID" not_luks2; continue; }
  if ! have systemd-cryptenroll || ! systemd-cryptenroll --help 2>&1 | grep -q 'recovery-key'; then vol "$UUID" no_cryptenroll; continue; fi
  [ "$COUNT" -lt 4 ] || { vol "$UUID" later; continue; }
  COUNT=$((COUNT + 1))
  LABEL=$(lsblk -rno MOUNTPOINT "$DEV" 2>/dev/null | grep -E '^/[A-Za-z0-9_./-]{0,40}$' | sort | head -n 1)
  [ -n "$LABEL" ] || LABEL="luks-$(printf '%s' "$UUID" | cut -c1-8)"

  # Unlock with the TPM first, then with a key file named in /etc/crypttab. Standard input is empty: nothing can ask for a passphrase.
  KEY=""
  OUT=$(timeout 60 systemd-cryptenroll --recovery-key --unlock-tpm2-device=auto "$DEV" 2>/dev/null </dev/null); RC=$?
  KEY=$(printf '%s\n' "$OUT" | grep -Eo '[cbdefghijklnrtuv]{8}(-[cbdefghijklnrtuv]{8}){7}' | head -n 1)
  if [ -z "$KEY" ]; then
    KF=$(awk -v u="$UUID" -v d="$DEV" '$0 !~ /^[ \t]*#/ && NF >= 3 && ($2 == "UUID=" u || $2 == d) && $3 != "none" && $3 != "-" {print $3; exit}' /etc/crypttab 2>/dev/null)
    if [ -n "$KF" ] && [ -f "$KF" ] && [ -r "$KF" ]; then
      OUT=$(timeout 60 systemd-cryptenroll --recovery-key --unlock-key-file="$KF" "$DEV" 2>/dev/null </dev/null); RC=$?
      KEY=$(printf '%s\n' "$OUT" | grep -Eo '[cbdefghijklnrtuv]{8}(-[cbdefghijklnrtuv]{8}){7}' | head -n 1)
    fi
  fi
  OUT=""
  if [ -z "$KEY" ]; then
    # exit status 0 without a key we can read means a slot was added whose key is lost: say so, never call it "cannot unlock"
    if [ "$RC" = "0" ]; then vol "$UUID" unreadable; else vol "$UUID" no_unlock; fi
    continue
  fi
  if [ -n "$KEYS" ]; then KEYS="$KEYS,"; fi
  KEYS="$KEYS{\"mount\":\"$LABEL\",\"protectorId\":\"$UUID\",\"recoveryPassword\":\"$KEY\"}"
  vol "$UUID" enrolled
done
printf '{"ok":true,"keys":[%s],"volumes":[%s]}' "$KEYS" "$VOLS"
`;
