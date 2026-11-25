// backend/src/reports/client-branding.service.ts
//
// A customer's own look for the reports sent to them: a colour, a logo, a note on the cover and a footer on every page.
// Anything not set falls back to the company's own branding.
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { existsSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";

export const UPLOADS_DIR = () => join(process.cwd(), "public", "uploads");

export type ClientBranding = { primaryColor: string | null; logoFile: string | null; coverText: string | null; footerText: string | null };

const HEX = /^#[0-9a-f]{6}$/i;

@Injectable()
export class ClientBrandingService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    private async assertClient(clientId: string) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const client = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: organizationId }, select: { id: true, name: true } });
        if (!client) throw new NotFoundException("That customer does not exist.");
        return client;
    }

    async get(clientId: string) {
        const client = await this.assertClient(clientId);
        const row = await this.prisma.client_report_settings.findUnique({ where: { client_id: clientId } });
        return {
            clientId,
            customer: client.name,
            primaryColor: row?.primary_color ?? null,
            logoFile: row?.logo_file ?? null,
            logoUrl: row?.logo_file ? `/static/uploads/${row.logo_file}` : null,
            coverText: row?.cover_text ?? null,
            footerText: row?.footer_text ?? null,
        };
    }

    async set(clientId: string, input: { primaryColor?: string | null; coverText?: string | null; footerText?: string | null }) {
        await this.assertClient(clientId);
        const color = (input.primaryColor ?? "").trim();
        if (color && !HEX.test(color)) throw new BadRequestException("The colour must look like #1a73e8.");
        const cover = (input.coverText ?? "").trim();
        const footer = (input.footerText ?? "").trim();
        if (cover.length > 1500) throw new BadRequestException("The cover note can be at most 1500 characters.");
        if (footer.length > 160) throw new BadRequestException("The page footer can be at most 160 characters.");
        const data = { primary_color: color || null, cover_text: cover || null, footer_text: footer || null, updated_at: new Date() };
        await this.prisma.client_report_settings.upsert({ where: { client_id: clientId }, create: { client_id: clientId, ...data }, update: data });
        return this.get(clientId);
    }

    private removeFile(name: string | null | undefined) {
        if (!name) return;
        const file = join(UPLOADS_DIR(), basename(name));
        try {
            if (existsSync(file)) unlinkSync(file);
        } catch {
            /* an old logo that cannot be deleted is left */
        }
    }

    async setLogo(clientId: string, filename: string) {
        await this.assertClient(clientId);
        const existing = await this.prisma.client_report_settings.findUnique({ where: { client_id: clientId } });
        await this.prisma.client_report_settings.upsert({ where: { client_id: clientId }, create: { client_id: clientId, logo_file: filename }, update: { logo_file: filename, updated_at: new Date() } });
        if (existing?.logo_file && existing.logo_file !== filename) this.removeFile(existing.logo_file);
        return this.get(clientId);
    }

    async removeLogo(clientId: string) {
        await this.assertClient(clientId);
        const existing = await this.prisma.client_report_settings.findUnique({ where: { client_id: clientId } });
        if (existing?.logo_file) {
            await this.prisma.client_report_settings.update({ where: { client_id: clientId }, data: { logo_file: null, updated_at: new Date() } });
            this.removeFile(existing.logo_file);
        }
        return this.get(clientId);
    }

    /** What the report cover needs, with the logo as a path that exists, or null. */
    async forReport(clientId: string | null): Promise<{ color: string | null; logoPath: string | null; coverText: string | null; footerText: string | null }> {
        if (!clientId) return { color: null, logoPath: null, coverText: null, footerText: null };
        const row = await this.prisma.client_report_settings.findUnique({ where: { client_id: clientId } }).catch(() => null);
        if (!row) return { color: null, logoPath: null, coverText: null, footerText: null };
        const candidate = row.logo_file && /\.(png|jpe?g)$/i.test(row.logo_file) ? join(UPLOADS_DIR(), basename(row.logo_file)) : null;
        return {
            color: row.primary_color && HEX.test(row.primary_color) ? row.primary_color : null,
            logoPath: candidate && existsSync(candidate) ? candidate : null,
            coverText: row.cover_text,
            footerText: row.footer_text,
        };
    }
}
