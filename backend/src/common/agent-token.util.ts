// adgrmm-minimal-e2e/backend/src/common/agent-token.util.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { PrismaService } from "../storage/prisma.service";

/** Agent tokens are stored only as this hash, and every lookup goes through it. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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

    const match = /^Bearer\s+(.+)$/.exec(authHeader);
    if (!match) {
      throw new UnauthorizedException("Invalid Authorization header format");
    }

    const token = match[1];

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
