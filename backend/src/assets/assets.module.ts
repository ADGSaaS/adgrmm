// backend/src/assets/assets.module.ts
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { AssetsController } from "./assets.controller";
import { AssetsService } from "./assets.service";

@Module({
    imports: [StorageModule, AuditModule],
    controllers: [AssetsController],
    providers: [AssetsService],
    exports: [AssetsService],
})
export class AssetsModule { }
