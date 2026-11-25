// backend/src/common/secrets-at-rest.service.ts
import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";

import { PrismaService } from "../storage/prisma.service";
import { STORAGE_SECRET_KEYS } from "../storage/storage-connections.service";
import { decryptSecret, encryptSecret, hasDataKey, isEncrypted, sealSecretValue } from "./secret-box";

const EMAIL_PASSWORD_COLUMNS = ["smtp_password", "imap_password", "pop_password"] as const;

/** email_channels settings have no fixed shape, so anything that looks like a credential is covered. */
const CHANNEL_SECRET_NAME = /pass|secret|token|private.?key|api.?key/i;

export type SecretsAtRestCounts = { encrypted: number; alreadyEncrypted: number; undecryptable: number; failedTables: string[] };

/**
 * Encrypts secrets saved before encryption existed. It runs at every start and only touches values
 * that are still plain, so a restored backup or an interrupted run is simply finished next time.
 *
 * A missing key must not take the backend down: everything keeps working with the plain values.
 */
@Injectable()
export class SecretsAtRestService implements OnApplicationBootstrap {
    private readonly log = new Logger("SecretsAtRest");

    constructor(private readonly prisma: PrismaService) { }

    async onApplicationBootstrap(): Promise<void> {
        if (!hasDataKey()) {
            this.log.error(
                "DATA_ENCRYPTION_KEY_FILE is not set or cannot be read. Stored secrets were left as they are, and saving new ones will fail.",
            );
            return;
        }

        const counts = await this.encryptExisting();

        this.log.log(`Stored secrets: ${counts.encrypted} encrypted now, ${counts.alreadyEncrypted} already encrypted.`);
        if (counts.undecryptable > 0) {
            this.log.error(
                `${counts.undecryptable} stored secret(s) cannot be decrypted with the current key. A restored backup needs the key it was made with.`,
            );
        }
        if (counts.failedTables.length > 0) {
            this.log.error(`Could not process stored secrets in: ${counts.failedTables.join(", ")}. The next start tries again.`);
        }
    }

    async encryptExisting(): Promise<SecretsAtRestCounts> {
        const counts: SecretsAtRestCounts = { encrypted: 0, alreadyEncrypted: 0, undecryptable: 0, failedTables: [] };

        const steps: [string, () => Promise<void>][] = [
            ["email_settings", () => this.emailSettings(counts)],
            ["email_channels", () => this.emailChannels(counts)],
            ["storage_connections", () => this.storageConnections(counts)],
            ["dkim_settings", () => this.dkimSettings(counts)],
            ["dkim_keys", () => this.dkimKeys(counts)],
        ];

        for (const [table, step] of steps) {
            try {
                await step();
            } catch (e: any) {
                // Only the code: a database error can repeat the values in the query.
                this.log.error(`Stopped on ${table}: ${e?.code ?? e?.name ?? "error"}`);
                counts.failedTables.push(table);
            }
        }
        return counts;
    }

    /** True if the value still needs encrypting. Values already encrypted are checked against the current key. */
    private isPlain(value: unknown, counts: SecretsAtRestCounts): value is string {
        if (typeof value !== "string" || value === "") return false;
        if (!isEncrypted(value)) return true;

        counts.alreadyEncrypted++;
        try {
            decryptSecret(value);
        } catch {
            counts.undecryptable++;
        }
        return false;
    }

    // Each update below only applies if the values are unchanged since they were read, so a save
    // made while this runs is never overwritten. A lost race is picked up at the next start.
    // updated_at cannot be compared: the database keeps microseconds and a JS Date only milliseconds.

    private async emailSettings(counts: SecretsAtRestCounts): Promise<void> {
        const rows = await this.prisma.email_settings.findMany();
        for (const row of rows) {
            for (const column of EMAIL_PASSWORD_COLUMNS) {
                const value = row[column];
                if (!this.isPlain(value, counts)) continue;

                const { count } = await this.prisma.email_settings.updateMany({
                    where: { purpose: row.purpose, [column]: value },
                    data: { [column]: encryptSecret(value) },
                });
                counts.encrypted += count;
            }
        }
    }

    private async dkimSettings(counts: SecretsAtRestCounts): Promise<void> {
        const rows = await this.prisma.dkim_settings.findMany();
        for (const row of rows) {
            if (!this.isPlain(row.private_key, counts)) continue;

            const { count } = await this.prisma.dkim_settings.updateMany({
                where: { id: row.id, private_key: row.private_key },
                data: { private_key: encryptSecret(row.private_key as string) },
            });
            counts.encrypted += count;
        }
    }

    private async dkimKeys(counts: SecretsAtRestCounts): Promise<void> {
        const rows = await this.prisma.dkim_keys.findMany({ select: { id: true, private_key: true } });
        for (const row of rows) {
            if (!this.isPlain(row.private_key, counts)) continue;

            const { count } = await this.prisma.dkim_keys.updateMany({
                where: { id: row.id, private_key: row.private_key },
                data: { private_key: encryptSecret(row.private_key) },
            });
            counts.encrypted += count;
        }
    }

    private async storageConnections(counts: SecretsAtRestCounts): Promise<void> {
        const rows = await this.prisma.storage_connections.findMany({
            select: { id: true, config: true, secrets: true },
        });

        for (const row of rows) {
            const config: Record<string, any> = { ...((row.config as any) ?? {}) };
            const secrets: Record<string, any> = { ...((row.secrets as any) ?? {}) };
            let changed = 0;

            for (const [name, value] of Object.entries(secrets)) {
                if (value === null || value === undefined || value === "") continue;
                if (typeof value === "string" && !this.isPlain(value, counts)) continue;

                secrets[name] = sealSecretValue(value);
                changed++;
            }

            // An older save could leave a credential in config, which the API returned.
            for (const name of STORAGE_SECRET_KEYS) {
                if (!(name in config)) continue;

                const value = config[name];
                delete config[name];
                if (value !== null && value !== "" && !secrets[name]) secrets[name] = sealSecretValue(value);
                changed++;
            }

            if (changed === 0) continue;

            const { count } = await this.prisma.storage_connections.updateMany({
                where: {
                    id: row.id,
                    config: { equals: row.config as any },
                    secrets: { equals: row.secrets as any },
                },
                data: { config, secrets },
            });
            if (count > 0) counts.encrypted += changed;
        }
    }

    private async emailChannels(counts: SecretsAtRestCounts): Promise<void> {
        const rows = await this.prisma.email_channels.findMany({
            select: { id: true, smtp_settings: true, imap_settings: true },
        });

        for (const row of rows) {
            const smtp = this.sealChannelSettings(row.smtp_settings, counts);
            const imap = this.sealChannelSettings(row.imap_settings, counts);
            const changed = smtp.changed + imap.changed;
            if (changed === 0) continue;

            const { count } = await this.prisma.email_channels.updateMany({
                where: {
                    id: row.id,
                    smtp_settings: { equals: row.smtp_settings as any },
                    imap_settings: { equals: row.imap_settings as any },
                },
                data: { smtp_settings: smtp.value, imap_settings: imap.value },
            });
            if (count > 0) counts.encrypted += changed;
        }
    }

    private sealChannelSettings(settings: unknown, counts: SecretsAtRestCounts): { value: any; changed: number } {
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { value: settings, changed: 0 };

        const value: Record<string, any> = {};
        let changed = 0;
        for (const [name, entry] of Object.entries(settings as Record<string, unknown>)) {
            if (entry && typeof entry === "object" && !Array.isArray(entry)) {
                const nested = this.sealChannelSettings(entry, counts);
                value[name] = nested.value;
                changed += nested.changed;
            } else if (CHANNEL_SECRET_NAME.test(name) && this.isPlain(entry, counts)) {
                value[name] = encryptSecret(entry);
                changed++;
            } else {
                value[name] = entry;
            }
        }
        return { value, changed };
    }
}
