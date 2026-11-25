// backend/src/bulk/bulk.controller.ts
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { Actor, BulkService } from "./bulk.service";

class TargetDto {
    @IsArray({ message: "Choose at least one device." })
    @ArrayMinSize(1, { message: "Choose at least one device." })
    @IsUUID("all", { each: true, message: "One of the devices is not a device id." })
    deviceIds!: string[];
}

class PatchScanDto extends TargetDto {
    @IsOptional() @IsBoolean() includeOptional?: boolean;
}

class PatchInstallDto extends TargetDto {
    @IsIn(["critical", "all"], { message: "level must be critical or all." }) level!: "critical" | "all";
    @IsOptional() @IsBoolean() includeOptional?: boolean;
}

class SetRingDto extends TargetDto {
    @IsIn(["pilot", "stable", "inherit"], { message: 'ring must be "pilot", "stable" or "inherit".' }) ring!: "pilot" | "stable" | "inherit";
}

class MoveSiteDto extends TargetDto {
    @IsUUID("all", { message: "Choose a site." }) siteId!: string;
}

class TagsDto extends TargetDto {
    @IsUUID("all", { message: "Choose a tag." }) tagId!: string;
    @IsOptional() @IsBoolean() remove?: boolean;
}

class DeleteRequestDto extends TargetDto {
    @IsString() @MaxLength(2000) reason!: string;
}

class SavedScriptDto extends TargetDto {
    @IsUUID("all", { message: "Choose a script." }) scriptId!: string;
    @IsOptional() @IsObject() parameters?: Record<string, string>;
}

class RunScriptDto extends TargetDto {
    @IsString() @MaxLength(1_000_000) script!: string;
    @IsOptional() @IsIn(["powershell", "bash", "cmd"]) shell?: "powershell" | "bash" | "cmd";
    @IsOptional() @IsInt() @Min(1) @Max(3600) timeoutSec?: number;
}

function actorOf(req: any): Actor {
    const u = req?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    return { id: u?.id ? String(u.id) : null, email: u?.email ? String(u.email) : null, organizationId: org ? String(org) : null };
}

/**
 * Many devices, one action: /api/bulk/devices/<action> with { deviceIds: [...up to 500], ...}. Each answers with the batch
 * it made and how every device went; a batch with some failures is still a 200 (the failures are in the answer).
 * Each device is checked on its own, so a person limited to some customers can only act on those customers' devices.
 */
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/bulk")
export class BulkController {
    constructor(private readonly bulk: BulkService) { }

    @Post("devices/reboot")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    reboot(@Req() req: any, @Body() body: TargetDto) {
        return this.bulk.reboot(actorOf(req), req, body.deviceIds);
    }

    @Post("devices/patch-scan")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    patchScan(@Req() req: any, @Body() body: PatchScanDto) {
        return this.bulk.patchScan(actorOf(req), req, body.deviceIds, !!body.includeOptional);
    }

    @Post("devices/patch-install")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    patchInstall(@Req() req: any, @Body() body: PatchInstallDto) {
        return this.bulk.patchInstall(actorOf(req), req, body.deviceIds, body.level, !!body.includeOptional);
    }

    @Post("devices/security-scan")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions"])
    securityScan(@Req() req: any, @Body() body: TargetDto) {
        return this.bulk.securityScan(actorOf(req), req, body.deviceIds);
    }

    @Post("devices/escrow-bitlocker")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.secrets.manage"])
    escrowBitlocker(@Req() req: any, @Body() body: TargetDto) {
        return this.bulk.escrowBitlocker(actorOf(req), req, body.deviceIds);
    }

    @Post("devices/rotate-laps-password")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.secrets.manage"])
    rotateLaps(@Req() req: any, @Body() body: TargetDto) {
        return this.bulk.rotateLaps(actorOf(req), req, body.deviceIds);
    }

    @Post("devices/update-agent")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    updateAgent(@Req() req: any, @Body() body: TargetDto) {
        return this.bulk.updateAgent(actorOf(req), req, body.deviceIds);
    }

    // Staged agent rollout: Pilot / Everyone. Needs the right to manage releases as well as to change devices.
    @Post("devices/set-ring")
    @HttpCode(200)
    @RequirePerm(["devices.write", "agents.release.manage"])
    setRing(@Req() req: any, @Body() body: SetRingDto) {
        return this.bulk.setRing(actorOf(req), req, body.deviceIds, body.ring);
    }

    @Post("devices/run-saved-script")
    @HttpCode(200)
    @RequirePerm("automation.run")
    runSavedScript(@Req() req: any, @Body() body: SavedScriptDto) {
        return this.bulk.runSavedScript(actorOf(req), req, body.deviceIds, body.scriptId, body.parameters ?? {});
    }

    @Post("devices/recover-agent")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    recoverAgent(@Req() req: any, @Body() body: TargetDto) {
        return this.bulk.recoverAgents(actorOf(req), req, body.deviceIds);
    }

    @Post("devices/run-script")
    @HttpCode(200)
    @RequirePerm("automation.run")
    runScript(@Req() req: any, @Body() body: RunScriptDto) {
        return this.bulk.runScript(actorOf(req), req, body.deviceIds, body);
    }

    @Post("devices/move-site")
    @HttpCode(200)
    @RequirePerm("devices.write")
    moveSite(@Req() req: any, @Body() body: MoveSiteDto) {
        return this.bulk.moveToSite(actorOf(req), req, body.deviceIds, body.siteId);
    }

    @Post("devices/tags")
    @HttpCode(200)
    @RequirePerm("devices.write")
    tags(@Req() req: any, @Body() body: TagsDto) {
        return this.bulk.tags(actorOf(req), req, body.deviceIds, body.tagId, !!body.remove);
    }

    // Asking for removal is not removing: each device waits for someone with devices.delete to approve it, as one at a time.
    @Post("devices/delete-request")
    @HttpCode(200)
    @RequirePerm("devices.write")
    deleteRequest(@Req() req: any, @Body() body: DeleteRequestDto) {
        return this.bulk.deleteRequest(actorOf(req), req, body.deviceIds, body.reason);
    }

    @Get("batches")
    @RequirePerm("devices.read")
    list(@Req() req: any, @Query("limit") limit?: string) {
        return this.bulk.listBatches(actorOf(req), Number(limit) || 30);
    }

    @Get("batches/:id")
    @RequirePerm("devices.read")
    one(@Req() req: any, @Param("id") id: string) {
        return this.bulk.getBatch(actorOf(req), id);
    }

    @Get("batches/:id/items/:itemId/output")
    @RequirePerm("devices.read")
    output(@Req() req: any, @Param("id") id: string, @Param("itemId") itemId: string) {
        return this.bulk.itemOutput(actorOf(req), id, itemId);
    }
}
