import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { CustomFieldsService } from "../customers/custom-fields.service";

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const MAX_TEMPLATES = 100;

type Input = { name?: unknown; hint?: unknown; subject?: unknown; body?: unknown; priority?: unknown; customFields?: unknown };

const oneLine = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

const present = (r: { id: string; name: string; hint: string | null; subject: string; body: string; priority: string; custom_fields: unknown; sort_order: number; updated_at: Date }) => ({
    id: r.id,
    name: r.name,
    hint: r.hint ?? "",
    subject: r.subject,
    body: r.body,
    priority: r.priority,
    customFields: r.custom_fields && typeof r.custom_fields === "object" && !Array.isArray(r.custom_fields) ? (r.custom_fields as Record<string, unknown>) : {},
    updatedAt: r.updated_at.toISOString(),
});

/** Starting points for new tickets: a default subject, description, priority and custom field values. */
@Injectable()
export class TicketTemplatesService {
    constructor(private readonly prisma: PrismaService, private readonly fields: CustomFieldsService) { }

    async list(orgId: string) {
        const rows = await this.prisma.ticket_templates.findMany({ where: { organization_id: orgId }, orderBy: [{ sort_order: "asc" }, { name: "asc" }] });
        // A value in a field that has been archived is not shown or used.
        const out: ReturnType<typeof present>[] = [];
        for (const r of rows) {
            const t = present(r);
            t.customFields = (await this.fields.onlyActive(orgId, t.customFields, "ticket")) as Record<string, unknown>;
            out.push(t);
        }
        return out;
    }

    private async clean(orgId: string, input: Input, partial: boolean) {
        const data: { name?: string; hint?: string | null; subject?: string; body?: string; priority?: string; custom_fields?: Prisma.InputJsonValue } = {};
        if (!partial || input.name !== undefined) {
            const name = oneLine(input.name);
            if (!name) throw new BadRequestException("Give the template a name.");
            if (name.length > 80) throw new BadRequestException("The name is too long (80 characters at most).");
            data.name = name;
        }
        if (input.hint !== undefined) {
            const hint = oneLine(input.hint);
            if (hint.length > 200) throw new BadRequestException("The description is too long (200 characters at most).");
            data.hint = hint || null;
        }
        if (input.subject !== undefined) {
            const subject = oneLine(input.subject);
            if (subject.length > 300) throw new BadRequestException("The subject is too long (300 characters at most).");
            data.subject = subject;
        }
        if (input.body !== undefined) {
            const body = String(input.body ?? "").replace(/\r\n?/g, "\n").trim();
            if (body.length > 10_000) throw new BadRequestException("The text is too long (10,000 characters at most).");
            data.body = body;
        }
        if (input.priority !== undefined) {
            const p = String(input.priority).toLowerCase();
            if (!(PRIORITIES as readonly string[]).includes(p)) throw new BadRequestException(`The priority must be one of: ${PRIORITIES.join(", ")}.`);
            data.priority = p;
        }
        if (input.customFields !== undefined) {
            data.custom_fields = (await this.fields.partialValues(orgId, input.customFields, "ticket")) as Prisma.InputJsonValue;
        }
        return data;
    }

    async create(orgId: string, input: Input, userId: string | null) {
        const data = await this.clean(orgId, input, false);
        if ((await this.prisma.ticket_templates.count({ where: { organization_id: orgId } })) >= MAX_TEMPLATES) throw new BadRequestException(`There can be ${MAX_TEMPLATES} templates at most.`);
        const last = await this.prisma.ticket_templates.aggregate({ where: { organization_id: orgId }, _max: { sort_order: true } });
        try {
            const r = await this.prisma.ticket_templates.create({
                data: { organization_id: orgId, name: data.name!, hint: data.hint ?? null, subject: data.subject ?? "", body: data.body ?? "", priority: data.priority ?? "medium", custom_fields: data.custom_fields ?? {}, sort_order: (last._max.sort_order ?? 0) + 1, created_by: userId },
            });
            return present(r);
        } catch (e: any) {
            if (e?.code === "P2002" || e?.code === "P2010") throw new ConflictException("There is already a template with that name.");
            throw e;
        }
    }

    private async find(orgId: string, id: string) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Template not found");
        const r = await this.prisma.ticket_templates.findFirst({ where: { id, organization_id: orgId } });
        if (!r) throw new NotFoundException("Template not found");
        return r;
    }

    async update(orgId: string, id: string, input: Input) {
        await this.find(orgId, id);
        const data = await this.clean(orgId, input, true);
        try {
            return present(await this.prisma.ticket_templates.update({ where: { id }, data: { ...data, updated_at: new Date() } }));
        } catch (e: any) {
            if (e?.code === "P2002" || e?.code === "P2010") throw new ConflictException("There is already a template with that name.");
            throw e;
        }
    }

    async remove(orgId: string, id: string) {
        await this.find(orgId, id);
        await this.prisma.ticket_templates.delete({ where: { id } });
        return { ok: true };
    }
}
