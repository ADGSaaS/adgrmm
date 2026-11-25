// Small helpers for device file paths and sizes, shared by the Files tab and the Remote Console's Files panel.
import type { FsItem } from "@/lib/device-files-api";

export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;

export function fmtBytes(n?: number | null) {
    if (n == null || !Number.isFinite(n) || n < 0) return "—";
    if (n === 0) return "0 B";
    const k = 1024;
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
    const v = n / Math.pow(k, i);
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function sortFs(items: FsItem[]) {
    const arr = [...items];
    arr.sort((a, b) => {
        if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
    });
    return arr;
}

export function isWindowsPath(p: string) {
    return /^[A-Za-z]:(\\|$)/.test(p);
}

export function samePath(a: string, b: string) {
    if (isWindowsPath(a) || isWindowsPath(b)) return a.toLowerCase() === b.toLowerCase();
    return a === b;
}

export function baseName(p: string) {
    const s = String(p ?? "");
    const sep = s.includes("\\") ? "\\" : "/";
    const parts = s.split(sep).filter(Boolean);
    return parts[parts.length - 1] ?? s;
}

export function dirName(p: string) {
    const s = String(p ?? "");
    const sep = s.includes("\\") ? "\\" : "/";
    const idx = s.lastIndexOf(sep);
    if (idx <= 0) return s; // root-ish
    return s.slice(0, idx + 1); // keep trailing sep for easy join
}

export function joinPath(dir: string, name: string) {
    const d = String(dir ?? "");
    const n = String(name ?? "");
    if (!d) return n;
    if (!n) return d;
    const win = isWindowsPath(d) || d.includes("\\");
    const sep = win ? "\\" : "/";
    const d2 = d.endsWith(sep) ? d : d + sep;
    return d2 + n;
}

export function downloadBase64AsFile(contentBase64: string, filename: string) {
    const b64 = String(contentBase64 ?? "").trim();
    if (!b64) return;

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download.bin";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1500);
}
