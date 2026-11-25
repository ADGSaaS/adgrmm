// backend/src/agents/agent-releases.controller.ts
//
// Administration > Agents & Endpoints > Releases (staged rollout, roadmap 10.10).
//   GET   /api/admin/agent-releases                       status for everyone who may read settings (canManage says whether the controls show)
//   POST  /api/admin/agent-releases/promote               needs agents.release.manage
//   POST  /api/admin/agent-releases/withdraw              needs agents.release.manage
//   PATCH /api/admin/agent-releases/devices/:id/ring      needs agents.release.manage (+ devices.write); a limited person only reaches their devices
//   GET   /api/admin/agent-releases/customers/:id/ring
//   PATCH /api/admin/agent-releases/customers/:id/ring    needs agents.release.manage (+ customers.write)
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";

import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "../reports/client-access.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { Actor, AgentReleasesService } from "./agent-releases.service";

const actorOf = (req: any): Actor => {
    const u = req?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    return { id: u?.id ? String(u.id) : null, email: u?.email ? String(u.email) : null, organizationId: org ? String(org) : null };
};

@Controller("api/admin/agent-releases")
export class AgentReleasesController {
    constructor(
        private readonly releases: AgentReleasesService,
        private readonly access: ClientAccessService,
        private readonly orgs: OrganizationContextService,
    ) { }

    private async orgId(req: any): Promise<string> {
        return actorOf(req).organizationId || (await this.orgs.getDefaultOrganizationId());
    }

    private body(b: unknown): Record<string, unknown> {
        if (!b || typeof b !== "object" || Array.isArray(b)) throw new BadRequestException("The request body must be a JSON object.");
        return b as Record<string, unknown>;
    }

    @Get()
    @RequirePerm("settings.read")
    async status(@Req() req: any) {
        const perms: Set<string> | undefined = req?.effectivePermissions;
        return { ...(await this.releases.status(await this.orgId(req))), canManage: !!perms?.has("agents.release.manage") };
    }

    @Post("promote")
    @HttpCode(200)
    @RequirePerm("agents.release.manage")
    async promote(@Req() req: any, @Body() raw: unknown) {
        const b = this.body(raw);
        const orgId = await this.orgId(req);
        const done = await this.releases.promote(actorOf(req), orgId, req, { os: b.os, candidateVersion: b.candidateVersion, force: b.force, reason: b.reason });
        return { ...done, status: await this.releases.status(orgId) };
    }

    @Post("withdraw")
    @HttpCode(200)
    @RequirePerm("agents.release.manage")
    async withdraw(@Req() req: any, @Body() raw: unknown) {
        const b = this.body(raw);
        const orgId = await this.orgId(req);
        const done = await this.releases.withdraw(actorOf(req), orgId, req, { os: b.os, candidateVersion: b.candidateVersion });
        return { ...done, status: await this.releases.status(orgId) };
    }

    @Patch("devices/:id/ring")
    @RequirePerm(["agents.release.manage", "devices.write"])
    async deviceRing(@Req() req: any, @Param("id") id: string, @Body() raw: unknown) {
        const b = this.body(raw);
        if (!("ring" in b)) throw new BadRequestException("ring is required.");
        const ring = AgentReleasesService.parseRing(b.ring, true);
        const a = actorOf(req);
        return this.releases.setDeviceRing(a, await this.orgId(req), req, id, ring, await this.access.scopeFor(a.id));
    }

    @Get("customers/:id/ring")
    @RequirePerm("customers.read")
    async getCustomerRing(@Req() req: any, @Param("id") id: string) {
        return this.releases.getCustomerRing(await this.orgId(req), id, await this.access.allowedFor(actorOf(req).id));
    }

    @Patch("customers/:id/ring")
    @RequirePerm(["agents.release.manage", "customers.write"])
    async customerRing(@Req() req: any, @Param("id") id: string, @Body() raw: unknown) {
        const b = this.body(raw);
        const ring = AgentReleasesService.parseRing(b.ring, false)!;
        const a = actorOf(req);
        return this.releases.setCustomerRing(a, await this.orgId(req), req, id, ring, await this.access.allowedFor(a.id));
    }
}
