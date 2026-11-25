// Records the remote video of a Remote Console session in this browser (MediaRecorder, WebM) and uploads it to the
// server in pieces while it runs, so a closed tab or a crash keeps everything that was already sent.
import { PieceRefused, recordings, uploadPiece } from "@/lib/recordings-api";

export type RecorderState = "starting" | "recording" | "stopping" | "finished" | "failed";

export type RecorderStatus = {
    state: RecorderState;
    startedAt: number;
    uploadedBytes: number;
    pendingBytes: number;
    /** While state is "recording" this is a hiccup being retried; when "failed" it is final. */
    message: string | null;
};

const SLICE_MS = 5000;
const VIDEO_BPS = 1_000_000;
/** More than this waiting means the upload cannot keep up, and the recording is better stopped than silently thinned. */
const MAX_PENDING_BYTES = 96 * 1024 * 1024;
const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

export function recordingSupported(): boolean {
    return typeof window !== "undefined" && typeof (window as any).MediaRecorder !== "undefined";
}

function pickMime(): string {
    for (const m of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
        try {
            if ((window as any).MediaRecorder.isTypeSupported(m)) return m;
        } catch {
            // try the next
        }
    }
    return "";
}

export class SessionRecorder {
    private recorder: MediaRecorder | null = null;
    private recordingId: string | null = null;
    private seq = 0;
    private queue: Blob[] = [];
    private pendingBytes = 0;
    private uploadedBytes = 0;
    private uploading = false;
    private startedAt = Date.now();
    private state: RecorderState = "starting";
    private message: string | null = null;
    private stopping = false;
    private flushWaiters: Array<() => void> = [];
    private readonly onPageHide = () => {
        // The tab is going away: close the recording on the server with what it already has.
        if (this.recordingId && this.state !== "finished") void recordings.finish(this.recordingId, Date.now() - this.startedAt, true).catch(() => { });
    };

    constructor(private readonly sessionId: string, private readonly onStatus: (s: RecorderStatus) => void) { }

    private emit() {
        this.onStatus({ state: this.state, startedAt: this.startedAt, uploadedBytes: this.uploadedBytes, pendingBytes: this.pendingBytes, message: this.message });
    }

    private fail(message: string) {
        this.state = "failed";
        this.message = message;
        this.queue = [];
        this.pendingBytes = 0;
        try {
            if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
        } catch {
            // already stopped
        }
        this.emit();
    }

    /** Starts the recording on the server and the recorder on the stream. Rejects with the reason if it cannot. */
    async start(stream: MediaStream): Promise<void> {
        if (!recordingSupported()) throw new Error("This browser cannot record the screen (no MediaRecorder).");
        this.emit();
        const info = await recordings.start(this.sessionId).catch((e: any) => {
            throw new Error(e?.message || "The server would not start a recording.");
        });
        this.recordingId = info.id;
        this.seq = info.nextSeq;
        this.startedAt = Date.now();

        const mime = pickMime();
        const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: VIDEO_BPS });
        this.recorder = rec;
        rec.ondataavailable = (ev) => {
            if (!ev.data || !ev.data.size || this.state === "failed") return;
            this.queue.push(ev.data);
            this.pendingBytes += ev.data.size;
            if (this.pendingBytes > MAX_PENDING_BYTES) {
                this.fail("Recording stopped: the connection to the server is too slow to keep up with the recording.");
                return;
            }
            this.emit();
            void this.pump();
        };
        rec.onerror = () => this.fail("Recording stopped: the browser's recorder reported an error.");
        rec.start(SLICE_MS);
        window.addEventListener("pagehide", this.onPageHide);
        this.state = "recording";
        this.emit();
    }

    private async pump(): Promise<void> {
        if (this.uploading || !this.recordingId) return;
        this.uploading = true;
        try {
            let attempt = 0;
            while (this.queue.length && this.state !== "failed") {
                const piece = this.queue[0];
                try {
                    const r = await uploadPiece(this.recordingId, this.seq, piece);
                    this.queue.shift();
                    this.pendingBytes -= piece.size;
                    this.seq = r.nextSeq;
                    this.uploadedBytes = r.sizeBytes;
                    attempt = 0;
                    if (this.message && this.state === "recording") this.message = null;
                    this.emit();
                } catch (e: any) {
                    // Refused for good: a limit, a setting turned off, a closed recording. Retrying cannot help.
                    if (e instanceof PieceRefused && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
                        const ahead = /Piece (\d+) comes next/.exec(e.message);
                        if (e.status === 409 && ahead && Number(ahead[1]) > this.seq) {
                            // The server is ahead (a retry whose answer was lost): the piece was stored.
                            this.queue.shift();
                            this.pendingBytes -= piece.size;
                            this.seq = Number(ahead[1]);
                            continue;
                        }
                        this.fail(`Recording stopped: ${e.message}`);
                        break;
                    }
                    this.message = "Upload is retrying (connection problem).";
                    this.emit();
                    await new Promise((res) => setTimeout(res, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]));
                    if (this.stopping && attempt > 6) {
                        this.fail("Recording stopped: the last part could not be uploaded.");
                        break;
                    }
                }
            }
        } finally {
            this.uploading = false;
            if (!this.queue.length) this.flushWaiters.splice(0).forEach((w) => w());
        }
    }

    /** Stops recording, uploads what is left and closes the recording on the server. Safe to call twice. */
    async stop(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        window.removeEventListener("pagehide", this.onPageHide);
        if (this.state !== "failed") {
            this.state = "stopping";
            this.emit();
        }
        const rec = this.recorder;
        if (rec && rec.state !== "inactive") {
            await new Promise<void>((resolve) => {
                rec.addEventListener("stop", () => resolve(), { once: true });
                try {
                    rec.stop();
                } catch {
                    resolve();
                }
            });
        }
        // The final piece is delivered by the recorder just before "stop"; let it queue, then flush with a time limit.
        await new Promise((r) => setTimeout(r, 50));
        if (this.queue.length && this.state !== "failed") {
            void this.pump();
            await Promise.race([new Promise<void>((r) => this.flushWaiters.push(r)), new Promise<void>((r) => setTimeout(r, 30_000))]);
        }
        if (this.recordingId) {
            try {
                await recordings.finish(this.recordingId, Date.now() - this.startedAt);
            } catch {
                // The server closes a recording whose browser went quiet by itself.
            }
        }
        if (this.state !== "failed") this.state = "finished";
        this.emit();
    }
}
