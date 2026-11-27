import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { SmtpService } from "../smtp/smtp.service";
import { EMAIL_TEMPLATES, checkWording, renderSubject, renderText, sampleValues, templateDef, type EmailTemplateDef } from "./email-template-registry";
import { looksLikeEmail } from "../common/text-util";

const EMAIL = { test: (v: string) => looksLikeEmail(v) };

/** The wording of the system emails: the built-in text, or what an administrator changed it to. */
@Injectable()
export class EmailTemplatesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly smtp: SmtpService,
    ) { }

    private present(def: EmailTemplateDef, row: { subject: string; body: string; updated_at: Date } | undefined) {
        return {
            key: def.key,
            label: def.label,
            description: def.description,
            purpose: def.purpose,
            variables: def.variables,
            required: def.required,
            subject: row?.subject ?? def.subject,
            body: row?.body ?? def.body,
            defaultSubject: def.subject,
            defaultBody: def.body,
            customized: !!row,
            updatedAt: row ? row.updated_at.toISOString() : null,
        };
    }

    async list(orgId: string) {
        const rows = await this.prisma.email_templates.findMany({ where: { organization_id: orgId } });
        const by = new Map(rows.map((r) => [r.key, r]));
        return EMAIL_TEMPLATES.map((d) => this.present(d, by.get(d.key)));
    }

    async save(orgId: string, key: string, input: { subject?: unknown; body?: unknown }, userId: string | null) {
        const def = templateDef(key);
        const w = checkWording(def, input.subject, input.body);
        const row = await this.prisma.email_templates.upsert({
            where: { organization_id_key: { organization_id: orgId, key } },
            create: { organization_id: orgId, key, subject: w.subject, body: w.body, updated_by: userId },
            update: { subject: w.subject, body: w.body, updated_by: userId, updated_at: new Date() },
        });
        return this.present(def, row);
    }

    /** Back to the built-in wording. */
    async reset(orgId: string, key: string) {
        const def = templateDef(key);
        await this.prisma.email_templates.deleteMany({ where: { organization_id: orgId, key } });
        return this.present(def, undefined);
    }

    /** What an edited (not yet saved) wording looks like, with sample values. */
    preview(key: string, input: { subject?: unknown; body?: unknown }) {
        const def = templateDef(key);
        const w = checkWording(def, input.subject, input.body);
        const values = sampleValues(def);
        return { subject: renderSubject(w.subject, values), body: renderText(w.body, values) };
    }

    /** Sends the wording (as typed, or as saved) with sample values to one address, through the mailbox set up for it. */
    async test(orgId: string, key: string, input: { to?: unknown; subject?: unknown; body?: unknown }) {
        const def = templateDef(key);
        const to = String(input.to ?? "").trim();
        if (!EMAIL.test(to) || to.length > 200) throw new BadRequestException("Enter the email address to send the test to.");
        let subject = def.subject;
        let body = def.body;
        if (input.subject !== undefined || input.body !== undefined) {
            ({ subject, body } = checkWording(def, input.subject, input.body));
        } else {
            const saved = await this.prisma.email_templates.findUnique({ where: { organization_id_key: { organization_id: orgId, key } } });
            if (saved) ({ subject, body } = saved);
        }
        const values = sampleValues(def);
        const note = "This is a test with sample values. Nothing was sent to a customer.";
        const res = await this.smtp.sendPlain(def.purpose, to, `[Test] ${renderSubject(subject, values)}`, `${renderText(body, values)}\n\n--\n${note}`);
        return { ok: res.ok, message: res.ok ? `Sent to ${to}.` : res.result };
    }

    /**
     * The subject and text to send for one email: the saved wording, or the built-in, with the values filled in.
     * Without an organization (alerts have no session) it is the default organization's.
     */
    async render(key: string, values: Record<string, string>, orgId?: string): Promise<{ subject: string; body: string }> {
        const def = templateDef(key);
        let subject = def.subject;
        let body = def.body;
        try {
            const org = orgId ?? (await this.orgs.getDefaultOrganizationId());
            const saved = await this.prisma.email_templates.findUnique({ where: { organization_id_key: { organization_id: org, key } } });
            if (saved) ({ subject, body } = saved);
        } catch {
            // A problem reading the saved wording must not stop the email: the built-in text is used.
        }
        return { subject: renderSubject(subject, values), body: renderText(body, values) };
    }
}
