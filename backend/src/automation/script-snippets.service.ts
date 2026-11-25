import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";

export const SNIPPET_LANGUAGES = ["powershell", "bash", "any"] as const;
export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

export type ScriptSnippet = {
    id: string;
    title: string;
    description: string;
    language: SnippetLanguage;
    body: string;
    shared: boolean;
    /** Written by the person asking. */
    mine: boolean;
    /** Who wrote a shared snippet. Empty when that person has since been removed. */
    author: string;
    /** Whether the person asking may change or remove it. */
    canEdit: boolean;
    updatedAt: string;
};

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 1000;
const BODY_MAX = 50_000;

type Who = { orgId: string; userId: string; isManager: boolean };
type Input = { title?: unknown; description?: unknown; language?: unknown; body?: unknown; shared?: unknown };

/**
 * Script snippets: pieces of script kept for reuse. The writer chooses whether one is private (only they see it)
 * or shared (everyone who writes scripts sees it). Anyone who may manage settings can tidy shared ones.
 */
@Injectable()
export class ScriptSnippetsService {
    constructor(private readonly prisma: PrismaService) { }

    private who(req: any): Who {
        const u = req?.user ?? {};
        const orgId = u.organizationId ?? u.organization_id ?? u.orgId ?? u.org_id;
        if (!orgId || !u.id) throw new BadRequestException("No signed-in user.");
        return { orgId: String(orgId), userId: String(u.id), isManager: req?.effectivePermissions?.has?.("settings.write") === true };
    }

    private clean(input: Input, partial: boolean) {
        const out: { title?: string; description?: string | null; language?: SnippetLanguage; body?: string } = {};
        if (!partial || input.title !== undefined) {
            const title = String(input.title ?? "").trim();
            if (!title) throw new BadRequestException("Give the snippet a title.");
            if (title.length > TITLE_MAX) throw new BadRequestException(`The title is too long (up to ${TITLE_MAX} characters).`);
            out.title = title;
        }
        if (input.description !== undefined) {
            const d = String(input.description ?? "").trim();
            if (d.length > DESCRIPTION_MAX) throw new BadRequestException(`The description is too long (up to ${DESCRIPTION_MAX} characters).`);
            out.description = d || null;
        }
        if (!partial || input.language !== undefined) {
            const language = String(input.language ?? "any") as SnippetLanguage;
            if (!SNIPPET_LANGUAGES.includes(language)) throw new BadRequestException("The language must be powershell, bash or any.");
            out.language = language;
        }
        if (!partial || input.body !== undefined) {
            const body = String(input.body ?? "");
            if (!body.trim()) throw new BadRequestException("The snippet has no code.");
            if (body.length > BODY_MAX) throw new BadRequestException(`The snippet is too long (up to ${BODY_MAX} characters).`);
            out.body = body;
        }
        return out;
    }

    private shape(r: any, w: Who): ScriptSnippet {
        const mine = r.owner_user_id === w.userId;
        return {
            id: r.id,
            title: String(r.title),
            description: r.description ? String(r.description) : "",
            language: r.language,
            body: String(r.body),
            shared: !!r.is_shared,
            mine,
            author: r.author_name ? String(r.author_name) : "",
            canEdit: mine || (!!r.is_shared && w.isManager),
            updatedAt: new Date(r.updated_at).toISOString(),
        };
    }

    /** Shared snippets and the person's own private ones, by title. */
    async list(req: any): Promise<ScriptSnippet[]> {
        const w = this.who(req);
        const rows = await this.prisma.$queryRaw<any[]>`
          SELECT s.id::text AS id, s.title, s.description, s.language, s.body, s.is_shared, s.owner_user_id::text AS owner_user_id, s.updated_at,
                 COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email::text, '') AS author_name
          FROM script_snippets s
          LEFT JOIN users u ON u.id = s.owner_user_id
          WHERE s.organization_id = ${w.orgId}::uuid
            AND (s.is_shared OR s.owner_user_id = ${w.userId}::uuid)
          ORDER BY lower(s.title) ASC`;
        return rows.map((r) => this.shape(r, w));
    }

    private duplicate(shared: boolean) {
        return shared
            ? "A shared snippet with that title and language already exists. Choose another title."
            : "You already have a private snippet with that title and language.";
    }

    async create(req: any, input: Input): Promise<ScriptSnippet> {
        const w = this.who(req);
        const c = this.clean(input, false);
        const shared = input.shared === true;
        const id = randomUUID();
        try {
            await this.prisma.script_snippets.create({
                data: { id, organization_id: w.orgId, owner_user_id: w.userId, title: c.title!, description: c.description ?? null, language: c.language!, body: c.body!, is_shared: shared },
            });
        } catch (e: any) {
            if (e?.code === "P2002") throw new BadRequestException(this.duplicate(shared));
            throw e;
        }
        return (await this.list(req)).find((s) => s.id === id)!;
    }

    private async find(w: Who, id: string) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Snippet not found");
        const r = await this.prisma.script_snippets.findFirst({ where: { id, organization_id: w.orgId } });
        // Another person's private snippet does not exist as far as this person can tell.
        if (!r || (!r.is_shared && r.owner_user_id !== w.userId)) throw new NotFoundException("Snippet not found");
        return r;
    }

    async update(req: any, id: string, input: Input): Promise<ScriptSnippet> {
        const w = this.who(req);
        const cur = await this.find(w, id);
        const mine = cur.owner_user_id === w.userId;
        if (!mine && !(cur.is_shared && w.isManager)) throw new ForbiddenException("Only the person who wrote this snippet can change it.");

        const data: Record<string, unknown> = this.clean(input, true);
        if (input.shared !== undefined) {
            // Sharing is the writer's choice. Someone tidying another person's snippet cannot make it private.
            if (!mine && input.shared !== true) throw new ForbiddenException("Only the person who wrote this snippet can make it private.");
            data.is_shared = input.shared === true;
        }
        if (Object.keys(data).length === 0) return (await this.list(req)).find((s) => s.id === id)!;
        data.updated_at = new Date();
        try {
            await this.prisma.script_snippets.update({ where: { id }, data });
        } catch (e: any) {
            if (e?.code === "P2002") throw new BadRequestException(this.duplicate(data.is_shared === undefined ? cur.is_shared : data.is_shared === true));
            throw e;
        }
        return (await this.list(req)).find((s) => s.id === id)!;
    }

    async remove(req: any, id: string) {
        const w = this.who(req);
        const cur = await this.find(w, id);
        if (cur.owner_user_id !== w.userId && !(cur.is_shared && w.isManager)) throw new ForbiddenException("Only the person who wrote this snippet can remove it.");
        await this.prisma.script_snippets.delete({ where: { id } });
        return { ok: true };
    }
}
