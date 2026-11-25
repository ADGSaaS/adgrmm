import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/--+/g, "-");
}

@Injectable()
export class OrganizationContextService {
    private readonly logger = new Logger(OrganizationContextService.name);
    private cachedOrgId: string | null = null;

    constructor(private readonly prisma: PrismaService) { }

    async getDefaultOrganizationId(): Promise<string> {
        if (this.cachedOrgId) return this.cachedOrgId;

        const configuredSlug = process.env.DEFAULT_ORGANIZATION_SLUG || "default";
        const slug = slugify(configuredSlug) || "default";
        const name = process.env.DEFAULT_ORGANIZATION_NAME || "Default Organization";

        try {
            const existing = await this.prisma.organizations.findUnique({
                where: { slug },
                select: { id: true },
            });
            if (existing) {
                this.cachedOrgId = existing.id;
                return this.cachedOrgId;
            }
        } catch (err) {
            this.logger.warn(`organizations table unavailable: ${(err as Error)?.message ?? err}`);
            throw err;
        }

        const { id: orgId } = await this.prisma.organizations.upsert({
            where: { slug },
            create: { name, slug },
            update: { name },
            select: { id: true },
        });
        this.cachedOrgId = orgId;

        await this.prisma.organization_settings.createMany({
            data: [{ organization_id: orgId }],
            skipDuplicates: true,
        });

        return orgId;
    }
}
