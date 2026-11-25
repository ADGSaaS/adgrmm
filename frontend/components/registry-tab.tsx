"use client";

// Registry browser of one Windows device (phase 1: read-only; phase 2: people with devices.registry.write can also change it). Like the Services / Processes / Event log tab, everything is a
// signed script job the device runs and answers (nothing is installed on it), so it only works while the device is online.
// Needs devices.read and devices.registry.read. Only HKLM and HKU are offered: HKU\<account> is that person's own hive.
// Changing (set / delete a value, create / delete an empty key, undo) needs devices.registry.write as well and always goes through a confirm dialog (registry-editor.tsx).
// Keys that hold security secrets are blocked by the server, and values whose name looks like a secret are shown as hidden.
import * as React from "react";
import { jfetch } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { deviceFamily } from "@/lib/device-os";
import { errorText, Pill } from "@/components/policies/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";
import {
    canAddValueAt, canCreateKeyUnder, canDeleteKeyAt, ConfirmChange, dataText, expectedOf, KeyNameDialog, RecentChanges, undoRequest, ValueEditor,
    type ChangeRequest, type ChangeView, type DeletedValue,
} from "@/components/registry-editor";

type RegType = "REG_SZ" | "REG_EXPAND_SZ" | "REG_MULTI_SZ" | "REG_DWORD" | "REG_QWORD" | "REG_BINARY" | "REG_NONE" | "REG_UNKNOWN";
type SubKey = { name: string; hasChildren: boolean; blocked: boolean };
type RegValue = { name: string; display: string; type: RegType; size: number; data: string | number | string[] | null; hex?: string; truncated?: boolean; masked?: boolean; unreadable?: boolean };
type KeyResult = {
    path: string;
    lastWrite: string | null;
    subKeys: SubKey[];
    subKeyCount: number;
    subKeysTruncated: boolean;
    values: RegValue[];
    valueCount: number;
    valuesTruncated: boolean;
};
type RootsResult = { roots: { key: string; name: string }[]; users: { sid: string; account: string | null; path: string }[] };
type Hit = { kind: "key" | "value" | "data"; path: string; name?: string; type?: RegType; preview?: string };
type SearchResult = { results: Hit[]; truncated: boolean; reason: "results" | "time" | null; scanned: number; seconds: number };
type Problem = { kind: "offline" | "unsupported" | "blocked" | "slow" | "missing" | "other"; message: string };

const TOP = [{ key: "HKLM", name: "HKEY_LOCAL_MACHINE" }, { key: "HKU", name: "HKEY_USERS" }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";
const SID_RE = /^S-1-\d+(-\d+)+$/;

/** Asks the registry route; a device that is slow answers "pending" with a job, which is asked about until it ends. */
async function ask<T>(deviceId: string, rest: string): Promise<T> {
    const base = `/api/devices/${encodeURIComponent(deviceId)}/tools/registry`;
    let r = await jfetch<any>(`${base}${rest}`);
    for (let i = 0; i < 100 && r?.pending; i++) {
        await sleep(1500);
        r = await jfetch<any>(`${base}/jobs/${encodeURIComponent(r.jobId)}`);
    }
    if (r?.pending) throw new Error("The device has not answered yet. Try again in a moment.");
    return r as T;
}

function classify(e: unknown): Problem {
    const status = (e as any)?.status as number | undefined;
    const message = errorText(e);
    if (status === 403 && /blocked/i.test(message)) return { kind: "blocked", message };
    if (/offline/i.test(message) || /no agent/i.test(message)) return { kind: "offline", message };
    if (/only available for windows/i.test(message) || /available for Windows and Linux/i.test(message)) return { kind: "unsupported", message };
    if (/took too long|has not answered/i.test(message)) return { kind: "slow", message: `The device took too long to answer. ${message.includes("has not answered") ? "It may be busy." : ""}`.trim() };
    if (/does not exist/i.test(message)) return { kind: "missing", message };
    return { kind: "other", message };
}

const parentOf = (path: string) => (path.includes("\\") ? path.slice(0, path.lastIndexOf("\\")) : "");
const leafOf = (path: string) => path.slice(path.lastIndexOf("\\") + 1);
const ancestorsOf = (path: string) => {
    const parts = path.split("\\");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("\\"));
};

function hexBlock(hex: string): string {
    const bytes = hex.split(" ").filter(Boolean);
    const lines: string[] = [];
    for (let i = 0; i < bytes.length; i += 16) lines.push(`${i.toString(16).padStart(4, "0")}  ${bytes.slice(i, i + 16).join(" ")}`);
    return lines.join("\n");
}

function ProblemNote({ problem }: { problem: Problem }) {
    const title = { offline: "The device is offline", unsupported: "Not available for this device", blocked: "Blocked key", slow: "The device took too long", missing: "No such key", other: "Could not read the registry" }[problem.kind];
    return (
        <div role="alert" className={`rounded-md border px-3 py-2 text-sm ${problem.kind === "blocked" ? "border-amber-500/40 bg-amber-500/10" : "border-destructive/40 bg-destructive/5"}`}>
            <p className="font-medium">{problem.kind === "blocked" ? "\u{1F512} " : ""}{title}</p>
            <p className="text-xs text-muted-foreground">{problem.message}</p>
        </div>
    );
}

/** Whether a value can be edited here: it must have been shown whole, with a type that can be written. */
const WRITABLE = ["REG_SZ", "REG_EXPAND_SZ", "REG_MULTI_SZ", "REG_DWORD", "REG_QWORD", "REG_BINARY"];
const editable = (v: RegValue) => !v.masked && !v.unreadable && !v.truncated && v.data !== null && WRITABLE.includes(v.type);
const editNote = (v: RegValue) => (v.masked ? "Values with a secret-looking name are never changed here" : v.truncated ? "Too long to edit here: it is shown cut" : v.unreadable || v.data === null ? "This value could not be read" : "This type cannot be edited here");

function DataCell({ v, hexMode, open, toggle }: { v: RegValue; hexMode: boolean; open: boolean; toggle: () => void }) {
    if (v.masked) return <span className="inline-flex items-center gap-2"><span className="italic text-muted-foreground">(hidden)</span><Pill tone="warn">hidden: the name looks like a secret</Pill></span>;
    if (v.unreadable || v.data === null) return <span className="italic text-muted-foreground">(could not be read)</span>;
    if (v.type === "REG_DWORD" || v.type === "REG_QWORD") {
        const dec = String(v.data);
        const main = hexMode ? v.hex ?? dec : dec;
        const other = hexMode ? dec : v.hex;
        return <span className="font-mono text-xs">{main}{other ? <span className="ml-2 text-muted-foreground">({other})</span> : null}</span>;
    }
    if (v.type === "REG_MULTI_SZ") {
        const lines = Array.isArray(v.data) ? v.data : [String(v.data)];
        if (lines.length <= 1 && !open) return <span className="break-all font-mono text-xs">{lines[0] ?? ""}{lines.length === 0 ? <span className="italic text-muted-foreground">(empty list)</span> : null}</span>;
        return (
            <div className="font-mono text-xs">
                {open ? <pre className="whitespace-pre-wrap break-all">{lines.join("\n")}</pre> : <span className="break-all">{lines.slice(0, 2).join("  |  ")}{lines.length > 2 ? "  |  …" : ""}</span>}
                <button type="button" className="ml-2 text-primary underline-offset-2 hover:underline" onClick={toggle}>{open ? "collapse" : `show all ${lines.length} lines`}</button>
                {v.truncated && open ? <p className="text-muted-foreground">The list is longer than what is shown.</p> : null}
            </div>
        );
    }
    if (v.type === "REG_SZ" || v.type === "REG_EXPAND_SZ") {
        const text = String(v.data);
        const long = text.length > 120 || /[\r\n]/.test(text);
        return (
            <div className="font-mono text-xs">
                {open ? <pre className="whitespace-pre-wrap break-all">{text}</pre> : <span className="break-all">{long ? `${text.replace(/[\r\n]+/g, " ↵ ").slice(0, 120)}…` : text || <span className="italic text-muted-foreground">(empty)</span>}</span>}
                {long ? <button type="button" className="ml-2 text-primary underline-offset-2 hover:underline" onClick={toggle}>{open ? "collapse" : "expand"}</button> : null}
                {v.truncated && open ? <p className="text-muted-foreground">Cut after {text.length} characters (the value is {v.size} long).</p> : null}
            </div>
        );
    }
    // REG_BINARY, REG_NONE, unknown types: hex
    const hex = String(v.data);
    const shown = hex.split(" ").filter(Boolean).length;
    const short = hex.split(" ").slice(0, 16).join(" ");
    return (
        <div className="font-mono text-xs">
            {v.size === 0 ? <span className="italic text-muted-foreground">(zero-length)</span> : open ? <pre className="whitespace-pre overflow-x-auto">{hexBlock(hex)}</pre> : <span>{short}{shown > 16 ? " …" : ""}</span>}
            {shown > 16 ? <button type="button" className="ml-2 text-primary underline-offset-2 hover:underline" onClick={toggle}>{open ? "collapse" : "show all bytes"}</button> : null}
            {v.truncated && open ? <p className="text-muted-foreground">Truncated: the first {shown} of {v.size} bytes are shown.</p> : null}
        </div>
    );
}

type TreeProps = {
    path: string;
    label: string;
    hasChildren: boolean;
    blocked?: boolean;
    depth: number;
    cache: Record<string, KeyResult>;
    expanded: Set<string>;
    busy: Set<string>;
    nodeErr: Record<string, string>;
    selected: string;
    names: Record<string, string>;
    onToggle: (path: string) => void;
    onSelect: (path: string) => void;
};

function TreeNode(p: TreeProps) {
    const open = p.expanded.has(p.path);
    const data = p.cache[p.path];
    return (
        <li role="none">
            <div role="treeitem" aria-expanded={p.hasChildren ? open : undefined} aria-selected={p.selected === p.path} className={`flex items-center gap-1 rounded px-1 py-0.5 text-sm ${p.selected === p.path ? "bg-accent" : "hover:bg-accent/50"}`} style={{ paddingLeft: `${p.depth * 12 + 4}px` }}>
                {p.hasChildren && !p.blocked ? (
                    <button type="button" aria-label={open ? `Collapse ${p.label}` : `Expand ${p.label}`} className="w-4 shrink-0 text-xs text-muted-foreground" onClick={() => p.onToggle(p.path)}>{p.busy.has(p.path) ? "…" : open ? "▾" : "▸"}</button>
                ) : <span className="w-4 shrink-0" />}
                <button type="button" disabled={p.blocked} title={p.blocked ? "Blocked: this key is never shown" : p.path} className={`min-w-0 flex-1 truncate text-left ${p.blocked ? "cursor-not-allowed text-muted-foreground" : ""}`} onClick={() => p.onSelect(p.path)}>
                    {p.blocked ? "\u{1F512} " : ""}{p.label}
                </button>
            </div>
            {open ? (
                <ul role="group">
                    {p.nodeErr[p.path] ? <li className="px-2 py-0.5 text-xs text-destructive" style={{ paddingLeft: `${(p.depth + 1) * 12 + 20}px` }}>{p.nodeErr[p.path]}</li> : null}
                    {data?.subKeys.length === 0 && !p.busy.has(p.path) ? <li className="px-2 py-0.5 text-xs text-muted-foreground" style={{ paddingLeft: `${(p.depth + 1) * 12 + 20}px` }}>(no sub keys)</li> : null}
                    {(data?.subKeys ?? []).map((c) => {
                        const full = `${p.path}\\${c.name}`;
                        const acct = p.path === "HKU" ? p.names[c.name] : undefined;
                        return <TreeNode key={c.name} {...p} path={full} label={acct ? `${c.name} (${acct})` : c.name} hasChildren={c.hasChildren} blocked={c.blocked} depth={p.depth + 1} />;
                    })}
                    {data?.subKeysTruncated ? <li className="px-2 py-0.5 text-xs text-muted-foreground" style={{ paddingLeft: `${(p.depth + 1) * 12 + 20}px` }}>… {data.subKeyCount - data.subKeys.length} more not shown</li> : null}
                </ul>
            ) : null}
        </li>
    );
}

export default function RegistryTab({ deviceId, os, deviceName }: { deviceId: string; os: string; deviceName: string }) {
    const { permissions } = useMe();
    const family = deviceFamily(os);
    const allowed = family === "windows" && hasPerm(permissions, ["devices.read", "devices.registry.read"]);
    const canWrite = allowed && hasPerm(permissions, ["devices.registry.write"]);

    const [view, setView] = React.useState<"64" | "32">("64");
    const [selected, setSelected] = React.useState("");
    const [pathInput, setPathInput] = React.useState("");
    const [cache, setCache] = React.useState<Record<string, KeyResult>>({});
    const cacheRef = React.useRef<Record<string, KeyResult>>({});
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
    const [busy, setBusy] = React.useState<Set<string>>(new Set());
    const [nodeErr, setNodeErr] = React.useState<Record<string, string>>({});
    const [roots, setRoots] = React.useState<RootsResult | null>(null);
    const [problem, setProblem] = React.useState<Problem | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [hexMode, setHexMode] = React.useState(false);
    const [openRows, setOpenRows] = React.useState<Set<string>>(new Set());
    const [focusValue, setFocusValue] = React.useState<string | null>(null);
    const [copied, setCopied] = React.useState(false);
    const [text, setText] = React.useState("");
    const [where, setWhere] = React.useState<"keys" | "values" | "data">("keys");
    const [searching, setSearching] = React.useState(false);
    const [search, setSearch] = React.useState<(SearchResult & { text: string; in: string; path: string }) | null>(null);
    const [searchProblem, setSearchProblem] = React.useState<Problem | null>(null);
    const token = React.useRef(0);
    // Changing (only with devices.registry.write): the editor, the new-key name, the confirm dialog, the last change (Undo) and the list refresh.
    const [editor, setEditor] = React.useState<{ kind: "add" } | { kind: "edit"; value: RegValue } | null>(null);
    const [keyDialog, setKeyDialog] = React.useState(false);
    const [confirm, setConfirm] = React.useState<ChangeRequest | null>(null);
    const [lastChange, setLastChange] = React.useState<ChangeView | null>(null);
    const [changesToken, setChangesToken] = React.useState(0);

    const names = React.useMemo(() => Object.fromEntries((roots?.users ?? []).filter((u) => u.account).map((u) => [u.sid, u.account as string])), [roots]);

    const mark = (path: string, on: boolean) => setBusy((cur) => { const n = new Set(cur); if (on) n.add(path); else n.delete(path); return n; });

    const viewRef = React.useRef<"64" | "32">("64");
    const loadKey = React.useCallback(async (path: string, force = false): Promise<KeyResult> => {
        if (!force && cacheRef.current[path]) return cacheRef.current[path];
        const d = await ask<KeyResult>(deviceId, `?path=${encodeURIComponent(path)}&view=${viewRef.current}`);
        cacheRef.current = { ...cacheRef.current, [path]: d };
        setCache(cacheRef.current);
        return d;
    }, [deviceId]);

    const loadRoots = React.useCallback(async () => {
        setLoading(true);
        setProblem(null);
        try {
            setRoots(await ask<RootsResult>(deviceId, ""));
        } catch (e) {
            setProblem(classify(e));
        } finally {
            setLoading(false);
        }
    }, [deviceId]);

    React.useEffect(() => {
        if (allowed) void loadRoots();
    }, [allowed, loadRoots]);

    const select = async (path: string, opts: { force?: boolean; reveal?: boolean } = {}) => {
        const my = ++token.current;
        setSelected(path);
        setPathInput(path);
        setProblem(null);
        setOpenRows(new Set());
        if (!path) {
            setFocusValue(null);
            if (!roots) void loadRoots();
            return;
        }
        setLoading(true);
        try {
            const d = await loadKey(path, opts.force);
            if (my !== token.current) return;
            if (d.path && d.path !== path) { setSelected(d.path); setPathInput(d.path); }
            const real = d.path || path;
            setExpanded((cur) => new Set(cur).add(real));
            if (opts.reveal) {
                // Open the parents in the tree, one listing each (the tree loads what it shows).
                for (const a of ancestorsOf(real)) {
                    if (my !== token.current) return;
                    try { if (!cacheRef.current[a]) await loadKey(a); } catch { break; }
                    setExpanded((cur) => new Set(cur).add(a));
                }
            }
        } catch (e) {
            if (my === token.current) setProblem(classify(e));
        } finally {
            if (my === token.current) setLoading(false);
        }
    };

    const toggle = async (path: string) => {
        if (expanded.has(path)) {
            setExpanded((cur) => { const n = new Set(cur); n.delete(path); return n; });
            return;
        }
        setExpanded((cur) => new Set(cur).add(path));
        if (cacheRef.current[path]) return;
        mark(path, true);
        setNodeErr((cur) => { const { [path]: _, ...rest } = cur; return rest; });
        try {
            await loadKey(path);
        } catch (e) {
            setNodeErr((cur) => ({ ...cur, [path]: classify(e).message }));
        } finally {
            mark(path, false);
        }
    };

    // The view changes what HKLM shows: the key that is open is read again in the new view.
    const changeView = (v: "64" | "32") => {
        viewRef.current = v;
        setView(v);
        cacheRef.current = {};
        setCache({});
        setExpanded(new Set());
        setSearch(null);
        void select(selected, { reveal: true });
    };

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(selected);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setProblem({ kind: "other", message: "Copying is not allowed in this browser. Select the path and copy it by hand." });
        }
    };

    const runSearch = async () => {
        if (!selected || !text.trim()) return;
        setSearching(true);
        setSearchProblem(null);
        setSearch(null);
        try {
            const r = await ask<SearchResult>(deviceId, `/search?path=${encodeURIComponent(selected)}&text=${encodeURIComponent(text.trim())}&in=${where}&view=${view}`);
            setSearch({ ...r, text: text.trim(), in: where, path: selected });
        } catch (e) {
            setSearchProblem(classify(e));
        } finally {
            setSearching(false);
        }
    };

    const current = selected ? cache[selected] : undefined;

    // A change was made: forget what is known about its key and the key above it, and look again.
    const afterChange = (change: ChangeView) => {
        const keyGone = change.action === "delete-key";
        const drop = new Set([change.path.toLowerCase(), parentOf(change.path).toLowerCase()]);
        cacheRef.current = Object.fromEntries(Object.entries(cacheRef.current).filter(([k]) => !drop.has(k.toLowerCase())));
        setCache(cacheRef.current);
        setChangesToken((n) => n + 1);
        setLastChange(change);
        const movedOn = keyGone && (selected.toLowerCase() === change.path.toLowerCase() || selected.toLowerCase().startsWith(`${change.path.toLowerCase()}\\`));
        void select(movedOn ? parentOf(change.path) : selected || parentOf(change.path), { force: true, reveal: true });
        toast({
            title: change.undo ? "Undone" : "Changed", variant: "success", duration: 12000, description: change.display ?? change.path,
            ...(!change.undo && change.outcome === "ok" ? { action: { label: "Undo", onClick: () => setConfirm(undoRequest({ ...change, canUndo: true })) } } : {}),
        });
    };
    const refreshOpenKey = () => { cacheRef.current = {}; setCache({}); void select(selected, { force: true, reveal: true }); };

    const askDeleteValue = (v: RegValue) => setConfirm({
        kind: "delete-value", title: "Delete this value?", confirmLabel: "Delete value", path: selected, name: v.name, oldType: v.type, oldText: dataText(v.type, v.data, v.hex, v.masked), newText: "(deleted)",
        typed: v.type === "REG_BINARY" || /^HKLM\\SYSTEM(\\|$)/i.test(selected), method: "DELETE", rest: "/value",
        body: { path: selected, view, name: v.name, expected: expectedOf(v) },
    });
    const askDeleteKey = () => {
        if (!current) return;
        const values: DeletedValue[] = current.values.map((v) => ({ name: v.name, display: v.display, type: v.type }));
        setConfirm({
            kind: "delete-key", title: "Delete this key?", confirmLabel: "Delete key", path: selected, oldText: `(the key with ${current.valueCount} ${current.valueCount === 1 ? "value" : "values"}, no sub keys)`, newText: "(deleted)", values,
            note: "Only an empty key (no sub keys) can be deleted. Its values go with it and are recorded, so Undo can bring the key and its values back.",
            typed: true, method: "DELETE", rest: "/key", body: { path: selected, view, expectedValueCount: current.valueCount },
        });
    };

    React.useEffect(() => {
        if (!focusValue || !current) return;
        document.getElementById(`reg-value-${CSS.escape(focusValue)}`)?.scrollIntoView({ block: "nearest" });
    }, [focusValue, current]);

    if (family !== "windows") return <p className="text-sm text-muted-foreground">The registry browser is only available for Windows devices.</p>;
    if (!allowed) return <p className="text-sm text-muted-foreground">Browsing the registry needs the right to browse the registry of Windows devices (administrators have it).</p>;

    const treeProps = { cache, expanded, busy, nodeErr, selected, names, onToggle: (p: string) => void toggle(p), onSelect: (p: string) => void select(p) };

    return (
        <div className="space-y-4" data-testid="registry-tab">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{canWrite ? "You can change this registry (one value or key at a time; each change is confirmed, recorded and can be undone)." : "Read-only."} Asked of {deviceName} when you open a key; it must be online. Every look{canWrite ? ", search and change" : " and search"} is recorded in the audit log.</p>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">View
                    <select aria-label="Registry view" className={selectClass} value={view} onChange={(e) => changeView(e.target.value as "64" | "32")}>
                        <option value="64">64-bit</option>
                        <option value="32">32-bit (WOW6432Node)</option>
                    </select>
                </label>
            </div>

            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void select(pathInput.trim().replace(/^\\+|\\+$/g, ""), { force: true, reveal: true }); }}>
                <Input aria-label="Key path" value={pathInput} onChange={(e) => setPathInput(e.target.value)} placeholder="HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion" className="min-w-[18rem] flex-1 font-mono text-xs" maxLength={1024} spellCheck={false} />
                <Button type="submit" size="sm" disabled={loading}>Go</Button>
                <Button type="button" size="sm" variant="outline" disabled={!selected || loading} onClick={() => void select(parentOf(selected), { reveal: true })}>Up one level</Button>
                <Button type="button" size="sm" variant="outline" disabled={!selected} onClick={() => void copy()}>{copied ? "Copied" : "Copy path"}</Button>
                <Button type="button" size="sm" variant="outline" disabled={!selected || loading} onClick={() => void select(selected, { force: true })}>Refresh</Button>
            </form>

            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
                <Input aria-label="Search text" value={text} onChange={(e) => setText(e.target.value)} placeholder={selected ? `Search below ${leafOf(selected)}` : "Open a key (or HKLM / HKU) to search below it"} className="w-72" maxLength={200} />
                <select aria-label="Search in" className={selectClass} value={where} onChange={(e) => setWhere(e.target.value as typeof where)}>
                    <option value="keys">Key names</option>
                    <option value="values">Value names</option>
                    <option value="data">Value data</option>
                </select>
                <Button type="submit" size="sm" disabled={searching || !selected || !text.trim()}>{searching ? "Searching…" : "Search"}</Button>
                <span className="text-xs text-muted-foreground">Plain text, up to 6 levels deep, 200 results, 20 seconds.</span>
            </form>
            {searching ? <p className="text-sm text-muted-foreground">Asking the device…</p> : null}
            {searchProblem ? <ProblemNote problem={searchProblem} /> : null}
            {search ? (
                <div className="rounded-md border">
                    <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
                        <span>{search.results.length} {search.results.length === 1 ? "result" : "results"} for &quot;{search.text}&quot; in {search.in === "keys" ? "key names" : search.in === "values" ? "value names" : "value data"} below {search.path}{search.truncated ? (search.reason === "time" ? ". The search stopped after 20 seconds: search below a more specific key to cover the rest" : ". The search stopped at 200 results: be more specific") : ""}.</span>
                        <button type="button" className="text-primary hover:underline" onClick={() => setSearch(null)}>Clear</button>
                    </div>
                    <ul className="max-h-60 divide-y divide-border/60 overflow-auto text-sm">
                        {search.results.map((h, i) => (
                            <li key={`${h.path}|${h.name ?? ""}|${i}`}>
                                <button type="button" className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-accent/40" onClick={() => { void select(h.path, { reveal: true }); setFocusValue(h.name ?? null); }}>
                                    <span className="flex items-center gap-2"><Pill tone="muted">{h.kind === "key" ? "key" : h.kind === "value" ? "value name" : "data"}</Pill><span className="break-all font-mono text-xs">{h.path}</span></span>
                                    {h.name !== undefined ? <span className="pl-1 text-xs">{h.name === "" ? "(Default)" : h.name}{h.preview !== undefined ? <span className="text-muted-foreground"> = {h.preview.length > 100 ? `${h.preview.slice(0, 100)}…` : h.preview}</span> : null}</span> : null}
                                </button>
                            </li>
                        ))}
                        {search.results.length === 0 ? <li className="px-3 py-3 text-center text-xs text-muted-foreground">Nothing found.</li> : null}
                    </ul>
                </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
                <div className="max-h-[65vh] overflow-auto rounded-md border p-1">
                    <ul role="tree" aria-label="Registry keys">
                        {TOP.map((r) => <TreeNode key={r.key} {...treeProps} path={r.key} label={`${r.key} (${r.name})`} hasChildren depth={0} />)}
                    </ul>
                </div>

                <div className="min-w-0 space-y-3">
                    {loading ? <p className="text-sm text-muted-foreground">Asking the device…</p> : null}
                    {problem ? <ProblemNote problem={problem} /> : null}

                    {!selected && !problem ? (
                        <div className="space-y-2 rounded-md border p-3 text-sm">
                            <p className="font-medium">Roots</p>
                            <ul className="space-y-1">
                                {TOP.map((r) => <li key={r.key}><button type="button" className="text-primary hover:underline" onClick={() => void select(r.key, { reveal: true })}>{r.key}</button> <span className="text-xs text-muted-foreground">{r.name}</span></li>)}
                            </ul>
                            <p className="pt-2 text-xs text-muted-foreground">HKCU of the agent is the SYSTEM account&apos;s hive, so it is not offered. To see a person&apos;s own settings, open their account under HKU: it is their HKCU.</p>
                            {roots ? (
                                <table className="w-full text-xs">
                                    <thead className="text-left text-muted-foreground"><tr><th className="py-1 pr-3">Loaded account hives (HKU)</th><th className="py-1">Account</th></tr></thead>
                                    <tbody className="divide-y divide-border/60">
                                        {roots.users.map((u) => (
                                            <tr key={u.sid}>
                                                <td className="py-1 pr-3"><button type="button" className="break-all font-mono text-primary hover:underline" onClick={() => void select(u.path, { reveal: true })}>{u.path}</button></td>
                                                <td className="py-1">{u.account ?? <span className="text-muted-foreground">{SID_RE.test(u.sid) ? "not resolved" : ""}</span>}</td>
                                            </tr>
                                        ))}
                                        {roots.users.length === 0 ? <tr><td colSpan={2} className="py-2 text-muted-foreground">No account hives are loaded.</td></tr> : null}
                                    </tbody>
                                </table>
                            ) : null}
                        </div>
                    ) : null}

                    {current ? (
                        <>
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span>
                                    {current.subKeyCount} {current.subKeyCount === 1 ? "sub key" : "sub keys"}, {current.valueCount} {current.valueCount === 1 ? "value" : "values"}
                                    {current.lastWrite ? `, last changed ${new Date(current.lastWrite).toLocaleString()}` : ""}
                                    {SID_RE.test(leafOf(current.path)) && parentOf(current.path) === "HKU" && names[leafOf(current.path)] ? `. This is the hive of ${names[leafOf(current.path)]} (their HKCU)` : ""}
                                </span>
                                <label className="flex items-center gap-1"><input type="checkbox" checked={hexMode} onChange={(e) => setHexMode(e.target.checked)} /> Show numbers as hex</label>
                            </div>
                            {canWrite ? (
                                <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Change this key">
                                    <Button type="button" size="sm" disabled={!canAddValueAt(selected)} title={canAddValueAt(selected) ? undefined : "Values are not added at the top of the registry"} onClick={() => setEditor({ kind: "add" })}>Add value</Button>
                                    <Button type="button" size="sm" variant="outline" disabled={!canCreateKeyUnder(selected)} onClick={() => setKeyDialog(true)}>New key</Button>
                                    <Button type="button" size="sm" variant="outline" disabled={!canDeleteKeyAt(selected) || current.subKeyCount > 0 || current.subKeysTruncated} title={current.subKeyCount > 0 ? "Only a key without sub keys can be deleted" : undefined} onClick={askDeleteKey}>Delete key</Button>
                                </div>
                            ) : null}
                            {canWrite && lastChange && lastChange.outcome === "ok" ? (
                                <p role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs" data-testid="registry-changed">
                                    <span className="min-w-0 break-words">{lastChange.undo ? "Undone." : "Changed."} {lastChange.display ?? lastChange.path}</span>
                                    {!lastChange.undo ? <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setConfirm(undoRequest({ ...lastChange, canUndo: true }))}>Undo</Button> : null}
                                    <button type="button" className="ml-auto text-muted-foreground hover:underline" onClick={() => setLastChange(null)}>Dismiss</button>
                                </p>
                            ) : null}
                            {current.valuesTruncated ? <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">Truncated: the first {current.values.length} of {current.valueCount} values are shown.</p> : null}
                            {current.subKeysTruncated ? <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">Truncated: the first {current.subKeys.length} of {current.subKeyCount} sub keys are shown.</p> : null}
                            {current.values.some((v) => v.masked) ? <p role="status" className="text-xs text-muted-foreground">Values whose name looks like a password, secret, token, credential or key are hidden: only their type and size are shown.</p> : null}
                            <div className="max-h-[55vh] overflow-auto rounded-md border">
                                <table className="w-full table-fixed text-sm">
                                    <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground"><tr><th className="w-[28%] px-3 py-2">Name</th><th className="w-[13rem] px-3 py-2">Type</th><th className="px-3 py-2">Data</th><th className="w-20 px-3 py-2 text-right">Size</th>{canWrite ? <th className="w-28 px-2 py-2"><span className="sr-only">Actions</span></th> : null}</tr></thead>
                                    <tbody className="divide-y divide-border/60">
                                        {current.values.map((v, i) => {
                                            const rowKey = `${i}|${v.name}`;
                                            return (
                                                <tr key={rowKey} id={`reg-value-${v.name}`} className={`align-top ${focusValue !== null && focusValue === v.name ? "bg-accent/60" : "hover:bg-accent/40"}`} onDoubleClick={canWrite && editable(v) ? () => setEditor({ kind: "edit", value: v }) : undefined}>
                                                    <td className="break-all px-3 py-1.5 text-xs font-medium">{v.display}</td>
                                                    <td className="px-3 py-1.5 text-xs">{v.type}</td>
                                                    <td className="min-w-0 px-3 py-1.5"><DataCell v={v} hexMode={hexMode} open={openRows.has(rowKey)} toggle={() => setOpenRows((cur) => { const n = new Set(cur); if (n.has(rowKey)) n.delete(rowKey); else n.add(rowKey); return n; })} /></td>
                                                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">{v.size}</td>
                                                    {canWrite ? (
                                                        <td className="whitespace-nowrap px-2 py-1.5 text-right">
                                                            <button type="button" aria-label={`Edit ${v.display}`} title={editable(v) ? "Edit (or double-click the row)" : editNote(v)} disabled={!editable(v)} className="rounded px-1.5 py-0.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40" onClick={() => setEditor({ kind: "edit", value: v })}>{"\u270E"} Edit</button>
                                                            <button type="button" aria-label={`Delete ${v.display}`} title={v.masked ? "Values with a secret-looking name are never deleted here" : "Delete this value"} disabled={!!v.masked || !!v.unreadable} className="rounded px-1.5 py-0.5 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => askDeleteValue(v)}>Delete</button>
                                                        </td>
                                                    ) : null}
                                                </tr>
                                            );
                                        })}
                                        {current.values.length === 0 ? <tr><td colSpan={canWrite ? 5 : 4} className="px-3 py-4 text-center text-xs text-muted-foreground">This key has no values.</td></tr> : null}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    ) : null}
                </div>
            </div>

            {canWrite ? <RecentChanges deviceId={deviceId} selected={selected} token={changesToken} canUndo={canWrite} onUndo={(c) => setConfirm(undoRequest(c))} /> : null}

            {canWrite && editor && selected ? (
                <ValueEditor key={editor.kind === "edit" ? `edit|${editor.value.name}` : "add"} hidden={!!confirm} deviceName={deviceName} path={selected} view={view} mode={editor} existingNames={(current?.values ?? []).map((v) => v.name)} onCancel={() => setEditor(null)} onReview={(r) => setConfirm(r)} />
            ) : null}
            {canWrite && keyDialog && selected ? (
                <KeyNameDialog hidden={!!confirm} deviceName={deviceName} parent={selected} view={view} existing={(current?.subKeys ?? []).map((k) => k.name)} onCancel={() => setKeyDialog(false)} onReview={(r) => setConfirm(r)} />
            ) : null}
            {canWrite && confirm ? (
                <ConfirmChange
                    deviceId={deviceId} deviceName={deviceName} req={confirm}
                    onBack={editor || keyDialog ? () => setConfirm(null) : undefined}
                    onClose={() => { setConfirm(null); setEditor(null); setKeyDialog(false); }}
                    onDone={(r) => { setConfirm(null); setEditor(null); setKeyDialog(false); afterChange(r.change); }}
                    onRefresh={refreshOpenKey}
                />
            ) : null}
        </div>
    );
}
