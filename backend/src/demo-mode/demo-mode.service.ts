// backend/src/demo-mode/demo-mode.service.ts
//
// The public demo's life cycle. Only does anything when DEMO_MODE=1.
//
//   start     keep a copy of the empty install (organisation, roles, the demo user, settings) the first time, then wipe the
//             database back to that copy and fill it with fresh sample data. So every start is a clean demo.
//   running   web pages send a "ping" every few seconds while someone has the demo open. Allowed changes mark the demo "dirty".
//   leaving   about a minute after the last ping, if anything was changed (or the sample data has aged), the server exits.
//             Docker starts it again, and the start above puts a fresh demo in place. Restarting also clears every cache.
//
// Nothing here runs in a normal install.
import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";

type PgClient = InstanceType<typeof Client>;
import { DemoService } from "../demo/demo.service";
import { isDemoMode } from "./demo-mode.rules";

const IDLE_MS = Math.max(15, Number(process.env.DEMO_IDLE_SECONDS || 60)) * 1000;
const STALE_MS = 30 * 60_000;   // sample data older than this is refreshed after a visit, so "seen 2 hours ago" stays believable
const HARD_MS = 4 * 3600_000;   // and after this even if nobody visited
const SKIP = new Set(["_prisma_migrations"]);

@Injectable()
export class DemoModeService implements OnApplicationBootstrap {
    private readonly log = new Logger("DemoMode");
    private readonly visitors = new Map<string, number>();
    private lastPing = 0;
    private dirty = false;
    private visited = false;
    private seededAt = Date.now();
    private leaving = false;

    constructor(private readonly demo: DemoService) { }

    // ------------------------------------------------------------------ visitors
    ping(id: string) {
        const now = Date.now();
        this.lastPing = now;
        this.visited = true;
        this.visitors.set(String(id).slice(0, 64), now);
        if (this.visitors.size > 500) this.prune(now);
    }
    markDirty() { this.dirty = true; }
    get isResetting() { return this.leaving; }
    private prune(now: number) { for (const [k, t] of this.visitors) if (now - t > IDLE_MS) this.visitors.delete(k); }

    // ------------------------------------------------------------------ start
    async onApplicationBootstrap() {
        if (!isDemoMode()) return;
        const started = Date.now();
        try {
            await this.snapshotIfNeeded();
            await this.restoreBaseline();
            await this.demo.enable();
            this.seededAt = Date.now();
            this.log.log(`Demo ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        } catch (err) {
            // A demo that cannot be filled is worse than none: stop, so the container's restart policy tries again.
            this.log.error(`Could not prepare the demo: ${(err as Error)?.message ?? err}`);
            setTimeout(() => process.exit(1), 500);
            return;
        }
        const timer = setInterval(() => this.tick(), 5000);
        timer.unref?.();
    }

    private tick() {
        if (this.leaving) return;
        const now = Date.now();
        this.prune(now);
        if (this.visitors.size > 0) return;                          // somebody is still looking
        const idleFor = now - Math.max(this.lastPing, this.seededAt);
        if (idleFor < IDLE_MS) return;                               // wait the full minute
        const age = now - this.seededAt;
        if (this.dirty || (this.visited && age > STALE_MS) || age > HARD_MS) {
            this.leaving = true;
            this.log.log(`Nobody has been here for ${Math.round(idleFor / 1000)} s${this.dirty ? " and the demo was changed" : ""}: restarting for a fresh demo`);
            setTimeout(() => process.exit(0), 300);
        }
    }

    // ------------------------------------------------------------------ database
    private connect(): PgClient {
        const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined;
        return new Client({ connectionString: process.env.DATABASE_URL, ssl });
    }

    private baselineFile() {
        const dir = process.env.DEMO_STATE_DIR || process.env.DATA_DIR || "/data/var";
        fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, "demo-baseline.json");
    }

    private async tables(c: PgClient): Promise<string[]> {
        const r = await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
        return r.rows.map((x: { tablename: string }) => x.tablename).filter((t: string) => !SKIP.has(t));
    }

    /** Saves the empty install the first time the demo starts. After that the file is the reference every reset returns to. */
    private async snapshotIfNeeded() {
        const file = this.baselineFile();
        if (fs.existsSync(file)) return;
        const c = this.connect();
        await c.connect();
        try {
            const clients = await c.query("SELECT count(*)::int AS n FROM clients");
            if ((clients.rows[0]?.n ?? 0) > 0) throw new Error("The demo database already holds customers, so it cannot be used as the clean starting point. Start from a new install.");
            const out: Record<string, unknown[]> = {};
            for (const t of await this.tables(c)) {
                const r = await c.query(`SELECT COALESCE(json_agg(x), '[]'::json) AS rows FROM "public"."${t}" x`);
                out[t] = r.rows[0].rows;
            }
            fs.writeFileSync(file, JSON.stringify(out), { mode: 0o600 });
            this.log.log(`Saved the clean starting point (${Object.keys(out).length} tables)`);
        } finally {
            await c.end();
        }
    }

    /** Empties every table and puts the clean starting point back. */
    private async restoreBaseline() {
        const baseline = JSON.parse(fs.readFileSync(this.baselineFile(), "utf8")) as Record<string, Array<Record<string, unknown>>>;
        const c = this.connect();
        await c.connect();
        try {
            await c.query("BEGIN");
            await c.query("SET LOCAL session_replication_role = replica");
            const tables = await this.tables(c);
            if (tables.length) await c.query(`TRUNCATE ${tables.map((t) => `"public"."${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
            for (const t of tables) {
                const rows = baseline[t];
                if (!rows?.length) continue;
                const cols = await c.query(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position", [t]);
                const list = cols.rows.map((x: { column_name: string }) => `"${x.column_name}"`).join(", ");
                await c.query(
                    `INSERT INTO "public"."${t}" (${list}) OVERRIDING SYSTEM VALUE SELECT ${list} FROM json_populate_recordset(null::"public"."${t}", $1::json)`,
                    [JSON.stringify(rows)]);
            }
            // Counters that run on from the highest id, so new rows do not collide with the restored ones.
            const seq = await c.query(
                `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`);
            for (const s of seq.rows as Array<{ table_name: string; column_name: string }>) {
                if (SKIP.has(s.table_name)) continue;
                await c.query(
                    `SELECT setval(pg_get_serial_sequence('"public"."${s.table_name}"', '${s.column_name}'), COALESCE(MAX("${s.column_name}"), 0) + 1, false) FROM "public"."${s.table_name}"`);
            }
            await c.query("COMMIT");
        } catch (err) {
            await c.query("ROLLBACK").catch(() => undefined);
            throw err;
        } finally {
            await c.end();
        }
    }
}
