import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { SmtpModule } from "../smtp/smtp.module";
import { CustomFieldsService } from "../customers/custom-fields.service";
import { EmailTemplatesService } from "./email-templates.service";
import { TicketTemplatesService } from "./ticket-templates.service";
import { EmailTemplatesController, TicketTemplatesController } from "./templates.controller";

@Module({
    // CustomFieldsService needs only the database, so it is provided here rather than importing the customers module (which would be a cycle through the portal).
    imports: [StorageModule, SmtpModule],
    controllers: [TicketTemplatesController, EmailTemplatesController],
    providers: [EmailTemplatesService, TicketTemplatesService, CustomFieldsService],
    exports: [EmailTemplatesService],
})
export class TemplatesModule { }
