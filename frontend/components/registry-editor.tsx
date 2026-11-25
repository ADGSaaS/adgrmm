"use client";

// The writing half of the Registry tab (phase 2): the dialogs that add / edit a value, create a key, and confirm EVERY change
// (device, key, value, type, old -> new, a warning, and typing the device name for the dangerous ones), the clear messages for
// refused / changed-since / rate limited / offline / slow / not allowed, and the "Recent changes" panel with Undo.
// The server is the authority: it checks everything again, refuses blocked keys and secret-named values, and records every change.
import * as React from "react";
import { jfetch } from "@/lib/api";
import { errorText, Pill } from "@/components/policies/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type WriteType = "REG_SZ" | "REG_EXPAND_SZ" | "REG_MULTI_SZ" | "REG_DWORD" | "REG_QWORD" | "REG_BINARY";
export const WRITE_TYPES: WriteType[] = ["REG_SZ", "REG_EXPAND_SZ", "REG_MULTI_SZ", "REG_DWORD", "REG_QWORD", "REG_BINARY"];
const LIMITS = { string: 8192, multiItems: 100, multiChars: 8192, binary: 4096, name: 16383 };
const MASK_RE = /pass(word|wd)?|secret|token|credential|apikey|api_key|private.?key/i;
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Data = string | number | string[] | null;
/** A value as the page already shows it (the reader's row). */
export type EditableValue = { name: string; display: string; type: string; size: number; data: Data; hex?: string; truncated?: boolean; masked?: boolean; unreadable?: boolean };
/** One side of a recorded change, as the server shows it. */
export type Side = { exists: false } | { exists: true; type: string; size?: number; data: Data; hex?: string; masked?: boolean } | null;
export type DeletedValue = { name: string; display: string; type?: string; data?: Data; hex?: string; masked?: boolean };
export type ChangeView = {
    id: string; at: string; user: string | null; userId: string | null; action: "set" | "delete-value" | "create-key" | "delete-key";
    undo: boolean; undoOf: string | null; hive: string; view: string; path: string; valueName: string | null; display: string | null;
    old: Side; new: Side; deletedValues: DeletedValue[] | null; valueCount: number | null;
    outcome: "pending" | "ok" | "refused" | "failed"; error: string | null; undoneAt: string | null; undoneBy: string | null; canUndo: boolean;
};

/** Data as text for the confirm dialog and the list (the same way the browser shows it). Hidden data is never shown. */
export function dataText(type: string, data: Data, hex?: string, masked?: boolean): string {
    if (masked) return "(hidden)";
    if (data === null || data === undefined) return "(could not be read)";
    if (type === "REG_DWORD" || type === "REG_QWORD") return hex ? `${data} (${hex})` : String(data);
    if (type === "REG_MULTI_SZ") return Array.isArray(data) ? (data.length ? data.map((x) => `"${x}"`).join(", ") : "(empty list)") : String(data);
    if (type === "REG_BINARY") return String(data) === "" ? "(zero-length)" : String(data);
    return `"${String(data)}"`;
}
export function sideText(s: Side): string {
    if (!s) return "";
    if (!s.exists) return "(not there)";
    return dataText(s.type, s.data, s.hex, s.masked);
}

const depth = (path: string) => path.split("\\").length;
/** The server refuses these anyway; the buttons are just not offered. */
export const canAddValueAt = (path: string) => depth(path) > 2;
export const canCreateKeyUnder = (path: string) => depth(path) >= 2;
export const canDeleteKeyAt = (path: string) => depth(path) > 2;
const needsTypedName = (path: string, action: string, types: (string | null | undefined)[]) =>
    action === "delete-key" || types.some((t) => t === "REG_BINARY") || /^HKLM\\SYSTEM(\\|$)/i.test(path);

/* ------------------------------ talking to the server ------------------------------ */

const base = (deviceId: string) => `/api/devices/${encodeURIComponent(deviceId)}/tools/registry`;

/** Sends one change. A slow device answers "pending": the job is asked about until it ends (the server finalises the record when it is read). */
export async function sendChange(deviceId: string, method: "PUT" | "DELETE" | "POST", rest: string, body?: unknown): Promise<{ changeId: string; change: ChangeView }> {
    let r = await jfetch<any>(`${base(deviceId)}${rest}`, { method, body });
    for (let i = 0; i < 100 && r?.pending; i++) {
        await sleep(1500);
        r = await jfetch<any>(`${base(deviceId)}/jobs/${encodeURIComponent(r.jobId)}`);
    }
    if (r?.pending) throw Object.assign(new Error(JSON.stringify({ message: "The device has not confirmed the change yet. It may still be applied: Recent changes settles it.", code: "slow" })), { status: 409 });
    return r;
}

export type ChangeProblem = { kind: "blocked" | "changed" | "rate" | "offline" | "slow" | "permission" | "invalid" | "other"; message: string };
export function changeProblem(e: unknown): ChangeProblem {
    // jfetch keeps only the server's message and the status, so the kind is told from those.
    const status = (e as any)?.status as number | undefined;
    const message = errorText(e);
    if (status === 429) return { kind: "rate", message };
    if (status === 403 && /Insufficient permissions/i.test(message)) return { kind: "permission", message: "Changing the registry needs the right devices.registry.write (an administrator can grant it in Roles)." };
    if (status === 403 || /^This change is blocked/i.test(message)) return { kind: "blocked", message };
    if (/changed on the device since you looked|changed again since|was changed on the device/i.test(message)) return { kind: "changed", message };
    if (/offline|has no agent/i.test(message)) return { kind: "offline", message };
    if (/took too long|has not confirmed|did not answer/i.test(message)) return { kind: "slow", message: /has not confirmed/i.test(message) ? message : "The device took too long to answer. The change may or may not have been applied: Recent changes settles it, and the key can be looked at again." };
    if (status === 400) return { kind: "invalid", message };
    return { kind: "other", message };
}

export function ProblemBox({ problem, onRefresh }: { problem: ChangeProblem; onRefresh?: () => void }) {
    const title = { blocked: "\u{1F512} Blocked", changed: "Changed since you looked", rate: "Too many changes", offline: "The device is offline", slow: "The device did not confirm in time", permission: "Not allowed", invalid: "Check the entry", other: "The change was not made" }[problem.kind];
    const amber = problem.kind === "blocked" || problem.kind === "changed" || problem.kind === "slow" || problem.kind === "rate";
    return (
        <div role="alert" className={`rounded-md border px-3 py-2 text-sm ${amber ? "border-amber-500/40 bg-amber-500/10" : "border-destructive/40 bg-destructive/5"}`}>
            <p className="font-medium">{title}</p>
            <p className="break-words text-xs text-muted-foreground">{problem.message}</p>
            {problem.kind === "changed" && onRefresh ? <p className="pt-1 text-xs">Nothing was changed. <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={onRefresh}>Refresh the key</button> and look again.</p> : null}
        </div>
    );
}

/* ------------------------------ the confirm dialog ------------------------------ */

export type ChangeRequest = {
    kind: "set" | "delete-value" | "create-key" | "delete-key" | "undo";
    title: string;
    confirmLabel: string;
    path: string;
    name?: string;
    oldType?: string | null;
    newType?: string | null;
    oldText?: string | null;
    newText?: string | null;
    /** Values that go with a deleted key. */
    values?: DeletedValue[];
    note?: string;
    typed: boolean;
    method: "PUT" | "DELETE" | "POST";
    rest: string;
    body?: unknown;
};

export function ConfirmChange({ deviceId, deviceName, req, onBack, onClose, onDone, onRefresh }: {
    deviceId: string; deviceName: string; req: ChangeRequest; onBack?: () => void; onClose: () => void; onDone: (r: { changeId: string; change: ChangeView }) => void; onRefresh: () => void;
}) {
    const [typed, setTyped] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [problem, setProblem] = React.useState<ChangeProblem | null>(null);
    const ok = !req.typed || typed.trim() === deviceName.trim();
    const typeLine = req.oldType && req.newType && req.oldType !== req.newType ? `${req.oldType} → ${req.newType}` : req.newType || req.oldType || "";
    const go = async () => {
        setBusy(true);
        setProblem(null);
        try {
            onDone(await sendChange(deviceId, req.method, req.rest, req.body));
        } catch (e) {
            setProblem(changeProblem(e));
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" data-testid="registry-confirm">
                <DialogHeader>
                    <DialogTitle>{req.title}</DialogTitle>
                    <DialogDescription>Check what will be changed on {deviceName}. Every change is recorded with its old value and can be undone.</DialogDescription>
                </DialogHeader>
                <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
                    <dt className="text-muted-foreground">Device</dt><dd className="break-words font-medium">{deviceName}</dd>
                    <dt className="text-muted-foreground">Key</dt><dd className="break-all font-mono text-xs">{req.path}</dd>
                    {req.name !== undefined ? (<><dt className="text-muted-foreground">Value</dt><dd className="break-all font-mono text-xs">{req.name === "" ? "(Default)" : req.name}</dd></>) : null}
                    {typeLine ? (<><dt className="text-muted-foreground">Type</dt><dd className="font-mono text-xs">{typeLine}</dd></>) : null}
                    {req.oldText !== undefined || req.newText !== undefined ? (
                        <>
                            <dt className="text-muted-foreground">Change</dt>
                            <dd className="min-w-0 space-y-1 font-mono text-xs">
                                {req.oldText !== undefined && req.oldText !== null ? <div className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1"><span className="text-muted-foreground">old: </span>{req.oldText}</div> : null}
                                {req.newText !== undefined && req.newText !== null ? <div className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1"><span className="text-muted-foreground">new: </span>{req.newText}</div> : null}
                            </dd>
                        </>
                    ) : null}
                </dl>
                {req.values ? (
                    <div className="space-y-1 text-xs">
                        <p className="font-medium">{req.values.length === 0 ? "This key holds no values." : `Deleted with the key: ${req.values.length} ${req.values.length === 1 ? "value" : "values"}`}</p>
                        {req.values.length ? (
                            <ul className="max-h-32 divide-y divide-border/60 overflow-auto rounded border">
                                {req.values.map((v, i) => <li key={`${i}|${v.name}`} className="flex flex-wrap gap-x-2 px-2 py-1"><span className="break-all font-mono">{v.display}</span><span className="text-muted-foreground">{v.type}</span></li>)}
                            </ul>
                        ) : null}
                    </div>
                ) : null}
                {req.note ? <p className="text-xs text-muted-foreground">{req.note}</p> : null}
                <p role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">Wrong registry changes can stop Windows or software working. Only change what you understand.</p>
                {req.typed ? (
                    <label className="block space-y-1 text-sm">
                        <span>Type the device name to confirm: <span className="font-mono text-xs">{deviceName}</span></span>
                        <Input aria-label="Type the device name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
                    </label>
                ) : null}
                {problem ? <ProblemBox problem={problem} onRefresh={problem.kind === "changed" ? () => { onClose(); onRefresh(); } : undefined} /> : null}
                <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
                    {onBack ? <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button> : null}
                    <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button variant="destructive" disabled={busy || !ok} onClick={() => void go()}>{busy ? "Working…" : req.confirmLabel}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ add / edit a value ------------------------------ */

type EditorMode = { kind: "add" } | { kind: "edit"; value: EditableValue };

/** What the person typed, checked the way the server checks it. Returns the data to send, or why not. */
export function parseEntry(type: WriteType, text: string, base: "dec" | "hex"): { ok: true; data: string | string[] } | { ok: false; error: string } {
    if (type === "REG_SZ" || type === "REG_EXPAND_SZ") {
        if (text.length > LIMITS.string) return { ok: false, error: `The text is too long (${LIMITS.string} characters at most).` };
        if (text.includes("\u0000")) return { ok: false, error: "The text cannot contain a NUL character." };
        return { ok: true, data: text };
    }
    if (type === "REG_MULTI_SZ") {
        const lines = text.split(/\r?\n/);
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        if (lines.length > LIMITS.multiItems) return { ok: false, error: `A list can have ${LIMITS.multiItems} lines at most.` };
        const empty = lines.findIndex((l) => l === "");
        if (empty >= 0) return { ok: false, error: `Line ${empty + 1} is empty: a list cannot have empty lines.` };
        if (lines.reduce((n, l) => n + l.length, 0) > LIMITS.multiChars) return { ok: false, error: `The lines can hold ${LIMITS.multiChars} characters in all.` };
        return { ok: true, data: lines };
    }
    if (type === "REG_DWORD" || type === "REG_QWORD") {
        const t = text.trim();
        const max = type === "REG_DWORD" ? BigInt("0xFFFFFFFF") : BigInt("0xFFFFFFFFFFFFFFFF");
        const valid = base === "hex" ? /^(0x)?[0-9a-f]{1,16}$/i.test(t) : /^\d{1,20}$/.test(t);
        if (!valid) return { ok: false, error: base === "hex" ? "Enter hex digits (0-9, a-f), for example FF or 0xFF." : "Enter a whole number (digits only)." };
        const n = base === "hex" ? BigInt(`0x${t.replace(/^0x/i, "")}`) : BigInt(t);
        if (n > max) return { ok: false, error: `The number must be from 0 to ${max.toString()}${type === "REG_DWORD" ? " (0xFFFFFFFF)" : ""}.` };
        return { ok: true, data: n.toString() };
    }
    const t = text.trim();
    if (t === "") return { ok: true, data: "" };
    let pairs: string[];
    if (/^[0-9a-f]{2}( [0-9a-f]{2})*$/i.test(t)) pairs = t.split(" ");
    else if (/^([0-9a-f]{2})+$/i.test(t)) pairs = t.match(/../g) as string[];
    else return { ok: false, error: "Enter hex bytes: pairs of the digits 0-9 and a-f, for example 0a 1b 2c (no odd digit, nothing else)." };
    if (pairs.length > LIMITS.binary) return { ok: false, error: `Binary data can be ${LIMITS.binary} bytes at most.` };
    return { ok: true, data: pairs.join(" ").toLowerCase() };
}

const initialText = (v: EditableValue): string => {
    if (v.data === null) return "";
    if (v.type === "REG_MULTI_SZ") return Array.isArray(v.data) ? v.data.join("\n") : String(v.data);
    return String(v.data);
};

/** The data of a value as an "expected old value" for the server: type, size and (when it was shown whole) the data. */
export function expectedOf(v: EditableValue) {
    const whole = !v.truncated && !v.masked && !v.unreadable && v.data !== null && v.data !== undefined;
    return { exists: true as const, type: v.type, size: v.size, ...(whole ? { data: v.type === "REG_DWORD" || v.type === "REG_QWORD" ? String(v.data) : v.data } : {}) };
}

export function ValueEditor({ deviceName, path, view, mode, existingNames, hidden, onCancel, onReview }: {
    deviceName: string; path: string; view: "64" | "32"; mode: EditorMode; existingNames: string[]; hidden?: boolean; onCancel: () => void; onReview: (req: ChangeRequest) => void;
}) {
    const editing = mode.kind === "edit" ? mode.value : null;
    const [name, setName] = React.useState(editing ? editing.name : "");
    const [type, setType] = React.useState<WriteType>(editing && (WRITE_TYPES as string[]).includes(editing.type) ? (editing.type as WriteType) : "REG_SZ");
    const [text, setText] = React.useState(editing ? initialText(editing) : "");
    const [base, setBase] = React.useState<"dec" | "hex">("dec");
    const [error, setError] = React.useState<string | null>(null);
    const numeric = type === "REG_DWORD" || type === "REG_QWORD";
    const masked = MASK_RE.test(name);

    const review = () => {
        setError(null);
        if (!editing) {
            if (name.length > LIMITS.name) return setError(`The name is too long (${LIMITS.name} characters at most).`);
            if (/[\u0000-\u001f\u007f]/.test(name)) return setError("The name has characters that are not allowed.");
            if (masked) return setError("Values whose name looks like a password, secret, token, credential or key are never changed here.");
            if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) return setError(name === "" ? "The (Default) value already exists: edit it instead." : "A value with this name already exists: edit it instead.");
        }
        const p = parseEntry(type, text, base);
        if (!p.ok) return setError(p.error);
        const newText = dataText(type, p.data as Data, numeric ? `0x${BigInt(p.data as string).toString(16).toUpperCase().padStart(type === "REG_DWORD" ? 8 : 16, "0")}` : undefined);
        const oldText = editing ? dataText(editing.type, editing.data, editing.hex, editing.masked) : null;
        onReview({
            kind: "set", title: editing ? "Change this value?" : "Add this value?", confirmLabel: editing ? "Change value" : "Add value",
            path, name, oldType: editing ? editing.type : null, newType: type, oldText: editing ? oldText : "(not there)", newText,
            typed: needsTypedName(path, "set", [type, editing?.type]), method: "PUT", rest: "/value",
            body: { path, view, name, type, data: p.data, expected: editing ? expectedOf(editing) : { exists: false } },
        });
    };

    return (
        <Dialog open={!hidden} onOpenChange={(o) => !o && onCancel()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" data-testid="registry-editor">
                <DialogHeader>
                    <DialogTitle>{editing ? "Edit value" : "Add value"}</DialogTitle>
                    <DialogDescription className="break-all font-mono text-xs">{path} on {deviceName}</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <label className="block space-y-1 text-sm">
                        <span>Name {editing ? <span className="text-xs text-muted-foreground">(cannot be changed)</span> : <span className="text-xs text-muted-foreground">(empty is the (Default) value)</span>}</span>
                        <Input aria-label="Value name" value={name} onChange={(e) => setName(e.target.value)} disabled={!!editing} maxLength={LIMITS.name} spellCheck={false} className="font-mono text-xs" />
                    </label>
                    {masked && !editing ? <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">The name looks like a secret: such values are never changed here.</p> : null}
                    <label className="block space-y-1 text-sm">
                        <span>Type</span>
                        <select aria-label="Value type" className={`${selectClass} w-full`} value={type} onChange={(e) => { setType(e.target.value as WriteType); setError(null); }}>
                            {WRITE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                    </label>
                    {numeric ? (
                        <div className="space-y-1 text-sm">
                            <div className="flex flex-wrap items-end gap-2">
                                <label className="min-w-0 flex-1 space-y-1"><span>Number</span>
                                    <Input aria-label="Number" value={text} onChange={(e) => setText(e.target.value)} inputMode={base === "hex" ? "text" : "numeric"} spellCheck={false} className="font-mono text-xs" />
                                </label>
                                <select aria-label="Number base" className={selectClass} value={base} onChange={(e) => {
                                    const next = e.target.value as "dec" | "hex";
                                    const cur = parseEntry(type, text, base);
                                    if (cur.ok && text.trim() !== "") setText(next === "hex" ? BigInt(cur.data as string).toString(16).toUpperCase() : (cur.data as string));
                                    setBase(next);
                                }}>
                                    <option value="dec">Decimal</option>
                                    <option value="hex">Hex</option>
                                </select>
                            </div>
                            <p className="text-xs text-muted-foreground">{type === "REG_DWORD" ? "0 to 4294967295 (0xFFFFFFFF)" : "0 to 18446744073709551615"}</p>
                        </div>
                    ) : type === "REG_MULTI_SZ" ? (
                        <label className="block space-y-1 text-sm"><span>List: one item per line</span>
                            <Textarea aria-label="List, one item per line" rows={6} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="font-mono text-xs" />
                            <span className="block text-xs text-muted-foreground">Up to {LIMITS.multiItems} lines, {LIMITS.multiChars} characters in all. Empty lines are not allowed.</span>
                        </label>
                    ) : type === "REG_BINARY" ? (
                        <label className="block space-y-1 text-sm"><span>Hex bytes</span>
                            <Textarea aria-label="Hex bytes" rows={5} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="0a 1b 2c" className="font-mono text-xs" />
                            <span className="block text-xs text-muted-foreground">Pairs of hex digits (0a 1b 2c). Up to {LIMITS.binary} bytes. Empty is a zero-length value.</span>
                        </label>
                    ) : (
                        <label className="block space-y-1 text-sm"><span>Data</span>
                            <Textarea aria-label="Data" rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="font-mono text-xs" />
                            <span className="block text-xs text-muted-foreground">Up to {LIMITS.string} characters.{type === "REG_EXPAND_SZ" ? " Names like %SystemRoot% are expanded by Windows when the value is used." : ""}</span>
                        </label>
                    )}
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                </div>
                <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
                    <Button variant="outline" onClick={onCancel}>Cancel</Button>
                    <Button onClick={review} disabled={!editing && masked}>Review change</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The name of a new key (below the open one). */
export function KeyNameDialog({ deviceName, parent, view, existing, hidden, onCancel, onReview }: { deviceName: string; parent: string; view: "64" | "32"; existing: string[]; hidden?: boolean; onCancel: () => void; onReview: (req: ChangeRequest) => void }) {
    const [name, setName] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const go = () => {
        const n = name.trim();
        if (!n) return setError("Enter a name for the new key.");
        if (n.includes("\\")) return setError("A key name cannot contain a backslash. Create one key at a time.");
        if (/[*?\u0000-\u001f\u007f]/.test(n)) return setError("The name has characters that are not allowed (* ? or control characters).");
        if (n === "." || n === ".." || n.length > 255) return setError("Use a key name of up to 255 characters, not . or ..");
        if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return setError("A key with this name already exists.");
        const path = `${parent}\\${n}`;
        onReview({ kind: "create-key", title: "Create this key?", confirmLabel: "Create key", path, newText: "(new empty key)", oldText: "(not there)", typed: /^HKLM\\SYSTEM(\\|$)/i.test(path), method: "POST", rest: "/key", body: { path, view } });
    };
    return (
        <Dialog open={!hidden} onOpenChange={(o) => !o && onCancel()}>
            <DialogContent className="sm:max-w-md" data-testid="registry-newkey">
                <DialogHeader>
                    <DialogTitle>New key</DialogTitle>
                    <DialogDescription className="break-all font-mono text-xs">Below {parent} on {deviceName}</DialogDescription>
                </DialogHeader>
                <label className="block space-y-1 text-sm"><span>Key name</span>
                    <Input aria-label="New key name" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} spellCheck={false} className="font-mono text-xs" onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
                </label>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
                    <Button variant="outline" onClick={onCancel}>Cancel</Button>
                    <Button onClick={go}>Review change</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ asking to undo ------------------------------ */

/** The confirm dialog's content for undoing a recorded change (what will be restored). */
export function undoRequest(c: ChangeView): ChangeRequest {
    const path = c.path;
    const common = { kind: "undo" as const, confirmLabel: "Undo the change", method: "POST" as const, rest: `/changes/${encodeURIComponent(c.id)}/undo` };
    if (c.action === "set") {
        const had = c.old && c.old.exists;
        return {
            ...common, title: "Undo this change?", path, name: c.valueName ?? "",
            oldType: c.new && c.new.exists ? c.new.type : null, newType: had ? (c.old as any).type : null,
            oldText: sideText(c.new), newText: had ? sideText(c.old) : "(deleted again: it did not exist before)",
            typed: needsTypedName(path, "set", [had ? (c.old as any).type : null, c.new && c.new.exists ? c.new.type : null]),
            note: "It is only undone if the value is still what this change left; if it was changed again since, nothing is touched.",
        };
    }
    if (c.action === "delete-value") {
        return { ...common, title: "Undo this deletion?", path, name: c.valueName ?? "", oldText: "(not there)", newText: sideText(c.old), newType: c.old && c.old.exists ? c.old.type : null, typed: needsTypedName(path, "set", [c.old && c.old.exists ? c.old.type : null]), note: "The value is put back only if nobody created it again since." };
    }
    if (c.action === "create-key") return { ...common, title: "Undo creating this key?", path, oldText: "(the empty key)", newText: "(deleted)", typed: needsTypedName(path, "delete-key", []), note: "The key is deleted only while it is still empty." };
    return { ...common, title: "Undo deleting this key?", path, oldText: "(not there)", newText: "(the key with its values again)", values: c.deletedValues ?? [], typed: false, note: "The key and its values are put back only if the key does not exist again." };
}

/* ------------------------------ recent changes ------------------------------ */

const when = (iso: string) => new Date(iso).toLocaleString();
function describe(c: ChangeView): string {
    const n = c.display ?? "";
    if (c.outcome !== "ok") {
        const what = c.action === "set" ? `set ${n || "(Default)"}` : c.action === "delete-value" ? `delete value ${n || "(Default)"}` : c.action === "create-key" ? "create the key" : "delete the key";
        return `${c.undo ? "Undo: " : ""}${c.outcome === "pending" ? "In progress" : "Not made"}: ${what}`;
    }
    if (c.action === "set") return `${c.undo ? "Undo: " : ""}Set ${n} (${c.new && c.new.exists ? c.new.type : "?"}): ${c.old && c.old.exists ? `${sideText(c.old)} → ` : "new value "}${sideText(c.new)}`;
    if (c.action === "delete-value") return `${c.undo ? "Undo: " : ""}Deleted value ${n}${c.old && c.old.exists ? ` (was ${sideText(c.old)})` : ""}`;
    if (c.action === "create-key") return `${c.undo ? "Undo: restored" : "Created"} key${c.valueCount ? ` with ${c.valueCount} values` : ""}`;
    return `Deleted key${c.valueCount !== null ? ` with ${c.valueCount} ${c.valueCount === 1 ? "value" : "values"}` : ""}`;
}

export function RecentChanges({ deviceId, selected, token, canUndo, onUndo }: { deviceId: string; selected: string; token: number; canUndo: boolean; onUndo: (c: ChangeView) => void }) {
    const [scope, setScope] = React.useState<"device" | "key">("device");
    const [items, setItems] = React.useState<ChangeView[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState(true);
    const path = scope === "key" ? selected : "";
    React.useEffect(() => {
        let live = true;
        setError(null);
        jfetch<{ items: ChangeView[] }>(`${base(deviceId)}/changes?limit=30${path ? `&path=${encodeURIComponent(path)}` : ""}`)
            .then((r) => { if (live) setItems(r.items); })
            .catch((e) => { if (live) setError(errorText(e)); });
        return () => { live = false; };
    }, [deviceId, path, token]);
    return (
        <section aria-label="Recent registry changes" className="rounded-md border" data-testid="registry-changes">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                <button type="button" aria-expanded={open} className="text-sm font-medium" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"} Recent changes</button>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">Show
                    <select aria-label="Which changes" className={selectClass} value={scope} onChange={(e) => setScope(e.target.value as "device" | "key")}>
                        <option value="device">This device</option>
                        <option value="key" disabled={!selected}>Only the open key</option>
                    </select>
                </label>
            </div>
            {open ? (
                <ul className="max-h-72 divide-y divide-border/60 overflow-auto text-sm">
                    {error ? <li role="alert" className="px-3 py-2 text-xs text-destructive">{error}</li> : null}
                    {(items ?? []).map((c) => (
                        <li key={c.id} className="space-y-0.5 px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="text-muted-foreground">{when(c.at)}</span>
                                <span className="font-medium">{c.user ?? "someone"}</span>
                                <Pill tone={c.outcome === "ok" ? "good" : c.outcome === "pending" ? "warn" : "bad"}>{c.outcome === "ok" ? "made" : c.outcome}</Pill>
                                {c.undoneAt ? <Pill tone="muted">undone{c.undoneBy ? ` by ${c.undoneBy}` : ""} {when(c.undoneAt)}</Pill> : null}
                                {canUndo && c.canUndo ? <Button type="button" size="sm" variant="outline" className="ml-auto h-7 px-2 text-xs" onClick={() => onUndo(c)} aria-label={`Undo: ${describe(c)}`}>Undo</Button> : null}
                            </div>
                            <p className="break-words text-xs">{describe(c)}</p>
                            <p className="break-all font-mono text-[11px] text-muted-foreground">{c.path}</p>
                            {c.error && c.outcome !== "ok" ? <p className="break-words text-xs text-destructive">{c.error}</p> : null}
                        </li>
                    ))}
                    {items && items.length === 0 ? <li className="px-3 py-3 text-center text-xs text-muted-foreground">No changes yet.</li> : null}
                    {!items && !error ? <li className="px-3 py-3 text-center text-xs text-muted-foreground">Loading…</li> : null}
                </ul>
            ) : null}
        </section>
    );
}
