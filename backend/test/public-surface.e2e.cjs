#!/usr/bin/env node
// The public surface of the API: every route (from the API description at /docs-json, so the server must run outside production) is called with
// NO sign-in, and the routes that do not answer 401 or 403 must be exactly the ones that are meant to be public (sign-in, SSO, the customer
// portal's token links, customer-facing billing links, surveys, agent enrolment, health checks). Found by this kind of check: the IT Docs API
// (vault, documents, assets) sat under /api/docs, which the sign-in and permission checks treated as the Swagger page, so all of it was open.
// A route added to the list below must be public on purpose. Throwaway server only.
//   BASE_URL=http://127.0.0.1:3951 node test/public-surface.e2e.cjs
"use strict";
const base = process.env.BASE_URL || "http://127.0.0.1:3901";
const MEANT_TO_BE_PUBLIC = new Set([
    "GET /api/branding", "GET /healthz", "GET /healthz/email",
    "POST /api/auth/2fa/verify", "POST /api/auth/logout", "GET /api/auth/me", "GET /api/auth/sso/config", "GET /api/auth/sso/start", "GET /api/auth/sso/callback", "GET /api/auth/login-config",
    "POST /api/auth-legacy/2fa/verify", "POST /api/auth-legacy/logout", "GET /api/auth-legacy/me",
    "POST /api/agent/enroll", "GET /api/provisioning/agent-packages/{os}", "GET /api/support-mailbox/callback",
    "GET /api/portal/config", "GET /api/portal/auth/link/{token}", "POST /api/portal/auth/set-password", "POST /api/portal/auth/forgot",
    "GET /api/public/billing/documents/{token}", "GET /api/public/billing/documents/{token}/pdf", "POST /api/public/billing/documents/{token}/checkout",
    "POST /api/public/billing/documents/{token}/accept", "POST /api/public/billing/documents/{token}/decline", "POST /api/public/billing/stripe-webhook",
    "GET /api/survey/{token}", "POST /api/survey/{token}", "GET /api/portal/survey/{token}", "POST /api/portal/survey/{token}",
]);
(async () => {
    const spec = await (await fetch(`${base}/docs-json`)).json();
    const U = "00000000-0000-4000-8000-000000000001";
    const open = [];
    let probed = 0;
    for (const [path, methods] of Object.entries(spec.paths)) {
        for (const method of Object.keys(methods)) {
            if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
            const r = await fetch(base + path.replace(/\{[^}]+\}/g, U), { method: method.toUpperCase(), headers: { "content-type": "application/json" }, body: ["post", "put", "patch"].includes(method) ? "{}" : undefined, redirect: "manual" });
            probed++;
            if (![401, 403].includes(r.status)) open.push(`${method.toUpperCase()} ${path}`);
        }
    }
    const unexpected = open.filter((o) => !MEANT_TO_BE_PUBLIC.has(o));
    const gone = [...MEANT_TO_BE_PUBLIC].filter((o) => !open.includes(o));
    console.log(`probed ${probed} routes; ${open.length} answer without sign-in`);
    let ok = probed > 400;
    if (!ok) console.log("FAIL too few routes were found (is the server running outside production?)");
    if (unexpected.length) { ok = false; console.log("FAIL routes open without sign-in that are not meant to be public:\n  " + unexpected.join("\n  ")); }
    if (gone.length) console.log("note: listed as public but no longer open (fine, remove from the list):\n  " + gone.join("\n  "));
    console.log(ok ? "ok   only the routes that are meant to be public are open" : "");
    process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
