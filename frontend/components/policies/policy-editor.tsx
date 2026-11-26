"use client";

import { EmptyState } from "@/components/list-controls";
import * as React from "react";
import { Pager, usePaged } from "@/components/pager";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { jfetch } from "@/lib/api";
import { useDeviceChoices, useSites } from "@/components/reports/full-report";
import { SoftwarePicker } from "@/components/policies/software-picker";
import {
    badClass, DAY_NAMES, errorText, Field, LEVEL_LABEL, OS_LABEL, Pill, selectClass, valueText,
    KIND_HELP, KIND_LABEL, policyKinds, type Assignment, type Level, type Policy, type PolicyKind, type Sections,
} from "@/components/policies/shared";

type Tri = "" | "on" | "off";
type Row = Assignment & { key: string };
type WindowRow = { key: string; name: string; days: number[]; start: string; end: string; timezone: string };
type Form = {
    name: string; description: string; enabled: boolean; priority: string; os: Policy["os"]; enforced: boolean; applyToNew: boolean;
    hold: string; reopen: string;
    offline: string; renotify: string; autoTicket: Tri; minSeverity: "" | "WARN" | "CRIT"; autoResolve: Tri;
    hoursOn: boolean; days: number[]; start: string; end: string; timezone: string;
    remote: "" | "off" | "notice" | "consent"; record: "" | "on" | "off";
    windows: WindowRow[]; muteAlerts: boolean;
    approve: "" | "none" | "critical" | "all"; installIn: "" | "anytime" | "maintenance"; reboot: "" | "never" | "maintenance" | "always";
    secScan: string;
    escrow: "" | "off" | "on"; lapsOn: Tri; lapsAccount: string; lapsLength: string; lapsDays: string; lapsReveal: string;
    appScan: string; appUpdate: "" | "none" | "listed" | "all"; appUpdateIn: "" | "anytime" | "maintenance";
    required: string; banned: string; waive: string;
    profileIds: string[];
    assignments: Row[];
};

type ProfileOption = { id: string; name: string; checkNames: string[] };
type HistoryItem = { id: string; action: string; by: string | null; at: string; version: number | null; changes: string[] };
type PreviewResult = {
    devicesChecked: number; devicesReached: number; devicesChanged: number; customersChanged: number; truncated: boolean;
    items: { deviceId: string; device: string; customer: string | null; site: string | null; changes: { key: string; label: string; from: unknown; to: unknown }[] }[];
};

const SECTIONS = [["details", "Details"], ["alerting", "Alerting"], ["software", "Software"], ["hours", "Business hours"], ["maintenance", "Maintenance windows"], ["patching", "Patching"], ["security", "Security"], ["secrets", "Device secrets"], ["remote", "Remote access"], ["checks", "Checks"], ["preview", "Preview"], ["history", "History"]] as const;
type Section = (typeof SECTIONS)[number][0];

const blank = (): Form => ({
    name: "", description: "", enabled: true, priority: "100", os: "any", enforced: false, applyToNew: false,
    hold: "", reopen: "",
    offline: "", renotify: "", autoTicket: "", minSeverity: "", autoResolve: "",
    hoursOn: false, days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", timezone: "UTC",
    remote: "", record: "", windows: [], muteAlerts: true, approve: "", installIn: "", reboot: "", secScan: "", escrow: "", lapsOn: "", lapsAccount: "", lapsLength: "", lapsDays: "", lapsReveal: "", appScan: "", appUpdate: "", appUpdateIn: "", required: "", banned: "", waive: "", profileIds: [], assignments: [],
});

const newWindow = (): WindowRow => ({ key: `w${++rowKey}`, name: "Nightly maintenance", days: [0, 1, 2, 3, 4, 5, 6], start: "02:00", end: "04:00", timezone: "UTC" });

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const tri = (v: boolean | undefined): Tri => (v === undefined ? "" : v ? "on" : "off");
let rowKey = 0;
const withKey = (a: Assignment): Row => ({ ...a, key: `r${++rowKey}` });

function fromPolicy(p: Policy): Form {
    const s = p.sections;
    return {
        name: p.name, description: p.description ?? "", enabled: p.enabled, priority: String(p.priority), os: p.os, enforced: p.enforced, applyToNew: p.applyToNewCustomers === true,
        hold: s.alerting?.holdMinutes !== undefined ? String(s.alerting.holdMinutes) : "", reopen: s.alerting?.reopenWithinMinutes !== undefined ? String(s.alerting.reopenWithinMinutes) : "",
        offline: s.alerting?.offlineAfterMinutes !== undefined ? String(s.alerting.offlineAfterMinutes) : "",
        renotify: s.alerting?.renotifyAfterHours !== undefined ? String(s.alerting.renotifyAfterHours) : "",
        autoTicket: tri(s.alerting?.autoTicket), minSeverity: s.alerting?.autoTicketMinSeverity ?? "", autoResolve: tri(s.alerting?.autoResolveTicket),
        hoursOn: !!s.hours, days: s.hours?.days ?? [1, 2, 3, 4, 5], start: s.hours?.start ?? "08:00", end: s.hours?.end ?? "18:00", timezone: s.hours?.timezone ?? "UTC",
        remote: s.remote?.consent ?? "", record: s.remote?.record === undefined ? "" : s.remote.record ? "on" : "off",
        windows: (s.maintenance?.windows ?? []).map((w) => ({ key: `w${++rowKey}`, ...w })), muteAlerts: s.maintenance?.muteAlerts ?? true,
        approve: s.patching?.approve ?? "", installIn: s.patching?.installIn ?? "", reboot: s.patching?.reboot ?? "",
        secScan: s.security?.scanHours === undefined ? "" : String(s.security.scanHours),
        escrow: s.security?.bitlockerEscrow ?? "", lapsOn: tri(s.laps?.enabled), lapsAccount: s.laps?.account ?? "",
        lapsLength: s.laps?.passwordLength === undefined ? "" : String(s.laps.passwordLength), lapsDays: s.laps?.rotateDays === undefined ? "" : String(s.laps.rotateDays),
        lapsReveal: s.laps?.rotateAfterRevealMinutes === undefined ? "" : String(s.laps.rotateAfterRevealMinutes),
        appScan: s.patching?.appScanHours === undefined ? "" : String(s.patching.appScanHours), appUpdate: s.patching?.appUpdate ?? "", appUpdateIn: s.patching?.appUpdateIn ?? "",
        required: (s.software?.required ?? []).join("\n"), banned: (s.software?.banned ?? []).join("\n"), waive: (s.software?.waive ?? []).join("\n"),
        profileIds: s.checks?.profileIds ?? [],
        assignments: p.assignments.map((a) => withKey(a)),
    };
}

function toSections(f: Form): Sections {
    const out: Sections = {};
    const alerting: NonNullable<Sections["alerting"]> = {};
    if (f.offline.trim() !== "") alerting.offlineAfterMinutes = Number(f.offline);
    if (f.renotify.trim() !== "") alerting.renotifyAfterHours = Number(f.renotify);
    if (f.hold.trim() !== "") alerting.holdMinutes = Number(f.hold);
    if (f.reopen.trim() !== "") alerting.reopenWithinMinutes = Number(f.reopen);
    if (f.autoTicket) alerting.autoTicket = f.autoTicket === "on";
    if (f.minSeverity) alerting.autoTicketMinSeverity = f.minSeverity;
    if (f.autoResolve) alerting.autoResolveTicket = f.autoResolve === "on";
    if (Object.keys(alerting).length) out.alerting = alerting;
    if (f.hoursOn) out.hours = { days: [...f.days].sort((a, b) => a - b), start: f.start, end: f.end, timezone: f.timezone };
    if (f.remote || f.record) out.remote = { ...(f.remote ? { consent: f.remote } : {}), ...(f.record ? { record: f.record === "on" } : {}) };
    if (f.windows.length) out.maintenance = { windows: f.windows.map((w) => ({ name: w.name.trim(), days: [...w.days].sort((a, b) => a - b), start: w.start, end: w.end, timezone: w.timezone })), muteAlerts: f.muteAlerts };
    const patching: NonNullable<Sections["patching"]> = {};
    if (f.approve) patching.approve = f.approve;
    if (f.installIn) patching.installIn = f.installIn;
    if (f.reboot) patching.reboot = f.reboot;
    if (f.appScan.trim() !== "") patching.appScanHours = Number(f.appScan);
    if (f.appUpdate) patching.appUpdate = f.appUpdate;
    if (f.appUpdateIn) patching.appUpdateIn = f.appUpdateIn;
    if (Object.keys(patching).length) out.patching = patching;
    const security: NonNullable<Sections["security"]> = {};
    if (f.secScan.trim() !== "") security.scanHours = Number(f.secScan);
    if (f.escrow) security.bitlockerEscrow = f.escrow;
    if (Object.keys(security).length) out.security = security;
    const laps: NonNullable<Sections["laps"]> = {};
    if (f.lapsOn) laps.enabled = f.lapsOn === "on";
    if (f.lapsAccount.trim() !== "") laps.account = f.lapsAccount.trim();
    if (f.lapsLength.trim() !== "") laps.passwordLength = Number(f.lapsLength);
    if (f.lapsDays.trim() !== "") laps.rotateDays = Number(f.lapsDays);
    if (f.lapsReveal.trim() !== "") laps.rotateAfterRevealMinutes = Number(f.lapsReveal);
    if (Object.keys(laps).length) out.laps = laps;
    const software: NonNullable<Sections["software"]> = {};
    if (lines(f.required).length) software.required = lines(f.required);
    if (lines(f.banned).length) software.banned = lines(f.banned);
    if (lines(f.waive).length) software.waive = lines(f.waive);
    if (Object.keys(software).length) out.software = software;
    if (f.profileIds.length) out.checks = { profileIds: f.profileIds };
    return out;
}

function toBody(f: Form) {
    return {
        name: f.name.trim(), description: f.description, enabled: f.enabled, priority: Number(f.priority), os: f.os, enforced: f.enforced, applyToNewCustomers: f.applyToNew,
        sections: toSections(f),
        assignments: f.assignments.map((a) => ({ level: a.level, targetId: a.targetId, exclude: a.exclude })),
    };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Names Windows keeps for itself; ADG RMM never manages these. The server checks the list again. */
const RESERVED_ACCOUNTS = ["administrator", "guest", "defaultaccount", "system", "wdagutilityaccount", "krbtgt"];
const whole = (s: string, min: number, max: number) => /^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max;

/** What is wrong, by field, with the section to look in. */
function problems(f: Form): Record<string, { section: Section; text: string }> {
    const p: Record<string, { section: Section; text: string }> = {};
    if (!f.name.trim()) p.name = { section: "details", text: "Required" };
    if (!whole(f.priority, 1, 1000)) p.priority = { section: "details", text: "1 to 1000" };
    if (f.offline.trim() !== "" && !whole(f.offline, 1, 1440)) p.offline = { section: "alerting", text: "1 to 1440" };
    if (f.renotify.trim() !== "" && !whole(f.renotify, 0, 720)) p.renotify = { section: "alerting", text: "0 to 720" };
    if (f.hold.trim() !== "" && !whole(f.hold, 0, 1440)) p.hold = { section: "alerting", text: "0 to 1440" };
    if (f.reopen.trim() !== "" && !whole(f.reopen, 0, 1440)) p.reopen = { section: "alerting", text: "0 to 1440" };
    if (f.secScan.trim() !== "" && !whole(f.secScan, 0, 720)) p.secScan = { section: "security", text: "0 to 720" };
    if (f.lapsAccount.trim() !== "") {
        const a = f.lapsAccount.trim();
        if (!/^[A-Za-z0-9._-]{1,20}$/.test(a)) p.lapsAccount = { section: "secrets", text: "1 to 20 letters, digits, . _ -" };
        else if (RESERVED_ACCOUNTS.includes(a.toLowerCase())) p.lapsAccount = { section: "secrets", text: "That name belongs to Windows. Choose another." };
    }
    if (f.lapsLength.trim() !== "" && !whole(f.lapsLength, 14, 64)) p.lapsLength = { section: "secrets", text: "14 to 64" };
    if (f.lapsDays.trim() !== "" && !whole(f.lapsDays, 1, 365)) p.lapsDays = { section: "secrets", text: "1 to 365" };
    if (f.lapsReveal.trim() !== "" && !whole(f.lapsReveal, 0, 10080)) p.lapsReveal = { section: "secrets", text: "0 to 10080" };
    if (f.hoursOn) {
        if (!f.days.length) p.days = { section: "hours", text: "Choose a day" };
        if (!TIME.test(f.start)) p.start = { section: "hours", text: "Like 08:00" };
        if (!TIME.test(f.end)) p.end = { section: "hours", text: "Like 17:30" };
        if (!f.timezone.trim()) p.timezone = { section: "hours", text: "Required" };
    }
    const seen = new Set<string>();
    f.windows.forEach((w, i) => {
        const name = w.name.trim().toLowerCase();
        if (!name) p[`win.${i}.name`] = { section: "maintenance", text: "Required" };
        else if (seen.has(name)) p[`win.${i}.name`] = { section: "maintenance", text: "Already used" };
        seen.add(name);
        if (!w.days.length) p[`win.${i}.days`] = { section: "maintenance", text: "Choose a day" };
        if (!TIME.test(w.start)) p[`win.${i}.start`] = { section: "maintenance", text: "Like 02:00" };
        if (!TIME.test(w.end)) p[`win.${i}.end`] = { section: "maintenance", text: "Like 04:00" };
    });
    return p;
}

const timeZones = (): string[] => {
    try {
        return (Intl as any).supportedValuesOf("timeZone") as string[];
    } catch {
        return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London"];
    }
};

export type PolicyEditorProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The policy to edit, or null to make a new one. */
    policy: Policy | null;
    /** For a new policy: the kind chosen before the editor opened. */
    newKind?: PolicyKind;
    /** Edit a template instead of a policy: no "applies to", no preview, and it is saved as a template. */
    template?: boolean;
    /** For a new policy: start from this template's settings. */
    seed?: Policy | null;
    canWrite: boolean;
    onSaved: (message: string) => void;
};

export function PolicyEditor({ open, onOpenChange, policy, newKind, template = false, seed = null, canWrite, onSaved }: PolicyEditorProps) {
    const editing = !!policy;
    const [form, setForm] = React.useState<Form>(blank);
    const [section, setSection] = React.useState<Section>("details");
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [tried, setTried] = React.useState(false);
    const [profiles, setProfiles] = React.useState<ProfileOption[]>([]);
    const [preview, setPreview] = React.useState<PreviewResult | null>(null);
    const [previewing, setPreviewing] = React.useState(false);
    const [history, setHistory] = React.useState<HistoryItem[] | null>(null);
    const pagedHistory = usePaged(history ?? [], "policy-versions", 10);
    const zones = React.useMemo(timeZones, []);

    React.useEffect(() => {
        if (!open) return;
        const initial = policy ? fromPolicy(policy) : seed ? { ...fromPolicy(seed), assignments: [] } : blank();
        setForm(!policy && newKind === "global" ? { ...initial, assignments: [withKey({ level: "global", targetId: null, exclude: false, targetName: "Everyone" })] } : initial);
        setSection("details");
        setError(null);
        setTried(false);
        setPreview(null);
        setHistory(null);
        jfetch<{ items: ProfileOption[] }>("/api/policies/check-profiles").then((r) => setProfiles(r.items)).catch(() => setProfiles([]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, policy?.id, seed?.id]);

    React.useEffect(() => {
        if (!open || section !== "history" || !policy || history) return;
        jfetch<{ items: HistoryItem[] }>(`/api/policies/${policy.id}/history`).then((r) => setHistory(r.items)).catch((e) => setError(errorText(e)));
    }, [open, section, policy, history]);

    const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setPreview(null); };
    const setWindow = (i: number, patch: Partial<WindowRow>) => { setForm((f) => ({ ...f, windows: f.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) })); setPreview(null); };
    const allProblems = (): Record<string, { section: Section; text: string }> => {
        const p = problems(form);
        if (!template && !editing && newKind && newKind !== "global" && !form.assignments.some((a) => !a.exclude && a.level === newKind)) {
            p.applies = { section: "details", text: `Choose a ${newKind} for this policy.` };
        }
        return p;
    };
    const errs = tried ? allProblems() : {};
    const e = (k: string) => errs[k]?.text;
    const sectionBad = (s: Section) => Object.values(errs).some((x) => x.section === s);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setTried(true);
        const found = allProblems();
        const keys = Object.keys(found);
        if (keys.length) {
            setSection(found[keys[0]].section);
            setError("Some details need fixing. They are marked in red.");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const full = toBody(form);
            const body = template
                ? { name: full.name, description: full.description, priority: full.priority, os: full.os, enforced: full.enforced, sections: full.sections }
                : editing ? { ...full, version: policy!.version } : full;
            const base = template ? "/api/policies/templates" : "/api/policies";
            const saved = await jfetch<{ name: string }>(editing ? `${base}/${policy!.id}` : base, { method: editing ? "PATCH" : "POST", body });
            onSaved(editing ? `Saved ${saved.name}.` : `Created ${saved.name}.`);
            onOpenChange(false);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
        }
    };

    const runPreview = async () => {
        const found = allProblems();
        if (Object.keys(found).length) {
            setTried(true);
            setError("Fix the marked details first, then preview.");
            return;
        }
        setPreviewing(true);
        setError(null);
        try {
            setPreview(await jfetch<PreviewResult>("/api/policies/preview", { method: "POST", body: { ...toBody(form), ...(editing ? { id: policy!.id } : {}) } }));
        } catch (err) {
            setError(errorText(err));
        } finally {
            setPreviewing(false);
        }
    };

    const restore = async (item: HistoryItem) => {
        if (!window.confirm("Put this policy back as it was after this change? Devices will get the old settings again.")) return;
        try {
            await jfetch(`/api/policies/history/${item.id}/restore`, { method: "POST" });
            onSaved("Policy restored.");
            onOpenChange(false);
        } catch (err) {
            setError(errorText(err));
        }
    };

    // The kind is fixed when a policy is started. An existing policy that reaches one kind keeps it; a mixed or empty one shows every choice.
    const existingKinds = policy ? policyKinds(policy) : [];
    const hasOffRows = !!policy && policy.assignments.some((a) => a.exclude);
    const kind: PolicyKind | undefined = newKind ?? (existingKinds.length === 1 && !hasOffRows ? existingKinds[0] : undefined);

    const nav = SECTIONS.filter(([k]) => (k !== "history" || (editing && !template)) && (!template || k !== "preview"));

    return (
        <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
            <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-5xl">
                <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
                    <DialogHeader className="border-b px-6 py-4">
                        <DialogTitle>{template ? (editing ? "Edit template" : "New template") : editing ? "Edit policy" : newKind ? `New ${KIND_LABEL[newKind].toLowerCase()} policy` : "New policy"}</DialogTitle>
                        <DialogDescription>
                            {template ? "A template is a set of settings kept as a pattern. It applies to nothing. Copy it to a global, customer, site or tag policy and edit the copy. " : !editing && newKind ? `${KIND_HELP[newKind]} ${seed ? `Started from the template ${seed.name}. ` : ""}` : ""}A policy is a set of settings and where they apply. Leave a setting empty and the policy says nothing about it, so the device keeps what it already has.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
                        <nav aria-label="Policy sections" className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r">
                            {nav.map(([key, label]) => (
                                <button key={key} type="button" aria-current={section === key ? "page" : undefined} onClick={() => setSection(key)}
                                    className={cn("flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm", section === key ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50")}>
                                    {label}
                                    {sectionBad(key) && <span aria-label="Needs attention" className="h-2 w-2 rounded-full bg-destructive" />}
                                </button>
                            ))}
                        </nav>

                        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                            {section === "details" && (
                                <div className="grid gap-x-4 sm:grid-cols-2">
                                    <Field label="Name *" htmlFor="pe-name" error={e("name")} className="sm:col-span-2">
                                        <Input id="pe-name" value={form.name} maxLength={120} aria-invalid={!!e("name")} className={e("name") ? badClass : ""} autoFocus={!editing} onChange={(ev) => set("name", ev.target.value)} placeholder="Standard workstation baseline" />
                                    </Field>
                                    <Field label="Description" htmlFor="pe-desc" className="sm:col-span-2">
                                        <Textarea id="pe-desc" rows={2} maxLength={500} value={form.description} onChange={(ev) => set("description", ev.target.value)} />
                                    </Field>
                                    <Field label="Priority" htmlFor="pe-priority" error={e("priority")} hint="1 is strongest. Breaks ties at one level.">
                                        <Input id="pe-priority" inputMode="numeric" value={form.priority} aria-invalid={!!e("priority")} className={e("priority") ? badClass : ""} onChange={(ev) => set("priority", ev.target.value)} />
                                    </Field>
                                    <Field label="Operating system" htmlFor="pe-os" hint="Only devices running this system get it">
                                        <select id="pe-os" className={selectClass} value={form.os} onChange={(ev) => set("os", ev.target.value as Policy["os"])}>
                                            {Object.entries(OS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                        </select>
                                    </Field>
                                    {!template && (
                                        <div className="sm:col-span-2 mt-1 pb-3">
                                            <div className="mb-1 text-sm font-medium">Applies to</div>
                                            {kind === "global" ? (
                                                <p className="text-sm text-muted-foreground">Every endpoint. This is the base the other policies build on.</p>
                                            ) : (
                                                <AppliesTo rows={form.assignments} onChange={(rows) => set("assignments", rows)} lockedLevel={kind} error={e("applies")} />
                                            )}
                                        </div>
                                    )}
                                    {!template && (<>
                                    <label className="flex items-start gap-2 text-sm sm:col-span-2">
                                        <input type="checkbox" className="mt-1" checked={form.enabled} onChange={(ev) => set("enabled", ev.target.checked)} />
                                        <span><span className="font-medium">On.</span> <span className="text-muted-foreground">A policy that is off applies to nothing.</span></span>
                                    </label>
                                    <label className="mt-3 flex items-start gap-2 text-sm sm:col-span-2">
                                        <input type="checkbox" className="mt-1" checked={form.applyToNew} onChange={(ev) => set("applyToNew", ev.target.checked)} />
                                        <span><span className="font-medium">Add to every new customer automatically.</span> <span className="text-muted-foreground">Part of the baseline: assigned to each customer the moment it is created. See the Baseline tab for customers that are missing it.</span></span>
                                    </label>
                                    </>)}
                                    <label className="mt-3 flex items-start gap-2 text-sm sm:col-span-2">
                                        <input type="checkbox" className="mt-1" checked={form.enforced} onChange={(ev) => set("enforced", ev.target.checked)} />
                                        <span><span className="font-medium">Enforced.</span> <span className="text-muted-foreground">Nothing more specific (a customer, site or device policy) can change the settings this policy sets. Use it for baselines every customer must have.</span></span>
                                    </label>
                                </div>
                            )}


                            {section === "alerting" && (
                                <div className="grid gap-x-4 sm:grid-cols-2">
                                    <p className="pb-3 text-sm text-muted-foreground sm:col-span-2">Leave a box empty to leave that setting alone.</p>
                                    <Field label="Minutes offline before an alert" htmlFor="pe-offline" error={e("offline")} hint="1 to 1440">
                                        <Input id="pe-offline" inputMode="numeric" value={form.offline} aria-invalid={!!e("offline")} className={e("offline") ? badClass : ""} onChange={(ev) => set("offline", ev.target.value)} placeholder="Leave as is" />
                                    </Field>
                                    <Field label="Hours between reminders" htmlFor="pe-renotify" error={e("renotify")} hint="0 means never remind">
                                        <Input id="pe-renotify" inputMode="numeric" value={form.renotify} aria-invalid={!!e("renotify")} className={e("renotify") ? badClass : ""} onChange={(ev) => set("renotify", ev.target.value)} placeholder="Leave as is" />
                                    </Field>
                                    <Field label="Minutes a check must keep failing before it alerts" htmlFor="pe-hold" error={e("hold")} hint="Stops a blip raising an alert. 0 alerts at once.">
                                        <Input id="pe-hold" inputMode="numeric" value={form.hold} aria-invalid={!!e("hold")} className={e("hold") ? badClass : ""} onChange={(ev) => set("hold", ev.target.value)} placeholder="Leave as is" />
                                    </Field>
                                    <Field label="Reopen a cleared alert if it returns within (minutes)" htmlFor="pe-reopen" error={e("reopen")} hint="One alert and ticket for a problem that flaps. 0 starts a new one.">
                                        <Input id="pe-reopen" inputMode="numeric" value={form.reopen} aria-invalid={!!e("reopen")} className={e("reopen") ? badClass : ""} onChange={(ev) => set("reopen", ev.target.value)} placeholder="Leave as is" />
                                    </Field>
                                    <Field label="Open a ticket for an alert" htmlFor="pe-auto">
                                        <select id="pe-auto" className={selectClass} value={form.autoTicket} onChange={(ev) => set("autoTicket", ev.target.value as Tri)}>
                                            <option value="">Leave as is</option><option value="on">Yes</option><option value="off">No</option>
                                        </select>
                                    </Field>
                                    <Field label="Lowest severity that opens a ticket" htmlFor="pe-sev">
                                        <select id="pe-sev" className={selectClass} value={form.minSeverity} onChange={(ev) => set("minSeverity", ev.target.value as Form["minSeverity"])}>
                                            <option value="">Leave as is</option><option value="WARN">Warning and above</option><option value="CRIT">Critical only</option>
                                        </select>
                                    </Field>
                                    <Field label="Close the ticket when the alert clears" htmlFor="pe-resolve">
                                        <select id="pe-resolve" className={selectClass} value={form.autoResolve} onChange={(ev) => set("autoResolve", ev.target.value as Tri)}>
                                            <option value="">Leave as is</option><option value="on">Yes</option><option value="off">No</option>
                                        </select>
                                    </Field>
                                </div>
                            )}

                            {section === "software" && (
                                <div className="grid gap-x-4 sm:grid-cols-3">
                                    <p className="pb-3 text-sm text-muted-foreground sm:col-span-3">Pick from the software library or the programs seen on your endpoints, or type a name and press Enter. Part of a name is enough. A program that is both required and banned counts as banned.</p>
                                    <SoftwarePicker id="pe-req" label="Must have" hint="Shown as missing if not installed" value={lines(form.required)} onChange={(v) => set("required", v.join("\n"))} />
                                    <SoftwarePicker id="pe-ban" label="Must not have" hint="Shown as found if installed" value={lines(form.banned)} onChange={(v) => set("banned", v.join("\n"))} />
                                    <SoftwarePicker id="pe-waive" label="Allowed here" hint="Takes these off the lists a broader policy set" value={lines(form.waive)} onChange={(v) => set("waive", v.join("\n"))} />
                                </div>
                            )}

                            {section === "hours" && (
                                <div className="grid gap-x-4 sm:grid-cols-3">
                                    <label className="flex items-center gap-2 pb-3 text-sm sm:col-span-3">
                                        <input type="checkbox" checked={form.hoursOn} onChange={(ev) => set("hoursOn", ev.target.checked)} />
                                        <span className="font-medium">Set the working day for these devices</span>
                                    </label>
                                    {form.hoursOn && (
                                        <>
                                            <div className="sm:col-span-3">
                                                <div className="flex flex-wrap gap-2" role="group" aria-label="Working days">
                                                    {DAY_NAMES.map((d, i) => (
                                                        <label key={d} className={cn("flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-sm", form.days.includes(i) && "bg-muted font-medium", e("days") && "border-destructive")}>
                                                            <input type="checkbox" className="sr-only" checked={form.days.includes(i)} onChange={() => set("days", form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i])} />
                                                            {d}
                                                        </label>
                                                    ))}
                                                </div>
                                                <p className={cn("min-h-4 pt-1 text-xs", e("days") ? "text-destructive" : "text-muted-foreground")}>{e("days") ?? ""}</p>
                                            </div>
                                            <Field label="Starts" htmlFor="pe-start" error={e("start")}>
                                                <Input id="pe-start" value={form.start} aria-invalid={!!e("start")} className={e("start") ? badClass : ""} onChange={(ev) => set("start", ev.target.value)} />
                                            </Field>
                                            <Field label="Ends" htmlFor="pe-end" error={e("end")} hint="Same as the start means all day">
                                                <Input id="pe-end" value={form.end} aria-invalid={!!e("end")} className={e("end") ? badClass : ""} onChange={(ev) => set("end", ev.target.value)} />
                                            </Field>
                                            <Field label="Time zone" htmlFor="pe-tz" error={e("timezone")}>
                                                <select id="pe-tz" className={selectClass} value={form.timezone} onChange={(ev) => set("timezone", ev.target.value)}>
                                                    {!zones.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
                                                    {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                                                </select>
                                            </Field>
                                        </>
                                    )}
                                </div>
                            )}

                            {section === "maintenance" && (
                                <div className="grid gap-3">
                                    <p className="text-sm text-muted-foreground">A maintenance window is a time when a device is expected to be busy or restarting. Alerts for the device are held back during it, and updates and restarts can be limited to it. If a problem is still there when the window closes, it is raised then. Windows from the most specific policy replace broader ones.</p>
                                    {form.windows.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No windows. This policy says nothing about maintenance.</p>}
                                    {form.windows.map((w, i) => (
                                        <fieldset key={w.key} className="grid gap-x-4 rounded-md border p-3 sm:grid-cols-4">
                                            <legend className="px-1 text-sm font-medium">{w.name.trim() || `Window ${i + 1}`}</legend>
                                            <Field label="Name *" htmlFor={`pe-w${i}-name`} error={e(`win.${i}.name`)} className="sm:col-span-2">
                                                <Input id={`pe-w${i}-name`} value={w.name} maxLength={60} aria-invalid={!!e(`win.${i}.name`)} className={e(`win.${i}.name`) ? badClass : ""} onChange={(ev) => setWindow(i, { name: ev.target.value })} />
                                            </Field>
                                            <Field label="Starts" htmlFor={`pe-w${i}-start`} error={e(`win.${i}.start`)}>
                                                <Input id={`pe-w${i}-start`} value={w.start} aria-invalid={!!e(`win.${i}.start`)} className={e(`win.${i}.start`) ? badClass : ""} onChange={(ev) => setWindow(i, { start: ev.target.value })} />
                                            </Field>
                                            <Field label="Ends" htmlFor={`pe-w${i}-end`} error={e(`win.${i}.end`)} hint="Same as start: all day">
                                                <Input id={`pe-w${i}-end`} value={w.end} aria-invalid={!!e(`win.${i}.end`)} className={e(`win.${i}.end`) ? badClass : ""} onChange={(ev) => setWindow(i, { end: ev.target.value })} />
                                            </Field>
                                            <div className="sm:col-span-3">
                                                <div className="flex flex-wrap gap-2" role="group" aria-label={`Days for ${w.name}`}>
                                                    {DAY_NAMES.map((d, di) => (
                                                        <label key={d} className={cn("flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-sm", w.days.includes(di) && "bg-muted font-medium", e(`win.${i}.days`) && "border-destructive")}>
                                                            <input type="checkbox" className="sr-only" checked={w.days.includes(di)} onChange={() => setWindow(i, { days: w.days.includes(di) ? w.days.filter((x) => x !== di) : [...w.days, di] })} />
                                                            {d}
                                                        </label>
                                                    ))}
                                                </div>
                                                <p className={cn("min-h-4 pt-1 text-xs", e(`win.${i}.days`) ? "text-destructive" : "text-muted-foreground")}>{e(`win.${i}.days`) ?? ""}</p>
                                            </div>
                                            <Field label="Time zone" htmlFor={`pe-w${i}-tz`}>
                                                <select id={`pe-w${i}-tz`} className={selectClass} value={w.timezone} onChange={(ev) => setWindow(i, { timezone: ev.target.value })}>
                                                    {!zones.includes(w.timezone) && <option value={w.timezone}>{w.timezone}</option>}
                                                    {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                                                </select>
                                            </Field>
                                            <div className="sm:col-span-4"><Button type="button" variant="ghost" size="sm" onClick={() => set("windows", form.windows.filter((x) => x.key !== w.key))}><Trash2 className="mr-1 h-4 w-4" aria-hidden /> Remove this window</Button></div>
                                        </fieldset>
                                    ))}
                                    <div><Button type="button" variant="outline" size="sm" onClick={() => set("windows", [...form.windows, newWindow()])}>Add a window</Button></div>
                                    <label className="flex items-start gap-2 text-sm">
                                        <input type="checkbox" className="mt-1" checked={form.muteAlerts} onChange={(ev) => set("muteAlerts", ev.target.checked)} />
                                        <span><span className="font-medium">Hold alerts back during a window.</span> <span className="text-muted-foreground">Offline and check alerts are not raised while a window is open.</span></span>
                                    </label>
                                </div>
                            )}

                            {section === "patching" && (
                                <div className="grid gap-x-4 sm:grid-cols-2">
                                    <p className="pb-3 text-sm text-muted-foreground sm:col-span-2">Install updates and restart devices on their own, on Windows and on Linux (apt, dnf, yum and zypper). Leave a choice on &quot;Leave as is&quot; and the policy says nothing about it. Without any policy, updates are installed by hand from the device page. Only devices that are online are touched, and an install is not repeated for four hours. On Linux, &quot;critical and important&quot; means security updates, and the device needs agent 1.3.34 or newer.</p>
                                    <Field label="Install updates automatically" htmlFor="pe-approve" hint="Needs a recent update scan, which runs every day">
                                        <select id="pe-approve" className={selectClass} value={form.approve} onChange={(ev) => set("approve", ev.target.value as Form["approve"])}>
                                            <option value="">Leave as is</option>
                                            <option value="none">No, install by hand</option>
                                            <option value="critical">Critical and important updates (security updates on Linux)</option>
                                            <option value="all">Every update</option>
                                        </select>
                                    </Field>
                                    <Field label="When to install" htmlFor="pe-install-in" hint={form.installIn === "maintenance" && form.windows.length === 0 ? "Add a maintenance window, here or in another policy" : undefined}>
                                        <select id="pe-install-in" className={selectClass} value={form.installIn} onChange={(ev) => set("installIn", ev.target.value as Form["installIn"])}>
                                            <option value="">Leave as is</option>
                                            <option value="anytime">Any time</option>
                                            <option value="maintenance">Only in a maintenance window</option>
                                        </select>
                                    </Field>
                                    <Field label="Restart when an update needs it" htmlFor="pe-reboot" hint="A restart gives the person at the device two minutes" className="sm:col-span-2">
                                        <select id="pe-reboot" className={selectClass} value={form.reboot} onChange={(ev) => set("reboot", ev.target.value as Form["reboot"])}>
                                            <option value="">Leave as is</option>
                                            <option value="never">Never, restart by hand</option>
                                            <option value="maintenance">In a maintenance window</option>
                                            <option value="always">As soon as an update needs it (can interrupt people)</option>
                                        </select>
                                    </Field>
                                    <h3 className="pt-4 text-sm font-semibold sm:col-span-2">Other programs (winget and Chocolatey)</h3>
                                    <p className="pb-3 text-sm text-muted-foreground sm:col-span-2">Find programs with a newer version and update them. This is separate from Windows updates and only works on Windows devices with a recent agent. Updates never force a restart; a program that needs one says so in the install log. Manage the allowed and never-update lists on the Software tab of the Policies page.</p>
                                    <Field label="Scan for outdated programs every (hours)" htmlFor="pe-app-scan" hint="0 means never; leave empty to say nothing. 1 to 720">
                                        <input id="pe-app-scan" type="number" min={0} max={720} className={selectClass} value={form.appScan} onChange={(ev) => set("appScan", ev.target.value)} placeholder="Leave as is" />
                                    </Field>
                                    <Field label="Update other programs automatically" htmlFor="pe-app-update" hint="A program is not tried again for a day">
                                        <select id="pe-app-update" className={selectClass} value={form.appUpdate} onChange={(ev) => set("appUpdate", ev.target.value as Form["appUpdate"])}>
                                            <option value="">Leave as is</option>
                                            <option value="none">No, update by hand</option>
                                            <option value="listed">Only programs on the allowed list</option>
                                            <option value="all">Every outdated program (except never-update)</option>
                                        </select>
                                    </Field>
                                    <Field label="When to update programs" htmlFor="pe-app-update-in" hint={form.appUpdateIn === "maintenance" && form.windows.length === 0 ? "Add a maintenance window, here or in another policy" : undefined} className="sm:col-span-2">
                                        <select id="pe-app-update-in" className={selectClass} value={form.appUpdateIn} onChange={(ev) => set("appUpdateIn", ev.target.value as Form["appUpdateIn"])}>
                                            <option value="">Leave as is</option>
                                            <option value="anytime">Any time</option>
                                            <option value="maintenance">Only in a maintenance window</option>
                                        </select>
                                    </Field>
                                </div>
                            )}

                            {section === "security" && (
                                <div className="grid gap-x-4 sm:grid-cols-2">
                                    <p className="pb-3 text-sm text-muted-foreground sm:col-span-2">Check the security of Windows and Linux devices on a schedule: antivirus, disk encryption, the firewall, accounts, SSH and more, against the security baseline. The scan only reads, nothing on the device is changed, and only devices that are online are asked. Without any policy, devices are scanned every 24 hours. Results are on each device&apos;s Security tab and on the Security page.</p>
                                    <Field label="Security scan every (hours)" htmlFor="pe-sec-scan" error={e("secScan")} hint="0 means never, scan by hand; leave empty to say nothing (24 hours unless another policy says otherwise). 1 to 720">
                                        <input id="pe-sec-scan" type="number" min={0} max={720} className={selectClass} value={form.secScan} onChange={(ev) => set("secScan", ev.target.value)} placeholder="Leave as is" aria-invalid={e("secScan") ? true : undefined} />
                                    </Field>
                                </div>
                            )}

                            {section === "secrets" && (
                                <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2" data-testid="secrets-section">
                                    <div className="space-y-2 pb-3 text-sm text-muted-foreground sm:col-span-2">
                                        <p>Keep the secrets of Windows and Linux devices where the right people can find them when a device locks up: disk recovery keys (BitLocker on Windows, LUKS on Linux), and a local administrator password that is different on every device. Both are off unless a policy turns them on; without any policy nothing is collected and no account is created.</p>
                                        <ul className="list-disc space-y-1 pl-5">
                                            <li>Everything is stored encrypted on this server and shown only to people with the right to view device secrets (Roles). Nobody has it by default except the owner. Every reveal asks for a reason and is logged.</li>
                                            <li>The password is generated on the device and sent here; it is never made or seen anywhere else.</li>
                                            <li>ADG RMM only creates and manages its own account. It never touches the built-in Administrator account or any other account.</li>
                                            <li>Turning password management off keeps the stored passwords and stops rotating them. The last password may still work on the device.</li>
                                        </ul>
                                        <p>Leave a field on &quot;Leave as is&quot; and the policy says nothing about it.</p>
                                    </div>
                                    <h3 className="pb-2 text-sm font-semibold sm:col-span-2">Disk recovery keys (BitLocker, LUKS)</h3>
                                    <Field label="Escrow disk recovery keys" htmlFor="pe-escrow" hint="Off unless a policy says on. A Windows device sends the keys of its BitLocker volumes here. On Linux, ADG RMM adds one recovery key slot to each LUKS2 disk that unlocks with the TPM or a key file and stores that key. Encrypted at rest." className="sm:col-span-2">
                                        <select id="pe-escrow" className={selectClass} value={form.escrow} onChange={(ev) => set("escrow", ev.target.value as Form["escrow"])}>
                                            <option value="">Leave as is (off unless another policy says otherwise)</option>
                                            <option value="on">On: collect and store the recovery keys</option>
                                            <option value="off">Off: do not collect them</option>
                                        </select>
                                    </Field>
                                    <h3 className="pb-2 pt-2 text-sm font-semibold sm:col-span-2">Local administrator password</h3>
                                    <Field label="Manage the local administrator password" htmlFor="pe-laps-on" hint="Off unless a policy says on" className="sm:col-span-2">
                                        <select id="pe-laps-on" className={selectClass} value={form.lapsOn} onChange={(ev) => set("lapsOn", ev.target.value as Tri)}>
                                            <option value="">Leave as is (off unless another policy says otherwise)</option>
                                            <option value="on">On: create the account and rotate its password</option>
                                            <option value="off">Off: stop rotating (stored passwords are kept)</option>
                                        </select>
                                    </Field>
                                    <Field label="Account name" htmlFor="pe-laps-account" error={e("lapsAccount")} hint="Default adg-admin. 1 to 20 letters, digits, . _ - Not Administrator, Guest or another Windows account.">
                                        <input id="pe-laps-account" type="text" maxLength={20} autoComplete="off" className={selectClass} value={form.lapsAccount} onChange={(ev) => set("lapsAccount", ev.target.value)} placeholder="Leave as is" aria-invalid={e("lapsAccount") ? true : undefined} />
                                    </Field>
                                    <Field label="Password length" htmlFor="pe-laps-length" error={e("lapsLength")} hint="Default 20 characters. 14 to 64">
                                        <input id="pe-laps-length" type="number" min={14} max={64} className={selectClass} value={form.lapsLength} onChange={(ev) => set("lapsLength", ev.target.value)} placeholder="Leave as is" aria-invalid={e("lapsLength") ? true : undefined} />
                                    </Field>
                                    <Field label="Rotate every (days)" htmlFor="pe-laps-days" error={e("lapsDays")} hint="Default 30 days. 1 to 365">
                                        <input id="pe-laps-days" type="number" min={1} max={365} className={selectClass} value={form.lapsDays} onChange={(ev) => set("lapsDays", ev.target.value)} placeholder="Leave as is" aria-invalid={e("lapsDays") ? true : undefined} />
                                    </Field>
                                    <Field label="Rotate after a reveal (minutes)" htmlFor="pe-laps-reveal" error={e("lapsReveal")} hint="Default 60. Once someone has seen the password it is changed again after this long. 0 means never, only on the schedule. 0 to 10080">
                                        <input id="pe-laps-reveal" type="number" min={0} max={10080} className={selectClass} value={form.lapsReveal} onChange={(ev) => set("lapsReveal", ev.target.value)} placeholder="Leave as is" aria-invalid={e("lapsReveal") ? true : undefined} />
                                    </Field>
                                </div>
                            )}

                            {section === "remote" && (
                                <div className="grid max-w-md">
                                    <Field label="When a technician connects, the person at the device" htmlFor="pe-remote" hint="Devices with nobody signed in are never asked">
                                        <select id="pe-remote" className={selectClass} value={form.remote} onChange={(ev) => set("remote", ev.target.value as Form["remote"])}>
                                            <option value="">Leave as is</option>
                                            <option value="notice">Sees a notice</option>
                                            <option value="consent">Is asked for permission first</option>
                                            <option value="off">Sees nothing</option>
                                        </select>
                                    </Field>
                                    <Field label="Record remote sessions" htmlFor="pe-record" hint="Overrides the customer's own setting. The person at the device is always told when a session is recorded.">
                                        <select id="pe-record" className={selectClass} value={form.record} onChange={(ev) => set("record", ev.target.value as Form["record"])}>
                                            <option value="">Leave as is</option>
                                            <option value="on">Record them</option>
                                            <option value="off">Do not record</option>
                                        </select>
                                    </Field>
                                </div>
                            )}

                            {section === "checks" && (
                                <div className="grid gap-2">
                                    <p className="text-sm text-muted-foreground">Check profiles are named sets of checks. Devices this policy reaches run every check in the profiles you choose, on top of the checks already assigned to them. Create profiles on the Check profiles tab.</p>
                                    {profiles.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">There are no check profiles yet.</p>}
                                    {profiles.map((p) => (
                                        <label key={p.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                                            <input type="checkbox" className="mt-1" checked={form.profileIds.includes(p.id)} onChange={() => set("profileIds", form.profileIds.includes(p.id) ? form.profileIds.filter((x) => x !== p.id) : [...form.profileIds, p.id])} />
                                            <span><span className="font-medium">{p.name}</span><span className="block text-xs text-muted-foreground">{p.checkNames.length ? p.checkNames.join(", ") : "No checks in it yet"}</span></span>
                                        </label>
                                    ))}
                                </div>
                            )}

                            {section === "preview" && (
                                <div className="grid gap-3">
                                    <p className="text-sm text-muted-foreground">See which devices would get something different if you saved this now. Nothing is saved by previewing.</p>
                                    <div><Button type="button" variant="outline" disabled={previewing} onClick={() => void runPreview()}>{previewing ? "Checking…" : "Preview the effect"}</Button></div>
                                    {preview && (
                                        <div className="grid gap-2">
                                            <p className="text-sm">
                                                Reaches <strong>{preview.devicesReached}</strong> of {preview.devicesChecked} devices. <strong>{preview.devicesChanged}</strong> would get something different{preview.customersChanged ? <>, across <strong>{preview.customersChanged}</strong> customer{preview.customersChanged === 1 ? "" : "s"}</> : null}.
                                            </p>
                                            {preview.devicesChanged === 0 && <p className="text-sm text-muted-foreground">No device would change. Either nothing is assigned yet, or the devices it reaches already have these values.</p>}
                                            <ul className="grid gap-2">
                                                {preview.items.map((i) => (
                                                    <li key={i.deviceId} className="rounded-md border p-2 text-sm">
                                                        <div className="font-medium">{i.device} <span className="font-normal text-muted-foreground">{[i.customer, i.site].filter(Boolean).join(" / ")}</span></div>
                                                        <ul className="mt-1 grid gap-0.5 text-xs">
                                                            {i.changes.map((c) => (
                                                                <li key={c.key}><span className="text-muted-foreground">{c.label}:</span> {valueText(c.key, c.from)} <span aria-hidden>&rarr;</span><span className="sr-only"> becomes </span> <strong>{valueText(c.key, c.to)}</strong></li>
                                                            ))}
                                                        </ul>
                                                    </li>
                                                ))}
                                            </ul>
                                            {preview.truncated && <p className="text-xs text-muted-foreground">Only the first 100 devices are listed.</p>}
                                        </div>
                                    )}
                                </div>
                            )}

                            {section === "history" && editing && (
                                <div className="grid gap-2">
                                    {!history && <p className="text-sm text-muted-foreground">Loading…</p>}
                                    {history?.length === 0 && <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>}
                                    {pagedHistory.rows.map((h) => (
                                        <div key={h.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-2 text-sm">
                                            <div>
                                                <div><span className="font-medium capitalize">{h.action}</span> <span className="text-muted-foreground">by {h.by ?? "someone"} on {new Date(h.at).toLocaleString()}</span></div>
                                                {h.changes.length > 0 && <ul className="text-xs text-muted-foreground">{h.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                                            </div>
                                            {canWrite && h.action !== "deleted" && <Button type="button" size="sm" variant="outline" onClick={() => void restore(h)}>Restore this version</Button>}
                                        </div>
                                    ))}
                                    {history && history.length > 0 && <Pager paged={pagedHistory} noun="versions" />}
                                </div>
                            )}
                        </div>
                    </div>

                    <DialogFooter className="items-center gap-2 border-t px-6 py-3 sm:justify-between">
                        <p role="alert" className="min-h-5 text-sm text-destructive">{error ?? ""}</p>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>{canWrite ? "Cancel" : "Close"}</Button>
                            {canWrite && <Button type="submit" variant="success" disabled={saving}>{saving ? "Saving..." : editing ? "Save changes" : template ? "Create template" : "Create policy"}</Button>}
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ where it applies ------------------------------ */

function AppliesTo({ rows, onChange, lockedLevel, error }: { rows: Row[]; onChange: (rows: Row[]) => void; lockedLevel?: PolicyKind; error?: string }) {
    const [mode, setMode] = React.useState<"on" | "off">("on");
    const [level, setLevel] = React.useState<Level>(lockedLevel ?? "global");
    const [clientId, setClientId] = React.useState("");
    const [siteId, setSiteId] = React.useState("");
    const [deviceId, setDeviceId] = React.useState("");
    const [tagId, setTagId] = React.useState("");
    const [tagList, setTagList] = React.useState<{ id: string; name: string }[]>([]);
    const [customers, setCustomers] = React.useState<{ key: string; name: string }[]>([]);
    const sites = useSites(clientId);
    const devices = useDeviceChoices(clientId, siteId);

    React.useEffect(() => {
        jfetch<{ key: string; name: string }[]>("/api/customers").then(setCustomers).catch(() => setCustomers([]));
        jfetch<{ items: { id: string; name: string }[] }>("/api/tags").then((r) => setTagList(r.items)).catch(() => setTagList([]));
    }, []);

    const names = React.useMemo(() => new Map(customers.map((c) => [c.key, c.name])), [customers]);
    const target = level === "global" ? "ok" : level === "customer" ? clientId : level === "site" ? siteId : level === "tag" ? tagId : deviceId;
    const nameOf = (): string => {
        if (level === "customer") return names.get(clientId) ?? "Customer";
        if (level === "site") return `${names.get(clientId) ?? "?"} / ${sites.find((s) => s.id === siteId)?.name ?? "site"}`;
        if (level === "tag") return tagList.find((t) => t.id === tagId)?.name ?? "Tag";
        if (level === "device") return devices.find((d) => d.id === deviceId)?.name ?? "Device";
        return "Everyone";
    };

    const add = () => {
        if (!target) return;
        const targetId = level === "global" ? null : level === "customer" ? clientId : level === "site" ? siteId : level === "tag" ? tagId : deviceId;
        if (rows.some((r) => r.level === level && r.targetId === targetId && r.exclude === (mode === "off"))) return;
        onChange([...rows, { key: `r${++rowKey}`, level, targetId, exclude: mode === "off", targetName: nameOf() }]);
    };

    return (
        <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">{lockedLevel ? `Choose which ${lockedLevel === "tag" ? "tags" : lockedLevel === "site" ? "sites" : "customers"} get this policy. Add as many as you like. An endpoint reached twice gets it once.` : "Choose who gets this policy. Add as many as you like. A device in more than one place gets the policy once. You can also switch it off for a customer, site or device it would otherwise reach."}</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {rows.length === 0 && <EmptyState>Not assigned to anything yet, so it applies to no one.</EmptyState>}
            <ul className="grid gap-2">
                {rows.map((r) => (
                    <li key={r.key} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                        <span className="flex flex-wrap items-center gap-2">
                            {r.exclude ? <Pill tone="warn">Switched off for</Pill> : <Pill tone="good">Applies to</Pill>}
                            <Pill>{LEVEL_LABEL[r.level]}</Pill>
                            <span>{r.level === "global" ? "Every device" : r.targetName ?? names.get(r.targetId ?? "") ?? r.targetId}</span>
                        </span>
                        <Button type="button" variant="ghost" size="sm" aria-label="Remove this assignment" onClick={() => onChange(rows.filter((x) => x.key !== r.key))}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                    </li>
                ))}
            </ul>
            <div className="grid gap-2 rounded-md border p-3">
                <div className="flex flex-wrap items-end gap-2">
                    {!lockedLevel && <label className="grid gap-1 text-xs">
                        <span className="text-muted-foreground">Action</span>
                        <select className={cn(selectClass, "w-44")} value={mode} onChange={(ev) => { const m = ev.target.value as "on" | "off"; setMode(m); if (m === "off" && level === "global") setLevel("customer"); }}>
                            <option value="on">Applies to</option>
                            <option value="off">Switched off for</option>
                        </select>
                    </label>}
                    {!lockedLevel && <label className="grid gap-1 text-xs">
                        <span className="text-muted-foreground">Who</span>
                        <select className={cn(selectClass, "w-40")} value={level} onChange={(ev) => { setLevel(ev.target.value as Level); setSiteId(""); setDeviceId(""); setTagId(""); }}>
                            {mode === "on" && <option value="global">Everyone</option>}
                            <option value="customer">A customer</option>
                            <option value="site">A site</option>
                            <option value="tag">A tag</option>
                            <option value="device">A device</option>
                        </select>
                    </label>}
                    {level === "tag" && (
                        <label className="grid gap-1 text-xs">
                            <span className="text-muted-foreground">Tag</span>
                            <select className={cn(selectClass, "w-52")} value={tagId} onChange={(ev) => setTagId(ev.target.value)}>
                                <option value="">{tagList.length ? "Choose a tag" : "No tags yet"}</option>
                                {tagList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </label>
                    )}
                    {level !== "global" && level !== "tag" && (
                        <label className="grid gap-1 text-xs">
                            <span className="text-muted-foreground">Customer</span>
                            <select className={cn(selectClass, "w-52")} value={clientId} onChange={(ev) => { setClientId(ev.target.value); setSiteId(""); setDeviceId(""); }}>
                                <option value="">Choose a customer</option>
                                {customers.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                            </select>
                        </label>
                    )}
                    {(level === "site" || level === "device") && (
                        <label className="grid gap-1 text-xs">
                            <span className="text-muted-foreground">{level === "site" ? "Site" : "Site (optional)"}</span>
                            <select className={cn(selectClass, "w-44")} value={siteId} disabled={!clientId} onChange={(ev) => { setSiteId(ev.target.value); setDeviceId(""); }}>
                                <option value="">{level === "site" ? "Choose a site" : "Any site"}</option>
                                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        </label>
                    )}
                    {level === "device" && (
                        <label className="grid gap-1 text-xs">
                            <span className="text-muted-foreground">Device</span>
                            <select className={cn(selectClass, "w-52")} value={deviceId} disabled={!clientId} onChange={(ev) => setDeviceId(ev.target.value)}>
                                <option value="">Choose a device</option>
                                {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                        </label>
                    )}
                    <Button type="button" variant="outline" disabled={!target} onClick={add}>Add</Button>
                </div>
            </div>
        </div>
    );
}
