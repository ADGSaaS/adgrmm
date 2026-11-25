// backend/src/endpoint-backups/backup.scripts.ts
//
// The scripts that read, on a computer, what protects it: restore points, the backup Windows itself keeps, and the backup software that is
// installed. Fixed text, read-only (they only read logs, services and file names; they never start, stop or change anything) and with no
// parameters. What they print is described in backup.core.ts (parseBackupOutput).
// The texts live in String.raw templates: no dollar-brace sequence and no backtick.

export const WINDOWS_BACKUP_SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
function Utc($d) { if ($d) { try { return ([datetime]$d).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } catch { return '' } } return '' }
function Emit($product, $kind, $success, $attempt, $state, $detail) {
  $text = ([string]$detail) -replace '[\r\n|]', ' '
  Write-Output ('P|{0}|{1}|{2}|{3}|{4}|{5}' -f $product, $kind, (Utc $success), (Utc $attempt), $state, $text)
}

# Restore points kept on this computer's own disk (they do not survive a failed disk, so they count for less than a real backup)
try {
  $shadows = @(Get-CimInstance -ClassName Win32_ShadowCopy -ErrorAction Stop | Sort-Object InstallDate -Descending)
  if ($shadows.Count -gt 0) { Emit 'Windows restore points (shadow copies)' 'snapshot' $shadows[0].InstallDate $shadows[0].InstallDate 'ok' ('{0} restore points are kept on this computer' -f $shadows.Count) }
} catch { }

# The backup that Windows itself makes: event 4 is a finished backup, event 5 a failed one
try {
  $log = Get-WinEvent -ListLog 'Microsoft-Windows-Backup' -ErrorAction Stop
  if ($log.RecordCount -gt 0) {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Backup'; Id = 4, 5 } -MaxEvents 40 -ErrorAction Stop | Sort-Object TimeCreated -Descending)
    if ($events.Count -gt 0) {
      $good = $events | Where-Object { $_.Id -eq 4 } | Select-Object -First 1
      $latest = $events[0]
      $state = if ($latest.Id -eq 5) { 'failed' } else { 'ok' }
      $why = ''
      if ($latest.Id -eq 5) { $why = ([string]$latest.Message) -replace '\s+', ' '; if ($why.Length -gt 160) { $why = $why.Substring(0, 160) } }
      Emit 'Windows Backup' 'image' $(if ($good) { $good.TimeCreated } else { $null }) $latest.TimeCreated $state $why
    }
  }
} catch { }

# Backup software that is installed. Its results are in its own console, so they are not read here: it is reported as present.
$known = @(
  @('Veeam Agent', 'Veeam'), @('Acronis Cyber Protect', 'Acronis'), @('Datto Backup', 'Datto'), @('N-able Cove Data Protection', 'Backup Service Controller|BackupFP|Cove Data'),
  @('Macrium Reflect', 'Macrium'), @('Backblaze', 'Backblaze|bzserv'), @('Carbonite', 'Carbonite'), @('CrashPlan', 'CrashPlan|Code42'), @('Druva inSync', 'Druva|inSync'),
  @('IDrive', 'IDrive'), @('Veritas Backup Exec', 'Backup Exec'), @('Commvault', 'Commvault|GxCVD'), @('Axcient', 'Axcient'), @('Barracuda Backup', 'Barracuda'),
  @('MSP360 (CloudBerry)', 'CloudBerry|MSP360'), @('Hornetsecurity VM Backup (Altaro)', 'Altaro|Hornetsecurity')
)
$services = @(Get-Service)
foreach ($k in $known) {
  $hits = @($services | Where-Object { $_.Name -match $k[1] -or $_.DisplayName -match $k[1] })
  if ($hits.Count -eq 0) { continue }
  $running = @($hits | Where-Object { $_.Status -eq 'Running' }).Count -gt 0
  if ($running) { Emit $k[0] 'agent' $null $null 'unknown' 'Its service is running. Its results are in its own console.' }
  else { Emit $k[0] 'agent' $null $null 'warning' 'It is installed, but its service is not running.' }
}
Write-Output 'D|ok'
`;

export const LINUX_BACKUP_SCRIPT = String.raw`#!/bin/bash
export LC_ALL=C
have() { command -v "$1" >/dev/null 2>&1; }
emit() { printf 'P|%s|%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5" "$(printf '%s' "$6" | tr '\n|' '  ')"; }
iso() { date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null; }

# ZFS snapshots: the newest one (restore points on this computer's own pool)
if have zfs; then
  N=$(zfs list -H -p -t snapshot -o creation 2>/dev/null | wc -l | tr -d ' ')
  T=$(zfs list -H -p -t snapshot -o creation -s creation 2>/dev/null | tail -n 1)
  if [ -n "$T" ] && [ "$N" -gt 0 ]; then emit "ZFS snapshots" snapshot "$(iso "$T")" "$(iso "$T")" ok "$N snapshots are kept on this computer"; fi
fi

# Timeshift: each snapshot is a folder named for when it was made
for D in /timeshift/snapshots /run/timeshift/backup/timeshift/snapshots; do
  if [ -d "$D" ]; then
    LAST=$(ls -1 "$D" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}$' | sort | tail -n 1)
    if [ -n "$LAST" ]; then
      WHEN=$(printf '%s' "$LAST" | sed 's/_/ /; s/\(.*\) \([0-9][0-9]\)-\([0-9][0-9]\)-\([0-9][0-9]\)$/\1 \2:\3:\4/')
      EP=$(date -d "$WHEN" +%s 2>/dev/null)
      if [ -n "$EP" ]; then emit "Timeshift" snapshot "$(iso "$EP")" "$(iso "$EP")" ok "$(ls -1 "$D" | wc -l | tr -d ' ') snapshots"; fi
    fi
    break
  fi
done

# Backup tools and services that are installed. Their results are not read here, so they are reported as present.
UNITS=""
if have systemctl; then UNITS=$(systemctl list-units --type=service --type=timer --all --no-legend --plain 2>/dev/null | awk '{print $1}'); fi
present() {
  NAME="$1"; PATTERN="$2"; BIN="$3"
  FOUND=""
  if [ -n "$UNITS" ] && printf '%s\n' "$UNITS" | grep -Eiq "$PATTERN"; then FOUND="a service or timer is set up"; fi
  if [ -z "$FOUND" ] && [ -n "$BIN" ] && have "$BIN"; then FOUND="the program is installed"; fi
  if [ -n "$FOUND" ]; then emit "$NAME" agent "" "" unknown "$FOUND. Its results are in its own console or logs."; fi
}
present "Veeam Agent for Linux" 'veeam' veeamconfig
present "Acronis" 'acronis' ""
present "Datto" 'datto' ""
present "N-able Cove Data Protection" 'backupfp|backup-manager' ""
present "Bacula or Bareos client" 'bacula-fd|bareos-fd' ""
present "UrBackup client" 'urbackup' urbackupclientctl
present "BorgBackup" 'borg' borg
present "restic" 'restic' restic
present "Duplicity or Duplicati" 'duplicity|duplicati' duplicity
present "rsnapshot" 'rsnapshot' rsnapshot
present "Amanda" 'amanda' ""
echo "D|ok"
`;
