// backend/src/automation/builtin-scripts.service.ts
//
// Puts the built-in scripts into the scripts manager (the `automations` table, type "script") and keeps them current.
//   - Created when missing. Updated to a newer shipped text only while the stored text is still exactly what was shipped (its hash matches the
//     one stored beside it), so a change someone made is never overwritten.
//   - A script that is not built in and happens to have the same name is never touched: the built-in one is skipped and the reason logged.
//   - One read of the existing scripts, then only the writes that are needed, so running on every boot is cheap and safe.
//   - BUILTIN_SCRIPTS_SEEDING=false turns the boot run off (tests do).
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { ALL_BUILTIN_SCRIPTS, BUILTIN_VERSION, textHash, type BuiltinScript } from "./builtin-scripts";

export type SeedResult = { created: number; updated: number; unchanged: number; skipped: Array<{ key: string; reason: string }> };

/** What is stored in an automation's configuration for a built-in script. */
export const configurationOf = (b: BuiltinScript) => ({
    language: b.language,
    timeoutSec: b.timeoutSec,
    parameters: b.parameters,
    builtin: true,
    builtinKey: b.key,
    builtinVersion: BUILTIN_VERSION,
    builtinHash: textHash(b.script),
    category: b.category,
    ...(b.platform === "all" ? { platform: "all", linuxScript: b.linuxScript, macosScript: b.macosScript } : {}),
});

/** JSON with the keys in a fixed order: the database stores objects with their own key order, so a plain stringify would never match. */
const stable = (v: unknown): string =>
    JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

type Stored = { id: string; name: string; description: string | null; script: string | null; configuration: unknown };

@Injectable()
export class BuiltinScriptsService implements OnModuleInit {
    private readonly logger = new Logger(BuiltinScriptsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
    ) { }

    async onModuleInit() {
        if ((process.env.BUILTIN_SCRIPTS_SEEDING ?? "").toLowerCase() === "false") return;
        try {
            const r = await this.seed();
            if (r.created || r.updated || r.skipped.length) {
                this.logger.log(`Built-in scripts: ${r.created} added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.skipped.length} skipped.`);
            }
        } catch (e) {
            // never stop the server from starting over this
            this.logger.warn(`Built-in scripts could not be added: ${(e as Error).message}`);
        }
    }

    /** Adds what is missing and updates what is unedited. Safe to run any number of times. */
    async seed(): Promise<SeedResult> {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const rows: Stored[] = await this.prisma.automations.findMany({
            where: { organization_id: organizationId, type: "script" },
            select: { id: true, name: true, description: true, script: true, configuration: true },
        });
        const byKey = new Map<string, Stored>();
        const byName = new Map<string, Stored>();
        for (const r of rows) {
            byName.set(r.name, r);
            const c = (r.configuration ?? {}) as { builtin?: boolean; builtinKey?: string };
            if (c.builtin === true && typeof c.builtinKey === "string") byKey.set(c.builtinKey, r);
        }

        const out: SeedResult = { created: 0, updated: 0, unchanged: 0, skipped: [] };
        for (const b of ALL_BUILTIN_SCRIPTS) {
            const cfg = configurationOf(b);
            const have = byKey.get(b.key);

            if (have) {
                const stored = (have.configuration ?? {}) as { builtinHash?: string; customized?: boolean };
                if (stored.customized === true || textHash(have.script ?? "") !== stored.builtinHash) {
                    out.skipped.push({ key: b.key, reason: "its text was changed by a person, so it is left as it is" });
                    continue;
                }
                const same = stable(have.configuration) === stable(cfg) && have.name === b.name && have.description === b.description && have.script === b.script;
                if (same) { out.unchanged++; continue; }
                const taken = byName.get(b.name);
                if (taken && taken.id !== have.id) { out.skipped.push({ key: b.key, reason: `another script is already called "${b.name}"` }); continue; }
                await this.prisma.automations.update({
                    where: { id: have.id },
                    data: { name: b.name, description: b.description, script: b.script, configuration: cfg as unknown as Prisma.InputJsonValue, updated_at: new Date() },
                });
                out.updated++;
                continue;
            }

            const clash = byName.get(b.name);
            if (clash) {
                out.skipped.push({ key: b.key, reason: `a script called "${b.name}" already exists and is not built in` });
                this.logger.warn(`Built-in script "${b.name}" was not added: a script with that name already exists.`);
                continue;
            }
            try {
                await this.prisma.automations.create({
                    data: { organization_id: organizationId, name: b.name, description: b.description, type: "script", script: b.script, configuration: cfg as unknown as Prisma.InputJsonValue, created_by: null },
                });
                out.created++;
            } catch (e) {
                if ((e as Prisma.PrismaClientKnownRequestError)?.code === "P2002") out.skipped.push({ key: b.key, reason: "a script with that name was added a moment ago" });
                else throw e;
            }
        }
        return out;
    }
}
