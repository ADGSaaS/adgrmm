// SNMP monitoring: what a printer, switch or other network device says about itself, read by a managed device on the same network
// (the "poller") through a fixed signed script job. SNMP version 1/2c with a community string, read only: the scripts only ever send GET
// and GETNEXT/walk requests for a short FIXED list of standard objects (system, IF-MIB, Printer-MIB, Host-Resources printer status), never
// a SET.
//   - Linux uses the standard net-snmp tools (snmpget, snmpwalk) and says which package to install when they are missing.
//   - Windows has no SNMP client in PowerShell, so the script carries a small SNMPv2c GET/GETNEXT client in C# (Add-Type).
//   - Targets reach the script through RIQ_SNMP_TARGETS: space separated "ip,port,community", checked on the server and in the script
//     (private IPv4 address, port 1-65535, community of letters, digits and . _ ~ @ # % ^ * + = - only).
//   - Output, one fact per line:  "T <ip> ok" or "T <ip> fail <reason>";  "S <ip> descr|name|location|uptime <value>" (uptime in 1/100 s);
//     "SUP <ip> <index> <level> <max> <description>" a printer supply;  "PR <ip> status|errors|pages <value>";
//     "IF <ip> <index> <oper> <speed> <inOctets> <outOctets> <name>";  "E <seconds>".
//     What a device printed is never trusted: parseSnmp checks every field against a strict shape.
// The scripts contain no dollar-brace sequence, no backtick (in bash) and no double curly brace (the server fills those in for a device).

import { BadRequestException } from "@nestjs/common";
import { ToolOutputError } from "../device-tools/device-tools.scripts";
import { isPrivateV4 } from "../network-discovery/discovery.scripts";

export const SNMP_KIND = "snmp.poll";
export const SNMP_TIMEOUT_SEC = 240;
export const SNMP_MAX_TARGETS = 20;
export const SNMP_MAX_INTERFACES = 64;
export const SNMP_MAX_SUPPLIES = 16;
const COMMUNITY = /^[A-Za-z0-9._~@#%^*+=-]{1,64}$/;

export type SnmpTarget = { ip: string; port: number; community: string };

/** The targets as the script takes them, or a plain-words refusal. */
export function checkTargets(targets: SnmpTarget[]): string {
    if (!targets.length) throw new BadRequestException("Nothing to poll.");
    if (targets.length > SNMP_MAX_TARGETS) throw new BadRequestException(`Poll ${SNMP_MAX_TARGETS} devices at most at a time.`);
    return targets.map((t) => {
        if (!isPrivateV4(t.ip)) throw new BadRequestException(`${String(t.ip).slice(0, 40)} is not a private address (10.x.x.x, 172.16-31.x.x, 192.168.x.x).`);
        if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new BadRequestException("The port must be 1 to 65535.");
        if (!COMMUNITY.test(t.community)) throw new BadRequestException("The community string may use letters, digits and . _ ~ @ # % ^ * + = - only, up to 64 characters.");
        return `${t.ip},${t.port},${t.community}`;
    }).join(" ");
}
export const isValidCommunity = (c: string) => COMMUNITY.test(c);

/* ------------------------------ the scripts ------------------------------ */

export const LINUX_SNMP_SCRIPT = String.raw`#!/bin/bash
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
T0=$(date +%s)
set -f
command -v snmpget >/dev/null 2>&1 && command -v snmpwalk >/dev/null 2>&1 || { echo "The SNMP tools are missing on this device. Install the snmp package (Debian, Ubuntu) or net-snmp-utils (Fedora, Rocky, RHEL, SUSE) from the Software tab." >&2; exit 69; }
W=$(mktemp -d 2>/dev/null) || { echo "No place to work." >&2; exit 1; }
trap 'rm -rf "$W"' EXIT
export W

# one value out of "oid value" lines: the first line, without the oid, without the quotes, no control characters
val() { head -1 | sed -e 's/^[^ ]* //' -e 's/^"//' -e 's/"$//' | tr -d '\000-\037\177' | cut -c1-200; }
nosuch() { grep -q 'No Such\|No more variables\|Timeout\|Error'; }

poll() {
  IP=$(echo "$1" | cut -d, -f1); PORT=$(echo "$1" | cut -d, -f2); C=$(echo "$1" | cut -d, -f3-)
  printf '%s' "$IP" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9.]+$' || exit 0
  printf '%s' "$C" | grep -Eq '^[A-Za-z0-9._~@#%^*+=-]{1,64}$' || exit 0
  H="$IP:$PORT"
  OUT="$W/t.$IP"
  O="-v2c -t2 -r1 -On -Oq -Oe -Ot"
  SYS=$(timeout 10 snmpget $O -c "$C" "$H" 1.3.6.1.2.1.1.1.0 1.3.6.1.2.1.1.3.0 1.3.6.1.2.1.1.5.0 1.3.6.1.2.1.1.6.0 2>&1)
  if [ -z "$SYS" ] || ! printf '%s\n' "$SYS" | grep -q '^\.1\.3\.6\.1\.2\.1\.1\.1\.0 '; then
    echo "T $IP fail No answer: wrong address, community or SNMP is switched off" > "$OUT"; exit 0
  fi
  {
    echo "T $IP ok"
    printf '%s\n' "$SYS" | grep '^\.1\.3\.6\.1\.2\.1\.1\.1\.0 ' | val | sed "s/^/S $IP descr /"
    printf '%s\n' "$SYS" | grep '^\.1\.3\.6\.1\.2\.1\.1\.3\.0 ' | val | sed "s/^/S $IP uptime /"
    printf '%s\n' "$SYS" | grep '^\.1\.3\.6\.1\.2\.1\.1\.5\.0 ' | val | sed "s/^/S $IP name /"
    printf '%s\n' "$SYS" | grep '^\.1\.3\.6\.1\.2\.1\.1\.6\.0 ' | val | sed "s/^/S $IP location /"
    # a printer: its supplies (Printer-MIB), status, error bits and page count
    timeout 20 snmpwalk $O -c "$C" "$H" 1.3.6.1.2.1.43.11.1.1.9.1 2>/dev/null | grep -v 'No Such\|No more' | head -16 | while read -r OID LEVEL; do
      IDX=$(echo "$OID" | sed 's/.*\.//')
      DESC=$(timeout 5 snmpget $O -c "$C" "$H" 1.3.6.1.2.1.43.11.1.1.6.1.$IDX 2>/dev/null | grep -v 'No Such' | val)
      MAX=$(timeout 5 snmpget $O -c "$C" "$H" 1.3.6.1.2.1.43.11.1.1.8.1.$IDX 2>/dev/null | grep -v 'No Such' | val)
      echo "SUP $IP $IDX $LEVEL $MAX $DESC"
    done
    PS=$(timeout 5 snmpget $O -c "$C" "$H" 1.3.6.1.2.1.25.3.5.1.1.1 2>/dev/null | grep -v 'No Such' | val); [ -n "$PS" ] && echo "PR $IP status $PS"
    PE=$(timeout 5 snmpget $O -Ox -c "$C" "$H" 1.3.6.1.2.1.25.3.5.1.2.1 2>/dev/null | grep -v 'No Such' | val | tr -d ' '); [ -n "$PE" ] && echo "PR $IP errors $PE"
    PG=$(timeout 5 snmpget $O -c "$C" "$H" 1.3.6.1.2.1.43.10.2.1.4.1.1 2>/dev/null | grep -v 'No Such' | val); [ -n "$PG" ] && echo "PR $IP pages $PG"
    # interfaces (IF-MIB): name, operational status, speed, octet counters, joined by index
    col() { timeout 20 snmpwalk $O -c "$C" "$H" "$1" 2>/dev/null | grep -v 'No Such\|No more' | head -64 | awk '{i=$1; sub(/.*\./,"",i); $1=""; v=substr($0,2); gsub(/^"|"$/,"",v); print i "\t" v}'; }
    col 1.3.6.1.2.1.2.2.1.2 > "$W/n.$IP"
    if [ -s "$W/n.$IP" ]; then
      col 1.3.6.1.2.1.2.2.1.8 > "$W/o.$IP"; col 1.3.6.1.2.1.2.2.1.5 > "$W/s.$IP"; col 1.3.6.1.2.1.2.2.1.10 > "$W/i.$IP"; col 1.3.6.1.2.1.2.2.1.16 > "$W/x.$IP"
      awk -F'\t' -v ip="$IP" -v f1="$W/n.$IP" -v f2="$W/o.$IP" -v f3="$W/s.$IP" -v f4="$W/i.$IP" -v f5="$W/x.$IP" '
        FILENAME==f1 {nm[$1]=$2; ord[++n]=$1; next}
        FILENAME==f2 {op[$1]=$2; next}
        FILENAME==f3 {sp[$1]=$2; next}
        FILENAME==f4 {ii[$1]=$2; next}
        FILENAME==f5 {oo[$1]=$2; next}
        END {for (j=1;j<=n;j++) {k=ord[j]; gsub(/[^A-Za-z0-9._\/:# -]/,"",nm[k]); printf "IF %s %s %.0f %.0f %.0f %.0f %s\n", ip, k, op[k], sp[k], ii[k], oo[k], nm[k]}}' "$W/n.$IP" "$W/o.$IP" "$W/s.$IP" "$W/i.$IP" "$W/x.$IP"
    fi
  } > "$OUT" 2>/dev/null
}
export -f poll val nosuch

printf '%s\n' $RIQ_SNMP_TARGETS | head -20 | xargs -P 8 -I{} bash -c 'set -f; poll "$1"' _ {}
set +f
cat "$W"/t.* 2>/dev/null
echo "E $(( $(date +%s) - T0 ))"
`;

/** The Windows script: a small SNMPv2c client (GET and GETNEXT) compiled with Add-Type, then the same questions as the Linux script. */
export const WINDOWS_SNMP_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$sw = [Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
public class RiqSnmpResult { public string Oid; public string Text; public string Hex; public bool Missing; }
public static class RiqSnmp {
  static void Len(List<byte> b, int n) { if (n < 128) b.Add((byte)n); else if (n < 256) { b.Add(0x81); b.Add((byte)n); } else { b.Add(0x82); b.Add((byte)(n >> 8)); b.Add((byte)(n & 255)); } }
  static List<byte> Tlv(byte t, List<byte> v) { var r = new List<byte>(); r.Add(t); Len(r, v.Count); r.AddRange(v); return r; }
  static List<byte> Int(int n) { var v = new List<byte>(); if (n == 0) v.Add(0); else { while (n > 0) { v.Insert(0, (byte)(n & 255)); n >>= 8; } if ((v[0] & 0x80) != 0) v.Insert(0, 0); } return Tlv(0x02, v); }
  static List<byte> Oid(string oid) {
    var p = oid.Trim('.').Split('.'); var v = new List<byte>(); v.Add((byte)(40 * int.Parse(p[0]) + int.Parse(p[1])));
    for (int i = 2; i < p.Length; i++) { long n = long.Parse(p[i]); var t = new List<byte>(); t.Insert(0, (byte)(n & 0x7f)); n >>= 7; while (n > 0) { t.Insert(0, (byte)((n & 0x7f) | 0x80)); n >>= 7; } v.AddRange(t); }
    return Tlv(0x06, v);
  }
  static int ReadLen(byte[] d, ref int p) { int l = d[p++]; if (l < 128) return l; int n = l & 0x7f; l = 0; for (int i = 0; i < n; i++) l = (l << 8) | d[p++]; return l; }
  static string OidText(byte[] d, int p, int len) {
    var sb = new StringBuilder(); sb.Append(d[p] / 40).Append('.').Append(d[p] % 40); long n = 0;
    for (int i = p + 1; i < p + len; i++) { n = (n << 7) + (d[i] & 0x7f); if ((d[i] & 0x80) == 0) { sb.Append('.').Append(n); n = 0; } }
    return sb.ToString();
  }
  // pdu: 0xA0 GET, 0xA1 GETNEXT. Returns null when nothing answered in time.
  public static RiqSnmpResult Query(string host, int port, string community, byte pdu, string oid, int timeoutMs) {
    var vb = Tlv(0x30, Tlv(0x30, Oid(oid).Concat2(new List<byte> { 0x05, 0x00 })));
    var body = Int(new Random().Next(1, 2000000000)); body.AddRange(Int(0)); body.AddRange(Int(0)); body.AddRange(vb);
    var msg = Int(1); msg.AddRange(Tlv(0x04, new List<byte>(Encoding.ASCII.GetBytes(community)))); msg.AddRange(Tlv(pdu, body));
    var pkt = Tlv(0x30, msg).ToArray();
    using (var u = new UdpClient()) {
      u.Client.ReceiveTimeout = timeoutMs; u.Connect(host, port); u.Send(pkt, pkt.Length);
      IPEndPoint any = null; byte[] d;
      try { d = u.Receive(ref any); } catch (SocketException) { return null; }
      try {
        int p = 0; if (d[p++] != 0x30) return null; ReadLen(d, ref p);
        p++; int l = ReadLen(d, ref p); p += l;                 // version
        p++; l = ReadLen(d, ref p); p += l;                     // community
        if (d[p++] != 0xA2) return null; ReadLen(d, ref p);     // response
        p++; l = ReadLen(d, ref p); p += l;                     // request id
        p++; l = ReadLen(d, ref p); int err = 0; for (int i = 0; i < l; i++) err = (err << 8) | d[p + i]; p += l;   // error status
        p++; l = ReadLen(d, ref p); p += l;                     // error index
        if (err != 0) return null;
        p++; ReadLen(d, ref p); p++; ReadLen(d, ref p);         // varbind list, first varbind
        p++; l = ReadLen(d, ref p); var r = new RiqSnmpResult(); r.Oid = OidText(d, p, l); p += l;
        byte tag = d[p++]; l = ReadLen(d, ref p);
        if (tag == 0x80 || tag == 0x81 || tag == 0x82 || tag == 0x05) { r.Missing = true; return r; }
        if (tag == 0x02) { long n = (d[p] & 0x80) != 0 ? -1 : 0; for (int i = 0; i < l; i++) n = (n << 8) | d[p + i]; r.Text = n.ToString(); }
        else if (tag == 0x41 || tag == 0x42 || tag == 0x43 || tag == 0x46) { ulong n = 0; for (int i = 0; i < l; i++) n = (n << 8) | d[p + i]; r.Text = n.ToString(); }
        else if (tag == 0x06) r.Text = OidText(d, p, l);
        else if (tag == 0x40 && l == 4) r.Text = d[p] + "." + d[p + 1] + "." + d[p + 2] + "." + d[p + 3];
        else {
          var sb = new StringBuilder(); var hx = new StringBuilder(); bool print = true;
          for (int i = 0; i < l; i++) { byte c = d[p + i]; hx.Append(c.ToString("X2")); if (c < 32 || c > 126) print = false; sb.Append((char)c); }
          r.Hex = hx.ToString(); r.Text = print ? sb.ToString() : hx.ToString();
        }
        return r;
      } catch (Exception) { return null; }
    }
  }
  static List<byte> Concat2(this List<byte> a, List<byte> b) { var r = new List<byte>(a); r.AddRange(b); return r; }
}
'@ -ErrorAction Stop
function Get1([string]$h, [int]$port, [string]$c, [string]$oid) { $r = [RiqSnmp]::Query($h, $port, $c, 0xA0, $oid, 2000); if ($r -and -not $r.Missing) { $r } else { $null } }
function Walk([string]$h, [int]$port, [string]$c, [string]$prefix, [int]$max) {
  $out = @(); $cur = $prefix
  for ($i = 0; $i -lt $max; $i++) {
    $r = [RiqSnmp]::Query($h, $port, $c, 0xA1, $cur, 2000)
    if (-not $r -or $r.Missing -or -not $r.Oid.StartsWith($prefix + '.')) { break }
    $out += ,$r; $cur = $r.Oid
  }
  $out
}
function N($x) { if ($x) { [int64]$x } else { [int64]0 } }
function Clean([string]$s, [int]$n) { $t = ($s -replace '[\x00-\x1f\x7f]', '').Trim(); if ($t.Length -gt $n) { $t.Substring(0, $n) } else { $t } }
function IsPrivate([string]$ip) { $o = $ip.Split('.'); if ($o.Count -ne 4) { return $false }; ([int]$o[0] -eq 10) -or ([int]$o[0] -eq 192 -and [int]$o[1] -eq 168) -or ([int]$o[0] -eq 172 -and [int]$o[1] -ge 16 -and [int]$o[1] -le 31) }
foreach ($t in @(([string]$env:RIQ_SNMP_TARGETS) -split '\s+' | Where-Object { $_ } | Select-Object -First 20)) {
  $p = $t.Split(',', 3)
  if ($p.Count -ne 3 -or -not (IsPrivate $p[0]) -or $p[1] -notmatch '^\d{1,5}$' -or $p[2] -notmatch '^[A-Za-z0-9._~@#%^*+=-]{1,64}$') { continue }
  $ip = $p[0]; $port = [int]$p[1]; $c = $p[2]
  $descr = Get1 $ip $port $c '1.3.6.1.2.1.1.1.0'
  if (-not $descr) { Write-Output ('T {0} fail No answer: wrong address, community or SNMP is switched off' -f $ip); continue }
  Write-Output ('T {0} ok' -f $ip)
  Write-Output ('S {0} descr {1}' -f $ip, (Clean $descr.Text 200))
  $up = Get1 $ip $port $c '1.3.6.1.2.1.1.3.0'; if ($up) { Write-Output ('S {0} uptime {1}' -f $ip, $up.Text) }
  $nm = Get1 $ip $port $c '1.3.6.1.2.1.1.5.0'; if ($nm) { Write-Output ('S {0} name {1}' -f $ip, (Clean $nm.Text 200)) }
  $lc = Get1 $ip $port $c '1.3.6.1.2.1.1.6.0'; if ($lc) { Write-Output ('S {0} location {1}' -f $ip, (Clean $lc.Text 200)) }
  foreach ($s in (Walk $ip $port $c '1.3.6.1.2.1.43.11.1.1.9.1' 16)) {
    $idx = $s.Oid.Split('.')[-1]
    $d = Get1 $ip $port $c ('1.3.6.1.2.1.43.11.1.1.6.1.' + $idx); $m = Get1 $ip $port $c ('1.3.6.1.2.1.43.11.1.1.8.1.' + $idx)
    Write-Output ('SUP {0} {1} {2} {3} {4}' -f $ip, $idx, $s.Text, $(if ($m) { $m.Text } else { '' }), $(if ($d) { Clean $d.Text 200 } else { '' }))
  }
  $ps = Get1 $ip $port $c '1.3.6.1.2.1.25.3.5.1.1.1'; if ($ps) { Write-Output ('PR {0} status {1}' -f $ip, $ps.Text) }
  $pe = Get1 $ip $port $c '1.3.6.1.2.1.25.3.5.1.2.1'; if ($pe) { $hex = if ($pe.Hex) { $pe.Hex } else { (($pe.Text.ToCharArray() | ForEach-Object { '{0:X2}' -f [int]$_ }) -join '') }; Write-Output ('PR {0} errors {1}' -f $ip, $hex) }
  $pg = Get1 $ip $port $c '1.3.6.1.2.1.43.10.2.1.4.1.1'; if ($pg) { Write-Output ('PR {0} pages {1}' -f $ip, $pg.Text) }
  $names = @(Walk $ip $port $c '1.3.6.1.2.1.2.2.1.2' 64)
  if ($names.Count) {
    $col = @{}; foreach ($k in '8', '5', '10', '16') { $h = @{}; foreach ($r in (Walk $ip $port $c ('1.3.6.1.2.1.2.2.1.' + $k) 64)) { $h[$r.Oid.Split('.')[-1]] = $r.Text }; $col[$k] = $h }
    foreach ($n in $names) {
      $i = $n.Oid.Split('.')[-1]; $nameText = (Clean $n.Text 60) -replace '[^A-Za-z0-9._/:# -]', ''
      Write-Output ('IF {0} {1} {2} {3} {4} {5} {6}' -f $ip, $i, (N $col['8'][$i]), (N $col['5'][$i]), (N $col['10'][$i]), (N $col['16'][$i]), $nameText)
    }
  }
}
Write-Output ('E {0}' -f [int]$sw.Elapsed.TotalSeconds)
`;

/* ------------------------------ what a device printed ------------------------------ */

export type SnmpSupply = { index: number; level: number; max: number | null; description: string };
export type SnmpInterface = { index: number; name: string; oper: number; speed: number; inOctets: number; outOctets: number };
export type SnmpResult = {
    ip: string; ok: boolean; message: string | null;
    descr: string | null; name: string | null; location: string | null; uptimeSeconds: number | null;
    supplies: SnmpSupply[]; printer: { status: number | null; errors: string | null; pages: number | null } | null; interfaces: SnmpInterface[];
};

const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const int = (s: string | undefined, min = -1e12, max = 1e15): number | null => (s !== undefined && /^-?\d{1,16}$/.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : null);

/** `expected` is the set of addresses that were asked about: anything else a device prints is dropped. */
export function parseSnmp(stdout: string, stderr: string, expected: string[]): { results: SnmpResult[]; seconds: number | null } {
    const lines = stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    const end = lines.find((l) => /^E \d{1,6}$/.test(l));
    if (!end) throw new ToolOutputError(stderr.trim().slice(0, 300) || "The device's answer was not an SNMP poll.");
    const by = new Map<string, SnmpResult>();
    const get = (ip: string) => (expected.includes(ip) ? by.get(ip) : undefined);
    for (const l of lines) {
        let m = /^T (\S+) (ok|fail)(?: (.*))?$/.exec(l);
        if (m) {
            if (!expected.includes(m[1]) || by.has(m[1])) continue;
            by.set(m[1], { ip: m[1], ok: m[2] === "ok", message: m[2] === "fail" ? clean(m[3] ?? "", 200) || "No answer." : null, descr: null, name: null, location: null, uptimeSeconds: null, supplies: [], printer: null, interfaces: [] });
            continue;
        }
        m = /^S (\S+) (descr|name|location|uptime) (.*)$/.exec(l);
        if (m) {
            const r = get(m[1]); if (!r) continue;
            if (m[2] === "uptime") { const cs = int(m[3].trim(), 0); r.uptimeSeconds = cs === null ? null : Math.floor(cs / 100); } else (r as any)[m[2]] = clean(m[3], 200) || null;
            continue;
        }
        m = /^SUP (\S+) (\d{1,4}) (-?\d{1,10}) (\d{0,10}) ?(.*)$/.exec(l);
        if (m) {
            const r = get(m[1]); if (!r || r.supplies.length >= SNMP_MAX_SUPPLIES) continue;
            r.supplies.push({ index: Number(m[2]), level: Number(m[3]), max: m[4] ? Number(m[4]) : null, description: clean(m[5], 120) });
            continue;
        }
        m = /^PR (\S+) (status|errors|pages) (\S+)$/.exec(l);
        if (m) {
            const r = get(m[1]); if (!r) continue;
            r.printer ??= { status: null, errors: null, pages: null };
            if (m[2] === "errors") r.printer.errors = /^[0-9A-Fa-f]{0,16}$/.test(m[3]) ? m[3].toUpperCase() : null;
            else r.printer[m[2] as "status" | "pages"] = int(m[3], 0);
            continue;
        }
        m = /^IF (\S+) (\d{1,6}) (-?\d{1,3}) (\d{1,12}) (\d{1,16}) (\d{1,16}) ?(.*)$/.exec(l);
        if (m) {
            const r = get(m[1]); if (!r || r.interfaces.length >= SNMP_MAX_INTERFACES) continue;
            r.interfaces.push({ index: Number(m[2]), name: clean(m[7], 60) || `Port ${m[2]}`, oper: Number(m[3]), speed: Number(m[4]), inOctets: Number(m[5]), outOctets: Number(m[6]) });
        }
    }
    // an address that was asked about and never answered either way is a failure too
    for (const ip of expected) if (!by.has(ip)) by.set(ip, { ip, ok: false, message: "The poller did not report this device.", descr: null, name: null, location: null, uptimeSeconds: null, supplies: [], printer: null, interfaces: [] });
    return { results: [...by.values()], seconds: Number(end.slice(2)) };
}

/* ------------------------------ what it means ------------------------------ */

/** Percent left of a supply, or null when the printer does not say (levels -1 other, -2 unknown, -3 "some left"). */
export function supplyPercent(s: SnmpSupply): number | null {
    if (s.level < 0 || !s.max || s.max <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((s.level * 100) / s.max)));
}

export const PRINTER_STATUS_TEXT: Record<number, string> = { 1: "Other", 2: "Unknown", 3: "Idle", 4: "Printing", 5: "Warming up" };

/** hrPrinterDetectedErrorState: first byte (low paper, no paper, low toner, no toner, door open, jammed, offline, service requested), second byte. */
const ERROR_BITS: Array<[number, number, string, "WARN" | "CRIT"]> = [
    [0, 0x40, "Out of paper", "CRIT"], [0, 0x80, "Paper is low", "WARN"], [0, 0x10, "Out of toner", "CRIT"], [0, 0x20, "Toner is low", "WARN"],
    [0, 0x08, "A door or cover is open", "WARN"], [0, 0x04, "Paper jam", "CRIT"], [0, 0x02, "The printer is offline", "WARN"], [0, 0x01, "Service is requested", "WARN"],
    [1, 0x80, "An input tray is missing", "WARN"], [1, 0x20, "A supply is missing", "WARN"], [1, 0x08, "The output tray is full", "WARN"], [1, 0x04, "An input tray is empty", "WARN"],
];
export function printerErrors(hex: string | null): Array<{ text: string; severity: "WARN" | "CRIT" }> {
    if (!hex || hex.length < 2) return [];
    const bytes = hex.match(/.{1,2}/g)!.map((h) => parseInt(h, 16));
    return ERROR_BITS.filter(([i, mask]) => ((bytes[i] ?? 0) & mask) !== 0).map(([, , text, severity]) => ({ text, severity }));
}

export type SnmpKind = "printer" | "switch" | "other";
/** Supplies mean a printer; several ports mean a switch or router; otherwise it is a device that answers SNMP. */
export function guessKind(r: Pick<SnmpResult, "supplies" | "printer" | "interfaces">): SnmpKind {
    if (r.supplies.length || (r.printer && (r.printer.status !== null || r.printer.pages !== null))) return "printer";
    if (r.interfaces.filter((i) => i.name !== "lo").length >= 4) return "switch";
    return "other";
}
