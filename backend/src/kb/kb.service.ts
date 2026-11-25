// Internal knowledge base: articles with history, categories, full-text search, feedback and links to tickets.
// This is the help desk's own how-to library; customer documentation lives in the separate docs app.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TITLE = 200;
export const MAX_BODY = 100_000;
const MAX_TAGS = 10;
const STOP = new Set("the and for are but not you your with this that have from was were been will can cant cannot does did how why what when where who please help need issue problem error unable working work doesnt dont".split(" "));

export type KbActor = { orgId: string; userId: string | null; canWrite: boolean };
export type KbPortalActor = { orgId: string; accountId: string };

// One expression, used by both the index and every query, so the GIN index is the one searched.
const DOC = Prisma.sql`(setweight(to_tsvector('english', coalesce(a.title, '')), 'A') || setweight(to_tsvector('english', kb_tags_text(a.tags)), 'B') || setweight(to_tsvector('english', coalesce(a.body, '')), 'C'))`;

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function cleanTags(input: unknown): string[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw new BadRequestException("Tags must be a list.");
    const out: string[] = [];
    for (const t of input) {
        const s = String(t ?? "").trim().toLowerCase().replace(/\s+/g, "-");
        if (!s) continue;
        if (s.length > 40) throw new BadRequestException("A tag can be at most 40 characters.");
        if (!out.includes(s)) out.push(s);
    }
    if (out.length > MAX_TAGS) throw new BadRequestException(`An article can have at most ${MAX_TAGS} tags.`);
    return out;
}

/** Words of a ticket subject worth searching for, safe to put into a tsquery. */
export function keywordsOf(subject: string): string[] {
    const words = subject.toLowerCase().match(/[a-z0-9]{3,30}/g) ?? [];
    return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 8);
}

/** A search box entry as a prefix query on every word ("print spool" -> print:* & spool:*), safe for to_tsquery. */
export function searchQuery(q: string): string | null {
    const words = (q.toLowerCase().match(/[a-z0-9]{1,40}/g) ?? []).slice(0, 8);
    return words.length ? words.map((w) => `${w}:*`).join(" & ") : null;
}

type Row = {
    id: string; title: string; body: string; tags: string[]; status: string; customer_visible: boolean; version: number;
    view_count: number; helpful_count: number; unhelpful_count: number; created_at: Date; updated_at: Date; published_at: Date | null;
    category_id: string | null; category_name: string | null; author_id: string | null; author_name: string | null; updater_name: string | null;
    snippet?: string | null; rank?: number | null;
};

@Injectable()
export class KbService {
    constructor(private readonly prisma: PrismaService) { }

    private shape(r: Row, withBody: boolean) {
        return {
            id: r.id,
            title: r.title,
            ...(withBody ? { body: r.body } : { excerpt: r.snippet ?? r.body.replace(/[#*_`>\[\]]/g, "").slice(0, 200) }),
            tags: r.tags,
            status: r.status,
            customerVisible: r.customer_visible,
            version: r.version,
            viewCount: r.view_count,
            helpful: r.helpful_count,
            unhelpful: r.unhelpful_count,
            category: r.category_id ? { id: r.category_id, name: r.category_name } : null,
            author: r.author_id ? { id: r.author_id, name: r.author_name } : null,
            updatedBy: r.updater_name,
            createdAt: r.created_at.toISOString(),
            updatedAt: r.updated_at.toISOString(),
            publishedAt: r.published_at ? r.published_at.toISOString() : null,
        };
    }

    private select(extra: Prisma.Sql = Prisma.empty) {
        return Prisma.sql`SELECT a.id::text, a.title, a.body, a.tags, a.status, a.customer_visible, a.version, a.view_count, a.helpful_count, a.unhelpful_count,
                 a.created_at, a.updated_at, a.published_at, a.category_id::text, c.name AS category_name,
                 a.author_user_id::text AS author_id, nullif(trim(coalesce(au.first_name, '') || ' ' || coalesce(au.last_name, '')), '') AS author_name,
                 nullif(trim(coalesce(uu.first_name, '') || ' ' || coalesce(uu.last_name, '')), '') AS updater_name ${extra}
            FROM kb_articles a
            LEFT JOIN kb_categories c ON c.id = a.category_id
            LEFT JOIN users au ON au.id = a.author_user_id
            LEFT JOIN users uu ON uu.id = a.updated_by`;
    }

    /* ------------------------------ reading ------------------------------ */

    /** Who may see which: writers see drafts, everyone else only published articles. */
    private staffVisible(actor: KbActor): Prisma.Sql {
        return actor.canWrite ? Prisma.sql`a.organization_id = ${actor.orgId}::uuid` : Prisma.sql`a.organization_id = ${actor.orgId}::uuid AND a.status = 'published'`;
    }

    async list(actor: KbActor, f: { q?: string; category?: string; tag?: string; status?: string; limit?: number; offset?: number }) {
        const where: Prisma.Sql[] = [this.staffVisible(actor)];
        if (f.category === "none") where.push(Prisma.sql`a.category_id IS NULL`);
        else if (f.category) {
            if (!isUuid(f.category)) return { items: [], total: 0 };
            where.push(Prisma.sql`a.category_id = ${f.category}::uuid`);
        }
        if (f.tag) where.push(Prisma.sql`${String(f.tag).toLowerCase().slice(0, 40)} = ANY (a.tags)`);
        if (f.status === "draft" || f.status === "published") where.push(Prisma.sql`a.status = ${f.status}`);
        const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 100);
        const offset = Math.max(Number(f.offset) || 0, 0);
        return this.run(where, f.q, limit, offset, false);
    }

    private async run(where: Prisma.Sql[], q: string | undefined, limit: number, offset: number, portal: boolean) {
        const tsq = q ? searchQuery(String(q)) : null;
        let rows: Row[];
        let total: number;
        if (tsq) {
            const like = `%${String(q).trim().slice(0, 100).replace(/[\\%_]/g, "\\$&")}%`;
            const match = Prisma.sql`(${DOC} @@ to_tsquery('english', ${tsq}) OR a.title ILIKE ${like})`;
            const w = Prisma.join([...where, match], " AND ");
            const rank = Prisma.sql`, ts_rank(${DOC}, to_tsquery('english', ${tsq})) + (CASE WHEN a.title ILIKE ${like} THEN 1 ELSE 0 END) AS rank,
                ts_headline('english', a.body, to_tsquery('english', ${tsq}), 'StartSel=<<, StopSel=>>, MaxWords=30, MinWords=12') AS snippet`;
            rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${this.select(rank)} WHERE ${w} ORDER BY rank DESC, a.updated_at DESC LIMIT ${limit} OFFSET ${offset}`);
            total = (await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM kb_articles a WHERE ${w}`))[0].n;
        } else {
            const w = Prisma.join(where, " AND ");
            rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${this.select()} WHERE ${w} ORDER BY a.updated_at DESC LIMIT ${limit} OFFSET ${offset}`);
            total = (await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM kb_articles a WHERE ${w}`))[0].n;
        }
        // The headline marks matches with << >> so the page can highlight them without trusting any HTML.
        if (portal) {
            return { items: rows.map((r) => ({ id: r.id, title: r.title, excerpt: r.snippet ?? r.body.replace(/[#*_`>\[\]]/g, "").slice(0, 200), tags: r.tags, category: r.category_id ? { id: r.category_id, name: r.category_name } : null, updatedAt: r.updated_at.toISOString() })), total };
        }
        return { items: rows.map((r) => this.shape(r, false)), total };
    }

    private async one(actor: KbActor, id: string): Promise<Row> {
        if (!isUuid(id)) throw new NotFoundException("Article not found");
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${this.select()} WHERE a.id = ${id}::uuid AND ${this.staffVisible(actor)}`);
        if (!rows[0]) throw new NotFoundException("Article not found");
        return rows[0];
    }

    async get(actor: KbActor, id: string, countView: boolean) {
        const r = await this.one(actor, id);
        if (countView) {
            await this.prisma.kb_articles.update({ where: { id }, data: { view_count: { increment: 1 } } });
            r.view_count += 1;
        }
        const vote = actor.userId ? await this.prisma.kb_feedback.findUnique({ where: { article_id_voter_key: { article_id: id, voter_key: `u:${actor.userId}` } }, select: { helpful: true } }) : null;
        const links = await this.prisma.kb_ticket_links.count({ where: { article_id: id } });
        return { ...this.shape(r, true), myVote: vote ? (vote.helpful ? "helpful" : "unhelpful") : null, linkedTickets: links };
    }

    /* ------------------------------ writing ------------------------------ */

    private async category(orgId: string, id: unknown): Promise<string | null> {
        if (id === undefined || id === null || id === "") return null;
        if (!isUuid(id)) throw new BadRequestException("That category does not exist.");
        const c = await this.prisma.kb_categories.findFirst({ where: { id, organization_id: orgId }, select: { id: true } });
        if (!c) throw new BadRequestException("That category does not exist.");
        return c.id;
    }

    private fields(b: any, partial: boolean) {
        const out: { title?: string; body?: string; tags?: string[]; status?: string; customer_visible?: boolean } = {};
        if (!partial || b.title !== undefined) {
            const t = String(b.title ?? "").trim();
            if (!t) throw new BadRequestException("The article needs a title.");
            if (t.length > MAX_TITLE) throw new BadRequestException(`The title can be at most ${MAX_TITLE} characters.`);
            out.title = t;
        }
        if (b.body !== undefined) {
            const body = String(b.body ?? "");
            if (body.length > MAX_BODY) throw new BadRequestException(`The article can be at most ${MAX_BODY} characters.`);
            out.body = body;
        }
        if (b.tags !== undefined) out.tags = cleanTags(b.tags);
        if (b.status !== undefined) {
            if (b.status !== "draft" && b.status !== "published") throw new BadRequestException("The status is draft or published.");
            out.status = b.status;
        }
        if (b.customerVisible !== undefined) out.customer_visible = b.customerVisible === true;
        return out;
    }

    async create(actor: KbActor, b: any) {
        const f = this.fields(b ?? {}, false);
        const categoryId = await this.category(actor.orgId, b?.categoryId);
        const status = f.status ?? "draft";
        const a = await this.prisma.$transaction(async (tx) => {
            const row = await tx.kb_articles.create({
                data: {
                    organization_id: actor.orgId, category_id: categoryId, title: f.title!, body: f.body ?? "", tags: f.tags ?? [], status,
                    customer_visible: f.customer_visible ?? false, author_user_id: actor.userId, updated_by: actor.userId, published_at: status === "published" ? new Date() : null,
                },
            });
            await tx.kb_article_versions.create({ data: { article_id: row.id, version: 1, title: row.title, body: row.body, tags: row.tags, saved_by: actor.userId, note: "Created" } });
            return row;
        });
        return { id: a.id, title: a.title };
    }

    async update(actor: KbActor, id: string, b: any) {
        const cur = await this.one(actor, id);
        const f = this.fields(b ?? {}, true);
        const data: Prisma.kb_articlesUncheckedUpdateInput = { updated_by: actor.userId, updated_at: new Date() };
        if (f.title !== undefined) data.title = f.title;
        if (f.body !== undefined) data.body = f.body;
        if (f.tags !== undefined) data.tags = f.tags;
        if (f.customer_visible !== undefined) data.customer_visible = f.customer_visible;
        if (f.status !== undefined) {
            data.status = f.status;
            if (f.status === "published" && cur.status !== "published") data.published_at = new Date();
        }
        if (b?.categoryId !== undefined) data.category_id = await this.category(actor.orgId, b.categoryId);
        const contentChanged = (f.title !== undefined && f.title !== cur.title) || (f.body !== undefined && f.body !== cur.body) || (f.tags !== undefined && f.tags.join("\n") !== cur.tags.join("\n"));
        await this.prisma.$transaction(async (tx) => {
            // The version number is claimed by the update itself, so two editors saving at once get two versions.
            if (contentChanged) data.version = { increment: 1 };
            const row = await tx.kb_articles.update({ where: { id }, data });
            if (contentChanged) {
                await tx.kb_article_versions.create({
                    data: { article_id: id, version: row.version, title: row.title, body: row.body, tags: row.tags, saved_by: actor.userId, note: typeof b?.note === "string" ? b.note.trim().slice(0, 200) || null : null },
                });
            }
        });
        return { ok: true };
    }

    async remove(actor: KbActor, id: string) {
        await this.one(actor, id);
        await this.prisma.kb_articles.delete({ where: { id } });
        return { ok: true };
    }

    async versions(actor: KbActor, id: string) {
        await this.one(actor, id);
        const rows = await this.prisma.$queryRaw<{ version: number; title: string; saved_at: Date; note: string | null; who: string | null; current: boolean }[]>`
            SELECT v.version, v.title, v.saved_at, v.note, nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS who, v.version = a.version AS current
              FROM kb_article_versions v JOIN kb_articles a ON a.id = v.article_id LEFT JOIN users u ON u.id = v.saved_by
             WHERE v.article_id = ${id}::uuid ORDER BY v.version DESC`;
        return rows.map((r) => ({ version: r.version, title: r.title, savedAt: r.saved_at.toISOString(), note: r.note, savedBy: r.who, current: r.current }));
    }

    async version(actor: KbActor, id: string, version: number) {
        await this.one(actor, id);
        if (!Number.isInteger(version) || version < 1) throw new NotFoundException("Version not found");
        const v = await this.prisma.kb_article_versions.findUnique({ where: { article_id_version: { article_id: id, version } } });
        if (!v) throw new NotFoundException("Version not found");
        return { version: v.version, title: v.title, body: v.body, tags: v.tags, savedAt: v.saved_at.toISOString(), note: v.note };
    }

    /** Puts an older version back as a new version, so nothing in the history is lost. */
    async restore(actor: KbActor, id: string, version: number) {
        const v = await this.version(actor, id, version);
        await this.update(actor, id, { title: v.title, body: v.body, tags: v.tags, note: `Restored from version ${version}` });
        return { ok: true, restoredFrom: version };
    }

    /* ----------------------------- categories ----------------------------- */

    async categories(orgId: string, portal = false) {
        const rows = await this.prisma.$queryRaw<{ id: string; name: string; sort_order: number; n: number }[]>`
            SELECT c.id::text, c.name, c.sort_order,
                   (SELECT count(*)::int FROM kb_articles a WHERE a.category_id = c.id AND a.status = 'published' ${portal ? Prisma.sql`AND a.customer_visible` : Prisma.empty}) AS n
              FROM kb_categories c WHERE c.organization_id = ${orgId}::uuid ORDER BY c.sort_order, lower(c.name)`;
        return rows.filter((r) => !portal || r.n > 0).map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, articles: r.n }));
    }

    private catName(v: unknown): string {
        const n = String(v ?? "").trim();
        if (!n) throw new BadRequestException("The category needs a name.");
        if (n.length > 80) throw new BadRequestException("The name can be at most 80 characters.");
        return n;
    }

    private dup(e: any): boolean {
        return e?.code === "P2002" || /kb_categories_name_uq/.test(String(e?.message));
    }

    async createCategory(orgId: string, b: any) {
        try {
            const c = await this.prisma.kb_categories.create({ data: { organization_id: orgId, name: this.catName(b?.name), sort_order: Number.isInteger(b?.sortOrder) ? b.sortOrder : 0 } });
            return { id: c.id, name: c.name };
        } catch (e: any) {
            if (this.dup(e)) throw new ConflictException("A category with that name already exists.");
            throw e;
        }
    }

    async updateCategory(orgId: string, id: string, b: any) {
        if (!isUuid(id)) throw new NotFoundException("Category not found");
        const data: { name?: string; sort_order?: number } = {};
        if (b?.name !== undefined) data.name = this.catName(b.name);
        if (Number.isInteger(b?.sortOrder)) data.sort_order = b.sortOrder;
        let count = 0;
        try {
            count = (await this.prisma.kb_categories.updateMany({ where: { id, organization_id: orgId }, data })).count;
        } catch (e: any) {
            if (this.dup(e)) throw new ConflictException("A category with that name already exists.");
            throw e;
        }
        if (!count) throw new NotFoundException("Category not found");
        return { ok: true };
    }

    async deleteCategory(orgId: string, id: string) {
        if (!isUuid(id)) throw new NotFoundException("Category not found");
        const r = await this.prisma.kb_categories.deleteMany({ where: { id, organization_id: orgId } });
        if (!r.count) throw new NotFoundException("Category not found");
        return { ok: true };
    }

    async tags(actor: KbActor) {
        return this.prisma.$queryRaw<{ tag: string; n: number }[]>`
            SELECT t AS tag, count(*)::int AS n FROM kb_articles a, unnest(a.tags) t WHERE ${this.staffVisible(actor)} GROUP BY t ORDER BY n DESC, t LIMIT 100`;
    }

    /* ------------------------ feedback and tickets ------------------------ */

    private async vote(articleId: string, voterKey: string, helpful: unknown) {
        if (typeof helpful !== "boolean") throw new BadRequestException("Say whether the article was helpful.");
        await this.prisma.$transaction(async (tx) => {
            await tx.kb_feedback.upsert({
                where: { article_id_voter_key: { article_id: articleId, voter_key: voterKey } },
                create: { article_id: articleId, voter_key: voterKey, helpful },
                update: { helpful, created_at: new Date() },
            });
            // Counts are recomputed from the votes, so a changed vote cannot drift them.
            const [h, u] = await Promise.all([tx.kb_feedback.count({ where: { article_id: articleId, helpful: true } }), tx.kb_feedback.count({ where: { article_id: articleId, helpful: false } })]);
            await tx.kb_articles.update({ where: { id: articleId }, data: { helpful_count: h, unhelpful_count: u } });
        });
        const a = await this.prisma.kb_articles.findUnique({ where: { id: articleId }, select: { helpful_count: true, unhelpful_count: true } });
        return { helpful: a?.helpful_count ?? 0, unhelpful: a?.unhelpful_count ?? 0, myVote: helpful ? "helpful" : "unhelpful" };
    }

    async feedback(actor: KbActor, id: string, helpful: unknown) {
        await this.one(actor, id);
        if (!actor.userId) throw new BadRequestException("Sign in first.");
        return this.vote(id, `u:${actor.userId}`, helpful);
    }

    private async ticketOk(orgId: string, ticketId: string) {
        if (!isUuid(ticketId)) throw new NotFoundException("Ticket not found");
        const t = await this.prisma.tickets.findFirst({ where: { id: ticketId, organization_id: orgId }, select: { id: true, subject: true } });
        if (!t) throw new NotFoundException("Ticket not found");
        return t;
    }

    async ticketLinks(actor: KbActor, ticketId: string) {
        await this.ticketOk(actor.orgId, ticketId);
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${this.select()} JOIN kb_ticket_links l ON l.article_id = a.id AND l.ticket_id = ${ticketId}::uuid WHERE ${this.staffVisible(actor)} ORDER BY l.created_at DESC`);
        return rows.map((r) => this.shape(r, false));
    }

    async linkTicket(actor: KbActor, ticketId: string, articleId: unknown) {
        await this.ticketOk(actor.orgId, ticketId);
        if (!isUuid(articleId)) throw new BadRequestException("Choose an article.");
        await this.one(actor, articleId);
        await this.prisma.kb_ticket_links.upsert({
            where: { ticket_id_article_id: { ticket_id: ticketId, article_id: articleId } },
            create: { ticket_id: ticketId, article_id: articleId, linked_by: actor.userId }, update: {},
        });
        return { ok: true };
    }

    async unlinkTicket(actor: KbActor, ticketId: string, articleId: string) {
        await this.ticketOk(actor.orgId, ticketId);
        if (!isUuid(articleId)) throw new NotFoundException("Article not found");
        await this.prisma.kb_ticket_links.deleteMany({ where: { ticket_id: ticketId, article_id: articleId } });
        return { ok: true };
    }

    /** Published articles that match the words of the ticket's subject, best first, leaving out ones already linked. */
    async suggest(actor: KbActor, ticketId: string) {
        const t = await this.ticketOk(actor.orgId, ticketId);
        const words = keywordsOf(t.subject);
        if (!words.length) return [];
        const tsq = words.map((w) => `${w}:*`).join(" | ");
        const rank = Prisma.sql`, ts_rank(${DOC}, to_tsquery('english', ${tsq})) AS rank`;
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${this.select(rank)}
            WHERE a.organization_id = ${actor.orgId}::uuid AND a.status = 'published' AND ${DOC} @@ to_tsquery('english', ${tsq})
              AND NOT EXISTS (SELECT 1 FROM kb_ticket_links l WHERE l.article_id = a.id AND l.ticket_id = ${ticketId}::uuid)
            ORDER BY rank DESC, a.helpful_count DESC LIMIT 5`);
        return rows.map((r) => this.shape(r, false));
    }

    /* ------------------------------- portal ------------------------------- */

    private portalWhere(a: KbPortalActor): Prisma.Sql {
        return Prisma.sql`a.organization_id = ${a.orgId}::uuid AND a.status = 'published' AND a.customer_visible`;
    }

    async portalList(a: KbPortalActor, f: { q?: string; category?: string }) {
        const where = [this.portalWhere(a)];
        if (f.category) {
            if (!isUuid(f.category)) return { items: [], total: 0 };
            where.push(Prisma.sql`a.category_id = ${f.category}::uuid`);
        }
        return this.run(where, f.q, 50, 0, true);
    }

    async portalGet(a: KbPortalActor, id: string) {
        if (!isUuid(id)) throw new NotFoundException("Article not found");
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${this.select()} WHERE a.id = ${id}::uuid AND ${this.portalWhere(a)}`);
        if (!rows[0]) throw new NotFoundException("Article not found");
        await this.prisma.kb_articles.update({ where: { id }, data: { view_count: { increment: 1 } } });
        const vote = await this.prisma.kb_feedback.findUnique({ where: { article_id_voter_key: { article_id: id, voter_key: `p:${a.accountId}` } }, select: { helpful: true } });
        const r = rows[0];
        // Customers do not see who wrote it, how often it is read, or the votes.
        return { id: r.id, title: r.title, body: r.body, tags: r.tags, category: r.category_id ? { id: r.category_id, name: r.category_name } : null, updatedAt: r.updated_at.toISOString(), myVote: vote ? (vote.helpful ? "helpful" : "unhelpful") : null };
    }

    async portalFeedback(a: KbPortalActor, id: string, helpful: unknown) {
        if (!isUuid(id)) throw new NotFoundException("Article not found");
        const ok = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT a.id::text FROM kb_articles a WHERE a.id = ${id}::uuid AND ${this.portalWhere(a)}`);
        if (!ok[0]) throw new NotFoundException("Article not found");
        const r = await this.vote(id, `p:${a.accountId}`, helpful);
        return { myVote: r.myVote };
    }

    async portalCategories(orgId: string) {
        return this.categories(orgId, true);
    }
}
