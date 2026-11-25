// lib/agent-update-tracker.ts
"use client";

import { dismiss, toast } from "@/components/ui/use-toast";
import { fetchAgentUpdateStatus } from "@/lib/api";

const POLL_MS = 4000;

// Long enough for a download, the swap, a restart, and the rollback window if the new version fails.
const GIVE_UP_MS = 8 * 60_000;
const OUTCOME_TOAST_MS = 12_000;
const STORAGE_KEY = "remoteiq.agentUpdates";

/** Tells open device lists to reload, so they show the new version. */
export const AGENT_UPDATED_EVENT = "remoteiq:agent-updated";

type TrackedUpdate = {
    deviceId: string;
    jobId: string;
    name: string;
    targetVersion: string;
    startedAt: number;
};

const running = new Set<string>();

function toastId(deviceId: string) {
    return `agent-update-${deviceId}`;
}

// Showing a new toast under an id in use would leave two on screen, so the old one goes first.
function show(deviceId: string, options: Parameters<typeof toast>[0]) {
    dismiss(toastId(deviceId));
    toast({ ...options, id: toastId(deviceId) });
}

function readSaved(): TrackedUpdate[] {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeSaved(updates: TrackedUpdate[]) {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updates));
    } catch {
        // Only reloading the page loses tracking without this.
    }
}

// Agents can report a build suffix after the version.
const plainVersion = (version: string | null | undefined) => String(version ?? "").split("+")[0].trim();

function finish(update: TrackedUpdate) {
    running.delete(update.deviceId);
    writeSaved(readSaved().filter((u) => u.deviceId !== update.deviceId));
}

async function poll(update: TrackedUpdate) {
    if (Date.now() - update.startedAt > GIVE_UP_MS) {
        finish(update);
        show(update.deviceId, {
            title: `${update.name} has not finished updating`,
            description: `It has not reported version ${update.targetVersion} yet. It may still be updating, or it may have gone back to its previous version.`,
            variant: "warning",
            duration: Infinity,
        });
        return;
    }

    try {
        const status = await fetchAgentUpdateStatus(update.deviceId, update.jobId);

        if (plainVersion(status.version) === plainVersion(update.targetVersion)) {
            finish(update);
            show(update.deviceId, {
                title: `${update.name} updated`,
                description: `Now running version ${plainVersion(status.version)}.`,
                variant: "success",
                duration: OUTCOME_TOAST_MS,
            });
            window.dispatchEvent(new CustomEvent(AGENT_UPDATED_EVENT));
            return;
        }

        if (status.failure) {
            finish(update);
            const how = status.failure.outcome === "rollback_failed" ? "It could not go back to the old version either, so it needs a person to look at it." : status.failure.outcome === "rolled_back" ? "It went back to the previous version." : "Nothing was changed.";
            show(update.deviceId, {
                title: `${update.name} could not update to ${status.failure.version}`,
                description: `${status.failure.detail || "The agent did not say why."} ${how}`.trim(),
                variant: "destructive",
                duration: Infinity,
            });
            return;
        }

        if (status.job === "failed" || status.job === "timeout") {
            finish(update);
            show(update.deviceId, {
                title: `Could not update ${update.name}`,
                description: status.error || "The agent did not accept the update request.",
                variant: "destructive",
                duration: Infinity,
            });
            return;
        }
    } catch (e: any) {
        // The device restarting is expected and does not reach here, so this is about the request itself.
        if (e?.status === 401 || e?.status === 403 || e?.status === 404) {
            finish(update);
            show(update.deviceId, {
                title: `Stopped tracking the update of ${update.name}`,
                description: e?.message || "Its progress is not available.",
                variant: "warning",
                duration: OUTCOME_TOAST_MS,
            });
            return;
        }
        // Anything else may be brief, and the next check will tell.
    }

    window.setTimeout(() => void poll(update), POLL_MS);
}

function begin(update: TrackedUpdate) {
    if (running.has(update.deviceId)) return;
    running.add(update.deviceId);

    show(update.deviceId, {
        title: `Updating ${update.name}`,
        description: `Installing version ${update.targetVersion}. The agent restarts when it is done, and this usually takes a couple of minutes.`,
        duration: Infinity,
    });
    window.setTimeout(() => void poll(update), POLL_MS);
}

/** Follows an update that has just been requested, until it succeeds, fails or runs out of time. */
export function trackAgentUpdate(update: Omit<TrackedUpdate, "startedAt">) {
    const tracked = { ...update, startedAt: Date.now() };
    writeSaved([...readSaved().filter((u) => u.deviceId !== update.deviceId), tracked]);
    begin(tracked);
}

// Reloading the page keeps following updates that were already under way.
if (typeof window !== "undefined") {
    readSaved().forEach(begin);
}
