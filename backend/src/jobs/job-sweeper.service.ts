// backend/src/jobs/job-sweeper.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";

const SWEEP_EVERY_MS = 60_000;
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 86_400;
const GRACE_SEC = 60;
const TIMEOUT_SEC_PATTERN = /^[0-9]{1,9}$/;
// A reboot queued yesterday must not fire whenever the agent next connects.
const QUEUED_EXPIRY_MS = 60 * 60_000;
// Patch installs can be slow, but an agent that crashed mid-task never reports back.
const RUNNING_TASK_EXPIRY_MS = 4 * 60 * 60_000;

function timeoutSecOf(payload: unknown): number {
    const raw =
        payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).timeoutSec
            : undefined;
    const usable =
        (typeof raw === "number" || typeof raw === "string") && TIMEOUT_SEC_PATTERN.test(String(raw));
    return Math.min(usable ? Number(raw) : DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
}

/**
 * Times out jobs whose agent never reported back. Jobs are deliberately not
 * re-queued: a script may already have run, and running it twice is not safe.
 */
@Injectable()
export class JobSweeperService {
    private readonly log = new Logger("JobSweeper");

    constructor(private readonly prisma: PrismaService) { }

    @Interval(SWEEP_EVERY_MS)
    async tick(): Promise<void> {
        try {
            const expired = await this.sweep();
            if (expired > 0) this.log.warn(`Timed out ${expired} unresponsive job(s).`);

            const stale = await this.sweepQueued();
            if (stale > 0) this.log.warn(`Expired ${stale} queued job(s) whose agent never connected.`);

            const stuck = await this.sweepTasks();
            if (stuck > 0) this.log.warn(`Failed ${stuck} task(s) whose agent stopped responding.`);
        } catch (e: any) {
            this.log.warn(`Job sweep failed: ${e?.message ?? e}`);
        }
    }

    async sweepQueued(): Promise<number> {
        const old = await this.prisma.jobs.findMany({
            where: { status: "queued", created_at: { lt: new Date(Date.now() - QUEUED_EXPIRY_MS) } },
            select: { id: true },
        });

        let expired = 0;
        for (const job of old) {
            expired += await this.prisma.$transaction(async (tx) => {
                const { count } = await tx.jobs.updateMany({
                    where: { id: job.id, status: "queued" },
                    data: { status: "timeout", finished_at: new Date() },
                });
                if (!count) return 0;
                await tx.job_results.createMany({
                    data: [{ job_id: job.id, exit_code: -1, stdout: "", stderr: "The device did not connect in time, so this job did not run.", duration_ms: BigInt(0) }],
                    skipDuplicates: true,
                });
                return count;
            });
        }
        return expired;
    }

    async sweepTasks(): Promise<number> {
        const { count } = await this.prisma.agent_tasks.updateMany({
            where: { status: "running", updated_at: { lt: new Date(Date.now() - RUNNING_TASK_EXPIRY_MS) } },
            data: { status: "failed" },
        });
        return count;
    }

    async sweep(): Promise<number> {
        const active = await this.prisma.jobs.findMany({
            where: { status: { in: ["dispatched", "running"] } },
            select: { id: true, status: true, payload: true, started_at: true, dispatched_at: true },
        });

        const now = Date.now();
        let expired = 0;

        for (const job of active) {
            const since = job.started_at ?? job.dispatched_at;
            if (!since) continue;

            const allowedMs = (timeoutSecOf(job.payload) + GRACE_SEC) * 1000;
            if (since.getTime() + allowedMs >= now) continue;

            expired += await this.prisma.$transaction(async (tx) => {
                // The status check skips a job that started or finished after the read above.
                const { count } = await tx.jobs.updateMany({
                    where: { id: job.id, status: job.status },
                    data: { status: "timeout", finished_at: new Date() },
                });
                if (!count) return 0;

                await tx.job_results.createMany({
                    data: [{
                        job_id: job.id,
                        exit_code: -1,
                        stdout: "",
                        stderr: "Timed out: the agent did not report a result.",
                        duration_ms: 0,
                    }],
                    skipDuplicates: true,
                });
                return count;
            });
        }

        return expired;
    }
}
