// backend/src/storage/storage.module.ts
import { Module } from "@nestjs/common";

import { PrismaService } from "./prisma.service";
import { OrganizationContextService } from "./organization-context.service";
import { StorageConnectionsService } from "./storage-connections.service";
import { StorageController } from "./storage.controller";
import { StorageImportController } from "./storage-import.controller";

@Module({
    controllers: [StorageController, StorageImportController],
    providers: [
        PrismaService,
        OrganizationContextService,
        StorageConnectionsService,
    ],
    exports: [
        PrismaService,
        OrganizationContextService,
        StorageConnectionsService,
    ],
})
export class StorageModule { }
