"use client";

// Device secrets on a Windows device's Security tab: BitLocker recovery keys and the local administrator password (LAPS style).
// Everything is off until a policy turns it on (Policies > Device secrets). Secrets are stored encrypted on this server and shown
// only to people with the right to view device secrets; this card is not drawn at all for anyone else. The card never holds a secret:
// revealing is done in RevealSecretDialog, which keeps it for a minute and then throws it away.
import * as React from "react";
import Link from "next/link";
import { Eye, KeyRound, Loader2, Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorText, Pill } from "@/components/policies/shared";
import RevealSecretDialog from "@/components/security/reveal-secret-dialog";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { ACTION_TEXT, STATUS_TEXT, vault, type SecretItem, type SecretsView } from "@/lib/vault-api";

const POLL_MS = 3000;
const POLL_TRIES = 40; // about two minutes

/** "in 3 hours", "in 21 days" for a time that has not come yet; ago() only knows the past. */
function inText(iso: string, now = Date.now()): string {
    const m = Math.round((Date.parse(iso) - now) / 60_000);
    if (m < 1) return "now";
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `in ${h} ${h === 1 ? "hour" : "hours"}`;
    const d = Math.round(h / 24);
    return `in ${d} ${d === 1 ? "day" : "days"}`;
}
const when = (iso: string | null | undefined) => (iso ? `${new Date(iso).toLocaleString()} (${Date.parse(iso) > Date.now() ? inText(iso) : ago(iso)})` : "never");
const from = (source: string | null) => (source ? `set by ${source}` : "the default");

function StatusPill({ status }: { status: SecretItem["status"] }) {
    return <Pill tone={status === "current" ? "good" : status === "unconfirmed" ? "warn" : "muted"}>{STATUS_TEXT[status]}</Pill>;
}

function SecretRow({ item, canReveal, onReveal }: { item: SecretItem; canReveal: boolean; onReveal: () => void }) {
    return (
        <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t px-3 py-2.5 first:border-t-0" data-testid="secret-row" data-status={item.status}>
            <div className="min-w-0 space-y-0.5">
                <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{item.label}</span>
                    <span className="select-none font-mono text-muted-foreground" aria-label="Hidden">•••• •••• ••••</span>
                    <StatusPill status={item.status} />
                </p>
                <p className="text-xs text-muted-foreground">
                    {item.kind !== "local_admin" ? "Key id ending " : "Version ending "}<span className="font-mono">{item.refTail}</span>. Stored {when(item.createdAt)}.
                    {item.rotatedAt ? ` Changed ${when(item.rotatedAt)}.` : ""}
                </p>
                <p className="text-xs text-muted-foreground">{item.lastRevealedAt ? `Last revealed ${when(item.lastRevealedAt)}${item.lastRevealedBy ? ` by ${item.lastRevealedBy}` : ""}.` : "Never revealed."}</p>
                {item.warning ? <p className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs" data-testid="secret-warning">{item.warning}</p> : null}
            </div>
            {canReveal ? <Button size="sm" variant="outline" className="gap-2" onClick={onReveal} aria-label={`Reveal ${item.label}`}><Eye className="h-4 w-4" aria-hidden="true" />Reveal</Button> : null}
        </li>
    );
}

function Block({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
    return (
        <section className="space-y-2 rounded-lg border p-3" aria-label={title}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">{title}</h4>
                {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
            <div className="space-y-2 text-sm">{children}</div>
        </section>
    );
}

type Queue = "escrow" | "rotate";

export default function SecretsCard({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
    const { permissions } = useMe();
    const wantReveal = hasPerm(permissions, ["devices.read", "devices.secrets.reveal"]);
    const wantManage = hasPerm(permissions, ["devices.read", "devices.secrets.manage"]);
    const allowed = wantReveal || wantManage;
    const [data, setData] = React.useState<SecretsView | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [note, setNote] = React.useState<string | null>(null);
    const [confirm, setConfirm] = React.useState<Queue | null>(null);
    const [confirmError, setConfirmError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [reveal, setReveal] = React.useState<SecretItem | null>(null);
    const [gaveUp, setGaveUp] = React.useState(false);
    const alive = React.useRef(true);

    const load = React.useCallback(async () => {
        try {
            const d = await vault.device(deviceId);
            if (alive.current) { setData(d); setError(null); }
            return d;
        } catch (e) {
            if (alive.current) setError(errorText(e));
            return null;
        }
    }, [deviceId]);

    React.useEffect(() => {
        alive.current = true;
        if (allowed) void load();
        return () => { alive.current = false; };
    }, [load, allowed]);

    // after a request is queued, look again every few seconds until the device has answered (about two minutes at most)
    const waiting = !!data && (data.escrow.pending || data.laps.pending);
    React.useEffect(() => {
        if (!waiting) return;
        setGaveUp(false);
        let tries = 0;
        const t = setInterval(async () => {
            tries++;
            const d = await load();
            if (!d || (!d.escrow.pending && !d.laps.pending)) clearInterval(t);
            else if (tries >= POLL_TRIES) { clearInterval(t); if (alive.current) setGaveUp(true); }
        }, POLL_MS);
        return () => clearInterval(t);
    }, [waiting, load]);

    if (!allowed) return null;
    if (data && !data.windows && !data.linux) return null;
    if (!data) {
        return error
            ? <p role="alert" className="text-sm text-destructive">Device secrets: {error}</p>
            : <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading device secrets…</div>;
    }

    const canReveal = data.canReveal && wantReveal;
    const canManage = data.canManage && wantManage;
    const keys = data.items.filter((i) => i.kind === "bitlocker_recovery" || i.kind === "luks_recovery");
    const diskName = data.linux ? "disk recovery keys (LUKS)" : "BitLocker recovery keys";
    const admins = data.items.filter((i) => i.kind === "local_admin");
    const { escrow, laps } = data;

    const blockWhy = (enabled: boolean, pending: boolean, what: string): string =>
        !data.hasAgent ? "This device has no agent." : !data.online ? "The device is offline." : !enabled ? `${what} is off by a policy for this device.` : pending ? "A request is already waiting for the device." : "";
    const escrowWhy = blockWhy(escrow.enabled, escrow.pending, "Key escrow");
    const rotateWhy = blockWhy(laps.enabled, laps.pending, "Managing the administrator password");

    const queue = async (what: Queue) => {
        setBusy(true);
        setConfirmError(null);
        try {
            const r = await (what === "escrow" ? vault.escrow(deviceId) : vault.rotate(deviceId));
            setNote(r.alreadyWaiting
                ? `A ${what === "escrow" ? "key escrow" : "password rotation"} is already waiting for ${deviceName}.`
                : what === "escrow" ? (data.linux ? `Asked ${deviceName} to add a recovery key to its encrypted disks. The keys appear here in a moment.` : `Asked ${deviceName} to send its BitLocker recovery keys. They appear here in a moment.`) : `Asked ${deviceName} to change its local administrator password. The new one appears here in a moment.`);
            setConfirm(null);
            await load();
        } catch (e) {
            setConfirmError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    const lapsState = laps.enabled
        ? `Managed: ADG RMM keeps the password of the account ${laps.account} (${laps.passwordLength} characters) and changes it every ${laps.rotateDays} ${laps.rotateDays === 1 ? "day" : "days"}${laps.rotateAfterRevealMinutes > 0 ? `, and ${laps.rotateAfterRevealMinutes} minutes after someone reveals it` : ", but not after a reveal"}. Controlled by ${from(laps.source)}.`
        : `Off: ${from(laps.source)} does not manage the administrator password, so nothing is rotated.`;

    return (
        <section className="space-y-3 rounded-lg border bg-card p-4" aria-label="Device secrets" data-testid="secrets-card">
            <div className="space-y-1">
                <h3 className="flex items-center gap-2 text-base font-semibold"><KeyRound className="h-4 w-4" aria-hidden="true" />Device secrets</h3>
                <p className="text-xs text-muted-foreground">
                    <Lock className="mr-1 inline h-3 w-3" aria-hidden="true" />
                    {data.linux ? "Disk recovery keys (LUKS)" : "BitLocker recovery keys"} and the local administrator password are stored encrypted on this server. Only people with the right to view device secrets can reveal them, every reveal asks for a reason, and each one is written to the secret access log. Both are off until a policy turns them on: <Link href="/policies" className="underline underline-offset-2">Policies, Device secrets</Link>.
                </p>
            </div>

            {note ? <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{note}</p> : null}
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {gaveUp ? <p role="status" className="text-xs text-muted-foreground">The device has not answered yet. It will be picked up when it does; reload this tab later to see the result.</p> : null}

            <div className="grid gap-3 lg:grid-cols-2">
                <Block
                    title={data.linux ? "Disk recovery keys (LUKS)" : "BitLocker recovery keys"}
                    actions={canManage ? (
                        <Button size="sm" variant="outline" className="gap-2" disabled={!!escrowWhy || busy} title={escrowWhy || undefined} onClick={() => { setConfirmError(null); setConfirm("escrow"); }}>
                            {escrow.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}Escrow keys now
                        </Button>
                    ) : null}
                >
                    <p className="text-xs text-muted-foreground" data-testid="escrow-state">
                        {escrow.enabled ? `Escrow is on (${from(escrow.source)}): the device sends its recovery keys here.` : `Escrow is off (${from(escrow.source)}): recovery keys are not collected from this device.`}{" "}
                        {escrow.lastOkAt ? `Last escrowed ${when(escrow.lastOkAt)}.` : "Never escrowed."}
                        {escrow.pending ? <span className="ml-1 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Waiting for the device to answer…</span> : null}
                    </p>
                    {escrow.message && !escrow.pending ? <p className="text-xs text-destructive">The last attempt did not work{escrow.lastAttemptAt ? ` (${ago(escrow.lastAttemptAt)})` : ""}: {escrow.message}</p> : null}
                    {canManage && escrowWhy ? <p className="text-xs text-muted-foreground">{escrowWhy}</p> : null}
                    {keys.length ? (
                        <ul className="m-0 list-none rounded-md border p-0" data-testid="key-list">{keys.map((i) => <SecretRow key={i.id} item={i} canReveal={canReveal} onReveal={() => setReveal(i)} />)}</ul>
                    ) : (
                        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground" data-testid="no-keys">No recovery keys are stored for this device yet.{escrow.enabled ? " Use Escrow keys now to collect them." : " Turn on key escrow in a policy to collect them."}</p>
                    )}
                </Block>

                <Block
                    title="Local administrator password"
                    actions={canManage ? (
                        <Button size="sm" variant="outline" className="gap-2" disabled={!!rotateWhy || busy} title={rotateWhy || undefined} onClick={() => { setConfirmError(null); setConfirm("rotate"); }}>
                            {laps.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}Rotate now
                        </Button>
                    ) : null}
                >
                    <p className="text-xs text-muted-foreground" data-testid="laps-state">{lapsState}</p>
                    {!laps.enabled && laps.mayStillBeValid ? <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs font-medium" role="note" data-testid="may-be-valid">This password may still be valid on the device. Turning management off keeps the stored password and stops rotating it; it does not remove the account.</p> : null}
                    <dl className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
                        <dt className="text-muted-foreground">Account</dt><dd className="font-mono">{laps.account}</dd>
                        <dt className="text-muted-foreground">Last changed</dt><dd>{when(laps.lastOkAt)}</dd>
                        <dt className="text-muted-foreground">Next rotation due</dt><dd>{laps.enabled ? (laps.nextRotationAt ? when(laps.nextRotationAt) : "not scheduled yet") : "not scheduled (management is off)"}</dd>
                        <dt className="text-muted-foreground">Rotation after a reveal due</dt><dd>{laps.rotateDueAt ? when(laps.rotateDueAt) : !laps.enabled ? "not scheduled (management is off)" : laps.rotateAfterRevealMinutes > 0 ? "nothing revealed since the last change" : "never (switched off in the policy)"}</dd>
                    </dl>
                    {laps.pending ? <p className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Waiting for the device to answer…</p> : null}
                    {laps.attempt && laps.attempt !== "ok" && !laps.pending ? (
                        <p className="text-xs text-destructive" role="alert">
                            {laps.attempt === "failed" ? "The last rotation failed" : laps.attempt === "unconfirmed" ? "The last rotation could not be confirmed" : "The device did not answer the last rotation"}
                            {laps.lastAttemptAt ? ` (${ago(laps.lastAttemptAt)})` : ""}{laps.message ? `: ${laps.message}` : "."}
                        </p>
                    ) : null}
                    {canManage && rotateWhy ? <p className="text-xs text-muted-foreground">{rotateWhy}</p> : null}
                    {admins.length ? (
                        <ul className="m-0 list-none rounded-md border p-0" data-testid="admin-list">{admins.map((i) => <SecretRow key={i.id} item={i} canReveal={canReveal} onReveal={() => setReveal(i)} />)}</ul>
                    ) : (
                        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground" data-testid="no-admin">No administrator password is stored for this device yet.{laps.enabled ? " Use Rotate now to create the account and its first password." : " Turn on password management in a policy to create one."}</p>
                    )}
                </Block>
            </div>

            <div className="space-y-1">
                <h4 className="text-sm font-semibold">Recent access</h4>
                {data.recentAccess.length ? (
                    <ul className="m-0 list-none divide-y rounded-md border p-0 text-xs" data-testid="recent-access">
                        {data.recentAccess.slice(0, 5).map((a) => (
                            <li key={a.id} className="grid gap-x-3 px-3 py-1.5 sm:grid-cols-[11rem_1fr]">
                                <span className="text-muted-foreground">{new Date(a.at).toLocaleString()}</span>
                                <span className="min-w-0 break-words"><strong>{a.userName ?? "The system"}</strong>: {ACTION_TEXT[a.action] ?? a.action}{a.label ? ` (${a.label})` : ""}{a.outcome && a.outcome !== "ok" ? `, ${a.outcome}` : ""}{a.reason ? `. Reason: ${a.reason}` : ""}</span>
                            </li>
                        ))}
                    </ul>
                ) : <p className="text-xs text-muted-foreground">Nothing has been revealed, escrowed or rotated on this device yet.</p>}
                {wantReveal ? <p className="text-xs text-muted-foreground">Everything, for all devices, is on the Security page under Secret access log.</p> : null}
            </div>

            {reveal ? <RevealSecretDialog key={reveal.id} deviceId={deviceId} deviceName={deviceName} item={reveal} onClose={() => setReveal(null)} onRevealed={() => void load()} /> : null}

            <Dialog open={!!confirm} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
                <DialogContent>
                    {confirm ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{confirm === "escrow" ? (data.linux ? "Add and store disk recovery keys now?" : "Escrow BitLocker recovery keys now?") : "Rotate the local administrator password now?"}</DialogTitle>
                                <DialogDescription>
                                    {confirm === "escrow" && data.linux
                                        ? `Asks ${deviceName} to add one new recovery key slot to each encrypted (LUKS2) disk that has none stored here yet, and to send the new key to this server, where it is stored encrypted. LUKS never keeps a key that can be read back, so this is the only way to hold one without the passphrase, and it works only for disks that unlock with the machine's TPM or with a key file listed in /etc/crypttab. Nothing is removed and the existing passphrase and keys are not touched.`
                                        : confirm === "escrow"
                                        ? `Asks ${deviceName} to send the recovery keys of its BitLocker volumes to this server, where they are stored encrypted. Nothing on the device is changed. Only people with the right to view device secrets can see them.`
                                        : `Asks ${deviceName} to generate a new password for the account ${laps.account}, set it, and send it to this server, where it is stored encrypted. The old password stops working on the device. ADG RMM only manages its own account and never touches the built-in Administrator. The password is made on the device.`}
                                    {" "}This is recorded in the audit log.
                                </DialogDescription>
                            </DialogHeader>
                            {confirmError ? <p role="alert" className="text-sm text-destructive">{confirmError}</p> : null}
                            <DialogFooter>
                                <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
                                <Button onClick={() => void queue(confirm)} disabled={busy} className="gap-2">
                                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy ? "Working…" : confirm === "escrow" ? "Escrow keys" : "Rotate password"}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </section>
    );
}
