// backend/src/agents/agent-updates.controller.ts
import { Controller, Get, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import * as fs from "node:fs";

import { Public } from "../auth/public.decorator";
import { AgentTokenGuard, getAgentFromRequest } from "../common/agent-token.util";
import { AgentUpdatesService } from "./agent-updates.service";

@Public() // bypass the global cookie guard; AgentTokenGuard authenticates these routes
@Controller("/api/agent/updates")
@UseGuards(AgentTokenGuard)
export class AgentUpdatesController {
  constructor(private readonly updates: AgentUpdatesService) { }

  /** 200 with a signed manifest when a newer package exists for this agent, otherwise 204. */
  @Get("check")
  async check(
    @Query("os") os: string | undefined,
    @Query("arch") arch: string | undefined,
    @Query("version") version: string | undefined,
    @Query("failedVersion") failedVersion: string | undefined,
    @Query("failedOutcome") failedOutcome: string | undefined,
    @Query("failedDetail") failedDetail: string | undefined,
    @Req() req: any,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const manifest = await this.updates.getManifest(os, arch, version, getAgentFromRequest(req)?.deviceId);
    // How the last update went (the reason an update failed after the agent accepted it), kept for the console.
    await this.updates.noteResult(getAgentFromRequest(req)?.id, version, { version: failedVersion, outcome: failedOutcome, detail: failedDetail });

    res.setHeader("Cache-Control", "no-store");
    if (!manifest) {
      res.status(204);
      res.send("");
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify(manifest));
  }

  @Get("download/:os")
  async download(@Param("os") os: string, @Req() req: any, @Res({ passthrough: false }) res: Response): Promise<void> {
    const out = await this.updates.getDownload(os, getAgentFromRequest(req)?.deviceId);

    res.status(200);
    res.setHeader("Content-Type", out.contentType);
    res.setHeader("Content-Length", String(out.sizeBytes));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const stream = fs.createReadStream(out.absPath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
}
