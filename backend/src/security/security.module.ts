// backend/src/security/security.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { JobsModule } from "../jobs/jobs.module";
import { PoliciesModule } from "../policies/policies.module";
import { DeviceSecurityController, SecurityFleetController } from "./security.controller";
import { SecurityService } from "./security.service";
import { SecurityAutomationService } from "./security-automation.service";
import { SecurityFleetService } from "./security-fleet.service";

@Module({
    imports: [StorageModule, AccessModule, PoliciesModule, forwardRef(() => JobsModule)],
    controllers: [DeviceSecurityController, SecurityFleetController],
    providers: [SecurityService, SecurityAutomationService, SecurityFleetService],
    exports: [SecurityService, SecurityAutomationService, SecurityFleetService],
})
export class SecurityModule { }
