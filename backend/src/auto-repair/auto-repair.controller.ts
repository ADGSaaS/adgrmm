// backend/src/auto-repair/auto-repair.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { CATEGORIES, ISSUES } from "./auto-repair.core";
import { LINUX_DIAGNOSE_KIND, LINUX_DIAGNOSE_SCRIPT, LINUX_REPAIR_KIND, LINUX_REPAIR_SCRIPT } from "./auto-repair.linux";
import { DIAGNOSE_KIND, DIAGNOSE_SCRIPT, REPAIR_KIND, REPAIR_SCRIPT } from "./auto-repair.scripts";
import { AutoRepairService } from "./auto-repair.service";
import { PlaybooksService } from "./playbooks.service";

/** Administration > Agents & Endpoints > Automatic repair. */
@Controller("api/admin/auto-repair")
export class AutoRepairAdminController {
    constructor(private readonly repair: AutoRepairService, private readonly audit: AuditService, private readonly playbooks: PlaybooksService) { }

    private org(req: any): string {
        const org = req?.user?.organizationId ?? null;
        if (!org) throw new BadRequestException("No organization in the session.");
        return String(org);
    }

    @Get()
    @RequirePerm("settings.read")
    async get(@Req() req: any) {
        return {
            ...(await this.repair.settings(this.org(req))),
            categories: CATEGORIES,
            problems: Object.values(ISSUES).map((i) => ({ id: i.id, kind: i.kind, title: i.title })),
        };
    }

    @Put()
    @RequirePerm("settings.write")
    async save(@Req() req: any, @Body() body: any) {
        const org = this.org(req);
        let result;
        try {
            result = await this.repair.saveSettings(org, req.user?.id ? String(req.user.id) : null, body && typeof body === "object" ? body : {});
        } catch (e) {
            throw new BadRequestException((e as Error).message);
        }
        await this.audit.record({
            action: "auto_repair.settings.update", category: "settings", outcome: "success", actorUserId: req.user?.id, actorEmail: req.user?.email, targetType: "organization", targetId: org,
            metadata: { before: result.before, after: result.after },
        } as any);
        return result.after;
    }

    /** The two scripts the automatic repair runs, exactly as they are sent to the computers (they are also written on every ticket they run for). */
    @Get("scripts")
    @RequirePerm("settings.read")
    scripts() {
        return {
            scripts: [
                { name: DIAGNOSE_KIND, title: "Checks (read only)", language: "powershell", purpose: "Looks for the problems a category can have. It only reads: nothing on the computer is changed. It is run before the repair and again afterwards to confirm the repair worked.", takes: "RIQ_CHECKS (which checks to run), RIQ_APP (the program, for a Software Issue)", text: DIAGNOSE_SCRIPT },
                { name: REPAIR_KIND, title: "Repair", language: "powershell", purpose: "Repairs only the problems it is told to (a list of problem names), each by a fixed set of steps written in the script, and prints FIXED or FAILED with a reason for each.", takes: "RIQ_FIX (the problems to repair)", text: REPAIR_SCRIPT },
                { name: LINUX_DIAGNOSE_KIND, title: "Checks on a Linux computer (read only)", language: "bash", purpose: "The same idea for a Linux computer: disk space, a waiting restart, time synchronization, name lookups and failed services. It only reads.", takes: "RIQ_CHECKS (which checks to run)", text: LINUX_DIAGNOSE_SCRIPT },
                { name: LINUX_REPAIR_KIND, title: "Repair on a Linux computer", language: "bash", purpose: "Repairs only the problems it is told to: clears old temporary files, package cache and logs; switches on time synchronization; restarts the name resolver; restarts failed services that are on a safe list (others are only reported).", takes: "RIQ_FIX (the problems to repair)", text: LINUX_REPAIR_SCRIPT },
            ],
        };
    }

    /** The results report for a period (default 30 days). */
    @Get("report")
    @RequirePerm("settings.read")
    report(@Req() req: any, @Query("days") days?: string) { return this.repair.report(this.org(req), Number(days) || 30); }

    /** One run in full: its settings, and every line it logged. */
    @Get("runs/:id")
    @RequirePerm("settings.read")
    async run(@Req() req: any, @Param("id") id: string) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException("Run not found");
        const r = await this.repair.runDetail(this.org(req), id);
        if (!r) throw new NotFoundException("Run not found");
        return r;
    }

    /* ------------------------------ your own repairs ------------------------------ */

    private async record(req: any, action: string, targetId: string, metadata: Record<string, unknown> = {}) {
        await this.audit.record({ action, category: "settings", outcome: "success", actorUserId: req.user?.id, actorEmail: req.user?.email, targetType: "repair_playbook", targetId, metadata } as any);
    }

    @Get("playbooks")
    @RequirePerm("settings.read")
    playbookList(@Req() req: any) { return this.playbooks.list(this.org(req)); }

    @Get("playbooks/:id")
    @RequirePerm("settings.read")
    playbook(@Req() req: any, @Param("id") id: string) { return this.playbooks.get(this.org(req), id); }

    @Post("playbooks")
    @HttpCode(200)
    @RequirePerm("settings.write")
    async playbookCreate(@Req() req: any, @Body() body: any) {
        const r = await this.playbooks.create(this.org(req), req.user?.id ? String(req.user.id) : null, body && typeof body === "object" ? body : {});
        await this.record(req, "auto_repair.playbook.create", r.id, { key: r.key, title: r.title, risk: r.risk });
        return r;
    }

    @Put("playbooks/:id")
    @RequirePerm("settings.write")
    async playbookUpdate(@Req() req: any, @Param("id") id: string, @Body() body: any) {
        const r = await this.playbooks.update(this.org(req), id, req.user?.id ? String(req.user.id) : null, body && typeof body === "object" ? body : {});
        await this.record(req, "auto_repair.playbook.update", id, { key: r.key, version: r.version, status: r.status });
        return r;
    }

    @Delete("playbooks/:id")
    @RequirePerm("settings.write")
    async playbookDelete(@Req() req: any, @Param("id") id: string) {
        const r = await this.playbooks.remove(this.org(req), id);
        await this.record(req, "auto_repair.playbook.delete", id);
        return r;
    }

    @Get("playbooks/:id/versions")
    @RequirePerm("settings.read")
    playbookVersions(@Req() req: any, @Param("id") id: string) { return this.playbooks.versions(this.org(req), id); }

    /** Tries the detection (read only) or a dry run of the repair on one computer. */
    @Post("playbooks/:id/test")
    @HttpCode(200)
    @RequirePerm("settings.write")
    async playbookTest(@Req() req: any, @Param("id") id: string, @Body() body: any) {
        const mode = body?.mode === "dryrun" ? "dryrun" : "detect";
        const r = await this.playbooks.startTest(this.org(req), id, String(body?.deviceId ?? ""), mode);
        await this.record(req, "auto_repair.playbook.test", id, { mode, deviceId: body?.deviceId });
        return r;
    }

    @Get("playbooks/:id/tests/:jobId")
    @RequirePerm("settings.write")
    playbookTestResult(@Req() req: any, @Param("id") id: string, @Param("jobId") jobId: string, @Query("mode") mode?: string) {
        if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new NotFoundException("That test does not exist.");
        return this.playbooks.testResult(this.org(req), id, jobId, mode === "dryrun" ? "dryrun" : "detect");
    }

    /** Only the Owner approves: these scripts run on customers' computers as the system. */
    @Post("playbooks/:id/approve")
    @HttpCode(200)
    @RequirePerm("agents.release.manage")
    async playbookApprove(@Req() req: any, @Param("id") id: string) {
        const r = await this.playbooks.approve(this.org(req), id, req.user?.id ? String(req.user.id) : null);
        await this.record(req, "auto_repair.playbook.approve", id, { key: r.key, version: r.version, risk: r.risk, warnings: r.warnings });
        return r;
    }

    @Post("playbooks/:id/enable")
    @HttpCode(200)
    @RequirePerm("agents.release.manage")
    async playbookEnable(@Req() req: any, @Param("id") id: string) {
        const r = await this.playbooks.setEnabled(this.org(req), id, true);
        await this.record(req, "auto_repair.playbook.enable", id);
        return r;
    }

    @Post("playbooks/:id/disable")
    @HttpCode(200)
    @RequirePerm("settings.write")
    async playbookDisable(@Req() req: any, @Param("id") id: string) {
        const r = await this.playbooks.setEnabled(this.org(req), id, false);
        await this.record(req, "auto_repair.playbook.disable", id);
        return r;
    }

    @Get("runs")
    @RequirePerm("settings.read")
    runs(@Req() req: any, @Query("limit") limit?: string) { return this.repair.runs(this.org(req), Number(limit) || 25); }
}
