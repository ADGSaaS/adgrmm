// backend/src/provisioning/installer-scripts.ts
//
// The scripts the console hands out. Values are filled in by replacing __PLACEHOLDERS__, and
// all of them are URL-safe, so they cannot break out of the quotes around them.
// Keep these ASCII: Windows PowerShell reads a BOM-less script as ANSI when it is saved to a file.

export type InstallerScriptValues = {
  baseUrl: string;
  enrollmentKey: string;
  packageSha256: string;
  /** Do nothing on a machine that already has the agent installed and enrolled (for scripts that run on every boot). */
  onlyIfMissing?: boolean;
};

const WINDOWS_TEMPLATE = String.raw`# ADG RMM agent installer for Windows
# Paste the command from the console into PowerShell as Administrator, or right-click this file
# and choose Run with PowerShell. Log: C:\ProgramData\AdgRmm\install.log
& {
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$BaseUrl = '__BASE_URL__'
$EnrollmentKey = '__ENROLLMENT_KEY__'
$PackageSha256 = '__PACKAGE_SHA256__'
$OnlyIfMissing = __ONLY_IF_MISSING__

$ServiceName = 'AdgRmmAgent'
$DataDir = Join-Path $env:ProgramData 'ADG RMM'
$InstallDir = Join-Path $env:ProgramFiles 'AdgRmm\Agent'
$ConfigPath = Join-Path $DataDir 'agent.config.json'
$EnrollmentPath = Join-Path $DataDir 'enrollment.json'
$LogPath = Join-Path $DataDir 'install.log'
$ZipPath = Join-Path $env:TEMP ('adgrmm-agent-' + [Guid]::NewGuid().ToString('N') + '.zip')

function Write-Log([string]$Message) {
  $line = '[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $Message
  Write-Host $line
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch {}
}

# Started from a saved file, the window would vanish with its result, so it stays open.
$RunFromFile = -not [string]::IsNullOrEmpty($PSCommandPath)
function Wait-ForKey {
  if ($RunFromFile -and -not $OnlyIfMissing -and -not [Console]::IsInputRedirected) { Read-Host 'Press Enter to close' | Out-Null }
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if (-not $RunFromFile) { throw 'Please run this in PowerShell as Administrator.' }
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"')
  } catch {
    Write-Host 'The installer needs administrator rights, and that request was declined.' -ForegroundColor Red
    Wait-ForKey
  }
  return
}

try {
# Run at every start-up by Group Policy, this must leave a working machine alone.
if ($OnlyIfMissing) {
  $enrolled = ''
  if (Test-Path -LiteralPath $ConfigPath) { try { $enrolled = [string](Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).AgentId } catch {} }
  if ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -and $enrolled) {
    Write-Host 'The ADG RMM agent is already installed and enrolled. Nothing to do.'
    return
  }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# The data folder will hold the agent's credentials and what the SYSTEM service trusts (its server and key, the update script),
# so only SYSTEM and Administrators may read or change it. A standard user can create C:\ProgramData\AdgRmm before the agent is
# installed and would then own it, so an existing folder first goes back to Administrators and has every permission reset,
# down to the last file in it. Well-known SIDs, not names, so this works in every Windows language.
if (Test-Path -LiteralPath $DataDir) {
  & icacls.exe $DataDir /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
  & icacls.exe $DataDir /reset /T /C /Q | Out-Null
} else {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}
& icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to the ADG RMM data folder.' }
# Nothing is written to it until it is checked: owned by Administrators or SYSTEM, and nobody else allowed anything.
$trustedSids = @('S-1-5-18', 'S-1-5-32-544')
$dataAcl = Get-Acl -LiteralPath $DataDir
if ($trustedSids -notcontains $dataAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value) {
  throw ('The ADG RMM data folder ' + $DataDir + ' is owned by another account and could not be taken back. Delete that folder and run the installer again.')
}
foreach ($rule in $dataAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $trustedSids -notcontains $rule.IdentityReference.Value) {
    throw ('The ADG RMM data folder ' + $DataDir + ' still lets ' + $rule.IdentityReference.Value + ' in. Delete that folder and run the installer again.')
  }
}

Write-Log ('Installing the ADG RMM agent from ' + $BaseUrl)

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# A device with the wrong date cannot check the server's certificate (it looks expired or not yet valid) and the download would fail,
# so the clock is put right first. Only when it is more than five minutes off: first by asking the Windows time service, then from
# the server's own Date header. That header is read without trusting the certificate when it has to be, because a wrong clock is
# exactly what breaks the certificate. Whatever happens here, the install carries on.
function Get-ServerDate([bool]$Verify) {
  if (-not $Verify) {
    if (-not ('AdgTrustAll' -as [type])) {
      Add-Type -TypeDefinition 'using System.Net; using System.Net.Security; using System.Security.Cryptography.X509Certificates; public static class AdgTrustAll { public static bool Yes(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) { return true; } public static void On() { ServicePointManager.ServerCertificateValidationCallback = new RemoteCertificateValidationCallback(Yes); } public static void Off() { ServicePointManager.ServerCertificateValidationCallback = null; } }'
    }
    [AdgTrustAll]::On()
  }
  try {
    $req = [Net.HttpWebRequest]::Create($BaseUrl + '/')
    $req.Method = 'HEAD'
    $req.Timeout = 15000
    $req.KeepAlive = $false
    $req.AllowAutoRedirect = $false
    $resp = $null
    try { $resp = $req.GetResponse() } catch [Net.WebException] { $resp = $_.Exception.Response; if (-not $resp) { throw } }
    $text = [string]$resp.Headers['Date']
    $resp.Close()
    if (-not $text) { return $null }
    $style = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    return [DateTime]::Parse($text, [Globalization.CultureInfo]::InvariantCulture, $style)
  } finally {
    if (-not $Verify) { [AdgTrustAll]::Off() }
  }
}

function Sync-Clock {
  try {
    $server = $null
    try { $server = Get-ServerDate $true } catch { try { $server = Get-ServerDate $false } catch {} }
    if (-not $server) { return }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    if ([Math]::Abs(([DateTime]::UtcNow - $server).TotalMinutes) -lt 5) { return }
    Write-Log ('The clock of this device is off by about ' + [int][Math]::Abs(([DateTime]::UtcNow - $server).TotalMinutes) + ' minutes, which breaks certificate checks. Setting it right.')
    try {
      Start-Service -Name w32time -ErrorAction SilentlyContinue
      & w32tm.exe /resync /force 2>&1 | Out-Null
    } catch {}
    $expected = $server + $watch.Elapsed
    if ([Math]::Abs(([DateTime]::UtcNow - $expected).TotalMinutes) -lt 5) { Write-Log 'The time service fixed the clock.'; return }
    if ($server.Year -lt 2024) { Write-Log 'The server reports an implausible date, so the clock was left alone.'; return }
    Set-Date -Date $expected.ToLocalTime() | Out-Null
    Write-Log ('The clock was set from the server: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
  } catch {
    Write-Log ('The clock could not be checked or set (' + $_.Exception.Message + '). Continuing.')
  }
}
Sync-Clock

$attempt = 0
while ($true) {
  $attempt++
  try {
    Invoke-WebRequest -Uri ($BaseUrl + '/api/provisioning/agent-packages/windows') -Headers @{ 'X-Enrollment-Key' = $EnrollmentKey } -OutFile $ZipPath -UseBasicParsing
    break
  } catch {
    $code = 0
    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401) { throw 'This installer has expired or its enrollment key was revoked. Create a new one in the console.' }
    if ($attempt -ge 5) { throw ('Could not download the agent: ' + $_.Exception.Message) }
    Write-Log ('Download failed, retrying: ' + $_.Exception.Message)
    Start-Sleep -Seconds 5
  }
}

$actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $PackageSha256) {
  Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
  throw 'The downloaded agent failed its integrity check. Create a new installer in the console and try again.'
}
Write-Log 'Download verified.'

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
  Write-Log 'Stopping the existing agent.'
  Stop-Service -Name $ServiceName -Force
  $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}

Get-ChildItem -LiteralPath $InstallDir -Force | Remove-Item -Recurse -Force
Expand-Archive -LiteralPath $ZipPath -DestinationPath $InstallDir -Force
Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue

$AgentExe = Join-Path $InstallDir 'AdgRmm.Agent.exe'
if (-not (Test-Path -LiteralPath $AgentExe)) { throw 'The agent package is missing AdgRmm.Agent.exe.' }

# A reinstall keeps this machine's device id, so it stays the same device in the console.
$DeviceId = ''
if (Test-Path -LiteralPath $ConfigPath) {
  try { $DeviceId = [string](Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).DeviceId } catch {}
}
if ([string]::IsNullOrWhiteSpace($DeviceId)) { $DeviceId = [Guid]::NewGuid().ToString() }

@{ baseUrl = $BaseUrl; deviceId = $DeviceId; enrollmentKey = $EnrollmentKey } | ConvertTo-Json | Set-Content -LiteralPath $EnrollmentPath -Encoding UTF8

try { if (-not [Diagnostics.EventLog]::SourceExists('ADG RMM Agent')) { New-EventLog -LogName Application -Source 'ADG RMM Agent' } } catch {}

$imagePath = '"' + $AgentExe + '"'
if ($existing) {
  # An existing service may come from an older install or a dev build, so it is pointed at this one.
  $wmiService = Get-CimInstance Win32_Service -Filter ("Name='" + $ServiceName + "'")
  $changed = Invoke-CimMethod -InputObject $wmiService -MethodName Change -Arguments @{ PathName = $imagePath; StartMode = 'Automatic'; StartName = 'LocalSystem'; StartPassword = ''; DisplayName = 'ADG RMM Agent' }
  if ($changed.ReturnValue -ne 0) { throw ('Could not update the existing AdgRmmAgent service (error ' + $changed.ReturnValue + ').') }
} else {
  New-Service -Name $ServiceName -BinaryPathName $imagePath -DisplayName 'ADG RMM Agent' -Description 'ADG RMM endpoint agent' -StartupType Automatic | Out-Null
}
& sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null

# The agent is a single-file app that unpacks its native DLLs when it starts. By default that is under SYSTEM's temp folder, which
# can be C:\Windows\Temp, where users can create folders; here it is a folder in the locked data folder (it inherits that ACL).
$BundleDir = Join-Path $DataDir 'dotnet-bundle'
New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null
$serviceKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\' + $ServiceName
$serviceEnv = @()
try { $serviceEnv = @((Get-ItemProperty -LiteralPath $serviceKey -Name Environment -ErrorAction Stop).Environment) } catch {}
$serviceEnv = @($serviceEnv | Where-Object { $_ -and -not $_.StartsWith('DOTNET_BUNDLE_EXTRACT_BASE_DIR=', [StringComparison]::OrdinalIgnoreCase) })
$serviceEnv += ('DOTNET_BUNDLE_EXTRACT_BASE_DIR=' + $BundleDir)
New-ItemProperty -LiteralPath $serviceKey -Name Environment -PropertyType MultiString -Value ([string[]]$serviceEnv) -Force | Out-Null

# Starting from a known state, so an agent that already enrolled cannot look like this install succeeded.
if (Test-Path -LiteralPath $ConfigPath) {
  $previous = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $previous.AgentId = ''
  $previous | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
}

try {
  Start-Service -Name $ServiceName
} catch {
  # Start-Service hides the actual reason, which Windows records in the event log.
  $why = ''
  try {
    $why = (Get-WinEvent -MaxEvents 1 -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; Id = 7000, 7009, 7011, 7023, 7024 } | Select-Object -ExpandProperty Message)
  } catch {}
  throw ('The agent service could not start. ' + $why)
}
Write-Log 'Service started. Waiting for the agent to enroll.'

$deadline = (Get-Date).AddSeconds(120)
$agentId = ''
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if ((Get-Service -Name $ServiceName).Status -eq 'Stopped') { break }
  try { $agentId = [string](Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).AgentId } catch {}
  if ($agentId) { break }
}

if (-not $agentId) {
  $latest = Get-ChildItem -Path (Join-Path $DataDir 'Logs') -Filter 'agent-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
  if ($latest) { Get-Content -LiteralPath $latest.FullName -Tail 15 | ForEach-Object { Write-Log $_ } }
  throw 'The agent is installed but has not enrolled. See the messages above. It keeps retrying on its own.'
}

Write-Log ('Done. This device is now enrolled as agent ' + $agentId + '.')
Wait-ForKey
} catch {
  $message = $_.Exception.Message
  Write-Log ('ERROR: ' + $message)
  if (-not $RunFromFile) { throw $message }
  Write-Host $message -ForegroundColor Red
  Wait-ForKey
  exit 1
}
}
`;

const LINUX_TEMPLATE = String.raw`#!/usr/bin/env bash
# ADG RMM agent installer for Linux (x64; systemd or OpenRC; glibc or musl, so Alpine too). Run as root.
set -euo pipefail

BASE_URL='__BASE_URL__'
ENROLLMENT_KEY='__ENROLLMENT_KEY__'
PACKAGE_SHA256='__PACKAGE_SHA256__'
ONLY_IF_MISSING=__ONLY_IF_MISSING_SH__

CONFIG_DIR=/etc/adgrmm
INSTALL_DIR=/opt/adgrmm-agent
SERVICE=adgrmm-agent

die() { echo "ERROR: $1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run this as root (sudo)."

# What starts services here: systemd, or OpenRC (Alpine, Gentoo, Artix). The other init systems are not supported.
INIT=""
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  INIT=systemd
elif command -v rc-service >/dev/null 2>&1 && { [ -x /sbin/openrc-run ] || [ -x /usr/sbin/openrc-run ]; }; then
  INIT=openrc
fi
[ -n "$INIT" ] || die "This system starts services with neither systemd nor OpenRC (runit, sysvinit and s6 are not supported yet)."
# The libc decides which of the two programs in the package runs: Alpine and other musl systems get the musl build.
MUSL=0
if [ -e /lib/ld-musl-x86_64.so.1 ] && [ ! -e /lib64/ld-linux-x86-64.so.2 ]; then MUSL=1; fi

svc_active() { if [ "$INIT" = openrc ]; then rc-service "$SERVICE" status >/dev/null 2>&1; else systemctl is-active --quiet "$SERVICE" 2>/dev/null; fi; }
svc_stop() { if [ "$INIT" = openrc ]; then rc-service "$SERVICE" stop >/dev/null 2>&1 || true; else systemctl stop "$SERVICE" 2>/dev/null || true; fi; }

# Run on every boot by configuration management, this must leave a working machine alone.
if [ "$ONLY_IF_MISSING" = "1" ] && svc_active \
  && grep -q '"AgentId": *"[^"]\+"' "$CONFIG_DIR/agent.json" 2>/dev/null; then
  echo "The ADG RMM agent is already installed and enrolled. Nothing to do."
  exit 0
fi
[ "$(uname -m)" = "x86_64" ] || die "The ADG RMM agent currently supports x86_64 only, not $(uname -m)."
# Alpine: the small base system lacks what the installer and the agent need, so it is added from Alpine's own repositories.
if [ "$MUSL" = "1" ] && command -v apk >/dev/null 2>&1; then
  apk add --no-cache bash curl tar ca-certificates libstdc++ libgcc zlib libssl3 coreutils >/dev/null 2>&1 || die "Could not install the packages the agent needs on Alpine (apk add bash curl tar ca-certificates libstdc++ libgcc zlib libssl3 coreutils)."
elif [ "$MUSL" = "1" ]; then
  die "This is a musl based Linux without apk. The agent needs bash, curl, tar, libstdc++, libgcc, zlib and OpenSSL 3 installed first."
fi
command -v tar >/dev/null 2>&1 || die "tar is required. Install it with your package manager (for example: zypper install tar gzip) and run this again."
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required."

# The agent talks over TLS through the system's OpenSSL. A system with none cannot run it, and one whose only OpenSSL is newer than
# the 3.x this runtime knows (libssl.so.4 and up) needs the runtime told which one to use.
SSL_ENV=""
OPENRC_ENV=""
if [ "$MUSL" = "0" ] && command -v ldconfig >/dev/null 2>&1; then
  LIBSSL_LIST="$(ldconfig -p 2>/dev/null | sed -n 's/.*libssl\.so\.\([0-9][0-9.]*\).*/\1/p' | sort -uV)"
  [ -n "$LIBSSL_LIST" ] || die "OpenSSL libraries (libssl) are missing. Install them (Debian and Ubuntu: libssl3, Fedora, Rocky and RHEL: openssl-libs, SUSE: libopenssl3) and run this again."
  if ! printf '%s\n' "$LIBSSL_LIST" | grep -qx -e '3' -e '1.1'; then
    SSL_ENV="Environment=CLR_OPENSSL_VERSION_OVERRIDE=$(printf '%s\n' "$LIBSSL_LIST" | tail -n 1)"
    OPENRC_ENV="export CLR_OPENSSL_VERSION_OVERRIDE=$(printf '%s\n' "$LIBSSL_LIST" | tail -n 1)"
  fi
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PACKAGE="$TMP_DIR/agent.tar.gz"

echo "Installing the ADG RMM agent from $BASE_URL"

# A device with the wrong date cannot check the server's certificate (it looks expired or not yet valid) and the download would fail,
# so the clock is put right first. Only when it is more than five minutes off: first by asking the system's own time service, then
# from the server's own Date header. That header is read without trusting the certificate when it has to be, because a wrong clock is
# exactly what breaks the certificate. Whatever happens here, the install carries on.
server_epoch() {
  local hdr=""
  if command -v curl >/dev/null 2>&1; then
    if [ "$1" = insecure ]; then hdr="$(curl -sS -k -I --max-time 15 "$BASE_URL/" 2>/dev/null || true)"; else hdr="$(curl -sS -I --max-time 15 "$BASE_URL/" 2>/dev/null || true)"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$1" = insecure ]; then hdr="$(wget -q -S --spider --no-check-certificate -T 15 "$BASE_URL/" 2>&1 || true)"; else hdr="$(wget -q -S --spider -T 15 "$BASE_URL/" 2>&1 || true)"; fi
  fi
  hdr="$(printf '%s\n' "$hdr" | tr -d '\r' | sed -n 's/^ *[Dd]ate: *//p' | head -n 1)"
  [ -n "$hdr" ] || return 0
  date -u -d "$hdr" +%s 2>/dev/null || true
}
uptime_s() { cut -d. -f1 /proc/uptime 2>/dev/null || echo 0; }
clock_off() { local d=$(( $1 - $(date -u +%s) )); [ "$d" -ge 0 ] || d=$(( 0 - d )); echo "$d"; }
sync_clock() {
  local se up0 expected off
  se="$(server_epoch verified)"; [ -n "$se" ] || se="$(server_epoch insecure)"
  [ -n "$se" ] || return 0
  up0="$(uptime_s)"
  off="$(clock_off "$se")"
  [ "$off" -ge 300 ] || return 0
  echo "The clock of this device is off by about $(( off / 60 )) minutes, which breaks certificate checks. Setting it right."
  if command -v timedatectl >/dev/null 2>&1; then timedatectl set-ntp true >/dev/null 2>&1 || true; fi
  if command -v chronyc >/dev/null 2>&1; then chronyc -a makestep >/dev/null 2>&1 || true; fi
  if systemctl is-active --quiet systemd-timesyncd 2>/dev/null; then systemctl restart systemd-timesyncd >/dev/null 2>&1 || true; sleep 4; fi
  expected=$(( se + $(uptime_s) - up0 ))
  off="$(clock_off "$expected")"
  if [ "$off" -lt 300 ]; then echo "The time service fixed the clock."; return 0; fi
  if [ "$se" -lt 1700000000 ]; then echo "The server reports an implausible date, so the clock was left alone."; return 0; fi
  expected=$(( se + $(uptime_s) - up0 ))
  if date -u -s "@$expected" >/dev/null 2>&1; then
    command -v hwclock >/dev/null 2>&1 && hwclock --systohc >/dev/null 2>&1 || true
    echo "The clock was set from the server: $(date -u '+%Y-%m-%d %H:%M:%S') UTC."
  else
    echo "The clock could not be set (a container or a locked down system?). Continuing."
  fi
}
sync_clock || true

# The key goes through a private file, so it does not show up in the process list.
HEADER_FILE="$TMP_DIR/key-header"
( umask 077; printf 'X-Enrollment-Key: %s\n' "$ENROLLMENT_KEY" > "$HEADER_FILE" )
URL="$BASE_URL/api/provisioning/agent-packages/linux"

if command -v curl >/dev/null 2>&1; then
  STATUS="$(curl -sS -L --retry 4 --retry-delay 5 -H "@$HEADER_FILE" -o "$PACKAGE" -w '%{http_code}' "$URL")" || die "Could not reach $BASE_URL."
elif command -v wget >/dev/null 2>&1; then
  STATUS=200
  wget -q --tries=5 --waitretry=5 --header="X-Enrollment-Key: $ENROLLMENT_KEY" -O "$PACKAGE" "$URL" || STATUS=0
else
  die "curl or wget is required."
fi
[ "$STATUS" != "401" ] || die "This installer has expired or its enrollment key was revoked. Create a new one in the console."
[ "$STATUS" = "200" ] || die "Could not download the agent (status $STATUS)."

echo "$PACKAGE_SHA256  $PACKAGE" | sha256sum -c --status - || die "The downloaded agent failed its integrity check. Create a new installer in the console and try again."
echo "Download verified."

svc_stop

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
tar -xzf "$PACKAGE" -C "$INSTALL_DIR"
# The package carries a glibc program and a musl program; this machine keeps the one it can run, under the one name.
if [ "$MUSL" = "1" ]; then
  [ -f "$INSTALL_DIR/adgrmm-agent-musl" ] || die "This agent package has no build for musl based systems such as Alpine. Ask your administrator for a newer package."
  mv -f "$INSTALL_DIR/adgrmm-agent-musl" "$INSTALL_DIR/adgrmm-agent"
else
  rm -f "$INSTALL_DIR/adgrmm-agent-musl"
fi
chmod 755 "$INSTALL_DIR/adgrmm-agent" "$INSTALL_DIR/uninstall.sh"
# SELinux (Fedora, Rocky, RHEL): give the new files the labels their folders call for, so the service may run them.
if command -v restorecon >/dev/null 2>&1; then restorecon -R "$INSTALL_DIR" "$CONFIG_DIR" >/dev/null 2>&1 || true; fi

# A reinstall keeps this machine's device id, so it stays the same device in the console.
CONFIG="$CONFIG_DIR/agent.json"
DEVICE_ID=""
if [ -f "$CONFIG" ]; then
  DEVICE_ID="$(sed -n 's/.*"DeviceId": *"\([^"]*\)".*/\1/p' "$CONFIG" | head -n 1)"
fi
[ -n "$DEVICE_ID" ] || DEVICE_ID="$(cat /proc/sys/kernel/random/uuid)"

( umask 077; cat > "$CONFIG_DIR/enrollment.json" <<JSON
{ "baseUrl": "$BASE_URL", "deviceId": "$DEVICE_ID", "enrollmentKey": "$ENROLLMENT_KEY" }
JSON
)

if [ "$INIT" = "systemd" ]; then
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=ADG RMM Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$INSTALL_DIR/adgrmm-agent
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=10
$SSL_ENV

[Install]
WantedBy=multi-user.target
UNIT

# Starting from a known state, so an agent that already enrolled cannot look like this install succeeded.
[ ! -f "$CONFIG" ] || sed -i 's/"AgentId": *"[^"]*"/"AgentId": ""/' "$CONFIG"

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
else
  # OpenRC: a supervised service that is restarted whenever it stops, started at boot, logging to one file.
  cat > "/etc/init.d/$SERVICE" <<RC
#!/sbin/openrc-run
name="ADG RMM Agent"
description="ADG RMM Agent"
supervisor="supervise-daemon"
command="$INSTALL_DIR/adgrmm-agent"
directory="$INSTALL_DIR"
respawn_delay=10
respawn_max=0
output_log="/var/log/adgrmm-agent.log"
error_log="/var/log/adgrmm-agent.log"
$OPENRC_ENV

depend() {
	need net
	after firewall
}
RC
  chmod 755 "/etc/init.d/$SERVICE"
  # Starting from a known state, so an agent that already enrolled cannot look like this install succeeded.
  [ ! -f "$CONFIG" ] || sed -i 's/"AgentId": *"[^"]*"/"AgentId": ""/' "$CONFIG"
  rc-update add "$SERVICE" default >/dev/null 2>&1 || true
  rc-service "$SERVICE" restart >/dev/null 2>&1 || rc-service "$SERVICE" start || die "OpenRC could not start the agent."
fi
echo "Service started. Waiting for the agent to enroll."

for _ in $(seq 1 40); do
  sleep 3
  AGENT_ID=""
  [ ! -f "$CONFIG" ] || AGENT_ID="$(sed -n 's/.*"AgentId": *"\([^"]*\)".*/\1/p' "$CONFIG" | head -n 1)"
  if [ -n "$AGENT_ID" ]; then
    echo "Done. This device is now enrolled as agent $AGENT_ID."
    exit 0
  fi
done

if [ "$INIT" = "openrc" ]; then tail -n 15 /var/log/adgrmm-agent.log >&2 2>/dev/null || true; else journalctl -u "$SERVICE" -n 15 --no-pager >&2 || true; fi
die "The agent is installed but has not enrolled. See the messages above. It keeps retrying on its own."
`;

function fill(template: string, values: InstallerScriptValues): string {
  // Function replacers, so nothing in a value is read as a replacement pattern.
  return template
    .split("\r").join("")
    .replace("__BASE_URL__", () => values.baseUrl)
    .replace("__ENROLLMENT_KEY__", () => values.enrollmentKey)
    .replace("__PACKAGE_SHA256__", () => values.packageSha256)
    .replace("__ONLY_IF_MISSING__", () => (values.onlyIfMissing ? "$true" : "$false"))
    .replace("__ONLY_IF_MISSING_SH__", () => (values.onlyIfMissing ? "1" : "0"));
}

export function windowsInstallerScript(values: InstallerScriptValues): string {
  return fill(WINDOWS_TEMPLATE, values);
}

export function linuxInstallerScript(values: InstallerScriptValues): string {
  return fill(LINUX_TEMPLATE, values);
}
