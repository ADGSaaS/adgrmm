// backend/src/devices/device-removals.controller.ts
//
// The removal request queue (/api/device-removals).
//   GET                     the requests waiting for approval (devices.read; a person limited to some customers sees only theirs)
//   POST /approve           delete the devices whose requests are waiting (devices.delete)
//   POST /decline           close the requests and keep the devices (devices.delete)
// Every answer is written to the audit trail with the device it was about.
import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, UsePipes, ValidationPipe } from "@nestjs/common";
import { ArrayMinSize, IsArray, IsUUID } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { AuditService } from "../audit/audit.service";
import { DeviceRemovalsService, MAX_DECISIONS, type Decision } from "./device-removals.service";

class DecisionDto {
    @IsArray({ message: "Choose at least one device." })
    @ArrayMinSize(1, { message: "Choose at least one device." })
    @IsUUID("all", { each: true, message: "One of the devices is not a device id." })
    deviceIds!: string[];
}

const userOf = (req: any): string | null => (req?.user?.id ? String(req.user.id) : null);

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/device-removals")
export class DeviceRemovalsController {
    constructor(private readonly removals: DeviceRemovalsService, private readonly audit: AuditService) { }

    @Get()
    @RequirePerm("devices.read")
    list(@Req() req: any) {
        return this.removals.list(userOf(req));
    }

    @Post("approve")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.delete"])
    approve(@Req() req: any, @Body() body: DecisionDto) {
        return this.answer(req, "approve", body.deviceIds);
    }

    @Post("decline")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.delete"])
    decline(@Req() req: any, @Body() body: DecisionDto) {
        return this.answer(req, "decline", body.deviceIds);
    }

    private async answer(req: any, decision: Decision, ids: string[]) {
        if (ids.length > MAX_DECISIONS) throw new BadRequestException(`Answer ${MAX_DECISIONS} requests at most at a time.`);
        const items = await this.removals.decide(userOf(req), decision, ids, (r) =>
            this.audit.record({
                action: decision === "approve" ? "device.deletion.approve" : "device.deletion.decline",
                category: "device",
                outcome: r.status === "deleted" || r.status === "declined" ? "success" : "failure",
                actorUserId: userOf(req),
                actorEmail: req?.user?.email ? String(req.user.email) : null,
                req,
                targetType: "device",
                targetId: r.deviceId,
                targetLabel: r.name,
                details: { via: "removal queue", result: r.status, ...(r.reason ? { reason: r.reason } : {}) },
            }),
        );
        const done = items.filter((i) => i.status === "deleted" || i.status === "declined").length;
        return { decision, done, items };
    }
}
