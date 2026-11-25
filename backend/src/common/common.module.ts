// backend/src/common/common.module.ts
import { Module } from '@nestjs/common';
import { SocketRegistry } from './socket-registry.service';
import { UiSocketRegistry } from './ui-socket-registry.service';
import { AgentTokenGuard } from './agent-token.util';
import { StorageModule } from '../storage/storage.module';
import { JobSignerService } from './job-signer.service';
import { SecretsAtRestService } from './secrets-at-rest.service';

@Module({
    imports: [StorageModule],
    providers: [SocketRegistry, UiSocketRegistry, AgentTokenGuard, JobSignerService, SecretsAtRestService],
    exports: [SocketRegistry, UiSocketRegistry, AgentTokenGuard, JobSignerService],
})
export class CommonModule { }
