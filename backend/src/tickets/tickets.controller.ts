import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
  ValidationPipe,
  NotFoundException,
  Req,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
} from "@nestjs/common";
import { TicketsService } from "./tickets.service";
import { ListTicketsQuery } from "./dto/list-tickets.dto";
import { CreateTicketDto } from "./dto/create-ticket.dto";
import { UpdateTicketDto } from "./dto/update-ticket.dto";
import { RequirePerm } from "../auth/require-perm.decorator";

import { FilesInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { safeAttachmentExtension } from "../common/upload-safety";
import { CannedResponsesService } from "./canned-responses.service";
import { TicketDevicesService } from "./ticket-devices";

@UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true }))
@Controller("/api/tickets")
export class TicketsController {
  constructor(
    private readonly svc: TicketsService,
    private readonly canned: CannedResponsesService,
    private readonly ticketDevices: TicketDevicesService
  ) { }

  @Get()
  @RequirePerm("tickets.read")
  async list(@Query() q: ListTicketsQuery, @Req() req: any) {
    const result = await this.svc.list(q, req);
    return result.items;
  }

  @Get("canned-responses")
  @RequirePerm("tickets.read")
  async cannedResponses(@Req() req: any) {
    return await this.canned.listForTicketUse(req); // returns [{id,title,body}]
  }

  @Get("canned-variables")
  @RequirePerm("tickets.read")
  async cannedVariables(@Req() req: any) {
    return await this.canned.listVariableDefinitionsForTicketUse(req); // returns [{key,label,description,source}]
  }

  @Get(":id/canned-variables")
  @RequirePerm("tickets.read")
  async cannedVariableValues(@Param("id") id: string, @Req() req: any) {
    await this.svc.assertVisible(id, req);
    return await this.canned.listVariableValuesForTicket(id, req); // returns [{key,value}]
  }

  @Post(":id/canned-render")
  @RequirePerm("tickets.read")
  async renderCanned(
    @Param("id") id: string,
    @Body() body: { template?: string },
    @Req() req: any
  ) {
    await this.svc.assertVisible(id, req);
    const template = String(body?.template ?? "");
    const rendered = await this.canned.renderForTicket(id, template, req);
    return { rendered };
  }

  /**
   * BACKCOMPAT:
   * Older UI called this "Activity".
   * New behavior: "Replies" only (messages). No changes, no internal notes.
   */
  @Get(":id/activity")
  @RequirePerm("tickets.read")
  async activity(@Param("id") id: string, @Req() req: any) {
    return this.svc.getReplies(id, req);
  }

  /**
   * Replies (customer-facing messages)
   */
  @Get(":id/replies")
  @RequirePerm("tickets.read")
  async replies(@Param("id") id: string, @Req() req: any) {
    return this.svc.getReplies(id, req);
  }

  /**
   * Internal Notes (technician-only)
   * Gate with tickets.write so client users can't see notes.
   */
  @Get(":id/notes")
  @RequirePerm("tickets.write")
  async notes(@Param("id") id: string, @Req() req: any) {
    return this.svc.getInternalNotes(id, req);
  }

  @Get(":id/history")
  @RequirePerm("tickets.read")
  async history(@Param("id") id: string, @Req() req: any) {
    return this.svc.getHistory(id, req);
  }

  @Get(":id/linked")
  @RequirePerm("tickets.read")
  async linked(@Param("id") id: string, @Req() req: any) {
    return this.svc.getLinked(id, req);
  }

  @Post(":id/linked")
  @RequirePerm("tickets.write")
  async linkTicket(@Param("id") id: string, @Body() body: { linkedId?: string }, @Req() req: any) {
    const linkedId = String(body?.linkedId ?? "").trim();
    if (!linkedId) throw new BadRequestException("linkedId is required (UUID or ticket number)");
    return this.svc.addLink(id, linkedId, req);
  }

  @Post(":id/attachments")
  @RequirePerm("tickets.write")
  @UseInterceptors(
    FilesInterceptor("files", 10, {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = path.join(process.cwd(), "public", "uploads", "tickets");
          try {
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
          } catch (e) {
            cb(e as any, dir);
          }
        },
        filename: (_req, file, cb) => {
          // Never the client's extension as is: only a known-safe one is kept, anything else (.html, .svg, .js) becomes .bin.
          cb(null, `${randomUUID()}${safeAttachmentExtension(file.originalname)}`);
        },
      }),
      limits: {
        files: 10,
        fileSize: 25 * 1024 * 1024,
      },
    })
  )
  async uploadAttachments(@Param("id") _id: string, @UploadedFiles() files: Express.Multer.File[]) {
    const arr = Array.isArray(files) ? files : [];
    return arr.map((f) => ({
      id: randomUUID(),
      name: f.originalname,
      url: `/static/uploads/tickets/${f.filename}`,
    }));
  }

  @Post(":id/reply")
  @RequirePerm("tickets.write")
  async reply(
    @Param("id") id: string,
    @Body()
    body: {
      body?: string;
      timeWorkedSeconds?: number;
      attachments?: any[];
      notifyCustomer?: boolean;
      submitAs?: "reply" | "reply_and_close" | "reply_and_resolve";
      timeMinutes?: number;
      billable?: boolean;
    },
    @Req() req: any
  ) {
    const submitAs = body?.submitAs;
    if (submitAs === "reply_and_close") {
      await this.svc.update(id, { status: "closed" } as any, req);
    } else if (submitAs === "reply_and_resolve") {
      await this.svc.update(id, { status: "resolved" } as any, req);
    }

    const result = await this.svc.addMessageOrNote(id, req, "message", {
      body: body?.body,
      attachments: body?.attachments,
      notifyCustomer: body?.notifyCustomer,
      time: { minutes: body?.timeMinutes, billable: body?.billable },
      canManualTime: req?.effectivePermissions?.has?.("tickets.time.manual") === true,
    });

    return result;
  }

  @Post(":id/note")
  @RequirePerm("tickets.write")
  async note(
    @Param("id") id: string,
    @Body()
    body: {
      body?: string;
      timeWorkedSeconds?: number;
      attachments?: any[];
      notifyCustomer?: boolean;
      submitAs?: string;
      handoff?: boolean;
      timeMinutes?: number;
      billable?: boolean;
    },
    @Req() req: any
  ) {
    await this.svc.addMessageOrNote(id, req, "note", {
      body: body?.body,
      attachments: body?.attachments,
      notifyCustomer: false,
      handoff: body?.handoff === true,
      time: { minutes: body?.timeMinutes, billable: body?.billable },
      canManualTime: req?.effectivePermissions?.has?.("tickets.time.manual") === true,
    });
    return { ok: true };
  }

  /** The technician has opened the ticket: its replies stop being marked new for them. */
  @Post(":id/read")
  @HttpCode(200)
  @RequirePerm("tickets.read")
  async markRead(@Param("id") id: string, @Req() req: any) {
    await this.svc.markRead(id, req);
    return { ok: true };
  }

  @Get(":id")
  @RequirePerm("tickets.read")
  async getOne(@Param("id") id: string, @Req() req: any) {
    const item = await this.svc.getOne(id, req);
    if (!item) throw new NotFoundException("Ticket not found");
    return item;
  }

  @Post()
  @RequirePerm("tickets.write")
  async create(@Body() dto: CreateTicketDto, @Req() req: any) {
    // A person limited to some customers can only put their own customers' devices on a ticket.
    await this.ticketDevices.assertVisible(req, [...(dto.deviceId ? [dto.deviceId] : []), ...(dto.deviceIds ?? [])]);
    const id = await this.svc.create(dto, req, { enforceRequired: true });
    return { id };
  }

  @Patch(":id")
  @RequirePerm("tickets.write")
  async update(@Param("id") id: string, @Body() dto: UpdateTicketDto, @Req() req: any) {
    if (dto.deviceId) await this.ticketDevices.assertVisible(req, [dto.deviceId]);
    const ok = await this.svc.update(id, dto, req);
    if (!ok) throw new NotFoundException("Ticket not found");
    return { ok: true };
  }
}
