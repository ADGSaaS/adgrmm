// backend/src/m365/m365.controller.ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { M365Service, type Actor } from "./m365.service";

const actorOf = (req: any): Actor => {
    const u = req?.user;
    return { id: u?.id ? String(u.id) : null, organizationId: (u?.organizationId ?? u?.org ?? null) ? String(u?.organizationId ?? u?.org) : null };
};

/** Microsoft 365 tenants of customers (Customers > Microsoft 365). Read-only toward Microsoft; the client secret is never sent back. */
@Controller("api/m365/tenants")
export class M365Controller {
    constructor(private readonly m365: M365Service) { }

    @Get()
    @RequirePerm("customers.read")
    list(@Req() req: any) { return this.m365.list(actorOf(req)); }

    @Get(":id")
    @RequirePerm("customers.read")
    get(@Req() req: any, @Param("id") id: string) { return this.m365.get(actorOf(req), id); }

    @Post()
    @RequirePerm("customers.write")
    create(@Req() req: any, @Body() body: any) { return this.m365.create(actorOf(req), body ?? {}); }

    @Patch(":id")
    @RequirePerm("customers.write")
    update(@Req() req: any, @Param("id") id: string, @Body() body: any) { return this.m365.update(actorOf(req), id, body ?? {}); }

    @Delete(":id")
    @RequirePerm("customers.write")
    remove(@Req() req: any, @Param("id") id: string) { return this.m365.remove(actorOf(req), id); }

    @Post(":id/sync")
    @HttpCode(200)
    @RequirePerm("customers.write")
    sync(@Req() req: any, @Param("id") id: string) { return this.m365.syncNow(actorOf(req), id); }
}
