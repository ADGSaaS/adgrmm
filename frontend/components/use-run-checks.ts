"use client";

// "Run now" for a device's checks. The server queues a signed task; the agent picks it up within about ten seconds, runs
// the checks and sends the results the way it always does. So after asking, the page looks again a few times.
import * as React from "react";
import { jfetch } from "@/lib/api";
import { toast } from "@/components/ui/use-toast";
import { errorText } from "@/components/policies/shared";

/** When to look for the new results after asking, in seconds. */
const LOOK_AGAIN_AT = [6, 14, 30];

export function useRunChecks(deviceId: string | undefined, onResults?: () => void) {
    const [busy, setBusy] = React.useState<string | null>(null);
    const timers = React.useRef<number[]>([]);
    React.useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

    /** `keys` names the checks; leave it out to run every check on the device. `label` is only for the message. */
    const run = React.useCallback(
        async (keys?: string[], label?: string) => {
            if (!deviceId) return;
            const id = (keys ?? []).join(",") || "all";
            setBusy(id);
            try {
                await jfetch(`/api/devices/${encodeURIComponent(deviceId)}/checks/run`, { method: "POST", body: { keys: keys ?? [] } });
                toast({
                    title: label ? `Running ${label}` : "Running all checks",
                    description: "The device picks this up within about ten seconds. Results appear here as soon as they arrive.",
                    variant: "success",
                });
                timers.current.forEach((t) => window.clearTimeout(t));
                timers.current = LOOK_AGAIN_AT.map((s) => window.setTimeout(() => onResults?.(), s * 1000));
            } catch (e) {
                toast({ title: "Could not run that now", description: errorText(e), variant: "destructive", duration: 10_000 });
            } finally {
                // Short pause so a second press is not an accident.
                window.setTimeout(() => setBusy(null), 1500);
            }
        },
        [deviceId, onResults],
    );

    return { run, busy };
}
