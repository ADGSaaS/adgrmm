// backend/src/dashboard/dashboard.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { SecurityModule } from "../security/security.module";
import { AgentsModule } from "../agents/agents.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

@Module({
    imports: [StorageModule, AccessModule, SecurityModule, AgentsModule],
    controllers: [DashboardController],
    providers: [DashboardService],
    exports: [DashboardService],
})
export class DashboardModule { }
