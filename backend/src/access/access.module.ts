// backend/src/access/access.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { ClientAccessService } from "../reports/client-access.service";

/** Which customers a person may see. Imported wherever a list or a record has to respect that. */
@Module({
    imports: [StorageModule],
    providers: [ClientAccessService],
    exports: [ClientAccessService],
})
export class AccessModule { }
