// backend/src/billing/billing.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { SmtpModule } from "../smtp/smtp.module";
import { TemplatesModule } from "../templates/templates.module";
import { BillingService } from "./billing.service";
import { BillingController, PublicBillingController } from "./billing.controller";

@Module({
    imports: [StorageModule, SmtpModule, TemplatesModule],
    controllers: [BillingController, PublicBillingController],
    providers: [BillingService],
    exports: [BillingService],
})
export class BillingModule { }
