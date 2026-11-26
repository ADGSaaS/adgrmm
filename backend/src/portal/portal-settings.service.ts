import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { normalizeDomain, PORTAL_MODULES } from "./portal.util";

export type PortalSettingsView = {
    enabled: boolean;
    domain: string | null;
    modules: string[];
    allowTicketCreate: boolean;
    welcomeTitle: string;
    welcomeText: string;
    supportEmail: string;
    supportPhone: string;
};

export type PortalSettingsInput = Partial<{
    enabled: boolean;
    domain: string | null;
    modules: string[];
    allowTicketCreate: boolean;
    welcomeTitle: string;
    welcomeText: string;
    supportEmail: string;
    supportPhone: string;
}>;

const DEFAULTS: PortalSettingsView = {
    enabled: false,
    domain: null,
    modules: [...PORTAL_MODULES],
    allowTicketCreate: true,
    welcomeTitle: "",
    welcomeText: "",
    supportEmail: "",
    supportPhone: "",
};

@Injectable()
export class PortalSettingsService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    orgId() {
        return this.orgs.getDefaultOrganizationId();
    }

    async get(): Promise<PortalSettingsView> {
        const r = await this.prisma.portal_settings.findUnique({ where: { organization_id: await this.orgId() } });
        if (!r) return { ...DEFAULTS };
        return {
            enabled: r.enabled,
            domain: r.domain,
            modules: r.modules.filter((m) => (PORTAL_MODULES as readonly string[]).includes(m)),
            allowTicketCreate: r.allow_ticket_create,
            welcomeTitle: r.welcome_title,
            welcomeText: r.welcome_text,
            supportEmail: r.support_email,
            supportPhone: r.support_phone,
        };
    }

    async update(input: PortalSettingsInput): Promise<PortalSettingsView> {
        const orgId = await this.orgId();
        const cur = await this.get();
        const next: PortalSettingsView = { ...cur };

        if (input.domain !== undefined) {
            const { domain, error } = normalizeDomain(input.domain);
            if (error) throw new BadRequestException(error);
            next.domain = domain;
        }
        if (input.modules !== undefined) {
            if (!Array.isArray(input.modules)) throw new BadRequestException("Modules must be a list.");
            const bad = input.modules.find((m) => !(PORTAL_MODULES as readonly string[]).includes(String(m)));
            if (bad) throw new BadRequestException(`"${bad}" is not a portal area.`);
            next.modules = [...new Set(input.modules.map(String))];
        }
        if (input.enabled !== undefined) next.enabled = input.enabled === true;
        if (input.allowTicketCreate !== undefined) next.allowTicketCreate = input.allowTicketCreate === true;
        const text = (v: unknown, max: number, label: string) => {
            const s = String(v ?? "").trim();
            if (s.length > max) throw new BadRequestException(`${label} can be at most ${max} characters.`);
            return s;
        };
        if (input.welcomeTitle !== undefined) next.welcomeTitle = text(input.welcomeTitle, 120, "The welcome title");
        if (input.welcomeText !== undefined) next.welcomeText = text(input.welcomeText, 2000, "The welcome message");
        if (input.supportEmail !== undefined) next.supportEmail = text(input.supportEmail, 254, "The support email");
        if (input.supportPhone !== undefined) next.supportPhone = text(input.supportPhone, 60, "The support phone");
        if (next.enabled && !next.domain) throw new BadRequestException("Set the portal address before turning the portal on.");

        const data = {
            enabled: next.enabled,
            domain: next.domain,
            modules: next.modules,
            allow_ticket_create: next.allowTicketCreate,
            welcome_title: next.welcomeTitle,
            welcome_text: next.welcomeText,
            support_email: next.supportEmail,
            support_phone: next.supportPhone,
            updated_at: new Date(),
        };
        try {
            await this.prisma.portal_settings.upsert({ where: { organization_id: orgId }, create: { organization_id: orgId, ...data }, update: data });
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("That address is already in use.");
            throw e;
        }
        return next;
    }

    /** What the portal website needs to draw itself before anyone signs in. */
    async publicConfig() {
        const s = await this.get();
        return {
            enabled: s.enabled && !!s.domain,
            domain: s.domain,
            modules: s.modules,
            allowTicketCreate: s.allowTicketCreate,
            welcomeTitle: s.welcomeTitle,
            welcomeText: s.welcomeText,
            supportEmail: s.supportEmail,
            supportPhone: s.supportPhone,
        };
    }

    /** True when the portal is on, so the endpoints answer. */
    async isOn(): Promise<boolean> {
        const s = await this.get();
        return s.enabled && !!s.domain;
    }

    /** Looks at the address from the outside, to tell the administrator whether traffic reaches this system. */
    async checkReachable(domain: string): Promise<{ ok: boolean; message: string }> {
        const { domain: host, error } = normalizeDomain(domain);
        if (error || !host) return { ok: false, message: error ?? "Enter the portal address first." };
        try {
            const res = await fetch(`https://${host}/api/portal/config`, { signal: AbortSignal.timeout(8000), redirect: "manual", headers: { accept: "application/json" } });
            if (!res.ok) return { ok: false, message: `The address answered, but not with the portal (HTTP ${res.status}). Check that the proxy points at the ADG RMM web app.` };
            const body = (await res.json().catch(() => null)) as { domain?: string | null } | null;
            if (!body || !("modules" in (body as object))) return { ok: false, message: "The address answered, but it is not this ADG RMM system." };
            if ((body.domain ?? "").toLowerCase() !== host) return { ok: false, message: "The address reaches ADG RMM, but the address saved here is different. Save the address first." };
            return { ok: true, message: "The portal is reachable at this address." };
        } catch (e: any) {
            const code = e?.cause?.code || e?.code || "";
            if (code === "ENOTFOUND") return { ok: false, message: "That name does not resolve yet. Add the DNS record and try again." };
            if (/CERT|SSL|TLS/i.test(String(code) + String(e?.message))) return { ok: false, message: "The address answers, but its HTTPS certificate is not valid. Request the certificate in the proxy." };
            return { ok: false, message: "Could not reach that address over HTTPS. Check the DNS record, the proxy host and the certificate." };
        }
    }
}
