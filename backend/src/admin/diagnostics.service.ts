import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaService } from "../storage/prisma.service";
import { EnvironmentService } from "./environment.service";

export type Finding = { level: "problem" | "warning" | "info"; area: string; message: string };

/** Runs one part of the report. A part that fails is reported as failed, and the rest still arrive. */
export async function safe<T>(fn: () => Promise<T> | T): Promise<T | { error: string }> {
    try {
        return await fn();
    } catch (e: any) {
        return { error: String(e?.message ?? e).split("\n")[0].slice(0, 300) };
    }
}

const failed = (x: unknown): x is { error: string } => !!x && typeof x === "object" && "error" in (x as any) && typeof (x as any).error === "string" && Object.keys(x as any).length === 1;

/** The git commit this server is running, read from the checkout without running anything. */
function gitCommit(): string | null {
    try {
        let dir = process.cwd();
        for (let i = 0; i < 4; i++) {
            const head = path.join(dir, ".git", "HEAD");
            if (fs.existsSync(head)) {
                const ref = fs.readFileSync(head, "utf8").trim();
                if (!ref.startsWith("ref:")) return ref.slice(0, 12);
                const name = ref.slice(5).trim();
                const loose = path.join(dir, ".git", name);
                if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim().slice(0, 12);
                const packed = path.join(dir, ".git", "packed-refs");
                if (fs.existsSync(packed)) {
                    const line = fs.readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(` ${name}`));
                    if (line) return line.slice(0, 12);
                }
                return null;
            }
            dir = path.dirname(dir);
        }
    } catch {
        /* not a checkout */
    }
    return null;
}

const hostOf = (url: string | null | undefined) => {
    try {
        return url ? new URL(url).host : null;
    } catch {
        return null;
    }
};

/**
 * A report for troubleshooting and for support: what this server is running, whether its parts are healthy, and what
 * has been going wrong lately. It never holds a secret, a password, a token, a customer's data or a ticket's text:
 * only names, counts, dates, and settings that are safe to show.
 */
@Injectable()
export class DiagnosticsService {
    constructor(private readonly prisma: PrismaService, private readonly env: EnvironmentService) { }

    async report(orgId: string, requestedBy: string | null) {
        const [app, database, disk, agents, tasks, email, mailbox, sso, imports, audit, environment] = await Promise.all([
            safe(() => this.app()),
            safe(() => this.database()),
            safe(() => this.disk()),
            safe(() => this.agents()),
            safe(() => this.tasks()),
            safe(() => this.email()),
            safe(() => this.mailbox(orgId)),
            safe(() => this.sso(orgId)),
            safe(() => this.imports(orgId)),
            safe(() => this.audit()),
            safe(() => this.environment()),
        ]);
        const report = { generatedAt: new Date().toISOString(), requestedBy, app, database, disk, agents, tasks, email, mailbox, sso, imports, audit, environment };
        return { ...report, findings: this.findings(report) };
    }

    app() {
        let version = "unknown";
        try {
            version = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version ?? version;
        } catch {
            /* no package.json next to the process */
        }
        const mem = process.memoryUsage();
        return {
            name: "remoteiq-backend",
            packageVersion: version,
            commit: gitCommit(),
            node: process.version,
            platform: `${os.platform()} ${os.release()}`,
            arch: os.arch(),
            nodeEnv: process.env.NODE_ENV ?? null,
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime()),
            serverTime: new Date().toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576), heapTotal: Math.round(mem.heapTotal / 1048576) },
            systemMemoryMb: { total: Math.round(os.totalmem() / 1048576), free: Math.round(os.freemem() / 1048576) },
            cpus: os.cpus().length,
            loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
        };
    }

    async database() {
        const [v] = await this.prisma.$queryRaw<{ version: string; size: bigint; connections: number }[]>`
          SELECT version() AS version, pg_database_size(current_database()) AS size,
                 (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections`;
        const migrations = await this.prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
          SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 400`;
        // Estimates, so a large table does not make the report slow.
        const rows = await this.prisma.$queryRaw<{ name: string; estimate: number }[]>`
          SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint::int AS estimate
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('devices', 'agents', 'tickets', 'ticket_activity', 'users', 'audit_events', 'alerts', 'agent_tasks', 'software_inventory', 'time_entries')`;
        const unfinished = migrations.filter((m) => !m.finished_at && !m.rolled_back_at).map((m) => m.migration_name);
        return {
            version: v.version.split(" on ")[0],
            sizeMb: Math.round(Number(v.size) / 1048576),
            connections: v.connections,
            migrations: {
                applied: migrations.filter((m) => m.finished_at).length,
                unfinished,
                rolledBack: migrations.filter((m) => m.rolled_back_at).map((m) => m.migration_name),
                latest: migrations.slice(0, 5).map((m) => ({ name: m.migration_name, finishedAt: m.finished_at?.toISOString() ?? null })),
            },
            approximateRows: Object.fromEntries(rows.map((r) => [r.name, r.estimate])),
        };
    }

    async disk() {
        const stat = async (label: string, p: string) => {
            try {
                const s: any = await (fs.promises as any).statfs(p);
                const total = Number(s.blocks) * Number(s.bsize);
                const free = Number(s.bavail) * Number(s.bsize);
                return { label, totalGb: Math.round((total / 1073741824) * 10) / 10, freeGb: Math.round((free / 1073741824) * 10) / 10, freePercent: total ? Math.round((free / total) * 100) : null };
            } catch (e: any) {
                return { label, error: String(e?.message ?? e).slice(0, 120) };
            }
        };
        const uploads = path.join(process.cwd(), "public", "uploads");
        return [await stat("application", process.cwd()), ...(fs.existsSync(uploads) ? [await stat("uploads", uploads)] : []), await stat("temp", os.tmpdir())];
    }

    async agents() {
        const byVersion = await this.prisma.$queryRaw<{ version: string | null; n: number; online: number }[]>`
          SELECT version, count(*)::int AS n, count(*) FILTER (WHERE last_check_in_at > now() - interval '3 minutes')::int AS online
            FROM agents GROUP BY version ORDER BY n DESC LIMIT 30`;
        const [t] = await this.prisma.$queryRaw<{ total: number; online: number; stale_day: number; never: number }[]>`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE last_check_in_at > now() - interval '3 minutes')::int AS online,
                 count(*) FILTER (WHERE last_check_in_at < now() - interval '1 day')::int AS stale_day,
                 count(*) FILTER (WHERE last_check_in_at IS NULL)::int AS never FROM agents`;
        const packages: Record<string, unknown> = {};
        for (const osName of ["windows", "linux"]) {
            const base = process.env.AGENT_PKG_DIR ? path.resolve(process.env.AGENT_PKG_DIR) : path.join(process.cwd(), "assets", "agent-packages");
            try {
                const v = JSON.parse(fs.readFileSync(path.join(base, osName, "version.json"), "utf8"));
                packages[osName] = { version: v.version ?? null, sha256: String(v.sha256 ?? "").slice(0, 12) || null };
            } catch {
                packages[osName] = null;
            }
        }
        return { total: t.total, online: t.online, notSeenForADay: t.stale_day, neverCheckedIn: t.never, byVersion: byVersion.map((r) => ({ version: r.version ?? "unknown", agents: r.n, online: r.online })), packagesOnServer: packages };
    }

    private async tasks() {
        const status = await this.prisma.$queryRaw<{ status: string; n: number }[]>`SELECT status::text AS status, count(*)::int AS n FROM agent_tasks GROUP BY status`;
        const recent = await this.prisma.$queryRaw<{ type: string; status: string; n: number }[]>`
          SELECT type::text AS type, status::text AS status, count(*)::int AS n FROM agent_tasks WHERE created_at > now() - interval '24 hours' GROUP BY type, status ORDER BY n DESC LIMIT 40`;
        const [oldest] = await this.prisma.$queryRaw<{ minutes: number | null }[]>`
          SELECT (EXTRACT(EPOCH FROM (now() - min(created_at))) / 60)::int AS minutes FROM agent_tasks WHERE status = 'pending'`;
        return { byStatus: Object.fromEntries(status.map((s) => [s.status, s.n])), last24Hours: recent, oldestPendingMinutes: oldest?.minutes ?? null };
    }

    private async email() {
        const rows = await this.prisma.$queryRaw<{ purpose: string; enabled: boolean; smtp: boolean; imap: boolean }[]>`
          SELECT purpose, enabled, (smtp_host <> '') AS smtp, (imap_host <> '') AS imap FROM email_settings ORDER BY purpose`;
        return { purposes: rows.map((r) => ({ purpose: r.purpose, enabled: r.enabled, smtpConfigured: r.smtp, imapConfigured: r.imap })) };
    }

    private async mailbox(orgId: string) {
        const m = await this.prisma.support_mailbox.findUnique({ where: { organization_id: orgId } });
        if (!m) return { configured: false };
        return {
            configured: true,
            enabled: m.enabled,
            source: m.source,
            connected: m.source === "imap" ? true : !!m.refresh_token,
            address: m.mailbox_address || null,
            lastPolledAt: m.last_polled_at?.toISOString() ?? null,
            lastError: m.last_error,
            lastErrorAt: m.last_error_at?.toISOString() ?? null,
        };
    }

    private async sso(orgId: string) {
        const s = await this.prisma.sso_config.findUnique({ where: { organization_id: orgId } });
        if (!s) return { configured: false };
        return { configured: true, enabled: s.enabled, providerHost: hostOf(s.issuer), hasClientSecret: !!s.client_secret, automaticAccounts: s.jit_enabled, passwordsStillWork: s.password_login, allowedDomains: s.allowed_domains ? s.allowed_domains.split(/[,\s]+/).filter(Boolean).length : 0 };
    }

    private async imports(orgId: string) {
        const rows = await this.prisma.import_jobs.findMany({ where: { organization_id: orgId }, orderBy: { created_at: "desc" }, take: 5, select: { source: true, status: true, message: true, created_at: true, finished_at: true } });
        return rows.map((r) => ({ source: r.source, status: r.status, message: r.message, startedAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null }));
    }

    private async audit() {
        const failures = await this.prisma.$queryRaw<{ action: string; n: number }[]>`
          SELECT action, count(*)::int AS n FROM audit_events WHERE created_at > now() - interval '24 hours' AND outcome <> 'success' GROUP BY action ORDER BY n DESC LIMIT 15`;
        const [t] = await this.prisma.$queryRaw<{ events: number; failures: number }[]>`
          SELECT count(*)::int AS events, count(*) FILTER (WHERE outcome <> 'success')::int AS failures FROM audit_events WHERE created_at > now() - interval '24 hours'`;
        return { last24Hours: { events: t.events, failures: t.failures }, topFailures: failures };
    }

    /** Which settings are set, and the ones that are safe to show. A secret is only ever shown as set or not set. */
    private environment() {
        return this.env.list().items.map((i) => ({ key: i.key, configured: i.configured, ...(i.value !== null ? { value: i.value } : {}) }));
    }

    /** What to look at first, in plain words. */
    private findings(r: Record<string, any>): Finding[] {
        const out: Finding[] = [];
        const add = (level: Finding["level"], area: string, message: string) => out.push({ level, area, message });

        for (const [area, part] of Object.entries(r)) {
            if (failed(part)) add("warning", area, `This part of the report could not be collected: ${part.error}`);
        }
        if (!failed(r.database)) {
            if (r.database.migrations.unfinished.length) add("problem", "database", `Database migrations did not finish: ${r.database.migrations.unfinished.join(", ")}.`);
            if (r.database.migrations.rolledBack.length) add("warning", "database", `Some migrations were rolled back: ${r.database.migrations.rolledBack.join(", ")}.`);
            if (r.database.connections > 80) add("warning", "database", `${r.database.connections} database connections are open.`);
        }
        if (!failed(r.disk)) {
            for (const d of r.disk as any[]) {
                if (typeof d.freePercent === "number" && d.freePercent < 10) add(d.freePercent < 5 ? "problem" : "warning", "disk", `Only ${d.freeGb} GB (${d.freePercent}%) is free on the ${d.label} disk.`);
            }
        }
        if (!failed(r.agents) && r.agents.total > 0) {
            const stale = r.agents.notSeenForADay;
            if (stale / r.agents.total > 0.5 && r.agents.total >= 4) add("warning", "agents", `${stale} of ${r.agents.total} agents have not checked in for a day. If that is not expected, look at the server or the network first.`);
            const versions = r.agents.byVersion.filter((v: any) => v.version !== "unknown");
            if (versions.length > 3) add("info", "agents", `${versions.length} different agent versions are in use.`);
            if (r.agents.neverCheckedIn > 0) add("info", "agents", `${r.agents.neverCheckedIn} agents have never checked in.`);
        }
        if (!failed(r.tasks)) {
            if ((r.tasks.oldestPendingMinutes ?? 0) > 60) add("warning", "tasks", `A task has been waiting ${r.tasks.oldestPendingMinutes} minutes without being picked up.`);
            const failedRecently = (r.tasks.last24Hours as any[]).filter((t) => /fail|error|timed/i.test(t.status)).reduce((a, t) => a + t.n, 0);
            if (failedRecently > 0) add(failedRecently > 20 ? "warning" : "info", "tasks", `${failedRecently} agent tasks failed in the last 24 hours.`);
        }
        if (!failed(r.mailbox) && r.mailbox.configured && r.mailbox.enabled && r.mailbox.lastError) add("problem", "mailbox", `The support mailbox reports: ${r.mailbox.lastError}`);
        if (!failed(r.sso) && r.sso.configured && r.sso.enabled && !r.sso.passwordsStillWork) add("info", "sso", "Passwords are turned off for everyone except Owners.");
        if (!failed(r.imports) && r.imports[0]?.status === "failed") add("warning", "imports", `The last import failed: ${r.imports[0].message ?? "no reason recorded"}`);
        if (!failed(r.audit) && r.audit.last24Hours.failures > 100) add("warning", "audit", `${r.audit.last24Hours.failures} failed actions in the last 24 hours (see top failures).`);
        if (!failed(r.app)) {
            if (r.app.nodeEnv !== "production") add("info", "app", `NODE_ENV is ${r.app.nodeEnv ?? "not set"}, not production.`);
            if (r.app.systemMemoryMb.free < 200) add("warning", "app", `Only ${r.app.systemMemoryMb.free} MB of memory is free on this server.`);
        }
        if (out.length === 0) add("info", "summary", "Nothing needs attention.");
        const order = { problem: 0, warning: 1, info: 2 } as const;
        return out.sort((a, b) => order[a.level] - order[b.level]);
    }
}
