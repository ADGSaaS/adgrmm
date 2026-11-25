import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { SmtpModule } from "../smtp/smtp.module";
import { AccessModule } from "../access/access.module";
import { TemplatesModule } from "../templates/templates.module";
import { TicketsModule } from "../tickets/tickets.module";
import { ScheduleController } from "./schedule.controller";
import { ScheduleService } from "./schedule.service";

// Named Dispatch so it is not confused with the ScheduleModule of @nestjs/schedule (the timer one).
@Module({
    imports: [StorageModule, SmtpModule, AccessModule, TemplatesModule, TicketsModule],
    controllers: [ScheduleController],
    providers: [ScheduleService],
    exports: [ScheduleService],
})
export class DispatchModule { }
