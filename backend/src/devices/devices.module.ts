// remoteiq-minimal-e2e/backend/src/devices/devices.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { DevicesController } from "./devices.controller";
import { DeviceActionsController } from "./device-actions.controller";
import { DeviceInsightsController } from "./device-insights.controller";
import { DeviceFilesController } from "./device-files.controller";
import { DeviceRemovalsController } from "./device-removals.controller";
import { DeviceRemovalsService } from "./device-removals.service";

import { JobsModule } from "../jobs/jobs.module";
import { AgentsModule } from "../agents/agents.module";
import { StorageModule } from "../storage/storage.module";
import { DevicesService } from "./devices.service";
import { AccessModule } from "../access/access.module";
import { AssetsModule } from "../assets/assets.module";

@Module({
  imports: [StorageModule, AccessModule, AssetsModule, forwardRef(() => JobsModule), forwardRef(() => AgentsModule)],
  controllers: [
    DevicesController,
    DeviceActionsController,
    DeviceInsightsController,
    DeviceFilesController,
    DeviceRemovalsController,
  ],
  providers: [DevicesService, DeviceRemovalsService],
  exports: [DevicesService, DeviceRemovalsService],
})
export class DevicesModule { }
