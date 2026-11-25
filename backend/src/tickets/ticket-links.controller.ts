import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { RequirePerm } from "../auth/require-perm.decorator";
import { DeviceAccessGuard } from "../access/device-access.guard";
import { TicketDevicesService } from "./ticket-devices";
import { TicketContactsService } from "./ticket-contacts";

/** Devices on a ticket, a device's tickets, and a customer's contacts for the ticket form. */
@Controller("/api")
@UsePipes(new ValidationPipe({ whitelist: false, transform: false }))
export class TicketLinksController {
    constructor(private readonly devices: TicketDevicesService, private readonly contacts: TicketContactsService) { }

    @Get("tickets/:id/devices")
    @RequirePerm("tickets.read")
    listDevices(@Param("id") id: string, @Req() req: any) {
        return this.devices.list(id, req);
    }

    @Post("tickets/:id/devices")
    @HttpCode(201)
    @RequirePerm("tickets.write")
    addDevice(@Param("id") id: string, @Body() body: { deviceId?: string }, @Req() req: any) {
        return this.devices.add(id, body?.deviceId, req);
    }

    @Delete("tickets/:id/devices/:deviceId")
    @RequirePerm("tickets.write")
    removeDevice(@Param("id") id: string, @Param("deviceId") deviceId: string, @Req() req: any) {
        return this.devices.remove(id, deviceId, req);
    }

    /** The device page's tickets: open ones first, then the most recent. */
    @Get("devices/:id/tickets")
    @UseGuards(DeviceAccessGuard)
    @RequirePerm("tickets.read")
    deviceTickets(@Param("id") id: string, @Query("limit") limit: string | undefined, @Req() req: any) {
        return this.devices.forDevice(id, req, Number(limit) || 25);
    }

    @Get("ticket-contacts")
    @RequirePerm("tickets.read")
    searchContacts(@Query("clientId") clientId: string, @Query("q") q: string | undefined, @Req() req: any) {
        return this.contacts.search(String(clientId ?? ""), q, req);
    }

    @Post("ticket-contacts")
    @RequirePerm("tickets.write")
    createContact(@Body() body: any, @Req() req: any) {
        return this.contacts.create(body ?? {}, req);
    }
}
