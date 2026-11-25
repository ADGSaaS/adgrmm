// backend/src/remote-console/remote-console.types.ts

import type WebSocket from "ws";

import type { SignedEnvelope } from "../common/job-signer.service";

export type ConsolePeerKind = "agent" | "tech";

export type ConsoleSessionState = "created" | "waiting" | "active" | "closed" | "error";

export type ConsoleSession = {
    iceServers: { urls: string | string[]; username?: string; credential?: string }[];
    sessionId: string;

    // Who started the session. A device takes one technician at a time.
    technicianId: string;
    technicianName: string;

    // What the person at the device is told or asked, from the customer's setting.
    consentMode: "off" | "notice" | "consent";

    // Whether this session may be recorded. Decided once, at the start, because the person at the device is
    // told at that moment; a recording is only accepted for a session that said so.
    record?: boolean;

    // The customer's "Remote video codec" setting. Passed on in the signed session start and to the browser; the device decides what it can really do.
    videoCodec?: "auto" | "vp8" | "h264";

    // Canonical agent id from DB (agents.id)
    agentId: string;

    // One-time token given to the tech UI for WS hello
    sessionToken: string;

    createdAt: number;
    lastActivityAt: number;

    state: ConsoleSessionState;

    // WS endpoints
    agentWs?: WebSocket;
    techWs?: WebSocket;

    // Optional diagnostics
    error?: string;
};

export type WsHelloAgent = {
    type: "hello";
    kind: "agent";
    agentUuid: string; // can be agents.id or agents.agent_uuid
    agentToken: string;
};

export type WsHelloTech = {
    type: "hello";
    kind: "tech";
    sessionId: string;
    sessionToken: string;
};

export type WsSignal = {
    type: "signal";
    sessionId: string;
    data: any; // SDP offer/answer, ICE candidates, etc.
};

export type WsPing = { type: "ping"; ts: number };
export type WsPong = { type: "pong"; ts: number };

export type WsServerToClient =
    | { type: "hello.ok"; sessionId?: string; agentId?: string }
    | { type: "hello.error"; message: string }
    | {
        type: "session.ready";
        sessionId: string;
        iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
        signed?: SignedEnvelope;
        videoCodec?: "auto" | "vp8" | "h264";
    }
    | { type: "session.closed"; sessionId: string; reason: string; message?: string }
    | { type: "session.waiting"; sessionId: string; message: string }
    | { type: "signal"; sessionId: string; data: any }
    | WsPing
    | WsPong;
