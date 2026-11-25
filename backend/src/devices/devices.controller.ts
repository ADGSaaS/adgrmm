// backend/src/devices/devices.controller.ts
import { ClientAccessService } from "../reports/client-access.service";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { IsOptional, IsString } from "class-validator";

import { ListDevicesQuery } from "./dto";
import { DevicesService, type Device, type DeviceCounts, type DeviceFilter } from "./devices.service";
import { RequirePerm } from "../auth/require-perm.decorator";

class MoveDeviceSiteDto {
  // preferred (camelCase)
  @IsOptional()
  @IsString()
  siteId?: string;

  // fallback (snake_case) — helps if some UI code sends site_id
  @IsOptional()
  @IsString()
  site_id?: string;
}

@Controller("/api/devices")
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class DevicesController {
  constructor(private readonly devices: DevicesService, private readonly access: ClientAccessService) { }

  private scope(req: any) {
    return this.access.scopeFor(req?.user?.id ? String(req.user.id) : null);
  }

  private filterOf(q: ListDevicesQuery): DeviceFilter {
    return { q: q.q, status: q.status, os: q.os, platform: q.platform, tagIds: q.tag, clientId: q.clientId, siteId: q.siteId, places: q.place };
  }

  /** A device outside a limited person's customers is reported as not found. */
  private async visible(req: any, id: string): Promise<Device> {
    const dev = await this.devices.getOne(id);
    if (!dev || !(await this.access.canSeeDevice(await this.scope(req), id))) throw new NotFoundException("Device not found");
    return dev;
  }

  @Get()
  @RequirePerm("devices.read")
  async list(
    @Req() req: any,
    @Query() query: ListDevicesQuery
  ): Promise<{ items: Device[]; nextCursor: string | null; total?: number }> {
    return this.devices.list({ ...this.filterOf(query), pageSize: query.pageSize, cursor: query.cursor, offset: query.offset, sort: query.sort, dir: query.dir, withTotal: query.total, scope: await this.scope(req) });
  }

  /** Counts for the dashboard, the customers tree and the filters: the same narrowing as the list (q, status, os, tag, clientId, siteId, place), over every device. */
  @Get("counts")
  @RequirePerm("devices.read")
  async counts(@Req() req: any, @Query() query: ListDevicesQuery): Promise<DeviceCounts> {
    return this.devices.counts({ ...this.filterOf(query), scope: await this.scope(req) });
  }

  /** The devices a filter matches, as ids and host names (at most 500, and how many match in all): what "select all N matching" in the list uses. */
  @Get("ids")
  @RequirePerm("devices.read")
  async ids(@Req() req: any, @Query() query: ListDevicesQuery): Promise<{ items: Array<{ id: string; hostname: string }>; total: number; limit: number }> {
    const limit = 500;
    const r = await this.devices.ids({ ...this.filterOf(query), limit, sort: query.sort, dir: query.dir, scope: await this.scope(req) });
    return { ...r, limit };
  }

  @Get(":id")
  @RequirePerm("devices.read")
  async getOne(@Req() req: any, @Param("id") id: string): Promise<Device> {
    return this.visible(req, id);
  }

  @Get(":id/checks")
  @RequirePerm("devices.read")
  async checks(@Req() req: any, @Param("id") id: string): Promise<{ items: never[] }> {
    // Ensure device exists (clean 404 instead of weird downstream issues)
    await this.visible(req, id);

    // No table holds check results by device under this route's shape; ChecksReadController has the real data.
    return { items: [] };
  }

  @Post(":id/deletion-requests")
  @RequirePerm("devices.read")
  @HttpCode(202)
  async requestDeletion(@Req() req: any, @Param("id") id: string, @Body() body: { reason?: unknown; createTicket?: unknown }) {
    await this.visible(req, id);
    const userId = req?.user?.id ? String(req.user.id) : null;
    return await this.devices.requestDeviceDeletion(id, userId, { reason: body?.reason, createTicket: body?.createTicket });
  }

  // What the approver needs to see before approving: who asked, why, and the ticket.
  @Get(":id/deletion-requests")
  @RequirePerm("devices.read")
  async deletionRequest(@Req() req: any, @Param("id") id: string) {
    await this.visible(req, id);
    return await this.devices.getDeletionRequest(id);
  }

  @Post(":id/deletion-requests/approve")
  @RequirePerm("devices.delete")
  async approveDeletion(@Req() req: any, @Param("id") id: string) {
    await this.visible(req, id);
    const userId = req?.user?.id ? String(req.user.id) : null;
    return await this.devices.approveAndDeleteDevice(id, userId);
  }

  @Get(":id/software")
  @RequirePerm("devices.read")
  async software(
    @Req() req: any,
    @Param("id") id: string
  ): Promise<{
    items: Array<{
      id: string;
      name: string;
      version: string;
      publisher?: string | null;
      installDate?: string | null;
      scope: "machine" | "user";
      user: string | null;
      installedBy: string | null;
    }>;
  }> {
    await this.visible(req, id);
    const items = await this.devices.listSoftware(id);
    return { items };
  }

  // Move a device to another site, which may be at another customer.
  // A person limited to some customers can only move devices they can see, into sites they can use.
  @Patch(":id/site")
  @RequirePerm("devices.write")
  async moveToSite(@Req() req: any, @Param("id") id: string, @Body() body: MoveDeviceSiteDto): Promise<Device> {
    const siteIdRaw = (body?.siteId ?? body?.site_id ?? "") as string;
    const siteId = String(siteIdRaw).trim();

    if (!siteId) throw new BadRequestException("siteId is required");
    const dev = await this.visible(req, id);
    if (!(await this.access.canSeeSite(await this.scope(req), siteId))) throw new NotFoundException("Target site not found");
    return await this.devices.moveToSite(dev.id, siteId);
  }
}
