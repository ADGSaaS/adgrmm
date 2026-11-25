// backend/src/device-metrics/device-metrics.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { DeviceMetricsController } from "./device-metrics.controller";
import { DeviceMetricsService } from "./device-metrics.service";

@Module({
    imports: [StorageModule, AccessModule],
    controllers: [DeviceMetricsController],
    providers: [DeviceMetricsService],
})
export class DeviceMetricsModule { }
