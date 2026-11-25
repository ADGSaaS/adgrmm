// backend/src/compliance/compliance.controller.ts
import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuditService } from "../audit/audit.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { FlagsService } from "../flags/flags.service";
import { ComplianceService } from "./compliance.service";

@Controller("api/admin/compliance")
export class ComplianceController {
    constructor(private readonly compliance: ComplianceService, private readonly flags: FlagsService, private readonly audit: AuditService) { }

    /** The posture check. Read-only. It shows counts and settings, never a user's secrets or a device's data. */
    @Get()
    @RequirePerm(["settings.read", "users.read"])
    async get(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        res.setHeader("Cache-Control", "private, no-store");
        const user = (req as any).user ?? {};
        const report = await this.compliance.report(await this.flags.orgOf(user));
        await this.audit.record({ action: "settings.compliance.view", category: "settings", outcome: "success", actorUserId: user.id ?? null, actorEmail: user.email ?? null, req, details: report.summary });
        return report;
    }
}
