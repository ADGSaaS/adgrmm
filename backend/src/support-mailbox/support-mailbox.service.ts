import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { randomBytes, randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { SmtpRepository } from "../smtp/smtp.repository";
import { SmtpService } from "../smtp/smtp.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { ServiceDeskService } from "../service-desk/service-desk.service";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { fireWorkflow } from "../workflows/workflows.bus";
import {
    MAX_PER_SENDER_PER_HOUR,
    cleanSubject,
    newTextOnly,
    referencedMessageIds,
    replySubject,
    skipReason,
    ticketNumberFromSubject,
} from "./mail-rules";
import {
    GRAPH_SEND_SCOPE,
    IMAP_SCOPE,
    MicrosoftAuthError,
    accountFromIdToken,
    authorizeUrl,
    exchangeCode,
    graphSendMail,
    refreshFor,
    validClientId,
    validTenant,
} from "./microsoft";

/** "Tickets <tickets@x.com>" and "tickets@x.com" are both just tickets@x.com. */
function bareAddress(v: string | null | undefined): string {
    const s = String(v ?? "").trim();
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
    const a = (m ? m[1] : s).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+$/.test(a) ? a : "";
}

const MAX_PER_POLL = 25;
const MAX_BODY_CHARS = 50_000;

export type MailboxStatus = {
    enabled: boolean;
    /** Where mail comes from: Microsoft 365 sign-in, or the IMAP login saved under the Tickets purpose. */
    source: "microsoft" | "imap";
    /** Whether the Tickets purpose has an IMAP login filled in. */
    imapReady: boolean;
    tenantId: string;
    clientId: string;
    hasClientSecret: boolean;
    connected: boolean;
    mailboxAddress: string;
    connectedAt: string | null;
    lastPolledAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
};

export type ProcessResult =
    | { action: "ticket"; ticketId: string; ticketNumber: number }
    | { action: "reply"; ticketId: string; ticketNumber: number }
    | { action: "skipped"; reason: string };

type Row = NonNullable<Awaited<ReturnType<PrismaService["support_mailbox"]["findUnique"]>>>;

/** What a person is told when Microsoft's answer could not be used. */
const RECONNECT = "The Microsoft sign-in expired or was revoked. Connect the mailbox again.";

@Injectable()
export class SupportMailboxService {
    private readonly log = new Logger(SupportMailboxService.name);
    private polling = false;

    /** The calls that leave this server, kept together so tests can replace them. */
    ms = { exchangeCode, refreshFor, graphSendMail };

    constructor(
        private readonly prisma: PrismaService,
        private readonly smtpRepo: SmtpRepository,
        private readonly smtp: SmtpService,
        private readonly webhooks: WebhooksService,
        private readonly desk?: ServiceDeskService
    ) { }

    /** The IMAP login (and the address replies come from) saved under the Tickets purpose in the email settings. */
    private async manualSettings() {
        const t = (await this.smtpRepo.getAllRaw()).tickets;
        const ready = !!(t?.imap_host && t.imap_username && t.imap_password);
        return { t, ready, address: bareAddress(t?.smtp_from_address) || bareAddress(t?.imap_username) };
    }

    // ---- Settings ---------------------------------------------------------------------------------------------

    async status(orgId: string): Promise<MailboxStatus> {
        const r = await this.prisma.support_mailbox.findUnique({ where: { organization_id: orgId } });
        const manual = await this.manualSettings();
        return {
            enabled: !!r?.enabled,
            source: r?.source === "imap" ? "imap" : "microsoft",
            imapReady: manual.ready,
            tenantId: r?.tenant_id ?? "",
            clientId: r?.client_id ?? "",
            hasClientSecret: !!r?.client_secret,
            connected: r?.source === "imap" ? manual.ready : !!r?.refresh_token,
            mailboxAddress: r?.mailbox_address ?? "",
            connectedAt: r?.connected_at?.toISOString() ?? null,
            lastPolledAt: r?.last_polled_at?.toISOString() ?? null,
            lastError: r?.last_error ?? null,
            lastErrorAt: r?.last_error_at?.toISOString() ?? null,
        };
    }

    async save(orgId: string, input: { source?: "microsoft" | "imap"; tenantId?: string; clientId?: string; clientSecret?: string; enabled?: boolean }) {
        const cur = await this.prisma.support_mailbox.findUnique({ where: { organization_id: orgId } });
        const tenant = input.tenantId !== undefined ? input.tenantId.trim() : cur?.tenant_id ?? "";
        const clientId = input.clientId !== undefined ? input.clientId.trim() : cur?.client_id ?? "";
        if (tenant && !validTenant(tenant)) throw new BadRequestException("The directory (tenant) ID is not valid. Copy it from the app registration's overview page.");
        if (clientId && !validClientId(clientId)) throw new BadRequestException("The application (client) ID is not valid. It looks like 00000000-0000-0000-0000-000000000000.");

        const secret = typeof input.clientSecret === "string" && input.clientSecret.trim() ? input.clientSecret.trim() : null;
        const appChanged = !!cur && (cur.tenant_id !== tenant || cur.client_id !== clientId || !!secret);
        const data: Record<string, unknown> = {
            tenant_id: tenant,
            client_id: clientId,
            ...(secret ? { client_secret: encryptSecret(secret) } : {}),
            // A different app means the saved sign-in is no good: it has to be connected again.
            ...(appChanged ? { refresh_token: null, connected_at: null, mailbox_address: "" } : {}),
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            updated_at: new Date(),
        };
        const source = input.source ?? (cur?.source === "imap" ? "imap" : "microsoft");
        const sourceChanged = (cur?.source ?? "microsoft") !== source;
        const turningOn = input.enabled === true || (sourceChanged && cur?.enabled === true);
        if (turningOn && source === "microsoft" && !(cur?.refresh_token && !appChanged && !sourceChanged)) {
            throw new BadRequestException("Connect the mailbox first, then turn it on.");
        }
        const manual = await this.manualSettings();
        if (turningOn && source === "imap" && !manual.ready) {
            throw new BadRequestException("Fill in the IMAP server, username and password for the Tickets purpose in Administration > SMTP first.");
        }
        // Mail that was already waiting when the mailbox is turned on is left alone, so the clock starts now.
        const startsNow = source === "imap" && turningOn && (!cur?.enabled || sourceChanged);
        Object.assign(data, {
            source,
            ...(source === "imap" && turningOn ? { mailbox_address: manual.address } : {}),
            ...(startsNow ? { connected_at: new Date(), last_error: null, last_error_at: null } : {}),
            ...(sourceChanged && source === "microsoft" ? { enabled: false, mailbox_address: "", connected_at: null } : {}),
        });
        await this.prisma.support_mailbox.upsert({
            where: { organization_id: orgId },
            create: { organization_id: orgId, ...data },
            update: data,
        });
        return this.status(orgId);
    }

    async disconnect(orgId: string) {
        await this.prisma.support_mailbox.updateMany({
            where: { organization_id: orgId },
            data: { enabled: false, refresh_token: null, connected_at: null, mailbox_address: "", last_error: null, last_error_at: null, updated_at: new Date() },
        });
        return this.status(orgId);
    }

    // ---- Signing in to Microsoft ------------------------------------------------------------------------------

    async beginConnect(orgId: string, redirectUri: string, returnTo: string | null): Promise<string> {
        const r = await this.prisma.support_mailbox.findUnique({ where: { organization_id: orgId } });
        if (!r?.tenant_id || !r.client_id || !r.client_secret) {
            throw new BadRequestException("Save the tenant ID, client ID and client secret first.");
        }
        const state = randomBytes(24).toString("hex");
        await this.prisma.support_mailbox.update({
            where: { organization_id: orgId },
            data: {
                oauth_state: state,
                oauth_state_expires: new Date(Date.now() + 10 * 60_000),
                oauth_return_to: returnTo && /^https?:\/\//i.test(returnTo) ? returnTo.slice(0, 500) : null,
            },
        });
        return authorizeUrl({ tenant: r.tenant_id, clientId: r.client_id, redirectUri, state, loginHint: r.mailbox_address || undefined });
    }

    private async takeState(state: string): Promise<Row | null> {
        if (!/^[0-9a-f]{48}$/.test(state)) return null;
        const r = await this.prisma.support_mailbox.findFirst({ where: { oauth_state: state, oauth_state_expires: { gt: new Date() } } });
        if (!r) return null;
        await this.prisma.support_mailbox.update({ where: { organization_id: r.organization_id }, data: { oauth_state: null, oauth_state_expires: null } });
        return r;
    }

    /** Microsoft sent the person back with a code. Returns where to send the browser next. */
    async completeConnect(state: string, code: string, redirectUri: string): Promise<{ ok: boolean; message: string; returnTo: string | null }> {
        const r = await this.takeState(state);
        if (!r) return { ok: false, message: "That sign-in link expired or was already used. Start again from the Support mailbox page.", returnTo: null };
        const returnTo = r.oauth_return_to;
        try {
            const t = await this.ms.exchangeCode({ tenant: r.tenant_id, clientId: r.client_id, clientSecret: decryptSecret(r.client_secret ?? ""), code, redirectUri });
            if (!t.refreshToken) return { ok: false, message: "Microsoft did not allow the mailbox to stay signed in (no refresh token).", returnTo };
            const address = accountFromIdToken(t.idToken);
            if (!address) return { ok: false, message: "Microsoft did not say which mailbox signed in.", returnTo };
            await this.prisma.support_mailbox.update({
                where: { organization_id: r.organization_id },
                data: {
                    refresh_token: encryptSecret(t.refreshToken),
                    mailbox_address: address,
                    connected_at: new Date(),
                    enabled: true,
                    last_error: null,
                    last_error_at: null,
                    updated_at: new Date(),
                },
            });
            await this.ensureChannel(r.organization_id);
            return { ok: true, message: `Connected ${address}`, returnTo };
        } catch (e: any) {
            const message = String(e?.message ?? e).slice(0, 300);
            await this.noteError(r.organization_id, message);
            return { ok: false, message, returnTo };
        }
    }

    /** Microsoft sent the person back with an error (they said no, or the app is set up wrong). */
    async failConnect(state: string, message: string): Promise<string | null> {
        const r = await this.takeState(state);
        if (r) await this.noteError(r.organization_id, message.slice(0, 300));
        return r?.oauth_return_to ?? null;
    }

    private async noteError(orgId: string, message: string) {
        await this.prisma.support_mailbox.updateMany({ where: { organization_id: orgId }, data: { last_error: message, last_error_at: new Date() } });
    }

    /** A token for IMAP or for sending. A refresh token Microsoft replaces is saved. */
    private async tokenFor(r: Row, scope: string): Promise<string> {
        if (!r.refresh_token || !r.client_secret) throw new Error("The mailbox is not connected.");
        try {
            const t = await this.ms.refreshFor({
                tenant: r.tenant_id,
                clientId: r.client_id,
                clientSecret: decryptSecret(r.client_secret),
                refreshToken: decryptSecret(r.refresh_token),
                scope,
            });
            if (t.refreshToken) {
                await this.prisma.support_mailbox.update({ where: { organization_id: r.organization_id }, data: { refresh_token: encryptSecret(t.refreshToken) } });
            }
            return t.accessToken;
        } catch (e: any) {
            if (e instanceof MicrosoftAuthError && e.needsReconnect) {
                await this.prisma.support_mailbox.update({
                    where: { organization_id: r.organization_id },
                    data: { refresh_token: null, connected_at: null, last_error: RECONNECT, last_error_at: new Date() },
                });
                throw new Error(RECONNECT);
            }
            throw e;
        }
    }

    // ---- Reading mail -----------------------------------------------------------------------------------------

    @Cron(CronExpression.EVERY_MINUTE)
    async pollAll() {
        if (process.env.SUPPORT_MAILBOX_POLL === "0" || this.polling) return;
        this.polling = true;
        try {
            const rows = await this.prisma.support_mailbox.findMany({ where: { enabled: true, OR: [{ source: "imap" }, { refresh_token: { not: null } }] } });
            for (const r of rows) {
                try {
                    await this.pollOne(r.organization_id);
                } catch (e: any) {
                    this.log.warn(`Support mailbox poll failed: ${e?.message ?? e}`);
                }
            }
        } finally {
            this.polling = false;
        }
    }

    /** Reads new mail once. Returns what it did, for the "Check now" button. */
    async pollOne(orgId: string): Promise<{ read: number; tickets: number; replies: number; skipped: number }> {
        const r = await this.prisma.support_mailbox.findUnique({ where: { organization_id: orgId } });
        if (!r) throw new BadRequestException("The mailbox is not connected.");
        const out = { read: 0, tickets: 0, replies: 0, skipped: 0 };
        let client: ImapFlow | null = null;
        try {
            if (r.source === "imap") {
                const { t: cfg, ready } = await this.manualSettings();
                if (!ready || !cfg) throw new BadRequestException("The IMAP server, username and password for the Tickets purpose are not filled in.");
                client = new ImapFlow({
                    host: cfg.imap_host,
                    port: cfg.imap_port ?? (cfg.imap_use_ssl ? 993 : 143),
                    secure: !!cfg.imap_use_ssl,
                    auth: { user: cfg.imap_username, pass: decryptSecret(cfg.imap_password!) },
                    logger: false,
                    tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED ? /^(1|true|yes)$/i.test(process.env.SMTP_TLS_REJECT_UNAUTHORIZED) : process.env.NODE_ENV === "production" },
                    connectionTimeout: 15_000,
                    greetingTimeout: 15_000,
                });
            } else {
                if (!r.refresh_token || !r.mailbox_address) throw new BadRequestException("The mailbox is not connected.");
                const accessToken = await this.tokenFor(r, IMAP_SCOPE);
                client = new ImapFlow({
                    host: process.env.SUPPORT_IMAP_HOST || "outlook.office365.com",
                    port: 993,
                    secure: true,
                    auth: { user: r.mailbox_address, accessToken },
                    logger: false,
                    connectionTimeout: 15_000,
                    greetingTimeout: 15_000,
                });
            }
            await client.connect();
            const lock = await client.getMailboxLock("INBOX");
            try {
                // Mail that was already waiting when the mailbox was connected is left alone.
                const since = r.connected_at ?? new Date();
                const uids = ((await client.search({ seen: false, since: new Date(since.getTime() - 86_400_000) }, { uid: true })) || []) as number[];
                for (const uid of uids.slice(0, MAX_PER_POLL)) {
                    const msg: any = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
                    if (!msg?.source) continue;
                    const received = msg.internalDate ? new Date(msg.internalDate) : new Date();
                    if (received.getTime() < since.getTime() - 60_000) continue;
                    out.read++;
                    let res: ProcessResult;
                    try {
                        res = await this.processRaw(r, msg.source, received);
                    } catch (e: any) {
                        this.log.error(`Could not turn a message into a ticket: ${e?.message ?? e}`);
                        // Left unread, so it is tried again on the next check.
                        await this.noteError(orgId, `A message could not be turned into a ticket: ${String(e?.message ?? e).slice(0, 200)}`);
                        continue;
                    }
                    if (res.action === "ticket") out.tickets++;
                    else if (res.action === "reply") out.replies++;
                    else out.skipped++;
                    await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
                }
            } finally {
                lock.release();
            }
            await this.prisma.support_mailbox.update({ where: { organization_id: orgId }, data: { last_polled_at: new Date(), last_error: null, last_error_at: null } });
        } catch (e: any) {
            const m = String(e?.responseText ?? e?.message ?? e).slice(0, 300);
            await this.noteError(orgId, m);
            throw e;
        } finally {
            try {
                await client?.logout();
            } catch {
                /* the connection is already gone */
            }
        }
        return out;
    }

    private async ensureChannel(orgId: string): Promise<string> {
        const found = await this.prisma.email_channels.findFirst({ where: { organization_id: orgId, name: "Support mailbox" }, select: { id: true } });
        if (found) return found.id;
        const made = await this.prisma.email_channels.create({
            data: { organization_id: orgId, name: "Support mailbox", purpose: "support", is_inbound_enabled: true, is_outbound_enabled: true },
            select: { id: true },
        });
        return made.id;
    }

    private headerMap(parsed: ParsedMail): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of parsed.headers) {
            // mailparser folds List-Id and List-Unsubscribe into one "list" entry.
            if (k === "list") { out["list-id"] = "present"; continue; }
            if (typeof v === "string") out[k] = v;
            else if (v && typeof v === "object" && "value" in (v as any) && typeof (v as any).value === "string") {
                const params = (v as any).params ?? {};
                out[k] = [(v as any).value, ...Object.entries(params).map(([pk, pv]) => `${pk}=${pv}`)].join("; ");
            }
            // Structured headers (List-Id, List-Unsubscribe) only need to be known to be there.
            else if (v !== undefined && v !== null) out[k] = String((v as any).text ?? "present");
        }
        return out;
    }

    /** One message, as it came off the wire. Creates a ticket, adds a reply to one, or sets the message aside. */
    async processRaw(mailbox: Pick<Row, "organization_id" | "mailbox_address">, raw: Buffer, receivedAt: Date): Promise<ProcessResult> {
        const orgId = mailbox.organization_id;
        const parsed = await simpleParser(raw);
        const from = parsed.from?.value?.[0];
        const fromAddress = (from?.address ?? "").trim().toLowerCase() || null;
        const subject = (parsed.subject ?? "").toString();
        const messageId = (parsed.messageId ?? "").replace(/^<|>$/g, "") || null;
        const channelId = await this.ensureChannel(orgId);

        const record = (ticketId: string | null, extra: Record<string, unknown>) =>
            this.prisma.email_messages.create({
                data: {
                    channel_id: channelId,
                    ticket_id: ticketId,
                    direction: "inbound",
                    message_id: messageId,
                    subject: subject.slice(0, 500) || null,
                    from_address: fromAddress,
                    to_addresses: (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []).flatMap((a) => a.value.map((v) => v.address ?? "")).filter(Boolean),
                    cc_addresses: (Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : []).flatMap((a) => a.value.map((v) => v.address ?? "")).filter(Boolean),
                    received_at: receivedAt,
                    payload: extra as Prisma.InputJsonValue,
                },
            });

        // The same message seen twice (a copy in two folders, a retry) is only handled once.
        if (messageId) {
            const dup = await this.prisma.email_messages.findFirst({ where: { channel_id: channelId, direction: "inbound", message_id: messageId }, select: { id: true } });
            if (dup) return { action: "skipped", reason: "duplicate" };
        }

        const why = skipReason({ fromAddress, mailboxAddress: mailbox.mailbox_address, subject, headers: this.headerMap(parsed) });
        if (why) {
            await record(null, { skipped: why });
            return { action: "skipped", reason: why };
        }

        const recent = await this.prisma.email_messages.count({
            where: { channel_id: channelId, direction: "inbound", from_address: fromAddress, created_at: { gt: new Date(Date.now() - 3_600_000) } },
        });
        if (recent >= MAX_PER_SENDER_PER_HOUR) {
            await record(null, { skipped: "rate-limit" });
            return { action: "skipped", reason: "rate-limit" };
        }

        let body = newTextOnly((parsed.text ?? "").toString()).slice(0, MAX_BODY_CHARS);
        const files = parsed.attachments ?? [];
        if (files.length > 0) {
            const names = files.map((f) => f.filename || "unnamed").slice(0, 10).join(", ");
            body += `${body ? "\n\n" : ""}(${files.length} attachment${files.length === 1 ? "" : "s"} in the email ${files.length === 1 ? "was" : "were"} not imported: ${names})`;
        }
        if (!body.trim()) body = "(the email had no text)";
        const who = from?.name?.trim() || fromAddress!;

        // Which ticket is this about? The tag in the subject first, then the message ids it answers.
        let ticket: { id: string; ticket_number: bigint; status: string } | null = null;
        const number = ticketNumberFromSubject(subject);
        if (number) {
            ticket = await this.prisma.tickets.findFirst({ where: { organization_id: orgId, ticket_number: BigInt(number) }, select: { id: true, ticket_number: true, status: true } });
        }
        if (!ticket) {
            const ids = referencedMessageIds(parsed.inReplyTo, parsed.references);
            if (ids.length) {
                const hit = await this.prisma.email_messages.findFirst({
                    where: { channel_id: channelId, message_id: { in: ids }, ticket_id: { not: null }, tickets: { organization_id: orgId } },
                    select: { tickets: { select: { id: true, ticket_number: true, status: true } } },
                });
                ticket = hit?.tickets ?? null;
            }
        }

        if (ticket) {
            await this.prisma.ticket_activity.create({
                data: { id: randomUUID(), ticket_id: ticket.id, kind: "message", body, attachments: [], time_worked_seconds: 0, notify_customer: false, author: who, is_internal: false, is_inbound: true },
            });
            const reopen = ["resolved", "closed", "pending"].includes(ticket.status);
            await this.prisma.tickets.update({ where: { id: ticket.id }, data: { updated_at: new Date(), ...(reopen ? { status: "open", closed_at: null } : {}) } });
            if (reopen) {
                await this.prisma.ticket_activity.create({
                    data: { id: randomUUID(), ticket_id: ticket.id, kind: "change", body: `status: ${ticket.status} -> open`, attachments: [], time_worked_seconds: 0, notify_customer: false, author: "Email reply", is_internal: true, field: "status", from_value: ticket.status, to_value: "open" },
                });
            }
            // A reply can reopen the ticket or take it off hold: the SLA clocks follow.
            await this.desk?.onChanged(ticket.id);
            await record(ticket.id, { kind: "reply" });
            return { action: "reply", ticketId: ticket.id, ticketNumber: Number(ticket.ticket_number) };
        }

        const contactId = await this.contactFor(orgId, fromAddress!, from?.name?.trim() || "");
        const created = await this.createTicket(orgId, cleanSubject(subject), body, contactId);
        await this.linkCustomerContact(orgId, created.id, fromAddress!);
        // Routing rules and the SLA clocks, once the customer is known.
        await this.desk?.onCreated(created.id, { source: "email" });
        fireWorkflow({ trigger: "ticket.created", ticketId: created.id, source: "email" });
        await record(created.id, { kind: "new" });
        return { action: "ticket", ticketId: created.id, ticketNumber: created.number };
    }

    /** A sender who is on one customer's contact list becomes that ticket's requester, and the ticket takes the customer. An address on several customers' lists is left alone. */
    private async linkCustomerContact(orgId: string, ticketId: string, email: string): Promise<void> {
        try {
            const hits = await this.prisma.customer_contacts.findMany({
                where: { email: { equals: email, mode: "insensitive" }, clients: { organization_id: orgId } },
                select: { id: true, client_id: true },
                take: 2,
            });
            if (hits.length !== 1) return;
            await this.prisma.tickets.updateMany({ where: { id: ticketId }, data: { requester_customer_contact_id: hits[0].id } });
            await this.prisma.tickets.updateMany({ where: { id: ticketId, client_id: null }, data: { client_id: hits[0].client_id } });
        } catch {
            // The ticket exists; linking the contact is a convenience.
        }
    }

    private async contactFor(orgId: string, email: string, name: string): Promise<string> {
        const found = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM contacts WHERE organization_id = ${orgId}::uuid AND email = ${email}::citext LIMIT 1`;
        if (found[0]) return found[0].id;
        const made = await this.prisma.contacts.create({ data: { organization_id: orgId, name: (name || email.split("@")[0]).slice(0, 200), email }, select: { id: true } });
        return made.id;
    }

    private async createTicket(orgId: string, subject: string, description: string, contactId: string): Promise<{ id: string; number: number }> {
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const rows = await this.prisma.$queryRaw<{ id: string; n: bigint }[]>`
                  WITH next_num AS (SELECT COALESCE(MAX(t.ticket_number), 0) + 1 AS n FROM tickets t WHERE t.organization_id = ${orgId}::uuid)
                  INSERT INTO tickets (organization_id, ticket_number, subject, description, status, priority, requester_contact_id, created_at, updated_at)
                  SELECT ${orgId}::uuid, next_num.n, ${subject}::text, ${description}::text, 'open'::ticket_status, 'normal'::ticket_priority, ${contactId}::uuid, now(), now()
                  FROM next_num
                  RETURNING id::text AS id, ticket_number AS n`;
                void this.webhooks.emitTicket("ticket.created", rows[0].id, { source: "email" }, orgId);
                return { id: rows[0].id, number: Number(rows[0].n) };
            } catch (e: any) {
                if (e?.code === "P2010" && /23505|unique/i.test(String(e?.message)) && attempt < 4) continue;
                throw e;
            }
        }
        throw new Error("Could not number the new ticket.");
    }

    // ---- Sending mail -----------------------------------------------------------------------------------------

    /** Emails a reply to the person who asked. Never throws: the reply is already saved on the ticket. */
    async sendReply(orgId: string, ticketId: string, text: string, actor: string): Promise<{ sent: boolean; reason?: string; to?: string }> {
        try {
            const r = await this.prisma.support_mailbox.findUnique({ where: { organization_id: orgId } });
            const viaImap = r?.source === "imap";
            if (!r?.enabled || (!viaImap && !r.refresh_token)) return { sent: false, reason: "The support mailbox is not turned on, so nothing was emailed." };
            const t = await this.prisma.tickets.findFirst({ where: { id: ticketId, organization_id: orgId }, select: { id: true, ticket_number: true, subject: true, portal_account_id: true, requester_customer_contact_id: true, contacts: { select: { email: true } } } });
            let to = t?.contacts?.email?.trim().toLowerCase();
            // A contact chosen from the customer's own contact list wins over the mailbox's address book entry.
            if (t?.requester_customer_contact_id) {
                const cc = await this.prisma.customer_contacts.findUnique({ where: { id: t.requester_customer_contact_id }, select: { email: true } });
                if (cc?.email?.trim()) to = cc.email.trim().toLowerCase();
            }
            // A ticket opened in the client portal goes to the person who opened it, whatever other contact the ticket carries.
            if (t?.portal_account_id) {
                const a = await this.prisma.portal_accounts.findUnique({ where: { id: t.portal_account_id }, select: { email: true, status: true } });
                if (a && a.status !== "disabled") to = String(a.email).trim().toLowerCase();
            }
            // A ticket submitted from the tray app goes to the email address the person typed there, and shows in the tray window as well.
            const trayEmail = await this.prisma.$queryRaw<Array<{ requester_email: string | null }>>`SELECT requester_email FROM public.tray_help_requests WHERE ticket_id = ${ticketId}::uuid AND requester_email IS NOT NULL LIMIT 1`.catch(() => []);
            if (trayEmail[0]?.requester_email) to = trayEmail[0].requester_email.trim().toLowerCase();
            if (!t || !to) return { sent: false, reason: "This ticket has no requester with an email address, so nothing was emailed." };
            if (to === r.mailbox_address.toLowerCase()) return { sent: false, reason: "The requester is the support mailbox itself, so nothing was emailed." };

            const subject = replySubject(Number(t.ticket_number), t.subject);
            const message = `${text.trim()}\n\n${actor}`;
            if (viaImap) {
                // Replies go out through the SMTP login saved under the same Tickets purpose.
                const sent = await this.smtp.sendPlain("tickets", to, subject, message);
                if (!sent.ok) throw new Error(sent.result);
            } else {
                await this.ms.graphSendMail(await this.tokenFor(r, GRAPH_SEND_SCOPE), { to, subject, text: message });
            }
            const channelId = await this.ensureChannel(orgId);
            await this.prisma.email_messages.create({
                data: { channel_id: channelId, ticket_id: t.id, direction: "outbound", subject, from_address: r.mailbox_address, to_addresses: [to], sent_at: new Date(), payload: { kind: "reply" } },
            });
            // The ticket's history says exactly where the email went.
            await this.prisma.ticket_activity
                .create({ data: { id: randomUUID(), ticket_id: t.id, kind: "change", body: `Reply emailed to ${to}`, attachments: [], time_worked_seconds: 0, notify_customer: false, author: "Email", is_internal: true } })
                .catch(() => undefined);
            return { sent: true, to };
        } catch (e: any) {
            const reason = `The reply was saved but could not be emailed: ${String(e?.message ?? e).slice(0, 200)}`;
            await this.prisma.ticket_activity
                .create({ data: { id: randomUUID(), ticket_id: ticketId, kind: "change", body: reason, attachments: [], time_worked_seconds: 0, notify_customer: false, author: "Email", is_internal: true } })
                .catch(() => undefined);
            return { sent: false, reason };
        }
    }
}
