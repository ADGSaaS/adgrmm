// backend/src/data-exchange/data-exchange.module.ts
import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { CustomersModule } from "../customers/customers.module";
import { StorageModule } from "../storage/storage.module";
import { DataExchangeController } from "./data-exchange.controller";
import { ExportService } from "./export.service";
import { ImportService } from "./import.service";

@Module({
    imports: [StorageModule, AccessModule, CustomersModule],
    controllers: [DataExchangeController],
    providers: [ExportService, ImportService],
})
export class DataExchangeModule { }
