// Installing and removing one package on a Linux device, as a fixed signed bash job.
//   - The package name and the action reach the script only through the environment (ADG_PKG, ADG_PKG_ACTION). Bash never parses them
//     as code, and the server checks the name against a strict shape before a job is made.
//   - Only the system's own package manager is used (apt, dnf, yum, zypper or Alpine's apk), non-interactively, with a lock wait and a time limit.
//   - A removal is refused when it would take anything else with it (apt: a dry run lists every package it would remove; rpm systems:
//     rpm's own dependency test), and for packages whose removal can break or lock out the machine (see PROTECTED).
//   - The script contains no dollar-brace sequence, no backtick and no double curly brace (the server fills those in for a device).

import { BadRequestException } from "@nestjs/common";

export type LinuxPackageAction = "install" | "remove";

/** A package name as every package manager spells one: letters, digits and + . _ - : (an architecture suffix such as :amd64). */
export const LINUX_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:-]{0,99}$/;

/** Packages that are never removed from here: the agent itself, the remote-access and login stack, the init system, the package manager, the kernel. */
const PROTECTED: RegExp[] = [
    /^adgrmm/i,
    /^(openssh-server|openssh-clients|openssh|ssh|sshd)$/i,
    /^(systemd|systemd-sysv|systemd-libs|init|dbus|dbus-daemon|dbus-broker|polkit|policykit-1|udev|util-linux|coreutils|bash|dash|sudo|login|passwd|shadow|shadow-utils)$/i,
    /^(libc6|libc-bin|glibc|glibc-common|libssl[0-9.]*|openssl|openssl-libs|ca-certificates|base-files|base-passwd|filesystem|setup)$/i,
    /^(dpkg|apt|apt-utils|rpm|rpm-libs|dnf|dnf-data|yum|zypper|libzypp|python3|python3-apt)$/i,
    /^(linux-image.*|linux-modules.*|linux-generic.*|linux-base|kernel|kernel-core|kernel-modules.*|kernel-default.*|grub.*|shim.*|dracut.*|initramfs-tools.*)$/i,
    /^(ufw|firewalld|iptables|nftables|network-manager|networkmanager|netplan\.io|systemd-resolved|systemd-networkd|cloud-init)$/i,
    /^(busybox|busybox-.*|musl|musl-utils|apk-tools|openrc|alpine-base|alpine-baselayout.*|alpine-keys|alpine-conf|ssl_client|libcrypto[0-9.]*|scanelf|mdev-conf|mkinitfs|syslinux|ifupdown-ng.*)$/i,
    /^(ubuntu-minimal|ubuntu-standard|ubuntu-server|ubuntu-desktop|debian-.*-minimal)$/i,
];

export function isProtectedPackage(name: string): boolean {
    const base = name.replace(/:[A-Za-z0-9_-]+$/, "");
    return PROTECTED.some((re) => re.test(base));
}

/** The name as a package manager takes it, or a plain-words refusal. */
export function checkPackageName(raw: unknown, action: LinuxPackageAction): string {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) throw new BadRequestException("Say which package.");
    if (!LINUX_PACKAGE_NAME.test(name)) throw new BadRequestException("A package name uses letters, digits and the characters + . _ - : only, and starts with a letter or digit.");
    if (action === "remove" && isProtectedPackage(name)) throw new BadRequestException(`${name} is needed to keep the device working or reachable, so it is not removed from here.`);
    if (action === "install" && /^adgrmm/i.test(name)) throw new BadRequestException("The ADG RMM agent is installed and updated through its own installer.");
    return name;
}

export const LINUX_PACKAGE_SCRIPT = String.raw`#!/bin/bash
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
fail() { echo "$1" >&2; exit "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
PKG="$ADG_PKG"
ACT="$ADG_PKG_ACTION"
case "$ACT" in install|remove) ;; *) fail "Unknown action." 64;; esac
printf '%s' "$PKG" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9+._:-]{0,99}$' || fail "That is not a package name." 64
[ "$(id -u)" = "0" ] || fail "The agent is not running as root, so it cannot change packages." 77
T() { if have timeout; then timeout 1500 "$@"; else "$@"; fi; }
# Runs a command, shows the end of what it said, and returns its own exit status.
run() { OUT=$(T "$@" 2>&1); RC=$?; printf '%s\n' "$OUT" | tail -25; return $RC; }

if have apt-get; then
  APT="apt-get -o DPkg::Lock::Timeout=180 -o Dpkg::Options::=--force-confold"
  if [ "$ACT" = "install" ]; then
    if dpkg -s "$PKG" 2>/dev/null | grep -q '^Status: install ok installed'; then echo "OK $PKG is already installed."; exit 0; fi
    run $APT update -qq >/dev/null 2>&1 || true
    run $APT install -y -- "$PKG" || fail "apt-get could not install $PKG." 1
    dpkg -s "$PKG" 2>/dev/null | grep -q '^Status: install ok installed' || fail "$PKG was not installed." 1
    echo "OK Installed $PKG."
  else
    dpkg -s "$PKG" 2>/dev/null | grep -q '^Status: install ok installed' || fail "$PKG is not installed." 2
    OTHERS=$($APT -s remove -- "$PKG" 2>/dev/null | awk '$1=="Remv"{print $2}' | grep -v -x -F "$PKG" | head -8 | tr '\n' ' ')
    [ -z "$OTHERS" ] || fail "Removing $PKG would also remove: $OTHERS. Nothing was removed. Use Remote Shell if that is what you want." 3
    run $APT remove -y -- "$PKG" || fail "apt-get could not remove $PKG." 1
    dpkg -s "$PKG" 2>/dev/null | grep -q '^Status: install ok installed' && fail "$PKG is still installed." 1
    echo "OK Removed $PKG."
  fi
elif have dnf || have yum || have zypper; then
  if have dnf; then M="dnf -y"; elif have yum; then M="yum -y"; else M="zypper -n"; fi
  if [ "$ACT" = "install" ]; then
    rpm -q -- "$PKG" >/dev/null 2>&1 && { echo "OK $PKG is already installed."; exit 0; }
    run $M install "$PKG" || fail "The package manager could not install $PKG." 1
    rpm -q -- "$PKG" >/dev/null 2>&1 || fail "$PKG was not installed." 1
    echo "OK Installed $PKG."
  else
    rpm -q -- "$PKG" >/dev/null 2>&1 || fail "$PKG is not installed." 2
    TESTOUT=$(rpm -e --test -- "$PKG" 2>&1) || fail "Removing $PKG would break other packages ($(printf '%s' "$TESTOUT" | tr '\n' ' ' | cut -c1-180)). Nothing was removed. Use Remote Shell if that is what you want." 3
    if have dnf || have yum; then RM=remove; else RM=rm; fi
    run $M $RM "$PKG" || fail "The package manager could not remove $PKG." 1
    rpm -q -- "$PKG" >/dev/null 2>&1 && fail "$PKG is still installed." 1
    echo "OK Removed $PKG."
  fi
elif have apk; then
  if [ "$ACT" = "install" ]; then
    apk info -e "$PKG" >/dev/null 2>&1 && { echo "OK $PKG is already installed."; exit 0; }
    run apk add --no-cache "$PKG" || fail "apk could not install $PKG." 1
    apk info -e "$PKG" >/dev/null 2>&1 || fail "$PKG was not installed." 1
    echo "OK Installed $PKG."
  else
    apk info -e "$PKG" >/dev/null 2>&1 || fail "$PKG is not installed." 2
    # apk removes what depends on a package too: a dry run says what else would go
    OTHERS=$(apk del -s "$PKG" 2>/dev/null | awk '/Purging/{print $3}' | grep -v -x -F "$PKG" | head -8 | tr '\n' ' ')
    [ -z "$OTHERS" ] || fail "Removing $PKG would also remove: $OTHERS. Nothing was removed. Use Remote Shell if that is what you want." 3
    run apk del "$PKG" || fail "apk could not remove $PKG." 1
    apk info -e "$PKG" >/dev/null 2>&1 && fail "$PKG is still installed." 1
    echo "OK Removed $PKG."
  fi
else
  fail "No supported package manager was found (apt, dnf, yum, zypper or apk)." 69
fi
`;
