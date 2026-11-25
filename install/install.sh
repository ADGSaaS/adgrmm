#!/usr/bin/env bash
# RemoteIQ installer.
#
#   curl -fsSL https://github.com/RemoteIQ-RMM/RemoteIQ-RMM/releases/latest/download/install.sh | sudo bash
#
# Installs RemoteIQ on this machine (Ubuntu 22.04/24.04 or Debian 12, x86_64) and walks you through the first setup:
# where it runs, its web address and HTTPS, the database, your administrator account, company name, email sending,
# the customer portal and a first customer with the agent install command.
#
#   install.sh [install]      new installation (the default)
#   install.sh upgrade        move to the latest release (or --version X.Y.Z), with a database backup and rollback
#   install.sh status         what is running and whether it is healthy;  status --logs  also writes a support bundle
#   install.sh reconfigure    change the web address or the portal address after installing
#   install.sh uninstall      stop and remove RemoteIQ; you choose whether to keep your data
#   install.sh help
#
# Options: --mode docker|native   --version X.Y.Z   --force (upgrade: reinstall the same version)   --no-color
# Environment: RIQ_RELEASE_BASE (download from your own web server instead of GitHub), GITHUB_TOKEN (private repository),
#              RIQ_REPO (owner/name), RIQ_HOME (install folder, default /opt/remoteiq).
#
# Everything is inside functions and main runs last, so a download that stops half way runs nothing.

set -Eeuo pipefail

RIQ_REPO_GIVEN="${RIQ_REPO:-}"
RIQ_REPO="${RIQ_REPO:-RemoteIQ-RMM/RemoteIQ-RMM}"
RIQ_RELEASE_BASE="${RIQ_RELEASE_BASE:-}"
RIQ_HOME="${RIQ_HOME:-/opt/remoteiq}"
ASSET="remoteiq-linux-x64.tar.gz"
PLACEHOLDER="riq-public-url.invalid"
COOKIE_PLACEHOLDER="riq-cookie-placeholder"
INTERNAL_PLACEHOLDER="http://riq-backend:3001"
EDGE_PORT_DEFAULT=8080
CONF="$RIQ_HOME/install.conf"
LOG="/var/log/remoteiq-install.log"
TTY="/dev/tty"
USE_COLOR=1
WANT_MODE=""
WANT_VERSION=""
WITH_LOGS=0
PURGE=""
FORCE=0
RECONFIGURE=0

# ------------------------------------------------------------------ output

setup_colors() {
    if [ "$USE_COLOR" = 1 ] && [ -t 1 ]; then
        B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
    else
        B=""; D=""; R=""; G=""; Y=""; C=""; N=""
    fi
}
say()   { printf '%s\n' "$*"; }
info()  { printf '%s%s%s\n' "$D" "$*" "$N"; }
ok()    { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn()  { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
die()   { printf '\n%s✗ %s%s\n' "$R" "$*" "$N" >&2; [ -f "$LOG" ] && printf '%sDetails: %s%s\n' "$D" "$LOG" "$N" >&2; exit 1; }
title() { printf '\n%s%s%s\n' "$B$C" "$*" "$N"; }
rule()  { printf '%s\n' "------------------------------------------------------------"; }

# Runs a noisy command quietly, keeping its output in the log and showing it only if it fails.
quiet() {
    local what="$1"; shift
    printf '  %s ... ' "$what"
    if "$@" >>"$LOG" 2>&1; then printf '%sdone%s\n' "$G" "$N"; else printf '%sfailed%s\n' "$R" "$N"; tail -n 15 "$LOG" >&2; die "$what failed."; fi
}

on_error() {
    local code=$? line=$1
    rm -f "$RIQ_HOME/config/first-run.json" 2>/dev/null || true
    printf '\n%s✗ The installer stopped (line %s, exit %s).%s\n' "$R" "$line" "$code" "$N" >&2
    [ -f "$LOG" ] && printf '%sThe log is in %s. Run the installer again after fixing the cause; it picks up where it left off.%s\n' "$D" "$LOG" "$N" >&2
    exit "$code"
}

# ------------------------------------------------------------------ questions (read from the terminal, so "curl | bash" works)

need_tty() { [ -r "$TTY" ] || die "This installer asks questions, so it needs a terminal. Download it first (curl -fsSLo install.sh <address>) and run: sudo bash install.sh"; }

# ask "Question" "default" -> $REPLY_VALUE
ask() {
    local q="$1" def="${2:-}" a
    if [ -n "$def" ]; then printf '%s%s%s [%s]: ' "$B" "$q" "$N" "$def" >"$TTY"; else printf '%s%s%s: ' "$B" "$q" "$N" >"$TTY"; fi
    IFS= read -r a <"$TTY" || a=""
    REPLY_VALUE="${a:-$def}"
}
ask_secret() {
    local q="$1" a
    printf '%s%s%s: ' "$B" "$q" "$N" >"$TTY"
    IFS= read -rs a <"$TTY" || a=""
    printf '\n' >"$TTY"
    REPLY_VALUE="$a"
}
# ask_valid "Question" "default" validator "what is wrong"
ask_valid() {
    local q="$1" def="$2" check="$3" bad="$4"
    while :; do
        ask "$q" "$def"
        if "$check" "$REPLY_VALUE"; then return 0; fi
        warn "$bad"
    done
}
# ask_yn "Question" y|n  -> returns 0 for yes
ask_yn() {
    local q="$1" def="${2:-y}" a hint="Y/n"
    [ "$def" = n ] && hint="y/N"
    while :; do
        printf '%s%s%s [%s]: ' "$B" "$q" "$N" "$hint" >"$TTY"
        IFS= read -r a <"$TTY" || a=""
        a="${a:-$def}"
        case "${a,,}" in y|yes) return 0 ;; n|no) return 1 ;; esac
        warn "Please answer y or n."
    done
}
# ask_choice "Question" default_number "Option one" "Option two" ... -> $REPLY_VALUE is the number
ask_choice() {
    local q="$1" def="$2"; shift 2
    local i=1 o
    printf '%s%s%s\n' "$B" "$q" "$N" >"$TTY"
    for o in "$@"; do printf '  %s) %s\n' "$i" "$o" >"$TTY"; i=$((i + 1)); done
    while :; do
        ask "Choose" "$def"
        case "$REPLY_VALUE" in ''|*[!0-9]*) ;; *) if [ "$REPLY_VALUE" -ge 1 ] && [ "$REPLY_VALUE" -le $# ]; then return 0; fi ;; esac
        warn "Enter a number from 1 to $#."
    done
}

valid_domain()  { [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]]; }
valid_host()    { valid_domain "$1" || [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]; }
valid_email()   { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$ ]]; }
valid_port()    { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
valid_nonempty(){ [ -n "$1" ]; }
# 3000 and 3001 are the web app and the API inside RemoteIQ; the proxy has to forward to a different port.
valid_edge_port(){ valid_port "$1" && [ "$1" != 3000 ] && [ "$1" != 3001 ]; }
valid_name()    { [ -n "$1" ] && [ "${#1}" -le 120 ]; }

# ------------------------------------------------------------------ saved answers (so a second run continues instead of starting over)

conf_get() { [ -f "$CONF" ] && sed -n "s/^$1=\(.*\)$/\1/p" "$CONF" | tail -n 1 || true; }
conf_set() {
    mkdir -p "$RIQ_HOME"; touch "$CONF"; chmod 600 "$CONF"
    local k="$1" v="$2" tmp
    tmp="$(mktemp)"
    grep -v "^$k=" "$CONF" >"$tmp" || true
    printf '%s=%s\n' "$k" "$v" >>"$tmp"
    cat "$tmp" >"$CONF"; rm -f "$tmp"
}

# ------------------------------------------------------------------ checks

preflight() {
    [ "$(id -u)" = 0 ] || die "Run this as root: sudo bash install.sh"
    [ "$(uname -s)" = Linux ] || die "RemoteIQ installs on Linux."
    [ "$(uname -m)" = x86_64 ] || die "RemoteIQ needs an x86_64 (64-bit Intel/AMD) server; this one is $(uname -m)."
    [ -r /etc/os-release ] || die "Cannot tell which Linux this is."
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}:${VERSION_ID:-}" in
        ubuntu:22.04|ubuntu:24.04|debian:12) ;;
        *) die "This installer supports Ubuntu 22.04, Ubuntu 24.04 and Debian 12. This is ${PRETTY_NAME:-unknown}." ;;
    esac
    OS_ID="$ID"; OS_VERSION="$VERSION_ID"; OS_CODENAME="${VERSION_CODENAME:-}"
    command -v apt-get >/dev/null 2>&1 || die "apt-get is missing."
    local mem_kb disk_kb
    mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
    [ "${mem_kb:-0}" -ge 1700000 ] || warn "This server has less than 2 GB of memory. RemoteIQ will run, but slowly."
    mkdir -p "$RIQ_HOME"
    disk_kb="$(df -Pk "$RIQ_HOME" | awk 'NR==2 {print $4}')"
    [ "${disk_kb:-0}" -ge 6000000 ] || die "Less than 6 GB of free disk space in $RIQ_HOME. Free some space and try again."
    touch "$LOG" && chmod 600 "$LOG"
}

port_in_use() { ss -ltn "( sport = :$1 )" 2>/dev/null | awk 'NR>1' | grep -q . ; }

check_connectivity() {
    local url
    if [ -n "$RIQ_RELEASE_BASE" ]; then url="$RIQ_RELEASE_BASE"; else url="https://github.com"; fi
    curl -fsSI --max-time 15 -o /dev/null "$url" >/dev/null 2>&1 || curl -sI --max-time 15 -o /dev/null "$url" >/dev/null 2>&1 || die "Cannot reach $url. Check this server's internet access (and any proxy)."
}

apt_install() {
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

base_packages() {
    quiet "Updating package lists" apt-get update
    quiet "Installing basic tools" apt_install ca-certificates curl gnupg openssl tar gzip coreutils util-linux iproute2 lsb-release
}

# ------------------------------------------------------------------ downloading the release

# Prints the download address of one release file (the latest release, or the one asked for).
asset_url() {
    local file="$1" ver="${2:-}"
    if [ -n "$RIQ_RELEASE_BASE" ]; then printf '%s/%s' "${RIQ_RELEASE_BASE%/}" "$file"; return; fi
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        local api="https://api.github.com/repos/$RIQ_REPO/releases/latest" json id
        [ -n "$ver" ] && api="https://api.github.com/repos/$RIQ_REPO/releases/tags/v$ver"
        json="$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$api")" || die "GitHub did not return the release (check GITHUB_TOKEN and $RIQ_REPO)."
        id="$(printf '%s\n' "$json" | awk -v want="$file" '/"url": "https:\/\/api.github.com\/repos\/.*\/releases\/assets\/[0-9]+"/ {match($0, /assets\/[0-9]+/); last=substr($0, RSTART+7, RLENGTH-7)} /"name": "/ {n=$0; sub(/.*"name": "/, "", n); sub(/".*/, "", n); if (n == want) {print last; exit}}')"
        [ -n "$id" ] || die "The release has no file called $file."
        printf 'https://api.github.com/repos/%s/releases/assets/%s' "$RIQ_REPO" "$id"
        return
    fi
    if [ -n "$ver" ]; then printf 'https://github.com/%s/releases/download/v%s/%s' "$RIQ_REPO" "$ver" "$file"; else printf 'https://github.com/%s/releases/latest/download/%s' "$RIQ_REPO" "$file"; fi
}

download() {
    local url="$1" dest="$2"
    if [ -n "${GITHUB_TOKEN:-}" ] && [[ "$url" == https://api.github.com/* ]]; then
        curl -fL --retry 3 -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/octet-stream" -o "$dest" "$url"
    else
        curl -fL --retry 3 -o "$dest" "$url"
    fi
}

# Downloads, verifies and unpacks a release into releases/<version>. Sets RELEASE_VERSION and RELEASE_DIR.
fetch_release() {
    local want="${1:-}" tmp ver sums
    tmp="$(mktemp -d)"
    title "Downloading RemoteIQ"
    download "$(asset_url version.txt "$want")" "$tmp/version.txt" >>"$LOG" 2>&1 || die "Could not find a release to download. If the repository is private, set GITHUB_TOKEN."
    ver="$(tr -d '[:space:]' <"$tmp/version.txt")"
    [[ "$ver" =~ ^[0-9A-Za-z._+-]+$ ]] || die "The release has an unexpected version: $ver"
    [ -z "$want" ] || [ "$want" = "$ver" ] || die "Asked for $want but the release says $ver."
    RELEASE_VERSION="$ver"
    RELEASE_DIR="$RIQ_HOME/releases/$ver"
    if [ -f "$RELEASE_DIR/.ready" ]; then ok "Version $ver is already downloaded"; rm -rf "$tmp"; return; fi
    printf '  Version %s%s%s\n' "$B" "$ver" "$N"
    quiet "Downloading the bundle (this is a few hundred MB)" download "$(asset_url "$ASSET" "$ver")" "$tmp/$ASSET"
    quiet "Downloading the checksum" download "$(asset_url SHA256SUMS "$ver")" "$tmp/SHA256SUMS"
    sums="$(grep " $ASSET\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
    [ -n "$sums" ] || die "SHA256SUMS does not list $ASSET."
    [ "$(sha256sum "$tmp/$ASSET" | awk '{print $1}')" = "$sums" ] || die "The download is damaged or has been tampered with: the checksum does not match."
    ok "Checksum matches"
    rm -rf "$RELEASE_DIR"; mkdir -p "$RIQ_HOME/releases"
    quiet "Unpacking" tar -xzf "$tmp/$ASSET" -C "$tmp"
    mv "$tmp/remoteiq" "$RELEASE_DIR"
    rm -rf "$tmp"
    [ -x "$RELEASE_DIR/runtime/bin/node" ] || die "The bundle is incomplete (no Node.js runtime)."
}

# The web app is built once for everybody. Here it learns this server's address.
# The sign-in cookie's name: the installation's own, or auth_token for one made before each had its own.
cookie_name() { local c; c="$(conf_get COOKIE_NAME)"; printf '%s' "${c:-auth_token}"; }

apply_placeholders() {
    local dir="$1" mode="$2" pub="$PUBLIC_URL" ws internal cookie
    cookie="$(cookie_name)"
    ws="ws${pub#http}"
    internal="$INTERNAL_PLACEHOLDER"
    [ "$mode" = native ] && internal="http://127.0.0.1:3001"
    grep -rlF "$PLACEHOLDER" "$dir/frontend" 2>/dev/null | while IFS= read -r f; do
        sed -i -e "s#wss://$PLACEHOLDER#$ws#g" -e "s#https://$PLACEHOLDER#$pub#g" "$f"
    done
    grep -rlF "$COOKIE_PLACEHOLDER" "$dir/frontend" 2>/dev/null | while IFS= read -r f; do sed -i "s#$COOKIE_PLACEHOLDER#$cookie#g" "$f"; done
    if [ "$internal" != "$INTERNAL_PLACEHOLDER" ]; then
        grep -rlF "$INTERNAL_PLACEHOLDER" "$dir/frontend" 2>/dev/null | while IFS= read -r f; do sed -i "s#$INTERNAL_PLACEHOLDER#$internal#g" "$f"; done
    fi
    if grep -rqF "$PLACEHOLDER" "$dir/frontend" 2>/dev/null; then warn "Some placeholder text was left in the web app; the address may not be applied everywhere."; fi
}

# ------------------------------------------------------------------ the questions

wizard() {
    need_tty
    title "RemoteIQ setup"
    say "I will ask a few questions, install everything, then finish the first configuration for you."
    say "${D}Press Enter to accept the answer in [brackets]. Nothing is changed until you confirm.${N}"
    rule

    # --- how to run it
    if [ -z "$WANT_MODE" ]; then
        local def=2; command -v docker >/dev/null 2>&1 && def=1
        ask_choice "How should RemoteIQ run on this server?" "$def" \
            "Docker (containers; easiest to upgrade and remove)" \
            "Native (system services; no Docker needed)"
        if [ "$REPLY_VALUE" = 1 ]; then MODE=docker; else MODE=native; fi
    else
        MODE="$WANT_MODE"
    fi

    # --- address and HTTPS
    title "Web address"
    say "The address people type to reach RemoteIQ, for example rmm.example.com. Its DNS record must point at this server."
    ask_valid "Web address (domain name)" "$(conf_get DOMAIN)" valid_host "Enter a domain name like rmm.example.com."
    DOMAIN="$REPLY_VALUE"

    ask_choice "How should RemoteIQ be reached over HTTPS?" "$([ -n "$(conf_get TLS)" ] && echo "$(conf_get TLS)" || echo 1)" \
        "Set it up for me: Caddy gets a free Let's Encrypt certificate (ports 80 and 443 must be free and the DNS record must already point here)" \
        "I already have a reverse proxy (Nginx Proxy Manager, nginx, Traefik...): just listen on a port" \
        "Set it up for me with a self-signed certificate (testing only: browsers will warn)"
    TLS="$REPLY_VALUE"
    case "$TLS" in
        1) PUBLIC_URL="https://$DOMAIN"; BIND_EDGE="127.0.0.1"; EDGE_PORT="$EDGE_PORT_DEFAULT"; ACME_EMAIL="" ;;
        3) PUBLIC_URL="https://$DOMAIN"; BIND_EDGE="127.0.0.1"; EDGE_PORT="$EDGE_PORT_DEFAULT"; ACME_EMAIL="" ;;
        2)
            ask_valid "Port for your proxy to forward to" "${EDGE_PORT_DEFAULT}" valid_edge_port "Use a port other than 3000 and 3001 (RemoteIQ uses those inside). 8080 is a good choice."
            EDGE_PORT="$REPLY_VALUE"
            ask_yn "Does your proxy serve $DOMAIN over HTTPS (not plain http)?" y && PUBLIC_URL="https://$DOMAIN" || PUBLIC_URL="http://$DOMAIN"
            [ "$PUBLIC_URL" = "http://$DOMAIN" ] && warn "Over plain http the browser will not keep the sign-in. HTTPS is needed outside a quick test."
            if ask_yn "Is your proxy on a different machine than this one?" n; then BIND_EDGE="0.0.0.0"; else BIND_EDGE="127.0.0.1"; fi
            ;;
    esac
    if [ "$TLS" = 1 ]; then
        ask_valid "Email for Let's Encrypt (renewal notices)" "$(conf_get ACME_EMAIL)" valid_email "Enter an email address."
        ACME_EMAIL="$REPLY_VALUE"
        local resolved
        resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}')"
        if [ -z "$resolved" ]; then warn "$DOMAIN does not resolve yet. The certificate will fail until its DNS record points at this server."
        else
            local mine; mine="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
            if [ -n "$mine" ] && [ "$mine" != "$resolved" ]; then warn "$DOMAIN points at $resolved but this server's public address looks like $mine."; else ok "$DOMAIN points at $resolved"; fi
        fi
    fi

    # --- database
    title "Database"
    ask_choice "Where should the database live?" "1" \
        "Install PostgreSQL 16 here (recommended)" \
        "Use an existing PostgreSQL server"
    if [ "$REPLY_VALUE" = 1 ]; then
        DB_MODE=local
    else
        DB_MODE=external
        ask_valid "Database host" "" valid_host "Enter a host name or address."; DB_HOST="$REPLY_VALUE"
        ask_valid "Database port" "5432" valid_port "Enter a port number."; DB_PORT="$REPLY_VALUE"
        ask_valid "Database name" "remoteiq" valid_nonempty "Enter a name."; DB_NAME="$REPLY_VALUE"
        ask_valid "Database user" "remoteiq" valid_nonempty "Enter a user name."; DB_USER="$REPLY_VALUE"
        ask_secret "Database password"; DB_PASSWORD="$REPLY_VALUE"
        if ask_yn "Does it require an SSL connection?" n; then DB_SSL=true; else DB_SSL=false; fi
        say "${D}The database must be empty (or a RemoteIQ one) and this user needs to be able to create the citext and pgcrypto extensions.${N}"
    fi

    # --- company and administrator
    title "Your company and administrator"
    ask_valid "Company name" "$(conf_get COMPANY)" valid_name "Enter your company name (up to 120 characters)."; COMPANY="$REPLY_VALUE"
    ask_valid "Administrator's first name" "" valid_name "Enter a first name."; ADMIN_FIRST="$REPLY_VALUE"
    ask "Administrator's last name" ""; ADMIN_LAST="$REPLY_VALUE"
    ask_valid "Administrator's email (this is the sign-in)" "$(conf_get ADMIN_EMAIL)" valid_email "Enter a valid email address."; ADMIN_EMAIL="$REPLY_VALUE"
    while :; do
        ask_secret "Administrator's password (at least 10 characters)"
        ADMIN_PASSWORD="$REPLY_VALUE"
        if [ "${#ADMIN_PASSWORD}" -lt 10 ]; then warn "Use at least 10 characters."; continue; fi
        ask_secret "Type it again"
        [ "$REPLY_VALUE" = "$ADMIN_PASSWORD" ] && break
        warn "The two passwords are not the same."
    done

    # --- email
    title "Email"
    say "RemoteIQ sends invitations, password resets, alerts and reports by email."
    SMTP_HOST=""; SMTP_PORT=""; SMTP_SECURITY=""; SMTP_USER=""; SMTP_PASSWORD=""; SMTP_FROM=""
    if ask_yn "Set up email sending now?" y; then
        ask_valid "SMTP server" "" valid_host "Enter a host name."; SMTP_HOST="$REPLY_VALUE"
        ask_choice "Connection security" "1" "STARTTLS (port 587, most common)" "SSL/TLS (port 465)" "None (port 25, only for trusted internal relays)"
        case "$REPLY_VALUE" in 1) SMTP_SECURITY=starttls; SMTP_PORT=587 ;; 2) SMTP_SECURITY=ssl; SMTP_PORT=465 ;; *) SMTP_SECURITY=none; SMTP_PORT=25 ;; esac
        ask_valid "SMTP port" "$SMTP_PORT" valid_port "Enter a port number."; SMTP_PORT="$REPLY_VALUE"
        ask "SMTP user name (leave empty if none)" ""; SMTP_USER="$REPLY_VALUE"
        if [ -n "$SMTP_USER" ]; then ask_secret "SMTP password"; SMTP_PASSWORD="$REPLY_VALUE"; fi
        ask_valid "Send from this address" "${SMTP_USER:-$ADMIN_EMAIL}" valid_email "Enter an email address."; SMTP_FROM="$REPLY_VALUE"
        if ask_yn "Send a test email to $ADMIN_EMAIL when setup finishes?" y; then SMTP_TEST_TO="$ADMIN_EMAIL"; else SMTP_TEST_TO=""; fi
    else
        info "Skipped. Set it later in Administration > Email."
    fi

    # --- portal
    title "Customer portal"
    say "A separate website, on its own address, where your customers see their tickets, devices and invoices."
    PORTAL_DOMAIN=""
    if ask_yn "Turn on the customer portal now?" n; then
        ask_valid "Portal address" "portal.${DOMAIN#*.}" valid_domain "Enter a domain name like portal.example.com."; PORTAL_DOMAIN="$REPLY_VALUE"
        [ "$PORTAL_DOMAIN" != "$DOMAIN" ] || { warn "The portal needs a different address than RemoteIQ itself."; PORTAL_DOMAIN=""; }
    else
        info "Skipped. Set it later in Administration > Client Portal."
    fi

    # --- first customer
    title "First customer"
    say "I can create a first customer and site and give you the one-line command that installs the agent on a computer."
    CUSTOMER=""; SITE=""
    if ask_yn "Create a first customer now?" y; then
        ask_valid "Customer name" "" valid_name "Enter a name."; CUSTOMER="$REPLY_VALUE"
        ask_valid "Site name" "Main office" valid_name "Enter a name."; SITE="$REPLY_VALUE"
    else
        info "Skipped. Add customers from the Customers page."
    fi

    # --- confirm
    title "Ready to install"
    rule
    printf '  Runs as           %s\n' "$([ "$MODE" = docker ] && echo "Docker containers" || echo "system services")"
    printf '  Web address       %s\n' "$PUBLIC_URL"
    case "$TLS" in
        1) printf '  HTTPS             Caddy with a Let'"'"'s Encrypt certificate\n' ;;
        3) printf '  HTTPS             Caddy with a self-signed certificate (testing)\n' ;;
        2) printf '  HTTPS             your own proxy, forwarding to port %s on %s\n' "$EDGE_PORT" "$BIND_EDGE" ;;
    esac
    printf '  Database          %s\n' "$([ "$DB_MODE" = local ] && echo "PostgreSQL 16 on this server" || echo "$DB_HOST:$DB_PORT/$DB_NAME")"
    printf '  Company           %s\n' "$COMPANY"
    printf '  Administrator     %s (%s %s)\n' "$ADMIN_EMAIL" "$ADMIN_FIRST" "$ADMIN_LAST"
    printf '  Email             %s\n' "${SMTP_HOST:-not set up now}"
    printf '  Customer portal   %s\n' "${PORTAL_DOMAIN:-not now}"
    printf '  First customer    %s\n' "$([ -n "$CUSTOMER" ] && echo "$CUSTOMER / $SITE" || echo none)"
    rule
    ask_yn "Install now?" y || die "Cancelled. Nothing was changed."

    conf_set MODE "$MODE"; conf_set DOMAIN "$DOMAIN"; conf_set TLS "$TLS"; conf_set PUBLIC_URL "$PUBLIC_URL"
    [ -z "$RIQ_RELEASE_BASE" ] || conf_set RELEASE_BASE "$RIQ_RELEASE_BASE"
    [ -z "$RIQ_REPO_GIVEN" ] || conf_set REPO "$RIQ_REPO_GIVEN"
    conf_set EDGE_PORT "$EDGE_PORT"; conf_set BIND_EDGE "$BIND_EDGE"; conf_set ACME_EMAIL "${ACME_EMAIL:-}"
    conf_set DB_MODE "$DB_MODE"; conf_set COMPANY "$COMPANY"; conf_set ADMIN_EMAIL "$ADMIN_EMAIL"; conf_set PORTAL_DOMAIN "$PORTAL_DOMAIN"
    if [ "$DB_MODE" = external ]; then conf_set DB_HOST "$DB_HOST"; conf_set DB_PORT "$DB_PORT"; conf_set DB_NAME "$DB_NAME"; conf_set DB_USER "$DB_USER"; conf_set DB_PASSWORD "$DB_PASSWORD"; conf_set DB_SSL "$DB_SSL"; fi
}

# ------------------------------------------------------------------ secrets and configuration

random_hex() { openssl rand -hex "${1:-32}"; }

make_secrets() {
    mkdir -p "$RIQ_HOME/secrets" "$RIQ_HOME/config"
    chmod 700 "$RIQ_HOME/secrets"
    [ -f "$RIQ_HOME/secrets/data-encryption.key" ] || { random_hex 48 >"$RIQ_HOME/secrets/data-encryption.key"; }
    chmod 600 "$RIQ_HOME/secrets/data-encryption.key"
    local k
    for k in JWT_SECRET ADMIN_API_KEY ENROLLMENT_SECRET DB_LOCAL_PASSWORD; do
        [ -n "$(conf_get "$k")" ] || conf_set "$k" "$(random_hex 32)"
    done
    # Each installation signs people in with a cookie of its own name, so it can share a domain with another RemoteIQ.
    [ -n "$(conf_get COOKIE_NAME)" ] || conf_set COOKIE_NAME "riq_$(random_hex 4)"
}

database_url() {
    local host port name user pass ssl=""
    if [ "$DB_MODE" = local ]; then
        name=remoteiq; user=remoteiq; pass="$(conf_get DB_LOCAL_PASSWORD)"; port="$(conf_get DB_LOCAL_PORT)"; port="${port:-5432}"
        if [ "$MODE" = docker ]; then host=postgres; port=5432; else host=127.0.0.1; fi
    else
        host="$(conf_get DB_HOST)"; port="$(conf_get DB_PORT)"; name="$(conf_get DB_NAME)"; user="$(conf_get DB_USER)"; pass="$(conf_get DB_PASSWORD)"
    fi
    [ "$(conf_get DB_SSL)" = true ] && ssl="&sslmode=require"
    # Characters that are special in a URL are escaped in the password.
    local enc
    enc="$(printf '%s' "$pass" | od -An -tx1 | tr -d ' \n' | sed 's/../%&/g')"
    printf 'postgresql://%s:%s@%s:%s/%s?schema=public%s' "$user" "$enc" "$host" "$port" "$name" "$ssl"
}

write_backend_env() {
    local mode="$1" file="$RIQ_HOME/config/remoteiq.env" origins keys data pkg uploads
    origins="$PUBLIC_URL"
    [ -n "${PORTAL_DOMAIN:-}" ] && origins="$origins,https://$PORTAL_DOMAIN"
    if [ "$mode" = docker ]; then keys=/secrets; data=/data/var; pkg=/opt/remoteiq/agent-packages; else keys="$RIQ_HOME/secrets"; data="$RIQ_HOME/data/var"; pkg="$RIQ_HOME/current/agent-packages"; fi
    local ssl=false; [ "$(conf_get DB_SSL)" = true ] && ssl=true
    {
        echo "# Written by the RemoteIQ installer. Edit with care; 'install.sh upgrade' keeps this file."
        echo "NODE_ENV=production"
        echo "PORT=3001"
        echo "BIND_HOST=$([ "$mode" = docker ] && echo 0.0.0.0 || echo 127.0.0.1)"
        echo "SWAGGER=false"
        echo "DATABASE_URL=$(database_url)"
        echo "DATABASE_SSL=$ssl"
        echo "JWT_SECRET=$(conf_get JWT_SECRET)"
        echo "ADMIN_API_KEY=$(conf_get ADMIN_API_KEY)"
        echo "ENROLLMENT_SECRET=$(conf_get ENROLLMENT_SECRET)"
        echo "AUTH_COOKIE_NAME=$(cookie_name)"
        echo "FRONTEND_ORIGINS=$origins"
        echo "ALLOWED_ORIGIN=$PUBLIC_URL"
        echo "PUBLIC_BASE_URL=$PUBLIC_URL"
        echo "PUBLIC_API_BASE_URL=$PUBLIC_URL"
        echo "PUBLIC_CONSOLE_URL=$PUBLIC_URL"
        echo "INSTALLER_BASE_URL=$PUBLIC_URL"
        echo "DATA_ENCRYPTION_KEY_FILE=$keys/data-encryption.key"
        echo "JOB_SIGNING_KEY_FILE=$keys/job-signing.pem"
        echo "ADMIN_DATA_DIR=$data"
        echo "AGENT_PKG_DIR=$pkg"
        echo "AGENT_UPDATES_ENABLED=true"
        echo "IMAP_POLL_ENABLED=false"
        echo "TURN_PROVIDER=none"
        echo "AUDIT_RETENTION_DAYS=365"
        echo "CHECK_RUNS_RETENTION_DAYS=14"
    } >"$file"
    chown root:"$([ "$mode" = native ] && echo remoteiq || echo root)" "$file" 2>/dev/null || true
    chmod 640 "$file"
}

# ------------------------------------------------------------------ docker mode

install_docker_engine() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then ok "Docker is already installed"; return; fi
    title "Installing Docker"
    quiet "Adding Docker's package source" bash -c "
        install -m 0755 -d /etc/apt/keyrings &&
        curl -fsSL https://download.docker.com/linux/$OS_ID/gpg -o /etc/apt/keyrings/docker.asc &&
        chmod a+r /etc/apt/keyrings/docker.asc &&
        echo \"deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable\" > /etc/apt/sources.list.d/docker.list &&
        apt-get update"
    quiet "Installing Docker" apt_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
    systemctl enable --now docker >>"$LOG" 2>&1 || true
}

dc() { docker compose -f "$RIQ_HOME/docker-compose.yml" --env-file "$RIQ_HOME/config/compose.env" "$@"; }

write_compose() {
    local ver="$1" edge_publish tls_block="" pg_block="" depends=""
    mkdir -p "$RIQ_HOME/data/uploads" "$RIQ_HOME/data/config" "$RIQ_HOME/data/var" "$RIQ_HOME/data/caddy" "$RIQ_HOME/data/caddy-config"
    chown -R 1000:1000 "$RIQ_HOME/data/uploads" "$RIQ_HOME/data/config" "$RIQ_HOME/data/var" "$RIQ_HOME/secrets"
    if [ "$TLS" = 2 ]; then edge_publish="\"$BIND_EDGE:$EDGE_PORT:8080\""; else edge_publish="\"127.0.0.1:$EDGE_PORT:8080\""; fi
    {
        echo "name: remoteiq"
        echo "services:"
        if [ "$DB_MODE" = local ]; then
            mkdir -p "$RIQ_HOME/data/postgres"
            cat <<YAML
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: remoteiq
      POSTGRES_DB: remoteiq
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - $RIQ_HOME/data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U remoteiq -d remoteiq"]
      interval: 5s
      timeout: 5s
      retries: 30
YAML
            depends="    depends_on:
      postgres:
        condition: service_healthy"
        fi
        cat <<YAML
  riq-backend:
    image: remoteiq-backend:\${RIQ_VERSION}
    restart: unless-stopped
    env_file: $RIQ_HOME/config/remoteiq.env
$depends
    ports:
      - "127.0.0.1:3001:3001"
    volumes:
      - $RIQ_HOME/data/uploads:/app/public/uploads
      - $RIQ_HOME/data/config:/app/config
      - $RIQ_HOME/data/var:/data/var
      - $RIQ_HOME/secrets:/secrets
      - $RIQ_HOME/current/agent-packages:/opt/remoteiq/agent-packages:ro
      - $RIQ_HOME/config:/config:ro
  riq-frontend:
    image: remoteiq-frontend:\${RIQ_VERSION}
    restart: unless-stopped
    environment:
      BACKEND_INTERNAL_URL: http://riq-backend:3001
    depends_on:
      - riq-backend
  riq-edge:
    image: remoteiq-backend:\${RIQ_VERSION}
    restart: unless-stopped
    command: ["node", "/opt/riq/tools/edge.cjs"]
    environment:
      EDGE_HOST: 0.0.0.0
      EDGE_PORT: "8080"
      WEB_UPSTREAM: http://riq-frontend:3000
      API_UPSTREAM: http://riq-backend:3001
      EDGE_PROTO: $([ "${PUBLIC_URL%%:*}" = https ] && echo https || echo http)
    ports:
      - $edge_publish
    depends_on:
      - riq-frontend
YAML
        if [ "$TLS" != 2 ]; then
            cat <<YAML
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - $RIQ_HOME/config/Caddyfile:/etc/caddy/Caddyfile:ro
      - $RIQ_HOME/data/caddy:/data
      - $RIQ_HOME/data/caddy-config:/config
    depends_on:
      - riq-edge
YAML
        fi
    } >"$RIQ_HOME/docker-compose.yml"
    {
        echo "RIQ_VERSION=$ver"
        echo "POSTGRES_PASSWORD=$(conf_get DB_LOCAL_PASSWORD)"
    } >"$RIQ_HOME/config/compose.env"
    chmod 600 "$RIQ_HOME/config/compose.env"
}

emit_caddyfile() {
    local dest="$1" upstream="$2" names="$DOMAIN"
    [ -n "${PORTAL_DOMAIN:-}" ] && names="$DOMAIN, $PORTAL_DOMAIN"
    {
        if [ "$TLS" = 1 ] && [ -n "${ACME_EMAIL:-}" ]; then printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"; fi
        printf '%s {\n' "$names"
        if [ "$TLS" = 3 ]; then printf '\ttls internal\n'; fi
        # The web app and the API already send X-Frame-Options, X-Content-Type-Options and Referrer-Policy (Caddy would add a second
        # copy next to them). Caddy adds only HSTS, and only with a real certificate: with the self-signed test certificate it would
        # lock browsers out of clicking through the warning for a year.
        if [ "$TLS" = 1 ]; then printf '\theader Strict-Transport-Security "max-age=31536000"\n'; fi
        printf '\treverse_proxy %s\n}\n' "$upstream"
    } >"$dest"
}

docker_install() {
    local ver="$1" dir="$2"
    title "Building the containers"
    quiet "Building the API image" docker build -q -f "$dir/docker/Dockerfile.backend" -t "remoteiq-backend:$ver" "$dir"
    quiet "Building the web app image" docker build -q -f "$dir/docker/Dockerfile.frontend" -t "remoteiq-frontend:$ver" "$dir"
    ln -sfn "$dir" "$RIQ_HOME/current"
    write_backend_env docker
    write_compose "$ver"
    [ "$TLS" = 2 ] || emit_caddyfile "$RIQ_HOME/config/Caddyfile" "riq-edge:8080"
    title "Starting RemoteIQ"
    [ "$DB_MODE" = local ] && quiet "Fetching the database image" docker pull -q postgres:16
    [ "$TLS" = 2 ] || quiet "Fetching the HTTPS proxy image" docker pull -q caddy:2
    quiet "Starting the services" dc up -d
}

# ------------------------------------------------------------------ native mode

install_postgres_native() {
    title "Installing PostgreSQL 16"
    quiet "Adding the PostgreSQL package source" bash -c "apt-get install -y --no-install-recommends postgresql-common >/dev/null && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y"
    quiet "Installing PostgreSQL 16" apt_install postgresql-16 postgresql-client-16
    systemctl enable --now postgresql >>"$LOG" 2>&1 || true
    # If something else already uses port 5432, the new cluster is given the next free port. Use the port it really has.
    local pgport; pgport="$(pg_lsclusters -h 2>/dev/null | awk '$1==16 && $2=="main" {print $3}')"; pgport="${pgport:-5432}"
    conf_set DB_LOCAL_PORT "$pgport"
    local i
    for i in $(seq 1 40); do runuser -u postgres -- pg_isready -q -p "$pgport" && break; sleep 1; done
    runuser -u postgres -- pg_isready -q -p "$pgport" || die "PostgreSQL did not start."
    local pass; pass="$(conf_get DB_LOCAL_PASSWORD)"
    runuser -u postgres -- psql -p "$pgport" -v ON_ERROR_STOP=1 -q >>"$LOG" 2>&1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'remoteiq') THEN CREATE ROLE remoteiq LOGIN; END IF;
END \$\$;
ALTER ROLE remoteiq WITH PASSWORD '$pass';
SELECT 'CREATE DATABASE remoteiq OWNER remoteiq' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'remoteiq')\gexec
SQL
    runuser -u postgres -- psql -p "$pgport" -v ON_ERROR_STOP=1 -q -d remoteiq -c 'CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto;' >>"$LOG" 2>&1
    ok "Database ready"
}

install_caddy_native() {
    command -v caddy >/dev/null 2>&1 && { ok "Caddy is already installed"; return; }
    title "Installing Caddy"
    quiet "Adding Caddy's package source" bash -c "
        apt-get install -y --no-install-recommends debian-keyring debian-archive-keyring apt-transport-https &&
        curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg &&
        curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list &&
        apt-get update"
    quiet "Installing Caddy" apt_install caddy
}

native_user_and_dirs() {
    id remoteiq >/dev/null 2>&1 || useradd --system --home-dir "$RIQ_HOME" --shell /usr/sbin/nologin remoteiq
    mkdir -p "$RIQ_HOME/data/uploads" "$RIQ_HOME/data/config" "$RIQ_HOME/data/var" "$RIQ_HOME/backups" "$RIQ_HOME/secrets"
    chown -R remoteiq:remoteiq "$RIQ_HOME/data" "$RIQ_HOME/secrets"
    chown root:remoteiq "$RIQ_HOME/config"; chmod 750 "$RIQ_HOME/config"
}

link_release_data() {
    local dir="$1"
    rm -rf "$dir/backend/public/uploads" "$dir/backend/config"
    mkdir -p "$dir/backend/public"
    ln -sfn "$RIQ_HOME/data/uploads" "$dir/backend/public/uploads"
    ln -sfn "$RIQ_HOME/data/config" "$dir/backend/config"
}

migrate_native() {
    local dir="$1"
    quiet "Preparing the database (migrations)" runuser -u remoteiq -- bash -c "set -a; . '$RIQ_HOME/config/remoteiq.env'; set +a; cd '$dir/backend' && '$dir/runtime/bin/node' node_modules/prisma/build/index.js migrate deploy"
}

write_units() {
    cat >/etc/systemd/system/remoteiq-backend.service <<UNIT
[Unit]
Description=RemoteIQ API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=remoteiq
Group=remoteiq
WorkingDirectory=$RIQ_HOME/current/backend
EnvironmentFile=$RIQ_HOME/config/remoteiq.env
ExecStart=$RIQ_HOME/current/runtime/bin/node dist/main.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
    cat >/etc/systemd/system/remoteiq-frontend.service <<UNIT
[Unit]
Description=RemoteIQ web app
After=remoteiq-backend.service
Wants=remoteiq-backend.service

[Service]
User=remoteiq
Group=remoteiq
WorkingDirectory=$RIQ_HOME/current/frontend
Environment=NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1 NEXT_TELEMETRY_DISABLED=1 BACKEND_INTERNAL_URL=http://127.0.0.1:3001
ExecStart=$RIQ_HOME/current/runtime/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
    cat >/etc/systemd/system/remoteiq-edge.service <<UNIT
[Unit]
Description=RemoteIQ edge router
After=remoteiq-frontend.service
Wants=remoteiq-frontend.service

[Service]
User=remoteiq
Group=remoteiq
Environment=EDGE_HOST=$BIND_EDGE EDGE_PORT=$EDGE_PORT WEB_UPSTREAM=http://127.0.0.1:3000 API_UPSTREAM=http://127.0.0.1:3001 EDGE_PROTO=$([ "${PUBLIC_URL%%:*}" = https ] && echo https || echo http)
ExecStart=$RIQ_HOME/current/runtime/bin/node $RIQ_HOME/current/tools/edge.cjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
}

native_install() {
    local ver="$1" dir="$2"
    native_user_and_dirs
    [ "$DB_MODE" = local ] && install_postgres_native
    [ "$TLS" = 2 ] || install_caddy_native
    link_release_data "$dir"
    ln -sfn "$dir" "$RIQ_HOME/current"
    # Hosts mapping is not needed: the web app is told the API's address directly.
    write_backend_env native
    migrate_native "$dir"
    write_units
    if [ "$TLS" != 2 ]; then
        emit_caddyfile /etc/caddy/Caddyfile "127.0.0.1:$EDGE_PORT"
        quiet "Starting Caddy" systemctl restart caddy
        systemctl enable caddy >>"$LOG" 2>&1 || true
    fi
    title "Starting RemoteIQ"
    quiet "Starting the services" systemctl enable --now remoteiq-backend remoteiq-frontend remoteiq-edge
}

# ------------------------------------------------------------------ after the services are up

open_firewall() {
    command -v ufw >/dev/null 2>&1 || return 0
    ufw status 2>/dev/null | grep -q "Status: active" || return 0
    if [ "$TLS" = 2 ]; then
        if [ "$BIND_EDGE" = 0.0.0.0 ]; then ufw allow "$EDGE_PORT"/tcp >>"$LOG" 2>&1 && ok "Opened port $EDGE_PORT in the firewall"; fi
    else
        ufw allow 80/tcp >>"$LOG" 2>&1; ufw allow 443/tcp >>"$LOG" 2>&1; ufw allow 443/udp >>"$LOG" 2>&1
        ok "Opened ports 80 and 443 in the firewall"
    fi
    return 0
}

wait_healthy() {
    local i
    printf '  Waiting for RemoteIQ to start '
    for i in $(seq 1 90); do
        if curl -fsS --max-time 3 http://127.0.0.1:3001/healthz >/dev/null 2>&1; then printf ' %sup%s\n' "$G" "$N"; return 0; fi
        printf '.'; sleep 2
    done
    printf '\n'
    return 1
}

wait_web() {
    local i
    for i in $(seq 1 45); do
        curl -fsS --max-time 4 -o /dev/null "http://127.0.0.1:$(conf_get EDGE_PORT)/login" 2>/dev/null && return 0
        sleep 2
    done
    return 1
}

# Runs one of the bundled setup helpers. Docker mode runs it inside the API container; native runs it with the bundled Node.
run_tool() {
    local cmd="$1" answers="$2"
    if [ "$MODE" = docker ]; then
        dc exec -T riq-backend node /opt/riq/tools/riq-admin.cjs "$cmd" "/config/$(basename "$answers")"
    else
        RIQ_BACKEND_DIR="$RIQ_HOME/current/backend" "$RIQ_HOME/current/runtime/bin/node" "$RIQ_HOME/current/tools/riq-admin.cjs" "$cmd" "$answers"
    fi
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr -d '\n\r'; }

first_run_setup() {
    local answers="$RIQ_HOME/config/first-run.json" db_url api_base="http://127.0.0.1:3001"
    db_url="$(database_url)"
    umask 077
    cat >"$answers" <<JSON
{
  "databaseUrl": "$(json_escape "$db_url")",
  "databaseSsl": $([ "$(conf_get DB_SSL)" = true ] && echo true || echo false),
  "apiBase": "$api_base",
  "company": "$(json_escape "$COMPANY")",
  "firstName": "$(json_escape "$ADMIN_FIRST")",
  "lastName": "$(json_escape "${ADMIN_LAST:-}")",
  "email": "$(json_escape "$ADMIN_EMAIL")",
  "password": "$(json_escape "$ADMIN_PASSWORD")",
  "companyEmail": "$(json_escape "$ADMIN_EMAIL")",
  "publicUrl": "$(json_escape "$PUBLIC_URL")",
  "portalDomain": "$(json_escape "${PORTAL_DOMAIN:-}")",
  "smtp": { "host": "$(json_escape "${SMTP_HOST:-}")", "port": "$(json_escape "${SMTP_PORT:-}")", "security": "$(json_escape "${SMTP_SECURITY:-}")", "username": "$(json_escape "${SMTP_USER:-}")", "password": "$(json_escape "${SMTP_PASSWORD:-}")", "fromAddress": "$(json_escape "${SMTP_FROM:-}")", "testTo": "$(json_escape "${SMTP_TEST_TO:-}")" },
  "customer": { "name": "$(json_escape "${CUSTOMER:-}")", "site": "$(json_escape "${SITE:-}")" }
}
JSON
    chmod 600 "$answers"
    if [ "$MODE" = docker ]; then chown 1000:1000 "$answers"; fi

    local out l rc
    out="$(mktemp)"
    title "Creating your administrator"
    if run_tool has-owner "$answers" >/dev/null 2>&1; then
        warn "This database already has an Owner, so no new administrator was created."
    else
        rc=0; run_tool create-admin "$answers" >"$out" 2>&1 || rc=$?
        while IFS= read -r l; do show_tool_line "$l"; done <"$out"
        if [ "$rc" != 0 ]; then rm -f "$answers" "$out"; die "Could not create the administrator."; fi
    fi

    title "Finishing the setup"
    rc=0; run_tool configure "$answers" >"$out" 2>&1 || rc=$?
    while IFS= read -r l; do show_tool_line "$l"; done <"$out"
    [ "$rc" = 0 ] || warn "The setup did not finish everything. Re-do the missing parts from Administration."
    rm -f "$answers" "$out"
    return 0
}

show_tool_line() {
    local kind="${1%% *}" rest="${1#* }"
    case "$kind" in
        OK) ok "$rest" ;;
        WARN) warn "$rest" ;;
        INFO) info "$rest" ;;
        ERROR) printf '%s✗ %s%s\n' "$R" "$rest" "$N" ;;
        CMD)
            AGENT_COMMANDS+=("$rest")
            ;;
        *) [ -n "$1" ] && info "$1" ;;
    esac
}

summary() {
    title "RemoteIQ is installed"
    rule
    printf '  Open              %s%s%s\n' "$B" "$PUBLIC_URL" "$N"
    printf '  Sign in with      %s\n' "$ADMIN_EMAIL"
    [ -n "${PORTAL_DOMAIN:-}" ] && printf '  Customer portal   https://%s\n' "$PORTAL_DOMAIN"
    printf '  Installed in      %s (%s)\n' "$RIQ_HOME" "$([ "$MODE" = docker ] && echo Docker || echo "systemd services")"
    rule
    if [ "$TLS" = 2 ]; then
        say "Point your reverse proxy at ${B}http://$([ "$BIND_EDGE" = 0.0.0.0 ] && echo "THIS-SERVER-ADDRESS" || echo 127.0.0.1):$EDGE_PORT${N} for ${B}$DOMAIN${N}"
        say "${D}Turn Websockets Support ON and request your certificate there. One proxy entry is all it needs.${N}"
        [ -n "${PORTAL_DOMAIN:-}" ] && say "${D}Add the same forwarding for ${PORTAL_DOMAIN} (a second proxy host with the same target).${N}"
        rule
    elif [ -n "${PORTAL_DOMAIN:-}" ]; then
        say "${D}Make sure DNS for ${PORTAL_DOMAIN} points at this server too; Caddy gets its certificate automatically.${N}"
        rule
    fi
    if [ "${#AGENT_COMMANDS[@]}" -gt 0 ]; then
        say "${B}Install the agent on a computer at ${CUSTOMER}${N} (run as administrator / root):"
        local c os
        for c in "${AGENT_COMMANDS[@]}"; do
            os="${c%% *}"
            printf '\n  %s%s%s\n  %s\n' "$B" "$([ "$os" = windows ] && echo "Windows (PowerShell)" || echo "Linux")" "$N" "${c#* }"
        done
        rule
    fi
    say "${B}Back up these two files somewhere safe, away from this server:${N}"
    say "  $RIQ_HOME/secrets/data-encryption.key"
    say "  $RIQ_HOME/secrets/job-signing.pem   ${D}(created the first time the server starts a job)${N}"
    say "${D}Without them, stored passwords and encrypted backups cannot be read, and agents must be reinstalled.${N}"
    rule
    say "Useful commands:"
    say "  sudo bash $RIQ_HOME/install.sh status       health check (add --logs for a support bundle)"
    say "  sudo bash $RIQ_HOME/install.sh upgrade      move to the latest release"
    say "  sudo bash $RIQ_HOME/install.sh uninstall    remove RemoteIQ"
    say "${D}Install log: $LOG${N}"
}

# ------------------------------------------------------------------ commands

cmd_install() {
    preflight
    if [ "$(conf_get INSTALLED)" = 1 ]; then
        die "RemoteIQ is already installed here ($(conf_get VERSION)). Use: upgrade, status or uninstall."
    fi
    if [ -n "$(conf_get MODE)" ]; then warn "A previous install did not finish. Your earlier answers are offered as defaults."; fi
    check_connectivity
    wizard
    if [ -z "$(conf_get INSTALLED)" ] && [ -z "$(conf_get PREVIOUS_RUN)" ]; then preflight_ports; else info "Skipping the port check: a previous run may be using them."; fi
    conf_set PREVIOUS_RUN 1
    AGENT_COMMANDS=()

    title "Installing"
    base_packages
    [ "$MODE" = docker ] && install_docker_engine
    make_secrets
    fetch_release "$WANT_VERSION"
    apply_placeholders "$RELEASE_DIR" "$MODE"
    # A piped script has no file of its own, so the copy that ships in the release is kept for later commands.
    if [ -s "$RELEASE_DIR/install.sh" ]; then cp "$RELEASE_DIR/install.sh" "$RIQ_HOME/install.sh"; chmod 700 "$RIQ_HOME/install.sh"; fi

    if [ "$MODE" = docker ]; then docker_install "$RELEASE_VERSION" "$RELEASE_DIR"; else native_install "$RELEASE_VERSION" "$RELEASE_DIR"; fi
    wait_healthy || die "The API did not start. See: $([ "$MODE" = docker ] && echo "docker compose -f $RIQ_HOME/docker-compose.yml logs riq-backend" || echo "journalctl -u remoteiq-backend -n 100")"
    wait_web || warn "The web app is slow to start; setup continues."
    open_firewall

    first_run_setup
    conf_set VERSION "$RELEASE_VERSION"; conf_set INSTALLED 1
    unset ADMIN_PASSWORD SMTP_PASSWORD
    summary
}

preflight_ports() {
    local p
    if [ "$TLS" != 2 ]; then
        for p in 80 443; do port_in_use "$p" && die "Port $p is already in use on this server, and the built-in HTTPS needs it. Stop what is using it (ss -ltnp | grep :$p) or choose the 'I already have a reverse proxy' option."; done
    fi
    case "$EDGE_PORT" in 3000|3001) die "Port $EDGE_PORT is used inside RemoteIQ. Choose another port for the proxy, such as 8080." ;; esac
    port_in_use "$EDGE_PORT" && die "Port $EDGE_PORT is already in use."
    port_in_use 3001 && die "Port 3001 is already in use."
    port_in_use 3000 && [ "$MODE" = native ] && die "Port 3000 is already in use."
    return 0
}

load_state() {
    [ -f "$CONF" ] || die "RemoteIQ is not installed here (no $CONF)."
    MODE="$(conf_get MODE)"; DOMAIN="$(conf_get DOMAIN)"; TLS="$(conf_get TLS)"; PUBLIC_URL="$(conf_get PUBLIC_URL)"
    EDGE_PORT="$(conf_get EDGE_PORT)"; BIND_EDGE="$(conf_get BIND_EDGE)"; ACME_EMAIL="$(conf_get ACME_EMAIL)"; DB_MODE="$(conf_get DB_MODE)"
    PORTAL_DOMAIN="$(conf_get PORTAL_DOMAIN)"; CURRENT_VERSION="$(conf_get VERSION)"
    # Upgrades come from where the installation came from, unless told otherwise.
    [ -n "$RIQ_RELEASE_BASE" ] || RIQ_RELEASE_BASE="$(conf_get RELEASE_BASE)"
    if [ -z "$RIQ_REPO_GIVEN" ] && [ -n "$(conf_get REPO)" ]; then RIQ_REPO="$(conf_get REPO)"; fi
}

cmd_upgrade() {
    preflight; load_state; check_connectivity
    [ "$(conf_get INSTALLED)" = 1 ] || die "The installation did not finish; run the installer again first."
    local old_dir new_dir ts dump
    old_dir="$(readlink -f "$RIQ_HOME/current")"
    fetch_release "$WANT_VERSION"
    if [ "$RELEASE_VERSION" = "$CURRENT_VERSION" ] && [ "$FORCE" != 1 ]; then ok "RemoteIQ $CURRENT_VERSION is already the latest."; return 0; fi
    new_dir="$RELEASE_DIR"
    if [ "$RELEASE_VERSION" = "$CURRENT_VERSION" ]; then say "Reinstalling ${B}$CURRENT_VERSION${N}"; else say "Upgrading ${B}$CURRENT_VERSION${N} to ${B}$RELEASE_VERSION${N}"; fi
    ask_yn_or_default() { if [ -r "$TTY" ]; then ask_yn "$1" y; else return 0; fi; }
    ask_yn_or_default "Continue? A database backup is taken first." || { say "Cancelled."; return 0; }

    ts="$(date +%Y%m%d-%H%M%S)"; mkdir -p "$RIQ_HOME/backups"; dump="$RIQ_HOME/backups/before-$RELEASE_VERSION-$ts.dump"
    backup_database "$dump" || die "The database backup failed, so nothing was changed."
    ok "Database backed up to $dump"

    apply_placeholders "$new_dir" "$MODE"
    if [ "$RECONFIGURE" = 1 ]; then
        write_backend_env "$MODE"
        if [ "$TLS" != 2 ]; then
            if [ "$MODE" = docker ]; then emit_caddyfile "$RIQ_HOME/config/Caddyfile" "riq-edge:8080"; else emit_caddyfile /etc/caddy/Caddyfile "127.0.0.1:$EDGE_PORT"; fi
        fi
    fi
    if [ "$MODE" = docker ]; then
        quiet "Building the API image" docker build -q -f "$new_dir/docker/Dockerfile.backend" -t "remoteiq-backend:$RELEASE_VERSION" "$new_dir"
        quiet "Building the web app image" docker build -q -f "$new_dir/docker/Dockerfile.frontend" -t "remoteiq-frontend:$RELEASE_VERSION" "$new_dir"
        ln -sfn "$new_dir" "$RIQ_HOME/current"
        write_compose "$RELEASE_VERSION"
        dc up -d >>"$LOG" 2>&1 || true
        if [ "$RECONFIGURE" = 1 ] && [ "$TLS" != 2 ]; then dc restart caddy >>"$LOG" 2>&1 || true; fi
    else
        link_release_data "$new_dir"
        ln -sfn "$new_dir" "$RIQ_HOME/current"
        if ! migrate_native "$new_dir"; then rollback "$old_dir" "$dump"; fi
        write_units
        systemctl restart remoteiq-backend remoteiq-frontend remoteiq-edge >>"$LOG" 2>&1 || true
        if [ "$RECONFIGURE" = 1 ] && [ "$TLS" != 2 ]; then systemctl restart caddy >>"$LOG" 2>&1 || true; fi
    fi
    if wait_healthy && wait_web; then
        conf_set VERSION "$RELEASE_VERSION"
        ok "RemoteIQ is now $RELEASE_VERSION"
        prune_releases
    else
        rollback "$old_dir" "$dump"
    fi
}

rollback() {
    local old_dir="$1" dump="$2"
    warn "The new version did not come up. Going back to $CURRENT_VERSION."
    ln -sfn "$old_dir" "$RIQ_HOME/current"
    if [ "$MODE" = docker ]; then
        write_compose "$CURRENT_VERSION"; dc up -d >>"$LOG" 2>&1 || true
    else
        write_units; systemctl restart remoteiq-backend remoteiq-frontend remoteiq-edge >>"$LOG" 2>&1 || true
    fi
    wait_healthy && ok "Running $CURRENT_VERSION again." || warn "It still is not healthy; see $LOG."
    # The release that failed is not kept.
    case "${RELEASE_DIR:-}" in "$RIQ_HOME"/releases/*) [ "$RELEASE_DIR" = "$old_dir" ] || rm -rf "$RELEASE_DIR" ;; esac
    warn "If the upgrade changed the database, restore the backup with: pg_restore --clean --if-exists -d <database> $dump"
    exit 1
}

backup_database() {
    local out="$1"
    # The dump holds every customer's data: it is created private (umask 077), so it is never readable by others, not even
    # for the moment before the chmod below. The writes after this truncate it and keep that mode.
    ( umask 077; rm -f "$out"; : >"$out" )
    if [ "$DB_MODE" = local ]; then
        if [ "$MODE" = docker ]; then dc exec -T postgres pg_dump -U remoteiq -Fc remoteiq >"$out"; else runuser -u postgres -- pg_dump -p "$(conf_get DB_LOCAL_PORT)" -Fc remoteiq >"$out"; fi
    else
        command -v pg_dump >/dev/null 2>&1 || { apt_install postgresql-client >>"$LOG" 2>&1 || true; }
        PGPASSWORD="$(conf_get DB_PASSWORD)" pg_dump -Fc -h "$(conf_get DB_HOST)" -p "$(conf_get DB_PORT)" -U "$(conf_get DB_USER)" "$(conf_get DB_NAME)" >"$out"
    fi
    [ -s "$out" ] && chmod 600 "$out"
}

prune_releases() {
    local keep=2 d
    # Keep the current and previous release; older ones and old database backups are removed.
    ls -1dt "$RIQ_HOME"/releases/*/ 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r d; do rm -rf "$d"; done
    ls -1t "$RIQ_HOME"/backups/*.dump 2>/dev/null | tail -n +6 | while IFS= read -r d; do rm -f "$d"; done
}

cmd_reconfigure() {
    preflight; load_state; need_tty
    [ "$(conf_get INSTALLED)" = 1 ] || die "The installation did not finish; run the installer again first."
    title "Change addresses"
    say "RemoteIQ's web address now is $PUBLIC_URL${PORTAL_DOMAIN:+ and the customer portal is on $PORTAL_DOMAIN}."
    ask_valid "Web address (domain name)" "$DOMAIN" valid_host "Enter a domain name like rmm.example.com."
    local newdomain="$REPLY_VALUE" newportal="$PORTAL_DOMAIN"
    ask "Customer portal address (leave empty for none)" "$PORTAL_DOMAIN"
    newportal="$REPLY_VALUE"
    if [ -n "$newportal" ] && ! valid_domain "$newportal"; then die "That is not a valid domain name: $newportal"; fi
    [ "$newportal" != "$newdomain" ] || die "The portal needs a different address than RemoteIQ itself."
    local scheme="${PUBLIC_URL%%://*}"
    conf_set DOMAIN "$newdomain"; conf_set PUBLIC_URL "$scheme://$newdomain"; conf_set PORTAL_DOMAIN "$newportal"
    ok "Saved. Applying it now (the same version is installed again with the new addresses)."
    say "${D}If you use your own reverse proxy, point it at the new names too. The portal address itself is chosen in Administration > Client Portal.${N}"
    load_state
    RECONFIGURE=1; FORCE=1; WANT_VERSION="$CURRENT_VERSION"
    cmd_upgrade
}

cmd_status() {
    load_state
    title "RemoteIQ status"
    rule
    printf '  Version     %s\n  Mode        %s\n  Address     %s\n' "$(conf_get VERSION)" "$MODE" "$PUBLIC_URL"
    rule
    local bad=0
    if [ "$MODE" = docker ]; then
        dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null || bad=1
    else
        local s
        for s in postgresql remoteiq-backend remoteiq-frontend remoteiq-edge $([ "$TLS" = 2 ] || echo caddy); do
            [ "$s" = postgresql ] && [ "$DB_MODE" != local ] && continue
            if systemctl is-active --quiet "$s"; then ok "$s is running"; else warn "$s is not running"; bad=1; fi
        done
    fi
    rule
    local tries api=0
    for tries in 1 2 3 4 5 6 7 8; do
        if curl -fsS --max-time 5 http://127.0.0.1:3001/healthz >/dev/null 2>&1; then api=1; break; fi
        sleep 2
    done
    if [ "$api" = 1 ]; then ok "API answers"; else warn "API does not answer on 127.0.0.1:3001"; bad=1; fi
    if curl -fsS --max-time 8 -o /dev/null "http://127.0.0.1:$EDGE_PORT/login" 2>/dev/null; then ok "Web app answers"; else warn "Web app does not answer on port $EDGE_PORT"; bad=1; fi
    if curl -fsS --max-time 10 -o /dev/null "$PUBLIC_URL/login" 2>/dev/null || curl -fsSk --max-time 10 -o /dev/null "$PUBLIC_URL/login" 2>/dev/null; then ok "$PUBLIC_URL is reachable from this server"; else warn "$PUBLIC_URL is not reachable from this server (DNS, firewall, certificate or proxy)"; fi
    [ -s "$RIQ_HOME/secrets/data-encryption.key" ] && ok "Data encryption key present" || warn "Data encryption key is missing"
    printf '  Disk free on %s: %s\n' "$RIQ_HOME" "$(df -h "$RIQ_HOME" | awk 'NR==2 {print $4}')"
    [ "$WITH_LOGS" = 1 ] && support_bundle
    return "$bad"
}

support_bundle() {
    local out tarball stamp
    stamp="$(date +%Y%m%d-%H%M%S)"
    # Logs and settings go in here, so the folder and the bundle are created private and under names nobody could prepare in
    # /tmp beforehand (mktemp makes them new, 0700 and 0600).
    out="$(mktemp -d "/tmp/remoteiq-support-$stamp-XXXXXX")"
    tarball="$(umask 077; mktemp "/tmp/remoteiq-support-$stamp-XXXXXX.tar.gz" 2>/dev/null || mktemp "/tmp/remoteiq-support-$stamp-XXXXXXXX")"
    {
        echo "version: $(conf_get VERSION)"; echo "mode: $MODE"; echo "os: $(. /etc/os-release; echo "$PRETTY_NAME")"
        echo "kernel: $(uname -r)"; free -m; df -h; uname -a
    } >"$out/system.txt" 2>&1
    # Secrets are not copied: the settings file is included with its values blanked out.
    sed -E 's/^([A-Z_]*(SECRET|KEY|PASSWORD|URL)[A-Z_]*)=.*/\1=***/' "$RIQ_HOME/config/remoteiq.env" >"$out/remoteiq.env.redacted" 2>/dev/null || true
    sed -E 's/^([A-Z_]*(PASSWORD|SECRET|KEY)[A-Z_]*)=.*/\1=***/' "$CONF" >"$out/install.conf.redacted" 2>/dev/null || true
    if [ "$MODE" = docker ]; then
        dc ps >"$out/containers.txt" 2>&1 || true
        local s; for s in riq-backend riq-frontend riq-edge postgres caddy; do dc logs --no-color --tail 500 "$s" >"$out/log-$s.txt" 2>&1 || true; done
    else
        local u; for u in remoteiq-backend remoteiq-frontend remoteiq-edge postgresql caddy; do journalctl -u "$u" -n 500 --no-pager >"$out/log-$u.txt" 2>&1 || true; done
    fi
    cp "$LOG" "$out/install.log" 2>/dev/null || true
    ( umask 077; tar -czf "$tarball" -C "$(dirname "$out")" "$(basename "$out")" ); rm -rf "$out"
    chmod 600 "$tarball"
    ok "Support bundle written to $tarball (passwords and keys are blanked out)"
}

cmd_uninstall() {
    preflight; load_state
    need_tty
    title "Uninstall RemoteIQ"
    say "This stops and removes the RemoteIQ services. PostgreSQL, Docker and Caddy packages are left installed."
    ask_yn "Remove RemoteIQ from this server?" n || { say "Cancelled."; return 0; }
    local purge=0
    if [ -n "$PURGE" ]; then purge="$PURGE"
    else
        say "Your data is the database, uploaded files and the two key files in $RIQ_HOME/secrets."
        if ask_yn "Keep your data so you can reinstall later?" y; then purge=0; else purge=1; fi
    fi
    if [ "$purge" = 1 ]; then
        printf '%sThis permanently deletes the database, files and keys.%s Type the word delete to confirm: ' "$R" "$N" >"$TTY"
        local a; IFS= read -r a <"$TTY"; [ "$a" = delete ] || { say "Cancelled."; return 0; }
    fi
    if [ "$MODE" = docker ]; then
        dc down >>"$LOG" 2>&1 || true
        docker rmi $(docker images -q 'remoteiq-*' 2>/dev/null | sort -u) >>"$LOG" 2>&1 || true
    else
        systemctl disable --now remoteiq-edge remoteiq-frontend remoteiq-backend >>"$LOG" 2>&1 || true
        rm -f /etc/systemd/system/remoteiq-{backend,frontend,edge}.service; systemctl daemon-reload
        [ "$TLS" = 2 ] || { : >/etc/caddy/Caddyfile; systemctl restart caddy >>"$LOG" 2>&1 || true; }
    fi
    if [ "$purge" = 1 ]; then
        if [ "$DB_MODE" = local ] && [ "$MODE" = native ]; then
            runuser -u postgres -- psql -q -c 'DROP DATABASE IF EXISTS remoteiq;' -c 'DROP ROLE IF EXISTS remoteiq;' >>"$LOG" 2>&1 || true
        fi
        rm -rf "$RIQ_HOME"
        id remoteiq >/dev/null 2>&1 && userdel remoteiq >/dev/null 2>&1 || true
        ok "RemoteIQ and all its data were removed."
    else
        rm -rf "$RIQ_HOME/releases" "$RIQ_HOME/current"; conf_set INSTALLED 0
        ok "RemoteIQ was removed. Your data is still in $RIQ_HOME."
    fi
}

usage() { sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; }

main() {
    trap 'on_error $LINENO' ERR
    local cmd=install
    while [ $# -gt 0 ]; do
        case "$1" in
            install|upgrade|status|uninstall|reconfigure) cmd="$1" ;;
            help|-h|--help) usage; exit 0 ;;
            --mode) WANT_MODE="${2:-}"; shift ;;
            --version) WANT_VERSION="${2:-}"; shift ;;
            --no-color) USE_COLOR=0 ;;
            --logs) WITH_LOGS=1 ;;
            --force) FORCE=1 ;;
            --purge) PURGE=1 ;;
            --keep-data) PURGE=0 ;;
            *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
        esac
        shift
    done
    case "$WANT_MODE" in ''|docker|native) ;; *) echo "--mode is docker or native" >&2; exit 2 ;; esac
    setup_colors
    case "$cmd" in
        install) cmd_install ;;
        upgrade) cmd_upgrade ;;
        # A report that finds a problem exits 1 without being treated as an installer error.
        status) if cmd_status; then exit 0; else exit 1; fi ;;
        uninstall) cmd_uninstall ;;
        reconfigure) cmd_reconfigure ;;
    esac
}

main "$@"
