import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module";
import { StorageModule } from "../storage/storage.module";
import { WebhooksModule } from "../webhooks/webhooks.module";
import { M365Controller } from "./m365.controller";
import { M365Service } from "./m365.service";

@Module({
    imports: [StorageModule, AccessModule, WebhooksModule],
    controllers: [M365Controller],
    providers: [M365Service],
    exports: [M365Service],
})
export class M365Module { }
