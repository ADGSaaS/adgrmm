// backend/src/snmp/snmp.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { JobsModule } from "../jobs/jobs.module";
import { AlertsModule } from "../alerts/alerts.module";
import { AssetsModule } from "../assets/assets.module";
import { SnmpController } from "./snmp.controller";
import { SnmpService } from "./snmp.service";

@Module({
    imports: [StorageModule, AccessModule, AlertsModule, AssetsModule, forwardRef(() => JobsModule)],
    controllers: [SnmpController],
    providers: [SnmpService],
    exports: [SnmpService],
})
export class SnmpModule { }
