// backend/src/vault/vault-automation.service.ts
//
// The schedule of the vault, in the style of the security scan scheduler: only Windows devices with an online agent are asked, a
// device whose job is still waiting is left alone, a sweep starts a bounded number of jobs, and the clock can be injected.
//   - escrow: devices whose effective policy has security.bitlockerEscrow = on (default OFF, so by default nothing runs). Read when
//     never read, again after 24 hours, and a failed read again after 30 minutes. At most 50 per sweep.
//   - rotation: devices whose effective policy has laps.enabled = true (default OFF): password never set (or only unconfirmed), older
//     than laps.rotateDays, or a "rotate after reveal" time that has passed. A try is not repeated within 30 minutes. At most 30 per sweep.
//   - upkeep: unanswered jobs are given up on after six minutes, and old password generations are purged.
// A device where the policy is turned off keeps its stored secrets and is simply not asked any more.
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";
import { PoliciesService } from "../policies/policies.service";
import { PENDING_STALE_MS, VaultService } from "./vault.service";

const SWEEP_EVERY_MS = 5 * 60_000;
const ONLINE_WITHIN_MS = 5 * 60_000;
const DEVICE_LIMIT = 5000;
export const ESCROWS_PER_SWEEP = 50;
export const ROTATIONS_PER_SWEEP = 30;
export const ESCROW_REREAD_MS = 24 * 3_600_000;
export const RETRY_AFTER_MS = 30 * 60_000;

type Candidate = {
    agent_id: string; device_id: string;
    escrow_pending_job_id: string | null; escrow_pending_at: Date | null; escrow_attempted_at: Date | null; escrow_ok_at: Date | null;
    laps_pending_job_id: string | null; laps_pending_at: Date | null; laps_attempted_at: Date | null; laps_rotate_due_at: Date | null;
    admin_rotated_at: Date | null; has_current_admin: boolean;
};

@Injectable()
export class VaultAutomationService {
    private readonly logger = new Logger(VaultAutomationService.name);
    private running = false;

    constructor(private readonly prisma: PrismaService, private readonly policies: PoliciesService, private readonly vault: VaultService) { }

    @Interval(SWEEP_EVERY_MS)
    async sweep(): Promise<void> {
        if (this.running || process.env.DEVICE_SECRETS_AUTOMATION_ENABLED === "false") return;
        this.running = true;
        try {
            const r = await this.run();
            if (r.escrows || r.rotations || r.purged) this.logger.log(`Device secrets: ${r.escrows} key read(s) and ${r.rotations} password change(s) queued, ${r.purged} old secret(s) purged.`);
        } catch (err) {
            this.logger.error(`Device secrets sweep failed: ${(err as Error).message}`);
        } finally {
            this.running = false;
        }
    }

    /** One pass. `now` can be set by tests. */
    async run(now = Date.now()): Promise<{ escrows: number; rotations: number; purged: number; considered: number }> {
        const at = new Date(now);
        await this.vault.releaseStale(at);
        const purged = await this.vault.purge(at);

        const rows = await this.prisma.$queryRaw<Candidate[]>`
            SELECT a.id::text AS agent_id, a.device_id::text AS device_id,
                   s.escrow_pending_job_id::text AS escrow_pending_job_id, s.escrow_pending_at, s.escrow_attempted_at, s.escrow_ok_at,
                   s.laps_pending_job_id::text AS laps_pending_job_id, s.laps_pending_at, s.laps_attempted_at, s.laps_rotate_due_at,
                   cur.rotated_at AS admin_rotated_at, (cur.id IS NOT NULL) AS has_current_admin
              FROM public.agents a
              JOIN public.devices d ON d.id = a.device_id
              LEFT JOIN public.device_secret_state s ON s.device_id = d.id
              LEFT JOIN LATERAL (SELECT ds.id, COALESCE(ds.rotated_at, ds.created_at) AS rotated_at FROM public.device_secrets ds
                                  WHERE ds.device_id = d.id AND ds.kind = 'local_admin' AND ds.status = 'current' ORDER BY ds.created_at DESC LIMIT 1) cur ON true
             WHERE (lower(COALESCE(a.facts->>'os', '')) IN ('windows', 'linux') OR lower(COALESCE(d.operating_system, '')) LIKE 'windows%' OR lower(COALESCE(d.operating_system, '')) ~ '(linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle)')
               AND a.last_check_in_at > ${new Date(now - ONLINE_WITHIN_MS)}
             ORDER BY COALESCE(s.escrow_attempted_at, s.laps_attempted_at) ASC NULLS FIRST
             LIMIT ${DEVICE_LIMIT}`;
        if (!rows.length) return { escrows: 0, rotations: 0, purged, considered: 0 };

        const settings = await this.vault.settingsOf(rows.map((r) => r.device_id));
        let escrows = 0;
        let rotations = 0;
        const waiting = (id: string | null, pendingAt: Date | null) => !!id && !!pendingAt && now - pendingAt.getTime() <= PENDING_STALE_MS;
        for (const r of rows) {
            const s = settings.get(r.device_id)!;
            if (s.escrow.enabled && escrows < ESCROWS_PER_SWEEP && !waiting(r.escrow_pending_job_id, r.escrow_pending_at)) {
                const ok = r.escrow_ok_at?.getTime() ?? 0;
                const tried = r.escrow_attempted_at?.getTime() ?? 0;
                const due = !r.escrow_attempted_at || (ok >= tried ? now - ok >= ESCROW_REREAD_MS : now - tried >= RETRY_AFTER_MS);
                if (due) {
                    try {
                        const q = await this.vault.startEscrow(r.device_id, r.agent_id, null, "scheduled", at);
                        if (q.queued) escrows++;
                    } catch (e) { this.logger.warn(`Could not queue a BitLocker key read: ${(e as Error).message}`); }
                }
            }
            if (s.laps.enabled && rotations < ROTATIONS_PER_SWEEP && !waiting(r.laps_pending_job_id, r.laps_pending_at)) {
                const tried = r.laps_attempted_at?.getTime() ?? 0;
                if (r.laps_attempted_at && now - tried < RETRY_AFTER_MS) continue;
                const aged = !r.has_current_admin || now - (r.admin_rotated_at?.getTime() ?? 0) >= s.laps.rotateDays * 86_400_000;
                const afterReveal = !!r.laps_rotate_due_at && r.laps_rotate_due_at.getTime() <= now;
                if (aged || afterReveal) {
                    try {
                        const q = await this.vault.startRotate(r.device_id, r.agent_id, s.laps, null, afterReveal ? "scheduled: after a reveal" : !r.has_current_admin ? "scheduled: first password" : `scheduled: older than ${s.laps.rotateDays} days`, at);
                        if (q.queued) rotations++;
                    } catch (e) { this.logger.warn(`Could not queue a password change: ${(e as Error).message}`); }
                }
            }
        }
        return { escrows, rotations, purged, considered: rows.length };
    }
}
