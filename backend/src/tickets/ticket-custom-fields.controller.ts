import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { CustomFieldsService } from "../customers/custom-fields.service";

const orgOf = (req: Request): string => {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};

type Body_ = { label?: string; type?: string; options?: string[] | string; required?: boolean; help?: string; active?: boolean; visibleToCustomer?: boolean };

/**
 * The custom fields tickets can have. Anyone who reads tickets sees them (the ticket form needs them); changing them
 * needs the settings right. Same fields, same rules as the customer ones, kept apart by their entity.
 */
@Controller("api/ticket-custom-fields")
export class TicketCustomFieldsController {
    constructor(private readonly fields: CustomFieldsService) { }

    @Get()
    @RequirePerm("tickets.read")
    async list(@Req() req: Request, @Query("archived") archived?: string) {
        return { items: await this.fields.list(orgOf(req), String(archived ?? "").toLowerCase() === "true", "ticket") };
    }

    @Post()
    @RequirePerm("settings.write")
    create(@Req() req: Request, @Body() body: Body_) {
        return this.fields.create(orgOf(req), body ?? {}, "ticket");
    }

    // Before the routes with an id, which would otherwise take this word as one.
    @Post("reorder")
    @RequirePerm("settings.write")
    async reorder(@Req() req: Request, @Body() body: { ids?: string[] }) {
        return { items: await this.fields.reorder(orgOf(req), body?.ids, "ticket") };
    }

    @Patch(":id")
    @RequirePerm("settings.write")
    update(@Req() req: Request, @Param("id") id: string, @Body() body: Body_) {
        return this.fields.update(orgOf(req), id, body ?? {}, "ticket");
    }

    /** Archives the field: what people saved in it is kept, and comes back if it is restored. */
    @Delete(":id")
    @RequirePerm("settings.write")
    archive(@Req() req: Request, @Param("id") id: string) {
        return this.fields.archive(orgOf(req), id, "ticket");
    }
}
