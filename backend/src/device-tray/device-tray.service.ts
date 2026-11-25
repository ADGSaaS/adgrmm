// backend/src/device-tray/device-tray.service.ts
//
// The tray app on a device. Three things:
//   settings    what an administrator switched on (off until they do), and how to reach support
//   the device  what the tray asks through the agent's own token: status, a help request (a ticket) and chat
//   technicians the chat from their side: who wrote, the thread, and answering
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { ClientAccessService } from "../reports/client-access.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PrismaService } from "../storage/prisma.service";
import { AutoRepairService } from "../auto-repair/auto-repair.service";
import { SOFTWARE_CATEGORY, cleanApp, cleanCategory } from "../auto-repair/auto-repair.core";
import { ServiceDeskService } from "../service-desk/service-desk.service";
import { SmtpService } from "../smtp/smtp.service";
import { TicketsService } from "../tickets/tickets.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import {
    CHAT_IDLE_MINUTES, CHAT_PER_10_MIN, SOLVED_SHOWN_DAYS, cleanReason, transcriptText, TICKET_REPLIES_PER_10_MIN, stripTrayFooter, DEFAULT_SETTINGS, HELP_PER_HOUR, KEEP_DAYS, PAGE, cleanEmail, cleanName, cleanPhone, cleanMessage, cleanSettings, cleanSubject, cleanUser, helpSubject, preview, type TraySettings,
} from "./device-tray.core";

export type Actor = { id: string | null; name?: string | null; organizationId?: string | null };

type Ctx = { deviceId: string; organizationId: string; name: string; hostname: string; clientId: string | null; customer: string | null; site: string | null; agentVersion: string | null; lastCheckInAt: Date | null };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

@Injectable()
export class DeviceTrayService {
    private readonly logger = new Logger(DeviceTrayService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly tickets: TicketsService,
        private readonly desk: ServiceDeskService,
        private readonly smtp: SmtpService,
        private readonly repair: AutoRepairService,
        private readonly hooks: WebhooksService,
    ) { }

    /* ------------------------------ settings ------------------------------ */

    async settings(orgId: string): Promise<TraySettings> {
        const rows = await this.prisma.$queryRaw<Array<{ enabled: boolean; help_enabled: boolean; chat_enabled: boolean; support_phone: string | null; support_email: string | null; greeting: string | null; provider_name: string | null; office_hours: string | null; website: string | null; contact_name: string | null; after_hours_phone: string | null; notice: string | null }>>`
            SELECT enabled, help_enabled, chat_enabled, support_phone, support_email, greeting, provider_name, office_hours, website, contact_name, after_hours_phone, notice FROM public.tray_settings WHERE organization_id = ${orgId}::uuid`;
        const r = rows[0];
        return r ? { enabled: r.enabled, helpEnabled: r.help_enabled, chatEnabled: r.chat_enabled, supportPhone: r.support_phone, supportEmail: r.support_email, greeting: r.greeting, providerName: r.provider_name, officeHours: r.office_hours, website: r.website, contactName: r.contact_name, afterHoursPhone: r.after_hours_phone, notice: r.notice } : { ...DEFAULT_SETTINGS };
    }

    async saveSettings(orgId: string, actorId: string | null, input: Record<string, unknown>) {
        const before = await this.settings(orgId);
        const after = cleanSettings(input, before);
        await this.prisma.$executeRaw`INSERT INTO public.tray_settings (organization_id, enabled, help_enabled, chat_enabled, support_phone, support_email, greeting, provider_name, office_hours, website, contact_name, after_hours_phone, notice, updated_by, updated_at)
            VALUES (${orgId}::uuid, ${after.enabled}, ${after.helpEnabled}, ${after.chatEnabled}, ${after.supportPhone}, ${after.supportEmail}, ${after.greeting}, ${after.providerName}, ${after.officeHours}, ${after.website}, ${after.contactName}, ${after.afterHoursPhone}, ${after.notice}, ${actorId}::uuid, now())
            ON CONFLICT (organization_id) DO UPDATE SET enabled = EXCLUDED.enabled, help_enabled = EXCLUDED.help_enabled, chat_enabled = EXCLUDED.chat_enabled,
              support_phone = EXCLUDED.support_phone, support_email = EXCLUDED.support_email, greeting = EXCLUDED.greeting,
              provider_name = EXCLUDED.provider_name, office_hours = EXCLUDED.office_hours, website = EXCLUDED.website, contact_name = EXCLUDED.contact_name, after_hours_phone = EXCLUDED.after_hours_phone, notice = EXCLUDED.notice, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        return { before, after };
    }

    /* ------------------------------ from the device ------------------------------ */

    private async ctxOf(agentId: string): Promise<Ctx> {
        if (!isCanonicalUuid(agentId)) throw new NotFoundException("Unknown device");
        const rows = await this.prisma.$queryRaw<Array<{ device_id: string; organization_id: string | null; alias: string | null; hostname: string; client_id: string | null; customer: string | null; site: string | null; version: string; last_check_in_at: Date | null }>>`
            SELECT d.id::text AS device_id, c.organization_id::text AS organization_id, d.alias, d.hostname, c.id::text AS client_id, c.name AS customer, s.name AS site, a.version, a.last_check_in_at
            FROM public.agents a JOIN public.devices d ON d.id = a.device_id LEFT JOIN public.sites s ON s.id = d.site_id LEFT JOIN public.clients c ON c.id = s.client_id
            WHERE a.id = ${agentId}::uuid`;
        const r = rows[0];
        if (!r) throw new NotFoundException("Unknown device");
        // a device that belongs to no customer follows the default organization, like the rest of the system
        const organizationId = r.organization_id ?? (await this.orgs.getDefaultOrganizationId());
        return { deviceId: r.device_id, organizationId, name: r.alias || r.hostname, hostname: r.hostname, clientId: r.client_id, customer: r.customer, site: r.site, agentVersion: r.version, lastCheckInAt: r.last_check_in_at };
    }

    /** What the tray shows: whether it is on at all, how to reach support, the device's own state, and its help requests and unread replies. */
    async status(agentId: string) {
        const ctx = await this.ctxOf(agentId);
        const s = await this.settings(ctx.organizationId);
        const base = { enabled: s.enabled, helpEnabled: s.helpEnabled, chatEnabled: s.chatEnabled };
        // when the administrator has not turned it on, the tray learns nothing but that, and closes itself
        if (!s.enabled) return base;
        const [alerts, requests, unread, openTickets] = await Promise.all([
            this.prisma.alerts.count({ where: { device_id: ctx.deviceId, state: { not: "RESOLVED" }, resolved_at: null } }),
            this.prisma.$queryRaw<Array<{ number: string; status: string; created_at: Date; updated_at: Date }>>`
                SELECT t.ticket_number::text AS number, t.status::text AS status, h.created_at, t.updated_at
                FROM public.tray_help_requests h JOIN public.tickets t ON t.id = h.ticket_id WHERE h.device_id = ${ctx.deviceId}::uuid ORDER BY h.created_at DESC LIMIT 5`,
            this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.device_chat_messages WHERE device_id = ${ctx.deviceId}::uuid AND direction = 'tech' AND delivered_at IS NULL`,
            this.ticketList(ctx),
        ]);
        return {
            ...base,
            greeting: s.greeting,
            support: { phone: s.supportPhone, email: s.supportEmail, provider: s.providerName, hours: s.officeHours, website: s.website, contact: s.contactName, afterHoursPhone: s.afterHoursPhone, notice: s.notice },
            device: { name: ctx.name, customer: ctx.customer, site: ctx.site, agentVersion: ctx.agentVersion, lastCheckInAt: iso(ctx.lastCheckInAt) },
            openAlerts: alerts,
            helpRequests: requests.map((r) => ({ number: Number(r.number), status: r.status, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() })),
            unreadMessages: unread[0]?.n ?? 0,
            tickets: openTickets,
            unreadTickets: openTickets.filter((t) => t.unread).length,
        };
    }

    private async requireOn(ctx: Ctx, what: "help" | "chat"): Promise<TraySettings> {
        const s = await this.settings(ctx.organizationId);
        if (!s.enabled || (what === "help" ? !s.helpEnabled : !s.chatEnabled)) throw new ForbiddenException(`${what === "help" ? "Asking for help" : "Chat"} is not turned on for this computer.`);
        return s;
    }

    /** A help request becomes a ticket for the device's customer, with the device on it. */
    async help(agentId: string, input: { message?: unknown; user?: unknown; urgent?: unknown; subject?: unknown; email?: unknown; name?: unknown; phone?: unknown; category?: unknown; appName?: unknown; appPublisher?: unknown; appVersion?: unknown }) {
        const ctx = await this.ctxOf(agentId);
        await this.requireOn(ctx, "help");
        const message = cleanMessage(input.message, "request");
        const user = cleanUser(input.user);
        const urgent = input.urgent === true;
        const email = cleanEmail(input.email);
        const name = cleanName(input.name);
        const phone = cleanPhone(input.phone);
        const who = name || user;
        const category = cleanCategory(input.category);
        const app = category === SOFTWARE_CATEGORY ? cleanApp(input.appName, input.appPublisher, input.appVersion) : null;
        if (category === SOFTWARE_CATEGORY && !app) throw new BadRequestException("Please choose which program the problem is with.");
        const [{ n }] = await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.tray_help_requests WHERE device_id = ${ctx.deviceId}::uuid AND created_at > now() - interval '1 hour'`;
        if (n >= HELP_PER_HOUR) throw new BadRequestException(`There have been ${HELP_PER_HOUR} requests from this computer in the last hour. Please wait for a reply, or call support.`);
        const req = { user: { organizationId: ctx.organizationId, name: "Tray app" } };
        // the person who asked is a contact of the computer's customer, so technicians see who to answer
        let contactId: string | undefined;
        if (email && ctx.clientId) {
            const found = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.customer_contacts WHERE client_id = ${ctx.clientId}::uuid AND lower(email) = ${email} AND lower(btrim(name)) = lower(btrim(${who.slice(0, 120)})) LIMIT 1`;
            contactId = found[0]?.id ?? (await this.prisma.customer_contacts.create({ data: { client_id: ctx.clientId, name: who.slice(0, 120), email, phone: phone || null, role: "other" } })).id;
        }
        const id = await this.tickets.create(
            { requesterCustomerContactId: contactId, subject: cleanSubject(input.subject) ? `${urgent ? "URGENT: " : ""}${cleanSubject(input.subject)}`.slice(0, 200) : helpSubject(user, ctx.name, urgent), description: `${message}\n\n${category ? `Category: ${category}\n` : ""}${app ? `Program: ${app.name}${app.publisher ? ` (${app.publisher}${app.version ? `, ${app.version}` : ""})` : ""}\n` : ""}Contact: ${[name, phone, email].filter(Boolean).join(", ") || user}\n-- Sent from the tray app on ${ctx.name} by ${user}.`, priority: urgent ? "high" : "medium", deviceId: ctx.deviceId, clientId: ctx.clientId ?? undefined } as any,
            req,
            { source: "tray" },
        );
        await this.prisma.$executeRaw`INSERT INTO public.tray_help_requests (device_id, ticket_id, requester, requester_email, requester_name, requester_phone, category, app_name, app_publisher, app_version) VALUES (${ctx.deviceId}::uuid, ${id}::uuid, ${user}, ${email || null}, ${name || null}, ${phone || null}, ${category}, ${app?.name ?? null}, ${app?.publisher ?? null}, ${app?.version ?? null})`;
        await this.noteContact(ctx.deviceId, user, name, email, phone);
        const t = await this.prisma.tickets.findUnique({ where: { id }, select: { ticket_number: true } });
        // the automatic checks and repair for what they picked, in the background (when it is switched on)
        await this.repair.start({ ticketId: id, deviceId: ctx.deviceId, orgId: ctx.organizationId, category, app });
        return { ok: true, ticket: { number: Number(t?.ticket_number ?? 0) } };
    }


    /** Remembers who is at the computer, as they said: shown to technicians next to the chat. Never throws. */
    private async noteContact(deviceId: string, windowsUser: string, name: string, email: string, phone: string) {
        if (!name && !email && !phone) return;
        try {
            await this.prisma.$executeRaw`INSERT INTO public.tray_contacts (device_id, windows_user, name, email, phone, updated_at) VALUES (${deviceId}::uuid, ${windowsUser}, ${name || null}, ${email || null}, ${phone || null}, now())
                ON CONFLICT (device_id, windows_user) DO UPDATE SET name = COALESCE(EXCLUDED.name, public.tray_contacts.name), email = COALESCE(EXCLUDED.email, public.tray_contacts.email), phone = COALESCE(EXCLUDED.phone, public.tray_contacts.phone), updated_at = now()`;
        } catch (e) {
            this.logger.debug(`Could not note the contact: ${(e as Error).message}`);
        }
    }

    /* ------------------------------ tickets, from the device ------------------------------ */

    /** The tickets of this computer the person may follow: open ones, and ones solved in the last days. Each says whether support has written since it was last opened here. */
    private async ticketList(ctx: Ctx) {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; number: string; subject: string; status: string; updated_at: Date; created_at: Date; unread: boolean; last_body: string | null; last_author: string | null }>>`
            SELECT t.id::text AS id, t.ticket_number::text AS number, t.subject, t.status::text AS status, t.updated_at, t.created_at,
                   EXISTS (SELECT 1 FROM public.ticket_activity a WHERE a.ticket_id = t.id AND a.kind = 'message' AND NOT a.is_internal AND NOT a.is_handoff AND NOT a.is_inbound
                           AND a.created_at > COALESCE((SELECT r.read_at FROM public.tray_ticket_reads r WHERE r.device_id = ${ctx.deviceId}::uuid AND r.ticket_id = t.id), '-infinity'::timestamptz)) AS unread,
                   lr.body AS last_body, lr.author AS last_author
              FROM public.tickets t
              LEFT JOIN LATERAL (SELECT a.body, a.author FROM public.ticket_activity a WHERE a.ticket_id = t.id AND a.kind = 'message' AND NOT a.is_internal AND NOT a.is_handoff AND NOT a.is_inbound ORDER BY a.created_at DESC LIMIT 1) lr ON true
             WHERE t.device_id = ${ctx.deviceId}::uuid AND t.organization_id = ${ctx.organizationId}::uuid
               AND (t.status::text IN ('open', 'pending', 'in_progress') OR (t.status::text = 'resolved' AND t.updated_at > now() - make_interval(days => ${SOLVED_SHOWN_DAYS}::int)))
             ORDER BY t.updated_at DESC LIMIT 20`;
        const repair = await this.repair.stateOf(rows.map((r) => r.id));
        return rows.map((r) => ({ number: Number(r.number), autoRepair: repair.get(r.id) === "awaiting_user" ? "awaiting_user" : null, subject: r.subject.slice(0, 200), status: r.status, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), unread: r.unread, lastReply: r.unread && r.last_body ? { sender: (r.last_author ?? "").slice(0, 80), text: preview(r.last_body, 200) } : null }));
    }

    private async ticketOf(ctx: Ctx, numberInput: unknown) {
        const n = Number(numberInput);
        if (!Number.isInteger(n) || n <= 0) throw new NotFoundException("Ticket not found");
        const rows = await this.prisma.$queryRaw<Array<{ id: string; number: string; subject: string; status: string; description: string | null; created_at: Date }>>`
            SELECT id::text AS id, ticket_number::text AS number, subject, status::text AS status, description, created_at FROM public.tickets
             WHERE ticket_number = ${n}::bigint AND organization_id = ${ctx.organizationId}::uuid AND device_id = ${ctx.deviceId}::uuid`;
        if (!rows[0]) throw new NotFoundException("Ticket not found");
        return rows[0];
    }

    /** One ticket's conversation as the person at the device may see it: what they wrote, and what support wrote to them. Internal notes never. Opening it marks the replies read. */
    async ticketForDevice(agentId: string, numberInput: unknown) {
        const ctx = await this.ctxOf(agentId);
        await this.requireOn(ctx, "help");
        const t = await this.ticketOf(ctx, numberInput);
        const acts = await this.prisma.$queryRaw<Array<{ id: string; body: string; author: string; is_inbound: boolean; created_at: Date }>>`
            SELECT * FROM (
              SELECT id::text AS id, body, author, is_inbound, created_at FROM public.ticket_activity
               WHERE ticket_id = ${t.id}::uuid AND kind = 'message' AND NOT is_internal AND NOT is_handoff ORDER BY created_at DESC LIMIT 60
            ) x ORDER BY created_at ASC`;
        await this.prisma.$executeRaw`INSERT INTO public.tray_ticket_reads (device_id, ticket_id, read_at) VALUES (${ctx.deviceId}::uuid, ${t.id}::uuid, now())
            ON CONFLICT (device_id, ticket_id) DO UPDATE SET read_at = now()`;
        const first = t.description ? stripTrayFooter(t.description) : "";
        const messages = [
            ...(first ? [{ id: "first", from: "you", sender: "", text: first.slice(0, 4000), at: t.created_at.toISOString() }] : []),
            ...acts.map((a) => ({ id: a.id, from: a.is_inbound ? "you" : "support", sender: a.author.slice(0, 80), text: a.body.slice(0, 4000), at: a.created_at.toISOString() })),
        ];
        const repairState = (await this.repair.stateOf([t.id])).get(t.id);
        return { ticket: { number: Number(t.number), subject: t.subject.slice(0, 200), status: t.status, autoRepair: repairState === "awaiting_user" ? "awaiting_user" : null }, messages };
    }

    /** The person at the device answers one of their tickets. A solved or waiting ticket goes back to open, like a reply from the customer portal. */
    async ticketReplyFromDevice(agentId: string, numberInput: unknown, input: { message?: unknown; user?: unknown; name?: unknown }) {
        const ctx = await this.ctxOf(agentId);
        await this.requireOn(ctx, "help");
        const t = await this.ticketOf(ctx, numberInput);
        if (t.status === "closed") throw new BadRequestException("This ticket is closed. Submit a new ticket instead.");
        const message = cleanMessage(input.message, "reply");
        const user = cleanName(input.name) || cleanUser(input.user);
        const [{ n }] = await this.prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM public.ticket_activity a JOIN public.tickets t ON t.id = a.ticket_id
             WHERE t.device_id = ${ctx.deviceId}::uuid AND a.via = 'tray' AND a.created_at > now() - interval '10 minutes'`;
        if (n >= TICKET_REPLIES_PER_10_MIN) throw new BadRequestException("You are sending replies very quickly. Please wait a few minutes.");
        await this.prisma.$transaction([
            this.prisma.ticket_activity.create({ data: { id: crypto.randomUUID(), ticket_id: t.id, kind: "message", body: message, author: user, is_inbound: true, via: "tray", is_internal: false, notify_customer: false } }),
            this.prisma.$executeRaw`UPDATE public.tickets SET updated_at = now(), status = CASE WHEN status::text IN ('pending', 'resolved') THEN 'open'::ticket_status ELSE status END WHERE id = ${t.id}::uuid`,
            this.prisma.$executeRaw`INSERT INTO public.tray_ticket_reads (device_id, ticket_id, read_at) VALUES (${ctx.deviceId}::uuid, ${t.id}::uuid, now())
                ON CONFLICT (device_id, ticket_id) DO UPDATE SET read_at = now()`,
        ]);
        await this.desk.onChanged(t.id).catch(() => undefined);
        await this.repair.onUserReply(t.id).catch(() => undefined);
        return { ok: true };
    }

    /** What the technicians wrote since the tray last asked, oldest first. Fetching them marks them delivered. */
    private async openSession(deviceId: string) {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; started_at: Date; contact_email: string | null; contact_name: string | null; contact_phone: string | null; windows_user: string | null }>>`
            SELECT id::text AS id, started_at, contact_email, contact_name, contact_phone, windows_user FROM public.device_chat_sessions WHERE device_id = ${deviceId}::uuid AND ended_at IS NULL LIMIT 1`;
        return rows[0] ?? null;
    }

    /** The chat that is going on for this computer, or a new one: a chat starts with the first message. */
    private async ensureSession(deviceId: string, windowsUser: string | null, name: string, email: string, phone: string) {
        await this.prisma.$executeRaw`INSERT INTO public.device_chat_sessions (device_id, windows_user, contact_name, contact_email, contact_phone) VALUES (${deviceId}::uuid, ${windowsUser}, ${name || null}, ${email || null}, ${phone || null})
            ON CONFLICT (device_id) WHERE ended_at IS NULL DO UPDATE SET contact_name = COALESCE(EXCLUDED.contact_name, device_chat_sessions.contact_name), contact_email = COALESCE(EXCLUDED.contact_email, device_chat_sessions.contact_email), contact_phone = COALESCE(EXCLUDED.contact_phone, device_chat_sessions.contact_phone), windows_user = COALESCE(EXCLUDED.windows_user, device_chat_sessions.windows_user)`;
        return (await this.openSession(deviceId))!;
    }

    /** What the technicians wrote in the chat that is going on, and how it stands. Fetching them marks them delivered. */
    async chatForDevice(agentId: string, after?: string) {
        const ctx = await this.ctxOf(agentId);
        await this.requireOn(ctx, "chat");
        const open = await this.openSession(ctx.deviceId);
        const ended = await this.prisma.$queryRaw<Array<{ id: string; ended_at: Date; ended_by: string | null; contact_email: string | null; transcript_email_status: string | null }>>`
            SELECT id::text AS id, ended_at, ended_by, contact_email, transcript_email_status FROM public.device_chat_sessions WHERE device_id = ${ctx.deviceId}::uuid AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`;
        const lastEnded = ended[0] ? { id: ended[0].id, endedAt: ended[0].ended_at.toISOString(), endedBy: ended[0].ended_by, emailedTo: ended[0].contact_email, emailStatus: ended[0].transcript_email_status } : null;
        if (!open) return { session: null, lastEnded, messages: [] };
        const since = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : null;
        const rows = await this.prisma.$queryRaw<Array<{ id: string; direction: string; sender: string; body: string; created_at: Date }>>`
            SELECT id::text AS id, direction, sender, body, created_at FROM public.device_chat_messages
            WHERE session_id = ${open.id}::uuid AND (${since}::timestamptz IS NULL OR date_trunc('milliseconds', created_at) > ${since}::timestamptz)
            ORDER BY created_at DESC, id DESC LIMIT ${PAGE}`;
        const messages = rows.reverse();
        const ids = messages.filter((m) => m.direction === "tech").map((m) => m.id);
        if (ids.length) await this.prisma.$executeRaw`UPDATE public.device_chat_messages SET delivered_at = now() WHERE id = ANY(${ids}::uuid[]) AND delivered_at IS NULL`;
        return {
            session: { id: open.id, startedAt: open.started_at.toISOString(), emailTo: open.contact_email },
            lastEnded,
            messages: messages.map((m) => ({ id: m.id, from: m.direction === "tech" ? "support" : "you", sender: m.sender, text: m.body, at: m.created_at.toISOString() })),
        };
    }

    /** Ends a chat: keeps a copy of the transcript with it and emails the copy to the person's address. Safe to call twice. */
    private async endSession(sessionId: string, by: "user" | "technician" | "idle", byName: string | null) {
        const done = await this.prisma.$queryRaw<Array<{ device_id: string; started_at: Date; ended_at: Date; contact_name: string | null; contact_email: string | null; windows_user: string | null }>>`
            UPDATE public.device_chat_sessions SET ended_at = now(), ended_by = ${by}, ended_by_name = ${byName}
             WHERE id = ${sessionId}::uuid AND ended_at IS NULL RETURNING device_id::text AS device_id, started_at, ended_at, contact_name, contact_email, windows_user`;
        const s = done[0];
        if (!s) return null;
        const info = await this.prisma.$queryRaw<Array<{ name: string; customer: string | null }>>`SELECT COALESCE(d.alias, d.hostname) AS name, c.name AS customer FROM public.devices d LEFT JOIN public.sites st ON st.id = d.site_id LEFT JOIN public.clients c ON c.id = st.client_id WHERE d.id = ${s.device_id}::uuid`;
        const msgs = await this.prisma.$queryRaw<Array<{ direction: string; sender: string; body: string; created_at: Date }>>`
            SELECT direction, sender, body, created_at FROM public.device_chat_messages WHERE session_id = ${sessionId}::uuid ORDER BY created_at ASC, id ASC`;
        const contact = [s.contact_name, s.contact_email].filter(Boolean).join(", ");
        const text = transcriptText({ device: info[0]?.name ?? "Computer", customer: info[0]?.customer ?? null, started: s.started_at, ended: s.ended_at, endedBy: by, contact, messages: msgs.map((m) => ({ at: m.created_at, sender: m.sender, from: m.direction === "tech" ? "support" : "you", text: m.body })) });
        let status = "no_email";
        if (s.contact_email) {
            try {
                const subject = `Your chat with support${info[0]?.name ? ` about ${info[0].name}` : ""}: transcript`;
                let r = await this.smtp.sendPlain("tickets", s.contact_email, subject, text);
                if (!r.ok && /not set up/i.test(r.result)) r = await this.smtp.sendPlain("alerts", s.contact_email, subject, text);
                status = r.ok ? "sent" : `failed: ${r.result}`.slice(0, 300);
            } catch (e) {
                status = `failed: ${(e as Error).message}`.slice(0, 300);
            }
        }
        await this.prisma.$executeRaw`UPDATE public.device_chat_sessions SET transcript = ${text}, transcript_email_status = ${status}, transcript_emailed_at = ${status === "sent" ? new Date() : null} WHERE id = ${sessionId}::uuid`;
        return { id: sessionId, deviceId: s.device_id, emailTo: s.contact_email, emailStatus: status };
    }

    /** The person typed who they are (before their first message): remembered, and put on the chat that is open, so technicians see them straight away. */
    async setContact(agentId: string, input: { user?: unknown; name?: unknown; email?: unknown; phone?: unknown }) {
        const ctx = await this.ctxOf(agentId);
        await this.requireOn(ctx, "chat");
        const windowsUser = cleanUser(input.user), name = cleanName(input.name), email = cleanEmail(input.email), phone = cleanPhone(input.phone);
        await this.noteContact(ctx.deviceId, windowsUser, name, email, phone);
        await this.prisma.$executeRaw`UPDATE public.device_chat_sessions SET contact_name = COALESCE(${name || null}, contact_name), contact_email = COALESCE(${email || null}, contact_email), contact_phone = COALESCE(${phone || null}, contact_phone), windows_user = COALESCE(${windowsUser}, windows_user) WHERE device_id = ${ctx.deviceId}::uuid AND ended_at IS NULL`;
        return { ok: true };
    }

    /** The person at the computer ends the chat. */
    async endFromDevice(agentId: string, input: { user?: unknown; name?: unknown }) {
        const ctx = await this.ctxOf(agentId);
        await this.requireOn(ctx, "chat");
        const open = await this.openSession(ctx.deviceId);
        if (!open) return { ok: true, ended: false };
        const r = await this.endSession(open.id, "user", cleanName(input.name) || cleanUser(input.user));
        return { ok: true, ended: !!r, emailTo: r?.emailTo ?? null, emailStatus: r?.emailStatus ?? null };
    }

    /** A technician ends the chat of a computer. */
    async endFromTech(actor: Actor, deviceId: string) {
        await this.assertDevice(actor, deviceId);
        const open = await this.openSession(deviceId);
        if (!open) return { ok: true, ended: false };
        const r = await this.endSession(open.id, "technician", actor.name ?? null);
        return { ok: true, ended: !!r, emailTo: r?.emailTo ?? null, emailStatus: r?.emailStatus ?? null };
    }

    /** Chats nobody has written in for a while end by themselves, and their transcripts go out. */
    @Interval(300_000)
    async endIdleChats() {
        try {
            const idle = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.device_chat_sessions WHERE ended_at IS NULL AND last_message_at < now() - make_interval(mins => ${CHAT_IDLE_MINUTES}::int) LIMIT 50`;
            for (const s of idle) await this.endSession(s.id, "idle", null);
        } catch (e) {
            this.logger.warn(`Could not end idle chats: ${(e as Error).message}`);
        }
    }

    async sendFromDevice(agentId: string, input: { message?: unknown; user?: unknown; name?: unknown; email?: unknown; phone?: unknown }) {
        const ctx = await this.ctxOf(agentId);
        await this.requireOn(ctx, "chat");
        const body = cleanMessage(input.message);
        const windowsUser = cleanUser(input.user);
        const name = cleanName(input.name), email = cleanEmail(input.email), phone = cleanPhone(input.phone);
        const user = name || windowsUser;
        await this.noteContact(ctx.deviceId, windowsUser, name, email, phone);
        const [{ n }] = await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.device_chat_messages WHERE device_id = ${ctx.deviceId}::uuid AND direction = 'device' AND created_at > now() - interval '10 minutes'`;
        if (n >= CHAT_PER_10_MIN) throw new BadRequestException("That is a lot of messages in a short time. Please wait a little.");
        const session = await this.ensureSession(ctx.deviceId, windowsUser, name, email, phone);
        await this.prisma.$executeRaw`UPDATE public.device_chat_sessions SET last_message_at = now() WHERE id = ${session.id}::uuid`;
        const rows = await this.prisma.$queryRaw<Array<{ id: string; created_at: Date }>>`INSERT INTO public.device_chat_messages (device_id, session_id, direction, sender, body) VALUES (${ctx.deviceId}::uuid, ${session.id}::uuid, 'device', ${user}, ${body}) RETURNING id::text AS id, created_at`;
        // technicians hear about it where they already look (Slack, Teams, a webhook)
        void this.hooks.emit("device.chat_message", {
            device: { id: ctx.deviceId, name: ctx.name, customer: ctx.customer, site: ctx.site },
            message: { from: user, text: preview(body, 300) },
            url: (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "") ? `${(process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "")}/chat?device=${ctx.deviceId}` : null,
        }, ctx.organizationId);
        return { ok: true, id: rows[0].id, at: rows[0].created_at.toISOString() };
    }

    /* ------------------------------ technicians ------------------------------ */

    private async org(actor: Actor) { return actor.organizationId || (await this.orgs.getDefaultOrganizationId()); }

    private async assertDevice(actor: Actor, deviceId: string) {
        if (!isCanonicalUuid(deviceId)) throw new NotFoundException("Device not found");
        await this.access.assertDevice(actor.id, deviceId);
        const org = await this.org(actor);
        const rows = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`SELECT true AS ok FROM public.devices d LEFT JOIN public.sites s ON s.id = d.site_id LEFT JOIN public.clients c ON c.id = s.client_id
            WHERE d.id = ${deviceId}::uuid AND (c.organization_id = ${org}::uuid OR c.id IS NULL)`;
        if (!rows[0]) throw new NotFoundException("Device not found");
    }

    /** The devices that have talked, newest first, with what the last line said and how many of the person's lines nobody has read. */
    async conversations(actor: Actor) {
        const org = await this.org(actor);
        const rows = await this.prisma.$queryRaw<Array<{ device_id: string; name: string; customer: string | null; site: string | null; last_at: Date; last_body: string; last_direction: string; unread: number; online: boolean }>>`
            WITH recent AS (
              SELECT device_id, max(created_at) AS last_at, count(*) FILTER (WHERE direction = 'device' AND read_by_tech_at IS NULL)::int AS unread
              FROM public.device_chat_messages GROUP BY device_id ORDER BY max(created_at) DESC LIMIT 300
            )
            SELECT r.device_id::text AS device_id, COALESCE(d.alias, d.hostname) AS name, c.name AS customer, s.name AS site, r.last_at, m.body AS last_body, m.direction AS last_direction, r.unread,
                   COALESCE(a.last_check_in_at > now() - interval '10 minutes', false) AS online
            FROM recent r JOIN public.devices d ON d.id = r.device_id LEFT JOIN public.sites s ON s.id = d.site_id LEFT JOIN public.clients c ON c.id = s.client_id LEFT JOIN public.agents a ON a.device_id = d.id
            JOIN LATERAL (SELECT body, direction FROM public.device_chat_messages WHERE device_id = r.device_id ORDER BY created_at DESC, id DESC LIMIT 1) m ON true
            WHERE (c.organization_id = ${org}::uuid OR c.id IS NULL) ORDER BY r.last_at DESC`;
        // a limited person sees only the devices of their customers, sites and tags
        const scope = await this.access.scopeFor(actor.id);
        let visible = rows;
        if (scope) {
            const ok = new Set((await this.prisma.devices.findMany({ where: { id: { in: rows.map((r) => r.device_id) }, ...this.access.deviceWhere(scope) }, select: { id: true } })).map((d) => d.id));
            visible = rows.filter((r) => ok.has(r.device_id));
        }
        return {
            items: visible.map((r) => ({ deviceId: r.device_id, name: r.name, customer: r.customer, site: r.site, online: r.online, lastAt: r.last_at.toISOString(), lastText: preview(r.last_body, 100), lastFrom: r.last_direction === "tech" ? "support" : "device", unread: r.unread })),
            unread: visible.reduce((n, r) => n + r.unread, 0),
        };
    }

    /** How many lines of people at devices nobody has read: for the badge. */
    async unreadCount(actor: Actor): Promise<number> {
        return (await this.conversations(actor)).unread;
    }

    async thread(actor: Actor, deviceId: string) {
        await this.assertDevice(actor, deviceId);
        const device = await this.prisma.devices.findUnique({ where: { id: deviceId }, select: { hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true } } } }, agents: { select: { last_check_in_at: true } } } });
        const open = await this.openSession(deviceId);
        const rows = open ? await this.prisma.$queryRaw<Array<{ id: string; direction: string; sender: string; body: string; created_at: Date; delivered_at: Date | null }>>`
            SELECT id::text AS id, direction, sender, body, created_at, delivered_at FROM public.device_chat_messages WHERE session_id = ${open.id}::uuid ORDER BY created_at DESC, id DESC LIMIT 200` : [];
        const past = await this.prisma.$queryRaw<Array<{ id: string; started_at: Date; ended_at: Date; ended_by: string | null; ended_by_name: string | null; contact_name: string | null; contact_email: string | null; transcript_email_status: string | null; n: number }>>`
            SELECT s.id::text AS id, s.started_at, s.ended_at, s.ended_by, s.ended_by_name, s.contact_name, s.contact_email, s.transcript_email_status,
                   (SELECT count(*)::int FROM public.device_chat_messages m WHERE m.session_id = s.id) AS n
              FROM public.device_chat_sessions s WHERE s.device_id = ${deviceId}::uuid AND s.ended_at IS NOT NULL ORDER BY s.ended_at DESC LIMIT 30`;
        await this.prisma.$executeRaw`UPDATE public.device_chat_messages SET read_by_tech_at = now() WHERE device_id = ${deviceId}::uuid AND direction = 'device' AND read_by_tech_at IS NULL`;
        const s = await this.settings(await this.org(actor));
        return {
            device: { id: deviceId, name: device?.alias || device?.hostname || "Device", customer: device?.sites?.clients?.name ?? null, site: device?.sites?.name ?? null, online: !!device?.agents?.last_check_in_at && Date.now() - device.agents.last_check_in_at.getTime() < 600_000 },
            trayOn: s.enabled && s.chatEnabled,
            session: open ? { id: open.id, startedAt: open.started_at.toISOString(), contactName: open.contact_name, contactEmail: open.contact_email } : null,
            sessions: past.map((p) => ({ id: p.id, startedAt: p.started_at.toISOString(), endedAt: p.ended_at.toISOString(), endedBy: p.ended_by, endedByName: p.ended_by_name, contactName: p.contact_name, contactEmail: p.contact_email, emailStatus: p.transcript_email_status, messages: p.n })),
            contact: open && (open.contact_name || open.contact_email || open.contact_phone)
                ? { user: open.windows_user ?? "", name: open.contact_name, email: open.contact_email, phone: open.contact_phone }
                : await this.prisma.$queryRaw<Array<{ windows_user: string; name: string | null; email: string | null; phone: string | null }>>`SELECT windows_user, name, email, phone FROM public.tray_contacts WHERE device_id = ${deviceId}::uuid ORDER BY updated_at DESC LIMIT 1`.then((r) => (r[0] ? { user: r[0].windows_user, name: r[0].name, email: r[0].email, phone: r[0].phone } : null)).catch(() => null),
            messages: rows.reverse().map((m) => ({ id: m.id, from: m.direction === "tech" ? "support" : "device", sender: m.sender, text: m.body, at: m.created_at.toISOString(), seen: m.direction === "tech" ? !!m.delivered_at : null })),
        };
    }

    async reply(actor: Actor, deviceId: string, input: { message?: unknown }) {
        await this.assertDevice(actor, deviceId);
        const s = await this.settings(await this.org(actor));
        if (!s.enabled || !s.chatEnabled) throw new BadRequestException("The tray app is not turned on, so there is nobody to read this. Turn it on under Administration > Agents & Endpoints.");
        const body = cleanMessage(input.message);
        const sender = cleanUser(actor.name || "Support").slice(0, 80);
        // a chat the technician starts uses who was last at the computer as the person to write to
        const who = await this.prisma.$queryRaw<Array<{ windows_user: string; name: string | null; email: string | null; phone: string | null }>>`SELECT windows_user, name, email, phone FROM public.tray_contacts WHERE device_id = ${deviceId}::uuid ORDER BY updated_at DESC LIMIT 1`;
        const session = await this.ensureSession(deviceId, who[0]?.windows_user ?? null, who[0]?.name ?? "", who[0]?.email ?? "", who[0]?.phone ?? "");
        await this.prisma.$executeRaw`UPDATE public.device_chat_sessions SET last_message_at = now() WHERE id = ${session.id}::uuid`;
        const rows = await this.prisma.$queryRaw<Array<{ id: string; created_at: Date }>>`INSERT INTO public.device_chat_messages (device_id, session_id, direction, sender, user_id, body) VALUES (${deviceId}::uuid, ${session.id}::uuid, 'tech', ${sender}, ${actor.id}::uuid, ${body}) RETURNING id::text AS id, created_at`;
        return { ok: true, id: rows[0].id, at: rows[0].created_at.toISOString() };
    }

    /** One ended chat, in full, for the dashboard: its messages and the copy that was emailed. */
    async sessionTranscript(actor: Actor, deviceId: string, sessionId: string) {
        await this.assertDevice(actor, deviceId);
        if (!isCanonicalUuid(sessionId)) throw new NotFoundException("Chat not found");
        const rows = await this.prisma.$queryRaw<Array<{ id: string; started_at: Date; ended_at: Date | null; ended_by: string | null; ended_by_name: string | null; contact_name: string | null; contact_email: string | null; contact_phone: string | null; transcript: string | null; transcript_email_status: string | null; transcript_emailed_at: Date | null }>>`
            SELECT id::text AS id, started_at, ended_at, ended_by, ended_by_name, contact_name, contact_email, contact_phone, transcript, transcript_email_status, transcript_emailed_at
              FROM public.device_chat_sessions WHERE id = ${sessionId}::uuid AND device_id = ${deviceId}::uuid`;
        const s = rows[0];
        if (!s) throw new NotFoundException("Chat not found");
        const msgs = await this.prisma.$queryRaw<Array<{ id: string; direction: string; sender: string; body: string; created_at: Date }>>`
            SELECT id::text AS id, direction, sender, body, created_at FROM public.device_chat_messages WHERE session_id = ${sessionId}::uuid ORDER BY created_at ASC, id ASC`;
        return {
            session: { id: s.id, startedAt: s.started_at.toISOString(), endedAt: iso(s.ended_at), endedBy: s.ended_by, endedByName: s.ended_by_name, contactName: s.contact_name, contactEmail: s.contact_email, contactPhone: s.contact_phone, emailStatus: s.transcript_email_status, emailedAt: iso(s.transcript_emailed_at) },
            transcript: s.transcript,
            messages: msgs.map((m) => ({ id: m.id, from: m.direction === "tech" ? "support" : "device", sender: m.sender, text: m.body, at: m.created_at.toISOString() })),
        };
    }

    /** The person at the computer says a ticket is solved, and why. The reason is a public message on the ticket and the ticket becomes solved. */
    async ticketResolveFromDevice(agentId: string, numberInput: unknown, input: { reason?: unknown; user?: unknown; name?: unknown }) {
        const ctx = await this.ctxOf(agentId);
        await this.requireOn(ctx, "help");
        const t = await this.ticketOf(ctx, numberInput);
        if (t.status === "closed" || t.status === "resolved") throw new BadRequestException("This ticket is already solved.");
        const reason = cleanReason(input.reason);
        const user = cleanName(input.name) || cleanUser(input.user);
        await this.prisma.$transaction([
            this.prisma.ticket_activity.create({ data: { id: crypto.randomUUID(), ticket_id: t.id, kind: "message", body: `Marked as solved by ${user}: ${reason}`, author: user, is_inbound: true, via: "tray", is_internal: false, notify_customer: false } }),
            this.prisma.ticket_activity.create({ data: { id: crypto.randomUUID(), ticket_id: t.id, kind: "change", body: `status: ${t.status} -> resolved`, author: user, is_internal: false, notify_customer: false, field: "status", from_value: t.status, to_value: "resolved" } }),
            this.prisma.$executeRaw`UPDATE public.tickets SET status = 'resolved'::ticket_status, updated_at = now() WHERE id = ${t.id}::uuid`,
            this.prisma.$executeRaw`INSERT INTO public.tray_ticket_reads (device_id, ticket_id, read_at) VALUES (${ctx.deviceId}::uuid, ${t.id}::uuid, now()) ON CONFLICT (device_id, ticket_id) DO UPDATE SET read_at = now()`,
        ]);
        await this.desk.onChanged(t.id).catch(() => undefined);
        await this.repair.onUserResolved(t.id).catch(() => undefined);
        return { ok: true };
    }

    @Interval(3_600_000)
    async prune() {
        try {
            await this.prisma.$executeRaw`DELETE FROM public.device_chat_messages WHERE created_at < now() - ${KEEP_DAYS} * interval '1 day'`;
            // an ended chat keeps its transcript for a year
            await this.prisma.$executeRaw`DELETE FROM public.device_chat_sessions WHERE ended_at < now() - interval '365 days'`;
        } catch (e) {
            this.logger.warn(`Could not prune chat: ${(e as Error).message}`);
        }
    }
}

