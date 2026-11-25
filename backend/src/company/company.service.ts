// backend/src/company/company.service.ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { CompanyProfile, CompanyProfileDto } from "./company.dto";

@Injectable()
export class CompanyService {
    private readonly rowId = 1;
    constructor(private readonly prisma: PrismaService) { }

    async get(): Promise<CompanyProfile | null> {
        const row = await this.prisma.company_profile.findUnique({
            where: { id: this.rowId },
        });
        if (!row) return null;

        return {
            id: row.id,
            name: row.name,
            legalName: row.legal_name,
            email: row.email,
            phone: row.phone,
            fax: row.fax,
            website: row.website,
            vatTin: row.vat_tin,
            address1: row.address1,
            address2: row.address2,
            city: row.city,
            state: row.state,
            postal: row.postal,
            country: row.country,
        } as CompanyProfile;
    }

    async upsert(input: CompanyProfileDto): Promise<void> {
        // Explicit nulls: a saved form replaces every field, and Prisma skips undefined.
        const values = {
            name: input.name,
            legal_name: input.legalName ?? null,
            email: input.email ?? null,
            phone: input.phone ?? null,
            fax: input.fax ?? null,
            website: input.website ?? null,
            vat_tin: input.vatTin ?? null,
            address1: input.address1 ?? null,
            address2: input.address2 ?? null,
            city: input.city ?? null,
            state: input.state ?? null,
            postal: input.postal ?? null,
            country: input.country ?? null,
        };

        await this.prisma.company_profile.upsert({
            where: { id: this.rowId },
            create: { id: this.rowId, ...values },
            update: values,
        });
    }
}
