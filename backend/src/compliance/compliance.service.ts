// backend/src/compliance/compliance.service.ts
//
// A security posture check computed from what this system really holds: settings, users, backups and what the
// agents report about each device. It is a health check, not a certification. It makes no claim about SOC 2,
// HIPAA, ISO 27001 or any other framework, and an item it cannot determine says so instead of passing.
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { retentionDays } from "../audit/audit.service";
import { avVerdict, encryptionVerdict, firewallOff, parseDeviceHealth } from "../reports/device-data";
import { PrismaService } from "../storage/prisma.service";

export type Status = "pass" | "warn" | "fail" | "info";
export type ComplianceItem = {
    key: string;
    title: string;
    status: Status;
    detail: string;
    link?: { label: string; href: string };
};
export type ComplianceSection = { key: string; title: string; items: ComplianceItem[] };

const DAY = 86_400_000;
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Windows releases that no longer get security updates from Microsoft, by name. Windows 10 reached its end on
 * 14 October 2025 (a paid extended program exists, which this check cannot see). Newer releases are not judged by
 * build number here, so nothing newer is ever reported as unsupported by mistake.
 */
export function unsupportedWindows(name: string | null | undefined): string | null {
    const n = String(name ?? "");
    if (!/windows/i.test(n)) return null;
    const server = n.match(/server\s*(2000|2003|2008|2012)(\s*r2)?/i);
    if (server) return `Windows Server ${server[1]}${server[2] ? " R2" : ""}`;
    const client = /server/i.test(n) ? null : n.match(/windows\s*(xp|vista|7|8\.1|8|10)(?!\d)/i);
    if (client) return `Windows ${/^xp$/i.test(client[1]) ? "XP" : client[1][0].toUpperCase() + client[1].slice(1)}`;
    return null;
}

@Injectable()
export class ComplianceService {
    constructor(private readonly prisma: PrismaService) { }

    async report(orgId: string, env: NodeJS.ProcessEnv = process.env) {
        const sections: ComplianceSection[] = [
            { key: "access", title: "Access and sign-in", items: await this.access(orgId, env) },
            { key: "data", title: "Data protection", items: await this.data(orgId, env) },
            { key: "server", title: "Server settings", items: this.server(env) },
            { key: "devices", title: "Devices", items: await this.devices() },
        ];
        const all = sections.flatMap((s) => s.items);
        return {
            generatedAt: new Date().toISOString(),
            notice: "This is a check of settings and device data that ADG RMM holds. It is not an audit or certification, and it does not measure compliance with SOC 2, HIPAA, ISO 27001 or any other framework.",
            summary: { pass: all.filter((i) => i.status === "pass").length, warn: all.filter((i) => i.status === "warn").length, fail: all.filter((i) => i.status === "fail").length, info: all.filter((i) => i.status === "info").length },
            sections,
        };
    }

    /* ------------------------------ access ------------------------------ */

    private async access(orgId: string, env: NodeJS.ProcessEnv): Promise<ComplianceItem[]> {
        const items: ComplianceItem[] = [];
        const staff = await this.prisma.users.findMany({
            where: { organization_id: orgId, status: "active" },
            select: { id: true, last_seen_at: true, created_at: true, user_security: { select: { two_factor_enabled: true } }, user_roles_user_roles_user_idTousers: { select: { roles: { select: { name: true } } } } },
        });
        const usersLink = { label: "Open Users", href: "/administration?tab=users" };

        const with2fa = staff.filter((u) => u.user_security?.two_factor_enabled).length;
        if (!staff.length) items.push({ key: "mfa_adoption", title: "Two-factor sign-in among staff", status: "info", detail: "There are no active staff accounts.", link: usersLink });
        else {
            const share = pct(with2fa, staff.length);
            items.push({
                key: "mfa_adoption",
                title: "Two-factor sign-in among staff",
                status: with2fa === staff.length ? "pass" : share >= 75 ? "warn" : "fail",
                detail: `${with2fa} of ${plural(staff.length, "active account")} (${share}%) use two-factor sign-in. Pass is everyone, a warning is 75% or more.`,
                link: usersLink,
            });
        }

        const owners = staff.filter((u) => u.user_roles_user_roles_user_idTousers.some((r) => r.roles.name.trim().toLowerCase() === "owner"));
        const ownersWithout = owners.filter((u) => !u.user_security?.two_factor_enabled).length;
        items.push(
            owners.length
                ? { key: "owner_mfa", title: "Two-factor sign-in for Owners", status: ownersWithout ? "fail" : "pass", detail: ownersWithout ? `${plural(ownersWithout, "Owner")} of ${owners.length} ${ownersWithout === 1 ? "has" : "have"} no two-factor sign-in. Owners can do everything.` : `All ${plural(owners.length, "Owner")} use two-factor sign-in.`, link: usersLink }
                : { key: "owner_mfa", title: "Two-factor sign-in for Owners", status: "info", detail: "No active account has the Owner role.", link: usersLink },
        );

        const min = parseInt(env.PASSWORD_MIN_LEN || "8", 10) || 8;
        items.push({
            key: "password_length",
            title: "Minimum password length",
            status: min >= 12 ? "pass" : min >= 8 ? "warn" : "fail",
            detail: `Passwords must be at least ${min} characters (PASSWORD_MIN_LEN). Pass is 12 or more, a warning is 8 to 11. This is the only password rule the system enforces.`,
            link: { label: "See server settings", href: "/administration?tab=secrets" },
        });

        const sso = await this.prisma.sso_config.findUnique({ where: { organization_id: orgId } });
        items.push(
            sso?.enabled
                ? { key: "sso", title: "Single sign-on", status: "pass", detail: sso.password_login ? "Single sign-on is on, and passwords still work alongside it." : "Single sign-on is on, and passwords are turned off except for Owners.", link: { label: "Open SSO", href: "/administration?tab=sso" } }
                : { key: "sso", title: "Single sign-on", status: "info", detail: sso ? "Single sign-on is set up but switched off." : "Single sign-on is not set up. It is optional.", link: { label: "Open SSO", href: "/administration?tab=sso" } },
        );

        const cutoff = Date.now() - 90 * DAY;
        const idle = staff.filter((u) => (u.last_seen_at ? u.last_seen_at.getTime() : u.created_at.getTime()) < cutoff).length;
        items.push({ key: "idle_accounts", title: "Accounts not used for 90 days", status: idle ? "warn" : "pass", detail: idle ? `${plural(idle, "active account")} ${idle === 1 ? "has" : "have"} not signed in for 90 days. Suspend accounts nobody needs.` : "Every active account has been used in the last 90 days.", link: usersLink });
        return items;
    }

    /* ------------------------------ data ------------------------------ */

    private async data(orgId: string, env: NodeJS.ProcessEnv): Promise<ComplianceItem[]> {
        const items: ComplianceItem[] = [];
        const link = { label: "Open Backups", href: "/administration?tab=backups" };

        const [cfg, policies, last] = await Promise.all([
            this.prisma.backups_config.findFirst(),
            this.prisma.backup_policies.count({ where: { organization_id: orgId } }),
            this.prisma.backup_jobs.findFirst({ where: { status: "completed" }, orderBy: { started_at: "desc" }, select: { started_at: true, finished_at: true } }),
        ]);
        const configured = !!cfg?.enabled || policies > 0;
        const lastAt = last ? (last.finished_at ?? last.started_at) : null;
        const ageDays = lastAt ? (Date.now() - lastAt.getTime()) / DAY : null;
        if (!configured) items.push({ key: "backups", title: "Backups", status: "fail", detail: "Backups are not turned on and no backup policy exists.", link });
        else if (ageDays === null) items.push({ key: "backups", title: "Backups", status: "fail", detail: "Backups are set up but none has ever completed.", link });
        else items.push({ key: "backups", title: "Backups", status: ageDays <= 2 ? "pass" : ageDays <= 7 ? "warn" : "fail", detail: `The last completed backup was ${ageDays < 1 ? "today" : `${Math.floor(ageDays)} days ago`}. Pass is within 2 days, a warning is within 7.`, link });
        if (cfg?.enabled) items.push({ key: "backup_encryption", title: "Backup encryption", status: cfg.encrypt ? "pass" : "warn", detail: cfg.encrypt ? "Backup archives are encrypted." : "Backup archives are not encrypted.", link });

        const keyFile = (env.DATA_ENCRYPTION_KEY_FILE ?? "").trim();
        const keyOk = !!(env.DATA_ENCRYPTION_KEY ?? "").trim() || !!keyFile;
        items.push({
            key: "data_key",
            title: "Key for stored secrets",
            status: keyOk ? "pass" : "fail",
            detail: keyOk ? "A data encryption key is configured, so mail passwords and storage keys are encrypted in the database. Keep a copy of it somewhere safe." : "No data encryption key is configured, so secrets cannot be stored safely.",
            link: { label: "See server settings", href: "/administration?tab=secrets" },
        });
        items.push({ key: "jwt_secret", title: "Sign-in signing key", status: (env.JWT_SECRET ?? "").length >= 32 ? "pass" : (env.JWT_SECRET ?? "") ? "warn" : "fail", detail: (env.JWT_SECRET ?? "").length >= 32 ? "A sign-in signing key of a good length is set." : (env.JWT_SECRET ?? "") ? "The sign-in signing key is set but shorter than 32 characters." : "No sign-in signing key is set.", link: { label: "See server settings", href: "/administration?tab=secrets" } });

        const days = retentionDays(env.AUDIT_RETENTION_DAYS);
        items.push({ key: "audit_retention", title: "Audit log retention", status: days >= 365 ? "pass" : days >= 90 ? "warn" : "fail", detail: `The audit log is kept for ${days} days${env.AUDIT_RETENTION_DAYS ? "" : " (the default)"}. Pass is a year or more, a warning is 90 days or more.`, link: { label: "Open Audit Logs", href: "/administration?tab=audit" } });
        return items;
    }

    /* ------------------------------ server ------------------------------ */

    private server(env: NodeJS.ProcessEnv): ComplianceItem[] {
        const link = { label: "See server settings", href: "/administration?tab=secrets" };
        const prod = (env.NODE_ENV ?? "").toLowerCase() === "production";
        const items: ComplianceItem[] = [
            { key: "production_mode", title: "Production mode", status: prod ? "pass" : "warn", detail: prod ? "The server runs in production mode." : `NODE_ENV is ${env.NODE_ENV ? `"${env.NODE_ENV}"` : "not set"}, not production, which turns on development behaviour.`, link },
            { key: "agent_bypass", title: "Agent sign-in bypass", status: env.AGENT_DEV_BYPASS ? "fail" : "pass", detail: env.AGENT_DEV_BYPASS ? "AGENT_DEV_BYPASS is set, which relaxes how agents are authenticated." : "The development bypass for agents is not set.", link },
            { key: "api_docs", title: "API documentation pages", status: (env.SWAGGER ?? "").toLowerCase() === "true" ? "warn" : "pass", detail: (env.SWAGGER ?? "").toLowerCase() === "true" ? "The API documentation pages are public. Turn them off on a server people can reach." : "The API documentation pages are off.", link },
            { key: "admin_key", title: "Break-glass API key", status: env.ADMIN_API_KEY ? "warn" : "pass", detail: env.ADMIN_API_KEY ? "ADMIN_API_KEY is set. Anyone holding it bypasses permission checks. Leave it unset unless automation needs it." : "No break-glass API key is set.", link },
        ];
        return items;
    }

    /* ------------------------------ devices ------------------------------ */

    /** Reads each agent's security facts a page at a time, so a large fleet is never held in memory at once. */
    private async devices(): Promise<ComplianceItem[]> {
        const link = { label: "Open Reports", href: "/reports" };
        const t = { devices: 0, reporting: 0, unencrypted: 0, av: 0, fw: 0, unsupported: 0, osKnown: 0 };
        const oldNames = new Map<string, number>();
        let after = "00000000-0000-0000-0000-000000000000";
        for (;;) {
            const rows = await this.prisma.$queryRaw<{ device_id: string; os_name: string | null; os: unknown; security: unknown }[]>(Prisma.sql`
              SELECT a.device_id::text AS device_id, d.operating_system AS os_name, a.facts->'device'->'os' AS os, a.facts->'device'->'security' AS security
                FROM public.agents a JOIN public.devices d ON d.id = a.device_id
               WHERE a.device_id > ${after}::uuid ORDER BY a.device_id LIMIT 1000`);
            if (!rows.length) break;
            after = rows[rows.length - 1].device_id;
            for (const r of rows) {
                t.devices++;
                const health = parseDeviceHealth({ device: { os: r.os ?? {}, security: r.security ?? {} } });
                const name = health.osName ?? r.os_name;
                if (name) {
                    t.osKnown++;
                    const old = unsupportedWindows(name);
                    if (old) {
                        t.unsupported++;
                        oldNames.set(old, (oldNames.get(old) ?? 0) + 1);
                    }
                }
                if (!r.security || (typeof r.security === "object" && !Object.keys(r.security as object).length)) continue;
                t.reporting++;
                if (encryptionVerdict(health).state === "unprotected") t.unencrypted++;
                if (avVerdict(health, 7).state === "off") t.av++;
                if (firewallOff(health).length) t.fw++;
            }
            if (rows.length < 1000) break;
        }

        const rate = (n: number): Status => (n === 0 ? "pass" : pct(n, t.reporting) > 10 ? "fail" : "warn");
        const silent = t.devices - t.reporting;
        const note = silent > 0 ? ` ${plural(silent, "device")} did not report security details (Linux, older agents, or not yet checked in), so ${silent === 1 ? "it is" : "they are"} not counted.` : "";
        if (!t.devices) return [{ key: "devices", title: "Devices", status: "info", detail: "No devices have an agent yet, so there is nothing to check.", link }];
        if (!t.reporting) return [{ key: "devices", title: "Device security details", status: "info", detail: `None of the ${plural(t.devices, "device")} has reported security details yet.`, link }, this.osItem(t, oldNames, link)];
        return [
            { key: "disk_encryption", title: "Disk encryption", status: rate(t.unencrypted), detail: `${t.unencrypted} of ${t.reporting} reporting devices have an unencrypted system drive.${note} Pass is none, a warning is up to 10%.`, link },
            { key: "antivirus", title: "Antivirus", status: rate(t.av), detail: `${t.av} of ${t.reporting} reporting devices have no antivirus switched on.${note}`, link },
            { key: "firewall", title: "Firewall", status: rate(t.fw), detail: `${t.fw} of ${t.reporting} reporting devices have the private or public firewall profile off.${note}`, link },
            this.osItem(t, oldNames, link),
        ];
    }

    private osItem(t: { osKnown: number; unsupported: number }, names: Map<string, number>, link: { label: string; href: string }): ComplianceItem {
        if (!t.osKnown) return { key: "unsupported_os", title: "Windows versions that no longer get updates", status: "info", detail: "No device has reported its operating system yet.", link };
        const list = [...names.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}: ${c}`).join(", ");
        const rate = pct(t.unsupported, t.osKnown);
        return { key: "unsupported_os", title: "Windows versions that no longer get updates", status: t.unsupported === 0 ? "pass" : rate > 10 ? "fail" : "warn", detail: t.unsupported === 0 ? "No device runs a Windows release that is past the end of support (judged by release name only)." : `${t.unsupported} of ${t.osKnown} devices run a Windows release that is past the end of support (${list}). Judged by release name only; a paid extended update program may cover some.`, link };
    }
}
