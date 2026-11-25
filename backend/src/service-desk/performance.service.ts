// backend/src/service-desk/performance.service.ts
//
// How the service desk is doing: per technician and for the whole team, over a period. Tickets are counted by the day they were created; a ticket
// counts as resolved when it is resolved or closed. SLA numbers come from the clocks kept on each ticket (working-hours time, paused while waiting),
// so a ticket that never had a policy is simply not counted in the SLA percentages. Time logged is what people booked in time entries.
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";

export type TechRow = {
    userId: string | null; name: string; assigned: number; resolved: number; open: number;
    responseMet: number; responseMissed: number; resolutionMet: number; resolutionMissed: number;
    avgResponseMinutes: number | null; avgResolutionMinutes: number | null; minutesLogged: number;
};

const pct = (met: number, missed: number): number | null => (met + missed === 0 ? null : Math.round((met / (met + missed)) * 100));
const minutes = (ms: number | null) => (ms === null || ms === undefined ? null : Math.round(Number(ms) / 60000));

/** The numbers of one row as the page shows them. */
export function present(r: TechRow) {
    return {
        ...r,
        responseMetPercent: pct(r.responseMet, r.responseMissed),
        resolutionMetPercent: pct(r.resolutionMet, r.resolutionMissed),
    };
}

@Injectable()
export class PerformanceService {
    constructor(private readonly prisma: PrismaService) { }

    async report(orgId: string, daysRaw: unknown, clientId?: string | null) {
        const days = Math.min(365, Math.max(1, Math.round(Number(daysRaw) || 30)));
        const since = new Date(Date.now() - days * 86400_000);
        const client = clientId && /^[0-9a-f-]{36}$/i.test(clientId) ? clientId : null;

        const rows = await this.prisma.$queryRaw<Array<any>>`
            SELECT t.assignee_user_id AS user_id,
                   count(*)::int AS assigned,
                   count(*) FILTER (WHERE t.status IN ('resolved', 'closed'))::int AS resolved,
                   count(*) FILTER (WHERE t.status NOT IN ('resolved', 'closed'))::int AS open,
                   count(*) FILTER (WHERE s.response_met IS TRUE)::int AS response_met,
                   count(*) FILTER (WHERE s.response_met IS FALSE)::int AS response_missed,
                   count(*) FILTER (WHERE s.resolution_met IS TRUE)::int AS resolution_met,
                   count(*) FILTER (WHERE s.resolution_met IS FALSE)::int AS resolution_missed,
                   avg(s.response_used_ms) FILTER (WHERE s.response_done_at IS NOT NULL)::float8 AS avg_response_ms,
                   avg(s.resolution_used_ms) FILTER (WHERE s.resolution_done_at IS NOT NULL)::float8 AS avg_resolution_ms
              FROM public.tickets t
              LEFT JOIN public.ticket_sla s ON s.ticket_id = t.id
             WHERE t.organization_id = ${orgId}::uuid AND t.created_at >= ${since} AND (${client}::uuid IS NULL OR t.client_id = ${client}::uuid)
             GROUP BY t.assignee_user_id`;

        const logged = await this.prisma.$queryRaw<Array<{ user_id: string; minutes: bigint }>>`
            SELECT user_id, COALESCE(sum(minutes), 0)::bigint AS minutes FROM public.time_entries
             WHERE organization_id = ${orgId}::uuid AND work_date >= ${since}::date AND (${client}::uuid IS NULL OR client_id = ${client}::uuid)
             GROUP BY user_id`;
        const loggedBy = new Map(logged.map((l) => [l.user_id, Number(l.minutes)]));

        const ids = [...new Set([...rows.map((r) => r.user_id).filter(Boolean), ...loggedBy.keys()])] as string[];
        const people = ids.length
            ? await this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
                SELECT id, COALESCE(NULLIF(trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS name FROM public.users WHERE id = ANY(${ids}::uuid[])`
            : [];
        const nameOf = new Map(people.map((p) => [p.id, p.name]));

        const byUser = new Map<string | null, TechRow>();
        for (const r of rows) {
            byUser.set(r.user_id ?? null, {
                userId: r.user_id ?? null, name: r.user_id ? nameOf.get(r.user_id) ?? "Unknown" : "Unassigned",
                assigned: r.assigned, resolved: r.resolved, open: r.open,
                responseMet: r.response_met, responseMissed: r.response_missed, resolutionMet: r.resolution_met, resolutionMissed: r.resolution_missed,
                avgResponseMinutes: minutes(r.avg_response_ms), avgResolutionMinutes: minutes(r.avg_resolution_ms), minutesLogged: loggedBy.get(r.user_id) ?? 0,
            });
        }
        for (const [uid, m] of loggedBy) {
            if (!byUser.has(uid)) byUser.set(uid, { userId: uid, name: nameOf.get(uid) ?? "Unknown", assigned: 0, resolved: 0, open: 0, responseMet: 0, responseMissed: 0, resolutionMet: 0, resolutionMissed: 0, avgResponseMinutes: null, avgResolutionMinutes: null, minutesLogged: m });
        }

        const technicians = [...byUser.values()].sort((a, b) => (a.userId === null ? 1 : b.userId === null ? -1 : b.resolved - a.resolved || a.name.localeCompare(b.name))).map(present);
        const sum = (f: (r: TechRow) => number) => technicians.reduce((n, r) => n + f(r), 0);
        const team = present({
            userId: null, name: "Whole team", assigned: sum((r) => r.assigned), resolved: sum((r) => r.resolved), open: sum((r) => r.open),
            responseMet: sum((r) => r.responseMet), responseMissed: sum((r) => r.responseMissed), resolutionMet: sum((r) => r.resolutionMet), resolutionMissed: sum((r) => r.resolutionMissed),
            avgResponseMinutes: null, avgResolutionMinutes: null, minutesLogged: sum((r) => r.minutesLogged),
        });
        const avgs = await this.prisma.$queryRaw<Array<{ r: number | null; s: number | null }>>`
            SELECT avg(s.response_used_ms) FILTER (WHERE s.response_done_at IS NOT NULL)::float8 AS r, avg(s.resolution_used_ms) FILTER (WHERE s.resolution_done_at IS NOT NULL)::float8 AS s
              FROM public.tickets t JOIN public.ticket_sla s ON s.ticket_id = t.id
             WHERE t.organization_id = ${orgId}::uuid AND t.created_at >= ${since} AND (${client}::uuid IS NULL OR t.client_id = ${client}::uuid)`;
        team.avgResponseMinutes = minutes(avgs[0]?.r ?? null);
        team.avgResolutionMinutes = minutes(avgs[0]?.s ?? null);

        const byPriority = await this.prisma.$queryRaw<Array<any>>`
            SELECT t.priority::text AS priority, count(*)::int AS tickets,
                   count(*) FILTER (WHERE s.response_met IS TRUE)::int AS response_met, count(*) FILTER (WHERE s.response_met IS FALSE)::int AS response_missed,
                   count(*) FILTER (WHERE s.resolution_met IS TRUE)::int AS resolution_met, count(*) FILTER (WHERE s.resolution_met IS FALSE)::int AS resolution_missed
              FROM public.tickets t LEFT JOIN public.ticket_sla s ON s.ticket_id = t.id
             WHERE t.organization_id = ${orgId}::uuid AND t.created_at >= ${since} AND (${client}::uuid IS NULL OR t.client_id = ${client}::uuid)
             GROUP BY t.priority ORDER BY 1`;

        return {
            days, since: since.toISOString(), team, technicians,
            byPriority: byPriority.map((p) => ({ priority: p.priority, tickets: p.tickets, responseMetPercent: pct(p.response_met, p.response_missed), resolutionMetPercent: pct(p.resolution_met, p.resolution_missed) })),
            note: "Tickets are counted by the day they were created. Response and resolution times are working-hours time from each ticket's SLA clock; tickets without an SLA policy are not in the percentages.",
        };
    }
}
