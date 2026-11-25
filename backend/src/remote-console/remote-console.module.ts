// backend/src/remote-console/remote-console.module.ts

import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { StorageModule } from "../storage/storage.module";
import { PoliciesModule } from "../policies/policies.module";
import { AccessModule } from "../access/access.module";

import { RemoteConsoleGateway } from "./remote-console.gateway";
import { RemoteConsoleService } from "./remote-console.service";
import { RemoteConsoleController } from "./remote-console.controller";

@Module({
    imports: [StorageModule, CommonModule, PoliciesModule, AccessModule],
    controllers: [RemoteConsoleController],
    providers: [RemoteConsoleGateway, RemoteConsoleService],
    exports: [RemoteConsoleService],
})
export class RemoteConsoleModule { }
