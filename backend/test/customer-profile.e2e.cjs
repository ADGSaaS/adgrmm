// A customer's whole record: create it with everything, read it back, change parts of it, contacts and all.
"use strict";

const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const fails = async (fn, re) => {
    try { await fn(); return false; } catch (e) { return re.test(String(e.message ?? e)); }
};

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    // Loading the whole app first fixes the order the modules load in; starting from CustomersModule alone hits a file import cycle.
    require(path.join(dist, "app.module.js"));
    const { CustomersModule } = require(path.join(dist, "customers/customers.module.js"));
    const { CustomersService } = require(path.join(dist, "customers/customers.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const app = await NestFactory.createApplicationContext(CustomersModule, { logger: ["error"] });
    const svc = app.get(CustomersService);
    const prisma = app.get(PrismaService, { strict: false });
    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const o = org.id;
    const stamp = Date.now();
    const name = `Profile ${stamp}`;
    const GHOST = "00000000-0000-4000-8000-000000000000";

    // ---- a name alone still creates a customer
    const bare = await svc.createClient({ name: `Bare ${stamp}` }, o);
    check("a name alone creates a customer", !!bare.id && bare.name === `Bare ${stamp}` && bare.status === "active" && bare.contacts.length === 0 && bare.billingSameAsAddress === true, bare);

    // ---- everything at once
    const made = await svc.createClient({
        name: `  ${name}  `, status: "prospect", accountNumber: "ACME-1", legalName: "Profile Holdings LLC", industry: "Dental",
        website: "profile.example.com", phone: "+1 555 0100", email: "Hello@Profile.Example.com", billingEmail: "ap@profile.example.com",
        taxId: "12-3456789", timeZone: "America/Chicago", currency: "usd", paymentTerms: "Net 30", employeeCount: "42", customerSince: "2024-03-01",
        address: { line1: "1 Main St", city: "Austin", region: "TX", postalCode: "78701", country: "USA" },
        billingSameAsAddress: false, billingAddress: { line1: "PO Box 9", city: "Austin", region: "TX", postalCode: "78702", country: "USA" },
        notes: "Gate code 1234", tags: ["VIP", "vip", " Dental ", ""],
        contacts: [
            { name: "Dana Primary", jobTitle: "Owner", email: "Dana@Profile.Example.com", role: "primary", isPrimary: true },
            { name: "Bill Payer", email: "bill@profile.example.com", role: "billing", isPrimary: true },
            { name: "Tech Person", mobile: "555 0111", role: "technical" },
        ],
    }, o);
    check("the name is tidied", made.name === name, made.name);
    check("every field is kept", made.status === "prospect" && made.accountNumber === "ACME-1" && made.legalName === "Profile Holdings LLC" && made.industry === "Dental" && made.phone === "+1 555 0100" && made.taxId === "12-3456789" && made.paymentTerms === "Net 30", made);
    check("a website gets https", made.website === "https://profile.example.com", made.website);
    check("emails are lower-cased", made.email === "hello@profile.example.com", made.email);
    check("currency is upper-cased", made.currency === "USD", made.currency);
    check("employees and date are kept", made.employeeCount === 42 && made.customerSince === "2024-03-01", [made.employeeCount, made.customerSince]);
    check("addresses are kept apart", made.address.city === "Austin" && made.address.line1 === "1 Main St" && made.billingSameAsAddress === false && made.billingAddress.line1 === "PO Box 9", made);
    check("tags drop blanks and repeats", JSON.stringify(made.tags) === JSON.stringify(["VIP", "Dental"]), made.tags);
    check("contacts are saved", made.contacts.length === 3, made.contacts);
    check("only one contact is the main one, and it comes first", made.contacts.filter((c) => c.isPrimary).length === 1 && made.contacts[0].name === "Dana Primary", made.contacts);
    check("a contact email is lower-cased", made.contacts[0].email === "dana@profile.example.com", made.contacts[0].email);

    // ---- reading it back
    const read = await svc.getProfile(made.id, o);
    check("it reads back the same", JSON.stringify(read) === JSON.stringify(made));
    check("it can be found by name too", (await svc.getProfile(name.toLowerCase(), o)).id === made.id);
    check("the list still works", (await svc.listClients(String(stamp), o)).length === 2);

    // ---- bad input is refused with a reason
    check("a missing name is refused", await fails(() => svc.createClient({ name: "  " }, o), /name is required/i));
    check("a repeated name is refused", await fails(() => svc.createClient({ name: name.toUpperCase() }, o), /already has that name/i));
    check("a bad email is refused", await fails(() => svc.createClient({ name: `E ${stamp}`, email: "nope" }, o), /Email is not a valid/));
    check("a bad billing email is refused", await fails(() => svc.createClient({ name: `E ${stamp}`, billingEmail: "a@b" }, o), /Billing email/));
    check("a bad website is refused", await fails(() => svc.createClient({ name: `W ${stamp}`, website: "not a site" }, o), /Website/));
    check("a bad time zone is refused", await fails(() => svc.createClient({ name: `T ${stamp}`, timeZone: "Mars/Base" }, o), /Time zone/));
    check("a bad currency is refused", await fails(() => svc.createClient({ name: `C ${stamp}`, currency: "DOLLARS" }, o), /Currency/));
    check("a bad status is refused", await fails(() => svc.createClient({ name: `S ${stamp}`, status: "dead" }, o), /Status/));
    check("a bad date is refused", await fails(() => svc.createClient({ name: `D ${stamp}`, customerSince: "yesterday" }, o), /Customer since/));
    check("a negative head count is refused", await fails(() => svc.createClient({ name: `N ${stamp}`, employeeCount: -3 }, o), /employees/));
    check("a contact without a name is refused", await fails(() => svc.createClient({ name: `K ${stamp}`, contacts: [{ email: "a@b.co" }] }, o), /Contact 1 needs a name/));
    check("a contact with a bad email says which", await fails(() => svc.createClient({ name: `K ${stamp}`, contacts: [{ name: "A" }, { name: "B", email: "x" }] }, o), /Contact 2 email/));
    check("a contact with a strange role is refused", await fails(() => svc.createClient({ name: `K ${stamp}`, contacts: [{ name: "A", role: "king" }] }, o), /role/));
    check("nothing was created by the failures", (await svc.listClients(`${stamp}`, o)).length === 2);

    // ---- editing
    const edited = await svc.updateClient(made.id, { phone: "+1 555 0199", industry: null, status: "active" }, o);
    check("only what is sent changes", edited.phone === "+1 555 0199" && edited.industry === null && edited.status === "active" && edited.legalName === "Profile Holdings LLC" && edited.contacts.length === 3 && edited.tags.length === 2, edited);
    check("a name alone renames, as before", (await svc.updateClient(made.id, { name: `Renamed ${stamp}` }, o)).name === `Renamed ${stamp}`);
    check("renaming onto another customer is refused", await fails(() => svc.updateClient(made.id, { name: `bare ${stamp}` }, o), /already has that name/i));
    check("keeping its own name is fine", (await svc.updateClient(made.id, { name: `Renamed ${stamp}`, notes: "x" }, o)).notes === "x");
    check("an empty name is refused", await fails(() => svc.updateClient(made.id, { name: "" }, o), /name is required/i));

    // contacts are replaced as a list
    const first = (await svc.getProfile(made.id, o)).contacts;
    const keep = first.find((c) => c.name === "Tech Person");
    const swapped = await svc.updateClient(made.id, { contacts: [{ id: keep.id, name: "Tech Person", role: "technical", email: "tech@profile.example.com", isPrimary: true }, { name: "New Owner", role: "owner" }] }, o);
    check("contacts not listed are removed", swapped.contacts.length === 2 && !swapped.contacts.some((c) => c.name === "Dana Primary"), swapped.contacts);
    check("a listed contact keeps its id and takes the change", swapped.contacts.some((c) => c.id === keep.id && c.email === "tech@profile.example.com" && c.isPrimary), swapped.contacts);
    check("a new contact is added", swapped.contacts.some((c) => c.name === "New Owner"));
    check("an unknown contact id is refused", await fails(() => svc.updateClient(made.id, { contacts: [{ id: GHOST, name: "Ghost" }] }, o), /does not belong/));
    check("a refused change leaves everything as it was", (await svc.getProfile(made.id, o)).contacts.length === 2);
    check("an empty list removes all contacts", (await svc.updateClient(made.id, { contacts: [] }, o)).contacts.length === 0);

    // another organisation cannot see or change it
    const other = await prisma.organizations.create({ data: { name: `Other ${stamp}`, slug: `other-${stamp}` } });
    check("another organisation cannot read it", await fails(() => svc.getProfile(made.id, other.id), /not found/i));
    check("another organisation cannot change it", await fails(() => svc.updateClient(made.id, { phone: "1" }, other.id), /not found/i));
    check("an unknown customer is not found", await fails(() => svc.updateClient(GHOST, { phone: "1" }, o), /not found/i));

    // two people editing: the second save is refused, not silently overwriting
    await svc.updateClient(made.id, { contacts: [{ name: "Keeper" }] }, o);
    const seen = await svc.getProfile(made.id, o);
    const mine = await svc.updateClient(made.id, { phone: "111", version: seen.updatedAt }, o);
    check("a save with the current version works and moves the version on", mine.phone === "111" && mine.updatedAt !== seen.updatedAt, [seen.updatedAt, mine.updatedAt]);
    check("a save made from an older version is refused", await fails(() => svc.updateClient(made.id, { phone: "222", version: seen.updatedAt }, o), /Someone else changed/));
    check("the refused save changed nothing", (await svc.getProfile(made.id, o)).phone === "111");
    check("a refused save leaves contacts alone too", await fails(() => svc.updateClient(made.id, { contacts: [], version: seen.updatedAt }, o), /Someone else changed/) && (await svc.getProfile(made.id, o)).contacts.length === 1);
    check("a bad version is refused", await fails(() => svc.updateClient(made.id, { phone: "3", version: "soon" }, o), /version/i));
    check("a save without a version still works", (await svc.updateClient(made.id, { phone: "333" }, o)).phone === "333");
    // the version survives the database keeping microseconds
    await prisma.$executeRaw`UPDATE clients SET updated_at = '2026-01-02 03:04:05.123456+00' WHERE id = ${made.id}::uuid`;
    const micro = await svc.getProfile(made.id, o);
    check("a version still matches when the database holds microseconds", (await svc.updateClient(made.id, { notes: "micro", version: micro.updatedAt }, o)).notes === "micro", micro.updatedAt);

    // archive and restore
    const archivedOne = await svc.setArchived(made.id, true, o);
    check("archiving marks the customer", archivedOne.archived === true && !!archivedOne.archivedAt);
    check("an archived customer leaves the list", !(await svc.listClients(String(stamp), o)).some((c) => c.key === made.id));
    const withArchived = await svc.listClients(String(stamp), o, true);
    check("it comes back when archived ones are asked for, and says so", withArchived.some((c) => c.key === made.id && c.archived === true));
    check("an archived customer can still be read and edited", (await svc.updateClient(made.id, { notes: "still here" }, o)).notes === "still here");
    check("archiving keeps its contacts", (await svc.getProfile(made.id, o)).contacts.length === 1);
    check("restoring puts it back", (await svc.setArchived(made.id, false, o)).archived === false && (await svc.listClients(String(stamp), o)).some((c) => c.key === made.id));
    check("another organisation cannot archive it", await fails(() => svc.setArchived(made.id, true, other.id), /not found/i));

    // sites carry their own details
    const hq = await svc.createSiteForClient(made.id, { name: " Head office ", address: { line1: "9 Dock Rd", city: "Austin" }, phone: "555 0100", contactName: "Sam Site", contactEmail: "Sam@Site.Example.com", timeZone: "America/Denver", notes: "Back door" }, o);
    check("a site is created with its details", hq.name === "Head office" && hq.address.city === "Austin" && hq.contactEmail === "sam@site.example.com" && hq.timeZone === "America/Denver" && hq.phone === "555 0100", hq);
    check("a site can still be created with a name alone", (await svc.createSiteForClient(made.id, { name: "Plain" }, o)).name === "Plain");
    check("a site reads back the same", JSON.stringify(await svc.getSite(made.id, hq.id, o)) === JSON.stringify(hq));
    check("a site is found by name too", (await svc.getSite(made.id, "head office", o)).id === hq.id);
    const hq2 = await svc.updateSite(made.id, hq.id, { phone: "555 0199", notes: null, version: hq.updatedAt }, o);
    check("only the sent site details change", hq2.phone === "555 0199" && hq2.notes === null && hq2.contactName === "Sam Site" && hq2.address.line1 === "9 Dock Rd", hq2);
    check("a stale site save is refused", await fails(() => svc.updateSite(made.id, hq.id, { phone: "000", version: hq.updatedAt }, o), /Someone else changed/));
    check("a site rename onto another site is refused", await fails(() => svc.updateSite(made.id, hq.id, { name: "plain" }, o), /already has that name/i));
    check("a site rename alone still works", (await svc.updateSite(made.id, hq.id, { name: "Main office" }, o)).name === "Main office");
    check("a bad site email is refused", await fails(() => svc.updateSite(made.id, hq.id, { email: "x" }, o), /Email/));
    check("a bad site time zone is refused", await fails(() => svc.updateSite(made.id, hq.id, { timeZone: "Nowhere/Land" }, o), /Time zone/));
    check("another organisation cannot read a site", await fails(() => svc.getSite(made.id, hq.id, other.id), /not found/i));
    check("the site list still counts them", (await svc.listSitesForClient(made.id, o)).length === 2);

    // deleting a customer takes its contacts with it
    await svc.updateClient(made.id, { contacts: [{ name: "Gone soon" }] }, o);
    await svc.deleteClient(made.id, { force: true }, o);
    check("deleting a customer deletes its contacts", (await prisma.customer_contacts.count({ where: { client_id: made.id } })) === 0);

    await svc.deleteClient(bare.id, {}, o);
    await prisma.organizations.delete({ where: { id: other.id } });
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
