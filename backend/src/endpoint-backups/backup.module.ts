import { Module, forwardRef } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AlertsModule } from "../alerts/alerts.module";
import { AuditModule } from "../audit/audit.module";
import { JobsModule } from "../jobs/jobs.module";
import { StorageModule } from "../storage/storage.module";
import { EndpointBackupsController } from "./backup.controller";
import { EndpointBackupsService } from "./backup.service";

@Module({
    imports: [StorageModule, AccessModule, AlertsModule, AuditModule, forwardRef(() => JobsModule)],
    controllers: [EndpointBackupsController],
    providers: [EndpointBackupsService],
    exports: [EndpointBackupsService],
})
export class EndpointBackupsModule { }
