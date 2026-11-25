// backend/src/auth/ws-auth.service.ts
import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { IncomingMessage } from "http";
import { PrismaService } from "../storage/prisma.service";
import { agentIdOrUuidWhere, isCanonicalUuid } from "../common/agent-lookup.util";
import { hashAgentToken } from "../common/agent-token.util";
import { getJwtSecret } from "./jwt-secret";
import { permsForRoles } from "./policy";
import { loadPolicy, sessionEnd } from "./security-policy";

export type AgentIdentity = {
    id: string;
    agentUuid: string;
    deviceId: string;
};

export type WsUser = {
    id: string;
    permissions: Set<string>;
};

/** Challenge tokens prove only a password; they must never authenticate a session. */
export function isChallengePayload(payload: any): boolean {
    return payload?.typ === "2fa_challenge";
}

function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (header ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i <= 0) continue;
        const key = part.slice(0, i).trim();
        try {
            out[key] = decodeURIComponent(part.slice(i + 1).trim());
        } catch {
            out[key] = part.slice(i + 1).trim();
        }
    }
    return out;
}

/** Authentication for WebSocket upgrades, which do not pass through the HTTP guards. */
@Injectable()
export class WsAuthService {
    constructor(
        private readonly jwt: JwtService,
        private readonly prisma: PrismaService,
    ) { }

    async authenticateAgent(req: IncomingMessage): Promise<AgentIdentity | null> {
        const header = req.headers.authorization;
        const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
        if (!match) return null;

        const row = await this.prisma.agents.findFirst({
            where: { agent_token: hashAgentToken(match[1]) },
            select: { id: true, agent_uuid: true, device_id: true },
        });
        return row ? { id: row.id, agentUuid: row.agent_uuid, deviceId: row.device_id } : null;
    }

    /** Authenticates the browser's session cookie and loads current permissions. */
    async authenticateUser(req: IncomingMessage): Promise<WsUser | null> {
        const cookieName = process.env.AUTH_COOKIE_NAME?.trim() || "auth_token";
        const token = parseCookies(req.headers.cookie)[cookieName];
        if (!token) return null;

        let payload: any;
        try {
            payload = await this.jwt.verifyAsync(token, { secret: getJwtSecret() });
        } catch {
            return null;
        }
        if (!(await this.isUsableUserToken(payload))) return null;

        const assignments = await this.prisma.user_roles.findMany({
            where: { user_id: String(payload.sub) },
            select: {
                roles: { select: { name: true, role_permissions: { select: { permission_key: true } } } },
            },
        });

        // Same rule as PermissionsGuard: what is stored for the person's roles and groups, and
        // everything for Owner.
        const permissions = new Set<string>();
        const fromGroups = await this.prisma.user_group_permissions.findMany({
            where: { user_groups: { user_group_members: { some: { user_id: String(payload.sub) } } } },
            select: { permission_key: true },
        });
        for (const { permission_key } of fromGroups) if (permission_key) permissions.add(permission_key.toLowerCase());
        const roleNames = new Set<string>();
        for (const { roles: role } of assignments) {
            if (role.name) roleNames.add(role.name.trim().toLowerCase());
            for (const { permission_key } of role.role_permissions) {
                if (permission_key) permissions.add(permission_key.toLowerCase());
            }
        }
        for (const perm of permsForRoles(Array.from(roleNames))) {
            permissions.add(String(perm).toLowerCase());
        }

        return { id: String(payload.sub), permissions };
    }

    /** True when a verified JWT belongs to an active user and an unrevoked session. */
    async isUsableUserToken(payload: any): Promise<boolean> {
        if (!payload?.sub || isChallengePayload(payload)) return false;

        const sub = String(payload.sub);
        if (!isCanonicalUuid(sub)) return false;

        const user = await this.prisma.users.findUnique({ where: { id: sub }, select: { status: true, organization_id: true } });
        if (user?.status !== "active") return false;

        if (payload.jti != null) {
            // A jti that cannot name a session could never be revoked, so it does not authenticate.
            const jti = String(payload.jti);
            if (!isCanonicalUuid(jti)) return false;
            const session = await this.prisma.sessions.findUnique({
                where: { id: jti },
                select: { revoked_at: true, created_at: true, last_seen_at: true },
            });
            if (session?.revoked_at) return false;
            // Same session limits as the HTTP guard, checked when a socket opens.
            if (session && sessionEnd(await loadPolicy(this.prisma, user.organization_id), session)) return false;
        }
        return true;
    }

    /** Resolves agents.id or agents.agent_uuid to the canonical agent_uuid. */
    async resolveAgentUuid(idOrUuid: string): Promise<string | null> {
        return (await this.resolveAgent(idOrUuid))?.agentUuid ?? null;
    }

    /** Resolves agents.id or agents.agent_uuid to the canonical agent_uuid and the device it belongs to (for customer-scope checks). */
    async resolveAgent(idOrUuid: string): Promise<{ agentUuid: string; deviceId: string } | null> {
        if (typeof idOrUuid !== "string" || !idOrUuid) return null;
        const row = await this.prisma.agents.findFirst({
            where: agentIdOrUuidWhere(idOrUuid),
            select: { agent_uuid: true, device_id: true },
        });
        return row ? { agentUuid: row.agent_uuid, deviceId: row.device_id } : null;
    }

    /** Browser sockets must come from a configured console origin when one is set. */
    isOriginAllowed(req: IncomingMessage): boolean {
        const allowed = (process.env.FRONTEND_ORIGINS || process.env.ALLOWED_ORIGIN || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (allowed.length === 0) return process.env.NODE_ENV !== "production";
        return allowed.includes(String(req.headers.origin ?? ""));
    }
}
