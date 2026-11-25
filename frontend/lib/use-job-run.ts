// remoteiq-frontend/lib/use-job-run.ts
"use client";

import * as React from "react";
import { onWsMessage, ensureSocket, sendWs } from "./ws";
import { fetchJob, postRunScript, type RunScriptRequest } from "./api";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type JobUpdate = {
    type: "job.run.updated";
    jobId: string;
    status: JobStatus;
    progress?: number; // 0..100
    chunk?: string; // log delta
    exitCode?: number | null;
    finishedAt?: string | null;
};

export function useJobRun() {
    const [jobId, setJobId] = React.useState<string | null>(null);
    const [status, setStatus] = React.useState<JobStatus | null>(null);
    const [log, setLog] = React.useState<string>("");
    const [progress, setProgress] = React.useState<number>(0);
    const [error, setError] = React.useState<string | null>(null);
    const [subscribed, setSubscribed] = React.useState(false);

    // Subscribe once to WS messages (filters inside)
    React.useEffect(() => {
        ensureSocket();

        const unsubscribe = onWsMessage((msg: any) => {
            if (msg?.type !== "job.run.updated") return;
            const data = msg as JobUpdate;
            if (!jobId || data.jobId !== jobId) return;

            setStatus(data.status);
            if (typeof data.progress === "number") setProgress(data.progress);
            // The server sends the whole output once, at the end. Polling may already have shown it.
            if (data.chunk) setLog(data.chunk);

            if (data.status === "failed") {
                setError(`Run failed${data.exitCode != null ? ` (exit ${data.exitCode})` : ""}`);
            }
            if (data.status === "succeeded") {
                // clear any stale error
                setError(null);
            }
        });

        setSubscribed(true);

        return () => {
            if (typeof unsubscribe === "function") void unsubscribe();
        };
    }, [jobId]);

    // The socket can miss an update, for example a job that ends as it subscribes, so the job is also polled.
    React.useEffect(() => {
        if (!jobId) return;
        let stopped = false;

        const check = async () => {
            try {
                const snap = await fetchJob(jobId);
                if (stopped) return;
                setStatus(snap.status);
                setLog(snap.log ?? "");
                if (snap.status === "succeeded") {
                    setProgress(100);
                    setError(null);
                    stopped = true;
                } else if (snap.status === "failed" || snap.status === "canceled") {
                    setProgress(100);
                    setError(`Run failed${snap.exitCode != null ? ` (exit ${snap.exitCode})` : ""}`);
                    stopped = true;
                }
            } catch {
                // Still running as far as we know. The next check tries again.
            }
        };

        const timer = setInterval(() => {
            if (stopped) clearInterval(timer);
            else void check();
        }, 2000);
        void check();

        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [jobId]);

    const start = React.useCallback(async (req: RunScriptRequest) => {
        setError(null);
        setLog("");
        setProgress(0);
        setStatus("queued");

        // ✅ subscribe dashboard socket to the device topic so it receives device-scoped broadcasts
        if (req.deviceId) {
            sendWs({ t: "subscribe_device", deviceId: String(req.deviceId) });
        }

        try {
            const res = await postRunScript(req);
            setJobId(res.jobId);
            return res.jobId;
        } catch (e: any) {
            // Without this the Run button stays on "Queued" with no explanation.
            setStatus("failed");
            setError(e?.message || "The script could not be started.");
            return null;
        }
    }, []);

    const reset = React.useCallback(() => {
        setJobId(null);
        setStatus(null);
        setLog("");
        setProgress(0);
        setError(null);
    }, []);

    return {
        jobId,
        status,
        log,
        progress,
        error,
        subscribed,
        start,
        reset,
    };
}
