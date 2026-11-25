// backend/src/imap/imap-ingest.repository.ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";

export interface IngestedMailRow {
    id?: number;
    purpose: "alerts" | "invites" | "password_resets" | "reports";
    uid: number;
    from_addr: string | null;
    subject: string | null;
    size_bytes: number | null;
    headers_snippet: string | null;
    is_bounce: boolean;
    bounce_recipient: string | null;
    bounce_status: string | null;
    bounce_action: string | null;
    bounce_diagnostic: string | null;
    created_at?: string; // timestamptz
}

@Injectable()
export class ImapIngestRepository {
    constructor(private readonly prisma: PrismaService) { }

    async insertIngested(row: IngestedMailRow) {
        await this.prisma.imap_ingested.createMany({
            data: [{
                purpose: row.purpose,
                uid: BigInt(row.uid),
                from_addr: row.from_addr,
                subject: row.subject,
                size_bytes: row.size_bytes ?? null,
                headers_snippet: row.headers_snippet ?? null,
                is_bounce: !!row.is_bounce,
                bounce_recipient: row.bounce_recipient ?? null,
                bounce_status: row.bounce_status ?? null,
                bounce_action: row.bounce_action ?? null,
                bounce_diagnostic: row.bounce_diagnostic ?? null,
            }],
            // The same message can be polled twice; (purpose, uid) keeps the first copy.
            skipDuplicates: true,
        });
    }
}
