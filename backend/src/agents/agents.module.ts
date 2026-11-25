// backend/src/agents/agents.module.ts
import { Module } from "@nestjs/common";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { AgentsTasksService } from "./agents.tasks.service";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module"; // provides PrismaService
import { CommonModule } from "../common/common.module"; // provides AgentTokenGuard utilities
import { ChecksModule } from "../checks/checks.module"; // provides ChecksService to controller
import { ProvisioningModule } from "../provisioning/provisioning.module"; // locates agent packages
import { AgentUpdatesController } from "./agent-updates.controller";
import { AgentUpdatesService } from "./agent-updates.service";
import { AgentSettingsController } from "./agent-settings.controller";
import { AgentReleasesController } from "./agent-releases.controller";
import { AgentReleasesService } from "./agent-releases.service";
import { AccessModule } from "../access/access.module"; // customer limits for ring changes

@Module({
  imports: [AuthModule, StorageModule, CommonModule, ChecksModule, ProvisioningModule, AccessModule],
  controllers: [AgentsController, AgentUpdatesController, AgentSettingsController, AgentReleasesController],
  providers: [AgentsService, AgentsTasksService, AgentUpdatesService, AgentReleasesService],
  exports: [AgentsService, AgentsTasksService, AgentUpdatesService, AgentReleasesService],
})
export class AgentsModule { }
