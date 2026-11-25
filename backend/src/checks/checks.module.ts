import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { CommonModule } from "../common/common.module";

import { ChecksService } from "./checks.service";
import { ChecksController } from "./checks.controller";
import { ChecksReadController } from "./checks.read.controller";
import { DeviceChecksController } from "./device-checks.controller";
import { CheckRunNowService } from "./check-run-now.service";
import { ChecksIngestController } from "./checks.ingest.controller";
import { ChecksRuntimeService } from "./checks.runtime.service";
import { ChecksRetentionService } from "./checks-retention.service";

import { WsModule } from "../ws/ws.module";
import { JobsModule } from "../jobs/jobs.module";
import { AlertsModule } from "../alerts/alerts.module";
import { CheckDefinitionsService } from "./check-definitions.service";
import { PoliciesModule } from "../policies/policies.module";
import { AccessModule } from "../access/access.module";

@Module({
    imports: [
        StorageModule,
        CommonModule,
        forwardRef(() => WsModule),
        forwardRef(() => JobsModule),
        AlertsModule,
        PoliciesModule,
        AccessModule,
    ],
    controllers: [
        ChecksController,
        ChecksReadController,
        DeviceChecksController,
        ChecksIngestController,
    ],
    providers: [
        ChecksService,
        ChecksRuntimeService,
        ChecksRetentionService,
        CheckDefinitionsService,
        CheckRunNowService,
    ],
    exports: [
        ChecksService,
        ChecksRuntimeService,
    ],
})
export class ChecksModule { }
