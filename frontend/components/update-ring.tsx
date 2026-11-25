"use client";

// The update ring controls: the "Pilot" badge, the control on a device's page, and the customer's default.
// Everyone sees the ring; only people with the right to manage agent releases (and to change devices, or customers) can change it.
import * as React from "react";
import { fetchCustomerRing, RING_LABEL, setCustomerRing, setDeviceRing, type Ring } from "@/lib/agent-releases-api";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";
import { errorText } from "@/components/policies/shared";
import { Button } from "@/components/ui/button";

const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm sm:w-auto";

export function UpdateRingBadge({ ring, className }: { ring?: Ring | null; className?: string }) {
    if (ring !== "pilot") return null;
    return (
        <span
            title="Pilot ring: this device gets new agent builds first, as a test"
            className={`inline-flex items-center rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300 ${className ?? ""}`}
        >
            Pilot
        </span>
    );
}

/** On a device's page. `own` is the ring set on the device; null means it follows its customer. */
export function DeviceUpdateRing({ deviceId, ring, own, onChanged }: { deviceId: string; ring: Ring; own: Ring | null; onChanged?: () => void }) {
    const { permissions } = useMe();
    const canChange = hasPerm(permissions, ["agents.release.manage", "devices.write"]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const value = own ?? "inherit";

    if (!canChange) {
        return (
            <span className="inline-flex flex-wrap items-center justify-end gap-2" data-testid="ring-readonly">
                {RING_LABEL[ring]}{own ? "" : " (follows the customer)"}
            </span>
        );
    }

    const change = async (v: string) => {
        setBusy(true);
        setError(null);
        try {
            await setDeviceRing(deviceId, v === "inherit" ? null : (v as Ring));
            onChanged?.();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className="flex min-w-0 flex-col items-stretch gap-1 sm:items-end">
            <select aria-label="Update ring" className={selectClass} value={value} disabled={busy} onChange={(e) => void change(e.target.value)}>
                <option value="inherit">Follow the customer ({RING_LABEL[ring]} now)</option>
                <option value="pilot">Pilot (test group)</option>
                <option value="stable">Everyone</option>
            </select>
            {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
        </span>
    );
}

/** In a customer's settings: the ring its devices follow when they have none of their own. */
export function CustomerUpdateRing({ clientId, disabled }: { clientId: string; disabled?: boolean }) {
    const { permissions } = useMe();
    const canChange = hasPerm(permissions, ["agents.release.manage", "customers.write"]);
    const [state, setState] = React.useState<{ ring: Ring; following: number } | null>(null);
    const [pick, setPick] = React.useState<Ring>("stable");
    const [busy, setBusy] = React.useState(false);
    const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

    React.useEffect(() => {
        if (!clientId) return;
        let cancelled = false;
        setState(null);
        setMsg(null);
        fetchCustomerRing(clientId)
            .then((r) => { if (!cancelled) { setState({ ring: r.defaultUpdateRing, following: r.devicesFollowingTheDefault }); setPick(r.defaultUpdateRing); } })
            .catch((e) => { if (!cancelled) setMsg({ ok: false, text: errorText(e) }); });
        return () => { cancelled = true; };
    }, [clientId]);

    const save = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await setCustomerRing(clientId, pick);
            setState({ ring: r.defaultUpdateRing, following: r.devicesFollowingTheDefault });
            setMsg({ ok: true, text: `Saved. ${r.devicesFollowingTheDefault} ${r.devicesFollowingTheDefault === 1 ? "device follows" : "devices follow"} this default.` });
        } catch (e) {
            setMsg({ ok: false, text: errorText(e) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="grid gap-2 rounded-md border p-3" data-testid="customer-ring">
            <label htmlFor="customer-ring" className="text-sm font-medium">Agent update ring for this customer&apos;s new devices</label>
            {canChange ? (
                <div className="flex flex-wrap items-center gap-2">
                    <select id="customer-ring" className={selectClass} value={pick} disabled={!clientId || !state || busy || disabled} onChange={(e) => setPick(e.target.value as Ring)}>
                        <option value="stable">Everyone (the default)</option>
                        <option value="pilot">Pilot (test group)</option>
                    </select>
                    <Button type="button" size="sm" variant="outline" disabled={!state || busy || pick === state.ring} onClick={() => void save()}>{busy ? "Saving…" : "Save ring"}</Button>
                </div>
            ) : (
                <p className="text-sm" data-testid="customer-ring-readonly">{state ? RING_LABEL[state.ring] : "…"}</p>
            )}
            <p className="text-xs text-muted-foreground">
                Devices of this customer that have no ring of their own follow this one{state ? ` (${state.following} now)` : ""}; a ring set on a device always wins.
                Pilot devices get a new agent build first; Everyone gets it only after it is promoted.
                {!canChange ? " Changing it needs the right to manage agent update rings." : ""}
            </p>
            {msg ? <p role={msg.ok ? "status" : "alert"} className={`text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>{msg.text}</p> : null}
        </div>
    );
}
