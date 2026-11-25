// backend/src/web-monitors/web-monitors.controller.ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { WebMonitorsService, type Actor } from "./web-monitors.service";

const actorOf = (req: any): Actor => {
    const u = req?.user;
    return { id: u?.id ? String(u.id) : null, organizationId: (u?.organizationId ?? u?.org ?? null) ? String(u?.organizationId ?? u?.org) : null };
};

/** Domain, DNS and certificate monitors. Rights follow the checks: read, write (make and change), delete and run. A limited person only sees their customers'. */
@Controller("api/monitors/web")
export class WebMonitorsController {
    constructor(private readonly monitors: WebMonitorsService) { }

    @Get()
    @RequirePerm("checks.read")
    list(@Req() req: any, @Query("clientId") clientId?: string, @Query("kind") kind?: string, @Query("status") status?: string) {
        return this.monitors.list(actorOf(req), { clientId, kind, status });
    }

    @Post()
    @RequirePerm("checks.write")
    create(@Req() req: any, @Body() body: any) {
        return this.monitors.create(actorOf(req), body ?? {});
    }

    @Patch(":id")
    @RequirePerm("checks.write")
    update(@Req() req: any, @Param("id") id: string, @Body() body: any) {
        return this.monitors.update(actorOf(req), id, body ?? {});
    }

    @Delete(":id")
    @RequirePerm("checks.delete")
    remove(@Req() req: any, @Param("id") id: string) {
        return this.monitors.remove(actorOf(req), id);
    }

    @Post(":id/run")
    @HttpCode(200)
    @RequirePerm("checks.run")
    run(@Req() req: any, @Param("id") id: string) {
        return this.monitors.runNow(actorOf(req), id);
    }

    @Post(":id/accept")
    @HttpCode(200)
    @RequirePerm("checks.write")
    accept(@Req() req: any, @Param("id") id: string) {
        return this.monitors.acceptBaseline(actorOf(req), id);
    }
}
