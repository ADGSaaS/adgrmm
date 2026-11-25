import { BadRequestException, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { actorOf } from "../access/grant-rules";
import { AuditService } from "../audit/audit.service";
import { AdminSessionsService } from "./admin-sessions.service";

const orgOf = (req: any): string => {
    const org = req?.user?.organizationId ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};

/** Administration > Sessions. */
@Controller("/api/admin/sessions")
export class AdminSessionsController {
    constructor(
        private readonly svc: AdminSessionsService,
        private readonly audit: AuditService,
    ) { }

    @Get()
    @RequirePerm("users.read")
    list(@Req() req: any, @Query("userId") userId?: string, @Query("search") search?: string, @Query("limit") limit?: string, @Query("offset") offset?: string) {
        return this.svc.list(orgOf(req), req.jti, { userId, search, limit: Number(limit), offset: Number(offset) });
    }

    /** Ends every session of one person. Declared before ":id" so "user" is not read as a session id. */
    @Post("user/:userId/revoke")
    @HttpCode(200)
    @RequirePerm("users.write")
    async revokeAllOf(@Req() req: any, @Param("userId") userId: string) {
        const r = await this.svc.revokeAllOf(actorOf(req), orgOf(req), userId, req.jti);
        await this.audit.record({
            action: "admin.session.revoke_all",
            category: "user",
            outcome: "success",
            actorUserId: req.user?.id,
            actorEmail: req.user?.email,
            targetType: "user",
            targetId: r.userId,
            targetLabel: r.email,
            req,
            details: { revoked: r.revoked },
        });
        return { revoked: r.revoked };
    }

    @Delete(":id")
    @RequirePerm("users.write")
    async revoke(@Req() req: any, @Param("id") id: string) {
        const r = await this.svc.revoke(actorOf(req), orgOf(req), id, req.jti);
        await this.audit.record({
            action: "admin.session.revoke",
            category: "user",
            outcome: "success",
            actorUserId: req.user?.id,
            actorEmail: req.user?.email,
            targetType: "user",
            targetId: r.userId,
            targetLabel: r.email,
            req,
            details: { sessionId: id },
        });
        return { revoked: r.revoked };
    }
}
