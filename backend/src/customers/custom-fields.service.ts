import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { FIELD_TYPES, MAX_FIELDS, cleanHelp, cleanLabel, cleanOptions, keyFromLabel, mergeValues, type FieldDef, type FieldType } from "./custom-fields";

export type FieldEntity = "customer" | "ticket";

type Input = { label?: unknown; type?: unknown; options?: unknown; required?: unknown; help?: unknown; active?: unknown; visibleToCustomer?: unknown };

const toDef = (r: any): FieldDef => ({
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type,
    options: Array.isArray(r.options) ? r.options.map(String) : [],
    required: !!r.required,
    help: r.help ?? "",
    sortOrder: r.sort_order,
    active: !!r.active,
    visibleToCustomer: !!r.visible_to_customer,
});

/** The fields an organization keeps about its customers (and its tickets), and the checking of what is typed into them. */
@Injectable()
export class CustomFieldsService {
    constructor(private readonly prisma: PrismaService) { }

    async list(orgId: string, includeArchived = false, entity: FieldEntity = "customer"): Promise<FieldDef[]> {
        const rows = await this.prisma.custom_field_defs.findMany({
            where: { organization_id: orgId, entity, ...(includeArchived ? {} : { active: true }) },
            orderBy: [{ active: "desc" }, { sort_order: "asc" }, { created_at: "asc" }],
        });
        return rows.map(toDef);
    }

    private async find(orgId: string, id: string, entity: FieldEntity) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Field not found");
        const r = await this.prisma.custom_field_defs.findFirst({ where: { id, organization_id: orgId, entity } });
        if (!r) throw new NotFoundException("Field not found");
        return r;
    }

    async create(orgId: string, input: Input, entity: FieldEntity = "customer"): Promise<FieldDef> {
        const label = cleanLabel(input.label);
        const type = String(input.type ?? "") as FieldType;
        if (!(FIELD_TYPES as readonly string[]).includes(type)) throw new BadRequestException(`The type must be one of: ${FIELD_TYPES.join(", ")}.`);
        const options = cleanOptions(type, input.options);
        const help = cleanHelp(input.help);

        const existing = await this.prisma.custom_field_defs.findMany({ where: { organization_id: orgId, entity }, select: { key: true, active: true, sort_order: true } });
        if (existing.filter((e) => e.active).length >= MAX_FIELDS) throw new BadRequestException(`There can be ${MAX_FIELDS} custom fields at most. Archive one you no longer use.`);
        const taken = new Set(existing.map((e) => e.key));
        let key = keyFromLabel(label);
        for (let n = 2; taken.has(key); n++) key = `${keyFromLabel(label).slice(0, 36)}_${n}`;

        try {
            const r = await this.prisma.custom_field_defs.create({
                data: {
                    id: randomUUID(),
                    organization_id: orgId,
                    entity,
                    key,
                    label,
                    type,
                    options: options as Prisma.InputJsonValue,
                    required: input.required === true,
                    help: help || null,
                    visible_to_customer: entity === "ticket" && input.visibleToCustomer === true,
                    sort_order: existing.reduce((m, e) => Math.max(m, e.sort_order), 0) + 1,
                },
            });
            return toDef(r);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("There is already a field with that name.");
            throw e;
        }
    }

    /** The type and key are fixed: values already saved depend on them. Everything else can change. */
    async update(orgId: string, id: string, input: Input, entity: FieldEntity = "customer"): Promise<FieldDef> {
        const cur = await this.find(orgId, id, entity);
        if (input.type !== undefined && input.type !== cur.type) throw new BadRequestException("The type of a field cannot be changed. Archive it and make a new one.");
        const data: Prisma.custom_field_defsUpdateInput = { updated_at: new Date() };
        if (input.label !== undefined) data.label = cleanLabel(input.label);
        if (input.options !== undefined) data.options = cleanOptions(cur.type as FieldType, input.options) as Prisma.InputJsonValue;
        if (input.required !== undefined) data.required = input.required === true;
        if (input.help !== undefined) data.help = cleanHelp(input.help) || null;
        if (input.visibleToCustomer !== undefined && entity === "ticket") data.visible_to_customer = input.visibleToCustomer === true;
        if (input.active !== undefined) {
            data.active = input.active === true;
            if (input.active === true && !cur.active) {
                const active = await this.prisma.custom_field_defs.count({ where: { organization_id: orgId, entity, active: true } });
                if (active >= MAX_FIELDS) throw new BadRequestException(`There can be ${MAX_FIELDS} custom fields at most.`);
            }
        }
        try {
            return toDef(await this.prisma.custom_field_defs.update({ where: { id }, data }));
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("There is already a field with that name.");
            throw e;
        }
    }

    /** Takes a field away without losing what was saved in it. */
    archive(orgId: string, id: string, entity: FieldEntity = "customer") {
        return this.update(orgId, id, { active: false }, entity);
    }

    async reorder(orgId: string, ids: unknown, entity: FieldEntity = "customer"): Promise<FieldDef[]> {
        if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) throw new BadRequestException("Send the fields in the order you want them.");
        const rows = await this.prisma.custom_field_defs.findMany({ where: { organization_id: orgId, entity, active: true }, select: { id: true } });
        const known = new Set(rows.map((r) => r.id));
        const order = (ids as string[]).filter((i) => known.has(i));
        const rest = rows.map((r) => r.id).filter((i) => !order.includes(i));
        await this.prisma.$transaction([...order, ...rest].map((id, i) => this.prisma.custom_field_defs.update({ where: { id }, data: { sort_order: i + 1 } })));
        return this.list(orgId, true, entity);
    }

    /**
     * What to save in a customer's custom_fields column, or undefined when nothing was sent and nothing needs checking.
     * A new customer must satisfy every required field. When editing, required fields are checked only if the person
     * sent field values (so other ways of changing a customer keep working).
     */
    async valuesToSave(orgId: string, sent: unknown, existing: Record<string, unknown>, isNew: boolean, entity: FieldEntity = "customer"): Promise<Record<string, unknown> | undefined> {
        if (sent !== undefined && (sent === null || typeof sent !== "object" || Array.isArray(sent))) throw new BadRequestException("Custom fields must be sent as a set of values.");
        if (sent === undefined && !isNew) return undefined;
        const defs = await this.list(orgId, true, entity);
        return mergeValues(defs, sent as Record<string, unknown> | undefined, existing, true);
    }

    /** Values for a template or another starting point: checked like any value, but none is required. */
    async partialValues(orgId: string, sent: unknown, entity: FieldEntity): Promise<Record<string, unknown>> {
        if (sent === undefined || sent === null) return {};
        if (typeof sent !== "object" || Array.isArray(sent)) throw new BadRequestException("Custom fields must be sent as a set of values.");
        const defs = await this.list(orgId, true, entity);
        return mergeValues(defs, sent as Record<string, unknown>, {}, false);
    }

    /** Only the values whose fields are still in use (a template may name a field that has been archived since). */
    async onlyActive(orgId: string, values: Record<string, unknown>, entity: FieldEntity): Promise<Record<string, unknown>> {
        const active = new Set((await this.list(orgId, false, entity)).map((d) => d.key));
        return Object.fromEntries(Object.entries(values).filter(([k]) => active.has(k)));
    }
}
