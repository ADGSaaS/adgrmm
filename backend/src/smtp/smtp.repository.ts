// backend/src/smtp/smtp.repository.ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";

export type EmailPurpose = "alerts" | "invites" | "password_resets" | "reports" | "tickets";

export interface EmailSettingsRow {
    purpose: EmailPurpose;
    enabled: boolean;

    smtp_host: string;
    smtp_port: number | null;
    smtp_username: string;
    smtp_password: string | null;
    smtp_use_tls: boolean;
    smtp_use_ssl: boolean;
    smtp_from_address: string;

    imap_host: string;
    imap_port: number | null;
    imap_username: string;
    imap_password: string | null;
    imap_use_ssl: boolean;

    pop_host: string;
    pop_port: number | null;
    pop_username: string;
    pop_password: string | null;
    pop_use_ssl: boolean;

    updated_at: string; // timestamptz
}

@Injectable()
export class SmtpRepository {
    constructor(private readonly prisma: PrismaService) { }

    /** Passwords are as stored, so decrypt them where they are used. */
    async getAllRaw(): Promise<Record<EmailPurpose, EmailSettingsRow>> {
        const rows = (await this.prisma.email_settings.findMany({
            orderBy: { purpose: "asc" },
        })) as unknown as EmailSettingsRow[];

        const map: Partial<Record<EmailPurpose, EmailSettingsRow>> = {};
        for (const r of rows) map[r.purpose] = r;

        // Ensure all four purposes exist for the UI
        const purposes: EmailPurpose[] = ["alerts", "invites", "password_resets", "reports", "tickets"];
        for (const p of purposes) {
            if (!map[p]) {
                map[p] = {
                    purpose: p,
                    enabled: true,
                    smtp_host: "",
                    smtp_port: 587,
                    smtp_username: "",
                    smtp_password: null,
                    smtp_use_tls: true,
                    smtp_use_ssl: false,
                    smtp_from_address: "",
                    imap_host: "",
                    imap_port: 993,
                    imap_username: "",
                    imap_password: null,
                    imap_use_ssl: true,
                    pop_host: "",
                    pop_port: 995,
                    pop_username: "",
                    pop_password: null,
                    pop_use_ssl: true,
                    updated_at: new Date(0).toISOString(),
                };
            }
        }
        return map as Record<EmailPurpose, EmailSettingsRow>;
    }

    /**
     * Upsert only provided fields (plus updated_at). Prisma skips undefined values,
     * so an omitted password keeps the saved one.
     */
    async upsertOne(purpose: EmailPurpose, patch: Partial<EmailSettingsRow>): Promise<void> {
        // The save body is not validated as nested data, so the form can send strings
        // where these columns need numbers or booleans. Postgres used to convert them.
        const values: any = { ...patch, updated_at: new Date() };
        delete values.purpose;
        for (const [key, value] of Object.entries(values)) {
            if (key.endsWith("_port") && typeof value === "string" && value.trim() !== "") {
                const port = Number(value);
                if (Number.isInteger(port)) values[key] = port;
            }
            if (key.includes("_use_") && (value === "true" || value === "false")) {
                values[key] = value === "true";
            }
        }

        await this.prisma.email_settings.upsert({
            where: { purpose },
            create: { ...values, purpose },
            update: values,
        });
    }
}
