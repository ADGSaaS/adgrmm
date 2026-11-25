import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_PERM_KEY, RequirePermMetadata } from "./require-perm.decorator";
import { PrismaService } from "../storage/prisma.service";
import { permsForRoles } from "./policy";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { AuditService } from "../audit/audit.service";
import { adminKeyMatches } from "../common/admin-key";

function getReqPath(req: any): string {
  const raw: string = req?.path || req?.url || req?.originalUrl || "";
  const q = raw.indexOf("?");
  const path = q >= 0 ? raw.slice(0, q) : raw;
  return path || "";
}

/**
 * Minimal endpoints that MUST remain reachable without req.user.
 * These are intentionally tiny and safe:
 * - docs/health/static
 * - branding fetch (login theming)
 * - login + 2FA verify + logout
 * - agent endpoints (use their own auth model)
 */
function isAlwaysPublicRequest(req: any): boolean {
  const path = getReqPath(req);
  const method = String(req?.method || "GET").toUpperCase();

  // Swagger (dev only, mounted at /docs). NOT /api/docs: that path belongs to the IT Docs API (vault, documents, assets), whose rights are checked.
  if (path === "/docs" || path.startsWith("/docs/")) return true;
  if (path === "/docs-json") return true;

  // Static
  if (path.startsWith("/static/")) return true;

  // Health
  if (method === "GET" && path === "/healthz") return true;
  if (method === "GET" && path === "/healthz/email") return true;

  // Branding fetch for login page
  if (method === "GET" && path === "/api/branding") return true;

  // Auth bootstrap routes
  if (method === "POST" && path === "/api/auth/login") return true;
  if (method === "POST" && path === "/api/auth/2fa/verify") return true;
  if (method === "POST" && path === "/api/auth/logout") return true;

  // Auth "me" is intentionally safe to expose unauthenticated (it returns {user:null} without a token)
  if (method === "GET" && path === "/api/auth/me") return true;

  // Optional legacy auth routes (if you keep /api/auth-legacy enabled)
  if (method === "POST" && path === "/api/auth-legacy/login") return true;
  if (method === "POST" && path === "/api/auth-legacy/2fa/verify") return true;
  if (method === "POST" && path === "/api/auth-legacy/logout") return true;

  // Agent endpoints authenticate with agent tokens (not req.user)
  if (path.startsWith("/api/agent")) return true;

  return false;
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: PrismaService,
    private readonly audit: AuditService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<any>();
    const path = getReqPath(req);

    // 0) Break-glass / automation admin API key (bypass everything)
    const apiKey =
      req.header?.("x-admin-api-key") ?? req.headers?.["x-admin-api-key"];
    if (adminKeyMatches(apiKey)) {
      return true;
    }

    // 1) Explicit @Public() bypass
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    // 2) Always-on allowlist for minimal bootstrap/public endpoints
    if (isAlwaysPublicRequest(req)) return true;

    // Only guard API routes; if someone hits "/", let it 404 normally.
    if (!path.startsWith("/api/")) return true;

    // 3) Deny-by-default auth: require a user for all /api/* (except the bypasses above)
    const user = req.user;
    if (!user) {
      throw new ForbiddenException("Not authenticated");
    }

    const requiredFromMeta: RequirePermMetadata | undefined =
      this.reflector.getAllAndOverride<RequirePermMetadata>(REQUIRE_PERM_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]);

    const isAdminRoute = path.startsWith("/api/admin");

    // If no @RequirePerm is set AND the route is under /api/admin,
    // require admin.access by default.
    const required: string[] =
      requiredFromMeta && requiredFromMeta.length > 0
        ? requiredFromMeta
        : isAdminRoute
          ? ["admin.access"]
          : [];

    // If nothing is required, auth-only access is allowed.
    if (required.length === 0) return true;

    // ---- Build user permissions set ----
    let userPerms = this.normalizePerms(user.permissions);

    // What a person may do is what is stored for their roles and groups. The one exception is
    // Owner, which always holds everything so the account can never be locked out.
    const roleHints = this.extractRoleNames(user);
    if (roleHints.length) {
      const owner = permsForRoles(roleHints);
      if (owner.size) {
        userPerms = Array.from(new Set([...userPerms, ...Array.from(owner)]));
      }
    }

    // If still empty, try loading from DB as a final fallback
    if (userPerms.length === 0 && user.id) {
      const fromDb = await this.loadPermsFromRoles(user.id);
      if (fromDb.length) {
        userPerms = Array.from(new Set([...userPerms, ...fromDb]));
      }
    }

    const userSet = new Set(userPerms.map((p) => String(p).toLowerCase()));
    req.effectivePermissions = userSet;

    for (const r of required) {
      const key = String(r).toLowerCase();
      if (!userSet.has(key)) {
        void this.audit.recordDenied(req, key);
        throw new ForbiddenException("Insufficient permissions");
      }
    }

    return true;
  }

  private normalizePerms(val: any): string[] {
    if (!val) return [];
    if (Array.isArray(val)) return val.map((x) => String(x).toLowerCase());
    if (typeof val === "object") return Object.keys(val).map((k) => k.toLowerCase());
    const s = String(val);
    if (s.includes(",")) {
      return s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    }
    return [s.toLowerCase()];
  }

  private async loadPermsFromRoles(userId: string): Promise<string[]> {
    try {
      const rows = await this.db.role_permissions.findMany({
        where: { roles: { user_roles: { some: { user_id: String(userId) } } } },
        select: { permission_key: true },
        distinct: ["permission_key"],
      });
      const fromGroups = await this.db.user_group_permissions.findMany({
        where: { user_groups: { user_group_members: { some: { user_id: String(userId) } } } },
        select: { permission_key: true },
        distinct: ["permission_key"],
      });
      return [...rows, ...fromGroups].map((r) => String(r.permission_key || "").toLowerCase()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private extractRoleNames(user: any): string[] {
    const out = new Set<string>();
    const push = (val: unknown) => {
      if (!val) return;
      const name = String(val).trim();
      if (name) out.add(name.toLowerCase());
    };

    if (Array.isArray(user?.roles)) user.roles.forEach(push);
    push(user?.role);
    push(user?.roleName);
    push(user?.role_name);
    if (user?.role?.name) push(user.role.name);

    return Array.from(out);
  }
}
