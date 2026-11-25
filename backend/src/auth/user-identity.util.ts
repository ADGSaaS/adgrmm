// backend/src/auth/user-identity.util.ts
import { isIP } from "node:net";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../storage/prisma.service";

export type UserIdentityRow = {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    password_hash?: string | null;
    status: string;
    organization_id: string;
    roles: any;
    permissions: string[] | null;
};

/**
 * sessions.ip_address is inet and forwarded headers are client-controlled, so anything
 * that is not a plain address is stored as NULL rather than failing the whole write.
 */
export function toInet(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const ip = value.trim();
    if (!ip || ip.includes("%")) return null; // inet has no IPv6 zone ids
    return isIP(ip) ? ip : null;
}

/**
 * Loads a user with roles and permissions. Raw because this runs on every request and
 * Prisma would split the join into four round trips; roles[0] also depends on this
 * DISTINCT ordering. Casts are needed because raw queries cannot return citext.
 */
export async function queryUserIdentity(
    prisma: PrismaService,
    where: Prisma.Sql,
    opts: { withPasswordHash?: boolean } = {},
): Promise<UserIdentityRow | null> {
    const passwordHash = opts.withPasswordHash ? Prisma.sql`u.password_hash,` : Prisma.empty;
    const rows = await prisma.$queryRaw<UserIdentityRow[]>`
        SELECT
            u.id::text AS id,
            u.email::text AS email,
            u.first_name,
            u.last_name,
            ${passwordHash}
            u.status::text AS status,
            u.organization_id::text AS organization_id,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
                     FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS roles,
            COALESCE((
                SELECT array_agg(DISTINCT p.permission_key)
                FROM (
                    SELECT rp.permission_key
                      FROM public.user_roles ur2
                      JOIN public.role_permissions rp ON rp.role_id = ur2.role_id
                     WHERE ur2.user_id = u.id
                    UNION
                    SELECT gp.permission_key
                      FROM public.user_group_members gm
                      JOIN public.user_group_permissions gp ON gp.group_id = gm.group_id
                     WHERE gm.user_id = u.id
                ) p
            ), '{}'::text[]) AS permissions
        FROM public.users u
        LEFT JOIN public.user_roles ur ON ur.user_id = u.id
        LEFT JOIN public.roles r ON r.id = ur.role_id
        WHERE ${where}
        GROUP BY u.id
        LIMIT 1`;
    return rows[0] ?? null;
}

/** Null for anything that is not a string, since a missing id must never widen a query. */
export function queryUserIdentityById(
    prisma: PrismaService,
    userId: unknown,
    opts: { withPasswordHash?: boolean } = {},
): Promise<UserIdentityRow | null> {
    if (typeof userId !== "string" || !userId) return Promise.resolve(null);
    return queryUserIdentity(prisma, Prisma.sql`u.id = ${userId}::uuid`, opts);
}

/**
 * Removes one recovery code, returning false if it was already gone. Raw because Prisma
 * can only replace a whole array, which would let concurrent requests reuse a code.
 */
export async function consumeRecoveryCodeHash(
    prisma: PrismaService,
    userId: string,
    codeHash: string,
): Promise<boolean> {
    const count = await prisma.$executeRaw`
        UPDATE public.user_security
           SET recovery_codes = array_remove(recovery_codes, ${codeHash}::text)
         WHERE user_id = ${userId}::uuid
           AND ${codeHash}::text = ANY(recovery_codes)`;
    return count === 1;
}
