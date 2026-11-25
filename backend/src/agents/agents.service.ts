// backend/src/agents/agents.service.ts
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { diffDevice, diffSoftware, MAX_CHANGES_PER_REPORT, type Change } from "./device-changes";

// Controller DTOs validated already; service accepts partials safely.
type UpdateAgentFacts = Partial<{
    hostname: string;
    os: string;
    arch: string;
    version: string;
    primaryIp: string;
    user: string; // logged-in user
    loggedInUser: string; // alias

    // ✅ NEW: agent device summary blob (hardware/disks/etc)
    facts: Record<string, any>;
}>;

/** An install date as a Date, or null when it is missing or not a real day (a registry value such as 0000-00-00 or 2024-13-45 must not fail the whole inventory). */
export function safeInstallDate(value: string | null | undefined): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y < 1980 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const date = new Date(Date.UTC(y, mo - 1, d));
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Text the database can hold: no NUL or other control characters (Postgres refuses NUL), and no lone surrogates. Trimmed, and cut to `max`. */
export function dbText(value: unknown, max: number): string | null {
    if (value === null || value === undefined) return null;
    const cleaned = String(value)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
        .trim();
    return cleaned ? cleaned.slice(0, max) : null;
}

type SoftwareItem = {
    name: string;
    version?: string | null;
    publisher?: string | null;
    installDate?: string | null; // YYYY-MM-DD
    scope?: "machine" | "user" | null;
    user?: string | null;
    installedBy?: string | null;
};

@Injectable()
export class AgentsService {
    constructor(private readonly prisma: PrismaService) { }

    /** Return the stable UUID mirror for a uuid agent id (or null if absent). */
    async getAgentUuidById(agentId: string): Promise<string | null> {
        try {
            const row = await this.prisma.agents.findUnique({
                where: { id: agentId },
                select: { agent_uuid: true },
            });

            const v = row?.agent_uuid ?? null;
            return v && String(v).trim() ? String(v) : String(agentId);
        } catch {
            return null;
        }
    }

    /**
     * Update agent facts and bump last_check_in_at (powers "Last Response").
     *
     * Your schema (public.agents):
     *  - hostname           text NULL
     *  - version            text NOT NULL
     *  - last_check_in_at   timestamptz NULL
     *  - facts              jsonb NOT NULL DEFAULT '{}'
     *  - agent_uuid         text NOT NULL UNIQUE
     */
    async updateFacts(agentId: string, facts: UpdateAgentFacts): Promise<void> {
        const now = new Date();
        // What the device looked like before this report, to note what changed for the change log.
        const previous = facts.facts && typeof facts.facts === "object"
            ? await this.prisma.agents.findUnique({ where: { id: agentId }, select: { device_id: true, facts: true } }).catch(() => null)
            : null;
        const data: Prisma.agentsUpdateManyMutationInput = {
            last_check_in_at: now,
            updated_at: now,
        };

        // Real columns
        if (facts.hostname !== undefined) data.hostname = facts.hostname;
        if (facts.version !== undefined) data.version = facts.version;

        /**
         * Build ONE jsonb patch, then assign facts once.
         * - basic keys used elsewhere in backend: os/arch/primary_ip/user/logged_in_user
         * - device summary blob stored under facts.device (hardware/disks/etc)
         */
        const patch: Record<string, any> = {};

        if (facts.os !== undefined) patch.os = facts.os || null;
        if (facts.arch !== undefined) patch.arch = facts.arch || null;
        if (facts.primaryIp !== undefined) patch.primary_ip = facts.primaryIp || null;

        const loginUser = facts.user ?? facts.loggedInUser;
        if (loginUser !== undefined) {
            patch.user = loginUser || null;
            patch.logged_in_user = loginUser || null;
        }

        // ✅ store the device summary blob under facts.device
        if (facts.facts !== undefined) {
            // if someone sends null/empty, we’ll store null to “clear” it
            patch.device = facts.facts && typeof facts.facts === "object" ? facts.facts : null;
        }

        const writes: Prisma.PrismaPromise<unknown>[] = [
            this.prisma.agents.updateMany({ where: { id: agentId }, data }),
            // keep agent_uuid stable + non-empty (your column is NOT NULL + UNIQUE)
            this.prisma.agents.updateMany({
                where: { id: agentId, agent_uuid: "" },
                data: { agent_uuid: agentId },
            }),
        ];

        if (Object.keys(patch).length > 0) {
            // Prisma can only replace a Json column; a top-level jsonb merge must be atomic so concurrent pings keep each other's keys.
            writes.push(this.prisma.$executeRaw`
                UPDATE public.agents
                   SET facts = COALESCE(facts, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
                 WHERE id = ${agentId}::uuid
            `);
        }

        await this.prisma.$transaction(writes);

        if (previous && facts.facts && typeof facts.facts === "object") {
            const before = (previous.facts as Record<string, any> | null)?.device;
            await this.recordChanges(previous.device_id, diffDevice(before, facts.facts));
        }
    }

    /** Writes what changed on a device to the change log. A failure here never stops the report being accepted. */
    private async recordChanges(deviceId: string, changes: Change[]): Promise<void> {
        if (!changes.length) return;
        try {
            const shown = changes.slice(0, MAX_CHANGES_PER_REPORT);
            const extra = changes.length - shown.length;
            await this.prisma.device_changes.createMany({
                data: [
                    ...shown.map((c) => ({ device_id: deviceId, kind: c.kind, summary: c.summary, before: (c.before ?? undefined) as Prisma.InputJsonValue | undefined, after: (c.after ?? undefined) as Prisma.InputJsonValue | undefined })),
                    ...(extra > 0 ? [{ device_id: deviceId, kind: "software_updated", summary: `${extra} more software changes were not listed` }] : []),
                ],
            });
        } catch {
            /* the log is a convenience */
        }
    }

    /**
     * Replace full software inventory for an agent. All or nothing: a bad item leaves
     * the previous inventory in place.
     */
    async replaceSoftwareInventory(agentId: string, items: SoftwareItem[], users?: Array<{ account?: string; loggedIn?: boolean }>): Promise<void> {
        if (!Array.isArray(items)) return;

        // The accounts the device has, when it said (older agents do not).
        const accounts = Array.isArray(users)
            ? [...new Map(users.map((u) => [dbText(u?.account, 256) ?? "", u?.loggedIn === true])).entries()].filter(([a]) => a).slice(0, 200)
            : null;

        const cleaned = items
            .map((it) => ({
                name: dbText(it.name, 256) ?? "",
                version: dbText(it.version, 128),
                publisher: dbText(it.publisher, 256),
                installDate: safeInstallDate(it.installDate),
                scope: it.scope === "user" ? "user" : "machine",
                user: dbText(it.user, 256),
                installedBy: dbText(it.installedBy, 256),
            }))
            .filter((it) => !!it.name);

        // The inventory before this one, so installs, removals and updates can be logged. The first inventory is not a change.
        const existing = await this.prisma.agent_software.findMany({ where: { agent_id: agentId }, select: { name: true, version: true } });
        const owner = existing.length ? await this.prisma.agents.findUnique({ where: { id: agentId }, select: { device_id: true } }).catch(() => null) : null;

        await this.prisma.$transaction([
            this.prisma.agent_software.deleteMany({ where: { agent_id: agentId } }),
            ...(accounts
                ? [
                    this.prisma.agent_user_accounts.deleteMany({ where: { agent_id: agentId } }),
                    this.prisma.agent_user_accounts.createMany({ data: accounts.map(([account, logged_in]) => ({ agent_id: agentId, account, logged_in })) }),
                ]
                : []),
            this.prisma.agent_software.createMany({
                data: cleaned.map((it) => ({
                    agent_id: agentId,
                    name: it.name,
                    version: it.version,
                    publisher: it.publisher,
                    install_date: it.installDate,
                    scope: it.scope,
                    installed_user: it.scope === "user" ? it.user : null,
                    installed_by: it.installedBy,
                })),
            }),
        ]);

        if (owner) await this.recordChanges(owner.device_id, diffSoftware(existing, cleaned.map((c) => ({ name: c.name, version: c.version }))));
    }
}
