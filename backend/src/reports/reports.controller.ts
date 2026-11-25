// backend/src/reports/reports.controller.ts
import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Optional, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UsePipes, ValidationPipe } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";
import type { Request, Response } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ReportsService } from "./reports.service";
import { EndpointReportsService, type ReportResult } from "./endpoint-reports.service";
import { ReportViewsService } from "./report-views.service";
import { FullReportService, QBR_SECTIONS, type FullReport } from "./full-report.service";
import { CustomReportsService } from "./custom-reports.service";
import { SoftwarePoliciesService } from "./software-policies.service";
import { ReportSettingsService } from "./report-settings.service";
import { AuditService } from "../audit/audit.service";
import { ClientAccessService } from "./client-access.service";

class HealthQuery {
    @IsUUID("all") clientId!: string;
    @IsString() from!: string;
    @IsString() to!: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

class RunQuery {
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsUUID("all") siteId?: string;
    @IsOptional() @IsUUID("all") deviceId?: string;
    @IsOptional() @Matches(DATE) from?: string;
    @IsOptional() @Matches(DATE) to?: string;
    @IsOptional() @IsString() @MaxLength(200) q?: string;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(365) offlineDays?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(90) minDiskFreePercent?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(512) minRamGb?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(365) maxUptimeDays?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(90) maxDefinitionAgeDays?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(90) staleDays?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(15) refreshYears?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(730) warnDays?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(730) notSeenDays?: number;
    @IsOptional() @IsString() @MaxLength(500) required?: string;
    @IsOptional() @IsString() @MaxLength(500) banned?: string;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(730) withinDays?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(50) @Max(100) targetPercent?: number;
    @IsOptional() @IsString() @MaxLength(5) businessHoursOnly?: string;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(365) slowDays?: number;
    @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(50) maxLocalAdmins?: number;
    @IsOptional() @IsIn(["json", "csv", "pdf"]) format?: string;
    /** Filter, sort, grouping and columns, as JSON. */
    @IsOptional() @IsString() @MaxLength(8000) view?: string;
}

/** The same fields as a schedule's timing, to see when it would send without saving it. */
class PreviewScheduleDto {
    @IsIn(["daily", "weekly", "monthly", "once"]) frequency!: string;
    @IsOptional() @Matches(TIME, { message: "Time must look like 09:30." }) time?: string;
    @IsOptional() @IsString() @MaxLength(64) timezone?: string;
    @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) daysOfWeek?: number[];
    @IsOptional() @IsInt() @Min(-1) @Max(31) dayOfMonth?: number;
    @IsOptional() @IsIn([1, 2, 3, 4, -1]) nthWeek?: number;
    @IsOptional() @IsInt() @Min(0) @Max(6) nthWeekday?: number;
    @IsOptional() @Matches(DATE, { message: "Choose the date to send on." }) onceDate?: string;
}

class FullQuery {
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsUUID("all") siteId?: string;
    @IsOptional() @IsUUID("all") deviceId?: string;
    @IsOptional() @Matches(DATE) from?: string;
    @IsOptional() @Matches(DATE) to?: string;
    /** pdf and xlsx download; summary is the scorecard and each section's headline numbers; json is everything. */
    @IsOptional() @IsIn(["pdf", "xlsx", "summary", "json"]) format?: string;
}

class CustomReportDto {
    @IsString() @MaxLength(120) name!: string;
    @IsOptional() @IsString() @MaxLength(500) description?: string;
    @IsDefined() config!: unknown;
}

class PolicyDto {
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsIn(["required", "banned"]) kind!: string;
    @IsString() @MaxLength(100) pattern!: string;
    @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class BusinessHoursDto {
    @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days!: number[];
    @Matches(TIME, { message: "Time must look like 08:00." }) start!: string;
    @Matches(TIME, { message: "Time must look like 18:00." }) end!: string;
    @IsString() @MaxLength(64) timezone!: string;
}

class PolicyQuery {
    @IsOptional() @IsUUID("all") clientId?: string;
}

class ViewsQuery {
    @IsOptional() @IsString() @MaxLength(60) report?: string;
}

class CreateViewDto {
    @IsString() @MaxLength(60) reportKey!: string;
    @IsString() @MaxLength(200) name!: string;
    @IsOptional() config?: unknown;
}

class UpdateViewDto {
    @IsOptional() @IsString() @MaxLength(200) name?: string;
    @IsOptional() config?: unknown;
}

const userIdOf = (req: Request) => ((req as any)?.user?.id ? String((req as any).user.id) : null);

class CreateScheduleDto {
    /** Which report. Left out, it is the customer summary, as before. */
    @IsOptional() @IsString() @MaxLength(60) reportKey?: string;
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsUUID("all") siteId?: string;
    /** For the All report: one device. */
    @IsOptional() @IsUUID("all") deviceId?: string;
    @IsIn(["daily", "weekly", "monthly", "once"]) frequency!: string;
    @IsOptional() @Matches(TIME, { message: "Time must look like 09:30." }) time?: string;
    @IsOptional() @IsString() @MaxLength(64) timezone?: string;
    @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) daysOfWeek?: number[];
    @IsOptional() @IsInt() @Min(-1) @Max(31) dayOfMonth?: number;
    @IsOptional() @IsIn([1, 2, 3, 4, -1]) nthWeek?: number;
    @IsOptional() @IsInt() @Min(0) @Max(6) nthWeekday?: number;
    @IsOptional() @Matches(DATE, { message: "Choose the date to send on." }) onceDate?: string;
    @IsArray() @IsString({ each: true }) recipients!: string[];
    @IsOptional() @IsIn(["pdf", "csv", "xlsx", "both"]) format?: string;
    @IsOptional() @IsBoolean() sendIfEmpty?: boolean;
    /** A saved view to copy the settings from. */
    @IsOptional() @IsUUID("all") viewId?: string;
    @IsOptional() config?: unknown;
}

class UpdateScheduleDto {
    @IsIn(["daily", "weekly", "monthly", "once"]) frequency!: string;
    @IsOptional() @Matches(TIME, { message: "Time must look like 09:30." }) time?: string;
    @IsOptional() @IsString() @MaxLength(64) timezone?: string;
    @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) daysOfWeek?: number[];
    @IsOptional() @IsInt() @Min(-1) @Max(31) dayOfMonth?: number;
    @IsOptional() @IsIn([1, 2, 3, 4, -1]) nthWeek?: number;
    @IsOptional() @IsInt() @Min(0) @Max(6) nthWeekday?: number;
    @IsOptional() @Matches(DATE, { message: "Choose the date to send on." }) onceDate?: string;
    @IsArray() @IsString({ each: true }) recipients!: string[];
    @IsOptional() @IsBoolean() enabled?: boolean;
    @IsOptional() @IsIn(["pdf", "csv", "xlsx", "both"]) format?: string;
    @IsOptional() @IsBoolean() sendIfEmpty?: boolean;
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/reports")
export class ReportsController {
    constructor(private readonly reports: ReportsService, private readonly endpoint: EndpointReportsService, private readonly views: ReportViewsService, private readonly full: FullReportService, private readonly custom: CustomReportsService, private readonly policies: SoftwarePoliciesService, private readonly settings: ReportSettingsService, private readonly access: ClientAccessService, @Optional() private readonly auditLog?: AuditService) { }

    /** The customers this person is limited to, or undefined when they may see all of them. */
    private async limitOf(req: Request): Promise<string[] | undefined> {
        return (await this.access.allowedFor((req as any)?.user?.id ? String((req as any).user.id) : null)) ?? undefined;
    }

    /** Who took a copy of a report, so there is a record. Never blocks the download. */
    private recordDownload(req: Request, label: string, format: string | undefined, input: { clientId?: string; siteId?: string; deviceId?: string }) {
        if (!this.auditLog || (format !== "pdf" && format !== "xlsx" && format !== "csv")) return;
        const user = (req as any)?.user;
        void this.auditLog.record({
            action: "report.download",
            category: "report",
            outcome: "success",
            actorUserId: user?.id ? String(user.id) : null,
            actorEmail: user?.email ?? null,
            targetType: "report",
            targetLabel: label,
            req,
            details: { format, ...(input.clientId ? { clientId: input.clientId } : {}), ...(input.siteId ? { siteId: input.siteId } : {}), ...(input.deviceId ? { deviceId: input.deviceId } : {}) },
        }).catch(() => undefined);
    }

    @Get("customer-health")
    @RequirePerm("customers.read")
    async health(@Query() query: HealthQuery, @Req() req: Request) {
        this.access.assertClient((await this.limitOf(req)) ?? null, query.clientId);
        return this.reports.customerHealth(query.clientId, query.from, query.to);
    }

    @Get("customer-health.pdf")
    @RequirePerm("customers.read")
    async pdf(@Query() query: HealthQuery, @Res() res: Response, @Req() req: Request) {
        this.access.assertClient((await this.limitOf(req)) ?? null, query.clientId);
        const { filename, data } = await this.reports.healthPdfFile(query.clientId, query.from, query.to);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(data);
    }

    /** The list of endpoint reports, with what each one asks for. */
    @Get("catalog")
    @RequirePerm("devices.read")
    catalog() {
        return this.endpoint.catalog();
    }

    /**
     * The All report: every report in one document, for a device, a site, a customer or everything. It leaves out any
     * section the person is not allowed to read (alerts need alerts.read, remote sessions need audit.read), and says so.
     */
    @Get("full")
    @RequirePerm("devices.read")
    async fullReport(@Query() query: FullQuery, @Req() req: Request, @Res() res: Response) {
        await this.sendFull(query, req, res, {});
    }

    /** The quarterly business review: the sections a customer cares about, over the last 90 days unless dates are given. */
    @Get("qbr")
    @RequirePerm("devices.read")
    async quarterlyReview(@Query() query: FullQuery, @Req() req: Request, @Res() res: Response) {
        await this.sendFull(query, req, res, { kind: "qbr", sections: QBR_SECTIONS, defaultDays: 90 });
    }

    /* ---- settings the reports share ---- */

    @Get("business-hours")
    @RequirePerm("devices.read")
    getBusinessHours() {
        return this.settings.getBusinessHours();
    }

    @Put("business-hours")
    @RequirePerm("settings.write")
    setBusinessHours(@Body() body: BusinessHoursDto) {
        return this.settings.setBusinessHours(body);
    }

    /* ---- software policies: what each customer must and must not have installed ---- */

    @Get("software-policies")
    @RequirePerm("devices.read")
    async listPolicies(@Query() query: PolicyQuery, @Req() req: Request) {
        const limit = await this.limitOf(req);
        if (limit && query.clientId) this.access.assertClient(limit, query.clientId);
        return this.policies.list(query.clientId, limit);
    }

    @Post("software-policies")
    @RequirePerm("settings.write")
    createPolicy(@Body() body: PolicyDto) {
        return this.policies.create(body);
    }

    @Delete("software-policies/:id")
    @RequirePerm("settings.write")
    removePolicy(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.policies.remove(id);
    }

    /* ---- reports people design: list, read, change, delete, and run ---- */

    @Get("custom")
    @RequirePerm("devices.read")
    listCustom() {
        return this.custom.list();
    }

    /** The columns a built-in report has, for choosing which to show in a designed report. */
    @Get("custom/columns/:key")
    @RequirePerm("devices.read")
    async customColumns(@Param("key") key: string) {
        return { items: await this.custom.columnsFor(key) };
    }

    @Post("custom")
    @RequirePerm("settings.write")
    createCustom(@Body() body: CustomReportDto, @Req() req: Request) {
        return this.custom.create(userIdOf(req), body);
    }

    @Get("custom/:id")
    @RequirePerm("devices.read")
    getCustom(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.custom.get(id);
    }

    @Put("custom/:id")
    @RequirePerm("settings.write")
    updateCustom(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: CustomReportDto) {
        return this.custom.update(id, body);
    }

    @Delete("custom/:id")
    @RequirePerm("settings.write")
    removeCustom(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.custom.remove(id);
    }

    @Get("custom/:id/run")
    @RequirePerm("devices.read")
    async runCustom(@Param("id", new ParseUUIDPipe()) id: string, @Query() query: FullQuery, @Req() req: Request, @Res() res: Response) {
        const { format, ...input } = query;
        const permissions = (req as any).effectivePermissions as Set<string> | undefined;
        const report = await this.custom.build(id, input, permissions ?? new Set(["devices.read"]), await this.limitOf(req));
        this.recordDownload(req, report.title, format, input);
        await this.respond(report, format, res);
    }

    private async sendFull(query: FullQuery, req: Request, res: Response, options: Parameters<FullReportService["build"]>[2]) {
        const { format, ...input } = query;
        const permissions = (req as any).effectivePermissions as Set<string> | undefined;
        const report = await this.full.build(input, permissions ?? new Set(["devices.read"]), { ...options, restrictClientIds: await this.limitOf(req) });
        this.recordDownload(req, report.title, format, input);
        await this.respond(report, format, res);
    }

    private async respond(report: FullReport, format: string | undefined, res: Response) {
        if (format === "pdf") {
            const { filename, data } = await this.full.pdfFile(report);
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.send(data);
            return;
        }
        if (format === "xlsx") {
            const { filename, data } = await this.full.xlsxFile(report);
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.send(data);
            return;
        }
        res.json(format === "json" ? report : this.full.summarise(report));
    }

    /**
     * Every report in the catalogue except the two activity reports that have their own routes. Each one asks for the
     * right its catalogue entry names (most need only devices.read; ticket reports need tickets.read, and so on), so a
     * report that reads something more sensitive than devices is not open to someone who can only read devices.
     * This used to accept eight names, so the other reports on the Reports page came back as "Unknown report".
     */
    @Get("run/:key")
    @RequirePerm("devices.read")
    async runDevices(@Param("key") key: string, @Query() query: RunQuery, @Res() res: Response, @Req() req: Request) {
        if (key === "alert-history" || key === "remote-sessions") throw new NotFoundException("Unknown report");
        const def = this.endpoint.definition(key);
        const permissions = (req as any).effectivePermissions as Set<string> | undefined;
        if (def.permission !== "devices.read" && (req as any).user && !permissions?.has(def.permission)) throw new ForbiddenException("Insufficient permissions");
        await this.deliver(res, key, query, req);
    }

    @Get("alert-history")
    @RequirePerm("alerts.read")
    async alertHistory(@Query() query: RunQuery, @Res() res: Response, @Req() req: Request) {
        await this.deliver(res, "alert-history", query, req);
    }

    /** The same right as the audit log, because this is a view of it. */
    @Get("remote-sessions")
    @RequirePerm("audit.read")
    async remoteSessions(@Query() query: RunQuery, @Res() res: Response, @Req() req: Request) {
        await this.deliver(res, "remote-sessions", query, req);
    }

    private assertKey(key: string, allowed: string[]) {
        if (!allowed.includes(key)) throw new NotFoundException("Unknown report");
    }

    private async deliver(res: Response, key: string, query: RunQuery, req?: Request) {
        const { format, view, ...rest } = query;
        const input = { ...rest, ...(req ? { restrictClientIds: await this.limitOf(req) } : {}) };
        if (req) this.recordDownload(req, key, format, input);
        if (format === "pdf") {
            const { filename, data } = await this.endpoint.pdfFile(key, input, view);
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.send(data);
            return;
        }
        const result: ReportResult = await this.endpoint.run(key, input, view);
        if (format === "csv") {
            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="${key}-${result.generatedAt.slice(0, 10)}.csv"`);
            res.send(this.endpoint.toCsv(result));
            return;
        }
        res.json(result);
    }

    /** Saved views are only settings, so anyone who can open the reports can use them. */
    @Get("views")
    @RequirePerm("devices.read")
    listViews(@Query() query: ViewsQuery, @Req() req: Request) {
        return this.views.list(query.report, userIdOf(req));
    }

    @Post("views")
    @RequirePerm("devices.read")
    createView(@Body() body: CreateViewDto, @Req() req: Request) {
        return this.views.create(userIdOf(req), body);
    }

    @Put("views/:id")
    @RequirePerm("devices.read")
    updateView(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: UpdateViewDto, @Req() req: Request) {
        return this.views.update(id, userIdOf(req), body);
    }

    @Delete("views/:id")
    @RequirePerm("devices.read")
    removeView(@Param("id", new ParseUUIDPipe()) id: string, @Req() req: Request) {
        return this.views.remove(id, userIdOf(req));
    }

    /** When a schedule would send, before it is saved: the next few times, in the customer's own time zone. */
    /** What was sent for one schedule, and what went wrong when it did not. */
    @Get("schedules/:id/deliveries")
    @RequirePerm("devices.read")
    async scheduleDeliveries(@Param("id", new ParseUUIDPipe()) id: string, @Req() req: Request) {
        await this.reports.assertScheduleAllowed(id, await this.limitOf(req));
        return this.reports.listDeliveries(id, 50);
    }

    @Get("deliveries")
    @RequirePerm("devices.read")
    async allDeliveries(@Req() req: Request) {
        return this.reports.listDeliveries(undefined, 100, await this.limitOf(req));
    }

    @Post("schedules/preview")
    @RequirePerm("customers.read")
    previewSchedule(@Body() body: PreviewScheduleDto) {
        return this.reports.previewSchedule(body);
    }

    @Get("schedules")
    @RequirePerm("customers.read")
    async schedules(@Req() req: Request) {
        return this.reports.listSchedules(await this.limitOf(req));
    }

    @Post("schedules")
    @RequirePerm("customers.write")
    async create(@Body() body: CreateScheduleDto, @Req() req: Request) {
        // Someone limited to some customers may only schedule for one of them, so a customer has to be chosen.
        const limit = await this.limitOf(req);
        if (limit) this.access.assertClient(limit, body.clientId);
        return this.reports.createSchedule(body);
    }

    @Put("schedules/:id")
    @RequirePerm("customers.write")
    async update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: UpdateScheduleDto, @Req() req: Request) {
        await this.reports.assertScheduleAllowed(id, await this.limitOf(req));
        return this.reports.updateSchedule(id, body);
    }

    /** Sends the report now, to see it. The schedule's next run does not move. */
    @Post("schedules/:id/send-now")
    @RequirePerm("customers.write")
    async sendNow(@Param("id", new ParseUUIDPipe()) id: string, @Req() req: Request) {
        await this.reports.assertScheduleAllowed(id, await this.limitOf(req));
        return this.reports.sendNow(id);
    }

    @Delete("schedules/:id")
    @RequirePerm("customers.write")
    async remove(@Param("id", new ParseUUIDPipe()) id: string, @Req() req: Request) {
        await this.reports.assertScheduleAllowed(id, await this.limitOf(req));
        return this.reports.deleteSchedule(id);
    }
}
