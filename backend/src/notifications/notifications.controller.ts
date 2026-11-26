// backend/src/notifications/notifications.controller.ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { NotificationsService } from "./notifications.service";
import { RequirePerm } from "../auth/require-perm.decorator";

class CreateChannelDto {
    @IsString() @MaxLength(100) name!: string;
    @IsIn(["email", "webhook"]) kind!: "email" | "webhook";
    @IsOptional() @IsBoolean() enabled?: boolean;
    @IsOptional() @IsIn(["WARN", "CRIT"]) minSeverity?: "WARN" | "CRIT";
    @IsOptional() @IsBoolean() notifyOnResolve?: boolean;
    @IsOptional() @IsArray() @IsString({ each: true }) recipients?: string[];
    @IsOptional() @IsString() @MaxLength(2000) url?: string;
    @IsOptional() @IsIn(["auto", "adgrmm", "slack", "discord", "teams"]) format?: "auto" | "adgrmm" | "slack" | "discord" | "teams";
}

class UpdateChannelDto {
    @IsOptional() @IsString() @MaxLength(100) name?: string;
    @IsOptional() @IsBoolean() enabled?: boolean;
    @IsOptional() @IsIn(["WARN", "CRIT"]) minSeverity?: "WARN" | "CRIT";
    @IsOptional() @IsBoolean() notifyOnResolve?: boolean;
    @IsOptional() @IsArray() @IsString({ each: true }) recipients?: string[];
    @IsOptional() @IsString() @MaxLength(2000) url?: string;
    @IsOptional() @IsIn(["auto", "adgrmm", "slack", "discord", "teams"]) format?: "auto" | "adgrmm" | "slack" | "discord" | "teams";
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/notifications/channels")
export class NotificationsController {
    constructor(private readonly notifications: NotificationsService) { }

    @Get()
    @RequirePerm("alerts.read")
    list() {
        return this.notifications.listChannels();
    }

    @Post()
    @RequirePerm("alerts.manage")
    create(@Body() body: CreateChannelDto) {
        return this.notifications.createChannel(body);
    }

    @Patch(":id")
    @RequirePerm("alerts.manage")
    update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: UpdateChannelDto) {
        return this.notifications.updateChannel(id, body);
    }

    @Delete(":id")
    @RequirePerm("alerts.manage")
    remove(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.notifications.deleteChannel(id);
    }

    @Post(":id/test")
    @RequirePerm("alerts.manage")
    test(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.notifications.testChannel(id);
    }
}
