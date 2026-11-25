// backend/src/maintenance/session-cleaner.service.ts
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;

@Injectable()
export class SessionCleanerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SessionCleanerService.name);
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly prisma: PrismaService) { }

    onModuleInit() {
        // first run shortly after boot
        this.timer = setTimeout(() => this.runOnce().catch(() => { }), 15_000) as unknown as NodeJS.Timeout;
        // then daily
        this.timer = setInterval(() => this.runOnce().catch(() => { }), DAY_MS) as unknown as NodeJS.Timeout;
    }

    async onModuleDestroy() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async runOnce() {
        try {
            const { count } = await this.prisma.sessions.deleteMany({
                where: { revoked_at: { lt: new Date(Date.now() - RETENTION_MS) } },
            });
            this.logger.log(`Pruned ${count} revoked sessions older than 30 days.`);
        } catch (e) {
            this.logger.warn(`Session prune failed: ${(e as Error)?.message || e}`);
        }
    }
}
