// backend/src/jobs/dispatcher.service.ts
import { Injectable, Logger, Inject, forwardRef } from "@nestjs/common";
import { agentIdOrUuidWhere } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { SocketRegistry } from "../common/socket-registry.service";
import { JobsService } from "./jobs.service";
import { JobSignerService } from "../common/job-signer.service";

type RunScriptPayload = {
  language: "powershell" | "bash";
  scriptText: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
};

type FileOpPayload = {
  op: "roots" | "list" | "read" | "write" | "mkdir" | "delete" | "move" | "copy";
  path?: string;
  path2?: string;
  contentBase64?: string;
  encoding?: "utf8" | "base64";
  recursive?: boolean;
  maxBytes?: number;
};

// safe parse for jsonb | text JSON
function parsePayload(raw: unknown): any | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

function isRunScriptPayload(v: any): v is RunScriptPayload {
  return !!v && (v.language === "powershell" || v.language === "bash") && typeof v.scriptText === "string";
}

function isFileOpPayload(v: any): v is FileOpPayload {
  const op = v?.op;

  const okOp =
    op === "roots" ||
    op === "list" ||
    op === "read" ||
    op === "write" ||
    op === "mkdir" ||
    op === "delete" ||
    op === "move" ||
    op === "copy";

  if (!v || !okOp) return false;

  // roots intentionally has no path requirement
  if (op === "roots") return true;

  // all other ops require a non-empty path
  return typeof v.path === "string" && v.path.trim().length > 0;
}

function uniqKeys(keys: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    const s = String(k ?? "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function isSocketOpen(s: any): boolean {
  // ws: OPEN=1, browser ws: readyState===1 too
  return !!s && typeof s.readyState === "number" && s.readyState === 1;
}

@Injectable()
export class DispatcherService {
  private readonly logger = new Logger("Dispatcher");

  constructor(
    private readonly prisma: PrismaService,
    private readonly sockets: SocketRegistry,
    private readonly signer: JobSignerService,
    @Inject(forwardRef(() => JobsService)) private readonly jobs: JobsService
  ) { }

  /** Agents only run jobs signed for them. jobId stays outside so a refusal can be reported. */
  private sealedFrame(agentId: string, contents: { t: string; jobId: string } & Record<string, unknown>): string {
    return JSON.stringify({ t: "signed_job", jobId: contents.jobId, ...this.signer.seal(agentId, contents) });
  }

  /** Try to dispatch a specific queued job to its agent over WS */
  async tryDispatch(jobId: string) {
    const job = await this.prisma.jobs.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        agent_id: true, // agents.id
        type: true,
        payload: true,
        status: true,
        agents: { select: { agent_uuid: true } },
      },
    });
    if (!job) return;

    // Only dispatch queued jobs (avoid double-send)
    if (String(job.status).toLowerCase() !== "queued") return;

    // Try socket lookup by BOTH ids (DB id and agent_uuid)
    // NOTE: keep both. In your codebase, different agents have registered under different keys.
    const keysToTry = uniqKeys([job.agent_id, job.agents.agent_uuid]);

    let socket: any = null;
    let matchedKey: string | null = null;

    for (const k of keysToTry) {
      const s = this.sockets.getByAgent(k);
      if (isSocketOpen(s)) {
        socket = s;
        matchedKey = k;
        break;
      }
    }

    if (!socket) {
      this.logger.debug(
        `Agent not connected; tried keys [${keysToTry.join(", ")}]; job ${job.id} stays queued`
      );
      return;
    }

    const type = String(job.type || "").toUpperCase();
    const parsed = parsePayload(job.payload);

    try {
      if (type === "RUN_SCRIPT") {
        if (!isRunScriptPayload(parsed)) {
          this.logger.warn(`Invalid RUN_SCRIPT payload for job ${job.id}; marking failed`);
          await this.jobs.finishJob(
            job.id,
            {
              exitCode: -1,
              stdout: "",
              stderr: "Invalid RUN_SCRIPT payload JSON",
              durationMs: 0,
            },
            "failed"
          );
          return;
        }

        // Send first. Only markDispatched after send succeeds.
        socket.send(
          this.sealedFrame(job.agent_id, {
            t: "job_run_script",
            jobId: job.id,
            language: parsed.language,
            scriptText: parsed.scriptText,
            args: parsed.args ?? [],
            env: parsed.env ?? {},
            timeoutSec: parsed.timeoutSec ?? 120,
          })
        );

        await this.jobs.markDispatched(job.id);
        this.logger.debug(`Dispatched RUN_SCRIPT ${job.id} via key=${matchedKey}`);
        return;
      }

      if (type === "AGENT_UPDATE") {
        socket.send(this.sealedFrame(job.agent_id, { t: "job_update_agent", jobId: job.id }));
        await this.jobs.markDispatched(job.id);
        this.logger.debug(`Dispatched AGENT_UPDATE ${job.id} via key=${matchedKey}`);
        return;
      }

      if (type === "FILE_OP") {
        if (!isFileOpPayload(parsed)) {
          this.logger.warn(`Invalid FILE_OP payload for job ${job.id}; marking failed`);
          await this.jobs.finishJob(
            job.id,
            {
              exitCode: -1,
              stdout: "",
              stderr: "Invalid FILE_OP payload JSON",
              durationMs: 0,
            },
            "failed"
          );
          return;
        }

        socket.send(
          this.sealedFrame(job.agent_id, {
            ...parsed,
            t: "job_file_op",
            jobId: job.id,
          })
        );

        await this.jobs.markDispatched(job.id);
        this.logger.debug(`Dispatched FILE_OP ${job.id} via key=${matchedKey}`);
        return;
      }

      this.logger.warn(`Unknown job type "${type}" for job ${job.id}; failing`);
      await this.jobs.finishJob(
        job.id,
        {
          exitCode: -1,
          stdout: "",
          stderr: `Unknown job type: ${type}`,
          durationMs: 0,
        },
        "failed"
      );
    } catch (e: any) {
      // If send fails, keep queued so it can retry later
      this.logger.warn(`WS send failed for job ${job.id} (key=${matchedKey}): ${e?.message ?? e}`);
    }
  }

  /**
   * Opportunistically dispatch all queued jobs for an agent (called on connect).
   * Accept either agents.id OR agents.agent_uuid.
   */
  async dispatchQueuedForAgent(agentIdOrUuid: string | number) {
    const key = String(agentIdOrUuid ?? "").trim();
    if (!key) return;

    // Resolve agent to DB id, because jobs.agent_id stores agents.id
    const agent = await this.prisma.agents.findFirst({
      where: agentIdOrUuidWhere(key),
      select: { id: true },
    });

    const agentId = agent?.id;
    if (!agentId) {
      this.logger.debug(`dispatchQueuedForAgent: no agent found for key=${key}`);
      return;
    }

    const rows = await this.prisma.jobs.findMany({
      where: { agent_id: agentId, status: "queued" },
      orderBy: { created_at: "asc" },
      select: { id: true },
    });

    for (const j of rows) {
      await this.tryDispatch(j.id);
    }
  }
}
