// backend/src/customers/customers.module.ts
import { Module } from "@nestjs/common";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { CustomFieldsController } from "./custom-fields.controller";
import { CustomFieldsService } from "./custom-fields.service";
import { StorageModule } from "../storage/storage.module";
import { PoliciesModule } from "../policies/policies.module";
import { AccessModule } from "../access/access.module";
import { PortalModule } from "../portal/portal.module";

@Module({
    imports: [StorageModule, PoliciesModule, AccessModule, PortalModule],
    controllers: [CustomersController, CustomFieldsController],
    providers: [CustomersService, CustomFieldsService],
    exports: [CustomersService, CustomFieldsService],
})
export class CustomersModule { }
