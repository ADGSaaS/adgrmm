// backend/src/automation/scripts.controller.ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import { Type } from "class-transformer";
import {
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsISO8601,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ScriptsService } from "./scripts.service";
import { BuiltinScriptsService } from "./builtin-scripts.service";

class ParameterDto {
    @IsString() @MaxLength(64) name!: string;
    @IsOptional() @IsString() @MaxLength(200) label?: string;
    @IsOptional() @IsBoolean() required?: boolean;
    @IsOptional() @IsString() @MaxLength(2000) defaultValue?: string;
}

class ScriptDto {
    @IsString() @MaxLength(200) name!: string;
    @IsOptional() @IsString() @MaxLength(1000) description?: string;
    @IsIn(["powershell", "bash"]) language!: "powershell" | "bash";
    @IsString() script!: string;
    @IsOptional() @IsIn(["windows", "linux", "both", "all"]) platform?: "windows" | "linux" | "both" | "all";
    @IsOptional() @IsString() linuxScript?: string | null;
    @IsOptional() @IsString() macosScript?: string | null;
    @IsOptional() @IsInt() @Min(10) @Max(86_400) timeoutSec?: number;
    @IsOptional() @IsString() @MaxLength(60) category?: string | null;
    @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ParameterDto) parameters?: ParameterDto[];
}

class CategoryDto {
    @IsString() @MaxLength(200) name!: string;
}

class RunDto {
    @IsArray() @IsUUID("all", { each: true }) deviceIds!: string[];
    @IsOptional() @IsObject() parameters?: Record<string, string>;
}

class ScheduleDto {
    @IsUUID("all") automationId!: string;
    @IsString() @MaxLength(200) name!: string;
    @IsIn(["organization", "client", "site", "device"]) targetType!: "organization" | "client" | "site" | "device";
    @IsOptional() @IsUUID("all") targetId?: string;
    @IsInt() @Min(5) @Max(525_600) intervalMinutes!: number;
    @IsOptional() @IsISO8601() startAt?: string;
    @IsOptional() @IsBoolean() enabled?: boolean;
    @IsOptional() @IsObject() parameters?: Record<string, string>;
}

class HistoryQuery {
    @IsOptional() @IsUUID("all") automationId?: string;
    @IsOptional() @IsUUID("all") deviceId?: string;
    @IsOptional() @IsUUID("all") cursor?: string;
    @IsOptional() @IsString() limit?: string;
}

const actorOf = (req: any): string | null => req?.user?.id ?? null;

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/scripts")
export class ScriptsController {
    constructor(private readonly scripts: ScriptsService, private readonly builtin: BuiltinScriptsService) { }

    @Get()
    @RequirePerm("automation.read")
    list() {
        return this.scripts.list();
    }

    @Get("categories")
    @RequirePerm("automation.read")
    categories() {
        return this.scripts.listCategories();
    }

    @Post("categories")
    @RequirePerm("automation.categories.manage")
    createCategory(@Body() body: CategoryDto, @Req() req: any) {
        return this.scripts.createCategory(body.name, actorOf(req));
    }

    @Delete("categories/:id")
    @RequirePerm("automation.categories.manage")
    deleteCategory(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.scripts.deleteCategory(id);
    }

    // Before the routes with an id, which would otherwise treat these words as one.
    @Get("history")
    @RequirePerm("automation.read")
    history(@Query() query: HistoryQuery) {
        return this.scripts.history(query);
    }

    @Get("schedules")
    @RequirePerm("automation.read")
    schedules() {
        return this.scripts.listSchedules();
    }

    @Post("schedules")
    @RequirePerm("automation.run")
    createSchedule(@Body() body: ScheduleDto, @Req() req: any) {
        return this.scripts.createSchedule(body, actorOf(req));
    }

    @Put("schedules/:id")
    @RequirePerm("automation.run")
    updateSchedule(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: ScheduleDto) {
        return this.scripts.updateSchedule(id, body);
    }

    @Delete("schedules/:id")
    @RequirePerm("automation.run")
    removeSchedule(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.scripts.removeSchedule(id);
    }

    /** Adds the built-in scripts that are missing (for example one that was removed straight from the database). Edited ones are left alone. */
    @Post(":id/reset")
    @RequirePerm("automation.run")
    reset(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.scripts.reset(id);
    }

    @Post("restore-builtin")
    @RequirePerm("automation.run")
    restoreBuiltin() {
        return this.builtin.seed();
    }

    @Post()
    @RequirePerm("automation.run")
    create(@Body() body: ScriptDto, @Req() req: any) {
        return this.scripts.create(body, actorOf(req));
    }

    @Put(":id")
    @RequirePerm("automation.run")
    update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: ScriptDto) {
        return this.scripts.update(id, body);
    }

    @Delete(":id")
    @RequirePerm("automation.run")
    remove(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.scripts.remove(id);
    }

    @Post(":id/duplicate")
    @RequirePerm("automation.run")
    duplicate(@Param("id", new ParseUUIDPipe()) id: string, @Req() req: any) {
        return this.scripts.duplicate(id, actorOf(req));
    }

    @Post(":id/run")
    @RequirePerm("automation.run")
    run(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: RunDto, @Req() req: any) {
        return this.scripts.run(id, body.deviceIds, body.parameters ?? {}, actorOf(req));
    }
}
