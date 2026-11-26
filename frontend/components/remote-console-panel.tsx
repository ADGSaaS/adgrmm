// components/remote-console-panel.tsx
"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
    Send,
    PlugZap,
    Power,
    Copy as CopyIcon,
    Clipboard,
    MessageSquare,
    Monitor,
    Terminal,
    ExternalLink,
    X,
    Activity,
    PanelRightClose,
    Volume2,
    VolumeX,
    FolderOpen,
    Lock,
    LockOpen,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import ConsoleFilesPanel, { type ConsoleFilesHandle } from "@/components/console-files-panel";
import { SessionRecorder, type RecorderStatus } from "@/lib/session-recorder";
import { jfetch } from "@/lib/api";

type Props = {
    deviceId: string;
    agentUuid?: string;
    popout?: boolean;
};

type Status =
    | "idle"
    | "creating-session"
    | "connecting-ws"
    | "waiting-for-agent"
    | "negotiating"
    | "connected"
    | "disconnected"
    | "error";

type ChatMsg = { id: string; at: number; from: "me" | "remote" | "system"; text: string };

type MonitorInfo = { w: number; h: number; primary: boolean };

const CLOSE_REASONS: Record<string, string> = {
    replaced_by_new_session: "This session was replaced by a newer one you opened.",
    agent_disconnected: "The agent on the device disconnected.",
    idle_timeout: "The session ended because it was idle.",
    token_expired: "The session expired. Connect again.",
    abandoned: "The session ended because it never finished connecting.",
    ended_at_device: "The person at the device ended the session.",
};

const AGENT_WAIT_MS = 20_000;

// The chat's two short sounds: a soft two-note chime when the person at the device replies, and a quieter single
// tick when you send. They are made from a few sine waves, so there are no sound files, and they match the ones
// the device plays for you.
let chatAudio: AudioContext | null = null;
function playChatSound(kind: "incoming" | "sent") {
    try {
        const Context = window.AudioContext || (window as any).webkitAudioContext;
        if (!Context) return;
        chatAudio = chatAudio ?? new Context();
        const ctx = chatAudio;
        if (!ctx) return;
        if (ctx.state === "suspended") void ctx.resume();

        const notes: [number, number][] = kind === "incoming" ? [[659.25, 0.11], [880, 0.2]] : [[523.25, 0.1]];
        const volume = kind === "incoming" ? 0.13 : 0.07;
        let at = ctx.currentTime + 0.01;
        for (const [hz, seconds] of notes) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = hz;
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(volume, at + 0.006);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds * 1.6);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(at);
            osc.stop(at + seconds * 1.6 + 0.02);
            at += seconds;
        }
    } catch {
        // A browser that will not play sound is not worth failing a chat over.
    }
}

type ViewMode = "desktop" | "terminal";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/+$/, "");
const WS_BASE_RAW = (process.env.NEXT_PUBLIC_WS_BASE || "").replace(/\/+$/, "");

function uid() {
    return Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

function apiUrl(path: string): string {
    if (!API_BASE) return path;
    return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

function buildWsUrl(path: string): string {
    if (WS_BASE_RAW) {
        const base = WS_BASE_RAW.endsWith("/ws") ? WS_BASE_RAW.slice(0, -3) : WS_BASE_RAW;
        return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    }

    if (typeof window !== "undefined") {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${window.location.host}${path.startsWith("/") ? "" : "/"}${path}`;
    }

    return path;
}

function safeJsonParse(s: string): any | null {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

// Only gives lastPointRef its type. computeVideoNormXY below returns this shape.
function computeNone() {
    return { x: 0, y: 0, w: 0, h: 0, dw: 0, dh: 0, cx: 0, cy: 0, ax: 0, ay: 0, offX: 0, offY: 0 };
}

function clamp01(n: number) {
    return Math.max(0, Math.min(1, n));
}

function toText(data: any): string {
    if (data == null) return "";
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer));
    try {
        return String(data);
    } catch {
        return "";
    }
}

type ControlMsg =
    | {
        type: "mouse.move";
        // normalized within *visible video content* (after letterboxing/cropping adjustments)
        x: number; // 0..1
        y: number; // 0..1

        // video track dimensions as decoded on the viewer
        w: number; // videoWidth
        h: number; // videoHeight

        // drawn content box (within the container) in CSS pixels
        dw: number; // drawnWidth
        dh: number; // drawnHeight

        // optional: viewport geometry (CSS px)
        cx?: number; // container width
        cy?: number; // container height

        // optional: absolute pointer coords within the drawn content in CSS px
        ax?: number;
        ay?: number;

        mods: { alt: boolean; ctrl: boolean; shift: boolean; meta: boolean };
    }
    | {
        type: "mouse.down" | "mouse.up";
        button: number;

        x: number;
        y: number;

        w: number;
        h: number;

        dw: number;
        dh: number;

        cx?: number;
        cy?: number;

        ax?: number;
        ay?: number;

        mods: { alt: boolean; ctrl: boolean; shift: boolean; meta: boolean };
    }
    | {
        type: "mouse.wheel";
        dx: number;
        dy: number;

        // optional: wheel mode / scaling hint
        mode?: "pixel" | "line" | "page";

        mods: { alt: boolean; ctrl: boolean; shift: boolean; meta: boolean };
    }
    | {
        type: "key.down" | "key.up";
        key: string;
        code: string;
        repeat: boolean;
        mods: { alt: boolean; ctrl: boolean; shift: boolean; meta: boolean };
    }
    | { type: "keys.sas" }
    | { type: "input.lock"; locked: boolean }
    | { type: "focus" | "blur" };


// One pop-out per device, so opening it twice brings the same window forward.
const popoutWindowName = (deviceId: string) => `adgrmm_console_${deviceId.replace(/[^a-zA-Z0-9]/g, "_")}`;
const popoutChannelName = (deviceId: string) => `adgrmm-console-${deviceId}`;
const SIGNALING_PING_MS = 25_000;
const PASTE_WAIT_MS = 150;
const PASTE_HEAD_START_MS = 80;
const POPOUT_ALIVE_MS = 2000;
const POPOUT_GONE_MS = 8000;
// A window that was just opened needs longer to load before its silence means anything.
const POPOUT_LOAD_GRACE_MS = 15000;
// The server releases the device a moment after the previous session ends.
const BUSY_RETRIES = 4;
const BUSY_RETRY_MS = 1000;

// A connection that cannot keep up should drop old pointer positions rather than queue them.
const MAX_QUEUED_MOVE_BYTES = 16 * 1024;

/** The clipboard of whichever window the console is showing in, because a browser refuses an unfocused one. */
function clipboardOf(ref: { current: HTMLElement | null }) {
    return (ref.current?.ownerDocument?.defaultView ?? window).navigator.clipboard;
}

function buildPopoutUrl(autoconnect = true) {
    const u = new URL(window.location.href);
    const sp = u.searchParams;
    if (!sp.get("tool")) sp.set("tool", "remote-console");
    sp.set("tool", "remote-console");
    sp.set("popout", "1");
    if (autoconnect) sp.set("autoconnect", "1");
    u.search = sp.toString();
    return u.toString();
}

/**
 * SDP munging for bandwidth hints:
 * - Adds b=TIAS / b=AS on the video m-line (helps some stacks pick sane target bandwidth).
 * - Adds x-google-(min/start/max)-bitrate to the VP9 fmtp line (Chrome-compatible hinting).
 *
 * NOTE: This is a pragmatic stopgap; agent-side encoder tuning still matters.
 */
function mungeSdpForVp9Quality(
    sdp: string,
    opts?: {
        minKbps?: number;
        startKbps?: number;
        maxKbps?: number;
        maxTiasBps?: number;
    }
): string {
    const minKbps = Math.max(50, Math.floor(opts?.minKbps ?? 250));
    const startKbps = Math.max(minKbps, Math.floor(opts?.startKbps ?? 1800));
    const maxKbps = Math.max(startKbps, Math.floor(opts?.maxKbps ?? 8000));

    const bps = Math.max(64_000, Math.floor(opts?.maxTiasBps ?? maxKbps * 1000));
    const asKbps = Math.max(64, Math.floor(bps / 1000));

    const lines = sdp.split(/\r\n/);

    // Find the video m-section
    let mVideo = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("m=video ")) {
            mVideo = i;
            break;
        }
    }
    if (mVideo === -1) return sdp;

    const sectionEnd = (() => {
        for (let i = mVideo + 1; i < lines.length; i++) {
            if (lines[i].startsWith("m=")) return i;
        }
        return lines.length;
    })();

    const before = lines.slice(0, mVideo);
    let mid = lines.slice(mVideo, sectionEnd);
    const after = lines.slice(sectionEnd);

    // ---- 1) Prefer VP9 first, VP8 second by reordering payloads in m=video ----
    // Find payload types for VP9 / VP8 from rtpmap
    const vp9Pts = new Set<string>();
    const vp8Pts = new Set<string>();

    for (const l of mid) {
        if (l.startsWith("a=rtpmap:") && /\/90000/i.test(l)) {
            // a=rtpmap:98 VP9/90000
            const m = l.match(/^a=rtpmap:(\d+)\s+([A-Za-z0-9\-]+)\/90000/i);
            if (!m) continue;
            const pt = m[1];
            const codec = (m[2] || "").toLowerCase();
            if (codec === "vp9") vp9Pts.add(pt);
            if (codec === "vp8") vp8Pts.add(pt);
        }
    }

    if (vp9Pts.size || vp8Pts.size) {
        const mParts = (mid[0] || "").split(" ").filter(Boolean);
        if (mParts.length >= 4) {
            const head = mParts.slice(0, 3);
            const pts = mParts.slice(3);

            const vp9Ordered = pts.filter((p) => vp9Pts.has(p));
            const vp8Ordered = pts.filter((p) => vp8Pts.has(p));
            const rest = pts.filter((p) => !vp9Pts.has(p) && !vp8Pts.has(p));

            // VP9 then VP8 then the rest
            const reordered = [...vp9Ordered, ...vp8Ordered, ...rest];
            mid[0] = [...head, ...reordered].join(" ");
        }
    }

    // ---- 2) Remove old b=AS/b=TIAS inside the video section ----
    mid = mid.filter((l) => !(l.startsWith("b=AS:") || l.startsWith("b=TIAS:")));

    // ---- 3) Insert b= lines near the top of the section (after m=/i=/c=) ----
    let insertAt = 1;
    for (let i = 1; i < mid.length; i++) {
        const l = mid[i];
        if (l.startsWith("i=") || l.startsWith("c=")) {
            insertAt = i + 1;
            continue;
        }
        if (l.startsWith("a=")) {
            insertAt = i;
            break;
        }
    }

    const bLines = [`b=TIAS:${bps}`, `b=AS:${asKbps}`, `a=content:screen`];
    mid.splice(insertAt, 0, ...bLines);

    // ---- 4) Add bitrate hints for BOTH VP9 + VP8 payloads (Chrome respects these) ----
    const want = `x-google-min-bitrate=${minKbps};x-google-start-bitrate=${startKbps};x-google-max-bitrate=${maxKbps};x-google-denoise=false;googNoiseReduction=false;googHighStartBitrate=true`;

    function upsertFmtp(pt: string) {
        let found = false;
        for (let i = 0; i < mid.length; i++) {
            const l = mid[i];
            if (l.startsWith(`a=fmtp:${pt}`)) {
                found = true;

                const parts = l.split(" ");
                const head = parts[0];
                const rest = parts.slice(1).join(" ").trim();

                const cleaned = rest
                    .split(";")
                    .map((p) => p.trim())
                    .filter(Boolean)
                    .filter(
                        (p) =>
                            !p.toLowerCase().startsWith("x-google-min-bitrate=") &&
                            !p.toLowerCase().startsWith("x-google-start-bitrate=") &&
                            !p.toLowerCase().startsWith("x-google-max-bitrate=") &&
                            !p.toLowerCase().startsWith("x-google-denoise=") &&
                            !p.toLowerCase().startsWith("goognoisereduction=") &&
                            !p.toLowerCase().startsWith("googhighstartbitrate=")
                    );

                mid[i] = `${head} ${[...cleaned, ...want.split(";")].join(";")}`.trim();
                return;
            }
        }

        if (!found) {
            // Insert right after the matching rtpmap line if possible
            let ins = mid.length;
            for (let i = 0; i < mid.length; i++) {
                if (mid[i].startsWith(`a=rtpmap:${pt}`)) {
                    ins = i + 1;
                    break;
                }
            }
            mid.splice(ins, 0, `a=fmtp:${pt} ${want}`);
        }
    }

    for (const pt of vp9Pts) upsertFmtp(pt);
    for (const pt of vp8Pts) upsertFmtp(pt);

    const out = [...before, ...mid, ...after].join("\r\n");
    return out.endsWith("\r\n") ? out : out + "\r\n";
}


export default function RemoteConsolePanel({ deviceId, agentUuid, popout }: Props) {
    const [status, setStatus] = React.useState<Status>("idle");
    const [err, setErr] = React.useState<string | null>(null);

    const [sessionId, setSessionId] = React.useState<string | null>(null);
    const transportSentRef = React.useRef(0);
    const transportKnownRef = React.useRef(false);
    const [sessionToken, setSessionToken] = React.useState<string | null>(null);

    const [viewMode, setViewMode] = React.useState<ViewMode>("desktop");
    const [videoFit, setVideoFit] = React.useState<"contain" | "cover">("contain");

    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    const containerRef = React.useRef<HTMLDivElement | null>(null);

    const wsRef = React.useRef<WebSocket | null>(null);
    const pcRef = React.useRef<RTCPeerConnection | null>(null);

    // Data channels
    const termDcRef = React.useRef<RTCDataChannel | null>(null); // rc.input (terminal)
    const controlDcRef = React.useRef<RTCDataChannel | null>(null); // rc.control (mouse/kb)
    const chatDcRef = React.useRef<RTCDataChannel | null>(null); // rc.chat
    const clipDcRef = React.useRef<RTCDataChannel | null>(null); // rc.clipboard
    const moveDcRef = React.useRef<RTCDataChannel | null>(null); // rc.move
    const moveReadyRef = React.useRef(false);
    const mouseSeqRef = React.useRef(0);

    // The pointer is drawn here rather than in the video, so it moves as soon as the mouse does.
    const cursorShapesRef = React.useRef(new Map<string, { url: string; hx: number; hy: number }>());
    const [pointerCursor, setPointerCursor] = React.useState<string | null>(null);
    const [overlayCursor, setOverlayCursor] = React.useState<{ url: string; hx: number; hy: number } | null>(null);
    const [pointerInside, setPointerInside] = React.useState(false);
    const overlayRef = React.useRef<HTMLImageElement | null>(null);
    const remotePointerRef = React.useRef<{ x: number; y: number } | null>(null);
    const deviceStatsRef = React.useRef<{ captureMs?: number; captureMethod?: string; encodeMs?: number; queuedMs?: number; pointer?: string; codec?: string; hardware?: boolean }>({});
    // The customer's "Remote video codec" setting, as the server sent it with session.ready. Decides whether H.264 is offered at all.
    const videoCodecSettingRef = React.useRef<string>("auto");
    // Set once the browser has asked the device to go back to VP8, so it asks only once per session.
    const askedVp8Ref = React.useRef(false);

    const pendingIceRef = React.useRef<RTCIceCandidateInit[]>([]);
    const didStartWebRtcRef = React.useRef(false);
    // Issued per session by the backend, including relay credentials when a relay is set up.
    const iceServersRef = React.useRef<RTCIceServer[] | null>(null);
    // Candidate types seen, so a failed connection can say what it tried.
    const iceSeenRef = React.useRef<{ local: Record<string, number>; remote: Record<string, number> }>({ local: {}, remote: {} });

    // The chat panel can be folded away, and the connection details line is hidden until asked for.
    // Both choices are remembered in this browser only.
    const [chatOpen, setChatOpen] = React.useState(true);
    const [showStats, setShowStats] = React.useState(false);
    const [unreadChat, setUnreadChat] = React.useState(0);
    // Set while the person at the device is being asked to allow the connection.
    const [waitingNote, setWaitingNote] = React.useState<string | null>(null);
    const chatOpenRef = React.useRef(true);
    chatOpenRef.current = chatOpen;

    // Chat sounds, on by default, with a mute button in the chat header. Remembered in this browser only.
    const [soundOn, setSoundOn] = React.useState(true);
    const soundOnRef = React.useRef(true);
    soundOnRef.current = soundOn;
    React.useEffect(() => {
        try {
            if (window.localStorage.getItem("adg.console.chatSound") === "0") setSoundOn(false);
        } catch {
            // Storage can be blocked. The default is fine.
        }
    }, []);
    const toggleSound = React.useCallback(() => {
        setSoundOn((on) => {
            const next = !on;
            try {
                window.localStorage.setItem("adg.console.chatSound", next ? "1" : "0");
            } catch {
                // ignore
            }
            if (next) playChatSound("sent");
            return next;
        });
    }, []);
    React.useEffect(() => {
        try {
            if (window.localStorage.getItem("adg.console.chatOpen") === "0") setChatOpen(false);
            if (window.localStorage.getItem("adg.console.showStats") === "1") setShowStats(true);
        } catch {
            // Storage can be blocked. The defaults are fine.
        }
    }, []);
    const toggleChat = React.useCallback(() => {
        setChatOpen((open) => {
            const next = !open;
            if (next) setUnreadChat(0);
            try {
                window.localStorage.setItem("adg.console.chatOpen", next ? "1" : "0");
            } catch {
                // ignore
            }
            return next;
        });
    }, []);
    const toggleStats = React.useCallback(() => {
        setShowStats((on) => {
            const next = !on;
            try {
                window.localStorage.setItem("adg.console.showStats", next ? "1" : "0");
            } catch {
                // ignore
            }
            return next;
        });
    }, []);

    // Files side panel (browse the device, drag files onto the console to upload) and session recording.
    const [filesOpen, setFilesOpen] = React.useState(false);
    const [dragOver, setDragOver] = React.useState(false);
    const filesRef = React.useRef<ConsoleFilesHandle | null>(null);
    const [recordingOn, setRecordingOn] = React.useState(false);
    const [recStatus, setRecStatus] = React.useState<RecorderStatus | null>(null);
    const [recTick, setRecTick] = React.useState(0);
    const recorderRef = React.useRef<{ sid: string; rec: SessionRecorder } | null>(null);

    const [chat, setChat] = React.useState<ChatMsg[]>([]);
    const [chatText, setChatText] = React.useState("");
    const [clipboardText, setClipboardText] = React.useState("");

    const [monitors, setMonitors] = React.useState<MonitorInfo[]>([]);
    const [activeMonitor, setActiveMonitor] = React.useState(0);

    // The sizes the device's screen can be switched to. A device that starts small, such as a virtual machine
    // at its sign-in screen, can be set larger, and the choice is remembered for that device in this browser.
    const [displayModes, setDisplayModes] = React.useState<{ w: number; h: number }[]>([]);
    const [displayCurrent, setDisplayCurrent] = React.useState<{ w: number; h: number } | null>(null);
    // The device has told us what sizes it offers (so an empty or one-item list is an answer, not a wait).
    const [displayModesSeen, setDisplayModesSeen] = React.useState(false);
    const savedSizeTriedRef = React.useRef(false);
    // Whether the person at the device can be locked out of their keyboard and mouse, and whether they are now.
    const [inputLockCap, setInputLockCap] = React.useState(false);
    const [inputLocked, setInputLocked] = React.useState(false);
    const [captureBlocked, setCaptureBlocked] = React.useState(false);
    const [captureBlockedDetail, setCaptureBlockedDetail] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);

    // Buttons held down here, and where the pointer last was, so a release is never lost.
    const pressedRef = React.useRef<Set<number>>(new Set());
    const lastPointRef = React.useRef<ReturnType<typeof computeNone> | null>(null);

    // Terminal UI state
    const [termOut, setTermOut] = React.useState<string>("");
    const [termLine, setTermLine] = React.useState<string>("");
    const termOutRef = React.useRef<HTMLDivElement | null>(null);

    // Video state
    const [hasVideoTrack, setHasVideoTrack] = React.useState(false);
    const [lastTrackInfo, setLastTrackInfo] = React.useState<string>("");

    const canStart = !!agentUuid;

    // The session is running in another window, so this page steps aside.
    const [poppedOut, setPoppedOut] = React.useState(false);
    // A live session moves to the new window by drawing into it from here, so the connection never drops.
    const [portalTarget, setPortalTarget] = React.useState<HTMLElement | null>(null);
    const portalWindowRef = React.useRef<Window | null>(null);
    const portalHandoverUrlRef = React.useRef<string | null>(null);
    const remoteStreamRef = React.useRef<MediaStream | null>(null);
    const popoutWindowRef = React.useRef<Window | null>(null);
    const popoutSeenAtRef = React.useRef(0);
    const popoutChannelRef = React.useRef<BroadcastChannel | null>(null);
    const retryIfBusyRef = React.useRef(false);

    const addChat = React.useCallback((from: ChatMsg["from"], text: string) => {
        const t = String(text || "").trim();
        if (!t) return;
        setChat((c) => [...c, { id: uid(), at: Date.now(), from, text: t }]);
        // A reply from the device must not go unseen while the panel is folded away.
        if (from === "remote" && !chatOpenRef.current) setUnreadChat((n) => n + 1);
        if (soundOnRef.current && (from === "remote" || from === "me")) playChatSound(from === "remote" ? "incoming" : "sent");
    }, []);

    const appendTermOut = React.useCallback((chunk: string) => {
        if (!chunk) return;
        setTermOut((prev) => {
            const next = prev + chunk;
            const cap = 200_000;
            return next.length > cap ? next.slice(next.length - cap) : next;
        });
    }, []);

    const scrollTermToBottom = React.useCallback(() => {
        const el = termOutRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, []);

    React.useEffect(() => {
        scrollTermToBottom();
    }, [termOut, scrollTermToBottom]);

    const sendWs = React.useCallback((msg: any) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(msg));
    }, []);

    const dcSendJson = React.useCallback((dc: RTCDataChannel | null, obj: any) => {
        if (!dc || dc.readyState !== "open") return;
        try {
            dc.send(JSON.stringify(obj));
        } catch {
            // ignore
        }
    }, []);

    const closeAll = React.useCallback(
        (reason?: string) => {
            didStartWebRtcRef.current = false;

            try {
                termDcRef.current?.close();
            } catch { }
            try {
                controlDcRef.current?.close();
            } catch { }
            try {
                chatDcRef.current?.close();
            } catch { }
            try {
                clipDcRef.current?.close();
            } catch { }

            termDcRef.current = null;
            controlDcRef.current = null;
            chatDcRef.current = null;
            clipDcRef.current = null;
            moveDcRef.current = null;
            moveReadyRef.current = false;
            cursorShapesRef.current.clear();
            setPointerCursor(null);
            setOverlayCursor(null);

            try {
                pcRef.current?.close();
            } catch { }
            pcRef.current = null;

            try {
                wsRef.current?.close();
            } catch { }
            wsRef.current = null;

            pendingIceRef.current = [];

            const v = videoRef.current;
            if (v) {
                try {
                    (v as any).srcObject = null;
                } catch { }
                v.src = "";
            }

            setHasVideoTrack(false);
            setLastTrackInfo("");
            setMonitors([]);
            setActiveMonitor(0);
            setDisplayModes([]);
            setDisplayCurrent(null);
            setDisplayModesSeen(false);
            savedSizeTriedRef.current = false;
            setCaptureBlocked(false);
            setNotice(null);
            setWaitingNote(null);
            pressedRef.current.clear();
            // The device lets the person have their keyboard and mouse back when we disconnect; the button follows.
            setInputLocked(false);
            setInputLockCap(false);

            setStatus("disconnected");
            if (reason) setErr(reason);
        },
        [setErr]
    );

    const sendTerminalText = React.useCallback((text: string) => {
        const dc = termDcRef.current;
        if (!dc || dc.readyState !== "open") return;
        try {
            dc.send(text ?? "");
        } catch { }
    }, []);

    const sendControl = React.useCallback(
        (msg: ControlMsg) => {
            const isMouse = String(msg.type).startsWith("mouse.");
            const out = isMouse ? { ...msg, seq: ++mouseSeqRef.current } : msg;

            const moveDc = moveDcRef.current;
            if (msg.type === "mouse.move" && moveReadyRef.current && moveDc?.readyState === "open") {
                dcSendJson(moveDc, out);
                return;
            }

            const dc = controlDcRef.current;
            if (!dc || dc.readyState !== "open") return;
            dcSendJson(dc, out);
        },
        [dcSendJson]
    );

    const sizeKey = `adg.console.size.${deviceId}`;

    // The device reports what its screen can do. A size chosen earlier for this device is applied once
    // per session, so connecting does not change a screen the technician never asked to change.
    const applyDisplayModesRef = React.useRef<(msg: any) => void>(() => { });
    applyDisplayModesRef.current = (msg: any) => {
        const list: { w: number; h: number }[] = Array.isArray(msg.list)
            ? msg.list.map((m: any) => ({ w: Number(m.w), h: Number(m.h) })).filter((m: { w: number; h: number }) => m.w > 0 && m.h > 0)
            : [];
        const current = msg.current && Number(msg.current.w) > 0 ? { w: Number(msg.current.w), h: Number(msg.current.h) } : null;
        setDisplayModes(list);
        setDisplayCurrent(current);
        setDisplayModesSeen(true);

        if (savedSizeTriedRef.current) return;
        savedSizeTriedRef.current = true;
        try {
            const saved = window.localStorage.getItem(sizeKey);
            const match = saved ? /^(\d+)x(\d+)$/.exec(saved) : null;
            if (!match) return;
            const w = Number(match[1]);
            const h = Number(match[2]);
            if (current && current.w === w && current.h === h) return;
            if (!list.some((m) => m.w === w && m.h === h)) return;
            dcSendJson(controlDcRef.current, { type: "display.set", w, h });
        } catch {
            // Storage can be blocked. Nothing is changed then.
        }
    };

    // Picking a size changes the device's screen and remembers it for this device. "Leave as is" only forgets it.
    const chooseScreenSize = (value: string) => {
        try {
            if (value === "keep") {
                window.localStorage.removeItem(sizeKey);
                return;
            }
            const match = /^(\d+)x(\d+)$/.exec(value);
            if (!match) return;
            window.localStorage.setItem(sizeKey, value);
            dcSendJson(controlDcRef.current, { type: "display.set", w: Number(match[1]), h: Number(match[2]) });
        } catch {
            // Storage can be blocked. The change still goes ahead for this session.
        }
    };

    const applyCursorShapeRef = React.useRef<(msg: any) => void>(() => { });
    applyCursorShapeRef.current = (msg: any) => {
        // Never leave the viewer with no pointer at all. The device's pointer is not in the video, so if it
        // reports none, or a shape we cannot show, the ordinary arrow is better than a pointer that vanishes.
        const fallBack = (why: string) => {
            deviceStatsRef.current.pointer = why;
            setPointerCursor(null);
            setOverlayCursor(null);
        };

        if (msg.hidden) {
            fallBack("hidden");
            return;
        }

        const id = String(msg.id ?? "");
        if (msg.rgba && Number(msg.w) > 0 && Number(msg.h) > 0) {
            const w = Number(msg.w);
            const h = Number(msg.h);
            const raw = atob(String(msg.rgba));
            if (raw.length !== w * h * 4) {
                fallBack("badsize");
                return;
            }

            // A shape with nothing opaque in it would draw an invisible pointer.
            let visible = false;
            for (let i = 3; i < raw.length; i += 4) {
                if (raw.charCodeAt(i) !== 0) {
                    visible = true;
                    break;
                }
            }
            if (!visible) {
                fallBack("blank");
                return;
            }

            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const context = canvas.getContext("2d");
            if (!context) {
                fallBack("nocanvas");
                return;
            }
            const image = context.createImageData(w, h);
            for (let i = 0; i < raw.length; i++) image.data[i] = raw.charCodeAt(i);
            context.putImageData(image, 0, 0);
            cursorShapesRef.current.set(id, { url: canvas.toDataURL("image/png"), hx: Number(msg.hx) || 0, hy: Number(msg.hy) || 0 });
        }

        const shape = cursorShapesRef.current.get(id);
        if (!shape) {
            fallBack("unknown");
            return;
        }
        deviceStatsRef.current.pointer = "shape";
        setPointerCursor(`url(${shape.url}) ${shape.hx} ${shape.hy}, default`);
        setOverlayCursor(shape);
    };

    // Places the device's pointer over the picture, for when it moves without this mouse.
    const placeOverlayRef = React.useRef<() => void>(() => { });
    placeOverlayRef.current = () => {
        const overlay = overlayRef.current;
        const video = videoRef.current;
        const point = remotePointerRef.current;
        const box = containerRef.current?.getBoundingClientRect();
        if (!overlay || !video || !point || !box || !video.videoWidth) return;

        const fit = videoFit === "contain" ? Math.min : Math.max;
        const scale = fit(box.width / video.videoWidth, box.height / video.videoHeight);
        const drawnW = video.videoWidth * scale;
        const drawnH = video.videoHeight * scale;
        const inside = point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
        overlay.style.visibility = inside ? "visible" : "hidden";
        overlay.style.transform = `translate(${(box.width - drawnW) / 2 + point.x * drawnW - (overlayCursor?.hx ?? 0)}px, ${(box.height - drawnH) / 2 + point.y * drawnH - (overlayCursor?.hy ?? 0)}px)`;
    };

    const computeVideoNormXY = React.useCallback(
        (clientX: number, clientY: number) => {
            const el = containerRef.current;
            const v = videoRef.current;
            if (!el) return null;

            const r = el.getBoundingClientRect();
            const rawX = clientX - r.left;
            const rawY = clientY - r.top;

            const cw = r.width;
            const ch = r.height;

            const vw = v?.videoWidth || 0;
            const vh = v?.videoHeight || 0;

            // Fallback when we don't know remote/video dimensions yet:
            // treat whole container as the "content box"
            if (!vw || !vh) {
                const nx = clamp01(rawX / Math.max(1, cw));
                const ny = clamp01(rawY / Math.max(1, ch));
                return {
                    x: nx,
                    y: ny,
                    w: 0,
                    h: 0,
                    dw: Math.round(cw),
                    dh: Math.round(ch),
                    cx: Math.round(cw),
                    cy: Math.round(ch),
                    ax: Math.round(rawX),
                    ay: Math.round(rawY),
                    offX: 0,
                    offY: 0,
                };
            }

            const containerAspect = cw / Math.max(1, ch);
            const videoAspect = vw / Math.max(1, vh);

            // Drawn box in container pixels (CSS px)
            let drawW = cw;
            let drawH = ch;
            let offX = 0;
            let offY = 0;

            if (videoFit === "contain") {
                // letterbox/pillarbox
                if (videoAspect > containerAspect) {
                    drawW = cw;
                    drawH = cw / videoAspect;
                    offY = (ch - drawH) / 2;
                } else {
                    drawH = ch;
                    drawW = ch * videoAspect;
                    offX = (cw - drawW) / 2;
                }
            } else {
                // cover (crop)
                if (videoAspect > containerAspect) {
                    drawH = ch;
                    drawW = ch * videoAspect;
                    offX = (cw - drawW) / 2;
                } else {
                    drawW = cw;
                    drawH = cw / videoAspect;
                    offY = (ch - drawH) / 2;
                }
            }

            // x/y within the drawn content box
            const xIn = rawX - offX;
            const yIn = rawY - offY;

            const nx = clamp01(xIn / Math.max(1, drawW));
            const ny = clamp01(yIn / Math.max(1, drawH));

            return {
                x: nx,
                y: ny,
                w: vw,
                h: vh,
                dw: Math.round(drawW),
                dh: Math.round(drawH),
                cx: Math.round(cw),
                cy: Math.round(ch),
                ax: Math.round(xIn),
                ay: Math.round(yIn),
                offX: Math.round(offX),
                offY: Math.round(offY),
            };
        },
        [videoFit]
    );


    const startWebRtc = React.useCallback(
        async (sid: string) => {
            if (didStartWebRtcRef.current) return;
            didStartWebRtcRef.current = true;

            setStatus("negotiating");

            // ?relay=1 forces the relay, to test it without needing a second network.
            const forceRelay = new URLSearchParams(window.location.search).get("relay") === "1";
            const pc = new RTCPeerConnection({
                iceServers: iceServersRef.current?.length
                    ? iceServersRef.current
                    : [{ urls: ["stun:stun.l.google.com:19302"] }],
                ...(forceRelay ? { iceTransportPolicy: "relay" as RTCIceTransportPolicy } : {}),
            });
            iceSeenRef.current = { local: {}, remote: {} };
            pcRef.current = pc;

            pc.onicecandidate = (ev2) => {
                {
                    const typ = /\btyp\s+(\w+)/.exec(String((ev2 as any)?.candidate?.candidate || ""))?.[1];
                    if (typ) iceSeenRef.current.local[typ] = (iceSeenRef.current.local[typ] || 0) + 1;
                }
                if (!ev2.candidate) return;

                const json = (ev2.candidate as any).toJSON ? (ev2.candidate as any).toJSON() : (ev2.candidate as any);
                let c = String(json?.candidate || "");

                const hasMid = json?.sdpMid != null;
                const hasMline = typeof json?.sdpMLineIndex === "number";
                if (!hasMid && !hasMline) return;

                if (c && !c.startsWith("candidate:")) c = `candidate:${c}`;

                sendWs({
                    type: "signal",
                    sessionId: sid,
                    data: {
                        candidate: c,
                        sdpMid: json?.sdpMid ?? null,
                        sdpMLineIndex: hasMline ? json.sdpMLineIndex : null,
                        usernameFragment: json?.usernameFragment ?? undefined,
                    },
                });
            };

            pc.oniceconnectionstatechange = () => {
                const ice = pc.iceConnectionState;
                const describe = (seen: Record<string, number>) =>
                    Object.entries(seen).map(([k, n]) => `${k}:${n}`).join(", ") || "none";

                // "disconnected" is often a brief network blip that recovers, so only failure is an error.
                if (ice === "failed") {
                    const { local, remote } = iceSeenRef.current;
                    setErr(`Could not connect to the device. This browser tried: ${describe(local)}. The device offered: ${describe(remote)}.`);
                } else if (ice === "connected" || ice === "completed") {
                    setErr((prev) => (prev?.startsWith("Could not connect to the device") ? null : prev));
                }
            };

            pc.onconnectionstatechange = () => {
                const st = pc.connectionState as "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
                if (st === "connected") setStatus("connected");
                else if (st === "disconnected" || st === "failed" || st === "closed") setStatus("disconnected");
                else setStatus((prev) => (prev === "connected" ? prev : "negotiating"));
            };

            // recvonly video
            let transceiver: RTCRtpTransceiver | null = null;
            try {
                transceiver = pc.addTransceiver("video", { direction: "recvonly" });
            } catch {
                transceiver = null;
            }

            // Prefer VP9 codec in the offer (fallback to VP8)
            if (transceiver && typeof (RTCRtpSender as any)?.getCapabilities === "function") {
                try {
                    const caps = (RTCRtpSender as any).getCapabilities("video");
                    const codecs = (caps?.codecs || []) as any[];

                    const vp9 = codecs.filter((c) => String(c?.mimeType || "").toLowerCase() === "video/vp9");
                    const vp8 = codecs.filter((c) => String(c?.mimeType || "").toLowerCase() === "video/vp8");

                    // H.264 is offered too, unless the customer's setting is VP8 only. It is only an offer: the device
                    // answers with H.264 only if it has proved it can encode it (hardware for Auto), and otherwise VP8.
                    // Receiver capabilities, because this side only decodes; only the form WebRTC's packetization needs.
                    let h264: any[] = [];
                    if (videoCodecSettingRef.current !== "vp8" && typeof (RTCRtpReceiver as any)?.getCapabilities === "function") {
                        const rx = ((RTCRtpReceiver as any).getCapabilities("video")?.codecs || []) as any[];
                        h264 = rx.filter(
                            (c) => String(c?.mimeType || "").toLowerCase() === "video/h264" && /packetization-mode=1/.test(String(c?.sdpFmtpLine || ""))
                        );
                    }

                    const ordered = [...vp9, ...vp8, ...h264];

                    if (ordered.length && typeof (transceiver as any).setCodecPreferences === "function") {
                        (transceiver as any).setCodecPreferences(ordered);
                    }
                } catch { }
            }

            pc.ontrack = (ev2) => {
                // Remote control needs the newest picture, not the smoothest playback. Browsers buffer
                // for smoothness unless told otherwise, and that buffer is felt as input lag.
                try {
                    (ev2.receiver as any).jitterBufferTarget = 0;
                    (ev2.receiver as any).playoutDelayHint = 0;
                } catch { }

                if (ev2.track?.kind === "video") {
                    setHasVideoTrack(true);
                    setLastTrackInfo(`video track id=${ev2.track.id} readyState=${ev2.track.readyState}`);
                } else if (ev2.track) {
                    setLastTrackInfo(`${ev2.track.kind} track id=${ev2.track.id} readyState=${ev2.track.readyState}`);
                }

                const stream = ev2.streams?.[0] || new MediaStream([ev2.track]);
                remoteStreamRef.current = stream;

                const v = videoRef.current;
                if (!v) return;

                const current = (v as any).srcObject as MediaStream | null;

                if (current !== stream) {
                    try {
                        (v as any).srcObject = stream;
                    } catch {
                        v.src = URL.createObjectURL(stream as any);
                    }
                }

                v.muted = true;
                v.playsInline = true;
                void v.play().catch(() => { });
            };

            // DataChannels:
            const termDc = pc.createDataChannel("rc.input", { ordered: true });
            const controlDc = pc.createDataChannel("rc.control", { ordered: true });
            const chatDc = pc.createDataChannel("rc.chat", { ordered: true });
            const clipDc = pc.createDataChannel("rc.clipboard", { ordered: true });
            moveDcRef.current = pc.createDataChannel("rc.move", { ordered: false });
            moveReadyRef.current = false;

            termDcRef.current = termDc;
            controlDcRef.current = controlDc;
            chatDcRef.current = chatDc;
            clipDcRef.current = clipDc;

            termDc.onopen = () => {
                appendTermOut("\r\n[ADG RMM] Terminal connected.\r\n");
                scrollTermToBottom();
            };
            termDc.onmessage = (ev2) => {
                const chunk = toText((ev2 as any).data);
                if (!chunk) return;
                appendTermOut(chunk);
            };

            controlDc.onopen = () => {
                dcSendJson(controlDc, { type: "focus" });
                dcSendJson(controlDc, { type: "cursor.local", enabled: true });
            };

            controlDc.onmessage = (ev2) => {
                const obj = safeJsonParse(toText((ev2 as any).data));
                if (obj?.type === "monitors" && Array.isArray(obj.list)) {
                    setMonitors(obj.list);
                    setActiveMonitor(Number(obj.active) || 0);
                } else if (obj?.type === "display.modes") {
                    applyDisplayModesRef.current(obj);
                } else if (obj?.type === "display.result") {
                    if (obj.ok === false && obj.message) setNotice(String(obj.message));
                } else if (obj?.type === "agent.caps") {
                    moveReadyRef.current = !!obj.move;
                    setInputLockCap(obj.inputLock === true);
                } else if (obj?.type === "input.lock.state") {
                    setInputLocked(obj.locked === true);
                    if (obj.ok === false && obj.message) setNotice(String(obj.message));
                } else if (obj?.type === "helper.stats") {
                    deviceStatsRef.current.captureMs = Number(obj.captureMs);
                    deviceStatsRef.current.captureMethod = obj.method ? String(obj.method) : undefined;
                } else if (obj?.type === "agent.stats") {
                    deviceStatsRef.current.encodeMs = Number(obj.encodeMs);
                    deviceStatsRef.current.queuedMs = Number(obj.queuedMs);
                    if (obj.codec) deviceStatsRef.current.codec = String(obj.codec);
                    deviceStatsRef.current.hardware = obj.hardware === true;
                } else if (obj?.type === "agent.codec") {
                    // Which codec the device is sending, and whether it fell back to VP8 after trying H.264.
                    deviceStatsRef.current.codec = obj.codec ? String(obj.codec) : undefined;
                    deviceStatsRef.current.hardware = obj.hardware === true;
                    if (obj.fellBack === true && obj.codec === "vp8") setNotice("This device could not keep up H.264 video, so it went back to VP8.");
                } else if (obj?.type === "cursor.shape") {
                    applyCursorShapeRef.current(obj);
                } else if (obj?.type === "cursor.pos") {
                    remotePointerRef.current = { x: Number(obj.x), y: Number(obj.y) };
                    placeOverlayRef.current();
                } else if (obj?.type === "capture.blocked") {
                    setCaptureBlocked(!!obj.blocked);
                    setCaptureBlockedDetail(obj.detail ? String(obj.detail) : null);
                } else if (obj?.type === "agent.notice") {
                    setNotice(String(obj.message || ""));
                }
            };

            chatDc.onmessage = (ev2) => {
                const t = String((ev2 as any).data || "");
                const obj = safeJsonParse(t);
                if (obj?.type === "chat.msg") addChat("remote", String(obj.text || ""));
                else if (obj?.type === "chat.error") addChat("system", String(obj.message || ""));
            };

            clipDc.onmessage = (ev2) => {
                const t = String((ev2 as any).data || "");
                const obj = safeJsonParse(t);
                if (obj?.type === "clipboard.set") {
                    const copied = String(obj.text || "");
                    setClipboardText(copied);
                    copyToLocalRef.current(copied);
                }
                else if (obj?.type === "clipboard.error") setNotice(String(obj.message || ""));
            };

            try {
                const offer = await pc.createOffer();

                // SDP munging for VP9 bitrate hints / bandwidth lines
                const munged = mungeSdpForVp9Quality(offer.sdp || "", {
                    minKbps: 300,
                    startKbps: 2200,
                    maxKbps: 9000,
                });

                await pc.setLocalDescription({ type: "offer", sdp: munged });

                sendWs({ type: "signal", sessionId: sid, data: { type: "offer", sdp: munged } });
                setStatus("negotiating");
            } catch (e: any) {
                setErr(`Failed to create offer: ${e?.message || e}`);
                setStatus("error");
                closeAll("Offer failed");
            }
        },
        [addChat, appendTermOut, closeAll, dcSendJson, scrollTermToBottom, sendWs]
    );

    const start = React.useCallback(async () => {
        if (!agentUuid) {
            setErr("This device has no agentUuid; remote console cannot start.");
            setStatus("error");
            return;
        }

        try {
            closeAll();
        } catch { }

        setErr(null);
        setStatus("creating-session");

        didStartWebRtcRef.current = false;
        setTermOut("");
        setTermLine("");
        setHasVideoTrack(false);
        setLastTrackInfo("");

        let created: { sessionId: string; sessionToken: string; wsPath?: string; iceServers?: RTCIceServer[] } | null = null;
        try {
            const createSession = () =>
                fetch(apiUrl("/api/remote-console/sessions"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ agentId: agentUuid }),
                });

            let res = await createSession();
            for (let i = 0; res.status === 409 && retryIfBusyRef.current && i < BUSY_RETRIES; i++) {
                await new Promise((resolve) => window.setTimeout(resolve, BUSY_RETRY_MS));
                res = await createSession();
            }
            retryIfBusyRef.current = false;

            const body = await res.json().catch(() => null);

            if (!res.ok) {
                throw new Error(body?.message ? String(body.message) : `Failed to create session (${res.status})`);
            }

            created = body;
            iceServersRef.current = body?.iceServers ?? null;
            setRecordingOn(body?.recording === true);
            setRecStatus(null);
        } catch (e: any) {
            setErr(e?.message || String(e));
            setStatus("error");
            return;
        }

        const sid = String(created?.sessionId || "");
        const stok = String(created?.sessionToken || "");
        if (!sid || !stok) {
            setErr("Invalid session response from backend.");
            setStatus("error");
            return;
        }

        setSessionId(sid);
        setSessionToken(stok);

        setStatus("connecting-ws");
        const wsUrl = buildWsUrl(created?.wsPath || "/ws/remote-console");
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            sendWs({ type: "hello", kind: "tech", sessionId: sid, sessionToken: stok });
            setStatus("waiting-for-agent");
        };

        ws.onmessage = async (ev) => {
            // A socket that was replaced must not be able to close the session that replaced it.
            if (wsRef.current !== ws) return;

            const msg = typeof ev.data === "string" ? safeJsonParse(ev.data) : null;
            if (!msg?.type) return;

            if (msg.type === "hello.error") {
                setErr(String(msg.message || "Unauthorized"));
                setStatus("error");
                closeAll(String(msg.message || "The server refused this session."));
                return;
            }

            if (msg.type === "session.closed") {
                // A device that refuses a session says why, such as its clock being wrong.
                closeAll(msg.reason === "agent_refused" && msg.message ? String(msg.message) : CLOSE_REASONS[String(msg.reason)] ?? "The session ended.");
                return;
            }

            if (msg.type === "session.waiting") {
                // The person at the device is being asked to allow the connection.
                setWaitingNote(String(msg.message || "Waiting for the person at the device to allow the connection…"));
                return;
            }

            if (msg.type === "session.ready") {
                videoCodecSettingRef.current = msg.videoCodec === "vp8" || msg.videoCodec === "h264" ? msg.videoCodec : "auto";
                askedVp8Ref.current = false;
                await startWebRtc(sid);
                return;
            }

            if (msg.type === "signal") {
                const data = msg.data;
                const pc = pcRef.current;
                if (!pc) return;

                if (data?.type === "answer" && data?.sdp) {
                    // The device can list candidates inside its answer as well as sending them one by one.
                    for (const m of String(data.sdp).matchAll(/a=candidate:.*?\btyp\s+(\w+)/g)) {
                        iceSeenRef.current.remote[m[1]] = (iceSeenRef.current.remote[m[1]] || 0) + 1;
                    }
                    try {
                        await pc.setRemoteDescription(data);

                        const pending = pendingIceRef.current.splice(0);
                        for (const c of pending) {
                            try {
                                await pc.addIceCandidate(c);
                            } catch { }
                        }
                    } catch (e: any) {
                        setErr(`Failed to apply answer: ${e?.message || e}`);
                        setStatus("error");
                    }
                    return;
                }

                if (typeof data?.candidate === "string") {
                    const cand: RTCIceCandidateInit = {
                        candidate: data.candidate,
                        sdpMid: data.sdpMid ?? null,
                        sdpMLineIndex: typeof data.sdpMLineIndex === "number" ? data.sdpMLineIndex : null,
                        usernameFragment: data.usernameFragment ?? undefined,
                    };

                    {
                        const typ = /\btyp\s+(\w+)/.exec(String(data?.candidate || ""))?.[1];
                        if (typ) iceSeenRef.current.remote[typ] = (iceSeenRef.current.remote[typ] || 0) + 1;
                    }

                    try {
                        if (!pc.remoteDescription) {
                            pendingIceRef.current.push(cand);
                            return;
                        }
                        await pc.addIceCandidate(cand);
                    } catch { }
                }
            }
        };

        ws.onerror = () => {
            setErr("WebSocket error");
            setStatus("error");
        };

        // Signaling goes quiet once video flows, and the proxy closes a quiet connection after about 90
        // seconds. The server treats that as the technician leaving, which would end a healthy session.
        const keepAlive = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }, SIGNALING_PING_MS);

        ws.onclose = () => {
            window.clearInterval(keepAlive);
            setStatus((prev) => (prev === "connected" || prev === "negotiating" ? "disconnected" : prev));
        };
    }, [agentUuid, closeAll, sendWs, startWebRtc]);

    const stop = React.useCallback(() => {
        const sid = sessionId;
        if (sid) {
            try {
                sendWs({ type: "signal", sessionId: sid, data: { type: "tech.hangup" } });
            } catch { }
        }
        closeAll();
        setErr(null);
    }, [closeAll, sendWs, sessionId]);

    // The server only says the session is ready once the agent is there, and an offline agent
    // never is, so without this the page would wait forever with no explanation.
    React.useEffect(() => {
        if (status !== "waiting-for-agent") return;
        const t = window.setTimeout(() => {
            setErr((prev) => prev || "The agent on this device has not answered. The device may be offline or restarting.");
        }, AGENT_WAIT_MS);
        return () => window.clearTimeout(t);
    }, [status]);

    // Keystrokes go nowhere until the viewer has focus, so it takes focus as soon as it connects.
    React.useEffect(() => {
        if (status === "connected") containerRef.current?.focus();
    }, [status]);

    React.useEffect(() => {
        if (status !== "connected") return;

        let stopped = false;

        const tick = async () => {
            const pc = pcRef.current;
            const v = videoRef.current;
            if (!pc || !v || stopped) return;

            try {
                const stats = await pc.getStats();
                let inbound: any = null;
                let codec: any = null;

                stats.forEach((r: any) => {
                    if (r.type === "inbound-rtp" && r.kind === "video") inbound = r;
                    if (r.type === "codec") {
                        // we'll select the codec associated with inbound-rtp later
                    }
                });

                if (inbound?.codecId) {
                    codec = stats.get(inbound.codecId);
                }

                const mime = codec?.mimeType || "";
                const fps = inbound?.framesPerSecond ?? inbound?.framesPerSecond ?? null;
                const kbps =
                    typeof inbound?.bytesReceived === "number" && typeof inbound?.timestamp === "number"
                        ? null
                        : null;

                // Best-effort bitrate estimate (bytes delta over time)
                // We'll store last values in closure
            } catch {
                // ignore
            }
        };

        let lastBytes = 0;
        let lastTs = 0;

        // Frames being decoded but never painted leave a black picture with healthy looking numbers.
        let video = videoRef.current as any;
        let painted = 0;
        let paintCallback = 0;
        const countPaint = () => {
            painted++;
            paintCallback = video?.requestVideoFrameCallback?.(countPaint) ?? 0;
        };
        paintCallback = video?.requestVideoFrameCallback?.(countPaint) ?? 0;
        let lastDecoded = 0;
        let lastPainted = 0;
        let stuckTicks = 0;
        let reattaches = 0;
        let noDecodeTicks = 0;

        const tick2 = async () => {
            const pc = pcRef.current;
            const v = videoRef.current;
            if (!pc || !v || stopped) return;

            try {
                const stats = await pc.getStats();
                let inbound: any = null;
                let codec: any = null;

                stats.forEach((r: any) => {
                    if (r.type === "inbound-rtp" && r.kind === "video") inbound = r;
                });

                if (inbound?.codecId) codec = stats.get(inbound.codecId);

                const decodedNow = typeof inbound?.framesDecoded === "number" ? inbound.framesDecoded : 0;
                if (v !== video) {
                    video = v;
                    paintCallback = video?.requestVideoFrameCallback?.(countPaint) ?? 0;
                }
                const own = v.ownerDocument;
                const canPaint = own.visibilityState === "visible" && (own.defaultView ?? window).getComputedStyle(v).opacity !== "0";
                if (paintCallback && canPaint && decodedNow > lastDecoded && painted === lastPainted) stuckTicks++;
                else stuckTicks = 0;
                lastDecoded = decodedNow;
                lastPainted = painted;
                // H.264 that the browser cannot show (no decoder, or one that refuses the stream): data arrives but nothing is
                // decoded. Asking the device for VP8 once keeps the session usable instead of showing a black picture.
                const isH264 = /h264/i.test(String(codec?.mimeType || ""));
                if (isH264 && decodedNow === 0 && (typeof inbound?.bytesReceived === "number" ? inbound.bytesReceived : 0) > 20000) noDecodeTicks++;
                else noDecodeTicks = 0;
                if (noDecodeTicks >= 5 && !askedVp8Ref.current) {
                    askedVp8Ref.current = true;
                    try {
                        controlDcRef.current?.send(JSON.stringify({ type: "video.codec", prefer: "vp8", reason: "this browser could not decode the H.264 video" }));
                    } catch { /* the channel is closed: nothing to ask */ }
                }

                if (stuckTicks >= 4 && reattaches < 3) {
                    stuckTicks = 0;
                    reattaches++;
                    const stream = (v as any).srcObject;
                    (v as any).srcObject = null;
                    (v as any).srcObject = stream;
                    void v.play().catch(() => { });
                }

                const nowBytes = typeof inbound?.bytesReceived === "number" ? inbound.bytesReceived : 0;
                const nowTs = typeof inbound?.timestamp === "number" ? inbound.timestamp : 0;

                let estKbps: number | null = null;
                if (lastTs && nowTs > lastTs && nowBytes >= lastBytes) {
                    const dtSec = (nowTs - lastTs) / 1000;
                    const dBytes = nowBytes - lastBytes;
                    estKbps = Math.round(((dBytes * 8) / dtSec) / 1000);
                }

                lastBytes = nowBytes;
                lastTs = nowTs;

                let route: string | null = null;
                let rttMs: number | null = null;
                stats.forEach((r: any) => {
                    if (r.type !== "transport" || !r.selectedCandidatePairId) return;
                    const pair = stats.get(r.selectedCandidatePairId);
                    if (typeof pair?.currentRoundTripTime === "number") rttMs = Math.round(pair.currentRoundTripTime * 1000);
                    const local = pair ? stats.get(pair.localCandidateId) : null;
                    const remote = pair ? stats.get(pair.remoteCandidateId) : null;
                    if (local || remote) route = local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
                });
                // Tell the server how this session reached the device (once it is known, then every minute with the video received so far), so relay use can be watched.
                if (route && sessionId && Date.now() - transportSentRef.current > (transportKnownRef.current ? 60_000 : 0)) {
                    transportSentRef.current = Date.now();
                    transportKnownRef.current = true;
                    void jfetch(`/api/remote-console/sessions/${encodeURIComponent(sessionId)}/transport`, { method: "POST", body: { relay: route === "relay", bytesReceived: nowBytes } }).catch(() => undefined);
                }
                const decodeMs = inbound?.framesDecoded && typeof inbound?.totalDecodeTime === "number" ? (1000 * inbound.totalDecodeTime) / inbound.framesDecoded : null;
                const device = deviceStatsRef.current;

                const mime = String(codec?.mimeType || "");
                const fps = typeof inbound?.framesPerSecond === "number" ? Math.round(inbound.framesPerSecond) : null;

                setLastTrackInfo(
                    [
                        route ? `route=${route}` : null,
                        rttMs != null ? `rtt=${rttMs}ms` : null,
                        device.captureMs != null ? `capture=${device.captureMs}ms${device.captureMethod ? ` (${device.captureMethod})` : ""}` : null,
                        device.codec ? `sending=${device.codec === "h264" ? (device.hardware ? "H.264 hardware" : "H.264 software") : "VP8"}` : null,
                        device.encodeMs != null ? `encode=${device.encodeMs}ms` : null,
                        device.queuedMs != null ? `queued=${device.queuedMs}ms` : null,
                        device.pointer ? `pointer=${device.pointer}` : "pointer=none-received",
                        decodeMs != null ? `decode=${decodeMs.toFixed(1)}ms` : null,
                        mime ? `codec=${mime}` : null,
                        v.videoWidth && v.videoHeight ? `rx=${v.videoWidth}x${v.videoHeight}` : null,
                        fps != null ? `fps≈${fps}` : null,
                        estKbps != null ? `kbps≈${estKbps}` : null,
                        inbound?.jitter != null ? `jitter=${Number(inbound.jitter).toFixed(3)}` : null,
                        typeof inbound?.framesDecoded === "number" ? `decoded=${inbound.framesDecoded}` : null,
                        typeof inbound?.keyFramesDecoded === "number" ? `keyframes=${inbound.keyFramesDecoded}` : null,
                        typeof inbound?.packetsLost === "number" ? `lost=${inbound.packetsLost}` : null,
                        typeof inbound?.pliCount === "number" ? `pli=${inbound.pliCount}` : null,
                        typeof inbound?.nackCount === "number" ? `nack=${inbound.nackCount}` : null,
                        typeof inbound?.freezeCount === "number" ? `freezes=${inbound.freezeCount}` : null,
                        inbound?.jitterBufferEmittedCount
                            ? `buffer=${Math.round((1000 * inbound.jitterBufferDelay) / inbound.jitterBufferEmittedCount)}ms`
                            : null,
                    ]
                        .filter(Boolean)
                        .join(" • ")
                );
            } catch {
                // ignore
            }
        };

        const id = window.setInterval(tick2, 1000);
        tick2().catch(() => { });

        return () => {
            stopped = true;
            window.clearInterval(id);
        };
    }, [status]);


    // Auto-connect when opened as popout with ?autoconnect=1
    React.useEffect(() => {
        if (!popout) return;
        if (!agentUuid) return;
        if (typeof window === "undefined") return;
        const sp = new URLSearchParams(window.location.search);
        const ac = sp.get("autoconnect");
        if (ac === "1" && status === "idle") {
            const t = window.setTimeout(() => {
                retryIfBusyRef.current = true;
                start().catch(() => { });
            }, 0);
            return () => window.clearTimeout(t);
        }
    }, [popout, start, status, agentUuid]);

    // --- Terminal input handling (line buffered) ---
    const submitLine = React.useCallback(() => {
        if (status !== "connected") return;

        const line = termLine;
        sendTerminalText(line + "\r\n");

        appendTermOut(line + "\r\n");
        setTermLine("");
    }, [appendTermOut, sendTerminalText, status, termLine]);

    const onTerminalKeyDown = React.useCallback(
        async (e: React.KeyboardEvent) => {
            if (status !== "connected") return;
            if (viewMode !== "terminal") return;

            if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) return;

            if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
                e.preventDefault();
                try {
                    const t = await clipboardOf(containerRef).readText();
                    if (t) setTermLine((p) => p + t.replace(/\r\n/g, "\n"));
                } catch { }
                return;
            }

            if (e.key === "Enter" || e.key === "NumpadEnter") {
                e.preventDefault();
                submitLine();
                return;
            }

            if (e.key === "Backspace") {
                e.preventDefault();
                setTermLine((p) => (p.length ? p.slice(0, -1) : p));
                return;
            }

            if (e.key === "Tab") {
                e.preventDefault();
                setTermLine((p) => p + "\t");
                return;
            }

            if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key && e.key.length === 1) {
                e.preventDefault();
                setTermLine((p) => p + e.key);
            }
        },
        [status, submitLine, viewMode]
    );

    // --- Desktop control input (mouse/kb) ---
    const modsFrom = React.useCallback((e: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean }) => {
        return {
            alt: !!e.altKey,
            ctrl: !!e.ctrlKey,
            shift: !!e.shiftKey,
            meta: !!e.metaKey,
        };
    }, []);

    const lastMoveSentAtRef = React.useRef<number>(0);

    const onMouseMove = React.useCallback(
        (e: React.MouseEvent) => {
            if (status !== "connected") return;
            if (viewMode !== "desktop") return;

            const now = Date.now();
            if (now - lastMoveSentAtRef.current < 15) return;
            const moveChannel = moveReadyRef.current && moveDcRef.current?.readyState === "open" ? moveDcRef.current : controlDcRef.current;
            if ((moveChannel?.bufferedAmount ?? 0) > MAX_QUEUED_MOVE_BYTES) return;
            lastMoveSentAtRef.current = now;

            const p = computeVideoNormXY(e.clientX, e.clientY);
            if (!p) return;
            lastPointRef.current = p;

            sendControl({
                type: "mouse.move",
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
                dw: p.dw,
                dh: p.dh,
                cx: p.cx,
                cy: p.cy,
                ax: p.ax,
                ay: p.ay,
                mods: modsFrom(e),
            });

        },
        [computeVideoNormXY, modsFrom, sendControl, status, viewMode]
    );

    const onMouseDown = React.useCallback(
        (e: React.MouseEvent) => {
            if (status !== "connected") return;
            if (viewMode !== "desktop") return;

            e.preventDefault();

            const p = computeVideoNormXY(e.clientX, e.clientY);
            if (!p) return;

            containerRef.current?.focus();

            lastPointRef.current = p;
            pressedRef.current.add(e.button);

            sendControl({
                type: "mouse.down",
                button: e.button,
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
                dw: p.dw,
                dh: p.dh,
                cx: p.cx,
                cy: p.cy,
                ax: p.ax,
                ay: p.ay,
                mods: modsFrom(e),
            });

        },
        [computeVideoNormXY, modsFrom, sendControl, status, viewMode]
    );

    const onMouseUp = React.useCallback(
        (e: React.MouseEvent) => {
            if (status !== "connected") return;
            if (viewMode !== "desktop") return;

            e.preventDefault();

            const p = computeVideoNormXY(e.clientX, e.clientY);
            if (!p) return;
            pressedRef.current.delete(e.button);

            sendControl({
                type: "mouse.up",
                button: e.button,
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
                dw: p.dw,
                dh: p.dh,
                cx: p.cx,
                cy: p.cy,
                ax: p.ax,
                ay: p.ay,
                mods: modsFrom(e),
            });

        },
        [computeVideoNormXY, modsFrom, sendControl, status, viewMode]
    );

    const releaseButton = React.useCallback(
        (button: number, p: NonNullable<typeof lastPointRef.current>) => {
            pressedRef.current.delete(button);
            sendControl({
                type: "mouse.up",
                button,
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
                dw: p.dw,
                dh: p.dh,
                cx: p.cx,
                cy: p.cy,
                ax: p.ax,
                ay: p.ay,
                mods: { alt: false, ctrl: false, shift: false, meta: false },
            });
        },
        [sendControl]
    );

    // A drag that ends outside the picture still has to let go on the device.
    React.useEffect(() => {
        const onUp = (e: MouseEvent) => {
            if (!pressedRef.current.has(e.button)) return;
            const p = computeVideoNormXY(e.clientX, e.clientY);
            if (p) releaseButton(e.button, p);
        };
        window.addEventListener("mouseup", onUp);
        const popup = portalWindowRef.current;
        popup?.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mouseup", onUp);
            popup?.removeEventListener("mouseup", onUp);
        };
    }, [computeVideoNormXY, releaseButton]);

    // These never reach the page, because the technician's own system acts on them first.
    const sendCombo = React.useCallback(
        (mods: Partial<{ alt: boolean; ctrl: boolean; shift: boolean; meta: boolean }>, code: string) => {
            const none = { alt: false, ctrl: false, shift: false, meta: false };
            const held = { ...none, ...mods };
            sendControl({ type: "key.down", key: "", code, repeat: false, mods: held });
            sendControl({ type: "key.up", key: "", code, repeat: false, mods: held });
            sendControl({ type: "key.up", key: "", code: "", repeat: false, mods: none });
            containerRef.current?.focus();
        },
        [sendControl]
    );

    const selectMonitor = React.useCallback(
        (index: number) => {
            dcSendJson(controlDcRef.current, { type: "monitor.select", index });
            containerRef.current?.focus();
        },
        [dcSendJson]
    );

    // IMPORTANT: do NOT use React's onWheel here.
    // React attaches wheel listeners as "passive" in many cases, so preventDefault causes console spam.
    // We attach a native wheel listener with { passive:false } in a useEffect below.

    // A browser only lets a focused page write the clipboard, so a refused write waits for focus.
    const lastClipboardTextRef = React.useRef<string | null>(null);
    const pendingCopyRef = React.useRef<string | null>(null);
    const copyToLocalRef = React.useRef<(text: string) => void>(() => { });
    const flushCopiedTextRef = React.useRef<() => void>(() => { });
    copyToLocalRef.current = (text: string) => {
        // The device reports what was pasted into it too, and that must not flatten what is copied here.
        if (!text || text === lastClipboardTextRef.current) return;
        lastClipboardTextRef.current = text;
        pendingCopyRef.current = text;
        flushCopiedTextRef.current();
    };
    flushCopiedTextRef.current = () => {
        const text = pendingCopyRef.current;
        if (!text) return;
        clipboardOf(containerRef)?.writeText(text).then(() => {
            if (pendingCopyRef.current === text) pendingCopyRef.current = null;
        }).catch(() => { });
    };

    const heldPasteRef = React.useRef<{ down: ControlMsg; up: ControlMsg | null; timer: number } | null>(null);

    const releaseHeldPaste = React.useCallback(() => {
        const held = heldPasteRef.current;
        if (!held) return;
        heldPasteRef.current = null;
        window.clearTimeout(held.timer);
        sendControl(held.down);
        if (held.up) sendControl(held.up);
    }, [sendControl]);

    const onPaste = React.useCallback(
        (e: React.ClipboardEvent) => {
            if (status !== "connected" || viewMode !== "desktop") return;
            e.preventDefault();

            const text = e.clipboardData?.getData("text/plain") ?? "";
            const dc = clipDcRef.current;
            if (!text || !dc || dc.readyState !== "open") {
                releaseHeldPaste();
                return;
            }

            lastClipboardTextRef.current = text;
            dc.send(JSON.stringify({ type: "clipboard.set", text }));

            // The text and the keystroke take separate paths on the device, so the text gets a head start.
            const held = heldPasteRef.current;
            if (held) {
                window.clearTimeout(held.timer);
                held.timer = window.setTimeout(releaseHeldPaste, PASTE_HEAD_START_MS);
            }
        },
        [releaseHeldPaste, status, viewMode]
    );

    const onKeyDownCapture = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (status !== "connected") return;
            if (viewMode !== "desktop") return;

            const message: ControlMsg = {
                type: "key.down",
                key: e.key,
                code: e.code,
                repeat: e.repeat,
                mods: modsFrom(e),
            };

            // Left to the browser, so that its paste event fires. Without text, the key still goes through.
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyV" && !e.repeat) {
                releaseHeldPaste();
                heldPasteRef.current = { down: message, up: null, timer: window.setTimeout(releaseHeldPaste, PASTE_WAIT_MS) };
                return;
            }

            e.preventDefault();
            sendControl(message);
        },
        [modsFrom, releaseHeldPaste, sendControl, status, viewMode]
    );

    const onKeyUpCapture = React.useCallback(
        (e: React.KeyboardEvent) => {
            if (status !== "connected") return;
            if (viewMode !== "desktop") return;

            e.preventDefault();
            const message: ControlMsg = {
                type: "key.up",
                key: e.key,
                code: e.code,
                repeat: e.repeat,
                mods: modsFrom(e),
            };

            // Keys let go while the paste is held are sent after it, so they stay in order.
            const held = heldPasteRef.current;
            if (held && e.code === "KeyV") {
                held.up = message;
                return;
            }
            if (held) releaseHeldPaste();

            sendControl(message);
        },
        [modsFrom, releaseHeldPaste, sendControl, status, viewMode]
    );

    const onFocus = React.useCallback(() => {
        if (status !== "connected") return;
        if (viewMode !== "desktop") return;
        sendControl({ type: "focus" });
        flushCopiedTextRef.current();
    }, [sendControl, status, viewMode]);

    const onBlur = React.useCallback(() => {
        if (status !== "connected") return;
        if (viewMode !== "desktop") return;
        sendControl({ type: "blur" });

        const p = lastPointRef.current;
        if (p) Array.from(pressedRef.current).forEach((button) => releaseButton(button, p));
    }, [releaseButton, sendControl, status, viewMode, portalTarget]);

    // Native wheel listener (non-passive) to stop the console spam + prevent scroll while controlling desktop
    React.useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const onWheelNative = (e: WheelEvent) => {
            if (status !== "connected") return;
            if (viewMode !== "desktop") return;

            // stop browser scroll/zoom inside the remote viewport
            e.preventDefault();

            sendControl({
                type: "mouse.wheel",
                dx: e.deltaX,
                dy: e.deltaY,
                mode: e.deltaMode === 0 ? "pixel" : e.deltaMode === 1 ? "line" : "page",
                mods: {
                    alt: !!(e as any).altKey,
                    ctrl: !!(e as any).ctrlKey,
                    shift: !!(e as any).shiftKey,
                    meta: !!(e as any).metaKey,
                },
            });

        };

        el.addEventListener("wheel", onWheelNative, { passive: false });

        return () => {
            try {
                el.removeEventListener("wheel", onWheelNative as any);
            } catch { }
        };
    }, [sendControl, status, viewMode, portalTarget, poppedOut]);

    const sendChat = React.useCallback(() => {
        const t = chatText.trim();
        if (!t) return;

        addChat("me", t);
        setChatText("");

        const dc = chatDcRef.current;
        try {
            if (!dc || dc.readyState !== "open") throw new Error("closed");
            dc.send(JSON.stringify({ type: "chat.msg", text: t }));
        } catch {
            addChat("system", "That message was not sent.");
        }
    }, [addChat, chatText]);

    const pushClipboardToRemote = React.useCallback(async () => {
        let text = clipboardText;
        try {
            if (clipboardOf(containerRef)?.readText) {
                text = await clipboardOf(containerRef).readText();
                setClipboardText(text);
            }
        } catch { }

        const dc = clipDcRef.current;
        if (!dc || dc.readyState !== "open") return;
        try {
            dc.send(JSON.stringify({ type: "clipboard.set", text: String(text || "") }));
        } catch {
            setNotice("That clipboard text is too large to send to the device.");
        }
    }, [clipboardText]);

    const pullClipboardFromRemote = React.useCallback(() => {
        const dc = clipDcRef.current;
        if (!dc || dc.readyState !== "open") return;
        try {
            dc.send(JSON.stringify({ type: "clipboard.get" }));
        } catch { }
    }, []);

    const copyLocalClipboardBox = React.useCallback(async () => {
        try {
            await clipboardOf(containerRef).writeText(clipboardText || "");
        } catch { }
    }, [clipboardText]);

    // Moves the session to its own window. Only one technician session can exist per device, so
    // one running here ends first, and the new window waits for the server to release the device.
    const openPopout = React.useCallback(() => {
        let w: Window | null = null;

        // A connection cannot move between windows, but the picture can. This page keeps the session.
        if (status === "connected") {
            try {
                w = window.open("", popoutWindowName(deviceId), "popup,width=1400,height=900");
            } catch { }
            if (!w) {
                setNotice("Your browser blocked the new window. Allow pop-ups for this site, then try again.");
                return;
            }

            const doc = w.document;
            doc.title = "Remote Console";
            doc.documentElement.className = document.documentElement.className;
            doc.documentElement.style.cssText = document.documentElement.style.cssText;
            doc.body.className = document.body.className;
            doc.head.querySelectorAll("link, style").forEach((n) => n.remove());
            document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
                const copy = node.cloneNode(true) as HTMLElement;
                if (copy instanceof HTMLLinkElement || (node as HTMLLinkElement).href) (copy as HTMLLinkElement).href = (node as HTMLLinkElement).href;
                doc.head.appendChild(doc.importNode(copy, true));
            });
            const host = doc.createElement("div");
            doc.body.replaceChildren(host);

            portalWindowRef.current = w;
            portalHandoverUrlRef.current = buildPopoutUrl(true);
            popoutWindowRef.current = w;
            popoutSeenAtRef.current = 0;
            setPortalTarget(host);
            setPoppedOut(true);
            setNotice(null);
            try { w.focus(); } catch { }
            return;
        }

        try {
            // Not connected yet, so the new window waits for the technician to press Connect.
            w = window.open(buildPopoutUrl(false), popoutWindowName(deviceId), "popup,width=1400,height=900");
        } catch { }

        if (!w) {
            setNotice("Your browser blocked the new window. Allow pop-ups for this site, then try again.");
            return;
        }

        try {
            // The pop-out has no need to reach back into this page. This page keeps its own handle.
            w.opener = null;
            w.focus();
        } catch { }

        popoutWindowRef.current = w;
        popoutSeenAtRef.current = Date.now() + POPOUT_LOAD_GRACE_MS;
        setPoppedOut(true);
        setNotice(null);

        if (status !== "idle" && status !== "disconnected" && status !== "error") stop();
    }, [deviceId, status, stop]);

    const focusPopout = React.useCallback(() => {
        try {
            const existing = popoutWindowRef.current;
            if (existing && !existing.closed) existing.focus();
            // After a reload this page has no handle, but the window can still be found by its name.
            else window.open("", popoutWindowName(deviceId))?.focus();
        } catch { }
    }, [deviceId]);

    // The video element is a new one after moving between windows, and needs the stream again.
    React.useEffect(() => {
        const v = videoRef.current;
        const stream = remoteStreamRef.current;
        if (!v || !stream || (v as any).srcObject === stream) return;
        (v as any).srcObject = stream;
        v.muted = true;
        void v.play().catch(() => { });
    }, [portalTarget, poppedOut]);

    // Leaving this page ends its session. A pop-out in use reconnects by itself rather than going blank.
    React.useEffect(() => {
        const handOver = () => {
            const w = portalWindowRef.current;
            const url = portalHandoverUrlRef.current;
            if (!w || w.closed || !url) return;
            try {
                w.location.replace(url);
            } catch { }
        };
        window.addEventListener("pagehide", handOver);
        return () => {
            window.removeEventListener("pagehide", handOver);
            handOver();
        };
    }, []);

    // Closes the pop-out, which ends its session, and connects here instead.
    const bringBackHere = React.useCallback(() => {
        // The session never left this page, so the window just closes and the picture comes back.
        if (portalWindowRef.current) {
            try { portalWindowRef.current.close(); } catch { }
            portalWindowRef.current = null;
            popoutWindowRef.current = null;
            setPortalTarget(null);
            setPoppedOut(false);
            return;
        }

        popoutChannelRef.current?.postMessage({ type: "close" });
        try {
            popoutWindowRef.current?.close();
        } catch { }
        popoutWindowRef.current = null;
        setPoppedOut(false);
        retryIfBusyRef.current = true;
        void start();
    }, [start]);

    // The two windows find each other through this channel, which also survives a reload of this page.
    React.useEffect(() => {
        if (typeof BroadcastChannel === "undefined") return;

        const channel = new BroadcastChannel(popoutChannelName(deviceId));
        popoutChannelRef.current = channel;

        if (popout) {
            const announce = () => channel.postMessage({ type: "alive" });
            announce();
            const timer = window.setInterval(announce, POPOUT_ALIVE_MS);
            const onGone = () => channel.postMessage({ type: "closed" });
            window.addEventListener("pagehide", onGone);
            channel.onmessage = (e) => {
                if (e.data?.type === "ping") announce();
                if (e.data?.type === "close") window.close();
            };
            return () => {
                window.clearInterval(timer);
                window.removeEventListener("pagehide", onGone);
                channel.close();
                popoutChannelRef.current = null;
            };
        }

        channel.onmessage = (e) => {
            if (e.data?.type === "alive") {
                popoutSeenAtRef.current = Math.max(popoutSeenAtRef.current, Date.now());
                setPoppedOut(true);
            } else if (e.data?.type === "closed") {
                popoutSeenAtRef.current = 0;
                popoutWindowRef.current = null;
                setPoppedOut(false);
            }
        };
        channel.postMessage({ type: "ping" });

        const watch = window.setInterval(() => {
            const handle = popoutWindowRef.current;
            const closed = !!handle && handle.closed;
            const silent = Date.now() - popoutSeenAtRef.current > POPOUT_GONE_MS;
            if (closed || (popoutSeenAtRef.current !== 0 && silent)) {
                popoutSeenAtRef.current = 0;
                popoutWindowRef.current = null;
                portalWindowRef.current = null;
                setPortalTarget(null);
                setPoppedOut(false);
            }
        }, 1000);

        return () => {
            window.clearInterval(watch);
            channel.close();
            popoutChannelRef.current = null;
        };
    }, [deviceId, popout]);

    React.useEffect(() => {
        if (process.env.NODE_ENV !== "development") return;

        (window as any).__rc = {
            get pc() {
                return pcRef.current;
            },
            get ws() {
                return wsRef.current;
            },
            get termDc() {
                return termDcRef.current;
            },
            get controlDc() {
                return controlDcRef.current;
            },
            get chatDc() {
                return chatDcRef.current;
            },
            get clipDc() {
                return clipDcRef.current;
            },
        };

        return () => {
            try {
                delete (window as any).__rc;
            } catch { }
        };
    }, []);

    React.useEffect(() => {
        return () => {
            try {
                closeAll("Unmount");
            } catch { }
        };
    }, [closeAll]);

    // Recording: when the server says this session is recorded, the picture is recorded here and uploaded as it goes.
    // If it cannot start, the session ends, because the person at the device was told it is recorded.
    React.useEffect(() => {
        const live = status === "connected" && hasVideoTrack && recordingOn && !!sessionId;
        const cur = recorderRef.current;
        if (!live) {
            if (cur && (status === "disconnected" || status === "error" || status === "idle" || status === "creating-session")) {
                recorderRef.current = null;
                void cur.rec.stop();
            }
            return;
        }
        if (cur && cur.sid === sessionId) return;
        const stream = remoteStreamRef.current;
        if (!stream) return;
        const rec = new SessionRecorder(sessionId!, setRecStatus);
        recorderRef.current = { sid: sessionId!, rec };
        rec.start(stream).catch((e: any) => {
            recorderRef.current = null;
            setRecStatus({ state: "failed", startedAt: Date.now(), uploadedBytes: 0, pendingBytes: 0, message: String(e?.message || "Recording could not start.") });
            closeAll(`This customer's sessions are recorded, and the recording could not start, so the session was ended. ${String(e?.message || "")}`.trim());
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, hasVideoTrack, recordingOn, sessionId]);
    React.useEffect(
        () => () => {
            const cur = recorderRef.current;
            recorderRef.current = null;
            if (cur) void cur.rec.stop();
        },
        []
    );
    React.useEffect(() => {
        if (!recStatus || recStatus.state !== "recording") return;
        const t = window.setInterval(() => setRecTick((n) => n + 1), 1000);
        return () => window.clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recStatus?.state]);

    void recTick;
    const recElapsed = recStatus ? Math.max(0, Math.floor((Date.now() - recStatus.startedAt) / 1000)) : 0;
    const recClock = `${String(Math.floor(recElapsed / 60)).padStart(2, "0")}:${String(recElapsed % 60).padStart(2, "0")}`;
    const recordingBadge =
        recordingOn && (status === "connected" || recStatus) ? (
            <span
                data-testid="recording-badge"
                className={[
                    "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-white",
                    recStatus?.state === "failed" ? "bg-amber-600" : "bg-red-600",
                ].join(" ")}
                title={recStatus?.message ?? "This session is being recorded. The person at the device has been told."}
            >
                <span className={["inline-block h-2 w-2 rounded-full bg-white", recStatus?.state === "recording" ? "animate-pulse" : ""].join(" ")} />
                {recStatus?.state === "failed" ? "Recording stopped" : recStatus?.state === "stopping" ? "Saving recording…" : "Recording"}
                {recStatus && recStatus.state === "recording" ? <span className="font-normal opacity-90">{recClock}</span> : null}
                {recStatus?.message && recStatus.state === "recording" ? <span className="font-normal opacity-90">· {recStatus.message}</span> : null}
            </span>
        ) : null;
    const recordingOverlay = recordingBadge ? <div className="pointer-events-none absolute right-3 top-3 z-10">{recordingBadge}</div> : null;
    const recordingProblem =
        recStatus?.state === "failed" && recStatus.message ? (
            <div className="mx-3 mb-2 mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
                {recStatus.message}
            </div>
        ) : null;

    const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const filesDrop = {
        onDragEnter: (e: React.DragEvent) => {
            if (status !== "connected" || !hasFiles(e)) return;
            e.preventDefault();
            setDragOver(true);
        },
        onDragOver: (e: React.DragEvent) => {
            if (status !== "connected" || !hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (e: React.DragEvent) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDragOver(false);
        },
        onDrop: (e: React.DragEvent) => {
            setDragOver(false);
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (status !== "connected" || !files.length) return;
            e.preventDefault();
            setFilesOpen(true);
            filesRef.current?.uploadFiles(files);
        },
    };
    const dropOverlay = dragOver ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/20 ring-2 ring-inset ring-primary" data-testid="drop-overlay">
            <div className="rounded-md bg-background px-4 py-2 text-sm font-medium shadow">Drop to upload to the folder open in Files (50 MB per file)</div>
        </div>
    ) : null;
    const filesToggleButton = (
        <Button type="button" variant={filesOpen ? "secondary" : "outline"} size="sm" className="gap-2" onClick={() => setFilesOpen((v) => !v)} title={filesOpen ? "Hide files" : "Browse the device's files and send files to it"}>
            <FolderOpen className="h-4 w-4" />
            Files
        </Button>
    );
    const filesPanel = <ConsoleFilesPanel ref={filesRef} deviceId={deviceId} connected={status === "connected"} open={filesOpen} onClose={() => setFilesOpen(false)} />;
    const filesColumn = filesOpen ? (
        <div className="w-[340px] max-w-[40vw] min-w-[280px] shrink-0 border-l bg-background flex flex-col min-h-0" {...filesDrop}>
            {filesPanel}
        </div>
    ) : (
        <div className="hidden">{filesPanel}</div>
    );

    const isBusy =
        status === "creating-session" ||
        status === "connecting-ws" ||
        status === "waiting-for-agent" ||
        status === "negotiating";

    const showNotConnectedOverlay = status !== "connected";
    const showNoVideoWarning = status === "connected" && viewMode === "desktop" && !hasVideoTrack;

    const displayControls = status === "connected" && viewMode === "desktop" ? (
        <div className="flex items-center gap-1">
            {monitors.length > 1
                ? monitors.map((m, i) => (
                    <Button
                        key={i}
                        type="button"
                        variant={i === activeMonitor ? "default" : "outline"}
                        size="sm"
                        onClick={() => selectMonitor(i)}
                        title={`${m.w} x ${m.h}${m.primary ? ", main display" : ""}`}
                    >
                        Display {i + 1}
                    </Button>
                ))
                : null}
            {displayModesSeen && displayModes.length <= 1 ? (
                <span
                    className="text-xs text-muted-foreground"
                    data-testid="screen-size-note"
                    title="A virtual machine with a basic display adapter often offers a single size. A VirtIO or QXL display driver, or a larger resolution in the machine's firmware (UEFI) menu, adds more."
                >
                    Screen size cannot be changed: this device offers only {displayModes[0] ?? displayCurrent ? `${(displayModes[0] ?? displayCurrent)!.w} × ${(displayModes[0] ?? displayCurrent)!.h}` : "one size"}.
                </span>
            ) : null}
            {displayModes.length > 1 ? (
                <select
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={displayCurrent ? `${displayCurrent.w}x${displayCurrent.h}` : "keep"}
                    onChange={(e) => chooseScreenSize(e.target.value)}
                    title="Change the size of the device's screen. Your choice is remembered for this device. A screen with someone at it will change for them too."
                >
                    {displayCurrent && !displayModes.some((m) => m.w === displayCurrent.w && m.h === displayCurrent.h) ? (
                        <option value={`${displayCurrent.w}x${displayCurrent.h}`}>
                            {displayCurrent.w} × {displayCurrent.h}
                        </option>
                    ) : null}
                    {displayModes.map((m) => (
                        <option key={`${m.w}x${m.h}`} value={`${m.w}x${m.h}`}>
                            {m.w} × {m.h}
                        </option>
                    ))}
                    <option value="keep">Leave as is</option>
                </select>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => sendControl({ type: "keys.sas" })} title="Press Ctrl+Alt+Del on the device, for a sign-in or lock screen that asks for it">
                Ctrl+Alt+Del
            </Button>
            {inputLockCap ? (
                <Button
                    type="button"
                    variant={inputLocked ? "destructive" : "outline"}
                    size="sm"
                    className="gap-1.5"
                    aria-pressed={inputLocked}
                    data-testid="lock-user-input"
                    onClick={() => sendControl({ type: "input.lock", locked: !inputLocked })}
                    title={inputLocked ? "Give the person at the device their keyboard and mouse back. It also happens by itself when you disconnect." : "Lock the keyboard and mouse of the person at the device so they cannot interrupt you. It lets go by itself when you disconnect. They can still press Ctrl+Alt+Del."}
                >
                    {inputLocked ? <LockOpen className="h-4 w-4" aria-hidden="true" /> : <Lock className="h-4 w-4" aria-hidden="true" />}
                    {inputLocked ? "Unlock user input" : "Lock user input"}
                </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => sendCombo({ meta: true }, "")} title="Press the Windows key on the device">
                Win
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => sendCombo({ alt: true }, "Tab")} title="Press Alt+Tab on the device">
                Alt+Tab
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => sendCombo({ ctrl: true, shift: true }, "Escape")} title="Open Task Manager on the device">
                Task Manager
            </Button>
        </div>
    ) : null;

    const noticeBanner = notice || captureBlocked || (waitingNote && !hasVideoTrack) ? (
        <div className="mx-3 mb-2 mt-2 space-y-1 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
            {waitingNote && !hasVideoTrack ? <div>{waitingNote}</div> : null}
            {captureBlocked ? (
                <div>
                    The device is showing a sign-in screen, lock screen or administrator prompt that Remote Console cannot reach
                    right now. The picture will return when it is dismissed at the device.
                    {captureBlockedDetail ? <div className="mt-1 text-xs opacity-80">Details: {captureBlockedDetail}</div> : null}
                </div>
            ) : null}
            {notice ? <div>{notice}</div> : null}
        </div>
    ) : null;

    const renderChatSender = (m: ChatMsg) => (m.from === "me" ? "You" : m.from === "remote" ? "Person at the device" : "ADG RMM");

    // Header buttons shared by both layouts.
    const chatToggleButton = (
        <Button
            type="button"
            variant={chatOpen ? "secondary" : "outline"}
            size="sm"
            className="relative gap-2"
            onClick={toggleChat}
            title={chatOpen ? "Hide chat" : "Show chat"}
        >
            <MessageSquare className="h-4 w-4" />
            Chat
            {!chatOpen && unreadChat > 0 ? (
                <span className="absolute -right-1 -top-1 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold leading-4 text-white">
                    {unreadChat > 9 ? "9+" : unreadChat}
                </span>
            ) : null}
        </Button>
    );

    const statsToggleButton = (
        <Button
            type="button"
            variant={showStats ? "secondary" : "ghost"}
            size="icon"
            onClick={toggleStats}
            title={showStats ? "Hide connection details" : "Show connection details (diagnostics)"}
            aria-pressed={showStats}
        >
            <Activity className="h-4 w-4" />
        </Button>
    );

    const pointerOverlay =
        overlayCursor && !pointerInside && status === "connected" && viewMode === "desktop" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                ref={(el) => {
                    overlayRef.current = el;
                    placeOverlayRef.current();
                }}
                src={overlayCursor.url}
                alt=""
                className="pointer-events-none absolute left-0 top-0"
            />
        ) : null;

    // --- Popout layout ---
    const popoutView = (
            <div className="h-screen w-full flex flex-col min-h-0">
                <div className="shrink-0 border-b bg-background/90 backdrop-blur">
                    <div className="h-12 px-3 flex items-center justify-between gap-2">
                        <div className="min-w-0 flex items-center gap-2">
                            <div className="text-sm font-semibold truncate">Remote Console</div>
                            <span className="hidden sm:inline rounded-md border px-2 py-1 text-xs text-muted-foreground">
                                {status === "connected" ? "connected" : status}
                            </span>
                            {sessionId ? (
                                <span className="hidden md:inline rounded-md border px-2 py-1 text-xs text-muted-foreground">
                                    <span className="text-foreground font-medium">Session</span>{" "}
                                    <code className="text-[11px]">{sessionId}</code>
                                </span>
                            ) : null}
                            {status === "connected" ? (
                                <span className="hidden lg:inline rounded-md border px-2 py-1 text-xs text-muted-foreground">
                                    Video:{" "}
                                    <span className={hasVideoTrack ? "text-foreground font-medium" : "text-yellow-700 font-medium"}>
                                        {hasVideoTrack ? "track" : "no track"}
                                    </span>
                                </span>
                            ) : null}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                            {displayControls}
                            <div className="hidden sm:flex rounded-md border overflow-hidden">
                                <Button
                                    type="button"
                                    variant={viewMode === "desktop" ? "default" : "ghost"}
                                    size="sm"
                                    className="rounded-none gap-2"
                                    onClick={() => setViewMode("desktop")}
                                    disabled={status !== "connected"}
                                    title="Desktop"
                                >
                                    <Monitor className="h-4 w-4" />
                                    Desktop
                                </Button>
                                <Button
                                    type="button"
                                    variant={viewMode === "terminal" ? "default" : "ghost"}
                                    size="sm"
                                    className="rounded-none gap-2"
                                    onClick={() => setViewMode("terminal")}
                                    disabled={status !== "connected"}
                                    title="Terminal"
                                >
                                    <Terminal className="h-4 w-4" />
                                    Terminal
                                </Button>
                            </div>

                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setVideoFit((p) => (p === "contain" ? "cover" : "contain"))}
                                disabled={viewMode !== "desktop"}
                                title="Toggle fit mode"
                            >
                                Fit: {videoFit}
                            </Button>

                            {recordingBadge}
                            {filesToggleButton}
                            {chatToggleButton}
                            {statsToggleButton}

                            {status !== "connected" ? (
                                <Button
                                    variant="default"
                                    size="sm"
                                    onClick={start}
                                    disabled={!canStart || isBusy}
                                    className="gap-2"
                                    title={!canStart ? "Missing agentUuid on device" : "Start remote console"}
                                >
                                    <PlugZap className="h-4 w-4" />
                                    Connect
                                </Button>
                            ) : (
                                <Button variant="destructive" size="sm" onClick={stop} className="gap-2" title="Stop session">
                                    <Power className="h-4 w-4" />
                                    Disconnect
                                </Button>
                            )}

                            <Button variant="outline" size="icon" onClick={() => window.close()} title="Close window">
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    {noticeBanner}
                    {recordingProblem}
                    {err ? (
                        <div className="px-3 pb-2">
                            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{err}</div>
                        </div>
                    ) : null}
                </div>

                <div className="flex-1 min-h-0 flex">
                    <div className="flex-1 min-h-0 p-2">
                        <div
                            ref={containerRef}
{...filesDrop}
                            className="relative h-full w-full rounded-lg border bg-black overflow-hidden outline-none touch-none"
                            style={{ touchAction: "none", cursor: viewMode === "desktop" && pointerCursor ? pointerCursor : undefined }}
                            onPointerEnter={() => setPointerInside(true)}
                            onPointerLeave={() => setPointerInside(false)}
                            tabIndex={0}
                            onMouseMove={onMouseMove}
                            onMouseDown={onMouseDown}
                            onMouseUp={onMouseUp}
                            onKeyDown={viewMode === "terminal" ? onTerminalKeyDown : onKeyDownCapture}
                            onKeyUp={viewMode === "desktop" ? onKeyUpCapture : undefined}
                            onPaste={onPaste}
                            onFocus={onFocus}
                            onBlur={onBlur}
                            onClick={() => containerRef.current?.focus()}
                            onContextMenu={(e) => e.preventDefault()}
                        >
                            <video
                                ref={videoRef}
                                className={[
                                    "absolute inset-0 h-full w-full",
                                    videoFit === "contain" ? "object-contain" : "object-cover",
                                    viewMode === "desktop" && status === "connected" ? "opacity-100" : "opacity-0 pointer-events-none",
                                ].join(" ")}
                                autoPlay
                                playsInline
                                muted
                            />
                            {pointerOverlay}
{recordingOverlay}
{dropOverlay}

                            {showNotConnectedOverlay ? (
                                <div className="absolute inset-0 flex items-center justify-center text-center p-6">
                                    <div className="max-w-md">
                                        <div className="text-white font-semibold">Not connected</div>
                                        <div className="mt-2 text-sm text-white/70">
                                            Click <b>Connect</b> to start the session.
                                            {status === "waiting-for-agent" ? (
                                                <>
                                                    <br />
                                                    Waiting for the device to answer…
                                                </>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            ) : viewMode === "terminal" ? (
                                <div className="absolute inset-0 flex flex-col">
                                    <div
                                        ref={termOutRef}
                                        className="flex-1 min-h-0 overflow-auto px-3 py-2 text-[13px] leading-5 text-white font-mono whitespace-pre-wrap break-words"
                                    >
                                        {termOut}
                                    </div>

                                    <div className="border-t border-white/10 px-3 py-2 text-[13px] leading-5 text-white font-mono">
                                        <span className="opacity-70">› </span>
                                        <span>{termLine}</span>
                                        <span className="inline-block w-[8px] animate-pulse opacity-70">▌</span>
                                    </div>

                                    <div className="px-3 pb-2 text-[11px] text-white/60">
                                        Enter sends the line • Ctrl+V pastes • For Ctrl+C or full-screen programs, use Remote Shell
                                    </div>
                                </div>
                            ) : (
                                <div className="absolute bottom-3 left-3 space-y-2">
                                    {showNoVideoWarning ? (
                                        <div className="max-w-sm rounded-md border border-yellow-400/30 bg-yellow-500/10 px-2 py-1 text-[11px] text-yellow-100">
                                            Connected, but no picture has arrived from the device yet.
                                        </div>
                                    ) : null}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className={chatOpen ? "w-[360px] max-w-[38vw] min-w-[320px] border-l bg-background flex flex-col min-h-0" : "hidden"}>
                        <div className="px-3 py-2 flex items-center justify-between">
                            <div className="flex items-center gap-2 font-medium">
                                <MessageSquare className="h-4 w-4" />
                                Chat
                            </div>
                            <div className="flex items-center gap-1">
                                <span className="text-xs text-muted-foreground">{status === "connected" ? "Live" : "Offline"}</span>
                                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={toggleSound} title={soundOn ? "Mute chat sounds" : "Turn chat sounds on"} aria-pressed={!soundOn}>
                                {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={toggleChat} title="Hide chat">
                                    <PanelRightClose className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                        <Separator />

                        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2">
                            {chat.length === 0 ? (
                                <div className="text-sm text-muted-foreground">Messages open a small window on the device, where the person there can read and reply.</div>
                            ) : (
                                chat.map((m) => (
                                    <div
                                        key={m.id}
                                        className={[
                                            "rounded-md border px-2 py-1.5 text-sm",
                                            m.from === "me" ? "bg-muted/40" : "bg-background",
                                        ].join(" ")}
                                    >
                                        <div className="text-xs text-muted-foreground">
                                            {renderChatSender(m)} · {new Date(m.at).toLocaleTimeString()}
                                        </div>
                                        <div className="mt-0.5 whitespace-pre-wrap break-words">{m.text}</div>
                                    </div>
                                ))
                            )}
                        </div>

                        <Separator />
                        <div className="p-3 flex gap-2">
                            <Input
                                value={chatText}
                                onChange={(e) => setChatText(e.target.value)}
                                placeholder="Message…"
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        sendChat();
                                    }
                                }}
                                disabled={status !== "connected"}
                            />
                            <Button onClick={sendChat} disabled={status !== "connected"} title="Send">
                                <Send className="h-4 w-4" />
                            </Button>
                        </div>

                        <div className="px-3 pb-3 space-y-2">
                            <div className="rounded-md border p-3 text-sm">
                                <div className="font-medium">Clipboard</div>
                                <div className="mt-2 flex gap-2">
                                    <Input value={clipboardText} onChange={(e) => setClipboardText(e.target.value)} placeholder="Clipboard text…" />
                                    <Button variant="outline" size="icon" onClick={copyLocalClipboardBox} title="Copy to system clipboard">
                                        <CopyIcon className="h-4 w-4" />
                                    </Button>
                                </div>

                                <div className="mt-2 flex gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-2 flex-1"
                                        onClick={pullClipboardFromRemote}
                                        disabled={status !== "connected"}
                                        title="Request clipboard from remote"
                                    >
                                        <Clipboard className="h-4 w-4" />
                                        Pull
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-2 flex-1"
                                        onClick={pushClipboardToRemote}
                                        disabled={status !== "connected"}
                                        title="Push your clipboard to remote"
                                    >
                                        <Send className="h-4 w-4" />
                                        Push
                                    </Button>
                                </div>
                            </div>

                            {showStats && lastTrackInfo ? (
                                <div className="text-[11px] text-muted-foreground">
                                    Track: <code>{lastTrackInfo}</code>
                                </div>
                            ) : null}

                        </div>
                    </div>
                    {filesColumn}
                </div>
            </div>
    );
    if (popout) return popoutView;

    // --- The session is in its own window ---
    if (poppedOut) {
        return (
            <div className="h-full min-h-0">
                {portalTarget ? createPortal(popoutView, portalTarget) : null}
                <Card className="h-full min-h-0 flex flex-col">
                    <CardContent className="flex flex-1 min-h-0 items-center justify-center p-6">
                        <div className="max-w-md text-center">
                            <ExternalLink className="mx-auto h-8 w-8 text-muted-foreground" />
                            <div className="mt-3 text-lg font-semibold">Remote Console opened in a pop-out window</div>
                            <div className="mt-1 text-sm text-muted-foreground">
                                {portalTarget ? "The session is showing in its own window. Closing that window brings it back here. Leaving this page makes that window reconnect by itself." : "The session is running in its own window. Closing that window ends the session."}
                            </div>
                            <div className="mt-4 flex flex-wrap justify-center gap-2">
                                <Button size="sm" onClick={focusPopout}>
                                    Show window
                                </Button>
                                <Button size="sm" variant="outline" onClick={bringBackHere}>
                                    Bring back here
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // --- In-page layout ---
    return (
        <div className="h-full min-h-0">
            <Card className="h-full min-h-0 flex flex-col">
                <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <CardTitle className="truncate">Remote Console</CardTitle>
                            <CardDescription className="truncate">
                                View and control this device&apos;s screen, including its sign-in screen. Device: <code className="text-xs">{deviceId}</code>
                            </CardDescription>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                            {recordingBadge}
                            {filesToggleButton}
                            {chatToggleButton}
                            {statsToggleButton}
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-2"
                                onClick={openPopout}
                                disabled={!canStart}
                                title="Move this session to its own window"
                            >
                                <ExternalLink className="h-4 w-4" />
                                Pop out
                            </Button>

                            {status !== "connected" ? (
                                <Button
                                    variant="default"
                                    size="sm"
                                    onClick={start}
                                    disabled={!canStart || isBusy}
                                    className="gap-2"
                                    title={!canStart ? "Missing agentUuid on device" : "Start remote console"}
                                >
                                    <PlugZap className="h-4 w-4" />
                                    Connect
                                </Button>
                            ) : (
                                <Button variant="destructive" size="sm" onClick={stop} className="gap-2" title="Stop session">
                                    <Power className="h-4 w-4" />
                                    Disconnect
                                </Button>
                            )}
                        </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded-md border px-2 py-1">
                            Status: <span className="text-foreground font-medium">{status}</span>
                        </span>
                        {sessionId ? (
                            <span className="rounded-md border px-2 py-1">
                                Session: <code className="text-[11px]">{sessionId}</code>
                            </span>
                        ) : null}
                        {status === "connected" ? (
                            <span className="rounded-md border px-2 py-1">
                                Video:{" "}
                                <span className={hasVideoTrack ? "text-foreground font-medium" : "text-yellow-700 font-medium"}>
                                    {hasVideoTrack ? "track received" : "no track yet"}
                                </span>
                            </span>
                        ) : null}
                    </div>

                    {showStats && lastTrackInfo ? (
                        <div className="mt-2 text-[11px] text-muted-foreground">
                            Track: <code>{lastTrackInfo}</code>
                        </div>
                    ) : null}

                    {noticeBanner}
                    {recordingProblem}
                    {err ? (
                        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{err}</div>
                    ) : null}
                </CardHeader>

                <CardContent className="relative flex-1 min-h-0">
                    {filesOpen ? <div className="absolute inset-y-0 right-0 z-30 flex w-[340px] max-w-[90%] flex-col border-l bg-background shadow-lg" {...filesDrop}>{filesPanel}</div> : <div className="hidden">{filesPanel}</div>}
                    <div className={["grid h-full min-h-0 grid-cols-1 gap-3", chatOpen ? "lg:grid-cols-4" : "lg:grid-cols-1"].join(" ")}>
                        <div className={[chatOpen ? "lg:col-span-3" : "lg:col-span-1", "flex min-h-0 flex-col gap-3"].join(" ")}>
                            <div className="flex items-center justify-between gap-2">
                                <div className="text-sm text-muted-foreground">
                                    {viewMode === "desktop" ? (
                                        <>Desktop mode: click inside to control • scroll wheel works • keyboard forwards to remote</>
                                    ) : (
                                        <>
                                            Terminal mode: click inside to type • <b>Enter</b> submits the line
                                        </>
                                    )}
                                </div>

                                <div className="flex flex-wrap items-center justify-end gap-2">
                                    {displayControls}
                                    <div className="flex rounded-md border overflow-hidden">
                                        <Button
                                            type="button"
                                            variant={viewMode === "desktop" ? "default" : "ghost"}
                                            size="sm"
                                            className="rounded-none gap-2"
                                            onClick={() => setViewMode("desktop")}
                                            disabled={status !== "connected"}
                                            title="Desktop view"
                                        >
                                            <Monitor className="h-4 w-4" />
                                            Desktop
                                        </Button>
                                        <Button
                                            type="button"
                                            variant={viewMode === "terminal" ? "default" : "ghost"}
                                            size="sm"
                                            className="rounded-none gap-2"
                                            onClick={() => setViewMode("terminal")}
                                            disabled={status !== "connected"}
                                            title="Terminal view"
                                        >
                                            <Terminal className="h-4 w-4" />
                                            Terminal
                                        </Button>
                                    </div>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setVideoFit((p) => (p === "contain" ? "cover" : "contain"))}
                                        disabled={viewMode !== "desktop"}
                                        title="Toggle fit mode"
                                    >
                                        Fit: {videoFit}
                                    </Button>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-2"
                                        onClick={pullClipboardFromRemote}
                                        disabled={status !== "connected"}
                                        title="Request clipboard from remote"
                                    >
                                        <Clipboard className="h-4 w-4" />
                                        Pull Clipboard
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-2"
                                        onClick={pushClipboardToRemote}
                                        disabled={status !== "connected"}
                                        title="Push your clipboard to remote"
                                    >
                                        <Send className="h-4 w-4" />
                                        Push Clipboard
                                    </Button>
                                </div>
                            </div>

                            <div
                                ref={containerRef}
{...filesDrop}
                                className="relative flex-1 min-h-0 rounded-lg border bg-black overflow-hidden outline-none touch-none"
                                style={{ touchAction: "none", cursor: viewMode === "desktop" && pointerCursor ? pointerCursor : undefined }}
                            onPointerEnter={() => setPointerInside(true)}
                            onPointerLeave={() => setPointerInside(false)}
                                tabIndex={0}
                                onMouseMove={onMouseMove}
                                onMouseDown={onMouseDown}
                                onMouseUp={onMouseUp}
                                onKeyDown={viewMode === "terminal" ? onTerminalKeyDown : onKeyDownCapture}
                                onKeyUp={viewMode === "desktop" ? onKeyUpCapture : undefined}
                            onPaste={onPaste}
                                onFocus={onFocus}
                                onBlur={onBlur}
                                onClick={() => containerRef.current?.focus()}
                                onContextMenu={(e) => e.preventDefault()}
                            >
                                <video
                                    ref={videoRef}
                                    className={[
                                        "absolute inset-0 h-full w-full",
                                        videoFit === "contain" ? "object-contain" : "object-cover",
                                        viewMode === "desktop" && status === "connected" ? "opacity-100" : "opacity-0 pointer-events-none",
                                    ].join(" ")}
                                    autoPlay
                                    playsInline
                                    muted
                                />
                                {pointerOverlay}
{recordingOverlay}
{dropOverlay}

                                {showNotConnectedOverlay ? (
                                    <div className="absolute inset-0 flex items-center justify-center text-center p-6">
                                        <div className="max-w-md">
                                            <div className="text-white font-semibold">Remote Console not connected</div>
                                            <div className="mt-2 text-sm text-white/70">
                                                Click <b>Connect</b> to start the session here, or <b>Pop out</b> for its own window.
                                                {status === "waiting-for-agent" ? (
                                                    <>
                                                        <br />
                                                        Waiting for the device to answer…
                                                    </>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                ) : viewMode === "terminal" ? (
                                    <div className="absolute inset-0 flex flex-col">
                                        <div
                                            ref={termOutRef}
                                            className="flex-1 min-h-0 overflow-auto px-3 py-2 text-[13px] leading-5 text-white font-mono whitespace-pre-wrap break-words"
                                        >
                                            {termOut}
                                        </div>

                                        <div className="border-t border-white/10 px-3 py-2 text-[13px] leading-5 text-white font-mono">
                                            <span className="opacity-70">› </span>
                                            <span>{termLine}</span>
                                            <span className="inline-block w-[8px] animate-pulse opacity-70">▌</span>
                                        </div>

                                        <div className="px-3 pb-2 text-[11px] text-white/60">
                                            Enter sends the line • Ctrl+V pastes • For Ctrl+C or full-screen programs, use Remote Shell
                                        </div>
                                    </div>
                                ) : (
                                    <div className="absolute bottom-3 left-3 space-y-2">
                                        {showNoVideoWarning ? (
                                            <div className="max-w-sm rounded-md border border-yellow-400/30 bg-yellow-500/10 px-2 py-1 text-[11px] text-yellow-100">
                                                Connected, but no picture has arrived from the device yet.
                                            </div>
                                        ) : null}
                                    </div>
                                )}
                            </div>

                            <div className="rounded-md border p-3 text-sm">
                                <div className="font-medium">Clipboard (local view)</div>
                                <div className="mt-2 flex gap-2">
                                    <Input value={clipboardText} onChange={(e) => setClipboardText(e.target.value)} placeholder="Clipboard text…" />
                                    <Button variant="outline" size="icon" onClick={copyLocalClipboardBox} title="Copy to system clipboard">
                                        <CopyIcon className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className={chatOpen ? "lg:col-span-1 flex min-h-0 flex-col rounded-lg border" : "hidden"}>
                            <div className="px-3 py-2 flex items-center justify-between">
                                <div className="flex items-center gap-2 font-medium">
                                    <MessageSquare className="h-4 w-4" />
                                    Chat
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-xs text-muted-foreground">{status === "connected" ? "Live" : "Offline"}</span>
                                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={toggleSound} title={soundOn ? "Mute chat sounds" : "Turn chat sounds on"} aria-pressed={!soundOn}>
                                {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={toggleChat} title="Hide chat">
                                        <PanelRightClose className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                            <Separator />

                            <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2">
                                {chat.length === 0 ? (
                                    <div className="text-sm text-muted-foreground">Messages open a small window on the device, where the person there can read and reply.</div>
                                ) : (
                                    chat.map((m) => (
                                        <div
                                            key={m.id}
                                            className={[
                                                "rounded-md border px-2 py-1.5 text-sm",
                                                m.from === "me" ? "bg-muted/40" : "bg-background",
                                            ].join(" ")}
                                        >
                                            <div className="text-xs text-muted-foreground">
                                                {renderChatSender(m)} · {new Date(m.at).toLocaleTimeString()}
                                            </div>
                                            <div className="mt-0.5 whitespace-pre-wrap break-words">{m.text}</div>
                                        </div>
                                    ))
                                )}
                            </div>

                            <Separator />
                            <div className="p-3 flex gap-2">
                                <Input
                                    value={chatText}
                                    onChange={(e) => setChatText(e.target.value)}
                                    placeholder="Message…"
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            sendChat();
                                        }
                                    }}
                                    disabled={status !== "connected"}
                                />
                                <Button onClick={sendChat} disabled={status !== "connected"} title="Send">
                                    <Send className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
