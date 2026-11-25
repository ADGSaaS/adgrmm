// backend/src/auto-repair/auto-repair.scripts.ts
//
// The two scripts the automatic repair runs on a Windows computer (as the agent's own signed script jobs). Both are fixed text: what to look at
// or repair comes in as environment variables (RIQ_CHECKS, RIQ_APP, RIQ_FIX), never pasted into the script. The first only reads. The second
// only does what is written here for the problems it is asked about, and says for each one whether it worked.
// With RIQ_DRYRUN=1 the repair changes nothing and says what it would have done (used by the tests).

export const DIAGNOSE_KIND = "auto-repair.diagnose";
export const REPAIR_KIND = "auto-repair.repair";

export const DIAGNOSE_SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$checks = @(($env:RIQ_CHECKS -split ',') | ForEach-Object { $_.Trim() })
function Clean([string]$s) { if ($null -eq $s) { return '' }; $t = ($s -replace '[\r\n\|]', ' ').Trim(); if ($t.Length -gt 300) { $t = $t.Substring(0, 300) }; return $t }
function Issue([string]$id, [string]$detail) { Write-Output ('ISSUE ' + $id + '|' + (Clean $detail)) }
function Info([string]$k, [string]$v) { Write-Output ('INFO ' + $k + '|' + (Clean $v)) }
function Reach([string]$h, [int]$port, [int]$ms) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $r = $c.BeginConnect($h, $port, $null, $null); $ok = $r.AsyncWaitHandle.WaitOne($ms, $false) -and $c.Connected; $c.Close(); return $ok } catch { return $false }
}
function CrashHits([string[]]$names) {
  if ($names.Count -eq 0) { return @() }
  # a repair cannot remove what is already in the event log, so when the checks run again to confirm a repair, only crashes AFTER the repair count (RIQ_SINCE)
  $from = (Get-Date).AddDays(-7)
  if ($env:RIQ_SINCE) { try { $s = [datetimeoffset]::Parse($env:RIQ_SINCE).LocalDateTime; if ($s -gt $from) { $from = $s } } catch { } }
  return @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1002; StartTime = $from } -MaxEvents 500 | Where-Object { $m = $_.Message; ($names | Where-Object { $m -like ('*' + $_ + '*') }).Count -gt 0 })
}

Info 'host' $env:COMPUTERNAME
if ($env:RIQ_SINCE) { Info 'counting_crashes_since' $env:RIQ_SINCE }
$upDays = 0
try { $os = Get-CimInstance Win32_OperatingSystem; $upDays = [int]((Get-Date) - $os.LastBootUpTime).TotalDays; Info 'uptime_days' $upDays } catch { }

if ($checks -contains 'disk') {
  $d = Get-PSDrive -Name C
  if ($d) {
    $free = [math]::Round($d.Free / 1GB, 1); $total = [math]::Round(($d.Used + $d.Free) / 1GB, 1)
    Info 'disk_free_gb' $free
    if ($free -lt 10 -or ($total -gt 0 -and ($free / $total) -lt 0.10)) { Issue 'low-disk' ('Only ' + $free + ' GB free of ' + $total + ' GB on C:') }
  }
}

if ($checks -contains 'reboot') {
  $pending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
  if ($pending) { Issue 'pending-reboot' 'Windows is waiting for a restart' }
  elseif ($upDays -ge 30) { Issue 'pending-reboot' ('The computer has not been restarted for ' + $upDays + ' days') }
}

if ($checks -contains 'cpu') {
  $skip = @('Idle', 'System', '_Total', 'Memory Compression', 'Registry')
  $a = @{}; Get-Process | Where-Object { $skip -notcontains $_.ProcessName } | ForEach-Object { $a[$_.Id] = $_.TotalProcessorTime.TotalSeconds }
  Start-Sleep -Seconds 3
  $cores = [Environment]::ProcessorCount; $top = $null; $topPct = 0
  Get-Process | Where-Object { $skip -notcontains $_.ProcessName } | ForEach-Object { if ($a.ContainsKey($_.Id)) { $pct = (($_.TotalProcessorTime.TotalSeconds - $a[$_.Id]) / 3 / $cores) * 100; if ($pct -gt $topPct) { $topPct = $pct; $top = $_.ProcessName } } }
  Info 'busiest_program' ($top + ' ' + [math]::Round($topPct) + '% of the processor')
  if ($topPct -ge 60) { Issue 'high-cpu-process' ($top + ' is using ' + [math]::Round($topPct) + '% of the processor') }
}

if ($checks -contains 'printing') {
  $svc = Get-Service -Name Spooler
  if ($svc) {
    Info 'spooler' $svc.Status
    if ($svc.Status -ne 'Running') { Issue 'spooler-stopped' ('The Print Spooler service is ' + $svc.Status) }
    else {
      $old = @(Get-ChildItem 'C:\Windows\System32\spool\PRINTERS' -File -Force | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-10) })
      if ($old.Count -gt 0) { Issue 'spooler-stuck-jobs' ([string]$old.Count + ' print job file(s) have been waiting for over 10 minutes') }
    }
  }
}

$gatewayOk = $true; $internetOk = $true
if ($checks -contains 'network') {
  $cfg = @(Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address })
  if ($cfg.Count -eq 0) { Issue 'no-ip-address' 'No connected network adapter has an address'; $gatewayOk = $false; $internetOk = $false }
  else {
    $bad = @($cfg | Where-Object { $_.IPv4Address.IPAddress -like '169.254.*' })
    if ($bad.Count -gt 0) { Issue 'no-ip-address' ('The adapter ' + $bad[0].InterfaceAlias + ' has the address ' + $bad[0].IPv4Address.IPAddress + ' instead of one from the network'); $gatewayOk = $false; $internetOk = $false }
    else {
      $gw = @($cfg | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4DefaultGateway.NextHop })
      Info 'gateway' ($gw -join ' ')
      if ($gw.Count -eq 0) { Issue 'gateway-unreachable' 'There is no default gateway'; $gatewayOk = $false; $internetOk = $false }
      elseif (-not (Test-Connection -ComputerName $gw[0] -Count 2 -Quiet)) { Issue 'gateway-unreachable' ('The router ' + $gw[0] + ' does not answer'); $gatewayOk = $false; $internetOk = $false }
    }
  }
  $dns = Get-Service -Name Dnscache
  if ($dns -and $dns.Status -ne 'Running') { Issue 'dns-client-stopped' ('The DNS Client service is ' + $dns.Status) }
  elseif ($gatewayOk) {
    $names = $null; try { $names = Resolve-DnsName -Name 'www.microsoft.com' -DnsOnly -QuickTimeout -ErrorAction Stop } catch { }
    if (-not $names) {
      if (Reach '1.1.1.1' 443 3000) { Issue 'dns-failing' 'Websites cannot be looked up, but the internet can be reached by address' } else { Issue 'no-internet' 'The router answers but the internet cannot be reached'; $internetOk = $false }
    }
  }
}

if ($checks -contains 'mail' -and $internetOk) {
  if (-not (Reach 'outlook.office365.com' 443 4000)) { if (Reach '1.1.1.1' 443 3000) { Issue 'mail-unreachable' 'outlook.office365.com does not answer on port 443' } }
}

if ($checks -contains 'outlook') {
  $hits = CrashHits @('OUTLOOK.EXE')
  Info 'outlook_crashes_7d' $hits.Count
  if ($hits.Count -ge 2) { Issue 'outlook-crashing' ('Outlook closed unexpectedly ' + $hits.Count + ' times in the last 7 days') }
}

if ($checks -contains 'time') {
  # what matters is how far the clock is from real time (sign-in breaks beyond about five minutes), not whether the Time service happens to be running
  $w = Get-Service -Name W32Time
  if ($w -and $w.Status -ne 'Running' -and $w.StartType -eq 'Automatic') { Issue 'time-not-synced' ('The Windows Time service is ' + $w.Status + ' but is set to start automatically') }
  $skew = $null
  try {
    $r = Invoke-WebRequest -Uri 'https://www.microsoft.com' -Method Head -UseBasicParsing -TimeoutSec 8
    $remote = [datetimeoffset]::Parse([string]($r.Headers['Date'] | Select-Object -First 1))
    $skew = [math]::Abs(((Get-Date).ToUniversalTime() - $remote.UtcDateTime).TotalSeconds)
  } catch { }
  if ($null -ne $skew) {
    Info 'clock_skew_seconds' ([math]::Round($skew))
    if ($skew -ge 300) { Issue 'time-not-synced' ('The clock is ' + [math]::Round($skew / 60, 1) + ' minutes away from real time') }
  }
  $cs = Get-CimInstance Win32_ComputerSystem
  if ($cs -and $cs.PartOfDomain) { $ok = $true; try { $ok = Test-ComputerSecureChannel } catch { }; if (-not $ok) { Issue 'secure-channel-broken' 'The secure channel to the domain is broken' } }
}

if ($checks -contains 'security') {
  $other = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct | Where-Object { $_.displayName -notmatch 'Defender' -and (($_.productState -shr 12) -band 0xF) -eq 1 })
  $mp = Get-MpComputerStatus
  if ($mp -and $other.Count -eq 0) {
    Info 'defender_signature_age_days' $mp.AntivirusSignatureAge
    if (-not $mp.RealTimeProtectionEnabled) { Issue 'defender-realtime-off' 'Real-time protection is off' }
    if ($mp.AntivirusSignatureAge -gt 7) { Issue 'defender-signatures-old' ('The virus definitions are ' + $mp.AntivirusSignatureAge + ' days old') }
  } elseif ($other.Count -gt 0) { Info 'antivirus' $other[0].displayName }
  $off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled } | ForEach-Object { $_.Name })
  if ($off.Count -gt 0) { Issue 'firewall-off' ('The firewall is off for: ' + ($off -join ', ')) }
}

if ($checks -contains 'hardware') {
  $bad = @(Get-PhysicalDisk | Where-Object { $_.HealthStatus -ne 'Healthy' })
  if ($bad.Count -gt 0) { Issue 'disk-unhealthy' ($bad[0].FriendlyName + ' reports ' + $bad[0].HealthStatus) }
  $dev = @(Get-PnpDevice -PresentOnly -Status Error)
  if ($dev.Count -gt 0) { Issue 'device-error' ([string]$dev.Count + ' device(s) with an error: ' + (($dev | Select-Object -First 3 | ForEach-Object { $_.FriendlyName }) -join ', ')) }
}

if ($checks -contains 'crash') {
  $app = [string]$env:RIQ_APP
  $names = @()
  if ($checks -contains 'teams') { $names = @('ms-teams.exe', 'Teams.exe') }
  else { $names = @(($app -split '[^A-Za-z0-9]+') | Where-Object { $_.Length -ge 4 -and $_ -notmatch '^(microsoft|windows|corporation|version|software|application|office)$' } | Select-Object -First 3) }
  $hits = CrashHits $names
  if ($names.Count -gt 0) { Info 'app_crashes_7d' $hits.Count }
  if ($hits.Count -gt 0) { Info 'last_crash' (($hits[0].Message -split "\r?\n")[0] + ' at ' + $hits[0].TimeCreated.ToString('yyyy-MM-dd HH:mm')) }
  if ($hits.Count -ge 2) { if ($checks -contains 'teams') { Issue 'teams-crashing' ('Teams closed unexpectedly ' + $hits.Count + ' times in the last 7 days') } else { Issue 'app-crashing' ($app + ' closed unexpectedly ' + $hits.Count + ' times in the last 7 days') } }
}
Write-Output 'DONE'
`;

export const REPAIR_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$dry = ($env:RIQ_DRYRUN -eq '1')
$custom = @{}
function Clean([string]$s) { if ($null -eq $s) { return '' }; $t = ($s -replace '[\r\n\|]', ' ').Trim(); if ($t.Length -gt 300) { $t = $t.Substring(0, 300) }; return $t }
function Fixed([string]$id, [string]$msg) { Write-Output ('FIXED ' + $id + '|' + (Clean $msg)) }
function Failed([string]$id, [string]$msg) { Write-Output ('FAILED ' + $id + '|' + (Clean $msg)) }
function Resolves() { try { return [bool](Resolve-DnsName -Name 'www.microsoft.com' -DnsOnly -QuickTimeout -ErrorAction Stop) } catch { return $false } }

foreach ($id in (($env:RIQ_FIX -split ',') | ForEach-Object { $_.Trim() })) {
  try {
    switch ($id) {
      'spooler-stopped' {
        if ($dry) { Fixed $id 'DRY RUN: would start the Print Spooler'; break }
        Set-Service -Name Spooler -StartupType Automatic
        Start-Service -Name Spooler
        Start-Sleep -Seconds 2
        if ((Get-Service -Name Spooler).Status -eq 'Running') { Fixed $id 'The Print Spooler is running again.' } else { Failed $id 'The Print Spooler would not start.' }
      }
      'spooler-stuck-jobs' {
        if ($dry) { Fixed $id 'DRY RUN: would clear the print queue'; break }
        Stop-Service -Name Spooler -Force
        Start-Sleep -Seconds 2
        Get-ChildItem 'C:\Windows\System32\spool\PRINTERS' -File -Force | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force } catch { } }
        Start-Service -Name Spooler
        Start-Sleep -Seconds 2
        $running = ((Get-Service -Name Spooler).Status -eq 'Running')
        $remaining = @(Get-ChildItem 'C:\Windows\System32\spool\PRINTERS' -File -Force).Count
        if ($running -and $remaining -eq 0) { Fixed $id 'The print queue was cleared and the Print Spooler is running.' } else { Failed $id ('The print queue could not be fully cleared (' + $remaining + ' file(s) left, spooler running: ' + $running + ').') }
      }
      'low-disk' {
        $before = (Get-PSDrive -Name C).Free
        $cut = (Get-Date).AddDays(-3)
        $targets = @($env:windir + '\Temp') + @(Get-ChildItem 'C:\Users' -Directory -Force | ForEach-Object { $_.FullName + '\AppData\Local\Temp' })
        $n = 0
        foreach ($t in $targets) {
          if (-not (Test-Path -LiteralPath $t)) { continue }
          Get-ChildItem -LiteralPath $t -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cut } | ForEach-Object {
            $n++
            if (-not $dry) { try { Remove-Item -LiteralPath $_.FullName -Force } catch { } }
          }
        }
        if ($dry) { Fixed $id ('DRY RUN: would delete ' + $n + ' temporary file(s)'); break }
        $d = Get-PSDrive -Name C
        $freed = [math]::Round(($d.Free - $before) / 1GB, 2); $freeNow = [math]::Round($d.Free / 1GB, 1); $total = ($d.Used + $d.Free) / 1GB
        if ($freeNow -ge 10 -or ($freeNow / $total) -ge 0.10) { Fixed $id ('Temporary files were deleted: ' + $freed + ' GB freed, ' + $freeNow + ' GB free now.') }
        else { Failed $id ('Temporary files were deleted (' + $freed + ' GB) but only ' + $freeNow + ' GB is free. More space is needed.') }
      }
      'dns-client-stopped' {
        if ($dry) { Fixed $id 'DRY RUN: would start the DNS Client service'; break }
        try { Set-Service -Name Dnscache -StartupType Automatic } catch { }
        Start-Service -Name Dnscache
        Start-Sleep -Seconds 2
        try { Clear-DnsClientCache } catch { }
        if (((Get-Service -Name Dnscache).Status -eq 'Running') -and (Resolves)) { Fixed $id 'The DNS Client service is running and website names can be looked up.' } else { Failed $id 'The DNS Client service was started but names still cannot be looked up.' }
      }
      'dns-failing' {
        if ($dry) { Fixed $id 'DRY RUN: would clear the DNS cache'; break }
        Clear-DnsClientCache
        try { Restart-Service -Name Dnscache -Force } catch { }
        Start-Sleep -Seconds 3
        if (Resolves) { Fixed $id 'The DNS cache was cleared and website names can be looked up again.' } else { Failed $id 'The DNS cache was cleared but names still cannot be looked up. The DNS servers may be wrong or down.' }
      }
      'no-ip-address' {
        if ($dry) { Fixed $id 'DRY RUN: would renew the network address'; break }
        & ipconfig.exe /renew | Out-Null
        Start-Sleep -Seconds 5
        $bad = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '169.254.*' })
        $have = @(Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.IPv4Address.IPAddress -notlike '169.254.*' })
        if ($bad.Count -eq 0 -and $have.Count -gt 0) { Fixed $id ('The computer now has the address ' + $have[0].IPv4Address.IPAddress + '.') } else { Failed $id 'The network did not give the computer an address. The router or DHCP server may be down.' }
      }
      'time-not-synced' {
        if ($dry) { Fixed $id 'DRY RUN: would synchronise the clock'; break }
        try { Set-Service -Name W32Time -StartupType Automatic } catch { }
        Start-Service -Name W32Time
        Start-Sleep -Seconds 2
        $out = (& w32tm.exe /resync /force 2>&1) -join ' '
        $code = $LASTEXITCODE
        Start-Sleep -Seconds 2
        $skew = $null
        try { $r = Invoke-WebRequest -Uri 'https://www.microsoft.com' -Method Head -UseBasicParsing -TimeoutSec 8; $skew = [math]::Abs(((Get-Date).ToUniversalTime() - ([datetimeoffset]::Parse([string]($r.Headers['Date'] | Select-Object -First 1))).UtcDateTime).TotalSeconds) } catch { }
        if ($null -ne $skew) { if ($skew -lt 120) { Fixed $id ('The clock was synchronised and is now within ' + [math]::Round($skew) + ' seconds of real time.') } else { Failed $id ('The clock is still ' + [math]::Round($skew / 60, 1) + ' minutes off after synchronising. The computer may not be able to reach a time source.') } }
        elseif ($code -eq 0) { Fixed $id 'The Windows Time service is running and the clock was synchronised.' } else { Failed $id ('The clock could not be synchronised: ' + $out) }
      }
      'defender-realtime-off' {
        if ($dry) { Fixed $id 'DRY RUN: would turn real-time protection on'; break }
        Set-MpPreference -DisableRealtimeMonitoring $false
        Start-Sleep -Seconds 3
        if ((Get-MpComputerStatus).RealTimeProtectionEnabled) { Fixed $id 'Real-time virus protection is on again.' } else { Failed $id 'Real-time protection would not turn on (a policy or tamper protection may be preventing it).' }
      }
      'defender-signatures-old' {
        if ($dry) { Fixed $id 'DRY RUN: would update the virus definitions'; break }
        Update-MpSignature
        $age = (Get-MpComputerStatus).AntivirusSignatureAge
        if ($age -le 2) { Fixed $id ('The virus definitions are up to date (' + $age + ' day(s) old).') } else { Failed $id ('The virus definitions are still ' + $age + ' days old after updating.') }
      }
      'teams-crashing' {
        if (-not $dry) { Get-Process -Name 'ms-teams', 'Teams' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
        $cleared = 0
        foreach ($u in (Get-ChildItem 'C:\Users' -Directory -Force)) {
          $dirs = @()
          foreach ($sub in 'Cache', 'blob_storage', 'databases', 'GPUCache', 'IndexedDB', 'Local Storage', 'tmp', 'Code Cache') { $dirs += ($u.FullName + '\AppData\Roaming\Microsoft\Teams\' + $sub) }
          $dirs += ($u.FullName + '\AppData\Local\Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams')
          foreach ($p in $dirs) { if (Test-Path -LiteralPath $p) { if (-not $dry) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }; if ($dry -or -not (Test-Path -LiteralPath $p)) { $cleared++ } } }
        }
        if ($dry) { Fixed $id ('DRY RUN: would clear ' + $cleared + ' Teams cache folder(s)'); break }
        if ($cleared -gt 0) { Fixed $id ('Teams was closed and ' + $cleared + ' cache folder(s) were cleared. Teams rebuilds them when it starts.') } else { Failed $id 'No Teams cache was found to clear.' }
      }
      default {
        if ($custom.ContainsKey($id)) {
          $o = (& $custom[$id] 2>&1 | Out-String)
          $m = [regex]::Match($o, '(?m)^(FIXED|FAILED)\|(.*)$')
          if ($m.Success -and $m.Groups[1].Value -eq 'FIXED') { Fixed $id $m.Groups[2].Value }
          elseif ($m.Success) { Failed $id $m.Groups[2].Value }
          else { Failed $id 'The repair did not say whether it worked.' }
        } else { Failed $id 'No repair is known for this.' }
      }
    }
  } catch { Failed $id ('The repair stopped with an error: ' + $_.Exception.Message) }
}
Write-Output 'DONE'
`;
