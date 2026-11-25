// backend/src/checks/check-plan.util.ts

/** What an agent is told to run. It only ever measures and reads, so nothing here runs code. */
export type AgentCheckDefinition = {
  key: string;
  type: "DISK" | "MEMORY" | "CPU" | "SERVICE" | "PROCESS" | "PORT" | "PING";
  name: string;
  intervalSec: number;
  timeoutSec: number;
  path?: string;
  service?: string;
  process?: string;
  host?: string;
  port?: number;
  warn?: number;
  crit?: number;
  downStatus?: "WARN" | "CRIT";
};

export type AgentCheckPlan = {
  /** "default" means the agent runs its built-in set, which depends on its OS. */
  mode: "default" | "custom";
  checks: AgentCheckDefinition[];
  /** A check someone adds must not silently turn off the built-in disk and CPU monitoring. */
  includeDefaults: boolean;
};

export type StoredCheck = {
  id: string;
  name: string;
  type: string;
  schedule: string;
  config: unknown;
};

const DEFAULT_INTERVAL_SEC = 300;

/** Accepts plain seconds or a number with s, m or h. Anything else gets the default. */
export function parseCheckSchedule(schedule: unknown): number {
  const match = /^\s*(\d{1,6})\s*([smh]?)\s*$/i.exec(String(schedule ?? ""));
  if (!match) return DEFAULT_INTERVAL_SEC;
  const unit = { "": 1, s: 1, m: 60, h: 3600 }[match[2].toLowerCase()] ?? 1;
  return Math.min(Math.max(Number(match[1]) * unit, 60), 86400);
}

function safeText(value: unknown, pattern: RegExp, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= max && pattern.test(text) && !text.startsWith("-") ? text : undefined;
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

/**
 * Turns a row from the checks table into something an agent can run, or null when it cannot.
 * Script checks are refused on purpose: running code belongs to signed jobs, which leave an audit
 * trail, and this plan must stay something that can only ever observe.
 */
export function toAgentCheck(check: StoredCheck): AgentCheckDefinition | null {
  const config = (check.config && typeof check.config === "object" ? check.config : {}) as Record<string, unknown>;
  const base = {
    key: `check:${check.id}`,
    name: String(check.name ?? "Check").slice(0, 200),
    intervalSec: parseCheckSchedule(check.schedule),
    timeoutSec: 30,
    ...(config.severity === "WARN" || config.severity === "CRIT" ? { downStatus: config.severity as "WARN" | "CRIT" } : {}),
  };

  switch (check.type) {
    case "ping": {
      const host = safeText(config.host, /^[A-Za-z0-9.:\-\[\]]+$/, 253);
      if (!host) return null;
      const port = typeof config.port === "number" && Number.isInteger(config.port) && config.port > 0 && config.port <= 65535
        ? config.port
        : undefined;
      return port ? { ...base, type: "PORT", host, port } : { ...base, type: "PING", host };
    }
    case "service": {
      const service = safeText(config.service ?? config.name, /^[A-Za-z0-9:_.@\\ -]+$/, 256);
      return service ? { ...base, type: "SERVICE", service } : null;
    }
    case "process": {
      const process = safeText(config.process ?? config.name, /^[A-Za-z0-9:_. -]+$/, 256);
      return process ? { ...base, type: "PROCESS", process } : null;
    }
    case "metric": {
      const warn = percent(config.warn);
      const crit = percent(config.crit);
      const limits = { ...(warn !== undefined ? { warn } : {}), ...(crit !== undefined ? { crit } : {}) };
      if (config.metric === "cpu") return { ...base, type: "CPU", ...limits };
      if (config.metric === "memory") return { ...base, type: "MEMORY", ...limits };
      if (config.metric === "disk") {
        const path = safeText(config.path, /^[A-Za-z0-9:_.\\/ -]+$/, 256);
        return { ...base, type: "DISK", ...limits, ...(path ? { path } : {}) };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Custom checks replace the built-in set only when at least one of them can actually run. */
export function buildCheckPlan(stored: StoredCheck[]): AgentCheckPlan {
  const seen = new Set<string>();
  const checks: AgentCheckDefinition[] = [];
  for (const row of stored) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const check = toAgentCheck(row);
    if (check) checks.push(check);
  }
  return checks.length > 0
    ? { mode: "custom", checks, includeDefaults: true }
    : { mode: "default", checks: [], includeDefaults: true };
}
