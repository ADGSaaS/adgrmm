import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { SmtpModule } from "../smtp/smtp.module";
import { SupportMailboxModule } from "../support-mailbox/support-mailbox.module";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";

@Module({
    imports: [StorageModule, SmtpModule, SupportMailboxModule],
    controllers: [IntegrationsController],
    providers: [IntegrationsService],
})
export class IntegrationsModule { }
