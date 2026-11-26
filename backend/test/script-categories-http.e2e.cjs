#!/usr/bin/env node
// Script categories and editable built-in scripts through the real HTTP API: the list of categories with counts, the SEPARATE right to make
// and delete categories (anyone who writes scripts may put a script in an existing one), the checks on a category name, assigning and
// changing a category on a script, deleting a category only when it is empty, and editing, resetting and deleting built-in scripts.
// The server must run with built-in seeding ON (the default).
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3983 DATABASE_URL=postgres://.../adg_cat_e2e JWT_SECRET=... node test/script-categories-http.e2e.cjs
"use strict";
const { assert, call, runner, setup } = require("./groupc-helpers.cjs");

async function main() {
    const { q, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `CT${Date.now()}`;

    const reader = await staffUser("ct-reader", ["automation.read"]);
    const scripter = await staffUser("ct-scripter", ["automation.read", "automation.run"]);
    const manager = await staffUser("ct-manager", ["automation.read", "automation.run", "automation.categories.manage"]);
    const onlyManage = await staffUser("ct-onlymanage", ["automation.read", "automation.categories.manage"]);

    const S = (path, t, body, method = "POST") => call(`/api/scripts${path}`, { method, token: t?.token, body });
    const ok = async (path, t, body, method = "POST", status = 200) => {
        const r = await S(path, t, body, method);
        assert.equal(r.status, status, `${method} ${path}: ${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`);
        return r.json();
    };
    const cats = async () => (await ok("/categories", reader, undefined, "GET")).items;
    const scriptBody = (name, extra = {}) => ({ name: `${tag} ${name}`, language: "bash", script: "echo hi", ...extra });

    console.log("the list");
    await test("the built-in categories come first with their counts, and nothing is uncategorized yet", async () => {
        const r = await ok("/categories", reader, undefined, "GET");
        assert.deepEqual(r.items.slice(0, 9).map((c) => c.name), ["Diagnostics", "Maintenance", "Security", "Network", "Users and accounts", "Software and updates", "Storage and disk", "Services and processes", "Inventory and reporting"]);
        assert.ok(r.items.slice(0, 9).every((c) => c.builtin === true && c.id === null && c.count > 0), JSON.stringify(r.items.slice(0, 3)));
        assert.equal(r.items.slice(0, 9).reduce((n, c) => n + c.count, 0), require(require("node:path").join(__dirname, "..", process.env.DIST || "dist", "automation/builtin-scripts.js")).ALL_BUILTIN_SCRIPTS.length, "every built-in script is in a category");
        assert.equal(r.uncategorized, 0);
    });

    console.log("who may make categories");
    await test("making or deleting a category needs its own right: writing scripts, or only reading them, is not enough", async () => {
        assert.equal((await S("/categories", reader, { name: `${tag} A` })).status, 403);
        assert.equal((await S("/categories", scripter, { name: `${tag} A` })).status, 403);
        assert.equal((await S(`/categories/${"00000000-0000-4000-8000-000000000000"}`, scripter, undefined, "DELETE")).status, 403);
        assert.ok([401, 403].includes((await S("/categories", undefined, { name: "x" })).status));
        assert.equal((await S("/categories", reader, undefined, "GET")).status, 200, "everyone who reads scripts can read the categories");
    });
    let mineA;
    await test("the manager makes one; it is listed with no scripts; the person who can only manage categories cannot write scripts", async () => {
        mineA = await ok("/categories", manager, { name: `  ${tag}   Client  A  ` }, "POST", 201);
        assert.equal(mineA.name, `${tag} Client A`, "spaces are tidied");
        assert.equal(mineA.builtin, false); assert.equal(mineA.count, 0); assert.match(mineA.id, /^[0-9a-f-]{36}$/);
        const listed = (await cats()).find((c) => c.id === mineA.id);
        assert.ok(listed && listed.count === 0 && listed.builtin === false);
        assert.equal((await S("", onlyManage, scriptBody("nope"))).status, 403, "automation.run is what writes scripts");
    });

    console.log("the name");
    await test("a bad name is refused: empty, too long, control characters, a built-in name in any case; a repeat is a 409 in any case", async () => {
        assert.equal((await S("/categories", manager, { name: "   " })).status, 400);
        assert.equal((await S("/categories", manager, { name: "x".repeat(61) })).status, 400);
        assert.equal((await S("/categories", manager, { name: "bad\u0007name" })).status, 400);
        assert.equal((await S("/categories", manager, { name: "a<b>" })).status, 400);
        assert.equal((await S("/categories", manager, { name: "NETWORK" })).status, 400, "built-in names are taken");
        assert.equal((await S("/categories", manager, {})).status, 400);
        assert.equal((await S("/categories", manager, { name: `${tag} client a` })).status, 409, "the same name in another case");
    });

    console.log("giving a script a category");
    let s1;
    await test("anyone who writes scripts can put a script in an existing category (their spelling is corrected), and it shows in the counts", async () => {
        s1 = await ok("", scripter, scriptBody("one", { category: `${tag.toLowerCase()} client a` }), "POST", 201);
        assert.equal(s1.category, `${tag} Client A`);
        assert.equal((await cats()).find((c) => c.id === mineA.id).count, 1);
        const inNetwork = await ok("", scripter, scriptBody("two", { category: "network" }), "POST", 201);
        assert.equal(inNetwork.category, "Network");
        const none = await ok("", scripter, scriptBody("three"), "POST", 201);
        assert.equal(none.category, null);
        assert.equal((await ok("/categories", reader, undefined, "GET")).uncategorized, 1);
    });
    await test("a category that does not exist is refused (a script cannot invent one), on create and on update", async () => {
        const r = await S("", scripter, scriptBody("four", { category: "Made up" }));
        assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /no category called/);
        assert.equal((await S(`/${s1.id}`, scripter, scriptBody("one", { category: "Nope" }), "PUT")).status, 400);
    });
    await test("changing and clearing the category on update", async () => {
        const moved = await ok(`/${s1.id}`, scripter, scriptBody("one", { category: "Security" }), "PUT");
        assert.equal(moved.category, "Security");
        const cleared = await ok(`/${s1.id}`, scripter, scriptBody("one", { category: "" }), "PUT");
        assert.equal(cleared.category, null);
        const back = await ok(`/${s1.id}`, scripter, scriptBody("one", { category: `${tag} Client A` }), "PUT");
        assert.equal(back.category, `${tag} Client A`);
    });

    console.log("deleting a category");
    await test("only an empty category can be deleted; a missing one is a 404", async () => {
        const r = await S(`/categories/${mineA.id}`, manager, undefined, "DELETE");
        assert.equal(r.status, 409); assert.match(JSON.stringify(await r.json()), /scripts? (is|are) in/);
        await ok(`/${s1.id}`, scripter, scriptBody("one"), "PUT");
        assert.deepEqual(await ok(`/categories/${mineA.id}`, manager, undefined, "DELETE"), { id: mineA.id, deleted: true });
        assert.equal((await cats()).some((c) => c.id === mineA.id), false);
        assert.equal((await S(`/categories/${mineA.id}`, manager, undefined, "DELETE")).status, 404);
        assert.equal((await S("/categories/not-a-uuid", manager, undefined, "DELETE")).status, 400);
    });

    console.log("built-in scripts");
    await test("a built-in script can be edited by a person who writes scripts: it becomes customized and keeps its identity; reset puts it back", async () => {
        const all = (await ok("", reader, undefined, "GET")).items;
        const b = all.find((x) => x.builtin && x.language === "bash");
        assert.ok(b && b.customized === false);
        const edited = await ok(`/${b.id}`, scripter, { name: b.name, description: "mine", language: "bash", script: "echo mine", category: "Maintenance" }, "PUT");
        assert.equal(edited.builtin, true); assert.equal(edited.customized, true); assert.equal(edited.script, "echo mine"); assert.equal(edited.category, "Maintenance");
        const reset = await ok(`/${b.id}/reset`, scripter, {}, "POST", 201);
        assert.equal(reset.customized, false); assert.equal(reset.script, b.script); assert.equal(reset.category, b.category);
        assert.equal((await S(`/${b.id}/reset`, reader, {})).status, 403);
        assert.equal((await S(`/${s1.id}/reset`, scripter, {})).status, 409, "a script that is not built in has no original");
    });
    await test("a built-in script can be deleted, and Restore brings it back as shipped", async () => {
        const b = (await ok("", reader, undefined, "GET")).items.find((x) => x.builtin && x.language === "bash");
        await ok(`/${b.id}`, scripter, undefined, "DELETE");
        assert.equal((await ok("", reader, undefined, "GET")).items.some((x) => x.id === b.id), false);
        const r = await ok("/restore-builtin", scripter, {}, "POST", 201);
        assert.equal(r.created, 1);
        assert.ok((await ok("", reader, undefined, "GET")).items.some((x) => x.name === b.name && x.builtin && !x.customized));
    });

    console.log("the audit trail");
    await test("making and deleting a category are recorded", async () => {
        const rows = await q(`SELECT action FROM audit_events WHERE action IN ('script.category.create','script.category.delete') ORDER BY created_at DESC LIMIT 5`);
        const acts = rows.rows.map((r) => r.action);
        assert.ok(acts.includes("script.category.create") && acts.includes("script.category.delete"), JSON.stringify(acts));
    });

    await q(`DELETE FROM automations WHERE name LIKE $1`, [`${tag}%`]).catch(() => { });
    await q(`DELETE FROM script_categories WHERE name LIKE $1`, [`${tag}%`]).catch(() => { });
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
