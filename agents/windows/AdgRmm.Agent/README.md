# ADG RMM Windows Agent

A secure .NET 8 Windows Service that enrolls with the ADG RMM backend, sends heartbeats and inventory, executes **signed** tasks, uploads artifacts (via task handlers), and supports staged self-updates.

## Build

Run `agents/build-packages.ps1` from the repo root. It produces the packages the backend serves.

## Install

Open **Customers > Reusable Installer** in the console, create a key, and run the install command it shows in an elevated PowerShell prompt.

Service account: **LocalSystem**, which script jobs and patching need.

## Logs & Config

- Logs: `%ProgramData%/AdgRmm/Logs/agent-*.log`
- Config: `%ProgramData%/AdgRmm/agent.config.json` (DPAPI-protected secret fields)

## Security

- **Signed tasks only**: RSA-PSS signatures validated using your server **public key** in `appsettings.json`.
- **DPAPI at rest**: `AgentKey` is encrypted using `LocalMachine` DPAPI.
- **Optional TLS certificate pinning**: enable and set `PinnedSpkiSha256` for SPKI pins.

## Backend Endpoints (actual)

REST (authenticated with `Authorization: Bearer {agentToken}`):

- `POST /api/agent/enroll` → `{ agentId, agentToken, deviceId, agentUuid }`
- `POST /api/agent/ping`
- `POST /api/agent/software`

WebSocket:

- Agent connects to `/ws/agent`
- Sends `{ t:"agent_hello", agentId, deviceId, ... }`
- Receives `{ t:"job_run_script", jobId, language, scriptText, args, env, timeoutSec }`
- Responds `{ t:"job_result", jobId, exitCode, stdout, stderr, durationMs, status }`

> Adjust URLs in services if your NestJS controllers differ.

## Uninstall

```powershell
& "$env:ProgramFiles\AdgRmm\Agent\uninstall.ps1"
```
