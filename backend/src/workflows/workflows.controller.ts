// backend/src/workflows/workflows.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { WorkflowsService } from "./workflows.service";

/** Administration > Automation > Workflows. */
@Controller("api/admin/workflows")
export class WorkflowsController {
    constructor(private readonly svc: WorkflowsService) { }

    private org(req: any): string {
        const org = req?.user?.organizationId ?? null;
        if (!org) throw new BadRequestException("No organization in the session.");
        return String(org);
    }

    @Get("meta") @RequirePerm("automation.read") meta() { return this.svc.meta(); }
    @Get() @RequirePerm("automation.read") list(@Req() req: any) { return this.svc.list(this.org(req)); }
    @Get("runs") @RequirePerm("automation.read") runs(@Req() req: any, @Query("ruleId") ruleId?: string) { return this.svc.runs(this.org(req), ruleId); }
    @Post() @RequirePerm("settings.write") create(@Req() req: any, @Body() body: any) { return this.svc.create(this.org(req), req?.user?.id ? String(req.user.id) : null, body); }
    @Put(":id") @RequirePerm("settings.write") update(@Req() req: any, @Param("id") id: string, @Body() body: any) { return this.svc.update(this.org(req), id, body); }
    @Post(":id/enable") @HttpCode(200) @RequirePerm("settings.write") enable(@Req() req: any, @Param("id") id: string) { return this.svc.setEnabled(this.org(req), id, true); }
    @Post(":id/disable") @HttpCode(200) @RequirePerm("settings.write") disable(@Req() req: any, @Param("id") id: string) { return this.svc.setEnabled(this.org(req), id, false); }
    @Post(":id/preview") @HttpCode(200) @RequirePerm("automation.read") preview(@Req() req: any, @Param("id") id: string) { return this.svc.preview(this.org(req), id); }
    @Delete(":id") @RequirePerm("settings.write") remove(@Req() req: any, @Param("id") id: string) { return this.svc.remove(this.org(req), id); }
}
