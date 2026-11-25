// backend/src/tools/tools.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { BulkModule } from "../bulk/bulk.module";
import { DashboardModule } from "../dashboard/dashboard.module";
import { ToolsController } from "./tools.controller";
import { ToolsService } from "./tools.service";
import { MaintenanceService } from "./maintenance.service";

@Module({
    imports: [StorageModule, AccessModule, BulkModule, DashboardModule],
    controllers: [ToolsController],
    providers: [ToolsService, MaintenanceService],
})
export class ToolsModule { }
