import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import * as fs from "fs/promises";
import * as path from "path";

const NAME_SPLIT_REGEX = /\s+/;

function splitDisplayName(name: unknown): { first: string | null; last: string | null } {
    if (typeof name !== "string") return { first: null, last: null };

    const parts = name.trim().split(NAME_SPLIT_REGEX).filter(Boolean);
    if (parts.length === 0) return { first: null, last: null };
    if (parts.length === 1) return { first: parts[0], last: null };

    const last = parts.pop() as string;
    return { first: parts.join(" "), last };
}

@Injectable()
export class MeService {
    constructor(private readonly prisma: PrismaService) { }

    // Compose a public URL for files served from /public (not used by controller anymore, but kept for compatibility)
    makePublicUrl(filename: string) {
        const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
        const staticBase = base ? (base.endsWith("/static") ? base : `${base}/static`) : "";
        return staticBase ? `${staticBase}/uploads/${filename}` : `/static/uploads/${filename}`;
    }

    /* ------------------------------ Helpers for local file cleanup ------------------------------ */

    /** Extract a local filesystem path for files under `/static/uploads/<name>` or `/uploads/<name>` */
    private toLocalUploadPathFromUrl(url?: string | null): string | null {
        if (!url) return null;
        let pathname = "";
        try {
            // absolute http(s) url
            const u = new URL(url);
            pathname = u.pathname;
        } catch {
            // not a full URL; treat as pathname-like
            pathname = url;
        }

        // Normalize where '/uploads/...' might appear (with or without /static prefix)
        const idx = pathname.indexOf("/uploads/");
        if (idx === -1) return null;

        const filename = pathname.substring(idx + "/uploads/".length);
        if (!filename || filename.includes("..")) return null;

        // Resolve to <project>/public/uploads/<filename>
        const uploadsDir = path.join(__dirname, "..", "public", "uploads");
        const abs = path.join(uploadsDir, filename);

        // Ensure file stays inside uploads dir (avoid traversal)
        const normUploads = path.normalize(uploadsDir + path.sep);
        const normFile = path.normalize(abs);
        if (!normFile.startsWith(normUploads)) return null;

        return normFile;
    }

    private async tryDeleteLocalFile(filePath: string | null) {
        if (!filePath) return;
        try {
            await fs.unlink(filePath);
        } catch {
            // swallow (file may not exist or we lack perms; not fatal)
        }
    }

    /* ------------------------------------ Profile CRUD ------------------------------------ */

    async getMe(userId: string) {
        const row = await this.prisma.users.findUnique({ where: { id: userId } });
        if (!row) return {};

        const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ").replace(/^ +| +$/g, "");

        return {
            id: row.id,
            name: fullName || row.email.split("@")[0],
            email: row.email,
            phone: row.phone ?? "",
            timezone: row.timezone ?? "",
            locale: row.locale ?? "",
            avatarUrl: row.avatar_url ?? "",
            avatarThumbUrl: row.avatar_thumb_url ?? "",
            address1: row.address1 ?? "",
            address2: row.address2 ?? "",
            city: row.city ?? "",
            state: row.state ?? "",
            postal: row.postal ?? "",
            country: row.country ?? "",
        };
    }

    async updateMe(userId: string, patch: Record<string, any>) {
        // Only accept known columns; convert avatarUrl -> avatar_url
        const map: Record<string, string> = {
            email: "email",
            phone: "phone",
            timezone: "timezone",
            locale: "locale",
            avatarUrl: "avatar_url",
            address1: "address1",
            address2: "address2",
            city: "city",
            state: "state",
            postal: "postal",
            country: "country",
        };

        const data: Record<string, string | null> = {};

        if (Object.prototype.hasOwnProperty.call(patch || {}, "name")) {
            const { first, last } = splitDisplayName(patch?.name);
            data.first_name = first;
            data.last_name = last;
        }

        for (const [k, v] of Object.entries(patch || {})) {
            if (k === "name") continue;
            const col = map[k];
            if (!col) continue;
            // This route's body is untyped, and these columns are all text.
            const value = v == null ? null : String(v);
            data[col] = value;
            // keep thumb in sync if avatarUrl is set directly through PATCH
            if (col === "avatar_url") data.avatar_thumb_url = value;
        }
        if (Object.keys(data).length === 0) {
            return this.getMe(userId);
        }

        await this.prisma.users.updateMany({
            where: { id: userId },
            data: { ...data, updated_at: new Date() } as any,
        });
        return this.getMe(userId);
    }

    /**
     * Replace avatar URLs and delete the previous local file (if any and if it was under /uploads).
     * If `nextUrl` is null, clears both avatar fields and removes old local file.
     */
    async replaceAvatarUrl(userId: string, nextUrl: string | null) {
        // first, read previous urls
        const prev = (await this.prisma.users.findUnique({
            where: { id: userId },
            select: { avatar_url: true, avatar_thumb_url: true },
        })) ?? { avatar_url: null, avatar_thumb_url: null };

        // upsert new URL(s); for now thumb mirrors the main url
        await this.prisma.users.updateMany({
            where: { id: userId },
            data: { avatar_url: nextUrl, avatar_thumb_url: nextUrl, updated_at: new Date() },
        });

        // delete the previous local file if it lived under /uploads and is different than new
        const oldUrl = prev.avatar_url;
        if (oldUrl && oldUrl !== nextUrl) {
            const localPath = this.toLocalUploadPathFromUrl(oldUrl);
            await this.tryDeleteLocalFile(localPath);
        }

        // return updated profile
        return this.getMe(userId);
    }

    /** Kept for compatibility with earlier calls; now delegates to replaceAvatarUrl */
    async setAvatarUrl(userId: string, url: string | null) {
        return this.replaceAvatarUrl(userId, url);
    }
}
