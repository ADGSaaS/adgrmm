// backend/src/endpoint-backups/backup.controller.ts
import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { AuditService } from "../audit/audit.service";
import { EndpointBackupsService, type Actor } from "./backup.service";

const actorOf = (req: any): Actor => {
    const u = req?.user;
    return { id: u?.id ? String(u.id) : null, organizationId: (u?.organizationId ?? u?.org ?? null) ? String(u?.organizationId ?? u?.org) : null };
};

/** Backup status of customers' computers (Devices > Endpoint backups) and the customer backup report. */
@Controller("api/endpoint-backups")
export class EndpointBackupsController {
    constructor(private readonly backups: EndpointBackupsService, private readonly audit: AuditService) { }

    @Get()
    @RequirePerm("devices.read")
    list(@Req() req: any, @Query("clientId") clientId?: string, @Query("status") status?: string, @Query("q") q?: string) {
        return this.backups.list(actorOf(req), { clientId, status, q });
    }

    /** The customer's backup report as JSON, or as a spreadsheet with format=csv. */
    @Get("report")
    @RequirePerm("devices.read")
    async report(@Req() req: any, @Res({ passthrough: true }) res: Response, @Query("clientId") clientId?: string, @Query("format") format?: string) {
        const report = await this.backups.report(actorOf(req), clientId);
        if (format === "csv") {
            const name = `backup-report${report.customer ? `-${report.customer.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : ""}-${report.generatedAt.slice(0, 10)}.csv`;
            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
            return EndpointBackupsService.csv(report);
        }
        return report;
    }

    @Post("check")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    check(@Req() req: any, @Body() body: any) {
        return this.backups.checkNow(actorOf(req), body ?? {});
    }

    @Get("settings")
    @RequirePerm("settings.read")
    settings(@Req() req: any) {
        return this.backups.settings(this.org(req));
    }

    @Put("settings")
    @RequirePerm("settings.write")
    async save(@Req() req: any, @Body() body: any) {
        const org = this.org(req);
        const { before, after } = await this.backups.saveSettings(org, req.user?.id ? String(req.user.id) : null, body && typeof body === "object" ? body : {});
        await this.audit.record({
            action: "endpoint_backups.settings.update", category: "settings", outcome: "success", actorUserId: req.user?.id, actorEmail: req.user?.email, targetType: "organization", targetId: org,
            metadata: { before, after },
        } as any).catch(() => undefined);
        return after;
    }

    private org(req: any): string {
        const org = req?.user?.organizationId ?? null;
        if (!org) throw new BadRequestException("No organization in the session.");
        return String(org);
    }
}
