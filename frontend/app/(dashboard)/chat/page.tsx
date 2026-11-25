"use client";

// Device chat: what people at computers wrote from the tray app, and the answers. A list of the computers that have written, newest first,
// with how many lines nobody has read, and the thread of the one that is open. The page looks for news every few seconds while it is open.
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { jfetch } from "@/lib/api";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { useMe } from "@/lib/use-me";

type Convo = { deviceId: string; name: string; customer: string | null; site: string | null; online: boolean; lastAt: string; lastText: string; lastFrom: "support" | "device"; unread: number };
type Msg = { id: string; from: "support" | "device"; sender: string; text: string; at: string; seen: boolean | null };
type PastChat = { id: string; startedAt: string; endedAt: string; endedBy: "user" | "technician" | "idle" | "earlier" | null; endedByName: string | null; contactName: string | null; contactEmail: string | null; emailStatus: string | null; messages: number };
type Transcript = { session: { id: string; startedAt: string; endedAt: string | null; endedBy: string | null; endedByName: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null; emailStatus: string | null; emailedAt: string | null }; transcript: string | null; messages: Array<{ id: string; from: "support" | "device"; sender: string; text: string; at: string }> };
const ENDED_BY: Record<string, string> = { user: "the person at the computer", technician: "a technician", idle: "inactivity", earlier: "an earlier version (no end recorded)" };
const emailText = (c: { contactEmail: string | null; emailStatus: string | null }) => (c.emailStatus === "sent" ? `Transcript emailed to ${c.contactEmail}` : c.emailStatus === "no_email" ? "No email address, so nothing was emailed" : c.emailStatus?.startsWith("failed") ? `Could not email the transcript to ${c.contactEmail} (${c.emailStatus.slice(8)})` : "");
type Thread = { session?: { id: string; startedAt: string; contactName: string | null; contactEmail: string | null } | null; sessions?: PastChat[]; device: { id: string; name: string; customer: string | null; site: string | null; online: boolean }; trayOn: boolean; contact?: { user: string; name: string | null; email: string | null; phone: string | null } | null; messages: Msg[] };

function ChatBody() {
    const { permissions } = useMe();
    const canReply = hasPerm(permissions, "devices.actions");
    const params = useSearchParams();
    const [convos, setConvos] = React.useState<Convo[] | null>(null);
    const [open, setOpen] = React.useState<string | null>(params.get("device"));
    const [thread, setThread] = React.useState<Thread | null>(null);
    const [text, setText] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const end = React.useRef<HTMLDivElement | null>(null);
    const [past, setPast] = React.useState<{ id: string; data: Transcript | null } | null>(null);

    const loadList = React.useCallback(async () => {
        try { setConvos((await jfetch<{ items: Convo[] }>("/api/device-chat")).items); } catch (e) { setError(errorText(e)); }
    }, []);
    const loadThread = React.useCallback(async (id: string) => {
        try { setThread(await jfetch<Thread>(`/api/device-chat/${encodeURIComponent(id)}`)); setError(null); } catch (e) { setError(errorText(e)); }
    }, []);

    React.useEffect(() => { void loadList(); const t = setInterval(() => void loadList(), 8000); return () => clearInterval(t); }, [loadList]);
    React.useEffect(() => {
        if (!open) { setThread(null); return; }
        void loadThread(open);
        const t = setInterval(() => void loadThread(open), 5000);
        return () => clearInterval(t);
    }, [open, loadThread]);
    React.useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [thread?.messages.length]);

    const endChat = async () => {
        if (!open || !thread?.session) return;
        const to = thread.session.contactEmail;
        if (!window.confirm(to ? `End this chat? A transcript is emailed to ${to} and a copy is kept here.` : "End this chat? There is no email address for this person, so a copy is kept here only.")) return;
        setBusy(true); setError(null);
        try {
            await jfetch(`/api/device-chat/${encodeURIComponent(open)}/end`, { method: "POST", body: {} });
            await Promise.all([loadThread(open), loadList()]);
        } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };
    const showPast = async (id: string) => {
        if (past?.id === id) { setPast(null); return; }
        setPast({ id, data: null });
        try { const data = await jfetch<Transcript>(`/api/device-chat/${encodeURIComponent(open ?? "")}/sessions/${encodeURIComponent(id)}`); setPast({ id, data }); } catch (e) { setError(errorText(e)); setPast(null); }
    };

    const send = async () => {
        if (!open || !text.trim()) return;
        setBusy(true); setError(null);
        try {
            await jfetch(`/api/device-chat/${encodeURIComponent(open)}`, { method: "POST", body: { message: text } });
            setText("");
            await Promise.all([loadThread(open), loadList()]);
        } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };

    return (
        <PageShell>
            <PageHeader title="Device chat" description="What people at computers wrote from the tray app, and your answers. They see your reply in the tray within a minute." />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!convos ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : convos.length === 0 && !open ? (
                <EmptyState>
                    <MessageSquare className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
                    Nobody has written yet. Turn the tray app on under Administration &gt; Agents &amp; Endpoints, and people can write to you from their computers.
                </EmptyState>
            ) : (
                <div className="grid min-h-[28rem] gap-3 md:grid-cols-[18rem_minmax(0,1fr)]">
                    <ul className="max-h-[70vh] overflow-y-auto rounded-lg border" aria-label="Computers that wrote">
                        {convos.map((c) => (
                            <li key={c.deviceId}>
                                <button
                                    className={`flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left text-sm hover:bg-accent/40 ${open === c.deviceId ? "bg-accent/60" : ""}`}
                                    onClick={() => setOpen(c.deviceId)}
                                    data-testid="chat-convo"
                                >
                                    <span className="flex items-center gap-2">
                                        <span className={`h-2 w-2 shrink-0 rounded-full ${c.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`} title={c.online ? "Online" : "Offline"} />
                                        <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                                        {c.unread ? <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground" aria-label={`${c.unread} unread`}>{c.unread}</span> : null}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground">{c.customer ?? "No customer"}{c.site ? ` · ${c.site}` : ""}</span>
                                    <span className="truncate text-xs">{c.lastFrom === "support" ? "You: " : ""}{c.lastText}</span>
                                    <span className="text-xs text-muted-foreground">{ago(c.lastAt)}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    <section className="flex min-h-[20rem] flex-col rounded-lg border" aria-label="Conversation">
                        {!open ? (
                            <div className="m-auto p-6 text-sm text-muted-foreground">Choose a computer on the left.</div>
                        ) : !thread ? (
                            <div className="m-auto p-6"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /></div>
                        ) : (
                            <>
                                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5">
                                    <div>
                                        <span className="font-medium">{thread.device.name}</span>
                                        <span className="ml-2 text-xs text-muted-foreground">{thread.device.customer ?? "No customer"}{thread.device.site ? ` · ${thread.device.site}` : ""} · {thread.device.online ? "online" : "offline"}</span>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {thread.session && canReply ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void endChat()} data-testid="end-chat">End chat</Button> : null}
                                        <Link href={`/devices/${encodeURIComponent(thread.device.id)}`} className="text-xs text-primary hover:underline">Open the device</Link>
                                    </div>
                                </div>
                                <div className="border-b px-4 py-1.5 text-xs text-muted-foreground" data-testid="chat-session-state">
                                    {thread.session ? `Chat open since ${ago(thread.session.startedAt)}${thread.session.contactEmail ? `. The transcript will be emailed to ${thread.session.contactEmail} when it ends.` : ". There is no email address for this person, so the transcript is kept here only."}` : "No chat is open. One starts when the person writes, or when you send the first message."}
                                </div>
                                {thread.contact && (thread.contact.name || thread.contact.phone || thread.contact.email) ? (
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 border-b bg-muted/30 px-4 py-2 text-xs" data-testid="chat-contact">
                                        <span className="text-muted-foreground">At the computer:</span>
                                        {thread.contact.name ? <span className="font-medium">{thread.contact.name}</span> : null}
                                        {thread.contact.phone ? <a className="text-primary hover:underline" href={`tel:${thread.contact.phone.replace(/[^0-9+]/g, "")}`}>{thread.contact.phone}</a> : null}
                                        {thread.contact.email ? <a className="text-primary hover:underline" href={`mailto:${thread.contact.email}`}>{thread.contact.email}</a> : null}
                                        <span className="text-muted-foreground">signed in as {thread.contact.user}</span>
                                    </div>
                                ) : null}
                                <div className="flex max-h-[55vh] flex-1 flex-col gap-2 overflow-y-auto px-4 py-3" data-testid="chat-thread">
                                    {thread.messages.length === 0 ? <p className="m-auto text-sm text-muted-foreground">{thread.session ? "No messages yet." : "Nothing to show: the last chat has ended."}</p> : thread.messages.map((m) => (
                                        <div key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.from === "support" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted"}`}>
                                            <div className={`text-xs ${m.from === "support" ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{m.sender} · {ago(m.at)}{m.from === "support" ? (m.seen ? " · seen at the computer" : " · not seen yet") : ""}</div>
                                            <div className="whitespace-pre-wrap break-words">{m.text}</div>
                                        </div>
                                    ))}
                                    <div ref={end} />
                                </div>
                                {thread.sessions && thread.sessions.length ? (
                                    <details className="border-t px-4 py-2 text-sm" data-testid="past-chats">
                                        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Past chats ({thread.sessions.length})</summary>
                                        <ul className="mt-2 space-y-1">
                                            {thread.sessions.map((c) => (
                                                <li key={c.id} className="rounded-md border">
                                                    <button type="button" className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-accent/40" onClick={() => void showPast(c.id)} aria-expanded={past?.id === c.id}>
                                                        <span className="font-medium">{new Date(c.startedAt).toLocaleString()} to {new Date(c.endedAt).toLocaleTimeString()}{c.contactName ? ` · ${c.contactName}` : ""} · {c.messages} {c.messages === 1 ? "message" : "messages"}</span>
                                                        <span className="text-muted-foreground">Ended by {c.endedBy === "technician" && c.endedByName ? c.endedByName : ENDED_BY[c.endedBy ?? ""] ?? "unknown"}{emailText(c) ? ` · ${emailText(c)}` : ""}</span>
                                                    </button>
                                                    {past?.id === c.id ? (
                                                        <div className="border-t px-3 py-2">
                                                            {!past.data ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : (
                                                                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs" data-testid="chat-transcript">{past.data.transcript ?? past.data.messages.map((m) => `[${new Date(m.at).toLocaleString()}] ${m.sender}${m.from === "support" ? " (support)" : ""}: ${m.text}`).join("\n")}</pre>
                                                            )}
                                                        </div>
                                                    ) : null}
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                ) : null}
                                {!thread.trayOn ? <p className="border-t px-4 py-2 text-xs text-amber-700 dark:text-amber-400">The tray app is off, so a reply will not reach this computer. Turn it on under Administration &gt; Agents &amp; Endpoints.</p> : null}
                                {canReply ? (
                                    <form className="flex gap-2 border-t p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                                        <textarea
                                            aria-label="Your reply"
                                            rows={2}
                                            maxLength={2000}
                                            className="min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
                                            placeholder="Write a reply"
                                            value={text}
                                            onChange={(e) => setText(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                                        />
                                        <Button type="submit" disabled={busy || !text.trim()} className="gap-2 self-end">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}Send</Button>
                                    </form>
                                ) : <p className="border-t px-4 py-2 text-xs text-muted-foreground">You can read this chat but not answer it.</p>}
                            </>
                        )}
                    </section>
                </div>
            )}
        </PageShell>
    );
}

export default function DeviceChatPage() {
    return (
        <PermGate require="devices.read" title="Device chat" message="You need permission to view devices to read their chat.">
            <React.Suspense fallback={null}><ChatBody /></React.Suspense>
        </PermGate>
    );
}
