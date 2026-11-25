import { Module, forwardRef } from "@nestjs/common";
import { AlertsModule } from "../alerts/alerts.module";
import { AuditModule } from "../audit/audit.module";
import { JobsModule } from "../jobs/jobs.module";
import { KbModule } from "../kb/kb.module";
import { StorageModule } from "../storage/storage.module";
import { SupportMailboxModule } from "../support-mailbox/support-mailbox.module";
import { AutoRepairAdminController } from "./auto-repair.controller";
import { AutoRepairService } from "./auto-repair.service";
import { PlaybooksService } from "./playbooks.service";

@Module({
    imports: [StorageModule, AuditModule, AlertsModule, KbModule, forwardRef(() => JobsModule), forwardRef(() => SupportMailboxModule)],
    controllers: [AutoRepairAdminController],
    providers: [AutoRepairService, PlaybooksService],
    exports: [AutoRepairService, PlaybooksService],
})
export class AutoRepairModule { }
