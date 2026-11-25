// backend/src/reports/software-policies.service.ts
//
// Software a customer must have, or must not have, kept as policies instead of typed into a report each time. A policy
// is part of a program's name; one with no customer applies to every customer. The software compliance report uses
// them unless a list is typed into the report itself.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PoliciesService } from "../policies/policies.service";

const MAX_PER_CUSTOMER = 200;

@Injectable()
export class SoftwarePoliciesService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    /** Policies for one customer, with the ones for everyone, or every policy when no customer is given. */
    async list(clientId?: string, allowed?: string[]) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const rows = await this.prisma.software_policies.findMany({
            where: { organization_id: organizationId, ...(clientId ? { OR: [{ client_id: clientId }, { client_id: null }] } : allowed ? { OR: [{ client_id: { in: allowed } }, { client_id: null }] } : {}) },
            orderBy: [{ kind: "asc" }, { pattern: "asc" }],
        });
        const names = new Map((await this.prisma.clients.findMany({ where: { organization_id: organizationId, id: { in: [...new Set(rows.map((r) => r.client_id).filter((v): v is string => !!v))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
        return {
            items: rows.map((r) => ({ id: r.id, clientId: r.client_id, customer: r.client_id ? names.get(r.client_id) ?? null : null, kind: r.kind, pattern: r.pattern, note: r.note, createdAt: r.created_at })),
        };
    }

    async create(input: { clientId?: string; kind: string; pattern: string; note?: string }) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        if (input.kind !== "required" && input.kind !== "banned") throw new BadRequestException("A policy is either required or banned.");
        const pattern = (input.pattern ?? "").trim();
        if (!pattern) throw new BadRequestException("Enter the name of the software, or part of it.");
        if (pattern.length > 100) throw new BadRequestException("The software name can be at most 100 characters.");
        if (input.clientId) {
            const client = await this.prisma.clients.findFirst({ where: { id: input.clientId, organization_id: organizationId }, select: { id: true } });
            if (!client) throw new BadRequestException("That customer does not exist.");
        }
        const clientId = input.clientId || null;
        const existing = await this.prisma.software_policies.findMany({ where: { organization_id: organizationId, client_id: clientId }, select: { kind: true, pattern: true } });
        if (existing.some((e) => e.kind === input.kind && e.pattern.toLowerCase() === pattern.toLowerCase())) throw new ConflictException("That policy already exists.");
        if (existing.length >= MAX_PER_CUSTOMER) throw new BadRequestException(`There can be at most ${MAX_PER_CUSTOMER} policies for one customer.`);
        const row = await this.prisma.software_policies.create({ data: { organization_id: organizationId, client_id: clientId, kind: input.kind, pattern, note: input.note?.trim().slice(0, 300) || null } });
        PoliciesService.invalidate();
        return { id: row.id, clientId: row.client_id, kind: row.kind, pattern: row.pattern, note: row.note };
    }

    async remove(id: string) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const row = await this.prisma.software_policies.findFirst({ where: { id, organization_id: organizationId }, select: { id: true } });
        if (!row) throw new NotFoundException("That policy does not exist.");
        await this.prisma.software_policies.delete({ where: { id } });
        PoliciesService.invalidate();
        return { id, deleted: true };
    }
}
