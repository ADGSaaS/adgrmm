// backend/src/automation/builtin-scripts.linux.ts
//
// The built-in bash scripts. Rules every one of them follows:
//   - Plain bash and only common tools; a missing tool is reported in words, never a crash.
//   - Read-only, unless its name says "changes the device": those only act when the Confirm parameter is YES, and the clean-up has a dry run
//     that is on by default.
//   - A parameter is read from the environment (RIQ_<NAME>), checked against a strict pattern, and passed as an ARGUMENT, never built into code.
//   - Plain output, and a non-zero exit code only for a real problem.
// The text lives in String.raw templates: it must contain no dollar-brace sequence and no backtick (so no ${VAR} and no old-style command
// substitution: use $VAR and $(command)).
import { CONFIRM_PARAM, type BuiltinScript } from "./builtin-scripts.types";

const HEAD = String.raw`#!/bin/bash
export LC_ALL=C
have() { command -v "$1" >/dev/null 2>&1; }
`;

export const LINUX_SCRIPTS: BuiltinScript[] = [
    /* ------------------------------ Diagnostics ------------------------------ */
    {
        key: "lin-system-summary",
        name: "System summary (Linux)",
        description: "Distribution, kernel, uptime, load, processor, memory, disks, virtualisation and IPv4 addresses on one screen.",
        language: "bash", category: "Diagnostics", timeoutSec: 120, parameters: [],
        script: HEAD + String.raw`if [ -r /etc/os-release ]; then . /etc/os-release; echo "OS            : $PRETTY_NAME"; fi
echo "Host name     : $(hostname)"
echo "Kernel        : $(uname -r) ($(uname -m))"
echo "Uptime        : $(awk '{d=int($1/86400); h=int(($1%86400)/3600); m=int(($1%3600)/60); printf "%d days %d hours %d minutes", d, h, m}' /proc/uptime 2>/dev/null)"
echo "Load average  : $(cut -d' ' -f1-3 /proc/loadavg)"
echo "Processor     : $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //') ($(nproc 2>/dev/null || echo '?') cores)"
if have free; then echo "Memory        : $(free -h | awk '/^Mem:/ {print $2 " total, " $3 " used, " $7 " available"}')"; fi
if have free; then echo "Swap          : $(free -h | awk '/^Swap:/ {print $2 " total, " $3 " used"}')"; fi
if have systemd-detect-virt; then echo "Virtualisation: $(systemd-detect-virt 2>/dev/null || true)"; fi
echo
echo "Disks:"
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | sed 's/^/  /'
echo
echo "IPv4 addresses:"
if have ip; then ip -4 -o addr show scope global 2>/dev/null | awk '{print "  " $4 "  (" $2 ")"}'; else hostname -I 2>/dev/null | sed 's/^/  /'; fi
`,
    },
    {
        key: "lin-top-processes",
        name: "Top processes by CPU and memory (Linux)",
        description: "The busiest processes by CPU and by memory, with their owner and how long they have run. Count parameter chooses how many (1 to 50).",
        language: "bash", category: "Diagnostics", timeoutSec: 60,
        parameters: [{ name: "count", label: "How many processes to list (1 to 50)", defaultValue: "10" }],
        script: HEAD + String.raw`if ! have ps; then echo "The ps command is not installed (package: procps), so processes cannot be listed."; exit 0; fi
N=10
case "$RIQ_COUNT" in ''|*[!0-9]*) ;; *) if [ "$RIQ_COUNT" -ge 1 ] && [ "$RIQ_COUNT" -le 50 ]; then N="$RIQ_COUNT"; fi;; esac
echo "Top $N processes by CPU:"
ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu 2>/dev/null | head -n $((N + 1)) | sed 's/^/  /'
echo
echo "Top $N processes by memory:"
ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pmem 2>/dev/null | head -n $((N + 1)) | sed 's/^/  /'
echo
echo "Load average: $(cut -d' ' -f1-3 /proc/loadavg)"
`,
    },
    {
        key: "lin-journal-errors",
        name: "System log errors, last 24 hours (Linux)",
        description: "Errors from the system journal (or the syslog files on systems without one), with the most frequent sources first. Hours parameter changes the window.",
        language: "bash", category: "Diagnostics", timeoutSec: 180,
        parameters: [{ name: "hours", label: "How many hours back (1 to 720)", defaultValue: "24" }],
        script: HEAD + String.raw`H=24
case "$RIQ_HOURS" in ''|*[!0-9]*) ;; *) if [ "$RIQ_HOURS" -ge 1 ] && [ "$RIQ_HOURS" -le 720 ]; then H="$RIQ_HOURS"; fi;; esac
if have journalctl; then
  OUT=$(journalctl -p err --since "$H hours ago" --no-pager -o short 2>/dev/null | grep -v '^-- ')
  if [ -z "$OUT" ]; then echo "No errors in the journal in the last $H hours."; exit 0; fi
  echo "$(echo "$OUT" | wc -l) error lines in the last $H hours. Most frequent sources:"
  echo "$OUT" | awk '{print $5}' | sed 's/\[[0-9]*\]://' | sort | uniq -c | sort -rn | head -10 | sed 's/^/  /'
  echo
  echo "Latest 30 lines:"
  echo "$OUT" | tail -n 30 | cut -c1-220 | sed 's/^/  /'
else
  for F in /var/log/syslog /var/log/messages; do
    if [ -r "$F" ]; then
      echo "Recent error lines in $F:"
      grep -i -E 'error|fail|critical' "$F" | tail -n 40 | cut -c1-220 | sed 's/^/  /'
      exit 0
    fi
  done
  echo "There is no journal and no readable syslog file on this system."
fi
`,
    },
    {
        key: "lin-reboot-uptime",
        name: "Uptime, kernel and restart status (Linux)",
        description: "How long it has been up, the running kernel against the newest installed one, and whether a restart is needed. Exits 1 when a restart is needed.",
        language: "bash", category: "Diagnostics", timeoutSec: 60, parameters: [],
        script: HEAD + String.raw`echo "Uptime : $(awk '{d=int($1/86400); h=int(($1%86400)/3600); m=int(($1%3600)/60); printf "%d days %d hours %d minutes", d, h, m}' /proc/uptime 2>/dev/null)"
BOOT=$(date -d "@$(( $(date +%s) - $(cut -d. -f1 /proc/uptime) ))" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)
[ -n "$BOOT" ] && echo "Booted : $BOOT"
RUN=$(uname -r)
echo "Running kernel : $RUN"
NEW=""
if have dpkg; then NEW=$(dpkg -l 'linux-image-[0-9]*' 2>/dev/null | awk '/^ii/ {print $2}' | sed 's/^linux-image-//' | sort -V | tail -n 1); fi
if [ -z "$NEW" ] && have rpm; then NEW=$(rpm -q kernel kernel-core 2>/dev/null | grep -v 'not installed' | sed 's/^kernel-core-//; s/^kernel-//' | sort -V | tail -n 1); fi
[ -n "$NEW" ] && echo "Newest installed kernel : $NEW"
NEED=0
if [ -f /var/run/reboot-required ] || [ -f /run/reboot-required ]; then
  echo "RESTART NEEDED: the system says a restart is required."
  [ -r /var/run/reboot-required.pkgs ] && echo "  because of: $(tr '\n' ' ' < /var/run/reboot-required.pkgs)"
  NEED=1
fi
if have needs-restarting; then
  needs-restarting -r >/dev/null 2>&1 || { echo "RESTART NEEDED: needs-restarting says a restart is required."; NEED=1; }
fi
if [ "$NEED" = 0 ]; then echo "No restart is needed."; fi
exit $NEED
`,
    },

    /* ------------------------------ Services and processes ------------------------------ */
    {
        key: "lin-failed-units",
        name: "Failed services (Linux)",
        description: "Services and units that failed, with their last log lines. Exits 1 when any have failed.",
        language: "bash", category: "Services and processes", timeoutSec: 60, parameters: [],
        script: HEAD + String.raw`if ! have systemctl || [ ! -d /run/systemd/system ]; then
  if have rc-status; then echo "OpenRC crashed services:"; rc-status --crashed 2>/dev/null | sed 's/^/  /'; exit 0; fi
  echo "This system does not use systemd, so there is no list of failed units."
  exit 0
fi
FAILED=$(systemctl --failed --no-legend --plain --no-pager 2>/dev/null | awk '{print $1}')
if [ -z "$FAILED" ]; then echo "No service has failed."; exit 0; fi
echo "Failed units:"
echo "$FAILED" | sed 's/^/  /'
echo
for U in $FAILED; do
  echo "--- $U"
  systemctl status "$U" --no-pager -n 6 2>/dev/null | tail -n 8 | cut -c1-200
done
exit 1
`,
    },
    {
        key: "lin-restart-service",
        name: "Restart a service (Linux, changes the device)",
        description: "Restarts one named systemd or OpenRC service and shows its state. Does nothing unless Confirm is YES. Give the service name, for example nginx.",
        language: "bash", category: "Services and processes", timeoutSec: 180,
        parameters: [{ name: "service", label: "Service name (for example nginx)", required: true }, CONFIRM_PARAM],
        script: HEAD + String.raw`S="$RIQ_SERVICE"
if ! printf '%s' "$S" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.@-]{0,79}$'; then echo "Give a valid service name in the Service parameter."; exit 2; fi
if have systemctl && [ -d /run/systemd/system ]; then
  if ! systemctl cat "$S" >/dev/null 2>&1; then echo "There is no service named $S."; exit 2; fi
  echo "Service $S is $(systemctl is-active "$S" 2>/dev/null)."
  if [ "$RIQ_CONFIRM" != "YES" ]; then echo "Nothing was changed. Run again with Confirm set to YES to restart it."; exit 0; fi
  systemctl restart "$S" || { echo "The restart failed."; systemctl status "$S" --no-pager -n 8 2>&1 | tail -n 10; exit 1; }
  sleep 2
  echo "Restarted. It is now $(systemctl is-active "$S" 2>/dev/null)."
  [ "$(systemctl is-active "$S" 2>/dev/null)" = "active" ] || exit 1
elif have rc-service; then
  if [ ! -x "/etc/init.d/$S" ]; then echo "There is no service named $S."; exit 2; fi
  rc-service "$S" status 2>&1
  if [ "$RIQ_CONFIRM" != "YES" ]; then echo "Nothing was changed. Run again with Confirm set to YES to restart it."; exit 0; fi
  rc-service "$S" restart && echo "Restarted." || { echo "The restart failed."; exit 1; }
else
  echo "This system has neither systemd nor OpenRC."
  exit 1
fi
`,
    },
    {
        key: "lin-cron-timers",
        name: "Scheduled jobs: cron and timers (Linux)",
        description: "System cron files, each user's crontab (when readable) and the systemd timers, so unexpected scheduled jobs are easy to spot.",
        language: "bash", category: "Services and processes", timeoutSec: 60, parameters: [],
        script: HEAD + String.raw`echo "/etc/crontab:"
grep -v '^#' /etc/crontab 2>/dev/null | grep -v '^$' | sed 's/^/  /'
for D in /etc/cron.d; do
  if [ -d "$D" ]; then echo "$D:"; for F in "$D"/*; do [ -f "$F" ] && { echo "  $F"; grep -v '^#' "$F" | grep -v '^$' | sed 's/^/      /'; }; done; fi
done
echo "Daily, weekly and monthly scripts:"
ls /etc/cron.daily /etc/cron.weekly /etc/cron.monthly /etc/cron.hourly 2>/dev/null | sed 's/^/  /'
echo
echo "User crontabs:"
for U in $(cut -d: -f1 /etc/passwd); do
  C=$(crontab -l -u "$U" 2>/dev/null | grep -v '^#' | grep -v '^$')
  [ -n "$C" ] && { echo "  $U:"; echo "$C" | sed 's/^/      /'; }
done
echo
if have systemctl && [ -d /run/systemd/system ]; then
  echo "systemd timers:"
  systemctl list-timers --all --no-pager 2>/dev/null | head -n 30 | cut -c1-200 | sed 's/^/  /'
fi
`,
    },

    /* ------------------------------ Storage and disk ------------------------------ */
    {
        key: "lin-disk-usage",
        name: "Disk space, inodes and biggest folders (Linux)",
        description: "Free space and inode use on every real file system, and the biggest folders directly under a path (default /). Exits 1 when a file system is over 90% full.",
        language: "bash", category: "Storage and disk", timeoutSec: 900,
        parameters: [{ name: "path", label: "Folder to look inside", defaultValue: "/" }],
        script: HEAD + String.raw`echo "Space:"
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | sed 's/^/  /'
echo
echo "Inodes:"
df -i -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | sed 's/^/  /'
P="$RIQ_PATH"
[ -n "$P" ] || P=/
if [ ! -d "$P" ] || printf '%s' "$P" | grep -q '^-'; then echo; echo "The Path parameter is not a folder on this system: $P"; exit 2; fi
echo
echo "Biggest folders directly under $P (same file system only):"
du -xh --max-depth=1 "$P" 2>/dev/null | sort -rh | head -n 12 | sed 's/^/  /'
FULL=$(df -P -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | awk 'NR>1 {gsub("%","",$5); if ($5+0 >= 90) print $6 " (" $5 "%)"}')
if [ -n "$FULL" ]; then echo; echo "OVER 90% FULL: $FULL"; exit 1; fi
`,
    },
    {
        key: "lin-disk-health",
        name: "Disk health, SMART status (Linux)",
        description: "The SMART health verdict and key counters of each physical disk (needs smartmontools). Without it, says so and shows what the kernel knows. Exits 1 when a disk fails its check.",
        language: "bash", category: "Storage and disk", timeoutSec: 180, parameters: [],
        script: HEAD + String.raw`if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
echo "Disks:"
lsblk -d -o NAME,SIZE,TYPE,ROTA,MODEL 2>/dev/null | grep -v loop | sed 's/^/  /'
echo
if ! have smartctl; then
  echo "smartmontools (smartctl) is not installed, so SMART health cannot be read. Install it from the Software tab (package: smartmontools)."
  exit 0
fi
BAD=0
for D in $(lsblk -d -n -o NAME,TYPE 2>/dev/null | awk '$2=="disk" {print $1}'); do
  echo "/dev/$D:"
  OUT=$(smartctl -H -A "/dev/$D" 2>&1)
  echo "$OUT" | grep -E 'overall-health|SMART Health Status|Reallocated_Sector|Current_Pending|Offline_Uncorrectable|Temperature|Power_On_Hours|Percentage Used|Media_Wearout|Critical Warning' | sed 's/^/  /'
  echo "$OUT" | grep -q 'Unable to detect device type\|SMART support is: Unavailable' && echo "  SMART is not available on this device (a virtual disk, for example)"
  echo "$OUT" | grep -Eq 'overall-health.*(FAILED)|SMART Health Status: (FAIL|BAD)' && { echo "  >>> THIS DISK FAILED ITS HEALTH CHECK"; BAD=1; }
done
exit $BAD
`,
    },

    /* ------------------------------ Maintenance ------------------------------ */
    {
        key: "lin-clean-caches",
        name: "Clean package caches and old logs (Linux, changes the device)",
        description: "Reports the space used by the package cache and the system journal, and what is older than N days. It only cleans when Dry run is no AND Confirm is YES. Never touches user files.",
        language: "bash", category: "Maintenance", timeoutSec: 900,
        parameters: [
            { name: "days", label: "Keep journal entries for this many days (1 to 365)", defaultValue: "14" },
            { name: "dry_run", label: "Dry run: yes only reports, no changes", defaultValue: "yes" },
            CONFIRM_PARAM,
        ],
        script: HEAD + String.raw`if [ "$(id -u)" != "0" ]; then echo "This needs to run as root."; exit 1; fi
DAYS=14
case "$RIQ_DAYS" in ''|*[!0-9]*) ;; *) if [ "$RIQ_DAYS" -ge 1 ] && [ "$RIQ_DAYS" -le 365 ]; then DAYS="$RIQ_DAYS"; fi;; esac
ACT=0
if [ "$RIQ_DRY_RUN" = "no" ] && [ "$RIQ_CONFIRM" = "YES" ]; then ACT=1; fi
echo "Space on / before: $(df -h / | awk 'NR==2 {print $4 " free of " $2}')"
echo
if have journalctl; then
  echo "System journal: $(journalctl --disk-usage 2>/dev/null | sed 's/.*take up //; s/ on disk.*//')"
  if [ "$ACT" = 1 ]; then journalctl --vacuum-time="$DAYS"d 2>&1 | tail -n 2 | sed 's/^/  /'; fi
fi
if have apt-get; then
  echo "apt cache: $(du -sh /var/cache/apt/archives 2>/dev/null | cut -f1)"
  if [ "$ACT" = 1 ]; then apt-get clean && echo "  apt cache cleaned"; fi
fi
if have dnf; then
  echo "dnf cache: $(du -sh /var/cache/dnf 2>/dev/null | cut -f1)"
  if [ "$ACT" = 1 ]; then dnf clean all >/dev/null 2>&1 && echo "  dnf cache cleaned"; fi
elif have yum; then
  echo "yum cache: $(du -sh /var/cache/yum 2>/dev/null | cut -f1)"
  if [ "$ACT" = 1 ]; then yum clean all >/dev/null 2>&1 && echo "  yum cache cleaned"; fi
fi
if have zypper; then
  echo "zypper cache: $(du -sh /var/cache/zypp 2>/dev/null | cut -f1)"
  if [ "$ACT" = 1 ]; then zypper clean --all >/dev/null 2>&1 && echo "  zypper cache cleaned"; fi
fi
if have apk; then
  echo "apk cache: $(du -sh /var/cache/apk 2>/dev/null | cut -f1)"
  if [ "$ACT" = 1 ]; then apk cache clean >/dev/null 2>&1 && echo "  apk cache cleaned"; fi
fi
echo
if [ "$ACT" = 1 ]; then
  echo "Space on / after: $(df -h / | awk 'NR==2 {print $4 " free of " $2}')"
else
  echo "DRY RUN: nothing was changed. To clean, set Dry run to no and Confirm to YES."
fi
`,
    },

    /* ------------------------------ Network ------------------------------ */
    {
        key: "lin-network-info",
        name: "Network addresses, routes and DNS (Linux)",
        description: "Each interface with its addresses and state, the default route, the DNS servers in use, and whether name lookup and the internet answer.",
        language: "bash", category: "Network", timeoutSec: 60, parameters: [],
        script: HEAD + String.raw`echo "Interfaces:"
if have ip; then ip -br addr 2>/dev/null | sed 's/^/  /'; else ifconfig 2>/dev/null | sed 's/^/  /'; fi
echo
echo "Routes:"
if have ip; then ip route 2>/dev/null | sed 's/^/  /'; else route -n 2>/dev/null | sed 's/^/  /'; fi
echo
echo "DNS servers:"
if have resolvectl; then resolvectl dns 2>/dev/null | sed 's/^/  /'; fi
grep '^nameserver' /etc/resolv.conf 2>/dev/null | sed 's/^/  /'
echo
echo "Lookup test (example.com):"
R=$(getent hosts example.com 2>/dev/null | head -n 1)
if [ -n "$R" ]; then echo "  answers: $R"; else echo "  FAILED: name lookup did not answer"; fi
echo "Internet test (a TCP connection to 1.1.1.1 port 443):"
if timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then echo "  reachable"; else echo "  NOT reachable"; fi
`,
    },
    {
        key: "lin-test-connection",
        name: "Test a connection to a host (Linux)",
        description: "Ping, an optional TCP port test and a short trace route to a host name or address. Use it to check that a device can reach a server or service.",
        language: "bash", category: "Network", timeoutSec: 180,
        parameters: [
            { name: "host", label: "Host name or IP address", required: true },
            { name: "port", label: "TCP port to test (optional)", defaultValue: "" },
        ],
        script: HEAD + String.raw`H="$RIQ_HOST"
if ! printf '%s' "$H" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$'; then echo "Give a valid host name or address in the Host parameter."; exit 2; fi
PORT="$RIQ_PORT"
if [ -n "$PORT" ]; then
  case "$PORT" in *[!0-9]*) echo "The Port parameter must be a number from 1 to 65535."; exit 2;; esac
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echo "The Port parameter must be a number from 1 to 65535."; exit 2; fi
fi
FAIL=0
echo "Name lookup for $H:"
getent hosts "$H" 2>/dev/null | head -n 2 | sed 's/^/  /' || true
echo "Ping $H (4 tries):"
if have ping; then ping -c 4 -W 2 "$H" 2>&1 | tail -n 4 | sed 's/^/  /'; else echo "  ping is not installed"; fi
if [ -n "$PORT" ]; then
  echo "TCP port $PORT on $H:"
  if timeout 6 bash -c 'exec 3<>/dev/tcp/"$1"/"$2"' _ "$H" "$PORT" 2>/dev/null; then echo "  open"; else echo "  closed or filtered"; FAIL=1; fi
fi
echo "Route (up to 15 hops):"
if have traceroute; then traceroute -n -m 15 -w 1 "$H" 2>&1 | sed 's/^/  /'
elif have tracepath; then tracepath -n -m 15 "$H" 2>&1 | head -n 20 | sed 's/^/  /'
else echo "  neither traceroute nor tracepath is installed"; fi
exit $FAIL
`,
    },
    {
        key: "lin-listening-ports",
        name: "Listening ports and their programs (Linux)",
        description: "Every TCP and UDP port the system listens on, with the program that owns it. Use it to find services that should not be exposed.",
        language: "bash", category: "Network", timeoutSec: 60, parameters: [],
        script: HEAD + String.raw`if have ss; then
  echo "Listening sockets (TCP and UDP):"
  ss -H -tulpn 2>/dev/null | awk '{print $1 "  " $5 "  " $7}' | sort -u | sed 's/^/  /'
elif have netstat; then
  netstat -tulpn 2>/dev/null | sed 's/^/  /'
else
  echo "Neither ss nor netstat is installed (package: iproute2 or net-tools), so these are the ports from /proc/net, without program names:"
  for F in tcp tcp6 udp udp6; do
    [ -r "/proc/net/$F" ] || continue
    awk -v f="$F" 'NR>1 && ($4=="0A" || (f ~ /^udp/ && $4=="07")) {print $2}' "/proc/net/$F" | while read ADDR; do
      HEXP=$(echo "$ADDR" | cut -d: -f2)
      echo "  $F  port $(printf '%d' "0x$HEXP")"
    done
  done | sort -u
fi
echo
echo "Ports open to every address (not only this machine):"
if have ss; then ss -H -tuln 2>/dev/null | awk '$5 !~ /^(127\.|\[::1\]|::1)/ {print "  " $1 "  " $5}' | sort -u; fi
`,
    },

    /* ------------------------------ Security ------------------------------ */
    {
        key: "lin-firewall-status",
        name: "Firewall and fail2ban status (Linux)",
        description: "Which firewall manager is active (ufw, firewalld, nftables, iptables) and its rules, plus fail2ban jails and banned addresses. Exits 1 when no firewall is active.",
        language: "bash", category: "Security", timeoutSec: 60, parameters: [],
        script: HEAD + String.raw`ON=0
if have ufw; then echo "ufw: $(ufw status 2>/dev/null | head -n 1)"; ufw status 2>/dev/null | sed -n '2,25p' | sed 's/^/  /'; ufw status 2>/dev/null | grep -qi '^Status: active' && ON=1; fi
if have firewall-cmd; then
  S=$(firewall-cmd --state 2>/dev/null)
  [ -n "$S" ] || S="not running"
  echo "firewalld: $S"
  if [ "$S" = "running" ]; then ON=1; firewall-cmd --list-all 2>/dev/null | sed 's/^/  /'; fi
fi
if have nft; then
  N=$(nft list ruleset 2>/dev/null | wc -l)
  echo "nftables: $N lines of rules"
  nft list ruleset 2>/dev/null | grep -q 'hook input' && ON=1
fi
if have iptables; then
  R=$(iptables -S INPUT 2>/dev/null | grep -c '^-A')
  echo "iptables: $R rules in INPUT, policy $(iptables -S INPUT 2>/dev/null | awk '/^-P INPUT/ {print $3}')"
  [ "$R" -gt 0 ] && ON=1
fi
echo
if have fail2ban-client; then
  echo "fail2ban:"
  fail2ban-client status 2>/dev/null | sed 's/^/  /'
  for J in $(fail2ban-client status 2>/dev/null | grep 'Jail list' | sed 's/.*:\s*//; s/,//g'); do
    echo "  jail $J: $(fail2ban-client status "$J" 2>/dev/null | grep -E 'Currently banned|Total banned' | tr '\n' ' ' | sed 's/\s\+/ /g')"
  done
else
  echo "fail2ban is not installed."
fi
echo
if [ "$ON" = 1 ]; then echo "A firewall is active."; else echo "NO FIREWALL IS ACTIVE (or the tools could not read it: run as root)."; exit 1; fi
`,
    },
    {
        key: "lin-ssh-config",
        name: "SSH server settings summary (Linux)",
        description: "Whether the SSH server is installed and running, its port, and the settings that matter most: root login, password logins, empty passwords and allowed users. Exits 1 on risky settings.",
        language: "bash", category: "Security", timeoutSec: 60, parameters: [],
        script: HEAD + String.raw`SSHD=""
for P in /usr/sbin/sshd /usr/local/sbin/sshd /sbin/sshd; do [ -x "$P" ] && SSHD="$P" && break; done
if [ -z "$SSHD" ]; then echo "The SSH server is not installed."; exit 0; fi
RUN="not known"
if have systemctl && [ -d /run/systemd/system ]; then
  if systemctl is-active ssh >/dev/null 2>&1 || systemctl is-active sshd >/dev/null 2>&1; then RUN="running"; else RUN="not running"; fi
elif have rc-service; then rc-service sshd status >/dev/null 2>&1 && RUN="running" || RUN="not running"; fi
echo "SSH server: $RUN"
CFG=$(timeout 6 "$SSHD" -T 2>/dev/null)
if [ -z "$CFG" ]; then
  CFG=$(cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | grep -v '^#' | awk 'NF>=2 {print tolower($1) " " tolower($2)}')
  echo "(read from the files: settings that are not written there use the defaults)"
fi
for K in port permitrootlogin passwordauthentication permitemptypasswords pubkeyauthentication x11forwarding allowusers allowgroups maxauthtries; do
  V=$(echo "$CFG" | awk -v k="$K" '$1==k {print $2; exit}')
  [ -n "$V" ] || V=default
  echo "  $K: $V"
done
RISK=0
echo "$CFG" | grep -q '^permitrootlogin yes' && { echo "RISK: root can sign in with a password."; RISK=1; }
echo "$CFG" | grep -q '^permitemptypasswords yes' && { echo "RISK: empty passwords are allowed."; RISK=1; }
echo "$CFG" | grep -q '^passwordauthentication yes' && echo "Note: password sign-in is on (keys only is safer)."
exit $RISK
`,
    },
    {
        key: "lin-sudo-logins",
        name: "Administrators and recent sign-ins (Linux)",
        description: "Accounts that can use sudo or are in the admin groups, accounts with no password, the last sign-ins and a count of failed attempts.",
        language: "bash", category: "Users and accounts", timeoutSec: 60, parameters: [],
        script: HEAD + String.raw`echo "Members of the administrator groups:"
for G in sudo wheel admin; do
  L=$(getent group "$G" 2>/dev/null | cut -d: -f4)
  [ -n "$L" ] && echo "  $G: $L"
done
echo
echo "Accounts with user id 0:"
awk -F: '$3==0 {print "  " $1}' /etc/passwd
echo
if [ -r /etc/shadow ]; then
  echo "Accounts with an empty password field:"
  E=$(awk -F: '$2=="" {print "  " $1}' /etc/shadow)
  if [ -n "$E" ]; then echo "$E"; else echo "  none"; fi
  echo
fi
echo "Last sign-ins:"
if have last; then last -n 15 -a 2>/dev/null | grep -v '^$' | sed 's/^/  /'; else echo "  the last command is not installed"; fi
echo
if have lastb && [ -r /var/log/btmp ]; then echo "Failed sign-in attempts on record: $(lastb 2>/dev/null | grep -vc '^$\|btmp begins')"; fi
`,
    },

    /* ------------------------------ Software and updates ------------------------------ */
    {
        key: "lin-pending-updates",
        name: "Pending package updates (Linux)",
        description: "The updates waiting to be installed, and which look like security updates, using whichever package manager the system has. Reads the local package lists: it does not refresh them or install anything.",
        language: "bash", category: "Software and updates", timeoutSec: 300, parameters: [],
        script: HEAD + String.raw`if have apt-get; then
  echo "apt (from the local package lists):"
  L=$(apt list --upgradable 2>/dev/null | grep -v '^Listing')
  N=$(echo "$L" | grep -c '/')
  echo "  $N updates waiting"
  echo "$L" | grep -i security | sed 's/^/  SECURITY: /' | head -n 20
  echo "$L" | head -n 40 | sed 's/^/  /'
elif have dnf; then
  echo "dnf:"
  dnf -q check-update 2>/dev/null | grep -v '^$' | head -n 60 | sed 's/^/  /'
  echo "Security updates:"
  dnf -q updateinfo list security 2>/dev/null | head -n 30 | sed 's/^/  /'
elif have yum; then
  yum -q check-update 2>/dev/null | head -n 60 | sed 's/^/  /'
elif have zypper; then
  echo "zypper:"
  zypper -q --non-interactive list-updates 2>/dev/null | head -n 60 | sed 's/^/  /'
elif have apk; then
  echo "apk:"
  apk version -l '<' 2>/dev/null | head -n 60 | sed 's/^/  /'
elif have pacman; then
  echo "pacman:"
  pacman -Qu 2>/dev/null | head -n 60 | sed 's/^/  /'
else
  echo "No supported package manager was found."
  exit 1
fi
`,
    },
    {
        key: "lin-installed-packages",
        name: "Installed packages (Linux)",
        description: "Every installed package with its version, sorted by name, from whichever package manager the system has, and a count.",
        language: "bash", category: "Software and updates", timeoutSec: 180, parameters: [],
        script: HEAD + String.raw`if have dpkg; then OUT=$(dpkg -l 2>/dev/null | awk '/^ii/ {print $2 "  " $3}')
elif have rpm; then OUT=$(rpm -qa --qf '%{NAME}  %{VERSION}-%{RELEASE}\n' 2>/dev/null | sort)
elif have apk; then OUT=$(apk list --installed 2>/dev/null | awk '{print $1}' | sort)
elif have pacman; then OUT=$(pacman -Q 2>/dev/null | sort)
else echo "No supported package manager was found."; exit 1; fi
echo "$(echo "$OUT" | grep -c .) packages installed:"
echo "$OUT" | sed 's/^/  /'
`,
    },

    /* ------------------------------ Inventory and reporting ------------------------------ */
    {
        key: "lin-docker-status",
        name: "Docker containers and images (Linux)",
        description: "Running and stopped containers, images, and the space Docker uses. Says so plainly when Docker is not installed.",
        language: "bash", category: "Inventory and reporting", timeoutSec: 120, parameters: [],
        script: HEAD + String.raw`if ! have docker; then echo "Docker is not installed on this system."; exit 0; fi
if ! docker info >/dev/null 2>&1; then echo "Docker is installed but its service is not reachable (not running, or this account may not use it)."; exit 1; fi
echo "Containers:"
docker ps -a 2>/dev/null | cut -c1-200 | sed 's/^/  /'
echo
echo "Images:"
docker images 2>/dev/null | head -n 30 | sed 's/^/  /'
echo
echo "Disk used by Docker:"
docker system df 2>/dev/null | sed 's/^/  /'
UNHEALTHY=$(docker ps -q --filter health=unhealthy 2>/dev/null | wc -l)
if [ "$UNHEALTHY" -gt 0 ]; then echo; echo "UNHEALTHY containers: $UNHEALTHY"; docker ps --filter health=unhealthy 2>/dev/null | cut -c1-200 | sed 's/^/  /'; exit 1; fi
`,
    },
];
