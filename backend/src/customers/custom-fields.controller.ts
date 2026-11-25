import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { CustomFieldsService } from "./custom-fields.service";

const orgOf = (req: Request): string => {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};

type Body_ = { label?: string; type?: string; options?: string[] | string; required?: boolean; help?: string; active?: boolean };

/** The custom fields customers can have. Anyone who reads customers sees them (the customer form needs them); changing them needs the settings right. */
@Controller("api/custom-fields")
export class CustomFieldsController {
    constructor(private readonly fields: CustomFieldsService) { }

    @Get()
    @RequirePerm("customers.read")
    async list(@Req() req: Request, @Query("archived") archived?: string) {
        return { items: await this.fields.list(orgOf(req), String(archived ?? "").toLowerCase() === "true") };
    }

    @Post()
    @RequirePerm("settings.write")
    create(@Req() req: Request, @Body() body: Body_) {
        return this.fields.create(orgOf(req), body ?? {});
    }

    // Before the routes with an id, which would otherwise take this word as one.
    @Post("reorder")
    @RequirePerm("settings.write")
    async reorder(@Req() req: Request, @Body() body: { ids?: string[] }) {
        return { items: await this.fields.reorder(orgOf(req), body?.ids) };
    }

    @Patch(":id")
    @RequirePerm("settings.write")
    update(@Req() req: Request, @Param("id") id: string, @Body() body: Body_) {
        return this.fields.update(orgOf(req), id, body ?? {});
    }

    /** Archives the field: what people saved in it is kept, and comes back if it is restored. */
    @Delete(":id")
    @RequirePerm("settings.write")
    archive(@Req() req: Request, @Param("id") id: string) {
        return this.fields.archive(orgOf(req), id);
    }
}
