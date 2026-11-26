// backend/src/security/security-linux.scripts.ts
//
// The security scan of LINUX devices. Like the Windows scan it is an ordinary signed script job with no new agent code: one fixed
// bash script that only READS (nothing is changed, installed or restarted), and a checker for what it prints.
//   - The script prints one line per fact ("K <probe> <key> <value>") or one line saying why a probe could not be read
//     ("U <probe> <reason>"). Every probe stands alone: a missing tool or a denied read costs that one check, never the scan.
//     Every command that could hang is run under `timeout`, and slow probes are skipped once the time budget is used up.
//   - Nothing secret is read: password HASHES are never printed (only which accounts have an EMPTY password field, never the field),
//     no private key, no sshd configuration beyond five settings, no file contents.
//   - parseLinuxScan: what a device printed is never trusted. Every value is checked against a strict shape, unknown keys are dropped,
//     and a probe that is malformed becomes "unknown" on its own.
// The script contains nothing a person typed and takes no input. It must not contain a dollar-brace sequence or a backtick, because
// it lives in a template literal.
import { ToolOutputError } from "../device-tools/device-tools.scripts";

export const LINUX_SCAN_KIND = "security.scan";

/* ------------------------------ the script ------------------------------ */

export const LINUX_SECURITY_SCAN_SCRIPT = String.raw`#!/bin/bash
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
T0=$(date +%s)
BUDGET=60

clip() { printf '%s' "$1" | tr -d '\000-\037\177' | cut -c1-$2; }
emit() { printf 'K %s %s %s\n' "$1" "$2" "$(clip "$3" 200)"; }
unk() { printf 'U %s %s\n' "$1" "$(clip "$2" 160)"; }
have() { command -v "$1" >/dev/null 2>&1; }
t() { if have timeout; then timeout 6 "$@"; else "$@"; fi; }
over() { [ $(( $(date +%s) - T0 )) -gt $BUDGET ]; }
active() { [ "$(t systemctl is-active "$1" 2>/dev/null)" = "active" ]; }
enabled() { case "$(t systemctl is-enabled "$1" 2>/dev/null)" in enabled|static) return 0;; esac; return 1; }

# ---- os
if [ -r /etc/os-release ]; then
  ( . /etc/os-release
    emit os id "$ID"; emit os version "$VERSION_ID"; emit os name "$PRETTY_NAME"; emit os kernel "$(uname -r)" )
else
  unk os "There is no /etc/os-release on this device."
fi

# ---- firewall: the manager that is in charge, and whether it is on. Only input rules count, because Docker adds its own tables.
FWM=none; FWON=0; FWKNOWN=0
if have ufw; then
  FWKNOWN=1
  S=$(t ufw status 2>/dev/null | head -1)
  case "$S" in *inactive*) FWM=ufw; FWON=0;; *active*) FWM=ufw; FWON=1;; esac
  if [ "$FWM" = none ] && [ -r /etc/ufw/ufw.conf ]; then
    if grep -qi '^ENABLED=yes' /etc/ufw/ufw.conf; then FWM=ufw; FWON=1; else FWM=ufw; FWON=0; fi
  fi
fi
if [ "$FWM" = none ] || [ "$FWON" = 0 ]; then
  if have firewall-cmd || have firewalld; then
    FWKNOWN=1
    if active firewalld; then FWM=firewalld; FWON=1; elif [ "$FWM" = none ]; then FWM=firewalld; FWON=0; fi
  fi
fi
if [ "$FWON" = 0 ] && [ "$FWM" != ufw ] && [ "$FWM" != firewalld ]; then
  if have nft; then
    FWKNOWN=1
    N=$(t nft list ruleset 2>/dev/null)
    if printf '%s' "$N" | grep -q 'hook input' && printf '%s' "$N" | grep -Eq 'policy (drop|reject)|[[:space:]](drop|reject)([[:space:]]|$)'; then FWM=nftables; FWON=1; fi
  fi
  if [ "$FWON" = 0 ] && have iptables; then
    FWKNOWN=1
    I=$(t iptables -S INPUT 2>/dev/null)
    if printf '%s' "$I" | grep -Eq '^-P INPUT (DROP|REJECT)' || [ "$(printf '%s\n' "$I" | grep -c '^-A INPUT')" -gt 0 ]; then FWM=iptables; FWON=1; fi
  fi
fi
if [ "$FWKNOWN" = 1 ] || [ "$FWON" = 1 ]; then
  emit firewall manager "$FWM"; emit firewall active "$( [ "$FWON" = 1 ] && echo yes || echo no )"
else
  # No firewall tool exists at all, which is what "no firewall" looks like on a minimal server.
  emit firewall manager none; emit firewall active no
fi

# ---- disk encryption: is the volume under "/" (and "/home", "/data" when they are their own mounts) on top of LUKS?
VOLS=""
for M in / /home /data; do
  [ "$M" = / ] || mountpoint -q "$M" 2>/dev/null || continue
  SRC=$(findmnt -n -o SOURCE --target "$M" 2>/dev/null | head -1 | sed 's/\[.*//')
  case "$SRC" in
    /dev/*)
      A=$(t lsblk -s -n -r -o TYPE,FSTYPE "$SRC" 2>/dev/null)
      if [ -z "$A" ]; then ST=unknown
      elif printf '%s\n' "$A" | grep -Eq '(^| )crypt( |$)|crypto_LUKS'; then ST=on
      else ST=off; fi;;
    *) ST=unknown;;
  esac
  VOLS="$VOLS$M:$ST,"
done
if [ -n "$VOLS" ]; then emit encryption volumes "$VOLS"; else unk encryption "The volume holding / could not be identified."; fi

# ---- ssh: five settings of the effective configuration (sshd -T), never the keys
SSHD=""
for P in /usr/sbin/sshd /usr/local/sbin/sshd /sbin/sshd; do [ -x "$P" ] && SSHD=$P && break; done
[ -z "$SSHD" ] && have sshd && SSHD=$(command -v sshd)
if [ -n "$SSHD" ]; then
  SALL=$(t "$SSHD" -T 2>&1 </dev/null)
  C=""
  case "$SALL" in *permitrootlogin*) C=$SALL;; esac
  if [ -z "$C" ]; then
    # sshd -T can refuse inside a service (missing /run/sshd, no host keys): read the files instead, first value wins, defaults after.
    FILES=$(ls /etc/ssh/sshd_config.d/*.conf 2>/dev/null; echo /etc/ssh/sshd_config)
    C=$(cat $FILES 2>/dev/null | awk 'BEGIN{r="prohibit-password";p="yes";e="no";o="22"} {k=tolower($1); v=tolower($2)} k=="permitrootlogin"&&!a{r=v;a=1} k=="passwordauthentication"&&!b{p=v;b=1} k=="permitemptypasswords"&&!c{e=v;c=1} k=="port"&&!d{o=v;d=1} END{print "permitrootlogin " r; print "passwordauthentication " p; print "permitemptypasswords " e; print "port " o}')
    [ -r /etc/ssh/sshd_config ] || C=""
  fi
  if [ -n "$C" ]; then
    emit ssh installed yes
    if active ssh || active sshd; then emit ssh running yes; else emit ssh running no; fi
    emit ssh permitrootlogin "$(printf '%s\n' "$C" | awk '$1=="permitrootlogin"{print $2; exit}')"
    emit ssh passwordauthentication "$(printf '%s\n' "$C" | awk '$1=="passwordauthentication"{print $2; exit}')"
    emit ssh permitemptypasswords "$(printf '%s\n' "$C" | awk '$1=="permitemptypasswords"{print $2; exit}')"
    emit ssh port "$(printf '%s\n' "$C" | awk '$1=="port"{print $2; exit}')"
  else
    unk ssh "The SSH server's settings could not be read (sshd -T: $(printf '%s' "$SALL" | head -c 100 | tr '\n' ' '))."
  fi
else
  emit ssh installed no
fi

# ---- accounts: empty password fields (never the hashes), extra accounts with user id 0, and who may use sudo
if [ -r /etc/shadow ]; then
  emit accounts emptypassword "$(awk -F: '($2=="") {printf "%s,", $1}' /etc/shadow 2>/dev/null)"
else
  unk accounts "The password file could not be read."
fi
emit accounts extraroot "$(awk -F: '($3==0 && $1!="root") {printf "%s,", $1}' /etc/passwd 2>/dev/null)"
ADM=""
for G in sudo wheel admin; do
  L=$(getent group "$G" 2>/dev/null | awk -F: '{print $4}')
  [ -n "$L" ] && ADM="$ADM,$L"
done
emit accounts admins "$(printf '%s' "$ADM" | tr ',' '\n' | sed '/^$/d;/^root$/d' | sort -u | tr '\n' ',')"

# ---- updates: when package activity last happened (the newest of the package manager logs)
NEWEST=0
for F in /var/log/dpkg.log /var/log/apt/history.log /var/log/dnf.rpm.log /var/log/dnf.log /var/log/yum.log /var/log/zypp/history /var/log/pacman.log; do
  if [ -f "$F" ]; then
    M=$(stat -c %Y "$F" 2>/dev/null)
    [ -n "$M" ] && [ "$M" -gt "$NEWEST" ] && NEWEST=$M
  fi
done
if [ "$NEWEST" -gt 0 ]; then emit updates agedays "$(( ( $(date +%s) - NEWEST ) / 86400 ))"; else unk updates "No package manager log was found."; fi

AUTO=no; BY=""
if enabled unattended-upgrades || enabled apt-daily-upgrade.timer; then
  if grep -rqE 'Unattended-Upgrade[[:space:]]+"1"' /etc/apt/apt.conf.d 2>/dev/null; then AUTO=yes; BY=unattended-upgrades; fi
fi
if [ "$AUTO" = no ]; then
  for U in dnf-automatic-install.timer dnf-automatic.timer yum-cron dnf-automatic.service; do
    if enabled "$U"; then AUTO=yes; BY=$U; break; fi
  done
fi
emit autoupdates enabled "$AUTO"; emit autoupdates by "$BY"

# ---- restart waiting
if [ -f /var/run/reboot-required ] || [ -f /run/reboot-required ]; then
  emit reboot pending yes
elif have needs-restarting; then
  t needs-restarting -r >/dev/null 2>&1; R=$?
  if [ "$R" = 1 ]; then emit reboot pending yes; else emit reboot pending no; fi
else
  emit reboot pending no
fi

# ---- mandatory access control
MK=none; MM=""
if have getenforce; then
  MM=$(t getenforce 2>/dev/null); case "$MM" in Enforcing) MK=selinux;; Permissive) MK=selinux;; Disabled) MK=none;; esac
fi
if [ "$MK" = none ] && [ -d /sys/kernel/security/apparmor ]; then
  if [ -r /sys/module/apparmor/parameters/enabled ] && grep -qi '^Y' /sys/module/apparmor/parameters/enabled; then MK=apparmor; MM=enabled; fi
fi
emit mac kind "$MK"; emit mac mode "$MM"

# ---- clock
if have timedatectl; then
  V=$(t timedatectl show -p NTPSynchronized --value 2>/dev/null)
  case "$V" in yes|no) emit time synchronized "$V";; *) unk time "The clock state could not be read.";; esac
else
  unk time "timedatectl is not installed."
fi

# ---- services listening to other machines that should not be (telnet, ftp, the r-commands, VNC)
if have ss && ! over; then
  RISKY=""
  for PR in telnet:23 ftp:21 rexec:512 rlogin:513 rsh:514 vnc:5900; do
    N=$(printf '%s' "$PR" | cut -d: -f1); PORT=$(printf '%s' "$PR" | cut -d: -f2)
    if t ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Ev '^(127\.|\[::1\]|::1)' | grep -Eq "[:.]$PORT$"; then RISKY="$RISKY$N,"; fi
  done
  emit exposure risky "$RISKY"
else
  unk exposure "The listening ports could not be read."
fi

# ---- root file system
DU=$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ -n "$DU" ]; then emit disk rootusedpercent "$DU"; else unk disk "The disk usage could not be read."; fi

# ---- antivirus or endpoint protection that is installed AND running
AVL=""
active clamav-daemon && AVL="$AVL""ClamAV,"
active clamd@scan && AVL="$AVL""ClamAV,"
active sophos-spl && AVL="$AVL""Sophos,"
active mdatp && AVL="$AVL""Microsoft Defender for Endpoint,"
active falcon-sensor && AVL="$AVL""CrowdStrike Falcon,"
active eset && AVL="$AVL""ESET,"
# ClamAV without a daemon (the way ADG RMM installs it): installed, with signatures that are not more than a week old
if have clamscan; then
  DBF=$(ls -t /var/lib/clamav/*.c[lv]d 2>/dev/null | head -n 1)
  if [ -n "$DBF" ]; then
    DBM=$(stat -c %Y "$DBF" 2>/dev/null)
    [ -n "$DBM" ] && [ $(( ( $(date +%s) - DBM ) / 86400 )) -le 7 ] && AVL="$AVL""ClamAV,"
  fi
fi
emit antivirus products "$AVL"

# ---- firmware
if [ -d /sys/firmware/efi ]; then
  emit boot uefi yes
  SBF=$(ls /sys/firmware/efi/efivars/SecureBoot-* 2>/dev/null | head -1)
  if [ -n "$SBF" ]; then
    SB=$(od -An -t u1 -j4 -N1 "$SBF" 2>/dev/null | tr -d ' ')
    case "$SB" in 1) emit boot secureboot yes;; 0) emit boot secureboot no;; esac
  fi
else
  emit boot uefi no
fi
if [ -d /sys/class/tpm/tpm0 ]; then emit boot tpm yes; else emit boot tpm no; fi

printf 'E %s\n' "$(( $(date +%s) - T0 ))"
`;

/* ------------------------------ what the scan finds ------------------------------ */

export interface LinuxOsData { id: string; version: string; name: string; kernel: string }
export interface LinuxFirewallData { manager: string; active: boolean }
export interface LinuxVolume { mount: string; state: "on" | "off" | "unknown" }
export interface LinuxEncryptionData { volumes: LinuxVolume[] }
export interface LinuxSshData { installed: boolean; running: boolean | null; permitRootLogin: string; passwordAuth: boolean | null; emptyPasswords: boolean | null; port: number | null }
export interface LinuxAccountsData { emptyPassword: string[] | null; extraRoot: string[]; admins: string[] }
export interface LinuxUpdatesData { ageDays: number }
export interface LinuxAutoUpdatesData { enabled: boolean; by: string }
export interface LinuxRebootData { pending: boolean }
export interface LinuxMacData { kind: "selinux" | "apparmor" | "none"; mode: string }
export interface LinuxTimeData { synchronized: boolean }
export interface LinuxExposureData { risky: string[] }
export interface LinuxDiskData { rootUsedPercent: number }
export interface LinuxAntivirusData { products: string[] }
export interface LinuxBootData { uefi: boolean; secureBoot: boolean | null; tpm: boolean }

export interface LinuxProbeData {
    os: LinuxOsData; firewall: LinuxFirewallData; encryption: LinuxEncryptionData; ssh: LinuxSshData; accounts: LinuxAccountsData;
    updates: LinuxUpdatesData; autoUpdates: LinuxAutoUpdatesData; reboot: LinuxRebootData; mac: LinuxMacData; time: LinuxTimeData;
    exposure: LinuxExposureData; disk: LinuxDiskData; antivirus: LinuxAntivirusData; boot: LinuxBootData;
}
export type LinuxProbeName = keyof LinuxProbeData;
export type LinuxProbe<K extends LinuxProbeName> = ({ status: "ok"; ms: number } & LinuxProbeData[K]) | { status: "unknown"; ms: number; reason: string };
export type LinuxProbes = { [K in LinuxProbeName]: LinuxProbe<K> };
export type LinuxScanData = { v: 1; platform: "linux"; ms: number; probes: LinuxProbes };

export const LINUX_PROBE_NAMES: LinuxProbeName[] = ["os", "firewall", "encryption", "ssh", "accounts", "updates", "autoUpdates", "reboot", "mac", "time", "exposure", "disk", "antivirus", "boot"];

/** Which probe each printed name belongs to. */
const PRINTED: Record<string, LinuxProbeName> = {
    os: "os", firewall: "firewall", encryption: "encryption", ssh: "ssh", accounts: "accounts", updates: "updates", autoupdates: "autoUpdates",
    reboot: "reboot", mac: "mac", time: "time", exposure: "exposure", disk: "disk", antivirus: "antivirus", boot: "boot",
};

/* ------------------------------ checking what a device printed ------------------------------ */

const MAX_OUTPUT_CHARS = 100_000;
const CONTROL = /[\u0000-\u001f\u007f]/g;
class Bad extends Error { }

const text = (v: string | undefined, max: number) => (typeof v === "string" ? v.replace(CONTROL, " ").trim().slice(0, max) : "");
const yesNo = (v: string | undefined): boolean | null => (v === "yes" ? true : v === "no" ? false : null);
const reqYesNo = (v: string | undefined, what: string): boolean => {
    const b = yesNo(v);
    if (b === null) throw new Bad(`${what} is not yes or no`);
    return b;
};
const num = (v: string | undefined, min: number, max: number): number | null => {
    if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) return null;
    const n = Number(v);
    return n >= min && n <= max ? n : null;
};
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.@ -]{0,63}$/;
const list = (v: string | undefined, max: number): string[] =>
    (v ?? "").split(",").map((s) => s.trim()).filter((s) => s && NAME.test(s)).slice(0, max);

type Facts = Record<string, string>;

const CLEANERS: { [K in LinuxProbeName]: (f: Facts) => LinuxProbeData[K] } = {
    os: (f) => ({ id: text(f.id, 40).toLowerCase(), version: text(f.version, 30), name: text(f.name, 100), kernel: text(f.kernel, 60) }),
    firewall: (f) => ({ manager: ["ufw", "firewalld", "nftables", "iptables", "none"].includes(f.manager) ? f.manager : "none", active: reqYesNo(f.active, "The firewall state") }),
    encryption: (f) => {
        const volumes = (f.volumes ?? "").split(",").flatMap((s): LinuxVolume[] => {
            const m = /^(\/[A-Za-z0-9_./-]{0,40}):(on|off|unknown)$/.exec(s.trim());
            return m ? [{ mount: m[1], state: m[2] as LinuxVolume["state"] }] : [];
        }).slice(0, 6);
        if (!volumes.length) throw new Bad("no volume was reported");
        return { volumes };
    },
    ssh: (f) => {
        const installed = reqYesNo(f.installed, "installed");
        if (!installed) return { installed: false, running: null, permitRootLogin: "", passwordAuth: null, emptyPasswords: null, port: null };
        return {
            installed: true, running: yesNo(f.running), permitRootLogin: ["yes", "no", "prohibit-password", "without-password", "forced-commands-only"].includes(f.permitrootlogin) ? f.permitrootlogin : "",
            passwordAuth: yesNo(f.passwordauthentication), emptyPasswords: yesNo(f.permitemptypasswords), port: num(f.port, 1, 65535),
        };
    },
    accounts: (f) => ({
        emptyPassword: f.emptypassword === undefined ? null : list(f.emptypassword, 20),
        extraRoot: list(f.extraroot, 20),
        admins: list(f.admins, 50),
    }),
    updates: (f) => {
        const d = num(f.agedays, 0, 100_000);
        if (d === null) throw new Bad("the age is not a number");
        return { ageDays: d };
    },
    autoUpdates: (f) => ({ enabled: reqYesNo(f.enabled, "enabled"), by: text(f.by, 60) }),
    reboot: (f) => ({ pending: reqYesNo(f.pending, "pending") }),
    mac: (f) => ({ kind: f.kind === "selinux" || f.kind === "apparmor" ? f.kind : "none", mode: ["Enforcing", "Permissive", "enabled"].includes(f.mode) ? f.mode : "" }),
    time: (f) => ({ synchronized: reqYesNo(f.synchronized, "synchronized") }),
    exposure: (f) => ({ risky: (f.risky ?? "").split(",").map((s) => s.trim()).filter((s) => ["telnet", "ftp", "rexec", "rlogin", "rsh", "vnc"].includes(s)) }),
    disk: (f) => {
        const n = num(f.rootusedpercent, 0, 100);
        if (n === null) throw new Bad("the usage is not a percentage");
        return { rootUsedPercent: n };
    },
    antivirus: (f) => ({ products: [...new Set((f.products ?? "").split(",").map((s) => s.trim()).filter((s) => ["ClamAV", "Sophos", "Microsoft Defender for Endpoint", "CrowdStrike Falcon", "ESET"].includes(s)))] }),
    boot: (f) => ({ uefi: reqYesNo(f.uefi, "uefi"), secureBoot: yesNo(f.secureboot), tpm: yesNo(f.tpm) === true }),
};

/** What a finished Linux scan job printed, checked. Throws ToolOutputError when there is no usable answer at all. */
export function parseLinuxScan(stdout: string, stderr: string): LinuxScanData {
    const out = String(stdout ?? "");
    if (out.length > MAX_OUTPUT_CHARS) throw new ToolOutputError("The device's answer was far larger than expected and was ignored.");

    const facts: Record<string, Facts> = {};
    const reasons: Record<string, string> = {};
    let ms = 0;
    let finished = false;
    for (const raw of out.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("K ")) {
            const m = /^K ([a-z]+) ([a-z]+) ?(.*)$/.exec(line);
            if (!m || !Object.prototype.hasOwnProperty.call(PRINTED, m[1])) continue;
            (facts[m[1]] ??= {})[m[2]] = m[3];
        } else if (line.startsWith("U ")) {
            const m = /^U ([a-z]+) (.*)$/.exec(line);
            if (m && Object.prototype.hasOwnProperty.call(PRINTED, m[1])) reasons[m[1]] = text(m[2], 200);
        } else if (line.startsWith("E ")) {
            finished = true;
            ms = (num(line.slice(2).trim(), 0, 3_600) ?? 0) * 1000;
        }
    }
    if (!finished && !Object.keys(facts).length) {
        const why = String(stderr ?? "").trim();
        throw new ToolOutputError(why ? `The scan did not run: ${why.slice(0, 200)}` : "The device's answer was not a security scan.");
    }

    const probes: Record<string, unknown> = {};
    for (const [printed, name] of Object.entries(PRINTED)) {
        let reason = reasons[printed] || "The device did not report this check.";
        const f = facts[printed];
        if (f) {
            try {
                probes[name] = { status: "ok", ms: 0, ...(CLEANERS[name] as (f: Facts) => object)(f) };
                continue;
            } catch (err) {
                reason = err instanceof Bad ? `The device sent an unexpected answer for this check (${err.message}).` : "The device sent an unexpected answer for this check.";
            }
        }
        probes[name] = { status: "unknown", ms: 0, reason };
    }
    return { v: 1, platform: "linux", ms, probes: probes as LinuxProbes };
}
