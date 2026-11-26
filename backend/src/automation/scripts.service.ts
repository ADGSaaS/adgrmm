// backend/src/automation/scripts.service.ts
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { JobsService } from "../jobs/jobs.service";
import { BUILTIN_CATEGORIES } from "./builtin-scripts.types";
import { ALL_BUILTIN_SCRIPTS, textHash } from "./builtin-scripts";
import { configurationOf } from "./builtin-scripts.service";

export type ScriptLanguage = "powershell" | "bash";
/**
 * Which systems a script is meant for. "both" (Windows and Linux) holds two bodies: the PowerShell one (`script`) and a bash one (`linuxScript`).
 * "all" (Windows, Linux and macOS) adds a third, `macosScript`, run with bash on a Mac.
 */
export type ScriptPlatform = "windows" | "linux" | "both" | "all";

export type ScriptParameter = { name: string; label?: string; required?: boolean; defaultValue?: string };

export type ScriptInput = {
    name: string;
    description?: string | null;
    language: ScriptLanguage;
    script: string;
    timeoutSec?: number;
    parameters?: ScriptParameter[];
    /** The name of an existing category (built-in or made by a person), or none. */
    category?: string | null;
    /** Omitted: from the language (PowerShell is for Windows, bash for Linux). */
    platform?: ScriptPlatform;
    /** The bash body of a script that is meant for both systems. */
    linuxScript?: string | null;
    /** The bash body of a script that is meant for all three systems. */
    macosScript?: string | null;
};

export type ScheduleInput = {
    automationId: string;
    name: string;
    targetType: "organization" | "client" | "site" | "device";
    targetId?: string | null;
    intervalMinutes: number;
    startAt?: string | null;
    enabled?: boolean;
    parameters?: Record<string, string>;
};

const SWEEP_EVERY_MS = 30_000;
const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 86_400;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_DEVICES_PER_RUN = 500;
const MIN_INTERVAL_MINUTES = 5;
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type Config = { language: ScriptLanguage; timeoutSec: number; parameters: ScriptParameter[]; builtin?: boolean; category?: string; customized?: boolean; builtinKey?: string; builtinHash?: string; platform?: ScriptPlatform; linuxScript?: string; macosScript?: string };

const configOf = (raw: unknown): Config => {
    const c = (raw ?? {}) as Partial<Config>;
    return {
        language: c.language === "bash" ? "bash" : "powershell",
        timeoutSec: Number(c.timeoutSec) || DEFAULT_TIMEOUT_SEC,
        parameters: Array.isArray(c.parameters) ? c.parameters : [],
        builtin: c.builtin === true,
        category: typeof c.category === "string" ? c.category : undefined,
        customized: c.customized === true,
        platform: c.platform === "both" || c.platform === "all" || c.platform === "windows" || c.platform === "linux" ? c.platform : c.language === "bash" ? "linux" : "windows",
        linuxScript: typeof c.linuxScript === "string" ? c.linuxScript : undefined,
        macosScript: typeof c.macosScript === "string" ? c.macosScript : undefined,
        builtinKey: typeof c.builtinKey === "string" ? c.builtinKey : undefined,
        builtinHash: typeof c.builtinHash === "string" ? c.builtinHash : undefined,
    };
};

const CATEGORY_NAME_MAX = 60;

/** A device's own system, from the operating-system text its agent reports. */
export const systemOf = (os: string): "windows" | "macos" | "linux" => {
    const o = os.toLowerCase();
    return o.includes("windows") ? "windows" : o.includes("mac") || o.includes("darwin") ? "macos" : "linux";
};

const languageFits = (language: ScriptLanguage, os: string) => {
    const windows = os.toLowerCase().includes("windows");
    return language === "powershell" ? windows : !windows;
};

@Injectable()
export class ScriptsService {
    private readonly logger = new Logger(ScriptsService.name);
    private sweeping = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly jobs: JobsService,
    ) { }

    /* ------------------------------ library ------------------------------ */

    private validate(input: ScriptInput): Config {
        if (!input.name?.trim()) throw new BadRequestException("Give the script a name.");
        if (!input.script?.trim()) throw new BadRequestException("The script is empty.");
        if (new TextEncoder().encode(input.script).length > MAX_SCRIPT_BYTES) throw new BadRequestException("That script is too large.");

        const parameters = input.parameters ?? [];
        const names = new Set<string>();
        for (const p of parameters) {
            if (!PARAMETER_NAME.test(p.name ?? "")) throw new BadRequestException(`"${p.name}" cannot be a parameter name. Use letters, numbers and underscores.`);
            if (names.has(p.name.toLowerCase())) throw new BadRequestException(`There are two parameters named "${p.name}".`);
            names.add(p.name.toLowerCase());
        }

        // which systems it is for: said outright, or from the language
        const platform: ScriptPlatform = input.platform === "both" || input.platform === "all" || input.platform === "windows" || input.platform === "linux" ? input.platform : input.language === "bash" ? "linux" : "windows";
        let linuxScript: string | undefined;
        let macosScript: string | undefined;
        if (platform === "both" || platform === "all") {
            linuxScript = String(input.linuxScript ?? "");
            if (!linuxScript.trim()) throw new BadRequestException(`A script for ${platform === "all" ? "all systems" : "both systems"} needs its Linux (bash) part as well as its Windows (PowerShell) part.`);
            if (new TextEncoder().encode(linuxScript).length > MAX_SCRIPT_BYTES) throw new BadRequestException("The Linux part is too large.");
        }
        if (platform === "all") {
            macosScript = String(input.macosScript ?? "");
            if (!macosScript.trim()) throw new BadRequestException("A script for all systems needs its macOS (bash) part too.");
            if (new TextEncoder().encode(macosScript).length > MAX_SCRIPT_BYTES) throw new BadRequestException("The macOS part is too large.");
        }
        return {
            // a script for both keeps its Windows (PowerShell) text in `script` and its bash text in linuxScript
            language: platform === "both" || platform === "all" || platform === "windows" ? "powershell" : "bash",
            platform,
            linuxScript,
            macosScript,
            timeoutSec: Math.min(Math.max(input.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 10), MAX_TIMEOUT_SEC),
            parameters,
        };
    }

    private present(row: { id: string; name: string; description: string | null; script: string | null; configuration: unknown; updated_at: Date }) {
        const config = configOf(row.configuration);
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            script: row.script ?? "",
            language: config.language,
            platform: config.platform ?? (config.language === "bash" ? "linux" : "windows"),
            linuxScript: config.platform === "both" || config.platform === "all" ? config.linuxScript ?? "" : null,
            macosScript: config.platform === "all" ? config.macosScript ?? "" : null,
            timeoutSec: config.timeoutSec,
            parameters: config.parameters,
            builtin: config.builtin === true,
            // a built-in whose text or settings a person changed no longer follows the shipped version
            customized: config.builtin === true && (config.customized === true || (!!config.builtinHash && textHash(row.script ?? "") !== config.builtinHash)),
            category: config.category ?? null,
            updatedAt: row.updated_at,
        };
    }

    async list() {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const rows = await this.prisma.automations.findMany({
            where: { organization_id: organizationId, type: "script" },
            orderBy: { name: "asc" },
        });
        return { items: rows.map((r) => this.present(r)) };
    }

    async create(input: ScriptInput, userId: string | null) {
        const config = this.validate(input);
        config.category = await this.resolveCategory(input.category);
        const organizationId = await this.orgs.getDefaultOrganizationId();
        try {
            const row = await this.prisma.automations.create({
                data: {
                    organization_id: organizationId,
                    name: input.name.trim(),
                    description: input.description ?? null,
                    type: "script",
                    script: input.script,
                    configuration: config as unknown as Prisma.InputJsonValue,
                    created_by: userId,
                },
            });
            return this.present(row);
        } catch (err) {
            if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2002") throw new ConflictException("A script with that name already exists.");
            throw err;
        }
    }

    /** A copy a person can edit: "<name> (copy)", or "(copy 2)" and so on when that name is taken. */
    async duplicate(id: string, userId: string | null) {
        const src = await this.prisma.automations.findUnique({ where: { id } });
        if (!src || src.type !== "script") throw new NotFoundException("Script not found");
        const taken = new Set(
            (await this.prisma.automations.findMany({ where: { organization_id: src.organization_id, name: { startsWith: `${src.name} (copy` } }, select: { name: true } })).map((r) => r.name),
        );
        let name = `${src.name} (copy)`;
        for (let n = 2; taken.has(name) && n < 1000; n++) name = `${src.name} (copy ${n})`;
        const config = { ...((src.configuration ?? {}) as Record<string, unknown>) };
        for (const k of ["builtin", "builtinKey", "builtinVersion", "builtinHash", "customized"]) delete config[k];
        try {
            const row = await this.prisma.automations.create({
                data: {
                    organization_id: src.organization_id,
                    name,
                    description: src.description,
                    type: "script",
                    script: src.script,
                    configuration: config as unknown as Prisma.InputJsonValue,
                    created_by: userId,
                },
            });
            return this.present(row);
        } catch (err) {
            if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2002") throw new ConflictException("A script with that name already exists.");
            throw err;
        }
    }

    async update(id: string, input: ScriptInput) {
        const config = this.validate(input);
        const existing = await this.prisma.automations.findUnique({ where: { id }, select: { type: true, configuration: true } });
        if (!existing || existing.type !== "script") throw new NotFoundException("Script not found");
        const old = configOf(existing.configuration);
        config.category = await this.resolveCategory(input.category);
        if (old.builtin) {
            // Editing a built-in is allowed. It keeps its identity, and from now on it no longer follows the shipped version.
            const raw = (existing.configuration ?? {}) as Record<string, unknown>;
            for (const k of ["builtin", "builtinKey", "builtinVersion", "builtinHash"]) if (k in raw) (config as any)[k] = raw[k];
            config.customized = true;
        }
        try {
            const row = await this.prisma.automations.update({
                where: { id },
                data: {
                    name: input.name.trim(),
                    description: input.description ?? null,
                    script: input.script,
                    configuration: config as unknown as Prisma.InputJsonValue,
                    updated_at: new Date(),
                },
            });
            return this.present(row);
        } catch (err) {
            const code = (err as Prisma.PrismaClientKnownRequestError)?.code;
            if (code === "P2002") throw new ConflictException("A script with that name already exists.");
            if (code === "P2025") throw new NotFoundException("Script not found");
            throw err;
        }
    }

    /** A built-in script put back to what ADG RMM ships: its name, text, settings and category. */
    async reset(id: string) {
        const row = await this.prisma.automations.findUnique({ where: { id } });
        if (!row || row.type !== "script") throw new NotFoundException("Script not found");
        const key = configOf(row.configuration).builtinKey;
        const shipped = key ? ALL_BUILTIN_SCRIPTS.find((b) => b.key === key) : undefined;
        if (!configOf(row.configuration).builtin || !shipped) throw new ConflictException("Only a built-in script can be put back to the original.");
        const clash = await this.prisma.automations.findFirst({ where: { organization_id: row.organization_id, name: shipped.name, NOT: { id } }, select: { id: true } });
        if (clash) throw new ConflictException(`Another script is already called "${shipped.name}". Rename or remove it first.`);
        const updated = await this.prisma.automations.update({
            where: { id },
            data: { name: shipped.name, description: shipped.description, script: shipped.script, configuration: configurationOf(shipped) as unknown as Prisma.InputJsonValue, updated_at: new Date() },
        });
        return this.present(updated);
    }

    async remove(id: string) {
        await this.prisma.automations.delete({ where: { id } }).catch(() => {
            throw new NotFoundException("Script not found");
        });
        return { id, deleted: true };
    }

    /* ------------------------------ categories ------------------------------ */

    private async userCategories(organizationId: string) {
        return this.prisma.$queryRaw<Array<{ id: string; name: string }>>`SELECT id::text AS id, name FROM public.script_categories WHERE organization_id = ${organizationId}::uuid ORDER BY lower(name)`;
    }

    /** The stored spelling of a category name that exists, or null for none; anything else is refused (a script cannot invent a category). */
    private async resolveCategory(raw: string | null | undefined): Promise<string | undefined> {
        const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
        if (!name) return undefined;
        const built = BUILTIN_CATEGORIES.find((c) => c.toLowerCase() === name.toLowerCase());
        if (built) return built;
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const mine = (await this.userCategories(organizationId)).find((c) => c.name.toLowerCase() === name.toLowerCase());
        if (!mine) throw new BadRequestException(`There is no category called "${name.slice(0, 60)}". Choose one from the list.`);
        return mine.name;
    }

    async listCategories() {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const rows = await this.prisma.automations.findMany({ where: { organization_id: organizationId, type: "script" }, select: { configuration: true } });
        const counts = new Map<string, number>();
        let uncategorized = 0;
        for (const r of rows) {
            const c = configOf(r.configuration).category;
            if (c) counts.set(c.toLowerCase(), (counts.get(c.toLowerCase()) ?? 0) + 1); else uncategorized++;
        }
        const mine = await this.userCategories(organizationId);
        return {
            items: [
                ...BUILTIN_CATEGORIES.map((name) => ({ id: null as string | null, name: name as string, builtin: true, count: counts.get(name.toLowerCase()) ?? 0 })),
                ...mine.map((c) => ({ id: c.id as string | null, name: c.name, builtin: false, count: counts.get(c.name.toLowerCase()) ?? 0 })),
            ],
            uncategorized,
        };
    }

    async createCategory(rawName: unknown, userId: string | null) {
        const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
        if (!name) throw new BadRequestException("Give the category a name.");
        if (name.length > CATEGORY_NAME_MAX) throw new BadRequestException(`A category name is at most ${CATEGORY_NAME_MAX} characters.`);
        if (/[\u0000-\u001f\u007f<>]/.test(name)) throw new BadRequestException("That name has characters that are not allowed.");
        if (BUILTIN_CATEGORIES.some((c) => c.toLowerCase() === name.toLowerCase())) throw new BadRequestException(`"${name}" is already one of the built-in categories.`);
        const organizationId = await this.orgs.getDefaultOrganizationId();
        try {
            const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
                INSERT INTO public.script_categories (organization_id, name, created_by)
                VALUES (${organizationId}::uuid, ${name}, ${userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null}::uuid)
                RETURNING id::text AS id`;
            return { id: rows[0].id, name, builtin: false, count: 0 };
        } catch (err) {
            if ((err as { code?: string; meta?: { code?: string } })?.meta?.code === "23505" || /unique/i.test(String((err as Error)?.message))) throw new ConflictException(`There is already a category called "${name}".`);
            throw err;
        }
    }

    async deleteCategory(id: string) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException("Category not found");
        const row = (await this.prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM public.script_categories WHERE id = ${id}::uuid AND organization_id = ${organizationId}::uuid`)[0];
        if (!row) throw new NotFoundException("Category not found");
        const inUse = (await this.listCategories()).items.find((c) => c.id === id)?.count ?? 0;
        if (inUse > 0) throw new ConflictException(`${inUse === 1 ? "A script is" : `${inUse} scripts are`} in "${row.name}". Move ${inUse === 1 ? "it" : "them"} to another category first.`);
        await this.prisma.$executeRaw`DELETE FROM public.script_categories WHERE id = ${id}::uuid`;
        return { id, deleted: true };
    }

    /* ------------------------------ running ------------------------------ */

    /** Values reach the script as environment variables, so they can never be parsed as code. */
    private environment(config: Config, supplied: Record<string, string>) {
        const env: Record<string, string> = {};
        for (const parameter of config.parameters) {
            const value = supplied[parameter.name] ?? parameter.defaultValue ?? "";
            if (parameter.required && !value) throw new BadRequestException(`"${parameter.label || parameter.name}" is required.`);
            env[`ADG_${parameter.name.toUpperCase()}`] = value;
        }
        return env;
    }

    private async runOnDevices(
        script: { id: string; name: string; script: string | null; configuration: unknown },
        deviceIds: string[],
        supplied: Record<string, string>,
        userId: string | null,
        scheduleId: string | null,
    ) {
        const config = configOf(script.configuration);
        const env = this.environment(config, supplied);

        const devices = await this.prisma.devices.findMany({
            where: { id: { in: deviceIds } },
            select: { id: true, hostname: true, operating_system: true, agents: { select: { id: true, facts: true } } },
        });

        const started: Array<{ deviceId: string; jobId: string }> = [];
        const skipped: Array<{ deviceId: string; name: string; reason: string }> = [];

        for (const device of devices) {
            if (!device.agents) {
                skipped.push({ deviceId: device.id, name: device.hostname, reason: "It has no agent." });
                continue;
            }
            const os = String((device.agents.facts as any)?.os || device.operating_system || "");
            // a script for both systems runs its Windows part on Windows and its bash part on Linux
            const system = systemOf(os);
            const isWindows = system === "windows";
            const both = config.platform === "both" || config.platform === "all";
            if (config.platform === "both" && system === "macos") {
                skipped.push({ deviceId: device.id, name: device.hostname, reason: "This script is made for Windows and Linux, not for macOS." });
                continue;
            }
            if (!both && !languageFits(config.language, os)) {
                skipped.push({ deviceId: device.id, name: device.hostname, reason: `This ${config.language} script does not run on ${os || "this system"}.` });
                continue;
            }
            const runLanguage: ScriptLanguage = both ? (isWindows ? "powershell" : "bash") : config.language;
            const runText = both && system === "macos" ? config.macosScript ?? "" : both && !isWindows ? config.linuxScript ?? "" : script.script ?? "";

            const job = await this.jobs.createRunScriptJob({
                agentId: device.agents.id,
                language: runLanguage,
                scriptText: runText,
                env,
                timeoutSec: config.timeoutSec,
            });
            await this.prisma.script_runs.create({
                data: {
                    automation_id: script.id,
                    script_name: script.name,
                    job_id: job.id,
                    device_id: device.id,
                    schedule_id: scheduleId,
                    triggered_by: userId,
                },
            });
            started.push({ deviceId: device.id, jobId: job.id });
        }

        return { started, skipped };
    }

    async run(id: string, deviceIds: string[], supplied: Record<string, string>, userId: string | null) {
        if (!deviceIds.length) throw new BadRequestException("Choose at least one device.");
        if (deviceIds.length > MAX_DEVICES_PER_RUN) throw new BadRequestException(`Choose at most ${MAX_DEVICES_PER_RUN} devices at a time.`);

        const script = await this.prisma.automations.findUnique({ where: { id } });
        if (!script) throw new NotFoundException("Script not found");
        return this.runOnDevices(script, deviceIds, supplied ?? {}, userId, null);
    }

    async history(params: { automationId?: string; deviceId?: string; cursor?: string; limit?: number | string }) {
        const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
        const rows = await this.prisma.script_runs.findMany({
            where: {
                ...(params.automationId ? { automation_id: params.automationId } : {}),
                ...(params.deviceId ? { device_id: params.deviceId } : {}),
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: limit + 1,
            ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
            include: {
                devices: { select: { id: true, hostname: true, alias: true } },
                jobs: { select: { status: true, started_at: true, finished_at: true, job_results: { select: { exit_code: true, stdout: true, stderr: true } } } },
            },
        });
        const page = rows.slice(0, limit);
        return {
            items: page.map((r) => ({
                id: r.id,
                jobId: r.job_id,
                scriptName: r.script_name,
                scheduled: !!r.schedule_id,
                device: { id: r.devices.id, name: r.devices.alias || r.devices.hostname },
                status: r.jobs.status,
                createdAt: r.created_at,
                finishedAt: r.jobs.finished_at,
                exitCode: r.jobs.job_results?.exit_code ?? null,
                stdout: r.jobs.job_results?.stdout?.slice(0, 20_000) ?? "",
                stderr: r.jobs.job_results?.stderr?.slice(0, 20_000) ?? "",
            })),
            nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        };
    }

    /* ------------------------------ schedules ------------------------------ */

    private validateSchedule(input: ScheduleInput) {
        if (!input.name?.trim()) throw new BadRequestException("Give the schedule a name.");
        if (input.intervalMinutes < MIN_INTERVAL_MINUTES) throw new BadRequestException(`A schedule can run at most every ${MIN_INTERVAL_MINUTES} minutes.`);
        if (input.targetType !== "organization" && !input.targetId) throw new BadRequestException("Choose where it should run.");
        const start = input.startAt ? new Date(input.startAt) : new Date(Date.now() + input.intervalMinutes * 60_000);
        if (Number.isNaN(start.getTime())) throw new BadRequestException("That start time is not valid.");
        return start;
    }

    private presentSchedule(row: any) {
        return {
            id: row.id,
            automationId: row.automation_id,
            scriptName: row.automations?.name ?? null,
            name: row.name,
            targetType: row.target_type,
            targetId: row.target_id,
            intervalMinutes: row.interval_minutes,
            nextRunAt: row.next_run_at,
            lastRunAt: row.last_run_at,
            enabled: row.enabled,
            parameters: row.parameters,
        };
    }

    async listSchedules() {
        const rows = await this.prisma.script_schedules.findMany({
            orderBy: { name: "asc" },
            include: { automations: { select: { name: true } } },
        });
        return { items: rows.map((r) => this.presentSchedule(r)) };
    }

    async createSchedule(input: ScheduleInput, userId: string | null) {
        const start = this.validateSchedule(input);
        const row = await this.prisma.script_schedules.create({
            data: {
                automation_id: input.automationId,
                name: input.name.trim(),
                target_type: input.targetType,
                target_id: input.targetType === "organization" ? null : input.targetId,
                interval_minutes: input.intervalMinutes,
                next_run_at: start,
                enabled: input.enabled ?? true,
                parameters: (input.parameters ?? {}) as Prisma.InputJsonValue,
                created_by: userId,
            },
            include: { automations: { select: { name: true } } },
        });
        return this.presentSchedule(row);
    }

    async updateSchedule(id: string, input: ScheduleInput) {
        const start = this.validateSchedule(input);
        try {
            const row = await this.prisma.script_schedules.update({
                where: { id },
                data: {
                    automation_id: input.automationId,
                    name: input.name.trim(),
                    target_type: input.targetType,
                    target_id: input.targetType === "organization" ? null : input.targetId,
                    interval_minutes: input.intervalMinutes,
                    next_run_at: start,
                    enabled: input.enabled ?? true,
                    parameters: (input.parameters ?? {}) as Prisma.InputJsonValue,
                    updated_at: new Date(),
                },
                include: { automations: { select: { name: true } } },
            });
            return this.presentSchedule(row);
        } catch {
            throw new NotFoundException("Schedule not found");
        }
    }

    async removeSchedule(id: string) {
        await this.prisma.script_schedules.delete({ where: { id } }).catch(() => {
            throw new NotFoundException("Schedule not found");
        });
        return { id, deleted: true };
    }

    private async devicesFor(targetType: string, targetId: string | null): Promise<string[]> {
        const where: Prisma.devicesWhereInput =
            targetType === "device" ? { id: targetId ?? undefined }
                : targetType === "site" ? { site_id: targetId }
                    : targetType === "client" ? { sites: { client_id: targetId ?? undefined } }
                        : {};
        const rows = await this.prisma.devices.findMany({ where: { ...where, agents: { isNot: null } }, select: { id: true } });
        return rows.map((r) => r.id);
    }

    @Interval(SWEEP_EVERY_MS)
    async runDueSchedules(): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            const now = new Date();
            const due = await this.prisma.script_schedules.findMany({
                where: { enabled: true, next_run_at: { lte: now } },
                include: { automations: true },
            });

            for (const schedule of due) {
                // Moved forward first, and past anything missed, so a restart or an outage never fires a backlog.
                const step = schedule.interval_minutes * 60_000;
                const behind = now.getTime() - schedule.next_run_at.getTime();
                const next = new Date(schedule.next_run_at.getTime() + (Math.floor(behind / step) + 1) * step);
                await this.prisma.script_schedules.update({ where: { id: schedule.id }, data: { next_run_at: next, last_run_at: now } });

                try {
                    const devices = await this.devicesFor(schedule.target_type, schedule.target_id);
                    await this.runOnDevices(schedule.automations, devices, (schedule.parameters ?? {}) as Record<string, string>, null, schedule.id);
                } catch (err) {
                    this.logger.error(`Schedule "${schedule.name}" could not run: ${(err as Error).message}`);
                }
            }
        } catch (err) {
            this.logger.error(`Could not check script schedules: ${(err as Error).message}`);
        } finally {
            this.sweeping = false;
        }
    }
}
