// backend/src/users/users.module.ts
import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AuthModule } from "../auth/auth.module";
import { GroupsModule } from "../groups/groups.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";

import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { MeController } from "./me.controller";
import { MeService } from "./me.service";

import { SecurityController } from "./security.controller";
import { SecurityService } from "./security.service";
import { AdminSessionsController } from "./admin-sessions.controller";
import { AdminSessionsService } from "./admin-sessions.service";

@Module({
    imports: [StorageModule, AuthModule, GroupsModule, EntitlementsModule],
    controllers: [UsersController, MeController, SecurityController, AdminSessionsController],
    providers: [UsersService, MeService, SecurityService, AdminSessionsService],
    exports: [UsersService, MeService, SecurityService],
})
export class UsersModule { }
