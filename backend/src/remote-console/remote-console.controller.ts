// backend/src/remote-console/remote-console.controller.ts

import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { RemoteConsoleService } from "./remote-console.service";
import { RequirePerm } from "../auth/require-perm.decorator";

@Controller("/api/remote-console")
export class RemoteConsoleController {
    constructor(private readonly rc: RemoteConsoleService) { }

    /**
     * TECH UI calls this to start a remote console session.
     * Auth is enforced by your existing global guards.
     */
    @Post("/sessions")
    @RequirePerm("devices.actions")
    async createSession(@Req() req: any, @Body() body: { agentId: string }) {
        const agentId = String(body?.agentId || "").trim();
        const { sessionId, sessionToken, iceServers, recording } = await this.rc.createSession(agentId, {
            id: String(req?.user?.id ?? ""),
            name: String(req?.user?.name || req?.user?.email || "Another technician"),
        });

        return {
            sessionId,
            sessionToken,
            iceServers,
            // True when the person at the device has been told this session is recorded and the browser may record it.
            recording,
            wsPath: "/ws/remote-console",
        };
    }

    /** The technician's browser says how the session reached the computer (directly or through the relay) and how much video came through. */
    @Post("/sessions/:id/transport")
    @RequirePerm("devices.actions")
    async transport(@Req() req: any, @Param("id") id: string, @Body() body: { relay?: boolean; bytesReceived?: number }) {
        return this.rc.noteTransport(id, req?.user?.id ? String(req.user.id) : null, body?.relay === true, Number(body?.bytesReceived ?? 0));
    }

    /** How many sessions in a period went through the relay, and how much data. The relay (Cloudflare TURN) is billed per GB sent to the browser after the free allowance. */
    @Get("/transport-report")
    @RequirePerm("settings.read")
    transportReport(@Query("days") days?: string) {
        return this.rc.transportReport(Number(days) || 30);
    }

}
