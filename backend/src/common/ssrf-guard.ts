// backend/src/common/ssrf-guard.ts
//
// The server calls addresses people typed in (webhooks, monitors). These helpers decide whether an address is on a private,
// local or special-purpose network, and make outgoing requests that check the address the socket really connects to, so a
// name cannot answer with a public address at the check and a private one at the connection (DNS rebinding).
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

/** IPv4 ranges that are never a public internet host. [first octets as a 32-bit number, prefix length] */
const V4_BLOCKED: Array<[string, number]> = [
    ["0.0.0.0", 8],        // "this" network
    ["10.0.0.0", 8],       // private
    ["100.64.0.0", 10],    // carrier-grade NAT
    ["127.0.0.0", 8],      // loopback
    ["169.254.0.0", 16],   // link-local, cloud metadata (169.254.169.254)
    ["172.16.0.0", 12],    // private
    ["192.0.0.0", 24],     // IETF protocol assignments
    ["192.0.2.0", 24],     // TEST-NET-1
    ["192.88.99.0", 24],   // 6to4 relay anycast
    ["192.168.0.0", 16],   // private
    ["198.18.0.0", 15],    // benchmarking
    ["198.51.100.0", 24],  // TEST-NET-2
    ["203.0.113.0", 24],   // TEST-NET-3
    ["224.0.0.0", 4],      // multicast
    ["240.0.0.0", 4],      // reserved, broadcast
];

function v4ToInt(b: number[]): number {
    return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
}

const V4_BLOCKED_INT = V4_BLOCKED.map(([a, len]) => {
    const base = v4ToInt(a.split(".").map(Number));
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return { base: (base & mask) >>> 0, mask };
});

function isBlockedV4(b: number[]): boolean {
    const n = v4ToInt(b);
    return V4_BLOCKED_INT.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

function parseV4(s: string): number[] | null {
    const parts = s.split(".");
    if (parts.length !== 4) return null;
    const out: number[] = [];
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const n = Number(p);
        if (n > 255) return null;
        out.push(n);
    }
    return out;
}

/** An IPv6 address as 16 bytes, or null when it cannot be read. Accepts "::", embedded dotted IPv4 and zone ids. */
export function parseV6(input: string): number[] | null {
    let s = input.trim().toLowerCase();
    const zone = s.indexOf("%");
    if (zone >= 0) s = s.slice(0, zone);
    if (!s.includes(":")) return null;

    let tailV4: number[] = [];
    const lastColon = s.lastIndexOf(":");
    const last = s.slice(lastColon + 1);
    if (last.includes(".")) {
        const v4 = parseV4(last);
        if (!v4) return null;
        tailV4 = v4;
        s = s.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
    }

    const halves = s.split("::");
    if (halves.length > 2) return null;
    const toGroups = (h: string) => (h === "" ? [] : h.split(":"));
    const head = toGroups(halves[0]);
    const tail = halves.length === 2 ? toGroups(halves[1]) : [];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
    const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
    if (groups.length !== 8) return null;

    const bytes: number[] = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        const n = parseInt(g, 16);
        bytes.push(n >> 8, n & 0xff);
    }
    if (tailV4.length) bytes.splice(12, 4, ...tailV4);
    return bytes;
}

const startsWith = (b: number[], prefix: number[]) => prefix.every((v, i) => b[i] === v);
const allZero = (b: number[], from: number, to: number) => b.slice(from, to).every((v) => v === 0);

function isBlockedV6(b: number[]): boolean {
    // ::/96 holds ::, ::1 and the deprecated IPv4-compatible form (::a.b.c.d): judge by the embedded IPv4 (0.0.0.0/8 covers :: and ::1).
    if (allZero(b, 0, 12)) return isBlockedV4(b.slice(12));
    // ::ffff:0:0/96 IPv4-mapped
    if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedV4(b.slice(12));
    // ::ffff:0:0:0/96 IPv4-translated (SIIT)
    if (allZero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return isBlockedV4(b.slice(12));
    // 64:ff9b::/96 NAT64 well-known prefix
    if (startsWith(b, [0x00, 0x64, 0xff, 0x9b]) && allZero(b, 4, 12)) return isBlockedV4(b.slice(12));
    // 64:ff9b:1::/48 local-use NAT64: the translator is on a local network
    if (startsWith(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return true;
    // 2002::/16 6to4: the IPv4 address is in bytes 2-5
    if (b[0] === 0x20 && b[1] === 0x02) return isBlockedV4(b.slice(2, 6));
    // 2001::/32 Teredo (client IPv4 is obfuscated, so the whole range is refused)
    if (startsWith(b, [0x20, 0x01, 0x00, 0x00])) return true;
    // 2001:db8::/32 documentation, 2001:2::/48 benchmarking, 2001:10::/28 ORCHID
    if (startsWith(b, [0x20, 0x01, 0x0d, 0xb8])) return true;
    if (startsWith(b, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00])) return true;
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3] & 0xf0) === 0x10) return true;
    // 100::/64 discard-only
    if (startsWith(b, [0x01, 0x00]) && allZero(b, 2, 8)) return true;
    // fc00::/7 unique local
    if ((b[0] & 0xfe) === 0xfc) return true;
    // fe80::/10 link-local, fec0::/10 site-local (deprecated)
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;
    // ff00::/8 multicast
    if (b[0] === 0xff) return true;
    return false;
}

/**
 * True when an address must not be called from this server: private, loopback, link-local, metadata, multicast,
 * reserved or documentation ranges, including IPv4 hidden inside IPv6 (mapped, compatible, NAT64, 6to4).
 * Anything that is not a readable IP address counts as private, so a mistake fails closed.
 */
export function isPrivateAddress(ip: string): boolean {
    const s = String(ip ?? "").trim().replace(/^\[|\]$/g, "");
    const kind = isIP(s.split("%")[0]);
    if (kind === 4) {
        const v4 = parseV4(s);
        return v4 ? isBlockedV4(v4) : true;
    }
    if (kind === 6) {
        const v6 = parseV6(s);
        return v6 ? isBlockedV6(v6) : true;
    }
    return true;
}

/** The ranges that are private but belong to an ordinary local network (RFC 1918, carrier-grade NAT, unique local IPv6). */
const V4_LAN: Array<[string, number]> = [["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16]];
const V4_LAN_INT = V4_LAN.map(([a, len]) => {
    const mask = (0xffffffff << (32 - len)) >>> 0;
    return { base: (v4ToInt(a.split(".").map(Number)) & mask) >>> 0, mask };
});

/**
 * True for an address on an ordinary local network: 10/8, 172.16/12, 192.168/16, 100.64/10 and fc00::/7 (also when written as
 * IPv4-mapped IPv6). Loopback, link-local and cloud-metadata (169.254.x.x), multicast and reserved ranges are not LAN addresses.
 */
export function isLanAddress(ip: string): boolean {
    const s = String(ip ?? "").trim().replace(/^\[|\]$/g, "").split("%")[0];
    const kind = isIP(s);
    let v4: number[] | null = null;
    if (kind === 4) v4 = parseV4(s);
    else if (kind === 6) {
        const b = parseV6(s);
        if (!b) return false;
        if ((b[0] & 0xfe) === 0xfc) return true;
        if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) v4 = b.slice(12);
    }
    if (!v4) return false;
    const n = v4ToInt(v4);
    return V4_LAN_INT.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * A dns.lookup replacement for http(s).request / net.connect: it resolves the name and refuses to hand back any address
 * when one of them is private, so the address that is connected to is always one that was checked.
 */
export function guardedLookup(hostname: string, options: any, callback?: LookupCallback): void {
    return lookupChecked(hostname, options, callback, false);
}

/** guardedLookup, but names that resolve to an ordinary local network address (see isLanAddress) are let through. */
export function guardedLookupAllowLan(hostname: string, options: any, callback?: LookupCallback): void {
    return lookupChecked(hostname, options, callback, true);
}

function lookupChecked(hostname: string, options: any, callback: LookupCallback | undefined, allowLan: boolean): void {
    const cb: LookupCallback = typeof options === "function" ? options : callback!;
    const opts: dns.LookupOptions = typeof options === "object" && options ? options : typeof options === "number" ? { family: options } : {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) return cb(err);
        const list = (addresses as unknown as dns.LookupAddress[]) ?? [];
        if (!list.length) return cb(Object.assign(new Error(`${hostname} has no address.`), { code: "ENOTFOUND" }));
        const bad = list.find((a) => isPrivateAddress(a.address) && !(allowLan && isLanAddress(a.address)));
        if (bad) return cb(Object.assign(new Error(`${hostname} resolves to a private network address, which is refused.`), { code: "EPRIVATEADDRESS" }));
        if (opts.all) return cb(null, list);
        cb(null, list[0].address, list[0].family);
    });
}

export type SafePostResponse = { status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> };

/**
 * POST a body to a URL the way fetch(url, { redirect: "error" }) would, but through guardedLookup so the connection only
 * ever goes to a checked public address. A redirect is not followed (it comes back as a non-ok status).
 * With allowPrivate the address check is skipped (for receivers on the same private network, opted into deliberately).
 */
export function safePost(rawUrl: string, init: { headers: Record<string, string>; body: string; timeoutMs: number; allowPrivate?: boolean; maxResponseBytes?: number }): Promise<SafePostResponse> {
    return safeRequest("POST", rawUrl, init);
}

/**
 * GET an address with the same protections (no redirect is followed, the connection only goes to a checked address, bounded time
 * and size). With allowLan, ordinary local-network addresses are accepted too, for a name that is meant to resolve inside this
 * network; loopback, link-local and metadata addresses stay refused.
 */
export function safeGet(rawUrl: string, init: { headers?: Record<string, string>; timeoutMs: number; allowLan?: boolean; maxResponseBytes?: number }): Promise<SafePostResponse & { json(): Promise<unknown> }> {
    return safeRequest("GET", rawUrl, { headers: init.headers ?? {}, timeoutMs: init.timeoutMs, allowLan: init.allowLan, maxResponseBytes: init.maxResponseBytes ?? 256 * 1024 }) as any;
}

function safeRequest(method: "GET" | "POST", rawUrl: string, init: { headers: Record<string, string>; body?: string; timeoutMs: number; allowPrivate?: boolean; allowLan?: boolean; maxResponseBytes?: number }): Promise<SafePostResponse & { json(): Promise<unknown> }> {
    const url = new URL(rawUrl);
    const mod = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!mod) return Promise.reject(new Error("Only http and https addresses can be called."));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!init.allowPrivate && isIP(host) && isPrivateAddress(host) && !(init.allowLan && isLanAddress(host))) return Promise.reject(new Error("That address is on a private network."));
    const limit = init.maxResponseBytes ?? 64 * 1024;

    const body = init.body;
    return new Promise<SafePostResponse & { json(): Promise<unknown> }>((resolve, reject) => {
        const req = mod.request(url, {
            method,
            headers: body === undefined ? init.headers : { ...init.headers, "Content-Length": String(new TextEncoder().encode(body).byteLength) },
            signal: AbortSignal.timeout(init.timeoutMs),
            ...(init.allowPrivate ? {} : { lookup: (init.allowLan ? guardedLookupAllowLan : guardedLookup) as any }),
        }, (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer) => { if (size < limit) { chunks.push(c); size += c.length; } });
            res.on("error", reject);
            res.on("end", () => {
                const status = res.statusCode ?? 0;
                const text = Buffer.concat(chunks).subarray(0, limit).toString("utf8");
                resolve({
                    status,
                    ok: status >= 200 && status < 300,
                    headers: { get: (name: string) => { const v = res.headers[name.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(", ") : String(v); } },
                    text: async () => text,
                    json: async () => JSON.parse(text),
                });
            });
        });
        req.on("error", reject);
        req.end(body);
    });
}
