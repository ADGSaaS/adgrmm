import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "../reports/client-access.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PortalAccountsService } from "./portal-accounts.service";
import { PortalSettingsService, type PortalSettingsInput } from "./portal-settings.service";

/** For the support team: the portal's settings, and who from each customer may sign in. */
@Controller("api/portal-admin")
export class PortalAdminController {
    constructor(
        private readonly settings: PortalSettingsService,
        private readonly accounts: PortalAccountsService,
        private readonly access: ClientAccessService,
        private readonly orgs: OrganizationContextService,
    ) { }

    private userId(req: Request): string | null {
        const id = (req as any)?.user?.id;
        return id ? String(id) : null;
    }

    private allowed(req: Request) {
        return this.access.visibleClientsFor(this.userId(req));
    }

    @Get("settings")
    @RequirePerm("settings.read")
    getSettings() {
        return this.settings.get();
    }

    @Put("settings")
    @RequirePerm("settings.write")
    putSettings(@Body() body: PortalSettingsInput) {
        return this.settings.update(body ?? {});
    }

    /** Looks at the address from outside and says whether it reaches this system. */
    @Post("settings/check")
    @HttpCode(200)
    @RequirePerm("settings.write")
    async check(@Body() body: { domain?: string }) {
        const domain = body?.domain ?? (await this.settings.get()).domain ?? "";
        return this.settings.checkReachable(String(domain));
    }

    @Get("accounts")
    @RequirePerm("customers.read")
    async list(@Req() req: Request, @Query("clientId") clientId?: string) {
        return this.accounts.list(await this.allowed(req), clientId || undefined);
    }

    @Post("accounts")
    @RequirePerm("customers.write")
    async create(@Req() req: Request, @Body() body: { clientId?: string; contactId?: string | null; email?: string; name?: string; role?: string; sendInvite?: boolean }) {
        return this.accounts.create(this.userId(req), await this.allowed(req), body ?? {}, await this.orgs.getDefaultOrganizationId());
    }

    @Patch("accounts/:id")
    @RequirePerm("customers.write")
    async update(@Req() req: Request, @Param("id") id: string, @Body() body: { name?: string; role?: string; status?: string }) {
        return this.accounts.update(id, await this.allowed(req), body ?? {});
    }

    /** Sends the invitation again, or a password reset link to someone who has already signed up. */
    @Post("accounts/:id/send")
    @HttpCode(200)
    @RequirePerm("customers.write")
    async send(@Req() req: Request, @Param("id") id: string) {
        return this.accounts.resend(id, await this.allowed(req));
    }

    @Delete("accounts/:id")
    @RequirePerm("customers.write")
    async remove(@Req() req: Request, @Param("id") id: string) {
        return this.accounts.remove(id, await this.allowed(req));
    }
}
