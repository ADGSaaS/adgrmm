//remoteiq-minimal-e2e\backend\src\roles\permissions-introspect.service.ts

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import {
    ALL_PERMISSIONS,
    PERMISSION_DEFINITIONS,
    PERMISSION_GROUPS,
    PermissionDefinition,
    rolePermissions,
    BUILT_IN_ROLES,
} from "../auth/policy";

export type PermissionGroupDto = {
    key: string;
    label: string;
    items: { key: string; label: string; description?: string }[];
};

@Injectable()
export class PermissionsIntrospectService implements OnModuleInit {
    private readonly logger = new Logger(PermissionsIntrospectService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
    ) { }

    async onModuleInit(): Promise<void> {
        try {
            const known = new Set((await this.prisma.permissions.findMany({ select: { permission_key: true } })).map((p) => p.permission_key));
            await this.syncPermissionCatalog();
            await this.ensureBuiltInRoles(ALL_PERMISSIONS.filter((k) => !known.has(k)));
        } catch (err) {
            this.logger.warn(`Failed to seed permissions catalog: ${(err as Error)?.message ?? err}`);
        }
    }

    listDistinctPermissionKeys(): Promise<string[]> {
        return Promise.resolve([...ALL_PERMISSIONS]);
    }

    listPermissionDefinitions(): Promise<PermissionDefinition[]> {
        return Promise.resolve([...PERMISSION_DEFINITIONS]);
    }

    listPermissionGroups(): Promise<PermissionGroupDto[]> {
        const groups: PermissionGroupDto[] = PERMISSION_GROUPS.map((group) => ({
            key: group.key,
            label: group.label,
            items: group.items.map((item) => ({
                key: item.key,
                label: item.label,
                description: item.description,
            })),
        }));
        return Promise.resolve(groups);
    }

    private async syncPermissionCatalog(): Promise<void> {
        await this.prisma.$transaction(
            PERMISSION_DEFINITIONS.map((d) => {
                const fields = { label: d.label, group_key: d.groupKey, group_label: d.groupLabel };
                return this.prisma.permissions.upsert({
                    where: { permission_key: d.key },
                    create: { permission_key: d.key, ...fields },
                    update: fields,
                });
            }),
        );
    }

    /**
     * Owner always holds every permission. Admin, Operator and Viewer are created when missing, with
     * their default permissions, and are never reset afterwards, so edits made in the Roles screen
     * stick. A permission that is new in this release is added to a built-in role only if that role's
     * default includes it, once, when it first appears.
     */
    private async ensureBuiltInRoles(newKeys: string[]): Promise<void> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const descriptions: Record<string, string> = {
            owner: "Full system access",
            admin: "Administrative access",
            operator: "Works on devices, alerts and tickets. No user or billing administration.",
            viewer: "Read-only access",
        };
        const display: Record<string, string> = { owner: "Owner", admin: "Admin", operator: "Operator", viewer: "Viewer" };

        for (const key of BUILT_IN_ROLES) {
            // key is a constant here, so ILIKE wildcards cannot come into it.
            const existing = await this.prisma.roles.findFirst({
                where: {
                    name: { equals: key, mode: "insensitive" },
                    OR: [{ scope: "organization", organization_id: orgId }, { scope: "system" }],
                },
                select: { id: true },
            });
            const defaults: string[] = key === "owner" ? [...ALL_PERMISSIONS] : [...rolePermissions[key]];

            if (!existing) {
                const roleId = randomUUID();
                await this.prisma.roles.create({
                    data: { id: roleId, organization_id: orgId, scope: "organization", name: display[key], description: descriptions[key] },
                });
                await this.replacePermissions(roleId, defaults);
                continue;
            }

            if (key === "owner") {
                await this.replacePermissions(existing.id, defaults);
                continue;
            }
            const add = defaults.filter((k) => newKeys.includes(k));
            if (add.length) {
                await this.prisma.role_permissions.createMany({
                    data: add.map((permission_key) => ({ role_id: existing.id, permission_key })),
                    skipDuplicates: true,
                });
            }
        }
    }

    private async replacePermissions(roleId: string, perms: string[]): Promise<void> {
        await this.prisma.$transaction([
            this.prisma.role_permissions.deleteMany({ where: { role_id: roleId } }),
            this.prisma.role_permissions.createMany({
                data: perms.map((permission_key) => ({ role_id: roleId, permission_key })),
            }),
        ]);
    }
}
