import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ReportsModule } from "../reports/reports.module";
import { BillingModule } from "../billing/billing.module";
import { SmtpModule } from "../smtp/smtp.module";
import { TemplatesModule } from "../templates/templates.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { KbModule } from "../kb/kb.module";
import { ServiceDeskModule } from "../service-desk/service-desk.module";
import { StorageModule } from "../storage/storage.module";
import { SurveysModule } from "../surveys/surveys.module";
import { SurveyPortalController } from "../surveys/surveys.controller";
import { PortalAccountsService } from "./portal-accounts.service";
import { PortalAdminController } from "./portal-admin.controller";
import { PortalAuthService } from "./portal-auth.service";
import { PortalDataService } from "./portal-data.service";
import { PortalSettingsService } from "./portal-settings.service";
import { PortalController, PortalGuard } from "./portal.controller";

@Module({
    imports: [StorageModule, SmtpModule, TemplatesModule, WebhooksModule, BillingModule, AccessModule, AuditModule, AuthModule, ReportsModule, ServiceDeskModule, KbModule, SurveysModule],
    controllers: [PortalController, PortalAdminController, SurveyPortalController],
    providers: [PortalSettingsService, PortalAuthService, PortalDataService, PortalAccountsService, PortalGuard],
    exports: [PortalSettingsService, PortalAccountsService],
})
export class PortalModule { }
