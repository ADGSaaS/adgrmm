// backend/src/jobs/jobs.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Headers,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { JobsService } from "./jobs.service";
import { PrismaService } from "../storage/prisma.service";
import { Public } from "../auth/public.decorator";
import { adminKeyMatches } from "../common/admin-key";

@Public() // ✅ secured by x-admin-api-key; avoid AuthCookieGuard blocking automation/break-glass usage
@Controller("/api/admin")
export class JobsController {
  private readonly logger = new Logger("JobsController");

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService
  ) { }

  private checkAdmin(key: string | undefined) {
    if (!adminKeyMatches(key)) {
      throw new UnauthorizedException("invalid admin key");
    }
  }

  @Post("/agents")
  async listAgents(@Headers("x-admin-api-key") key: string | undefined) {
    this.checkAdmin(key);
    try {
      const rows = await this.prisma.agents.findMany({
        select: {
          id: true,
          agent_uuid: true,
          device_id: true,
          hostname: true,
          facts: true,
          version: true,
          created_at: true,
          updated_at: true,
        },
        orderBy: { created_at: "desc" },
      });
      // os and arch are not columns; agents report them in facts.
      const items = rows.map(({ facts, ...agent }) => {
        const reported = (facts ?? {}) as Record<string, any>;
        return { ...agent, os: reported.os ?? null, arch: reported.arch ?? null };
      });
      return { items };
    } catch (e: any) {
      this.logger.error(`listAgents failed: ${e?.message ?? e}`, e?.stack ?? undefined);
      throw e;
    }
  }

  @Post("/jobs/run-script")
  async runScript(
    @Headers("x-admin-api-key") key: string | undefined,
    @Body()
    body: {
      agentId?: string;
      agentUuid?: string;
      language: "powershell" | "bash";
      scriptText: string;
      args?: string[];
      env?: Record<string, string>;
      timeoutSec?: number;
    }
  ) {
    this.checkAdmin(key);
    try {
      return await this.jobs.createRunScriptJob(body);
    } catch (e: any) {
      this.logger.error(`run-script failed: ${e?.message ?? e}`, e?.stack ?? undefined);
      throw e;
    }
  }

  @Post("/jobs/file-op")
  async fileOp(
    @Headers("x-admin-api-key") key: string | undefined,
    @Body()
    body: {
      agentId?: string;
      agentUuid?: string;

      op: "list" | "read" | "write" | "mkdir" | "delete" | "move" | "copy";
      path: string;

      path2?: string;
      recursive?: boolean;
      maxBytes?: number;
      contentBase64?: string;
    }
  ) {
    this.checkAdmin(key);
    try {
      return await this.jobs.createFileOpJob(body);
    } catch (e: any) {
      this.logger.error(`file-op failed: ${e?.message ?? e}`, e?.stack ?? undefined);
      throw e;
    }
  }

  @Get("/jobs/:id")
  async getJob(@Headers("x-admin-api-key") key: string | undefined, @Param("id") id: string) {
    this.checkAdmin(key);
    return this.jobs.getJobWithResult(id);
  }
}
