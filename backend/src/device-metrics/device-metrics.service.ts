// backend/src/device-metrics/device-metrics.service.ts
//
// Hardware and performance history for one device (roadmap 1.15).
//
// Two sources, both already collected:
//  - check results: every agent runs the built-in CPU, memory and disk checks every few minutes (or the intervals of
//    checks someone added), and each result keeps its numbers in `metrics`. Those are kept for 14 days, so the 24 hour
//    and 7 day graphs are full and the 30 day graph covers the last 14 days.
//  - device_daily: one row per device per day (availability, lowest free disk, disk size), kept for 800 days.
// Nothing here asks an agent for anything, so finer sampling than the checks' interval needs a future agent change.
//
// Network traffic and disk activity (bytes per second) come the same way, from the informational NETWORK and DISKIO
// check results that agents 1.3.36 and newer send. Older agents do not send them: those two series are then empty with
// a reason, and nothing else about the response changes (the "problem" banner only ever speaks about CPU, memory and disk).
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";

export type MetricRange = "1h" | "12h" | "24h" | "7d" | "30d";

const RANGES: Record<MetricRange, { hours: number; bucketSec: number }> = {
    "1h": { hours: 1, bucketSec: 5 * 60 },
    "12h": { hours: 12, bucketSec: 5 * 60 },
    "24h": { hours: 24, bucketSec: 5 * 60 },
    "7d": { hours: 24 * 7, bucketSec: 30 * 60 },
    "30d": { hours: 24 * 30, bucketSec: 2 * 3600 },
};
/** How long check results are kept (see ChecksRetentionService). */
const DETAIL_DAYS = 14;
const GIB = 1073741824;
/** The first agent version that measures network traffic and disk activity. */
export const IO_MIN_AGENT_VERSION = "1.3.36";

function versionAtLeast(have: string | null | undefined, need: string): boolean {
    const a = String(have ?? "").split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
    const b = need.split(".").map((p) => parseInt(p, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
        const x = a[i] ?? 0, y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    return true;
}

type Row = {
    type: string; key: string; t: Date; avg: number; max: number; min: number; n: number; total: number | null;
    // the second value of a result that has two (received/sent, read/written)
    avg2: number | null; max2: number | null; min2: number | null;
};

export type Point = { t: string; avg: number; max: number; min: number };

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** The mount or drive a disk check result is for: "builtin:disk:c:" is c:, "check:<id>:/var" is /var. */
export function mountOf(dedupeKey: string): string {
    const parts = String(dedupeKey ?? "").split(":");
    const rest = parts.slice(2).join(":");
    return rest || "disk";
}

function merge(rows: Row[]): Point[] {
    const by = new Map<number, { sum: number; n: number; max: number; min: number }>();
    for (const r of rows) {
        const k = r.t.getTime();
        const e = by.get(k) ?? { sum: 0, n: 0, max: -Infinity, min: Infinity };
        e.sum += r.avg * r.n;
        e.n += r.n;
        e.max = Math.max(e.max, r.max);
        e.min = Math.min(e.min, r.min);
        by.set(k, e);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, e]) => ({ t: new Date(t).toISOString(), avg: round(e.sum / e.n), max: round(e.max), min: round(e.min) }));
}

function stats(points: Point[]) {
    if (!points.length) return null;
    const avg = points.reduce((s, p) => s + p.avg, 0) / points.length;
    return { latest: points[points.length - 1].avg, average: round(avg), peak: round(Math.max(...points.map((p) => p.max))), low: round(Math.min(...points.map((p) => p.min))) };
}

@Injectable()
export class DeviceMetricsService {
    constructor(private readonly prisma: PrismaService) { }

    /** The device row id for a devices.id or an agents.id, or null. */
    async resolveDevice(id: string): Promise<string | null> {
        if (!isCanonicalUuid(id)) return null;
        const d = await this.prisma.devices.findUnique({ where: { id }, select: { id: true } });
        if (d) return d.id;
        const a = await this.prisma.agents.findUnique({ where: { id }, select: { device_id: true } });
        return a?.device_id ?? null;
    }

    async series(deviceId: string, range: MetricRange) {
        const cfg = RANGES[range];
        const now = new Date();
        const from = new Date(now.getTime() - cfg.hours * 3_600_000);

        const rows = await this.prisma.$queryRaw<Row[]>`
            WITH x AS (
                SELECT ca.check_type AS type, ca.dedupe_key AS key, cr.started_at,
                       CASE ca.check_type WHEN 'CPU' THEN cr.metrics->>'busyPercent'
                                          WHEN 'MEMORY' THEN cr.metrics->>'usedPercent'
                                          WHEN 'DISK' THEN cr.metrics->>'freePercent'
                                          WHEN 'NETWORK' THEN cr.metrics->>'rxBytesPerSec'
                                          WHEN 'DISKIO' THEN cr.metrics->>'readBytesPerSec' END AS raw,
                       CASE ca.check_type WHEN 'NETWORK' THEN cr.metrics->>'txBytesPerSec'
                                          WHEN 'DISKIO' THEN cr.metrics->>'writeBytesPerSec' END AS raw2,
                       cr.metrics->>'totalGb' AS totalraw
                  FROM public.check_assignments ca
                  JOIN public.check_runs cr ON cr.assignment_id = ca.id
                 WHERE ca.target_type = 'device' AND ca.target_id = ${deviceId}::uuid
                   AND ca.check_type IN ('CPU', 'MEMORY', 'DISK', 'NETWORK', 'DISKIO')
                   AND cr.started_at >= ${from}
            ), y AS (
                SELECT type, key, started_at,
                       CASE WHEN raw ~ '^-?[0-9]+([.][0-9]+)?$' THEN raw::float8 END AS v,
                       CASE WHEN raw2 ~ '^[0-9]+([.][0-9]+)?$' THEN raw2::float8 END AS v2,
                       CASE WHEN totalraw ~ '^[0-9]+([.][0-9]+)?$' THEN totalraw::float8 END AS total
                  FROM x
            )
            SELECT type, key,
                   to_timestamp(floor(extract(epoch FROM started_at) / ${cfg.bucketSec}::int) * ${cfg.bucketSec}::int) AS t,
                   avg(v)::float8 AS avg, max(v)::float8 AS max, min(v)::float8 AS min, count(*)::int AS n,
                   max(total)::float8 AS total,
                   avg(v2)::float8 AS avg2, max(v2)::float8 AS max2, min(v2)::float8 AS min2
              FROM y
             WHERE v IS NOT NULL
               -- rates are never negative and always come as a pair
               AND (type NOT IN ('NETWORK', 'DISKIO') OR (v >= 0 AND v2 IS NOT NULL))
             GROUP BY type, key, t
             ORDER BY t`;

        const [seen] = await this.prisma.$queryRaw<Array<{ last: Date | null; first: Date | null; n: number }>>`
            SELECT max(cr.started_at) AS last, min(cr.started_at) AS first, count(*)::int AS n
              FROM public.check_assignments ca
              JOIN public.check_runs cr ON cr.assignment_id = ca.id
             WHERE ca.target_type = 'device' AND ca.target_id = ${deviceId}::uuid AND ca.check_type IN ('CPU', 'MEMORY', 'DISK')`;

        const agent = await this.prisma.agents.findUnique({ where: { device_id: deviceId }, select: { version: true, last_check_in_at: true } });

        // What the agent said last about network traffic and disk activity (the reason when there is nothing to draw, and the link speed).
        const ioLatest = await this.prisma.$queryRaw<Array<{ type: string; at: Date; reason: string | null; link: string | null }>>`
            SELECT ca.check_type AS type, last.started_at AS at, last.metrics->>'reason' AS reason, last.metrics->>'linkMbps' AS link
              FROM public.check_assignments ca
              JOIN LATERAL (SELECT cr.started_at, cr.metrics FROM public.check_runs cr WHERE cr.assignment_id = ca.id ORDER BY cr.started_at DESC LIMIT 1) last ON true
             WHERE ca.target_type = 'device' AND ca.target_id = ${deviceId}::uuid AND ca.check_type IN ('NETWORK', 'DISKIO')
             ORDER BY last.started_at DESC`;

        const ofType = (t: string) => rows.filter((r) => r.type === t);
        const coreRows = rows.filter((r) => r.type === "CPU" || r.type === "MEMORY" || r.type === "DISK");
        const cpu = merge(ofType("CPU"));
        const memRows = ofType("MEMORY");
        const memory = merge(memRows);
        const memoryTotalGb = memRows.length ? round(Math.max(...memRows.map((r) => r.total ?? 0)), 1) || null : null;

        const diskRows = ofType("DISK");
        const mounts = new Map<string, Row[]>();
        for (const r of diskRows) mounts.set(mountOf(r.key), [...(mounts.get(mountOf(r.key)) ?? []), r]);
        const disks = [...mounts.entries()]
            .map(([mount, rs]) => {
                const points = merge(rs);
                const total = Math.max(...rs.map((r) => r.total ?? 0));
                return { mount, totalGb: total ? round(total, 1) : null, points, stats: stats(points) };
            })
            .sort((a, b) => a.mount.localeCompare(b.mount));

        // Why there may be nothing to draw, in words the page can show.
        let state: "ok" | "no-agent" | "never-reported" | "stopped" = "ok";
        let problem: string | null = null;
        if (!agent) {
            state = "no-agent";
            problem = "This device has no agent, so nothing is measured on it.";
        } else if (!seen?.n) {
            state = "never-reported";
            problem = "The agent has not reported any CPU, memory or disk results yet. Agents measure these by default every few minutes, so an old agent that does not know about checks, or a device that has not been online since it was enrolled, are the usual reasons.";
        } else if (!coreRows.length) {
            state = "stopped";
            problem = `Nothing was measured in this period. The last result is from ${seen.last?.toISOString().slice(0, 16).replace("T", " ")} UTC.`;
        }

        return {
            range,
            from: from.toISOString(),
            to: now.toISOString(),
            bucketMinutes: cfg.bucketSec / 60,
            retentionDays: DETAIL_DAYS,
            // The 30 day graph can only reach as far back as results are kept.
            coveredFrom: seen?.first ? new Date(Math.max(seen.first.getTime(), from.getTime())).toISOString() : null,
            monitoring: {
                state,
                problem,
                agentVersion: agent?.version ?? null,
                lastResultAt: seen?.last ? seen.last.toISOString() : null,
                lastCheckInAt: agent?.last_check_in_at ? agent.last_check_in_at.toISOString() : null,
            },
            cpu: { points: cpu, stats: stats(cpu) },
            memory: { totalGb: memoryTotalGb, points: memory, stats: stats(memory) },
            disks,
            network: this.ioSeries("network", ofType("NETWORK"), ioLatest.filter((l) => l.type === "NETWORK"), agent?.version ?? null, !!agent),
            diskIo: this.ioSeries("diskIo", ofType("DISKIO"), ioLatest.filter((l) => l.type === "DISKIO"), agent?.version ?? null, !!agent),
        };
    }

    /**
     * A two-line series in bytes per second: received and sent, or read and written. It speaks only for itself: an agent
     * without these measurements gets an empty series and the reason why, and the rest of the response is not affected.
     */
    private ioSeries(kind: "network" | "diskIo", rows: Row[], latest: Array<{ at: Date; reason: string | null; link: string | null }>, agentVersion: string | null, hasAgent: boolean) {
        const [a, b] = kind === "network" ? (["rx", "tx"] as const) : (["read", "write"] as const);
        const first = merge(rows);
        const second = merge(rows.map((r) => ({ ...r, avg: r.avg2 ?? 0, max: r.max2 ?? 0, min: r.min2 ?? 0 })));
        const points = first.map((p, i) => ({
            t: p.t,
            [a]: Math.round(p.avg), [b]: Math.round(second[i].avg),
            [`${a}Max`]: Math.round(p.max), [`${b}Max`]: Math.round(second[i].max),
        }));
        const st = (ps: Point[]) => { const s = stats(ps); return s ? { latest: Math.round(s.latest), average: Math.round(s.average), peak: Math.round(s.peak) } : null; };
        const statsOut = points.length ? { [a]: st(first), [b]: st(second) } : null;

        let state: "ok" | "no-agent" | "needs-agent" | "waiting" | "unavailable" | "stopped" = "ok";
        let reason: string | null = null;
        if (!points.length) {
            const last = latest[0];
            if (!hasAgent) {
                state = "no-agent";
                reason = "This device has no agent, so nothing is measured on it.";
            } else if (last?.reason) {
                state = "unavailable";
                reason = last.reason;
            } else if (last) {
                state = "stopped";
                reason = `Nothing was measured in this period. The last result is from ${last.at.toISOString().slice(0, 16).replace("T", " ")} UTC.`;
            } else if (versionAtLeast(agentVersion, IO_MIN_AGENT_VERSION)) {
                state = "waiting";
                reason = "Waiting for the first measurement. A rate needs two samples, so the first one arrives a few minutes after the agent starts.";
            } else {
                state = "needs-agent";
                reason = `No data yet: needs agent ${IO_MIN_AGENT_VERSION} or newer, which updates itself.`;
            }
        }
        const link = latest[0]?.link ? Math.round(Number(latest[0].link)) : NaN;
        const linkMbps = kind === "network" && Number.isFinite(link) && link > 0 ? link : null;
        return { unit: "bytes/s", state, reason, ...(kind === "network" ? { linkMbps } : {}), points, stats: statsOut };
    }

    /** One row per day: how much of it the device was online, and the lowest free disk space that day. Up to 800 days (what is kept). */
    async daily(deviceId: string, days: number) {
        const n = Math.min(Math.max(Math.floor(days) || 90, 1), 800);
        const since = new Date(Date.now() - (n - 1) * 86_400_000);
        since.setUTCHours(0, 0, 0, 0);
        const rows = await this.prisma.device_daily.findMany({ where: { device_id: deviceId, day: { gte: since } }, orderBy: { day: "asc" } });
        const pct = (a: number, b: number) => (b > 0 ? round((a / b) * 100, 1) : null);
        return {
            days: n,
            keptDays: 800,
            items: rows.map((r) => ({
                day: r.day.toISOString().slice(0, 10),
                samples: r.samples,
                availability: pct(r.online_samples, r.samples),
                businessAvailability: pct(r.business_online_samples, r.business_samples),
                diskFreePctMin: r.disk_free_pct_min == null ? null : round(r.disk_free_pct_min, 1),
                diskFreeGb: r.disk_free_bytes == null ? null : round(Number(r.disk_free_bytes) / GIB, 1),
                diskTotalGb: r.disk_total_bytes == null ? null : round(Number(r.disk_total_bytes) / GIB, 1),
            })),
        };
    }
}
