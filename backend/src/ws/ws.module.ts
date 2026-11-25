// backend/src/ws/ws.module.ts
import { Module, forwardRef } from "@nestjs/common";

import { AgentGateway } from "./agent.gateway";
import { DashboardGateway } from "./dashboard.gateway";

import { JobsModule } from "../jobs/jobs.module";
import { CommonModule } from "../common/common.module";
import { StorageModule } from "../storage/storage.module";
import { AuthModule } from "../auth/auth.module";
import { AccessModule } from "../access/access.module";

@Module({
  imports: [
    CommonModule,
    StorageModule,
    AuthModule,                 // ✅ provides JwtService via exported JwtModule
    AccessModule,               // customer limits for device subscriptions
    forwardRef(() => JobsModule),
  ],
  providers: [AgentGateway, DashboardGateway],
  exports: [AgentGateway, DashboardGateway],
})
export class WsModule { }
