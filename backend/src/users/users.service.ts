// backend/src/users/users.service.ts
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { GroupsService } from "../groups/groups.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { Actor, assertCanGrant } from "../access/grant-rules";
import { isOwnerRoleName } from "../auth/policy";
import { queryUserIdentityById } from "../auth/user-identity.util";
import { enforcePasswordPolicy, rememberPassword } from "../auth/password-policy";
import {
    BulkInviteDto,
    CreateUserDto,
    InviteUserDto,
    ListUsersQuery,
    ResetPasswordDto,
    UpdateRoleDto,
    UpdateUserDto,
    UserRow,
} from "./users.dto";

const SALT_ROUNDS = 12;
const NAME_SPLIT_REGEX = /\s+/;
// A person created without a role gets the least powerful built-in one, never a more powerful one.
const DEFAULT_ROLE = "viewer";

// DB status values (canonical)
type DbUserStatus = "active" | "invited" | "disabled";

// Helpers to map API/FE <-> DB
const apiToDbStatus = (input: "active" | "invited" | "suspended"): DbUserStatus =>
    input === "suspended" ? "disabled" : input;

const dbToApiStatus = (db: string): UserRow["status"] =>
    db === "disabled" ? "suspended" : (db as any);

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function coalesceString(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed.length ? trimmed : null;
}

function splitDisplayName(name: string | undefined | null): { first: string | null; last: string | null } {
    if (!name) return { first: null, last: null };
    const trimmed = name?.trim();
    if (!trimmed) return { first: null, last: null };
    const parts = trimmed.split(NAME_SPLIT_REGEX).filter(Boolean);
    if (parts.length === 0) return { first: null, last: null };
    if (parts.length === 1) return { first: parts[0], last: null };
    const last = parts.pop() as string;
    return { first: parts.join(" "), last };
}

type DbUserRow = {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    status: DbUserStatus; // <- DB enum values only
    last_seen_at: Date | null;
    created_at: Date;
    updated_at: Date;
    two_factor_enabled: boolean;
    primary_role_id: string | null;
    primary_role_name: string | null;
    roles: any;
    // extended profile fields (nullable)
    phone?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    state?: string | null;
    postal?: string | null;
    country?: string | null;
    avatar_url?: string | null;
    avatar_thumb_url?: string | null;
};

@Injectable()
export class UsersService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly groups: GroupsService,
        private readonly entitlements: EntitlementsService,
    ) { }

    private mapUserRow(row: DbUserRow): UserRow {
        const roles = Array.isArray(row.roles)
            ? row.roles
                .map((r: any) => ({
                    id: String(r.id ?? ""),
                    name: String(r.name ?? "").trim(),
                }))
                .filter((r) => r.id && r.name)
            : [];

        const primaryRoleName = row.primary_role_name || roles[0]?.name || "";
        const displayNameParts = [row.first_name, row.last_name].map((v) => v?.trim()).filter(Boolean) as string[];
        const displayName = displayNameParts.length
            ? displayNameParts.join(" ")
            : row.email.split("@")[0];

        const apiStatus = dbToApiStatus(row.status);

        return {
            id: row.id,
            name: displayName,
            email: row.email,
            role: primaryRoleName,
            roleId: row.primary_role_id,
            roles,
            status: apiStatus, // expose "suspended" to API/FE
            twoFactorEnabled: !!row.two_factor_enabled,
            suspended: row.status === "disabled", // boolean convenience
            lastSeen: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
            // include optional profile fields for Admin UI
            phone: row.phone ?? null,
            address1: row.address1 ?? null,
            address2: row.address2 ?? null,
            city: row.city ?? null,
            state: row.state ?? null,
            postal: row.postal ?? null,
            country: row.country ?? null,
            avatarUrl: row.avatar_url ?? null,
            avatarThumbUrl: row.avatar_thumb_url ?? null,
        };
    }

    private async ensureUserExists(userId: string): Promise<{ organization_id: string }> {
        const user = await this.prisma.users.findUnique({
            where: { id: userId },
            select: { organization_id: true },
        });
        if (!user) {
            throw new NotFoundException("User not found");
        }
        return user;
    }

    private async ensureUserSecurityRow(userId: string): Promise<void> {
        await this.prisma.user_security.createMany({
            data: [{ user_id: userId }],
            skipDuplicates: true,
        });
    }

    private async replaceUserRoles(userId: string, roleIds: string[]): Promise<void> {
        await this.prisma.$transaction([
            this.prisma.user_roles.deleteMany({ where: { user_id: userId } }),
            this.prisma.user_roles.createMany({
                data: roleIds.map((roleId) => ({ user_id: userId, role_id: roleId })),
            }),
        ]);
    }

    /**
     * The role named or identified by `input`. A role that was asked for but does not exist is an
     * error (it used to fall back silently to whatever role was around, even Admin). With nothing
     * asked for the person gets Viewer, or no role at all if Viewer has been removed.
     */
    private async resolveRole(orgId: string, input?: string | null, emptyMeansNone = false): Promise<{ id: string; name: string } | null> {
        const roles = await this.prisma.roles.findMany({
            where: { OR: [{ scope: "organization" as const, organization_id: orgId }, { scope: "system" as const }] },
            select: { id: true, name: true },
        });
        const trimmed = input?.trim();
        if (trimmed) {
            // Compared here because Prisma's insensitive match is ILIKE, where a role name of "%" would match any role.
            const hit = isUuid(trimmed)
                ? roles.find((r) => r.id === trimmed.toLowerCase())
                : roles.find((r) => r.name.toLowerCase() === trimmed.toLowerCase());
            if (!hit) throw new BadRequestException("That role does not exist.");
            return hit;
        }
        // Choosing "no role" on an existing person takes their role away; leaving it out on a new one gives Viewer.
        if (emptyMeansNone && input !== undefined && input !== null) return null;
        return roles.find((r) => r.name.toLowerCase() === DEFAULT_ROLE) ?? null;
    }

    /** Handing someone a role hands them everything it allows, so you must hold all of it yourself. */
    private async assertRoleGrantable(actor: Actor, role: { id: string; name: string }) {
        if (isOwnerRoleName(role.name) && !actor.owner) throw new ForbiddenException("Only an Owner can give the Owner role.");
        const perms = await this.prisma.role_permissions.findMany({ where: { role_id: role.id }, select: { permission_key: true } });
        assertCanGrant(actor, perms.map((p) => p.permission_key), "a role");
    }

    /** Owners may change anyone; everyone else only people who can do no more than they can. */
    private async assertCanManage(actor: Actor, targetId: string, selfOk: boolean) {
        if (actor.id && actor.id === targetId) {
            if (selfOk) return;
            throw new ForbiddenException("You cannot do that to your own account. Ask another administrator.");
        }
        if (actor.owner) return;
        const target = await queryUserIdentityById(this.prisma, targetId);
        if (!target) throw new NotFoundException("User not found");
        const roles: string[] = (Array.isArray(target.roles) ? target.roles : []).map((r: any) => String(r.name ?? ""));
        if (roles.some(isOwnerRoleName)) throw new ForbiddenException("Only an Owner can change an Owner.");
        const extra = (target.permissions ?? []).filter((p) => !actor.perms.has(String(p).toLowerCase()));
        if (extra.length) throw new ForbiddenException("That person can do things you cannot, so you cannot change their account.");
    }

    /** Whether the actor may end this person's sign-ins: Owners anyone, others only people who can do no more than they can. */
    async assertCanEndSessions(actor: Actor, targetId: string): Promise<void> {
        await this.assertCanManage(actor, targetId, true);
    }

    /** There must always be at least one active Owner. */
    private async assertNotLastOwner(userId: string, orgId: string) {
        const owners = await this.prisma.users.findMany({
            where: { organization_id: orgId, status: "active", user_roles_user_roles_user_idTousers: { some: { roles: { name: { equals: "owner", mode: "insensitive" } } } } },
            select: { id: true },
        });
        if (owners.some((o) => o.id === userId) && owners.length <= 1) {
            throw new BadRequestException("That is the last active Owner. Make someone else an Owner first.");
        }
    }

    private async assertEmailFree(orgId: string, email: string, exceptId?: string) {
        const clash = await this.prisma.users.findFirst({
            where: { organization_id: orgId, email, ...(exceptId ? { id: { not: exceptId } } : {}) },
            select: { id: true },
        });
        if (clash) throw new ConflictException("Someone with that email already exists.");
    }

    /**
     * Raw because the sort keys, search and primary role are all expressions (LOWER,
     * COALESCE, a LATERAL pick of the first role) that Prisma cannot order or filter by.
     */
    private userRowsSql(where: Prisma.Sql, tail: Prisma.Sql): Prisma.Sql {
        return Prisma.sql`
            SELECT
                u.id::text AS id,
                u.email::text AS email,
                u.first_name,
                u.last_name,
                u.status::text AS status,
                u.last_seen_at,
                u.created_at,
                u.updated_at,
                COALESCE(us.two_factor_enabled, false) AS two_factor_enabled,
                pr.id::text AS primary_role_id,
                pr.name AS primary_role_name,
                COALESCE(
                    jsonb_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
                    FILTER (WHERE r.id IS NOT NULL),
                    '[]'::jsonb
                ) AS roles,
                COALESCE(NULLIF(CONCAT_WS(' ', NULLIF(u.first_name, ''), NULLIF(u.last_name, '')), ''), u.email::text) AS display_name,
                u.phone,
                u.address1,
                u.address2,
                u.city,
                u.state,
                u.postal,
                u.country,
                u.avatar_url,
                u.avatar_thumb_url
            FROM public.users u
            LEFT JOIN public.user_security us ON us.user_id = u.id
            LEFT JOIN public.user_roles ur ON ur.user_id = u.id
            LEFT JOIN public.roles r ON r.id = ur.role_id
            LEFT JOIN LATERAL (
                SELECT r2.id, r2.name
                FROM public.user_roles ur2
                JOIN public.roles r2 ON r2.id = ur2.role_id
                WHERE ur2.user_id = u.id
                ORDER BY r2.scope DESC, LOWER(r2.name) ASC
                LIMIT 1
            ) pr ON TRUE
            WHERE ${where}
            GROUP BY u.id, us.two_factor_enabled, pr.id, pr.name
            ${tail}`;
    }

    // Return a single user with extended profile fields for Admin Edit
    async getOne(id: string): Promise<UserRow> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const rows = await this.prisma.$queryRaw<DbUserRow[]>(
            this.userRowsSql(
                Prisma.sql`u.organization_id = ${orgId}::uuid AND u.id = ${id}::uuid`,
                Prisma.sql`LIMIT 1`,
            ),
        );
        if (!rows[0]) throw new NotFoundException("User not found");
        const row = this.mapUserRow(rows[0]);
        row.groups = await this.groups.groupsOfUser(row.id);
        return row;
    }

    async list(q: ListUsersQuery): Promise<{ items: UserRow[]; total: number }> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const where: Prisma.Sql[] = [Prisma.sql`u.organization_id = ${orgId}::uuid`];

        const term = q.q?.trim();
        if (term) {
            const pattern = `%${term.toLowerCase()}%`;
            where.push(Prisma.sql`(
                LOWER(u.email::text) LIKE ${pattern}
                OR LOWER(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) LIKE ${pattern}
            )`);
        }

        if (q.status && q.status !== "all") {
            // Map API 'suspended' -> DB 'disabled'
            const dbStatus: DbUserStatus = apiToDbStatus(q.status as any);
            where.push(Prisma.sql`u.status = ${dbStatus}::public.user_status`);
        }

        if (q.role && q.role !== "all") {
            where.push(
                isUuid(q.role)
                    ? Prisma.sql`EXISTS (
                        SELECT 1
                        FROM public.user_roles urf
                        WHERE urf.user_id = u.id AND urf.role_id = ${q.role}::uuid
                    )`
                    : Prisma.sql`EXISTS (
                        SELECT 1
                        FROM public.user_roles urf
                        JOIN public.roles rf ON rf.id = urf.role_id
                        WHERE urf.user_id = u.id AND LOWER(rf.name) = LOWER(${q.role})
                    )`,
            );
        }

        const whereSql = Prisma.join(where, " AND ");

        const countRows = await this.prisma.$queryRaw<{ c: number }[]>`
            SELECT COUNT(*)::int AS c FROM public.users u WHERE ${whereSql}`;
        const total = countRows[0]?.c ?? 0;

        const sortKeyMap: Record<string, string> = {
            name: "display_name",
            email: "LOWER(u.email::text)",
            role: "LOWER(COALESCE(pr.name, ''))",
            lastSeen: "u.last_seen_at",
        };
        const sortKey = sortKeyMap[q.sortKey ?? "name"] || sortKeyMap.name;
        const sortDir = q.sortDir?.toUpperCase() === "DESC" ? "DESC" : "ASC";

        const page = Math.max(1, q.page ?? 1);
        const pageSize = Math.min(1000, Math.max(1, q.pageSize ?? 25));
        const offset = (page - 1) * pageSize;

        // sortKey and sortDir come from the fixed values above, never from the request.
        const rows = await this.prisma.$queryRaw<DbUserRow[]>(
            this.userRowsSql(
                whereSql,
                Prisma.sql`
                ORDER BY ${Prisma.raw(sortKey)} ${Prisma.raw(sortDir)}, display_name ASC
                LIMIT ${pageSize}
                OFFSET ${offset}`,
            ),
        );
        const items = rows.map((row) => this.mapUserRow(row));
        const byUser = await this.groups.groupsOfUsers(items.map((i) => i.id));
        for (const item of items) item.groups = byUser.get(item.id) ?? [];
        return { items, total };
    }

    async roles(): Promise<{ id: string; name: string }[]> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        // Raw because Prisma cannot order by LOWER(name), and the database collation decides the order.
        const rows = await this.prisma.$queryRaw<{ id: string; name: string }[]>`
            SELECT id::text AS id, name
            FROM public.roles
            WHERE scope = 'system' OR organization_id = ${orgId}::uuid
            ORDER BY scope DESC, LOWER(name) ASC`;
        return rows.map((r) => ({ id: r.id, name: r.name }));
    }

    async inviteOne(actor: Actor, dto: InviteUserDto): Promise<{ id: string }> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const email = dto.email.toLowerCase().trim();
        const existing = await this.prisma.users.findFirst({ where: { organization_id: orgId, email }, select: { id: true, status: true } });
        if (existing && existing.status !== "invited") throw new ConflictException(`${email} already has an account. Edit them instead.`);
        if (existing) await this.assertCanManage(actor, existing.id, false);
        // Inviting someone new takes a technician seat on a hosted plan (re-sending an invite does not: they already hold one).
        if (!existing) await this.entitlements.assertCanAddTechnicians(1);

        const fallbackName = email.split("@")[0];
        const displayName = coalesceString(dto.name) || fallbackName;
        const { first, last } = splitDisplayName(displayName);
        const role = await this.resolveRole(orgId, dto.role);
        if (role) await this.assertRoleGrantable(actor, role);
        const groupIds = dto.groupIds ?? [];
        const passwordHash = await bcrypt.hash(randomUUID(), SALT_ROUNDS);

        const { id } = await this.prisma.users.upsert({
            where: { organization_id_email: { organization_id: orgId, email } },
            create: { organization_id: orgId, email, password_hash: passwordHash, first_name: first, last_name: last, status: "invited" },
            update: { first_name: first, last_name: last },
            select: { id: true },
        });

        await this.ensureUserSecurityRow(id);
        await this.replaceUserRoles(id, role ? [role.id] : []);
        if (groupIds.length) await this.groups.setUserGroups(actor, id, groupIds);

        return { id };
    }

    async inviteBulk(actor: Actor, dto: BulkInviteDto): Promise<{ created: number; skipped: { email: string; reason: string }[] }> {
        let created = 0;
        const skipped: { email: string; reason: string }[] = [];
        if ((dto.invites?.length ?? 0) > 200) throw new BadRequestException("Invite at most 200 people at a time.");
        // On a hosted plan with a technician limit, as many invites are sent as fit, in the order given; the rest are listed in
        // `skipped` with the plan message (each invite checks the seat count again, so the batch never overshoots the limit).
        for (const inv of dto.invites || []) {
            try {
                await this.inviteOne(actor, inv);
                created++;
            } catch (err: any) {
                skipped.push({ email: String(inv?.email ?? ""), reason: String(err?.response?.message ?? err?.message ?? "Could not invite") });
            }
        }
        return { created, skipped };
    }

    async updateRole(actor: Actor, id: string, dto: UpdateRoleDto): Promise<void> {
        const user = await this.ensureUserExists(id);
        await this.assertCanManage(actor, id, false);
        const role = await this.resolveRole(user.organization_id, dto.role, true);
        if (role) await this.assertRoleGrantable(actor, role);
        if (!role || !isOwnerRoleName(role.name)) await this.assertNotLastOwner(id, user.organization_id);
        await this.replaceUserRoles(id, role ? [role.id] : []);
    }

    async setSuspended(actor: Actor, id: string, suspended: boolean): Promise<void> {
        const user = await this.ensureUserExists(id);
        await this.assertCanManage(actor, id, false);
        if (suspended) await this.assertNotLastOwner(id, user.organization_id);
        // Turning a disabled person back on takes a technician seat on a hosted plan. Suspending never needs one.
        if (!suspended) {
            const now = await this.prisma.users.findUnique({ where: { id }, select: { status: true } });
            if (now?.status === "disabled") await this.entitlements.assertCanAddTechnicians(1);
        }
        const status: DbUserStatus = suspended ? "disabled" : "active"; // <- WRITE DB-SAFE VALUE
        const { count } = await this.prisma.users.updateMany({
            where: { id },
            data: { status, updated_at: new Date() },
        });
        if (count === 0) throw new NotFoundException("User not found");
        if (suspended) await this.revokeSessions(id);
    }

    async reset2fa(actor: Actor, id: string): Promise<void> {
        await this.ensureUserExists(id);
        await this.assertCanManage(actor, id, true);
        await this.prisma.user_security.upsert({
            where: { user_id: id },
            create: { user_id: id, two_factor_enabled: false, totp_secret: null, recovery_codes: [] },
            update: { two_factor_enabled: false, totp_secret: null, recovery_codes: [] },
        });
    }

    /** Ends every sign-in of a person, so a changed password or a suspension takes hold at once. */
    private async revokeSessions(userId: string) {
        await this.prisma.sessions.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: new Date() } });
    }

    async remove(actor: Actor, id: string): Promise<void> {
        const user = await this.ensureUserExists(id);
        await this.assertCanManage(actor, id, false);
        await this.assertNotLastOwner(id, user.organization_id);
        try {
            const { count } = await this.prisma.users.deleteMany({ where: { id } });
            if (count === 0) throw new NotFoundException("User not found");
        } catch (err: any) {
            if (err?.code === "P2003" || err?.code === "P2014") {
                throw new ConflictException("That person has tickets, jobs or other history. Suspend them instead of deleting.");
            }
            throw err;
        }
    }

    async createOne(actor: Actor, dto: CreateUserDto): Promise<{ id: string }> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const email = dto.email.toLowerCase().trim();
        const inputStatus = dto.status ?? "active";
        // Validate API status, then map to DB-safe
        if (!["active", "invited", "suspended"].includes(inputStatus)) {
            throw new BadRequestException("Invalid status");
        }
        const dbStatus: DbUserStatus = apiToDbStatus(inputStatus);
        // An account created switched off holds no seat; any other takes a technician seat on a hosted plan.
        if (dbStatus !== "disabled") await this.entitlements.assertCanAddTechnicians(1);
        // An existing account is never overwritten from here: that would silently replace its password and roles.
        await this.assertEmailFree(orgId, email);
        // The password rules from Security Policies apply to every staff password that is set.
        await enforcePasswordPolicy(this.prisma, orgId, null, dto.password);

        const displayName = coalesceString(dto.name) || email.split("@")[0];
        const { first, last } = splitDisplayName(displayName);
        const role = await this.resolveRole(orgId, dto.role);
        if (role) await this.assertRoleGrantable(actor, role);
        const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

        const { id } = await this.prisma.users.create({
            data: { organization_id: orgId, email, password_hash: passwordHash, first_name: first, last_name: last, status: dbStatus },
            select: { id: true },
        });
        await rememberPassword(this.prisma, id, passwordHash);

        await this.ensureUserSecurityRow(id);
        await this.prisma.user_security.updateMany({
            where: { user_id: id },
            data: { password_changed_at: new Date() },
        });

        await this.replaceUserRoles(id, role ? [role.id] : []);
        if (dto.groupIds?.length) await this.groups.setUserGroups(actor, id, dto.groupIds);

        return { id };
    }

    async setPassword(actor: Actor, id: string, body: ResetPasswordDto): Promise<void> {
        const target = await this.ensureUserExists(id);
        await this.assertCanManage(actor, id, true);
        await enforcePasswordPolicy(this.prisma, target.organization_id, id, body.password);

        const hash = await bcrypt.hash(body.password, SALT_ROUNDS);
        const now = new Date();
        const { count } = await this.prisma.users.updateMany({
            where: { id },
            data: { password_hash: hash, updated_at: now },
        });
        if (count === 0) throw new NotFoundException("User not found");
        await rememberPassword(this.prisma, id, hash);

        await this.prisma.user_security.upsert({
            where: { user_id: id },
            create: { user_id: id, password_changed_at: now },
            update: { password_changed_at: now },
        });
        // Anyone who knew the old password is signed out. Resetting your own keeps you signed in.
        if (actor.id !== id) await this.revokeSessions(id);
    }

    async updateUser(actor: Actor, id: string, dto: UpdateUserDto): Promise<void> {
        const user = await this.ensureUserExists(id);
        await this.assertCanManage(actor, id, true);
        const data: Prisma.usersUpdateManyMutationInput = {};

        if (dto.role !== undefined) {
            // The edit form sends the role every time; only a real change is a role change.
            const current = (await this.prisma.user_roles.findMany({ where: { user_id: id }, select: { role_id: true } })).map((r) => r.role_id);
            const wanted = await this.resolveRole(user.organization_id, dto.role, true);
            const same = wanted ? current.length === 1 && current[0] === wanted.id : current.length === 0;
            if (!same) await this.updateRole(actor, id, { role: dto.role });
        }

        if (dto.name !== undefined) {
            const { first, last } = splitDisplayName(dto.name);
            data.first_name = first;
            data.last_name = last;
        }

        if (dto.email !== undefined) {
            const email = dto.email.trim().toLowerCase();
            await this.assertEmailFree(user.organization_id, email, id);
            data.email = email;
        }

        const optionalMap = {
            phone: "phone",
            address1: "address1",
            address2: "address2",
            city: "city",
            state: "state",
            postal: "postal",
            country: "country",
            avatarUrl: "avatar_url",
            avatarThumbUrl: "avatar_thumb_url",
        } as const;

        for (const [key, column] of Object.entries(optionalMap)) {
            const value = (dto as any)[key];
            if (value !== undefined) data[column] = value;
        }

        if (Object.keys(data).length === 0) {
            return;
        }

        const { count } = await this.prisma.users.updateMany({
            where: { id },
            data: { ...data, updated_at: new Date() },
        });
        if (count === 0) throw new NotFoundException("User not found");
    }
}
