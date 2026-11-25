// backend/src/jobs/jobs.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";     // PrismaService
import { CommonModule } from "../common/common.module";        // SocketRegistry
import { AccessModule } from "../access/access.module";   // which customers a person may see
import { WsModule } from "../ws/ws.module";                    // if you use ws gateway/handlers

import { JobsController } from "./jobs.controller";
import { AgentJobsController } from "./agent-jobs.controller";
import { JobsPublicController } from "./jobs.public.controller";

import { JobsService } from "./jobs.service";
import { DispatcherService } from "./dispatcher.service";
import { JobSweeperService } from "./job-sweeper.service";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";

@Module({
  imports: [
    StorageModule,                 // provides PrismaService
    CommonModule,                  // exports SocketRegistry
    AccessModule,
    forwardRef(() => WsModule),    // keep if you have circular deps with ws
  ],
  controllers: [JobsController, AgentJobsController, JobsPublicController, RunsController],
  providers: [JobsService, DispatcherService, JobSweeperService, RunsService],
  exports: [JobsService, DispatcherService, RunsService],
})
export class JobsModule { }
