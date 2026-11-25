// backend/src/reports/device-history.service.ts
//
// Every 15 minutes, notes for each device whether it is online and how full its disks are, keeping one row per device
// per day. Availability and disk-space trends are worked out from those rows, so they need no heavy storage.
import { PoliciesService } from "../policies/policies.service";
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";
import { inBusinessHours, ReportSettingsService } from "./report-settings.service";

const SAMPLE_EVERY_MS = 15 * 60_000;
/** Rows older than this are removed, so the table stays small. */
const KEEP_DAYS = 800;

@Injectable()
export class DeviceHistoryService {
    private readonly logger = new Logger(DeviceHistoryService.name);
    private running = false;

    constructor(private readonly prisma: PrismaService, private readonly settings: ReportSettingsService, private readonly policies: PoliciesService) { }

    @Interval(SAMPLE_EVERY_MS)
    async sweep() {
        if (this.running || process.env.DEVICE_HISTORY_ENABLED === "false") return;
        this.running = true;
        try {
            await this.sample();
        } catch (err) {
            this.logger.warn(`Device history sample failed: ${(err as Error).message}`);
        } finally {
            this.running = false;
        }
    }

    /** One sample for every device with an agent. A device counts as online if its agent checked in within five minutes. */
    async sample(): Promise<number> {
        // Whether this moment is inside the working day, so availability can also be measured in business hours only.
        const business = inBusinessHours(Date.now(), await this.settings.getBusinessHours()) ? 1 : 0;
        // A policy can give a device its own working day. Only the devices that differ need telling apart.
        const own: Record<string, number> = {};
        try {
            const all = await this.policies.effectiveForAll();
            const now = Date.now();
            for (const [deviceId, e] of all) {
                const h = e.scalars.hours;
                if (!h || h.source.kind !== "policy") continue;
                const flag = inBusinessHours(now, h.value as any) ? 1 : 0;
                if (flag !== business) own[deviceId] = flag;
            }
        } catch (err) {
            this.logger.warn(`Could not read business hours from policies, using the shared hours: ${(err as Error).message}`);
        }
        const flags = JSON.stringify(own);
        const written = await this.prisma.$executeRaw`
            INSERT INTO public.device_daily (device_id, day, samples, online_samples, disk_free_pct_min, disk_total_bytes, disk_free_bytes, business_samples, business_online_samples)
            SELECT a.device_id,
                   (now() AT TIME ZONE 'utc')::date,
                   1,
                   CASE WHEN a.last_check_in_at IS NOT NULL AND a.last_check_in_at > now() - interval '5 minutes' THEN 1 ELSE 0 END,
                   d.min_pct,
                   d.total::bigint,
                   d.free::bigint,
                   COALESCE((${flags}::jsonb ->> a.device_id::text)::int, ${business}::int),
                   CASE WHEN COALESCE((${flags}::jsonb ->> a.device_id::text)::int, ${business}::int) = 1 AND a.last_check_in_at IS NOT NULL AND a.last_check_in_at > now() - interval '5 minutes' THEN 1 ELSE 0 END
              FROM public.agents a
              LEFT JOIN LATERAL (
                  SELECT min(CASE WHEN t.total > 0 THEN t.free / t.total * 100 END) AS min_pct, sum(t.total) AS total, sum(t.free) AS free
                    FROM (
                        SELECT (x->>'totalBytes')::numeric AS total, (x->>'freeBytes')::numeric AS free
                          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.facts->'device'->'disks') = 'array' THEN a.facts->'device'->'disks' ELSE '[]'::jsonb END) x
                         WHERE (x->>'totalBytes') ~ '^[0-9]+(\\.[0-9]+)?$' AND (x->>'freeBytes') ~ '^[0-9]+(\\.[0-9]+)?$'
                    ) t
              ) d ON true
            ON CONFLICT (device_id, day) DO UPDATE SET
                samples = device_daily.samples + 1,
                online_samples = device_daily.online_samples + EXCLUDED.online_samples,
                business_samples = device_daily.business_samples + EXCLUDED.business_samples,
                business_online_samples = device_daily.business_online_samples + EXCLUDED.business_online_samples,
                disk_free_pct_min = CASE WHEN device_daily.disk_free_pct_min IS NULL THEN EXCLUDED.disk_free_pct_min WHEN EXCLUDED.disk_free_pct_min IS NULL THEN device_daily.disk_free_pct_min ELSE LEAST(device_daily.disk_free_pct_min, EXCLUDED.disk_free_pct_min) END,
                disk_total_bytes = COALESCE(EXCLUDED.disk_total_bytes, device_daily.disk_total_bytes),
                disk_free_bytes = COALESCE(EXCLUDED.disk_free_bytes, device_daily.disk_free_bytes)
        `;
        // Tidy up once a day's worth of samples in.
        if (new Date().getUTCMinutes() < 15 && new Date().getUTCHours() === 3) {
            await this.prisma.$executeRaw`DELETE FROM public.device_daily WHERE day < (now() AT TIME ZONE 'utc')::date - ${KEEP_DAYS}::int`;
            await this.prisma.$executeRaw`DELETE FROM public.device_changes WHERE changed_at < now() - make_interval(days => ${KEEP_DAYS}::int)`;
        }
        return Number(written);
    }
}
