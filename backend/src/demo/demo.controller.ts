// backend/src/demo/demo.controller.ts
import { Controller, Delete, Get, HttpCode, Post, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { FlagsService } from "../flags/flags.service";
import { DemoService } from "./demo.service";

@Controller("api/admin/demo")
export class DemoController {
    constructor(private readonly demo: DemoService, private readonly flags: FlagsService) { }

    @Get()
    @RequirePerm("settings.read")
    status() {
        return this.demo.status();
    }

    /** Turns demo data on: two sample customers and ten endpoints with full sample data. */
    @Post("enable")
    @HttpCode(200)
    @RequirePerm("settings.write")
    async enable(@Req() req: any) {
        await this.flags.assertEnabled(await this.flags.orgOf(req?.user), "demo_data");
        return this.demo.enable();
    }

    /** Turns demo data off, deleting all of it. Nothing that was not created as demo data is touched. */
    @Post("disable")
    @HttpCode(200)
    @RequirePerm("settings.write")
    disable() {
        return this.demo.disable();
    }

    @Delete()
    @RequirePerm("settings.write")
    remove() {
        return this.demo.disable();
    }
}
