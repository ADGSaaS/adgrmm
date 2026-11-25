#!/usr/bin/env node
// Custom fields for tickets, through the real HTTP API: defining them, filling them in on a ticket (create and edit),
// required fields, search and filters, history, the audit log, the client portal (only fields marked visible), the
// Tickets report and that customer custom fields are untouched.
//
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../riq_x_e2e JWT_SECRET=... node test/ticket-custom-fields-http.e2e.cjs
"use strict";
const bcrypt = require("bcryptjs");
const { assert, call, json, runner, setup } = require("./groupc-helpers.cjs");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = Date.now();

    const admin = await staffUser("tcf-admin", ["settings.read", "settings.write", "customers.read", "customers.write", "tickets.read", "tickets.write", "audit.read", "reports.read", "devices.read"]);
    const tech = await staffUser("tcf-tech", ["tickets.read", "tickets.write"]);
    const reader = await staffUser("tcf-reader", ["tickets.read"]);
    const noTickets = await staffUser("tcf-none", ["customers.read", "devices.read"]);
    const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `TCF Customer ${stamp}`])).rows[0].id;
    made.clients.push(client);
    await q(`DELETE FROM custom_field_defs WHERE entity = 'ticket'`);

    const def = (body) => call("/api/ticket-custom-fields", { method: "POST", token: admin.token, body });
    let contract, warranty, tier, onsite, link, hidden;

    await test("only people with the settings right can define ticket fields; people who read tickets can list them", async () => {
        assert.equal((await call("/api/ticket-custom-fields", { method: "POST", token: tech.token, body: { label: "X", type: "text" } })).status, 403);
        assert.equal((await call("/api/ticket-custom-fields", { token: reader.token })).status, 200);
        assert.equal((await call("/api/ticket-custom-fields", { token: noTickets.token })).status, 403);
        assert.equal((await call("/api/ticket-custom-fields")).status, 401);
    });

    await test("each type can be defined, with a key made from its name", async () => {
        contract = await (await def({ label: "Contract number", type: "text", required: true, help: "From the contract" })).json();
        assert.equal(contract.key, "contract_number");
        assert.equal(contract.visibleToCustomer, false);
        warranty = await (await def({ label: "Warranty ends", type: "date" })).json();
        tier = await (await def({ label: "Support tier", type: "dropdown", options: ["Gold", "Silver", "Bronze"] })).json();
        onsite = await (await def({ label: "On site", type: "checkbox" })).json();
        link = await (await def({ label: "Vendor case", type: "url", visibleToCustomer: true })).json();
        hidden = await (await def({ label: "Budget", type: "number" })).json();
        assert.equal(link.visibleToCustomer, true);
        assert.equal((await def({ label: "contract NUMBER", type: "text" })).status, 409);
        assert.equal((await def({ label: "Bad", type: "dropdown", options: [] })).status, 400);
        assert.equal((await def({ label: "Bad", type: "color" })).status, 400);
        const list = (await json("/api/ticket-custom-fields", { token: reader.token })).items;
        assert.deepEqual(list.map((f) => f.key), ["contract_number", "warranty_ends", "support_tier", "on_site", "vendor_case", "budget"]);
    });

    await test("ticket fields and customer fields are separate sets", async () => {
        const customers = (await json("/api/custom-fields", { token: admin.token })).items;
        assert.ok(!customers.some((f) => f.label === "Contract number" && f.id === contract.id));
        const other = await (await call("/api/custom-fields", { method: "POST", token: admin.token, body: { label: "Contract number", type: "text" } })).json();
        assert.equal(other.key, "contract_number"); // the same name is allowed on the other side
        assert.equal(other.visibleToCustomer, false);
        assert.equal((await call(`/api/ticket-custom-fields/${other.id}`, { method: "PATCH", token: admin.token, body: { label: "Hijack" } })).status, 404);
        assert.equal((await call(`/api/custom-fields/${contract.id}`, { method: "PATCH", token: admin.token, body: { label: "Hijack" } })).status, 404);
        await call(`/api/custom-fields/${other.id}`, { method: "DELETE", token: admin.token });
        await q(`DELETE FROM custom_field_defs WHERE id = $1`, [other.id]);
    });

    let ticketId;
    await test("a required field must be filled in on the new-ticket form", async () => {
        const res = await call("/api/tickets", { method: "POST", token: tech.token, body: { subject: "GC missing required", clientId: client } });
        assert.equal(res.status, 400);
        assert.match((await res.json()).message, /Contract number is required/);
        const res2 = await call("/api/tickets", { method: "POST", token: tech.token, body: { subject: "GC bad value", clientId: client, customFields: { contract_number: "C-1", support_tier: "Platinum" } } });
        assert.equal(res2.status, 400);
        const res3 = await call("/api/tickets", { method: "POST", token: tech.token, body: { subject: "GC unknown", clientId: client, customFields: { contract_number: "C-1", nope: "x" } } });
        assert.equal(res3.status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM tickets WHERE subject LIKE 'GC %'`)).rows[0].n, 0);
    });

    await test("a ticket is made with values, which are cleaned and kept", async () => {
        const res = await call("/api/tickets", { method: "POST", token: tech.token, body: { subject: "GC with fields", clientId: client, customFields: { contract_number: "  C-100  ", warranty_ends: "2027-03-01", support_tier: "gold", on_site: true, vendor_case: "vendor.example.com/case/9", budget: "1,500" } } });
        assert.equal(res.status, 201);
        ticketId = (await res.json()).id;
        const t = await json(`/api/tickets/${ticketId}`, { token: reader.token });
        assert.deepEqual(t.customFields, { contract_number: "C-100", warranty_ends: "2027-03-01", support_tier: "Gold", on_site: true, vendor_case: "https://vendor.example.com/case/9", budget: 1500 });
    });

    await test("tickets opened by the system (an alert) are not blocked by a required field", async () => {
        const row = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject) VALUES ($1,(SELECT COALESCE(MAX(ticket_number),0)+1 FROM tickets WHERE organization_id=$1),'GC system') RETURNING custom_fields`, [org])).rows[0];
        assert.deepEqual(row.custom_fields, {});
    });

    await test("editing changes only what was sent, checks values, and writes the history", async () => {
        assert.equal((await call(`/api/tickets/${ticketId}`, { method: "PATCH", token: tech.token, body: { customFields: { support_tier: "Silver", on_site: false } } })).status, 200);
        const t = await json(`/api/tickets/${ticketId}`, { token: reader.token });
        assert.equal(t.customFields.support_tier, "Silver");
        assert.equal(t.customFields.contract_number, "C-100");
        assert.equal(t.customFields.on_site, false);
        assert.equal((await call(`/api/tickets/${ticketId}`, { method: "PATCH", token: tech.token, body: { customFields: { contract_number: "" } } })).status, 400); // required
        assert.equal((await call(`/api/tickets/${ticketId}`, { method: "PATCH", token: tech.token, body: { customFields: { warranty_ends: "2027-02-30" } } })).status, 400);
        assert.equal((await call(`/api/tickets/${ticketId}`, { method: "PATCH", token: tech.token, body: { customFields: { budget: "lots" } } })).status, 400);
        assert.equal((await call(`/api/tickets/${ticketId}`, { method: "PATCH", token: tech.token, body: { subject: "GC with fields (renamed)" } })).status, 200); // other edits need no fields
        assert.equal((await call(`/api/tickets/${ticketId}`, { method: "PATCH", token: reader.token, body: { customFields: { support_tier: "Gold" } } })).status, 403);
        const history = (await json(`/api/tickets/${ticketId}/history`, { token: reader.token })).map((h) => h.what);
        assert.ok(history.includes("Support tier: Gold -> Silver"), history.join(" | "));
        assert.ok(history.includes("On site: Yes -> No"), history.join(" | "));
    });

    await test("archiving a field hides it and refuses new values, and restoring brings the values back", async () => {
        assert.equal((await call(`/api/ticket-custom-fields/${hidden.id}`, { method: "DELETE", token: admin.token })).status, 200);
        assert.equal((await call(`/api/tickets/${ticketId}`, { method: "PATCH", token: tech.token, body: { customFields: { budget: 5 } } })).status, 400);
        assert.ok(!(await json("/api/ticket-custom-fields", { token: reader.token })).items.some((f) => f.key === "budget"));
        assert.equal((await call(`/api/ticket-custom-fields/${hidden.id}`, { method: "PATCH", token: admin.token, body: { active: true } })).status, 200);
        assert.equal((await json(`/api/tickets/${ticketId}`, { token: reader.token })).customFields.budget, 1500);
    });

    await test("ticket search looks in field values; filters pick tickets by one field", async () => {
        const list = await json(`/api/tickets?search=C-100`, { token: reader.token });
        const hit = list.find((t) => t.id === ticketId);
        assert.ok(hit, "found by a custom value");
        assert.equal(hit.match?.in, "custom field");
        assert.equal((await json(`/api/tickets?search=C-10_`, { token: reader.token })).length, 0); // _ is a character, not a wildcard
        assert.deepEqual((await json(`/api/tickets?customField=support_tier&customValue=silver`, { token: reader.token })).map((t) => t.id), [ticketId]);
        assert.deepEqual(await json(`/api/tickets?customField=support_tier&customValue=gold`, { token: reader.token }), []);
        assert.deepEqual(await json(`/api/tickets?customField=${encodeURIComponent("x'); drop table tickets;--")}&customValue=1`, { token: reader.token }), []);
        const g = await json(`/api/search?q=C-100`, { token: admin.token });
        assert.ok(JSON.stringify(g).includes(ticketId), "global search finds it");
    });

    await test("changes to the definitions and to values are in the audit log", async () => {
        const rows = (await q(`SELECT action FROM audit_events WHERE action LIKE 'ticket_custom_field.%' OR (action = 'ticket.update' AND target_id = $1)`, [ticketId])).rows.map((r) => r.action);
        for (const a of ["ticket_custom_field.create", "ticket_custom_field.update", "ticket_custom_field.archive", "ticket.update"]) assert.ok(rows.includes(a), `missing ${a}: ${rows}`);
    });

    await test("the Tickets report exists and has a column per field", async () => {
        const res = await call("/api/reports/run/ticket-list?format=json", { token: admin.token });
        assert.equal(res.status, 200);
        const report = await res.json();
        const cols = Object.fromEntries(report.columns.map((c) => [c.key, c]));
        assert.equal(cols.cf_contract_number.label, "Contract number");
        assert.equal(cols.cf_budget.type, "number");
        assert.equal(cols.cf_warranty_ends.type, "date");
        const row = report.rows.find((r) => r.subject.startsWith("GC with fields"));
        assert.equal(row.cf_contract_number, "C-100");
        assert.equal(row.cf_support_tier, "Silver");
        assert.equal(row.cf_on_site, "No");
        assert.equal(row.cf_budget, 1500);
        assert.ok(report.charts.some((c) => c.key === "cf_support_tier"));
        const csv = await call("/api/reports/run/ticket-list?format=csv", { token: admin.token });
        assert.match(await csv.text(), /Contract number/);
        // A person who cannot read tickets is refused.
        assert.equal((await call("/api/reports/run/ticket-list?format=json", { token: noTickets.token })).status, 403);
    });

    await test("the client portal shows only fields marked visible to the customer, and only with a value", async () => {
        await call("/api/portal-admin/settings", { method: "PUT", token: admin.token, body: { enabled: true, domain: `tcf-${stamp}.example.test` } });
        const email = `tcf-${stamp}@portal.example.test`;
        const acct = (await q(`INSERT INTO portal_accounts (organization_id, client_id, email, name, role, status, password_hash) VALUES ($1,$2,$3,'Portal Person','manager','active',$4) RETURNING id`, [org, client, email, await bcrypt.hash("correct horse battery", 4)])).rows[0].id;
        const login = await call("/api/portal/auth/login", { method: "POST", body: { email, password: "correct horse battery" } });
        assert.equal(login.status, 200);
        const portal = (login.headers.getSetCookie?.() ?? []).map((c) => c.match(/^portal_token=([^;]*)/)?.[1]).find(Boolean);
        const t = await json(`/api/portal/tickets/${ticketId}`, { portal });
        assert.deepEqual(t.customFields, [{ label: "Vendor case", type: "url", value: "https://vendor.example.com/case/9" }]);
        assert.ok(!JSON.stringify(t).includes("C-100"), "a field not marked visible stays inside");
        await call(`/api/ticket-custom-fields/${tier.id}`, { method: "PATCH", token: admin.token, body: { visibleToCustomer: true } });
        assert.deepEqual((await json(`/api/portal/tickets/${ticketId}`, { portal })).customFields.map((f) => f.label), ["Support tier", "Vendor case"]);
        await call(`/api/ticket-custom-fields/${tier.id}`, { method: "PATCH", token: admin.token, body: { visibleToCustomer: false } });
        assert.equal((await json(`/api/portal/tickets/${ticketId}`, { portal })).customFields.length, 1);
        await q(`DELETE FROM portal_accounts WHERE id = $1`, [acct]);
    });

    await test("reordering keeps the order asked for", async () => {
        const items = (await json("/api/ticket-custom-fields", { token: admin.token })).items;
        const ids = items.map((f) => f.id).reverse();
        const res = await (await call("/api/ticket-custom-fields/reorder", { method: "POST", token: admin.token, body: { ids } })).json();
        assert.deepEqual(res.items.filter((f) => f.active).map((f) => f.id), ids);
    });

    await q(`DELETE FROM custom_field_defs WHERE entity = 'ticket'`);
    await q(`DELETE FROM portal_settings`);
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
