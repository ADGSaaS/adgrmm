// backend/src/snmp/snmp.controller.ts
//
// SNMP monitoring (/api/snmp). A monitored device is a printer, switch or other network device that has no agent; a managed Windows or
// Linux device of the same site polls it.
//   GET    /devices          the monitored devices (devices.read), limited to the person's customers
//   GET    /devices/:id      one device with supplies, printer state, interfaces and history
//   POST   /devices          start monitoring {siteId, ip, community?, name?, kind?, pollMinutes?, port?, pollerDeviceId?}: devices.actions; polls at once
//   PATCH  /devices/:id      change settings; the community string is only replaced when given, and never returned
//   DELETE /devices/:id      stop monitoring
//   POST   /devices/:id/poll poll now
// Every change is audited, without the community string.
import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { AuditService } from "../audit/audit.service";
import { SnmpService } from "./snmp.service";

class ListQuery {
    @IsOptional() @IsString() @MaxLength(64) clientId?: string;
    @IsOptional() @IsString() @MaxLength(64) siteId?: string;
    @IsOptional() @IsString() @MaxLength(20) status?: string;
    @IsOptional() @IsString() @MaxLength(100) q?: string;
}

class CreateDto {
    @IsUUID("all", { message: "Choose the site." }) siteId!: string;
    @IsString() @MaxLength(45) ip!: string;
    @IsOptional() @IsInt() port?: number;
    @IsOptional() @IsString() @MaxLength(80) community?: string;
    @IsOptional() @IsString() @MaxLength(200) name?: string;
    @IsOptional() @IsString() @MaxLength(20) kind?: string;
    @IsOptional() @IsInt() pollMinutes?: number;
    @IsOptional() @IsBoolean() alertEnabled?: boolean;
    @IsOptional() @IsUUID("all") pollerDeviceId?: string | null;
}

class UpdateDto {
    @IsOptional() @IsInt() port?: number;
    @IsOptional() @IsString() @MaxLength(80) community?: string;
    @IsOptional() @IsString() @MaxLength(200) name?: string | null;
    @IsOptional() @IsString() @MaxLength(20) kind?: string;
    @IsOptional() @IsInt() pollMinutes?: number;
    @IsOptional() @IsBoolean() enabled?: boolean;
    @IsOptional() @IsBoolean() alertEnabled?: boolean;
    @IsOptional() @IsUUID("all") pollerDeviceId?: string | null;
}

const userOf = (req: any): string | null => (req?.user?.id ? String(req.user.id) : null);

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/snmp")
export class SnmpController {
    constructor(private readonly snmp: SnmpService, private readonly audit: AuditService) { }

    @Get("devices")
    @RequirePerm("devices.read")
    list(@Req() req: any, @Query() q: ListQuery) {
        return this.snmp.list(userOf(req), q);
    }

    @Get("devices/:id")
    @RequirePerm("devices.read")
    get(@Req() req: any, @Param("id") id: string) {
        return this.snmp.get(userOf(req), id);
    }

    @Post("devices")
    @HttpCode(201)
    @RequirePerm(["devices.read", "devices.actions"])
    async create(@Req() req: any, @Body() body: CreateDto) {
        try {
            const id = await this.snmp.create(userOf(req), body);
            this.record(req, "snmp.device.add", "success", id, { siteId: body.siteId, ip: body.ip, kind: body.kind ?? "auto" });
            try { await this.snmp.pollNow(userOf(req), id); } catch { /* the device is added; the first poll is retried by the scheduler */ }
            return this.snmp.get(userOf(req), id);
        } catch (e: any) {
            this.record(req, "snmp.device.add", "failure", null, { siteId: body.siteId, ip: body.ip, error: String(e?.message ?? "").slice(0, 200) });
            throw e;
        }
    }

    @Patch("devices/:id")
    @RequirePerm(["devices.read", "devices.actions"])
    async update(@Req() req: any, @Param("id") id: string, @Body() body: UpdateDto) {
        await this.snmp.update(userOf(req), id, body);
        const { community, ...rest } = body;
        this.record(req, "snmp.device.update", "success", id, { ...rest, communityChanged: community !== undefined });
        return this.snmp.get(userOf(req), id);
    }

    @Delete("devices/:id")
    @RequirePerm(["devices.read", "devices.actions"])
    async remove(@Req() req: any, @Param("id") id: string) {
        if (!(await this.snmp.remove(userOf(req), id))) throw new NotFoundException("Device not found");
        this.record(req, "snmp.device.remove", "success", id, {});
        return { deleted: true };
    }

    @Post("devices/:id/asset")
    @HttpCode(200)
    @RequirePerm(["devices.read", "assets.write"])
    async addAsset(@Req() req: any, @Param("id") id: string) {
        try {
            const r = await this.snmp.addAsset(userOf(req), id);
            this.record(req, "snmp.device.asset", "success", id, { provider: r.provider, alreadyLinked: r.alreadyLinked });
            return r;
        } catch (e: any) {
            this.record(req, "snmp.device.asset", "failure", id, { error: String(e?.message ?? "").slice(0, 200) });
            throw e;
        }
    }

    @Post("devices/:id/poll")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions"])
    async poll(@Req() req: any, @Param("id") id: string) {
        const r = await this.snmp.pollNow(userOf(req), id);
        this.record(req, "snmp.device.poll", "success", id, { alreadyPolling: r.alreadyPolling });
        return r;
    }

    private record(req: any, action: string, outcome: "success" | "failure", targetId: string | null, details: Record<string, unknown>) {
        void this.audit.record({
            action, category: "device", outcome, actorUserId: userOf(req), actorEmail: req?.user?.email ? String(req.user.email) : null,
            req, targetType: "snmp-device", targetId: targetId ?? undefined, details,
        });
    }
}
