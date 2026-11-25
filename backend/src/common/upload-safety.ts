// backend/src/common/upload-safety.ts
//
// Files people upload are served back without sign-in under /static/uploads. A file the browser would run (HTML, SVG, JS)
// must never be stored or served as active content, so: uploads keep only extensions from a known-safe list, branding
// images are accepted only as raster types, and every response from /static carries headers that stop rendering anything active.
import * as path from "node:path";

/** Extensions a ticket attachment may keep. Anything else is stored as .bin. None of these is rendered as active content. */
const SAFE_ATTACHMENT_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic",
    "pdf", "txt", "log", "csv", "tsv", "json", "md", "rtf",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "msg", "eml",
    "zip", "7z", "gz", "tgz", "tar", "rar",
    "mp3", "wav", "m4a", "mp4", "mov", "webm", "avi", "mkv",
    "evtx", "etl", "dmp", "cab", "reg", "cer", "crt", "pem",
]);

/** The extension (with dot, lower case) a stored attachment gets for this original file name: a known-safe one, or .bin. */
export function safeAttachmentExtension(originalName: string | null | undefined): string {
    const ext = path.extname(String(originalName ?? "")).slice(1).toLowerCase();
    return SAFE_ATTACHMENT_EXTENSIONS.has(ext) ? `.${ext}` : ".bin";
}

/** Image types accepted for logos and favicons. No SVG: it can carry script. */
const BRANDING_EXT_BY_MIME: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
};

/** The stored extension for a branding image of this (client-supplied) MIME type, or null when the type is not accepted. */
export function brandingImageExtension(mime: string | null | undefined): string | null {
    return BRANDING_EXT_BY_MIME[String(mime ?? "").toLowerCase().trim()] ?? null;
}

/** Only these are shown inline from /static/uploads; everything else is a download. */
const INLINE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico"]);

/** The extra headers for a file served from /static, by its path relative to the static root (e.g. "uploads/tickets/x.pdf"). */
export function staticFileHeaders(relativePath: string): Record<string, string> {
    const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
    const normalized = String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    if (normalized.startsWith("uploads/")) {
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
        const ext = path.extname(normalized).slice(1);
        if (!INLINE_IMAGE_EXTENSIONS.has(ext)) headers["Content-Disposition"] = "attachment";
    }
    return headers;
}
