// backend/src/jobs/secret-jobs.ts
//
// Jobs whose output holds a secret (BitLocker recovery keys, a freshly generated local administrator password). Such a job is marked
// with the environment variable RIQ_SECRET_JOB=1 and names its tool in RIQ_TOOL. When its result arrives, JobsService.finishJob
//   1. writes the stored result with FIXED text instead of the output (before anything else happens, in the same transaction),
//   2. hands the output, held only in memory, to the handler registered for the tool (it stores what it needs, encrypted),
//   3. and if the handler fails, marks the job failed (the output is gone either way).
// So the raw output is never in the jobs tables, never readable through any job API, and never logged. See finishSecretJob.
import type { Prisma } from "@prisma/client";

export const SECRET_JOB_MARKER = "RIQ_SECRET_JOB";
export const REDACTED_TEXT = "(secret output removed)";
export const REDACTED_FAILED_TEXT = "(secret output removed) The result could not be stored.";

export type SecretJobContext = { jobId: string; agentId: string; tool: string; env: Record<string, string> };
export type SecretJobResult = { status: "succeeded" | "failed" | "timeout"; exitCode: number; stdout: string; stderr: string };

export type SecretJobHandler = {
    /** Parses and stores the output. Throws (or returns false) when it cannot; the transaction work of a failed ingest is rolled back. */
    ingest(tx: Prisma.TransactionClient, ctx: SecretJobContext, result: SecretJobResult): Promise<boolean>;
    /** Records that the job produced nothing usable (timeout, failure, unreadable). Gets NO output, only the reason code. */
    failed(tx: Prisma.TransactionClient, ctx: SecretJobContext, reason: "timeout" | "failed" | "unreadable"): Promise<void>;
};

const handlers = new Map<string, SecretJobHandler>();

export function registerSecretJobHandler(tool: string, handler: SecretJobHandler): void {
    handlers.set(tool, handler);
}

export function secretJobHandler(tool: string): SecretJobHandler | undefined {
    return handlers.get(tool);
}

export function isSecretJobEnv(env: unknown): env is Record<string, string> {
    return !!env && typeof env === "object" && !Array.isArray(env) && (env as Record<string, unknown>)[SECRET_JOB_MARKER] === "1";
}
