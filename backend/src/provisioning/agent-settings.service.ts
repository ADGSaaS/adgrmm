// backend/src/provisioning/agent-settings.service.ts
// Administration > Agents & Endpoints: the defaults that are real. What is not here has no way to reach the agent:
// the agent decides its own check-in interval (the server's answer is ignored), and the install path carries no scripts.
import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";

export const DEFAULT_KEY_EXPIRY_MINS = 7 * 24 * 60;
/** Same ceiling as a key created by hand: ten years. */
export const MAX_KEY_EXPIRY_MINS = 5_259_600;

export type AgentSettings = {
    /** How long a new install key lasts when the person making it does not choose. */
    installKeyExpiryMins: number;
    /** Whether agents are offered newer packages at all. */
    autoUpdate: boolean;
};

@Injectable()
export class AgentSettingsService {
    private autoCache: { at: number; value: boolean } | null = null;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
    ) { }

    async get(orgId?: string): Promise<AgentSettings> {
        const id = orgId ?? (await this.orgs.getDefaultOrganizationId());
        try {
            const row = await this.prisma.agent_settings.findUnique({ where: { organization_id: id } });
            if (row) return { installKeyExpiryMins: row.install_key_expiry_mins, autoUpdate: row.auto_update };
        } catch {
            // Without the table, behave as before: a week, and updates on.
        }
        return { installKeyExpiryMins: DEFAULT_KEY_EXPIRY_MINS, autoUpdate: true };
    }

    async save(orgId: string, actorId: string | null, input: Partial<AgentSettings>): Promise<{ before: AgentSettings; after: AgentSettings }> {
        const before = await this.get(orgId);
        const after = { ...before };
        if (input.installKeyExpiryMins !== undefined) {
            const n = Number(input.installKeyExpiryMins);
            if (!Number.isInteger(n) || n < 1 || n > MAX_KEY_EXPIRY_MINS) {
                throw new BadRequestException("The default install key lifetime must be between 1 minute and 10 years.");
            }
            after.installKeyExpiryMins = n;
        }
        if (input.autoUpdate !== undefined) {
            if (typeof input.autoUpdate !== "boolean") throw new BadRequestException("autoUpdate must be true or false.");
            after.autoUpdate = input.autoUpdate;
        }
        const data = { install_key_expiry_mins: after.installKeyExpiryMins, auto_update: after.autoUpdate, updated_at: new Date(), updated_by: actorId };
        await this.prisma.agent_settings.upsert({ where: { organization_id: orgId }, create: { organization_id: orgId, ...data }, update: data });
        this.autoCache = null;
        return { before, after };
    }

    /** True unless an administrator turned automatic updates off. The AGENT_UPDATES_ENABLED kill switch is separate and wins. */
    async autoUpdateEnabled(): Promise<boolean> {
        // Every agent asks every few minutes, so the answer is kept for a few seconds.
        if (this.autoCache && Date.now() - this.autoCache.at < 5_000) return this.autoCache.value;
        const value = (await this.get()).autoUpdate;
        this.autoCache = { at: Date.now(), value };
        return value;
    }
}
