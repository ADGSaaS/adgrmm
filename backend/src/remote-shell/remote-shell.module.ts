// adgrmm-minimal-e2e/backend/src/remote-shell/remote-shell.module.ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CommonModule } from "../common/common.module";
import { AccessModule } from "../access/access.module";
import { RemoteShellGateway } from "./remote-shell.gateway";

@Module({
    imports: [AuthModule, CommonModule, AccessModule],
    providers: [RemoteShellGateway],
})
export class RemoteShellModule { }
