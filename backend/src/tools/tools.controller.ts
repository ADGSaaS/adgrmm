// backend/src/tools/tools.controller.ts
import { Body, Controller, Get, HttpCode, Post, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ToolsService } from "./tools.service";

class ScopeDto {
    @IsOptional() @IsIn(["all", "client", "site", "tag"]) kind?: "all" | "client" | "site" | "tag";
    @IsOptional() @IsUUID("all") tagId?: string;
    @IsOptional() @IsArray() @IsUUID("all", { each: true }) exclude?: string[];
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsUUID("all") siteId?: string;
    @IsOptional() @IsIn(["any", "windows", "linux"]) os?: "any" | "windows" | "linux";
    @IsOptional() @IsBoolean() onlineOnly?: boolean;
}

class ScopedDto {
    @IsOptional() @ValidateNested() @Type(() => ScopeDto) scope?: ScopeDto;
}

class CommandDto extends ScopedDto {
    @IsString() @MaxLength(1_000_000) script!: string;
    @IsOptional() @IsIn(["powershell", "bash", "cmd"]) shell?: "powershell" | "bash" | "cmd";
    @IsOptional() @IsInt() @Min(1) @Max(3600) timeoutSec?: number;
}

class ScriptDto extends ScopedDto {
    @IsUUID("all", { message: "Choose a script." }) scriptId!: string;
    @IsOptional() @IsObject() parameters?: Record<string, string>;
}

class PatchesDto extends ScopedDto {
    @IsIn(["scan", "install-critical", "install-all"], { message: "Choose scan, install critical or install all." }) action!: "scan" | "install-critical" | "install-all";
    @IsOptional() @IsBoolean() includeOptional?: boolean;
}

class TaskDto {
    @IsString() @MaxLength(60) key!: string;
    @IsOptional() @IsInt() days?: number;
}

class MaintenanceDto {
    @IsArray() @ValidateNested({ each: true }) @Type(() => TaskDto) tasks!: TaskDto[];
    @IsOptional() @IsBoolean() optimize?: boolean;
}

const actorOf = (req: any) => {
    const u = req?.user;
    return { id: u?.id ? String(u.id) : null, email: u?.email ? String(u.email) : null, organizationId: (u?.organizationId ?? u?.org ?? null) ? String(u?.organizationId ?? u?.org) : null };
};

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/tools")
export class ToolsController {
    constructor(private readonly tools: ToolsService) { }

    /** How many devices a choice matches, so the person sees the reach before they act. */
    @Post("preview")
    @HttpCode(200)
    @RequirePerm("devices.read")
    preview(@Req() req: any, @Body() body: ScopedDto) {
        return this.tools.preview(actorOf(req), body.scope);
    }

    @Post("command")
    @HttpCode(200)
    @RequirePerm("automation.run")
    command(@Req() req: any, @Body() body: CommandDto) {
        return this.tools.command(actorOf(req), req, body.scope, { script: body.script, shell: body.shell, timeoutSec: body.timeoutSec });
    }

    @Post("script")
    @HttpCode(200)
    @RequirePerm("automation.run")
    script(@Req() req: any, @Body() body: ScriptDto) {
        return this.tools.script(actorOf(req), req, body.scope, body.scriptId, body.parameters ?? {});
    }

    @Post("patches")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    patches(@Req() req: any, @Body() body: PatchesDto) {
        return this.tools.patches(actorOf(req), req, body.scope, { action: body.action, includeOptional: body.includeOptional });
    }

    @Post("recover-agents")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    recover(@Req() req: any, @Body() body: ScopedDto) {
        return this.tools.recover(actorOf(req), req, body.scope);
    }

    @Get("maintenance")
    @RequirePerm("settings.write")
    maintenanceList() {
        return this.tools.maintenanceList();
    }

    @Post("maintenance/preview")
    @HttpCode(200)
    @RequirePerm("settings.write")
    maintenancePreview(@Body() body: MaintenanceDto) {
        return this.tools.maintenancePreview(body);
    }

    @Post("maintenance/run")
    @HttpCode(200)
    @RequirePerm("settings.write")
    maintenanceRun(@Req() req: any, @Body() body: MaintenanceDto) {
        return this.tools.maintenanceRun(actorOf(req), req, body);
    }

    @Post("clear-cache")
    @HttpCode(200)
    @RequirePerm("settings.write")
    clearCache(@Req() req: any) {
        return this.tools.clearCache(actorOf(req), req);
    }
}
