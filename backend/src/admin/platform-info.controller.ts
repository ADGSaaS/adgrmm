// backend/src/admin/platform-info.controller.ts
import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuditService } from "../audit/audit.service";
import { HumanSessionGuard } from "../auth/human-session.guard";
import { RequirePerm } from "../auth/require-perm.decorator";
import { secretsStatus } from "./environment.descriptions";
import { PlatformInfoService } from "./platform-info.service";

const noStore = (res: Response) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Vary", "Cookie, Authorization");
};

/** System, Migrations and Secrets screens. Sign-in sessions only (no API keys), never cached, read-only. */
@Controller("/api/admin")
@UseGuards(HumanSessionGuard)
export class PlatformInfoController {
    constructor(private readonly info: PlatformInfoService, private readonly audit: AuditService) { }

    @Get("system")
    @RequirePerm("settings.environment.read")
    system(@Res({ passthrough: true }) res: Response) {
        noStore(res);
        return this.info.system();
    }

    @Get("migrations")
    @RequirePerm("settings.environment.read")
    migrations(@Res({ passthrough: true }) res: Response) {
        noStore(res);
        return this.info.migrations();
    }

    /** Which server settings are set and which are not. Never a value, not even a part of one. */
    @Get("secrets-status")
    @RequirePerm("settings.environment.read")
    async secrets(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        noStore(res);
        const user = (req as any).user ?? {};
        const status = secretsStatus();
        await this.audit.record({
            action: "settings.secrets.view",
            category: "settings",
            outcome: "success",
            actorUserId: user.id ?? null,
            actorEmail: user.email ?? null,
            req,
            details: { settings: status.summary.total, set: status.summary.set },
        });
        return status;
    }
}
