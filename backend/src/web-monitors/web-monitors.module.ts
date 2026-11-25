import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { SmtpModule } from "../smtp/smtp.module";
import { StorageModule } from "../storage/storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { WebMonitorsController } from "./web-monitors.controller";
import { WebMonitorsService } from "./web-monitors.service";

@Module({
    imports: [StorageModule, AccessModule, SmtpModule, WebhooksModule],
    controllers: [WebMonitorsController],
    providers: [WebMonitorsService],
    exports: [WebMonitorsService],
})
export class WebMonitorsModule { }
