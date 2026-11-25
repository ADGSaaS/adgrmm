// backend/src/reports/reports.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { SmtpModule } from "../smtp/smtp.module";
import { ReportsService } from "./reports.service";
import { EndpointReportsService } from "./endpoint-reports.service";
import { ReportViewsService } from "./report-views.service";
import { FullReportService } from "./full-report.service";
import { DeviceHistoryService } from "./device-history.service";
import { CustomReportsService } from "./custom-reports.service";
import { SoftwarePoliciesService } from "./software-policies.service";
import { ReportSettingsService } from "./report-settings.service";
import { ClientBrandingService } from "./client-branding.service";
import { ClientBrandingController } from "./client-branding.controller";
import { ClientAccessService } from "./client-access.service";
import { ClientAccessController } from "./client-access.controller";
import { ReportsController } from "./reports.controller";
import { PoliciesModule } from "../policies/policies.module";
import { AccessModule } from "../access/access.module";
import { AssetsModule } from "../assets/assets.module";

@Module({
    imports: [StorageModule, SmtpModule, PoliciesModule, AccessModule, AssetsModule],
    controllers: [ReportsController, ClientBrandingController, ClientAccessController],
    providers: [ReportsService, EndpointReportsService, ReportViewsService, FullReportService, DeviceHistoryService, CustomReportsService, SoftwarePoliciesService, ReportSettingsService, ClientBrandingService],
    exports: [ReportsService, EndpointReportsService, ReportViewsService, FullReportService, DeviceHistoryService, CustomReportsService, SoftwarePoliciesService, ReportSettingsService, ClientBrandingService, AccessModule],
})
export class ReportsModule { }
