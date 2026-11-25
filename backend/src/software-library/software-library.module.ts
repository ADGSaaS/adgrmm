import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { DeviceSoftwareInstallController, SoftwareLibraryController } from "./software-library.controller";
import { SoftwareLibraryService } from "./software-library.service";

@Module({
    imports: [StorageModule, AccessModule],
    controllers: [SoftwareLibraryController, DeviceSoftwareInstallController],
    providers: [SoftwareLibraryService],
    exports: [SoftwareLibraryService],
})
export class SoftwareLibraryModule { }
