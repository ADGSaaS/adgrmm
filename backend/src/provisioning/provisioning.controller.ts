// backend/src/provisioning/provisioning.controller.ts
import {
    Body,
    Controller,
    Get,
    Headers,
    NotFoundException,
    Param,
    Patch,
    Post,
    Query,
    Req,
    Res,
    UsePipes,
    ValidationPipe,
} from "@nestjs/common";
import type { Response } from "express";
import * as fs from "node:fs";
import { RequirePerm } from "../auth/require-perm.decorator";
import { Public } from "../auth/public.decorator";
import { ProvisioningService } from "./provisioning.service";
import { AgentSettingsService } from "./agent-settings.service";
import { ClientAccessService } from "../reports/client-access.service";
import { CreateEndpointDto, type CreateEndpointResult } from "./dto/create-endpoint.dto";
import { CreateEnrollmentKeyDto, type CreateEnrollmentKeyResult } from "./dto/create-enrollment-key.dto";
import { CreateInstallerBundleDto, type CreateInstallerBundleResult } from "./dto/create-installer-bundle.dto";

function safeAttachmentFilename(name: string): string {
    const cleaned = String(name ?? "download.txt").replace(/[\r\n"]/g, "").trim();
    return cleaned.length ? cleaned : "download.txt";
}

function firstForwardedValue(v: unknown): string {
    const s = String(v ?? "").trim();
    if (!s) return "";
    // forwarded headers can be "https,http"
    return s.split(",")[0]?.trim() ?? "";
}

function deriveBaseUrlFromRequest(req: any): string | null {
    const xfProto = firstForwardedValue(req?.headers?.["x-forwarded-proto"]);
    const xfHost = firstForwardedValue(req?.headers?.["x-forwarded-host"]);

    const protoRaw = (xfProto || String(req?.protocol ?? "").trim() || "https").toLowerCase();
    const hostRaw = (xfHost || String(req?.headers?.host ?? "").trim()).toLowerCase();

    if (protoRaw !== "http" && protoRaw !== "https") return null;
    if (!hostRaw) return null;

    // Basic hardening: allow only host-ish chars (domain, ipv4, ipv6-in-brackets, optional port)
    // Examples allowed: example.com, example.com:3001, 10.0.0.5:3001, [2001:db8::1]:3001
    const ok = /^[a-z0-9.\-:[\]]+$/.test(hostRaw);
    if (!ok) return null;

    return `${protoRaw}://${hostRaw}`.replace(/\/+$/, "");
}

@Controller("/api/provisioning")
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class ProvisioningController {
    constructor(
        private readonly provisioning: ProvisioningService,
        private readonly access: ClientAccessService,
        private readonly agentSettings: AgentSettingsService
    ) { }

    private scope(req: any) {
        return this.access.scopeFor(req?.user?.id ? String(req.user.id) : null);
    }

    @Post("endpoints")
    @RequirePerm("customers.write")
    async createEndpoint(@Body() body: CreateEndpointDto): Promise<CreateEndpointResult> {
        return await this.provisioning.createEndpoint(body);
    }

    @Post("enrollment-keys")
    @RequirePerm("customers.write")
    async createEnrollmentKey(
        @Req() req: any,
        @Body() body: CreateEnrollmentKeyDto
    ): Promise<CreateEnrollmentKeyResult> {
        const userId = req?.user?.id ? String(req.user.id) : null;
        // Someone limited to some customers can only make keys for sites they can use.
        if (!(await this.access.canSeeSite(await this.scope(req), String(body?.siteId ?? "")))) throw new NotFoundException("Site not found");
        return await this.provisioning.createEnrollmentKey(body, userId, (await this.agentSettings.get()).installKeyExpiryMins);
    }

    /** What the install key form starts with: the default lifetime set under Administration > Agents & Endpoints. */
    @Get("enrollment-key-defaults")
    @RequirePerm("customers.write")
    async enrollmentKeyDefaults() {
        return { expiresMinutes: (await this.agentSettings.get()).installKeyExpiryMins };
    }

    /** Install keys: who made them, when they run out, when they were last used and how often. The key itself is never shown again. */
    @Get("enrollment-keys")
    @RequirePerm("customers.write")
    async listEnrollmentKeys(@Req() req: any) {
        return { items: await this.provisioning.listEnrollmentKeys(await this.scope(req)) };
    }

    @Post("enrollment-keys/:id/revoke")
    @RequirePerm("customers.write")
    async revokeEnrollmentKey(@Req() req: any, @Param("id") id: string) {
        return await this.provisioning.revokeEnrollmentKey(id, await this.scope(req));
    }

    @Patch("enrollment-keys/:id")
    @RequirePerm("customers.write")
    async renameEnrollmentKey(@Req() req: any, @Param("id") id: string, @Body() body: { name?: string }) {
        return await this.provisioning.renameEnrollmentKey(id, String(body?.name ?? ""), await this.scope(req));
    }

    @Post("installer-bundles")
    @RequirePerm("customers.write")
    async createInstallerBundle(
        @Req() req: any,
        @Body() body: CreateInstallerBundleDto
    ): Promise<CreateInstallerBundleResult> {
        // Prefer deriving from the request origin so the downloaded PS1 pulls from the same backend
        // the dashboard is talking to (works even before a “public installer domain” exists).
        const derivedBaseUrl = deriveBaseUrlFromRequest(req);
        return await this.provisioning.createInstallerBundle(body, derivedBaseUrl);
    }

    @Public()
    @Get("installer-bundles/:id/download")
    async downloadInstallerBundle(
        @Param("id") id: string,
        @Query("token") token: string | undefined,
        @Res({ passthrough: false }) res: Response
    ): Promise<void> {
        const out = await this.provisioning.getInstallerBundleDownload(id, token);

        const filename = safeAttachmentFilename(out.filename);
        const body = out.content ?? "";

        res.status(200);
        res.setHeader("Content-Type", out.contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.send(body);
    }

    /** Downloads the agent itself. Used by the installer scripts. */
    @Public()
    @Get("agent-packages/:os")
    async downloadAgentPackage(
        @Param("os") os: string,
        @Headers("x-enrollment-key") enrollmentKey: string | undefined,
        @Res({ passthrough: false }) res: Response
    ): Promise<void> {
        const out = await this.provisioning.getAgentPackageDownload(os, enrollmentKey);

        res.status(200);
        res.setHeader("Content-Type", out.contentType);
        res.setHeader("Content-Length", String(out.sizeBytes));
        res.setHeader("Content-Disposition", `attachment; filename="${safeAttachmentFilename(out.filename)}"`);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");

        const stream = fs.createReadStream(out.absPath);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
    }
}
