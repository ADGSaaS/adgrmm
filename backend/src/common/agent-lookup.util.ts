// backend/src/common/agent-lookup.util.ts
import type { Prisma } from "@prisma/client";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Prisma rejects non-UUID values for uuid columns instead of simply not matching. */
export function isCanonicalUuid(value: string): boolean {
    return CANONICAL_UUID.test(value);
}

/** Matches an agent by agents.id or agents.agent_uuid, whichever the caller holds. */
export function agentIdOrUuidWhere(value: string): Prisma.agentsWhereInput {
    return {
        OR: [
            { agent_uuid: value },
            ...(isCanonicalUuid(value) ? [{ id: value }] : []),
        ],
    };
}
