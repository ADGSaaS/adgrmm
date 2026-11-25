// backend/src/bulk/bulk.module.ts
import { Module, forwardRef } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { JobsModule } from "../jobs/jobs.module";
import { PatchesModule } from "../patches/patches.module";
import { DevicesModule } from "../devices/devices.module";
import { AgentsModule } from "../agents/agents.module";
import { SecurityModule } from "../security/security.module";
import { VaultModule } from "../vault/vault.module";
import { BulkController } from "./bulk.controller";
import { BulkService } from "./bulk.service";

@Module({
    imports: [StorageModule, AccessModule, forwardRef(() => JobsModule), PatchesModule, forwardRef(() => DevicesModule), forwardRef(() => AgentsModule), SecurityModule, VaultModule],
    controllers: [BulkController],
    providers: [BulkService],
    exports: [BulkService],
})
export class BulkModule { }
