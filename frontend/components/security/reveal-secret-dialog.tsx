"use client";

// Reveal one stored secret (a BitLocker recovery key or the local administrator password). Two steps: the person says why (the reason
// is kept in the access log), then the secret is shown for 60 seconds.
//
// How the secret is handled: it lives in ONE state variable of this component (`shown`). Nothing else holds it: not storage, not the
// URL, not a cache, not a log. The variable is set to null when the countdown ends, when the dialog is closed, when the browser tab
// is hidden and when the component unmounts. The text is selectable only inside the revealed box; the rest of the dialog is not.
import * as React from "react";
import { Clipboard, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { KIND_TEXT, reasonProblem, vault, VaultError, type SecretItem } from "@/lib/vault-api";

type Shown = { secret: string; deadline: number; warning: string | null; rotateAt: string | null };
type Hidden = "timeout" | "tab" | null;

function waitText(sec: number | null): string {
    if (!sec) return "a little while";
    if (sec < 90) return `${sec} seconds`;
    return `${Math.ceil(sec / 60)} minutes`;
}

function revealError(e: unknown): string {
    if (e instanceof VaultError) {
        if (e.status === 429) return `You have revealed secrets too often. Try again in ${waitText(e.retryAfterSec)}.`;
        if (e.status === 404 || e.status === 410) return "This secret is no longer stored. It may have been replaced or removed. Close this window and reload the device's Security tab.";
        if (e.status === 403) return "You do not have the right to view device secrets.";
        return e.message;
    }
    return "Something went wrong. Nothing was revealed.";
}

export default function RevealSecretDialog({ deviceId, deviceName, item, onClose, onRevealed }: { deviceId: string; deviceName: string; item: SecretItem; onClose: () => void; onRevealed: () => void }) {
    const [reason, setReason] = React.useState("");
    const [touched, setTouched] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [shown, setShown] = React.useState<Shown | null>(null);
    const [hidden, setHidden] = React.useState<Hidden>(null);
    const [left, setLeft] = React.useState(0);
    const [copyNote, setCopyNote] = React.useState<string | null>(null);
    const alive = React.useRef(true);
    const boxRef = React.useRef<HTMLDivElement | null>(null);

    const clear = React.useCallback((why: Hidden) => {
        setShown(null);
        setCopyNote(null);
        setHidden(why);
    }, []);

    React.useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            setShown(null); // the secret never outlives the dialog
        };
    }, []);

    // countdown from a deadline (so a throttled background timer cannot make the secret live longer); hide at zero
    const deadline = shown?.deadline ?? null;
    React.useEffect(() => {
        if (deadline === null) return;
        const tick = () => {
            const s = Math.ceil((deadline - Date.now()) / 1000);
            if (s <= 0) clear("timeout");
            else setLeft(s);
        };
        tick();
        const t = setInterval(tick, 500);
        return () => clearInterval(t);
    }, [deadline, clear]);

    // hide when the tab is no longer in front
    const visible = shown !== null;
    React.useEffect(() => {
        if (!visible) return;
        const onVis = () => { if (document.visibilityState === "hidden") clear("tab"); };
        document.addEventListener("visibilitychange", onVis);
        return () => document.removeEventListener("visibilitychange", onVis);
    }, [visible, clear]);

    React.useEffect(() => {
        if (visible) boxRef.current?.focus();
    }, [visible]);

    const problem = reasonProblem(reason);
    const submit = async () => {
        setTouched(true);
        if (problem || busy) return;
        setBusy(true);
        setError(null);
        try {
            const r = await vault.reveal(deviceId, item.id, reason.trim());
            if (!alive.current) return;
            setHidden(null);
            setShown({ secret: r.secret, deadline: Date.now() + Math.max(1, r.hideAfterSec) * 1000, warning: r.warning, rotateAt: r.rotateAt });
            onRevealed();
        } catch (e) {
            if (alive.current) setError(revealError(e));
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const copy = async () => {
        if (!shown) return;
        try {
            if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
            await navigator.clipboard.writeText(shown.secret);
            setCopyNote("Copied. It stays on your clipboard until you copy something else.");
        } catch {
            setCopyNote("This browser would not let the page copy it. Select the text in the box and copy it yourself.");
        }
    };

    const close = () => {
        setShown(null);
        onClose();
    };

    const what = KIND_TEXT[item.kind];
    const mark = left === 30 || left === 10 ? `Hides in ${left} seconds` : null;

    return (
        <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
            <DialogContent className="max-w-lg select-none" data-testid="reveal-dialog" aria-describedby="reveal-desc">
                <DialogHeader>
                    <DialogTitle>{shown ? `${what}: ${item.label}` : `Reveal the ${what.toLowerCase()} (${item.label})`}</DialogTitle>
                    <DialogDescription id="reveal-desc">
                        {shown
                            ? `From ${deviceName}. It is hidden again after a minute, and when you close this window or leave this browser tab.`
                            : `On ${deviceName}. Say why you need it. Your name, the time and your reason are written to the secret access log, which administrators can read.`}
                    </DialogDescription>
                </DialogHeader>

                {shown ? (
                    <div className="space-y-3" data-testid="reveal-step-shown">
                        <div
                            ref={boxRef}
                            tabIndex={-1}
                            role="group"
                            aria-label={`Revealed ${what.toLowerCase()} for ${item.label}`}
                            className="select-text break-all rounded-md border-2 border-amber-500/60 bg-amber-500/10 px-3 py-3 font-mono text-base tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                            data-testid="secret-box"
                        >
                            {shown.secret}
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm tabular-nums" aria-hidden="true" data-testid="countdown">Hides in <strong>{left}</strong> {left === 1 ? "second" : "seconds"}</p>
                            <Button type="button" size="sm" variant="outline" className="gap-2" onClick={() => void copy()}><Clipboard className="h-4 w-4" aria-hidden="true" />Copy</Button>
                        </div>
                        <p className="sr-only" role="status" aria-live="polite">{mark ?? ""}</p>
                        {copyNote ? <p role="status" className="text-xs text-muted-foreground">{copyNote}</p> : null}
                        {shown.warning ? <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{shown.warning}</p> : null}
                        {shown.rotateAt ? <p className="text-xs text-muted-foreground">Because it was revealed, this password is due to be changed automatically around {new Date(shown.rotateAt).toLocaleString()}.</p> : null}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {hidden ? (
                            <p role="status" className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="reveal-hidden">
                                <EyeOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                                {hidden === "timeout" ? "Hidden again after a minute. Reveal it again if you still need it (this is logged again)." : "Hidden because you left this browser tab. Reveal it again if you still need it (this is logged again)."}
                            </p>
                        ) : null}
                        <div className="grid gap-1">
                            <label htmlFor="reveal-reason" className="text-sm font-medium">Reason</label>
                            <Textarea
                                id="reveal-reason"
                                rows={3}
                                maxLength={300}
                                autoComplete="off"
                                autoCapitalize="off"
                                spellCheck={false}
                                className="select-text"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                onBlur={() => setTouched(true)}
                                placeholder="For example: ticket 4821, laptop will not boot, customer asked for recovery"
                                aria-invalid={touched && problem ? true : undefined}
                                aria-describedby="reveal-reason-help"
                                disabled={busy}
                            />
                            <div id="reveal-reason-help" className="flex justify-between gap-3 text-xs">
                                <span className={touched && problem ? "text-destructive" : "text-muted-foreground"} role={touched && problem ? "alert" : undefined}>{touched && problem ? problem : "5 to 300 characters."}</span>
                                <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="reason-count">{reason.trim().length} / 300</span>
                            </div>
                        </div>
                        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                    </div>
                )}

                <DialogFooter>
                    {shown ? (
                        <Button type="button" onClick={close} className="gap-2"><EyeOff className="h-4 w-4" aria-hidden="true" />Hide and close</Button>
                    ) : (
                        <>
                            <Button type="button" variant="outline" onClick={close} disabled={busy}>Cancel</Button>
                            <Button type="button" onClick={() => void submit()} disabled={busy || (touched && !!problem)} className="gap-2">
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}{busy ? "Revealing…" : "Reveal"}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
