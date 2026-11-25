// backend/src/device-tools/device-registry-write.controller.ts
//
// Changing a Windows device's registry (phase 2). Needs devices.read, devices.registry.read AND devices.registry.write (granted to no
// role by the migration: Owner holds it by rule, an administrator is granted it in Roles). One value or one key of ONE device per
// request, never in bulk. The customer limit is applied to the device by DeviceAccessGuard (another customer's device is a 404).
// Every attempt is written to the audit trail (device.registry.set / .delete-value / .create-key / .delete-key / .undo) with the
// path, the value NAME and the types, and never any data; the data is in the change record (device_registry_changes).
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsObject, IsOptional, IsString } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DeviceAccessGuard } from "../access/device-access.guard";
import { AuditService } from "../audit/audit.service";
import { DeviceToolsService, type Target } from "./device-tools.service";
import { DeviceRegistryService } from "./device-registry.service";
import { changeIdOf, codeOf, DeviceRegistryWriteService, CHANGES_DEFAULT_LIMIT, type Actor, type WriteResult } from "./device-registry-write.service";
import { cleanRegistryPath } from "./device-registry.scripts";

class ValueDto {
    @IsOptional() @IsString() path?: string;
    @IsOptional() @IsString() view?: string;
    // Text, checked by cleanValueName (an empty name is the (Default) value).
    @IsOptional() name?: unknown;
    @IsOptional() type?: unknown;
    // Text, a list of text or a number, checked against the type by cleanValueData.
    @IsOptional() data?: unknown;
    @IsOptional() @IsObject() expected?: Record<string, unknown>;
}

class KeyDto {
    @IsOptional() @IsString() path?: string;
    @IsOptional() @IsString() view?: string;
    @IsOptional() expectedValueCount?: unknown;
}

class ChangesQuery {
    @IsOptional() @IsString() path?: string;
    @IsOptional() @IsString() limit?: string;
}

const safe = (v: unknown, n = 300) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
const typeName = (v: unknown) => safe(v, 20).toUpperCase();

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(DeviceAccessGuard)
@Controller("api/devices/:id/tools/registry")
export class DeviceRegistryWriteController {
    constructor(
        private readonly tools: DeviceToolsService,
        private readonly registry: DeviceRegistryService,
        private readonly writes: DeviceRegistryWriteService,
        private readonly audit: AuditService,
    ) { }

    private actor(req: any): Actor {
        return { id: String(req?.user?.id ?? ""), email: req?.user?.email ? String(req.user.email) : null, name: req?.user?.name ? String(req.user.name) : null, orgId: req?.user?.organizationId ? String(req.user.organizationId) : null };
    }

    private record(req: any, t: Target, action: string, outcome: "success" | "failure", details: Record<string, unknown>) {
        void this.audit.record({
            action, category: "device", outcome,
            actorUserId: req?.user?.id ? String(req.user.id) : null, actorEmail: req?.user?.email ? String(req.user.email) : null,
            req, targetType: "device", targetId: t.deviceId, targetLabel: t.name, details,
        });
    }

    /** Runs one change: Windows only, rate limited, recorded; the audit row names the path, value name and types, never data. */
    private async change(req: any, id: string, action: string, details: Record<string, unknown>, run: (a: Actor, t: Target) => Promise<WriteResult>) {
        const t = await this.tools.target(id);
        const actor = this.actor(req);
        try {
            this.registry.requireWindows(t);
        } catch (e: any) {
            this.record(req, t, action, "failure", { ...details, error: safe(e?.response?.message ?? e?.message, 200) });
            throw e;
        }
        // Over the limit: one audit row for a burst (the limiter says when it is the first), none for the attempts after it.
        this.writes.take(actor, t, () => this.record(req, t, action, "failure", { ...details, error: "rate limited", reason: "rate_limited" }));
        try {
            const r = await run(actor, t);
            if (r.pending) {
                this.record(req, t, action, "success", { ...details, changeId: r.changeId, jobId: r.jobId, pending: true });
                return { os: t.family, ...r };
            }
            const c = r.change;
            this.record(req, t, action, "success", {
                ...details, path: c.path, changeId: r.changeId,
                ...(c.old && "type" in c.old ? { oldType: c.old.type } : {}), ...(c.new && "type" in c.new ? { newType: c.new.type } : {}),
                ...(c.valueCount !== null ? { valueCount: c.valueCount } : {}),
            });
            return { os: t.family, status: "ok", ...r };
        } catch (e: any) {
            this.record(req, t, action, "failure", { ...details, error: safe(e?.response?.message ?? e?.message, 200), ...(codeOf(e) ? { reason: codeOf(e) } : {}), ...(changeIdOf(e) ? { changeId: changeIdOf(e) } : {}) });
            throw e;
        }
    }

    @Put("value")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.registry.read", "devices.registry.write"])
    setValue(@Req() req: any, @Param("id") id: string, @Body() body: ValueDto) {
        return this.change(req, id, "device.registry.set", { path: safe(body.path), view: safe(body.view, 4), valueName: safe(body.name), type: typeName(body.type) }, (a, t) => this.writes.setValue(a, t, body));
    }

    @Delete("value")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.registry.read", "devices.registry.write"])
    deleteValue(@Req() req: any, @Param("id") id: string, @Body() body: ValueDto) {
        return this.change(req, id, "device.registry.delete-value", { path: safe(body.path), view: safe(body.view, 4), valueName: safe(body.name) }, (a, t) => this.writes.deleteValue(a, t, body));
    }

    @Post("key")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.registry.read", "devices.registry.write"])
    createKey(@Req() req: any, @Param("id") id: string, @Body() body: KeyDto) {
        return this.change(req, id, "device.registry.create-key", { path: safe(body.path), view: safe(body.view, 4) }, (a, t) => this.writes.createKey(a, t, body));
    }

    @Delete("key")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.registry.read", "devices.registry.write"])
    deleteKey(@Req() req: any, @Param("id") id: string, @Body() body: KeyDto) {
        return this.change(req, id, "device.registry.delete-key", { path: safe(body.path), view: safe(body.view, 4) }, (a, t) => this.writes.deleteKey(a, t, body));
    }

    @Post("changes/:changeId/undo")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.registry.read", "devices.registry.write"])
    undo(@Req() req: any, @Param("id") id: string, @Param("changeId") changeId: string) {
        return this.change(req, id, "device.registry.undo", { undoes: safe(changeId, 40) }, (a, t) => this.writes.undo(a, t, changeId));
    }

    /** A device's recent changes (newest first), optionally those of one key. Needs only the right to browse; data is shown as the reader shows it. */
    @Get("changes")
    @RequirePerm(["devices.read", "devices.registry.read"])
    async changes(@Req() req: any, @Param("id") id: string, @Query() q: ChangesQuery) {
        const t = await this.tools.target(id);
        this.registry.requireWindows(t);
        const path = cleanRegistryPath(q.path);
        const perms: Set<string> | undefined = req?.effectivePermissions;
        const canUndo = !!perms?.has("devices.registry.write");
        const limit = q.limit === undefined ? CHANGES_DEFAULT_LIMIT : Number(q.limit);
        return { os: t.family, path, canWrite: canUndo, items: await this.writes.list(t, path, Number.isFinite(limit) ? limit : CHANGES_DEFAULT_LIMIT, canUndo) };
    }
}
