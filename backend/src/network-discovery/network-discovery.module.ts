// backend/src/network-discovery/network-discovery.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { JobsModule } from "../jobs/jobs.module";
import { AlertsModule } from "../alerts/alerts.module";
import { AssetsModule } from "../assets/assets.module";
import { NetworkDiscoveryController } from "./network-discovery.controller";
import { NetworkDiscoveryService } from "./network-discovery.service";
import { NetworkDiscoverySchedulesService } from "./network-discovery-schedules.service";

@Module({
    imports: [StorageModule, AccessModule, AlertsModule, AssetsModule, forwardRef(() => JobsModule)],
    controllers: [NetworkDiscoveryController],
    providers: [NetworkDiscoveryService, NetworkDiscoverySchedulesService],
    exports: [NetworkDiscoveryService, NetworkDiscoverySchedulesService],
})
export class NetworkDiscoveryModule { }
