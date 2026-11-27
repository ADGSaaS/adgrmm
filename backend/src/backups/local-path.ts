// backend/src/backups/local-path.ts
import { BadRequestException } from "@nestjs/common";
import * as pathMod from "path";

export function isWindowsPath(p: string) {
    return /^[A-Za-z]:\\/.test(p);
}
export function isAbsolutePath(p: string) {
    return p.startsWith("/") || isWindowsPath(p);
}
/**
 * A folder on this server that backups may be written to. It must be absolute and free of ".." and NUL, and is normalised
 * (repeated and trailing separators removed). Only a person with the backups.manage permission can choose it, because writing to a
 * folder of their choosing is what a local backup destination is. When BACKUP_LOCAL_ROOTS is set (comma-separated folders), the
 * choice must also lie inside one of them; unset, any absolute folder is accepted as before.
 */
export function sanitizeLocalPath(p: string, roots: string | undefined = process.env.BACKUP_LOCAL_ROOTS) {
    if (typeof p !== "string" || !isAbsolutePath(p)) throw new BadRequestException("Path must be absolute");
    if (p.includes("..") || p.includes("\0")) throw new BadRequestException("Invalid path");
    const m = isWindowsPath(p) ? pathMod.win32 : pathMod.posix;
    const clean = m.normalize(p);
    const allowed = (roots ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    if (allowed.length) {
        const inside = allowed.some((r) => {
            const rel = m.relative(m.normalize(r), clean);
            return rel === "" || (rel !== ".." && !rel.startsWith(".." + m.sep) && !m.isAbsolute(rel));
        });
        if (!inside) throw new BadRequestException("That folder is not one of the folders backups may be written to.");
    }
    return clean;
}
