// Importing from Freshdesk, against a stand-in Freshdesk server and the test database: reading every page,
// mapping, attachments, time, skipping what is already in, cancelling, and failing one ticket without harming the rest.
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));

const fd = dist("imports/freshdesk.js");

let passed = 0, failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message}`); }
}

// ---- A stand-in Freshdesk ------------------------------------------------------------------------------------
const KEY = "good-key";
const N = 230;
const BASE_T = Date.UTC(2024, 0, 1);
const iso = (h) => new Date(BASE_T + h * 3_600_000).toISOString();
const state = { rateLimitOnce: true, delayMs: 0, revokeAfter: Infinity, calls: 0, hits: [], failConversations: new Set([1003]), stamp: "" };

function dataset(stamp) {
    const tickets = [];
    for (let i = 0; i < N; i++) {
        // Tickets 199 and 200 changed at the same moment, right at the edge of a window of 200.
        const updated = iso(i === 200 ? 199 : i);
        tickets.push({
            id: 1000 + i, subject: i === 5 ? `  Re: <b>Printer</b> ${stamp} ` : `Ticket ${i} ${stamp}`, description: `<div>Please help <b>${i}</b></div>`, description_text: `Please help ${i}`,
            status: [2, 3, 4, 5, 7][i % 5], priority: (i % 4) + 1, requester_id: 500 + (i % 3), responder_id: 10 + (i % 2),
            created_at: iso(i), updated_at: updated, due_by: iso(i + 48), tags: i % 5 === 0 ? ["vip", "hardware"] : [],
            stats: { closed_at: iso(i + 5), resolved_at: iso(i + 4) },
            attachments: i === 0 ? [{ id: 1, name: "screenshot.png", size: 7, attachment_url: `__BASE__/files/screenshot.png` }] : [],
        });
    }
    return tickets;
}

function startFreshdesk(stamp, agentEmails) {
    const tickets = dataset(stamp);
    const requesters = {
        500: { id: 500, name: "Pat Customer", email: `pat-${stamp}@customer.test`, phone: "555-0100", company_id: 900 },
        501: { id: 501, name: "Existing Person", email: `existing-${stamp}@customer.test`, phone: null, company_id: 901 },
        502: { id: 502, name: "No Email Person", email: null, phone: "555-0102", mobile: "555-0103" },
    };
    const srv = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        const base = `http://127.0.0.1:${srv.address().port}`;
        const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
        const respond = () => {
            if (url.pathname.startsWith("/files/")) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end("PDFDATA"); }
            state.calls++;
            state.hits.push(url.pathname);
            const auth = req.headers.authorization || "";
            if (auth !== `Basic ${Buffer.from(`${KEY}:X`).toString("base64")}` || state.calls > state.revokeAfter) return send(401, { code: "invalid_credentials" });
            if (state.rateLimitOnce && url.pathname === "/api/v2/contacts") { state.rateLimitOnce = false; return send(429, { message: "slow down" }, { "retry-after": "1" }); }
            const page = Number(url.searchParams.get("page") || 1);
            const per = Number(url.searchParams.get("per_page") || 30);
            const slice = (arr) => arr.slice((page - 1) * per, page * per);
            if (url.pathname === "/api/v2/agents") return send(200, slice([{ id: 10, contact: { name: "Agent One", email: agentEmails[0] } }, { id: 11, contact: { name: "Agent Two", email: agentEmails[1] } }]));
            if (url.pathname === "/api/v2/companies") return send(200, slice([{ id: 900, name: `Acme Dental ${stamp}` }, { id: 901, name: `Unknown Co ${stamp}` }]));
            if (url.pathname === "/api/v2/contacts") return send(200, slice(Object.values(requesters)));
            if (url.pathname === "/api/v2/tickets") {
                // Without updated_since Freshdesk only lists the last 30 days: the importer must always ask for everything.
                const since = url.searchParams.get("updated_since");
                if (!since) return send(200, []);
                const list = tickets.filter((t) => t.updated_at >= since).sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id - b.id));
                const withReq = url.searchParams.get("include")?.includes("requester");
                return send(200, slice(list).map((t) => ({ ...t, attachments: t.attachments.map((a) => ({ ...a, attachment_url: a.attachment_url.replace("__BASE__", base) })), ...(withReq ? { requester: requesters[t.requester_id] } : {}) })));
            }
            const m = /^\/api\/v2\/tickets\/(\d+)\/(conversations|time_entries)$/.exec(url.pathname);
            if (m) {
                const id = Number(m[1]);
                const i = id - 1000;
                if (m[2] === "conversations") {
                    if (state.failConversations.has(id)) return send(500, { message: "boom" });
                    if (i % 2 !== 0) return send(200, []);
                    return send(200, slice([
                        { id: id * 10 + 1, incoming: true, private: false, user_id: 500, body_text: "It is still broken.", body: "<p>It is still broken.</p>", created_at: iso(i + 1), attachments: [] },
                        { id: id * 10 + 2, incoming: false, private: true, user_id: 10, body_text: "Checked the cable, looks fine.", created_at: iso(i + 2), attachments: [] },
                        { id: id * 10 + 3, incoming: false, private: false, user_id: 11, body: "<p>We will send a <b>replacement</b>.</p>", created_at: iso(i + 3), attachments: [{ id: 5, name: "invoice.pdf", size: 7, attachment_url: `${base}/files/invoice.pdf` }] },
                    ]));
                }
                if (i % 4 === 0) return send(200, [{ id: id * 10 + 1, agent_id: 10, time_spent: "01:30", executed_at: iso(i), billable: true, note: "On site" }, { id: id * 10 + 2, agent_id: 11, time_spent: "00:00", executed_at: iso(i), billable: false }]);
                return send(200, []);
            }
            send(404, {});
        };
        if (state.delayMs) setTimeout(respond, state.delayMs); else respond();
    });
    return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

(async () => {
    // ---- Rules, no database or network ----
    await check("only Freshdesk addresses are accepted", () => {
        assert.equal(fd.freshdeskHost("acme"), "acme.freshdesk.com");
        assert.equal(fd.freshdeskHost("https://Acme.freshdesk.com/helpdesk/tickets"), "acme.freshdesk.com");
        for (const bad of ["", "evil.com", "acme.freshdesk.com.evil.com", "169.254.169.254", "a b.freshdesk.com", "https://user@evil.com"]) assert.throws(() => fd.freshdeskHost(bad), /Freshdesk|address/, bad);
    });
    await check("statuses, priorities, text and time are mapped", () => {
        assert.deepEqual([2, 3, 4, 5].map((n) => fd.mapStatus(n).status), ["open", "pending", "resolved", "closed"]);
        assert.deepEqual(fd.mapStatus(7), { status: "open", known: false });
        assert.deepEqual([1, 2, 3, 4, 9].map(fd.mapPriority), ["low", "normal", "high", "urgent", "normal"]);
        assert.equal(fd.htmlToText("<p>A &amp; B</p><p>C<br>D</p><script>x()</script>"), "A & B\nC\nD");
        assert.equal(fd.textOf({ body_text: "plain", body: "<b>html</b>" }), "plain");
        assert.equal(fd.textOf({ body: "<b>only html</b>" }), "only html");
        assert.equal(fd.minutesOf("01:30"), 90);
        assert.equal(fd.minutesOf("0:45:20"), 45);
        assert.equal(fd.minutesOf("nonsense"), 0);
        assert.equal(fd.safeName("../../etc/passwd"), ".._.._etc_passwd");
    });

    // ---- The importer ----
    const { PrismaService } = dist("storage/prisma.service.js");
    const { ImportsService } = dist("imports/imports.service.js");
    const prisma = new PrismaService();
    const org = (await prisma.$queryRaw`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)[0].id;
    const stamp = Date.now().toString(36);
    state.stamp = stamp;
    const agentEmails = [`agent1-${stamp}@fd.test`, `agent2-${stamp}@fd.test`];
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "adg-import-"));
    const fdServer = await startFreshdesk(stamp, agentEmails);
    const svc = new ImportsService(prisma);
    svc.makeClient = (host, key) => new fd.FreshdeskClient(`${fdServer.base}/api/v2`, key, { sleep: async () => { }, maxPages: 2 });
    svc.allowInsecureFiles = true;
    svc.uploadDir = uploadDir;

    const mkUser = async (email) => (await prisma.$queryRaw`INSERT INTO users (organization_id, email, password_hash, status) VALUES (${org}::uuid, ${email}, 'x', 'active') RETURNING id::text AS id`)[0].id;
    const agent1 = await mkUser(agentEmails[0]);
    const admin = await mkUser(`admin-${stamp}@fd.test`);
    const clientId = (await prisma.clients.create({ data: { organization_id: org, name: `Acme Dental ${stamp}` }, select: { id: true } })).id;
    const existingContact = (await prisma.contacts.create({ data: { organization_id: org, name: "Already Here", email: `existing-${stamp}@customer.test` }, select: { id: true } })).id;
    const jobs = [];
    const preview = async (key = KEY, domain = "acme") => {
        const { id } = await svc.startPreview(org, admin, { domain, apiKey: key });
        jobs.push(id);
        await svc.waitFor(id);
        return svc.get(org, id);
    };
    const run = async (id, opts = {}) => {
        await svc.startRun(org, admin, id, opts);
        await svc.waitFor(id);
        return svc.get(org, id);
    };
    const ticketsOfImport = () => prisma.$queryRaw`SELECT t.* FROM tickets t JOIN import_links l ON l.local_id = t.id WHERE l.organization_id = ${org}::uuid AND l.kind = 'ticket' AND t.subject LIKE ${"%" + stamp + "%"}`;

    try {
        await check("a wrong address or key is refused, and the key is not kept", async () => {
            await assert.rejects(() => svc.startPreview(org, admin, { domain: "evil.com", apiKey: "x" }), /Freshdesk address/);
            await assert.rejects(() => svc.startPreview(org, admin, { domain: "acme", apiKey: "  " }), /API key/);
            const j = await preview("wrong-key");
            assert.equal(j.status, "failed");
            assert.match(j.message, /refused the API key/);
            const raw = await prisma.import_jobs.findUnique({ where: { id: j.id } });
            assert.equal(raw.config.apiKey, undefined);
            assert.equal(raw.config.host, "acme.freshdesk.com");
        });

        let previewed;
        await check("the preview reads every page and says what would match, without importing anything", async () => {
            state.hits.length = 0;
            previewed = await preview();
            assert.equal(previewed.status, "previewed", previewed.message);
            const p = previewed.preview;
            assert.equal(p.tickets.total, N, "every ticket, across windows of 200");
            assert.equal(p.tickets.alreadyImported, 0);
            assert.deepEqual(p.tickets.byStatus, { Open: 46, Pending: 46, Resolved: 46, Closed: 46, "Custom status 7": 46 });
            assert.equal(p.tickets.unknownStatus, 46);
            assert.equal(p.tickets.firstCreatedAt, iso(0));
            assert.equal(p.agents.total, 2);
            assert.equal(p.agents.matched, 1);
            assert.deepEqual(p.agents.unmatched, [agentEmails[1]]);
            assert.equal(p.companies.total, 2);
            assert.equal(p.companies.matched, 1);
            assert.deepEqual(p.companies.unmatched, [`Unknown Co ${stamp}`]);
            assert.equal(p.contacts.total, 3);
            assert.equal((await ticketsOfImport()).length, 0);
            assert.ok(!state.hits.some((h) => h.includes("conversations")), "a preview does not read conversations");
            const raw = await prisma.import_jobs.findUnique({ where: { id: previewed.id } });
            assert.ok(raw.config.apiKey.startsWith("enc:v1:"), "the key is kept encrypted until the job ends");
        });

        await check("an import cannot start from a failed or unknown preview, or alongside another", async () => {
            await assert.rejects(() => svc.startRun(org, admin, "not-a-uuid", {}), /not found/);
            const failedJob = jobs[0];
            await assert.rejects(() => svc.startRun(org, admin, failedJob, {}), /Preview first/);
            await assert.rejects(() => svc.startRun(org, admin, previewed.id, { contacts: false, tickets: false }), /Choose something/);
        });

        let first;
        await check("the import brings in contacts, tickets, replies, notes, attachments and time; one bad ticket fails alone", async () => {
            first = await run(previewed.id);
            assert.equal(first.status, "completed", first.message);
            const pr = first.progress;
            assert.equal(pr.tickets.done, N - 1);
            assert.equal(pr.tickets.failed, 1);
            assert.equal(pr.tickets.skipped, 0);
            assert.equal(first.errors.filter((e) => e.kind === "ticket").length, 1);
            assert.equal(first.errors.find((e) => e.kind === "ticket").id, "1003");
            assert.equal(pr.replies, 230);
            assert.equal(pr.notes, 115);
            assert.equal(pr.time.done, 58);
            assert.equal(pr.time.skipped, 58, "zero-minute entries are not kept");
            assert.equal(pr.attachments.saved, 115 + 1);
            assert.equal(pr.attachments.failed, 0);
            assert.equal((await ticketsOfImport()).length, N - 1);
            // The failed ticket left nothing behind.
            assert.equal((await prisma.import_links.count({ where: { organization_id: org, kind: "ticket", external_id: "1003" } })), 0);
            assert.equal((await prisma.tickets.count({ where: { organization_id: org, subject: `Ticket 3 ${stamp}` } })), 0);
            const raw = await prisma.import_jobs.findUnique({ where: { id: first.id } });
            assert.equal(raw.config.apiKey, undefined, "the key is gone once the job ends");
        });

        await check("a ticket keeps its subject, text, status, priority, dates, assignee, tags and requester", async () => {
            const t = (await prisma.tickets.findFirst({ where: { organization_id: org, subject: { contains: `Printer` }, description: { contains: "Please help 5" } }, include: { contacts: true, ticket_tags: true } }));
            assert.ok(t, "ticket 5 (its subject was padded and had Re:/HTML)");
            assert.equal(t.subject, `Re: <b>Printer</b> ${stamp}`, "the subject is kept as the person wrote it, only trimmed");
            assert.equal(t.description, "Please help 5");
            assert.equal(t.status, "open", "status 7 is a custom status here");
            assert.equal(t.priority, "normal", "Freshdesk priority 2 is medium, which is normal here");
        });
        await check("status, priority, assignee and dates for a known ticket", async () => {
            const link = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1004" } } });
            const t = await prisma.tickets.findUnique({ where: { id: link.local_id }, include: { contacts: true, ticket_tags: true } });
            assert.equal(t.status, "open"); // 4 % 5 -> status 7 (custom)
            const l2 = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1002" } } });
            const t2 = await prisma.tickets.findUnique({ where: { id: l2.local_id }, include: { contacts: true } });
            assert.equal(t2.status, "resolved");
            assert.equal(t2.priority, "high");
            assert.equal(t2.created_at.toISOString(), iso(2));
            assert.equal(t2.closed_at.toISOString(), iso(2 + 5), "closed/resolved tickets take the date from the ticket's stats");
            assert.equal(t2.due_at.toISOString(), iso(2 + 48));
            assert.equal(t2.assignee_user_id, agent1, "ticket 1002 is assigned to Freshdesk agent 10, whose email matches a user here");
        });
        await check("agents are matched to users by email, and the rest are left unassigned", async () => {
            const l0 = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1000" } } });
            const t0 = await prisma.tickets.findUnique({ where: { id: l0.local_id } });
            assert.equal(t0.assignee_user_id, agent1, "ticket 1000 is assigned to agent 10, whose email matches a user");
            const l1 = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1001" } } });
            assert.equal((await prisma.tickets.findUnique({ where: { id: l1.local_id } })).assignee_user_id, null, "agent 11 has no user here");
        });

        await check("replies, private notes and who wrote them", async () => {
            const link = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1000" } } });
            const acts = await prisma.ticket_activity.findMany({ where: { ticket_id: link.local_id }, orderBy: { created_at: "asc" } });
            const real = acts.filter((a) => a.author !== "Import");
            assert.deepEqual(real.map((a) => [a.kind, a.is_internal, a.is_inbound]), [["message", false, true], ["note", true, false], ["message", false, false]], "customer reply, private note, agent reply");
        });
        await check("the customer's reply shows as theirs, the private note stays private, HTML becomes text", async () => {
            const link = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1004" } } });
            const acts = await prisma.ticket_activity.findMany({ where: { ticket_id: link.local_id, author: { not: "Import" } }, orderBy: { created_at: "asc" } });
            assert.equal(acts.length, 3);
            assert.deepEqual([acts[0].kind, acts[0].is_inbound, acts[0].body], ["message", true, "It is still broken."]);
            assert.match(acts[0].author, /Customer|Person|Requester|@/, "named after the requester");
            assert.equal(acts[1].kind, "note");
            assert.equal(acts[1].is_internal, true);
            assert.equal(acts[1].author, "Agent One");
            assert.equal(acts[1].notify_customer, false);
            assert.equal(acts[2].kind, "message");
            assert.equal(acts[2].is_internal, false);
            assert.equal(acts[2].author, "Agent Two");
            assert.equal(acts[2].body, "We will send a replacement.");
            assert.equal(acts[0].created_at.toISOString(), iso(4 + 1), "the original time is kept");
            const files = acts[2].attachments;
            assert.equal(files.length, 1);
            assert.equal(files[0].name, "invoice.pdf");
            assert.match(files[0].url, /^\/static\/uploads\/tickets\/[0-9a-f-]+\.pdf$/);
            assert.equal(fs.readFileSync(path.join(uploadDir, path.basename(files[0].url)), "utf8"), "PDFDATA");
        });

        await check("files on the original request are kept on a private note, and each ticket says where it came from", async () => {
            const link = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1000" } } });
            const acts = await prisma.ticket_activity.findMany({ where: { ticket_id: link.local_id } });
            const note = acts.find((a) => a.body === "Files attached to the original request");
            assert.equal(note.attachments[0].name, "screenshot.png");
            assert.ok(acts.some((a) => a.kind === "change" && a.body === "Imported from Freshdesk (ticket #1000)"));
        });

        await check("tags are kept", async () => {
            const link = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1000" } } });
            assert.deepEqual((await prisma.ticket_tags.findMany({ where: { ticket_id: link.local_id } })).map((x) => x.tag).sort(), ["hardware", "vip"]);
        });

        await check("logged time is kept for the record and is never approved, so it cannot be invoiced", async () => {
            const link = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1004" } } });
            const te = await prisma.time_entries.findMany({ where: { ticket_id: link.local_id } });
            assert.equal(te.length, 1);
            assert.equal(te[0].minutes, 90);
            assert.equal(te[0].status, "imported");
            assert.equal(te[0].billable, true);
            assert.equal(te[0].user_id, agent1);
            assert.equal(te[0].work_date.toISOString().slice(0, 10), iso(4).slice(0, 10));
            assert.equal(await prisma.time_entries.count({ where: { organization_id: org, status: "approved", ticket_id: link.local_id } }), 0);
        });

        await check("contacts: matched by email, created when new, and company matches become customer contacts", async () => {
            const pat = await prisma.contacts.findMany({ where: { organization_id: org, email: `pat-${stamp}@customer.test` } });
            assert.equal(pat.length, 1);
            assert.equal(pat[0].metadata.company, `Acme Dental ${stamp}`);
            assert.equal(pat[0].phone, "555-0100");
            assert.equal(await prisma.contacts.count({ where: { organization_id: org, email: `existing-${stamp}@customer.test` } }), 1, "no duplicate of the existing person");
            const noEmail = await prisma.contacts.findFirst({ where: { organization_id: org, name: "No Email Person" } });
            assert.equal(noEmail.email, null);
            assert.equal(noEmail.phone, "555-0102");
            assert.equal(await prisma.customer_contacts.count({ where: { client_id: clientId, email: `pat-${stamp}@customer.test` } }), 1, "Acme Dental exists, so Pat is listed there");
            assert.equal(await prisma.customer_contacts.count({ where: { client_id: clientId } }), 1);
            const t = await prisma.import_links.findUnique({ where: { organization_id_source_kind_external_id: { organization_id: org, source: "freshdesk", kind: "ticket", external_id: "1001" } } });
            const ticket = await prisma.tickets.findUnique({ where: { id: t.local_id } });
            assert.equal(ticket.requester_contact_id, existingContact, "a ticket by the existing person points at the existing record");
        });

        await check("running it again skips everything already in, and picks up only what failed (now that it works)", async () => {
            state.failConversations.clear();
            const again = await run((await preview()).id);
            assert.equal(again.preview.tickets.alreadyImported, N - 1);
            assert.equal(again.status, "completed", again.message);
            assert.equal(again.progress.tickets.done, 1, "only the ticket that failed before");
            assert.equal(again.progress.tickets.skipped, N - 1);
            assert.equal(again.progress.contacts.skipped, 3);
            assert.equal((await ticketsOfImport()).length, N);
            assert.equal(await prisma.contacts.count({ where: { organization_id: org, email: `pat-${stamp}@customer.test` } }), 1);
            const third = await run((await preview()).id);
            assert.equal(third.progress.tickets.done, 0);
            assert.equal(third.progress.tickets.skipped, N);
        });

        await check("options: nothing optional is imported when it is turned off", async () => {
            await prisma.$executeRawUnsafe(`DELETE FROM tickets WHERE id IN (SELECT local_id FROM import_links WHERE organization_id = '${org}' AND kind = 'ticket')`);
            await prisma.import_links.deleteMany({ where: { organization_id: org, kind: { in: ["ticket", "conversation", "time_entry"] } } });
            const filesBefore = fs.readdirSync(uploadDir).length;
            const j = await run((await preview()).id, { contacts: false, attachments: false, time: false });
            assert.equal(j.status, "completed", j.message);
            assert.equal(j.progress.tickets.done, N);
            assert.equal(j.progress.attachments.saved, 0);
            assert.equal(j.progress.time.done, 0);
            assert.equal(fs.readdirSync(uploadDir).length, filesBefore, "no files were saved");
            assert.equal(await prisma.time_entries.count({ where: { organization_id: org, status: "imported", ticket_id: { in: (await prisma.import_links.findMany({ where: { organization_id: org, kind: "ticket" } })).map((l) => l.local_id) } } }), 0);
            // Contacts were not imported in this run, but each ticket still gets its requester.
            assert.equal(j.progress.contacts.done, 0);
        });

        await check("one import at a time, and a running import can be cancelled and finished later", async () => {
            await prisma.$executeRawUnsafe(`DELETE FROM tickets WHERE id IN (SELECT local_id FROM import_links WHERE organization_id = '${org}' AND kind = 'ticket')`);
            await prisma.import_links.deleteMany({ where: { organization_id: org, kind: { in: ["ticket", "conversation", "time_entry"] } } });
            const pv = await preview();
            state.delayMs = 15;
            await svc.startRun(org, admin, pv.id, { contacts: false });
            await assert.rejects(() => svc.startPreview(org, admin, { domain: "acme", apiKey: KEY }), /Another import is running/);
            for (let i = 0; i < 400 && (await svc.get(org, pv.id)).progress.tickets?.done < 5; i++) await new Promise((r) => setTimeout(r, 25));
            await svc.cancel(org, pv.id);
            await svc.waitFor(pv.id);
            state.delayMs = 0;
            const c = await svc.get(org, pv.id);
            assert.equal(c.status, "cancelled");
            assert.ok(c.progress.tickets.done >= 5 && c.progress.tickets.done < N, `stopped part way (${c.progress.tickets.done})`);
            const done = c.progress.tickets.done;
            const resumed = await run((await preview()).id, { contacts: false });
            assert.equal(resumed.progress.tickets.skipped >= done, true);
            assert.equal((await ticketsOfImport()).length, N);
            await assert.rejects(() => svc.cancel(org, pv.id), /not running/);
        });

        await check("a key that stops working part way fails the job cleanly and keeps what was imported", async () => {
            await prisma.$executeRawUnsafe(`DELETE FROM tickets WHERE id IN (SELECT local_id FROM import_links WHERE organization_id = '${org}' AND kind = 'ticket')`);
            await prisma.import_links.deleteMany({ where: { organization_id: org, kind: { in: ["ticket", "conversation", "time_entry"] } } });
            const pv = await preview();
            state.revokeAfter = state.calls + 40;
            const j = await run(pv.id, { contacts: false });
            state.revokeAfter = Infinity;
            assert.equal(j.status, "failed");
            assert.match(j.message, /refused the API key/);
            assert.ok(j.progress.tickets.done > 0 && j.progress.tickets.done < N);
            const raw = await prisma.import_jobs.findUnique({ where: { id: j.id } });
            assert.equal(raw.config.apiKey, undefined);
        });

        await check("a restart marks unfinished jobs as interrupted", async () => {
            const j = await prisma.import_jobs.create({ data: { organization_id: org, source: "freshdesk", status: "running", config: { host: "acme.freshdesk.com" } } });
            jobs.push(j.id);
            await svc.onModuleInit();
            const after = await svc.get(org, j.id);
            assert.equal(after.status, "interrupted");
            assert.match(after.message, /restarted/);
        });
    } finally {
        await prisma.$executeRawUnsafe(`DELETE FROM tickets WHERE id IN (SELECT local_id FROM import_links WHERE organization_id = '${org}' AND kind = 'ticket') OR subject LIKE '%${stamp}%'`);
        await prisma.$executeRawUnsafe(`DELETE FROM time_entries WHERE status = 'imported' AND organization_id = '${org}'`);
        await prisma.import_links.deleteMany({ where: { organization_id: org, source: "freshdesk" } });
        await prisma.import_jobs.deleteMany({ where: { organization_id: org, source: "freshdesk" } });
        await prisma.$executeRawUnsafe(`DELETE FROM customer_contacts WHERE client_id = '${clientId}'`);
        await prisma.$executeRawUnsafe(`DELETE FROM clients WHERE id = '${clientId}'`);
        await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE organization_id = '${org}' AND (email::text LIKE '%-${stamp}@customer.test' OR name = 'No Email Person')`);
        await prisma.$executeRawUnsafe(`DELETE FROM users WHERE email::text LIKE '%-${stamp}@fd.test'`);
        fs.rmSync(uploadDir, { recursive: true, force: true });
        fdServer.srv.close();
        await prisma.$disconnect();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
