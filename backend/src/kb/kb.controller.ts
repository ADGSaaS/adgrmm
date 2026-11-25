import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, forwardRef } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { TicketsService } from "../tickets/tickets.service";
import { KbActor, KbService } from "./kb.service";

function actorOf(req: any): KbActor {
    const u = req?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("Sign in first.");
    return { orgId: String(org), userId: u?.id ? String(u.id) : null, canWrite: req?.effectivePermissions?.has?.("kb.write") === true };
}

/** The internal knowledge base. Technicians read; people with kb.write also see drafts and edit. */
@Controller("api/kb")
export class KbController {
    constructor(private readonly svc: KbService, @Inject(forwardRef(() => TicketsService)) private readonly tickets: TicketsService) { }

    @Get("articles")
    @RequirePerm("kb.read")
    list(@Req() req: any, @Query() q: { q?: string; category?: string; tag?: string; status?: string; limit?: string; offset?: string }) {
        return this.svc.list(actorOf(req), { ...q, limit: Number(q.limit), offset: Number(q.offset) });
    }

    @Post("articles")
    @RequirePerm("kb.write")
    create(@Req() req: any, @Body() b: any) {
        return this.svc.create(actorOf(req), b);
    }

    @Get("articles/:id")
    @RequirePerm("kb.read")
    get(@Req() req: any, @Param("id") id: string, @Query("noview") noview?: string) {
        return this.svc.get(actorOf(req), id, noview !== "1");
    }

    @Patch("articles/:id")
    @RequirePerm("kb.write")
    update(@Req() req: any, @Param("id") id: string, @Body() b: any) {
        return this.svc.update(actorOf(req), id, b);
    }

    @Delete("articles/:id")
    @RequirePerm("kb.write")
    remove(@Req() req: any, @Param("id") id: string) {
        return this.svc.remove(actorOf(req), id);
    }

    @Get("articles/:id/versions")
    @RequirePerm("kb.write")
    versions(@Req() req: any, @Param("id") id: string) {
        return this.svc.versions(actorOf(req), id);
    }

    @Get("articles/:id/versions/:version")
    @RequirePerm("kb.write")
    version(@Req() req: any, @Param("id") id: string, @Param("version") v: string) {
        return this.svc.version(actorOf(req), id, Number(v));
    }

    @Post("articles/:id/versions/:version/restore")
    @HttpCode(200)
    @RequirePerm("kb.write")
    restore(@Req() req: any, @Param("id") id: string, @Param("version") v: string) {
        return this.svc.restore(actorOf(req), id, Number(v));
    }

    @Post("articles/:id/feedback")
    @HttpCode(200)
    @RequirePerm("kb.read")
    feedback(@Req() req: any, @Param("id") id: string, @Body() b: { helpful?: unknown }) {
        return this.svc.feedback(actorOf(req), id, b?.helpful);
    }

    @Get("categories")
    @RequirePerm("kb.read")
    categories(@Req() req: any) {
        return this.svc.categories(actorOf(req).orgId);
    }

    @Post("categories")
    @RequirePerm("kb.write")
    createCategory(@Req() req: any, @Body() b: any) {
        return this.svc.createCategory(actorOf(req).orgId, b);
    }

    @Patch("categories/:id")
    @RequirePerm("kb.write")
    updateCategory(@Req() req: any, @Param("id") id: string, @Body() b: any) {
        return this.svc.updateCategory(actorOf(req).orgId, id, b);
    }

    @Delete("categories/:id")
    @RequirePerm("kb.write")
    deleteCategory(@Req() req: any, @Param("id") id: string) {
        return this.svc.deleteCategory(actorOf(req).orgId, id);
    }

    @Get("tags")
    @RequirePerm("kb.read")
    tags(@Req() req: any) {
        return this.svc.tags(actorOf(req));
    }

    /* ------------------------------ on a ticket ------------------------------ */

    @Get("tickets/:ticketId/suggestions")
    @RequirePerm(["kb.read", "tickets.read"])
    async suggest(@Req() req: any, @Param("ticketId") ticketId: string) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.suggest(actorOf(req), ticketId);
    }

    @Get("tickets/:ticketId/links")
    @RequirePerm(["kb.read", "tickets.read"])
    async links(@Req() req: any, @Param("ticketId") ticketId: string) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.ticketLinks(actorOf(req), ticketId);
    }

    @Post("tickets/:ticketId/links")
    @HttpCode(200)
    @RequirePerm(["kb.read", "tickets.write"])
    async link(@Req() req: any, @Param("ticketId") ticketId: string, @Body() b: { articleId?: unknown }) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.linkTicket(actorOf(req), ticketId, b?.articleId);
    }

    @Delete("tickets/:ticketId/links/:articleId")
    @RequirePerm(["kb.read", "tickets.write"])
    async unlink(@Req() req: any, @Param("ticketId") ticketId: string, @Param("articleId") articleId: string) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.unlinkTicket(actorOf(req), ticketId, articleId);
    }
}
