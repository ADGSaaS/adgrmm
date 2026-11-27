// adgrmm-minimal-e2e/backend/src/common/agent-token.util.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { PrismaService } from "../storage/prisma.service";

/** Agent tokens are stored only as this hash, and every lookup goes through it. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The token in "Bearer <token>" (white space between the two is allowed), or null. Linear time, unlike /^Bearer\s+(.+)$/. */
export function bearerToken(header: string): string | null {
  if (!header.startsWith("Bearer")) return null;
  let i = 6;
  while (i < header.length && /\s/.test(header[i])) i++;
  if (i === 6) return null;
  const token = header.slice(i);
  return token && !/[\r\n\u2028\u2029]/.test(token) ? token : null;
}

export type AgentAuthContext = {
  id: string; // uuid
  deviceId?: string; // uuid (string)
  token?: string; // raw agent token
};

export function getAgentFromRequest(req: any): AgentAuthContext {
  return (req as any).agent as AgentAuthContext;
}

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const authHeader = req.headers["authorization"];
    if (!authHeader || Array.isArray(authHeader)) {
      throw new UnauthorizedException("Missing Authorization header");
    }

    const token = bearerToken(authHeader);
    if (!token) {
      throw new UnauthorizedException("Invalid Authorization header format");
    }

    const row = await this.prisma.agents.findFirst({
      where: { agent_token: hashAgentToken(token) },
      select: { id: true, device_id: true },
    });

    if (!row) {
      throw new UnauthorizedException("Invalid or unknown agent token");
    }

    (req as any).agent = {
      id: row.id,
      deviceId: row.device_id ?? undefined,
      token,
    } as AgentAuthContext;

    return true;
  }
}
