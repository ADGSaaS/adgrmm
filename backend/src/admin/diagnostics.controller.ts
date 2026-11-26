import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { HumanSessionGuard } from "../auth/human-session.guard";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DiagnosticsService } from "./diagnostics.service";

/** A troubleshooting report for administrators. Sign-in sessions only (no API keys), and never cached. */
@Controller("/api/admin/diagnostics")
@UseGuards(HumanSessionGuard)
export class DiagnosticsController {
    constructor(private readonly diagnostics: DiagnosticsService) { }

    @Get()
    @RequirePerm("settings.environment.read")
    async get(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query("download") download?: string) {
        const u = (req as any)?.user ?? {};
        const orgId = String(u.organizationId ?? u.org ?? "");
        const report = await this.diagnostics.report(orgId, u.email ? String(u.email) : null);
        res.setHeader("Cache-Control", "private, no-store, max-age=0");
        res.setHeader("Pragma", "no-cache");
        if (download === "1") {
            const stamp = report.generatedAt.replace(/[:.]/g, "-").slice(0, 19);
            res.setHeader("Content-Disposition", `attachment; filename="adgrmm-diagnostics-${stamp}.json"`);
        }
        return report;
    }
}
