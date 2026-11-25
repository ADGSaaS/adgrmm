// backend/src/remote-console/remote-console.service.ts

import { PoliciesService } from "../policies/policies.service";
import { Injectable, Logger, ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import { agentIdOrUuidWhere } from "../common/agent-lookup.util";
import { hashAgentToken } from "../common/agent-token.util";
import { JobSignerService } from "../common/job-signer.service";
import { ClientAccessService } from "../reports/client-access.service";
import { PrismaService } from "../storage/prisma.service";
import type { ConsoleSession, ConsolePeerKind, WsServerToClient } from "./remote-console.types";
import {
    TURN_CREDENTIAL_TTL_SEC,
    builtinIceServers,
    resolveTurnProvider,
    stunServers,
    type IceServer,
} from "./turn-config";

const WS_OPEN = 1;

// 15 minutes session token validity by default
const DEFAULT_TOKEN_TTL_MS = 15 * 60_000;
// cleanup idle sessions
const DEFAULT_IDLE_TTL_MS = 10 * 60_000;

// A new session has this long to connect before it stops holding the device.
const UNCONNECTED_SESSION_GRACE_MS = 30_000;

function safeJsonParse(text: string): any | null {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function rawToUtf8(data: any): string {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf8");
    if (ArrayBuffer.isView(data)) {
        const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        return Buffer.from(u8).toString("utf8");
    }
    try {
        return String(data ?? "");
    } catch {
        return "";
    }
}

function wsReady(ws?: WebSocket) {
    return !!ws && (ws as any).readyState === WS_OPEN;
}

function wsSend(ws: WebSocket | undefined, msg: WsServerToClient) {
    if (!wsReady(ws)) return;
    try {
        (ws as any).send(JSON.stringify(msg));
    } catch {
        // ignore
    }
}

@Injectable()
export class RemoteConsoleService {
    private readonly logger = new Logger("RemoteConsole");

    /**
     * We use static registries so we don't get bitten if Nest accidentally
     * instantiates the service twice in dev/hot-reload edge cases.
     */
    private static readonly SESSIONS = new Map<string, ConsoleSession>();
    private static readonly AGENTS = new Map<string, WebSocket>(); // agentId -> ws
    private static cleanerStarted = false;

    private readonly tokenTtlMs =
        Number(process.env.REMOTE_CONSOLE_TOKEN_TTL_MS || "") || DEFAULT_TOKEN_TTL_MS;

    private readonly idleTtlMs =
        Number(process.env.REMOTE_CONSOLE_IDLE_TTL_MS || "") || DEFAULT_IDLE_TTL_MS;

    /** Remembers how a session reached the computer. One row per session, updated while it runs; the numbers are clamped so a wrong report cannot do harm. */
    async noteTransport(sessionId: string, userId: string | null, relay: boolean, bytesReceived: number) {
        const id = String(sessionId || "").slice(0, 80);
        if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return { ok: false };
        const bytes = Number.isFinite(bytesReceived) ? Math.min(Math.max(0, Math.round(bytesReceived)), 5e12) : 0;
        await this.prisma.$executeRaw`
            INSERT INTO public.remote_session_transport (session_id, user_id, relay, bytes_received) VALUES (${id}, ${userId}::uuid, ${relay}, ${bytes})
            ON CONFLICT (session_id) DO UPDATE SET relay = public.remote_session_transport.relay OR EXCLUDED.relay,
              bytes_received = GREATEST(public.remote_session_transport.bytes_received, EXCLUDED.bytes_received), updated_at = now()`;
        return { ok: true };
    }

    async transportReport(daysRaw: number) {
        const days = Math.min(365, Math.max(1, Math.round(daysRaw || 30)));
        const r = (await this.prisma.$queryRaw<Array<{ total: bigint; relayed: bigint; relay_bytes: bigint; all_bytes: bigint }>>`
            SELECT count(*)::bigint AS total, count(*) FILTER (WHERE relay)::bigint AS relayed,
                   COALESCE(sum(bytes_received) FILTER (WHERE relay), 0)::bigint AS relay_bytes, COALESCE(sum(bytes_received), 0)::bigint AS all_bytes
              FROM public.remote_session_transport WHERE started_at > now() - make_interval(days => ${days}::int)`)[0];
        const gb = (n: bigint) => Math.round((Number(n) / 1024 ** 3) * 100) / 100;
        return {
            days, sessions: Number(r?.total ?? 0), relayedSessions: Number(r?.relayed ?? 0),
            relayedPercent: Number(r?.total ?? 0) ? Math.round((Number(r.relayed) / Number(r.total)) * 100) : null,
            relayGigabytes: gb(r?.relay_bytes ?? 0n), totalGigabytes: gb(r?.all_bytes ?? 0n),
            freeAllowanceGigabytes: 1000, pricePerGigabyteAfterAllowance: 0.05,
        };
    }

    constructor(
        private readonly prisma: PrismaService,
        private readonly signer: JobSignerService,
        private readonly policies: PoliciesService,
        private readonly access: ClientAccessService,
    ) {
        if (!RemoteConsoleService.cleanerStarted) {
            RemoteConsoleService.cleanerStarted = true;
            setInterval(() => this.cleanup(), 30_000).unref();
        }
    }

    // ---------------- Debug helpers ----------------

    listSessions() {
        return Array.from(RemoteConsoleService.SESSIONS.values()).map((s) => ({
            sessionId: s.sessionId,
            agentId: s.agentId,
            state: s.state,
            createdAt: s.createdAt,
            lastActivityAt: s.lastActivityAt,
            hasAgent: wsReady(s.agentWs),
            hasTech: wsReady(s.techWs),
            error: s.error ?? null,
        }));
    }

    listConnectedAgents() {
        return Array.from(RemoteConsoleService.AGENTS.keys());
    }

    // ---------------- Session creation (REST) ----------------

    /**
     * Called by the TECH UI via REST:
     * - Validates agent exists
     * - Creates sessionId + one-time sessionToken for WS hello
     */
    async createSession(
        agentIdOrUuid: string,
        technician: { id: string; name: string }
    ): Promise<{ sessionId: string; sessionToken: string; iceServers: IceServer[]; recording: boolean }> {
        const raw = String(agentIdOrUuid || "").trim();
        if (!raw) throw new Error("Missing agent id");

        // Resolve canonical agents.id
        const found = await this.prisma.agents.findFirst({
            where: agentIdOrUuidWhere(raw),
            select: { id: true, device_id: true },
        });

        const agentId = found?.id;
        if (!agentId) throw new Error("Unknown agent");

        // A person limited to some customers cannot open a console on another customer's device.
        await this.access.assertDevice(technician.id || null, found!.device_id);

        const iceServers = await this.issueIceServers();
        const record = await this.recordingFor(agentId);
        // A recorded session is never silent: with "show nothing" the person would be filmed without being told.
        const chosenMode = await this.consentModeFor(agentId);
        const consentMode = record && chosenMode === "off" ? "notice" : chosenMode;
        const videoCodec = await this.videoCodecFor(agentId);

        // Nothing is awaited from here until the session is registered, so two technicians
        // connecting at once cannot both pass this check.
        this.claimDevice(agentId, technician);

        const sessionId = randomUUID();
        const sessionToken = randomUUID();
        const now = Date.now();

        const s: ConsoleSession = {
            sessionId,
            agentId,
            sessionToken,
            createdAt: now,
            lastActivityAt: now,
            state: "created",
            iceServers,
            technicianId: technician.id,
            technicianName: technician.name,
            consentMode,
            record,
            videoCodec,
        };

        RemoteConsoleService.SESSIONS.set(sessionId, s);

        this.logger.log(`session created session=${sessionId} agent=${agentId}`);
        return { sessionId, sessionToken, iceServers: s.iceServers, recording: record };
    }

    /**
     * The customer's "Remote video codec" setting for this device. A failed lookup means "auto", which only ever picks H.264
     * on a hardware encoder that passed its own check on the device. REMOTE_CONSOLE_VIDEO_CODEC=vp8 on the server keeps
     * every session on VP8 whatever the customers say, as a switch for the whole system.
     */
    async videoCodecFor(agentId: string): Promise<"auto" | "vp8" | "h264"> {
        if ((process.env.REMOTE_CONSOLE_VIDEO_CODEC || "").trim().toLowerCase() === "vp8") return "vp8";
        try {
            const rows = await this.prisma.$queryRaw<Array<{ codec: string }>>`
                SELECT c.remote_console_codec AS codec
                  FROM public.agents a
                  JOIN public.devices d ON d.id = a.device_id
                  JOIN public.sites s ON s.id = d.site_id
                  JOIN public.clients c ON c.id = s.client_id
                 WHERE a.id = ${agentId}::uuid
                 LIMIT 1`;
            const codec = rows[0]?.codec;
            if (codec === "vp8" || codec === "h264") return codec;
        } catch (e: any) {
            this.logger.warn(`could not read the video codec setting for agent=${agentId}: ${e?.message ?? e}`);
        }
        return "auto";
    }

    /**
     * Whether sessions on this device are recorded: a policy that reaches the device decides, otherwise the customer's
     * setting (the policy lookup already falls back to it). A failed lookup means no recording, because nothing may be
     * recorded unless that was clearly asked for.
     */
    async recordingFor(agentId: string): Promise<boolean> {
        try {
            const agent = await this.prisma.agents.findUnique({ where: { id: agentId }, select: { device_id: true } });
            if (!agent) return false;
            const effective = await this.policies.effectiveForDevice(agent.device_id);
            return effective?.scalars["remote.record"]?.value === true;
        } catch (e: any) {
            this.logger.warn(`could not read the recording setting for agent=${agentId}: ${e?.message ?? e}`);
            return false;
        }
    }

    /** What the recording service needs to know about a live session of this technician, or null if it is not one. */
    liveSessionFor(sessionId: string, technicianId: string): { agentId: string; technicianName: string; record: boolean; consentMode: string } | null {
        const s = RemoteConsoleService.SESSIONS.get(String(sessionId || "").trim());
        if (!s || s.state === "closed" || s.state === "error") return null;
        if (s.technicianId !== technicianId) return null;
        return { agentId: s.agentId, technicianName: s.technicianName, record: s.record === true, consentMode: s.consentMode };
    }

    /**
     * What the person at this device is told or asked, from its customer's setting. A device with no
     * customer, or a lookup that fails, gets the default: a notice. It never silently becomes "off".
     */
    private async consentModeFor(agentId: string): Promise<"off" | "notice" | "consent"> {
        try {
            // A policy that reaches the device decides. Without one, the customer's own setting (read by the same lookup) applies.
            const agent = await this.prisma.agents.findUnique({ where: { id: agentId }, select: { device_id: true } });
            const effective = agent ? await this.policies.effectiveForDevice(agent.device_id) : null;
            const chosen = effective?.scalars["remote.consent"]?.value;
            if (chosen === "off" || chosen === "consent" || chosen === "notice") return chosen;
        } catch (e: any) {
            this.logger.warn(`could not read the policy for agent=${agentId}: ${e?.message ?? e}`);
        }
        try {
            const rows = await this.prisma.$queryRaw<Array<{ mode: string }>>`
                SELECT c.remote_console_consent AS mode
                  FROM public.agents a
                  JOIN public.devices d ON d.id = a.device_id
                  JOIN public.sites s ON s.id = d.site_id
                  JOIN public.clients c ON c.id = s.client_id
                 WHERE a.id = ${agentId}::uuid
                 LIMIT 1`;
            const mode = rows[0]?.mode;
            if (mode === "off" || mode === "consent" || mode === "notice") return mode;
        } catch (e: any) {
            this.logger.warn(`could not read the consent setting for agent=${agentId}: ${e?.message ?? e}`);
        }
        return "notice";
    }

    /**
     * A device takes one technician at a time. Reconnecting replaces your own earlier session,
     * so a stuck tab cannot lock you out, and a session that never connected stops counting.
     */
    private claimDevice(agentId: string, technician: { id: string; name: string }): void {
        for (const s of Array.from(RemoteConsoleService.SESSIONS.values())) {
            if (s.agentId !== agentId || s.state === "closed") continue;

            const inUse = wsReady(s.techWs) || Date.now() - s.createdAt < UNCONNECTED_SESSION_GRACE_MS;
            if (inUse && s.technicianId !== technician.id) {
                throw new ConflictException(
                    `${s.technicianName} is already connected to this device. Only one technician can use Remote Console at a time.`,
                );
            }

            this.closeSession(s.sessionId, s.technicianId === technician.id ? "replaced_by_new_session" : "abandoned");
        }
    }

    /** Credentials for the configured relay, or plain STUN if there is none or it is unavailable. */
    private async issueIceServers(): Promise<IceServer[]> {
        try {
            const provider = resolveTurnProvider();
            if (provider === "builtin") return builtinIceServers();
            if (provider === "cloudflare") return await this.cloudflareIceServers();
        } catch (e: any) {
            this.logger.warn(`Could not issue TURN credentials (${e?.message ?? e}); this session has no relay.`);
        }
        return stunServers();
    }

    private async cloudflareIceServers(): Promise<IceServer[]> {
        const keyId = (process.env.CLOUDFLARE_TURN_KEY_ID || "").trim();
        const apiToken = (process.env.CLOUDFLARE_TURN_API_TOKEN || "").trim();
        if (!keyId || !apiToken) {
            throw new Error("The cloudflare TURN provider needs CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN.");
        }

        const res = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SEC }),
                signal: AbortSignal.timeout(5000),
            },
        );
        if (!res.ok) throw new Error(`Cloudflare returned ${res.status}`);

        const body: any = await res.json();
        if (!Array.isArray(body?.iceServers) || body.iceServers.length === 0) {
            throw new Error("Cloudflare returned no servers");
        }
        return body.iceServers;
    }

    // ---------------- WebSocket hello/auth ----------------

    /**
     * Agent hello:
     * - validates agent token
     * - stores AGENTS registry
     * - attaches to any waiting sessions (if any)
     */
    async handleAgentHello(ws: WebSocket, agentUuid: string, agentToken: string) {
        const agentUuidTrim = String(agentUuid || "").trim();
        const agentTokenTrim = String(agentToken || "").trim();
        if (!agentUuidTrim || !agentTokenTrim) {
            wsSend(ws, { type: "hello.error", message: "Missing agentUuid/agentToken" });
            try {
                ws.close();
            } catch { }
            return;
        }

        // Resolve canonical id
        const found = await this.prisma.agents.findFirst({
            where: agentIdOrUuidWhere(agentUuidTrim),
            select: { id: true },
        });

        const agentId = found?.id;
        if (!agentId) {
            wsSend(ws, { type: "hello.error", message: "Unknown agent" });
            try {
                ws.close();
            } catch { }
            return;
        }

        // Validate token
        const ok = await this.prisma.agents.findFirst({
            where: { ...agentIdOrUuidWhere(agentUuidTrim), agent_token: hashAgentToken(agentTokenTrim) },
            select: { id: true },
        });

        if (!ok) {
            wsSend(ws, { type: "hello.error", message: "Unauthorized" });
            try {
                ws.close();
            } catch { }
            return;
        }

        // Register agent WS (kick previous)
        const existing = RemoteConsoleService.AGENTS.get(agentId);
        if (existing && existing !== ws) {
            try {
                existing.close();
            } catch { }
        }
        RemoteConsoleService.AGENTS.set(agentId, ws);

        // Mark on socket
        (ws as any).__rcAuthed = true;
        (ws as any).__rcKind = "agent";
        (ws as any).__rcAgentId = agentId;

        wsSend(ws, { type: "hello.ok", agentId });

        this.logger.log(`agent authed for remote-console agent=${agentId}`);

        // If there are sessions for this agent waiting, attach
        for (const s of RemoteConsoleService.SESSIONS.values()) {
            if (s.state === "closed" || s.state === "error") continue;
            if (s.agentId !== agentId) continue;

            // Attach agentWs if missing
            if (!wsReady(s.agentWs)) {
                s.agentWs = ws;
                s.lastActivityAt = Date.now();
                s.state = wsReady(s.techWs) ? "active" : "waiting";
                this.maybeAnnounceReady(s);
            }
        }
    }

    /**
     * Tech hello:
     * - validates sessionId + token
     * - attaches techWs
     * - if agent connected, session becomes active and we announce ready
     */
    handleTechHello(ws: WebSocket, sessionId: string, sessionToken: string) {
        const sid = String(sessionId || "").trim();
        const tok = String(sessionToken || "").trim();
        if (!sid || !tok) {
            wsSend(ws, { type: "hello.error", message: "Missing sessionId/sessionToken" });
            try {
                ws.close();
            } catch { }
            return;
        }

        const s = RemoteConsoleService.SESSIONS.get(sid);
        if (!s || s.state === "closed" || s.state === "error") {
            wsSend(ws, { type: "hello.error", message: "Unknown session" });
            try {
                ws.close();
            } catch { }
            return;
        }

        // Token + expiry check
        const now = Date.now();
        const age = now - s.createdAt;
        if (s.sessionToken !== tok) {
            wsSend(ws, { type: "hello.error", message: "Unauthorized" });
            try {
                ws.close();
            } catch { }
            return;
        }
        if (age > this.tokenTtlMs) {
            wsSend(ws, { type: "hello.error", message: "Session token expired" });
            this.closeSession(sid, "token_expired");
            try {
                ws.close();
            } catch { }
            return;
        }

        // Kick prior tech connection
        if (wsReady(s.techWs) && s.techWs !== ws) {
            try {
                s.techWs!.close();
            } catch { }
        }

        // Attach tech
        s.techWs = ws;
        s.lastActivityAt = now;

        // Attach agentWs if agent is already registered
        const agentWs = RemoteConsoleService.AGENTS.get(s.agentId);
        if (wsReady(agentWs)) s.agentWs = agentWs;

        s.state = wsReady(s.agentWs) ? "active" : "waiting";

        // Mark on socket
        (ws as any).__rcAuthed = true;
        (ws as any).__rcKind = "tech";
        (ws as any).__rcSessionId = sid;

        wsSend(ws, { type: "hello.ok", sessionId: sid });

        this.logger.log(`tech authed for remote-console session=${sid} agent=${s.agentId}`);
        this.maybeAnnounceReady(s);
    }

    // ---------------- Message relay (signaling) ----------------

    /**
     * Any "signal" messages are relayed to the opposite peer.
     * Server does not parse SDP/ICE; it just brokers.
     */
    relaySignal(fromKind: ConsolePeerKind, sessionId: string, data: any) {
        const sid = String(sessionId || "").trim();
        if (!sid) return;

        const s = RemoteConsoleService.SESSIONS.get(sid);
        if (!s || s.state === "closed" || s.state === "error") return;

        s.lastActivityAt = Date.now();

        if (fromKind === "tech") {
            wsSend(s.agentWs, { type: "signal", sessionId: sid, data });
        } else {
            wsSend(s.techWs, { type: "signal", sessionId: sid, data });
        }
    }

    // ---------------- Keepalive / activity bump ----------------

    /**
     * IMPORTANT:
     * Once WebRTC connects, signaling can go quiet for long periods.
     * We must treat ping/pong as activity, or idle cleanup will kill active sessions.
     */
    private bumpActivityForSocket(ws: WebSocket) {
        const authed = Boolean((ws as any).__rcAuthed);
        if (!authed) return;

        const kind = String((ws as any).__rcKind || "") as ConsolePeerKind;
        const now = Date.now();

        if (kind === "tech") {
            const sid = String((ws as any).__rcSessionId || "").trim();
            if (!sid) return;
            const s = RemoteConsoleService.SESSIONS.get(sid);
            if (!s || s.state === "closed" || s.state === "error") return;
            s.lastActivityAt = now;
            return;
        }

        if (kind === "agent") {
            const agentId = String((ws as any).__rcAgentId || "").trim();
            if (!agentId) return;
            for (const s of RemoteConsoleService.SESSIONS.values()) {
                if (s.agentId !== agentId) continue;
                if (s.state === "closed" || s.state === "error") continue;
                s.lastActivityAt = now;
            }
        }
    }

    // ---------------- Disconnect handling ----------------

    handleSocketClosed(ws: WebSocket) {
        const authed = Boolean((ws as any).__rcAuthed);
        if (!authed) return;

        const kind = String((ws as any).__rcKind || "") as ConsolePeerKind;

        if (kind === "agent") {
            const agentId = String((ws as any).__rcAgentId || "");
            if (agentId) {
                const cur = RemoteConsoleService.AGENTS.get(agentId);
                if (cur === ws) RemoteConsoleService.AGENTS.delete(agentId);

                // Any active sessions for this agent must close
                for (const s of RemoteConsoleService.SESSIONS.values()) {
                    if (s.agentId !== agentId) continue;
                    if (s.state === "closed" || s.state === "error") continue;
                    if (s.agentWs === ws) {
                        s.agentWs = undefined;
                        this.closeSession(s.sessionId, "agent_disconnected");
                    }
                }
            }
            return;
        }

        if (kind === "tech") {
            const sid = String((ws as any).__rcSessionId || "");
            if (!sid) return;
            const s = RemoteConsoleService.SESSIONS.get(sid);
            if (!s) return;

            if (s.techWs === ws) s.techWs = undefined;

            // If tech leaves, we close the session (simple policy).
            this.closeSession(sid, "tech_disconnected");
        }
    }

    // ---------------- Close / cleanup ----------------

    closeSession(sessionId: string, reason: string, message?: string) {
        const sid = String(sessionId || "").trim();
        if (!sid) return;

        const s = RemoteConsoleService.SESSIONS.get(sid);
        if (!s || s.state === "closed") return;

        s.state = "closed";
        s.lastActivityAt = Date.now();

        wsSend(s.agentWs, { type: "session.closed", sessionId: sid, reason });
        wsSend(s.techWs, { type: "session.closed", sessionId: sid, reason, ...(message ? { message } : {}) });

        /**
         * IMPORTANT:
         * Do NOT close agent WS here.
         * The agent should stay connected for future sessions.
         */
        try {
            if (wsReady(s.techWs)) s.techWs!.close();
        } catch { }

        RemoteConsoleService.SESSIONS.delete(sid);

        this.logger.log(`session closed session=${sid} reason=${reason}`);
    }

    /** The agent would not start the session, usually because its signature did not check out. */
    private handleAgentRefusal(ws: WebSocket, kind: ConsolePeerKind, sessionId: string, reason: string) {
        if (kind !== "agent") return;

        const s = RemoteConsoleService.SESSIONS.get(sessionId);
        if (!s || s.agentId !== String((ws as any).__rcAgentId || "")) return;

        const message = reason.slice(0, 300) || "The agent refused to start the session.";
        this.logger.warn(`agent refused session=${sessionId} agent=${s.agentId}: ${message}`);
        this.closeSession(sessionId, "agent_refused", message);
    }

    private maybeAnnounceReady(s: ConsoleSession) {
        const sid = s.sessionId;
        const ready = wsReady(s.agentWs) && wsReady(s.techWs);

        if (!ready) return;

        // session is active
        s.state = "active";
        s.lastActivityAt = Date.now();

        wsSend(s.agentWs, {
            type: "session.ready",
            sessionId: sid,
            iceServers: s.iceServers,
            // Signed with the session start, so nothing between here and the agent can weaken it.
            ...this.signer.sessionStartField(s.agentId, "console", sid, {
                consent: s.consentMode,
                videoCodec: s.videoCodec ?? "auto",
                // The device shows this as "<name> from your IT provider ...". The agent has a fixed sentence and
                // cuts the name at 60 characters, so the notice of a recorded session rides in the name.
                technician: s.record ? `${s.technicianName.slice(0, 27)} (this session is being recorded)` : s.technicianName,
            }),
        });
        wsSend(s.techWs, { type: "session.ready", sessionId: sid, videoCodec: s.videoCodec ?? "auto" });

        this.logger.log(`session ready session=${sid} agent=${s.agentId}`);
    }

    private cleanup() {
        const now = Date.now();

        for (const s of RemoteConsoleService.SESSIONS.values()) {
            if (s.state === "closed" || s.state === "error") {
                RemoteConsoleService.SESSIONS.delete(s.sessionId);
                continue;
            }

            // If session was created but never used, expire it
            if (now - s.createdAt > this.tokenTtlMs && !wsReady(s.techWs)) {
                this.closeSession(s.sessionId, "token_expired");
                continue;
            }

            // If active/idle too long, close
            if (now - s.lastActivityAt > this.idleTtlMs) {
                this.closeSession(s.sessionId, "idle_timeout");
                continue;
            }
        }
    }

    // ---------------- WS entry helpers ----------------

    /**
     * Used by the gateway:
     * - parses text messages
     * - routes hello/signal/ping
     */
    async handleWsMessage(ws: WebSocket, data: any, isBinary: boolean) {
        if (isBinary) {
            // We do not accept binary on signaling WS (WebRTC media/data is P2P)
            return;
        }

        const text = rawToUtf8(data);
        if (!text) return;

        const msg = safeJsonParse(text);
        if (!msg?.type) return;

        const type = String(msg.type);

        if (type === "hello") {
            const kind = String(msg.kind || "");
            if (kind === "agent") {
                await this.handleAgentHello(ws, msg.agentUuid, msg.agentToken);
                return;
            }
            if (kind === "tech") {
                this.handleTechHello(ws, msg.sessionId, msg.sessionToken);
                return;
            }
            wsSend(ws, { type: "hello.error", message: "Invalid hello kind" });
            try {
                ws.close();
            } catch { }
            return;
        }

        // Everything below requires authed socket
        const authed = Boolean((ws as any).__rcAuthed);
        const kind = String((ws as any).__rcKind || "") as ConsolePeerKind;
        if (!authed || (kind !== "agent" && kind !== "tech")) return;

        if (type === "ping") {
            // Treat ping as activity so idle cleanup doesn't kill active WebRTC sessions.
            this.bumpActivityForSocket(ws);
            wsSend(ws, { type: "pong", ts: Number(msg.ts || Date.now()) });
            return;
        }

        if (type === "pong") {
            // If clients ever send pong, treat it as activity too.
            this.bumpActivityForSocket(ws);
            return;
        }

        if (type === "signal") {
            const sessionId = String(msg.sessionId || "");
            this.relaySignal(kind, sessionId, msg.data);
            return;
        }

        if (type === "session.refused") {
            this.handleAgentRefusal(ws, kind, String(msg.sessionId || ""), String(msg.reason || ""));
            return;
        }

        // The person at the device pressed End session. The technician is told, and the session is closed.
        if (type === "session.end") {
            const sid = String(msg.sessionId || "");
            const s = RemoteConsoleService.SESSIONS.get(sid);
            if (kind === "agent" && s && s.agentId === String((ws as any).__rcAgentId || "")) {
                this.logger.log(`session ended at the device session=${sid} agent=${s.agentId}`);
                this.closeSession(sid, "ended_at_device");
            }
            return;
        }

        // The agent is waiting for the person at the device to allow the session. The technician is told,
        // so a long wait is not mistaken for a fault.
        if (type === "session.waiting") {
            const sid = String(msg.sessionId || "");
            const s = RemoteConsoleService.SESSIONS.get(sid);
            if (kind === "agent" && s && s.agentId === String((ws as any).__rcAgentId || "")) {
                wsSend(s.techWs, { type: "session.waiting", sessionId: sid, message: String(msg.message || "").slice(0, 200) });
            }
            return;
        }

        // ignore unknown messages
    }
}
