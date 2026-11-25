// backend/src/vault/vault.controller.ts
//
// Device secrets (security basics, stage 2). Both rights are granted to NO role by the migration (Owner holds them by rule).
//   - devices.secrets.reveal: view a secret (with a reason) and the Secret access log. devices.secrets.manage: escrow keys now and rotate
//     the managed local administrator password now. Neither includes the other, and both need devices.read.
//   - The customer limit is applied to the device by DeviceAccessGuard (another customer's device is a 404) and to the log by the scope.
//   - A person must be signed in: the admin API key passes the permission guard without a user and gets nothing here.
//   - Nothing but the reveal answer ever carries a secret; its response is never cached. Audit rows name kind, label, the last four
//     characters of the reference and the reason, never the value.
import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DeviceAccessGuard } from "../access/device-access.guard";
import { AuditService } from "../audit/audit.service";
import { VaultService, type Actor } from "./vault.service";
import type { SecurityDevice } from "../security/security.service";

class RevealDto {
    // Text, checked by cleanReason (5 to 300 characters, no control characters). Not whitelisted away: its absence is a 400, not a 500.
    @IsOptional() reason?: unknown;
}

class AccessQueryDto {
    @IsOptional() @IsString() @MaxLength(64) clientId?: string;
    @IsOptional() @IsString() @MaxLength(64) deviceId?: string;
    @IsOptional() @IsString() @MaxLength(120) user?: string;
    @IsOptional() @IsString() @MaxLength(10) limit?: string;
    @IsOptional() @IsString() @MaxLength(10) offset?: string;
}

const userOf = (req: any): string | null => (req?.user?.id ? String(req.user.id) : null);
const actorOf = (req: any): Actor => ({ id: userOf(req), name: req?.user?.name ? String(req.user.name) : null, email: req?.user?.email ? String(req.user.email) : null });
const need = (req: any): Actor => {
    if (!userOf(req)) throw new ForbiddenException("Device secrets need a signed-in person.");
    return actorOf(req);
};
const has = (req: any, perm: string) => !!(req?.effectivePermissions as Set<string> | undefined)?.has(perm);
const safe = (v: unknown, n = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(DeviceAccessGuard)
@Controller("api/devices/:id/secrets")
export class DeviceSecretsController {
    constructor(private readonly vault: VaultService, private readonly audit: AuditService) { }

    private record(req: any, d: SecurityDevice, action: string, outcome: "success" | "failure", details: Record<string, unknown>) {
        void this.audit.record({
            action, category: "device", outcome, actorUserId: userOf(req), actorEmail: req?.user?.email ? String(req.user.email) : null,
            req, targetType: "device", targetId: d.id, targetLabel: d.name, details,
        });
    }

    /** Metadata only. Shown to people who hold either right. */
    @Get()
    @Header("Cache-Control", "no-store")
    @RequirePerm("devices.read")
    async list(@Req() req: any, @Param("id") id: string) {
        need(req);
        const reveal = has(req, "devices.secrets.reveal");
        const manage = has(req, "devices.secrets.manage");
        if (!reveal && !manage) throw new ForbiddenException("Insufficient permissions");
        return this.vault.view(await this.vault.device(id), { reveal, manage });
    }

    @Post(":secretId/reveal")
    @HttpCode(200)
    @Header("Cache-Control", "no-store")
    @Header("Pragma", "no-cache")
    @RequirePerm(["devices.read", "devices.secrets.reveal"])
    async reveal(@Req() req: any, @Param("id") id: string, @Param("secretId") secretId: string, @Body() body: RevealDto) {
        const actor = need(req);
        const d = await this.vault.device(id);
        if (!d.windows && !d.linux) throw new BadRequestException("Device secrets are only available for Windows and Linux devices.");
        try {
            const r = await this.vault.reveal(d, secretId, actor, body?.reason);
            this.record(req, d, "device.secret.reveal", "success", r.audit);
            return r.payload;
        } catch (e: any) {
            const f = this.vault.describeRefusal(e);
            this.record(req, d, "device.secret.reveal", "failure", { code: f.code, error: safe(f.message) });
            throw e;
        }
    }

    @Post("escrow")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.secrets.manage"])
    async escrow(@Req() req: any, @Param("id") id: string) {
        const actor = need(req);
        const d = await this.vault.device(id);
        try {
            this.vault.limiters.change.take(actor.id ?? "none", d.id);
            const r = await this.vault.requestEscrow(d, actor, "manual");
            this.record(req, d, "device.secret.escrow", "success", { trigger: "manual", alreadyWaiting: r.alreadyWaiting });
            return r;
        } catch (e: any) {
            this.record(req, d, "device.secret.escrow", "failure", { trigger: "manual", error: safe(e?.response?.message ?? e?.message) });
            throw e;
        }
    }

    @Post("rotate")
    @HttpCode(200)
    @RequirePerm(["devices.read", "devices.secrets.manage"])
    async rotate(@Req() req: any, @Param("id") id: string) {
        const actor = need(req);
        const d = await this.vault.device(id);
        try {
            this.vault.limiters.change.take(actor.id ?? "none", d.id);
            const r = await this.vault.requestRotate(d, actor, "manual");
            this.record(req, d, "device.secret.rotate", "success", { trigger: "manual", alreadyWaiting: r.alreadyWaiting });
            return r;
        } catch (e: any) {
            this.record(req, d, "device.secret.rotate", "failure", { trigger: "manual", error: safe(e?.response?.message ?? e?.message) });
            throw e;
        }
    }
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/security/secret-access")
export class SecretAccessController {
    constructor(private readonly vault: VaultService) { }

    /** Who revealed, stored or changed which secret, when and why. Needs the reveal right (the customer limit applies). */
    @Get()
    @Header("Cache-Control", "no-store")
    @RequirePerm("devices.secrets.reveal")
    list(@Req() req: any, @Query() q: AccessQueryDto) {
        need(req);
        return this.vault.accessLog(userOf(req), q);
    }
}
