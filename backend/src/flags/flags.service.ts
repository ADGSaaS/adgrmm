// backend/src/flags/flags.service.ts
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PrismaService } from "../storage/prisma.service";
import { FLAG_CATALOG, FLAG_KEYS } from "./flags.catalog";

export type FlagView = {
    key: string;
    label: string;
    description: string;
    effect: string;
    enabled: boolean;
    defaultEnabled: boolean;
    /** True when an administrator changed it from the default. */
    changed: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
};

const TTL_MS = 5_000;

@Injectable()
export class FlagsService {
    private readonly cache = new Map<string, { at: number; values: Map<string, boolean> }>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly audit: AuditService,
    ) { }

    async orgOf(user: any): Promise<string> {
        const id = user?.organizationId ?? user?.org;
        return id && isCanonicalUuid(String(id)) ? String(id) : this.orgs.getDefaultOrganizationId();
    }

    private async overrides(orgId: string): Promise<Map<string, boolean>> {
        const hit = this.cache.get(orgId);
        if (hit && Date.now() - hit.at < TTL_MS) return hit.values;
        const rows = await this.prisma.feature_flags.findMany({ where: { organization_id: orgId } });
        const values = new Map(rows.map((r) => [r.key, r.enabled]));
        this.cache.set(orgId, { at: Date.now(), values });
        return values;
    }

    /** True when the flag is on for the organization. A key that is not in the catalog is off. */
    async isEnabled(orgId: string, key: string): Promise<boolean> {
        const def = FLAG_CATALOG.find((f) => f.key === key);
        if (!def) return false;
        return (await this.overrides(orgId)).get(key) ?? def.defaultEnabled;
    }

    /** Throws when the flag is off, for the server side of a gated feature. */
    async assertEnabled(orgId: string, key: string): Promise<void> {
        if (await this.isEnabled(orgId, key)) return;
        const def = FLAG_CATALOG.find((f) => f.key === key);
        throw new ForbiddenException(`${def?.label ?? key} is turned off. An administrator can turn it on under Administration > Feature Flags.`);
    }

    /** Just the on/off answers, for any signed-in person's screens to read. */
    async effective(orgId: string): Promise<Record<string, boolean>> {
        const over = await this.overrides(orgId);
        return Object.fromEntries(FLAG_CATALOG.map((f) => [f.key, over.get(f.key) ?? f.defaultEnabled]));
    }

    async list(orgId: string): Promise<FlagView[]> {
        const rows = await this.prisma.feature_flags.findMany({ where: { organization_id: orgId } });
        const byKey = new Map(rows.map((r) => [r.key, r]));
        const people = rows.map((r) => r.updated_by).filter((x): x is string => !!x);
        const users = people.length ? await this.prisma.users.findMany({ where: { id: { in: people } }, select: { id: true, email: true } }) : [];
        const email = new Map(users.map((u) => [u.id, String(u.email)]));
        return FLAG_CATALOG.map((f) => {
            const row = byKey.get(f.key);
            return {
                key: f.key,
                label: f.label,
                description: f.description,
                effect: f.effect,
                enabled: row ? row.enabled : f.defaultEnabled,
                defaultEnabled: f.defaultEnabled,
                changed: !!row && row.enabled !== f.defaultEnabled,
                updatedAt: row ? row.updated_at.toISOString() : null,
                updatedBy: row?.updated_by ? email.get(row.updated_by) ?? null : null,
            };
        });
    }

    async set(orgId: string, key: string, enabled: boolean, actor: { id?: string | null; email?: string | null }, req: any): Promise<FlagView> {
        if (!FLAG_KEYS.has(key)) throw new NotFoundException("There is no such feature flag.");
        const before = await this.isEnabled(orgId, key);
        const by = actor.id && isCanonicalUuid(String(actor.id)) ? String(actor.id) : null;
        await this.prisma.feature_flags.upsert({
            where: { organization_id_key: { organization_id: orgId, key } },
            create: { organization_id: orgId, key, enabled, updated_by: by },
            update: { enabled, updated_by: by, updated_at: new Date() },
        });
        this.cache.delete(orgId);
        await this.audit.record({
            action: "settings.flag.set",
            category: "settings",
            outcome: "success",
            actorUserId: by,
            actorEmail: actor.email ?? null,
            targetType: "feature_flag",
            targetId: key,
            targetLabel: key,
            req,
            details: { flag: key, from: before, to: enabled },
        });
        return (await this.list(orgId)).find((f) => f.key === key)!;
    }
}
