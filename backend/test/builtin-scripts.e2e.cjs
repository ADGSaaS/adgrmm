// The built-in scripts in the application against a real database (no HTTP): seeding, running it again, protection from edits and deletes,
// duplicating, restoring, a person's own script with a built-in's name, a person's edit surviving a newer shipped text, and the switch that
// turns the boot run off. Throwaway database only (name has "e2e").
"use strict";

const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.SECURITY_SCANS_AUTOMATION_ENABLED = "false";
process.env.SECURITY_SCANS_POLLER_ENABLED = "false";
process.env.DEVICE_SECRETS_AUTOMATION_ENABLED = "false";
process.env.SNMP_POLLER_ENABLED = "false";
process.env.NETWORK_DISCOVERY_SCHEDULER_ENABLED = "false";
process.env.NETWORK_DISCOVERY_POLLER_ENABLED = "false";
process.env.BUILTIN_SCRIPTS_SEEDING = "false"; // the test seeds by hand, so it controls when
process.env.NODE_ENV = "development";

let passed = 0, failed = 0;
function check(name, ok, extra) {
    if (ok) passed++; else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e?.response?.message ?? e?.message ?? e)) ? (e?.status ?? e?.getStatus?.() ?? true) : false; } };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { OrganizationContextService } = require(path.join(dist, "storage/organization-context.service.js"));
    const { ScriptsService } = require(path.join(dist, "automation/scripts.service.js"));
    const { ScriptsController } = require(path.join(dist, "automation/scripts.controller.js"));
    const { BuiltinScriptsService } = require(path.join(dist, "automation/builtin-scripts.service.js"));
    const { ALL_BUILTIN_SCRIPTS: BUILTIN_SCRIPTS, textHash } = require(path.join(dist, "automation/builtin-scripts.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const orgs = app.get(OrganizationContextService, { strict: false });
    const scripts = app.get(ScriptsService, { strict: false });
    const builtin = app.get(BuiltinScriptsService, { strict: false });
    const controller = app.get(ScriptsController, { strict: false });
    const org = await orgs.getDefaultOrganizationId();
    const N = BUILTIN_SCRIPTS.length;
    const rows = () => prisma.automations.findMany({ where: { organization_id: org, type: "script" } });
    const builtinRows = async () => (await rows()).filter((r) => r.configuration?.builtin === true);
    const rowOf = async (key) => (await builtinRows()).find((r) => r.configuration.builtinKey === key);
    // start clean of anything a previous run left
    await prisma.automations.deleteMany({ where: { organization_id: org, type: "script", OR: [{ name: { contains: "(copy" } }, { name: { startsWith: "Zz mine " } }] } });
    await prisma.automations.deleteMany({ where: { organization_id: org, type: "script" } });

    console.log("seeding");
    const first = await builtin.seed();
    check(`a first run adds all ${N} scripts to the scripts table`, first.created === N && first.updated === 0 && first.skipped.length === 0 && (await builtinRows()).length === N, first);
    check("each one carries its key, category, version, a hash of its text, and the language, timeout and parameters the runner reads", (await builtinRows()).every((r) => {
        const b = BUILTIN_SCRIPTS.find((x) => x.key === r.configuration.builtinKey);
        return b && r.name === b.name && r.script === b.script && r.configuration.builtinHash === textHash(b.script) && r.configuration.category === b.category
            && r.configuration.language === b.language && r.configuration.timeoutSec === b.timeoutSec && Array.isArray(r.configuration.parameters) && r.configuration.builtinVersion >= 1 && r.type === "script";
    }));
    const again = await builtin.seed();
    check("running it again changes nothing (idempotent, so every boot is safe)", again.created === 0 && again.updated === 0 && again.unchanged === N && again.skipped.length === 0, again);
    const before = (await rows()).map((r) => `${r.id}:${r.updated_at.getTime()}`).sort().join();
    await builtin.seed();
    check("and does not even touch the rows (no updated_at moves)", (await rows()).map((r) => `${r.id}:${r.updated_at.getTime()}`).sort().join() === before);

    console.log("what the list shows");
    const list = (await scripts.list()).items;
    const one = list.find((x) => x.name === BUILTIN_SCRIPTS[0].name);
    check("the list says which scripts are built in and their category, and the run settings are intact", list.length === N && list.every((x) => x.builtin === true && typeof x.category === "string") && one.language === BUILTIN_SCRIPTS[0].language && one.timeoutSec === BUILTIN_SCRIPTS[0].timeoutSec, one);

    console.log("built-in scripts can be edited, reset and deleted");
    const target = list.find((x) => x.name === "Restart a service (Windows, changes the device)");
    const edit = { name: target.name, description: "x", language: "powershell", script: "Write-Output 'changed'" };
    const spare = BUILTIN_SCRIPTS.find((b) => b.key.startsWith("lin-") && !["lin-top-processes", "lin-docker-status"].includes(b.key));
    const spareRow0 = await rowOf(spare.key);
    const editedBuiltin = await scripts.update(spareRow0.id, { name: spare.name, description: "my words", language: "bash", script: "echo 'my own version'", category: "Network", parameters: [] });
    check("editing a built-in works: it keeps being a built-in, now shows as customized, with the new text and category", editedBuiltin.builtin === true && editedBuiltin.customized === true && editedBuiltin.script === "echo 'my own version'" && editedBuiltin.category === "Network", editedBuiltin);
    const mineRow = await rowOf(spare.key);
    check("it keeps its identity (the key stays, so it is still found as that built-in) and is marked customized", mineRow.configuration.builtinKey === spare.key && mineRow.configuration.customized === true && mineRow.configuration.builtin === true, mineRow.configuration);
    const seedAfterEdit = await builtin.seed();
    check("seeding leaves an edited built-in alone and says so", (await rowOf(spare.key)).script === "echo 'my own version'" && seedAfterEdit.updated === 0 && seedAfterEdit.skipped.some((x) => x.key === spare.key), seedAfterEdit);
    const back = await scripts.reset(spareRow0.id);
    check("reset puts the shipped name, text, settings and category back, and it is no longer customized", back.script === spare.script && back.customized === false && back.category === spare.category && back.description === spare.description, back);
    check("after a reset seeding follows newer shipped texts again (nothing to do now)", (await builtin.seed()).skipped.every((x) => x.key !== spare.key));
    const cross = BUILTIN_SCRIPTS.find((b) => b.key === "all-system-summary");
    const crossRow = await rowOf(cross.key);
    check("a script for all three systems is stored with its three texts and shown with all three", crossRow.configuration.platform === "all" && crossRow.configuration.linuxScript === cross.linuxScript && crossRow.configuration.macosScript === cross.macosScript && crossRow.script === cross.script);
    const crossShown = (await scripts.list()).items.find((x) => x.name === cross.name);
    check("the list shows platform all with the Linux and macOS texts", crossShown.platform === "all" && crossShown.linuxScript === cross.linuxScript && crossShown.macosScript === cross.macosScript && crossShown.language === "powershell", crossShown);
    const crossEdit = await scripts.update(crossRow.id, { name: cross.name, language: "powershell", platform: "all", script: cross.script, linuxScript: cross.linuxScript, macosScript: cross.macosScript + "# mine", parameters: [] });
    check("editing only its macOS text makes it customized, and the macOS text is what was saved", crossEdit.customized === true && crossEdit.macosScript.endsWith("# mine"), crossEdit);
    check("a script for all systems without its macOS text is refused", (await fails(() => scripts.update(crossRow.id, { name: cross.name, language: "powershell", platform: "all", script: cross.script, linuxScript: cross.linuxScript, parameters: [] }), /macOS/)) === 400);
    const crossBack = await scripts.reset(crossRow.id);
    check("reset brings back all three shipped texts", crossBack.customized === false && crossBack.macosScript === cross.macosScript && crossBack.linuxScript === cross.linuxScript && crossBack.script === cross.script, crossBack);
    check("an unknown id is a plain 404 for update, reset and delete", (await fails(() => scripts.update("00000000-0000-4000-8000-000000000000", edit), /not found/i)) === 404 && (await fails(() => scripts.reset("00000000-0000-4000-8000-000000000000"), /not found/i)) === 404 && (await fails(() => scripts.remove("00000000-0000-4000-8000-000000000000"), /not found/i)) === 404);
    const doomed = BUILTIN_SCRIPTS.find((b) => b.key.startsWith("lin-") && ![spare.key, "lin-top-processes", "lin-docker-status"].includes(b.key));
    const doomedRow = await rowOf(doomed.key);
    check("a built-in can be deleted", (await scripts.remove(doomedRow.id)).deleted === true && (await builtinRows()).length === N - 1);
    const restoredAfterDelete = await builtin.seed();
    check("and seeding brings it back as it ships", restoredAfterDelete.created === 1 && (await rowOf(doomed.key)).script === doomed.script, restoredAfterDelete);

    console.log("duplicating");
    const copy = await controller.duplicate(target.id, { user: { id: null } });
    check("a copy is named '<name> (copy)', is not built in, and has the same text and settings", copy.name === `${target.name} (copy)` && copy.builtin === false && copy.script === target.script && copy.language === target.language && copy.parameters.length === target.parameters.length, copy);
    const copy2 = await scripts.duplicate(target.id, null);
    check("a second copy is '(copy 2)' (no name clash)", copy2.name === `${target.name} (copy 2)`, copy2.name);
    const copyOfCopy = await scripts.duplicate(copy.id, null);
    check("a copy of a copy works too", copyOfCopy.name === `${copy.name} (copy)` && copyOfCopy.builtin === false, copyOfCopy.name);
    const cRow = await prisma.automations.findUnique({ where: { id: copy.id } });
    check("the copy carries none of the built-in markers", !("builtinKey" in cRow.configuration) && !("builtinHash" in cRow.configuration) && cRow.configuration.builtin !== true, cRow.configuration);
    const edited = await scripts.update(copy.id, { ...edit, name: copy.name });
    check("a copy can be edited", edited.script === edit.script && edited.builtin === false);
    check("a copy can be deleted", (await scripts.remove(copy2.id)).deleted === true);
    check("a built-in could not be duplicated from an id that is not a script", (await fails(() => scripts.duplicate("00000000-0000-4000-8000-000000000000", null), /not found/i)) === 404);
    const afterCopies = await builtin.seed();
    check("seeding after copies exist adds and changes nothing (the copies are left alone)", afterCopies.created === 0 && afterCopies.updated === 0, afterCopies);
    check("the edited copy kept its edit after seeding", (await prisma.automations.findUnique({ where: { id: copy.id } })).script === edit.script);

    console.log("a newer shipped text, and a person's edit");
    const k1 = "win-flush-dns", k2 = "lin-top-processes";
    const r1 = await rowOf(k1);
    const oldText = "Write-Output 'older shipped text'";
    await prisma.automations.update({ where: { id: r1.id }, data: { script: oldText, description: "older description", configuration: { ...r1.configuration, builtinHash: textHash(oldText), builtinVersion: 0 } } });
    const r2 = await rowOf(k2);
    await prisma.automations.update({ where: { id: r2.id }, data: { script: "echo 'a person edited this'" } }); // text no longer matches the stored hash
    const upd = await builtin.seed();
    check("an UNEDITED built-in with an older shipped text is brought up to date (text, description, version)", upd.updated === 1 && (await rowOf(k1)).script === BUILTIN_SCRIPTS.find((b) => b.key === k1).script && (await rowOf(k1)).configuration.builtinVersion >= 1 && (await rowOf(k1)).description === BUILTIN_SCRIPTS.find((b) => b.key === k1).description, upd);
    check("a built-in whose text a PERSON changed is NOT overwritten, and the run says so", (await rowOf(k2)).script === "echo 'a person edited this'" && upd.skipped.some((x) => x.key === k2 && /changed by a person/.test(x.reason)), upd.skipped);
    const upd2 = await builtin.seed();
    check("and it stays that way on every later run", (await rowOf(k2)).script === "echo 'a person edited this'" && upd2.updated === 0 && upd2.created === 0);
    // put it back for the next steps
    await prisma.automations.update({ where: { id: r2.id }, data: { script: BUILTIN_SCRIPTS.find((b) => b.key === k2).script } });

    console.log("restoring, and a person's own script with the same name");
    const gone = BUILTIN_SCRIPTS.find((b) => b.key === "lin-docker-status");
    await prisma.automations.deleteMany({ where: { organization_id: org, name: gone.name } });
    check("a built-in removed from the table is missing", (await builtinRows()).length === N - 1);
    const restored = await controller.restoreBuiltin();
    check("restore-builtin puts back what is missing and reports it", restored.created === 1 && (await builtinRows()).length === N && (await rowOf("lin-docker-status")).script === gone.script, restored);
    await prisma.automations.deleteMany({ where: { organization_id: org, name: gone.name } });
    await prisma.automations.create({ data: { organization_id: org, name: gone.name, type: "script", script: "echo mine", configuration: { language: "bash", timeoutSec: 60, parameters: [] } } });
    const clash = await builtin.seed();
    const mine = (await rows()).find((r) => r.name === gone.name);
    check("a script that is not built in but has a built-in's name is never touched; the built-in is skipped with the reason", mine.script === "echo mine" && mine.configuration.builtin !== true && clash.skipped.some((x) => x.key === "lin-docker-status" && /not built in/.test(x.reason)) && (await builtinRows()).length === N - 1, clash);
    await prisma.automations.delete({ where: { id: mine.id } });
    await builtin.seed();
    check("once that script is gone the built-in comes back", (await builtinRows()).length === N);

    console.log("the switch");
    await prisma.automations.deleteMany({ where: { organization_id: org, type: "script" } });
    await builtin.onModuleInit();
    check("with BUILTIN_SCRIPTS_SEEDING=false the boot run adds nothing", (await rows()).length === 0);
    delete process.env.BUILTIN_SCRIPTS_SEEDING;
    await builtin.onModuleInit();
    check("without it the boot run adds every script", (await builtinRows()).length === N);
    process.env.BUILTIN_SCRIPTS_SEEDING = "false";

    console.log("running a built-in uses its parameters as environment variables");
    const withParams = (await scripts.list()).items.find((x) => x.name === "Restart a service (Linux, changes the device)");
    check("its parameters (service required, confirm default NO) come through the list for the run dialog", withParams.parameters.some((p) => p.name === "service" && p.required) && withParams.parameters.some((p) => p.name === "confirm" && p.defaultValue === "NO"), withParams.parameters);
    check("running with no device chosen is refused with 400 before any job is made", (await fails(() => scripts.run(withParams.id, [], {}, null), /at least one device/)) === 400);

    // leave the database as the other tests expect it: no scripts of ours
    await prisma.automations.deleteMany({ where: { organization_id: org, type: "script" } });
    console.log(`\n${passed} passed, ${failed} failed`);
    await app.close();
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
