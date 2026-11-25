import { Module } from "@nestjs/common";

import { StorageModule } from "../storage/storage.module";
import { HumanSessionGuard } from "../auth/human-session.guard";

import { DatabaseController } from "./database.controller";
import { DatabaseService } from "./database.service";

import { EnvironmentController } from "./environment.controller";
import { EnvironmentService } from "./environment.service";

import { DiagnosticsController } from "./diagnostics.controller";
import { DiagnosticsService } from "./diagnostics.service";

import { PlatformInfoController } from "./platform-info.controller";
import { PlatformInfoService } from "./platform-info.service";

@Module({
    imports: [StorageModule],
    controllers: [
        DatabaseController,
        EnvironmentController,
        DiagnosticsController,
        PlatformInfoController,
    ],
    providers: [
        DatabaseService,
        EnvironmentService,
        DiagnosticsService,
        PlatformInfoService,
        HumanSessionGuard,
    ],
    exports: [
        DatabaseService,
        EnvironmentService,
    ],
})
export class AdminModule {}
