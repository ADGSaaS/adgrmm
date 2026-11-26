// The support mailbox: the rules for turning email into tickets, then the real service against the test database
// (reading a message, threading a reply, sending one, signing in to Microsoft with the network calls replaced).
const path = require("node:path");
const assert = require("node:assert/strict");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));

const rules = dist("support-mailbox/mail-rules.js");
const ms = dist("support-mailbox/microsoft.js");

let passed = 0, failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}

const mail = ({ from = "Pat Customer <pat@customer.test>", to = "support@msp.test", subject = "Printer is down", body = "The printer will not print.", headers = {}, id, inReplyTo, references } = {}) =>
    Buffer.from([
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: Tue, 11 Nov 2026 10:00:00 +0000`,
        `Message-ID: <${id ?? `${Math.random().toString(36).slice(2)}@customer.test`}>`,
        ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
        ...(references ? [`References: ${references.map((r) => `<${r}>`).join(" ")}`] : []),
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        body,
    ].join("\r\n"));

(async () => {
    // ---- Rules, without a database ----
    await check("the ticket number is read from the subject, in either tag form", () => {
        assert.equal(rules.ticketNumberFromSubject("Re: Printer [#123]"), 123);
        assert.equal(rules.ticketNumberFromSubject("[TICKET:#45] hello"), 45);
        assert.equal(rules.ticketNumberFromSubject("Issue #7 is open"), null);
        assert.equal(rules.ticketNumberFromSubject("[#0]"), null);
    });
    await check("subjects lose Re:/Fwd: and the tag", () => {
        assert.equal(rules.cleanSubject("RE: Fwd: AW: Printer [#12]"), "Printer");
        assert.equal(rules.cleanSubject("   "), "(no subject)");
        assert.equal(rules.replySubject(12, "Re: Printer [#12]"), "Re: Printer [#12]");
    });
    await check("message ids are read from In-Reply-To and References", () => {
        assert.deepEqual(rules.referencedMessageIds("<a@x>", "<b@x> <c@x>"), ["a@x", "c@x", "b@x"]);
        assert.deepEqual(rules.referencedMessageIds(undefined, undefined), []);
    });
    await check("quoted text is cut off, and kept whole when that would leave nothing", () => {
        assert.equal(rules.newTextOnly("Thanks, fixed.\n\nOn Tue, 11 Nov 2026 at 10:00, Support <s@x.test> wrote:\n> old stuff\n> more"), "Thanks, fixed.");
        assert.equal(rules.newTextOnly("Yes.\n\n-----Original Message-----\nFrom: a\nSent: b\nOld"), "Yes.");
        assert.equal(rules.newTextOnly("Hi\n\nFrom: Bob <b@x>\nSent: Monday\nSubject: x\n\nold"), "Hi");
        assert.equal(rules.newTextOnly("> only a quote\n> here"), "> only a quote\n> here");
        assert.equal(rules.newTextOnly("Just text, no quote."), "Just text, no quote.");
    });
    await check("mail a person did not write is set aside", () => {
        const base = { fromAddress: "pat@c.test", mailboxAddress: "support@msp.test", subject: "Hi", headers: {} };
        assert.equal(rules.skipReason(base), null);
        assert.equal(rules.skipReason({ ...base, fromAddress: "Support@MSP.test" }), "own-mail");
        assert.equal(rules.skipReason({ ...base, fromAddress: "mailer-daemon@x.test" }), "bounce");
        assert.equal(rules.skipReason({ ...base, subject: "Undeliverable: Re: Hi" }), "bounce");
        assert.equal(rules.skipReason({ ...base, headers: { "auto-submitted": "auto-replied" } }), "automatic");
        assert.equal(rules.skipReason({ ...base, headers: { "auto-submitted": "no" } }), null);
        assert.equal(rules.skipReason({ ...base, headers: { precedence: "bulk" } }), "automatic");
        assert.equal(rules.skipReason({ ...base, subject: "Automatic reply: away" }), "automatic");
        assert.equal(rules.skipReason({ ...base, headers: { "list-id": "<news.x.test>" } }), "mailing-list");
        assert.equal(rules.skipReason({ ...base, fromAddress: null }), "no-sender");
    });
    await check("tenant and client ids are checked before they go into a URL", () => {
        assert.equal(ms.validTenant("contoso.onmicrosoft.com"), true);
        assert.equal(ms.validTenant("a/../b"), false);
        assert.equal(ms.validTenant("x?y=1"), false);
        assert.equal(ms.validClientId("11111111-2222-3333-4444-555555555555"), true);
        assert.equal(ms.validClientId("nope"), false);
        const u = new URL(ms.authorizeUrl({ tenant: "t.test", clientId: "11111111-2222-3333-4444-555555555555", redirectUri: "https://api.test/api/support-mailbox/callback", state: "s" }));
        assert.equal(u.hostname, "login.microsoftonline.com");
        assert.match(u.searchParams.get("scope"), /IMAP\.AccessAsUser\.All/);
        assert.match(u.searchParams.get("scope"), /Mail\.Send/);
        assert.match(u.searchParams.get("scope"), /offline_access/);
    });
    await check("the signed-in account is read from the ID token", () => {
        const tok = (p) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;
        assert.equal(ms.accountFromIdToken(tok({ preferred_username: "Support@MSP.test" })), "support@msp.test");
        assert.equal(ms.accountFromIdToken(tok({ name: "no address" })), null);
        assert.equal(ms.accountFromIdToken("garbage"), null);
        assert.equal(ms.accountFromIdToken(null), null);
    });

    // ---- The service, against the test database ----
    process.env.ADG_E2E_ALLOW = process.env.ADG_E2E_ALLOW || "1";
    const { PrismaService } = dist("storage/prisma.service.js");
    const { SupportMailboxService } = dist("support-mailbox/support-mailbox.service.js");
    const { encryptSecret } = dist("common/secret-box.js");
    const prisma = new PrismaService();
    const settings = { imap_host: "", imap_username: "", imap_password: null, smtp_from_address: "" };
    const sent = [];
    const smtpRepo = { getAllRaw: async () => ({ tickets: { ...settings, imap_port: 993, imap_use_ssl: true } }) };
    const smtp = { sendPlain: async (purpose, to, subject, text) => { sent.push({ purpose, to, subject, text }); return settings.failSend ? { ok: false, result: "SMTP said no" } : { ok: true, result: "Sent" }; } };
    const svc = new SupportMailboxService(prisma, smtpRepo, smtp, { emitTicket: async () => {} });
    svc.ms = {
        exchangeCode: async () => ({ accessToken: "a", refreshToken: "refresh-secret-1", idToken: `x.${Buffer.from(JSON.stringify({ preferred_username: "support@msp.test" })).toString("base64url")}.y`, expiresIn: 3600 }),
        refreshFor: async () => ({ accessToken: "graph-token", refreshToken: null, idToken: null, expiresIn: 3600 }),
        graphSendMail: async (token, m) => { sent.push({ via: "graph", token, ...m }); },
    };

    const org = (await prisma.$queryRaw`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)[0].id;
    const stamp = Date.now().toString(36);
    const sender = `pat-${stamp}@customer.test`;
    const box = { organization_id: org, mailbox_address: "support@msp.test" };
    const made = { tickets: [], clients: [], portal: [] };

    try {
        await prisma.support_mailbox.deleteMany({ where: { organization_id: org } });

        await check("setup: a mailbox cannot be turned on before it is connected or its IMAP login filled in", async () => {
            await assert.rejects(() => svc.save(org, { source: "microsoft", enabled: true }), /Connect the mailbox first/);
            await assert.rejects(() => svc.save(org, { source: "imap", enabled: true }), /Tickets purpose/);
            await assert.rejects(() => svc.save(org, { tenantId: "a/../b" }), /not valid/);
            await assert.rejects(() => svc.save(org, { clientId: "nope" }), /not valid/);
        });

        await check("setup: signing in to Microsoft stores the token encrypted and never shows a secret", async () => {
            await svc.save(org, { tenantId: "contoso.test", clientId: "11111111-2222-3333-4444-555555555555", clientSecret: "client-secret-xyz" });
            const url = await svc.beginConnect(org, "https://api.test/cb", "https://app.test/administration?tab=support-mailbox");
            const state = new URL(url).searchParams.get("state");
            assert.match(state, /^[0-9a-f]{48}$/);
            const bad = await svc.completeConnect("0".repeat(48), "code", "https://api.test/cb");
            assert.equal(bad.ok, false);
            const ok = await svc.completeConnect(state, "code", "https://api.test/cb");
            assert.equal(ok.ok, true);
            assert.equal(ok.returnTo, "https://app.test/administration?tab=support-mailbox");
            const again = await svc.completeConnect(state, "code", "https://api.test/cb");
            assert.equal(again.ok, false, "a sign-in link works once");
            const st = await svc.status(org);
            assert.equal(st.connected, true);
            assert.equal(st.enabled, true);
            assert.equal(st.mailboxAddress, "support@msp.test");
            assert.equal(st.hasClientSecret, true);
            assert.ok(!JSON.stringify(st).includes("client-secret-xyz") && !JSON.stringify(st).includes("refresh-secret-1"));
            const row = await prisma.support_mailbox.findUnique({ where: { organization_id: org } });
            assert.ok(row.refresh_token.startsWith("enc:v1:") && row.client_secret.startsWith("enc:v1:"));
        });

        await check("setup: an expired sign-in link is refused", async () => {
            const url = await svc.beginConnect(org, "https://api.test/cb", null);
            const state = new URL(url).searchParams.get("state");
            await prisma.support_mailbox.update({ where: { organization_id: org }, data: { oauth_state_expires: new Date(Date.now() - 1000) } });
            assert.equal((await svc.completeConnect(state, "code", "https://api.test/cb")).ok, false);
        });

        let first;
        await check("a new email becomes a ticket, with the sender as requester and no quoted text", async () => {
            first = await svc.processRaw(box, mail({ from: `Pat Customer <${sender}>`, subject: "Re: Printer is down", body: "The printer will not print.\n\nOn Mon, 10 Nov 2026, Bob <b@x.test> wrote:\n> earlier", id: `first-${stamp}@customer.test` }), new Date());
            assert.equal(first.action, "ticket");
            made.tickets.push(first.ticketId);
            const t = await prisma.tickets.findUnique({ where: { id: first.ticketId }, include: { contacts: true } });
            assert.equal(t.subject, "Printer is down");
            assert.equal(t.description, "The printer will not print.");
            assert.equal(t.status, "open");
            assert.equal(t.contacts.email, sender);
            assert.equal(t.contacts.name, "Pat Customer");
        });

        await check("a second email from the same person reuses the contact", async () => {
            const r = await svc.processRaw(box, mail({ from: sender, subject: "Another problem" }), new Date());
            made.tickets.push(r.ticketId);
            const n = await prisma.contacts.count({ where: { organization_id: org, email: sender } });
            assert.equal(n, 1);
        });

        await check("a reply with the ticket tag is added to that ticket and reopens it", async () => {
            await prisma.tickets.update({ where: { id: first.ticketId }, data: { status: "closed", closed_at: new Date() } });
            const r = await svc.processRaw(box, mail({ from: sender, subject: `Re: Printer is down [#${first.ticketNumber}]`, body: "Still broken." }), new Date());
            assert.equal(r.action, "reply");
            assert.equal(r.ticketId, first.ticketId);
            const t = await prisma.tickets.findUnique({ where: { id: first.ticketId } });
            assert.equal(t.status, "open");
            assert.equal(t.closed_at, null);
            const a = await prisma.ticket_activity.findMany({ where: { ticket_id: first.ticketId, kind: "message" } });
            assert.equal(a.length, 1);
            assert.equal(a[0].is_inbound, true);
            assert.equal(a[0].is_internal, false);
            assert.equal(a[0].body, "Still broken.");
            assert.equal(a[0].author, sender);
        });

        await check("a reply with no tag is found by the message it answers", async () => {
            const r = await svc.processRaw(box, mail({ from: sender, subject: "Printer is down", body: "One more thing.", inReplyTo: `first-${stamp}@customer.test` }), new Date());
            assert.equal(r.action, "reply");
            assert.equal(r.ticketId, first.ticketId);
        });

        await check("a tag for a ticket that does not exist makes a new ticket instead of failing", async () => {
            const r = await svc.processRaw(box, mail({ from: sender, subject: "Re: x [#99999999]" }), new Date());
            assert.equal(r.action, "ticket");
            made.tickets.push(r.ticketId);
        });

        await check("the same message twice is handled once", async () => {
            const raw = mail({ from: sender, subject: "Dup", id: `dup-${stamp}@customer.test` });
            const a = await svc.processRaw(box, raw, new Date());
            made.tickets.push(a.ticketId);
            const b = await svc.processRaw(box, raw, new Date());
            assert.deepEqual(b, { action: "skipped", reason: "duplicate" });
        });

        await check("automatic replies, bounces and its own mail make no tickets", async () => {
            const before = await prisma.tickets.count({ where: { organization_id: org } });
            const cases = [
                [mail({ from: sender, subject: "Out of office", headers: { "Auto-Submitted": "auto-replied" } }), "automatic"],
                [mail({ from: "MAILER-DAEMON@x.test", subject: "Undelivered Mail Returned to Sender" }), "bounce"],
                [mail({ from: "support@msp.test", subject: "Re: Printer [#1]" }), "own-mail"],
                [mail({ from: `news-${stamp}@x.test`, headers: { "List-Unsubscribe": "<mailto:u@x.test>" } }), "mailing-list"],
            ];
            for (const [raw, why] of cases) assert.deepEqual(await svc.processRaw(box, raw, new Date()), { action: "skipped", reason: why });
            assert.equal(await prisma.tickets.count({ where: { organization_id: org } }), before);
        });

        await check("attachments are not imported, and the ticket says so", async () => {
            const raw = Buffer.from([
                `From: ${sender}`, `To: support@msp.test`, `Subject: With a file`, `Message-ID: <att-${stamp}@customer.test>`, `MIME-Version: 1.0`,
                `Content-Type: multipart/mixed; boundary="b1"`, ``, `--b1`, `Content-Type: text/plain`, ``, `See attached.`, `--b1`,
                `Content-Type: application/pdf; name="invoice.pdf"`, `Content-Disposition: attachment; filename="invoice.pdf"`, `Content-Transfer-Encoding: base64`, ``, `JVBERi0xLjQK`, `--b1--`, ``,
            ].join("\r\n"));
            const r = await svc.processRaw(box, raw, new Date());
            made.tickets.push(r.ticketId);
            const t = await prisma.tickets.findUnique({ where: { id: r.ticketId } });
            assert.match(t.description, /See attached\./);
            assert.match(t.description, /1 attachment in the email was not imported: invoice\.pdf/);
        });

        await check("one sender cannot flood the desk: after 20 in an hour the rest are held back", async () => {
            const spammer = `flood-${stamp}@x.test`;
            let held = 0;
            for (let i = 0; i < 24; i++) {
                const r = await svc.processRaw(box, mail({ from: spammer, subject: `Flood ${i}` }), new Date());
                if (r.action === "ticket") made.tickets.push(r.ticketId);
                if (r.action === "skipped" && r.reason === "rate-limit") held++;
            }
            assert.equal(held, 4);
        });

        await check("a reply to the customer goes out through Microsoft with the ticket tag in the subject", async () => {
            sent.length = 0;
            const r = await svc.sendReply(org, first.ticketId, "We have fixed it.", "Alex Tech");
            assert.deepEqual(r, { sent: true, to: sender });
            assert.equal(sent.length, 1);
            assert.equal(sent[0].via, "graph");
            assert.equal(sent[0].to, sender);
            assert.equal(sent[0].subject, `Re: Printer is down [#${first.ticketNumber}]`);
            assert.match(sent[0].text, /We have fixed it\.\n\nAlex Tech/);
            const out = await prisma.email_messages.count({ where: { ticket_id: first.ticketId, direction: "outbound" } });
            assert.equal(out, 1);
        });

        await check("a sender who is on one customer's contact list becomes the requester, the ticket takes the customer, and replies go to that contact", async () => {
            const client = await prisma.clients.create({ data: { organization_id: org, name: `MB Customer ${stamp}` } });
            made.clients.push(client.id);
            const known = `known-${stamp}@customer.test`;
            const contact = await prisma.customer_contacts.create({ data: { client_id: client.id, name: "Kay Known", email: known.toUpperCase() } });
            const r = await svc.processRaw(box, mail({ from: `Kay <${known}>`, subject: "Known sender" }), new Date());
            assert.equal(r.action, "ticket");
            made.tickets.push(r.ticketId);
            const t = await prisma.tickets.findUnique({ where: { id: r.ticketId } });
            assert.equal(t.requester_customer_contact_id, contact.id);
            assert.equal(t.client_id, client.id);
            sent.length = 0;
            // The mailbox's own address book entry for the same person is not preferred over the customer's contact.
            const other = await prisma.customer_contacts.create({ data: { client_id: client.id, name: "Other Person", email: `other-${stamp}@customer.test` } });
            await prisma.tickets.update({ where: { id: r.ticketId }, data: { requester_customer_contact_id: other.id } });
            assert.deepEqual(await svc.sendReply(org, r.ticketId, "Fixed.", "Alex"), { sent: true, to: `other-${stamp}@customer.test` });
            assert.equal(sent[0].to, `other-${stamp}@customer.test`);

            // A ticket opened in the client portal still goes to the portal person, whatever contact it carries.
            const portal = await prisma.portal_accounts.create({ data: { organization_id: org, client_id: client.id, email: `portal-${stamp}@customer.test`, name: "Portal Pat", status: "active" } });
            made.portal.push(portal.id);
            await prisma.tickets.update({ where: { id: r.ticketId }, data: { portal_account_id: portal.id } });
            sent.length = 0;
            assert.deepEqual(await svc.sendReply(org, r.ticketId, "Fixed again.", "Alex"), { sent: true, to: `portal-${stamp}@customer.test` });
        });

        await check("an address on two customers' contact lists is left alone", async () => {
            const a = await prisma.clients.create({ data: { organization_id: org, name: `MB Twin A ${stamp}` } });
            const b = await prisma.clients.create({ data: { organization_id: org, name: `MB Twin B ${stamp}` } });
            made.clients.push(a.id, b.id);
            const twin = `twin-${stamp}@customer.test`;
            await prisma.customer_contacts.create({ data: { client_id: a.id, name: "Twin", email: twin } });
            await prisma.customer_contacts.create({ data: { client_id: b.id, name: "Twin", email: twin } });
            const r = await svc.processRaw(box, mail({ from: twin, subject: "Which customer" }), new Date());
            made.tickets.push(r.ticketId);
            const t = await prisma.tickets.findUnique({ where: { id: r.ticketId } });
            assert.equal(t.requester_customer_contact_id, null);
            assert.equal(t.client_id, null);
        });

        await check("a failed send leaves a note on the ticket instead of failing the reply", async () => {
            svc.ms.graphSendMail = async () => { throw new Error("Mailbox unavailable"); };
            const r = await svc.sendReply(org, first.ticketId, "Hello", "Alex");
            assert.equal(r.sent, false);
            assert.match(r.reason, /could not be emailed: Mailbox unavailable/);
            const note = await prisma.ticket_activity.findFirst({ where: { ticket_id: first.ticketId, is_internal: true, body: { contains: "could not be emailed" } } });
            assert.ok(note);
        });

        await check("no email is sent when the ticket has no requester address", async () => {
            const t = await prisma.tickets.create({ data: { organization_id: org, ticket_number: BigInt(Date.now()), subject: "No requester" } });
            made.tickets.push(t.id);
            const r = await svc.sendReply(org, t.id, "Hello", "Alex");
            assert.equal(r.sent, false);
            assert.match(r.reason, /no requester with an email address/);
        });

        await check("a revoked Microsoft sign-in asks for a reconnect and stops polling", async () => {
            svc.ms.refreshFor = async () => { throw new ms.MicrosoftAuthError("AADSTS70008 expired", "invalid_grant"); };
            const r = await svc.sendReply(org, first.ticketId, "Hello", "Alex");
            assert.equal(r.sent, false);
            const st = await svc.status(org);
            assert.equal(st.connected, false);
            assert.match(st.lastError, /Connect the mailbox again/);
        });

        await check("manual IMAP: the login saved under the Tickets purpose feeds the same mailbox, and replies go out by SMTP", async () => {
            Object.assign(settings, { imap_host: "imap.msp.test", imap_username: "tickets@msp.test", imap_password: encryptSecret("pw"), smtp_from_address: "Tickets <tickets@msp.test>" });
            const st = await svc.save(org, { source: "imap", enabled: true });
            assert.equal(st.source, "imap");
            assert.equal(st.enabled, true);
            assert.equal(st.connected, true);
            const row = await prisma.support_mailbox.findUnique({ where: { organization_id: org } });
            assert.equal(row.source, "imap");
            assert.ok(row.connected_at, "the clock starts when it is turned on, so old mail is left alone");
            assert.equal(row.mailbox_address, "tickets@msp.test");

            const imapBox = { organization_id: org, mailbox_address: row.mailbox_address };
            const r = await svc.processRaw(imapBox, mail({ from: `Dana <dana-${stamp}@customer.test>`, to: "tickets@msp.test", subject: "Laptop slow", body: "It is very slow." }), new Date());
            assert.equal(r.action, "ticket");
            made.tickets.push(r.ticketId);
            assert.equal((await svc.processRaw(imapBox, mail({ from: "tickets@msp.test" }), new Date())).reason, "own-mail");

            sent.length = 0;
            assert.deepEqual(await svc.sendReply(org, r.ticketId, "Try a restart.", "Alex"), { sent: true, to: `dana-${stamp}@customer.test` });
            assert.equal(sent[0].purpose, "tickets");
            assert.equal(sent[0].to, `dana-${stamp}@customer.test`);
            assert.match(sent[0].subject, new RegExp(`^Re: Laptop slow \\[#${r.ticketNumber}\\]$`));

            settings.failSend = true;
            const bad = await svc.sendReply(org, r.ticketId, "Again", "Alex");
            assert.equal(bad.sent, false);
            assert.match(bad.reason, /SMTP said no/);
            settings.failSend = false;
        });

        await check("manual IMAP: turning on without the login filled in is refused, and so is polling", async () => {
            Object.assign(settings, { imap_host: "", imap_username: "", imap_password: null });
            await svc.save(org, { enabled: false });
            await assert.rejects(() => svc.save(org, { source: "imap", enabled: true }), /Tickets purpose/);
            await assert.rejects(() => svc.pollOne(org), /not filled in|not connected/);
        });

        await check("disconnecting forgets the sign-in and turns the mailbox off", async () => {
            const st = await svc.disconnect(org);
            assert.equal(st.enabled, false);
            assert.equal(st.connected, false);
            assert.equal(st.mailboxAddress, "");
        });
    } finally {
        await prisma.$executeRawUnsafe(`DELETE FROM email_messages WHERE channel_id IN (SELECT id FROM email_channels WHERE organization_id = '${org}' AND name = 'Support mailbox')`);
        await prisma.$executeRawUnsafe(`DELETE FROM email_channels WHERE organization_id = '${org}' AND name = 'Support mailbox'`);
        for (const id of made.tickets) await prisma.tickets.delete({ where: { id } }).catch(() => undefined);
        for (const id of made.portal) await prisma.portal_accounts.delete({ where: { id } }).catch(() => undefined);
        for (const id of made.clients) await prisma.clients.delete({ where: { id } }).catch(() => undefined);
        await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE organization_id = '${org}' AND email::text LIKE '%${stamp}@%'`);
        await prisma.support_mailbox.deleteMany({ where: { organization_id: org } });
        await prisma.$disconnect();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
