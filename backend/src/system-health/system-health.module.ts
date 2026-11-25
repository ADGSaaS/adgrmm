import { Module } from "@nestjs/common";
import { BackupsModule } from "../backups/backups.module";
import { StorageModule } from "../storage/storage.module";
import { SystemHealthController } from "./system-health.controller";
import { SystemHealthService } from "./system-health.service";

@Module({
    imports: [StorageModule, BackupsModule],
    controllers: [SystemHealthController],
    providers: [SystemHealthService],
    exports: [SystemHealthService],
})
export class SystemHealthModule { }
