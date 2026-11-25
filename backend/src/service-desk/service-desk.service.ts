import { Injectable } from "@nestjs/common";
import { RoutingService, type RouteContext } from "./routing.service";
import { SlaService } from "./sla.service";

/**
 * What the rest of the app calls when a ticket is made or changes. Routing runs only for a new ticket; the SLA
 * clocks follow every change. Neither throws: the ticket is already saved by the time they run.
 */
@Injectable()
export class ServiceDeskService {
    constructor(readonly sla: SlaService, readonly routing: RoutingService) { }

    /** A ticket was just made, from any source: route it, then start its clocks. `acknowledged` when staff opened it themselves. */
    async onCreated(ticketId: string, ctx: RouteContext & { acknowledged?: boolean }): Promise<void> {
        await this.routing.route(ticketId, ctx);
        await this.sla.sync(ticketId, ctx.acknowledged ? { respondedAt: new Date() } : {});
    }

    /** Status, priority, queue or customer changed (or the customer wrote back): clocks pause, resume or re-aim. */
    async onChanged(ticketId: string, opts: { respondedAt?: Date } = {}): Promise<void> {
        await this.sla.sync(ticketId, opts);
    }

    /** A technician answered the customer: the first-response clock stops. */
    async onStaffReply(ticketId: string): Promise<void> {
        await this.sla.sync(ticketId, { respondedAt: new Date() });
    }
}
