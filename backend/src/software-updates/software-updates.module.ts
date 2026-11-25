import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { PoliciesModule } from "../policies/policies.module";
import { DeviceSoftwareUpdatesController, SoftwareUpdatesController } from "./software-updates.controller";
import { SoftwareUpdatesService } from "./software-updates.service";
import { SoftwareUpdatesAutomationService } from "./software-updates-automation.service";

@Module({
    imports: [StorageModule, AccessModule, PoliciesModule],
    controllers: [SoftwareUpdatesController, DeviceSoftwareUpdatesController],
    providers: [SoftwareUpdatesService, SoftwareUpdatesAutomationService],
    exports: [SoftwareUpdatesService, SoftwareUpdatesAutomationService],
})
export class SoftwareUpdatesModule { }
