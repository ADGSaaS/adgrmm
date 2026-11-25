// backend/src/recordings/recordings.controller.ts
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, PayloadTooLargeException, Post, Query, Req, Res } from "@nestjs/common";

import { RequirePerm } from "../auth/require-perm.decorator";
import { OrganizationContextService } from "../storage/organization-context.service";
import { MAX_PIECE_BYTES, RecActor, RecordingsService } from "./recordings.service";

/** Reads a request body as bytes, giving up as soon as it passes the limit. */
function readBody(req: any, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers?.["content-length"]);
        if (Number.isFinite(declared) && declared > limit) {
            reject(new PayloadTooLargeException(`A piece can be at most ${limit / (1024 * 1024)} MB.`));
            return;
        }
        const parts: Buffer[] = [];
        let size = 0;
        let done = false;
        req.on("data", (c: Buffer) => {
            if (done) return;
            size += c.length;
            if (size > limit) {
                done = true;
                parts.length = 0;
                reject(new PayloadTooLargeException(`A piece can be at most ${limit / (1024 * 1024)} MB.`));
                return;
            }
            parts.push(c);
        });
        req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
        req.on("error", (e: Error) => { if (!done) { done = true; reject(e); } });
    });
}

/**
 * Session recordings. The technician's browser starts one for a live Remote Console session, uploads it in pieces and
 * finishes it. People with recordings.read list, watch and download; recordings.delete removes them and sets retention.
 */
@Controller("api/remote-recordings")
export class RecordingsController {
    constructor(private readonly svc: RecordingsService, private readonly orgs: OrganizationContextService) { }

    private async actor(req: any): Promise<RecActor> {
        const u = req?.user;
        const org = u?.organizationId ?? u?.org ?? (await this.orgs.getDefaultOrganizationId());
        return {
            orgId: String(org),
            userId: u?.id ? String(u.id) : null,
            name: String(u?.name || u?.email || "A technician"),
            email: u?.email ? String(u.email) : null,
        };
    }

    @Get()
    @RequirePerm("recordings.read")
    async list(@Req() req: any, @Query() q: Record<string, unknown>) {
        return this.svc.list(await this.actor(req), q);
    }

    @Get("facets")
    @RequirePerm("recordings.read")
    async facets(@Req() req: any) {
        return this.svc.facets(await this.actor(req));
    }

    @Get("settings")
    @RequirePerm("recordings.read")
    async settings(@Req() req: any) {
        return this.svc.settings((await this.actor(req)).orgId);
    }

    @Patch("settings")
    @RequirePerm("recordings.delete")
    async updateSettings(@Req() req: any, @Body() body: any) {
        return this.svc.updateSettings(await this.actor(req), body);
    }

    @Post("cleanup")
    @HttpCode(200)
    @RequirePerm("recordings.delete")
    cleanup() {
        return this.svc.sweep();
    }

    @Post()
    @HttpCode(201)
    @RequirePerm("devices.actions")
    async start(@Req() req: any, @Body() body: { sessionId?: unknown }) {
        return this.svc.start(await this.actor(req), body?.sessionId);
    }

    @Post(":id/chunks")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    async chunk(@Req() req: any, @Param("id") id: string, @Query("seq") seq: string) {
        const type = String(req.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (type !== "application/octet-stream") throw new BadRequestException("Send the piece as application/octet-stream.");
        const data = await readBody(req, MAX_PIECE_BYTES);
        return this.svc.addPiece(await this.actor(req), id, seq, data);
    }

    @Post(":id/finish")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    async finish(@Req() req: any, @Param("id") id: string, @Body() body: { durationMs?: unknown }) {
        return this.svc.finish(await this.actor(req), id, body?.durationMs);
    }

    @Get(":id")
    @RequirePerm("recordings.read")
    async get(@Req() req: any, @Param("id") id: string) {
        return this.svc.get(await this.actor(req), id);
    }

    @Get(":id/stream")
    @RequirePerm("recordings.read")
    async stream(@Req() req: any, @Res() res: any, @Param("id") id: string, @Query("download") download?: string) {
        await this.svc.stream(await this.actor(req), id, req, res, download === "1" || download === "true");
    }

    @Delete(":id")
    @RequirePerm("recordings.delete")
    async remove(@Req() req: any, @Param("id") id: string) {
        return this.svc.deleteOne(await this.actor(req), id);
    }
}
