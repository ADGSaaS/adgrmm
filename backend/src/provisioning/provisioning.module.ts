import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { ProvisioningController } from "./provisioning.controller";
import { ProvisioningService } from "./provisioning.service";
import { AgentSettingsService } from "./agent-settings.service";

@Module({
    imports: [StorageModule, AccessModule],
    controllers: [ProvisioningController],
    providers: [ProvisioningService, AgentSettingsService],
    exports: [ProvisioningService, AgentSettingsService],
})
export class ProvisioningModule { }
