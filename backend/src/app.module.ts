// adgrmm-minimal-e2e/backend/src/app.module.ts

import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join, relative } from "path";
import { staticFileHeaders } from "./common/upload-safety";

import { CommonModule } from "./common/common.module";
import { AuthModule } from "./auth/auth.module";
import { WsModule } from "./ws/ws.module";
import { AgentsModule } from "./agents/agents.module";
import { JobsModule } from "./jobs/jobs.module";
import { DevicesModule } from "./devices/devices.module";
import { HealthModule } from "./health/health.module";
import { AdminModule } from "./admin/admin.module";
import { CompanyModule } from "./company/company.module";
import { BrandingModule } from "./branding/branding.module";
import { LocalizationModule } from "./localization/localization.module";
import { SupportLegalModule } from "./support-legal/support-legal.module";
import { UsersModule } from "./users/users.module";
import { RolesModule } from "./roles/roles.module";
import { GroupsModule } from "./groups/groups.module";
import { SoftwareLibraryModule } from "./software-library/software-library.module";
import { SoftwareUpdatesModule } from "./software-updates/software-updates.module";
import { SearchModule } from "./search/search.module";
import { SmtpModule } from "./smtp/smtp.module";
import { ScheduleModule } from "@nestjs/schedule";
import { ImapModule } from "./imap/imap.module";
import { SupportMailboxModule } from "./support-mailbox/support-mailbox.module";
import { PortalModule } from "./portal/portal.module";
import { ImportsModule } from "./imports/imports.module";
import { SessionCleanerService } from "./maintenance/session-cleaner.service";
import { CustomersModule } from "./customers/customers.module";
import { PoliciesModule } from "./policies/policies.module";
import { BackupsModule } from "./backups/backups.module";
import { StorageModule } from "./storage/storage.module";
import { TicketsModule } from "./tickets/tickets.module";
import { SurveysModule } from "./surveys/surveys.module";
import { TemplatesModule } from "./templates/templates.module";
import { RecurringTicketsModule } from "./recurring-tickets/recurring-tickets.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { WebMonitorsModule } from "./web-monitors/web-monitors.module";
import { DeviceTrayModule } from "./device-tray/device-tray.module";
import { EndpointBackupsModule } from "./endpoint-backups/backup.module";
import { M365Module } from "./m365/m365.module";
import { AutoRepairModule } from "./auto-repair/auto-repair.module";
import { SystemHealthModule } from "./system-health/system-health.module";
import { WorkflowsModule } from "./workflows/workflows.module";
import { EdrModule } from "./edr/edr.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { RemoteShellModule } from "./remote-shell/remote-shell.module";
import { RemoteConsoleModule } from "./remote-console/remote-console.module";
import { RecordingsModule } from "./recordings/recordings.module";
import { AuthCookieMiddleware } from "./auth/auth-cookie.middleware";
import { CompatModule } from "./compat/compat.module";
import { PatchesModule } from "./patches/patches.module";
import { DispatchModule } from "./schedule/schedule.module";
import { AuditModule } from "./audit/audit.module";

// ✅ NEW
import { ProvisioningModule } from "./provisioning/provisioning.module";

// ✅ NEW (Remote Desktop tunnel)
import { RemoteDesktopModule } from "./remote-desktop/remote-desktop.module";
import { AlertsModule } from "./alerts/alerts.module";
import { BillingModule } from "./billing/billing.module";
import { ItDocsModule } from "./itdocs/itdocs.module";
import { ReportsModule } from "./reports/reports.module";
import { DemoModule } from "./demo/demo.module";
import { DemoModeModule } from "./demo-mode/demo-mode.module";
import { FlagsModule } from "./flags/flags.module";
import { ComplianceModule } from "./compliance/compliance.module";
import { DataExchangeModule } from "./data-exchange/data-exchange.module";
import { AutomationModule } from "./automation/automation.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { KbModule } from "./kb/kb.module";

import { BulkModule } from "./bulk/bulk.module";
import { ToolsModule } from "./tools/tools.module";
import { DeviceMetricsModule } from "./device-metrics/device-metrics.module";
import { DeviceToolsModule } from "./device-tools/device-tools.module";
import { SecurityModule } from "./security/security.module";
import { NetworkDiscoveryModule } from "./network-discovery/network-discovery.module";
import { SnmpModule } from "./snmp/snmp.module";
import { AssetsModule } from "./assets/assets.module";
import { VaultModule } from "./vault/vault.module";
import { DashboardModule } from "./dashboard/dashboard.module";
@Module({
    imports: [
        ServeStaticModule.forRoot({
            rootPath: join(__dirname, "..", "public"),
            serveRoot: "/static",
            // Uploaded files are served without sign-in: never sniffed, sandboxed, and anything but a plain image is a download.
            serveStaticOptions: {
                setHeaders: (res: any, filePath: string) => {
                    const headers = staticFileHeaders(relative(join(__dirname, "..", "public"), filePath));
                    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
                },
            },
        }),

        CommonModule,
        StorageModule,
        AuditModule,

        BrandingModule,
        AuthModule,
        WsModule,
        AgentsModule,
        JobsModule,
        DevicesModule,
        HealthModule,
        AdminModule,
        CompanyModule,
        LocalizationModule,
        SupportLegalModule,
        UsersModule,
        RolesModule,
        GroupsModule,
        SoftwareLibraryModule,
        SoftwareUpdatesModule,
        SearchModule,
        CustomersModule,
        PoliciesModule,
        BackupsModule,
        TicketsModule,
        KbModule,
        TemplatesModule,
        RecurringTicketsModule,
        DeviceMetricsModule,
        DeviceToolsModule,
        SecurityModule,
        NetworkDiscoveryModule,
        SnmpModule,
        AssetsModule,
        VaultModule,
        DashboardModule,
        WebhooksModule,
        WebMonitorsModule,
        DeviceTrayModule,
        EndpointBackupsModule,
        M365Module,
        EdrModule,
    AutoRepairModule,
    SystemHealthModule,
    WorkflowsModule,
        IntegrationsModule,
        BulkModule,
        ToolsModule,
        RemoteShellModule,
        RemoteConsoleModule,
        RecordingsModule,

        // ✅ NEW Remote Desktop module
        RemoteDesktopModule,
        AlertsModule,
        BillingModule,
        ItDocsModule,
        ReportsModule,
        DemoModule,
        DemoModeModule,
        FlagsModule,
        ComplianceModule,
        DataExchangeModule,
        AutomationModule,
        NotificationsModule,

        // ✅ compatibility endpoints for ticketing UI
        CompatModule,

        // ✅ NEW provisioning endpoints for dashboard-generated installers
        ProvisioningModule,

        SmtpModule,
        ScheduleModule.forRoot(),
        ImapModule,
        SupportMailboxModule,
        PortalModule,
        SurveysModule,
        ImportsModule,
        PatchesModule,
        DispatchModule,
    ],
    providers: [SessionCleanerService],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer
            .apply(AuthCookieMiddleware)
            .exclude(
                "healthz",
                "docs",
                "docs/{*path}",
                "static/{*path}",
                "api/auth/login",
                "api/auth/logout"
            )
            // Express 5 / path-to-regexp v8 wildcard syntax ("*" and "(.*)" are no longer valid).
            .forRoutes("{*path}");
    }
}
