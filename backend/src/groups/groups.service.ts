// Groups: a named team of people with their own permissions and their own view of customers.
//
//  - A person's permissions are their role's plus those of every group they are in. Groups only add.
//  - A person's view of customers is their own limit plus every group's. If neither they nor any of
//    their groups name any customer, site or tag, they see everything, as before.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { ALL_PERMISSIONS, PERMISSION_DEFINITIONS } from "../auth/policy";
import { Actor, assertCanGrant } from "../access/grant-rules";

export type ScopeKind = "customer" | "site" | "tag";
export type ScopeItem = { kind: ScopeKind; id: string; name?: string; customer?: string };

export type GroupDto = {
    id: string;
    name: string;
    description: string | null;
    memberCount: number;
    permissions: string[];
    scope: ScopeItem[];
    createdAt: string;
    updatedAt: string;
};

export type GroupInput = {
    name?: string;
    description?: string | null;
    permissions?: string[];
    scope?: { kind: string; id: string }[];
    memberIds?: string[];
};

const KINDS = new Set<string>(["customer", "site", "tag"]);
const VALID = new Set<string>(ALL_PERMISSIONS);
const LABEL = new Map(PERMISSION_DEFINITIONS.map((d) => [d.key as string, { label: d.label, group: d.groupLabel }]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class GroupsService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    private cleanName(raw: unknown): string {
        const name = String(raw ?? "").trim().replace(/\s+/g, " ");
        if (name.length < 2 || name.length > 64) throw new BadRequestException("Name must be 2 to 64 characters.");
        return name;
    }

    private cleanPerms(raw: unknown): string[] {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) throw new BadRequestException("Permissions must be a list.");
        const out = new Set<string>();
        const bad: string[] = [];
        for (const p of raw) {
            const key = String(p ?? "").trim().toLowerCase();
            if (!key) continue;
            if (!VALID.has(key)) bad.push(key); else out.add(key);
        }
        if (bad.length) throw new BadRequestException(`Unknown permission(s): ${bad.join(", ")}`);
        return [...out];
    }

    private async cleanScope(orgId: string, raw: unknown): Promise<{ kind: ScopeKind; id: string }[]> {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) throw new BadRequestException("Access must be a list.");
        if (raw.length > 500) throw new BadRequestException("That is too many customers, sites and tags.");
        const seen = new Set<string>();
        const items: { kind: ScopeKind; id: string }[] = [];
        for (const r of raw) {
            const kind = String((r as any)?.kind ?? "");
            const id = String((r as any)?.id ?? "");
            if (!KINDS.has(kind) || !UUID.test(id)) throw new BadRequestException("Each access entry needs a customer, site or tag.");
            const k = `${kind}:${id.toLowerCase()}`;
            if (seen.has(k)) continue;
            seen.add(k);
            items.push({ kind: kind as ScopeKind, id: id.toLowerCase() });
        }
        const ids = (kind: ScopeKind) => items.filter((i) => i.kind === kind).map((i) => i.id);
        const [clients, sites, tags] = await Promise.all([
            this.prisma.clients.findMany({ where: { id: { in: ids("customer") }, organization_id: orgId }, select: { id: true } }),
            this.prisma.sites.findMany({ where: { id: { in: ids("site") }, clients: { organization_id: orgId } }, select: { id: true } }),
            this.prisma.tag_defs.findMany({ where: { id: { in: ids("tag") }, organization_id: orgId }, select: { id: true } }),
        ]);
        if (clients.length !== ids("customer").length) throw new BadRequestException("One of those customers does not exist.");
        if (sites.length !== ids("site").length) throw new BadRequestException("One of those sites does not exist.");
        if (tags.length !== ids("tag").length) throw new BadRequestException("One of those tags does not exist.");
        return items;
    }

    private async usersInOrg(orgId: string, ids: string[]): Promise<string[]> {
        const unique = [...new Set(ids.map(String))];
        if (!unique.length) return [];
        if (unique.some((i) => !UUID.test(i))) throw new BadRequestException("One of those people does not exist.");
        const found = await this.prisma.users.findMany({ where: { id: { in: unique }, organization_id: orgId }, select: { id: true } });
        if (found.length !== unique.length) throw new BadRequestException("One of those people does not exist.");
        return unique;
    }

    /** The catalogue rows the permission foreign key points at. Normally written at start-up. */
    private async ensureCatalog() {
        await this.prisma.permissions.createMany({
            data: PERMISSION_DEFINITIONS.map((d) => ({ permission_key: d.key, label: d.label, group_key: d.groupKey, group_label: d.groupLabel })),
            skipDuplicates: true,
        });
    }

    private async nameTaken(orgId: string, name: string, exceptId?: string) {
        const rows = await this.prisma.user_groups.findMany({ where: { organization_id: orgId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { name: true } });
        return rows.some((r) => r.name.toLowerCase() === name.toLowerCase());
    }

    private async scopeNames(items: { kind: string; id: string }[]): Promise<Map<string, { name: string; customer?: string }>> {
        const ids = (k: string) => [...new Set(items.filter((i) => i.kind === k).map((i) => i.id))];
        const [clients, sites, tags] = await Promise.all([
            this.prisma.clients.findMany({ where: { id: { in: ids("customer") } }, select: { id: true, name: true } }),
            this.prisma.sites.findMany({ where: { id: { in: ids("site") } }, select: { id: true, name: true, clients: { select: { name: true } } } }),
            this.prisma.tag_defs.findMany({ where: { id: { in: ids("tag") } }, select: { id: true, name: true } }),
        ]);
        const out = new Map<string, { name: string; customer?: string }>();
        for (const c of clients) out.set(`customer:${c.id}`, { name: c.name });
        for (const s of sites) out.set(`site:${s.id}`, { name: s.name, customer: s.clients?.name });
        for (const t of tags) out.set(`tag:${t.id}`, { name: t.name });
        return out;
    }

    private toDto(g: any, names: Map<string, { name: string; customer?: string }>): GroupDto {
        return {
            id: g.id,
            name: g.name,
            description: g.description ?? null,
            memberCount: g._count?.user_group_members ?? 0,
            permissions: (g.user_group_permissions ?? []).map((p: any) => p.permission_key).sort(),
            scope: (g.user_group_scope ?? [])
                .map((s: any) => ({ kind: s.kind as ScopeKind, id: s.target_id, name: names.get(`${s.kind}:${s.target_id}`)?.name ?? "(removed)", customer: names.get(`${s.kind}:${s.target_id}`)?.customer }))
                .sort((a: ScopeItem, b: ScopeItem) => a.kind.localeCompare(b.kind) || String(a.name).localeCompare(String(b.name))),
            createdAt: new Date(g.created_at).toISOString(),
            updatedAt: new Date(g.updated_at).toISOString(),
        };
    }

    private readonly include = { user_group_permissions: true, user_group_scope: true, _count: { select: { user_group_members: true } } } as const;

    async list(): Promise<GroupDto[]> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const rows = await this.prisma.user_groups.findMany({ where: { organization_id: orgId }, include: this.include });
        const names = await this.scopeNames(rows.flatMap((g) => g.user_group_scope.map((s) => ({ kind: s.kind, id: s.target_id }))));
        return rows.map((g) => this.toDto(g, names)).sort((a, b) => a.name.localeCompare(b.name));
    }

    async get(id: string): Promise<GroupDto & { members: { id: string; name: string; email: string; status: string }[] }> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        if (!UUID.test(id)) throw new NotFoundException("Group not found.");
        const g = await this.prisma.user_groups.findFirst({ where: { id, organization_id: orgId }, include: this.include });
        if (!g) throw new NotFoundException("Group not found.");
        const names = await this.scopeNames(g.user_group_scope.map((s) => ({ kind: s.kind, id: s.target_id })));
        const members = await this.prisma.user_group_members.findMany({
            where: { group_id: id },
            select: { users: { select: { id: true, email: true, first_name: true, last_name: true, status: true } } },
        });
        return {
            ...this.toDto(g, names),
            members: members
                .map((m) => ({ id: m.users.id, email: String(m.users.email), name: [m.users.first_name, m.users.last_name].filter(Boolean).join(" ") || String(m.users.email).split("@")[0], status: m.users.status === "disabled" ? "suspended" : String(m.users.status) }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    async create(actor: Actor, input: GroupInput): Promise<{ id: string }> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const name = this.cleanName(input.name);
        if (await this.nameTaken(orgId, name)) throw new ConflictException("A group with that name already exists.");
        const permissions = this.cleanPerms(input.permissions);
        assertCanGrant(actor, permissions, "a group permission");
        const scope = await this.cleanScope(orgId, input.scope);
        const memberIds = await this.usersInOrg(orgId, input.memberIds ?? []);
        await this.ensureCatalog();
        const g = await this.prisma.user_groups.create({ data: { organization_id: orgId, name, description: String(input.description ?? "").trim() || null }, select: { id: true } });
        await this.writeParts(g.id, { permissions, scope, memberIds });
        return { id: g.id };
    }

    async update(actor: Actor, id: string, input: GroupInput): Promise<void> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        if (!UUID.test(id)) throw new NotFoundException("Group not found.");
        const current = await this.prisma.user_groups.findFirst({ where: { id, organization_id: orgId }, include: { user_group_permissions: true } });
        if (!current) throw new NotFoundException("Group not found.");

        const data: { name?: string; description?: string | null; updated_at: Date } = { updated_at: new Date() };
        if (input.name !== undefined) {
            const name = this.cleanName(input.name);
            if (await this.nameTaken(orgId, name, id)) throw new ConflictException("A group with that name already exists.");
            data.name = name;
        }
        if (input.description !== undefined) data.description = String(input.description ?? "").trim() || null;

        let permissions: string[] | undefined;
        if (input.permissions !== undefined) {
            permissions = this.cleanPerms(input.permissions);
            const had = new Set(current.user_group_permissions.map((p) => p.permission_key));
            assertCanGrant(actor, permissions.filter((p) => !had.has(p)), "a group permission");
        }
        const scope = input.scope !== undefined ? await this.cleanScope(orgId, input.scope) : undefined;
        if (permissions || input.memberIds !== undefined) {
            // Putting someone into a group hands them everything the group can do.
            assertCanGrant(actor, (permissions ?? current.user_group_permissions.map((p) => p.permission_key)), "a group's permissions");
        }
        const memberIds = input.memberIds !== undefined ? await this.usersInOrg(orgId, input.memberIds) : undefined;
        await this.ensureCatalog();
        await this.prisma.user_groups.update({ where: { id }, data });
        await this.writeParts(id, { permissions, scope, memberIds });
    }

    private async writeParts(id: string, parts: { permissions?: string[]; scope?: { kind: ScopeKind; id: string }[]; memberIds?: string[] }) {
        const ops: any[] = [];
        if (parts.permissions) {
            ops.push(this.prisma.user_group_permissions.deleteMany({ where: { group_id: id } }));
            ops.push(this.prisma.user_group_permissions.createMany({ data: parts.permissions.map((permission_key) => ({ group_id: id, permission_key })) }));
        }
        if (parts.scope) {
            ops.push(this.prisma.user_group_scope.deleteMany({ where: { group_id: id } }));
            ops.push(this.prisma.user_group_scope.createMany({ data: parts.scope.map((s) => ({ group_id: id, kind: s.kind, target_id: s.id })) }));
        }
        if (parts.memberIds) {
            ops.push(this.prisma.user_group_members.deleteMany({ where: { group_id: id } }));
            ops.push(this.prisma.user_group_members.createMany({ data: parts.memberIds.map((user_id) => ({ group_id: id, user_id })) }));
        }
        if (ops.length) await this.prisma.$transaction(ops);
    }

    async remove(id: string): Promise<void> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        if (!UUID.test(id)) throw new NotFoundException("Group not found.");
        const { count } = await this.prisma.user_groups.deleteMany({ where: { id, organization_id: orgId } });
        if (count === 0) throw new NotFoundException("Group not found.");
    }

    /** Replaces one person's groups. Adding a group is giving what it can do, so the actor must hold it. */
    async setUserGroups(actor: Actor, userId: string, groupIds: string[]): Promise<void> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const user = await this.prisma.users.findFirst({ where: { id: userId, organization_id: orgId }, select: { id: true } });
        if (!user) throw new NotFoundException("User not found");
        const wanted = [...new Set((groupIds ?? []).map(String))];
        if (wanted.length > 50) throw new BadRequestException("That is too many groups for one person.");
        if (wanted.some((g) => !UUID.test(g))) throw new BadRequestException("One of those groups does not exist.");
        const groups = await this.prisma.user_groups.findMany({ where: { id: { in: wanted }, organization_id: orgId }, include: { user_group_permissions: true } });
        if (groups.length !== wanted.length) throw new BadRequestException("One of those groups does not exist.");
        const already = new Set((await this.prisma.user_group_members.findMany({ where: { user_id: userId }, select: { group_id: true } })).map((m) => m.group_id));
        for (const g of groups) if (!already.has(g.id)) assertCanGrant(actor, g.user_group_permissions.map((p) => p.permission_key), `the "${g.name}" group's permissions`);
        await this.prisma.$transaction([
            this.prisma.user_group_members.deleteMany({ where: { user_id: userId, group_id: { notIn: wanted } } }),
            this.prisma.user_group_members.createMany({ data: wanted.map((group_id) => ({ group_id, user_id: userId })), skipDuplicates: true }),
        ]);
    }

    async groupsOfUser(userId: string): Promise<{ id: string; name: string }[]> {
        const rows = await this.prisma.user_group_members.findMany({ where: { user_id: userId }, select: { user_groups: { select: { id: true, name: true } } } });
        return rows.map((r) => r.user_groups).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** For the user list: every person's groups in one query. */
    async groupsOfUsers(userIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
        const out = new Map<string, { id: string; name: string }[]>();
        if (!userIds.length) return out;
        const rows = await this.prisma.user_group_members.findMany({ where: { user_id: { in: userIds } }, select: { user_id: true, user_groups: { select: { id: true, name: true } } } });
        for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.user_groups]);
        for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    /**
     * Everything a person can do and see, and where each piece comes from: their role, a group, or
     * a limit set on them directly. This is what the Users screen shows, so "why can they do that?"
     * has an answer.
     */
    async accessOf(userId: string) {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const user = await this.prisma.users.findFirst({
            where: { id: userId, organization_id: orgId },
            select: {
                id: true,
                user_roles_user_roles_user_idTousers: { select: { roles: { select: { id: true, name: true, role_permissions: { select: { permission_key: true } } } } } },
                user_group_members: { select: { user_groups: { select: { id: true, name: true, user_group_permissions: true, user_group_scope: true } } } },
            },
        });
        if (!user) throw new NotFoundException("User not found");

        const roles = user.user_roles_user_roles_user_idTousers.map((r) => r.roles);
        const groups = user.user_group_members.map((m) => m.user_groups);
        const owner = roles.some((r) => r.name.trim().toLowerCase() === "owner");

        const sources = new Map<string, { kind: "role" | "group"; name: string }[]>();
        const add = (key: string, from: { kind: "role" | "group"; name: string }) => {
            const list = sources.get(key) ?? [];
            if (!list.some((s) => s.kind === from.kind && s.name === from.name)) list.push(from);
            sources.set(key, list);
        };
        for (const r of roles) {
            const keys = owner && r.name.trim().toLowerCase() === "owner" ? ALL_PERMISSIONS : r.role_permissions.map((p) => p.permission_key);
            for (const k of keys) add(k, { kind: "role", name: r.name });
        }
        for (const g of groups) for (const p of g.user_group_permissions) add(p.permission_key, { kind: "group", name: g.name });

        const personal = await this.prisma.user_client_access.findMany({ where: { user_id: userId }, select: { client_id: true } });
        const raw: { from: { kind: "person" | "group"; name: string }; kind: ScopeKind; id: string }[] = [
            ...personal.map((p) => ({ from: { kind: "person" as const, name: "Set on this person" }, kind: "customer" as ScopeKind, id: p.client_id })),
            ...groups.flatMap((g) => g.user_group_scope.map((s) => ({ from: { kind: "group" as const, name: g.name }, kind: s.kind as ScopeKind, id: s.target_id }))),
        ];
        const names = await this.scopeNames(raw);

        return {
            owner,
            permissions: [...sources.entries()]
                .map(([key, from]) => ({ key, label: LABEL.get(key)?.label ?? key, group: LABEL.get(key)?.group ?? "Other", from }))
                .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label)),
            limited: raw.length > 0,
            scope: raw.map((r) => ({ ...r, name: names.get(`${r.kind}:${r.id}`)?.name ?? "(removed)", customer: names.get(`${r.kind}:${r.id}`)?.customer })),
            groups: groups.map((g) => ({ id: g.id, name: g.name })),
            roles: roles.map((r) => ({ id: r.id, name: r.name })),
        };
    }
}
