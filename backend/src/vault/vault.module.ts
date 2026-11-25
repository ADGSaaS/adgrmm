// backend/src/vault/vault.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { JobsModule } from "../jobs/jobs.module";
import { PoliciesModule } from "../policies/policies.module";
import { SecurityModule } from "../security/security.module";
import { DeviceSecretsController, SecretAccessController } from "./vault.controller";
import { VaultService } from "./vault.service";
import { VaultAutomationService } from "./vault-automation.service";
import { VaultLimiters } from "./vault.limiter";

@Module({
    imports: [StorageModule, AccessModule, PoliciesModule, SecurityModule, forwardRef(() => JobsModule)],
    controllers: [DeviceSecretsController, SecretAccessController],
    providers: [VaultService, VaultAutomationService, VaultLimiters],
    exports: [VaultService, VaultAutomationService],
})
export class VaultModule { }
