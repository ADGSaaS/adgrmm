import { BadRequestException, Controller, Get, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { IntegrationsService } from "./integrations.service";

/** The state of every connection to something outside the product, for Administration > Integrations. Read only. */
@Controller("api/admin/integrations")
export class IntegrationsController {
    constructor(private readonly integrations: IntegrationsService) { }

    @Get()
    @RequirePerm("settings.read")
    async list(@Req() req: Request) {
        const u = (req as any)?.user;
        const org = u?.organizationId ?? u?.org ?? null;
        if (!org) throw new BadRequestException("No organization in the session.");
        return { items: await this.integrations.cards(String(org)), checkedAt: new Date().toISOString() };
    }
}
