import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { safeAttachmentExtension } from "../common/upload-safety";
import { PrismaService } from "../storage/prisma.service";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import {
    FreshdeskClient,
    FreshdeskError,
    MAX_TEXT,
    STATUS_NAMES,
    freshdeskHost,
    mapPriority,
    mapStatus,
    minutesOf,
    safeName,
    textOf,
} from "./freshdesk";

const SOURCE = "freshdesk";
const MAX_ERRORS = 200;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type ImportOptions = { contacts: boolean; tickets: boolean; attachments: boolean; time: boolean };

type Progress = {
    phase: string;
    contacts: { done: number; skipped: number; failed: number };
    tickets: { total: number | null; done: number; skipped: number; failed: number };
    replies: number;
    notes: number;
    attachments: { saved: number; failed: number };
    time: { done: number; skipped: number };
};

const freshProgress = (): Progress => ({
    phase: "starting",
    contacts: { done: 0, skipped: 0, failed: 0 },
    tickets: { total: null, done: 0, skipped: 0, failed: 0 },
    replies: 0,
    notes: 0,
    attachments: { saved: 0, failed: 0 },
    time: { done: 0, skipped: 0 },
});

type Agent = { name: string; email: string; userId: string | null };
type ErrorItem = { kind: string; id: string; message: string };

type Ctx = {
    orgId: string;
    jobId: string;
    userId: string | null;
    client: FreshdeskClient;
    opts: ImportOptions;
    agents: Map<string, Agent>;
    companies: Map<string, { name: string; clientId: string | null }>;
    progress: Progress;
    errors: ErrorItem[];
    lastFlush: number;
};

export type JobView = {
    id: string;
    source: string;
    status: string;
    host: string;
    options: Partial<ImportOptions>;
    preview: unknown;
    progress: Progress | Record<string, never>;
    errors: ErrorItem[];
    message: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
};

const msg = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);

/**
 * Importing from Freshdesk: a preview first (what is there, what would match), then a run that brings in contacts,
 * tickets with every reply and private note, attachments and logged time. Everything imported is remembered, so
 * running it again skips what is already in, and a ticket is imported whole or not at all.
 */
@Injectable()
export class ImportsService implements OnModuleInit {
    private readonly log = new Logger(ImportsService.name);
    private readonly running = new Map<string, Promise<void>>();
    private readonly cancelled = new Set<string>();

    /** The calls that leave this server, kept together so tests can replace them. */
    makeClient = (host: string, apiKey: string) => new FreshdeskClient(`https://${host}/api/v2`, apiKey, { minDelayMs: 120 });
    /** Attachment files are only fetched over https. Tests turn this on to use a local server. */
    allowInsecureFiles = false;
    uploadDir = path.join(process.cwd(), "public", "uploads", "tickets");

    constructor(private readonly prisma: PrismaService) { }

    async onModuleInit() {
        // A restart stops a job where it was. What it already imported is remembered, so it can simply be run again.
        await this.prisma.import_jobs.updateMany({
            where: { status: { in: ["previewing", "running"] } },
            data: { status: "interrupted", message: "The server restarted during this import. Start a new preview and run it again: what was already imported is skipped.", finished_at: new Date(), updated_at: new Date() },
        }).catch(() => undefined);
    }

    /** Waits for a job's background work to finish (used by tests). */
    async waitFor(jobId: string) {
        await this.running.get(jobId);
    }

    // ---- Jobs -------------------------------------------------------------------------------------------------

    private view(j: any): JobView {
        return {
            id: j.id,
            source: j.source,
            status: j.status,
            host: String(j.config?.host ?? ""),
            options: j.options ?? {},
            preview: j.preview ?? null,
            progress: j.progress ?? {},
            errors: Array.isArray(j.errors) ? j.errors : [],
            message: j.message ?? null,
            createdAt: j.created_at.toISOString(),
            startedAt: j.started_at?.toISOString() ?? null,
            finishedAt: j.finished_at?.toISOString() ?? null,
        };
    }

    async list(orgId: string): Promise<JobView[]> {
        const rows = await this.prisma.import_jobs.findMany({ where: { organization_id: orgId }, orderBy: { created_at: "desc" }, take: 20 });
        return rows.map((r) => this.view(r));
    }

    async get(orgId: string, id: string): Promise<JobView> {
        return this.view(await this.find(orgId, id));
    }

    private async find(orgId: string, id: string) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Import not found");
        const j = await this.prisma.import_jobs.findFirst({ where: { id, organization_id: orgId } });
        if (!j) throw new NotFoundException("Import not found");
        return j;
    }

    private async anyActive(orgId: string): Promise<boolean> {
        return (await this.prisma.import_jobs.count({ where: { organization_id: orgId, status: { in: ["previewing", "running"] } } })) > 0;
    }

    private async setJob(id: string, data: Prisma.import_jobsUpdateInput) {
        await this.prisma.import_jobs.update({ where: { id }, data: { ...data, updated_at: new Date() } });
    }

    // ---- Preview ----------------------------------------------------------------------------------------------

    async startPreview(orgId: string, userId: string | null, input: { domain?: string; apiKey?: string }): Promise<{ id: string }> {
        let host: string;
        try {
            host = freshdeskHost(input.domain ?? "");
        } catch (e) {
            throw new BadRequestException(msg(e));
        }
        const apiKey = String(input.apiKey ?? "").trim();
        if (!apiKey) throw new BadRequestException("Enter the API key. In Freshdesk it is under your profile settings.");
        if (apiKey.length > 200) throw new BadRequestException("That API key is too long.");
        if (await this.anyActive(orgId)) throw new ConflictException("Another import is running. Wait for it to finish, or cancel it.");

        const job = await this.prisma.import_jobs.create({
            data: { organization_id: orgId, source: SOURCE, status: "previewing", config: { host, apiKey: encryptSecret(apiKey) }, created_by: userId },
        });
        this.running.set(job.id, this.runPreview(job.id, orgId).finally(() => this.running.delete(job.id)));
        return { id: job.id };
    }

    private async clientFor(job: { config: any }): Promise<FreshdeskClient> {
        return this.makeClient(String(job.config.host), decryptSecret(String(job.config.apiKey)));
    }

    private async loadAgents(client: FreshdeskClient, orgId: string): Promise<Map<string, Agent>> {
        const users = await this.prisma.$queryRaw<{ id: string; email: string }[]>`SELECT id::text AS id, lower(email::text) AS email FROM users WHERE organization_id = ${orgId}::uuid AND status = 'active'`;
        const byEmail = new Map(users.map((u) => [u.email, u.id]));
        const agents = new Map<string, Agent>();
        for await (const page of client.pages<any>("/agents")) {
            for (const a of page) {
                const email = String(a?.contact?.email ?? "").trim().toLowerCase();
                agents.set(String(a.id), { name: String(a?.contact?.name ?? email ?? "Freshdesk agent"), email, userId: byEmail.get(email) ?? null });
            }
        }
        return agents;
    }

    private async clientIdByName(orgId: string, name: string): Promise<string | null> {
        const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM clients WHERE organization_id = ${orgId}::uuid AND lower(name) = lower(${name}) LIMIT 1`;
        return rows[0]?.id ?? null;
    }

    private async runPreview(jobId: string, orgId: string) {
        try {
            const job = await this.prisma.import_jobs.findUniqueOrThrow({ where: { id: jobId } });
            const client = await this.clientFor(job);
            const agents = await this.loadAgents(client, orgId); // also proves the key works

            const matched = [...agents.values()].filter((a) => a.userId).length;
            const unmatchedAgents = [...agents.values()].filter((a) => !a.userId).map((a) => a.email || a.name).slice(0, 50);

            let companies = 0;
            const unmatchedCompanies: string[] = [];
            let matchedCompanies = 0;
            for await (const page of client.pages<any>("/companies")) {
                for (const c of page) {
                    companies++;
                    if (await this.clientIdByName(orgId, String(c.name ?? ""))) matchedCompanies++;
                    else if (unmatchedCompanies.length < 50) unmatchedCompanies.push(String(c.name ?? ""));
                }
            }

            let contacts = 0;
            for await (const page of client.pages<any>("/contacts")) contacts += page.length;

            const byStatus: Record<string, number> = {};
            let total = 0;
            let unknownStatus = 0;
            let already = 0;
            let first: string | null = null;
            let last: string | null = null;
            for await (const page of client.tickets()) {
                total += page.length;
                for (const t of page) {
                    const m = mapStatus(t.status);
                    if (!m.known) unknownStatus++;
                    const name = STATUS_NAMES[Number(t.status)] ?? `Custom status ${t.status}`;
                    byStatus[name] = (byStatus[name] ?? 0) + 1;
                    const c = String(t.created_at ?? "");
                    if (c && (!first || c < first)) first = c;
                    if (c && (!last || c > last)) last = c;
                }
                const ids = page.map((t) => String(t.id));
                already += (await this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM import_links WHERE organization_id = ${orgId}::uuid AND source = ${SOURCE} AND kind = 'ticket' AND external_id = ANY(${ids}::text[])`)[0].n;
                await this.setJob(jobId, { progress: { phase: "previewing", tickets: { total } } });
                if (this.cancelled.has(jobId)) throw new Error("Cancelled");
            }

            const preview = {
                agents: { total: agents.size, matched, unmatched: unmatchedAgents },
                companies: { total: companies, matched: matchedCompanies, unmatched: unmatchedCompanies },
                contacts: { total: contacts },
                tickets: { total, alreadyImported: already, byStatus, unknownStatus, firstCreatedAt: first, lastCreatedAt: last },
            };
            await this.setJob(jobId, { status: "previewed", preview: preview as Prisma.InputJsonValue, progress: {}, message: null });
        } catch (e) {
            await this.setJob(jobId, { status: "failed", message: msg(e), finished_at: new Date() }).catch(() => undefined);
            await this.dropKey(jobId);
        }
    }

    /** Once a job has ended, the API key is not kept. */
    private async dropKey(jobId: string) {
        await this.prisma.$executeRaw`UPDATE import_jobs SET config = config - 'apiKey' WHERE id = ${jobId}::uuid`.catch(() => undefined);
    }

    // ---- Run --------------------------------------------------------------------------------------------------

    async startRun(orgId: string, userId: string | null, jobId: string, input: Partial<ImportOptions>): Promise<JobView> {
        const job = await this.find(orgId, jobId);
        if (job.status !== "previewed") throw new ConflictException("Preview first, then start the import from that preview.");
        if (!(job.config as any)?.apiKey) throw new ConflictException("The API key is no longer kept. Start a new preview.");
        const opts: ImportOptions = {
            contacts: input.contacts !== false,
            tickets: input.tickets !== false,
            attachments: input.attachments !== false,
            time: input.time !== false,
        };
        if (!opts.contacts && !opts.tickets) throw new BadRequestException("Choose something to import.");
        if (await this.anyActive(orgId)) throw new ConflictException("Another import is running.");

        await this.setJob(jobId, { status: "running", options: opts as Prisma.InputJsonValue, progress: freshProgress() as unknown as Prisma.InputJsonValue, errors: [], started_at: new Date(), message: null, created_by: userId ?? job.created_by });
        this.cancelled.delete(jobId);
        this.running.set(jobId, this.runImport(jobId, orgId, userId ?? job.created_by, opts).finally(() => this.running.delete(jobId)));
        return this.get(orgId, jobId);
    }

    async cancel(orgId: string, jobId: string): Promise<JobView> {
        const job = await this.find(orgId, jobId);
        if (!["running", "previewing"].includes(job.status)) throw new ConflictException("That import is not running.");
        this.cancelled.add(jobId);
        if (!this.running.has(jobId)) {
            await this.setJob(jobId, { status: "cancelled", finished_at: new Date(), message: "Cancelled." });
            await this.dropKey(jobId);
        }
        return this.get(orgId, jobId);
    }

    private async flush(ctx: Ctx, force = false) {
        if (!force && Date.now() - ctx.lastFlush < 1500) return;
        ctx.lastFlush = Date.now();
        await this.setJob(ctx.jobId, { progress: ctx.progress as unknown as Prisma.InputJsonValue, errors: ctx.errors as unknown as Prisma.InputJsonValue }).catch(() => undefined);
    }

    private noteError(ctx: Ctx, kind: string, id: string, message: string) {
        if (ctx.errors.length < MAX_ERRORS) ctx.errors.push({ kind, id, message: message.slice(0, 300) });
    }

    private async runImport(jobId: string, orgId: string, userId: string | null, opts: ImportOptions) {
        let ctx: Ctx | null = null;
        try {
            const job = await this.prisma.import_jobs.findUniqueOrThrow({ where: { id: jobId } });
            const client = await this.clientFor(job);
            ctx = { orgId, jobId, userId, client, opts, agents: new Map(), companies: new Map(), progress: freshProgress(), errors: [], lastFlush: 0 };
            ctx.progress.tickets.total = Number((job.preview as any)?.tickets?.total) || null;

            ctx.progress.phase = "people";
            await this.flush(ctx, true);
            ctx.agents = await this.loadAgents(client, orgId);

            if (opts.contacts) await this.importContacts(ctx);
            if (opts.tickets && !this.cancelled.has(jobId)) await this.importTickets(ctx);

            const cancelled = this.cancelled.has(jobId);
            ctx.progress.phase = cancelled ? "cancelled" : "done";
            await this.flush(ctx, true);
            await this.setJob(jobId, { status: cancelled ? "cancelled" : "completed", finished_at: new Date(), message: cancelled ? "Cancelled. What was imported so far is kept, and running it again skips it." : null });
        } catch (e) {
            if (ctx) await this.flush(ctx, true);
            await this.setJob(jobId, { status: "failed", finished_at: new Date(), message: msg(e) }).catch(() => undefined);
        } finally {
            this.cancelled.delete(jobId);
            await this.dropKey(jobId);
        }
    }

    // ---- Links ------------------------------------------------------------------------------------------------

    private async linked(orgId: string, kind: string, externalId: string): Promise<string | null | undefined> {
        const r = await this.prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: orgId, source: SOURCE, kind, external_id: externalId } } });
        return r ? r.local_id : undefined;
    }

    private link(orgId: string, kind: string, externalId: string, localId: string | null) {
        return this.prisma.import_links.upsert({
            where: { organization_id_source_kind_external_id: { organization_id: orgId, source: SOURCE, kind, external_id: externalId } },
            create: { organization_id: orgId, source: SOURCE, kind, external_id: externalId, local_id: localId },
            update: {},
        });
    }

    // ---- Contacts and companies ---------------------------------------------------------------------------------

    private async importContacts(ctx: Ctx) {
        ctx.progress.phase = "contacts";
        for await (const page of ctx.client.pages<any>("/companies")) {
            for (const c of page) {
                const clientId = await this.clientIdByName(ctx.orgId, String(c.name ?? ""));
                ctx.companies.set(String(c.id), { name: String(c.name ?? ""), clientId });
            }
        }
        for await (const page of ctx.client.pages<any>("/contacts")) {
            for (const c of page) {
                if (this.cancelled.has(ctx.jobId)) return;
                try {
                    const before = await this.linked(ctx.orgId, "contact", String(c.id));
                    if (before !== undefined) ctx.progress.contacts.skipped++;
                    else {
                        await this.ensureContact(ctx, c);
                        ctx.progress.contacts.done++;
                    }
                } catch (e) {
                    ctx.progress.contacts.failed++;
                    this.noteError(ctx, "contact", String(c?.id), msg(e));
                }
                await this.flush(ctx);
            }
        }
    }

    /** The contact for a Freshdesk person: remembered, else found by email, else created. */
    private async ensureContact(ctx: Ctx, c: { id: unknown; name?: unknown; email?: unknown; phone?: unknown; mobile?: unknown; company_id?: unknown }): Promise<string> {
        const known = await this.linked(ctx.orgId, "contact", String(c.id));
        if (known) return known;

        const email = String(c.email ?? "").trim().toLowerCase();
        const validEmail = /^[^\s@]+@[^\s@]+$/.test(email) ? email : "";
        const name = (String(c.name ?? "").trim() || validEmail || `Freshdesk contact ${c.id}`).slice(0, 200);
        const phone = String(c.phone ?? c.mobile ?? "").trim().slice(0, 60) || null;
        const company = c.company_id != null ? ctx.companies.get(String(c.company_id)) : undefined;

        let id: string | null = null;
        if (validEmail) {
            const found = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM contacts WHERE organization_id = ${ctx.orgId}::uuid AND email = ${validEmail}::citext LIMIT 1`;
            id = found[0]?.id ?? null;
        }
        if (!id) {
            const metadata = { importedFrom: SOURCE, externalId: String(c.id), ...(company?.name ? { company: company.name } : {}) };
            id = (await this.prisma.contacts.create({ data: { organization_id: ctx.orgId, name, email: validEmail || null, phone, metadata }, select: { id: true } })).id;
        }
        // A company that matches one of your customers also gets the person listed as a contact there.
        if (company?.clientId && validEmail) {
            const dup = await this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM customer_contacts WHERE client_id = ${company.clientId}::uuid AND lower(email) = ${validEmail}`;
            if (dup[0].n === 0) await this.prisma.customer_contacts.create({ data: { client_id: company.clientId, name, email: validEmail, phone } });
        }
        await this.link(ctx.orgId, "contact", String(c.id), id);
        return id;
    }

    // ---- Tickets ----------------------------------------------------------------------------------------------

    private async importTickets(ctx: Ctx) {
        ctx.progress.phase = "tickets";
        for await (const page of ctx.client.tickets({ include: "requester,stats" })) {
            for (const t of page) {
                if (this.cancelled.has(ctx.jobId)) return;
                try {
                    if ((await this.linked(ctx.orgId, "ticket", String(t.id))) !== undefined) ctx.progress.tickets.skipped++;
                    else {
                        await this.importTicket(ctx, t);
                        ctx.progress.tickets.done++;
                    }
                } catch (e) {
                    if (e instanceof FreshdeskError && e.fatal) throw e;
                    ctx.progress.tickets.failed++;
                    this.noteError(ctx, "ticket", String(t?.id), msg(e));
                }
                await this.flush(ctx);
            }
        }
    }

    private agentName(ctx: Ctx, id: unknown): string {
        return ctx.agents.get(String(id))?.name || "Freshdesk agent";
    }

    /** Downloads a ticket or reply's files into this server's storage. Returns what could be kept, and notes what could not. */
    private async saveFiles(ctx: Ctx, files: any[] | undefined, saved: string[]): Promise<{ id: string; name: string; size: number; url: string }[]> {
        const out: { id: string; name: string; size: number; url: string }[] = [];
        if (!ctx.opts.attachments || !Array.isArray(files)) return out;
        for (const f of files) {
            const name = safeName(f?.name);
            try {
                const src = new URL(String(f?.attachment_url ?? ""));
                if (src.protocol !== "https:" && !(this.allowInsecureFiles && src.protocol === "http:")) throw new Error("not an https address");
                if (Number(f?.size) > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
                const res = await fetch(src, { signal: AbortSignal.timeout(60_000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
                const file = `${randomUUID()}${safeAttachmentExtension(name)}`;
                fs.mkdirSync(this.uploadDir, { recursive: true });
                fs.writeFileSync(path.join(this.uploadDir, file), buf);
                saved.push(path.join(this.uploadDir, file));
                out.push({ id: randomUUID(), name, size: buf.length, url: `/static/uploads/tickets/${file}` });
                ctx.progress.attachments.saved++;
            } catch (e) {
                ctx.progress.attachments.failed++;
                this.noteError(ctx, "attachment", `${f?.id ?? name}`, `${name}: ${msg(e)}`);
            }
        }
        return out;
    }

    private async importTicket(ctx: Ctx, t: any) {
        const externalId = String(t.id);
        const saved: string[] = [];
        try {
            // Everything is read first, so a ticket that cannot be read completely is not half imported.
            const conversations: any[] = [];
            for await (const page of ctx.client.pages<any>(`/tickets/${externalId}/conversations`)) conversations.push(...page);
            let times: any[] = [];
            if (ctx.opts.time) {
                try {
                    const r = await ctx.client.get<any[]>(`/tickets/${externalId}/time_entries`);
                    times = Array.isArray(r) ? r : [];
                } catch (e) {
                    // Time tracking can be off for the account; that is not a reason to skip the ticket.
                    if (!(e instanceof FreshdeskError) || e.status === 401) throw e;
                }
            }

            const requester = t.requester && t.requester.id != null ? t.requester : t.requester_id != null ? { id: t.requester_id } : null;
            const requesterName = String(t.requester?.name ?? t.requester?.email ?? "Requester");
            const requesterContactId = requester ? await this.ensureContact(ctx, requester) : null;

            const ticketFiles = await this.saveFiles(ctx, t.attachments, saved);
            const replyFiles = new Map<string, { id: string; name: string; size: number; url: string }[]>();
            for (const c of conversations) replyFiles.set(String(c.id), await this.saveFiles(ctx, c.attachments, saved));

            const { status } = mapStatus(t.status);
            const closedAt = status === "closed" || status === "resolved" ? t.stats?.closed_at ?? t.stats?.resolved_at ?? t.updated_at ?? null : null;
            const created = String(t.created_at ?? new Date().toISOString());
            const updated = String(t.updated_at ?? created);
            const assignee = t.responder_id != null ? ctx.agents.get(String(t.responder_id))?.userId ?? null : null;
            const subject = String(t.subject ?? "").trim().slice(0, 300) || "(no subject)";
            const description = textOf(t) || null;
            const priority = mapPriority(t.priority);
            const dueAt = t.due_by ?? null;

            let ticketId = "";
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    ticketId = await this.prisma.$transaction(async (tx) => {
                        const rows = await tx.$queryRaw<{ id: string }[]>`
                          WITH next_num AS (SELECT COALESCE(MAX(x.ticket_number), 0) + 1 AS n FROM tickets x WHERE x.organization_id = ${ctx.orgId}::uuid)
                          INSERT INTO tickets (organization_id, ticket_number, subject, description, status, priority, assignee_user_id, requester_contact_id, created_at, updated_at, closed_at, due_at)
                          SELECT ${ctx.orgId}::uuid, next_num.n, ${subject}::text, ${description}::text, ${status}::ticket_status, ${priority}::ticket_priority,
                                 ${assignee}::uuid, ${requesterContactId}::uuid, ${created}::timestamptz, ${updated}::timestamptz, ${closedAt}::timestamptz, ${dueAt}::timestamptz
                          FROM next_num RETURNING id::text AS id`;
                        const id = rows[0].id;

                        const tags = Array.isArray(t.tags) ? [...new Set(t.tags.map((x: unknown) => String(x).trim().slice(0, 60)).filter(Boolean))] : [];
                        if (tags.length) await tx.ticket_tags.createMany({ data: tags.map((tag) => ({ ticket_id: id, tag: tag as string })), skipDuplicates: true });

                        const activity: Prisma.ticket_activityCreateManyInput[] = [];
                        const ids: { ext: string; local: string }[] = [];
                        activity.push({ id: randomUUID(), ticket_id: id, kind: "change", body: `Imported from Freshdesk (ticket #${externalId})`, attachments: [], time_worked_seconds: 0, notify_customer: false, author: "Import", is_internal: true, created_at: new Date() });
                        if (ticketFiles.length) {
                            activity.push({ id: randomUUID(), ticket_id: id, kind: "note", body: "Files attached to the original request", attachments: ticketFiles as unknown as Prisma.InputJsonValue, time_worked_seconds: 0, notify_customer: false, author: "Import", is_internal: true, created_at: new Date(created) });
                        }
                        for (const c of conversations) {
                            const isPrivate = c.private === true;
                            const incoming = c.incoming === true;
                            const local = randomUUID();
                            ids.push({ ext: String(c.id), local });
                            activity.push({
                                id: local,
                                ticket_id: id,
                                kind: isPrivate ? "note" : "message",
                                body: textOf(c) || "(no text)",
                                attachments: (replyFiles.get(String(c.id)) ?? []) as unknown as Prisma.InputJsonValue,
                                time_worked_seconds: 0,
                                notify_customer: false,
                                author: incoming ? requesterName : this.agentName(ctx, c.user_id),
                                is_internal: isPrivate,
                                is_inbound: incoming && !isPrivate,
                                created_at: new Date(String(c.created_at ?? created)),
                            });
                        }
                        await tx.ticket_activity.createMany({ data: activity });

                        let timeDone = 0;
                        let timeSkipped = 0;
                        const timeLinks: { ext: string; local: string }[] = [];
                        for (const te of times) {
                            const minutes = minutesOf(te.time_spent);
                            const agent = ctx.agents.get(String(te.agent_id));
                            const who = agent?.userId ?? ctx.userId;
                            if (minutes <= 0 || !who) { timeSkipped++; continue; }
                            const local = randomUUID();
                            await tx.time_entries.create({
                                data: {
                                    id: local,
                                    organization_id: ctx.orgId,
                                    user_id: who,
                                    ticket_id: id,
                                    work_date: new Date(String(te.executed_at ?? te.start_time ?? created).slice(0, 10)),
                                    minutes,
                                    billable: te.billable !== false,
                                    note: [te.note ? String(te.note).slice(0, 1000) : "", agent?.userId ? "" : `Freshdesk agent: ${agent?.name ?? te.agent_id}`].filter(Boolean).join(" - ") || null,
                                    // Kept for the record on the ticket. Not "approved", so it is never put on an invoice.
                                    status: "imported",
                                },
                            });
                            timeLinks.push({ ext: String(te.id), local });
                            timeDone++;
                        }

                        await tx.import_links.createMany({
                            data: [
                                { organization_id: ctx.orgId, source: SOURCE, kind: "ticket", external_id: externalId, local_id: id },
                                ...ids.map((x) => ({ organization_id: ctx.orgId, source: SOURCE, kind: "conversation", external_id: x.ext, local_id: x.local })),
                                ...timeLinks.map((x) => ({ organization_id: ctx.orgId, source: SOURCE, kind: "time_entry", external_id: x.ext, local_id: x.local })),
                            ],
                            skipDuplicates: true,
                        });
                        ctx.progress.replies += conversations.filter((c) => c.private !== true).length;
                        ctx.progress.notes += conversations.filter((c) => c.private === true).length;
                        ctx.progress.time.done += timeDone;
                        ctx.progress.time.skipped += timeSkipped;
                        return id;
                    }, { timeout: 60_000, maxWait: 15_000 });
                    break;
                } catch (e: any) {
                    // Two tickets numbered at once: try again with the next number.
                    if (e?.code === "P2010" && /23505|unique/i.test(String(e?.message)) && attempt < 4) continue;
                    throw e;
                }
            }
            return ticketId;
        } catch (e) {
            for (const f of saved) fs.rmSync(f, { force: true });
            throw e;
        }
    }
}
