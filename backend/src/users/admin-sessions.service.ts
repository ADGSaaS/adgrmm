// backend/src/users/admin-sessions.service.ts
// Administration > Sessions: every staff sign-in in the organization, and ending them. People manage their own
// under Account (security.service.ts); this is the same data seen by an administrator.
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { loadPolicy } from "../auth/security-policy";
import type { Actor } from "../access/grant-rules";
import { UsersService } from "./users.service";

type Row = {
    id: string;
    user_id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    user_agent: string | null;
    ip_address: string | null;
    created_at: Date;
    last_seen_at: Date;
    trusted: boolean | null;
    roles: string[] | null;
};

@Injectable()
export class AdminSessionsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly users: UsersService,
    ) { }

    /** Signed-in sessions, most recently used first. Ones the policy has already run out are not shown as live. */
    async list(orgId: string, currentJti: string | undefined, q: { userId?: string; search?: string; limit?: number; offset?: number }) {
        const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 50), 1), 200);
        const offset = Math.max(Math.trunc(Number(q.offset) || 0), 0);
        if (q.userId !== undefined && !isCanonicalUuid(q.userId)) throw new BadRequestException("userId is not valid.");
        const policy = await loadPolicy(this.prisma, orgId);

        const where: Prisma.Sql[] = [Prisma.sql`u.organization_id = ${orgId}::uuid`, Prisma.sql`s.revoked_at IS NULL`];
        if (policy.sessionTimeoutMins > 0) where.push(Prisma.sql`s.created_at > now() - make_interval(mins => ${policy.sessionTimeoutMins}::int)`);
        if (policy.idleTimeoutMins > 0) where.push(Prisma.sql`s.last_seen_at > now() - make_interval(mins => ${policy.idleTimeoutMins}::int)`);
        if (q.userId) where.push(Prisma.sql`s.user_id = ${q.userId}::uuid`);
        const search = typeof q.search === "string" ? q.search.trim().slice(0, 100) : "";
        if (search) {
            const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
            where.push(
                Prisma.sql`(u.email::text ILIKE ${like} OR (coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) ILIKE ${like} OR host(s.ip_address) ILIKE ${like} OR coalesce(s.user_agent, '') ILIKE ${like})`,
            );
        }
        const cond = Prisma.join(where, " AND ");

        const [rows, total] = await Promise.all([
            this.prisma.$queryRaw<Row[]>`
                SELECT s.id::text AS id, s.user_id::text AS user_id, u.email::text AS email, u.first_name, u.last_name,
                       s.user_agent, host(s.ip_address) AS ip_address, s.created_at, s.last_seen_at, s.trusted,
                       (SELECT array_agg(r.name ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles
                  FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE ${cond}
                 ORDER BY s.last_seen_at DESC, s.created_at DESC
                 LIMIT ${limit} OFFSET ${offset}`,
            this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE ${cond}`,
        ]);

        return {
            total: total[0]?.n ?? 0,
            items: rows.map((r) => ({
                id: r.id,
                userId: r.user_id,
                email: r.email,
                name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
                roles: r.roles ?? [],
                userAgent: r.user_agent || "",
                // Node reports IPv4 clients on a dual-stack socket as ::ffff:1.2.3.4.
                ip: r.ip_address ? r.ip_address.replace(/^::ffff:(?=\d+\.)/i, "") : null,
                createdAt: r.created_at,
                lastSeenAt: r.last_seen_at,
                trusted: !!r.trusted,
                current: !!currentJti && r.id === currentJti,
            })),
        };
    }

    /** Ends one session. Your own current one is refused: that is signing out. */
    async revoke(actor: Actor, orgId: string, sessionId: string, currentJti: string | undefined) {
        if (!isCanonicalUuid(sessionId)) throw new NotFoundException("Session not found.");
        const s = await this.prisma.$queryRaw<{ user_id: string; email: string }[]>`
            SELECT s.user_id::text AS user_id, u.email::text AS email FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id = ${sessionId}::uuid AND s.revoked_at IS NULL AND u.organization_id = ${orgId}::uuid`;
        if (!s[0]) throw new NotFoundException("Session not found.");
        if (currentJti && sessionId === currentJti) throw new BadRequestException("That is the session you are using. Sign out instead.");
        await this.users.assertCanEndSessions(actor, s[0].user_id);
        const { count } = await this.prisma.sessions.updateMany({ where: { id: sessionId, revoked_at: null }, data: { revoked_at: new Date() } });
        if (count === 0) throw new NotFoundException("Session not found.");
        return { revoked: count, userId: s[0].user_id, email: s[0].email };
    }

    /** Ends every session of one person (the one the administrator is using stays, if it is their own). */
    async revokeAllOf(actor: Actor, orgId: string, userId: string, currentJti: string | undefined) {
        if (!isCanonicalUuid(userId)) throw new NotFoundException("User not found.");
        const u = await this.prisma.users.findFirst({ where: { id: userId, organization_id: orgId }, select: { id: true, email: true } });
        if (!u) throw new NotFoundException("User not found.");
        await this.users.assertCanEndSessions(actor, userId);
        const keep = actor.id === userId && currentJti && isCanonicalUuid(currentJti) ? currentJti : null;
        const { count } = await this.prisma.sessions.updateMany({
            where: { user_id: userId, revoked_at: null, ...(keep ? { id: { not: keep } } : {}) },
            data: { revoked_at: new Date() },
        });
        return { revoked: count, userId, email: String(u.email) };
    }
}
