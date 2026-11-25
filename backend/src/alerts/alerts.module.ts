import { Module } from "@nestjs/common";
import { AlertsService } from "./alerts.service";
import { AlertsController } from "./alerts.controller";
import { StorageModule } from "../storage/storage.module";
import { TicketsModule } from "../tickets/tickets.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PoliciesModule } from "../policies/policies.module";
import { AccessModule } from "../access/access.module";
import { WebhooksModule } from "../webhooks/webhooks.module";

@Module({
    imports: [StorageModule, TicketsModule, NotificationsModule, PoliciesModule, AccessModule, WebhooksModule],
    controllers: [AlertsController],
    providers: [AlertsService],
    exports: [AlertsService],
})
export class AlertsModule { }
