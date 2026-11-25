// backend/src/audit/audit.module.ts
import { Global, Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AuditController } from "./audit.controller";
import { AuditInterceptor } from "./audit.interceptor";
import { AuditService } from "./audit.service";

// Global because sign-in, the permission guard and the shell gateway all write to it.
@Global()
@Module({
    imports: [StorageModule],
    controllers: [AuditController],
    providers: [AuditService, AuditInterceptor],
    exports: [AuditService, AuditInterceptor],
})
export class AuditModule { }
