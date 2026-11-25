// backend/src/flags/flags.module.ts
import { Global, Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { FlagsController } from "./flags.controller";
import { FlagsService } from "./flags.service";

// Global so a feature in any module can ask whether it is switched on.
@Global()
@Module({
    imports: [StorageModule],
    controllers: [FlagsController],
    providers: [FlagsService],
    exports: [FlagsService],
})
export class FlagsModule { }
