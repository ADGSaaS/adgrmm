// backend/src/security/security.scripts.ts
//
// Security basics, stage 1 (roadmap 8.1, 8.3 status only, 8.5): ordinary signed script jobs, no new agent code.
//   - SECURITY_SCAN_SCRIPT: one fixed Windows PowerShell script that prints ONE ASCII JSON text with a probe for each thing
//     checked. Every probe is independent (its own try/catch and clock, and the slow ones run in a runspace that is dropped
//     after a time limit), so one denied or slow query never costs the whole scan. WMI/CIM is only used with named
//     properties (asking for all of them once took 90 s on a real PC). Nothing secret is ever read: no BitLocker key id,
//     recovery password or key (only the TYPES of key protectors), no Winlogon DefaultPassword, no password hash.
//   - the Defender action scripts (update signatures, start a quick or full scan): they only add protection, nothing here
//     turns anything off or edits exclusions.
//   - parseSecurityScan: what a device printed is never trusted. Sizes, types and values are checked, unknown fields are dropped,
//     and a probe that is malformed becomes "unknown" on its own.
// The scripts never contain anything a person typed: the only input (the scan type) is checked on the server and travels in an
// environment variable, which PowerShell never parses as code.
import { ToolOutputError, parseWindowsJson } from "../device-tools/device-tools.scripts";

/* ------------------------------ scripts ------------------------------ */

export const SECURITY_SCAN_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$T0 = [Diagnostics.Stopwatch]::StartNew()
$BUDGET_MS = 26000
function ConvertTo-Ascii([string]$s) {
  $bs = [string][char]92
  return [regex]::Replace($s, '[^\x00-\x7F]', { param($m) $bs + 'u' + ('{0:x4}' -f [int][char]$m.Value) })
}
function Out-Riq($obj) { [Console]::Out.Write((ConvertTo-Ascii ($obj | ConvertTo-Json -Compress -Depth 6))) }

# Helpers every probe can use (they are also given to the probes that run in their own runspace).
$HELPERS = @'
$ErrorActionPreference = 'Stop'
$HKLM = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
function Short([string]$s, [int]$n) { if ($null -eq $s) { return '' }; $t = ($s -replace '[\x00-\x1f]', ' ').Trim(); if ($t.Length -gt $n) { return $t.Substring(0, $n) }; return $t }
function RegV([string]$sub, [string]$name) {
  $k = $HKLM.OpenSubKey($sub)
  if (-not $k) { return $null }
  try { return $k.GetValue($name, $null) } finally { $k.Close() }
}
function Days($d) {
  if ($null -eq $d) { return $null }
  $u = ([datetime]$d).ToUniversalTime()
  if ($u.Year -lt 2000) { return $null }
  return [int][math]::Floor(([datetime]::UtcNow - $u).TotalDays)
}
function Iso($d) {
  if ($null -eq $d) { return $null }
  $u = ([datetime]$d).ToUniversalTime()
  if ($u.Year -lt 2000) { return $null }
  return $u.ToString('yyyy-MM-ddTHH:mm:ssZ')
}
function Unknown([string]$why) { return @{ status = 'unknown'; reason = $why } }
'@
. ([scriptblock]::Create($HELPERS))

$probes = [ordered]@{}
# One probe: its own try/catch and clock. With $box > 0 it runs in a separate runspace that is abandoned after $box ms.
function Probe([string]$name, [int]$box, [scriptblock]$body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $res = $null
  $left = $BUDGET_MS - $T0.ElapsedMilliseconds
  if ($left -lt 1000) {
    $res = @{ status = 'unknown'; reason = 'Skipped: the scan ran out of time.' }
  } else {
    try {
      if ($box -gt 0) {
        if ($box -gt $left) { $box = [int]$left }
        $ps = [powershell]::Create()
        $null = $ps.AddScript($HELPERS + [Environment]::NewLine + $body.ToString())
        $h = $ps.BeginInvoke()
        if (-not $h.AsyncWaitHandle.WaitOne($box)) { $null = $ps.BeginStop($null, $null); throw ('Timed out after ' + [int]($box / 1000) + ' s.') }
        $out = @($ps.EndInvoke($h))
        if ($ps.Streams.Error.Count -gt 0 -and $out.Count -eq 0) { throw $ps.Streams.Error[0].Exception.Message }
        $val = $out | Select-Object -Last 1
        $ps.Dispose()
      } else {
        $val = & $body
      }
      if ($val -isnot [hashtable]) { throw 'The probe gave no answer.' }
      if (-not $val.ContainsKey('status')) { $val.status = 'ok' }
      $res = $val
    } catch {
      $res = @{ status = 'unknown'; reason = (Short $_.Exception.Message 200) }
    }
  }
  $res.ms = [int]$sw.ElapsedMilliseconds
  $probes[$name] = $res
}

Probe 'os' 0 {
  $cv = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $dv = RegV $cv 'DisplayVersion'; if (-not $dv) { $dv = RegV $cv 'ReleaseId' }
  @{ productName = Short ([string](RegV $cv 'ProductName')) 100; displayVersion = Short ([string]$dv) 20; build = [int](RegV $cv 'CurrentBuildNumber'); ubr = [int](RegV $cv 'UBR'); editionId = Short ([string](RegV $cv 'EditionID')) 60; installationType = Short ([string](RegV $cv 'InstallationType')) 20 }
}

Probe 'defender' 12000 {
  $o = @{}
  try { $sc = New-Object System.ServiceProcess.ServiceController('WinDefend'); $o.serviceState = [string]$sc.Status } catch { $o.serviceState = 'Unknown' }
  $s = Get-MpComputerStatus
  $o.antivirusEnabled = [bool]$s.AntivirusEnabled
  $o.realTimeProtection = [bool]$s.RealTimeProtectionEnabled
  $o.tamperProtected = [bool]$s.IsTamperProtected
  $o.runningMode = Short ([string]$s.AMRunningMode) 40
  $o.productVersion = Short ([string]$s.AMProductVersion) 40
  $o.signatureVersion = Short ([string]$s.AntivirusSignatureVersion) 40
  $o.signatureUpdated = Iso $s.AntivirusSignatureLastUpdated
  $o.signatureAgeDays = Days $s.AntivirusSignatureLastUpdated
  $o.quickScanAt = Iso $s.QuickScanEndTime
  $o.quickScanAgeDays = Days $s.QuickScanEndTime
  $o.fullScanAt = Iso $s.FullScanEndTime
  $o.fullScanAgeDays = Days $s.FullScanEndTime
  $th = @()
  try { $th = @(Get-MpThreat -ErrorAction Stop | Where-Object { $_.IsActive }) } catch { $o.threatsUnknown = $true }
  $o.threatCount = $th.Count
  $o.threats = @($th | Select-Object -First 10 | ForEach-Object { Short ([string]$_.ThreatName) 100 })
  $o
}

# What Microsoft Defender is told NOT to scan. Only the number of exclusions and the BROAD kinds are reported (a whole drive, a system
# folder, a whole user profile, a temp or downloads folder, program or script file types, script engines); the paths themselves stay on the device.
Probe 'defenderExclusions' 12000 {
  $p = Get-MpPreference
  $paths = @($p.ExclusionPath | Where-Object { $_ })
  $exts = @($p.ExclusionExtension | Where-Object { $_ })
  $procs = @($p.ExclusionProcess | Where-Object { $_ })
  if (($paths + $exts + $procs) | Where-Object { ([string]$_) -like 'N/A*' }) { throw 'The exclusions can only be read with administrator rights.' }
  $cats = New-Object System.Collections.Generic.List[string]
  foreach ($x in $paths) {
    $n = (([string]$x) -replace '/', '\').TrimEnd('\').ToLower()
    if ($n -match '^[a-z]:$' -or $n -eq '*') { $cats.Add('a whole drive') }
    elseif ($n -match '^[a-z]:\\(windows|windows\\system32|program files|program files \(x86\)|programdata|users)$') { $cats.Add('a system folder') }
    elseif ($n -match '^[a-z]:\\users\\[^\\]+(\\(appdata|appdata\\local|appdata\\roaming|desktop|documents))?$') { $cats.Add('a whole user profile') }
    elseif ($n -match '\\(temp|downloads)$') { $cats.Add('a temp or downloads folder') }
  }
  $risky = @('exe', 'dll', 'ps1', 'bat', 'cmd', 'vbs', 'js', 'scr', 'com', 'hta', 'msi', 'jar')
  foreach ($e in $exts) { $n = ([string]$e).TrimStart('.').ToLower(); if ($risky -contains $n) { $cats.Add('program or script files (.' + $n + ')') } }
  $engines = @('powershell.exe', 'pwsh.exe', 'cmd.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe', 'regsvr32.exe')
  foreach ($q in $procs) { $leaf = ([IO.Path]::GetFileName((([string]$q) -replace '/', '\'))).ToLower(); if ($engines -contains $leaf) { $cats.Add('a script or system program (' + $leaf + ')') } }
  @{ paths = [int]$paths.Count; extensions = [int]$exts.Count; processes = [int]$procs.Count; broad = @($cats | Select-Object -Unique | Select-Object -First 10) }
}

# Antivirus products registered in Windows Security Center (workstations only). productState is decoded by the server.
Probe 'securityCenter' 6000 {
  $items = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -Property displayName,productState -ErrorAction Stop)
  @{ products = @($items | Select-Object -First 10 | ForEach-Object { @{ name = Short ([string]$_.displayName) 100; state = [int64]$_.productState } }) }
}

# BitLocker per fixed drive. Only the TYPES of key protectors are read: no key id, recovery password or key is ever requested.
Probe 'bitlocker' 8000 {
  $fixed = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' } | ForEach-Object { $_.Name.Substring(0, 2).ToUpper() })
  $names = @{ 1 = 'TPM'; 2 = 'ExternalKey'; 3 = 'RecoveryPassword'; 4 = 'TPMAndPIN'; 5 = 'TPMAndStartupKey'; 6 = 'TPMAndPINAndStartupKey'; 7 = 'PublicKey'; 8 = 'Password'; 9 = 'TPMCertificate'; 10 = 'CryptoAPI' }
  $methods = @{ 0 = 'None'; 1 = 'AES128Diffuser'; 2 = 'AES256Diffuser'; 3 = 'AES128'; 4 = 'AES256'; 5 = 'Hardware'; 6 = 'XtsAes128'; 7 = 'XtsAes256' }
  $conv = @{ 0 = 'Decrypted'; 1 = 'Encrypted'; 2 = 'Encrypting'; 3 = 'Decrypting'; 4 = 'EncryptionPaused'; 5 = 'DecryptionPaused' }
  $vols = @()
  $detail = $true
  $why = $null
  try {
    $ns = 'root/CIMV2/Security/MicrosoftVolumeEncryption'
    $items = @(Get-CimInstance -Namespace $ns -ClassName Win32_EncryptableVolume -Property DriveLetter,ProtectionStatus -ErrorAction Stop)
    foreach ($v in $items) {
      $dl = ([string]$v.DriveLetter).ToUpper()
      if ($fixed -notcontains $dl) { continue }
      $prot = 'unknown'; if ($v.ProtectionStatus -eq 1) { $prot = 'on' } elseif ($v.ProtectionStatus -eq 0) { $prot = 'off' }
      $row = @{ drive = $dl; protection = $prot; percent = $null; method = $null; state = $null; protectors = @() }
      try { $c = Invoke-CimMethod -InputObject $v -MethodName GetConversionStatus -Arguments @{ PrecisionFactor = [uint32]0 } -ErrorAction Stop; $row.percent = [int]$c.EncryptionPercentage; $row.state = [string]$conv[[int]$c.ConversionStatus] } catch { }
      try { $m = Invoke-CimMethod -InputObject $v -MethodName GetEncryptionMethod -ErrorAction Stop; $row.method = [string]$methods[[int]$m.EncryptionMethod] } catch { }
      try {
        $k = Invoke-CimMethod -InputObject $v -MethodName GetKeyProtectors -Arguments @{ KeyProtectorType = [uint32]0 } -ErrorAction Stop
        $types = @()
        foreach ($id in @($k.VolumeKeyProtectorID)) {
          $t = Invoke-CimMethod -InputObject $v -MethodName GetKeyProtectorType -Arguments @{ VolumeKeyProtectorID = [string]$id } -ErrorAction Stop
          $n = [string]$names[[int]$t.KeyProtectorType]; if (-not $n) { $n = 'Other' }
          if ($types -notcontains $n) { $types += $n }
        }
        $row.protectors = @($types)
      } catch { }
      $vols += $row
    }
  } catch {
    # Without the right to read BitLocker, Windows still tells the shell whether a drive is protected (1 on, 2 off).
    $detail = $false
    $why = Short $_.Exception.Message 120
    $sh = New-Object -ComObject Shell.Application
    foreach ($dl in $fixed) {
      $p = $null
      try { $p = $sh.NameSpace($dl + '\').Self.ExtendedProperty('System.Volume.BitLockerProtection') } catch { }
      $prot = 'unknown'; if ($p -eq 1) { $prot = 'on' } elseif ($p -eq 2) { $prot = 'off' }
      $vols += @{ drive = $dl; protection = $prot; percent = $null; method = $null; state = $null; protectors = @() }
    }
  }
  $r = @{ volumes = @($vols | Select-Object -First 8); detail = $detail; systemDrive = [string]$env:SystemDrive }
  if ($why) { $r.reason = 'Detail not readable: ' + $why }
  $r
}

Probe 'firewall' 0 {
  $o = @{}
  foreach ($p in @(@('domain', 'DomainProfile'), @('private', 'StandardProfile'), @('public', 'PublicProfile'))) {
    $pol = RegV ('SOFTWARE\Policies\Microsoft\WindowsFirewall\' + $p[1]) 'EnableFirewall'
    $loc = RegV ('SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\' + $p[1]) 'EnableFirewall'
    $v = $loc; if ($null -ne $pol) { $v = $pol }
    if ($null -eq $v) { $o[$p[0]] = $null } else { $o[$p[0]] = ([int]$v -ne 0) }
  }
  try { $sc = New-Object System.ServiceProcess.ServiceController('mpssvc'); $o.serviceState = [string]$sc.Status } catch { $o.serviceState = 'Unknown' }
  if ($null -eq $o.domain -and $null -eq $o.private -and $null -eq $o.public) { return (Unknown 'The firewall settings are not in the registry.') }
  $o
}

Probe 'uac' 0 {
  $k = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  $lua = RegV $k 'EnableLUA'
  if ($null -eq $lua) { return (Unknown 'EnableLUA is not set.') }
  $prompt = RegV $k 'ConsentPromptBehaviorAdmin'
  $secure = RegV $k 'PromptOnSecureDesktop'
  $o = @{ enabled = ([int]$lua -ne 0); adminPrompt = $null; secureDesktop = $null }
  if ($null -ne $prompt) { $o.adminPrompt = [int]$prompt }
  if ($null -ne $secure) { $o.secureDesktop = ([int]$secure -ne 0) }
  $o
}

Probe 'secureBoot' 0 {
  $st = RegV 'SYSTEM\CurrentControlSet\Control\SecureBoot\State' 'UEFISecureBootEnabled'
  if ($null -eq $st) { return @{ supported = $false; enabled = $false } }
  @{ supported = $true; enabled = ([int]$st -eq 1) }
}

# Get-Tpm needs administrator rights: as SYSTEM it works, as a standard user it prints nothing.
Probe 'tpm' 6000 {
  $t = Get-Tpm
  if ($null -eq $t -or $null -eq $t.TpmPresent) { return (Unknown 'The TPM can only be read with administrator rights.') }
  @{ present = [bool]$t.TpmPresent; ready = [bool]$t.TpmReady; enabled = [bool]$t.TpmEnabled; activated = [bool]$t.TpmActivated }
}

Probe 'autoLogon' 0 {
  $k = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  $v = [string](RegV $k 'AutoAdminLogon')
  $u = ''; if ($v -eq '1') { $u = Short ([string](RegV $k 'DefaultUserName')) 60 }
  # DefaultPassword is never read.
  @{ enabled = ($v -eq '1'); user = $u }
}

# Local accounts and the Administrators group, by well known SIDs (the names change with the Windows language).
Probe 'accounts' 8000 {
  $comp = [ADSI]('WinNT://' + $env:COMPUTERNAME)
  $o = @{ builtinAdminEnabled = $null; builtinAdminName = ''; guestEnabled = $null }
  foreach ($u in @($comp.Children | Where-Object { $_.SchemaClassName -eq 'User' })) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($u.objectSid.Value, 0)
    $rid = [int]($sid.Value.Split('-')[-1])
    $disabled = (([int]$u.UserFlags.Value -band 2) -ne 0)
    if ($rid -eq 500) { $o.builtinAdminEnabled = (-not $disabled); $o.builtinAdminName = Short ([string]$u.Name) 60 }
    if ($rid -eq 501) { $o.guestEnabled = (-not $disabled) }
  }
  $adm = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $gname = $adm.Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
  $g = [ADSI]('WinNT://./' + $gname + ',group')
  $names = @()
  foreach ($m in @($g.Invoke('Members'))) {
    $e = New-Object System.DirectoryServices.DirectoryEntry($m)
    $parts = ([string]$e.Path -replace '^WinNT://', '').Split('/')
    $n = $parts[-1]; if ($parts.Count -ge 2) { $n = $parts[-2] + '\' + $parts[-1] }
    $names += (Short $n 80)
  }
  $o.adminCount = $names.Count
  $o.adminNames = @($names | Select-Object -First 20)
  $o
}

Probe 'smb1' 6000 {
  $v = RegV 'SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters' 'SMB1'
  if ($null -ne $v) { return @{ enabled = ([int]$v -ne 0); source = 'registry' } }
  $c = Get-SmbServerConfiguration -ErrorAction Stop
  @{ enabled = [bool]$c.EnableSMB1Protocol; source = 'smb' }
}

Probe 'rdp' 0 {
  $ts = 'SYSTEM\CurrentControlSet\Control\Terminal Server'
  $pol = 'SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
  $deny = RegV $pol 'fDenyTSConnections'; if ($null -eq $deny) { $deny = RegV $ts 'fDenyTSConnections' }
  if ($null -eq $deny) { return (Unknown 'The Remote Desktop setting is not in the registry.') }
  $nla = RegV $pol 'UserAuthentication'; if ($null -eq $nla) { $nla = RegV ($ts + '\WinStations\RDP-Tcp') 'UserAuthentication' }
  $o = @{ enabled = ([int]$deny -eq 0); nlaRequired = $null }
  if ($null -ne $nla) { $o.nlaRequired = ([int]$nla -ne 0) }
  $o
}

Probe 'screenLock' 0 {
  $sys = RegV 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'InactivityTimeoutSecs'
  $users = @()
  $hk = [Microsoft.Win32.Registry]::Users
  foreach ($sn in @($hk.GetSubKeyNames() | Where-Object { $_ -match '^S-1-5-21-[0-9-]+$' } | Select-Object -First 10)) {
    $vals = @{}
    foreach ($sub in @('Control Panel\Desktop', 'Software\Policies\Microsoft\Windows\Control Panel\Desktop')) {
      $k = $hk.OpenSubKey($sn + '\' + $sub)
      if ($k) { foreach ($n in 'ScreenSaveActive', 'ScreenSaverIsSecure', 'ScreenSaveTimeOut') { $x = $k.GetValue($n, $null); if ($null -ne $x) { $vals[$n] = [string]$x } }; $k.Close() }
    }
    $t = 0; [void][int]::TryParse([string]$vals['ScreenSaveTimeOut'], [ref]$t)
    $tv = $null; if ($t -gt 0) { $tv = $t }
    $users += @{ secure = (($vals['ScreenSaveActive'] -eq '1') -and ($vals['ScreenSaverIsSecure'] -eq '1')); timeoutSecs = $tv }
  }
  $iv = $null; if ($null -ne $sys) { $iv = [int]$sys }
  @{ inactivityTimeoutSecs = $iv; users = @($users) }
}

# net accounts prints its lines in a fixed order in every language; only the numbers are read.
Probe 'passwordPolicy' 5000 {
  $lines = @(net accounts 2>$null)
  if ($lines.Count -lt 8) { return (Unknown 'net accounts gave no answer.') }
  # Words such as Never or Unlimited are not numbers: they stay empty, which means no limit.
  function Num($i) { $t = [string]$lines[$i]; $v = ($t.Substring($t.LastIndexOf(':') + 1)).Trim(); $n = 0; if ([int]::TryParse(($v -split '\s+')[0], [ref]$n)) { return $n }; return $null }
  @{ minLength = (Num 3); maxAgeDays = (Num 2); historyCount = (Num 4); lockoutThreshold = (Num 5); lockoutMinutes = (Num 6) }
}

Probe 'reboot' 0 {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
  $cbs = $null -ne ($base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'))
  $wu = $null -ne ($base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'))
  $ren = $null -ne (RegV 'SYSTEM\CurrentControlSet\Control\Session Manager' 'PendingFileRenameOperations')
  @{ pending = ($cbs -or $wu); servicing = $cbs; windowsUpdate = $wu; fileRename = $ren }
}

# The Windows Update history, without the Defender definition updates that arrive every day.
Probe 'lastUpdate' 8000 {
  $u = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
  $best = $null
  foreach ($e in @($u.QueryHistory(0, 60))) {
    if ($e.Operation -ne 1 -or $e.ResultCode -ne 2) { continue }
    if ([string]$e.Title -match 'Security Intelligence|Definition Update|Malicious Software Removal') { continue }
    if ($null -eq $best -or $e.Date -gt $best) { $best = $e.Date }
  }
  if ($null -eq $best) { return (Unknown 'No installed Windows update is recorded in the update history.') }
  $best = [datetime]::SpecifyKind($best, [DateTimeKind]::Utc)
  @{ at = (Iso $best); ageDays = (Days $best) }
}

Out-Riq @{ ok = $true; v = 1; ms = [int]$T0.ElapsedMilliseconds; probes = $probes }
`;

const PS_HEAD = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function ConvertTo-Ascii([string]$s) {
  $bs = [string][char]92
  return [regex]::Replace($s, '[^\x00-\x7F]', { param($m) $bs + 'u' + ('{0:x4}' -f [int][char]$m.Value) })
}
function Out-Riq($obj) { [Console]::Out.Write((ConvertTo-Ascii ($obj | ConvertTo-Json -Compress -Depth 4))) }
function Fail($e) { Out-Riq @{ ok = $false; error = [string]$e.Exception.Message } }
`;

const psc = (body: string) => `${PS_HEAD}try {\n${body}\n} catch { Fail $_ }\n`;

export type DefenderAction = "update" | "quick-scan" | "full-scan";
export const DEFENDER_ACTIONS: DefenderAction[] = ["update", "quick-scan", "full-scan"];
/** The tool kind (RIQ_TOOL) each action's job carries. */
export const DEFENDER_KIND: Record<DefenderAction, string> = { update: "security.defender.update", "quick-scan": "security.defender.quick-scan", "full-scan": "security.defender.full-scan" };

export const DEFENDER_SCRIPTS = {
    // Update-MpSignature waits for the download, which can take a minute: the answer may arrive after the first wait (pending).
    update: psc(String.raw`$before = [string](Get-MpComputerStatus).AntivirusSignatureVersion
Update-MpSignature
$s = Get-MpComputerStatus
$at = $s.AntivirusSignatureLastUpdated
$iso = $null; if ($at -and $at.ToUniversalTime().Year -ge 2000) { $iso = $at.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
Out-Riq @{ ok = $true; action = 'update'; before = $before; after = [string]$s.AntivirusSignatureVersion; updatedAt = $iso }`),

    // A scan takes minutes to hours, so it is started in a process Windows creates on its own (Win32_Process.Create: it outlives
    // this job, which ends at once). RIQ_SCAN_TYPE is QuickScan or FullScan (checked on the server and again here); the two command
    // lines are fixed text.
    scan: psc(String.raw`$type = $env:RIQ_SCAN_TYPE
if ($type -ne 'QuickScan' -and $type -ne 'FullScan') { throw 'Unknown scan type.' }
$s = Get-MpComputerStatus
if (-not $s.AMServiceEnabled) { throw 'Microsoft Defender is not running on this device, so it cannot scan.' }
$exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if ($type -eq 'FullScan') { $cmd = '"' + $exe + '" -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-MpScan -ScanType FullScan"' }
else { $cmd = '"' + $exe + '" -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-MpScan -ScanType QuickScan"' }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($r.ReturnValue -ne 0) { throw ('Windows could not start the scan (code ' + $r.ReturnValue + ').') }
Out-Riq @{ ok = $true; action = 'scan'; scanType = $type; started = $true }`),
};

export const SCAN_TYPES = { "quick-scan": "QuickScan", "full-scan": "FullScan" } as const;

export type DefenderUpdateResult = { before: string; after: string; updatedAt: string | null; changed: boolean };
export type DefenderScanResult = { scanType: "QuickScan" | "FullScan"; started: true };

export function parseDefenderUpdate(stdout: string, stderr: string): DefenderUpdateResult {
    const p = parseWindowsJson(stdout, stderr);
    const before = clean(p.before, 40);
    const after = clean(p.after, 40);
    return { before, after, updatedAt: isoOrNull(p.updatedAt), changed: !!after && before !== after };
}

export function parseDefenderScan(stdout: string, stderr: string): DefenderScanResult {
    const p = parseWindowsJson(stdout, stderr);
    if ((p.scanType !== "QuickScan" && p.scanType !== "FullScan") || p.started !== true) throw new ToolOutputError("The device did not say that the scan started.");
    return { scanType: p.scanType, started: true };
}

/* ------------------------------ what a scan prints ------------------------------ */

export interface OsData { productName: string; displayVersion: string; build: number; ubr: number; editionId: string; installationType: string }
export interface DefenderData {
    serviceState: string; antivirusEnabled: boolean; realTimeProtection: boolean; tamperProtected: boolean; runningMode: string; productVersion: string;
    signatureVersion: string; signatureUpdated: string | null; signatureAgeDays: number | null;
    quickScanAt: string | null; quickScanAgeDays: number | null; fullScanAt: string | null; fullScanAgeDays: number | null;
    threatCount: number; threatsUnknown: boolean; threats: string[];
}
export interface DefenderExclusionsData { paths: number; extensions: number; processes: number; broad: string[] }
export interface SecurityCenterData { products: { name: string; state: number }[] }
export interface BitLockerVolume { drive: string; protection: "on" | "off" | "unknown"; percent: number | null; method: string | null; state: string | null; protectors: string[] }
export interface BitLockerData { detail: boolean; systemDrive: string; volumes: BitLockerVolume[]; note: string | null }
export interface FirewallData { domain: boolean | null; private: boolean | null; public: boolean | null; serviceState: string }
export interface UacData { enabled: boolean; adminPrompt: number | null; secureDesktop: boolean | null }
export interface SecureBootData { supported: boolean; enabled: boolean }
export interface TpmData { present: boolean; ready: boolean; enabled: boolean; activated: boolean }
export interface AutoLogonData { enabled: boolean; user: string }
export interface AccountsData { builtinAdminEnabled: boolean | null; builtinAdminName: string; guestEnabled: boolean | null; adminCount: number; adminNames: string[] }
export interface Smb1Data { enabled: boolean; source: string }
export interface RdpData { enabled: boolean; nlaRequired: boolean | null }
export interface ScreenLockData { inactivityTimeoutSecs: number | null; users: { secure: boolean; timeoutSecs: number | null }[] }
export interface PasswordPolicyData { minLength: number | null; maxAgeDays: number | null; historyCount: number | null; lockoutThreshold: number | null; lockoutMinutes: number | null }
export interface RebootData { pending: boolean; servicing: boolean; windowsUpdate: boolean; fileRename: boolean }
export interface LastUpdateData { at: string | null; ageDays: number | null }

export interface ProbeData {
    os: OsData; defender: DefenderData; defenderExclusions: DefenderExclusionsData; securityCenter: SecurityCenterData; bitlocker: BitLockerData; firewall: FirewallData; uac: UacData;
    secureBoot: SecureBootData; tpm: TpmData; autoLogon: AutoLogonData; accounts: AccountsData; smb1: Smb1Data; rdp: RdpData;
    screenLock: ScreenLockData; passwordPolicy: PasswordPolicyData; reboot: RebootData; lastUpdate: LastUpdateData;
}
export type ProbeName = keyof ProbeData;
export type Probe<K extends ProbeName> = ({ status: "ok"; ms: number } & ProbeData[K]) | { status: "unknown"; ms: number; reason: string };
export type Probes = { [K in ProbeName]: Probe<K> };
export type ScanData = { v: 1; ms: number; probes: Probes };

export const PROBE_NAMES: ProbeName[] = ["os", "defender", "defenderExclusions", "securityCenter", "bitlocker", "firewall", "uac", "secureBoot", "tpm", "autoLogon", "accounts", "smb1", "rdp", "screenLock", "passwordPolicy", "reboot", "lastUpdate"];

/* ------------------------------ checking what a device printed ------------------------------ */

const MAX_OUTPUT_CHARS = 200_000;
const CONTROL = /[\u0000-\u001f\u007f]/g;
class Bad extends Error { }

function clean(v: unknown, max: number): string {
    return typeof v === "string" ? v.replace(CONTROL, " ").trim().slice(0, max) : "";
}
function reqBool(v: unknown, what: string): boolean {
    if (typeof v !== "boolean") throw new Bad(`${what} is not on or off`);
    return v;
}
function optBool(v: unknown): boolean | null {
    return typeof v === "boolean" ? v : null;
}
function int(v: unknown, min: number, max: number): number | null {
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}
function reqInt(v: unknown, min: number, max: number, what: string): number {
    const n = int(v, min, max);
    if (n === null) throw new Bad(`${what} is not a valid number`);
    return n;
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function isoOrNull(v: unknown): string | null {
    if (typeof v !== "string" || !ISO.test(v)) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t < Date.UTC(2100, 0, 1) ? v : null;
}
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
/** Days are never negative (a clock a little ahead on the device would otherwise give -1). */
const days = (v: unknown) => { const n = int(v, -1, 100_000); return n === null ? null : Math.max(0, n); };

const DRIVE = /^[A-Za-z]:$/;
const PROTECTORS = new Set(["TPM", "ExternalKey", "RecoveryPassword", "TPMAndPIN", "TPMAndStartupKey", "TPMAndPINAndStartupKey", "PublicKey", "Password", "TPMCertificate", "CryptoAPI", "Other"]);
const METHODS = new Set(["None", "AES128Diffuser", "AES256Diffuser", "AES128", "AES256", "Hardware", "XtsAes128", "XtsAes256"]);
const CONVERSION = new Set(["Decrypted", "Encrypted", "Encrypting", "Decrypting", "EncryptionPaused", "DecryptionPaused"]);

const CLEANERS: { [K in ProbeName]: (o: Record<string, unknown>) => ProbeData[K] } = {
    os: (o) => ({
        productName: clean(o.productName, 100), displayVersion: clean(o.displayVersion, 20), build: reqInt(o.build, 1, 1_000_000, "The Windows build"),
        ubr: int(o.ubr, 0, 1_000_000) ?? 0, editionId: clean(o.editionId, 60), installationType: clean(o.installationType, 20),
    }),
    defender: (o) => ({
        serviceState: clean(o.serviceState, 30), antivirusEnabled: reqBool(o.antivirusEnabled, "antivirusEnabled"), realTimeProtection: reqBool(o.realTimeProtection, "realTimeProtection"),
        tamperProtected: reqBool(o.tamperProtected, "tamperProtected"), runningMode: clean(o.runningMode, 40), productVersion: clean(o.productVersion, 40),
        signatureVersion: clean(o.signatureVersion, 40), signatureUpdated: isoOrNull(o.signatureUpdated), signatureAgeDays: days(o.signatureAgeDays),
        quickScanAt: isoOrNull(o.quickScanAt), quickScanAgeDays: days(o.quickScanAgeDays), fullScanAt: isoOrNull(o.fullScanAt), fullScanAgeDays: days(o.fullScanAgeDays),
        threatCount: reqInt(o.threatCount, 0, 1_000_000, "The threat count"), threatsUnknown: o.threatsUnknown === true,
        threats: arr(o.threats, 10).map((t) => clean(t, 100)).filter(Boolean),
    }),
    defenderExclusions: (o) => ({
        paths: reqInt(o.paths, 0, 100_000, "The path exclusion count"), extensions: reqInt(o.extensions, 0, 100_000, "The extension exclusion count"), processes: reqInt(o.processes, 0, 100_000, "The process exclusion count"),
        // Only these exact kinds are accepted: nothing else the device sends (such as a path) is kept.
        broad: arr(o.broad, 10).map((c) => clean(c, 80)).filter((c) => /^(a whole drive|a system folder|a whole user profile|a temp or downloads folder|program or script files \(\.[a-z0-9]{1,5}\)|a script or system program \([a-z0-9._-]{1,30}\))$/.test(c)),
    }),
    securityCenter: (o) => ({
        products: arr(o.products, 10).flatMap((p) => {
            if (!p || typeof p !== "object") return [];
            const r = p as Record<string, unknown>;
            const name = clean(r.name, 100);
            const state = int(r.state, 0, 0xffffff);
            return name && state !== null ? [{ name, state }] : [];
        }),
    }),
    bitlocker: (o) => ({
        detail: o.detail === true,
        systemDrive: DRIVE.test(String(o.systemDrive ?? "")) ? String(o.systemDrive).toUpperCase() : "",
        note: clean(o.reason, 200) || null,
        volumes: arr(o.volumes, 8).flatMap((v): BitLockerVolume[] => {
            if (!v || typeof v !== "object") return [];
            const r = v as Record<string, unknown>;
            if (typeof r.drive !== "string" || !DRIVE.test(r.drive)) return [];
            const protection: BitLockerVolume["protection"] = r.protection === "on" || r.protection === "off" ? r.protection : "unknown";
            const method = typeof r.method === "string" && METHODS.has(r.method) ? r.method : null;
            const state = typeof r.state === "string" && CONVERSION.has(r.state) ? r.state : null;
            const protectors = [...new Set(arr(r.protectors, 10).filter((p): p is string => typeof p === "string" && PROTECTORS.has(p)))];
            return [{ drive: r.drive.toUpperCase(), protection, percent: int(r.percent, 0, 100), method, state, protectors }];
        }),
    }),
    firewall: (o) => {
        const f = { domain: optBool(o.domain), private: optBool(o.private), public: optBool(o.public), serviceState: clean(o.serviceState, 30) };
        if (f.domain === null && f.private === null && f.public === null) throw new Bad("no firewall profile was reported");
        return f;
    },
    uac: (o) => ({ enabled: reqBool(o.enabled, "enabled"), adminPrompt: int(o.adminPrompt, 0, 10), secureDesktop: optBool(o.secureDesktop) }),
    secureBoot: (o) => ({ supported: reqBool(o.supported, "supported"), enabled: reqBool(o.enabled, "enabled") }),
    tpm: (o) => ({ present: reqBool(o.present, "present"), ready: reqBool(o.ready, "ready"), enabled: o.enabled === true, activated: o.activated === true }),
    autoLogon: (o) => ({ enabled: reqBool(o.enabled, "enabled"), user: clean(o.user, 60) }),
    accounts: (o) => ({
        builtinAdminEnabled: optBool(o.builtinAdminEnabled), builtinAdminName: clean(o.builtinAdminName, 60), guestEnabled: optBool(o.guestEnabled),
        adminCount: reqInt(o.adminCount, 0, 100_000, "The administrator count"), adminNames: arr(o.adminNames, 20).map((n) => clean(n, 80)).filter(Boolean),
    }),
    smb1: (o) => ({ enabled: reqBool(o.enabled, "enabled"), source: o.source === "registry" ? "registry" : "smb" }),
    rdp: (o) => ({ enabled: reqBool(o.enabled, "enabled"), nlaRequired: optBool(o.nlaRequired) }),
    screenLock: (o) => ({
        inactivityTimeoutSecs: int(o.inactivityTimeoutSecs, 0, 31_536_000),
        users: arr(o.users, 10).flatMap((u) => (u && typeof u === "object" ? [{ secure: (u as any).secure === true, timeoutSecs: int((u as any).timeoutSecs, 1, 31_536_000) }] : [])),
    }),
    passwordPolicy: (o) => ({
        minLength: int(o.minLength, 0, 128), maxAgeDays: int(o.maxAgeDays, 0, 100_000), historyCount: int(o.historyCount, 0, 1000),
        lockoutThreshold: int(o.lockoutThreshold, 0, 1000), lockoutMinutes: int(o.lockoutMinutes, 0, 1_000_000),
    }),
    reboot: (o) => ({ pending: reqBool(o.pending, "pending"), servicing: o.servicing === true, windowsUpdate: o.windowsUpdate === true, fileRename: o.fileRename === true }),
    lastUpdate: (o) => ({ at: isoOrNull(o.at), ageDays: days(o.ageDays) }),
};

/** What a finished scan job printed, checked. Throws ToolOutputError when there is no usable answer at all. */
export function parseSecurityScan(stdout: string, stderr: string): ScanData {
    if (String(stdout ?? "").length > MAX_OUTPUT_CHARS) throw new ToolOutputError("The device's answer was far larger than expected and was ignored.");
    const parsed = parseWindowsJson(stdout, stderr);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.probes || typeof parsed.probes !== "object" || Array.isArray(parsed.probes)) {
        throw new ToolOutputError("The device's answer was not a security scan.");
    }
    const raw = parsed.probes as Record<string, unknown>;
    const probes: Record<string, unknown> = {};
    for (const name of PROBE_NAMES) {
        const entry = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : undefined;
        const ms = (entry && typeof entry === "object" ? int((entry as any).ms, 0, 3_600_000) : null) ?? 0;
        let unknown = "The device did not report this check.";
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const e = entry as Record<string, unknown>;
            if (e.status === "ok") {
                try {
                    probes[name] = { status: "ok", ms, ...(CLEANERS[name] as (o: Record<string, unknown>) => object)(e) };
                    continue;
                } catch (err) {
                    unknown = err instanceof Bad ? `The device sent an unexpected answer for this check (${err.message}).` : "The device sent an unexpected answer for this check.";
                }
            } else if (e.status === "unknown") {
                unknown = clean(e.reason, 200) || "The device could not read this.";
            }
        }
        probes[name] = { status: "unknown", ms, reason: unknown };
    }
    return { v: 1, ms: int(parsed.ms, 0, 3_600_000) ?? 0, probes: probes as Probes };
}

/* ------------------------------ Windows Security Center ------------------------------ */

export type ProductState = { state: "on" | "off" | "snoozed" | "expired" | "unknown"; upToDate: boolean | null };

/**
 * Decodes the productState of an AntiVirusProduct of root\SecurityCenter2: the second hex digit from the right is whether the product
 * is on (1), off (0), snoozed (2) or expired (3); the next one says whether its definitions are up to date (0) or out of date (1).
 * 0x061000 is Windows Defender on and up to date, 0x061010 on and out of date, 0x041000 a third-party product on and up to date.
 */
export function decodeProductState(n: unknown): ProductState {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 0xffffff) return { state: "unknown", upToDate: null };
    const product = (n >> 12) & 0xf;
    const sig = (n >> 4) & 0xf;
    return {
        state: product === 1 ? "on" : product === 0 ? "off" : product === 2 ? "snoozed" : product === 3 ? "expired" : "unknown",
        upToDate: sig === 0 ? true : sig === 1 ? false : null,
    };
}

export const isDefenderName = (name: string) => /^(microsoft|windows) defender/i.test(name.trim());

/* ------------------------------ Windows support dates ------------------------------ */

export type SupportRow = { build: number; name: string; /** Home and Pro (client) or the one date (server). */ ends: string; /** Enterprise and Education, when it differs. */ endsEnterprise?: string; ltsc?: string };

/**
 * End of support by Windows build: DATA THE SERVER OWNS, from Microsoft's lifecycle pages (the date after which a build gets no
 * more security updates). Paid Extended Security Updates are not modelled. A build that is not in these tables is "unknown", never
 * guessed. Edit the tables here when Microsoft publishes a new date.
 */
export const CLIENT_SUPPORT: SupportRow[] = [
    { build: 7601, name: "Windows 7 SP1", ends: "2020-01-14" },
    { build: 9600, name: "Windows 8.1", ends: "2023-01-10" },
    { build: 10240, name: "Windows 10 1507", ends: "2017-05-09" },
    { build: 10586, name: "Windows 10 1511", ends: "2017-10-10" },
    { build: 14393, name: "Windows 10 1607", ends: "2018-04-10", endsEnterprise: "2019-04-09", ltsc: "2026-10-13" },
    { build: 15063, name: "Windows 10 1703", ends: "2018-10-09", endsEnterprise: "2019-10-08" },
    { build: 16299, name: "Windows 10 1709", ends: "2019-04-09", endsEnterprise: "2020-10-13" },
    { build: 17134, name: "Windows 10 1803", ends: "2019-11-12", endsEnterprise: "2021-05-11" },
    { build: 17763, name: "Windows 10 1809", ends: "2020-11-10", endsEnterprise: "2021-05-11", ltsc: "2029-01-09" },
    { build: 18362, name: "Windows 10 1903", ends: "2020-12-08" },
    { build: 18363, name: "Windows 10 1909", ends: "2021-05-11", endsEnterprise: "2022-05-10" },
    { build: 19041, name: "Windows 10 2004", ends: "2021-12-14" },
    { build: 19042, name: "Windows 10 20H2", ends: "2022-05-10", endsEnterprise: "2023-05-09" },
    { build: 19043, name: "Windows 10 21H1", ends: "2022-12-13" },
    { build: 19044, name: "Windows 10 21H2", ends: "2023-06-13", endsEnterprise: "2024-06-11", ltsc: "2027-01-12" },
    { build: 19045, name: "Windows 10 22H2", ends: "2025-10-14" },
    { build: 22000, name: "Windows 11 21H2", ends: "2023-10-10", endsEnterprise: "2024-10-08" },
    { build: 22621, name: "Windows 11 22H2", ends: "2024-10-08", endsEnterprise: "2025-10-14" },
    { build: 22631, name: "Windows 11 23H2", ends: "2025-11-11", endsEnterprise: "2026-11-10" },
    { build: 26100, name: "Windows 11 24H2", ends: "2026-10-13", endsEnterprise: "2027-10-12", ltsc: "2029-10-09" },
    { build: 26200, name: "Windows 11 25H2", ends: "2027-10-12", endsEnterprise: "2028-10-10" },
];
export const SERVER_SUPPORT: SupportRow[] = [
    { build: 7601, name: "Windows Server 2008 R2", ends: "2020-01-14" },
    { build: 9200, name: "Windows Server 2012", ends: "2023-10-10" },
    { build: 9600, name: "Windows Server 2012 R2", ends: "2023-10-10" },
    { build: 14393, name: "Windows Server 2016", ends: "2027-01-12" },
    { build: 17763, name: "Windows Server 2019", ends: "2029-01-09" },
    { build: 20348, name: "Windows Server 2022", ends: "2031-10-14" },
    { build: 26100, name: "Windows Server 2025", ends: "2034-11-14" },
];

export type OsSupport = { status: "supported" | "ending" | "ended" | "unknown"; name: string; endsOn: string | null; daysLeft: number | null };
const ENDING_SOON_DAYS = 90;
const LTSC_EDITION = /EnterpriseS($|N$)|IoTEnterpriseS|EnterpriseG/i;
const ENTERPRISE_EDITION = /enterprise|education/i;

/** Whether this Windows build still gets security updates, from the table above. */
export function osSupport(os: Pick<OsData, "build" | "editionId" | "installationType" | "productName">, now: Date = new Date()): OsSupport {
    const server = /server/i.test(os.installationType) || /server/i.test(os.productName);
    const row = (server ? SERVER_SUPPORT : CLIENT_SUPPORT).find((r) => r.build === os.build);
    if (!row) return { status: "unknown", name: os.productName || `Windows build ${os.build}`, endsOn: null, daysLeft: null };
    let ends = row.ends;
    if (!server) {
        if (LTSC_EDITION.test(os.editionId) && row.ltsc) ends = row.ltsc;
        else if (ENTERPRISE_EDITION.test(os.editionId) && row.endsEnterprise) ends = row.endsEnterprise;
    }
    // support ends at the end of that day
    const endMs = Date.parse(`${ends}T23:59:59Z`);
    const daysLeft = Math.floor((endMs - now.getTime()) / 86_400_000);
    return { status: endMs < now.getTime() ? "ended" : daysLeft <= ENDING_SOON_DAYS ? "ending" : "supported", name: row.name, endsOn: ends, daysLeft };
}
