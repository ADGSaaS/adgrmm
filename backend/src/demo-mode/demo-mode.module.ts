// backend/src/demo-mode/demo-mode.module.ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DemoModule } from "../demo/demo.module";
import { DemoModeController } from "./demo-mode.controller";
import { DemoModeService } from "./demo-mode.service";

@Module({
    imports: [AuthModule, DemoModule],
    controllers: [DemoModeController],
    providers: [DemoModeService],
    exports: [DemoModeService],
})
export class DemoModeModule { }
