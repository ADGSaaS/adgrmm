import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { TicketTimeService } from "./ticket-time.service";
import { TicketsService } from "./tickets.service";

// The person's own stopwatches. Everything here is about the signed-in person, so it needs the right to work tickets.
@Controller("api/ticket-timers")
export class TicketTimeController {
    constructor(private readonly svc: TicketTimeService, private readonly tickets: TicketsService) { }

    @Get()
    @RequirePerm("tickets.write")
    mine(@Req() req: any) {
        return this.svc.mine(req);
    }

    @Get(":ticketId")
    @RequirePerm("tickets.write")
    async get(@Req() req: any, @Param("ticketId") ticketId: string) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.get(req, ticketId);
    }

    @Post(":ticketId/start")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("tickets.write")
    async start(@Req() req: any, @Param("ticketId") ticketId: string) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.start(req, ticketId);
    }

    @Post(":ticketId/pause")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("tickets.write")
    async pause(@Req() req: any, @Param("ticketId") ticketId: string) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.pause(req, ticketId);
    }

    @Post(":ticketId/discard")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("tickets.write")
    async discard(@Req() req: any, @Param("ticketId") ticketId: string) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.discard(req, ticketId);
    }

    @Post(":ticketId/stop")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("tickets.write")
    async stop(@Req() req: any, @Param("ticketId") ticketId: string, @Body() body: { minutes?: unknown; billable?: unknown; note?: unknown; workDate?: unknown }) {
        await this.tickets.assertVisible(ticketId, req);
        return this.svc.stop(req, ticketId, body ?? {}, req?.effectivePermissions?.has?.("tickets.time.manual") === true);
    }
}
