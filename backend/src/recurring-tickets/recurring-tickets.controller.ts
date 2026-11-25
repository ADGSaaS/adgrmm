import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { RecurringTicketsService } from "./recurring-tickets.service";

/** Recurring tickets. Anyone who can read tickets sees them; changing or running them needs the settings right, like ticket templates. */
@Controller("/api/recurring-tickets")
export class RecurringTicketsController {
    constructor(private readonly svc: RecurringTicketsService) { }

    @Get()
    @RequirePerm("tickets.read")
    list(@Req() req: any) {
        return this.svc.list(req);
    }

    /** What a schedule would do (its next times), without saving it. */
    @Post("preview")
    @HttpCode(200)
    @RequirePerm("tickets.read")
    preview(@Body() body: Record<string, unknown>) {
        return this.svc.preview(body ?? {});
    }

    @Post()
    @RequirePerm("settings.write")
    create(@Req() req: any, @Body() body: Record<string, any>) {
        return this.svc.create(req, body ?? {});
    }

    @Get(":id")
    @RequirePerm("tickets.read")
    get(@Req() req: any, @Param("id") id: string) {
        return this.svc.get(id, req);
    }

    @Patch(":id")
    @RequirePerm("settings.write")
    update(@Req() req: any, @Param("id") id: string, @Body() body: Record<string, any>) {
        return this.svc.update(id, req, body ?? {});
    }

    @Delete(":id")
    @RequirePerm("settings.write")
    remove(@Req() req: any, @Param("id") id: string) {
        return this.svc.remove(id, req);
    }

    @Post(":id/pause")
    @HttpCode(200)
    @RequirePerm("settings.write")
    pause(@Req() req: any, @Param("id") id: string) {
        return this.svc.setEnabled(id, req, false);
    }

    @Post(":id/resume")
    @HttpCode(200)
    @RequirePerm("settings.write")
    resume(@Req() req: any, @Param("id") id: string) {
        return this.svc.setEnabled(id, req, true);
    }

    /** Opens the ticket now, as an extra. */
    @Post(":id/run")
    @HttpCode(200)
    @RequirePerm("settings.write")
    run(@Req() req: any, @Param("id") id: string) {
        return this.svc.runNow(id, req);
    }

    @Get(":id/runs")
    @RequirePerm("tickets.read")
    runs(@Req() req: any, @Param("id") id: string, @Query("limit") limit?: string) {
        return this.svc.runs(id, req, Number(limit) || 50);
    }
}
