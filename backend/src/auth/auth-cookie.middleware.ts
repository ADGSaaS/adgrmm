import { isChallengePayload } from "./ws-auth.service";
import { getJwtSecret } from "./jwt-secret";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { queryUserIdentityById } from "./user-identity.util";
import { SESSION_END_MESSAGE, loadPolicy, sessionEnd } from "./security-policy";

const SESSION_IDLE_UPDATE_SECS =
    parseInt(process.env.SESSION_IDLE_UPDATE_SECS || "300", 10) || 300;

type DbSessionRow = { revoked_at: Date | null; last_seen_at: Date; created_at: Date };
type DbUserRow = {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    status: string;
    organization_id: string;
    roles: any;
    permissions: string[] | null;
};

function buildDisplayName(first: string | null, last: string | null): string | null {
    const parts = [first?.trim(), last?.trim()].filter(Boolean) as string[];
    if (parts.length === 0) return null;
    return parts.join(" ");
}

@Injectable()
export class AuthCookieMiddleware implements NestMiddleware {
    private readonly cookieName: string;

    constructor(
        private readonly jwt: JwtService,
        private readonly prisma: PrismaService,
    ) {
        this.cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
    }

    async use(req: Request & { user?: any; jti?: string }, res: Response, next: NextFunction) {
        try {
            const token = (req as any).cookies?.[this.cookieName];
            if (!token) return next();

            const payload = await this.jwt.verifyAsync<any>(token, {
                secret: getJwtSecret(),
            });
            if (isChallengePayload(payload)) return next();
            // A jti that cannot name a session could never be revoked, so it does not authenticate.
            if (payload.jti != null && !isCanonicalUuid(String(payload.jti))) return next();

            const userRow = await this.loadUserById(payload.sub);
            if (!userRow || userRow.status !== "active") {
                return next();
            }

            const displayName = buildDisplayName(userRow.first_name, userRow.last_name) || payload.name || null;
            const roles: string[] = Array.isArray(userRow.roles)
                ? userRow.roles.map((r: any) => String(r.name ?? r).trim()).filter(Boolean)
                : [];
            const permissions = Array.isArray(userRow.permissions)
                ? userRow.permissions.map((p) => String(p).toLowerCase())
                : [];
            const primaryRole = roles[0] || payload.role || "user";

            req.user = {
                id: userRow.id,
                email: userRow.email,
                name: displayName,
                organizationId: userRow.organization_id,
                roles,
                role: primaryRole,
                permissions,
            };
            req.jti = payload.jti;

            if (req.jti) {
                let session: DbSessionRow | null;
                try {
                    session = await this.loadSession(req.jti);
                } catch {
                    // Revocation status is unknown, so the session cannot be trusted.
                    delete req.user;
                    delete req.jti;
                    return res.status(401).json({ message: "Session could not be verified." });
                }
                if (session?.revoked_at) {
                    return res.status(401).json({ message: "Session revoked." });
                }
                if (session) {
                    // Checked before last_seen_at is refreshed below, or an idle session would always look fresh.
                    const end = sessionEnd(await loadPolicy(this.prisma, userRow.organization_id), session);
                    if (end) {
                        await this.prisma.sessions.updateMany({ where: { id: req.jti, revoked_at: null }, data: { revoked_at: new Date() } });
                        return res.status(401).json({ message: SESSION_END_MESSAGE[end], code: end });
                    }
                    const lastSeen = session.last_seen_at.getTime();
                    const now = Date.now();
                    if ((now - lastSeen) / 1000 > SESSION_IDLE_UPDATE_SECS) {
                        await this.prisma.sessions.updateMany({
                            where: { id: req.jti },
                            data: { last_seen_at: new Date() },
                        });
                    }
                }
            }
        } catch {
            // ignore broken/expired token; route can still choose to 401
        }
        next();
    }

    private loadSession(id: string): Promise<DbSessionRow | null> {
        return this.prisma.sessions.findUnique({
            where: { id },
            select: { revoked_at: true, last_seen_at: true, created_at: true },
        });
    }

    private async loadUserById(userId: unknown): Promise<DbUserRow | null> {
        try {
            const row = await queryUserIdentityById(this.prisma, userId);
            if (!row) return null;
            return {
                ...row,
                roles: Array.isArray(row.roles) ? row.roles : [],
                permissions: Array.isArray(row.permissions) ? row.permissions : [],
            };
        } catch {
            return null;
        }
    }
}
