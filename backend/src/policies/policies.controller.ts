// backend/src/policies/policies.controller.ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { PoliciesService, type Actor } from "./policies.service";
import { ClientAccessService } from "../reports/client-access.service";

function orgOf(req: Request): string | null {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    return org ? String(org) : null;
}

function actorOf(req: Request): Actor {
    const u = (req as any)?.user;
    const name = [u?.firstName ?? u?.first_name, u?.lastName ?? u?.last_name].filter(Boolean).join(" ") || u?.name || u?.email || null;
    return { id: u?.id ? String(u.id) : null, name: name ? String(name) : null };
}

@Controller("api/policies")
export class PoliciesController {
    constructor(private readonly svc: PoliciesService, private readonly access: ClientAccessService) { }

    @Get()
    @RequirePerm("policies.read")
    list(@Req() req: Request) {
        return this.svc.list(orgOf(req));
    }

    @Post()
    @RequirePerm("policies.write")
    create(@Req() req: Request, @Body() body: unknown) {
        return this.svc.create(body, actorOf(req), orgOf(req));
    }

    // Templates: patterns that are never applied; people copy one to a global, customer, site or tag policy
    @Get("templates")
    @RequirePerm("policies.read")
    templates(@Req() req: Request) {
        return this.svc.listTemplates(orgOf(req));
    }

    @Post("templates")
    @RequirePerm("policies.write")
    createTemplate(@Req() req: Request, @Body() body: unknown) {
        return this.svc.createTemplate(body, actorOf(req), orgOf(req));
    }

    @Patch("templates/:id")
    @RequirePerm("policies.write")
    updateTemplate(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
        return this.svc.updateTemplate(id, body, orgOf(req));
    }

    @Delete("templates/:id")
    @RequirePerm("policies.write")
    removeTemplate(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.removeTemplate(id, orgOf(req));
    }

    // Named bundles of checks a policy can hand to a device
    @Get("check-profiles")
    @RequirePerm("policies.read")
    profiles(@Req() req: Request) {
        return this.svc.listProfiles(orgOf(req));
    }

    @Post("check-profiles")
    @RequirePerm("policies.write")
    createProfile(@Req() req: Request, @Body() body: unknown) {
        return this.svc.createProfile(body, actorOf(req), orgOf(req));
    }

    @Patch("check-profiles/:id")
    @RequirePerm("policies.write")
    updateProfile(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
        return this.svc.updateProfile(id, body, orgOf(req));
    }

    @Delete("check-profiles/:id")
    @RequirePerm("policies.write")
    removeProfile(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.removeProfile(id, orgOf(req));
    }

    // The policies every new customer gets, and the customers that have drifted from them
    @Get("baseline")
    @RequirePerm("policies.read")
    baseline(@Req() req: Request) {
        return this.svc.baselineStatus(orgOf(req));
    }

    @Post("baseline/apply")
    @RequirePerm("policies.write")
    applyBaseline(@Req() req: Request) {
        return this.svc.applyBaseline(actorOf(req), orgOf(req));
    }

    // What changed and who changed it, for every policy
    @Get("history")
    @RequirePerm("policies.read")
    allHistory(@Req() req: Request, @Query("limit") limit?: string) {
        return this.svc.history(null, orgOf(req), Number(limit) || 100);
    }

    // See the effect of a change before saving it
    @Post("preview")
    @RequirePerm("policies.read")
    preview(@Req() req: Request, @Body() body: unknown) {
        return this.svc.preview(body, orgOf(req));
    }

    // Put a policy back as it was after a recorded change
    @Post("history/:auditId/restore")
    @RequirePerm("policies.write")
    restore(@Req() req: Request, @Param("auditId", new ParseUUIDPipe()) auditId: string) {
        return this.svc.restore(auditId, actorOf(req), orgOf(req));
    }

    // What one device gets, and why
    @Get("devices/:deviceId/effective")
    @RequirePerm("policies.read")
    async effective(@Req() req: Request, @Param("deviceId", new ParseUUIDPipe()) deviceId: string) {
        const id = (req as any)?.user?.id;
        return this.svc.explainDevice(deviceId, orgOf(req), await this.access.scopeFor(id ? String(id) : null));
    }

    @Get(":id")
    @RequirePerm("policies.read")
    get(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.get(id, orgOf(req));
    }

    @Patch(":id")
    @RequirePerm("policies.write")
    update(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
        return this.svc.update(id, body, actorOf(req), orgOf(req));
    }

    @Delete(":id")
    @RequirePerm("policies.write")
    remove(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.remove(id, actorOf(req), orgOf(req));
    }

    @Post(":id/duplicate")
    @RequirePerm("policies.write")
    duplicate(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.duplicate(id, actorOf(req), orgOf(req));
    }

    @Get(":id/devices")
    @RequirePerm("policies.read")
    devices(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.devicesOf(id, orgOf(req));
    }

    @Get(":id/history")
    @RequirePerm("policies.read")
    history(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.history(id, orgOf(req));
    }
}
