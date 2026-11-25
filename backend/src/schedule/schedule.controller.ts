import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ScheduleService } from "./schedule.service";

@Controller("api/schedule")
export class ScheduleController {
    constructor(private readonly svc: ScheduleService) { }

    @Get("visits")
    @RequirePerm("schedule.read")
    list(@Req() req: any, @Query() q: { from?: string; to?: string; techId?: string; ticketId?: string; status?: string }) {
        return this.svc.list(req, q ?? {});
    }

    @Get("unscheduled")
    @RequirePerm("schedule.read")
    unscheduled(@Req() req: any, @Query() q: { q?: string }) {
        return this.svc.unscheduled(req, q ?? {});
    }

    @Get("techs")
    @RequirePerm("schedule.read")
    techs(@Req() req: any) {
        return this.svc.techs(req);
    }

    @Get("time-off")
    @RequirePerm("schedule.read")
    timeOff(@Req() req: any, @Query() q: { from?: string; to?: string }) {
        return this.svc.timeOff(req, q ?? {});
    }

    @Post("time-off")
    @RequirePerm("schedule.write")
    addTimeOff(@Req() req: any, @Body() body: any) {
        return this.svc.addTimeOff(req, body ?? {});
    }

    @Delete("time-off/:id")
    @RequirePerm("schedule.write")
    removeTimeOff(@Req() req: any, @Param("id") id: string) {
        return this.svc.removeTimeOff(req, id);
    }

    @Put("availability/:userId")
    @RequirePerm("schedule.write")
    setAvailability(@Req() req: any, @Param("userId") userId: string, @Body() body: any) {
        return this.svc.setAvailability(req, userId, body ?? {});
    }

    @Post("visits/conflicts")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("schedule.read")
    conflicts(@Req() req: any, @Body() body: any) {
        return this.svc.checkConflicts(req, body ?? {});
    }

    @Post("visits")
    @RequirePerm("schedule.write")
    create(@Req() req: any, @Body() body: any) {
        return this.svc.create(req, body ?? {});
    }

    @Get("visits/:id")
    @RequirePerm("schedule.read")
    get(@Req() req: any, @Param("id") id: string) {
        return this.svc.get(req, id);
    }

    @Get("visits/:id/ics")
    @RequirePerm("schedule.read")
    async ics(@Req() req: any, @Param("id") id: string, @Res({ passthrough: true }) res: Response) {
        const f = await this.svc.icsFor(req, id);
        res.setHeader("Content-Type", "text/calendar; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`);
        return f.content;
    }

    @Patch("visits/:id")
    @RequirePerm("schedule.write")
    update(@Req() req: any, @Param("id") id: string, @Body() body: any) {
        return this.svc.update(req, id, body ?? {});
    }

    @Delete("visits/:id")
    @RequirePerm("schedule.write")
    remove(@Req() req: any, @Param("id") id: string) {
        return this.svc.remove(req, id);
    }
}
