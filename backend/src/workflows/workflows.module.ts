import { Module, forwardRef } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { BackupsModule } from "../backups/backups.module";
import { StorageModule } from "../storage/storage.module";
import { TicketsModule } from "../tickets/tickets.module";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";

@Module({
    imports: [StorageModule, forwardRef(() => TicketsModule), AutomationModule, BackupsModule],
    controllers: [WorkflowsController],
    providers: [WorkflowsService],
    exports: [WorkflowsService],
})
export class WorkflowsModule { }
