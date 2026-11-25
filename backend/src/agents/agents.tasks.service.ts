// backend/src/agents/agents.tasks.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { fireWorkflow } from "../workflows/workflows.bus";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { ingestScan, ingestUpgrade } from "../software-updates/ingest";

type AgentTaskStatus = "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
type AgentTaskType = "script" | "policy" | "update" | "command" | "patch_scan" | "patch_install" | "run_checks" | "software_install" | "software_updates_scan";

// Agents poll, so bursts can queue for a connection; waiting beats failing the poll.
const TX_OPTIONS = { maxWait: 10_000, timeout: 10_000 };

export type ClaimedAgentTask = {
  task: {
    id: string;
    agentId: string;
    type: AgentTaskType;
    payload: Record<string, any>;
    status: AgentTaskStatus;
    queuedAt: string | null;
    startedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  run: {
    id: string;
    taskId: string;
    attempt: number;
    status: AgentTaskStatus;
    startedAt: string;
  };
};

@Injectable()
export class AgentsTasksService {
  private readonly logger = new Logger(AgentsTasksService.name);

  constructor(private readonly prisma: PrismaService) { }

  /**
   * Atomically claim the next pending/queued task for an agent, mark task running,
   * and create a corresponding run row.
   *
   * Returns null if there is no work.
   */
  async claimNext(agentId: string): Promise<ClaimedAgentTask | null> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      // Prisma cannot express FOR UPDATE SKIP LOCKED, which keeps concurrent claims from sharing a task.
      const [next] = await tx.$queryRaw<
        { id: string; queued_at: Date | null; started_at: Date | null }[]
      >`
        SELECT t.id::text AS id, t.queued_at, t.started_at
          FROM public.agent_tasks t
         WHERE t.agent_id = ${agentId}::uuid
           AND t.status IN ('pending'::agent_task_status, 'queued'::agent_task_status)
         ORDER BY COALESCE(t.queued_at, t.created_at) ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      `;
      if (!next) return null;

      const now = new Date();
      const task = await tx.agent_tasks.update({
        where: { id: next.id },
        data: {
          status: "running",
          ...(next.started_at ? {} : { started_at: now }),
          ...(next.queued_at ? {} : { queued_at: now }),
          updated_at: now,
        },
      });

      const { _max } = await tx.agent_task_runs.aggregate({
        where: { task_id: task.id },
        _max: { attempt: true },
      });

      const run = await tx.agent_task_runs.create({
        data: {
          task_id: task.id,
          attempt: (_max.attempt ?? 0) + 1,
          status: "running",
          started_at: now,
          created_at: now,
        },
      });

      return { task, run };
    }, TX_OPTIONS);

    if (!claimed) return null;
    const { task, run } = claimed;

    return {
      task: {
        id: task.id,
        agentId: task.agent_id,
        type: task.type as AgentTaskType,
        payload: (task.payload ?? {}) as Record<string, any>,
        status: task.status as AgentTaskStatus,
        queuedAt: task.queued_at ? task.queued_at.toISOString() : null,
        startedAt: task.started_at ? task.started_at.toISOString() : null,
        createdAt: task.created_at.toISOString(),
        updatedAt: task.updated_at.toISOString(),
      },
      run: {
        id: run.id,
        taskId: task.id,
        attempt: run.attempt,
        status: run.status as AgentTaskStatus,
        startedAt: run.started_at.toISOString(),
      },
    };
  }

  /**
   * Mark a run complete, upsert stdout/stderr/artifacts, and finalize the task status.
   * Enforces agent ownership (agent_id must match task.agent_id).
   */
  async completeRun(args: {
    agentId: string;
    taskId: string;
    runId: string;
    status: AgentTaskStatus; // typically succeeded/failed/cancelled
    stdout: string | null;
    stderr: string | null;
    output: Record<string, any> | null; // stored on agent_task_runs.output
    artifacts: Record<string, any> | null; // stored on agent_task_results.artifacts
  }): Promise<void> {
    const { agentId, taskId, runId, status } = args;
    const terminal = status === "succeeded" || status === "failed" || status === "cancelled";

    let recorded = false;
    await this.prisma.$transaction(async (tx) => {
      // If the agent tried to complete something it doesn't own (or mismatched ids), we just no-op safely.
      // (Controller/agent can treat as ok=false later if you want stricter behavior.)
      const owned = await tx.agent_task_runs.findFirst({
        where: { id: runId, task_id: taskId, agent_tasks: { agent_id: agentId } },
        select: { id: true },
      });
      if (!owned) return;

      const now = new Date();
      const { count } = await tx.agent_task_runs.updateMany({
        where: { id: runId, task_id: taskId },
        data: {
          status,
          finished_at: now,
          ...(args.output ? { output: args.output as Prisma.InputJsonValue } : {}),
        },
      });
      if (!count) return;

      const result = {
        stdout: args.stdout,
        stderr: args.stderr,
        artifacts: args.artifacts ? (args.artifacts as Prisma.InputJsonValue) : Prisma.DbNull,
        created_at: now,
      };
      await tx.agent_task_results.upsert({
        where: { run_id: runId },
        create: { run_id: runId, ...result },
        update: result,
      });

      await tx.agent_tasks.update({
        where: { id: taskId },
        data: {
          status,
          ...(terminal ? { completed_at: now } : {}),
          updated_at: now,
        },
      });
      recorded = true;
    }, TX_OPTIONS);

    // What a finished scan found, or a confirmed update, goes into the outdated-software tables. It must never fail the completion.
    if (recorded && terminal) {
      try {
        const t = await this.prisma.agent_tasks.findFirst({ where: { id: taskId, agent_id: agentId }, select: { type: true, payload: true } });
        if (status === "failed" && (t?.type === "patch_install" || t?.type === "patch_scan")) {
          const ag = await this.prisma.agents.findUnique({ where: { id: agentId }, select: { device_id: true } });
          if (ag?.device_id) fireWorkflow({ trigger: "patch.failed", deviceId: ag.device_id, source: t.type, reason: String(args.stderr ?? "").trim().slice(0, 500) || "The computer gave no reason." });
        }
        if (t?.type === "patch_install") await this.scanAfterInstall(agentId, t.payload);
        else if (t?.type === "software_updates_scan") await ingestScan(this.prisma, { agentId, status, output: args.output, artifacts: args.artifacts, stderr: args.stderr });
        if (t?.type === "software_install" && (t.payload as any)?.action === "upgrade") await ingestUpgrade(this.prisma, { agentId, status, payload: t.payload, output: args.output });
      } catch (err) {
        this.logger.warn(`Could not record the software update result of task ${taskId}: ${(err as Error).message}`);
      }
    }
  }
  /**
   * After an install finishes (whatever it said), the device is scanned again, so the list of what is still needed is what the device
   * says now and not a guess from the install. Nothing is queued while a scan is already waiting or running.
   */
  private async scanAfterInstall(agentId: string, payload: unknown): Promise<void> {
    const waiting = await this.prisma.agent_tasks.count({ where: { agent_id: agentId, type: "patch_scan", status: { in: ["pending", "queued", "running"] } } });
    if (waiting > 0) return;
    const now = new Date();
    await this.prisma.agent_tasks.create({
      data: {
        agent_id: agentId, type: "patch_scan", payload: { includeOptional: !!(payload as any)?.includeOptional, afterInstall: true },
        status: "queued", queued_at: now, created_by: null, created_at: now, updated_at: now,
      },
    });
  }
}
