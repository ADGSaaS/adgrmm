// backend/src/device-tools/device-tools.controller.ts
//
// A device's Services / Processes / Event log tab (roadmap 1.16).
// Looking needs devices.read and devices.actions (the right the terminal needs, since these tools can do what it does).
// Changing a service or ending a process also needs devices.tools.write. The Security event log needs it too, because it
// records who signed in. Every look and every change is written to the audit trail, with the customer limit applied to the device.
import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import type { Response } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DeviceAccessGuard } from "../access/device-access.guard";
import { AuditService } from "../audit/audit.service";
import { DeviceToolsService, type Target } from "./device-tools.service";
import { SERVICE_ACTIONS, START_TYPES, type ServiceAction, type StartType } from "./device-tools.scripts";

class ServiceActionDto {
    @IsString() @MaxLength(300) name!: string;
    @IsIn(SERVICE_ACTIONS) action!: ServiceAction;
    @IsOptional() @IsIn(START_TYPES) startType?: StartType;
    @IsOptional() @IsBoolean() force?: boolean;
}

class EndProcessDto {
    // A number or digits, checked by cleanPid.
    @IsOptional() pid!: unknown;
    @IsOptional() @IsBoolean() force?: boolean;
}

class EventQuery {
    @IsOptional() @IsString() @MaxLength(200) log?: string;
    @IsOptional() @IsString() hours?: string;
    @IsOptional() @IsString() @MaxLength(100) levels?: string;
    @IsOptional() @IsString() max?: string;
    @IsOptional() @IsString() @MaxLength(400) q?: string;
    @IsOptional() @IsIn(["json", "csv"]) format?: "json" | "csv";
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(DeviceAccessGuard)
@Controller("api/devices/:id/tools")
export class DeviceToolsController {
    constructor(private readonly tools: DeviceToolsService, private readonly audit: AuditService) { }

    private who(req: any) {
        return { actorUserId: req?.user?.id ? String(req.user.id) : null, actorEmail: req?.user?.email ? String(req.user.email) : null };
    }

    private looked(req: any, t: Target, action: string, details: Record<string, unknown>) {
        void this.audit.record({ action, category: "device", outcome: "success", ...this.who(req), req, targetType: "device", targetId: t.deviceId, targetLabel: t.name, details });
    }

    @Get("services")
    @RequirePerm(["devices.read", "devices.actions"])
    async services(@Req() req: any, @Param("id") id: string) {
        const t = await this.tools.target(id);
        const r = await this.tools.listServices(t);
        this.looked(req, t, "device.tools.services.view", {});
        return { os: t.family, ...r };
    }

    @Post("services/action")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions", "devices.tools.write"])
    async serviceAction(@Param("id") id: string, @Body() body: ServiceActionDto) {
        const t = await this.tools.target(id);
        return { os: t.family, ...(await this.tools.serviceAction(t, body)) };
    }

    @Get("processes")
    @RequirePerm(["devices.read", "devices.actions"])
    async processes(@Req() req: any, @Param("id") id: string) {
        const t = await this.tools.target(id);
        const r = await this.tools.listProcesses(t);
        this.looked(req, t, "device.tools.processes.view", {});
        return { os: t.family, ...r };
    }

    @Post("processes/end")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions", "devices.tools.write"])
    async endProcess(@Param("id") id: string, @Body() body: EndProcessDto) {
        const t = await this.tools.target(id);
        return { os: t.family, ...(await this.tools.endProcess(t, body)) };
    }

    @Get("eventlog")
    @RequirePerm(["devices.read", "devices.actions"])
    async eventLog(@Req() req: any, @Param("id") id: string, @Query() q: EventQuery, @Res({ passthrough: true }) res: Response) {
        const t = await this.tools.target(id);
        const query = this.tools.parseEventQuery(t.family, q);
        // The security log says who signed in and who failed to, so it needs the stronger right.
        const perms: Set<string> | undefined = req?.effectivePermissions;
        if (query.log.toLowerCase() === "security" && perms && !perms.has("devices.tools.write")) {
            throw new ForbiddenException("Reading the security log needs the right to change services and processes.");
        }
        const r = await this.tools.eventLog(t, query);
        this.looked(req, t, "device.tools.eventlog.view", { log: query.log, hours: query.hours, levels: query.levels, max: query.max, ...(query.text ? { searchText: query.text.slice(0, 100) } : {}), csv: q.format === "csv" });
        if (q.format === "csv") {
            if (r.pending) return { os: t.family, ...r };
            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="event-log-${query.log.replace(/[^A-Za-z0-9_-]+/g, "_")}.csv"`);
            return this.tools.csv(r.items ?? []);
        }
        return { os: t.family, ...r };
    }

    /** The answer to a request that was still running when it was made (it must be a job of these tools, on this device). */
    @Get("jobs/:jobId")
    @RequirePerm(["devices.read", "devices.actions"])
    async job(@Param("id") id: string, @Param("jobId") jobId: string) {
        const t = await this.tools.target(id);
        return { os: t.family, ...(await this.tools.result(t, jobId)) };
    }
}
