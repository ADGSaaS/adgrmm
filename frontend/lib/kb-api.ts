// The knowledge base's calls (staff side). The customer portal has its own, in lib/portal-api.ts.
import { jfetch } from "@/lib/api";

export type KbCategory = { id: string; name: string; sortOrder: number; articles: number };

export type KbArticleRow = {
    id: string;
    title: string;
    excerpt: string;
    tags: string[];
    status: "draft" | "published";
    customerVisible: boolean;
    version: number;
    viewCount: number;
    helpful: number;
    unhelpful: number;
    category: { id: string; name: string } | null;
    author: { id: string; name: string | null } | null;
    updatedBy: string | null;
    createdAt: string;
    updatedAt: string;
    publishedAt: string | null;
};

export type KbArticle = Omit<KbArticleRow, "excerpt"> & { body: string; myVote: "helpful" | "unhelpful" | null; linkedTickets: number };
export type KbVersionRow = { version: number; title: string; savedAt: string; note: string | null; savedBy: string | null; current: boolean };
export type KbVersion = { version: number; title: string; body: string; tags: string[]; savedAt: string; note: string | null };

export type KbInput = { title: string; body: string; tags: string[]; categoryId: string | null; status: "draft" | "published"; customerVisible: boolean; note?: string };

const qs = (params: Record<string, string | number | undefined | null>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
    const t = s.toString();
    return t ? `?${t}` : "";
};

export const kb = {
    list: (p: { q?: string; category?: string; tag?: string; status?: string; limit?: number; offset?: number }) =>
        jfetch<{ items: KbArticleRow[]; total: number }>(`/api/kb/articles${qs(p)}`),
    get: (id: string, countView = true) => jfetch<KbArticle>(`/api/kb/articles/${id}${countView ? "" : "?noview=1"}`),
    create: (b: KbInput) => jfetch<{ id: string; title: string }>("/api/kb/articles", { method: "POST", body: b }),
    update: (id: string, b: Partial<KbInput>) => jfetch<{ ok: true }>(`/api/kb/articles/${id}`, { method: "PATCH", body: b }),
    remove: (id: string) => jfetch<{ ok: true }>(`/api/kb/articles/${id}`, { method: "DELETE" }),
    versions: (id: string) => jfetch<KbVersionRow[]>(`/api/kb/articles/${id}/versions`),
    version: (id: string, v: number) => jfetch<KbVersion>(`/api/kb/articles/${id}/versions/${v}`),
    restore: (id: string, v: number) => jfetch<{ ok: true }>(`/api/kb/articles/${id}/versions/${v}/restore`, { method: "POST" }),
    vote: (id: string, helpful: boolean) => jfetch<{ helpful: number; unhelpful: number; myVote: "helpful" | "unhelpful" }>(`/api/kb/articles/${id}/feedback`, { method: "POST", body: { helpful } }),
    categories: () => jfetch<KbCategory[]>("/api/kb/categories"),
    createCategory: (name: string) => jfetch<{ id: string }>("/api/kb/categories", { method: "POST", body: { name } }),
    renameCategory: (id: string, name: string) => jfetch<{ ok: true }>(`/api/kb/categories/${id}`, { method: "PATCH", body: { name } }),
    deleteCategory: (id: string) => jfetch<{ ok: true }>(`/api/kb/categories/${id}`, { method: "DELETE" }),
    tags: () => jfetch<{ tag: string; n: number }[]>("/api/kb/tags"),
    suggestions: (ticketId: string) => jfetch<KbArticleRow[]>(`/api/kb/tickets/${ticketId}/suggestions`),
    links: (ticketId: string) => jfetch<KbArticleRow[]>(`/api/kb/tickets/${ticketId}/links`),
    link: (ticketId: string, articleId: string) => jfetch<{ ok: true }>(`/api/kb/tickets/${ticketId}/links`, { method: "POST", body: { articleId } }),
    unlink: (ticketId: string, articleId: string) => jfetch<{ ok: true }>(`/api/kb/tickets/${ticketId}/links/${articleId}`, { method: "DELETE" }),
};

/** Where a customer can open an article: the portal address when the article is customer-visible and a portal domain is set. */
export async function articleUrl(a: { id: string; customerVisible: boolean }): Promise<{ url: string; customerCanOpen: boolean }> {
    let domain: string | null = null;
    if (a.customerVisible) {
        try {
            const c = await fetch("/api/portal/config", { cache: "no-store" }).then((r) => r.json());
            domain = c?.enabled ? c.domain : null;
        } catch { /* no portal */ }
    }
    if (domain) return { url: `https://${domain}/knowledge/${a.id}`, customerCanOpen: true };
    return { url: `${window.location.origin}/knowledge-base/${a.id}`, customerCanOpen: false };
}
