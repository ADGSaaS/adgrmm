import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { EmailTemplatesService } from "./email-templates.service";
import { TicketTemplatesService } from "./ticket-templates.service";

const orgOf = (req: Request): string => {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};
const userOf = (req: Request): string | null => {
    const id = (req as any)?.user?.id;
    return id ? String(id) : null;
};

/** Ticket templates. Anyone who can read tickets can use them (the new-ticket form lists them); changing them needs the settings right. */
@Controller("api/ticket-templates")
export class TicketTemplatesController {
    constructor(private readonly templates: TicketTemplatesService) { }

    @Get()
    @RequirePerm("tickets.read")
    async list(@Req() req: Request) {
        return { items: await this.templates.list(orgOf(req)) };
    }

    @Post()
    @RequirePerm("settings.write")
    create(@Req() req: Request, @Body() body: any) {
        return this.templates.create(orgOf(req), body ?? {}, userOf(req));
    }

    @Patch(":id")
    @RequirePerm("settings.write")
    update(@Req() req: Request, @Param("id") id: string, @Body() body: any) {
        return this.templates.update(orgOf(req), id, body ?? {});
    }

    @Delete(":id")
    @RequirePerm("settings.write")
    remove(@Req() req: Request, @Param("id") id: string) {
        return this.templates.remove(orgOf(req), id);
    }
}

/** The wording of the system emails. */
@Controller("api/admin/email-templates")
export class EmailTemplatesController {
    constructor(private readonly emails: EmailTemplatesService) { }

    @Get()
    @RequirePerm("settings.read")
    async list(@Req() req: Request) {
        return { items: await this.emails.list(orgOf(req)) };
    }

    @Put(":key")
    @RequirePerm("settings.write")
    save(@Req() req: Request, @Param("key") key: string, @Body() body: { subject?: string; body?: string }) {
        return this.emails.save(orgOf(req), key, body ?? {}, userOf(req));
    }

    /** Back to the built-in wording. */
    @Delete(":key")
    @RequirePerm("settings.write")
    reset(@Req() req: Request, @Param("key") key: string) {
        return this.emails.reset(orgOf(req), key);
    }

    @Post(":key/preview")
    @RequirePerm("settings.read")
    preview(@Param("key") key: string, @Body() body: { subject?: string; body?: string }) {
        return this.emails.preview(key, body ?? {});
    }

    @Post(":key/test")
    @RequirePerm("settings.write")
    test(@Req() req: Request, @Param("key") key: string, @Body() body: { to?: string; subject?: string; body?: string }) {
        return this.emails.test(orgOf(req), key, body ?? {});
    }
}
