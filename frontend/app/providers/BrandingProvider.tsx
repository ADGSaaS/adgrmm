"use client";

import * as React from "react";
import { applyBrandingToDocument, BRANDING_CACHE_KEY } from "@/lib/branding-boot";

/**
 * Branding shape coming from GET /api/branding
 */
export interface Branding {
    primaryColor: string | null;
    secondaryColor: string | null;
    logoLightUrl: string | null;
    logoDarkUrl: string | null;
    loginBackgroundUrl: string | null;
    faviconUrl: string | null;
    emailHeader: string | null;
    emailFooter: string | null;
    customCss: string | null;
    allowClientThemeToggle: boolean | null;
}

type PreviewPatch = Partial<Pick<Branding, "primaryColor" | "secondaryColor" | "faviconUrl">>;

interface BrandingContextType {
    branding: Branding | null;
    isLoaded: boolean;
    applyPreview: (patch: PreviewPatch) => void;
    clearPreview: () => void;
    refetch: () => Promise<void>;
}

const BrandingContext = React.createContext<BrandingContextType | undefined>(undefined);

// These match the colours the theme starts with in styles/globals.css, so a first visit with no saved branding does not flash either.
const DEFAULT_PRIMARY = "#3b82f6";
const DEFAULT_SECONDARY = "#22c55e";
const DEFAULT_FAVICON = "/favicon.ico"; // <- default from public/

/* ====================== Browser copy of the branding ====================== */

/** What is kept in this browser so the next visit can colour the page before it is drawn. */
type CachedBranding = Pick<Branding, "primaryColor" | "secondaryColor" | "customCss" | "logoLightUrl" | "logoDarkUrl" | "faviconUrl" | "loginBackgroundUrl">;

function readCache(): CachedBranding | null {
    try {
        const raw = window.localStorage.getItem(BRANDING_CACHE_KEY);
        const parsed = raw ? (JSON.parse(raw) as CachedBranding) : null;
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function writeCache(b: Branding) {
    const next: CachedBranding = {
        primaryColor: b.primaryColor,
        secondaryColor: b.secondaryColor,
        customCss: b.customCss,
        logoLightUrl: b.logoLightUrl,
        logoDarkUrl: b.logoDarkUrl,
        faviconUrl: b.faviconUrl,
        loginBackgroundUrl: b.loginBackgroundUrl,
    };
    try {
        window.localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(next));
    } catch {
        /* private mode or full storage: the page still works, it just cannot pre-colour next time */
    }
}

/* ====================== Favicon helpers ====================== */

function ensureFaviconLink(): HTMLLinkElement {
    // Prefer rel="icon", but also handle existing "shortcut icon"
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
    }
    return link;
}

function setFavicon(href: string) {
    const link = ensureFaviconLink();
    link.href = href || DEFAULT_FAVICON;
}

/* ====================== Normalizer ====================== */

function normalizeBranding(b: Partial<Branding> | null): Branding {
    return {
        primaryColor: b?.primaryColor ?? DEFAULT_PRIMARY,
        secondaryColor: b?.secondaryColor ?? DEFAULT_SECONDARY,
        logoLightUrl: b?.logoLightUrl ?? "",
        logoDarkUrl: b?.logoDarkUrl ?? "",
        loginBackgroundUrl: b?.loginBackgroundUrl ?? "",
        faviconUrl: b?.faviconUrl ?? "",
        emailHeader: b?.emailHeader ?? "<h1>{{org_name}}</h1>",
        emailFooter: b?.emailFooter ?? "<p>Copyright 2025. All rights reserved.</p>",
        customCss: b?.customCss ?? "/* ... */",
        allowClientThemeToggle: b?.allowClientThemeToggle ?? true,
    };
}

/* ====================== Provider ====================== */

// Runs before the browser paints on the client, so the logos from the saved copy are there on the first frame.
const useIsoLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

export function BrandingProvider({ children }: { children: React.ReactNode }) {
    const [branding, setBranding] = React.useState<Branding | null>(null);
    const [isLoaded, setIsLoaded] = React.useState(false);

    const applyThemeVars = React.useCallback((b: Branding | null) => {
        applyBrandingToDocument({
            primaryColor: b?.primaryColor || DEFAULT_PRIMARY,
            secondaryColor: b?.secondaryColor || DEFAULT_SECONDARY,
            customCss: b?.customCss ?? null,
        });
    }, []);

    const applyInitialFavicon = React.useCallback((b: Branding | null) => {
        const src = b?.faviconUrl?.trim() || DEFAULT_FAVICON;
        setFavicon(src);
    }, []);

    // 1) The saved copy goes on straight away (the head script has usually done the colours already).
    useIsoLayoutEffect(() => {
        const cached = readCache();
        if (!cached) return;
        const norm = normalizeBranding(cached);
        setBranding(norm);
        applyThemeVars(norm);
        applyInitialFavicon(norm);
    }, [applyInitialFavicon, applyThemeVars]);

    // 2) Then the current branding is fetched on every load. If it differs, the page updates and the saved copy is replaced.
    const fetchBranding = React.useCallback(async () => {
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/branding`, {
                method: "GET",
                credentials: "include",
                headers: { Accept: "application/json" },
                cache: "no-store",
            });
            if (!res.ok) {
                throw new Error(`GET /api/branding failed: ${res.status}`);
            }
            const data = (await res.json()) as Branding;
            const norm = normalizeBranding(data);
            setBranding(norm);
            applyThemeVars(norm);
            applyInitialFavicon(norm);
            writeCache(norm);
        } catch (e) {
            // A failed request must not undo colours that are already on the page. Only fall back to the defaults
            // when there is nothing saved and nothing showing.
            setBranding((current) => {
                if (current) return current;
                const norm = normalizeBranding(readCache());
                applyThemeVars(norm);
                applyInitialFavicon(norm);
                return norm;
            });
            // eslint-disable-next-line no-console
            console.warn(e);
        } finally {
            setIsLoaded(true);
        }
    }, [applyInitialFavicon, applyThemeVars]);

    React.useEffect(() => {
        fetchBranding();
    }, [fetchBranding]);

    /**
     * applyPreview:
     * - Accepts partial { primaryColor?, secondaryColor?, faviconUrl? }
     * - Applies CSS vars and/or favicon temporarily without mutating `branding` or the saved copy.
     */
    const applyPreview = React.useCallback((patch: PreviewPatch) => {
        if (patch.primaryColor || patch.secondaryColor) {
            applyBrandingToDocument({ primaryColor: patch.primaryColor, secondaryColor: patch.secondaryColor });
        }
        if (patch.faviconUrl !== undefined) {
            setFavicon(patch.faviconUrl?.trim() || DEFAULT_FAVICON);
        }
    }, []);

    /**
     * clearPreview:
     * - Reapplies CSS vars + favicon from the current saved branding (or defaults)
     */
    const clearPreview = React.useCallback(() => {
        applyThemeVars(branding);
        applyInitialFavicon(branding);
    }, [applyInitialFavicon, applyThemeVars, branding]);

    const value: BrandingContextType = React.useMemo(
        () => ({ branding, isLoaded, applyPreview, clearPreview, refetch: fetchBranding }),
        [branding, isLoaded, applyPreview, clearPreview, fetchBranding]
    );

    return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
    const ctx = React.useContext(BrandingContext);
    if (!ctx) throw new Error("useBranding must be used within BrandingProvider");
    return ctx;
}
