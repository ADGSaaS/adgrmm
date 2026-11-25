// backend/src/device-tools/device-registry.controller.ts
//
// A Windows device's Registry tab (read-only, phase 1). Looking needs devices.read and devices.registry.read (Admin and Owner).
// Every look and every search is written to the audit trail with the path and search text (never any value), and a refused one
// is recorded too. The customer limit is applied to the device by DeviceAccessGuard (another customer's device is a 404).
import { Controller, Get, Param, Query, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsOptional, IsString } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DeviceAccessGuard } from "../access/device-access.guard";
import { AuditService } from "../audit/audit.service";
import { DeviceToolsService, type Target } from "./device-tools.service";
import { DeviceRegistryService } from "./device-registry.service";
import { assertNotBlocked, cleanRegistryPath, cleanRegistrySearchText, cleanSearchIn, cleanView } from "./device-registry.scripts";

class KeyQuery {
    @IsOptional() @IsString() path?: string;
    @IsOptional() @IsString() view?: string;
}

class SearchQuery extends KeyQuery {
    @IsOptional() @IsString() text?: string;
    @IsOptional() @IsString() in?: string;
}

const safe = (v: unknown, n = 300) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(DeviceAccessGuard)
@Controller("api/devices/:id/tools/registry")
export class DeviceRegistryController {
    constructor(private readonly tools: DeviceToolsService, private readonly registry: DeviceRegistryService, private readonly audit: AuditService) { }

    private record(req: any, t: Target, action: string, outcome: "success" | "failure", details: Record<string, unknown>) {
        void this.audit.record({
            action, category: "device", outcome,
            actorUserId: req?.user?.id ? String(req.user.id) : null, actorEmail: req?.user?.email ? String(req.user.email) : null,
            req, targetType: "device", targetId: t.deviceId, targetLabel: t.name, details,
        });
    }

    @Get()
    @RequirePerm(["devices.read", "devices.registry.read"])
    async view(@Req() req: any, @Param("id") id: string, @Query() q: KeyQuery) {
        const t = await this.tools.target(id);
        const details: Record<string, unknown> = { path: safe(q.path), view: safe(q.view, 4) };
        try {
            this.registry.requireWindows(t);
            const path = cleanRegistryPath(q.path);
            const view = cleanView(q.view);
            Object.assign(details, { path, view });
            if (path) assertNotBlocked(path);
            const r = path ? await this.registry.key(t, path, view) : await this.registry.roots(t);
            this.record(req, t, "device.registry.view", "success", details);
            return { os: t.family, view, path, ...r };
        } catch (e: any) {
            this.record(req, t, "device.registry.view", "failure", { ...details, error: safe(e?.message, 200) });
            throw e;
        }
    }

    @Get("search")
    @RequirePerm(["devices.read", "devices.registry.read"])
    async search(@Req() req: any, @Param("id") id: string, @Query() q: SearchQuery) {
        const t = await this.tools.target(id);
        const details: Record<string, unknown> = { path: safe(q.path), text: safe(q.text, 200), in: safe(q.in, 10), view: safe(q.view, 4) };
        try {
            this.registry.requireWindows(t);
            const path = cleanRegistryPath(q.path, { allowEmpty: false });
            const text = cleanRegistrySearchText(q.text);
            const where = cleanSearchIn(q.in);
            const view = cleanView(q.view);
            Object.assign(details, { path, text, in: where, view });
            assertNotBlocked(path);
            const r = await this.registry.search(t, path, text, where, view);
            this.record(req, t, "device.registry.search", "success", details);
            return { os: t.family, path, text, in: where, view, ...r };
        } catch (e: any) {
            this.record(req, t, "device.registry.search", "failure", { ...details, error: safe(e?.message, 200) });
            throw e;
        }
    }

    /** The answer to a look or search that was still running when it was made (a registry job of this device). */
    @Get("jobs/:jobId")
    @RequirePerm(["devices.read", "devices.registry.read"])
    async job(@Param("id") id: string, @Param("jobId") jobId: string) {
        const t = await this.tools.target(id);
        this.registry.requireWindows(t);
        return { os: t.family, ...(await this.registry.result(t, jobId)) };
    }
}
