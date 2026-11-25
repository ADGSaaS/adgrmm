// backend/src/demo/demo.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { DemoController } from "./demo.controller";
import { DemoService } from "./demo.service";

@Module({
    imports: [StorageModule],
    controllers: [DemoController],
    providers: [DemoService],
    exports: [DemoService],
})
export class DemoModule { }
