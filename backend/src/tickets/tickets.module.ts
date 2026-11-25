import { Module } from "@nestjs/common";
import { TicketsController } from "./tickets.controller";
import { TicketsService } from "./tickets.service";

import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { CannedResponsesService } from "./canned-responses.service";
import { AdminTicketingController } from "./admin-ticketing.controller";
import { TicketTimeController } from "./ticket-time.controller";
import { TicketTimeService } from "./ticket-time.service";
import { SupportMailboxModule } from "../support-mailbox/support-mailbox.module";
import { CustomersModule } from "../customers/customers.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { TicketCustomFieldsController } from "./ticket-custom-fields.controller";
import { AccessModule } from "../access/access.module";
import { ServiceDeskModule } from "../service-desk/service-desk.module";
import { TicketLinksController } from "./ticket-links.controller";
import { TicketDevicesService } from "./ticket-devices";
import { TicketContactsService } from "./ticket-contacts";

@Module({
  imports: [AuthModule, StorageModule, SupportMailboxModule, CustomersModule, WebhooksModule, AccessModule, ServiceDeskModule],
  controllers: [TicketsController, AdminTicketingController, TicketTimeController, TicketCustomFieldsController, TicketLinksController],
  providers: [TicketsService, CannedResponsesService, TicketTimeService, TicketDevicesService, TicketContactsService],
  exports: [TicketsService, CannedResponsesService, TicketTimeService, TicketDevicesService, TicketContactsService],
})
export class TicketsModule { }
