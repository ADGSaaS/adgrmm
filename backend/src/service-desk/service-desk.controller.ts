import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService } from "../reports/client-access.service";
import { PrismaService } from "../storage/prisma.service";
import { PerformanceService } from "./performance.service";
import { QueuesService } from "./queues.service";
import { RoutingService } from "./routing.service";
import { CONDITION_FIELDS, SOURCES } from "./routing-rules";
import { SlaService } from "./sla.service";
import { AuditService } from "../audit/audit.service";
import { describeChanges } from "./changes";

const orgOf = (req: any): string => {
    const u = req?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};
const userOf = (req: any): string | null => (req?.user?.id ? String(req.user.id) : null);

/** Writes one audit event with what changed, spelled out one value per line. */
async function auditChange(audit: AuditService, req: any, action: string, targetType: string, target: { id: string; name: string }, before: unknown, after: unknown) {
    await audit.record({
        action,
        category: "settings",
        outcome: "success",
        actorUserId: userOf(req),
        actorEmail: req?.user?.email ? String(req.user.email) : null,
        targetType,
        targetId: target.id,
        targetLabel: target.name,
        req,
        details: { changes: describeChanges(before, after, ["id", "createdAt", "updatedAt", "customers", "calendarName", "policies"]) },
    });
}

/** SLA policies, working-hours calendars, each customer's own policy, the periodic check and a person's SLA notices. */
@Controller("api/sla")
export class SlaController {
    constructor(private readonly sla: SlaService, private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly performance: PerformanceService) { }

    /** How the team and each technician are doing over a period: tickets, resolved, SLA met, average times, time logged. */
    @Get("performance")
    @RequirePerm("settings.read")
    performanceReport(@Req() req: any, @Query("days") days?: string, @Query("clientId") clientId?: string) {
        return this.performance.report(orgOf(req), days, clientId);
    }

    @Get("policies")
    @RequirePerm("settings.read")
    async policies(@Req() req: any) {
        return { items: await this.sla.listPolicies(orgOf(req)) };
    }

    @Post("policies")
    @RequirePerm("settings.write")
    async createPolicy(@Req() req: any, @Body() body: any) {
        const made = await this.sla.createPolicy(orgOf(req), body ?? {});
        await auditChange(this.audit, req, "sla.policy.create", "sla_policy", made, null, made);
        return made;
    }

    @Patch("policies/:id")
    @RequirePerm("settings.write")
    async updatePolicy(@Req() req: any, @Param("id") id: string, @Body() body: any) {
        const before = await this.sla.getPolicy(orgOf(req), id);
        const after = await this.sla.updatePolicy(orgOf(req), id, body ?? {});
        await auditChange(this.audit, req, "sla.policy.update", "sla_policy", after, before, after);
        return after;
    }

    @Delete("policies/:id")
    @RequirePerm("settings.write")
    async deletePolicy(@Req() req: any, @Param("id") id: string) {
        const before = await this.sla.getPolicy(orgOf(req), id);
        const out = await this.sla.deletePolicy(orgOf(req), id);
        await auditChange(this.audit, req, "sla.policy.delete", "sla_policy", before, before, null);
        return out;
    }

    @Get("calendars")
    @RequirePerm("settings.read")
    async calendars(@Req() req: any) {
        return { items: await this.sla.listCalendars(orgOf(req)) };
    }

    /** The working week set under Reports, to start a calendar from. */
    @Get("calendars/defaults")
    @RequirePerm("settings.read")
    async calendarDefaults(@Req() req: any) {
        const r = await this.prisma.report_settings.findUnique({ where: { organization_id: orgOf(req) } });
        return { timezone: r?.timezone ?? "UTC", days: r?.business_days?.length ? r.business_days : [1, 2, 3, 4, 5], start: r?.business_start ?? "09:00", end: r?.business_end ?? "17:00" };
    }

    @Post("calendars")
    @RequirePerm("settings.write")
    async createCalendar(@Req() req: any, @Body() body: any) {
        const made = await this.sla.createCalendar(orgOf(req), body ?? {});
        await auditChange(this.audit, req, "sla.calendar.create", "sla_calendar", made, null, made);
        return made;
    }

    @Patch("calendars/:id")
    @RequirePerm("settings.write")
    async updateCalendar(@Req() req: any, @Param("id") id: string, @Body() body: any) {
        const before = (await this.sla.listCalendars(orgOf(req))).find((c) => c.id === id);
        const after = await this.sla.updateCalendar(orgOf(req), id, body ?? {});
        await auditChange(this.audit, req, "sla.calendar.update", "sla_calendar", after, before, after);
        return after;
    }

    @Delete("calendars/:id")
    @RequirePerm("settings.write")
    async deleteCalendar(@Req() req: any, @Param("id") id: string) {
        const before = (await this.sla.listCalendars(orgOf(req))).find((c) => c.id === id);
        const out = await this.sla.deleteCalendar(orgOf(req), id);
        if (before) await auditChange(this.audit, req, "sla.calendar.delete", "sla_calendar", before, before, null);
        return out;
    }

    @Get("clients")
    @RequirePerm("settings.read")
    async clientPolicies(@Req() req: any) {
        return { items: await this.sla.listClientPolicies(orgOf(req)) };
    }

    /** Gives one customer a policy of its own, or (policyId null) puts it back on the default one. */
    @Put("clients/:clientId")
    @RequirePerm("settings.write")
    async setClientPolicy(@Req() req: any, @Param("clientId") clientId: string, @Body() body: { policyId?: string | null }) {
        const was = (await this.sla.listClientPolicies(orgOf(req))).find((c) => c.clientId === clientId);
        const out = await this.sla.setClientPolicy(orgOf(req), clientId, body?.policyId ? String(body.policyId) : null);
        const now = (await this.sla.listClientPolicies(orgOf(req))).find((c) => c.clientId === clientId);
        await auditChange(this.audit, req, "sla.customer_policy.set", "client", { id: clientId, name: now?.clientName ?? was?.clientName ?? clientId }, { policy: was?.policyName ?? null }, { policy: now?.policyName ?? null });
        return out;
    }

    /** Runs the check for warnings and breaches now instead of waiting for the next minute. */
    @Post("run")
    @HttpCode(200)
    @RequirePerm("settings.write")
    run() {
        return this.sla.run();
    }

    @Get("notices")
    @RequirePerm("tickets.read")
    async notices(@Req() req: any) {
        const id = userOf(req);
        return { items: id ? await this.sla.notices(id, orgOf(req)) : [] };
    }

    @Post("notices/read")
    @HttpCode(200)
    @RequirePerm("tickets.read")
    async readNotices(@Req() req: any, @Body() body: { ids?: string[]; all?: boolean }) {
        const id = userOf(req);
        if (!id) return { read: 0 };
        return this.sla.markNoticesRead(id, body?.all === true ? "all" : Array.isArray(body?.ids) ? body.ids.map(String) : []);
    }
}

/** Queues: tickets wait in one until someone takes them. Anyone who reads tickets can see them; changing them needs the settings right. */
@Controller("api/ticket-queues")
export class QueuesController {
    constructor(private readonly queues: QueuesService, private readonly access: ClientAccessService) { }

    @Get()
    @RequirePerm("tickets.read")
    async list(@Req() req: any) {
        const allowed = await this.access.allowedFor(userOf(req));
        return { items: await this.queues.list(orgOf(req), allowed, userOf(req)) };
    }

    /** For the tickets screen: open tickets per queue, in no queue, mine and unassigned, within what the person may see. */
    @Get("counts")
    @RequirePerm("tickets.read")
    async counts(@Req() req: any) {
        return this.queues.counts(orgOf(req), await this.access.allowedFor(userOf(req)), userOf(req));
    }

    @Post()
    @RequirePerm("settings.write")
    create(@Req() req: any, @Body() body: any) {
        return this.queues.create(orgOf(req), body ?? {});
    }

    @Patch(":id")
    @RequirePerm("settings.write")
    update(@Req() req: any, @Param("id") id: string, @Body() body: any) {
        return this.queues.update(orgOf(req), id, body ?? {});
    }

    @Delete(":id")
    @RequirePerm("settings.write")
    remove(@Req() req: any, @Param("id") id: string) {
        return this.queues.remove(orgOf(req), id);
    }
}

/** Routing rules: tried in order on every new ticket, from any source. */
@Controller("api/ticket-routing-rules")
export class RoutingController {
    constructor(private readonly routing: RoutingService) { }

    @Get()
    @RequirePerm("settings.read")
    async list(@Req() req: any) {
        return { items: await this.routing.list(orgOf(req)), fields: CONDITION_FIELDS, sources: SOURCES };
    }

    @Post()
    @RequirePerm("settings.write")
    create(@Req() req: any, @Body() body: any) {
        return this.routing.create(orgOf(req), body ?? {});
    }

    @Post("reorder")
    @HttpCode(200)
    @RequirePerm("settings.write")
    async reorder(@Req() req: any, @Body() body: { ids?: string[] }) {
        return { items: await this.routing.reorder(orgOf(req), body?.ids) };
    }

    /** Which rule would catch a ticket like this, and where it would go. Changes nothing. */
    @Post("test")
    @HttpCode(200)
    @RequirePerm("settings.read")
    test(@Req() req: any, @Body() body: any) {
        return this.routing.preview(orgOf(req), body ?? {});
    }

    @Patch(":id")
    @RequirePerm("settings.write")
    update(@Req() req: any, @Param("id") id: string, @Body() body: any) {
        return this.routing.update(orgOf(req), id, body ?? {});
    }

    @Delete(":id")
    @RequirePerm("settings.write")
    remove(@Req() req: any, @Param("id") id: string) {
        return this.routing.remove(orgOf(req), id);
    }
}
