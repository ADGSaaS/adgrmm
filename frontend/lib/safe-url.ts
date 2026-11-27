// frontend/lib/safe-url.ts
//
// Addresses typed or loaded as text and then put into an <img src> or <source srcSet>. Only addresses that can show a picture are
// kept: http(s), a path on this site, a blob made in this browser, and base64 image data. Anything else (javascript:, other data:
// types, file:, ...) gives undefined, so the element shows nothing instead of running or fetching it.

const IMAGE_DATA = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]*$/i;

export function safeImageSrc(value: string | null | undefined): string | undefined {
  const v = String(value ?? "").trim();
  if (!v || v.length > 2_000_000) return undefined;
  // a path on this site, with or without the leading slash (but not "//host", which names another site)
  if (!v.startsWith("//") && !v.startsWith("/\\") && !/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  if (IMAGE_DATA.test(v)) return v;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "blob:") return v;
  } catch {
    /* not an absolute address */
  }
  return undefined;
}
