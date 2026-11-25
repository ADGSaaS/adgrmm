// FILE: remoteiq-minimal-e2e/backend/src/customers/customers.controller.ts

import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    Param,
    Patch,
    Post,
    Query,
    Req,
} from "@nestjs/common";
import type { Request } from "express";
import { CustomersService } from "./customers.service";
import { PortalAccountsService } from "../portal/portal-accounts.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "../reports/client-access.service";

type CreateClientDto = Record<string, unknown>;

type CreateSiteDto = Record<string, unknown>;

function getOrgId(req: Request): string | null {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    return org ? String(org) : null;
}

@Controller("api/customers")
export class CustomersController {
    constructor(private readonly svc: CustomersService, private readonly access: ClientAccessService, private readonly portal: PortalAccountsService) { }

    /** The customers this person is limited to, or null when they may see all of them. */
    private allowed(req: Request): Promise<string[] | null> {
        const id = (req as any)?.user?.id;
        return this.access.visibleClientsFor(id ? String(id) : null);
    }

    /** Throws when a limited person asks about a customer outside their list. */
    private async guard(req: Request, client: string) {
        const allowed = await this.allowed(req);
        if (allowed) await this.svc.assertAllowed(client, allowed, getOrgId(req));
    }

    @Get()
    @RequirePerm("customers.read")
    async listClients(@Req() req: Request, @Query("q") q?: string, @Query("archived") archived?: string) {
        return this.svc.listClients(q ?? "", getOrgId(req), String(archived ?? "").toLowerCase() === "true", await this.allowed(req));
    }

    // ✅ Create client
    @Post()
    @RequirePerm("customers.write")
    async createClient(@Req() req: Request, @Body() body: CreateClientDto) {
        // A new customer would not be on a limited person's list, so they could not see what they made.
        if (await this.allowed(req)) throw new ForbiddenException("People who are limited to some customers cannot create customers.");
        const created = await this.svc.createClient(body, getOrgId(req));
        // People entered on the new customer are invited to the client portal as managers.
        const id = (created as any)?.id;
        const orgId = getOrgId(req);
        if (id && orgId) {
            const uid = (req as any)?.user?.id;
            const portal = await this.portal.inviteContactsOf(String(id), orgId, uid ? String(uid) : null);
            return { ...created, portalInvites: portal };
        }
        return created;
    }

    // One customer with everything we keep about them
    @Get(":client")
    @RequirePerm("customers.read")
    async getClient(@Req() req: Request, @Param("client") client: string) {
        await this.guard(req, client);
        return this.svc.getProfile(client, getOrgId(req));
    }

    @Get(":client/sites")
    @RequirePerm("customers.read")
    async listSites(@Req() req: Request, @Param("client") client: string) {
        await this.guard(req, client);
        return this.svc.listSitesForClient(client, getOrgId(req));
    }

    // ✅ Create site for client
    @Post(":client/sites")
    @RequirePerm("customers.write")
    async createSite(
        @Req() req: Request,
        @Param("client") client: string,
        @Body() body: CreateSiteDto
    ) {
        await this.guard(req, client);
        return this.svc.createSiteForClient(client, body, getOrgId(req));
    }

    // Change a customer's details (a name alone still works)
    @Patch(":client")
    @RequirePerm("customers.write")
    async updateClient(
        @Req() req: Request,
        @Param("client") client: string,
        @Body() body: Record<string, unknown>
    ) {
        await this.guard(req, client);
        return this.svc.updateClient(client, body, getOrgId(req));
    }

    // One site with everything we keep about it
    @Get(":client/sites/:site")
    @RequirePerm("customers.read")
    async getSite(@Req() req: Request, @Param("client") client: string, @Param("site") site: string) {
        await this.guard(req, client);
        return this.svc.getSite(client, site, getOrgId(req));
    }

    // Change a site's details (a name alone still renames)
    @Patch(":client/sites/:site")
    @RequirePerm("customers.write")
    async updateSite(
        @Req() req: Request,
        @Param("client") client: string,
        @Param("site") site: string,
        @Body() body: Record<string, unknown>
    ) {
        await this.guard(req, client);
        return this.svc.updateSite(client, site, body, getOrgId(req));
    }

    // Archive: hide a customer from the lists without deleting anything
    @Post(":client/archive")
    @RequirePerm("customers.write")
    async archiveClient(@Req() req: Request, @Param("client") client: string) {
        await this.guard(req, client);
        return this.svc.setArchived(client, true, getOrgId(req));
    }

    @Post(":client/restore")
    @RequirePerm("customers.write")
    async restoreClient(@Req() req: Request, @Param("client") client: string) {
        await this.guard(req, client);
        return this.svc.setArchived(client, false, getOrgId(req));
    }

    // What the person at a customer's devices is told when a technician starts Remote Console.
    @Get(":client/remote-console")
    @RequirePerm("customers.read")
    async getRemoteConsoleSetting(@Req() req: Request, @Param("client") client: string) {
        await this.guard(req, client);
        return this.svc.getRemoteConsoleConsent(client, getOrgId(req));
    }

    @Patch(":client/remote-console")
    @RequirePerm("customers.write")
    async setRemoteConsoleSetting(
        @Req() req: Request,
        @Param("client") client: string,
        @Body() body: { consent?: string; record?: boolean; codec?: string }
    ) {
        await this.guard(req, client);
        return this.svc.setRemoteConsoleConsent(client, body?.consent, getOrgId(req), body?.record, body?.codec);
    }

    // ✅ Delete a site under a client (site can be UUID or name within that client)
    @Delete(":client/sites/:site")
    @RequirePerm("customers.write")
    async deleteSite(
        @Req() req: Request,
        @Param("client") client: string,
        @Param("site") site: string
    ) {
        await this.guard(req, client);
        return this.svc.deleteSiteForClient(client, site, getOrgId(req));
    }

    // ✅ Delete a client
    // ?force=true will delete empty sites then the client (but refuses if devices/tickets exist)
    @Delete(":client")
    @RequirePerm("customers.write")
    async deleteClient(
        @Req() req: Request,
        @Param("client") client: string,
        @Query("force") force?: string
    ) {
        await this.guard(req, client);
        const doForce = String(force ?? "").toLowerCase() === "true";
        return this.svc.deleteClient(client, { force: doForce }, getOrgId(req));
    }
}
