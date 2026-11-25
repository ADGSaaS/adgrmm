import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AccessModule } from "../access/access.module";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

@Module({
    imports: [StorageModule, AccessModule],
    controllers: [SearchController],
    providers: [SearchService],
})
export class SearchModule { }
