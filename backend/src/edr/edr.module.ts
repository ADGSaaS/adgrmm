import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { AlertsModule } from "../alerts/alerts.module";
import { StorageModule } from "../storage/storage.module";
import { EdrController } from "./edr.controller";
import { EdrService } from "./edr.service";

@Module({
    imports: [StorageModule, AccessModule, AlertsModule],
    controllers: [EdrController],
    providers: [EdrService],
    exports: [EdrService],
})
export class EdrModule { }
