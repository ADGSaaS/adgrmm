// backend/src/network-discovery/network-discovery.controller.ts
//
// Network discovery (/api/network-discovery).
//   GET  /hosts      what was found: status unmanaged (default), managed, ignored or all; devices.read, limited to the person's customers
//   GET  /runs       the latest scans;  GET /runs/:id  one scan, read back when it has finished
//   GET  /scanners   the online Windows and Linux devices a scan can run from
//   POST /scan       scan from a device {deviceId, ranges?}: needs devices.actions; private ranges only; audited
//   POST /ignore     hide hosts from the default list {ids, ignored}: needs devices.actions; audited
// A scan only looks; nothing here changes a device or the network.
import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import { ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { AuditService } from "../audit/audit.service";
import { NetworkDiscoveryService } from "./network-discovery.service";
import { NetworkDiscoverySchedulesService } from "./network-discovery-schedules.service";

class HostsQuery {
    @IsOptional() @IsString() @MaxLength(20) status?: string;
    @IsOptional() @IsString() @MaxLength(64) clientId?: string;
    @IsOptional() @IsString() @MaxLength(64) siteId?: string;
    @IsOptional() @IsString() @MaxLength(100) q?: string;
    @IsOptional() @IsString() @MaxLength(10) limit?: string;
    @IsOptional() @IsString() @MaxLength(10) offset?: string;
}

class ScanDto {
    @IsUUID("all", { message: "Choose the device to scan from." }) deviceId!: string;
    @IsOptional() @IsArray() @IsString({ each: true }) ranges?: string[];
}

class ScheduleDto {
    @IsOptional() @IsBoolean() enabled?: boolean;
    @IsOptional() @IsInt() intervalHours?: number;
    @IsOptional() @IsArray() @IsString({ each: true }) ranges?: string[];
    @IsOptional() @IsUUID("all") scannerDeviceId?: string | null;
    @IsOptional() @IsBoolean() alertNew?: boolean;
}

class ScanManyDto {
    @IsArray({ message: "Choose at least one device." }) @ArrayMinSize(1, { message: "Choose at least one device." }) @IsUUID("all", { each: true }) deviceIds!: string[];
    @IsOptional() @IsArray() @IsString({ each: true }) ranges?: string[];
}

class IgnoreDto {
    @IsArray({ message: "Choose at least one host." }) @ArrayMinSize(1, { message: "Choose at least one host." }) @IsUUID("all", { each: true }) ids!: string[];
    @IsBoolean() ignored!: boolean;
}

const userOf = (req: any): string | null => (req?.user?.id ? String(req.user.id) : null);

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/network-discovery")
export class NetworkDiscoveryController {
    constructor(private readonly discovery: NetworkDiscoveryService, private readonly schedules: NetworkDiscoverySchedulesService, private readonly audit: AuditService) { }

    @Get("hosts")
    @RequirePerm("devices.read")
    hosts(@Req() req: any, @Query() q: HostsQuery) {
        return this.discovery.list(userOf(req), { status: q.status, clientId: q.clientId, siteId: q.siteId, q: q.q, limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined });
    }

    @Get("runs")
    @RequirePerm("devices.read")
    runs(@Req() req: any) {
        return this.discovery.runs(userOf(req));
    }

    @Get("runs/:id")
    @RequirePerm("devices.read")
    run(@Req() req: any, @Param("id") id: string) {
        return this.discovery.run(userOf(req), id);
    }

    @Get("scanners")
    @RequirePerm(["devices.read", "devices.actions"])
    scanners(@Req() req: any) {
        return this.discovery.scanners(userOf(req));
    }

    @Post("scan")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions"])
    async scan(@Req() req: any, @Body() body: ScanDto) {
        try {
            const r = await this.discovery.startScan(userOf(req), body.deviceId, body.ranges ?? []);
            this.record(req, "network.discovery.scan", "success", body.deviceId, { ranges: r.ranges, alreadyRunning: r.alreadyRunning });
            return r;
        } catch (e: any) {
            this.record(req, "network.discovery.scan", "failure", body.deviceId, { error: String(e?.message ?? "").slice(0, 200) });
            throw e;
        }
    }

    @Post("scan-many")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions"])
    async scanMany(@Req() req: any, @Body() body: ScanManyDto) {
        try {
            const r = await this.discovery.startScans(userOf(req), body.deviceIds, body.ranges ?? []);
            this.record(req, "network.discovery.scan", "success", null, { devices: body.deviceIds.length, started: r.started, alreadyRunning: r.alreadyRunning, skipped: r.skipped, ranges: body.ranges ?? [] });
            return r;
        } catch (e: any) {
            this.record(req, "network.discovery.scan", "failure", null, { devices: body.deviceIds?.length ?? 0, error: String(e?.message ?? "").slice(0, 200) });
            throw e;
        }
    }

    @Post("hosts/:id/asset")
    @HttpCode(200)
    @RequirePerm(["devices.read", "assets.write"])
    async addAsset(@Req() req: any, @Param("id") id: string) {
        try {
            const r = await this.discovery.addAsset(userOf(req), id);
            this.record(req, "network.discovery.asset", "success", null, { host: id, provider: r.provider, alreadyLinked: r.alreadyLinked });
            return r;
        } catch (e: any) {
            this.record(req, "network.discovery.asset", "failure", null, { host: id, error: String(e?.message ?? "").slice(0, 200) });
            throw e;
        }
    }

    @Post("ignore")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions"])
    async ignore(@Req() req: any, @Body() body: IgnoreDto) {
        const changed = await this.discovery.setIgnored(userOf(req), body.ids, body.ignored);
        this.record(req, body.ignored ? "network.discovery.ignore" : "network.discovery.unignore", "success", null, { hosts: changed });
        return { changed };
    }

    @Get("schedules")
    @RequirePerm("devices.read")
    listSchedules(@Req() req: any) {
        return this.schedules.list(userOf(req));
    }

    @Put("schedules/:siteId")
    @RequirePerm(["devices.read", "devices.actions"])
    async saveSchedule(@Req() req: any, @Param("siteId") siteId: string, @Body() body: ScheduleDto) {
        const r = await this.schedules.save(userOf(req), siteId, body);
        this.record(req, "network.discovery.schedule.save", "success", null, { siteId, intervalHours: r?.intervalHours, enabled: r?.enabled, alertNew: r?.alertNew });
        return r;
    }

    @Delete("schedules/:siteId")
    @RequirePerm(["devices.read", "devices.actions"])
    async deleteSchedule(@Req() req: any, @Param("siteId") siteId: string) {
        if (!(await this.schedules.remove(userOf(req), siteId))) throw new NotFoundException("Schedule not found");
        this.record(req, "network.discovery.schedule.delete", "success", null, { siteId });
        return { deleted: true };
    }

    private record(req: any, action: string, outcome: "success" | "failure", targetId: string | null, details: Record<string, unknown>) {
        void this.audit.record({
            action, category: "device", outcome, actorUserId: userOf(req), actorEmail: req?.user?.email ? String(req.user.email) : null,
            req, targetType: targetId ? "device" : "network-discovery", targetId: targetId ?? undefined, details,
        });
    }
}
