import {
    Injectable,
    BadRequestException,
    NotFoundException,
    ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../storage/prisma.service';
import { OrganizationContextService } from '../storage/organization-context.service';
import { ALL_PERMISSIONS, Permission } from '../auth/policy';
import { Actor, assertCanGrant } from '../access/grant-rules';

export type RoleDto = {
    id: string;
    name: string;
    description?: string;
    permissions: string[];
    usersCount: number;
    createdAt: string;
    updatedAt: string;
};

export type CreateRoleDto = {
    name: string;
    description?: string;
    permissions?: string[];
};

export type UpdateRoleDto = Partial<{
    name: string;
    description: string | null;
    permissions: string[]; // full replace
}>;

const PROTECTED_NAMES = new Set(['owner', 'admin']);
const FULL_LOCK_NAME = 'owner';
const VALID_PERMISSIONS = new Set<Permission>(ALL_PERMISSIONS);

type RoleRecord = {
    id: string;
    name: string;
    scope: 'system' | 'organization';
    organization_id: string | null;
    description: string | null;
};

function isUuid(v: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function normalizePermissions(perms?: string[]): Permission[] {
    if (!perms || !perms.length) return [];
    const invalid: string[] = [];
    const out = new Set<Permission>();

    for (const raw of perms) {
        if (!raw) continue;
        const key = raw.trim().toLowerCase() as Permission;
        if (!VALID_PERMISSIONS.has(key)) {
            invalid.push(raw);
            continue;
        }
        out.add(key);
    }

    if (invalid.length) {
        throw new BadRequestException(`Unknown permission(s): ${invalid.join(', ')}`);
    }

    return Array.from(out);
}

@Injectable()
export class RolesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
    ) { }

    async list(): Promise<RoleDto[]> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        // Raw because Prisma cannot order by lower(name), and the database collation decides the order.
        const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        r.id::text AS id,
        r.name,
        COALESCE(r.description, '') AS description,
        COALESCE(array_agg(DISTINCT rp.permission_key)
                 FILTER (WHERE rp.permission_key IS NOT NULL),
                 '{}'::text[]) AS permissions,
        (
          SELECT COUNT(*)::int
          FROM public.user_roles ur
          WHERE ur.role_id = r.id
        ) AS "usersCount",
        r.created_at AS "createdAt",
        r.updated_at AS "updatedAt"
      FROM public.roles r
      LEFT JOIN public.role_permissions rp
        ON rp.role_id = r.id
      WHERE
        (r.scope = 'system')
        OR (r.organization_id = ${orgId}::uuid)
      GROUP BY r.id
      ORDER BY lower(r.name) ASC`;
        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            description: r.description ?? undefined,
            permissions: Array.isArray(r.permissions) ? r.permissions : [],
            usersCount: Number(r.usersCount ?? 0),
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        }));
    }

    async create(actor: Actor, payload: CreateRoleDto): Promise<{ id: string }> {
        const name = (payload.name ?? '').trim();
        if (name.length < 2 || name.length > 64) {
            throw new BadRequestException('Name must be 2–64 characters.');
        }

        const orgId = await this.orgs.getDefaultOrganizationId();
        if (await this.nameTaken(name, orgId)) {
            throw new ConflictException('Role name must be unique (case-insensitive).');
        }

        const desc = payload.description?.trim() || null;
        const perms = normalizePermissions(payload.permissions);
        assertCanGrant(actor, perms, 'a role');

        const { id } = await this.prisma.roles.create({
            data: { organization_id: orgId, scope: 'organization', name, description: desc },
            select: { id: true },
        });

        await this.replaceRolePermissions(id, perms);

        return { id };
    }

    async getById(id: string): Promise<{ id: string; name: string }> {
        if (!isUuid(id)) throw new BadRequestException('Invalid role id.');
        const role = await this.fetchRoleById(id);
        return { id: role.id, name: role.name };
    }

    /** Copies a role (its permissions, not its people) under a new name. */
    async duplicate(actor: Actor, id: string, nameRaw?: string): Promise<{ id: string }> {
        const role = await this.fetchRoleById(id);
        const current = await this.prisma.role_permissions.findMany({ where: { role_id: id }, select: { permission_key: true } });
        const perms = current.map((p) => p.permission_key);
        assertCanGrant(actor, perms, 'a role');
        const name = (nameRaw ?? '').trim() || `${role.name} (copy)`;
        return this.create(actor, { name, description: role.description ?? undefined, permissions: perms });
    }

    async update(actor: Actor, id: string, patch: UpdateRoleDto): Promise<void> {
        const { name: newNameRaw, description, permissions } = patch;
        const role = await this.fetchRoleById(id);

        const oldLower = role.name.trim().toLowerCase();
        let normalizedPerms = permissions === undefined ? null : normalizePermissions(permissions ?? []);

        if (oldLower === FULL_LOCK_NAME && normalizedPerms !== null) {
            // The edit form sends the permissions back with every save. Sending the same ones is not a change.
            const held = new Set((await this.prisma.role_permissions.findMany({ where: { role_id: id }, select: { permission_key: true } })).map((p) => p.permission_key));
            const same = held.size === normalizedPerms.length && normalizedPerms.every((p) => held.has(p));
            if (!same) throw new BadRequestException('The "Owner" role always has every permission and cannot be changed.');
            normalizedPerms = null;
        }
        if (!actor.owner) {
            // A role stronger than you are is not yours to edit, and you cannot add what you lack.
            const held = await this.prisma.role_permissions.findMany({ where: { role_id: id }, select: { permission_key: true } });
            assertCanGrant(actor, held.map((p) => p.permission_key), 'a role');
            if (normalizedPerms) assertCanGrant(actor, normalizedPerms, 'a role');
        }

        if (newNameRaw !== undefined) {
            const newName = newNameRaw.trim();
            if (newName.length < 2 || newName.length > 64) {
                throw new BadRequestException('Name must be 2–64 characters.');
            }
            if (role.scope === 'system' || oldLower === FULL_LOCK_NAME) {
                throw new BadRequestException('The "Owner" role cannot be renamed.');
            }
            if (newName.toLowerCase() !== oldLower) {
                if (await this.nameTaken(newName, role.organization_id, id)) {
                    throw new ConflictException('Role name must be unique (case-insensitive).');
                }

                await this.prisma.roles.updateMany({ where: { id }, data: { name: newName } });
                role.name = newName;
            }
        }

        if (description !== undefined) {
            await this.prisma.roles.updateMany({ where: { id }, data: { description: description ?? null } });
        }

        if (normalizedPerms !== null) {
            await this.replaceRolePermissions(id, normalizedPerms);
        }
    }

    async remove(roleId: string): Promise<void> {
        if (!isUuid(roleId)) throw new BadRequestException('Invalid role id.');

        const role = await this.fetchRoleById(roleId);
        const lower = role.name.trim().toLowerCase();
        if (role.scope === 'system' || PROTECTED_NAMES.has(lower)) {
            throw new BadRequestException('This role is protected and cannot be deleted.');
        }

        const assigned = await this.prisma.user_roles.findFirst({
            where: { role_id: roleId },
            select: { user_id: true },
        });
        if (assigned) {
            throw new BadRequestException('Cannot delete a role that still has users assigned.');
        }

        await this.prisma.roles.deleteMany({ where: { id: roleId } });
    }

    private async replaceRolePermissions(roleId: string, permissions: Permission[]): Promise<void> {
        await this.prisma.$transaction([
            this.prisma.role_permissions.deleteMany({ where: { role_id: roleId } }),
            this.prisma.role_permissions.createMany({
                data: permissions.map((permission_key) => ({ role_id: roleId, permission_key })),
            }),
        ]);
    }

    /**
     * Case-insensitive name check. Compared here because Prisma's insensitive match is
     * ILIKE, where "_" and "%" in a role name would act as wildcards.
     */
    private async nameTaken(name: string, orgId: string | null, exceptId?: string): Promise<boolean> {
        const roles = await this.prisma.roles.findMany({
            where: {
                ...(exceptId ? { id: { not: exceptId } } : {}),
                OR: [
                    ...(orgId ? [{ scope: 'organization' as const, organization_id: orgId }] : []),
                    { scope: 'system' as const },
                ],
            },
            select: { name: true },
        });
        const lower = name.toLowerCase();
        return roles.some((r) => r.name.toLowerCase() === lower);
    }

    private async fetchRoleById(id: string): Promise<RoleRecord> {
        const role = await this.prisma.roles.findUnique({
            where: { id },
            select: { id: true, name: true, scope: true, organization_id: true, description: true },
        });
        if (!role) throw new NotFoundException('Role not found.');
        return role;
    }
}
