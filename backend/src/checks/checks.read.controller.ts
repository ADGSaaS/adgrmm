import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { CheckRunNowService } from "./check-run-now.service";
import { ClientAccessService } from "../reports/client-access.service";
import { ChecksRuntimeService } from "./checks.runtime.service";
import { RequirePerm } from "../auth/require-perm.decorator";

@Controller("api/devices")
export class ChecksReadController {
    constructor(private readonly checksRuntime: ChecksRuntimeService, private readonly access: ClientAccessService, private readonly runNow: CheckRunNowService) { }

    // GET /api/devices/:deviceId/checks?limit=100
    @Get(":deviceId/checks")
    @RequirePerm("checks.read")
    async listForDevice(@Req() req: any, @Param("deviceId") deviceId: string, @Query("limit") limit?: string) {
        await this.access.assertDevice(req?.user?.id ? String(req.user.id) : null, deviceId);
        const l = limit ? parseInt(limit, 10) : 100;
        return this.checksRuntime.listByDevice(deviceId, Number.isFinite(l) ? l : 100);
    }

    // POST /api/devices/:deviceId/checks/run   { keys?: string[] }  (no keys means every check)
    @Post(":deviceId/checks/run")
    @RequirePerm("checks.run")
    @HttpCode(HttpStatus.ACCEPTED)
    async run(@Req() req: any, @Param("deviceId", new ParseUUIDPipe()) deviceId: string, @Body() body: { keys?: string[] }) {
        await this.access.assertDevice(req?.user?.id ? String(req.user.id) : null, deviceId);
        return this.runNow.request(deviceId, body?.keys, req?.user?.id ? String(req.user.id) : null);
    }
}
