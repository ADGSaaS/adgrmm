import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { SoftwareLibraryService } from "./software-library.service";

function orgOf(req: Request): string | null {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    return org ? String(org) : null;
}

const userOf = (req: Request): string | null => ((req as any)?.user?.id ? String((req as any).user.id) : null);

@Controller("api/software-library")
export class SoftwareLibraryController {
    constructor(private readonly svc: SoftwareLibraryService) { }

    @Get()
    @RequirePerm("policies.read")
    list(@Req() req: Request, @Query("q") q?: string, @Query("category") category?: string) {
        return this.svc.list(orgOf(req), userOf(req), q, category);
    }

    @Get("seen")
    @RequirePerm("policies.read")
    seen(@Req() req: Request, @Query("q") q?: string, @Query("clientId") clientId?: string) {
        return this.svc.seen(orgOf(req), userOf(req), q, clientId);
    }

    // What installs and removals did, across everything the person may see
    @Get("installs")
    @RequirePerm("devices.read")
    installs(@Req() req: Request, @Query("status") status?: string, @Query("limit") limit?: string) {
        return this.svc.installs(orgOf(req), userOf(req), { status, limit: limit ? Number(limit) : undefined });
    }

    @Post()
    @RequirePerm("policies.write")
    create(@Req() req: Request, @Body() body: unknown) {
        return this.svc.create(body, userOf(req), orgOf(req));
    }

    @Patch(":id")
    @RequirePerm("policies.write")
    update(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
        return this.svc.update(id, body, orgOf(req));
    }

    @Delete(":id")
    @RequirePerm("policies.write")
    remove(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.remove(id, orgOf(req));
    }

    // Reading what an install would touch changes nothing, so it only needs the right to install
    // The plan behind "Fix now" on the software compliance report. It changes nothing.
    @Post("fix-plan")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("software.install")
    fixPlan(@Req() req: Request, @Body() body: unknown) {
        return this.svc.fixPlan(orgOf(req), userOf(req), body);
    }

    @Post(":id/install-preview")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("software.install")
    preview(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
        return this.svc.preview(id, body, userOf(req), orgOf(req));
    }

    @Post(":id/install")
    @HttpCode(HttpStatus.ACCEPTED)
    @RequirePerm("software.install")
    install(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
        return this.svc.queue(id, body, userOf(req), orgOf(req));
    }
}

@Controller("api/devices")
export class DeviceSoftwareInstallController {
    constructor(private readonly svc: SoftwareLibraryService) { }

    // GET /api/devices/:deviceId/software/users   the accounts this device reported, and who is signed in
    @Get(":deviceId/software/users")
    @RequirePerm("devices.read")
    users(@Req() req: Request, @Param("deviceId", new ParseUUIDPipe()) deviceId: string) {
        return this.svc.users(orgOf(req), userOf(req), deviceId);
    }

    // GET /api/devices/:deviceId/software/installs   what installs and removals did on this device
    @Get(":deviceId/software/installs")
    @RequirePerm("devices.read")
    installs(@Req() req: Request, @Param("deviceId", new ParseUUIDPipe()) deviceId: string, @Query("limit") limit?: string) {
        return this.svc.installs(orgOf(req), userOf(req), { deviceId, limit: limit ? Number(limit) : undefined });
    }

    // POST /api/devices/:deviceId/software/install   { libraryId, action }
    @Post(":deviceId/software/install")
    @HttpCode(HttpStatus.ACCEPTED)
    @RequirePerm("software.install")
    install(@Req() req: Request, @Param("deviceId", new ParseUUIDPipe()) deviceId: string, @Body() body: unknown) {
        return this.svc.queueOne(deviceId, body, userOf(req), orgOf(req));
    }
}
