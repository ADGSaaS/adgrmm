// backend/src/entitlements/entitlements.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { EntitlementsController } from "./entitlements.controller";
import { EntitlementsService } from "./entitlements.service";

@Module({
    imports: [StorageModule],
    controllers: [EntitlementsController],
    providers: [EntitlementsService],
    exports: [EntitlementsService],
})
export class EntitlementsModule { }
