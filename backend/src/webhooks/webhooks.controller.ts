import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { WebhooksService } from "./webhooks.service";

const orgOf = (req: Request): string => {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};

/** Outbound webhooks (Administration > Integrations). The signing secret is shown once, when a webhook is made or its secret is replaced. */
@Controller("api/admin/webhooks")
export class WebhooksController {
    constructor(private readonly hooks: WebhooksService) { }

    @Get()
    @RequirePerm("settings.read")
    list(@Req() req: Request) {
        return this.hooks.list(orgOf(req));
    }

    @Post()
    @RequirePerm("settings.write")
    create(@Req() req: Request, @Body() body: any) {
        return this.hooks.create(orgOf(req), body ?? {}, (req as any)?.user?.id ?? null);
    }

    @Patch(":id")
    @RequirePerm("settings.write")
    update(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
        return this.hooks.update(orgOf(req), id, body ?? {});
    }

    @Delete(":id")
    @RequirePerm("settings.write")
    remove(@Req() req: Request, @Param("id") id: string) {
        return this.hooks.remove(orgOf(req), id);
    }

    @Get(":id/deliveries")
    @RequirePerm("settings.read")
    deliveries(@Req() req: Request, @Param("id") id: string) {
        return this.hooks.deliveries(orgOf(req), id);
    }

    @Post(":id/test")
    @RequirePerm("settings.write")
    test(@Req() req: Request, @Param("id") id: string) {
        return this.hooks.test(orgOf(req), id);
    }
}
