import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { SmtpModule } from "../smtp/smtp.module";
import { StorageModule } from "../storage/storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { PerformanceService } from "./performance.service";
import { QueuesService } from "./queues.service";
import { RoutingService } from "./routing.service";
import { QueuesController, RoutingController, SlaController } from "./service-desk.controller";
import { ServiceDeskService } from "./service-desk.service";
import { SlaService } from "./sla.service";

/** SLAs, queues and routing rules. Imports nothing from the tickets module, so tickets, the portal and the mailbox can all use it. */
@Module({
    imports: [StorageModule, WebhooksModule, SmtpModule, AccessModule],
    controllers: [SlaController, QueuesController, RoutingController],
    providers: [PerformanceService, SlaService, QueuesService, RoutingService, ServiceDeskService],
    exports: [PerformanceService, ServiceDeskService, SlaService, QueuesService, RoutingService],
})
export class ServiceDeskModule { }
