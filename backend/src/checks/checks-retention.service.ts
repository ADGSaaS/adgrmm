// backend/src/checks/checks-retention.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;
const BATCH = 10_000;
const MAX_BATCHES = 50;

function retentionDays(): number {
  const parsed = Number(process.env.CHECK_RUNS_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_RETENTION_DAYS;
}

/**
 * Every device reports a handful of results every few minutes, so without this the table only grows.
 * The newest run of each assignment is always kept, so a device that has been offline for a long
 * time still shows its last known state.
 */
@Injectable()
export class ChecksRetentionService {
  private readonly log = new Logger("ChecksRetention");
  private running = false;

  constructor(private readonly prisma: PrismaService) { }

  @Interval(HOUR_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const removed = await this.prune(new Date(Date.now() - retentionDays() * 24 * HOUR_MS));
      if (removed > 0) this.log.log(`Removed ${removed} old check run(s).`);
    } catch (e: any) {
      this.log.warn(`Check run cleanup failed: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  async prune(cutoff: Date): Promise<number> {
    let total = 0;
    // Small batches keep this from holding locks that would slow down agents reporting in.
    for (let i = 0; i < MAX_BATCHES; i++) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM public.check_runs
        WHERE id IN (
          SELECT cr.id
          FROM public.check_runs cr
          WHERE cr.created_at < ${cutoff}
            AND EXISTS (
              SELECT 1 FROM public.check_runs newer
              WHERE newer.assignment_id = cr.assignment_id
                AND newer.created_at > cr.created_at
            )
          LIMIT ${BATCH}
        )
      `;
      total += removed;
      if (removed < BATCH) break;
    }
    return total;
  }
}
