// backend/src/checks/checks.controller.ts
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Req,
    UsePipes,
    ValidationPipe,
} from "@nestjs/common";
import { Type } from "class-transformer";
import {
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { CheckDefinitionsService, type CheckKind, type TargetType } from "./check-definitions.service";

class TargetDto {
    @IsIn(["organization", "client", "site", "device"]) type!: TargetType;
    @IsOptional() @IsUUID("all") id?: string;
}

class CheckDto {
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

    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => TargetDto)
    targets!: TargetDto[];
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/checks")
export class ChecksController {
    constructor(private readonly definitions: CheckDefinitionsService) { }

    @Get()
    @RequirePerm("checks.read")
    list() {
        return this.definitions.list();
    }

    @Post()
    @RequirePerm("checks.write")
    create(@Body() body: CheckDto, @Req() req: any) {
        return this.definitions.create(body, req?.user?.id ?? null);
    }

    @Put(":id")
    @RequirePerm("checks.write")
    update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: CheckDto) {
        return this.definitions.update(id, body);
    }

    @Delete(":id")
    @RequirePerm("checks.delete")
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param("id", new ParseUUIDPipe()) id: string) {
        await this.definitions.remove(id);
    }
}
