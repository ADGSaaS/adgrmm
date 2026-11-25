// Global search: one box that finds devices, customers, sites, tickets, alerts, people, groups, policies, tags,
// custom reports.
//
// Each kind is only searched if the person holds the right that kind needs, and devices, customers, sites and alerts
// follow the customer / site / tag limits a person has. Tickets follow the customer limit too: a limited person finds
// their customers' tickets and the ones assigned to them.
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { ticketScopeSql } from "../service-desk/queues.service";
import type { Actor } from "../access/grant-rules";
import { snippetAround } from "../tickets/ticket-search";
import { customValueMatch } from "../tickets/ticket-custom-values";

export type SearchItem = { id: string; title: string; detail?: string; badge?: string; href: string };
export type SearchGroup = { key: string; label: string; items: SearchItem[] };

const enc = encodeURIComponent;

/** The text turned into a LIKE pattern, so a % or _ typed by someone is just a character. */
function likeOf(text: string): string {
    return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

@Injectable()
export class SearchService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
    ) { }

    async search(actor: Actor, rawQuery: string, perKind = 5): Promise<{ query: string; groups: SearchGroup[] }> {
        const query = String(rawQuery ?? "").trim().slice(0, 100);
        if (query.length < 2) return { query, groups: [] };

        const orgId = await this.orgs.getDefaultOrganizationId();
        const like = likeOf(query);
        const n = Math.min(Math.max(Math.floor(perKind) || 5, 1), 10);
        const can = (perm: string) => actor.owner || actor.perms.has(perm);
        const scope = await this.access.scopeFor(actor.id);
        const visibleClients = await this.access.visibleClientsFor(actor.id);
        const digits = /^#?(\d{1,9})$/.exec(query)?.[1] ?? null;

        const tasks: Array<Promise<SearchGroup | null>> = [];
        const add = (key: string, label: string, allowed: boolean, run: () => Promise<SearchItem[]>) => {
            if (!allowed) return;
            tasks.push(
                run()
                    .then((items) => (items.length ? { key, label, items } : null))
                    // One kind failing must not take the whole search down.
                    .catch(() => null),
            );
        };

        add("devices", "Devices", can("devices.read"), async () => {
            const limit = scope ? Prisma.sql`AND ${deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`s.id::text`, id: Prisma.sql`d.id::text` })}` : Prisma.empty;
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT d.id::text AS id, COALESCE(NULLIF(d.alias, ''), d.hostname) AS title, c.name AS client, s.name AS site,
                       (COALESCE(ag.last_check_in_at, d.last_seen_at) IS NULL OR COALESCE(ag.last_check_in_at, d.last_seen_at) < NOW() - INTERVAL '5 minutes') AS offline
                  FROM public.devices d
                  JOIN public.sites s ON s.id = d.site_id
                  JOIN public.clients c ON c.id = s.client_id
                  LEFT JOIN public.agents ag ON ag.device_id = d.id
                 WHERE c.organization_id::text = ${orgId}
                   AND (d.hostname ILIKE ${like} ESCAPE '\\' OR d.alias ILIKE ${like} ESCAPE '\\' OR d.primary_user ILIKE ${like} ESCAPE '\\' OR d.serial_number ILIKE ${like} ESCAPE '\\'
                        OR EXISTS (SELECT 1 FROM public.device_tags dt JOIN public.tag_defs td ON td.id = dt.tag_id WHERE dt.device_id = d.id AND td.name ILIKE ${like} ESCAPE '\\'))
                   ${limit}
                 ORDER BY d.hostname ASC
                 LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.title, detail: [r.client, r.site].filter(Boolean).join(" / "), badge: r.offline ? "Offline" : undefined, href: `/devices/${enc(r.id)}` }));
        });

        add("customers", "Customers", can("customers.read"), async () => {
            const only = visibleClients ? Prisma.sql`AND c.id::text = ANY(${visibleClients}::text[])` : Prisma.empty;
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT c.id::text AS id, c.name, c.email, c.phone
                  FROM public.clients c
                 WHERE c.organization_id::text = ${orgId} AND c.archived_at IS NULL
                   AND (c.name ILIKE ${like} ESCAPE '\\' OR c.legal_name ILIKE ${like} ESCAPE '\\' OR c.email ILIKE ${like} ESCAPE '\\' OR c.phone ILIKE ${like} ESCAPE '\\'
                        OR EXISTS (
                          SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(c.custom_fields) = 'object' THEN c.custom_fields ELSE '{}'::jsonb END) cv
                          JOIN public.custom_field_defs cd ON cd.organization_id = c.organization_id AND cd.entity = 'customer' AND cd.key = cv.key AND cd.active
                          WHERE cv.value ILIKE ${like} ESCAPE '\\'))
                   ${only}
                 ORDER BY c.name ASC LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.name, detail: r.email || r.phone || undefined, href: `/customers?org=${enc(r.name)}` }));
        });

        add("sites", "Sites", can("customers.read"), async () => {
            const only = scope ? Prisma.sql`AND (s.client_id::text = ANY(${scope.clients}::text[]) OR s.id::text = ANY(${scope.sites}::text[]))` : Prisma.empty;
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT s.id::text AS id, s.name, c.name AS client
                  FROM public.sites s JOIN public.clients c ON c.id = s.client_id
                 WHERE c.organization_id::text = ${orgId} AND c.archived_at IS NULL
                   AND (s.name ILIKE ${like} ESCAPE '\\' OR s.contact_name ILIKE ${like} ESCAPE '\\')
                   ${only}
                 ORDER BY s.name ASC LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.name, detail: r.client, href: `/customers?org=${enc(r.client)}&site=${enc(r.name)}` }));
        });

        add("tickets", "Tickets", can("tickets.read"), async () => {
            const byNumber = digits ? Prisma.sql`OR t.ticket_number::text = ${digits}` : Prisma.empty;
            const ticketLimit = ticketScopeSql(await this.access.allowedFor(actor.id), actor.id);
            // Also the words inside replies and notes: the newest one with them is shown under the subject.
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT t.id::text AS id, t.ticket_number::text AS number, t.subject, t.status::text AS status,
                       (t.subject ILIKE ${like} ESCAPE '\\' OR t.id::text ILIKE ${like} ESCAPE '\\' ${byNumber}) AS in_subject,
                       h.is_internal AS hit_internal, h.body AS hit_body
                  FROM public.tickets t
                  LEFT JOIN LATERAL (
                    SELECT a.is_internal, a.body FROM public.ticket_activity a
                     WHERE a.ticket_id = t.id AND a.kind IN ('message', 'note') AND a.body ILIKE ${like} ESCAPE '\\'
                     ORDER BY a.created_at DESC LIMIT 1
                  ) h ON true
                 WHERE t.organization_id::text = ${orgId}
                   AND ${ticketLimit}
                   AND (t.subject ILIKE ${like} ESCAPE '\\' OR t.id::text ILIKE ${like} ESCAPE '\\' ${byNumber} OR h.body IS NOT NULL OR ${customValueMatch(like)})
                 ORDER BY t.updated_at DESC LIMIT ${n}`;
            return rows.map((r) => ({
                id: r.id,
                title: r.subject,
                detail: !r.in_subject && r.hit_body ? `${r.hit_internal ? "Note" : "Reply"}: ${snippetAround(r.hit_body, query, 50)}` : String(r.id).slice(0, 8),
                badge: String(r.status).replace(/_/g, " "),
                href: `/tickets/${enc(r.id)}`,
            }));
        });

        add("alerts", "Alerts", can("alerts.read"), async () => {
            const limit = scope ? Prisma.sql`AND ${deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`s.id::text`, id: Prisma.sql`d.id::text` })}` : Prisma.empty;
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT a.id::text AS id, a.title, a.state, a.severity, COALESCE(NULLIF(d.alias, ''), d.hostname) AS device, d.id::text AS device_id
                  FROM public.alerts a
                  JOIN public.devices d ON d.id = a.device_id
                  JOIN public.sites s ON s.id = d.site_id
                  JOIN public.clients c ON c.id = s.client_id
                 WHERE c.organization_id::text = ${orgId}
                   AND (a.title ILIKE ${like} ESCAPE '\\' OR a.detail ILIKE ${like} ESCAPE '\\')
                   ${limit}
                 ORDER BY a.last_seen_at DESC LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.title, detail: r.device, badge: String(r.state).toLowerCase(), href: `/alerts?q=${enc(r.title)}` }));
        });

        add("people", "People", can("users.read"), async () => {
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT u.id::text AS id, u.email::text AS email, NULLIF(CONCAT_WS(' ', NULLIF(u.first_name, ''), NULLIF(u.last_name, '')), '') AS name
                  FROM public.users u
                 WHERE u.organization_id::text = ${orgId}
                   AND (u.email::text ILIKE ${like} ESCAPE '\\' OR u.first_name ILIKE ${like} ESCAPE '\\' OR u.last_name ILIKE ${like} ESCAPE '\\')
                 ORDER BY u.email ASC LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.name || r.email, detail: r.name ? r.email : undefined, href: `/administration?tab=users` }));
        });

        add("groups", "Groups", can("groups.read"), async () => {
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT g.id::text AS id, g.name FROM public.user_groups g
                 WHERE g.organization_id::text = ${orgId} AND g.name ILIKE ${like} ESCAPE '\\'
                 ORDER BY g.name ASC LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.name, href: `/administration?tab=groups` }));
        });

        add("policies", "Policies", can("policies.read"), async () => {
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT p.id::text AS id, p.name, p.enabled FROM public.policies p
                 WHERE p.organization_id::text = ${orgId} AND p.name ILIKE ${like} ESCAPE '\\'
                 ORDER BY p.name ASC LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.name, badge: r.enabled ? undefined : "Off", href: `/policies` }));
        });

        add("tags", "Tags", can("devices.read"), async () => {
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT t.id::text AS id, t.name FROM public.tag_defs t
                 WHERE t.organization_id::text = ${orgId} AND t.name ILIKE ${like} ESCAPE '\\'
                 ORDER BY t.name ASC LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.name, href: `/policies` }));
        });

        add("reports", "Saved reports", can("devices.read"), async () => {
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT r.id::text AS id, r.name FROM public.custom_reports r
                 WHERE r.organization_id::text = ${orgId} AND r.name ILIKE ${like} ESCAPE '\\'
                 ORDER BY r.name ASC LIMIT ${n}`;
            return rows.map((r) => ({ id: r.id, title: r.name, href: `/reports` }));
        });

        const groups = (await Promise.all(tasks)).filter((g): g is SearchGroup => !!g);
        return { query, groups };
    }
}
