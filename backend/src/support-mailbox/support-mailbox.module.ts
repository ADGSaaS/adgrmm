import { Module } from "@nestjs/common";
import { SmtpModule } from "../smtp/smtp.module";
import { StorageModule } from "../storage/storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { ServiceDeskModule } from "../service-desk/service-desk.module";
import { SupportMailboxController } from "./support-mailbox.controller";
import { SupportMailboxService } from "./support-mailbox.service";

@Module({
    imports: [StorageModule, SmtpModule, WebhooksModule, ServiceDeskModule],
    controllers: [SupportMailboxController],
    providers: [SupportMailboxService],
    exports: [SupportMailboxService],
})
export class SupportMailboxModule { }
