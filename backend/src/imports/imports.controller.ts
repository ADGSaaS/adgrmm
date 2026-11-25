import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { FlagsService } from "../flags/flags.service";
import { ImportsService, ImportOptions } from "./imports.service";

const who = (req: any) => {
    const u = req?.user ?? {};
    const org = u.organizationId ?? u.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return { orgId: String(org), userId: u.id ? String(u.id) : null };
};

/** Importing from another helpdesk. Needs the right to manage settings, since it brings in a lot and reads another system with a key. */
@Controller("api/admin/import")
export class ImportsController {
    constructor(private readonly imports: ImportsService, private readonly flags: FlagsService) { }

    @Get("jobs")
    @RequirePerm("settings.write")
    async list(@Req() req: any) {
        return { items: await this.imports.list(who(req).orgId) };
    }

    @Get("jobs/:id")
    @RequirePerm("settings.write")
    get(@Req() req: any, @Param("id") id: string) {
        return this.imports.get(who(req).orgId, id);
    }

    @Post("freshdesk/preview")
    @HttpCode(HttpStatus.ACCEPTED)
    @RequirePerm("settings.write")
    async preview(@Req() req: any, @Body() body: { domain?: string; apiKey?: string }) {
        const w = who(req);
        await this.flags.assertEnabled(w.orgId, "freshdesk_import");
        return this.imports.startPreview(w.orgId, w.userId, body ?? {});
    }

    @Post("jobs/:id/run")
    @HttpCode(HttpStatus.ACCEPTED)
    @RequirePerm("settings.write")
    async run(@Req() req: any, @Param("id") id: string, @Body() body: Partial<ImportOptions>) {
        const w = who(req);
        await this.flags.assertEnabled(w.orgId, "freshdesk_import");
        return this.imports.startRun(w.orgId, w.userId, id, body ?? {});
    }

    @Post("jobs/:id/cancel")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("settings.write")
    cancel(@Req() req: any, @Param("id") id: string) {
        return this.imports.cancel(who(req).orgId, id);
    }
}
