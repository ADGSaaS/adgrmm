// backend/src/security/security.controller.ts
//
// Security basics, stage 1. A device's Security tab (/api/devices/:id/security) and the fleet page (/api/security).
//   - Looking needs devices.read. The customer limit is applied to the device by DeviceAccessGuard (another customer's device is a 404)
//     and to the fleet queries by the access scope.
//   - Running a scan or a Defender action needs devices.actions as well (the right restarts and patch scans need), and a device that is
//     online. Every one is written to the audit trail, without any scan data. No action here turns protection off or edits exclusions.
import { BadRequestException, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DeviceAccessGuard } from "../access/device-access.guard";
import { AuditService } from "../audit/audit.service";
import { SecurityService, type SecurityDevice } from "./security.service";
import { SecurityFleetService } from "./security-fleet.service";
import { DEFENDER_ACTIONS, type DefenderAction } from "./security.scripts";
import { LINUX_ACTIONS, type LinuxAction } from "./security-linux.actions";

class FleetQueryDto {
    @IsOptional() @IsString() @MaxLength(64) clientId?: string;
    @IsOptional() @IsString() @MaxLength(200) q?: string;
    @IsOptional() @IsString() @MaxLength(10) grade?: string;
    @IsOptional() @IsString() @MaxLength(20) sort?: string;
    @IsOptional() @IsString() @MaxLength(10) limit?: string;
    @IsOptional() @IsString() @MaxLength(10) offset?: string;
}

class SummaryQueryDto {
    @IsOptional() @IsString() @MaxLength(64) clientId?: string;
}

const userOf = (req: any): string | null => (req?.user?.id ? String(req.user.id) : null);

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(DeviceAccessGuard)
@Controller("api/devices/:id/security")
export class DeviceSecurityController {
    constructor(private readonly security: SecurityService, private readonly audit: AuditService) { }

    private record(req: any, d: SecurityDevice, action: string, outcome: "success" | "failure", details: Record<string, unknown>) {
        void this.audit.record({
            action, category: "device", outcome, actorUserId: userOf(req), actorEmail: req?.user?.email ? String(req.user.email) : null,
            req, targetType: "device", targetId: d.id, targetLabel: d.name, details,
        });
    }

    /** The latest scan: score, grade, every rule with its result and texts, highlights, and why there is none when there is none. */
    @Get()
    @RequirePerm("devices.read")
    async view(@Param("id") id: string) {
        return this.security.view(await this.security.device(id));
    }

    @Post("scan")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions"])
    async scan(@Req() req: any, @Param("id") id: string) {
        const d = await this.security.device(id);
        try {
            const r = await this.security.startScan(d);
            this.record(req, d, "device.security.scan", "success", { trigger: "manual", alreadyWaiting: r.alreadyWaiting });
            return { queued: !r.alreadyWaiting, alreadyWaiting: r.alreadyWaiting, jobId: r.jobId };
        } catch (e: any) {
            this.record(req, d, "device.security.scan", "failure", { trigger: "manual", error: String(e?.message ?? "").slice(0, 200) });
            throw e;
        }
    }

    @Post("defender/:action")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions"])
    async defender(@Req() req: any, @Param("id") id: string, @Param("action") actionRaw: string) {
        const action = actionRaw as DefenderAction;
        if (!DEFENDER_ACTIONS.includes(action)) throw new BadRequestException(`The Defender action must be one of: ${DEFENDER_ACTIONS.join(", ")}.`);
        const d = await this.security.device(id);
        const audit = `device.security.defender.${action}`;
        try {
            const r = await this.security.defender(d, action);
            this.record(req, d, audit, "success", { pending: r.pending });
            return r;
        } catch (e: any) {
            this.record(req, d, audit, "failure", { error: String(e?.message ?? "").slice(0, 200) });
            throw e;
        }
    }

    /** Linux only: turn on the firewall (SSH is allowed first) or run a ClamAV malware scan (reports only). */
    @Post("linux/:action")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.actions"])
    async linux(@Req() req: any, @Param("id") id: string, @Param("action") actionRaw: string) {
        const action = actionRaw as LinuxAction;
        if (!LINUX_ACTIONS.includes(action)) throw new BadRequestException(`The Linux action must be one of: ${LINUX_ACTIONS.join(", ")}.`);
        const d = await this.security.device(id);
        const audit = `device.security.linux.${action}`;
        try {
            const r = await this.security.linuxAction(d, action);
            this.record(req, d, audit, "success", { pending: r.pending });
            return r;
        } catch (e: any) {
            this.record(req, d, audit, "failure", { error: String(e?.message ?? "").slice(0, 200) });
            throw e;
        }
    }

    /** The answer of a Defender action that was still running when it was asked (only a Defender job of this device). */
    @Get("jobs/:jobId")
    @RequirePerm(["devices.read", "devices.actions"])
    async job(@Param("id") id: string, @Param("jobId") jobId: string) {
        return this.security.defenderResult(await this.security.device(id), jobId);
    }
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/security")
export class SecurityFleetController {
    constructor(private readonly fleet: SecurityFleetService) { }

    /** One row per Windows device, paged, sorted and filtered on the server. */
    @Get("fleet")
    @RequirePerm("devices.read")
    list(@Req() req: any, @Query() q: FleetQueryDto) {
        return this.fleet.fleet(userOf(req), q);
    }

    @Get("summary")
    @RequirePerm("devices.read")
    summary(@Req() req: any, @Query() q: SummaryQueryDto) {
        return this.fleet.summary(userOf(req), q.clientId);
    }
}
