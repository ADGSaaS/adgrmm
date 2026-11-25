import { BadRequestException, Body, Controller, Get, Put, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { AuditService } from "../audit/audit.service";
import { agentUpdatesEnabled, AgentUpdatesService } from "./agent-updates.service";
import { AgentSettings, AgentSettingsService } from "../provisioning/agent-settings.service";

const orgOf = (req: any): string => {
    const org = req?.user?.organizationId ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};

/** Administration > Agents & Endpoints. */
@Controller("api/admin/agent-settings")
export class AgentSettingsController {
    constructor(
        private readonly settings: AgentSettingsService,
        private readonly updates: AgentUpdatesService,
        private readonly audit: AuditService,
    ) { }

    private async view(orgId: string) {
        return {
            ...(await this.settings.get(orgId)),
            /** AGENT_UPDATES_ENABLED on the server overrides the switch: when it is off, no agent is offered an update. */
            updatesDisabledByServer: !agentUpdatesEnabled(),
            packages: await this.updates.packageStatus(),
        };
    }

    @Get()
    @RequirePerm("settings.read")
    get(@Req() req: any) {
        return this.view(orgOf(req));
    }

    @Put()
    @RequirePerm("settings.write")
    async save(@Req() req: any, @Body() body: Partial<AgentSettings>) {
        const orgId = orgOf(req);
        const { before, after } = await this.settings.save(orgId, req.user?.id ? String(req.user.id) : null, body && typeof body === "object" ? body : {});
        // Recorded by hand so the entry says what changed.
        await this.audit.record({
            action: "agents.settings.update",
            category: "settings",
            outcome: "success",
            actorUserId: req.user?.id,
            actorEmail: req.user?.email,
            targetType: "organization",
            targetId: orgId,
            req,
            details: { installKeyExpiryMins: `${before.installKeyExpiryMins} -> ${after.installKeyExpiryMins}`, autoUpdate: `${before.autoUpdate} -> ${after.autoUpdate}` },
        });
        return this.view(orgId);
    }
}
