// "Run now": asks a device's agent to run its checks straight away instead of waiting for their schedule.
//
// It is an ordinary signed agent task (type run_checks). The agent picks tasks up within about ten seconds, runs the
// named checks (or all of them), and posts the results the same way it always does, so the page updates by itself.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";

/** Agents older than this do not know the run_checks task. */
export const RUN_NOW_MIN_VERSION = "1.3.29";

const MAX_KEYS = 50;
const MAX_KEY_LENGTH = 200;
/** Someone pressing the button twice, or several people at once, gets the same run. */
const REUSE_WINDOW_MS = 2 * 60_000;
const ONLINE_WITHIN_MS = 5 * 60_000;

function versionAtLeast(have: string, need: string): boolean {
    const a = String(have).split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
    const b = need.split(".").map((p) => parseInt(p, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
        const x = a[i] ?? 0, y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    return true;
}

@Injectable()
export class CheckRunNowService {
    constructor(private readonly prisma: PrismaService) { }

    private cleanKeys(raw: unknown): string[] {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) throw new BadRequestException("keys must be a list.");
        if (raw.length > MAX_KEYS) throw new BadRequestException(`Run at most ${MAX_KEYS} checks at a time.`);
        const out = new Set<string>();
        for (const k of raw) {
            const key = String(k ?? "").trim();
            if (!key) continue;
            if (key.length > MAX_KEY_LENGTH || /[\u0000-\u001f]/.test(key)) throw new BadRequestException("One of those checks is not valid.");
            out.add(key);
        }
        return [...out];
    }

    async request(deviceId: string, rawKeys: unknown, userId: string | null) {
        const keys = this.cleanKeys(rawKeys);
        const agent = await this.prisma.agents.findFirst({
            where: { device_id: deviceId },
            select: { id: true, version: true, facts: true, last_check_in_at: true },
        });
        if (!agent) throw new NotFoundException("That device has no agent.");

        const os = String((agent.facts as any)?.os ?? "").toLowerCase();
        if (os !== "windows") throw new ConflictException("Running checks on demand is only available on Windows devices for now.");
        if (!versionAtLeast(agent.version, RUN_NOW_MIN_VERSION)) {
            throw new ConflictException(`Run now needs agent ${RUN_NOW_MIN_VERSION} or newer. This device has ${agent.version}; update its agent first.`);
        }
        if (!agent.last_check_in_at || Date.now() - agent.last_check_in_at.getTime() > ONLINE_WITHIN_MS) {
            throw new ConflictException("This device is offline right now, so it cannot run checks. Try again when it is back.");
        }

        const since = new Date(Date.now() - REUSE_WINDOW_MS);
        const existing = await this.prisma.agent_tasks.findFirst({
            where: { agent_id: agent.id, type: "run_checks", status: { in: ["pending", "queued", "running"] }, created_at: { gte: since } },
            select: { id: true },
            orderBy: { created_at: "desc" },
        });
        if (existing && keys.length === 0) return { accepted: true as const, taskId: existing.id, reused: true };

        const now = new Date();
        const { id } = await this.prisma.agent_tasks.create({
            data: { agent_id: agent.id, type: "run_checks", payload: { keys }, status: "queued", queued_at: now, created_by: userId, created_at: now, updated_at: now },
            select: { id: true },
        });
        return { accepted: true as const, taskId: id, reused: false };
    }
}
