// backend/src/compliance/compliance.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";

@Module({
    imports: [StorageModule],
    controllers: [ComplianceController],
    providers: [ComplianceService],
})
export class ComplianceModule { }
