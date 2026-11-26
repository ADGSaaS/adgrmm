// backend/src/automation/builtin-scripts.windows.ts
//
// The built-in PowerShell scripts. Rules every one of them follows:
//   - Windows PowerShell 5.1, ASCII only, nothing from outside the box.
//   - Read-only, unless its name says "changes the device": those only act when the Confirm parameter is YES, and the ones that delete or
//     disable also have a dry run that is on by default.
//   - A parameter is read from the environment (ADG_<NAME>), checked against a strict pattern, and passed as an ARGUMENT, never built into code.
//   - Plain output, and a non-zero exit code only for a real problem (a check that found a fault, or a bad parameter).
// The text lives in String.raw templates: it must contain no dollar-brace sequence and no backtick.
import { CONFIRM_PARAM, type BuiltinScript } from "./builtin-scripts.types";

export const WINDOWS_SCRIPTS: BuiltinScript[] = [
    /* ------------------------------ Diagnostics ------------------------------ */
    {
        key: "win-system-summary",
        name: "System summary (Windows)",
        description: "Computer name, model, Windows version, uptime, processor, memory, disks, signed-in user and IPv4 addresses on one screen.",
        language: "powershell", category: "Diagnostics", timeoutSec: 120, parameters: [],
        script: String.raw`$ErrorActionPreference = 'Continue'
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$up = (Get-Date) - $os.LastBootUpTime
Write-Output "Computer       : $($env:COMPUTERNAME)"
Write-Output "Domain/Group   : $($cs.Domain)"
Write-Output "Model          : $($cs.Manufacturer) $($cs.Model)"
Write-Output "Windows        : $($os.Caption) $($os.Version) (build $($os.BuildNumber), $($os.OSArchitecture))"
Write-Output "Uptime         : $([int]$up.TotalDays) days $($up.Hours) hours (since $($os.LastBootUpTime))"
Write-Output "Processor      : $($cpu.Name) ($($cs.NumberOfLogicalProcessors) logical processors)"
Write-Output ("Memory         : {0} GB total, {1} GB free" -f [math]::Round($cs.TotalPhysicalMemory / 1GB, 1), [math]::Round($os.FreePhysicalMemory / 1MB, 1))
Write-Output "Signed-in user : $($cs.UserName)"
Write-Output ''
Write-Output 'Disks:'
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  Write-Output ("  {0}  {1} GB total, {2} GB free ({3}% free)" -f $_.DeviceID, [math]::Round($_.Size / 1GB, 1), [math]::Round($_.FreeSpace / 1GB, 1), [math]::Round(100 * $_.FreeSpace / $_.Size, 0))
}
Write-Output ''
Write-Output 'IPv4 addresses:'
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { Write-Output ("  {0}  ({1})" -f $_.IPAddress, $_.InterfaceAlias) }
`,
    },
    {
        key: "win-top-processes",
        name: "Top processes by CPU and memory (Windows)",
        description: "The busiest processes by CPU time and by memory, with the account they run as. Count parameter chooses how many (1 to 50).",
        language: "powershell", category: "Diagnostics", timeoutSec: 120,
        parameters: [{ name: "count", label: "How many processes to list (1 to 50)", defaultValue: "10" }],
        script: String.raw`$n = 10
if ($env:ADG_COUNT -match '^[0-9]{1,2}$' -and [int]$env:ADG_COUNT -ge 1 -and [int]$env:ADG_COUNT -le 50) { $n = [int]$env:ADG_COUNT }
Write-Output "Top $n processes by CPU time (seconds since they started):"
Get-Process | Sort-Object CPU -Descending | Select-Object -First $n Name, Id,
  @{n='CPU_s'; e={[math]::Round($_.CPU, 1)}}, @{n='Memory_MB'; e={[math]::Round($_.WorkingSet64 / 1MB, 1)}} |
  Format-Table -AutoSize | Out-String -Width 200 | Write-Output
Write-Output "Top $n processes by memory:"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First $n Name, Id,
  @{n='Memory_MB'; e={[math]::Round($_.WorkingSet64 / 1MB, 1)}}, @{n='Threads'; e={$_.Threads.Count}} |
  Format-Table -AutoSize | Out-String -Width 200 | Write-Output
$os = Get-CimInstance Win32_OperatingSystem
Write-Output ("Memory in use: {0}% of {1} GB" -f [math]::Round(100 * ($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize, 0), [math]::Round($os.TotalVisibleMemorySize / 1MB, 1))
`,
    },
    {
        key: "win-uptime-reboot",
        name: "Uptime and restart status (Windows)",
        description: "When it last started, how long it has been up, whether a restart is waiting (and why) and the last restarts and unexpected shutdowns. Exits 1 when a restart is pending.",
        language: "powershell", category: "Diagnostics", timeoutSec: 120, parameters: [],
        script: String.raw`$os = Get-CimInstance Win32_OperatingSystem
$up = (Get-Date) - $os.LastBootUpTime
Write-Output "Last start : $($os.LastBootUpTime)"
Write-Output "Uptime     : $([int]$up.TotalDays) days $($up.Hours) hours $($up.Minutes) minutes"
$reasons = @()
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { $reasons += 'Windows servicing (component store) is waiting for a restart' }
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $reasons += 'Windows Update is waiting for a restart' }
if ($null -ne (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue)) { $reasons += 'Files are waiting to be replaced at the next start' }
$pc = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName' -ErrorAction SilentlyContinue
$pn = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName' -ErrorAction SilentlyContinue
if ($pc -and $pn -and $pc.ComputerName -ne $pn.ComputerName) { $reasons += 'A computer rename is waiting for a restart' }
Write-Output ''
if ($reasons.Count -gt 0) {
  Write-Output 'RESTART PENDING:'
  $reasons | ForEach-Object { Write-Output ("  - " + $_) }
} else {
  Write-Output 'No restart is pending.'
}
Write-Output ''
Write-Output 'Recent starts, shutdowns and crashes (System log):'
try {
  Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 1074, 6005, 6006, 6008 } -MaxEvents 12 -ErrorAction Stop |
    ForEach-Object { Write-Output ("  {0}  event {1}  {2}" -f $_.TimeCreated, $_.Id, (($_.Message -split "\r?\n")[0])) }
} catch { Write-Output '  (none found, or the log could not be read)' }
if ($reasons.Count -gt 0) { exit 1 }
`,
    },
    {
        key: "win-event-errors",
        name: "Event log errors, last 24 hours (Windows)",
        description: "Errors and critical events from the System and Application logs, grouped by source and event, with the latest message of each. Hours parameter changes the window.",
        language: "powershell", category: "Diagnostics", timeoutSec: 300,
        parameters: [{ name: "hours", label: "How many hours back (1 to 720)", defaultValue: "24" }],
        script: String.raw`$h = 24
if ($env:ADG_HOURS -match '^[0-9]{1,3}$' -and [int]$env:ADG_HOURS -ge 1 -and [int]$env:ADG_HOURS -le 720) { $h = [int]$env:ADG_HOURS }
$since = (Get-Date).AddHours(-$h)
Write-Output "Errors and critical events since $since ($h hours):"
try {
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'System', 'Application'; Level = 1, 2; StartTime = $since } -MaxEvents 1000 -ErrorAction Stop
} catch {
  Write-Output 'No errors found in that time.'
  exit 0
}
Write-Output ("{0} events found." -f @($events).Count)
Write-Output ''
$events | Group-Object ProviderName, Id | Sort-Object Count -Descending | Select-Object -First 20 | ForEach-Object {
  $e = $_.Group[0]
  $msg = (($e.Message -split "\r?\n")[0])
  if ($msg.Length -gt 180) { $msg = $msg.Substring(0, 180) }
  Write-Output ("{0,4} x  {1} / {2}  (latest {3})" -f $_.Count, $e.ProviderName, $e.Id, $e.TimeCreated)
  Write-Output ("        " + $msg)
}
`,
    },

    /* ------------------------------ Services and processes ------------------------------ */
    {
        key: "win-failed-services",
        name: "Automatic services that are not running (Windows)",
        description: "Services set to start automatically that are stopped, with their start type and exit code. Some trigger-started services stop by design. Exits 1 when any are found.",
        language: "powershell", category: "Services and processes", timeoutSec: 120, parameters: [],
        script: String.raw`$bad = Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' } | Sort-Object Name
if (-not $bad) {
  Write-Output 'Every automatic service is running.'
  exit 0
}
Write-Output ("{0} automatic service(s) are not running (some stop by design, for example services that start on demand):" -f @($bad).Count)
$bad | Select-Object Name, DisplayName, State, ExitCode, StartName | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
exit 1
`,
    },
    {
        key: "win-restart-service",
        name: "Restart a service (Windows, changes the device)",
        description: "Restarts one named service. Does nothing unless Confirm is YES. Give the short service name, for example Spooler.",
        language: "powershell", category: "Services and processes", timeoutSec: 180,
        parameters: [{ name: "service", label: "Service name (for example Spooler)", required: true }, CONFIRM_PARAM],
        script: String.raw`$name = [string]$env:ADG_SERVICE
if ($name -notmatch '^[A-Za-z0-9_.@ -]{1,80}$') { Write-Output 'Give a valid service name in the Service parameter.'; exit 2 }
$svc = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $svc) { Write-Output "There is no service named '$name'."; exit 2 }
Write-Output "Service $($svc.Name) ($($svc.DisplayName)) is $($svc.Status)."
if ($env:ADG_CONFIRM -cne 'YES') {
  Write-Output 'Nothing was changed. Run again with Confirm set to YES to restart it.'
  exit 0
}
try {
  Restart-Service -Name $svc.Name -Force -ErrorAction Stop
  Start-Sleep -Seconds 3
  $now = Get-Service -Name $svc.Name
  Write-Output "Restarted. It is now $($now.Status)."
  if ($now.Status -ne 'Running') { exit 1 }
} catch {
  Write-Output "Could not restart it: $($_.Exception.Message)"
  exit 1
}
`,
    },
    {
        key: "win-scheduled-tasks-startup",
        name: "Scheduled tasks and startup items (Windows)",
        description: "Scheduled tasks that are not part of Windows, and the programs that start with Windows or at sign-in. A quick way to spot things that should not be there.",
        language: "powershell", category: "Services and processes", timeoutSec: 180, parameters: [],
        script: String.raw`Write-Output 'Scheduled tasks (not under Microsoft):'
try {
  Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -notlike '\Microsoft\*' } | ForEach-Object {
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction SilentlyContinue
    [pscustomobject]@{ Task = $_.TaskPath + $_.TaskName; State = $_.State; RunAs = $_.Principal.UserId; LastRun = $info.LastRunTime; LastResult = $info.LastTaskResult }
  } | Sort-Object Task | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
} catch { Write-Output '  could not be read' }
Write-Output 'Programs that start with Windows or at sign-in:'
Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Select-Object Name, Command, Location, User | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
`,
    },

    /* ------------------------------ Storage and disk ------------------------------ */
    {
        key: "win-disk-usage",
        name: "Disk space and biggest folders (Windows)",
        description: "Free space on every fixed drive, and the ten biggest folders directly under a path (default C:\\). Big drives take a few minutes.",
        language: "powershell", category: "Storage and disk", timeoutSec: 1800,
        parameters: [{ name: "path", label: "Folder to look inside", defaultValue: "C:\\" }],
        script: String.raw`Write-Output 'Fixed drives:'
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  Write-Output ("  {0}  {1} GB total, {2} GB free ({3}% free)" -f $_.DeviceID, [math]::Round($_.Size / 1GB, 1), [math]::Round($_.FreeSpace / 1GB, 1), [math]::Round(100 * $_.FreeSpace / $_.Size, 0))
}
$p = [string]$env:ADG_PATH
if ([string]::IsNullOrWhiteSpace($p)) { $p = 'C:\' }
if ($p -match '[<>|"?*]' -or $p.Length -gt 240 -or -not (Test-Path -LiteralPath $p -PathType Container)) { Write-Output ''; Write-Output "The Path parameter is not a folder on this computer: $p"; exit 2 }
Write-Output ''
Write-Output "Biggest folders directly under $($p):"
$rows = Get-ChildItem -LiteralPath $p -Force -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $sum = (Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  [pscustomobject]@{ Folder = $_.FullName; SizeGB = [math]::Round(([double]$sum) / 1GB, 2) }
}
$rows | Sort-Object SizeGB -Descending | Select-Object -First 10 | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
`,
    },
    {
        key: "win-disk-health",
        name: "Disk health, SMART status (Windows)",
        description: "Health, type and wear of each physical disk and the error counters the drive reports. Exits 1 when a disk is not Healthy.",
        language: "powershell", category: "Storage and disk", timeoutSec: 120, parameters: [],
        script: String.raw`$bad = $false
try { $disks = Get-PhysicalDisk -ErrorAction Stop } catch { Write-Output 'Disk health could not be read on this computer.'; exit 1 }
foreach ($d in $disks) {
  Write-Output ("{0}  {1}  {2}  {3} GB  Health: {4}  Status: {5}" -f $d.DeviceId, $d.FriendlyName, $d.MediaType, [math]::Round($d.Size / 1GB, 0), $d.HealthStatus, $d.OperationalStatus)
  if ($d.HealthStatus -ne 'Healthy') { $bad = $true }
  $c = $d | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
  if ($c) {
    Write-Output ("    Temperature {0} C (max {1}), wear {2}%, power-on hours {3}, read errors {4}, write errors {5}" -f $c.Temperature, $c.TemperatureMax, $c.Wear, $c.PowerOnHours, $c.ReadErrorsTotal, $c.WriteErrorsTotal)
  }
}
Write-Output ''
if ($bad) { Write-Output 'AT LEAST ONE DISK IS NOT HEALTHY.'; exit 1 }
Write-Output 'All disks report Healthy.'
`,
    },

    /* ------------------------------ Maintenance ------------------------------ */
    {
        key: "win-clean-temp",
        name: "Clean old temporary files (Windows, changes the device)",
        description: "Finds files older than N days in the Windows temp folder and every user's temp folder, and says how much space they take. It only deletes when Dry run is no AND Confirm is YES.",
        language: "powershell", category: "Maintenance", timeoutSec: 1800,
        parameters: [
            { name: "days", label: "Only files not changed for this many days (1 to 365)", defaultValue: "7" },
            { name: "dry_run", label: "Dry run: yes only reports, no deletes", defaultValue: "yes" },
            CONFIRM_PARAM,
        ],
        script: String.raw`$days = 7
if ($env:ADG_DAYS -match '^[0-9]{1,3}$' -and [int]$env:ADG_DAYS -ge 1 -and [int]$env:ADG_DAYS -le 365) { $days = [int]$env:ADG_DAYS }
$delete = ($env:ADG_DRY_RUN -ceq 'no' -and $env:ADG_CONFIRM -ceq 'YES')
$cut = (Get-Date).AddDays(-$days)
$folders = @()
$folders += Join-Path $env:windir 'Temp'
$usersRoot = 'C:\Users'
if ($env:PUBLIC) { $usersRoot = Split-Path -Path $env:PUBLIC -Parent }
Get-ChildItem $usersRoot -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $folders += Join-Path $_.FullName 'AppData\Local\Temp' }
$total = 0; $count = 0; $removed = 0; $failed = 0
foreach ($f in $folders) {
  if (-not (Test-Path -LiteralPath $f)) { continue }
  $files = Get-ChildItem -LiteralPath $f -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cut }
  $size = ($files | Measure-Object -Property Length -Sum).Sum
  if (-not $size) { $size = 0 }
  Write-Output ("{0}: {1} old files, {2} MB" -f $f, @($files).Count, [math]::Round($size / 1MB, 1))
  $total += $size; $count += @($files).Count
  if ($delete) {
    foreach ($file in $files) {
      try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop; $removed++ } catch { $failed++ }
    }
  }
}
Write-Output ''
Write-Output ("Found {0} files older than {1} days, {2} MB in total." -f $count, $days, [math]::Round($total / 1MB, 1))
if ($delete) {
  Write-Output ("Deleted {0} files. {1} could not be deleted (in use or protected)." -f $removed, $failed)
} else {
  Write-Output 'DRY RUN: nothing was deleted. To delete, set Dry run to no and Confirm to YES.'
}
`,
    },
    {
        key: "win-time-sync",
        name: "Time sync status, and resync (Windows, changes the device with confirm)",
        description: "Shows the time source, last sync and offset. A wrong clock breaks certificates and sign-in. With Confirm set to YES it also forces a resync.",
        language: "powershell", category: "Maintenance", timeoutSec: 180, parameters: [CONFIRM_PARAM],
        script: String.raw`Write-Output "Clock now: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (UTC offset $([System.TimeZoneInfo]::Local.BaseUtcOffset), $([System.TimeZoneInfo]::Local.Id))"
Write-Output ''
Write-Output 'Time source:'
& w32tm.exe /query /source 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
Write-Output 'Status:'
& w32tm.exe /query /status 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
$svc = Get-Service w32time -ErrorAction SilentlyContinue
Write-Output ''
Write-Output ("Windows Time service: {0}" -f $(if ($svc) { $svc.Status } else { 'not found' }))
if ($env:ADG_CONFIRM -ceq 'YES') {
  Write-Output ''
  Write-Output 'Forcing a resync...'
  if ($svc -and $svc.Status -ne 'Running') { Start-Service w32time -ErrorAction SilentlyContinue }
  & w32tm.exe /resync /force 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
  if ($LASTEXITCODE -ne 0) { exit 1 }
} else {
  Write-Output 'Nothing was changed. Set Confirm to YES to force a resync.'
}
`,
    },
    {
        key: "win-flush-dns",
        name: "Flush the DNS cache (Windows, changes the device)",
        description: "Clears the local DNS resolver cache. Harmless, and useful after a DNS change. Does nothing unless Confirm is YES.",
        language: "powershell", category: "Maintenance", timeoutSec: 60, parameters: [CONFIRM_PARAM],
        script: String.raw`$n = @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count
Write-Output "The DNS cache holds $n entries."
if ($env:ADG_CONFIRM -cne 'YES') { Write-Output 'Nothing was changed. Set Confirm to YES to flush it.'; exit 0 }
& ipconfig.exe /flushdns 2>&1 | ForEach-Object { Write-Output $_ }
if ($LASTEXITCODE -ne 0) { exit 1 }
`,
    },

    /* ------------------------------ Network ------------------------------ */
    {
        key: "win-network-info",
        name: "Network adapters, addresses and DNS (Windows)",
        description: "Each active adapter with its address, gateway, DNS servers, speed and MAC address, plus whether DNS and the internet answer.",
        language: "powershell", category: "Network", timeoutSec: 120, parameters: [],
        script: String.raw`Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $cfg = Get-NetIPConfiguration -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue
  Write-Output ("{0}  ({1})  {2}  MAC {3}" -f $_.Name, $_.InterfaceDescription, $_.LinkSpeed, $_.MacAddress)
  if ($cfg) {
    Write-Output ("    IPv4    : {0}" -f (($cfg.IPv4Address | ForEach-Object { $_.IPAddress }) -join ', '))
    Write-Output ("    Gateway : {0}" -f (($cfg.IPv4DefaultGateway | ForEach-Object { $_.NextHop }) -join ', '))
    Write-Output ("    DNS     : {0}" -f (($cfg.DnsServer.ServerAddresses) -join ', '))
  }
}
Write-Output ''
Write-Output 'DNS lookup test (microsoft.com):'
try { $r = Resolve-DnsName microsoft.com -Type A -ErrorAction Stop | Select-Object -First 1; Write-Output ("  answers: " + $r.IPAddress) } catch { Write-Output '  FAILED: DNS did not answer' }
Write-Output 'Internet test (a TCP connection to 1.1.1.1 port 443):'
try { $t = Test-NetConnection -ComputerName 1.1.1.1 -Port 443 -WarningAction SilentlyContinue; Write-Output ("  reachable: " + $t.TcpTestSucceeded) } catch { Write-Output '  could not be tested' }
`,
    },
    {
        key: "win-test-connection",
        name: "Test a connection to a host (Windows)",
        description: "Ping, an optional TCP port test and a short trace route to a host name or address. Use it to check that a device can reach a server or service.",
        language: "powershell", category: "Network", timeoutSec: 180,
        parameters: [
            { name: "host", label: "Host name or IP address", required: true },
            { name: "port", label: "TCP port to test (optional)", defaultValue: "" },
        ],
        script: String.raw`$h = [string]$env:ADG_HOST
if ($h -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$') { Write-Output 'Give a valid host name or address in the Host parameter.'; exit 2 }
$port = 0
if ($env:ADG_PORT) {
  if ($env:ADG_PORT -notmatch '^[0-9]{1,5}$' -or [int]$env:ADG_PORT -lt 1 -or [int]$env:ADG_PORT -gt 65535) { Write-Output 'The Port parameter must be a number from 1 to 65535.'; exit 2 }
  $port = [int]$env:ADG_PORT
}
$failed = $false
Write-Output "Ping $h (4 tries):"
try {
  $p = Test-Connection -ComputerName $h -Count 4 -ErrorAction Stop
  $avg = ($p | Measure-Object -Property ResponseTime -Average).Average
  Write-Output ("  {0} replies, average {1} ms, address {2}" -f @($p).Count, [math]::Round($avg, 1), $p[0].IPV4Address)
} catch { Write-Output '  no reply (the host may block ping)'; $failed = $true }
if ($port -gt 0) {
  Write-Output "TCP port $port on $($h):"
  $t = Test-NetConnection -ComputerName $h -Port $port -WarningAction SilentlyContinue
  Write-Output ("  open: " + $t.TcpTestSucceeded)
  if (-not $t.TcpTestSucceeded) { $failed = $true }
}
Write-Output 'Route (up to 15 hops):'
& tracert.exe -d -h 15 -w 1000 $h 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
if ($port -gt 0 -and $failed) { exit 1 }
`,
    },
    {
        key: "win-listening-ports",
        name: "Listening ports and their programs (Windows)",
        description: "Every TCP port the computer is listening on, with the program that owns it, and a count of UDP listeners. Use it to find services that should not be exposed.",
        language: "powershell", category: "Network", timeoutSec: 120, parameters: [],
        script: String.raw`$procs = @{}
Get-Process | ForEach-Object { $procs[$_.Id] = $_.ProcessName }
Write-Output 'TCP ports listening:'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Sort-Object LocalPort | ForEach-Object {
  [pscustomobject]@{ Port = $_.LocalPort; Address = $_.LocalAddress; PID = $_.OwningProcess; Program = $procs[[int]$_.OwningProcess] }
} | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
$udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)
Write-Output ("UDP endpoints: {0}" -f $udp.Count)
$udp | Group-Object { $procs[[int]$_.OwningProcess] } | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object { Write-Output ("  {0}: {1}" -f $_.Name, $_.Count) }
`,
    },

    /* ------------------------------ Security ------------------------------ */
    {
        key: "win-security-status",
        name: "Security status: firewall, Defender, BitLocker, UAC (Windows)",
        description: "Windows Firewall profiles, Microsoft Defender protection and signature age, BitLocker volumes and User Account Control. Exits 1 when something important is off.",
        language: "powershell", category: "Security", timeoutSec: 180, parameters: [],
        script: String.raw`$problems = @()
Write-Output 'Windows Firewall:'
try {
  Get-NetFirewallProfile -ErrorAction Stop | ForEach-Object {
    Write-Output ("  {0,-8} enabled: {1}  inbound default: {2}" -f $_.Name, $_.Enabled, $_.DefaultInboundAction)
    if (-not $_.Enabled) { $problems += "Firewall profile $($_.Name) is off" }
  }
} catch { Write-Output '  could not be read' }
Write-Output ''
Write-Output 'Microsoft Defender:'
try {
  $m = Get-MpComputerStatus -ErrorAction Stop
  Write-Output ("  Antivirus enabled     : {0}" -f $m.AntivirusEnabled)
  Write-Output ("  Real-time protection  : {0}" -f $m.RealTimeProtectionEnabled)
  Write-Output ("  Signatures            : {0}, {1} days old" -f $m.AntivirusSignatureVersion, $m.AntivirusSignatureAge)
  Write-Output ("  Last quick scan       : {0}" -f $m.QuickScanEndTime)
  if (-not $m.RealTimeProtectionEnabled) { $problems += 'Defender real-time protection is off' }
  if ($m.AntivirusSignatureAge -gt 7) { $problems += 'Defender signatures are more than 7 days old' }
} catch { Write-Output '  not available (another antivirus may be in charge)' }
Write-Output ''
Write-Output 'BitLocker:'
try {
  Get-BitLockerVolume -ErrorAction Stop | ForEach-Object {
    Write-Output ("  {0}  {1}  protection: {2}  {3}%" -f $_.MountPoint, $_.VolumeStatus, $_.ProtectionStatus, $_.EncryptionPercentage)
    if ($_.VolumeType -eq 'OperatingSystem' -and $_.ProtectionStatus -ne 'On') { $problems += "BitLocker protection is off on $($_.MountPoint)" }
  }
} catch { Write-Output '  not available on this edition or not readable' }
Write-Output ''
$uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -ErrorAction SilentlyContinue).EnableLUA
Write-Output ("User Account Control enabled: {0}" -f $uac)
if ($uac -eq 0) { $problems += 'User Account Control is off' }
Write-Output ''
if ($problems.Count -gt 0) {
  Write-Output 'PROBLEMS:'
  $problems | ForEach-Object { Write-Output ("  - " + $_) }
  exit 1
}
Write-Output 'Nothing important is switched off.'
`,
    },
    {
        key: "win-defender-update-scan",
        name: "Defender: update signatures and quick scan (Windows, changes the device)",
        description: "Shows Defender's state. With Confirm set to YES it downloads the newest signatures and runs a quick scan, then lists any threats found.",
        language: "powershell", category: "Security", timeoutSec: 3600, parameters: [CONFIRM_PARAM],
        script: String.raw`try { $m = Get-MpComputerStatus -ErrorAction Stop } catch { Write-Output 'Microsoft Defender is not available on this computer.'; exit 1 }
Write-Output ("Signatures {0}, {1} days old. Real-time protection: {2}. Last quick scan: {3}" -f $m.AntivirusSignatureVersion, $m.AntivirusSignatureAge, $m.RealTimeProtectionEnabled, $m.QuickScanEndTime)
if ($env:ADG_CONFIRM -cne 'YES') { Write-Output 'Nothing was changed. Set Confirm to YES to update signatures and run a quick scan.'; exit 0 }
Write-Output 'Updating signatures...'
try { Update-MpSignature -ErrorAction Stop; Write-Output 'Signatures updated.' } catch { Write-Output ("Update failed: " + $_.Exception.Message) }
Write-Output 'Running a quick scan...'
try { Start-MpScan -ScanType QuickScan -ErrorAction Stop; Write-Output 'Scan finished.' } catch { Write-Output ("Scan failed: " + $_.Exception.Message); exit 1 }
$t = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddHours(-2) })
if ($t.Count -gt 0) {
  Write-Output ("THREATS DETECTED in the last 2 hours: {0}" -f $t.Count)
  $t | ForEach-Object { Write-Output ("  {0}  {1}" -f $_.InitialDetectionTime, (($_.Resources) -join '; ')) }
  exit 1
}
Write-Output 'No threats were detected.'
`,
    },
    {
        key: "win-cert-expiry",
        name: "Certificates that are expired or expiring (Windows)",
        description: "Certificates in the computer's Personal, Web Hosting and Remote Desktop stores that have expired or expire soon. Days parameter sets how soon. Exits 1 when any are found.",
        language: "powershell", category: "Security", timeoutSec: 120,
        parameters: [{ name: "days", label: "Warn when a certificate expires within this many days (1 to 3650)", defaultValue: "30" }],
        script: String.raw`$days = 30
if ($env:ADG_DAYS -match '^[0-9]{1,4}$' -and [int]$env:ADG_DAYS -ge 1 -and [int]$env:ADG_DAYS -le 3650) { $days = [int]$env:ADG_DAYS }
$limit = (Get-Date).AddDays($days)
$found = @()
foreach ($store in 'My', 'WebHosting', 'Remote Desktop') {
  $path = "Cert:\LocalMachine\" + $store
  if (-not (Test-Path $path)) { continue }
  Get-ChildItem $path -ErrorAction SilentlyContinue | Where-Object { $_.NotAfter -lt $limit } | ForEach-Object {
    $found += [pscustomobject]@{ Store = $store; Expires = $_.NotAfter; State = $(if ($_.NotAfter -lt (Get-Date)) { 'EXPIRED' } else { 'expiring' }); Subject = $_.Subject; Thumbprint = $_.Thumbprint }
  }
}
if ($found.Count -eq 0) { Write-Output "No certificate has expired or expires within $days days."; exit 0 }
Write-Output ("{0} certificate(s) have expired or expire within {1} days:" -f $found.Count, $days)
$found | Sort-Object Expires | Format-Table -AutoSize | Out-String -Width 240 | Write-Output
exit 1
`,
    },
    {
        key: "win-remote-access-status",
        name: "Remote access status: RDP, WinRM, SSH (Windows)",
        description: "Whether Remote Desktop is on, its port and Network Level Authentication, WinRM and OpenSSH state, and who is signed in right now.",
        language: "powershell", category: "Security", timeoutSec: 120, parameters: [],
        script: String.raw`$deny = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction SilentlyContinue).fDenyTSConnections
$nla = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -ErrorAction SilentlyContinue).UserAuthentication
$port = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name PortNumber -ErrorAction SilentlyContinue).PortNumber
Write-Output ("Remote Desktop enabled           : {0}" -f $(if ($deny -eq 0) { 'YES' } else { 'no' }))
Write-Output ("Remote Desktop port              : {0}" -f $port)
Write-Output ("Network Level Authentication     : {0}" -f $(if ($nla -eq 1) { 'required' } else { 'NOT required' }))
foreach ($name in 'TermService', 'WinRM', 'sshd') {
  $s = Get-Service -Name $name -ErrorAction SilentlyContinue
  Write-Output ("Service {0,-22}: {1}" -f $name, $(if ($s) { "$($s.Status), starts $($s.StartType)" } else { 'not installed' }))
}
Write-Output ''
Write-Output 'Remote Desktop firewall rules:'
Get-NetFirewallRule -DisplayGroup 'Remote Desktop' -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("  {0}  enabled: {1}  profile: {2}  action: {3}" -f $_.DisplayName, $_.Enabled, $_.Profile, $_.Action) }
Write-Output ''
Write-Output 'Signed-in sessions:'
& quser.exe 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
`,
    },

    /* ------------------------------ Users and accounts ------------------------------ */
    {
        key: "win-local-admins",
        name: "Local administrators (Windows)",
        description: "Who is in the local Administrators group, and whether each account is enabled. Review it for accounts that should not have this power.",
        language: "powershell", category: "Users and accounts", timeoutSec: 120, parameters: [],
        script: String.raw`$group = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value.Split([char]92)[-1]
Write-Output "Members of the local group '$group':"
try {
  Get-LocalGroupMember -Group $group -ErrorAction Stop | ForEach-Object {
    $enabled = ''
    if ($_.ObjectClass -eq 'User' -and $_.PrincipalSource -eq 'Local') {
      $u = Get-LocalUser -SID $_.SID -ErrorAction SilentlyContinue
      if ($u) { $enabled = "enabled: " + $u.Enabled }
    }
    Write-Output ("  {0}  [{1}, {2}]  {3}" -f $_.Name, $_.ObjectClass, $_.PrincipalSource, $enabled)
  }
} catch {
  Write-Output '  (falling back to net localgroup)'
  & net.exe localgroup $group 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
}
`,
    },
    {
        key: "win-recent-logons",
        name: "Recent sign-ins (Windows)",
        description: "Interactive and Remote Desktop sign-ins from the Security log in the last N days, with user, type and source address. Needs the agent to run as SYSTEM.",
        language: "powershell", category: "Users and accounts", timeoutSec: 300,
        parameters: [{ name: "days", label: "How many days back (1 to 90)", defaultValue: "7" }],
        script: String.raw`$days = 7
if ($env:ADG_DAYS -match '^[0-9]{1,2}$' -and [int]$env:ADG_DAYS -ge 1 -and [int]$env:ADG_DAYS -le 90) { $days = [int]$env:ADG_DAYS }
$types = @{ 2 = 'Console'; 7 = 'Unlock'; 10 = 'Remote Desktop'; 11 = 'Cached' }
try {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4624; StartTime = (Get-Date).AddDays(-$days) } -MaxEvents 3000 -ErrorAction Stop
} catch {
  Write-Output "No sign-in events were found in the last $days days, or the Security log cannot be read."
  exit 0
}
$rows = foreach ($e in $ev) {
  $user = [string]$e.Properties[5].Value
  $type = [int]$e.Properties[8].Value
  if ($types.ContainsKey($type) -and $user -notmatch '^(DWM-|UMFD-|SYSTEM|ANONYMOUS|LOCAL SERVICE|NETWORK SERVICE)' -and $user -notlike '*$') {
    [pscustomobject]@{ Time = $e.TimeCreated; User = $user; Domain = [string]$e.Properties[6].Value; Type = $types[$type]; From = [string]$e.Properties[18].Value }
  }
}
if (-not $rows) { Write-Output "No interactive sign-ins in the last $days days."; exit 0 }
Write-Output ("{0} sign-ins in the last {1} days. Latest first (up to 60):" -f @($rows).Count, $days)
$rows | Sort-Object Time -Descending | Select-Object -First 60 | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
Write-Output 'By user:'
$rows | Group-Object User | Sort-Object Count -Descending | ForEach-Object { Write-Output ("  {0}: {1}" -f $_.Name, $_.Count) }
`,
    },
    {
        key: "win-stale-accounts",
        name: "Stale local accounts (Windows, disables with confirm)",
        description: "Lists enabled local accounts that have not signed in for N days. Administrators and built-in accounts are never touched. It only disables accounts when Dry run is no AND Confirm is YES.",
        language: "powershell", category: "Users and accounts", timeoutSec: 180,
        parameters: [
            { name: "days", label: "Not signed in for this many days (7 to 3650)", defaultValue: "90" },
            { name: "dry_run", label: "Dry run: yes only reports, no changes", defaultValue: "yes" },
            CONFIRM_PARAM,
        ],
        script: String.raw`$days = 90
if ($env:ADG_DAYS -match '^[0-9]{1,4}$' -and [int]$env:ADG_DAYS -ge 7 -and [int]$env:ADG_DAYS -le 3650) { $days = [int]$env:ADG_DAYS }
$act = ($env:ADG_DRY_RUN -ceq 'no' -and $env:ADG_CONFIRM -ceq 'YES')
$cut = (Get-Date).AddDays(-$days)
$adminSid = 'S-1-5-32-544'
$adminNames = @()
try { $adminNames = @(Get-LocalGroupMember -SID $adminSid -ErrorAction Stop | ForEach-Object { ($_.Name -split '\\')[-1] }) } catch { }
$builtin = 'Administrator', 'Guest', 'DefaultAccount', 'WDAGUtilityAccount'
$stale = @()
foreach ($u in (Get-LocalUser | Where-Object { $_.Enabled })) {
  if ($builtin -contains $u.Name) { continue }
  if ($adminNames -contains $u.Name) { Write-Output ("Skipped (administrator): {0}" -f $u.Name); continue }
  if ($null -eq $u.LastLogon -or $u.LastLogon -lt $cut) { $stale += $u }
}
if ($stale.Count -eq 0) { Write-Output "No enabled local account has been idle for $days days or more."; exit 0 }
foreach ($u in $stale) {
  $last = if ($u.LastLogon) { $u.LastLogon } else { 'never' }
  Write-Output ("Stale: {0}  last sign-in: {1}" -f $u.Name, $last)
  if ($act) {
    try { Disable-LocalUser -Name $u.Name -ErrorAction Stop; Write-Output "  disabled" } catch { Write-Output ("  could not be disabled: " + $_.Exception.Message) }
  }
}
Write-Output ''
if (-not $act) { Write-Output 'DRY RUN: nothing was changed. To disable them, set Dry run to no and Confirm to YES.' }
`,
    },

    /* ------------------------------ Software and updates ------------------------------ */
    {
        key: "win-installed-software",
        name: "Installed software (Windows)",
        description: "Every program in the uninstall lists (64-bit, 32-bit and the signed-in user) with version, publisher and install date, sorted by name.",
        language: "powershell", category: "Software and updates", timeoutSec: 180, parameters: [],
        script: String.raw`$paths = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
$apps = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  Select-Object @{n='Name'; e={$_.DisplayName}}, @{n='Version'; e={$_.DisplayVersion}}, @{n='Publisher'; e={$_.Publisher}}, @{n='Installed'; e={$_.InstallDate}} |
  Sort-Object Name -Unique
Write-Output ("{0} programs installed:" -f @($apps).Count)
$apps | Format-Table -AutoSize | Out-String -Width 250 | Write-Output
`,
    },
    {
        key: "win-update-status",
        name: "Windows Update status and history (Windows)",
        description: "Update service state, whether a restart is waiting, the last fifteen update attempts with their result, and the newest installed hotfixes.",
        language: "powershell", category: "Software and updates", timeoutSec: 300, parameters: [],
        script: String.raw`foreach ($n in 'wuauserv', 'bits', 'UsoSvc') {
  $s = Get-Service -Name $n -ErrorAction SilentlyContinue
  Write-Output ("Service {0,-9}: {1}" -f $n, $(if ($s) { "$($s.Status), starts $($s.StartType)" } else { 'not found' }))
}
$pending = Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
Write-Output ("Restart waiting for updates: {0}" -f $pending)
Write-Output ''
Write-Output 'Last 15 update attempts:'
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $count = $searcher.GetTotalHistoryCount()
  $codes = @{ 0 = 'not started'; 1 = 'in progress'; 2 = 'succeeded'; 3 = 'succeeded with errors'; 4 = 'FAILED'; 5 = 'aborted' }
  if ($count -gt 0) {
    $searcher.QueryHistory(0, [math]::Min($count, 15)) | ForEach-Object { Write-Output ("  {0}  {1}  {2}" -f $_.Date, $codes[[int]$_.ResultCode], $_.Title) }
  } else { Write-Output '  (no history)' }
} catch { Write-Output '  the update history could not be read' }
Write-Output ''
Write-Output 'Newest installed hotfixes:'
Get-HotFix -ErrorAction SilentlyContinue | Sort-Object InstalledOn -Descending | Select-Object -First 8 HotFixID, Description, InstalledOn | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
`,
    },
    {
        key: "win-reset-update-cache",
        name: "Reset a stuck Windows Update cache (Windows, changes the device)",
        description: "Stops the update services, renames the SoftwareDistribution and catroot2 folders (Windows rebuilds them) and starts the services again. Fixes updates that hang or fail with the same error. Does nothing unless Confirm is YES.",
        language: "powershell", category: "Software and updates", timeoutSec: 900, parameters: [CONFIRM_PARAM],
        script: String.raw`$sd = Join-Path $env:windir 'SoftwareDistribution'
$cr = Join-Path $env:windir 'System32\catroot2'
foreach ($p in $sd, $cr) {
  if (Test-Path -LiteralPath $p) { $mb = [math]::Round((Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB, 1); Write-Output "$p : $mb MB" }
}
if ($env:ADG_CONFIRM -cne 'YES') { Write-Output 'Nothing was changed. Set Confirm to YES to reset the update cache.'; exit 0 }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$services = 'wuauserv', 'bits', 'cryptsvc', 'msiserver'
foreach ($s in $services) { Stop-Service -Name $s -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$failed = $false
foreach ($p in $sd, $cr) {
  if (Test-Path -LiteralPath $p) {
    try { Rename-Item -LiteralPath $p -NewName ((Split-Path $p -Leaf) + '.old-' + $stamp) -ErrorAction Stop; Write-Output "Renamed $p" } catch { Write-Output ("Could not rename " + $p + ": " + $_.Exception.Message); $failed = $true }
  }
}
foreach ($s in $services) { Start-Service -Name $s -ErrorAction SilentlyContinue }
Write-Output 'Services started again. Windows will rebuild the folders at the next update check; the .old folders can be deleted later.'
if ($failed) { exit 1 }
`,
    },

    /* ------------------------------ Inventory and reporting ------------------------------ */
    {
        key: "win-hardware-inventory",
        name: "Hardware inventory and battery (Windows)",
        description: "Manufacturer, model, serial number, BIOS version and date, motherboard, memory modules, graphics adapters and battery wear, for asset records and warranty lookups.",
        language: "powershell", category: "Inventory and reporting", timeoutSec: 180, parameters: [],
        script: String.raw`$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$board = Get-CimInstance Win32_BaseBoard
Write-Output ("Manufacturer : {0}" -f $cs.Manufacturer)
Write-Output ("Model        : {0}" -f $cs.Model)
Write-Output ("Serial number: {0}" -f $bios.SerialNumber)
Write-Output ("BIOS         : {0} {1} ({2})" -f $bios.Manufacturer, $bios.SMBIOSBIOSVersion, $bios.ReleaseDate)
Write-Output ("Motherboard  : {0} {1}" -f $board.Manufacturer, $board.Product)
Write-Output ''
Write-Output 'Memory modules:'
Get-CimInstance Win32_PhysicalMemory | ForEach-Object { Write-Output ("  {0}  {1} GB  {2} MHz  {3}  {4}" -f $_.DeviceLocator, [math]::Round($_.Capacity / 1GB, 0), $_.Speed, $_.Manufacturer, $_.PartNumber) }
Write-Output ''
Write-Output 'Graphics:'
Get-CimInstance Win32_VideoController | ForEach-Object { Write-Output ("  {0}  driver {1}" -f $_.Name, $_.DriverVersion) }
Write-Output ''
Write-Output 'Battery:'
$b = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
if ($b.Count -eq 0) { Write-Output '  no battery (a desktop or a server)' }
else {
  foreach ($x in $b) { Write-Output ("  {0}  charge {1}%  status {2}" -f $x.Name, $x.EstimatedChargeRemaining, $x.BatteryStatus) }
  try {
    $design = (Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData -ErrorAction Stop | Select-Object -First 1).DesignedCapacity
    $full = (Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity -ErrorAction Stop | Select-Object -First 1).FullChargedCapacity
    if ($design -gt 0) { Write-Output ("  designed capacity {0} mWh, full charge now {1} mWh: {2}% of new" -f $design, $full, [math]::Round(100 * $full / $design, 0)) }
  } catch { Write-Output '  wear figures are not reported by this battery' }
}
`,
    },
];
