import { Injectable } from "@nestjs/common";
import { encryptSecret } from "../common/secret-box";
import { PrismaService } from "../storage/prisma.service";

export type DkimRow = {
    id: number;
    domain: string;
    selector: string;
    private_key: string | null;
    updated_at: string | Date; // timestamptz
};

@Injectable()
export class DkimRepository {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Returns the single DKIM row (id=1) or a default empty row if none.
     * private_key is as stored, so decrypt it where the key is used.
     */
    async get(): Promise<DkimRow> {
        const row = await this.prisma.dkim_settings.findUnique({ where: { id: 1 } });
        if (row) return row;

        // Default empty
        return {
            id: 1,
            domain: "",
            selector: "",
            private_key: null,
            updated_at: new Date(0).toISOString(),
        };
    }

    /**
     * Upserts domain + selector; privateKey is optional (omit to preserve).
     */
    async save(input: { domain: string; selector: string; privateKey?: string }) {
        const values = {
            domain: input.domain,
            selector: input.selector,
            updated_at: new Date(),
            // An empty key stays empty, so "is a key saved?" keeps meaning the same.
            ...(typeof input.privateKey === "string"
                ? { private_key: input.privateKey ? encryptSecret(input.privateKey) : input.privateKey }
                : {}),
        };

        await this.prisma.dkim_settings.upsert({
            where: { id: 1 },
            create: { id: 1, ...values },
            update: values,
        });
    }
}
