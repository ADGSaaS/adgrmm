// backend/src/system-health/system-health.controller.ts
import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { SystemHealthService } from "./system-health.service";

/** Administration > System > Server health. */
@Controller("api/admin/system-health")
export class SystemHealthController {
    constructor(private readonly health: SystemHealthService) { }

    @Get()
    @RequirePerm("settings.read")
    status() { return this.health.status(); }

    /** Start a restore test of the newest good backup now (into a scratch database; production is not touched). */
    @Post("restore-test")
    @HttpCode(200)
    @RequirePerm("settings.write")
    restoreTest() { return this.health.maybeStartRestore(new Date(), true); }
}
