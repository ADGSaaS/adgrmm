import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { TicketsModule } from "../tickets/tickets.module";
import { KbController } from "./kb.controller";
import { KbService } from "./kb.service";

@Module({
    imports: [AuthModule, StorageModule, forwardRef(() => TicketsModule)],
    controllers: [KbController],
    providers: [KbService],
    exports: [KbService],
})
export class KbModule { }
