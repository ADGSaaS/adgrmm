// backend/src/jobs/jobs.service.ts
import { applyAgentProperties, referencedCustomFields, referencedProperties, type ScriptLanguage } from "./script-properties";
import {
  Injectable,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
  BadRequestException,
} from "@nestjs/common";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { DispatcherService } from "./dispatcher.service";
import type { Prisma } from "@prisma/client";
import { isSecretJobEnv, REDACTED_FAILED_TEXT, REDACTED_TEXT, secretJobHandler, type SecretJobContext } from "./secret-jobs";

export type JobStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout";

// ──────────────────────────────────────────────────────────────────────────────
// Inputs / payloads
// ──────────────────────────────────────────────────────────────────────────────

export type AgentSelector = {
  /** Back-compat id (stringified). Optional if agentUuid is provided. */
  agentId?: string;
  /** Preferred identifier */
  agentUuid?: string;
};

export type RunScriptInput = AgentSelector & {
  language: "powershell" | "bash";
  scriptText: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
};

export type FileOpInput = AgentSelector & {
  op: "roots" | "list" | "read" | "write" | "mkdir" | "delete" | "move" | "copy";

  /**
   * For most ops, path is required.
   * For "roots", omit path.
   */
  path?: string;

  // Optional extras depending on op:
  path2?: string; // move/copy destination
  recursive?: boolean; // list/delete/copy
  maxBytes?: number; // read cap
  contentBase64?: string; // write
};

type EnqueueJobInput = AgentSelector & {
  /** Matches your jobs.type column, e.g. RUN_SCRIPT, FILE_OP */
  type: "RUN_SCRIPT" | "FILE_OP" | string;
  /** Will be JSON.stringified into jobs.payload */
  payload: any;
};

function tryParseJson(s: any): any | null {
  if (typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Postgres text columns reject NUL, which would otherwise leave the job stuck.
function stripNul(s: string | null | undefined): string {
  return (s ?? "").replace(/\u0000/g, "");
}

function normalizeSelector(sel: AgentSelector): AgentSelector {
  return {
    agentId: sel.agentId ? String(sel.agentId).trim() : undefined,
    agentUuid: sel.agentUuid ? String(sel.agentUuid).trim() : undefined,
  };
}

// Null means nothing can match: Prisma rejects non-UUID values where id::text = $1 found nothing.
function activeJobWhere(jobId: string, statuses: JobStatus[], agentId?: string | null) {
  if (!isCanonicalUuid(jobId)) return null;
  if (agentId != null && !isCanonicalUuid(agentId)) return null;
  return {
    id: jobId,
    status: { in: statuses as string[] },
    ...(agentId != null ? { agent_id: agentId } : {}),
  };
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger("JobsService");

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DispatcherService))
    private readonly dispatcher: DispatcherService
  ) { }

  /** Resolve an agent id from either uuid or id (string) */
  private async resolveAgentId(sel: AgentSelector): Promise<string> {
    const s = normalizeSelector(sel);

    if (s.agentUuid) {
      const row = await this.prisma.agents.findUnique({
        where: { agent_uuid: s.agentUuid },
        select: { id: true },
      });

      const id = row?.id;
      if (!id) throw new NotFoundException("Agent not found for provided agentUuid");
      return id;
    }

    if (s.agentId) return s.agentId;

    throw new BadRequestException("Either agentUuid or agentId is required");
  }

  private async assertAgentExists(agentId: string): Promise<void> {
    const row = isCanonicalUuid(agentId)
      ? await this.prisma.agents.findUnique({ where: { id: agentId }, select: { id: true } })
      : null;
    if (!row) throw new NotFoundException("Agent not found");
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Generic enqueue
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Insert into jobs + attempt immediate dispatch.
   */
  async enqueueJob(input: EnqueueJobInput) {
    const agentId = await this.resolveAgentId(input);
    await this.assertAgentExists(agentId);

    // Round trip so undefined fields are dropped the way they always were.
    const payload = JSON.parse(JSON.stringify(input.payload ?? {}));

    const job = await this.prisma.jobs.create({
      data: {
        agent_id: agentId,
        type: input.type,
        payload,
        status: "queued",
        created_at: new Date(),
      },
      select: { id: true, agent_id: true, type: true, status: true, created_at: true },
    });

    // Best-effort dispatch (do not block request)
    this.dispatcher.tryDispatch(job.id).catch((e: any) => {
      this.logger.warn(`Dispatch failed for job ${job.id}: ${e?.message ?? e}`);
    });

    return job;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Specific helpers
  // ──────────────────────────────────────────────────────────────────────────────

  /** What a script can ask for with {{agent.*}}, for one agent. */
  private async agentValues(agentId: string): Promise<Record<string, string>> {
    const a = await this.prisma.agents.findUnique({
      where: { id: agentId },
      select: {
        agent_uuid: true,
        version: true,
        facts: true,
        devices: {
          select: {
            id: true, hostname: true, alias: true, operating_system: true, primary_user: true, status: true,
            sites: { select: { id: true, name: true, clients: { select: { id: true, name: true } } } },
            device_tags: { select: { tag_defs: { select: { name: true } } } },
          },
        },
      },
    });
    const d = a?.devices;
    const facts = (a?.facts ?? {}) as { os?: string };
    const osName = String(d?.operating_system ?? "");
    const os = String(facts.os ?? (/windows/i.test(osName) ? "windows" : osName ? "linux" : "")).toLowerCase();
    return {
      hostname: d?.hostname ?? "",
      name: d?.alias || d?.hostname || "",
      id: d?.id ?? "",
      uuid: a?.agent_uuid ?? "",
      os,
      osname: osName,
      user: d?.primary_user ?? "",
      customer: d?.sites?.clients?.name ?? "",
      customer_id: d?.sites?.clients?.id ?? "",
      site: d?.sites?.name ?? "",
      site_id: d?.sites?.id ?? "",
      tags: (d?.device_tags ?? []).map((t) => t.tag_defs.name).sort().join(","),
      version: a?.version ?? "",
      status: String(d?.status ?? ""),
    };
  }

  /** The custom fields in use for a customer, and what they hold, as text. A checkbox is "true" or "false". */
  private async customerFields(clientId: string): Promise<Record<string, string>> {
    if (!clientId || !isCanonicalUuid(clientId)) return {};
    const client = await this.prisma.clients.findUnique({ where: { id: clientId }, select: { organization_id: true, custom_fields: true } });
    if (!client) return {};
    const defs = await this.prisma.custom_field_defs.findMany({ where: { organization_id: client.organization_id, entity: "customer", active: true }, select: { key: true, type: true } });
    const saved = client.custom_fields && typeof client.custom_fields === "object" && !Array.isArray(client.custom_fields) ? (client.custom_fields as Record<string, unknown>) : {};
    return Object.fromEntries(
      defs.map((d) => {
        const v = saved[d.key];
        return [d.key, d.type === "checkbox" ? String(v === true) : v === undefined || v === null ? "" : String(v)];
      })
    );
  }

  async createRunScriptJob(input: RunScriptInput) {
    if (!input?.language) throw new BadRequestException("language is required");
    if (!input?.scriptText?.trim()) throw new BadRequestException("scriptText is required");

    // {{agent.hostname}} and the like are filled in for this device, or the script is stopped and says why.
    let scriptText = input.scriptText;
    let env = input.env ?? {};
    if (referencedProperties(scriptText).length || referencedCustomFields(scriptText).length) {
      const agentId = await this.resolveAgentId(input);
      const values = await this.agentValues(agentId);
      const custom = referencedCustomFields(scriptText).length ? await this.customerFields(values.customer_id) : {};
      const filled = applyAgentProperties(input.language as ScriptLanguage, scriptText, values, custom);
      if (filled.used) {
        scriptText = filled.scriptText;
        env = { ...filled.env, ...env };
        if (!filled.ok) this.logger.warn(`Script for agent ${agentId} not run: ${filled.problems.join(" ")}`);
      }
    }

    const payload = {
      language: input.language,
      scriptText,
      args: input.args ?? [],
      env,
      timeoutSec: input.timeoutSec ?? 120,
    };

    return this.enqueueJob({
      agentId: input.agentId,
      agentUuid: input.agentUuid,
      type: "RUN_SCRIPT",
      payload,
    });
  }

  /** Tells an agent to check for an update now. The update itself stays signed and verified. */
  async createAgentUpdateJob(agentId: string) {
    return this.enqueueJob({ agentId, type: "AGENT_UPDATE", payload: { timeoutSec: 60 } });
  }

  async createFileOpJob(input: FileOpInput) {
    if (!input?.op) throw new BadRequestException("op is required");

    const op = input.op;

    // roots = no path
    if (op !== "roots") {
      if (!input?.path?.trim()) throw new BadRequestException("path is required");
    }

    if ((op === "move" || op === "copy") && !String(input.path2 ?? "").trim()) {
      throw new BadRequestException("path2 is required for move/copy");
    }

    // An empty string is a valid empty file.
    if (op === "write" && input.contentBase64 == null) {
      throw new BadRequestException("contentBase64 is required for write");
    }

    const payload: any = {
      op,
      recursive: !!input.recursive,
      maxBytes: Number.isFinite(input.maxBytes) ? input.maxBytes : undefined,
      contentBase64: input.contentBase64 ?? undefined,
      path2: input.path2 ?? undefined,
    };

    // Only include path if present (roots should omit it)
    if (op !== "roots") {
      payload.path = String(input.path ?? "");
    }

    return this.enqueueJob({
      agentId: input.agentId,
      agentUuid: input.agentUuid,
      type: "FILE_OP",
      payload,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Reads / status updates
  // ──────────────────────────────────────────────────────────────────────────────

  /** Read a job and its (optional) result + parsed stdout/payload if it is JSON */
  async getJobWithResult(jobId: string) {
    const row = await this.prisma.jobs.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        agent_id: true,
        type: true,
        status: true,
        payload: true,
        created_at: true,
        dispatched_at: true,
        started_at: true,
        finished_at: true,
        job_results: true,
      },
    });
    if (!row) throw new NotFoundException("Job not found");

    const { job_results: result, ...fields } = row;
    const job = {
      ...fields,
      exit_code: result?.exit_code ?? null,
      stdout: result?.stdout ?? null,
      stderr: result?.stderr ?? null,
      duration_ms: result ? result.duration_ms.toString() : null,
    };

    const parsedStdout = tryParseJson(job.stdout);
    const parsedPayload =
      typeof job.payload === "string" ? tryParseJson(job.payload) : job.payload ?? null;

    return { ...job, parsed_stdout: parsedStdout, parsed_payload: parsedPayload };
  }

  /**
   * The result of a secret job. The stored result is written with fixed text FIRST; only then is the output (in memory only) given to
   * the tool's handler. A handler that fails is rolled back to a savepoint, the job is marked failed, and the output stays gone.
   * Nothing here logs the output or any error message that could contain it.
   */
  private async finishSecretJob(
    tx: Prisma.TransactionClient,
    ctx: SecretJobContext,
    result: { exitCode: number; stdout: string; stderr: string; durationMs: number },
    status: "succeeded" | "failed" | "timeout",
  ) {
    const fields = {
      exit_code: result.exitCode,
      stdout: REDACTED_TEXT,
      stderr: REDACTED_TEXT,
      duration_ms: BigInt(Math.trunc(result.durationMs ?? 0)),
    };
    await tx.job_results.upsert({ where: { job_id: ctx.jobId }, create: { job_id: ctx.jobId, ...fields }, update: fields });

    const handler = secretJobHandler(ctx.tool);
    let stored = false;
    const reason: "timeout" | "failed" | "unreadable" = status === "timeout" ? "timeout" : status === "failed" ? "failed" : "unreadable";
    if (handler && status !== "timeout") {
      await tx.$executeRawUnsafe("SAVEPOINT riq_secret_ingest");
      try {
        stored = await handler.ingest(tx, ctx, { status, exitCode: result.exitCode, stdout: stripNul(result.stdout), stderr: stripNul(result.stderr) });
        if (stored) await tx.$executeRawUnsafe("RELEASE SAVEPOINT riq_secret_ingest");
      } catch {
        stored = false;
      }
      if (!stored) await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT riq_secret_ingest");
    }
    if (!stored) {
      this.logger.warn(`A secret job (${ctx.tool.slice(0, 40)}) gave nothing that could be stored; its output was discarded.`);
      if (handler) {
        await tx.$executeRawUnsafe("SAVEPOINT riq_secret_failed");
        try {
          await handler.failed(tx, ctx, reason);
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT riq_secret_failed");
        } catch {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT riq_secret_failed");
        }
      }
      if (status === "succeeded") await tx.jobs.updateMany({ where: { id: ctx.jobId }, data: { status: "failed" } });
      await tx.job_results.update({ where: { job_id: ctx.jobId }, data: { stderr: REDACTED_FAILED_TEXT } });
    }
  }

  async markDispatched(jobId: string) {
    await this.prisma.jobs.updateMany({
      where: { id: jobId, status: "queued" },
      data: { status: "dispatched", dispatched_at: new Date() },
    });
  }

  /** Returns false when the job is not an active job owned by the given agent. */
  async markRunning(jobId: string, opts?: { agentId?: string }): Promise<boolean> {
    const where = activeJobWhere(jobId, ["queued", "dispatched"], opts?.agentId);
    if (!where) return false;

    const { count } = await this.prisma.jobs.updateMany({
      where,
      data: { status: "running", started_at: new Date() },
    });
    return count > 0;
  }

  async finishJob(
    jobId: string,
    result: { exitCode: number; stdout: string; stderr: string; durationMs: number },
    status: "succeeded" | "failed" | "timeout",
    opts?: { agentId?: string }
  ): Promise<boolean> {
    // Only the owning agent may report, and a finished job cannot be overwritten.
    const where = activeJobWhere(jobId, ["queued", "dispatched", "running"], opts?.agentId);
    if (!where) return false;

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.jobs.updateMany({
        where,
        data: { status, finished_at: new Date() },
      });
      if (!count) return false;

      // A job marked as carrying a secret never has its output stored: see secret-jobs.ts.
      const marked = await tx.jobs.findUnique({ where: { id: jobId }, select: { payload: true, agent_id: true } });
      const markedEnv = (marked?.payload as any)?.env;
      if (marked && isSecretJobEnv(markedEnv)) {
        await this.finishSecretJob(tx, { jobId, agentId: marked.agent_id, tool: String(markedEnv.RIQ_TOOL ?? ""), env: markedEnv }, result, status);
        return true;
      }

      const fields = {
        exit_code: result.exitCode,
        stdout: stripNul(result.stdout),
        stderr: stripNul(result.stderr),
        duration_ms: BigInt(Math.trunc(result.durationMs ?? 0)),
      };
      await tx.job_results.upsert({
        where: { job_id: jobId },
        create: { job_id: jobId, ...fields },
        update: fields,
      });
      return true;
    }, { maxWait: 10_000 });
  }
}
