// adgrmm-minimal-e2e/backend/src/remote-shell/remote-shell.gateway.ts
import { Logger, OnModuleDestroy } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "http";
import type WebSocket from "ws";
import { Server } from "ws";
import { WsAuthService } from "../auth/ws-auth.service";
import { JobSignerService, type SignedEnvelope } from "../common/job-signer.service";
import { AuditService } from "../audit/audit.service";
import { ClientAccessService } from "../reports/client-access.service";

type Role = "ui" | "agent";
type RunAs = "system" | "user";

type UiOpen = { type: "open"; cols?: number; rows?: number; runAs?: RunAs };
type UiInput = { type: "input"; sessionId: string; data: string };
type UiSignal = { type: "signal"; sessionId: string; signal: "SIGINT" | "SIGTERM" };
type UiResize = { type: "resize"; sessionId: string; cols: number; rows: number };
type UiClose = { type: "close"; sessionId: string };
type UiToServer = UiOpen | UiInput | UiSignal | UiResize | UiClose;

type AgentHello = { type: "hello"; agentUuid?: string; token?: string };
type AgentReady = { type: "shell.ready"; sessionId: string };
type AgentData = { type: "shell.data"; sessionId: string; data: string };
type AgentExit = { type: "shell.exit"; sessionId: string; code?: number; signal?: string; message?: string };
type AgentError = { type: "shell.error"; sessionId?: string; message: string };
type AgentToServer = AgentHello | AgentReady | AgentData | AgentExit | AgentError;

type ServerToUi =
    | {
        type: "status";
        status: "connected" | "waiting_for_agent" | "agent_connected" | "agent_disconnected";
        agentUuid: string;
    }
    | { type: "session"; sessionId: string; agentUuid: string }
    | { type: "data"; sessionId: string; data: string }
    | { type: "exit"; sessionId: string; code?: number; signal?: string; message?: string }
    | { type: "error"; message: string };

type ServerToAgent =
    | { type: "shell.open"; sessionId: string; cols?: number; rows?: number; runAs?: RunAs; signed?: SignedEnvelope }
    | { type: "shell.input"; sessionId: string; data: string }
    | { type: "shell.signal"; sessionId: string; signal: "SIGINT" | "SIGTERM" }
    | { type: "shell.resize"; sessionId: string; cols: number; rows: number }
    | { type: "shell.close"; sessionId: string };

const WS_OPEN = 1;
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const SHELL_PERMISSION = "devices.actions";

function safeJsonParse(s: string): any | null {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

function wsSend(ws: WebSocket, msg: any) {
    if ((ws as any).readyState === WS_OPEN) {
        try {
            ws.send(JSON.stringify(msg));
        } catch {
            // ignore
        }
    }
}

function getQuery(req: IncomingMessage): URLSearchParams {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    return url.searchParams;
}

@WebSocketGateway({
    path: "/ws/shell",
})
export class RemoteShellGateway implements OnModuleDestroy {
    @WebSocketServer()
    server!: Server;

    private readonly logger = new Logger("RemoteShellGateway");

    constructor(
        private readonly wsAuth: WsAuthService,
        private readonly signer: JobSignerService,
        private readonly audit: AuditService,
        private readonly access: ClientAccessService,
    ) { }

    private agentsByAgentUuid = new Map<string, WebSocket>();
    private uiAgentBySocket = new Map<WebSocket, string>();

    private sessions = new Map<string, { agentUuid: string; ui: WebSocket }>();

    private heartbeatTimer: NodeJS.Timeout | null = null;

    afterInit(server: Server) {
        // Heartbeat: ping/pong to detect dead connections and force cleanup
        server.on("connection", (ws: WebSocket) => {
            (ws as any).isAlive = true;
            (ws as any).on("pong", () => {
                (ws as any).isAlive = true;
            });
        });

        this.heartbeatTimer = setInterval(() => {
            try {
                for (const client of this.server.clients) {
                    const anyClient = client as any;
                    if (anyClient.isAlive === false) {
                        try {
                            client.terminate();
                        } catch { }
                        continue;
                    }
                    anyClient.isAlive = false;
                    try {
                        (client as any).ping();
                    } catch { }
                }
            } catch {
                // ignore
            }
        }, 30_000);
    }

    onModuleDestroy() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    handleConnection(client: WebSocket, req: IncomingMessage) {
        const q = getQuery(req);
        const role = ((q.get("role") as Role) || "ui").trim() as Role;
        const requestedAgent = (q.get("agentUuid") || "").trim();

        if (role !== "ui" && role !== "agent") {
            this.reject(client, CLOSE_BAD_REQUEST, "Invalid role");
            return;
        }

        if (!requestedAgent) {
            this.reject(client, CLOSE_BAD_REQUEST, "Missing agentUuid");
            return;
        }

        // Listeners attach synchronously and await this, so no frame is lost or
        // handled before authorization finishes.
        const authorized = (role === "agent"
            ? this.authorizeAgent(client, req, requestedAgent)
            : this.authorizeUi(client, req, requestedAgent)
        ).catch((e: any) => {
            this.logger.warn(`Shell authorization failed: ${e?.message ?? e}`);
            this.reject(client, CLOSE_UNAUTHORIZED, "Not authorized");
            return false;
        });

        (client as any).on("message", async (raw: any) => {
            if (!(await authorized)) return;

            const text = typeof raw === "string" ? raw : raw?.toString ? raw.toString("utf8") : "";
            const msg = safeJsonParse(text);
            if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
                wsSend(client, { type: "error", message: "Invalid message" } satisfies ServerToUi);
                return;
            }

            if (role === "agent") this.handleAgentMessage(client, msg as AgentToServer);
            else this.handleUiMessage(client, msg as UiToServer);
        });

        (client as any).on("close", () => {
            this.handleDisconnect(client);
        });
    }

    // Sockets bypass the HTTP interceptor, so opening a shell has to record itself.
    private async recordShellOpen(ui: WebSocket, agentUuid: string, sessionId: string, runAs: RunAs) {
        const userId = (ui as any).__userId;
        await this.audit.record({
            action: "remote.shell.start",
            category: "remote",
            outcome: "success",
            actorUserId: userId,
            actorEmail: await this.audit.lookupLabel("user", userId),
            targetType: "device",
            targetId: agentUuid,
            targetLabel: await this.audit.lookupLabel("device", agentUuid),
            req: (ui as any).__upgradeRequest,
            details: { sessionId, runAs },
        });
    }

    private reject(client: WebSocket, code: number, message: string) {
        wsSend(client, { type: "error", message } satisfies ServerToUi);
        try {
            client.close(code, message);
        } catch { }
    }

    private async authorizeAgent(client: WebSocket, req: IncomingMessage, requestedAgent: string): Promise<boolean> {
        const agent = await this.wsAuth.authenticateAgent(req);
        if (!agent || (requestedAgent !== agent.id && requestedAgent !== agent.agentUuid)) {
            this.reject(client, CLOSE_UNAUTHORIZED, "Invalid agent token");
            return false;
        }
        if ((client as any).readyState !== WS_OPEN) return false;

        const agentUuid = agent.agentUuid;
        (client as any).__role = "agent";
        (client as any).__agentUuid = agentUuid;
        // Agents check signatures against this id, which is not the uuid sockets are keyed by.
        (client as any).__agentId = agent.id;

        const existing = this.agentsByAgentUuid.get(agentUuid);
        if (existing && existing !== client) {
            try {
                existing.close();
            } catch { }
        }

        this.agentsByAgentUuid.set(agentUuid, client);
        this.logger.log(`Agent connected for agentUuid ${agentUuid}`);

        for (const [uiSock, uiAgent] of this.uiAgentBySocket.entries()) {
            if (uiAgent === agentUuid) {
                wsSend(uiSock, { type: "status", status: "agent_connected", agentUuid } satisfies ServerToUi);
            }
        }
        return true;
    }

    private async authorizeUi(client: WebSocket, req: IncomingMessage, requestedAgent: string): Promise<boolean> {
        if (!this.wsAuth.isOriginAllowed(req)) {
            this.reject(client, CLOSE_FORBIDDEN, "Origin not allowed");
            return false;
        }

        const user = await this.wsAuth.authenticateUser(req);
        if (!user) {
            this.reject(client, CLOSE_UNAUTHORIZED, "Not authenticated");
            return false;
        }
        if (!user.permissions.has(SHELL_PERMISSION)) {
            this.reject(client, CLOSE_FORBIDDEN, "Insufficient permissions");
            return false;
        }

        const agent = await this.wsAuth.resolveAgent(requestedAgent);
        // A person limited to some customers cannot open a shell on another customer's device (same rule as the
        // remote console); it looks exactly like an unknown agent.
        if (!agent || !(await this.access.canSeeDevice(await this.access.scopeFor(user.id), agent.deviceId))) {
            this.reject(client, CLOSE_FORBIDDEN, "Unknown agent");
            return false;
        }
        const agentUuid = agent.agentUuid;
        if ((client as any).readyState !== WS_OPEN) return false;

        (client as any).__role = "ui";
        (client as any).__agentUuid = agentUuid;
        (client as any).__userId = user.id;
        (client as any).__upgradeRequest = req;
        this.uiAgentBySocket.set(client, agentUuid);

        const hasAgent = this.agentsByAgentUuid.has(agentUuid);
        wsSend(client, {
            type: "status",
            status: hasAgent ? "agent_connected" : "waiting_for_agent",
            agentUuid,
        } satisfies ServerToUi);

        this.logger.log(`UI connected for agentUuid ${agentUuid} user=${user.id}`);
        return true;
    }

    handleDisconnect(client: WebSocket) {
        const role = ((client as any).__role as Role) || "ui";
        const agentUuid = String((client as any).__agentUuid || "");

        if (role === "agent") {
            const sock = this.agentsByAgentUuid.get(agentUuid);
            if (sock === client) {
                this.agentsByAgentUuid.delete(agentUuid);
                this.logger.log(`Agent disconnected for agentUuid ${agentUuid}`);

                for (const [uiSock, uiAgent] of this.uiAgentBySocket.entries()) {
                    if (uiAgent === agentUuid) {
                        wsSend(uiSock, { type: "status", status: "agent_disconnected", agentUuid } satisfies ServerToUi);
                    }
                }

                for (const [sid, sess] of this.sessions.entries()) {
                    if (sess.agentUuid === agentUuid) {
                        wsSend(sess.ui, { type: "exit", sessionId: sid, message: "Agent disconnected." } satisfies ServerToUi);
                        this.sessions.delete(sid);
                    }
                }
            }
            return;
        }

        // UI disconnect
        if (agentUuid) {
            this.uiAgentBySocket.delete(client);

            for (const [sid, sess] of this.sessions.entries()) {
                if (sess.ui === client) {
                    const agent = this.agentsByAgentUuid.get(sess.agentUuid);
                    if (agent) wsSend(agent, { type: "shell.close", sessionId: sid } satisfies ServerToAgent);
                    this.sessions.delete(sid);
                }
            }
        }
    }

    private handleUiMessage(ui: WebSocket, msg: UiToServer) {
        const agentUuid = this.uiAgentBySocket.get(ui);
        if (!agentUuid) {
            wsSend(ui, { type: "error", message: "UI socket not registered" } satisfies ServerToUi);
            return;
        }

        const agent = this.agentsByAgentUuid.get(agentUuid);

        switch (msg.type) {
            case "open": {
                if (!agent) {
                    wsSend(ui, { type: "error", message: "Agent not connected for this agentUuid." } satisfies ServerToUi);
                    return;
                }

                // Policy: one active shell per device (agentUuid)
                for (const [, s] of this.sessions.entries()) {
                    if (s.agentUuid === agentUuid) {
                        wsSend(ui, { type: "error", message: "A shell session is already active for this device." } satisfies ServerToUi);
                        return;
                    }
                }

                const runAs: RunAs = msg.runAs === "user" ? "user" : "system";

                const sessionId = randomUUID();
                this.sessions.set(sessionId, { agentUuid, ui });

                this.logger.log(`Shell open: agent=${agentUuid} session=${sessionId} runAs=${runAs} user=${(ui as any).__userId ?? ""}`);
                void this.recordShellOpen(ui, agentUuid, sessionId, runAs);

                wsSend(ui, { type: "session", sessionId, agentUuid } satisfies ServerToUi);

                wsSend(agent, {
                    type: "shell.open",
                    sessionId,
                    cols: msg.cols,
                    rows: msg.rows,
                    runAs,
                    ...this.signer.sessionStartField(String((agent as any).__agentId), "shell", sessionId, { runAs }),
                } satisfies ServerToAgent);
                return;
            }

            case "input": {
                const sess = this.sessions.get(msg.sessionId);
                if (!sess || sess.ui !== ui) {
                    wsSend(ui, { type: "error", message: "Unknown session" } satisfies ServerToUi);
                    return;
                }
                const a = this.agentsByAgentUuid.get(sess.agentUuid);
                if (!a) {
                    wsSend(ui, { type: "error", message: "Agent disconnected" } satisfies ServerToUi);
                    return;
                }
                wsSend(a, { type: "shell.input", sessionId: msg.sessionId, data: msg.data } satisfies ServerToAgent);
                return;
            }

            case "signal": {
                const sess = this.sessions.get(msg.sessionId);
                if (!sess || sess.ui !== ui) {
                    wsSend(ui, { type: "error", message: "Unknown session" } satisfies ServerToUi);
                    return;
                }
                const a = this.agentsByAgentUuid.get(sess.agentUuid);
                if (!a) {
                    wsSend(ui, { type: "error", message: "Agent disconnected" } satisfies ServerToUi);
                    return;
                }
                wsSend(a, { type: "shell.signal", sessionId: msg.sessionId, signal: msg.signal } satisfies ServerToAgent);
                return;
            }

            case "resize": {
                const sess = this.sessions.get(msg.sessionId);
                if (!sess || sess.ui !== ui) return;
                const a = this.agentsByAgentUuid.get(sess.agentUuid);
                if (!a) return;
                wsSend(a, { type: "shell.resize", sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows } satisfies ServerToAgent);
                return;
            }

            case "close": {
                const sess = this.sessions.get(msg.sessionId);
                if (!sess || sess.ui !== ui) return;

                const a = this.agentsByAgentUuid.get(sess.agentUuid);
                if (a) wsSend(a, { type: "shell.close", sessionId: msg.sessionId } satisfies ServerToAgent);

                this.sessions.delete(msg.sessionId);

                this.logger.log(`Shell close: agent=${sess.agentUuid} session=${msg.sessionId}`);

                wsSend(ui, { type: "exit", sessionId: msg.sessionId, message: "Session closed." } satisfies ServerToUi);
                return;
            }
        }
    }

    private handleAgentMessage(agent: WebSocket, msg: AgentToServer) {
        // An agent may only write to sessions opened on its own device.
        const self = String((agent as any).__agentUuid || "");

        switch (msg.type) {
            case "hello":
                return;

            case "shell.ready": {
                // Optional: you could forward a "ready" status, but session is already emitted to UI.
                return;
            }

            case "shell.data": {
                const sess = this.sessions.get(msg.sessionId);
                if (!sess || sess.agentUuid !== self) return;
                wsSend(sess.ui, { type: "data", sessionId: msg.sessionId, data: msg.data } satisfies ServerToUi);
                return;
            }

            case "shell.exit": {
                const sess = this.sessions.get(msg.sessionId);
                if (!sess || sess.agentUuid !== self) return;
                wsSend(sess.ui, {
                    type: "exit",
                    sessionId: msg.sessionId,
                    code: msg.code,
                    signal: msg.signal,
                    message: msg.message,
                } satisfies ServerToUi);
                this.sessions.delete(msg.sessionId);

                this.logger.log(`Shell exit: agent=${sess.agentUuid} session=${msg.sessionId} code=${msg.code ?? ""} signal=${msg.signal ?? ""}`);

                return;
            }

            case "shell.error": {
                if (msg.sessionId) {
                    const sess = this.sessions.get(msg.sessionId);
                    if (sess && sess.agentUuid === self) {
                        wsSend(sess.ui, { type: "error", message: msg.message } satisfies ServerToUi);
                        wsSend(sess.ui, { type: "exit", sessionId: msg.sessionId, message: msg.message } satisfies ServerToUi);
                        this.sessions.delete(msg.sessionId);

                        this.logger.log(`Shell error: agent=${sess.agentUuid} session=${msg.sessionId} message=${msg.message}`);
                    }
                }
                return;
            }
        }
    }
}
