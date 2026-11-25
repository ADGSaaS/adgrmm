// backend/src/edr/edr.controller.ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { EdrService, type Actor } from "./edr.service";

const actorOf = (req: any): Actor => {
    const u = req?.user;
    return { id: u?.id ? String(u.id) : null, organizationId: (u?.organizationId ?? u?.org ?? null) ? String(u?.organizationId ?? u?.org) : null };
};

/** EDR and antivirus consoles (Monitoring > EDR and antivirus). Read-only toward the console; credentials are never sent back. */
@Controller("api/edr")
export class EdrController {
    constructor(private readonly edr: EdrService) { }

    @Get("vendors")
    @RequirePerm("devices.read")
    vendors() { return this.edr.vendors(); }

    @Get("coverage")
    @RequirePerm("devices.read")
    coverage(@Req() req: any, @Query("clientId") clientId?: string, @Query("q") q?: string) { return this.edr.coverage(actorOf(req), { clientId, q }); }

    @Get("connections")
    @RequirePerm("devices.read")
    list(@Req() req: any) { return this.edr.list(actorOf(req)); }

    @Post("connections")
    @RequirePerm("settings.write")
    create(@Req() req: any, @Body() body: any) { return this.edr.create(actorOf(req), body ?? {}); }

    @Patch("connections/:id")
    @RequirePerm("settings.write")
    update(@Req() req: any, @Param("id") id: string, @Body() body: any) { return this.edr.update(actorOf(req), id, body ?? {}); }

    @Delete("connections/:id")
    @RequirePerm("settings.write")
    remove(@Req() req: any, @Param("id") id: string) { return this.edr.remove(actorOf(req), id); }

    @Post("connections/:id/sync")
    @HttpCode(200)
    @RequirePerm("settings.write")
    sync(@Req() req: any, @Param("id") id: string) { return this.edr.syncNow(actorOf(req), id); }
}
