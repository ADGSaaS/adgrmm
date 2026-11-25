// Putting the saved branding colours on the page before it is first drawn, so nothing flashes.
//
// How it works:
//  1. Every time the branding is loaded from the server, a copy is kept in this browser (localStorage, BRANDING_CACHE_KEY).
//  2. On the next visit a tiny script in <head> (BRANDING_BOOT_SCRIPT) reads that copy and sets the colours and custom CSS
//     straight away, before the first paint.
//  3. The page then asks the server for the current branding as usual. If it changed, the colours update and the copy is
//     replaced, so a change made in Administration > Branding shows up on the next reload.
//
// `applyBrandingToDocument` must stay self-contained (no imports, no outside names): its source text is what runs in <head>.

export const BRANDING_CACHE_KEY = "riq-branding";

export type BrandingLook = {
    primaryColor?: string | null;
    secondaryColor?: string | null;
    /** undefined leaves the custom CSS alone; null or empty removes it. */
    customCss?: string | null;
};

/** Sets --primary, --secondary (and readable text colours for them) and the custom CSS on the page. Safe to call repeatedly. */
export function applyBrandingToDocument(look: BrandingLook): void {
    var HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

    function rgb(hex: string) {
        if (!HEX.test(hex)) return null;
        var h = hex.slice(1);
        if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
        var n = parseInt(h, 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    // "#3b82f6" -> "217 91% 60%", the form the theme variables use.
    function tuple(hex: string): string | null {
        var c = rgb(hex);
        if (!c) return null;
        var r = c.r / 255, g = c.g / 255, b = c.b / 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var l = (max + min) / 2, hh = 0, s = 0;
        if (max !== min) {
            var d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) hh = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) hh = (b - r) / d + 2;
            else hh = (r - g) / d + 4;
            hh /= 6;
        }
        return Math.round(hh * 360) + " " + Math.round(s * 100) + "% " + Math.round(l * 100) + "%";
    }

    // White text on a dark colour, near-black on a light one.
    function readableOn(hex: string): string {
        var c = rgb(hex);
        if (!c) return "0 0% 100%";
        function lin(v: number) {
            var x = v / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        }
        var lum = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
        return lum > 0.5 ? "224 30% 10%" : "0 0% 100%";
    }

    var style = document.documentElement.style;
    var p = look.primaryColor ? tuple(look.primaryColor) : null;
    if (p && look.primaryColor) {
        style.setProperty("--primary", p);
        style.setProperty("--primary-foreground", readableOn(look.primaryColor));
    }
    var s2 = look.secondaryColor ? tuple(look.secondaryColor) : null;
    if (s2 && look.secondaryColor) {
        style.setProperty("--secondary", s2);
        style.setProperty("--secondary-foreground", readableOn(look.secondaryColor));
    }

    if (look.customCss !== undefined) {
        var text = (look.customCss || "").trim();
        // The starter text "/* ... */" is a comment with nothing in it.
        var emptyComment = /^\/\*[\s\S]*\*\/$/.test(text) && !/[{}]/.test(text);
        var el = document.getElementById("riq-custom-css");
        if (!text || emptyComment) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        } else {
            if (!el) {
                el = document.createElement("style");
                el.id = "riq-custom-css";
                document.head.appendChild(el);
            }
            el.textContent = text;
        }
    }
}

/** The script placed in <head>. It only ever reads what this browser saved earlier, and ignores anything it cannot read. */
export const BRANDING_BOOT_SCRIPT =
    "(function(){try{var raw=window.localStorage.getItem(" +
    JSON.stringify(BRANDING_CACHE_KEY) +
    ");if(!raw)return;var look=JSON.parse(raw);if(look&&typeof look==='object'){(" +
    applyBrandingToDocument.toString() +
    ")(look);}}catch(e){}})();";
