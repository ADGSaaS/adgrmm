// lib/auto-repair-api.ts
//
// The results report of automatic repair and self-healing, and the log of one run.
import { jfetch } from "@/lib/api";

export type Report = {
    days: number; since: string; assumptionMinutesPerFix: number;
    total: number; tickets: number; alerts: number; fixed: number; waiting: number; handed: number; inProgress: number;
    fixedPercent: number | null; minutesSaved: number; averageMinutesToFix: number | null;
    reasons: Array<{ code: string; text: string; count: number }>;
    byCategory: Array<{ category: string; total: number; fixed: number; handed: number }>;
    problemsFound: Array<{ id: string; title: string; kind: string; count: number; fixed: number; notFixed: number }>;
    addNext: Array<{ what: string; count: number }>;
    articles: Array<{ issue: string; articleId: string | null; title: string; seen: number; writtenAt: string; lastSeenAt: string }>;
    trend: Array<{ day: string; fixed: number; handed: number; other: number }>;
};

export type RunDetail = {
    id: string; source: "ticket" | "alert"; state: string; category: string | null; app: string | null; checks: string[]; outcome: string | null; handoff: string | null; device: string;
    ticketNumber: number | null; alertTitle: string | null; startedAt: string; finishedAt: string | null;
    events: Array<{ id: string; at: string; internal: boolean; text: string }>;
};

export const autoRepair = {
    report: (days: number) => jfetch<Report>(`/api/admin/auto-repair/report?days=${days}`),
    run: (id: string) => jfetch<RunDetail>(`/api/admin/auto-repair/runs/${encodeURIComponent(id)}`),
};

/* ------------------------------ your own repairs ------------------------------ */

export type TestState = { state: "not_run" | "passed" | "failed" | "old"; at?: string; output?: string } | null;
export type Playbook = {
    id: string; key: string; title: string; plain: string; signs: string; fixText: string; ifItReturns: string;
    categories: string[]; appWords: string[]; checkService: string | null; checkMetric: "disk" | "cpu" | null;
    detectScript: string; fixScript: string; risk: "low" | "medium" | "high";
    status: "draft" | "tested" | "approved" | "disabled"; version: number; approved: boolean; approvedBy: string | null; approvedAt: string | null;
    warnings: string[]; tests: { detect: TestState; dryrun: TestState };
    createdAt: string; updatedAt: string;
};
export type PlaybookInput = Omit<Playbook, "id" | "key" | "status" | "version" | "approved" | "approvedBy" | "approvedAt" | "warnings" | "tests" | "createdAt" | "updatedAt">;

export const playbooks = {
    list: () => jfetch<{ items: Playbook[] }>("/api/admin/auto-repair/playbooks"),
    create: (body: PlaybookInput) => jfetch<Playbook>("/api/admin/auto-repair/playbooks", { method: "POST", body }),
    update: (id: string, body: PlaybookInput) => jfetch<Playbook>(`/api/admin/auto-repair/playbooks/${encodeURIComponent(id)}`, { method: "PUT", body }),
    remove: (id: string) => jfetch<{ ok: boolean }>(`/api/admin/auto-repair/playbooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    startTest: (id: string, deviceId: string, mode: "detect" | "dryrun") => jfetch<{ jobId: string; mode: string }>(`/api/admin/auto-repair/playbooks/${encodeURIComponent(id)}/test`, { method: "POST", body: { deviceId, mode } }),
    testResult: (id: string, jobId: string, mode: "detect" | "dryrun") => jfetch<{ state: "running" | "passed" | "failed"; summary?: string; output?: string }>(`/api/admin/auto-repair/playbooks/${encodeURIComponent(id)}/tests/${encodeURIComponent(jobId)}?mode=${mode}`),
    approve: (id: string) => jfetch<Playbook>(`/api/admin/auto-repair/playbooks/${encodeURIComponent(id)}/approve`, { method: "POST", body: {} }),
    enable: (id: string) => jfetch<Playbook>(`/api/admin/auto-repair/playbooks/${encodeURIComponent(id)}/enable`, { method: "POST", body: {} }),
    disable: (id: string) => jfetch<Playbook>(`/api/admin/auto-repair/playbooks/${encodeURIComponent(id)}/disable`, { method: "POST", body: {} }),
    versions: (id: string) => jfetch<{ items: Array<{ version: number; hash: string; savedAt: string; note: string | null; by: string | null }> }>(`/api/admin/auto-repair/playbooks/${encodeURIComponent(id)}/versions`),
};
