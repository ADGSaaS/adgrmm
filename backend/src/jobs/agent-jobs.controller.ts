import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, Post, UseGuards, Req } from "@nestjs/common";
import { JobsService } from "./jobs.service";
import { AgentTokenGuard, getAgentFromRequest } from "../common/agent-token.util";
import { Public } from "../auth/public.decorator";

@Public() // ✅ agent endpoints use AgentTokenGuard; bypass AuthCookieGuard
@Controller("/api/agent/jobs")
export class AgentJobsController {
    constructor(private readonly jobs: JobsService) { }

    // Agent says: I started running this job
    @Post(":id/running")
    @UseGuards(AgentTokenGuard)
    @HttpCode(204)
    async running(@Req() req: any, @Param("id") jobId: string) {
        const agent = getAgentFromRequest(req);
        const ok = await this.jobs.markRunning(jobId, { agentId: agent.id });
        if (!ok) throw new NotFoundException("No active job with this id for this agent");
    }

    // Agent says: I finished this job (success/fail/timeout)
    @Post(":id/finish")
    @UseGuards(AgentTokenGuard)
    @HttpCode(204)
    async finish(
        @Req() req: any,
        @Param("id") jobId: string,
        @Body()
        body: {
            status: "succeeded" | "failed" | "timeout";
            exitCode: number;
            stdout: string;
            stderr: string;
            durationMs: number;
        },
    ) {
        if (!["succeeded", "failed", "timeout"].includes(body?.status)) {
            throw new BadRequestException("status must be one of: succeeded | failed | timeout");
        }

        const agent = getAgentFromRequest(req);
        const ok = await this.jobs.finishJob(
            jobId,
            {
                exitCode: Number.isInteger(body.exitCode) ? body.exitCode : -1,
                stdout: typeof body.stdout === "string" ? body.stdout : "",
                stderr: typeof body.stderr === "string" ? body.stderr : "",
                durationMs: Number.isFinite(body.durationMs) ? Math.max(0, body.durationMs) : 0,
            },
            body.status,
            { agentId: agent.id },
        );
        if (!ok) throw new NotFoundException("No active job with this id for this agent");
    }
}
