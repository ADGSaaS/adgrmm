// backend/src/itdocs/itdocs.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { SmtpModule } from "../smtp/smtp.module";
import { AssetsModule } from "../assets/assets.module";
import { AccessModule } from "../access/access.module";
import { ItDocsService } from "./itdocs.service";
import { ItDocsController } from "./itdocs.controller";

@Module({
    imports: [StorageModule, SmtpModule, AssetsModule, AccessModule],
    controllers: [ItDocsController],
    providers: [ItDocsService],
    exports: [ItDocsService],
})
export class ItDocsModule { }
