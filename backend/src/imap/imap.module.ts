// backend/src/imap/imap.module.ts
import { Module } from "@nestjs/common";
import { ImapPollerService } from "./imap-poller.service";
import { ImapIngestRepository } from "./imap-ingest.repository";
import { SmtpModule } from "../smtp/smtp.module";
import { StorageModule } from "../storage/storage.module";

@Module({
    imports: [
        StorageModule,
        // Gives this module access to SmtpRepository (exported by SmtpModule)
        SmtpModule,
    ],
    providers: [
        ImapPollerService,
        ImapIngestRepository, // <-- provide it here
    ],
    exports: [
        ImapPollerService,
        ImapIngestRepository,
    ],
})
export class ImapModule { }
