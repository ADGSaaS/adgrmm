import { Module, forwardRef } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { SmtpModule } from "../smtp/smtp.module";
import { StorageModule } from "../storage/storage.module";
import { TemplatesModule } from "../templates/templates.module";
import { TicketsModule } from "../tickets/tickets.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { SurveysService } from "./surveys.service";
import { SurveysAdminController, SurveyPublicController, TicketSurveyController } from "./surveys.controller";

/** The portal-side controller (SurveyPortalController) is registered by PortalModule, which owns the portal sign-in guard. */
@Module({
    imports: [StorageModule, SmtpModule, TemplatesModule, WebhooksModule, AuditModule, AuthModule, forwardRef(() => TicketsModule)],
    controllers: [SurveysAdminController, TicketSurveyController, SurveyPublicController],
    providers: [SurveysService],
    exports: [SurveysService],
})
export class SurveysModule { }
