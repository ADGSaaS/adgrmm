import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { SoftwareUpdatesService } from "./software-updates.service";

function orgOf(req: Request): string | null {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    return org ? String(org) : null;
}

const userOf = (req: Request): string | null => ((req as any)?.user?.id ? String((req as any).user.id) : null);

@Controller("api/software-updates")
export class SoftwareUpdatesController {
    constructor(private readonly svc: SoftwareUpdatesService) { }

    // GET /api/software-updates/fleet?clientId&q&source   one row per outdated program, with device counts and versions
    @Get("fleet")
    @RequirePerm("devices.read")
    fleet(@Req() req: Request, @Query("clientId") clientId?: string, @Query("q") q?: string, @Query("source") source?: string) {
        return this.svc.fleet(orgOf(req), userOf(req), { clientId, q, source });
    }

    // GET /api/software-updates/fleet/devices?source&appId&clientId   the devices that have one program outdated
    @Get("fleet/devices")
    @RequirePerm("devices.read")
    fleetDevices(@Req() req: Request, @Query("source") source?: string, @Query("appId") appId?: string, @Query("clientId") clientId?: string) {
        return this.svc.fleetDevices(orgOf(req), userOf(req), { source, appId, clientId });
    }

    // POST /api/software-updates/scan   { deviceIds }   look for outdated programs now (max 200 devices)
    @Post("scan")
    @HttpCode(HttpStatus.ACCEPTED)
    @RequirePerm("software.install")
    scan(@Req() req: Request, @Body() body: unknown) {
        return this.svc.scanNow(body, userOf(req), orgOf(req));
    }

    // POST /api/software-updates/preview   { deviceIds, apps: [{source, appId}] | all: true }   changes nothing
    @Post("preview")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("software.install")
    preview(@Req() req: Request, @Body() body: unknown) {
        return this.svc.preview(body, userOf(req), orgOf(req));
    }

    // POST /api/software-updates/update   { deviceIds, apps: [{source, appId}] | all: true }   update now (max 200 devices)
    @Post("update")
    @HttpCode(HttpStatus.ACCEPTED)
    @RequirePerm("software.install")
    update(@Req() req: Request, @Body() body: unknown) {
        return this.svc.update(body, userOf(req), orgOf(req));
    }

    // GET /api/software-updates/rules?clientId   the allowed-to-update and never-update lists
    @Get("rules")
    @RequirePerm("policies.read")
    rules(@Req() req: Request, @Query("clientId") clientId?: string) {
        return this.svc.listRules(orgOf(req), userOf(req), clientId);
    }

    // POST /api/software-updates/rules   { rule: "allow" | "block", source, appId, name?, clientId? }
    @Post("rules")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("policies.write")
    setRule(@Req() req: Request, @Body() body: unknown) {
        return this.svc.setRule(body, userOf(req), orgOf(req));
    }

    @Delete("rules/:id")
    @RequirePerm("policies.write")
    removeRule(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.removeRule(id, userOf(req), orgOf(req));
    }
}

@Controller("api/devices")
export class DeviceSoftwareUpdatesController {
    constructor(private readonly svc: SoftwareUpdatesService) { }

    // GET /api/devices/:deviceId/software/updates   outdated programs on this device, the last scan, and what policies do
    @Get(":deviceId/software/updates")
    @RequirePerm("devices.read")
    forDevice(@Req() req: Request, @Param("deviceId", new ParseUUIDPipe()) deviceId: string) {
        return this.svc.forDevice(orgOf(req), userOf(req), deviceId);
    }
}
