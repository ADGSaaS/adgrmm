// backend/src/web-monitors/web-monitors.probe.ts
//
// What the server reads from the internet for a monitor: the certificate a server shows, the registration of a domain (RDAP) and the DNS
// records of a name. The server connects to names that people typed in, so a name that points at a private network address is refused
// (unless MONITOR_ALLOW_PRIVATE=true, for monitoring a network on purpose), and the connection goes to the address that was checked, so a
// name cannot change its answer between the check and the connection.
import * as dns from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as tls from "node:tls";
import { isPrivateAddress } from "../notifications/notifications.service";
import { normalizeValue, type CertificateResult, type DnsResult, type DnsType, type DomainResult } from "./web-monitors.core";

const allowPrivate = () => (process.env.MONITOR_ALLOW_PRIVATE ?? "").toLowerCase() === "true";

/** The address to connect to: the first one the name resolves to, after every one of them was found to be public. */
export async function publicAddress(host: string): Promise<string> {
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch((e) => { throw new Error(e?.code === "ENOTFOUND" ? `The name ${host} does not exist.` : `The name ${host} could not be looked up (${e?.code ?? e?.message}).`); })).map((a) => a.address);
    if (!addresses.length) throw new Error(`The name ${host} has no address.`);
    if (!allowPrivate() && addresses.some(isPrivateAddress)) throw new Error(`${host} is on a private network address, which is not monitored from here.`);
    return addresses[0];
}

/** The certificate a server shows on a port, and whether it is trusted and made for this name. */
export async function readCertificate(host: string, port: number, timeoutMs = 10_000): Promise<CertificateResult> {
    const ip = await publicAddress(host);
    return new Promise<CertificateResult>((resolve, reject) => {
        const socket = tls.connect({ host: ip, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs });
        const fail = (msg: string) => { socket.destroy(); reject(new Error(msg)); };
        socket.once("timeout", () => fail(`${host}:${port} did not answer in ${Math.round(timeoutMs / 1000)} seconds.`));
        socket.once("error", (e: NodeJS.ErrnoException) => fail(e.code === "ECONNREFUSED" ? `${host}:${port} refused the connection.` : `Could not connect to ${host}:${port} (${e.code ?? e.message}).`));
        socket.once("secureConnect", () => {
            try {
                const c = socket.getPeerCertificate(true);
                if (!c || !c.valid_to) return fail("The server did not show a certificate.");
                const nameErr = tls.checkServerIdentity(host, c);
                const authErr = socket.authorizationError as unknown;
                const result: CertificateResult = {
                    subject: c.subject?.CN ? String(c.subject.CN) : undefined,
                    issuer: c.issuer ? String(c.issuer.O || c.issuer.CN || "") || undefined : undefined,
                    validFrom: new Date(c.valid_from).toISOString(),
                    validTo: new Date(c.valid_to).toISOString(),
                    names: String(c.subjectaltname ?? "").split(",").map((s) => s.trim().replace(/^(DNS|IP Address):/, "")).filter(Boolean).slice(0, 30),
                    protocol: socket.getProtocol() ?? undefined,
                    fingerprint: c.fingerprint256,
                    trusted: socket.authorized === true,
                    authError: authErr ? String((authErr as Error).message ?? authErr) : null,
                    nameError: nameErr ? nameErr.message : null,
                };
                socket.end();
                resolve(result);
            } catch (e) {
                fail(`Could not read the certificate: ${(e as Error).message}`);
            }
        });
    });
}

let bootstrap: { at: number; map: Map<string, string[]> } | null = null;
const UA = "RemoteIQ-monitor/1.0 (domain expiry check)";

/** The registry's own RDAP address for a name's last label, from IANA's published list (kept for a day). Empty when it cannot be found. */
async function registryBases(host: string): Promise<string[]> {
    try {
        if (!bootstrap || Date.now() - bootstrap.at > 86_400_000) {
            const r = await fetch("https://data.iana.org/rdap/dns.json", { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(10_000) });
            if (!r.ok) throw new Error(String(r.status));
            const j: any = await r.json();
            const map = new Map<string, string[]>();
            for (const svc of Array.isArray(j?.services) ? j.services : []) for (const tld of svc[0] ?? []) map.set(String(tld).toLowerCase(), (svc[1] ?? []).filter((u: unknown) => typeof u === "string" && u.startsWith("https://")));
            bootstrap = { at: Date.now(), map };
        }
        return bootstrap.map.get(host.split(".").pop()!.toLowerCase()) ?? [];
    } catch {
        return [];
    }
}

/** The registration of a domain from the registry (RDAP): the registry's own server first, then rdap.org (or only RDAP_BASE_URL when it says so). */
export async function readDomain(host: string): Promise<DomainResult> {
    const forced = process.env.RDAP_BASE_URL;
    const bases = forced ? [forced] : [...(await registryBases(host)).map((b) => `${b.replace(/\/+$/, "")}/domain/`), "https://rdap.org/domain/"];
    let res: Response | null = null;
    let last = "";
    for (const base of bases) {
        try {
            const r = await fetch(`${base}${encodeURIComponent(host)}`, { headers: { accept: "application/rdap+json, application/json", "user-agent": UA }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
            if (r.ok || r.status === 404) { res = r; break; }
            last = r.status === 403 || r.status === 429 ? `status ${r.status}, the registry is refusing or limiting requests from this server` : `status ${r.status}`;
        } catch (e) {
            last = `could not be reached (${(e as Error).message})`;
        }
    }
    if (!res) throw new Error(`The registry answered with ${last || "no answer"}. It will be tried again at the next check.`);
    if (res.status === 404) throw new Error(`The registry has no record of ${host}. Use the registered domain (such as example.com, not www.example.com). Some registries do not publish this at all.`);
    const j = (await res.json().catch(() => null)) as any;
    if (!j || typeof j !== "object") throw new Error("The registry answer could not be read.");
    const events: any[] = Array.isArray(j.events) ? j.events : [];
    const exp = events.find((e) => String(e?.eventAction).toLowerCase() === "expiration");
    const registrarEntity = (Array.isArray(j.entities) ? j.entities : []).find((e: any) => Array.isArray(e?.roles) && e.roles.includes("registrar"));
    const fn = Array.isArray(registrarEntity?.vcardArray?.[1]) ? registrarEntity.vcardArray[1].find((p: any) => p?.[0] === "fn")?.[3] : null;
    return {
        expiresAt: exp?.eventDate ? new Date(exp.eventDate).toISOString() : null,
        registrar: typeof fn === "string" ? fn.slice(0, 120) : null,
        status: Array.isArray(j.status) ? j.status.map((s: unknown) => String(s)).slice(0, 12) : [],
        nameservers: Array.isArray(j.nameservers) ? j.nameservers.map((n: any) => String(n?.ldhName ?? "").toLowerCase()).filter(Boolean).slice(0, 12) : [],
    };
}

const EMPTY = new Set(["ENODATA", "ENOTFOUND", "ENOTIMP", "NOTFOUND", "NODATA"]);

/** The records of a name, as plain text values. A type the name has none of is an empty list; a failure of the lookup itself is thrown. */
export async function readDns(host: string, types: DnsType[]): Promise<DnsResult> {
    const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
    if (process.env.MONITOR_DNS_SERVERS) resolver.setServers(process.env.MONITOR_DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean));
    const out: DnsResult = {};
    for (const t of types) {
        try {
            let values: string[];
            if (t === "A") values = await resolver.resolve4(host);
            else if (t === "AAAA") values = await resolver.resolve6(host);
            else if (t === "NS") values = await resolver.resolveNs(host);
            else if (t === "CNAME") values = await resolver.resolveCname(host);
            else if (t === "MX") values = (await resolver.resolveMx(host)).map((m) => `${m.priority} ${m.exchange}`);
            else values = (await resolver.resolveTxt(host)).map((chunks) => chunks.join(""));
            out[t] = [...new Set(values.map((v) => normalizeValue(t, v)))].sort();
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code ?? "";
            if (EMPTY.has(code)) { out[t] = []; continue; }
            throw new Error(`The ${t} records of ${host} could not be looked up (${code || (e as Error).message}).`);
        }
    }
    return out;
}
