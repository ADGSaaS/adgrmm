// backend/src/branding/branding.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { UpdateBrandingDto } from './dto/update-branding.dto';
import { PrismaService } from '../storage/prisma.service';

type BrandingRow = {
    primary_color: string | null;
    secondary_color: string | null;
    logo_light_url: string | null;
    logo_dark_url: string | null;
    login_background_url: string | null;
    favicon_url: string | null;
    email_header: string | null;
    email_footer: string | null;
    custom_css: string | null;
    allow_client_theme_toggle: boolean | null;
};

@Injectable()
export class BrandingService {
    constructor(private readonly prisma: PrismaService) { }

    private rowToApi(row: BrandingRow | null) {
        return {
            primaryColor: row?.primary_color ?? null,
            secondaryColor: row?.secondary_color ?? null,
            logoLightUrl: row?.logo_light_url ?? null,
            logoDarkUrl: row?.logo_dark_url ?? null,
            loginBackgroundUrl: row?.login_background_url ?? null,
            faviconUrl: row?.favicon_url ?? null,
            emailHeader: row?.email_header ?? null,
            emailFooter: row?.email_footer ?? null,
            customCss: row?.custom_css ?? null,
            allowClientThemeToggle: row?.allow_client_theme_toggle ?? null,
        };
    }

    async getBranding() {
        try {
            const row = await this.prisma.branding_settings.findFirst({
                orderBy: { id: 'desc' },
            });
            return this.rowToApi(row);
        } catch (err: any) {
            throw new InternalServerErrorException(`Failed to load branding: ${err?.message ?? err}`);
        }
    }

    async updateBranding(input: UpdateBrandingDto) {
        try {
            // Explicit nulls: a saved form replaces every field, and Prisma skips undefined.
            const values = {
                primary_color: input.primaryColor ?? null,
                secondary_color: input.secondaryColor ?? null,
                logo_light_url: input.logoLightUrl ?? null,
                logo_dark_url: input.logoDarkUrl ?? null,
                login_background_url: input.loginBackgroundUrl ?? null,
                favicon_url: input.faviconUrl ?? null,
                email_header: input.emailHeader ?? null,
                email_footer: input.emailFooter ?? null,
                custom_css: input.customCss ?? null,
                allow_client_theme_toggle: input.allowClientThemeToggle ?? null,
            };

            await this.prisma.branding_settings.upsert({
                where: { id: 1 },
                create: { id: 1, ...values },
                update: values,
            });
            return this.getBranding();
        } catch (err: any) {
            throw new InternalServerErrorException(`Failed to update branding: ${err?.message ?? err}`);
        }
    }
}
