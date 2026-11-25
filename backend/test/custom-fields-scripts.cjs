// {{customer.<field>}} in scripts, through the real job service and database (the job itself is not sent anywhere).
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const dist = (p) => require(path.join(__dirname, "..", "dist", p));

let passed = 0, failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 2).join(" | ") ?? e.message}`); }
}

(async () => {
    const { PrismaService } = dist("storage/prisma.service.js");
    const { JobsService } = dist("jobs/jobs.service.js");
    const prisma = new PrismaService();
    const jobs = new JobsService(prisma, {});
    const sent = [];
    jobs.enqueueJob = async (input) => { sent.push(input); return { ok: true }; };

    const org = (await prisma.$queryRaw`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)[0].id;
    const stamp = Date.now().toString(36);
    const def = (key, label, type, active = true, extra = {}) => prisma.custom_field_defs.create({ data: { organization_id: org, entity: "customer", key, label: `${label} ${stamp}`, type, active, ...extra } });
    const dContract = await def("contract", "Contract", "text");
    const dSeats = await def("seats", "Seats", "number");
    const dSigned = await def("signed", "Signed", "checkbox");
    const dOld = await def("oldfield", "Old", "text", false);
    const dMissing = await def("missingfield", "Missing", "text");
    const client = await prisma.clients.create({ data: { organization_id: org, name: `Jobs CF ${stamp}`, custom_fields: { contract: "C-100", seats: 12, oldfield: "kept", signed: false } }, select: { id: true } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" }, select: { id: true } });
    const device = await prisma.devices.create({ data: { site_id: site.id, hostname: `CFJ-${stamp}`, operating_system: "Windows 11" }, select: { id: true } });
    const agentId = randomUUID();
    const agentUuid = randomUUID();
    await prisma.agents.create({ data: { id: agentId, device_id: device.id, agent_uuid: agentUuid, hostname: `CFJ-${stamp}`, version: "1.3.33", facts: {}, agent_token: `t-${stamp}`, token: `t-${stamp}` } });

    const run = async (scriptText, language = "powershell") => {
        sent.length = 0;
        await jobs.createRunScriptJob({ agentId, language, scriptText });
        return sent[0].payload;
    };

    try {
        await check("a customer's fields are filled in for the device's customer", async () => {
            const p = await run("Write-Output '{{customer.contract}} has {{customer.seats}} seats on {{agent.hostname}}'");
            assert.equal(p.scriptText, `Write-Output 'C-100 has 12 seats on CFJ-${stamp}'`);
            assert.equal(p.env.RIQ_CUSTOMER_CONTRACT, "C-100");
            assert.equal(p.env.RIQ_CUSTOMER_SEATS, "12");
            assert.equal(p.env.RIQ_CUSTOMER_SIGNED, "false", "an unchecked box is false");
            assert.equal(p.env.RIQ_CUSTOMER_MISSINGFIELD, "", "a field with no value is empty");
            assert.ok(!("RIQ_CUSTOMER_OLDFIELD" in p.env), "an archived field is not offered");
        });
        await check("a script that uses no property is sent exactly as written", async () => {
            const p = await run("Get-Date");
            assert.equal(p.scriptText, "Get-Date");
            assert.ok(!Object.keys(p.env).some((k) => k.startsWith("RIQ_CUSTOMER_")));
        });
        await check("an archived field, an unknown one, and one with no value stop the script and say why", async () => {
            for (const [ref, why] of [["oldfield", /is not a custom field/], ["nothere", /is not a custom field/], ["missingfield", /has no value for this device''s customer/]]) {  // (PowerShell doubles the apostrophe in the stub script)
                const p = await run(`Write-Output 'before {{customer.${ref}}} after'`);
                assert.doesNotMatch(p.scriptText, /before/, "nothing the author wrote is run");
                assert.match(p.scriptText, why);
                assert.match(p.scriptText, /exit 1/);
            }
        });
        await check("works in a bash script too", async () => {
            const p = await run("echo {{customer.contract}}", "bash");
            assert.equal(p.scriptText, "echo C-100");
        });
    } finally {
        await prisma.$executeRawUnsafe(`DELETE FROM agents WHERE id = '${agentId}'`);
        await prisma.$executeRawUnsafe(`DELETE FROM devices WHERE id = '${device.id}'`);
        await prisma.$executeRawUnsafe(`DELETE FROM clients WHERE id = '${client.id}'`);
        await prisma.custom_field_defs.deleteMany({ where: { id: { in: [dContract.id, dSeats.id, dSigned.id, dOld.id, dMissing.id] } } });
        await prisma.$disconnect();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
