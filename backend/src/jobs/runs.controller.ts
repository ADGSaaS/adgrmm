// backend/src/jobs/runs.controller.ts
import {
    Body,
    Controller,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    Req,
    UsePipes,
    ValidationPipe,
} from "@nestjs/common";
import { RunsService } from "./runs.service";
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "../reports/client-access.service";

class RunScriptDto {
    @IsUUID()
    deviceId!: string;

    @IsString()
    @MinLength(1)
    @MaxLength(1_000_000)
    script!: string;

    @IsOptional()
    @IsIn(["powershell", "bash", "cmd"])
    shell?: "powershell" | "bash" | "cmd";

    @IsOptional()
    @IsInt()
    @Min(1)
    @Transform(({ value }) => (value != null ? parseInt(value, 10) : undefined))
    timeoutSec?: number;
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("/api/automation")
export class RunsController {
    constructor(private readonly runs: RunsService, private readonly access: ClientAccessService) { }

    private userId(req: any): string | null {
        return req?.user?.id ? String(req.user.id) : null;
    }

    private async canSee(req: any, deviceId: string): Promise<boolean> {
        const scope = await this.access.scopeFor(this.userId(req));
        return this.access.canSeeDevice(scope, deviceId);
    }

    /**
     * Start a new automation run.
     * Returns { jobId } and uses 202 Accepted for async work.
     */
    @Post("runs")
    @HttpCode(202)
    @RequirePerm("automation.run")
    async start(@Req() req: any, @Body() body: RunScriptDto): Promise<{ jobId: string }> {
        // A person limited to some customers gets "not found" for a device outside them.
        await this.access.assertDevice(this.userId(req), body.deviceId);
        const jobId = await this.runs.startRun(body);
        return { jobId };
    }

    /**
     * Get the *full* job snapshot (status, log, times, exitCode).
     */
    @Get("runs/:jobId")
    @RequirePerm("automation.read")
    async getSnapshot(@Req() req: any, @Param("jobId", ParseUUIDPipe) jobId: string) {
        const snap = await this.runs.get(jobId);
        if (!snap || !(await this.canSee(req, snap.deviceId))) throw new NotFoundException("Job not found");
        return snap;
    }

    /**
     * Get just the job logs (kept for compatibility with your current UI).
     */
    @Get("runs/:jobId/log")
    @RequirePerm("automation.read")
    async log(@Req() req: any, @Param("jobId", ParseUUIDPipe) jobId: string): Promise<{ jobId: string; log: string }> {
        const snap = await this.runs.get(jobId);
        if (!snap || !(await this.canSee(req, snap.deviceId))) throw new NotFoundException("Job not found");
        return { jobId, log: snap.log };
    }
}
