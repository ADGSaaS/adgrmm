// backend/src/flags/flags.controller.ts
import { BadRequestException, Body, Controller, Get, Header, Param, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { FlagsService } from "./flags.service";

@Controller()
export class FlagsController {
    constructor(private readonly flags: FlagsService) { }

    /** On or off for each flag, for the screens to read. Anyone signed in may ask; it holds nothing but those answers. */
    @Get("api/flags")
    @Header("Cache-Control", "private, no-store")
    async effective(@Req() req: Request) {
        return { flags: await this.flags.effective(await this.flags.orgOf((req as any).user)) };
    }

    @Get("api/admin/flags")
    @RequirePerm("settings.read")
    @Header("Cache-Control", "private, no-store")
    async list(@Req() req: Request) {
        return { items: await this.flags.list(await this.flags.orgOf((req as any).user)) };
    }

    @Put("api/admin/flags/:key")
    @RequirePerm("settings.write")
    async set(@Req() req: Request, @Param("key") key: string, @Body() body: { enabled?: unknown }) {
        if (typeof body?.enabled !== "boolean") throw new BadRequestException("Send enabled as true or false.");
        const user = (req as any).user ?? {};
        return this.flags.set(await this.flags.orgOf(user), key, body.enabled, { id: user.id, email: user.email }, req);
    }
}
