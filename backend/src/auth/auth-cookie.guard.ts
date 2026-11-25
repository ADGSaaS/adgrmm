import { isChallengePayload } from "./ws-auth.service";
import { getJwtSecret } from "./jwt-secret";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { queryUserIdentityById, toInet } from "./user-identity.util";
import { randomUUID, createHash } from "crypto";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { SESSION_END_MESSAGE, loadPolicy, sessionEnd } from "./security-policy";

function parseCookieMaxAge(): number {
  const v = process.env.AUTH_COOKIE_MAX_AGE_MS;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 7 * 24 * 60 * 60 * 1000;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

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

function buildDisplayName(
  first: string | null,
  last: string | null,
  fallback?: string | null
): string | null {
  const parts = [first?.trim(), last?.trim()].filter(Boolean) as string[];
  if (parts.length > 0) return parts.join(" ");
  return fallback ?? null;
}

function isPublicRequest(req: Request): boolean {
  // Express: req.path excludes query string; req.originalUrl includes it.
  const path = (req as any).path || req.url || "";
  const method = (req.method || "GET").toUpperCase();

  // AuthCookieGuard
  if (method === "GET" && path.startsWith("/api/provisioning/installer-bundles/") && path.includes("/download")) return true;


  // Swagger (dev only, mounted at /docs). NOT /api/docs: that path belongs to the IT Docs API (vault, documents, assets), which needs sign-in.
  if (path === "/docs" || path.startsWith("/docs/")) return true;
  if (path === "/docs-json") return true;

  // Static assets (ServeStaticModule/useStaticAssets usually bypass guards, but allow anyway)
  if (path.startsWith("/static/")) return true;

  // Health endpoints
  if (method === "GET" && path === "/healthz") return true;
  if (method === "GET" && path === "/healthz/email") return true;
  if (method === "GET" && path === "/healthz/ping") return true; // ✅ moved common health check

  // Auth endpoints that must be reachable without an existing session
  if (method === "POST" && path === "/api/auth/login") return true;
  if (method === "POST" && path === "/api/auth/2fa/verify") return true;
  if (method === "POST" && path === "/api/auth/logout") return true;
  if (method === "GET" && path === "/api/branding") return true;

  // ✅ Optional legacy auth routes (if you keep /api/auth-legacy enabled)
  if (method === "POST" && path === "/api/auth-legacy/login") return true;
  if (method === "POST" && path === "/api/auth-legacy/2fa/verify") return true;
  if (method === "POST" && path === "/api/auth-legacy/logout") return true;

  return false;
}

@Injectable()
export class AuthCookieGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService
  ) { }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    // 1) Explicit allowlist via decorator
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // 2) Path-based allowlist (keeps system working even before we annotate controllers)
    if (isPublicRequest(req)) return true;

    const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
    const tokenFromCookie =
      (req as any).cookies?.[cookieName] || (req as any).cookies?.["auth_token"];
    const tokenFromHeader =
      req.headers.authorization?.replace(/^Bearer\s+/i, "") || null;

    const token = tokenFromCookie || tokenFromHeader;
    if (!token) throw new UnauthorizedException("No auth token provided");

    // Record which credential source actually authenticated this request.
    // Security-sensitive human-session endpoints require cookie auth and
    // explicitly reject bearer/API-key automation paths.
    (req as any).authSource = tokenFromCookie ? "cookie" : "bearer";

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: getJwtSecret(),
      });
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
    if (!payload?.sub) throw new UnauthorizedException("Invalid token payload");
    if (isChallengePayload(payload)) throw new UnauthorizedException("Invalid token");
    // A jti that cannot name a session could never be revoked, so it does not authenticate.
    if (payload.jti != null && !isCanonicalUuid(String(payload.jti))) {
      throw new UnauthorizedException("Invalid token");
    }

    // A session that was revoked, or never existed, ends the token, however it is presented.
    let session: { revoked_at: Date | null; user_id: string; created_at: Date; last_seen_at: Date } | null = null;
    if (payload.jti != null) {
      session = await this.prisma.sessions.findUnique({
        where: { id: String(payload.jti) },
        select: { revoked_at: true, user_id: true, created_at: true, last_seen_at: true },
      });
      if (!session || session.revoked_at || session.user_id !== String(payload.sub)) {
        throw new UnauthorizedException("Session has ended");
      }
    }

    const userRow = await this.loadUserById(String(payload.sub));
    if (!userRow || userRow.status !== "active") {
      throw new UnauthorizedException("Account disabled");
    }

    // The session limits from Security Policies: too long signed in, or too long without a request.
    if (session && payload.jti != null) {
      const end = sessionEnd(await loadPolicy(this.prisma, userRow.organization_id), session);
      if (end) {
        await this.prisma.sessions
          .updateMany({ where: { id: String(payload.jti), revoked_at: null }, data: { revoked_at: new Date() } })
          .catch(() => { });
        throw new UnauthorizedException(SESSION_END_MESSAGE[end]);
      }
    }

    const roles: string[] = Array.isArray(userRow.roles)
      ? userRow.roles
        .map((r: any) => String(r.name ?? r).trim())
        .filter(Boolean)
      : [];
    const permissions = Array.isArray(userRow.permissions)
      ? userRow.permissions.map((p) => String(p).toLowerCase())
      : [];

    const displayName = buildDisplayName(
      userRow.first_name,
      userRow.last_name,
      payload.name
    );
    const primaryRole = roles[0] || payload.role || "user";

    (req as any).user = {
      id: userRow.id,
      email: userRow.email,
      name: displayName,
      organizationId: userRow.organization_id,
      roles,
      role: primaryRole,
      permissions,
    };

    let jti: string | null = payload?.jti != null ? String(payload.jti) : null;
    if (!jti) {
      jti = randomUUID();
      const newToken = await this.jwt.signAsync({
        sub: payload.sub,
        email: payload.email,
        name: displayName,
        role: primaryRole,
        org: userRow.organization_id,
        perms: permissions,
        jti,
      });

      res.cookie(cookieName, newToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
        maxAge: parseCookieMaxAge(),
      });

      const ipHdr = (req.headers["x-forwarded-for"] as string) || "";
      const ip = toInet(ipHdr.split(",")[0] || req.ip);
      const ua = req.get("user-agent") || null;

      await this.upsertSession(userRow.id, jti, ua, ip, hashToken(newToken));
    }

    (req as any).jti = jti;

    if (jti) {
      const ipHdr = (req.headers["x-forwarded-for"] as string) || "";
      const ip = toInet(ipHdr.split(",")[0] || req.ip);
      const ua = req.get("user-agent") || null;
      this.prisma.sessions
        .updateMany({
          where: { id: jti, revoked_at: null },
          data: {
            last_seen_at: new Date(),
            ...(ip ? { ip_address: ip } : {}),
            ...(ua ? { user_agent: ua } : {}),
          },
        })
        .catch(() => { });
    }

    return true;
  }

  private async upsertSession(
    userId: string,
    sessionId: string,
    ua: string | null,
    ip: string | null,
    tokenHash: string
  ) {
    await this.prisma.sessions.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        user_id: userId,
        refresh_token: tokenHash,
        user_agent: ua,
        ip_address: ip,
      },
      update: {
        last_seen_at: new Date(),
        refresh_token: tokenHash,
        ...(ua ? { user_agent: ua } : {}),
        ...(ip ? { ip_address: ip } : {}),
      },
    });
  }

  private async loadUserById(userId: string): Promise<DbUserRow | null> {
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
