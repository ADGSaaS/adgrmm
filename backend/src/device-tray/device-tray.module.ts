import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AutoRepairModule } from "../auto-repair/auto-repair.module";
import { AuditModule } from "../audit/audit.module";
import { ServiceDeskModule } from "../service-desk/service-desk.module";
import { SmtpModule } from "../smtp/smtp.module";
import { StorageModule } from "../storage/storage.module";
import { TicketsModule } from "../tickets/tickets.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { AgentTrayController, DeviceChatController, TrayAdminController } from "./device-tray.controller";
import { DeviceTrayService } from "./device-tray.service";

@Module({
    imports: [StorageModule, AccessModule, AuditModule, TicketsModule, ServiceDeskModule, SmtpModule, AutoRepairModule, WebhooksModule],
    controllers: [AgentTrayController, TrayAdminController, DeviceChatController],
    providers: [DeviceTrayService],
    exports: [DeviceTrayService],
})
export class DeviceTrayModule { }
