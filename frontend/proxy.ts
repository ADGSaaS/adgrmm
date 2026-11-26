import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const PUBLIC_PATHS = new Set<string>([
    "/login",
    "/favicon.ico",
    "/robots.txt",
    "/sitemap.xml",
]);

function getApiBase(req: NextRequest) {
    // A packaged install gives the address of the API as this server sees it, which avoids going out and back in.
    const env = (process.env.BACKEND_INTERNAL_URL || process.env.NEXT_PUBLIC_API_BASE)?.replace(/\/+$/, "");
    if (env) return env;
    // fallback: assume API on same origin at /api
    return req.nextUrl.origin.replace(/\/+$/, "");
}

// The sign-in cookie's name. A packaged install gives each installation its own (NEXT_PUBLIC_AUTH_COOKIE_NAME, set when
// it is installed), so two installations under one domain never read each other's cookie. Everywhere else it stays auth_token.
const AUTH_COOKIE = process.env.NEXT_PUBLIC_AUTH_COOKIE_NAME || "auth_token";

// ---- The client portal ----
// The portal is the same web app answering on its own domain (set in Administration). On that domain only portal pages
// and the portal's own API exist: the staff app, its sign-in and the rest of the API are not reachable there.
let portalDomainCache: { at: number; domain: string | null } | null = null;

async function portalDomain(req: NextRequest): Promise<string | null> {
    const now = Date.now();
    if (portalDomainCache && now - portalDomainCache.at < 5_000) return portalDomainCache.domain;
    try {
        const res = await fetch(`${getApiBase(req)}/api/portal/config`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
        if (res.ok) {
            const data = (await res.json()) as { domain?: string | null };
            portalDomainCache = { at: now, domain: data.domain ? String(data.domain).toLowerCase() : null };
        }
    } catch {
        /* keep what we knew; a short outage must not turn the portal into the staff app */
    }
    if (!portalDomainCache) portalDomainCache = { at: now - 4_000, domain: null };
    return portalDomainCache.domain;
}

function hostOf(req: NextRequest): string {
    return String(req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

const PORTAL_PUBLIC_API = ["/api/portal/", "/api/branding"];
const PORTAL_API_ALLOWED = (p: string) => PORTAL_PUBLIC_API.some((a) => p === a.replace(/\/$/, "") || p.startsWith(a));

function withHeaders(req: NextRequest, extra: Record<string, string>) {
    const h = new Headers(req.headers);
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return h;
}

/**
 * The address the browser used, for redirects. Next always builds its own URLs from the server's internal address
 * (localhost:3000), so behind a proxy a redirect would send people to localhost. A proxy says what it was asked for
 * in X-Forwarded-Host and X-Forwarded-Proto; with neither (development, direct access) nothing changes.
 */
function publicUrl(req: NextRequest) {
    const url = req.nextUrl.clone();
    const fh = req.headers.get("x-forwarded-host");
    const fp = req.headers.get("x-forwarded-proto");
    if (fh || fp) {
        const host = String(fh ?? req.headers.get("host") ?? url.host).split(",")[0].trim();
        const proto = String(fp ?? url.protocol.replace(":", "")).split(",")[0].trim();
        if (host) {
            // Setting only the host would keep the server's own port (3000) on the address.
            const m = host.match(/^(.*?)(?::(\d+))?$/);
            url.hostname = m?.[1] || host;
            url.port = m?.[2] ?? "";
        }
        if (proto === "http" || proto === "https") url.protocol = proto;
    }
    return url;
}

// Next 16 renamed the middleware convention to proxy (always the Node.js runtime).
export async function proxy(req: NextRequest) {
    const { pathname } = req.nextUrl;

    const domain = await portalDomain(req);
    if (domain && hostOf(req) === domain) {
        if (pathname.startsWith("/_next/") || pathname.startsWith("/static/") || pathname.startsWith("/images/") || pathname.startsWith("/fonts/")) return NextResponse.next();
        if (pathname.startsWith("/api/")) {
            return PORTAL_API_ALLOWED(pathname)
                ? NextResponse.next()
                : NextResponse.json({ message: "Not found" }, { status: 404 });
        }
        if (/\.[a-z0-9]{2,5}$/i.test(pathname)) return NextResponse.next(); // files from /public (icons, robots)
        // A portal page asked for by its internal name (the server asks for it that way after the rewrite below, and
        // someone may type it): served as it is, with the portal's own paths.
        if (pathname === "/portal" || pathname.startsWith("/portal/")) {
            return NextResponse.next({ request: { headers: withHeaders(req, { "x-adg-portal": "1", "x-adg-portal-base": "" }) } });
        }
        const url = req.nextUrl.clone();
        // The rewrite must stay on this server's own http address, or Next takes it for an outside address and tries to proxy it.
        url.protocol = "http:";
        url.pathname = pathname === "/" ? "/portal" : `/portal${pathname}`;
        return NextResponse.rewrite(url, { request: { headers: withHeaders(req, { "x-adg-portal": "1", "x-adg-portal-base": "" }) } });
    }

    // Reachable on the main address too (before the domain is set up, or to try it), with its own sign-in.
    if (pathname === "/portal" || pathname.startsWith("/portal/")) {
        return NextResponse.next({ request: { headers: withHeaders(req, { "x-adg-portal": "1", "x-adg-portal-base": "/portal" }) } });
    }

    // Normalize old path
    if (pathname === "/auth/login") {
        const url = publicUrl(req);
        url.pathname = "/login";
        url.searchParams.set("next", "/");
        return NextResponse.redirect(url);
    }

    // Skip static & login
    if (
        pathname === "/login" ||
        pathname.startsWith("/_next/") ||
        pathname.startsWith("/static/") ||
        pathname.startsWith("/images/") ||
        pathname.startsWith("/fonts/")
    ) {
        return NextResponse.next();
    }

    // Allow FE-only API routes
    if (pathname.startsWith("/api/")) {
        return NextResponse.next();
    }

    if (PUBLIC_PATHS.has(pathname)) {
        return NextResponse.next();
    }

    // Customers open these from an emailed link and have no account.
    if (pathname.startsWith("/pay/") || pathname === "/survey") {
        return NextResponse.next();
    }

    // Require auth cookie in general
    const token = req.cookies.get(AUTH_COOKIE)?.value;
    if (!token) {
        const url = publicUrl(req);
        url.pathname = "/login";
        url.searchParams.set("next", pathname || "/");
        return NextResponse.redirect(url);
    }

    // Hard-gate Administration
    if (pathname.startsWith("/administration")) {
        try {
            const apiBase = getApiBase(req);
            const res = await fetch(`${apiBase}/api/auth/me`, {
                headers: { cookie: req.headers.get("cookie") ?? "" },
                cache: "no-store",
            });
            if (!res.ok) throw new Error(`auth/me ${res.status}`);
            const data = await res.json();
            const perms: string[] =
                data?.user?.permissions ??
                data?.permissions ??
                [];
            const hasAdmin = Array.isArray(perms) && perms.includes("admin.access");
            if (!hasAdmin) {
                const url = publicUrl(req);
                url.pathname = "/";
                url.searchParams.set("denied", "admin");
                return NextResponse.redirect(url);
            }
        } catch {
            const url = publicUrl(req);
            url.pathname = "/login";
            url.searchParams.set("next", pathname || "/");
            return NextResponse.redirect(url);
        }
    }

    return NextResponse.next();
}

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
