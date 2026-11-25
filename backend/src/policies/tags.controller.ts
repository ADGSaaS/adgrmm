// backend/src/policies/tags.controller.ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { TagsService } from "./tags.service";

function orgOf(req: Request): string | null {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    return org ? String(org) : null;
}

function userOf(req: Request): string | null {
    const id = (req as any)?.user?.id;
    return id ? String(id) : null;
}

@Controller("api/tags")
export class TagsController {
    constructor(private readonly svc: TagsService) { }

    @Get()
    @RequirePerm("devices.read")
    list(@Req() req: Request) {
        return this.svc.list(orgOf(req));
    }

    @Post()
    @RequirePerm("policies.write")
    create(@Req() req: Request, @Body() body: unknown) {
        return this.svc.create(body, orgOf(req));
    }

    // The tags one device has, and replacing them
    @Get("devices/:deviceId")
    @RequirePerm("devices.read")
    ofDevice(@Req() req: Request, @Param("deviceId", new ParseUUIDPipe()) deviceId: string) {
        return this.svc.ofDevice(deviceId, orgOf(req), userOf(req));
    }

    @Put("devices/:deviceId")
    @RequirePerm("devices.write")
    setForDevice(@Req() req: Request, @Param("deviceId", new ParseUUIDPipe()) deviceId: string, @Body() body: unknown) {
        return this.svc.setForDevice(deviceId, body, orgOf(req), userOf(req));
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

    @Get(":id/devices")
    @RequirePerm("devices.read")
    devices(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
        return this.svc.devicesOf(id, orgOf(req), userOf(req));
    }

    // Put the tag on, or take it off ({ remove: true }), many devices at once
    @Post(":id/devices")
    @RequirePerm("devices.write")
    bulk(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
        return this.svc.bulk(id, body, orgOf(req), userOf(req));
    }
}
