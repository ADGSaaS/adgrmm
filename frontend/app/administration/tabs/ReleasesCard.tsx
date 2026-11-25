"use client";

// Administration > Agents & endpoints > Releases: the staged rollout of agent updates.
// A new build is dropped on the server as a CANDIDATE; devices in the Pilot ring get it first; once the pilot looks healthy a person
// with the right promotes it to everyone, or withdraws it.
import * as React from "react";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    fetchReleases, GATE_STATUS, logText, OS_NAME, promoteRelease, ReleaseError, sizeText, withdrawRelease,
    type Gate, type ReleaseOs, type ReleaseStatus, type SlotView, type SystemRelease,
} from "@/lib/agent-releases-api";
import type { ToastFn } from "../types";
import { AdminNote, AdminSection } from "../tab-layout";

const TONE: Record<"ok" | "warn" | "bad" | "idle", string> = {
    ok: "border-emerald-500/40 bg-emerald-500/10",
    warn: "border-amber-500/40 bg-amber-500/10",
    bad: "border-red-500/40 bg-red-500/10",
    idle: "border-border bg-muted/40",
};

const dateText = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
};

function Slot({ title, slot, note }: { title: string; slot: SlotView; note?: string }) {
    return (
        <div className="min-w-0 rounded-lg bg-muted/40 p-3" data-testid={`slot-${title.toLowerCase()}`}>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
            {slot.state === "valid" ? (
                <>
                    <div className="text-base font-semibold">{slot.version}</div>
                    <div className="text-xs text-muted-foreground">{sizeText(slot.sizeBytes)}{slot.modifiedAt ? ` · ${dateText(slot.modifiedAt)}` : ""}</div>
                </>
            ) : slot.state === "problem" ? (
                <div className="text-xs text-red-700 dark:text-red-400">Not usable: {slot.problem}</div>
            ) : (
                <div className="text-sm text-muted-foreground">none</div>
            )}
            {note ? <div className="mt-1 text-xs text-muted-foreground">{note}</div> : null}
        </div>
    );
}

function Cell({ label, value, tone }: { label: string; value: number; tone?: "bad" | "warn" }) {
    return (
        <div className="min-w-0 rounded-lg bg-muted/40 p-3">
            <div className={`text-lg font-semibold leading-none ${value > 0 && tone === "bad" ? "text-red-700 dark:text-red-400" : value > 0 && tone === "warn" ? "text-amber-700 dark:text-amber-400" : ""}`}>{value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{label}</div>
        </div>
    );
}

function GateTable({ gate }: { gate: Gate }) {
    const st = GATE_STATUS[gate.status];
    return (
        <div className="grid gap-2" data-testid="gate">
            <AdminNote tone={st.tone === "idle" ? "info" : st.tone}>
                <span className="font-medium">{st.label}.</span> {gate.message}
            </AdminNote>
            {gate.candidateVersion ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Cell label="Pilot devices" value={gate.pilotTotal} />
                    <Cell label={`Run ${gate.candidateVersion}`} value={gate.onCandidate} />
                    <Cell label="Of those, online now (15 min)" value={gate.onCandidateOnline} />
                    <Cell label="Seen online after updating" value={gate.seenOnlineAfterUpdate} />
                    <Cell label="Not updated yet" value={gate.notYetUpdated} />
                    <Cell label="Quiet for 30+ min since updating" value={gate.offlineSinceUpdating} tone="bad" />
                    <Cell label="Last update job failed" value={gate.updateFailed} tone="warn" />
                </div>
            ) : null}
        </div>
    );
}

type Dialogs = { kind: "promote" | "withdraw"; os: ReleaseOs } | null;

export function ReleasesView({
    status, busy, error, onPromote, onWithdraw, onClearError,
}: {
    status: ReleaseStatus;
    busy: boolean;
    error: string | null;
    onPromote: (os: ReleaseOs, version: string, force?: { reason: string }) => Promise<void>;
    onWithdraw: (os: ReleaseOs, version: string) => Promise<void>;
    onClearError: () => void;
}) {
    const [dialog, setDialog] = React.useState<Dialogs>(null);
    const [anyway, setAnyway] = React.useState(false);
    const [reason, setReason] = React.useState("");
    const sys = dialog ? status.systems.find((s) => s.os === dialog.os) ?? null : null;
    const close = () => { setDialog(null); setAnyway(false); setReason(""); onClearError(); };

    const blockers = sys?.gate.blockers ?? [];
    const needForce = blockers.length > 0;
    const reasonOk = reason.trim().length >= 5 && reason.trim().length <= 300;
    const canConfirmPromote = !!sys && !busy && (!needForce || (anyway && reasonOk));

    const usable = (s: SystemRelease) => s.candidate.state === "valid" && !s.candidateNotNewer;

    return (
        <AdminSection
            data-testid="releases-card"
            title="Releases"
            icon={Rocket}
            description={<>
                Devices are in one of two rings: <strong>Pilot</strong> (your test devices) or <strong>Everyone</strong> (the default).
                A new agent build is put on the server as a <em>candidate</em> and only Pilot devices are offered it. When the pilot devices have updated and look healthy, someone with the right promotes it to everyone, or withdraws it.
                Set a device&apos;s ring on its page or in the device list, and a customer&apos;s default in the customer&apos;s settings.
            </>}
        >
            <p className="text-sm text-muted-foreground">
                Everyone now: {status.rings.stable} {status.rings.stable === 1 ? "device" : "devices"}. Pilot: {status.rings.pilot}.
            </p>

            {status.updatesDisabledByServer ? (
                <AdminNote tone="warn">Agent updates are switched off in the server&apos;s environment, so no device is offered anything, pilot or not.</AdminNote>
            ) : !status.autoUpdate ? (
                <AdminNote tone="warn">&ldquo;Offer new agent versions to devices automatically&rdquo; is off, so no device is offered anything, pilot or not.</AdminNote>
            ) : null}

            {!status.canManage ? (
                <p className="text-sm text-muted-foreground" data-testid="releases-readonly">You can see the releases but not change them. Promoting and withdrawing needs the right &ldquo;Manage agent update rings and releases&rdquo;.</p>
            ) : null}

            <div className="grid gap-4">
                {status.systems.map((s) => (
                    <div key={s.os} className="grid gap-3 border-t pt-5 first:border-t-0 first:pt-0" data-testid={`release-${s.os}`}>
                        <h4 className="text-sm font-semibold">{OS_NAME[s.os]}</h4>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <Slot title="Stable" slot={s.stable} note="What Everyone is offered." />
                            <Slot title="Candidate" slot={s.candidate} note={s.candidateNotNewer ? "Candidate is not newer than stable, so it is ignored." : s.candidate.state === "valid" ? "Offered to Pilot devices only." : undefined} />
                            <Slot title="Previous" slot={s.previous} note="For reference and an emergency manual rebuild only. Devices never go back to an older version." />
                        </div>
                        <GateTable gate={s.gate} />
                        {s.ringCounts.length ? (
                            <div className="text-sm text-muted-foreground" data-testid={`counts-${s.os}`}>
                                Devices by agent version:{" "}
                                {s.ringCounts.map((r, i) => (
                                    <span key={r.version}>{i ? "; " : ""}{r.version}: {r.stable} Everyone{r.pilot ? `, ${r.pilot} Pilot` : ""}</span>
                                ))}
                            </div>
                        ) : null}
                        {status.canManage ? (
                            <div className="flex flex-wrap gap-2">
                                <Button size="sm" disabled={!usable(s) || busy} onClick={() => setDialog({ kind: "promote", os: s.os })}>Promote candidate to everyone</Button>
                                <Button size="sm" variant="outline" disabled={s.candidate.state === "absent" || busy} onClick={() => setDialog({ kind: "withdraw", os: s.os })}>Withdraw candidate</Button>
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>

            {status.recent.length ? (
                <details className="text-sm">
                    <summary className="cursor-pointer font-medium">Recent activity</summary>
                    <ul className="mt-1 grid gap-1 text-muted-foreground">
                        {status.recent.map((e, i) => (
                            <li key={i}>{dateText(e.at)} · {e.actorEmail ?? "someone"} · {logText(e)}</li>
                        ))}
                    </ul>
                </details>
            ) : null}

            <Dialog open={!!dialog} onOpenChange={(o) => !o && close()}>
                <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
                    {dialog && sys ? (
                        dialog.kind === "promote" ? (
                            <>
                                <DialogHeader>
                                    <DialogTitle>Promote {OS_NAME[sys.os]} {sys.candidate.version} to everyone?</DialogTitle>
                                    <DialogDescription>
                                        Stable goes from <strong>{sys.stable.version ?? "nothing"}</strong> to <strong>{sys.candidate.version}</strong>. Every {OS_NAME[sys.os]} device will be offered it and update within hours.
                                        The current stable build is kept as &ldquo;previous&rdquo; for reference; there is no downgrade, devices never go back to an older version.
                                    </DialogDescription>
                                </DialogHeader>
                                <div className="grid gap-2 text-sm">
                                    <div className={`rounded-md border p-2 ${TONE[GATE_STATUS[sys.gate.status].tone]}`} role="status"><span className="font-medium">Pilot: {GATE_STATUS[sys.gate.status].label}.</span> {sys.gate.message}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {sys.gate.pilotTotal} pilot · {sys.gate.onCandidate} on the candidate · {sys.gate.seenOnlineAfterUpdate} seen online after updating · {sys.gate.offlineSinceUpdating} quiet since updating.
                                    </div>
                                    {needForce ? (
                                        <div className="grid gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2">
                                            <ul className="list-disc pl-5 text-sm">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                                            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} /> Promote anyway, I accept the risk</label>
                                            {anyway ? (
                                                <label className="grid gap-1 text-sm">Why? (recorded)
                                                    <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the pilot VM is switched off over the weekend" />
                                                </label>
                                            ) : null}
                                        </div>
                                    ) : null}
                                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                                </div>
                                <DialogFooter>
                                    <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
                                    <Button variant={needForce ? "destructive" : "default"} disabled={!canConfirmPromote}
                                        onClick={async () => { await onPromote(sys.os, sys.candidate.version!, needForce ? { reason: reason.trim() } : undefined); }}>
                                        {busy ? "Promoting…" : needForce ? "Promote anyway" : "Promote to everyone"}
                                    </Button>
                                </DialogFooter>
                            </>
                        ) : (
                            <>
                                <DialogHeader>
                                    <DialogTitle>Withdraw the {OS_NAME[sys.os]} candidate{sys.candidate.version ? ` ${sys.candidate.version}` : ""}?</DialogTitle>
                                    <DialogDescription>
                                        Nobody else will be offered this build. Devices that already updated to it ({sys.gate.onCandidate} pilot {sys.gate.onCandidate === 1 ? "device" : "devices"}) stay on it: there is no downgrade.
                                        Stable stays {sys.stable.version ?? "as it is"}.
                                    </DialogDescription>
                                </DialogHeader>
                                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                                <DialogFooter>
                                    <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
                                    <Button variant="destructive" disabled={busy} onClick={async () => { await onWithdraw(sys.os, sys.candidate.version ?? ""); }}>{busy ? "Withdrawing…" : "Withdraw candidate"}</Button>
                                </DialogFooter>
                            </>
                        )
                    ) : null}
                </DialogContent>
            </Dialog>
            <DialogCloser dialog={dialog} status={status} setDialog={setDialog} onReset={() => { setAnyway(false); setReason(""); }} />
        </AdminSection>
    );
}

/** Closes the dialog once its candidate is gone (promoted or withdrawn). */
function DialogCloser({ dialog, status, setDialog, onReset }: { dialog: Dialogs; status: ReleaseStatus; setDialog: (d: Dialogs) => void; onReset: () => void }) {
    React.useEffect(() => {
        if (!dialog) return;
        const s = status.systems.find((x) => x.os === dialog.os);
        if (!s || s.candidate.state === "absent") { setDialog(null); onReset(); }
    }, [dialog, status, setDialog, onReset]);
    return null;
}

export default function ReleasesCard({ push }: { push: ToastFn }) {
    const [status, setStatus] = React.useState<ReleaseStatus | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try { setStatus(await fetchReleases()); }
        catch (e) { push({ title: "Could not load the releases", desc: e instanceof Error ? e.message : undefined, kind: "destructive" }); }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    const run = async (fn: () => Promise<{ status: ReleaseStatus }>, ok: string) => {
        setBusy(true);
        setError(null);
        try {
            const r = await fn();
            setStatus(r.status);
            push({ title: ok, kind: "success" });
        } catch (e) {
            setError(e instanceof ReleaseError ? e.message : e instanceof Error ? e.message : "Something went wrong.");
            // "changed since you looked" and similar: show what is true now.
            if (e instanceof ReleaseError && e.status === 409) void load();
        } finally {
            setBusy(false);
        }
    };

    if (!status) return <div className="text-sm text-muted-foreground">Loading releases…</div>;
    return (
        <ReleasesView
            status={status}
            busy={busy}
            error={error}
            onClearError={() => setError(null)}
            onPromote={(os, version, force) => run(() => promoteRelease(os, version, force), `${OS_NAME[os]} ${version} promoted to everyone`)}
            onWithdraw={(os, version) => run(() => withdrawRelease(os, version), `${OS_NAME[os]} candidate withdrawn`)}
        />
    );
}
