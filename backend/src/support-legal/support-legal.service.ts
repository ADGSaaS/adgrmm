import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { SupportLegal, SupportLegalDto } from "./support-legal.dto";

@Injectable()
export class SupportLegalService {
    private readonly rowId = 1;

    constructor(private readonly prisma: PrismaService) { }

    async get(): Promise<SupportLegal | null> {
        const row = await this.prisma.support_legal.findUnique({
            where: { id: this.rowId },
        });
        if (!row) return null;

        return {
            id: row.id,
            supportEmail: row.support_email,
            supportPhone: row.support_phone,
            knowledgeBaseUrl: row.knowledge_base_url,
            statusPageUrl: row.status_page_url,
            privacyPolicyUrl: row.privacy_policy_url,
            termsUrl: row.terms_url,
            gdprContactEmail: row.gdpr_contact_email,
            legalAddress: row.legal_address,
            ticketPortalUrl: row.ticket_portal_url,
            phoneHours: row.phone_hours,
            notesHtml: row.notes_html,
        } as SupportLegal;
    }

    async upsert(input: SupportLegalDto): Promise<void> {
        // Explicit nulls: a saved form replaces every field, and Prisma skips undefined.
        const values = {
            support_email: input.supportEmail ?? null,
            support_phone: input.supportPhone ?? null,
            knowledge_base_url: input.knowledgeBaseUrl ?? null,
            status_page_url: input.statusPageUrl ?? null,
            privacy_policy_url: input.privacyPolicyUrl ?? null,
            terms_url: input.termsUrl ?? null,
            gdpr_contact_email: input.gdprContactEmail ?? null,
            legal_address: input.legalAddress ?? null,
            ticket_portal_url: input.ticketPortalUrl ?? null,
            phone_hours: input.phoneHours ?? null,
            notes_html: input.notesHtml ?? null,
        };

        await this.prisma.support_legal.upsert({
            where: { id: this.rowId },
            create: { id: this.rowId, ...values },
            update: values,
        });
    }
}
