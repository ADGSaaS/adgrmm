// backend/src/policies/policies.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { PoliciesController } from "./policies.controller";
import { PoliciesService } from "./policies.service";
import { TagsController } from "./tags.controller";
import { TagsService } from "./tags.service";

@Module({
    imports: [StorageModule, AccessModule],
    controllers: [PoliciesController, TagsController],
    providers: [PoliciesService, TagsService],
    exports: [PoliciesService, TagsService],
})
export class PoliciesModule { }
