// backend/src/automation/automation.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { JobsModule } from "../jobs/jobs.module";
import { ScriptsService } from "./scripts.service";
import { BuiltinScriptsService } from "./builtin-scripts.service";
import { ScriptsController } from "./scripts.controller";
import { ScriptSnippetsController } from "./script-snippets.controller";
import { ScriptSnippetsService } from "./script-snippets.service";
import { FailuresService } from "./failures.service";
import { FailuresController } from "./failures.controller";
import { AccessModule } from "../access/access.module";

@Module({
    imports: [StorageModule, AccessModule, forwardRef(() => JobsModule)],
    controllers: [ScriptsController, ScriptSnippetsController, FailuresController],
    providers: [ScriptsService, BuiltinScriptsService, ScriptSnippetsService, FailuresService],
    exports: [ScriptsService, BuiltinScriptsService, FailuresService],
})
export class AutomationModule { }
