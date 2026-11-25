// Network discovery: what a managed device (the "scanner") can see on its own network, found by a fixed signed script job.
//   - Windows runs PowerShell, Linux runs bash; a macOS variant is another script with the same output lines, so nothing else changes.
//   - The script takes only RIQ_RANGES (private IPv4 ranges, comma separated; empty means the subnets of the scanner's own cards,
//     never wider than a /24 each). The ranges are checked here AND in the script: private addresses only, at most 1024 per range.
//   - It does a ping sweep, reads the neighbour (ARP) table for MAC addresses and for hosts that did not answer a ping, asks the
//     name server for names, and tries a short FIXED list of TCP ports on the hosts that answered. It sends no payload, never logs in,
//     never reads a banner and never touches an address outside the ranges.
//   - Output, one fact per line:  "R <cidr>"  a range that was scanned;  "H <ip> <mac|-> <name|-> <ports|-> "  a host;  "E <seconds>"  the end.
//     What a device printed is never trusted: parseDiscovery checks every field against a strict shape.
// Neither script contains a dollar-brace sequence, a backtick or a double curly brace (they live in template literals, and the server
// fills double curly braces in for a device).

import { BadRequestException } from "@nestjs/common";
import { ToolOutputError } from "../device-tools/device-tools.scripts";

export const DISCOVERY_KIND = "network.discovery";
/** The TCP ports tried on a host that answered. Fixed: what a person sees is what these say about the host. */
export const DISCOVERY_PORTS = [22, 23, 53, 80, 135, 139, 161, 443, 445, 515, 554, 631, 3389, 5900, 8080, 9100];
export const DISCOVERY_MAX_HOSTS = 2048;
export const DISCOVERY_TIMEOUT_SEC = 300;

/* ------------------------------ ranges ------------------------------ */

const ipToInt = (ip: string): number => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** RFC 1918 (10/8, 172.16/12, 192.168/16): the only addresses a scan may touch. */
export function isPrivateV4(ip: string): boolean {
    if (!IPV4.test(ip)) return false;
    const n = ipToInt(ip);
    return (n >= ipToInt("10.0.0.0") && n <= ipToInt("10.255.255.255")) || (n >= ipToInt("172.16.0.0") && n <= ipToInt("172.31.255.255")) || (n >= ipToInt("192.168.0.0") && n <= ipToInt("192.168.255.255"));
}

/** A range as "a.b.c.d/nn" with the host bits cleared, or a plain-words refusal. At most 4 ranges of 1024 addresses (/22), private only. */
export function checkRanges(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
    const out: string[] = [];
    for (const r of list.map((x) => String(x).trim()).filter(Boolean)) {
        const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(r);
        if (!m || !IPV4.test(m[1])) throw new BadRequestException(`"${r.slice(0, 40)}" is not a range like 192.168.1.0/24.`);
        const prefix = Number(m[2]);
        if (prefix < 22 || prefix > 32) throw new BadRequestException(`${r}: a range must be between /22 (1024 addresses) and /32 (one address).`);
        if (!isPrivateV4(m[1])) throw new BadRequestException(`${r}: only private ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x) are scanned.`);
        const size = 2 ** (32 - prefix);
        const base = Math.floor(ipToInt(m[1]) / size) * size;
        if (!isPrivateV4(intToIp(base)) || !isPrivateV4(intToIp(base + size - 1))) throw new BadRequestException(`${r} reaches outside the private ranges.`);
        const cidr = `${intToIp(base)}/${prefix}`;
        if (!out.includes(cidr)) out.push(cidr);
    }
    if (out.length > 4) throw new BadRequestException("Scan 4 ranges at most at a time.");
    return out;
}

/* ------------------------------ the scripts ------------------------------ */

export const LINUX_DISCOVERY_SCRIPT = String.raw`#!/bin/bash
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
T0=$(date +%s)
BUDGET=240
PORTS="22 23 53 80 135 139 161 443 445 515 554 631 3389 5900 8080 9100"
W=$(mktemp -d 2>/dev/null) || { echo "No place to work." >&2; exit 1; }
trap 'rm -rf "$W"' EXIT
have() { command -v "$1" >/dev/null 2>&1; }
ip2int() { local IFS=.; set -- $1; echo $(( ($1<<24) + ($2<<16) + ($3<<8) + $4 )); }
int2ip() { echo "$(( ($1>>24)&255 )).$(( ($1>>16)&255 )).$(( ($1>>8)&255 )).$(( $1&255 ))"; }
private() { case "$1" in 10.*|192.168.*) return 0;; 172.*) local s; s=$(echo "$1" | cut -d. -f2); [ "$s" -ge 16 ] && [ "$s" -le 31 ] && return 0;; esac; return 1; }
over() { [ $(( $(date +%s) - T0 )) -gt $BUDGET ]; }

# ---- the ranges: given, or the subnets of this machine's own cards (a /24 at most each, no virtual bridges)
RANGES=$(printf '%s' "$RIQ_RANGES" | tr ',' ' ' | tr -cd '0-9./ ')
if [ -z "$RANGES" ] && have ip; then
  RANGES=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $2, $4}' | grep -Ev '^(docker|br-|veth|virbr|cni|flannel|cali|vxlan|lxcbr|lxdbr|tun|tap|kube|cilium|weave|wg|tailscale|zt|ppp|gre|sit|ipip)' | while read -r IFACE CIDR; do
    A=$(echo "$CIDR" | cut -d/ -f1); P=$(echo "$CIDR" | cut -d/ -f2)
    private "$A" || continue
    [ "$P" -lt 24 ] && P=24
    [ "$P" -gt 32 ] && continue
    SZ=$(( 1 << (32-P) )); B=$(( $(ip2int "$A") / SZ * SZ ))
    echo "$(int2ip $B)/$P"
  done | sort -u | head -4 | tr '\n' ' ')
fi
[ -n "$RANGES" ] || { echo "This device has no private network address to scan from." >&2; exit 2; }

# ---- every address of every range
: > "$W/all"
for R in $RANGES; do
  A=$(echo "$R" | cut -d/ -f1); P=$(echo "$R" | cut -d/ -f2)
  case "$P" in ''|*[!0-9]*) continue;; esac
  [ "$P" -ge 22 ] && [ "$P" -le 32 ] || continue
  private "$A" || continue
  SZ=$(( 1 << (32-P) )); B=$(( $(ip2int "$A") / SZ * SZ ))
  private "$(int2ip $B)" && private "$(int2ip $(( B + SZ - 1 )))" || continue
  echo "R $(int2ip $B)/$P"
  S=0; E=$SZ
  [ "$P" -le 30 ] && { S=1; E=$(( SZ - 1 )); }
  I=$S; while [ "$I" -lt "$E" ]; do int2ip $(( B + I )) >> "$W/all"; I=$(( I + 1 )); done
done
[ -s "$W/all" ] || { echo "No address to scan." >&2; exit 2; }

# ---- who is there: a ping sweep, then what the neighbour table learned
if have ping; then
  xargs -P 64 -I{} sh -c 'ping -c1 -W1 "$1" >/dev/null 2>&1 && echo "$1"' _ {} < "$W/all" > "$W/alive" 2>/dev/null
fi
: > "$W/arp"
if [ -r /proc/net/arp ]; then awk 'NR>1 && $3=="0x2" && $4!="00:00:00:00:00:00" {print $1, toupper($4)}' /proc/net/arp > "$W/arp"; fi
awk '{print $1}' "$W/arp" | grep -x -F -f "$W/all" >> "$W/alive" 2>/dev/null
sort -u "$W/alive" -o "$W/alive" 2>/dev/null
# the scanner itself is not one of the hosts it found
if have ip; then ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 > "$W/own"; grep -vxF -f "$W/own" "$W/alive" > "$W/alive2" 2>/dev/null; mv "$W/alive2" "$W/alive"; fi
[ -s "$W/alive" ] || { echo "E $(( $(date +%s) - T0 ))"; exit 0; }

# ---- names a DNS server does not know: ask the host itself. NetBIOS (UDP 137, Windows, many NAS boxes and printers) and mDNS (UDP 5353,
# Apple, Linux with Avahi, many printers and cameras). Both are one read-only question ("what is your name?"), no login, nothing is changed.
NBPORT=137; MDNSPORT=5353
[ -n "$RIQ_NB_PORT" ] && NBPORT=$(printf '%s' "$RIQ_NB_PORT" | tr -cd '0-9')
[ -n "$RIQ_MDNS_PORT" ] && MDNSPORT=$(printf '%s' "$RIQ_MDNS_PORT" | tr -cd '0-9')
A30=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
udpask() {
  ( exec 4<>"/dev/udp/$1/$2" 2>/dev/null || exit 0; cat >&4; timeout 1 dd bs=1500 count=1 <&4 2>/dev/null | od -An -tx1 -v ) 2>/dev/null
}
nbquery() { printf '\x13\x37\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x20CK%s\x00\x00\x21\x00\x01' "$A30" | udpask "$1" "$NBPORT"; }
lab() { printf "\\$(printf '%03o' "$(printf '%s' "$1" | wc -c | tr -d ' ')")%s" "$1"; }
mdnsquery() {
  IFS=. read -r qa qb qc qd <<EOF
$1
EOF
  # the whole question is put together first and sent in ONE write: sent piece by piece it would leave as several packets
  { printf '\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00'; lab "$qd"; lab "$qc"; lab "$qb"; lab "$qa"; lab in-addr; lab arpa; printf '\x00\x00\x0c\x00\x01'; } > "$W/mq.$1"
  udpask "$1" "$MDNSPORT" < "$W/mq.$1"
}
# a hex dump of a reply on stdin; prints the first usable name, or nothing
AWKLIB='function hv(s) { return (index("0123456789abcdef", substr(s,1,1)) - 1) * 16 + (index("0123456789abcdef", substr(s,2,1)) - 1) }
  function skipname(p) { while (p <= n) { l = b[p]; if (l == 0) return p + 1; if (l >= 192) return p + 2; p += l + 1 } return n + 1 }
  { for (k = 1; k <= NF; k++) { n++; b[n] = hv($k) } }'
nbparse() {
  awk "$AWKLIB"'
  END {
    if (n < 57) exit
    qd = b[5] * 256 + b[6]; p = 13
    for (i = 0; i < qd; i++) p = skipname(p) + 4
    p = skipname(p) + 10
    c = b[p]; p++
    for (i = 0; i < c && p + 17 <= n; i++) {
      nm = ""; for (j = 0; j < 15; j++) { ch = b[p + j]; if (ch >= 33 && ch <= 126) nm = nm sprintf("%c", ch) }
      if (b[p + 15] == 0 && b[p + 16] < 128 && nm ~ /^[A-Za-z0-9._-]+$/) { print substr(nm, 1, 15); exit }
      p += 18
    }
  }'
}
mdnsparse() {
  awk "$AWKLIB"'
  function rdname(p,   out, hops, l, sv, j) { out = ""; hops = 0; while (p <= n && hops < 20) { l = b[p]; if (l == 0) break; if (l >= 192) { p = (l - 192) * 256 + b[p + 1] + 1; hops++; continue } sv = ""; for (j = 1; j <= l; j++) sv = sv sprintf("%c", b[p + j]); out = (out == "" ? sv : out "." sv); p += l + 1 } return out }
  END {
    if (n < 20) exit
    qd = b[5] * 256 + b[6]; an = b[7] * 256 + b[8]; p = 13
    for (i = 0; i < qd; i++) p = skipname(p) + 4
    for (i = 0; i < an && p <= n; i++) {
      p = skipname(p); ty = b[p] * 256 + b[p + 1]; len = b[p + 8] * 256 + b[p + 9]; p += 10
      if (ty == 12) { nm = rdname(p); gsub(/[^A-Za-z0-9._-]/, "", nm); if (nm != "") { print substr(nm, 1, 63); exit } }
      p += len
    }
  }'
}

# ---- what each one is: a name, a MAC, and which of the fixed ports are open
probe() {
  IP=$1
  MAC=$(awk -v ip="$IP" '$1==ip {print $2; exit}' "$W/arp"); [ -n "$MAC" ] || MAC="-"
  NAME="-"; SRC="-"
  if [ "$RIQ_NO_DNS" != "1" ]; then
    NAME=$(timeout 2 getent hosts "$IP" 2>/dev/null | awk '{print $2; exit}' | tr -cd 'A-Za-z0-9._-' | cut -c1-63); [ -n "$NAME" ] || NAME="-"
  fi
  [ "$NAME" != "-" ] && SRC=dns
  if [ "$NAME" = "-" ]; then N=$(nbquery "$IP" | nbparse | tr -cd 'A-Za-z0-9._-'); [ -n "$N" ] && NAME=$N && SRC=nbns; fi
  if [ "$NAME" = "-" ]; then N=$(mdnsquery "$IP" | mdnsparse | tr -cd 'A-Za-z0-9._-' | cut -c1-63); [ -n "$N" ] && NAME=$N && SRC=mdns; fi
  OPEN=""
  for P in $PORTS; do
    if timeout 1 bash -c "echo > /dev/tcp/$IP/$P" >/dev/null 2>&1; then OPEN="$OPEN,$P"; fi
  done
  OPEN=$(printf '%s' "$OPEN" | sed 's/^,//'); [ -n "$OPEN" ] || OPEN="-"
  echo "H $IP $MAC $NAME $OPEN $SRC" > "$W/h.$IP"
}
export -f probe udpask nbquery lab mdnsquery nbparse mdnsparse
export W PORTS NBPORT MDNSPORT A30 AWKLIB RIQ_NO_DNS
xargs -P 24 -I{} bash -c 'probe "$1"' _ {} < "$W/alive"
cat "$W"/h.* 2>/dev/null
echo "E $(( $(date +%s) - T0 ))"
`;

export const WINDOWS_DISCOVERY_SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$sw = [Diagnostics.Stopwatch]::StartNew()
$ports = 22,23,53,80,135,139,161,443,445,515,554,631,3389,5900,8080,9100
function ToInt([string]$ip) { $b = ([Net.IPAddress]::Parse($ip)).GetAddressBytes(); [uint64]($b[0] * 16777216 + $b[1] * 65536 + $b[2] * 256 + $b[3]) }
function ToIp([uint64]$n) { '{0}.{1}.{2}.{3}' -f [math]::Floor($n / 16777216), ([math]::Floor($n / 65536) % 256), ([math]::Floor($n / 256) % 256), ($n % 256) }
function IsPrivate([string]$ip) { $n = ToInt $ip; ($n -ge (ToInt '10.0.0.0') -and $n -le (ToInt '10.255.255.255')) -or ($n -ge (ToInt '172.16.0.0') -and $n -le (ToInt '172.31.255.255')) -or ($n -ge (ToInt '192.168.0.0') -and $n -le (ToInt '192.168.255.255')) }

# ---- the ranges: given, or the subnets of this machine's own cards (a /24 at most each, no virtual switches)
# VPN adapters (TAP, Wintun, WireGuard, ...) answer for whole subnets, so they are not scanned unless asked for by range
$vpnWords = 'TAP-Windows|Wintun|WireGuard|OpenVPN|Tailscale|ZeroTier|VPN|AnyConnect|Fortinet|GlobalProtect|PANGP|Juniper|SonicWall|Teredo|ISATAP'
$vpnIf = @(Get-NetAdapter | Where-Object { $_.InterfaceDescription -match $vpnWords -or $_.Name -match $vpnWords } | ForEach-Object { $_.ifIndex })
$ranges = @()
$given = [string]$env:RIQ_RANGES
if ($given.Trim()) { $ranges = @($given -split '[,\s]+' | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$' }) }
else {
  $ranges = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|Hyper-V|Loopback|Docker|WSL|Bluetooth' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '127.*' -and ($vpnIf -notcontains $_.InterfaceIndex) -and (IsPrivate $_.IPAddress) } | ForEach-Object {
    $p = [int]$_.PrefixLength; if ($p -lt 24) { $p = 24 }
    if ($p -le 32) { $sz = [math]::Pow(2, 32 - $p); $base = [math]::Floor((ToInt $_.IPAddress) / $sz) * $sz; '{0}/{1}' -f (ToIp $base), $p }
  } | Sort-Object -Unique | Select-Object -First 4)
}
if ($ranges.Count -eq 0) { [Console]::Error.WriteLine('This device has no private network address to scan from.'); exit 2 }

# ---- every address of every range
$all = New-Object System.Collections.Generic.List[string]
foreach ($r in $ranges) {
  $a, $pl = $r -split '/'; $p = [int]$pl
  if ($p -lt 22 -or $p -gt 32) { continue }
  if (-not (IsPrivate $a)) { continue }
  $sz = [math]::Pow(2, 32 - $p); $base = [math]::Floor((ToInt $a) / $sz) * $sz
  if (-not (IsPrivate (ToIp $base)) -or -not (IsPrivate (ToIp ($base + $sz - 1)))) { continue }
  Write-Output ('R {0}/{1}' -f (ToIp $base), $p)
  $s = 0; $e = $sz; if ($p -le 30) { $s = 1; $e = $sz - 1 }
  for ($i = $s; $i -lt $e; $i++) { $all.Add((ToIp ($base + $i))) }
}
if ($all.Count -eq 0) { [Console]::Error.WriteLine('No address to scan.'); exit 2 }

# ---- who is there: a ping sweep in batches, then what the neighbour table learned
$alive = New-Object 'System.Collections.Generic.HashSet[string]'
for ($i = 0; $i -lt $all.Count -and $sw.Elapsed.TotalSeconds -lt 120; $i += 128) {
  $batch = $all.GetRange($i, [math]::Min(128, $all.Count - $i))
  $pings = @(); $tasks = @()
  foreach ($ip in $batch) { $pg = New-Object Net.NetworkInformation.Ping; $pings += $pg; $tasks += ,@($ip, $pg.SendPingAsync($ip, 800)) }
  [void][Threading.Tasks.Task]::WaitAll(@($tasks | ForEach-Object { $_[1] }), 6000)
  foreach ($t in $tasks) { if ($t[1].Status -eq 'RanToCompletion' -and $t[1].Result.Status -eq 'Success') { [void]$alive.Add($t[0]) } }
  foreach ($pg in $pings) { $pg.Dispose() }
}
$mac = @{}
Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.State -in 'Reachable', 'Stale', 'Delay', 'Probe', 'Permanent' -and $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00' -and $_.LinkLayerAddress -ne 'FF-FF-FF-FF-FF-FF' } | ForEach-Object {
  $mac[$_.IPAddress] = ($_.LinkLayerAddress -replace '-', ':').ToUpper()
  if ($all.Contains($_.IPAddress)) { [void]$alive.Add($_.IPAddress) }
}

# the scanner itself is not one of the hosts it found
if ($env:RIQ_INCLUDE_SELF -ne '1') { foreach ($o in @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $_.IPAddress })) { [void]$alive.Remove($o) } }

# ---- names a DNS server does not know: ask the host itself. NetBIOS (UDP 137, Windows, many NAS boxes and printers) and mDNS (UDP 5353,
# Apple, Linux with Avahi, many printers and cameras). Both are one read-only question ("what is your name?"), no login, nothing is changed.
$nbPort = 137; if ($env:RIQ_NB_PORT -match '^\d{1,5}$') { $nbPort = [int]$env:RIQ_NB_PORT }
$mdnsPort = 5353; if ($env:RIQ_MDNS_PORT -match '^\d{1,5}$') { $mdnsPort = [int]$env:RIQ_MDNS_PORT }
function SkipName([byte[]]$d, [int]$p) { while ($p -lt $d.Length) { $l = $d[$p]; if ($l -eq 0) { return $p + 1 }; if (($l -band 0xC0) -eq 0xC0) { return $p + 2 }; $p += $l + 1 }; return $d.Length }
function ReadName([byte[]]$d, [int]$p) {
  $parts = @(); $hops = 0
  while ($p -lt $d.Length -and $hops -lt 20) {
    $l = $d[$p]; if ($l -eq 0) { break }
    if (($l -band 0xC0) -eq 0xC0) { $p = (($l -band 0x3F) * 256) + $d[$p + 1]; $hops++; continue }
    if ($p + 1 + $l -gt $d.Length) { break }
    $parts += [Text.Encoding]::ASCII.GetString($d, $p + 1, $l); $p += $l + 1
  }
  $parts -join '.'
}
function NbQuery([string]$ip) {
  $q = New-Object System.Collections.Generic.List[byte]
  $q.AddRange([byte[]](0x13, 0x37, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x20)); $q.AddRange([Text.Encoding]::ASCII.GetBytes('CK' + ('A' * 30))); $q.AddRange([byte[]](0, 0, 0x21, 0, 1))
  , $q.ToArray()
}
function MdnsQuery([string]$ip) {
  $o = $ip.Split('.'); $q = New-Object System.Collections.Generic.List[byte]
  $q.AddRange([byte[]](0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0))
  foreach ($x in @($o[3], $o[2], $o[1], $o[0], 'in-addr', 'arpa')) { $b = [Text.Encoding]::ASCII.GetBytes([string]$x); $q.Add([byte]$b.Length); $q.AddRange($b) }
  $q.AddRange([byte[]](0, 0, 12, 0, 1))
  , $q.ToArray()
}
function NbParse([byte[]]$d) {
  if ($d.Length -lt 57) { return $null }
  $p = 12; $qd = ($d[4] * 256) + $d[5]
  for ($i = 0; $i -lt $qd; $i++) { $p = (SkipName $d $p) + 4 }
  $p = (SkipName $d $p) + 10
  if ($p -ge $d.Length) { return $null }
  $count = $d[$p]; $p++
  for ($i = 0; $i -lt $count -and ($p + 18) -le $d.Length; $i++) {
    $n = ([Text.Encoding]::ASCII.GetString($d, $p, 15)) -replace '[^\x21-\x7e]', ''
    if ($d[$p + 15] -eq 0 -and $d[$p + 16] -lt 128 -and $n -match '^[A-Za-z0-9._-]{1,15}$') { return $n }
    $p += 18
  }
  return $null
}
function MdnsParse([byte[]]$d) {
  if ($d.Length -lt 20) { return $null }
  $qd = ($d[4] * 256) + $d[5]; $an = ($d[6] * 256) + $d[7]; $p = 12
  for ($i = 0; $i -lt $qd; $i++) { $p = (SkipName $d $p) + 4 }
  for ($i = 0; $i -lt $an -and ($p + 10) -le $d.Length; $i++) {
    $p = SkipName $d $p
    $type = ($d[$p] * 256) + $d[$p + 1]; $len = ($d[$p + 8] * 256) + $d[$p + 9]; $p += 10
    if ($type -eq 12) { $n = (ReadName $d $p) -replace '[^A-Za-z0-9._-]', ''; if ($n) { return $n.Substring(0, [math]::Min(63, $n.Length)) } }
    $p += $len
  }
  return $null
}
# one question to many hosts at once; what came back within the time, by address
function UdpAskMany([string[]]$ips, [int]$port, [scriptblock]$make, [int]$ms) {
  $res = @{}
  for ($s = 0; $s -lt $ips.Count; $s += 100) {
    $jobs = @()
    foreach ($ip in @($ips[$s..([math]::Min($s + 99, $ips.Count - 1))])) {
      $u = New-Object Net.Sockets.UdpClient
      try { $u.Connect($ip, $port); $pkt = [byte[]](& $make $ip); [void]$u.Send($pkt, $pkt.Length); $jobs += ,@($ip, $u, $u.ReceiveAsync()) } catch { $u.Close() }
    }
    try { [void][Threading.Tasks.Task]::WaitAll(@($jobs | ForEach-Object { $_[2] }), $ms) } catch { }
    foreach ($j in $jobs) { if ($j[2].Status -eq 'RanToCompletion') { $res[$j[0]] = $j[2].Result.Buffer }; $j[1].Close() }
  }
  $res
}

# ---- what each one is: a name, a MAC, and which of the fixed ports are open
$rows = @()
foreach ($ip in @($alive | Sort-Object { ToInt $_ })) {
  if ($sw.Elapsed.TotalSeconds -gt 200) { break }
  $name = '-'; $src = '-'
  if ($env:RIQ_NO_DNS -ne '1') {
    try {
      $dns = [Net.Dns]::GetHostEntryAsync($ip)
      if ($dns.Wait(1500) -and $dns.Status -eq 'RanToCompletion') { $n = ([string]$dns.Result.HostName) -replace '[^A-Za-z0-9._-]', ''; if ($n -and $n -ne $ip) { $name = $n.Substring(0, [math]::Min(63, $n.Length)); $src = 'dns' } }
    } catch { }
  }
  $clients = @(); $conns = @()
  foreach ($p in $ports) { $c = New-Object Net.Sockets.TcpClient; $clients += $c; $conns += ,@($p, $c.ConnectAsync($ip, $p)) }
  [void][Threading.Tasks.Task]::WaitAll(@($conns | ForEach-Object { $_[1] }), 1500)
  $open = @(); $k = 0
  foreach ($c in $conns) { if ($c[1].Status -eq 'RanToCompletion' -and $clients[$k].Connected) { $open += $c[0] }; $k++ }
  foreach ($cl in $clients) { $cl.Close() }
  $m = if ($mac.ContainsKey($ip)) { $mac[$ip] } else { '-' }
  $o = if ($open.Count) { $open -join ',' } else { '-' }
  $rows += [pscustomobject]@{ ip = $ip; mac = $m; name = $name; src = $src; ports = $o }
}
# the hosts DNS did not name: NetBIOS first, then mDNS, each asked of all of them at once
$todo = @($rows | Where-Object { $_.name -eq '-' } | ForEach-Object { $_.ip })
if ($todo.Count -and $sw.Elapsed.TotalSeconds -lt 215) {
  $got = UdpAskMany $todo $nbPort { param($i) NbQuery $i } 1000
  foreach ($r in $rows) { if ($r.name -eq '-' -and $got.ContainsKey($r.ip)) { $n = NbParse $got[$r.ip]; if ($n) { $r.name = $n; $r.src = 'nbns' } } }
}
$todo = @($rows | Where-Object { $_.name -eq '-' } | ForEach-Object { $_.ip })
if ($todo.Count -and $sw.Elapsed.TotalSeconds -lt 225) {
  $got = UdpAskMany $todo $mdnsPort { param($i) MdnsQuery $i } 1000
  foreach ($r in $rows) { if ($r.name -eq '-' -and $got.ContainsKey($r.ip)) { $n = MdnsParse $got[$r.ip]; if ($n) { $r.name = $n; $r.src = 'mdns' } } }
}
foreach ($r in $rows) { Write-Output ('H {0} {1} {2} {3} {4}' -f $r.ip, $r.mac, $r.name, $r.ports, $r.src) }
Write-Output ('E {0}' -f [int]$sw.Elapsed.TotalSeconds)
`;

/* ------------------------------ what a device printed ------------------------------ */

/** Where a host's name came from: the DNS server, a NetBIOS reply, an mDNS (Bonjour) reply. */
export type NameSource = "dns" | "nbns" | "mdns";
export const NAME_SOURCE_TEXT: Record<NameSource, string> = { dns: "DNS", nbns: "NetBIOS", mdns: "mDNS (Bonjour)" };
export type DiscoveredHost = { ip: string; mac: string | null; hostname: string | null; ports: number[]; nameSource: NameSource | null };
export type DiscoveryScan = { ranges: string[]; hosts: DiscoveredHost[]; seconds: number | null };

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

export function parseDiscovery(stdout: string, stderr: string): DiscoveryScan {
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const end = lines.find((l) => /^E \d{1,6}$/.test(l));
    if (!end) throw new ToolOutputError(stderr.trim().slice(0, 300) || "The device's answer was not a network scan.");
    const ranges: string[] = [];
    const hosts = new Map<string, DiscoveredHost>();
    for (const l of lines) {
        if (l.startsWith("R ")) {
            try { for (const r of checkRanges(l.slice(2))) if (!ranges.includes(r)) ranges.push(r); } catch { /* an odd range line is ignored */ }
            continue;
        }
        const m = /^H (\S+) (\S+) (\S+) (\S+)(?: (\S+))?$/.exec(l);
        if (!m || hosts.size >= DISCOVERY_MAX_HOSTS || !isPrivateV4(m[1]) || hosts.has(m[1])) continue;
        const mac = MAC.test(m[2].toUpperCase()) && !/^(00:00:00:00:00:00|FF:FF:FF:FF:FF:FF)$/i.test(m[2]) ? m[2].toUpperCase() : null;
        const name = /^[A-Za-z0-9._-]{1,63}$/.test(m[3]) && m[3] !== "-" && m[3] !== m[1] ? m[3] : null;
        const ports = m[4] === "-" ? [] : [...new Set(m[4].split(",").map(Number))].filter((p) => DISCOVERY_PORTS.includes(p)).sort((a, b) => a - b);
        // the source is only meaningful next to a name; an older script sends none
        const nameSource: NameSource | null = name && (m[5] === "dns" || m[5] === "nbns" || m[5] === "mdns") ? (m[5] as NameSource) : null;
        hosts.set(m[1], { ip: m[1], mac, hostname: name, ports, nameSource });
    }
    return { ranges, hosts: [...hosts.values()].sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip)), seconds: Number(end.slice(2)) };
}

/* ------------------------------ what a host probably is ------------------------------ */

/** A few vendors by MAC prefix: enough to name virtual machines, common network gear and single board computers. Not a full registry. */
const OUI: Array<[string, string]> = [
    ["00:50:56", "VMware"], ["00:0C:29", "VMware"], ["00:05:69", "VMware"], ["00:15:5D", "Microsoft Hyper-V"], ["08:00:27", "VirtualBox"],
    ["52:54:00", "QEMU/KVM"], ["02:42:", "Docker"], ["B8:27:EB", "Raspberry Pi"], ["DC:A6:32", "Raspberry Pi"], ["E4:5F:01", "Raspberry Pi"],
    ["28:CD:C1", "Raspberry Pi"], ["00:11:32", "Synology"], ["FC:EC:DA", "Ubiquiti"], ["24:5A:4C", "Ubiquiti"], ["78:8A:20", "Ubiquiti"],
    ["44:D9:E7", "Ubiquiti"], ["74:83:C2", "Ubiquiti"], ["80:2A:A8", "Ubiquiti"],
];
export function vendorOf(mac: string | null): string | null {
    if (!mac) return null;
    const m = mac.toUpperCase();
    return OUI.find(([p]) => m.startsWith(p))?.[1] ?? null;
}

export type HostKind = "printer" | "camera" | "windows" | "linux" | "network" | "nas" | "virtual" | "web" | "unknown";
export const HOST_KIND_TEXT: Record<HostKind, string> = {
    printer: "Printer", camera: "Camera or recorder", windows: "Windows computer", linux: "Linux or Unix computer", network: "Network device",
    nas: "Storage", virtual: "Virtual machine", web: "Device with a web page", unknown: "Unknown",
};

/** A guess from the open ports and the vendor, shown as a guess. */
export function classifyHost(ports: number[], vendor: string | null): HostKind {
    const has = (...p: number[]) => p.some((x) => ports.includes(x));
    if (has(9100, 515, 631)) return "printer";
    if (has(554)) return "camera";
    if (vendor === "Synology") return "nas";
    if (vendor === "Ubiquiti") return "network";
    if (has(3389) || (has(135) && has(445)) || (has(139) && has(445))) return "windows";
    if (vendor === "Raspberry Pi") return "linux";
    if (has(22) && !has(80, 443, 8080)) return "linux";
    if (has(161) || (has(23) && !has(22))) return "network";
    if (vendor === "VMware" || vendor === "Microsoft Hyper-V" || vendor === "VirtualBox" || vendor === "QEMU/KVM") return "virtual";
    if (has(22)) return "linux";
    if (has(80, 443, 8080)) return "web";
    return "unknown";
}
