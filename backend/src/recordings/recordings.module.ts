// backend/src/recordings/recordings.module.ts
import { Module } from "@nestjs/common";

import { RemoteConsoleModule } from "../remote-console/remote-console.module";
import { AccessModule } from "../access/access.module";
import { StorageModule } from "../storage/storage.module";
import { RecordingsController } from "./recordings.controller";
import { RecordingsService } from "./recordings.service";

@Module({
    imports: [StorageModule, RemoteConsoleModule, AccessModule],
    controllers: [RecordingsController],
    providers: [RecordingsService],
    exports: [RecordingsService],
})
export class RecordingsModule { }
