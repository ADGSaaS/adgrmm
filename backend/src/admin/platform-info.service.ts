// backend/src/admin/platform-info.service.ts
//
// What the System and Migrations screens show: facts about this server and its database, read live. Read-only.
import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaService } from "../storage/prisma.service";
import { DiagnosticsService, safe } from "./diagnostics.service";

export type MigrationRow = {
    name: string;
    startedAt: string;
    appliedAt: string | null;
    appliedSteps: number;
    state: "applied" | "failed" | "rolled_back";
    /** The first line of the error, only for a migration that failed. */
    error?: string;
};

/** Where the migration folders are, next to the running code (the backend folder), or null when not shipped. */
export function migrationsDir(cwd = process.cwd()): string | null {
    for (const candidate of [path.join(cwd, "prisma", "migrations"), path.join(__dirname, "..", "..", "prisma", "migrations")]) {
        try {
            if (fs.statSync(candidate).isDirectory()) return candidate;
        } catch {
            /* try the next place */
        }
    }
    return null;
}

/** Folder names that look like Prisma migrations, in the order they are applied. */
export function migrationsOnDisk(dir: string): string[] {
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name) && fs.existsSync(path.join(dir, e.name, "migration.sql")))
        .map((e) => e.name)
        .sort();
}

/** How the server was started, as far as the process itself can tell. Nothing here reads the installer's files. */
export function installMode(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): { mode: "docker" | "systemd" | "manual"; description: string } {
    if (exists("/.dockerenv") || env.container === "docker") return { mode: "docker", description: "Running in a Docker container." };
    if (env.INVOCATION_ID) return { mode: "systemd", description: "Running as a system service (systemd)." };
    return { mode: "manual", description: "Started by hand or by a development tool, not as a service or container." };
}

@Injectable()
export class PlatformInfoService {
    constructor(private readonly prisma: PrismaService, private readonly diagnostics: DiagnosticsService) { }

    async system() {
        const [app, database, disk, agents] = await Promise.all([
            safe(() => this.diagnostics.app()),
            safe(() => this.diagnostics.database()),
            safe(() => this.diagnostics.disk()),
            safe(() => this.diagnostics.agents()),
        ]);
        return { generatedAt: new Date().toISOString(), install: installMode(), app, database, disk, agents };
    }

    async migrations() {
        const dir = migrationsDir();
        const rows = await this.prisma.$queryRaw<{ migration_name: string; started_at: Date; finished_at: Date | null; rolled_back_at: Date | null; applied_steps_count: number; logs: string | null }[]>`
          SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, logs
            FROM _prisma_migrations ORDER BY started_at ASC, migration_name ASC`;
        const items: MigrationRow[] = rows.map((r) => {
            const state = r.finished_at ? "applied" : r.rolled_back_at ? "rolled_back" : "failed";
            return {
                name: r.migration_name,
                startedAt: r.started_at.toISOString(),
                appliedAt: r.finished_at ? r.finished_at.toISOString() : null,
                appliedSteps: Number(r.applied_steps_count ?? 0),
                state,
                ...(state === "failed" && r.logs ? { error: String(r.logs).split("\n").find((l) => l.trim()) ?.slice(0, 300) ?? "" } : {}),
            };
        });
        // A migration counts as done once it has a finished row. A failed attempt that was later re-run shows both rows.
        const done = new Set(items.filter((i) => i.state === "applied").map((i) => i.name));
        const onDisk = dir ? migrationsOnDisk(dir) : null;
        const pending = onDisk ? onDisk.filter((n) => !done.has(n)) : null;
        const failed = [...new Set(items.filter((i) => i.state === "failed" && !done.has(i.name)).map((i) => i.name))];
        return {
            generatedAt: new Date().toISOString(),
            folderFound: !!dir,
            summary: {
                applied: done.size,
                pending: pending ? pending.length : null,
                failed: failed.length,
                latest: items.filter((i) => i.state === "applied").slice(-1)[0]?.name ?? null,
            },
            pending,
            failed,
            items: items.reverse(),
        };
    }
}
