// backend/src/device-tools/device-tools.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { JobsModule } from "../jobs/jobs.module";
import { DeviceToolsController } from "./device-tools.controller";
import { DeviceToolsService } from "./device-tools.service";
import { DeviceRegistryController } from "./device-registry.controller";
import { DeviceRegistryService } from "./device-registry.service";
import { DeviceRegistryWriteController } from "./device-registry-write.controller";
import { DeviceRegistryWriteService } from "./device-registry-write.service";
import { RegistryWriteLimiter } from "./device-registry.limiter";

@Module({
    imports: [StorageModule, AccessModule, forwardRef(() => JobsModule)],
    controllers: [DeviceToolsController, DeviceRegistryController, DeviceRegistryWriteController],
    providers: [DeviceToolsService, DeviceRegistryService, DeviceRegistryWriteService, RegistryWriteLimiter],
})
export class DeviceToolsModule { }
