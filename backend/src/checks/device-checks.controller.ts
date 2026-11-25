// The checks that apply to one device, made and changed from the device's own page.
//
// A check made here is aimed at this device only. Checks that come from a customer, a site or "all devices" are listed
// so it is clear why they run, but they are changed under Automation, where it is clear who else they affect.
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DeviceAccessGuard } from "../access/device-access.guard";
import { CheckDefinitionsService, type CheckKind } from "./check-definitions.service";

class DeviceCheckDto {
    @IsString() @MaxLength(200) name!: string;
    @IsIn(["disk", "cpu", "memory", "service", "process", "ping", "port"]) kind!: CheckKind;
    @IsOptional() @IsString() @MaxLength(1000) description?: string;
    @IsOptional() @IsInt() @Min(1) @Max(1440) intervalMinutes?: number;
    @IsOptional() @IsBoolean() enabled?: boolean;
    @IsOptional() @IsIn(["WARN", "CRIT"]) severity?: "WARN" | "CRIT";
    @IsOptional() @IsNumber() @Min(0) @Max(100) warn?: number;
    @IsOptional() @IsNumber() @Min(0) @Max(100) crit?: number;
    @IsOptional() @IsString() @MaxLength(256) path?: string;
    @IsOptional() @IsString() @MaxLength(256) service?: string;
    @IsOptional() @IsString() @MaxLength(256) process?: string;
    @IsOptional() @IsString() @MaxLength(253) host?: string;
    @IsOptional() @IsInt() @Min(1) @Max(65_535) port?: number;
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(DeviceAccessGuard)
@Controller("api/devices/:id/check-definitions")
export class DeviceChecksController {
    constructor(private readonly definitions: CheckDefinitionsService) { }

    @Get()
    @RequirePerm("checks.read")
    list(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.definitions.forDevice(id);
    }

    @Post()
    @RequirePerm("checks.write")
    create(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: DeviceCheckDto, @Req() req: any) {
        return this.definitions.createForDevice(id, body, req?.user?.id ?? null);
    }

    @Put(":checkId")
    @RequirePerm("checks.write")
    update(@Param("id", new ParseUUIDPipe()) id: string, @Param("checkId", new ParseUUIDPipe()) checkId: string, @Body() body: DeviceCheckDto) {
        return this.definitions.updateForDevice(id, checkId, body);
    }

    @Delete(":checkId")
    @RequirePerm("checks.delete")
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param("id", new ParseUUIDPipe()) id: string, @Param("checkId", new ParseUUIDPipe()) checkId: string) {
        await this.definitions.removeForDevice(id, checkId);
    }
}
