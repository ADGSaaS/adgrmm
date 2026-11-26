// backend/src/automation/builtin-scripts.cross.ts
//
// The built-in scripts that are made for Windows, Linux AND macOS: one entry, three texts. The Windows text (PowerShell) is the script itself,
// the Linux and macOS texts (bash) ride beside it, and each device runs the one for its own system. The rules of the other two catalogs apply
// to every text (see builtin-scripts.windows.ts and builtin-scripts.linux.ts): read-only unless the name says "changes the device", Confirm
// has to be YES to change anything, parameters only as ADG_<NAME> environment variables checked against strict patterns, no eval.
// Where a Windows or Linux script already exists for the same job, its text is reused as it is (it has been run for real); the macOS texts are
// new. macOS ships bash 3.2 and BSD tools: no associative arrays, no mapfile, no GNU-only options, no `timeout` command.
// The texts live in String.raw templates: no dollar-brace sequence and no backtick (so $VAR and $(command), never ${VAR}).
import { CONFIRM_PARAM, type BuiltinParameter, type BuiltinScript } from "./builtin-scripts.types";
import { LINUX_SCRIPTS } from "./builtin-scripts.linux";
import { WINDOWS_SCRIPTS } from "./builtin-scripts.windows";

const HEAD = String.raw`#!/bin/bash
export LC_ALL=C
have() { command -v "$1" >/dev/null 2>&1; }
`;

const textOf = (list: BuiltinScript[], key: string): string => {
    const found = list.find((s) => s.key === key);
    if (!found) throw new Error(`built-in script ${key} is missing`);
    return found.script;
};
const win = (key: string) => textOf(WINDOWS_SCRIPTS, key);
const lin = (key: string) => textOf(LINUX_SCRIPTS, key);

const all = (
    key: string, name: string, description: string, category: BuiltinScript["category"], timeoutSec: number, parameters: BuiltinParameter[],
    texts: { windows: string; linux: string; macos: string },
): BuiltinScript => ({
    key: `all-${key}`, name, description, language: "powershell", category, timeoutSec, parameters,
    script: texts.windows, platform: "all", linuxScript: texts.linux, macosScript: texts.macos,
});

export const CROSS_SCRIPTS: BuiltinScript[] = [
    /* ------------------------------ the same job as a Windows and a Linux script, plus macOS ------------------------------ */
    all("system-summary", "System summary (all systems)",
        "Operating system, host name, uptime, processor, memory, disks and IPv4 addresses on one screen. Works on Windows, Linux and macOS.",
        "Diagnostics", 120, [], {
            windows: win("win-system-summary"), linux: lin("lin-system-summary"),
            macos: HEAD + String.raw`echo "OS            : $(sw_vers -productName) $(sw_vers -productVersion) (build $(sw_vers -buildVersion))"
echo "Host name     : $(hostname)"
echo "Model         : $(sysctl -n hw.model 2>/dev/null)"
echo "Kernel        : $(uname -r) ($(uname -m))"
BOOT=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p')
if [ -n "$BOOT" ]; then
  S=$(( $(date +%s) - BOOT ))
  echo "Uptime        : $((S / 86400)) days $(( (S % 86400) / 3600 )) hours $(( (S % 3600) / 60 )) minutes"
fi
echo "Load average  : $(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1, $2, $3}')"
echo "Processor     : $(sysctl -n machdep.cpu.brand_string 2>/dev/null) ($(sysctl -n hw.ncpu 2>/dev/null) cores)"
MEM=$(sysctl -n hw.memsize 2>/dev/null)
if [ -n "$MEM" ]; then echo "Memory        : $((MEM / 1073741824)) GB total"; fi
echo
echo "Disks:"
df -h 2>/dev/null | awk 'NR==1 || /^\/dev\//' | sed 's/^/  /'
echo
echo "IPv4 addresses:"
ifconfig 2>/dev/null | awk '/^[a-z0-9]+:/ {i=$1} /inet / && $2 != "127.0.0.1" {print "  " $2 "  (" i ")"}' | sed 's/:)/)/'
`,
        }),

    all("top-processes", "Top processes by CPU and memory (all systems)",
        "The busiest processes by CPU and by memory. Count chooses how many (1 to 50). Works on Windows, Linux and macOS.",
        "Diagnostics", 120, [{ name: "count", label: "How many processes to list (1 to 50)", defaultValue: "10" }], {
            windows: win("win-top-processes"), linux: lin("lin-top-processes"),
            macos: HEAD + String.raw`N=10
case "$ADG_COUNT" in ''|*[!0-9]*) ;; *) if [ "$ADG_COUNT" -ge 1 ] && [ "$ADG_COUNT" -le 50 ]; then N="$ADG_COUNT"; fi;; esac
echo "Top $N by CPU:"
ps -Aro pid,user,%cpu,%mem,etime,comm | head -n $((N + 1)) | sed 's/^/  /'
echo
echo "Top $N by memory:"
ps -Amo pid,user,%cpu,%mem,etime,comm | head -n $((N + 1)) | sed 's/^/  /'
`,
        }),

    all("uptime-restart", "Uptime and last restart (all systems)",
        "When the device last started, how long it has been up, and whether a restart is waiting. Works on Windows, Linux and macOS.",
        "Diagnostics", 120, [], {
            windows: win("win-uptime-reboot"), linux: lin("lin-reboot-uptime"),
            macos: HEAD + String.raw`BOOT=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p')
if [ -n "$BOOT" ]; then
  S=$(( $(date +%s) - BOOT ))
  echo "Last restart : $(date -r "$BOOT" '+%Y-%m-%d %H:%M:%S')"
  echo "Up for       : $((S / 86400)) days $(( (S % 86400) / 3600 )) hours $(( (S % 3600) / 60 )) minutes"
else
  echo "The start time could not be read."
fi
echo "macOS        : $(sw_vers -productVersion) (build $(sw_vers -buildVersion))"
echo
echo "Recent restarts:"
last reboot 2>/dev/null | head -n 5 | sed 's/^/  /'
`,
        }),

    all("recent-errors", "System log errors (all systems)",
        "Errors from the system log of the last N hours (1 to 168): the Windows event log, the Linux journal or the macOS unified log.",
        "Diagnostics", 300, [{ name: "hours", label: "How many hours back (1 to 168)", defaultValue: "24" }], {
            windows: win("win-event-errors"), linux: lin("lin-journal-errors"),
            macos: HEAD + String.raw`H=24
case "$ADG_HOURS" in ''|*[!0-9]*) ;; *) if [ "$ADG_HOURS" -ge 1 ] && [ "$ADG_HOURS" -le 168 ]; then H="$ADG_HOURS"; fi;; esac
echo "Errors and faults in the system log, last $H hours (the newest 60):"
log show --style compact --last "$H"h --predicate 'messageType == error OR messageType == fault' 2>/dev/null | grep -v '^Timestamp' | tail -n 60 | cut -c1-300 | sed 's/^/  /'
`,
        }),

    all("restart-service", "Restart a service (all systems, changes the device)",
        "Restarts one named service: a Windows service, a Linux systemd service or a macOS launchd service. Does nothing unless Confirm is YES.",
        "Services and processes", 180,
        [{ name: "service", label: "Service name (Windows service name, Linux unit, or macOS launchd label)", required: true }, CONFIRM_PARAM], {
            windows: win("win-restart-service"), linux: lin("lin-restart-service"),
            macos: HEAD + String.raw`S="$ADG_SERVICE"
if ! printf '%s' "$S" | grep -Eq '^[A-Za-z0-9_.@-]{1,120}$'; then echo "Give a valid service name (a launchd label such as com.example.agent) in the Service parameter."; exit 2; fi
if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
if ! launchctl print "system/$S" >/dev/null 2>&1; then echo "There is no system service with the label '$S'."; exit 2; fi
echo "Service $S:"
launchctl print "system/$S" 2>/dev/null | grep -E '^\s*(state|pid|program|path) =' | sed 's/^/  /'
if [ "$ADG_CONFIRM" != "YES" ]; then
  echo "Nothing was changed. Run again with Confirm set to YES to restart it."
  exit 0
fi
if launchctl kickstart -k "system/$S" 2>&1; then
  sleep 3
  echo "Restarted. Now:"
  launchctl print "system/$S" 2>/dev/null | grep -E '^\s*(state|pid) =' | sed 's/^/  /'
else
  echo "Could not restart it."
  exit 1
fi
`,
        }),

    all("disk-usage", "Disk space and biggest folders (all systems)",
        "Free space on the disks, and the biggest folders directly under a path (blank: the main drive). Big drives take a few minutes.",
        "Storage and disk", 1800, [{ name: "path", label: "Folder to look inside (blank: C:\\ on Windows, / elsewhere)", defaultValue: "" }], {
            windows: win("win-disk-usage"), linux: lin("lin-disk-usage"),
            macos: HEAD + String.raw`echo "Space:"
df -h 2>/dev/null | awk 'NR==1 || /^\/dev\//' | sed 's/^/  /'
P="$ADG_PATH"
[ -n "$P" ] || P=/
if [ ! -d "$P" ] || printf '%s' "$P" | grep -q '^-'; then echo; echo "The Path parameter is not a folder on this system: $P"; exit 2; fi
echo
echo "Biggest folders directly under $P (same disk only):"
du -xk -d 1 "$P" 2>/dev/null | sort -rn | head -n 12 | awk '{kb=$1; $1=""; printf "  %9.1f MB %s\n", kb/1024, $0}'
FULL=$(df -P 2>/dev/null | awk '$1 ~ /^\/dev\// {gsub("%","",$5); if ($5+0 >= 90) print $6 " (" $5 "%)"}')
if [ -n "$FULL" ]; then echo; echo "OVER 90% FULL: $FULL"; exit 1; fi
`,
        }),

    all("test-connection", "Test a connection to a host (all systems)",
        "Name lookup, ping, an optional TCP port test and a short trace route to a host name or address. Works on Windows, Linux and macOS.",
        "Network", 180,
        [{ name: "host", label: "Host name or IP address", required: true }, { name: "port", label: "TCP port to test (optional)", defaultValue: "" }], {
            windows: win("win-test-connection"), linux: lin("lin-test-connection"),
            macos: HEAD + String.raw`H="$ADG_HOST"
if ! printf '%s' "$H" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$'; then echo "Give a valid host name or address in the Host parameter."; exit 2; fi
PORT="$ADG_PORT"
if [ -n "$PORT" ]; then
  case "$PORT" in *[!0-9]*) echo "The Port parameter must be a number from 1 to 65535."; exit 2;; esac
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echo "The Port parameter must be a number from 1 to 65535."; exit 2; fi
fi
FAIL=0
echo "Name lookup for $H:"
dscacheutil -q host -a name "$H" 2>/dev/null | head -n 4 | sed 's/^/  /'
echo "Ping $H (4 tries):"
ping -c 4 -t 12 "$H" 2>&1 | tail -n 4 | sed 's/^/  /'
if [ -n "$PORT" ]; then
  echo "TCP port $PORT on $H:"
  if nc -z -G 5 "$H" "$PORT" >/dev/null 2>&1; then echo "  open"; else echo "  closed or filtered"; FAIL=1; fi
fi
echo "Route (up to 15 hops):"
traceroute -n -m 15 -w 1 "$H" 2>&1 | sed 's/^/  /'
exit $FAIL
`,
        }),

    all("network-info", "Network adapters, addresses and DNS (all systems)",
        "The network adapters with their addresses, the default gateway and the DNS servers in use. Works on Windows, Linux and macOS.",
        "Network", 120, [], {
            windows: win("win-network-info"), linux: lin("lin-network-info"),
            macos: HEAD + String.raw`echo "Addresses:"
ifconfig 2>/dev/null | awk '/^[a-z0-9]+:/ {i=$1} /inet6? / && $2 != "127.0.0.1" && $2 != "::1" {print "  " i " " $1 " " $2}' | sed 's/: / /'
echo
echo "Default route:"
route -n get default 2>/dev/null | awk '/gateway|interface/ {print "  " $0}'
echo
echo "DNS servers:"
scutil --dns 2>/dev/null | awk '/nameserver\[[0-9]+\]/ {print "  " $3}' | sort -u
echo
echo "Hardware ports:"
networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port|Device/ {print "  " $0}'
`,
        }),

    all("listening-ports", "Listening ports and their programs (all systems)",
        "Every TCP port and UDP port that something is listening on, with the program that owns it. Works on Windows, Linux and macOS.",
        "Network", 120, [], {
            windows: win("win-listening-ports"), linux: lin("lin-listening-ports"),
            macos: HEAD + String.raw`if ! have lsof; then echo "The lsof command is missing."; exit 1; fi
echo "Listening TCP ports:"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print "  " $1 "  " $2 "  " $3 "  " $9}' | head -n 80
echo
echo "UDP ports:"
lsof -nP -iUDP 2>/dev/null | awk '{print "  " $1 "  " $2 "  " $3 "  " $9}' | head -n 60
`,
        }),

    all("installed-software", "Installed software (all systems)",
        "The installed programs: Windows programs, Linux packages or macOS applications, each with its version.",
        "Software and updates", 300, [], {
            windows: win("win-installed-software"), linux: lin("lin-installed-packages"),
            macos: HEAD + String.raw`echo "Applications in /Applications:"
for A in /Applications/*.app /Applications/*/*.app; do
  [ -d "$A" ] || continue
  V=$(defaults read "$A/Contents/Info" CFBundleShortVersionString 2>/dev/null)
  echo "  $(basename "$A" .app)  $V"
done | sort
echo
echo "Installer packages that are not Apple's (the first 60):"
pkgutil --pkgs 2>/dev/null | grep -v '^com\.apple\.' | head -n 60 | sed 's/^/  /'
`,
        }),

    all("pending-updates", "Pending updates (all systems)",
        "The operating system updates that are waiting: Windows Update, Linux package updates or macOS software updates.",
        "Software and updates", 600, [], {
            windows: win("win-update-status"), linux: lin("lin-pending-updates"),
            macos: HEAD + String.raw`echo "Software updates waiting (macOS $(sw_vers -productVersion)):"
softwareupdate --list 2>&1 | grep -v '^$' | head -n 40 | sed 's/^/  /'
echo
echo "Automatic update settings:"
defaults read /Library/Preferences/com.apple.SoftwareUpdate 2>/dev/null | grep -E 'AutomaticCheckEnabled|AutomaticDownload|AutomaticallyInstall|CriticalUpdateInstall' | sed 's/^/  /'
`,
        }),

    all("scheduled-and-startup", "Scheduled jobs and startup items (all systems)",
        "What starts by itself: Windows scheduled tasks and startup programs, Linux cron jobs and timers, macOS launch daemons and agents.",
        "Services and processes", 180, [], {
            windows: win("win-scheduled-tasks-startup"), linux: lin("lin-cron-timers"),
            macos: HEAD + String.raw`for D in /Library/LaunchDaemons /Library/LaunchAgents; do
  echo "$D:"
  ls -1 "$D" 2>/dev/null | sed 's/^/  /'
done
echo
echo "Loaded services that are not Apple's (launchctl):"
launchctl list 2>/dev/null | awk 'NR>1 && $3 !~ /^com\.apple\./ {print "  " $1 "  " $2 "  " $3}' | head -n 60
echo
echo "Cron jobs of root:"
crontab -l 2>&1 | sed 's/^/  /'
`,
        }),

    /* ------------------------------ written for all three systems ------------------------------ */
    all("clean-temp", "Clean old temporary files (all systems, changes the device)",
        "Finds temporary files not changed for N days (Windows temp folders, /tmp and /var/tmp, macOS /private/tmp) and says how much space they take. It only deletes when Dry run is no AND Confirm is YES.",
        "Maintenance", 1800,
        [
            { name: "days", label: "Only files not changed for this many days (1 to 365)", defaultValue: "7" },
            { name: "dry_run", label: "Dry run: yes only reports, no deletes", defaultValue: "yes" },
            CONFIRM_PARAM,
        ], {
            windows: win("win-clean-temp"),
            linux: HEAD + String.raw`if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
D=7
case "$ADG_DAYS" in ''|*[!0-9]*) ;; *) if [ "$ADG_DAYS" -ge 1 ] && [ "$ADG_DAYS" -le 365 ]; then D="$ADG_DAYS"; fi;; esac
ACT=0
if [ "$ADG_DRY_RUN" = "no" ] && [ "$ADG_CONFIRM" = "YES" ]; then ACT=1; fi
echo "Files in /tmp and /var/tmp not changed for $D days or more:"
N=$(find /tmp /var/tmp -xdev -type f -mtime +"$D" 2>/dev/null | wc -l | tr -d ' ')
SZ=$(find /tmp /var/tmp -xdev -type f -mtime +"$D" -print0 2>/dev/null | xargs -0 du -ck 2>/dev/null | tail -n 1 | awk '{print int($1 / 1024)}')
[ -n "$SZ" ] || SZ=0
echo "  $N files, about $SZ MB"
if [ "$ACT" = 1 ]; then
  find /tmp /var/tmp -xdev -type f -mtime +"$D" -delete 2>/dev/null
  echo "Deleted them."
else
  echo "Nothing was deleted. To delete, set Dry run to no and Confirm to YES."
fi
`,
            macos: HEAD + String.raw`if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
D=7
case "$ADG_DAYS" in ''|*[!0-9]*) ;; *) if [ "$ADG_DAYS" -ge 1 ] && [ "$ADG_DAYS" -le 365 ]; then D="$ADG_DAYS"; fi;; esac
ACT=0
if [ "$ADG_DRY_RUN" = "no" ] && [ "$ADG_CONFIRM" = "YES" ]; then ACT=1; fi
echo "Files in /private/tmp and /private/var/tmp not changed for $D days or more:"
N=$(find /private/tmp /private/var/tmp -xdev -type f -mtime +"$D" 2>/dev/null | wc -l | tr -d ' ')
SZ=$(find /private/tmp /private/var/tmp -xdev -type f -mtime +"$D" -print0 2>/dev/null | xargs -0 du -ck 2>/dev/null | tail -n 1 | awk '{print int($1 / 1024)}')
[ -n "$SZ" ] || SZ=0
echo "  $N files, about $SZ MB"
if [ "$ACT" = 1 ]; then
  find /private/tmp /private/var/tmp -xdev -type f -mtime +"$D" -delete 2>/dev/null
  echo "Deleted them."
else
  echo "Nothing was deleted. To delete, set Dry run to no and Confirm to YES."
fi
`,
        }),

    all("flush-dns", "Flush the DNS cache (all systems, changes the device)",
        "Clears the name-lookup cache of the device so it asks the DNS servers again. Does nothing unless Confirm is YES.",
        "Network", 60, [CONFIRM_PARAM], {
            windows: win("win-flush-dns"),
            linux: HEAD + String.raw`if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
if [ "$ADG_CONFIRM" != "YES" ]; then echo "Nothing was changed. Run again with Confirm set to YES to flush the DNS cache."; exit 0; fi
DONE=0
if have resolvectl && resolvectl flush-caches >/dev/null 2>&1; then echo "Flushed the systemd-resolved cache."; DONE=1; fi
if have nscd && nscd -i hosts >/dev/null 2>&1; then echo "Flushed the nscd hosts cache."; DONE=1; fi
if have dnsmasq && pkill -HUP -x dnsmasq >/dev/null 2>&1; then echo "Told dnsmasq to clear its cache."; DONE=1; fi
if [ "$DONE" = 0 ]; then echo "No caching name resolver was found, so there was nothing to flush."; fi
`,
            macos: HEAD + String.raw`if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
if [ "$ADG_CONFIRM" != "YES" ]; then echo "Nothing was changed. Run again with Confirm set to YES to flush the DNS cache."; exit 0; fi
dscacheutil -flushcache
killall -HUP mDNSResponder 2>/dev/null
echo "Flushed the DNS cache."
`,
        }),

    all("time-status", "Time and time sync status (all systems)",
        "The device clock, time zone, whether it follows a time server and which one. A wrong clock breaks certificates and sign-ins.",
        "Diagnostics", 120, [], {
            windows: String.raw`Write-Output ("Local time    : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Output ("Time zone     : {0}" -f (Get-TimeZone).DisplayName)
$svc = Get-Service -Name w32time -ErrorAction SilentlyContinue
if ($svc) { Write-Output "Windows Time service: $($svc.Status)" } else { Write-Output 'The Windows Time service is not installed.' }
Write-Output ''
$status = & w32tm.exe /query /status 2>&1
$status | ForEach-Object { Write-Output "  $_" }
Write-Output ("Time source   : {0}" -f ((& w32tm.exe /query /source 2>&1) -join ' '))
if (-not $svc -or $svc.Status -ne 'Running') { exit 1 }
`,
            linux: HEAD + String.raw`echo "Local time : $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "UTC        : $(date -u '+%Y-%m-%d %H:%M:%S')"
if have timedatectl; then
  timedatectl 2>/dev/null | sed 's/^ *//' | grep -Ei 'time zone|synchronized|NTP service|RTC' | sed 's/^/  /'
  if timedatectl 2>/dev/null | grep -qi 'synchronized: no'; then echo "The clock is NOT synchronized."; exit 1; fi
fi
if have chronyc; then echo; echo "chrony:"; chronyc tracking 2>/dev/null | head -n 8 | sed 's/^/  /'; fi
if ! have timedatectl && ! have chronyc; then echo "No time service tool (timedatectl or chronyc) was found."; fi
`,
            macos: HEAD + String.raw`echo "Local time : $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "UTC        : $(date -u '+%Y-%m-%d %H:%M:%S')"
systemsetup -gettimezone 2>/dev/null | sed 's/^/  /'
systemsetup -getusingnetworktime 2>/dev/null | sed 's/^/  /'
systemsetup -getnetworktimeserver 2>/dev/null | sed 's/^/  /'
if systemsetup -getusingnetworktime 2>/dev/null | grep -qi ': off'; then echo "The clock does not follow a time server."; exit 1; fi
`,
        }),

    all("disk-encryption", "Disk encryption status (all systems)",
        "Whether the disks are encrypted: BitLocker on Windows, LUKS on Linux, FileVault on macOS. Only reports, changes nothing.",
        "Security", 120, [], {
            windows: String.raw`$vols = $null
try { $vols = Get-BitLockerVolume -ErrorAction Stop } catch { $vols = $null }
if ($vols) {
  foreach ($v in $vols) {
    Write-Output ("  {0,-6} {1,-18} protection: {2,-4} encrypted: {3}%" -f $v.MountPoint, $v.VolumeStatus, $v.ProtectionStatus, $v.EncryptionPercentage)
  }
} else {
  Write-Output 'BitLocker volumes could not be read with the BitLocker commands. manage-bde says:'
  & manage-bde.exe -status 2>&1 | ForEach-Object { Write-Output "  $_" }
}
`,
            linux: HEAD + String.raw`if ! have lsblk; then echo "The lsblk command is missing."; exit 1; fi
echo "Block devices (a type of crypt means an unlocked encrypted volume):"
lsblk -o NAME,TYPE,FSTYPE,SIZE,MOUNTPOINT 2>/dev/null | sed 's/^/  /'
echo
if lsblk -rno TYPE,FSTYPE 2>/dev/null | grep -Eq 'crypt|crypto_LUKS'; then echo "Encrypted (LUKS) volumes are present."; else echo "No encrypted (LUKS) volume was found."; fi
`,
            macos: HEAD + String.raw`echo "FileVault:"
fdesetup status 2>&1 | sed 's/^/  /'
echo
echo "Volumes:"
diskutil apfs list 2>/dev/null | grep -E 'Name:|FileVault:' | sed 's/^ *//; s/^/  /' | head -n 30
`,
        }),

    all("firewall-status", "Firewall status (all systems)",
        "Whether the firewall is on. Windows lists its three profiles, Linux checks ufw, firewalld and nftables, macOS reads the application firewall. Exits 1 when it is off.",
        "Security", 120, [], {
            windows: String.raw`$bad = 0
Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output ("  {0,-8} enabled: {1,-5} inbound by default: {2}  outbound by default: {3}" -f $_.Name, $_.Enabled, $_.DefaultInboundAction, $_.DefaultOutboundAction)
  if (-not $_.Enabled) { $bad = 1 }
}
if ($bad -eq 1) { Write-Output 'At least one firewall profile is OFF.'; exit 1 }
`,
            linux: HEAD + String.raw`FOUND=0
if have ufw; then echo "ufw: $(ufw status 2>/dev/null | head -n 1)"; if ufw status 2>/dev/null | grep -qi 'Status: active'; then FOUND=1; fi; fi
if have firewall-cmd; then S=$(firewall-cmd --state 2>&1); echo "firewalld: $S"; if [ "$S" = "running" ]; then FOUND=1; fi; fi
if have nft; then R=$(nft list ruleset 2>/dev/null | grep -c ' rule \| accept\| drop\| reject'); echo "nftables: $R rule lines"; if [ "$R" -gt 0 ]; then FOUND=1; fi; fi
if have iptables; then R=$(iptables -S 2>/dev/null | grep -vc '^-P'); echo "iptables: $R rules"; if [ "$R" -gt 0 ]; then FOUND=1; fi; fi
if [ "$FOUND" = 0 ]; then echo "No active firewall was found."; exit 1; fi
`,
            macos: HEAD + String.raw`FW=/usr/libexec/ApplicationFirewall/socketfilterfw
if [ ! -x "$FW" ]; then echo "The application firewall tool was not found."; exit 1; fi
$FW --getglobalstate 2>&1 | sed 's/^/  /'
$FW --getstealthmode 2>&1 | sed 's/^/  /'
$FW --getblockall 2>&1 | sed 's/^/  /'
if $FW --getglobalstate 2>&1 | grep -qi 'disabled'; then echo "The firewall is OFF."; exit 1; fi
`,
        }),

    all("hardware-summary", "Hardware summary (all systems)",
        "Make, model, serial number, firmware, memory and battery of the device. Works on Windows, Linux and macOS.",
        "Inventory and reporting", 180, [], {
            windows: win("win-hardware-inventory"),
            linux: HEAD + String.raw`D=/sys/class/dmi/id
show() { if [ -r "$D/$1" ]; then echo "$2: $(cat "$D/$1" 2>/dev/null)"; fi; }
show sys_vendor "Make          "
show product_name "Model         "
show product_serial "Serial number "
show bios_vendor "Firmware maker "
show bios_version "Firmware       "
show bios_date "Firmware date  "
echo "Processor     : $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //') ($(nproc 2>/dev/null || echo '?') cores)"
if have free; then echo "Memory        : $(free -h | awk '/^Mem:/ {print $2 " total"}')"; fi
for B in /sys/class/power_supply/BAT*; do
  [ -d "$B" ] || continue
  echo "Battery       : $(cat "$B/capacity" 2>/dev/null)% ($(cat "$B/status" 2>/dev/null))"
done
if have lsblk; then echo; echo "Disks:"; lsblk -d -o NAME,SIZE,TYPE,MODEL 2>/dev/null | grep -v loop | sed 's/^/  /'; fi
`,
            macos: HEAD + String.raw`system_profiler SPHardwareDataType 2>/dev/null | grep -E 'Model Name|Model Identifier|Chip|Processor Name|Total Number of Cores|Memory:|Serial Number|System Firmware Version' | sed 's/^ *//; s/^/  /'
echo
echo "Battery:"
if pmset -g batt 2>/dev/null | grep -q 'InternalBattery'; then
  pmset -g batt 2>/dev/null | grep -E 'InternalBattery' | sed 's/^ *//; s/^/  /'
  system_profiler SPPowerDataType 2>/dev/null | grep -E 'Cycle Count|Condition|Maximum Capacity' | sed 's/^ *//; s/^/  /'
else
  echo "  no battery"
fi
echo
echo "Disks:"
diskutil list physical 2>/dev/null | grep -E '^/dev/|0:' | sed 's/^/  /'
`,
        }),

    all("local-users", "Local user accounts and administrators (all systems)",
        "The accounts that exist on the device and who is an administrator. Only reports, changes nothing.",
        "Users and accounts", 120, [], {
            windows: String.raw`Write-Output 'Local accounts:'
Get-LocalUser | ForEach-Object { Write-Output ("  {0,-26} enabled: {1,-5} last sign-in: {2}" -f $_.Name, $_.Enabled, $_.LastLogon) }
Write-Output ''
Write-Output 'Administrators:'
Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("  {0} ({1})" -f $_.Name, $_.ObjectClass) }
`,
            linux: HEAD + String.raw`echo "Accounts that can sign in (user IDs from 1000, and root):"
awk -F: '($3 == 0 || $3 >= 1000) && $1 != "nobody" && $7 !~ /(nologin|false)$/ {print "  " $1 "  (id " $3 ", shell " $7 ")"}' /etc/passwd
echo
echo "Accounts with user ID 0 (full control):"
awk -F: '$3 == 0 {print "  " $1}' /etc/passwd
echo
for G in sudo wheel admin; do
  L=$(getent group "$G" 2>/dev/null | cut -d: -f4)
  if [ -n "$L" ]; then echo "Members of group $G: $L"; fi
done
`,
            macos: HEAD + String.raw`echo "Accounts (user IDs from 500, and root):"
dscl . -list /Users UniqueID 2>/dev/null | awk '$2 >= 500 || $2 == 0 {print "  " $1 "  (id " $2 ")"}'
echo
echo "Administrators:"
dscl . -read /Groups/admin GroupMembership 2>/dev/null | sed 's/GroupMembership: //; s/^/  /'
`,
        }),

    all("who-is-signed-in", "Who is signed in (all systems)",
        "The people signed in at the device right now and the most recent sign-ins. Works on Windows, Linux and macOS.",
        "Users and accounts", 120, [], {
            windows: String.raw`Write-Output 'Signed in now:'
$q = & quser.exe 2>&1
if ($LASTEXITCODE -ne 0 -or -not $q) { Write-Output '  nobody' } else { $q | ForEach-Object { Write-Output "  $_" } }
Write-Output ''
Write-Output 'Signed-in user according to the computer system:'
Write-Output ("  {0}" -f (Get-CimInstance Win32_ComputerSystem).UserName)
`,
            linux: HEAD + String.raw`echo "Signed in now:"
if have who; then who 2>/dev/null | sed 's/^/  /'; else echo "  the who command is missing"; fi
echo
echo "Recent sign-ins:"
if have last; then last -n 10 2>/dev/null | head -n 10 | sed 's/^/  /'; else echo "  the last command is missing"; fi
`,
            macos: HEAD + String.raw`echo "Signed in now:"
who 2>/dev/null | sed 's/^/  /'
echo
echo "Recent sign-ins:"
last -10 2>/dev/null | head -n 10 | sed 's/^/  /'
`,
        }),

    all("stop-process", "Stop a process by name (all systems, changes the device)",
        "Ends every process with the given name. Core system programs and ADG RMM itself are refused. Without Confirm it only lists what it would stop.",
        "Services and processes", 120,
        [{ name: "process", label: "Process name (for example notepad, firefox)", required: true }, CONFIRM_PARAM], {
            windows: String.raw`$name = [string]$env:ADG_PROCESS
if ($name -notmatch '^[A-Za-z0-9_.+-]{1,64}$') { Write-Output 'Give a valid process name in the Process parameter.'; exit 2 }
if ($name -match '(?i)^(system|smss|csrss|wininit|winlogon|services|lsass|svchost|explorer|dwm|idle)(\.exe)?$' -or $name -match '(?i)adgrmm') { Write-Output "Refusing to stop '$name': it is a core system program or ADG RMM itself."; exit 2 }
$short = $name -replace '\.exe$', ''
$procs = @(Get-Process -Name $short -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Write-Output "No process named '$short' is running."; exit 0 }
Write-Output "Processes named '$short':"
$procs | ForEach-Object { Write-Output ("  id {0}  started {1}" -f $_.Id, $_.StartTime) }
if ($env:ADG_CONFIRM -cne 'YES') { Write-Output 'Nothing was stopped. Run again with Confirm set to YES to stop them.'; exit 0 }
$failed = 0
foreach ($p in $procs) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Write-Output "Stopped id $($p.Id)." } catch { Write-Output "Could not stop id $($p.Id): $($_.Exception.Message)"; $failed = 1 }
}
exit $failed
`,
            linux: HEAD + String.raw`P="$ADG_PROCESS"
if ! printf '%s' "$P" | grep -Eq '^[A-Za-z0-9_.+-]{1,64}$'; then echo "Give a valid process name in the Process parameter."; exit 2; fi
if printf '%s' "$P" | grep -Eiq '^(init|systemd|launchd|kernel_task|sshd|dbus-daemon|login)$|adgrmm'; then echo "Refusing to stop '$P': it is a core system program or ADG RMM itself."; exit 2; fi
if ! have pgrep; then echo "The pgrep command is missing (package: procps)."; exit 1; fi
PIDS=$(pgrep -x "$P" 2>/dev/null | grep -vx "$$")
if [ -z "$PIDS" ]; then echo "No process named '$P' is running."; exit 0; fi
echo "Processes named '$P':"
for I in $PIDS; do echo "  id $I  user $(ps -o user= -p "$I" 2>/dev/null)"; done
if [ "$ADG_CONFIRM" != "YES" ]; then echo "Nothing was stopped. Run again with Confirm set to YES to stop them."; exit 0; fi
FAILED=0
for I in $PIDS; do if kill "$I" 2>/dev/null; then echo "Stopped id $I."; else echo "Could not stop id $I."; FAILED=1; fi; done
exit $FAILED
`,
            macos: HEAD + String.raw`P="$ADG_PROCESS"
if ! printf '%s' "$P" | grep -Eq '^[A-Za-z0-9_.+-]{1,64}$'; then echo "Give a valid process name in the Process parameter."; exit 2; fi
if printf '%s' "$P" | grep -Eiq '^(init|launchd|kernel_task|sshd|loginwindow|WindowServer)$|adgrmm'; then echo "Refusing to stop '$P': it is a core system program or ADG RMM itself."; exit 2; fi
PIDS=$(pgrep -x "$P" 2>/dev/null | grep -vx "$$")
if [ -z "$PIDS" ]; then echo "No process named '$P' is running."; exit 0; fi
echo "Processes named '$P':"
for I in $PIDS; do echo "  id $I  user $(ps -o user= -p "$I" 2>/dev/null)"; done
if [ "$ADG_CONFIRM" != "YES" ]; then echo "Nothing was stopped. Run again with Confirm set to YES to stop them."; exit 0; fi
FAILED=0
for I in $PIDS; do if kill "$I" 2>/dev/null; then echo "Stopped id $I."; else echo "Could not stop id $I."; FAILED=1; fi; done
exit $FAILED
`,
        }),

    all("schedule-restart", "Schedule or cancel a restart (all systems, changes the device)",
        "Restarts the device after a number of minutes (1 to 1440), or cancels a restart that is already waiting. Does nothing unless Confirm is YES.",
        "Maintenance", 60,
        [
            { name: "minutes", label: "Restart in this many minutes (1 to 1440)", defaultValue: "5" },
            { name: "cancel", label: "Type YES to cancel a waiting restart instead", defaultValue: "NO" },
            CONFIRM_PARAM,
        ], {
            windows: String.raw`$mins = 5
if ($env:ADG_MINUTES -match '^[0-9]{1,4}$' -and [int]$env:ADG_MINUTES -ge 1 -and [int]$env:ADG_MINUTES -le 1440) { $mins = [int]$env:ADG_MINUTES }
$cancel = ($env:ADG_CANCEL -ceq 'YES')
if ($env:ADG_CONFIRM -cne 'YES') {
  if ($cancel) { Write-Output 'Nothing was changed. Run again with Confirm set to YES to cancel the waiting restart.' } else { Write-Output "Nothing was changed. Run again with Confirm set to YES to restart in $mins minutes." }
  exit 0
}
if ($cancel) {
  & shutdown.exe /a 2>&1 | ForEach-Object { Write-Output $_ }
  if ($LASTEXITCODE -ne 0) { Write-Output 'There was no restart waiting, or it could not be cancelled.'; exit 1 }
  Write-Output 'The waiting restart was cancelled.'
  exit 0
}
$secs = $mins * 60
& shutdown.exe /r /t $secs /c 'Restart requested from ADG RMM' 2>&1 | ForEach-Object { Write-Output $_ }
if ($LASTEXITCODE -ne 0) { Write-Output 'The restart could not be scheduled.'; exit 1 }
Write-Output "The device will restart in $mins minutes."
`,
            linux: HEAD + String.raw`if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
M=5
case "$ADG_MINUTES" in ''|*[!0-9]*) ;; *) if [ "$ADG_MINUTES" -ge 1 ] && [ "$ADG_MINUTES" -le 1440 ]; then M="$ADG_MINUTES"; fi;; esac
if [ "$ADG_CONFIRM" != "YES" ]; then
  if [ "$ADG_CANCEL" = "YES" ]; then echo "Nothing was changed. Run again with Confirm set to YES to cancel the waiting restart."; else echo "Nothing was changed. Run again with Confirm set to YES to restart in $M minutes."; fi
  exit 0
fi
if ! have shutdown; then echo "The shutdown command is missing."; exit 1; fi
if [ "$ADG_CANCEL" = "YES" ]; then
  if shutdown -c 2>&1; then echo "The waiting restart was cancelled."; else echo "There was no restart waiting, or it could not be cancelled."; exit 1; fi
  exit 0
fi
if shutdown -r +"$M" "Restart requested from ADG RMM" 2>&1; then echo "The device will restart in $M minutes."; else echo "The restart could not be scheduled."; exit 1; fi
`,
            macos: HEAD + String.raw`if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
M=5
case "$ADG_MINUTES" in ''|*[!0-9]*) ;; *) if [ "$ADG_MINUTES" -ge 1 ] && [ "$ADG_MINUTES" -le 1440 ]; then M="$ADG_MINUTES"; fi;; esac
if [ "$ADG_CONFIRM" != "YES" ]; then
  if [ "$ADG_CANCEL" = "YES" ]; then echo "Nothing was changed. Run again with Confirm set to YES to cancel the waiting restart."; else echo "Nothing was changed. Run again with Confirm set to YES to restart in $M minutes."; fi
  exit 0
fi
if [ "$ADG_CANCEL" = "YES" ]; then
  if pkill -x shutdown 2>/dev/null; then echo "The waiting restart was cancelled."; else echo "There was no restart waiting."; exit 1; fi
  exit 0
fi
nohup shutdown -r +"$M" "Restart requested from ADG RMM" >/dev/null 2>&1 &
sleep 1
echo "The device will restart in $M minutes."
`,
        }),

    all("file-hash", "File size and SHA-256 hash (all systems)",
        "The size, last change time and SHA-256 hash of one file, for checking that a file is what it should be. Works on Windows, Linux and macOS.",
        "Security", 300, [{ name: "path", label: "Full path of the file", required: true }], {
            windows: String.raw`$p = [string]$env:ADG_PATH
if ([string]::IsNullOrWhiteSpace($p) -or $p -match '[<>|"?*]' -or $p.Length -gt 240 -or -not (Test-Path -LiteralPath $p -PathType Leaf)) { Write-Output "The Path parameter is not a file on this computer: $p"; exit 2 }
$f = Get-Item -LiteralPath $p
$h = Get-FileHash -LiteralPath $p -Algorithm SHA256
Write-Output "File     : $($f.FullName)"
Write-Output "Size     : $($f.Length) bytes"
Write-Output "Changed  : $($f.LastWriteTime)"
Write-Output "SHA-256  : $($h.Hash.ToLower())"
`,
            linux: HEAD + String.raw`P="$ADG_PATH"
if [ -z "$P" ] || [ ! -f "$P" ] || printf '%s' "$P" | grep -q '^-'; then echo "The Path parameter is not a file on this system: $P"; exit 2; fi
if ! have sha256sum; then echo "The sha256sum command is missing."; exit 1; fi
echo "File     : $P"
echo "Size     : $(wc -c < "$P" | tr -d ' ') bytes"
echo "Changed  : $(date -r "$P" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)"
echo "SHA-256  : $(sha256sum "$P" | cut -d' ' -f1)"
`,
            macos: HEAD + String.raw`P="$ADG_PATH"
if [ -z "$P" ] || [ ! -f "$P" ] || printf '%s' "$P" | grep -q '^-'; then echo "The Path parameter is not a file on this system: $P"; exit 2; fi
echo "File     : $P"
echo "Size     : $(wc -c < "$P" | tr -d ' ') bytes"
echo "Changed  : $(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$P" 2>/dev/null)"
echo "SHA-256  : $(shasum -a 256 "$P" | cut -d' ' -f1)"
`,
        }),

    all("dns-lookup", "DNS lookup of a name (all systems)",
        "Asks the device's own name resolution for the addresses of a host name, and shows the answers. Works on Windows, Linux and macOS.",
        "Network", 60, [{ name: "name", label: "Host name to look up", required: true }], {
            windows: String.raw`$n = [string]$env:ADG_NAME
if ($n -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$') { Write-Output 'Give a valid host name in the Name parameter.'; exit 2 }
try {
  Resolve-DnsName -Name $n -ErrorAction Stop | Select-Object Name, Type, TTL, IPAddress, NameHost | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
} catch {
  Write-Output "The name '$n' could not be resolved: $($_.Exception.Message)"
  exit 1
}
`,
            linux: HEAD + String.raw`N="$ADG_NAME"
if ! printf '%s' "$N" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$'; then echo "Give a valid host name in the Name parameter."; exit 2; fi
echo "Answers of the system resolver for $N:"
R=$(getent ahosts "$N" 2>/dev/null | awk '{print $1}' | sort -u)
if [ -z "$R" ]; then echo "  none: the name could not be resolved"; exit 1; fi
echo "$R" | sed 's/^/  /'
if have nslookup; then echo; echo "nslookup:"; nslookup "$N" 2>&1 | head -n 12 | sed 's/^/  /'; fi
`,
            macos: HEAD + String.raw`N="$ADG_NAME"
if ! printf '%s' "$N" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$'; then echo "Give a valid host name in the Name parameter."; exit 2; fi
echo "Answers of the system resolver for $N:"
R=$(dscacheutil -q host -a name "$N" 2>/dev/null | awk '/ip_address|ipv6_address/ {print $2}' | sort -u)
if [ -z "$R" ]; then echo "  none: the name could not be resolved"; exit 1; fi
echo "$R" | sed 's/^/  /'
echo
echo "nslookup:"
nslookup "$N" 2>&1 | head -n 12 | sed 's/^/  /'
`,
        }),
];
