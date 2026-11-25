// backend/src/jobs/jobs.public.controller.ts
import { Controller, Get, NotFoundException, Param, Req } from "@nestjs/common";
import { JobsService } from "./jobs.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "../reports/client-access.service";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";

/**
 * Authenticated job read endpoint (for dashboard/UI polling).
 * - Uses normal cookie auth + PermissionsGuard.
 * - Requires automation.read so random authenticated users can't query arbitrary job ids.
 * - A person limited to some customers only reads jobs that ran on their customers' devices.
 */
@Controller("/api/jobs")
export class JobsPublicController {
    constructor(
        private readonly jobs: JobsService,
        private readonly access: ClientAccessService,
        private readonly prisma: PrismaService,
    ) { }

    @Get(":id") // ✅ canonical (no leading slash)
    @RequirePerm("automation.read")
    async getJob(@Req() req: any, @Param("id") id: string) {
        const scope = await this.access.scopeFor(req?.user?.id ? String(req.user.id) : null);
        if (scope) {
            // Out of scope looks exactly like a job that does not exist.
            const row = isCanonicalUuid(String(id))
                ? await this.prisma.jobs.findUnique({ where: { id }, select: { agents: { select: { device_id: true } } } })
                : null;
            const deviceId = row?.agents?.device_id;
            if (!deviceId || !(await this.access.canSeeDevice(scope, deviceId))) throw new NotFoundException("Job not found");
        }
        return this.jobs.getJobWithResult(id);
    }
}
