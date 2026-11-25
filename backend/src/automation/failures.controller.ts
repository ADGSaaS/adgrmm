// backend/src/automation/failures.controller.ts
import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "../reports/client-access.service";
import { FailuresService } from "./failures.service";

@Controller("api/automation/failures")
export class FailuresController {
    constructor(private readonly failures: FailuresService, private readonly access: ClientAccessService) { }

    @Get()
    @RequirePerm("automation.read")
    async list(@Req() req: Request, @Query("days") days?: string, @Query("kind") kind?: string, @Query("skipped") skipped?: string, @Query("limit") limit?: string) {
        const u = (req as any)?.user;
        const org = u?.organizationId ?? u?.org ?? null;
        const allowed = await this.access.scopeFor(u?.id ? String(u.id) : null);
        return this.failures.list({ days: Number(days) || undefined, kind: kind || undefined, showSkipped: skipped !== "false", limit: Number(limit) || undefined }, allowed, org ? String(org) : null);
    }
}
