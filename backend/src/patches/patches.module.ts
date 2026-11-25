import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { PatchesController } from "./patches.controller";
import { PatchesService } from "./patches.service";
import { PatchAutomationService } from "./patch-automation.service";
import { PoliciesModule } from "../policies/policies.module";
import { JobsModule } from "../jobs/jobs.module";

@Module({
    imports: [StorageModule, PoliciesModule, JobsModule],
    controllers: [PatchesController],
    providers: [PatchesService, PatchAutomationService],
    exports: [PatchesService, PatchAutomationService],
})
export class PatchesModule { }
