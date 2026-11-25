// backend/src/checks/checks.ingest.controller.ts
import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { AgentTokenGuard, getAgentFromRequest } from "../common/agent-token.util";
import { JobSignerService } from "../common/job-signer.service";
import { IsArray, IsDateString, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { ChecksRuntimeService } from "./checks.runtime.service";
import { Public } from "../auth/public.decorator";

const MAX_RUNS_PER_REQUEST = 200;

/* ----------------------------- DTOs (light) ----------------------------- */

class RunDto {
    @IsOptional() @IsString() assignmentId?: string;
    @IsOptional() @IsString() dedupeKey?: string;
    @IsOptional() @IsString() checkType?: string;
    @IsOptional() @IsString() checkName?: string;

    @IsString() status!: string;
    @IsOptional() @IsString() severity?: "WARN" | "CRIT";

    @IsOptional() @IsObject() metrics?: Record<string, any>;
    @IsOptional() @IsString() output?: string;
    // A date that cannot be parsed would otherwise fail the whole batch with a 500.
    @IsOptional() @IsDateString() startedAt?: string;
    @IsOptional() @IsDateString() finishedAt?: string;
}

class IngestBodyDto {
    @IsString() deviceId!: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => RunDto)
    runs!: RunDto[];
}

/* ----------------------------- Controller ------------------------------- */
/**
 * NOTE:
 * This endpoint used to collide with AgentsController POST /api/agent/check-runs.
 * It has been moved to /api/agent/ingest/check-runs to avoid duplicate route mapping.
 */
@Public()
@Controller("api/agent/ingest")
export class ChecksIngestController {
    constructor(
        private readonly checks: ChecksRuntimeService,
        private readonly signer: JobSignerService,
    ) { }

    /**
     * What this agent should run. Signed like everything else an agent is told to do, even though
     * checks only observe, so tampered traffic cannot point an agent's probes somewhere else.
     */
    @Get("check-plan")
    @UseGuards(AgentTokenGuard)
    async getCheckPlan(@Req() req: Request) {
        const agent = getAgentFromRequest(req);
        if (!agent.deviceId) throw new BadRequestException("This agent is not bound to a device.");

        const plan = await this.checks.getCheckPlan(agent.deviceId);
        return this.signer.seal(agent.id, { planId: randomUUID(), ...plan });
    }

    @Post("check-runs")
    @UseGuards(AgentTokenGuard)
    @HttpCode(HttpStatus.CREATED)
    async postCheckRuns(@Req() req: Request, @Body() body: IngestBodyDto) {
        const agent = getAgentFromRequest(req);
        if (body.deviceId !== agent.deviceId) {
            throw new ForbiddenException("deviceId does not match this agent");
        }
        if (body.runs.length > MAX_RUNS_PER_REQUEST) {
            throw new BadRequestException(`Send at most ${MAX_RUNS_PER_REQUEST} runs at a time.`);
        }

        const result = await this.checks.ingestAgentRuns({
            agentId: agent.id,
            deviceId: body.deviceId,
            runs: body.runs.map((r) => ({
                assignmentId: r.assignmentId,
                dedupeKey: r.dedupeKey,
                checkType: r.checkType,
                checkName: r.checkName,
                status: r.status,
                severity: r.severity,
                metrics: r.metrics,
                output: r.output,
                startedAt: r.startedAt,
                finishedAt: r.finishedAt,
            })),
        });

        return result; // { inserted, assignmentsCreated }
    }
}
