// Four actions a person can start from a Linux device's Security tab, each a fixed signed bash job that takes no input:
//   - firewall-enable: turns on the firewall the machine already has (ufw or firewalld), after allowing the SSH port(s) the SSH
//     server listens on, so turning it on cannot lock the person out of SSH. Everything else coming in is then blocked.
//     It never installs a firewall; with none installed it says which package to install (the Software tab does that).
//   - antivirus-install / antivirus-update: install ClamAV with automatic signature updates, and update the signatures now.
//   - malware-scan: runs ClamAV (clamscan) at low priority over the places malware lands (home folders, /tmp, /var/tmp, /opt, /srv,
//     /var/www, /usr/local). It never installs ClamAV and never deletes, moves or quarantines anything: it only reports.
// What the device printed is never trusted: parseLinuxAction accepts only the exact line shapes below and clips every text.
// The scripts contain no dollar-brace sequence, no backtick and no double curly brace.

import { ToolOutputError } from "../device-tools/device-tools.scripts";

export type LinuxAction = "firewall-enable" | "malware-scan" | "antivirus-install" | "antivirus-update";
export const LINUX_ACTIONS: LinuxAction[] = ["firewall-enable", "malware-scan", "antivirus-install", "antivirus-update"];
export const LINUX_ACTION_KIND: Record<LinuxAction, string> = { "firewall-enable": "security.linux.firewall-enable", "malware-scan": "security.linux.malware-scan", "antivirus-install": "security.linux.antivirus-install", "antivirus-update": "security.linux.antivirus-update" };
/** A malware scan can run long; a firewall change is quick. */
export const LINUX_ACTION_TIMEOUT_SEC: Record<LinuxAction, number> = { "firewall-enable": 120, "malware-scan": 30 * 60, "antivirus-install": 25 * 60, "antivirus-update": 16 * 60 };

const PRELUDE = String.raw`#!/bin/bash
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
fail() { echo "$1" >&2; exit "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
[ "$(id -u)" = "0" ] || fail "The agent is not running as root, so it cannot do this." 77
`;

export const LINUX_FIREWALL_ENABLE_SCRIPT = PRELUDE + String.raw`
# The ports the SSH server listens on (22 when that cannot be read). They are allowed BEFORE the firewall is switched on.
SSHD=""
for P in /usr/sbin/sshd /usr/local/sbin/sshd /sbin/sshd; do [ -x "$P" ] && SSHD=$P && break; done
PORTS=""
if [ -n "$SSHD" ]; then PORTS=$(timeout 6 "$SSHD" -T 2>/dev/null </dev/null | awk '$1=="port"{print $2}' | grep -E '^[0-9]{1,5}$' | sort -un | head -5 | tr '\n' ' '); fi
if [ -z "$PORTS" ] && [ -r /etc/ssh/sshd_config ]; then PORTS=$(cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | awk 'tolower($1)=="port"{print $2}' | grep -E '^[0-9]{1,5}$' | sort -un | head -5 | tr '\n' ' '); fi
[ -n "$PORTS" ] || PORTS="22"

if have ufw; then
  if ufw status 2>/dev/null | head -1 | grep -qi '^Status: active'; then echo "OK The firewall (ufw) was already on."; exit 0; fi
  for P in $PORTS; do ufw allow "$P/tcp" >/dev/null 2>&1 || fail "Could not allow SSH on port $P, so the firewall was NOT turned on." 1; done
  ufw --force enable >/dev/null 2>&1 || fail "ufw would not start." 1
  ufw status 2>/dev/null | head -1 | grep -qi '^Status: active' || fail "ufw did not turn on." 1
  echo "OK The firewall (ufw) is on. Incoming SSH (port $PORTS) is allowed; everything else coming in is blocked."
elif have firewall-cmd; then
  systemctl enable --now firewalld >/dev/null 2>&1 || fail "firewalld would not start." 1
  [ "$(firewall-cmd --state 2>/dev/null)" = "running" ] || fail "firewalld is not running." 1
  for P in $PORTS; do
    [ "$P" = "22" ] && continue
    firewall-cmd --permanent --add-port="$P/tcp" >/dev/null 2>&1 || fail "Could not allow SSH on port $P in firewalld." 1
  done
  firewall-cmd --reload >/dev/null 2>&1
  echo "OK The firewall (firewalld) is on. SSH (port $PORTS) is allowed; other incoming traffic follows the zone's rules."
else
  fail "No firewall is installed. Install ufw (Ubuntu and Debian) or firewalld (Fedora, Rocky, RHEL, SUSE) from the Software tab, then try again." 69
fi
`;

export const LINUX_MALWARE_SCAN_SCRIPT = PRELUDE + String.raw`
have clamscan || fail "ClamAV is not installed. Install the clamav package from the Software tab, then run this again." 69
DIRS=""
for D in /home /root /tmp /var/tmp /opt /srv /var/www /usr/local; do [ -d "$D" ] && DIRS="$DIRS $D"; done
[ -n "$DIRS" ] || fail "There is nothing to scan." 1
S=$(date +%s)
OUT=$(nice -n 19 timeout 1500 clamscan -r -i --max-filesize=100M --max-scansize=400M --exclude-dir='^/proc' --exclude-dir='^/sys' $DIRS 2>&1 </dev/null)
RC=$?
E=$(( $(date +%s) - S ))
if [ "$RC" -gt 1 ]; then
  echo "E $(printf '%s' "$OUT" | grep -v '^$' | grep -v 'FOUND$' | tail -1 | tr -d '\000-\037' | cut -c1-160)"
  exit 0
fi
SC=$(printf '%s\n' "$OUT" | awk -F': ' '/^Scanned files:/{print $2}' | head -1)
IN=$(printf '%s\n' "$OUT" | awk -F': ' '/^Infected files:/{print $2}' | head -1)
echo "R $([ "$RC" = "1" ] && echo infected || echo clean) $SC $E $IN"
printf '%s\n' "$OUT" | grep 'FOUND$' | head -20 | sed -e 's/ FOUND$//' | awk -F': ' '{sig=$NF; p=$0; sub(/: [^:]*$/, "", p); print "F " sig "|" p}'
`;


// Keeping ClamAV on a machine: install it (with its automatic signature updates, no always-on daemon, which needs about a gigabyte of
// memory) and update the signatures by hand. Packages come from the distribution's own repositories; on Rocky, AlmaLinux, CentOS and
// Oracle Linux that means enabling EPEL (the distribution's own epel-release package). Red Hat Enterprise Linux is not touched: its EPEL
// needs the person to decide, so the script says so.
const AV_COMMON = String.raw`
update_sigs() {
  have freshclam || fail "freshclam is not installed." 69
  have systemctl && systemctl stop clamav-freshclam >/dev/null 2>&1
  mkdir -p /var/lib/clamav 2>/dev/null
  OUT=$(timeout 900 freshclam 2>&1 </dev/null); RC=$?
  # keep the definitions updating by themselves
  have systemctl && systemctl enable --now clamav-freshclam >/dev/null 2>&1
  if [ "$RC" -ne 0 ]; then
    DB=$(ls /var/lib/clamav/*.c[lv]d 2>/dev/null | head -1)
    fail "The signatures could not be updated (check that this device can reach database.clamav.net): $(printf '%s' "$OUT" | grep -v '^$' | tail -1 | tr -d '\000-\037' | cut -c1-160)" 1
  fi
}
version_line() { clamscan --version 2>/dev/null | head -1 | tr -d '\000-\037' | cut -c1-120; }
`;

export const LINUX_AV_INSTALL_SCRIPT = PRELUDE + AV_COMMON + String.raw`
export DEBIAN_FRONTEND=noninteractive
ID_L=""
[ -r /etc/os-release ] && ID_L=$(. /etc/os-release; printf '%s' "$ID" | tr 'A-Z' 'a-z')
if have clamscan && have freshclam; then
  :
elif have apt-get; then
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq clamav clamav-freshclam >/dev/null 2>&1 || fail "The clamav packages could not be installed with apt." 1
elif have dnf || have yum; then
  PM=dnf; have dnf || PM=yum
  case "$ID_L" in
    rocky|almalinux|centos|ol) $PM install -y -q epel-release >/dev/null 2>&1 || fail "Could not enable the EPEL repository, which carries ClamAV on this system." 1;;
    rhel) rpm -q epel-release >/dev/null 2>&1 || fail "ClamAV for Red Hat Enterprise Linux comes from the EPEL repository. Enable EPEL (see Red Hat's instructions), then run this again." 69;;
  esac
  $PM install -y -q clamav clamav-update >/dev/null 2>&1 || fail "The clamav packages could not be installed." 1
  # the packaged configuration refuses to run until its Example line is commented out
  [ -f /etc/freshclam.conf ] && sed -i 's/^Example/#Example/' /etc/freshclam.conf
elif have zypper; then
  zypper --non-interactive install clamav >/dev/null 2>&1 || fail "The clamav package could not be installed with zypper." 1
elif have pacman; then
  pacman -S --noconfirm clamav >/dev/null 2>&1 || fail "The clamav package could not be installed with pacman." 1
else
  fail "No supported package manager was found (apt, dnf, yum, zypper or pacman)." 69
fi
have clamscan || fail "ClamAV did not install." 1
update_sigs
echo "OK ClamAV is installed ($(version_line)) and its signatures are up to date. They update by themselves from now on."
`;

export const LINUX_AV_UPDATE_SCRIPT = PRELUDE + AV_COMMON + String.raw`
have clamscan || fail "ClamAV is not installed. Use Install ClamAV first." 69
update_sigs
echo "OK The ClamAV signatures are up to date ($(version_line))."
`;

/* ------------------------------ what a device printed ------------------------------ */

export type LinuxActionResult =
    | { action: "firewall-enable" | "antivirus-install" | "antivirus-update"; message: string }
    | { action: "malware-scan"; state: "clean" | "infected" | "error"; scannedFiles: number | null; seconds: number | null; infectedCount: number; found: { signature: string; path: string }[]; message: string | null };

const clip = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const smallInt = (s: string | undefined): number | null => (s !== undefined && /^\d{1,9}$/.test(s) ? Number(s) : null);

export function parseLinuxAction(action: LinuxAction, stdout: string, stderr: string): LinuxActionResult {
    const lines = stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    if (action === "firewall-enable" || action === "antivirus-install" || action === "antivirus-update") {
        const ok = lines.find((l) => l.startsWith("OK "));
        if (!ok) throw new ToolOutputError(clip(stderr, 300) || (action === "firewall-enable" ? "The device did not say the firewall is on." : "The device did not say the work was done."));
        return { action, message: clip(ok.slice(3), 300) };
    }
    const e = lines.find((l) => l.startsWith("E "));
    if (e) return { action, state: "error", scannedFiles: null, seconds: null, infectedCount: 0, found: [], message: clip(e.slice(2), 200) || "The scan stopped with an error." };
    const r = lines.find((l) => l.startsWith("R "));
    if (!r) throw new ToolOutputError(clip(stderr, 300) || "The device's answer was not a malware scan result.");
    const m = /^R (clean|infected) (\S*) (\d+) (\S*)$/.exec(r) ?? /^R (clean|infected) (\S*) (\d+)\s*$/.exec(r);
    if (!m) throw new ToolOutputError("The device's malware scan result could not be read.");
    const found = lines
        .filter((l) => l.startsWith("F "))
        .slice(0, 20)
        .map((l) => {
            const [sig, ...path] = l.slice(2).split("|");
            return { signature: clip(sig ?? "", 80), path: clip(path.join("|"), 200) };
        })
        .filter((f) => f.signature);
    const infectedCount = Math.max(smallInt(m[4]) ?? 0, found.length);
    return { action, state: m[1] === "infected" || infectedCount > 0 ? "infected" : "clean", scannedFiles: smallInt(m[2]), seconds: smallInt(m[3]), infectedCount, found, message: null };
}
