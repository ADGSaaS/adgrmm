// backend/src/auto-repair/auto-repair.linux.ts
//
// The two scripts the automatic repair runs on a Linux computer (the agent's own signed script jobs, run by bash). Like the Windows ones they are fixed
// text: what to look at or repair comes in as environment variables (ADG_CHECKS, ADG_FIX), never pasted into the script. The first only reads. The
// second only does what is written here for the problems it is asked about, and says for each one whether it worked. ADG_DRYRUN=1 changes nothing.
// Output protocol is the same as on Windows: ISSUE id|detail, INFO key|value, DONE; FIXED id|text, FAILED id|text.

export const LINUX_DIAGNOSE_KIND = "auto-repair.linux.diagnose";
export const LINUX_REPAIR_KIND = "auto-repair.linux.repair";

export const LINUX_DIAGNOSE_SCRIPT = String.raw`#!/bin/bash
export LC_ALL=C
checks=",${'$'}{ADG_CHECKS// /},"
clean() { printf '%s' "$1" | tr '\r\n|' '   ' | cut -c1-300; }
issue() { echo "ISSUE $1|$(clean "$2")"; }
info() { echo "INFO $1|$(clean "$2")"; }
want() { case "$checks" in *",$1,"*) return 0;; esac; return 1; }

info host "$(hostname 2>/dev/null)"
info uptime_days "$(awk '{printf "%d", $1/86400}' /proc/uptime 2>/dev/null)"

if want disk; then
  worst=""
  for m in / /var /home; do
    mountpoint -q "$m" 2>/dev/null || [ "$m" = "/" ] || continue
    line=$(df -P -k "$m" 2>/dev/null | awk 'NR==2 {print $2, $4, $6}')
    [ -n "$line" ] || continue
    total=$(echo "$line" | awk '{print $1}'); free=$(echo "$line" | awk '{print $2}')
    [ "$total" -gt 0 ] 2>/dev/null || continue
    freegb=$(awk -v f="$free" 'BEGIN {printf "%.1f", f/1048576}')
    pct=$(awk -v f="$free" -v t="$total" 'BEGIN {printf "%d", f*100/t}')
    info "free_$(echo "$m" | tr '/' '_')" "$freegb GB ($pct%)"
    if [ "$free" -lt 5242880 ] || [ "$pct" -lt 10 ]; then worst="$m has $freegb GB free ($pct%)"; fi
  done
  [ -n "$worst" ] && issue linux-low-disk "$worst"
fi

if want reboot; then
  if [ -e /var/run/reboot-required ] || [ -e /run/reboot-required ]; then issue linux-pending-reboot "A restart is waiting (updates need it)."; fi
fi

if want time; then
  if command -v timedatectl >/dev/null 2>&1; then
    sync=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)
    info time_synchronized "${'$'}{sync:-unknown}"
    [ "$sync" = "no" ] && issue linux-time-not-synced "The clock is not synchronized with a time server."
  fi
fi

if want network; then
  if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 || ping -c1 -W2 8.8.8.8 >/dev/null 2>&1; then
    info internet "reachable by address"
    if ! getent hosts www.google.com >/dev/null 2>&1 && ! getent hosts www.microsoft.com >/dev/null 2>&1; then
      issue linux-dns-broken "The internet is reachable by address but names do not resolve."
    fi
  else
    info internet "not reachable by address"
  fi
fi

if want services; then
  if command -v systemctl >/dev/null 2>&1; then
    failed=$(systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}' | head -20 | tr '\n' ' ')
    [ -n "$failed" ] && issue linux-service-failed "Failed services: $failed"
  fi
fi
echo DONE
`;

/** Services that are safe to restart on their own. Anything else that has failed is reported, never touched. */
export const LINUX_SAFE_UNITS = "cups|NetworkManager|systemd-resolved|systemd-timesyncd|chrony|chronyd|ssh|sshd|avahi-daemon|cron|crond|rsyslog|nginx|apache2|httpd|docker|containerd|fail2ban|ufw|firewalld|smbd|nmbd|bluetooth|snapd|unattended-upgrades|packagekit|colord|ModemManager|wpa_supplicant|gdm|lightdm|sddm|cups-browsed";

export const LINUX_REPAIR_SCRIPT = String.raw`#!/bin/bash
export LC_ALL=C
dry=0; [ "$ADG_DRYRUN" = "1" ] && dry=1
clean() { printf '%s' "$1" | tr '\r\n|' '   ' | cut -c1-300; }
fixed() { echo "FIXED $1|$(clean "$2")"; }
failed() { echo "FAILED $1|$(clean "$2")"; }
safe='^(${LINUX_SAFE_UNITS})\.service$'

for id in $(echo "$ADG_FIX" | tr ',' ' '); do
  case "$id" in
    linux-low-disk)
      before=$(df -P -k / | awk 'NR==2 {print $4}')
      if [ $dry = 1 ]; then
        n=$(find /tmp /var/tmp -xdev -type f -mtime +3 2>/dev/null | wc -l)
        fixed "$id" "DRY RUN: would delete $n temporary file(s), clean the package cache and trim the system log"
        continue
      fi
      find /tmp /var/tmp -xdev -type f -mtime +3 -delete 2>/dev/null
      command -v journalctl >/dev/null 2>&1 && journalctl --vacuum-time=7d >/dev/null 2>&1
      if command -v apt-get >/dev/null 2>&1; then apt-get clean >/dev/null 2>&1
      elif command -v dnf >/dev/null 2>&1; then dnf clean all >/dev/null 2>&1
      elif command -v yum >/dev/null 2>&1; then yum clean all >/dev/null 2>&1
      elif command -v apk >/dev/null 2>&1; then apk cache clean >/dev/null 2>&1; fi
      after=$(df -P -k / | awk 'NR==2 {print $4}'); total=$(df -P -k / | awk 'NR==2 {print $2}')
      freedmb=$(( (after - before) / 1024 )); freegb=$(awk -v f="$after" 'BEGIN {printf "%.1f", f/1048576}'); pct=$(( after * 100 / total ))
      if [ "$after" -ge 5242880 ] && [ "$pct" -ge 10 ]; then fixed "$id" "Old temporary files, the package cache and old system logs were cleared: $freedmb MB freed, $freegb GB free now."
      else failed "$id" "Cleaned $freedmb MB but only $freegb GB ($pct%) is free. More space is needed."; fi
      ;;
    linux-time-not-synced)
      if [ $dry = 1 ]; then fixed "$id" "DRY RUN: would switch on time synchronization and restart the time service"; continue; fi
      timedatectl set-ntp true >/dev/null 2>&1
      for u in chronyd chrony systemd-timesyncd; do systemctl list-unit-files "$u.service" >/dev/null 2>&1 && systemctl restart "$u" >/dev/null 2>&1; done
      ok=no
      for i in 1 2 3 4 5 6; do sleep 5; [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ] && { ok=yes; break; }; done
      if [ $ok = yes ]; then fixed "$id" "Time synchronization is on and the clock is synchronized."; else failed "$id" "Time synchronization was switched on but the clock did not synchronize in 30 seconds (a time server may be blocked)."; fi
      ;;
    linux-dns-broken)
      if [ $dry = 1 ]; then fixed "$id" "DRY RUN: would restart the name resolver"; continue; fi
      for u in systemd-resolved NetworkManager; do systemctl is-enabled "$u" >/dev/null 2>&1 && systemctl restart "$u" >/dev/null 2>&1; done
      sleep 4
      if getent hosts www.google.com >/dev/null 2>&1 || getent hosts www.microsoft.com >/dev/null 2>&1; then fixed "$id" "The name resolver was restarted and names resolve again."
      else failed "$id" "The name resolver was restarted but names still do not resolve (check the DNS servers in the network settings)."; fi
      ;;
    linux-service-failed)
      units=$(systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}' | head -20)
      done_=""; left=""
      for u in $units; do
        if echo "$u" | grep -Eq "$safe"; then
          if [ $dry = 1 ]; then done_="$done_ $u"; continue; fi
          systemctl reset-failed "$u" >/dev/null 2>&1; systemctl restart "$u" >/dev/null 2>&1; sleep 2
          if systemctl is-active --quiet "$u"; then done_="$done_ $u"; else left="$left $u"; fi
        else left="$left $u"; fi
      done
      if [ $dry = 1 ]; then fixed "$id" "DRY RUN: would restart:${'$'}{done_:- nothing} (not touched:${'$'}{left:- nothing})"
      elif [ -z "$left" ] && [ -n "$done_" ]; then fixed "$id" "Restarted:$done_."
      else failed "$id" "Restarted:${'$'}{done_:- nothing}. Still failed or not on the safe list:$left."; fi
      ;;
    *) failed "$id" "There is no automatic repair for this." ;;
  esac
done
echo DONE
`;
