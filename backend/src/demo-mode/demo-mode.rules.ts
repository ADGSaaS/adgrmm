// backend/src/demo-mode/demo-mode.rules.ts
//
// What a visitor of the public demo may do. The demo is a normal ADG RMM install started with DEMO_MODE=1, so every rule here is
// about keeping the sample data safe and the server harmless:
//   * nothing that reaches outside (email, webhooks, URL checks, scans, storage, chat, remote tools),
//   * nothing that adds a device (agent enrollment, installers that really enroll),
//   * nothing that shows how the server itself is set up (environment, database, paths, hosts, keys).
// Every administration page is visible. The pages that would show the real server (system, database, storage, backups, mail logins,
// single sign-on, sessions, install keys, secrets, diagnostics, integrations, agents, migrations, ...) are answered with made-up sample
// data from demo-fixtures.ts, by the gate, before any real controller runs. The "make an installer / install key / endpoint" calls return
// sample values too (a command that does nothing, a text file saying it is a demo), so the flow can be walked through; they create nothing.
// Reads of those routes that have no sample, and all writes, stay refused (judge() below still says "refuse" for every one of them).
// Reads are open except for the "sensitive" list; writes are refused unless they are on the allow list. Anything not listed
// is therefore refused, so a new route stays closed in the demo until someone opens it on purpose.
// Agent enrollment (/api/agent/*, /api/agents/*) stays refused, so no device can ever really join the demo.

import { findFixture, type FixtureHit } from "./demo-fixtures";

export const isDemoMode = (): boolean => process.env.DEMO_MODE === "1";

/** Refused for every method: these show how the server is set up, or would let a visitor add a device. */
export const DENY_ANY: RegExp[] = [
    /^\/api\/admin\/(database|diagnostics|environment|migrations|secrets-status|system|system-health|storage|backups|sso|email|integrations|sessions|agent-settings|agent-releases|tray|data|import|jobs|agents|webhooks|demo)(\/|$)/,
    /^\/api\/(provisioning|agent|agents|vault|remote-desktop|remote-console|remote-shell|device-chat|remote-recordings|storage|auth-legacy|public)(\/|$)/,
    /^\/api\/users\/me\/(tokens|webauthn)(\/|$)/,
    /^\/api\/devices\/[^/]+\/secrets(\/|$)/,
    /^\/api\/notifications\/channels(\/|$)/,
    /^\/api\/portal-admin\/(accounts|settings)(\/|$)/,
    /^\/api\/support-mailbox(\/|$)/,
];

/** Refused for writes even where a broader allow rule would match (anything that sends, fetches, uploads or runs). */
export const DENY_WRITE: RegExp[] = [
    /\/(send|send-now|test|test-smtp|test-imap|sync|import|upload|upload-favicon|attachments|checkout|run|run-now|invite)(\/|$)/,
    /^\/api\/tickets\/[^/]+\/attachments(\/|$)/,
    /^\/api\/billing\/invoices\/[^/]+\/send(\/|$)/,
    /^\/api\/reports\/branding\/[^/]+\/logo(\/|$)/,
    /^\/api\/scripts\/(schedules|[^/]+\/run)(\/|$)/,
];

/** Writes that only change rows in the demo's own database. */
export const ALLOW_WRITE: RegExp[] = [
    /^\/api\/auth\/(login|logout)$/,
    /^\/api\/users\/me$/,
    /^\/api\/tickets(\/|$)/,
    /^\/api\/ticket-(timers|templates|queues|routing-rules|contacts|custom-fields)(\/|$)/,
    /^\/api\/recurring-tickets(\/|$)/,
    /^\/api\/custom-fields(\/|$)/,
    /^\/api\/sla(\/|$)/,
    /^\/api\/kb(\/|$)/,
    /^\/api\/tags(\/|$)/,
    /^\/api\/customers(\/|$)/,
    /^\/api\/alerts(\/|$)/,
    /^\/api\/checks(\/|$)/,
    /^\/api\/policies(\/|$)/,
    /^\/api\/billing(\/|$)/,
    /^\/api\/reports(\/|$)/,
    /^\/api\/schedule(\/|$)/,
    /^\/api\/script-snippets(\/|$)/,
    /^\/api\/scripts(\/|$)/,
    /^\/api\/docs(\/|$)/,
    /^\/api\/devices\/[^/]+\/(site|check-definitions)(\/|$)/,
    /^\/api\/bulk\/devices\/(tags|move-site)$/,
    /^\/api\/admin\/ticketing\/canned-(responses|variables)(\/|$)/,
];

export const DEMO_REFUSAL = {
    statusCode: 403,
    message: "That is switched off in the demo. The demo's devices are samples, and it cannot reach outside or change how the server is set up.",
    demo: true,
};

/** Cleans a request path the way the router will see it, and says whether it looks like an attempt to dodge the rules. */
export function normalizePath(rawUrl: string): { path: string; suspicious: boolean } {
    const raw = rawUrl.split("?")[0].split("#")[0];
    const suspicious = /%2e|%2f|%5c|%00|\.\.|\/\//i.test(raw) || raw.includes("\\");
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { return { path: raw.toLowerCase(), suspicious: true }; }
    const path = decoded.toLowerCase().replace(/\/+$/, "") || "/";
    return { path, suspicious };
}

export type Verdict = "pass" | "refuse" | "write-ok";

export function judge(method: string, rawUrl: string): Verdict {
    const { path, suspicious } = normalizePath(rawUrl);
    if (!path.startsWith("/api/")) return "pass";              // the web app's own files
    if (path.startsWith("/api/demo/")) return "pass";          // the demo's own entry, ping and mode routes
    if (path === "/api/healthz" || path === "/healthz") return "pass";
    if (suspicious) return "refuse";
    if (DENY_ANY.some((r) => r.test(path))) return "refuse";
    const m = method.toUpperCase();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "pass";
    if (DENY_WRITE.some((r) => r.test(path))) return "refuse";
    if (ALLOW_WRITE.some((r) => r.test(path))) return "write-ok";
    return "refuse";
}

export type Decision = { kind: "fixture"; hit: FixtureHit; method: string; path: string } | { kind: Verdict };

/** What the gate does with a request: answer it from a sample (kind "fixture"), or the verdict of judge(). */
export function decide(method: string, rawUrl: string): Decision {
    const { path, suspicious } = normalizePath(rawUrl);
    if (path.startsWith("/api/")) {
        const hit = findFixture(method, path, rawUrl, suspicious);
        if (hit) return { kind: "fixture", hit, method: method.toUpperCase(), path };
    }
    return { kind: judge(method, rawUrl) };
}
