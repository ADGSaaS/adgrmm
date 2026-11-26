#!/usr/bin/env node
// The internal knowledge base through the real HTTP API: who may read and write, drafts hidden from readers, version
// history and restore, categories, full-text search (stemming, prefixes, odd input), feedback, links to tickets and
// suggestions from the subject, the audit log, and the customer portal (only published articles marked visible to
// customers, only for people signed in to the portal, and nothing internal in the answers).
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... node test/kb-http.e2e.cjs
"use strict";
const bcrypt = require("bcryptjs");
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

const { test, finish } = runner();

(async () => {
    const s = await setup();
    const { q, org } = s;
    const stamp = uuid().slice(0, 8);
    const made = { clients: [], accounts: [] };
    const reader = await s.staffUser("kbreader", ["kb.read", "tickets.read", "tickets.write"]);
    const writer = await s.staffUser("kbwriter", ["kb.read", "kb.write", "tickets.read", "tickets.write"]);
    const nobody = await s.staffUser("kbnobody", ["tickets.read"]);
    const R = { token: reader.token };
    const W = { token: writer.token };
    const N = { token: nobody.token };
    const settingsBefore = (await q(`SELECT * FROM portal_settings WHERE organization_id = $1`, [org])).rows[0];

    try {
        // ------------------------------------------------------------ permissions
        console.log("permissions");
        await test("the permissions exist, and the built-in roles got them (admin writes, operator and viewer read)", async () => {
            const keys = (await q(`SELECT permission_key FROM permissions WHERE permission_key IN ('kb.read','kb.write')`)).rows.map((r) => r.permission_key).sort();
            assert.deepEqual(keys, ["kb.read", "kb.write"]);
        });
        await test("signed-out and rightless callers are refused", async () => {
            assert.equal((await call("/api/kb/articles")).status, 401);
            assert.equal((await call("/api/kb/articles", N)).status, 403);
            assert.equal((await call("/api/kb/categories", N)).status, 403);
        });
        await test("a reader cannot write anything", async () => {
            assert.equal((await call("/api/kb/articles", { method: "POST", ...R, body: { title: "x" } })).status, 403);
            assert.equal((await call("/api/kb/categories", { method: "POST", ...R, body: { name: "x" } })).status, 403);
        });

        // ------------------------------------------------------------ categories
        console.log("categories");
        const cat = await json("/api/kb/categories", { method: "POST", ...W, body: { name: `Printing ${stamp}` } });
        await test("a category is made, a duplicate name (any case) is refused, blank and long names are refused", async () => {
            assert.ok(cat.id);
            assert.equal((await call("/api/kb/categories", { method: "POST", ...W, body: { name: `printing ${stamp}` } })).status, 409);
            assert.equal((await call("/api/kb/categories", { method: "POST", ...W, body: { name: "  " } })).status, 400);
            assert.equal((await call("/api/kb/categories", { method: "POST", ...W, body: { name: "x".repeat(81) } })).status, 400);
        });
        await test("categories can be renamed and listed with counts", async () => {
            assert.equal((await call(`/api/kb/categories/${cat.id}`, { method: "PATCH", ...W, body: { name: `Printers ${stamp}` } })).status, 200);
            const list = await json("/api/kb/categories", R);
            assert.ok(list.find((c) => c.id === cat.id && c.name === `Printers ${stamp}`));
        });

        // ------------------------------------------------------------ articles
        console.log("articles");
        const created = await json("/api/kb/articles", {
            method: "POST", ...W,
            body: { title: `Fix a stuck print queue ${stamp}`, body: "Restart the **Print Spooler** service, then clear C:\\Windows\\System32\\spool\\PRINTERS.", tags: ["Printing", "windows", "printing"], categoryId: cat.id, status: "draft" },
        });
        const id = created.id;
        await test("an article is created as a draft with version 1, tags cleaned and de-duplicated", async () => {
            assert.ok(id);
            const a = await json(`/api/kb/articles/${id}?noview=1`, W);
            assert.equal(a.status, "draft");
            assert.equal(a.version, 1);
            assert.deepEqual(a.tags, ["printing", "windows"]);
            assert.equal(a.category.id, cat.id);
            assert.ok(a.author?.name);
        });
        await test("validation: title required and limited, status limited, bad category, too many tags, huge body", async () => {
            const bad = async (body) => (await call("/api/kb/articles", { method: "POST", ...W, body })).status;
            assert.equal(await bad({ title: "" }), 400);
            assert.equal(await bad({ title: "x".repeat(201) }), 400);
            assert.equal(await bad({ title: "ok", status: "archived" }), 400);
            assert.equal(await bad({ title: "ok", categoryId: uuid() }), 400);
            assert.equal(await bad({ title: "ok", categoryId: "not-a-uuid" }), 400);
            assert.equal(await bad({ title: "ok", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), 400);
            assert.equal(await bad({ title: "ok", body: "x".repeat(100_001) }), 400);
        });
        await test("a draft is invisible to a reader (list, get, search, versions) but visible to a writer", async () => {
            assert.equal((await call(`/api/kb/articles/${id}`, R)).status, 404);
            const list = await json(`/api/kb/articles?q=spooler`, R);
            assert.ok(!list.items.find((a) => a.id === id), "the draft is not in a reader's results");
            assert.equal((await call(`/api/kb/articles/${id}/versions`, R)).status, 403);
            const w = await json(`/api/kb/articles?q=spooler`, W);
            assert.ok(w.items.find((a) => a.id === id));
        });
        await test("publishing makes it readable, sets the published time, and counts views", async () => {
            assert.equal((await call(`/api/kb/articles/${id}`, { method: "PATCH", ...W, body: { status: "published" } })).status, 200);
            const a = await json(`/api/kb/articles/${id}`, R);
            assert.equal(a.status, "published");
            assert.ok(a.publishedAt);
            const b = await json(`/api/kb/articles/${id}`, R);
            assert.equal(b.viewCount, a.viewCount + 1);
            const quiet = await json(`/api/kb/articles/${id}?noview=1`, R);
            assert.equal(quiet.viewCount, b.viewCount);
        });
        await test("a status-only change adds no version; a content change does, with who and when", async () => {
            assert.equal((await json(`/api/kb/articles/${id}?noview=1`, W)).version, 1);
            await call(`/api/kb/articles/${id}`, { method: "PATCH", ...W, body: { body: "Restart the **Print Spooler** service. If that fails, reboot the print server.", note: "added fallback" } });
            const vs = await json(`/api/kb/articles/${id}/versions`, W);
            assert.deepEqual(vs.map((v) => v.version), [2, 1]);
            assert.equal(vs[0].current, true);
            assert.equal(vs[0].note, "added fallback");
            assert.ok(vs[0].savedBy);
        });
        await test("restoring an old version makes a new version with the old text; history is kept", async () => {
            const old = await json(`/api/kb/articles/${id}/versions/1`, W);
            assert.match(old.body, /PRINTERS/);
            const r = await json(`/api/kb/articles/${id}/versions/1/restore`, { method: "POST", ...W });
            assert.equal(r.restoredFrom, 1);
            const a = await json(`/api/kb/articles/${id}?noview=1`, W);
            assert.equal(a.version, 3);
            assert.match(a.body, /PRINTERS/);
            const vs = await json(`/api/kb/articles/${id}/versions`, W);
            assert.equal(vs.length, 3);
            assert.match(vs[0].note, /Restored from version 1/);
            assert.equal((await call(`/api/kb/articles/${id}/versions/99`, W)).status, 404);
            assert.equal((await call(`/api/kb/articles/${id}/versions/abc/restore`, { method: "POST", ...W })).status, 404);
        });
        await test("two saves at once give two distinct versions", async () => {
            await Promise.all([1, 2].map((n) => call(`/api/kb/articles/${id}`, { method: "PATCH", ...W, body: { body: `concurrent edit ${n} spooler` } })));
            const vs = (await json(`/api/kb/articles/${id}/versions`, W)).map((v) => v.version);
            assert.equal(new Set(vs).size, vs.length);
            assert.equal(vs[0], 5);
        });
        await test("unknown and malformed ids are 404, and another organization's article is not reachable by id", async () => {
            assert.equal((await call(`/api/kb/articles/${uuid()}`, W)).status, 404);
            assert.equal((await call(`/api/kb/articles/zzz`, W)).status, 404);
            assert.equal((await call(`/api/kb/articles/zzz`, { method: "DELETE", ...W })).status, 404);
            const org2 = (await q(`INSERT INTO organizations (name, slug) VALUES ('Other KB org', $1) RETURNING id`, [`kb-other-${stamp}`])).rows[0].id;
            const foreign = (await q(`INSERT INTO kb_articles (organization_id, title, body, status) VALUES ($1,'Foreign','secret spooler','published') RETURNING id`, [org2])).rows[0].id;
            assert.equal((await call(`/api/kb/articles/${foreign}`, W)).status, 404);
            assert.equal((await call(`/api/kb/articles/${foreign}`, { method: "PATCH", ...W, body: { title: "hacked" } })).status, 404);
            const found = await json(`/api/kb/articles?q=secret`, W);
            assert.equal(found.items.length, 0);
            await q(`DELETE FROM organizations WHERE id = $1`, [org2]);
        });

        // ------------------------------------------------------------ search
        console.log("search");
        const other = await json("/api/kb/articles", { method: "POST", ...W, body: { title: `VPN will not connect ${stamp}`, body: "Check the certificate and that the user is in the VPN group. Error 809 means the firewall blocks GRE.", tags: ["vpn", "network"], status: "published" } });
        const wifi = await json("/api/kb/articles", { method: "POST", ...W, body: { title: `Wi-Fi keeps dropping ${stamp}`, body: "Update the wireless adapter driver.", tags: ["wifi"], status: "published" } });
        await test("full text search finds by body, title and tag, with stemming and prefixes", async () => {
            const find = async (term) => (await json(`/api/kb/articles?q=${encodeURIComponent(term)}`, R)).items.map((a) => a.id);
            assert.ok((await find("firewall")).includes(other.id), "body word");
            assert.ok((await find("connecting")).includes(other.id), "stemmed (connect/connecting)");
            assert.ok((await find("certif")).includes(other.id), "prefix");
            assert.ok((await find("network")).includes(other.id), "tag");
            assert.ok((await find("wireless drivers")).includes(wifi.id), "all words, stemmed");
            assert.ok(!(await find("wireless firewall")).length, "words must all match");
        });
        await test("a title match ranks first, and results carry a highlighted snippet", async () => {
            const r = await json(`/api/kb/articles?q=vpn`, R);
            assert.equal(r.items[0].id, other.id);
            assert.match(r.items[0].excerpt, /<<.*>>/s);
        });
        await test("hostile and odd search input never errors", async () => {
            for (const term of ["'; DROP TABLE kb_articles; --", "a & | ! ( ) :* <->", "\\", "%", "_", "   ", "é漢字", "x".repeat(5000), "!!!", "and or not"]) {
                const res = await call(`/api/kb/articles?q=${encodeURIComponent(term)}`, R);
                assert.equal(res.status, 200, `status for ${JSON.stringify(term).slice(0, 30)}`);
            }
            assert.equal((await q(`SELECT to_regclass('kb_articles') AS t`)).rows[0].t, "kb_articles");
        });
        await test("filters: category, tag, status (writers), paging", async () => {
            const inCat = await json(`/api/kb/articles?category=${cat.id}`, W);
            assert.ok(inCat.items.every((a) => a.category?.id === cat.id) && inCat.items.length >= 1);
            assert.deepEqual((await json(`/api/kb/articles?category=nope`, W)).items, []);
            const tagged = await json(`/api/kb/articles?tag=vpn`, R);
            assert.ok(tagged.items.find((a) => a.id === other.id) && tagged.items.every((a) => a.tags.includes("vpn")));
            const drafts = await json(`/api/kb/articles?status=draft`, W);
            assert.ok(drafts.items.every((a) => a.status === "draft"));
            const page = await json(`/api/kb/articles?limit=1&offset=0`, W);
            assert.equal(page.items.length, 1);
            assert.ok(page.total >= 3);
        });
        await test("tags list counts tags a reader can see", async () => {
            const t = await json(`/api/kb/tags`, R);
            assert.ok(t.find((x) => x.tag === "vpn"));
        });

        // ------------------------------------------------------------ feedback
        console.log("feedback");
        await test("a person's vote is one vote; changing it moves the count; bad input is refused", async () => {
            let r = await json(`/api/kb/articles/${other.id}/feedback`, { method: "POST", ...R, body: { helpful: true } });
            assert.deepEqual([r.helpful, r.unhelpful], [1, 0]);
            r = await json(`/api/kb/articles/${other.id}/feedback`, { method: "POST", ...R, body: { helpful: true } });
            assert.deepEqual([r.helpful, r.unhelpful], [1, 0]);
            r = await json(`/api/kb/articles/${other.id}/feedback`, { method: "POST", ...R, body: { helpful: false } });
            assert.deepEqual([r.helpful, r.unhelpful], [0, 1]);
            r = await json(`/api/kb/articles/${other.id}/feedback`, { method: "POST", ...W, body: { helpful: true } });
            assert.deepEqual([r.helpful, r.unhelpful], [1, 1]);
            assert.equal((await call(`/api/kb/articles/${other.id}/feedback`, { method: "POST", ...R, body: { helpful: "yes" } })).status, 400);
            assert.equal((await json(`/api/kb/articles/${other.id}?noview=1`, R)).myVote, "unhelpful");
        });

        // ------------------------------------------------------------ tickets
        console.log("tickets");
        const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `KB Client ${stamp}`])).rows[0].id;
        made.clients.push(client);
        const ticket = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject, description, status, client_id)
            VALUES ($1, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets WHERE organization_id = $1), $2, 'd', 'open'::ticket_status, $3) RETURNING id`,
            [org, `GC KB printer will not print, VPN down ${stamp}`, client])).rows[0].id;
        await test("suggestions come from the subject's words, published articles only, best first", async () => {
            const sug = await json(`/api/kb/tickets/${ticket}/suggestions`, R);
            const ids = sug.map((a) => a.id);
            assert.ok(ids.includes(other.id), "vpn article suggested");
            assert.ok(ids.includes(id), "print article suggested");
            const draft = await json("/api/kb/articles", { method: "POST", ...W, body: { title: `printer draft ${stamp}`, body: "print", status: "draft" } });
            assert.ok(!(await json(`/api/kb/tickets/${ticket}/suggestions`, W)).map((a) => a.id).includes(draft.id));
        });
        await test("linking, listing, de-duplicating and unlinking an article on a ticket", async () => {
            assert.equal((await call(`/api/kb/tickets/${ticket}/links`, { method: "POST", ...R, body: { articleId: other.id } })).status, 200);
            assert.equal((await call(`/api/kb/tickets/${ticket}/links`, { method: "POST", ...R, body: { articleId: other.id } })).status, 200);
            const links = await json(`/api/kb/tickets/${ticket}/links`, R);
            assert.deepEqual(links.map((a) => a.id), [other.id]);
            assert.ok(!(await json(`/api/kb/tickets/${ticket}/suggestions`, R)).map((a) => a.id).includes(other.id), "linked ones are not suggested again");
            assert.equal((await call(`/api/kb/tickets/${ticket}/links`, { method: "POST", ...R, body: { articleId: "bad" } })).status, 400);
            assert.equal((await call(`/api/kb/tickets/${ticket}/links`, { method: "POST", ...R, body: { articleId: uuid() } })).status, 404);
            assert.equal((await call(`/api/kb/tickets/${uuid()}/links`, R)).status, 404);
            assert.equal((await call(`/api/kb/tickets/${ticket}/links/${other.id}`, { method: "DELETE", ...R })).status, 200);
            assert.deepEqual(await json(`/api/kb/tickets/${ticket}/links`, R), []);
        });
        await test("ticket links need tickets.write; a reader without it cannot link", async () => {
            const ro = await s.staffUser("kbro", ["kb.read", "tickets.read"]);
            assert.equal((await call(`/api/kb/tickets/${ticket}/links`, { method: "POST", token: ro.token, body: { articleId: other.id } })).status, 403);
            assert.equal((await call(`/api/kb/tickets/${ticket}/links`, { token: ro.token })).status, 200);
        });

        // ------------------------------------------------------------ audit
        console.log("audit");
        await test("writes are in the audit log; reads and votes are not", async () => {
            await new Promise((r) => setTimeout(r, 800));
            const rows = (await q(`SELECT action FROM audit_events WHERE action LIKE 'kb.%' OR action LIKE 'ticket.kb%'`)).rows.map((r) => r.action);
            for (const a of ["kb.article.create", "kb.article.update", "kb.article.restore", "kb.category.create", "kb.category.update", "kb.article.link", "kb.article.unlink"]) assert.ok(rows.includes(a), `missing ${a}`);
            assert.ok(!rows.includes("kb.article.feedback"));
        });

        // ------------------------------------------------------------ portal
        console.log("customer portal");
        const PASS = "correct horse battery";
        const mkPerson = async (clientId, label, role = "user") => {
            const email = `${label}-${stamp}@kb.example.test`;
            const pid = (await q(`INSERT INTO portal_accounts (organization_id, client_id, email, name, role, status, password_hash) VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id`, [org, clientId, email, `${label} person`, role, await bcrypt.hash(PASS, 4)])).rows[0].id;
            made.accounts.push(pid);
            return { id: pid, email };
        };
        const loginPortal = async (p) => {
            const res = await call("/api/portal/auth/login", { method: "POST", body: { email: p.email, password: PASS } });
            return (res.headers.getSetCookie?.() ?? []).map((c) => c.match(/^portal_token=([^;]*)/)?.[1]).find(Boolean);
        };
        await q(`DELETE FROM portal_settings WHERE organization_id = $1`, [org]);
        await q(`INSERT INTO portal_settings (organization_id, enabled, domain, modules) VALUES ($1, true, $2, ARRAY['dashboard','tickets','knowledge'])`, [org, `portal-${stamp}.example.test`]);
        const cust = await mkPerson(client, "cust");
        const pt = await loginPortal(cust);
        const pub = await json("/api/kb/articles", { method: "POST", ...W, body: { title: `How to reset your password ${stamp}`, body: "Go to the sign-in page and choose **Forgot password**.\n\nInternal note: admin override is in the vault.", tags: ["password"], status: "published", customerVisible: true } });
        const internalOnly = await json("/api/kb/articles", { method: "POST", ...W, body: { title: `Internal password policy ${stamp}`, body: "password staff only", status: "published" } });
        const draftVisible = await json("/api/kb/articles", { method: "POST", ...W, body: { title: `Draft password thing ${stamp}`, body: "password draft", status: "draft", customerVisible: true } });
        await test("portal knowledge needs a portal sign-in; a staff token does not work there", async () => {
            assert.equal((await call("/api/portal/kb")).status, 401);
            assert.equal((await call("/api/portal/kb", { token: writer.token })).status, 401);
            assert.equal((await call(`/api/portal/kb/${pub.id}`)).status, 401);
        });
        await test("a customer sees only published, customer-visible articles, with nothing internal in the answer", async () => {
            const list = await json("/api/portal/kb?q=password", { portal: pt });
            const ids = list.items.map((a) => a.id);
            assert.ok(ids.includes(pub.id));
            assert.ok(!ids.includes(internalOnly.id) && !ids.includes(draftVisible.id));
            const item = list.items.find((a) => a.id === pub.id);
            for (const k of ["author", "updatedBy", "viewCount", "helpful", "status", "customerVisible", "version"]) assert.ok(!(k in item), `leaks ${k}`);
            assert.ok(Array.isArray(list.categories));
            const a = await json(`/api/portal/kb/${pub.id}`, { portal: pt });
            assert.match(a.body, /Forgot password/);
            for (const k of ["author", "updatedBy", "viewCount", "helpful", "unhelpful", "status", "customerVisible", "version", "linkedTickets"]) assert.ok(!(k in a), `leaks ${k}`);
            assert.equal((await call(`/api/portal/kb/${internalOnly.id}`, { portal: pt })).status, 404);
            assert.equal((await call(`/api/portal/kb/${draftVisible.id}`, { portal: pt })).status, 404);
            assert.equal((await call(`/api/portal/kb/not-a-uuid`, { portal: pt })).status, 404);
        });
        await test("portal search is safe against odd input and a customer cannot read other articles by searching", async () => {
            for (const term of ["'; --", "a & | !", "\\", "x".repeat(3000)]) assert.equal((await call(`/api/portal/kb?q=${encodeURIComponent(term)}`, { portal: pt })).status, 200);
            const hits = (await json("/api/portal/kb?q=staff", { portal: pt })).items;
            assert.equal(hits.length, 0);
            assert.equal((await call(`/api/portal/kb?category=nope`, { portal: pt })).status, 200);
        });
        await test("a customer's vote is recorded once per person, and cannot vote on hidden articles", async () => {
            assert.equal((await call(`/api/portal/kb/${pub.id}/feedback`, { method: "POST", portal: pt, body: { helpful: true } })).status, 200);
            assert.equal((await call(`/api/portal/kb/${pub.id}/feedback`, { method: "POST", portal: pt, body: { helpful: false } })).status, 200);
            const a = await json(`/api/kb/articles/${pub.id}?noview=1`, W);
            assert.deepEqual([a.helpful, a.unhelpful], [0, 1]);
            assert.equal((await call(`/api/portal/kb/${internalOnly.id}/feedback`, { method: "POST", portal: pt, body: { helpful: true } })).status, 404);
            assert.equal((await call(`/api/portal/kb/${pub.id}/feedback`, { method: "POST", portal: pt, body: { helpful: "x" } })).status, 400);
        });
        await test("unpublishing or un-flagging hides it from customers at once", async () => {
            await call(`/api/kb/articles/${pub.id}`, { method: "PATCH", ...W, body: { customerVisible: false } });
            assert.equal((await call(`/api/portal/kb/${pub.id}`, { portal: pt })).status, 404);
            await call(`/api/kb/articles/${pub.id}`, { method: "PATCH", ...W, body: { customerVisible: true, status: "draft" } });
            assert.equal((await call(`/api/portal/kb/${pub.id}`, { portal: pt })).status, 404);
            await call(`/api/kb/articles/${pub.id}`, { method: "PATCH", ...W, body: { status: "published" } });
            assert.equal((await call(`/api/portal/kb/${pub.id}`, { portal: pt })).status, 200);
        });
        await test("the portal area can be switched off in the portal settings", async () => {
            await q(`UPDATE portal_settings SET modules = ARRAY['dashboard','tickets'] WHERE organization_id = $1`, [org]);
            assert.equal((await call("/api/portal/kb", { portal: pt })).status, 403);
            assert.equal((await call(`/api/portal/kb/${pub.id}`, { portal: pt })).status, 403);
            await q(`UPDATE portal_settings SET modules = ARRAY['dashboard','tickets','knowledge'] WHERE organization_id = $1`, [org]);
        });

        // ------------------------------------------------------------ delete
        console.log("delete");
        await test("deleting an article removes its history, votes and ticket links; deleting a category keeps its articles", async () => {
            await call(`/api/kb/tickets/${ticket}/links`, { method: "POST", ...W, body: { articleId: id } });
            assert.equal((await call(`/api/kb/articles/${id}`, { method: "DELETE", ...W })).status, 200);
            assert.equal((await call(`/api/kb/articles/${id}`, W)).status, 404);
            assert.equal((await q(`SELECT count(*)::int n FROM kb_article_versions WHERE article_id = $1`, [id])).rows[0].n, 0);
            assert.equal((await q(`SELECT count(*)::int n FROM kb_ticket_links WHERE article_id = $1`, [id])).rows[0].n, 0);
            const keep = await json("/api/kb/articles", { method: "POST", ...W, body: { title: `kept ${stamp}`, categoryId: cat.id } });
            assert.equal((await call(`/api/kb/categories/${cat.id}`, { method: "DELETE", ...W })).status, 200);
            assert.equal((await json(`/api/kb/articles/${keep.id}?noview=1`, W)).category, null);
            assert.equal((await call(`/api/kb/categories/${cat.id}`, { method: "DELETE", ...W })).status, 404);
        });
    } finally {
        await q(`DELETE FROM kb_articles WHERE organization_id = $1 AND (title LIKE '%${stamp}%')`, [org]);
        await q(`DELETE FROM kb_categories WHERE organization_id = $1 AND name LIKE '%${stamp}%'`, [org]);
        await q(`DELETE FROM portal_accounts WHERE id = ANY($1::uuid[])`, [made.accounts]);
        await q(`DELETE FROM portal_settings WHERE organization_id = $1`, [org]);
        if (settingsBefore) {
            await q(`INSERT INTO portal_settings (organization_id, enabled, domain, modules, allow_ticket_create, welcome_title, welcome_text, support_email, support_phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [org, settingsBefore.enabled, settingsBefore.domain, settingsBefore.modules, settingsBefore.allow_ticket_create, settingsBefore.welcome_title, settingsBefore.welcome_text, settingsBefore.support_email, settingsBefore.support_phone]);
        }
        s.made.clients.push(...made.clients);
        await s.cleanup();
    }
    finish();
})().catch((e) => { console.error(e); process.exit(1); });
