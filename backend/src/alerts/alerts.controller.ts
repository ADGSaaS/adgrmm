// backend/src/alerts/alerts.controller.ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import {
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsISO8601,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
} from "class-validator";
import { AlertsService, type AlertSeverity } from "./alerts.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "../reports/client-access.service";

class ReasonDto {
    @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class SilenceDto extends ReasonDto {
    @IsOptional() @IsISO8601() until?: string;
}

class BulkDto extends SilenceDto {
    @IsArray() @IsUUID("all", { each: true }) ids!: string[];
    @IsIn(["ack", "silence", "resolve"]) action!: "ack" | "silence" | "resolve";
}

class ListAlertsQuery {
    @IsOptional() state?: string[] | string;
    @IsOptional() severity?: string[] | string;
    @IsOptional() @IsUUID("all") deviceId?: string;
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsUUID("all") siteId?: string;
    @IsOptional() @IsString() @MaxLength(200) q?: string;
    @IsOptional() @IsString() limit?: string;
    @IsOptional() @IsUUID("all") cursor?: string;
}

class SettingsDto {
    @IsOptional() @IsInt() @Min(5) @Max(10_080) offlineAfterMinutes?: number;
    @IsOptional() @IsInt() @Min(0) @Max(720) renotifyAfterHours?: number;
    @IsOptional() @IsBoolean() autoTicket?: boolean;
    @IsOptional() @IsIn(["WARN", "CRIT"]) autoTicketMinSeverity?: AlertSeverity;
    @IsOptional() @IsBoolean() autoResolveTicket?: boolean;
}

const actorOf = (req: any): string | null => req?.user?.id ?? null;

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/alerts")
export class AlertsController {
    constructor(private readonly alerts: AlertsService, private readonly access: ClientAccessService) { }

    private allowed(req: any) {
        return this.access.scopeFor(actorOf(req));
    }

    @Get()
    @RequirePerm("alerts.read")
    async list(@Query() query: ListAlertsQuery, @Req() req: any) {
        return this.alerts.list(query, await this.allowed(req));
    }

    @Get("summary")
    @RequirePerm("alerts.read")
    async summary(@Req() req: any) {
        return this.alerts.summary(await this.allowed(req));
    }

    @Get("settings")
    @RequirePerm("alerts.read")
    async settings() {
        const s = await this.alerts.getSettings();
        return {
            offlineAfterMinutes: s.offline_after_minutes,
            renotifyAfterHours: s.renotify_after_hours,
            autoTicket: s.auto_ticket,
            autoTicketMinSeverity: s.auto_ticket_min_severity,
            autoResolveTicket: s.auto_resolve_ticket,
        };
    }

    @Put("settings")
    @RequirePerm("alerts.manage")
    async saveSettings(@Body() body: SettingsDto) {
        await this.alerts.updateSettings(body);
        return this.settings();
    }

    @Post("bulk")
    @RequirePerm("alerts.manage")
    bulk(@Body() body: BulkDto, @Req() req: any) {
        return this.alerts.bulk(body.action, body.ids, actorOf(req), body.reason, body.until);
    }

    @Get(":id/timeline")
    @RequirePerm("alerts.read")
    timeline(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.alerts.getTimeline(id);
    }

    @Post(":id/ack")
    @RequirePerm("alerts.manage")
    ack(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: ReasonDto, @Req() req: any) {
        return this.alerts.ack(id, actorOf(req), body?.reason);
    }

    @Post(":id/silence")
    @RequirePerm("alerts.manage")
    silence(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: SilenceDto, @Req() req: any) {
        return this.alerts.silence(id, actorOf(req), body?.reason, body?.until ?? null);
    }

    @Post(":id/unsilence")
    @RequirePerm("alerts.manage")
    unsilence(@Param("id", new ParseUUIDPipe()) id: string, @Req() req: any) {
        return this.alerts.unsilence(id, actorOf(req));
    }

    @Post(":id/resolve")
    @RequirePerm("alerts.manage")
    resolve(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: ReasonDto, @Req() req: any) {
        return this.alerts.resolve(id, actorOf(req), body?.reason);
    }

    @Post(":id/ticket")
    @RequirePerm("alerts.manage")
    async ticket(@Param("id", new ParseUUIDPipe()) id: string) {
        return { ticketId: await this.alerts.openTicket(id) };
    }
}
