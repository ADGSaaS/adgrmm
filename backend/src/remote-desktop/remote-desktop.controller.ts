// backend/src/remote-desktop/remote-desktop.controller.ts

import {
    BadRequestException,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
    Post,
    Body,
    ServiceUnavailableException,
    Res,
    Req,
} from "@nestjs/common";
import type { Response } from "express";

import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { RemoteDesktopTunnelService } from "./remote-desktop-tunnel.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { ClientAccessService, type AccessScope } from "../reports/client-access.service";
import { agentIdOrUuidWhere } from "../common/agent-lookup.util";

function asNonEmptyString(v: any): string | null {
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s.length ? s : null;
}

function ensureOneOf(deviceId?: string | null, agentUuid?: string | null) {
    const hasDeviceId = !!deviceId;
    const hasAgentUuid = !!agentUuid;

    if (hasDeviceId && hasAgentUuid) {
        throw new BadRequestException("Please use only one: deviceId OR agentUuid.");
    }
    if (!hasDeviceId && !hasAgentUuid) {
        throw new BadRequestException("You must provide either deviceId or agentUuid.");
    }
}

type CreateSessionBody = {
    deviceId?: string;
    agentUuid?: string;

    // optional overrides
    host?: string;
    port?: number;
};

@Controller("/api/remote-desktop")
export class RemoteDesktopController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly tunnels: RemoteDesktopTunnelService,
        private readonly access: ClientAccessService,
    ) { }

    private scopeOf(req: any): Promise<AccessScope | null> {
        return this.access.scopeFor(req?.user?.id ? String(req.user.id) : null);
    }

    /** Agent keys (agents.id or agent_uuid, any case) a limited person may reach. Null scope: everything. */
    private async visibleAgentKeys(scope: AccessScope, keys: string[]): Promise<Set<string>> {
        const wanted = [...new Set(keys.map((k) => String(k || "").trim().toLowerCase()).filter(Boolean))];
        if (!wanted.length) return new Set();
        const rows = await this.prisma.agents.findMany({
            where: { AND: [{ OR: wanted.map((k) => agentIdOrUuidWhere(k)) }, { devices: this.access.deviceWhere(scope) }] },
            select: { id: true, agent_uuid: true },
        });
        const out = new Set<string>();
        for (const r of rows) {
            out.add(String(r.id).toLowerCase());
            if (r.agent_uuid) out.add(String(r.agent_uuid).toLowerCase());
        }
        return out;
    }

    /** A limited person gets "not found" for an agent that is not on one of their customers' devices. */
    /** A session on a device outside a limited person's customers looks like one that does not exist. */
    private async assertSession(req: any, sid: string) {
        const sess = this.tunnels.listSessions().find((s) => String(s.sessionId) === String(sid));
        if (!sess) return; // the handlers keep their own not-found behaviour
        try {
            await this.assertAgent(req, sess.agentUuid);
        } catch {
            throw new NotFoundException("Session not found");
        }
    }

    private async assertAgent(req: any, agentKey: string) {
        const scope = await this.scopeOf(req);
        if (!scope) return;
        const ok = await this.visibleAgentKeys(scope, [agentKey]);
        if (!ok.has(String(agentKey || "").trim().toLowerCase())) throw new NotFoundException("Device not found");
    }

    /**
     * List connected agents + active sessions (for UI polling).
     */
    @Get("/sessions")
    @RequirePerm("devices.actions")
    async getSessions(@Req() req: any) {
        const agents = this.tunnels.listConnectedAgents();
        const sessions = this.tunnels.listSessions();
        const scope = await this.scopeOf(req);
        if (!scope) return { ok: true, agents, sessions };
        // A person limited to some customers sees only their customers' agents and tunnels.
        const visible = await this.visibleAgentKeys(scope, [...agents, ...sessions.map((s) => s.agentUuid)]);
        const seen = (k: string) => visible.has(String(k || "").trim().toLowerCase());
        return {
            ok: true,
            agents: agents.filter(seen),
            sessions: sessions.filter((s) => seen(s.agentUuid)),
        };
    }

    /**
     * Create an RDP tunnel session.
     * Body must include EXACTLY ONE of: { deviceId } OR { agentUuid }.
     */
    @Post("/sessions")
    @RequirePerm("devices.actions")
    async createSession(@Req() req: any, @Body() body: CreateSessionBody) {
        const deviceId = asNonEmptyString(body?.deviceId);
        const agentUuid = asNonEmptyString(body?.agentUuid);

        ensureOneOf(deviceId, agentUuid);

        // Defaults: Windows RDP on localhost of endpoint
        const host = asNonEmptyString(body?.host) ?? "127.0.0.1";
        const port =
            typeof body?.port === "number" && Number.isFinite(body.port) ? body.port : 3389;

        // A person limited to some customers cannot open a tunnel through another customer's device.
        if (deviceId) await this.access.assertDevice(req?.user?.id ? String(req.user.id) : null, deviceId);
        else await this.assertAgent(req, String(agentUuid));

        let resolvedAgentUuid = agentUuid;

        // If they pass deviceId, resolve to agent id/uuid
        if (!resolvedAgentUuid && deviceId) {
            // agents.device_id is unique, so there is at most one row.
            const row = isCanonicalUuid(deviceId)
                ? await this.prisma.agents.findUnique({
                    where: { device_id: deviceId },
                    select: { id: true, agent_uuid: true },
                })
                : null;

            resolvedAgentUuid = (row?.agent_uuid || row?.id || "").trim() || null;

            if (!resolvedAgentUuid) {
                throw new BadRequestException("No agent is registered for this deviceId yet.");
            }
        }

        try {
            const { sessionId, localPort } = await this.tunnels.openTunnel(String(resolvedAgentUuid), {
                host,
                port,
            });

            // NOTE: localPort is bound on the backend machine (127.0.0.1).
            return {
                ok: true,
                sessionId,
                host: "127.0.0.1",
                port: localPort,
                target: { host, port },
            };
        } catch (e: any) {
            const msg = String(e?.message || e || "Unknown error");

            if (/agent not connected/i.test(msg)) {
                throw new ServiceUnavailableException(
                    "Desktop tunnel agent is not connected. Ensure the Windows agent is running and connected to /ws/desktop-tunnel."
                );
            }

            throw new BadRequestException(msg);
        }
    }

    /**
     * Close a session.
     */
    @Delete("/sessions/:sessionId")
    @RequirePerm("devices.actions")
    async closeSession(@Req() req: any, @Param("sessionId") sessionId: string) {
        const sid = asNonEmptyString(sessionId);
        if (!sid) throw new BadRequestException("sessionId is required");
        await this.assertSession(req, sid);

        await this.tunnels.closeTunnel(sid, "ui_close");
        return { ok: true };
    }

    /**
     * Download an .rdp file for a session.
     * Browser opens this in a new tab/window; Windows should launch MSTSC.
     */
    @Get("/sessions/:sessionId/rdp")
    @RequirePerm("devices.actions")
    async downloadRdp(@Req() req: any, @Param("sessionId") sessionId: string, @Res() res: Response) {
        const sid = asNonEmptyString(sessionId);
        if (!sid) throw new BadRequestException("sessionId is required");
        await this.assertSession(req, sid);

        const sess = this.tunnels.listSessions().find((s) => String(s.sessionId) === String(sid));
        if (!sess) throw new NotFoundException("Session not found");
        if (!sess.localPort || typeof sess.localPort !== "number") {
            throw new BadRequestException("Session has no localPort");
        }
        if (String(sess.state) !== "ready") {
            throw new BadRequestException(`Session is not ready (state=${sess.state})`);
        }

        const fullAddress = `127.0.0.1:${sess.localPort}`;

        const rdp = [
            `full address:s:${fullAddress}`,
            `prompt for credentials:i:1`,
            `administrative session:i:0`,
            `screen mode id:i:2`,
            `use multimon:i:0`,
            `compression:i:1`,
            `redirectclipboard:i:1`,
            `redirectprinters:i:0`,
            `redirectcomports:i:0`,
            `redirectsmartcards:i:0`,
            `redirectposdevices:i:0`,
            `autoreconnection enabled:i:1`,
            `authentication level:i:2`,
            `negotiate security layer:i:1`,
            `enablecredsspsupport:i:1`,
            ``,
        ].join("\r\n");

        res.setHeader("Content-Type", "application/x-rdp; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="adgrmm-${sid}.rdp"`);
        res.status(200).send(rdp);
    }
}
