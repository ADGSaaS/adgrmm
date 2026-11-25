import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { TicketsModule } from "../tickets/tickets.module";
import { RecurringTicketsController } from "./recurring-tickets.controller";
import { RecurringTicketsService } from "./recurring-tickets.service";

@Module({
    imports: [StorageModule, AccessModule, TicketsModule],
    controllers: [RecurringTicketsController],
    providers: [RecurringTicketsService],
    exports: [RecurringTicketsService],
})
export class RecurringTicketsModule { }
