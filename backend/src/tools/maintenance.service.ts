// backend/src/tools/maintenance.service.ts
//
// Server maintenance: clearing out old history so the database stays small and fast. Every task counts what it would remove (a preview), and
// removes in small batches so a big clean-up never locks a table. Nothing here touches the audit log, tickets, devices, customers or any
// setting: only history that is only ever read as "what happened a while ago".
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";

export const MIN_DAYS = 7;
export const MAX_DAYS = 3650;
const BATCH = 5000;
const MAX_BATCHES = 400; // 2 million rows per task per run, then it says "more to do"

type Task = {
    key: string;
    title: string;
    description: string;
    defaultDays: number;
    /** SQL that selects the ids to remove, given $1 = the cut-off date; "ids" is what is removed. */
    table: string;
    where: string;
    /** Extra statements that are not tied to a row count (none by default). */
};

const TASKS: Task[] = [
    { key: "jobs", title: "Finished jobs and their output", description: "Scripts, scans and other jobs that finished a while ago, with what they printed. The history of who ran what stays in the audit log.", defaultDays: 30, table: "jobs", where: "finished_at IS NOT NULL AND finished_at < $1" },
    { key: "script_runs", title: "Script run history", description: "The list of past script runs (the jobs behind them are cleared by the line above).", defaultDays: 90, table: "script_runs", where: "created_at < $1" },
    { key: "alerts", title: "Resolved alerts", description: "Alerts that were resolved a while ago, with their notes. Open and silenced alerts are never touched.", defaultDays: 90, table: "alerts", where: "state = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_at < $1" },
    { key: "bulk", title: "Bulk action history", description: "The Recent actions list: past bulk actions and the result of each device.", defaultDays: 90, table: "bulk_batches", where: "created_at < $1" },
    { key: "notification_deliveries", title: "Sent notifications", description: "The record of alert emails and chat messages that were sent or gave up.", defaultDays: 30, table: "notification_deliveries", where: "status <> 'pending' AND created_at < $1" },
    { key: "webhook_deliveries", title: "Sent webhooks", description: "The record of webhook calls that were delivered or gave up.", defaultDays: 30, table: "webhook_deliveries", where: "status <> 'pending' AND created_at < $1" },
    { key: "discovery_runs", title: "Network scan history", description: "Past network scans. The hosts found and their last-seen dates are kept.", defaultDays: 90, table: "network_discovery_runs", where: "status <> 'pending' AND requested_at < $1" },
    { key: "snmp_polls", title: "Network device poll history", description: "Past SNMP polls (the latest state of each device is kept).", defaultDays: 30, table: "snmp_polls", where: "status <> 'pending' AND requested_at < $1" },
    { key: "snmp_samples", title: "Network device readings", description: "Old readings used for the SNMP graphs.", defaultDays: 90, table: "snmp_samples", where: "at < $1" },
    { key: "login_records", title: "Expired sign-in records", description: "Finished sign-in challenges, single sign-on states and customer portal sessions that have expired.", defaultDays: 7, table: "login_challenges", where: "expires_at < $1" },
];

export type MaintenanceRequest = { tasks: Array<{ key: string; days?: number }>; optimize?: boolean };

@Injectable()
export class MaintenanceService {
    private readonly logger = new Logger(MaintenanceService.name);
    private running = false;

    constructor(private readonly prisma: PrismaService) { }

    list() {
        return { min: MIN_DAYS, max: MAX_DAYS, tasks: TASKS.map((t) => ({ key: t.key, title: t.title, description: t.description, defaultDays: t.defaultDays })) };
    }

    private cutoff(days: number | undefined, fallback: number): Date {
        const d = days === undefined ? fallback : Number(days);
        if (!Number.isInteger(d) || d < MIN_DAYS || d > MAX_DAYS) throw new BadRequestException(`Keep history for ${MIN_DAYS} to ${MAX_DAYS} days.`);
        return new Date(Date.now() - d * 86_400_000);
    }

    private pick(req: MaintenanceRequest) {
        if (!req || !Array.isArray(req.tasks) || (req.tasks.length === 0 && !req.optimize)) throw new BadRequestException("Choose what to clear.");
        const seen = new Set<string>();
        return req.tasks.map((r) => {
            const t = TASKS.find((x) => x.key === r?.key);
            if (!t) throw new BadRequestException(`"${String(r?.key).slice(0, 40)}" is not a maintenance task.`);
            if (seen.has(t.key)) throw new BadRequestException("Each task can be chosen once.");
            seen.add(t.key);
            return { task: t, cutoff: this.cutoff(r.days, t.defaultDays), days: r.days ?? t.defaultDays };
        });
    }

    /** What each chosen task would remove right now. Nothing is changed. */
    async preview(req: MaintenanceRequest) {
        const chosen = this.pick(req);
        const items: Array<{ key: string; title: string; days: number; count: number }> = [];
        for (const c of chosen) {
            const rows = await this.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.${c.task.table} WHERE ${c.task.where}`, c.cutoff);
            let n = rows[0]?.n ?? 0;
            // the sign-in records come from three tables
            if (c.task.key === "login_records") n += await this.extraLoginRecords(c.cutoff, false);
            items.push({ key: c.task.key, title: c.task.title, days: c.days, count: n });
        }
        return { items };
    }

    private async extraLoginRecords(cutoff: Date, remove: boolean): Promise<number> {
        let n = 0;
        for (const sql of [
            ["sso_login_states", "expires_at < $1"],
            ["portal_sessions", "(expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1))"],
        ]) {
            if (remove) n += await this.prisma.$executeRawUnsafe(`DELETE FROM public.${sql[0]} WHERE ${sql[1]}`, cutoff);
            else n += (await this.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.${sql[0]} WHERE ${sql[1]}`, cutoff))[0]?.n ?? 0;
        }
        return n;
    }

    /** Removes what the chosen tasks selected, in batches. One run at a time. */
    async run(req: MaintenanceRequest) {
        if (this.running) throw new BadRequestException("A clean-up is already running. Try again when it has finished.");
        const chosen = this.pick(req);
        this.running = true;
        try {
            const items: Array<{ key: string; title: string; days: number; removed: number; more: boolean }> = [];
            for (const c of chosen) {
                let removed = 0;
                let more = false;
                for (let i = 0; i < MAX_BATCHES; i++) {
                    const n = await this.prisma.$executeRawUnsafe(
                        `DELETE FROM public.${c.task.table} WHERE ctid IN (SELECT ctid FROM public.${c.task.table} WHERE ${c.task.where} LIMIT ${BATCH})`,
                        c.cutoff,
                    );
                    removed += n;
                    if (n < BATCH) break;
                    if (i === MAX_BATCHES - 1) more = true;
                }
                if (c.task.key === "login_records") removed += await this.extraLoginRecords(c.cutoff, true);
                items.push({ key: c.task.key, title: c.task.title, days: c.days, removed, more });
            }
            let optimized = false;
            if (req.optimize) {
                // VACUUM cannot run inside a transaction; Prisma runs this statement on its own
                await this.prisma.$executeRawUnsafe("VACUUM (ANALYZE)");
                optimized = true;
            }
            this.logger.log(`Maintenance: ${items.map((i) => `${i.key} ${i.removed}`).join(", ")}${optimized ? ", optimized" : ""}`);
            return { items, optimized };
        } finally {
            this.running = false;
        }
    }
}
