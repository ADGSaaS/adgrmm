// backend/src/devices/device-actions.controller.ts
import { DeviceAccessGuard } from "../access/device-access.guard";
import {
    Body,
    Controller,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Post,
    UsePipes,
    ValidationPipe,
    BadRequestException,
    ConflictException,
    UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";

import { JobsService } from "../jobs/jobs.service";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { RequirePerm } from "../auth/require-perm.decorator";
import { UninstallSoftwareDto } from "./dto/uninstall-software.dto";
import { checkPackageName, LINUX_PACKAGE_SCRIPT } from "../device-tools/linux-software.scripts";
import { AgentUpdatesService, agentUpdatesEnabled } from "../agents/agent-updates.service";
import { compareAgentVersions, parseAgentVersion } from "../agents/agent-version.util";
import { agentVersionAtLeast, linuxPatchMinVersion, patchOs } from "../patches/linux-patching";

class ActionRequestDto {
    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;
}

type ActionResponse = { accepted: true; jobId: string };

type AgentUpdateResponse =
    | { status: "up_to_date"; version: string }
    | { status: "started"; jobId: string; version: string; targetVersion: string };

// Same window the device list uses to call a device online.
const AGENT_ONLINE_WINDOW_MS = 5 * 60_000;
// The first release whose agents understand the job and contain a working updater.
const FIRST_SELF_UPDATING_VERSION = [1, 3, 0];

async function agentOsOf(prisma: PrismaService, agentId: string): Promise<string> {
    const agent = await prisma.agents.findUnique({
        where: { id: agentId },
        select: { facts: true, devices: { select: { operating_system: true } } },
    });
    return String((agent?.facts as any)?.os || agent?.devices?.operating_system || "").toLowerCase();
}

async function isWindowsAgent(prisma: PrismaService, agentId: string): Promise<boolean> {
    const agent = await prisma.agents.findUnique({
        where: { id: agentId },
        select: { facts: true, devices: { select: { operating_system: true } } },
    });
    const os = String((agent?.facts as any)?.os || agent?.devices?.operating_system || "").toLowerCase();
    return os === "windows";
}

/**
 * Resolve an agent id for actions.
 * Accepts:
 * - agents.id (preferred)
 * - devices.id (public.devices.id) -> lookup agents.device_id
 */
async function resolveAgentIdOrThrow(prisma: PrismaService, id: string): Promise<string> {
    const key = String(id ?? "").trim();
    if (!key) throw new NotFoundException("Missing device id");

    if (isCanonicalUuid(key)) {
        // 1) If the id is already an agent id, accept it.
        const asAgent = await prisma.agents.findUnique({ where: { id: key }, select: { id: true } });
        if (asAgent) return asAgent.id;

        // 2) Otherwise treat it as device id -> find agent by device_id
        const byDevice = await prisma.agents.findUnique({ where: { device_id: key }, select: { id: true } });
        if (byDevice) return byDevice.id;
    }

    // No connected agent for this device
    throw new NotFoundException("Agent not connected for this device");
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@UseGuards(DeviceAccessGuard)
@Controller("/api/devices/:id/actions")
export class DeviceActionsController {
    constructor(
        private readonly jobs: JobsService,
        private readonly prisma: PrismaService,
        private readonly updates: AgentUpdatesService,
    ) { }

    @Post("update-agent")
    @RequirePerm("devices.actions")
    @HttpCode(202)
    async updateAgent(@Param("id") id: string): Promise<AgentUpdateResponse> {
        const agentId = await resolveAgentIdOrThrow(this.prisma, id);
        const agent = await this.prisma.agents.findUnique({
            where: { id: agentId },
            select: { version: true, device_id: true, last_check_in_at: true, facts: true, devices: { select: { operating_system: true } } },
        });

        const lastSeen = agent?.last_check_in_at?.getTime() ?? 0;
        if (Date.now() - lastSeen > AGENT_ONLINE_WINDOW_MS) {
            throw new ConflictException("This device is offline. Try again when it is back online.");
        }

        const version = String(agent?.version ?? "");
        const parsed = parseAgentVersion(version);
        if (!parsed || compareAgentVersions(parsed, FIRST_SELF_UPDATING_VERSION) < 0) {
            throw new ConflictException(
                `This agent (version ${version || "unknown"}) cannot update itself. Run the installer on the device once, and later versions can update from here.`,
            );
        }

        if (!agentUpdatesEnabled()) {
            throw new ConflictException("Agent updates are turned off on this server.");
        }

        const facts = (agent?.facts ?? {}) as any;
        const os = facts.os || agent?.devices?.operating_system;
        // The device's own ring decides what it is offered: a pilot device gets the candidate build, everyone else the stable one.
        const manifest = await this.updates.getManifest(os, facts.arch, version, agent?.device_id ?? null);
        if (!manifest) return { status: "up_to_date", version };

        const job = await this.jobs.createAgentUpdateJob(agentId);
        return { status: "started", jobId: job.id, version, targetVersion: manifest.version };
    }

    /**
     * What a requested update has come to. The job only says whether the agent accepted the request,
     * so success is the device reporting the new version after it restarts.
     */
    @Get("update-agent/:jobId")
    @RequirePerm("devices.read")
    async updateAgentStatus(@Param("id") id: string, @Param("jobId") jobId: string) {
        const agentId = await resolveAgentIdOrThrow(this.prisma, id);
        if (!isCanonicalUuid(jobId)) throw new NotFoundException("Update not found");

        const job = await this.jobs.getJobWithResult(jobId);
        if (job.agent_id !== agentId || job.type !== "AGENT_UPDATE") throw new NotFoundException("Update not found");

        const agent = await this.prisma.agents.findUnique({
            where: { id: agentId },
            select: { version: true },
        });

        // After the agent accepted the request, a failure is only known from what the agent reports with its next update check.
        const failure = (await this.prisma.$queryRaw<Array<{ version: string; outcome: string; detail: string }>>`
            SELECT version, outcome, detail FROM public.agent_update_failures
             WHERE agent_id = ${agentId}::uuid AND reported_at >= ${new Date(job.created_at as any)}`)[0] ?? null;

        return {
            job: job.status,
            error: job.status === "failed" || job.status === "timeout" ? job.stderr || null : null,
            version: agent?.version ?? null,
            failure,
        };
    }

    @Post("reboot")
    @RequirePerm("devices.actions")
    @HttpCode(202)
    async reboot(@Param("id") id: string, @Body() _body: ActionRequestDto): Promise<ActionResponse> {
        const agentId = await resolveAgentIdOrThrow(this.prisma, id);

        const windows = await isWindowsAgent(this.prisma, agentId);
        const job = await this.jobs.createRunScriptJob({
            agentId,
            language: windows ? "powershell" : "bash",
            scriptText: windows ? "shutdown.exe /r /t 5" : "shutdown -r +0 >/dev/null 2>&1 &",
            timeoutSec: 60,
        });

        return { accepted: true, jobId: job.id };
    }

    @Post("patch")
    @RequirePerm("devices.actions")
    @HttpCode(202)
    async patch(@Param("id") id: string, @Body() _body: ActionRequestDto): Promise<ActionResponse> {
        const agentId = await resolveAgentIdOrThrow(this.prisma, id);
        const target = await this.prisma.agents.findUnique({ where: { id: agentId }, select: { version: true, facts: true, devices: { select: { operating_system: true } } } });
        const targetOs = patchOs(target?.facts, target?.devices?.operating_system);
        if (targetOs === "linux") {
            // A Linux agent installs every available update itself, as a signed patch_install task (the id returned is the task's).
            const need = linuxPatchMinVersion();
            if (!agentVersionAtLeast(target?.version, need)) {
                throw new ConflictException(`Patching a Linux device needs agent ${need} or newer. This device has ${target?.version || "an unknown version"}; update its agent first.`);
            }
            const now = new Date();
            const task = await this.prisma.agent_tasks.create({
                data: { agent_id: agentId, type: "patch_install", payload: { includeOptional: false, ids: [], mode: "all" }, status: "queued", queued_at: now, created_by: null, created_at: now, updated_at: now },
                select: { id: true },
            });
            return { accepted: true, jobId: task.id };
        }
        if (targetOs !== "windows") {
            throw new BadRequestException("Patching is available on Windows and Linux devices.");
        }

        const job = await this.jobs.createRunScriptJob({
            agentId,
            language: "powershell",
            scriptText:
                'Install-Module PSWindowsUpdate -Force -Scope CurrentUser; Import-Module PSWindowsUpdate; Get-WindowsUpdate -AcceptAll -Install -AutoReboot',
            timeoutSec: 15 * 60,
        });

        return { accepted: true, jobId: job.id };
    }

    @Post("uninstall")
    @RequirePerm("devices.actions")
    @HttpCode(202)
    async uninstall(
        @Param("id") id: string,
        @Body() body: UninstallSoftwareDto
    ): Promise<ActionResponse> {
        if (!body?.name) throw new NotFoundException("Missing software name");

        const agentId = await resolveAgentIdOrThrow(this.prisma, id);
        const targetOs = await agentOsOf(this.prisma, agentId);
        if (targetOs === "linux") return this.linuxPackage(agentId, body.name, "remove");
        if (targetOs !== "windows") {
            throw new BadRequestException("Uninstalling software is available on Windows and Linux devices.");
        }

        // The name arrives through the environment, so PowerShell never parses it as code.
        const ps = `
$ErrorActionPreference = 'Stop'
$targetName = $env:REMOTEIQ_UNINSTALL_NAME
$apps = @()
$apps += Get-ItemProperty "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -ErrorAction SilentlyContinue
$apps += Get-ItemProperty "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -ErrorAction SilentlyContinue
$target = $apps | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $targetName } | Select-Object -First 1
if (-not $target) { [Console]::Error.WriteLine("App not found: $targetName"); exit 2 }
$quiet = if ($target.PSObject.Properties['QuietUninstallString']) { $target.QuietUninstallString } else { '' }
$normal = if ($target.PSObject.Properties['UninstallString']) { $target.UninstallString } else { '' }
$command = if ($quiet) { $quiet } else { $normal }
if (-not $command) { [Console]::Error.WriteLine("No uninstall command found for $targetName"); exit 3 }
if ($command -match '(?i)^\\s*"?msiexec(\\.exe)?"?\\s') {
  $command = ($command -replace '(?i)/i\\s*\\{', '/x {') + ' /qn /norestart'
}
$p = Start-Process -FilePath "cmd.exe" -ArgumentList '/c', ('"' + $command + '"') -Wait -NoNewWindow -PassThru
exit $p.ExitCode
    `.trim();

        const job = await this.jobs.createRunScriptJob({
            agentId,
            language: "powershell",
            scriptText: ps,
            env: { REMOTEIQ_UNINSTALL_NAME: body.name },
            timeoutSec: 30 * 60,
        });

        return { accepted: true, jobId: job.id };
    }
    /** Installs one package from the device's own repositories (Linux only; Windows installs come from the software library). */
    @Post("install-package")
    @RequirePerm(["devices.actions", "software.install"])
    @HttpCode(202)
    async installPackage(@Param("id") id: string, @Body() body: UninstallSoftwareDto): Promise<ActionResponse> {
        const agentId = await resolveAgentIdOrThrow(this.prisma, id);
        if ((await agentOsOf(this.prisma, agentId)) !== "linux") {
            throw new BadRequestException("Installing a package by name is only available on Linux devices. Windows devices install from the software library.");
        }
        return this.linuxPackage(agentId, body?.name, "install");
    }

    /** One fixed bash job; the name and action travel only in the environment. */
    private async linuxPackage(agentId: string, rawName: unknown, action: "install" | "remove"): Promise<ActionResponse> {
        const name = checkPackageName(rawName, action);
        const job = await this.jobs.createRunScriptJob({
            agentId,
            language: "bash",
            scriptText: LINUX_PACKAGE_SCRIPT,
            env: { RIQ_PKG: name, RIQ_PKG_ACTION: action },
            timeoutSec: 30 * 60,
        });
        return { accepted: true, jobId: job.id };
    }
}
