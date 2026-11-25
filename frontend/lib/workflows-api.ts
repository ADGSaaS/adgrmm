// lib/workflows-api.ts
//
// Workflow rules, "when this happens, do that": the rules, what can start one, and the log of what each did.
import { jfetch } from "@/lib/api";

export type Condition = { field: string; op: string; value: string };
export type Action =
    | { type: "create_ticket"; subject: string; description: string; priority: "low" | "medium" | "high" | "urgent" }
    | { type: "notify"; subject: string; message: string }
    | { type: "run_script"; scriptId: string }
    | { type: "set_priority"; priority: "low" | "medium" | "high" | "urgent" }
    | { type: "assign"; userId: string };

export type Rule = {
    id: string; name: string; enabled: boolean; trigger: string; conditions: Condition[]; actions: Action[]; cooldownMinutes: number;
    runCount: number; lastRunAt: string | null; createdAt: string; updatedAt: string;
};
export type RuleInput = { name: string; trigger: string; enabled: boolean; conditions: Condition[]; actions: Action[]; cooldownMinutes: number };
export type Meta = {
    triggers: Array<{ id: string; title: string; plain: string; hasDevice: boolean; fields: Array<{ key: string; label: string }> }>;
    actions: Array<{ id: string; title: string; needsDevice: boolean; needsTicket: boolean }>;
    templates: Array<{ id: string; title: string; plain: string; rule: Omit<RuleInput, "enabled"> }>;
    ops: Array<{ id: string; label: string }>;
};
export type Run = { id: string; ruleId: string; rule: string; trigger: string; subject: string; outcome: string; detail: string; steps: Array<{ action: string; ok: boolean; text: string }>; at: string };
export type Preview = { sample: Record<string, string> | null; wouldRun: boolean; actions: string[]; note: string };

const base = "/api/admin/workflows";
const id = encodeURIComponent;

export const workflows = {
    meta: () => jfetch<Meta>(`${base}/meta`),
    list: () => jfetch<{ items: Rule[] }>(base),
    runs: (ruleId?: string) => jfetch<{ items: Run[] }>(`${base}/runs${ruleId ? `?ruleId=${id(ruleId)}` : ""}`),
    create: (body: RuleInput) => jfetch<Rule>(base, { method: "POST", body }),
    update: (ruleId: string, body: RuleInput) => jfetch<Rule>(`${base}/${id(ruleId)}`, { method: "PUT", body }),
    enable: (ruleId: string) => jfetch<Rule>(`${base}/${id(ruleId)}/enable`, { method: "POST", body: {} }),
    disable: (ruleId: string) => jfetch<Rule>(`${base}/${id(ruleId)}/disable`, { method: "POST", body: {} }),
    preview: (ruleId: string) => jfetch<Preview>(`${base}/${id(ruleId)}/preview`, { method: "POST", body: {} }),
    remove: (ruleId: string) => jfetch<{ ok: boolean }>(`${base}/${id(ruleId)}`, { method: "DELETE" }),
};
