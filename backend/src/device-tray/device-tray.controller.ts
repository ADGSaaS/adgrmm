// backend/src/device-tray/device-tray.controller.ts
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { AuditService } from "../audit/audit.service";
import { AgentTokenGuard, getAgentFromRequest } from "../common/agent-token.util";
import { DeviceTrayService, type Actor } from "./device-tray.service";

const actorOf = (req: any): Actor => {
    const u = req?.user;
    return { id: u?.id ? String(u.id) : null, name: u?.name ? String(u.name) : u?.email ? String(u.email) : null, organizationId: (u?.organizationId ?? u?.org ?? null) ? String(u?.organizationId ?? u?.org) : null };
};

/** What the tray app on a device asks, with the agent's own token (the tray talks to the agent, and the agent to here). */
@Public()
@Controller("api/agent/tray")
@UseGuards(AgentTokenGuard)
@UsePipes(new ValidationPipe({ whitelist: false, transform: true }))
export class AgentTrayController {
    constructor(private readonly tray: DeviceTrayService) { }

    @Get("status")
    status(@Req() req: any) { return this.tray.status(String(getAgentFromRequest(req).id)); }

    @Post("help")
    @HttpCode(200)
    help(@Req() req: any, @Body() body: any) { return this.tray.help(String(getAgentFromRequest(req).id), body ?? {}); }

    @Get("tickets/:number")
    ticket(@Req() req: any, @Param("number") number: string) { return this.tray.ticketForDevice(String(getAgentFromRequest(req).id), number); }

    @Post("tickets/:number/reply")
    @HttpCode(200)
    ticketReply(@Req() req: any, @Param("number") number: string, @Body() body: any) { return this.tray.ticketReplyFromDevice(String(getAgentFromRequest(req).id), number, body ?? {}); }

    @Get("chat")
    chat(@Req() req: any, @Query("after") after?: string) { return this.tray.chatForDevice(String(getAgentFromRequest(req).id), after); }

    @Post("contact")
    @HttpCode(200)
    contact(@Req() req: any, @Body() body: any) { return this.tray.setContact(String(getAgentFromRequest(req).id), body ?? {}); }

    @Post("chat/end")
    @HttpCode(200)
    endChat(@Req() req: any, @Body() body: any) { return this.tray.endFromDevice(String(getAgentFromRequest(req).id), body ?? {}); }

    @Post("tickets/:number/resolve")
    @HttpCode(200)
    resolve(@Req() req: any, @Param("number") number: string, @Body() body: any) { return this.tray.ticketResolveFromDevice(String(getAgentFromRequest(req).id), number, body ?? {}); }

    @Post("chat")
    @HttpCode(200)
    send(@Req() req: any, @Body() body: any) { return this.tray.sendFromDevice(String(getAgentFromRequest(req).id), body ?? {}); }
}

/** Administration > Agents & Endpoints > Tray app. */
@Controller("api/admin/tray")
export class TrayAdminController {
    constructor(private readonly tray: DeviceTrayService, private readonly audit: AuditService) { }

    private org(req: any): string {
        const org = req?.user?.organizationId ?? null;
        if (!org) throw new BadRequestException("No organization in the session.");
        return String(org);
    }

    @Get()
    @RequirePerm("settings.read")
    get(@Req() req: any) { return this.tray.settings(this.org(req)); }

    @Put()
    @RequirePerm("settings.write")
    async save(@Req() req: any, @Body() body: any) {
        const org = this.org(req);
        const { before, after } = await this.tray.saveSettings(org, req.user?.id ? String(req.user.id) : null, body && typeof body === "object" ? body : {});
        await this.audit.record({
            action: "tray.settings.update", category: "settings", outcome: "success", actorUserId: req.user?.id, actorEmail: req.user?.email, targetType: "organization", targetId: org,
            metadata: { before, after },
        } as any).catch(() => undefined);
        return after;
    }
}

/** The chat from the technicians' side. */
@Controller("api/device-chat")
export class DeviceChatController {
    constructor(private readonly tray: DeviceTrayService) { }

    @Get()
    @RequirePerm("devices.read")
    list(@Req() req: any) { return this.tray.conversations(actorOf(req)); }

    @Get("unread")
    @RequirePerm("devices.read")
    async unread(@Req() req: any) { return { unread: await this.tray.unreadCount(actorOf(req)) }; }

    @Get(":deviceId")
    @RequirePerm("devices.read")
    thread(@Req() req: any, @Param("deviceId") deviceId: string) { return this.tray.thread(actorOf(req), deviceId); }

    @Get(":deviceId/sessions/:sessionId")
    @RequirePerm("devices.read")
    sessionTranscript(@Req() req: any, @Param("deviceId") deviceId: string, @Param("sessionId") sessionId: string) { return this.tray.sessionTranscript(actorOf(req), deviceId, sessionId); }

    @Post(":deviceId/end")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    end(@Req() req: any, @Param("deviceId") deviceId: string) { return this.tray.endFromTech(actorOf(req), deviceId); }

    @Post(":deviceId")
    @HttpCode(200)
    @RequirePerm("devices.actions")
    reply(@Req() req: any, @Param("deviceId") deviceId: string, @Body() body: any) { return this.tray.reply(actorOf(req), deviceId, body ?? {}); }
}
