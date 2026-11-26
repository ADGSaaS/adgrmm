#!/usr/bin/env node
"use strict";
// Setup helpers the installer runs with the bundled Node. Each reads a JSON answers file (0600, deleted by the
// installer afterwards) and prints one line per result: "OK ...", "WARN ...", "INFO ...", "CMD <os> <command>".
//
//   node adg-admin.cjs create-admin  <answers.json>   the first Owner, straight into the database
//   node adg-admin.cjs configure     <answers.json>   company, email, portal, first customer, agent installers (through the API)
//   node adg-admin.cjs has-owner     <answers.json>   exit 0 when an Owner already exists
//   node adg-admin.cjs db-check      <answers.json>   exit 0 when the database can be reached and holds the needed extensions

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BACKEND = process.env.ADG_BACKEND_DIR || path.join(__dirname, "..", "backend");
const need = (name) => require(path.join(BACKEND, "node_modules", name));

const say = (kind, text) => console.log(`${kind} ${String(text).replace(/\r?\n/g, " ")}`);

function readAnswers(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function dbClient(a) {
    const { Client } = need("pg");
    // Prisma's ?schema=public is not something Postgres understands.
    const url = String(a.databaseUrl).replace(/([?&])schema=[^&]*&?/, "$1").replace(/[?&]$/, "");
    const client = new Client({ connectionString: url, ssl: a.databaseSsl ? { rejectUnauthorized: false } : undefined });
    await client.connect();
    return client;
}

/* ------------------------------------------------------------------ database */

async function dbCheck(a) {
    const db = await dbClient(a);
    try {
        await db.query("SELECT 1");
        for (const ext of ["citext", "pgcrypto"]) {
            const have = await db.query("SELECT 1 FROM pg_extension WHERE extname = $1", [ext]);
            if (have.rowCount) continue;
            try {
                await db.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
            } catch (e) {
                throw new Error(`The database does not have the "${ext}" extension and this login may not create it (${e.message}). Ask the database administrator to run: CREATE EXTENSION ${ext};`);
            }
        }
    } finally {
        await db.end();
    }
}

/* ------------------------------------------------------------------ the first administrator */

async function hasOwner(a) {
    const db = await dbClient(a);
    try {
        const r = await db.query(
            `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE lower(r.name) = 'owner' LIMIT 1`
        );
        return r.rowCount > 0;
    } finally {
        await db.end();
    }
}

async function createAdmin(a) {
    const bcrypt = need("bcryptjs");
    const db = await dbClient(a);
    try {
        const role = await db.query(`SELECT id FROM roles WHERE lower(name) = 'owner' ORDER BY scope DESC LIMIT 1`);
        if (!role.rowCount) throw new Error("The built-in Owner role is missing. The backend has to start once before the administrator can be created.");
        const exists = await db.query(
            `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.id = $1 LIMIT 1`,
            [role.rows[0].id]
        );
        if (exists.rowCount) throw new Error("An Owner already exists in this database, so no new administrator was created.");

        let org = (await db.query(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).rows[0]?.id;
        if (!org) {
            org = (await db.query(`INSERT INTO organizations (name, slug) VALUES ($1, 'default') RETURNING id`, [a.company || "My company"])).rows[0].id;
        } else if (a.company) {
            await db.query(`UPDATE organizations SET name = $2 WHERE id = $1`, [org, a.company]);
        }

        const email = String(a.email).trim().toLowerCase();
        const taken = await db.query(`SELECT id FROM users WHERE lower(email) = $1`, [email]);
        let userId;
        if (taken.rowCount) {
            userId = taken.rows[0].id;
            await db.query(`UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`, [userId, await bcrypt.hash(String(a.password), 12)]);
        } else {
            userId = crypto.randomUUID();
            await db.query(
                `INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,$4,$5,'active',$6)`,
                [userId, org, email, a.firstName || "Admin", a.lastName || "", await bcrypt.hash(String(a.password), 12)]
            );
        }
        await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, role.rows[0].id]);
        say("OK", `Administrator ${email} created`);
    } finally {
        await db.end();
    }
}

/* ------------------------------------------------------------------ settings through the API */

class Api {
    constructor(base) {
        this.base = base.replace(/\/+$/, "");
        this.cookie = "";
    }

    async call(method, route, body) {
        const res = await fetch(`${this.base}${route}`, {
            method,
            headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(45_000),
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!res.ok) {
            const m = data && typeof data === "object" ? data.message : text;
            const err = new Error(Array.isArray(m) ? m.join(" ") : String(m || `HTTP ${res.status}`));
            err.status = res.status;
            throw err;
        }
        return { data, res };
    }

    async login(email, password) {
        const { res } = await this.call("POST", "/api/auth/login", { email, password });
        const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [String(res.headers.get("set-cookie") || "")];
        const mine = cookies.map((c) => c.split(";")[0]).filter((c) => /^[^=]+=.+/.test(c));
        if (!mine.length) throw new Error("Signing in did not return a session.");
        this.cookie = mine.join("; ");
    }
}

const step = async (title, fn) => {
    try {
        const r = await fn();
        if (r !== false) say("OK", title);
    } catch (e) {
        say("WARN", `${title}: ${e.message}`);
    }
};

async function configure(a) {
    const api = new Api(a.apiBase || "http://127.0.0.1:3001");
    await api.login(a.email, a.password);

    if (a.company) {
        await step(`Company name set to "${a.company}"`, () => api.call("POST", "/api/admin/company/save", { name: a.company, email: a.companyEmail || a.email || undefined }));
    }

    if (a.publicUrl) {
        await step("Invoice and payment links use your web address", () => api.call("PUT", "/api/billing/settings", { publicBaseUrl: a.publicUrl }));
    }

    if (a.smtp && a.smtp.host) {
        const s = a.smtp;
        const smtp = {
            host: s.host,
            port: Number(s.port) || 587,
            username: s.username || "",
            ...(s.password ? { password: s.password } : {}),
            useTLS: s.security === "starttls",
            useSSL: s.security === "ssl",
            fromAddress: s.fromAddress,
        };
        const empty = { host: "", username: "", useSSL: true };
        const profile = { smtp, imap: empty, pop: empty, enabled: true };
        const profiles = {};
        for (const k of ["alerts", "invites", "password_resets", "reports", "tickets"]) profiles[k] = profile;
        let saved = false;
        await step("Email settings saved for alerts, invitations, password resets, reports and tickets", async () => {
            await api.call("POST", "/api/admin/email/save", { profiles });
            saved = true;
        });
        if (saved && s.testTo) {
            try {
                const { data } = await api.call("POST", "/api/admin/email/send-test", { profile: "invites", to: s.testTo, subject: "ADG RMM email test", body: "If you can read this, ADG RMM can send email." });
                if (data && data.ok) say("OK", `Test email sent to ${s.testTo}`);
                else say("WARN", `The test email was not sent: ${(data && data.result) || "unknown reason"}. Check the settings under Administration > Email.`);
            } catch (e) {
                say("WARN", `The test email was not sent: ${e.message}`);
            }
        }
    }

    if (a.portalDomain) {
        await step(`Client portal turned on at ${a.portalDomain}`, () => api.call("PUT", "/api/portal-admin/settings", { domain: a.portalDomain, enabled: true }));
    }

    if (a.customer && a.customer.name) {
        let clientId = null;
        let siteId = null;
        await step(`Customer "${a.customer.name}" created`, async () => {
            const { data } = await api.call("POST", "/api/customers", { name: a.customer.name });
            clientId = data && data.id;
            if (!clientId) throw new Error("no customer id came back");
        });
        if (clientId) {
            const siteName = a.customer.site || "Main office";
            await step(`Site "${siteName}" created`, async () => {
                const { data } = await api.call("POST", `/api/customers/${encodeURIComponent(clientId)}/sites`, { name: siteName });
                siteId = (data && (data.id || (data.site && data.site.id))) || null;
                if (!siteId) {
                    const sites = (await api.call("GET", `/api/customers/${encodeURIComponent(clientId)}/sites`)).data;
                    const list = Array.isArray(sites) ? sites : (sites && sites.items) || [];
                    siteId = (list.find((s) => s.name === siteName) || list[0] || {}).id || null;
                }
                if (!siteId) throw new Error("no site id came back");
            });
        }
        if (clientId && siteId) {
            let key = null;
            await step("Install key created for this site", async () => {
                const { data } = await api.call("POST", "/api/provisioning/enrollment-keys", { clientId, siteId, name: "First install key", expiresMinutes: 5_259_600 });
                key = data && data.enrollmentKey;
                if (!key) throw new Error("no key came back");
            });
            if (key) {
                for (const os of ["windows", "linux"]) {
                    try {
                        const { data } = await api.call("POST", "/api/provisioning/installer-bundles", { enrollmentKey: key, os, label: a.customer.name });
                        if (data && data.installCommand) say("CMD", `${os} ${data.installCommand}`);
                    } catch (e) {
                        say("WARN", `The ${os} agent installer is not available yet: ${e.message}. Add the agent packages (see the README), then make one from Customers > Reusable installer.`);
                    }
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */

async function main() {
    const [cmd, file] = process.argv.slice(2);
    if (!cmd || !file) {
        console.error("usage: adg-admin.cjs <create-admin|configure|has-owner|db-check> <answers.json>");
        process.exit(2);
    }
    const a = readAnswers(file);
    if (cmd === "create-admin") return createAdmin(a);
    if (cmd === "configure") return configure(a);
    if (cmd === "has-owner") process.exit((await hasOwner(a)) ? 0 : 1);
    if (cmd === "db-check") return dbCheck(a);
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}

main().catch((e) => {
    say("ERROR", e.message || e);
    process.exit(1);
});
