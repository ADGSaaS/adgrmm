#!/usr/bin/env node
// Devices on a ticket and the customer's contact as the person who asked, through the real HTTP API.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... node test/ticket-devices-contacts-http.e2e.cjs
"use strict";
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = Date.now();
    const tag = `TD${stamp}`;

    const tech = await staffUser("td-tech", ["tickets.read", "tickets.write", "devices.read", "customers.read"]);
    const reader = await staffUser("td-reader", ["tickets.read"]);
    const nobody = await staffUser("td-nobody", ["customers.read"]);
    const limited = await staffUser("td-limited", ["tickets.read", "tickets.write", "devices.read"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id;
        return { id, site };
    };
    const mkDevice = async (site, host, os = "Windows 11") => (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, host, os])).rows[0].id;
    const A = await mkClient("Alpha");
    const B = await mkClient("Bravo");
    const a1 = await mkDevice(A.site, `${tag}-A1`);
    const a2 = await mkDevice(A.site, `${tag}-A2`, "Ubuntu 24.04");
    const b1 = await mkDevice(B.site, `${tag}-B1`);
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);

    const open = (t, body) => call("/api/tickets", { method: "POST", token: t.token, body });
    const ticketId = async (body, t = tech) => {
        const r = await open(t, body);
        assert.equal(r.status, 201, `create: ${r.status}`);
        return (await r.json()).id;
    };
    const devicesOf = async (id, t = tech) => (await json(`/api/tickets/${id}/devices`, { token: t.token })).items;

    console.log("devices on a ticket");
    let t1;
    await test("a ticket made for a device links it, takes the customer and has it as the main device", async () => {
        t1 = await ticketId({ subject: `${tag} first`, deviceId: a1 });
        const items = await devicesOf(t1);
        assert.equal(items.length, 1);
        assert.equal(items[0].id, a1);
        assert.equal(items[0].isMain, true);
        assert.equal(items[0].hostname, `${tag}-A1`);
        assert.equal(items[0].os, "Windows 11");
        assert.equal(items[0].clientId, A.id);
        assert.equal(items[0].siteName, "Alpha HQ");
        assert.ok("status" in items[0] && "lastSeenAt" in items[0]);
        const t = await json(`/api/tickets/${t1}`, { token: tech.token });
        assert.equal(t.clientId, A.id);
        assert.equal(t.deviceCount, 1);
        assert.deepEqual(t.deviceNames, [`${tag}-A1`]);
    });

    await test("a second device of the same customer can be added; it is listed and the ticket counts both", async () => {
        const r = await call(`/api/tickets/${t1}/devices`, { method: "POST", token: tech.token, body: { deviceId: a2 } });
        assert.equal(r.status, 201);
        const items = await devicesOf(t1);
        assert.deepEqual(items.map((d) => d.hostname).sort(), [`${tag}-A1`, `${tag}-A2`]);
        assert.equal(items.find((d) => d.id === a1).isMain, true);
        assert.equal((await json(`/api/tickets/${t1}`, { token: tech.token })).deviceCount, 2);
        // adding it again changes nothing
        assert.equal((await call(`/api/tickets/${t1}/devices`, { method: "POST", token: tech.token, body: { deviceId: a2 } })).status, 201);
        assert.equal((await devicesOf(t1)).length, 2);
    });

    await test("a device of another customer is refused, and so are bad ids", async () => {
        const r = await call(`/api/tickets/${t1}/devices`, { method: "POST", token: tech.token, body: { deviceId: b1 } });
        assert.equal(r.status, 400);
        assert.match((await r.json()).message, /different customer/);
        assert.equal((await call(`/api/tickets/${t1}/devices`, { method: "POST", token: tech.token, body: { deviceId: uuid() } })).status, 400);
        assert.equal((await call(`/api/tickets/${t1}/devices`, { method: "POST", token: tech.token, body: { deviceId: "nope" } })).status, 400);
        assert.equal((await call(`/api/tickets/${t1}/devices`, { method: "POST", token: tech.token, body: {} })).status, 400);
        assert.equal((await devicesOf(t1)).length, 2);
    });

    await test("changing the main device through the ticket update is held to the same rule", async () => {
        const r = await call(`/api/tickets/${t1}`, { method: "PATCH", token: tech.token, body: { deviceId: b1 } });
        assert.equal(r.status, 400);
        assert.equal((await call(`/api/tickets/${t1}`, { method: "PATCH", token: tech.token, body: { clientId: B.id } })).status, 400, "the customer cannot move away from its devices");
    });

    await test("who may do what: reading needs tickets.read, changing needs tickets.write", async () => {
        assert.equal((await call(`/api/tickets/${t1}/devices`, { token: reader.token })).status, 200);
        assert.equal((await call(`/api/tickets/${t1}/devices`, { method: "POST", token: reader.token, body: { deviceId: a2 } })).status, 403);
        assert.equal((await call(`/api/tickets/${t1}/devices/${a2}`, { method: "DELETE", token: reader.token })).status, 403);
        assert.equal((await call(`/api/tickets/${t1}/devices`, { token: nobody.token })).status, 403);
        assert.equal((await call(`/api/tickets/${t1}/devices`)).status, 401);
    });

    await test("removing a device: the main one hands over to the next, and the history says so", async () => {
        assert.equal((await call(`/api/tickets/${t1}/devices/${a1}`, { method: "DELETE", token: tech.token })).status, 200);
        const items = await devicesOf(t1);
        assert.deepEqual(items.map((d) => d.id), [a2]);
        assert.equal(items[0].isMain, true);
        assert.equal((await json(`/api/tickets/${t1}`, { token: tech.token })).deviceId, a2);
        assert.equal((await call(`/api/tickets/${t1}/devices/${a1}`, { method: "DELETE", token: tech.token })).status, 404, "it is no longer on the ticket");
        const hist = (await json(`/api/tickets/${t1}/history`, { token: tech.token })).map((h) => h.what);
        assert.ok(hist.includes(`Device added: ${tag}-A2`), hist.join(" | "));
        assert.ok(hist.includes(`Device removed: ${tag}-A1`), hist.join(" | "));
        assert.equal((await call(`/api/tickets/${t1}/devices/${a2}`, { method: "DELETE", token: tech.token })).status, 200);
        assert.equal((await devicesOf(t1)).length, 0);
        assert.equal((await json(`/api/tickets/${t1}`, { token: tech.token })).deviceId, null);
    });

    await test("a ticket with no customer takes the customer of its first device", async () => {
        const id = await ticketId({ subject: `${tag} no customer` });
        assert.equal((await json(`/api/tickets/${id}`, { token: tech.token })).clientId, null);
        assert.equal((await call(`/api/tickets/${id}/devices`, { method: "POST", token: tech.token, body: { deviceId: b1 } })).status, 201);
        assert.equal((await json(`/api/tickets/${id}`, { token: tech.token })).clientId, B.id);
        assert.equal((await call(`/api/tickets/${id}/devices`, { method: "POST", token: tech.token, body: { deviceId: a1 } })).status, 400);
    });

    await test("a ticket can be opened with several devices; devices of two customers are refused and no ticket is left behind", async () => {
        const id = await ticketId({ subject: `${tag} many`, deviceIds: [a1, a2] });
        assert.equal((await devicesOf(id)).length, 2);
        const before = (await q(`SELECT count(*)::int AS n FROM tickets WHERE subject = $1`, [`${tag} mixed`])).rows[0].n;
        const r = await open(tech, { subject: `${tag} mixed`, deviceIds: [a1, b1] });
        assert.equal(r.status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM tickets WHERE subject = $1`, [`${tag} mixed`])).rows[0].n, before);
        assert.equal((await open(tech, { subject: `${tag} explicit`, clientId: B.id, deviceId: a1 })).status, 400, "an explicit customer must match the device");
    });

    await test("anything that opens a ticket with a device in the database links it (alerts, removal approvals)", async () => {
        const id = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject, device_id) VALUES ($1, (SELECT COALESCE(MAX(ticket_number),0)+1 FROM tickets WHERE organization_id=$1), $2, $3) RETURNING id`, [org, `${tag} direct`, a1])).rows[0].id;
        assert.deepEqual((await devicesOf(id)).map((d) => d.id), [a1]);
    });

    await test("a person limited to some customers can use only their customers' devices", async () => {
        const mine = await ticketId({ subject: `${tag} limited`, deviceId: a1 }, limited);
        assert.equal((await call(`/api/tickets/${mine}/devices`, { method: "POST", token: limited.token, body: { deviceId: b1 } })).status, 404);
        assert.equal((await open(limited, { subject: `${tag} limited B`, deviceId: b1 })).status, 404);
        assert.equal((await call(`/api/tickets/${t1}/devices`, { method: "POST", token: limited.token, body: { deviceId: b1 } })).status, 404);
        assert.equal((await call(`/api/devices/${b1}/tickets`, { token: limited.token })).status, 404);
        assert.equal((await call(`/api/devices/${a1}/tickets`, { token: limited.token })).status, 200);
    });

    console.log("a device's tickets, filters and search");
    let tOpen, tDone;
    await test("a device lists its open tickets first, then recent ones", async () => {
        tOpen = await ticketId({ subject: `${tag} open one`, deviceId: a1 });
        tDone = await ticketId({ subject: `${tag} done one`, deviceId: a1 });
        assert.equal((await call(`/api/tickets/${tDone}`, { method: "PATCH", token: tech.token, body: { status: "closed" } })).status, 200);
        const r = await json(`/api/devices/${a1}/tickets`, { token: tech.token });
        const mineOnly = r.items.filter((t) => t.id === tOpen || t.id === tDone);
        assert.equal(mineOnly[0].id, tOpen, "open before closed");
        assert.equal(mineOnly[1].id, tDone);
        assert.ok(r.openCount >= 1);
        assert.ok(r.items[0].number > 0 && r.items[0].title);
        assert.equal((await call(`/api/devices/${a1}/tickets`, { token: nobody.token })).status, 403);
    });

    await test("the ticket list filters by device and finds a ticket by the hostname of a linked device", async () => {
        const byDevice = await json(`/api/tickets?deviceId=${a1}&pageSize=200`, { token: tech.token });
        assert.ok(byDevice.some((t) => t.id === tOpen) && byDevice.some((t) => t.id === tDone));
        assert.ok(!byDevice.some((t) => t.id === t1), "t1 no longer has the device");
        assert.equal((await json(`/api/tickets?deviceId=${b1}&pageSize=200`, { token: tech.token })).every((t) => t.deviceNames.includes(`${tag}-B1`)), true);
        const found = await json(`/api/tickets?search=${encodeURIComponent(`${tag}-A1`)}&pageSize=200`, { token: tech.token });
        const hit = found.find((t) => t.id === tOpen);
        assert.ok(hit, "found by hostname");
        assert.equal(hit.match?.in, "device");
        assert.equal(hit.match?.snippet, `${tag}-A1`);
        assert.equal((await call(`/api/tickets?deviceId=nope`, { token: tech.token })).status, 400);
    });

    console.log("the contact who asked");
    let cAlice, cBob;
    await test("a customer's contacts can be searched and added from the ticket form", async () => {
        const made1 = await call("/api/ticket-contacts", { method: "POST", token: tech.token, body: { clientId: A.id, name: "Alice Adams", email: `Alice-${stamp}@alpha.test`, phone: "555 0100" } });
        assert.equal(made1.status, 201);
        cAlice = await made1.json();
        assert.equal(cAlice.email, `alice-${stamp}@alpha.test`);
        assert.equal(cAlice.isPrimary, true, "the first contact is the main one");
        cBob = await (await call("/api/ticket-contacts", { method: "POST", token: tech.token, body: { clientId: A.id, name: "Bob Brown" } })).json();
        const all = await json(`/api/ticket-contacts?clientId=${A.id}`, { token: tech.token });
        assert.deepEqual(all.items.map((c) => c.name), ["Alice Adams", "Bob Brown"]);
        assert.deepEqual((await json(`/api/ticket-contacts?clientId=${A.id}&q=bro`, { token: tech.token })).items.map((c) => c.name), ["Bob Brown"]);
        assert.deepEqual((await json(`/api/ticket-contacts?clientId=${A.id}&q=ALICE-${stamp}`, { token: tech.token })).items.map((c) => c.name), ["Alice Adams"]);
        assert.deepEqual((await json(`/api/ticket-contacts?clientId=${B.id}`, { token: tech.token })).items, []);
    });

    await test("the contact form checks its input: name, email, a duplicate email, the customer", async () => {
        const post = (body, t = tech) => call("/api/ticket-contacts", { method: "POST", token: t.token, body });
        assert.equal((await post({ clientId: A.id, name: "" })).status, 400);
        assert.equal((await post({ clientId: A.id, name: "X", email: "not-an-email" })).status, 400);
        assert.equal((await post({ clientId: "nope", name: "X" })).status, 400);
        assert.equal((await post({ clientId: uuid(), name: "X" })).status, 404);
        const dup = await post({ clientId: A.id, name: "Alice again", email: `ALICE-${stamp}@alpha.test` });
        assert.equal(dup.status, 409);
        assert.equal((await post({ clientId: A.id, name: "Rd" }, reader)).status, 403);
        assert.equal((await call(`/api/ticket-contacts?clientId=${A.id}`, { token: nobody.token })).status, 403);
        // a limited person does not see another customer's contacts, nor add to them
        assert.equal((await call(`/api/ticket-contacts?clientId=${B.id}`, { token: limited.token })).status, 404);
        assert.equal((await post({ clientId: B.id, name: "Sneaky" }, limited)).status, 404);
        assert.equal((await call(`/api/ticket-contacts?clientId=${A.id}`, { token: limited.token })).status, 200);
    });

    let tc;
    await test("a ticket can be opened for a contact: the customer follows, and name, email and phone show on the ticket", async () => {
        tc = await ticketId({ subject: `${tag} for alice`, requesterCustomerContactId: cAlice.id });
        const t = await json(`/api/tickets/${tc}`, { token: tech.token });
        assert.equal(t.clientId, A.id);
        assert.equal(t.requesterCustomerContactId, cAlice.id);
        assert.equal(t.requesterContact.name, "Alice Adams");
        assert.equal(t.requesterContact.phone, "555 0100");
        assert.equal(t.requesterName, "Alice Adams");
        assert.equal(t.requesterEmail, `alice-${stamp}@alpha.test`);
        const inList = (await json(`/api/tickets?pageSize=200`, { token: tech.token })).find((x) => x.id === tc);
        assert.equal(inList.requesterName, "Alice Adams");
    });

    await test("the contact has to be of the ticket's customer", async () => {
        const other = (await q(`INSERT INTO customer_contacts (client_id, name, email) VALUES ($1,'Zed Zulu','zed@bravo.test') RETURNING id`, [B.id])).rows[0].id;
        assert.equal((await open(tech, { subject: `${tag} wrong`, clientId: A.id, requesterCustomerContactId: other })).status, 400);
        assert.equal((await open(tech, { subject: `${tag} wrong 2`, deviceId: a1, requesterCustomerContactId: other })).status, 400);
        assert.equal((await call(`/api/tickets/${tc}`, { method: "PATCH", token: tech.token, body: { requesterCustomerContactId: other } })).status, 400);
        assert.equal((await call(`/api/tickets/${tc}`, { method: "PATCH", token: tech.token, body: { requesterCustomerContactId: uuid() } })).status, 400);
        assert.equal((await json(`/api/tickets/${tc}`, { token: tech.token })).requesterCustomerContactId, cAlice.id);
    });

    await test("the contact can be changed and cleared, with history; tickets are listed by contact", async () => {
        assert.equal((await call(`/api/tickets/${tc}`, { method: "PATCH", token: tech.token, body: { requesterCustomerContactId: cBob.id } })).status, 200);
        assert.equal((await json(`/api/tickets/${tc}`, { token: tech.token })).requesterContact.name, "Bob Brown");
        const byContact = await json(`/api/tickets?contactId=${cBob.id}`, { token: tech.token });
        assert.deepEqual(byContact.map((t) => t.id), [tc]);
        assert.deepEqual(await json(`/api/tickets?contactId=${cAlice.id}`, { token: tech.token }), []);
        assert.equal((await call(`/api/tickets/${tc}`, { method: "PATCH", token: tech.token, body: { requesterCustomerContactId: null } })).status, 200);
        const t = await json(`/api/tickets/${tc}`, { token: tech.token });
        assert.equal(t.requesterContact, null);
        const hist = (await json(`/api/tickets/${tc}/history`, { token: tech.token })).map((h) => h.what);
        assert.ok(hist.includes("requester: Alice Adams -> Bob Brown"), hist.join(" | "));
        assert.ok(hist.includes("requester: Bob Brown -> -"), hist.join(" | "));
    });

    await test("search finds a ticket by the contact's name", async () => {
        assert.equal((await call(`/api/tickets/${tc}`, { method: "PATCH", token: tech.token, body: { requesterCustomerContactId: cAlice.id } })).status, 200);
        const found = await json(`/api/tickets?search=${encodeURIComponent("Alice Adams")}&pageSize=200`, { token: tech.token });
        assert.equal(found.find((t) => t.id === tc)?.match?.in, "requester");
    });

    await test("deleting a contact from the customer record leaves the ticket, without a requester", async () => {
        const tmp = (await q(`INSERT INTO customer_contacts (client_id, name) VALUES ($1,'Temp Person') RETURNING id`, [A.id])).rows[0].id;
        const id = await ticketId({ subject: `${tag} temp`, requesterCustomerContactId: tmp });
        await q(`DELETE FROM customer_contacts WHERE id = $1`, [tmp]);
        const t = await json(`/api/tickets/${id}`, { token: tech.token });
        assert.equal(t.requesterCustomerContactId, null);
        assert.equal(t.clientId, A.id);
    });

    await test("audit: adding and removing a device and adding a contact are recorded", async () => {
        const rows = (await q(`SELECT action FROM audit_events WHERE action IN ('ticket.device.add','ticket.device.remove','ticket.contact.create') AND created_at > now() - interval '10 minutes'`)).rows.map((r) => r.action);
        for (const a of ["ticket.device.add", "ticket.device.remove", "ticket.contact.create"]) assert.ok(rows.includes(a), `${a} in ${rows.join(",")}`);
    });

    await q(`DELETE FROM tickets WHERE subject LIKE $1`, [`${tag}%`]);
    await q(`DELETE FROM user_client_access WHERE user_id = $1`, [limited.id]);
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
