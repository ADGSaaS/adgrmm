// backend/src/security/security-automation.service.ts
//
// Scans Windows devices on the schedule the policies that reach each of them set (policy setting security.scanHours: 0 means never,
// every 24 hours when no policy says otherwise). It follows the scheduled scan of outdated programs: only devices that are online
// are asked, a device whose scan is still waiting is left alone, and a sweep starts a bounded number of scans so a large fleet
// is spread over several sweeps. A scan only reads, so it does not wait for a maintenance window. The answer is kept by the
// SecurityService poller.
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";
import { PoliciesService } from "../policies/policies.service";
import { SecurityService } from "./security.service";

const SWEEP_EVERY_MS = 5 * 60_000;
const ONLINE_WITHIN_MS = 5 * 60_000;
const DEVICE_LIMIT = 5000;
export const SCANS_PER_SWEEP = 50;

type Candidate = { agent_id: string; device_id: string; attempted_at: Date | null; pending: boolean };

@Injectable()
export class SecurityAutomationService {
    private readonly logger = new Logger(SecurityAutomationService.name);
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly policies: PoliciesService,
        private readonly security: SecurityService,
    ) { }

    @Interval(SWEEP_EVERY_MS)
    async sweep(): Promise<void> {
        if (this.running || process.env.SECURITY_SCANS_AUTOMATION_ENABLED === "false") return;
        this.running = true;
        try {
            const r = await this.run();
            if (r.scans) this.logger.log(`Policies queued ${r.scans} security scan(s).`);
        } catch (err) {
            this.logger.error(`Scheduled security scans failed: ${(err as Error).message}`);
        } finally {
            this.running = false;
        }
    }

    /** One pass over the Windows devices that are online. Returns how many scans were queued. `now` can be set by tests. */
    async run(now = Date.now()): Promise<{ scans: number; considered: number; due: number }> {
        const rows = await this.prisma.$queryRaw<Candidate[]>`
            SELECT a.id::text AS agent_id, a.device_id::text AS device_id, s.attempted_at, (s.pending_job_id IS NOT NULL) AS pending
              FROM public.agents a
              JOIN public.devices d ON d.id = a.device_id
              LEFT JOIN public.device_security_scans s ON s.device_id = d.id
             WHERE (lower(COALESCE(a.facts->>'os', '')) IN ('windows', 'linux') OR (COALESCE(a.facts->>'os', '') = '' AND (lower(COALESCE(d.operating_system, '')) LIKE 'windows%' OR lower(COALESCE(d.operating_system, '')) ~ '(linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle)')))
               AND a.last_check_in_at > ${new Date(now - ONLINE_WITHIN_MS)}
             ORDER BY s.attempted_at ASC NULLS FIRST
             LIMIT ${DEVICE_LIMIT}`;
        if (!rows.length) return { scans: 0, considered: 0, due: 0 };

        const effective = await this.policies.effectiveForDevices(rows.map((r) => r.device_id));
        let scans = 0;
        let due = 0;
        for (const r of rows) {
            const hours = Number(effective.get(r.device_id)?.scalars["security.scanHours"]?.value ?? 0);
            if (!(hours > 0)) continue;
            // a device with a scan already waiting is left alone
            if (r.pending) continue;
            if (r.attempted_at && now - r.attempted_at.getTime() < hours * 3_600_000) continue;
            due++;
            if (scans >= SCANS_PER_SWEEP) continue;
            try {
                const q = await this.security.queueScan(r.device_id, r.agent_id, new Date(now));
                if (!q.alreadyWaiting) scans++;
            } catch (e) {
                this.logger.warn(`Could not queue a security scan: ${(e as Error).message}`);
            }
        }
        return { scans, considered: rows.length, due };
    }
}
