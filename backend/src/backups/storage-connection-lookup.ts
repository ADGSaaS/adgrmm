import { Prisma } from "@prisma/client";
import { openSecretMap } from "../common/secret-box";
import { PrismaService } from "../storage/prisma.service";

/**
 * Loads a connection's config and decrypted secrets, which callers must not log or return.
 *
 * A missing id finds nothing. Prisma would drop an undefined filter and return some other
 * connection of that kind, or read an object from a request body as a filter operator.
 */
export async function findStorageConnection(
    prisma: PrismaService,
    id: unknown,
    kind: string,
): Promise<{ config: any; secrets: any } | null> {
    if (id == null) return null;
    const row = await prisma.storage_connections.findFirst({
        where: { id: String(id), kind },
        select: { config: true, secrets: true },
    });
    return row ? { config: row.config, secrets: openSecretMap(row.secrets) } : null;
}

/** The value JSON.stringify would store: undefined properties dropped, dates as ISO strings. */
export function toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value));
}
