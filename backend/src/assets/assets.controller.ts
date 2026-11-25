// backend/src/assets/assets.controller.ts
//
// Who owns assets (/api/assets).
//   GET  /provider            who owns assets now (any person who can see devices: pages use it to say "managed in Killian")
//   GET  /provider/preflight  what switching would change (integrations.manage)
//   GET  /export              every built-in asset as JSON or CSV, for importing elsewhere (integrations.manage)
//   PUT  /provider            switch between the built-in asset manager and an external one (integrations.manage, confirmation required, audited)
// Nothing here deletes an asset.
import { Body, Controller, Get, Header, Put, Query, Req, Res, UsePipes, ValidationPipe } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import type { Response } from "express";
import { RequirePerm } from "../auth/require-perm.decorator";
import { AuditService } from "../audit/audit.service";
import { AssetsService } from "./assets.service";

class SwitchDto {
    @IsIn(["builtin", "external"]) provider!: "builtin" | "external";
    @IsOptional() @IsString() @MaxLength(60) externalName?: string | null;
    @IsOptional() @IsString() @MaxLength(300) externalUrl?: string | null;
    @IsBoolean() confirm!: boolean;
}

const userOf = (req: any): string | null => (req?.user?.id ? String(req.user.id) : null);

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/assets")
export class AssetsController {
    constructor(private readonly assets: AssetsService, private readonly audit: AuditService) { }

    @Get("provider")
    @RequirePerm("devices.read")
    async provider(@Req() req: any) {
        const s = await this.assets.settings();
        const perms: Set<string> | undefined = req?.effectivePermissions;
        return { provider: s.provider, externalName: s.externalName, externalUrl: s.externalUrl, changedAt: s.changedAt, canSwitch: !!perms?.has?.("integrations.manage") };
    }

    @Get("provider/preflight")
    @RequirePerm("integrations.manage")
    preflight() {
        return this.assets.preflight();
    }

    @Get("export")
    @RequirePerm("integrations.manage")
    @Header("Cache-Control", "no-store")
    async export(@Req() req: any, @Query("format") format: string | undefined, @Res() res: Response) {
        const f = format === "csv" ? "csv" : "json";
        const out = await this.assets.export(f);
        void this.audit.record({ action: "assets.export", category: "settings", outcome: "success", actorUserId: userOf(req), actorEmail: req?.user?.email ? String(req.user.email) : null, req, targetType: "assets", details: { format: f } });
        res.setHeader("Content-Type", out.contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
        res.send(out.body);
    }

    @Put("provider")
    @RequirePerm("integrations.manage")
    async switch(@Req() req: any, @Body() body: SwitchDto) {
        const before = await this.assets.settings();
        try {
            const after = await this.assets.setProvider(userOf(req), body);
            void this.audit.record({
                action: "assets.provider.switch", category: "settings", outcome: "success", actorUserId: userOf(req), actorEmail: req?.user?.email ? String(req.user.email) : null, req,
                targetType: "assets", details: { from: before.provider, to: after.provider, externalName: after.externalName },
            });
            return after;
        } catch (e: any) {
            void this.audit.record({ action: "assets.provider.switch", category: "settings", outcome: "failure", actorUserId: userOf(req), actorEmail: req?.user?.email ? String(req.user.email) : null, req, targetType: "assets", details: { from: before.provider, to: body.provider, error: String(e?.message ?? "").slice(0, 200) } });
            throw e;
        }
    }
}
