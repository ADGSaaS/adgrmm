<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/adg-saas-logo-horizontal-color-on-dark.svg">
    <img alt="ADG SaaS" src="docs/brand/adg-saas-logo-horizontal-color-on-light.svg" height="64">
  </picture>
</p>

# ADG RMM

<p align="center">
  <a href="https://github.com/adgsaas/adgrmm/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/adgsaas/adgrmm?label=release&color=5B8CFF"></a>
  <a href="LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/badge/license-AGPL--3.0-A06BFF"></a>
  <a href="https://github.com/adgsaas/adgrmm/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/adgsaas/adgrmm?color=FF5FA2"></a>
  <a href="https://github.com/adgsaas/adgrmm/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/adgsaas/adgrmm"></a>
  <a href="https://github.com/adgsaas/adgrmm/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/adgsaas/adgrmm?style=flat"></a>
  <img alt="Agents: Windows and Linux" src="https://img.shields.io/badge/agents-Windows%20%7C%20Linux-informational">
  <img alt="Backend: NestJS" src="https://img.shields.io/badge/backend-NestJS-E0234E?logo=nestjs&logoColor=white">
  <img alt="Frontend: Next.js" src="https://img.shields.io/badge/frontend-Next.js-000000?logo=nextdotjs&logoColor=white">
  <img alt="Database: PostgreSQL" src="https://img.shields.io/badge/database-PostgreSQL-4169E1?logo=postgresql&logoColor=white">
  <img alt="Agent: .NET 8" src="https://img.shields.io/badge/agent-.NET%208-512BD4?logo=dotnet&logoColor=white">
  <a href="CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen"></a>
</p>

ADG RMM is an all-in-one platform for managed service providers (MSPs): remote monitoring and management (RMM), a service desk, documentation, billing and client-facing tools in one product.

This repository holds all of ADG RMM: the API, the web dashboard, the agents and the installer.

| Part | Where | What it is |
|---|---|---|
| **Web dashboard** | [`frontend/`](frontend/) | Next.js app the technicians and customers use. Talks to the API only |
| **Backend API** | [`backend/`](backend/) | NestJS service with a PostgreSQL database. Serves the dashboard's API, talks to agents over HTTPS and WebSocket, and brokers remote sessions |
| **Windows agent** | [`agents/windows/AdgRmm.Agent`](agents/windows/AdgRmm.Agent) | .NET 8 Windows service that runs on managed devices |
| **Windows capture helper** | [`agents/windows/AdgRmm.CaptureHelper`](agents/windows/AdgRmm.CaptureHelper) | Small helper the agent starts in the user's session to capture the screen, inject input, and host the chat window for Remote Console |
| **Linux agent** | [`agents/linux/`](agents/linux) | .NET 8 agent for Linux devices |
| **Shared agent code** | [`agents/shared/`](agents/shared) | Checks, update logic and session-start verification used by both agents |
| **Native WebRTC** | [`native/`](native) | Native WebRTC library project for the agent |
| **Relay (TURN) setup** | [`deploy/turn/`](deploy/turn) | Docker Compose for a self-hosted coturn relay |
| **Docs** | [`docs/`](docs) | Operations guides, the roadmap and feature status |

**Licence:** GNU Affero General Public License v3.0 (see [`LICENSE`](LICENSE)). Contributions are welcome: see [`CONTRIBUTING.md`](CONTRIBUTING.md). To report a security problem, see [`SECURITY.md`](SECURITY.md).

> **Status:** under active development (releases are published, but expect rough edges and rapid change). What works, what is untested and what is planned are tracked in [`docs/roadmap/ROADMAP.md`](docs/roadmap/ROADMAP.md) and [`docs/roadmap/FEATURE-STATUS.md`](docs/roadmap/FEATURE-STATUS.md). Treat those two files as the source of truth, because a README goes out of date faster than a tracker does.

---

## Contents

- [How it fits together](#how-it-fits-together)
- [Quick start for development](#quick-start-for-development)
- [Configuration](#configuration)
- [Database](#database)
- [Backend layout](#backend-layout)
- [Agents](#agents)
- [Remote Console](#remote-console)
- [Releasing an agent version](#releasing-an-agent-version)
- [Security model](#security-model)
- [Testing and CI](#testing-and-ci)
- [Deploying](#deploying)
- [Documentation index](#documentation-index)
- [Contributing notes](#contributing-notes)

---

## How it fits together

```
                       ┌─────────────────────┐
  Technician browser ──►  ADG RMM frontend   │  Next.js dashboard (frontend/)
                       └──────────┬──────────┘
                                  │ /api/*  (proxied)
                                  ▼
                       ┌─────────────────────┐        ┌────────────────┐
                       │   Backend (NestJS)  │◄──────►│ PostgreSQL 16  │
                       │   REST + WebSocket  │        └────────────────┘
                       └───┬──────────┬──────┘
          HTTPS + /ws/agent│          │ signed session starts, signalling
                           ▼          ▼
                 ┌───────────────┐   ┌──────────────────────┐
                 │  Agents       │   │ TURN relay (optional)│  carries video when a
                 │ Windows/Linux │◄─►│ Cloudflare or coturn │  direct connection is blocked
                 └───────────────┘   └──────────────────────┘
```

- Agents **enroll** with a key, then send heartbeats and inventory, run **signed** jobs, and ask the backend for updates. Nothing is pushed to an agent over an inbound connection.
- A technician's **Remote Console** session is WebRTC between the browser and the device. The backend signs the session start, relays signalling, and issues short-lived relay credentials.
- Everything the backend persists lives in PostgreSQL, except two key files that are deliberately kept outside the database (see [Security model](#security-model)).

---

## Quick start for development

### Prerequisites

- Node.js and npm (the backend uses `package-lock.json`)
- PostgreSQL 16, or Docker to run the one provided
- .NET 8 SDK, only if you are building or changing the agents
- PowerShell 7 (`pwsh`), only for the agent build script

### Run the backend

```bash
# 1. Start a local PostgreSQL 16 (optional, if you do not already have one)
cd backend
mkdir -p .secrets && openssl rand -hex 24 > .secrets/postgres_password   # file read by docker-compose.db.yml
docker compose -f docker-compose.db.yml up -d

# 2. Configure
cp .env.example .env
#   set DATABASE_URL, JWT_SECRET (long and random) and the origins; see Configuration below

# 3. Install, apply the schema, run
npm install
npx prisma migrate deploy
npm run dev            # tsx watch src/main.ts, http://localhost:3001
```

Check that it is alive:

```bash
curl -sf http://localhost:3001/healthz && echo OK      # or: npm run health
```

In development (`NODE_ENV` not `production`) the OpenAPI docs are served by Swagger. In production they are off unless `SWAGGER=true`.

### Useful scripts (`backend/package.json`)

| Script | What it does |
|---|---|
| `npm run dev` | Run from source with automatic restart |
| `npm run build` | `prisma generate`, then compile TypeScript to `dist/` |
| `npm start` / `npm run start:prod` | Run the compiled build (`node dist/main.js`) |
| `npm run prisma:generate` | Regenerate the Prisma client |
| `npm run prisma:migrate:dev` | Create and apply a migration while developing |
| `npm run prisma:migrate:deploy` / `npm run db:migrate` | Apply pending migrations (use this in production) |
| `npm run prisma:migrate:status` | Show which migrations are applied |
| `npm run prisma:studio` | Browse the database |
| `npm run health` | Call `/healthz` |

> `prisma generate` must run before a build. `npm run build` does it for you.

---

## Configuration

The backend reads environment variables, usually from `backend/.env`. [`backend/.env.example`](backend/.env.example) is the annotated reference. The main groups:

| Group | Variables | Notes |
|---|---|---|
| **Server** | `NODE_ENV`, `PORT` (default `3001`), `SWAGGER`, `PUBLIC_BASE_URL` | |
| **Origins and cookies** | `FRONTEND_ORIGINS`, `ALLOWED_ORIGIN`, `AUTH_COOKIE_NAME`, `AUTH_COOKIE_DOMAIN`, `AUTH_COOKIE_MAX_AGE_MS` | Must match where the dashboard is served |
| **Auth** | `JWT_SECRET`, `JWT_EXPIRES`, `ADMIN_API_KEY`, `ENROLLMENT_SECRET` | Generate long random values. `generate-jwt-secret.ps1` in the repo root can do it |
| **Database** | `DATABASE_URL`, `DATABASE_SSL`, `DATABASE_POOL_MAX`, `DATABASE_POOL_MIN`, `POSTGRES_*` | `DATABASE_URL` is a standard `postgresql://` URL |
| **Agents** | `AGENT_PKG_DIR`, `PUBLIC_API_BASE_URL`, `INSTALLER_BASE_URL`, `AGENT_UPDATES_ENABLED` | Where agent packages are served from and what URL agents are told to use |
| **Keys** | `JOB_SIGNING_KEY_FILE`, `DATA_ENCRYPTION_KEY_FILE` | Paths to two key files; see [Security model](#security-model) |
| **Remote Console relay** | `TURN_PROVIDER` (`builtin`, `cloudflare` or `none`), plus the provider's own settings | See [`docs/remote-console-turn.md`](docs/remote-console-turn.md) |
| **Seat limits (hosted plans)** | `ENTITLEMENTS_FILE` (default `/config/entitlements.json`) | Optional. No file means no limits. See [`docs/entitlements.md`](docs/entitlements.md) |
| **Retention** | `CHECK_RUNS_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS` | |
| **Mail** | `IMAP_POLL_ENABLED` and the SMTP/IMAP settings stored through the admin screens | Passwords are encrypted with the data key |

Never commit a real `.env` file or the key files.

---

## Database

- **PostgreSQL 16**, accessed through **Prisma** (`backend/prisma/schema.prisma`, about 90 models).
- Migrations are in `backend/prisma/migrations/`. Apply them with `npx prisma migrate deploy`. A fresh database starts from the baseline migration and every later one applies on top.
- A local Docker Compose file for development is [`backend/docker-compose.db.yml`](backend/docker-compose.db.yml). It binds to `127.0.0.1` only and reads the password from a file, not from the environment.
- Disaster recovery: [`backend/docs/postgres-dr-promotion.md`](backend/docs/postgres-dr-promotion.md) describes promoting a verified backup into the live database. The web application never replaces the production database itself.

---

## Backend layout

`backend/src/` is a NestJS application. Each folder is a module:

| Area | Modules |
|---|---|
| **Accounts and access** | `auth`, `users`, `roles`, `audit`, `company`, `branding` |
| **Devices and agents** | `agents`, `devices`, `provisioning`, `customers`, `compat` |
| **Remote tools** | `remote-console`, `remote-shell`, `remote-desktop`, `realtime`, `ws` |
| **Monitoring and automation** | `checks`, `alerts`, `automation`, `jobs`, `patches`, `maintenance`, `notifications` |
| **Service desk** | `tickets`, `imap`, `smtp`, `support-legal` |
| **Documentation** | `itdocs` |
| **Billing and reporting** | `billing`, `reports` |
| **Platform** | `backups`, `storage`, `health`, `localization`, `admin`, `common` |

Notable files: `main.ts` (startup, validates the authentication root of trust before listening, optional Swagger), `app.module.ts`, `common/job-signer.service.ts` (signs everything agents act on), `auth/permissions.guard.ts` with `auth/require-perm.decorator.ts` (role and permission checks on routes).

Other folders: `backend/test/` (API checks), `backend/scripts/` (backup decryption and database promotion tools), `backend/tools/` (a sanity-check script), `backend/public/` (served static files).

---

## Agents

### Windows agent

A .NET 8 Windows service running as **LocalSystem**, because scripts and patching need it.

- **Enrols** with an install key, receives an agent token (stored hashed by the backend), and sends heartbeats, inventory and software lists.
- **Runs only signed jobs.** The backend signs each job with the key at `JOB_SIGNING_KEY_FILE` and the agent verifies it against the server's public key in `appsettings.json`. Unsigned or badly signed jobs are refused.
- **Checks and scripts, patching, remote shell, file browsing and Remote Console** are all served by the same service.
- **Updates itself** from the packages the backend serves; see [`docs/agent-updates.md`](docs/agent-updates.md).
- Secrets at rest are protected with machine-level DPAPI. Optional TLS certificate pinning is available (`PinnedSpkiSha256`).
- Logs: `%ProgramData%\AdgRmm\Logs\agent-*.log`. Config: `%ProgramData%\AdgRmm\agent.config.json`.

More detail, including the agent's REST and WebSocket endpoints, is in [`agents/windows/AdgRmm.Agent/README.md`](agents/windows/AdgRmm.Agent/README.md).

### Windows capture helper

Started by the agent in whichever session is on screen (a signed-in session, or the sign-in screen), so a technician can see and use the lock screen and approve UAC prompts. It captures the screen with **Desktop Duplication**, falling back to the older screen copy when that is unavailable, injects mouse and keyboard input, tracks the cursor, syncs the clipboard and runs the chat window. See [`docs/remote-console-unattended.md`](docs/remote-console-unattended.md).

### Linux agent

A .NET 8 agent with its own check probes and update platform. It is installed from the dashboard's installer command, and `agents/linux/scripts/uninstall.sh` removes it.

### Installing an agent

In the dashboard open **Customers → Reusable Installer**, create a key, and run the command it shows in an elevated shell on the device.

---

## Remote Console

Browser-based remote control of a Windows device, over WebRTC.

- **Video:** VP8 only. The agent's own encoder is tuned for desktop content, with its own packet pacing, resend and bitrate control that follows the network.
- **Input and extras:** mouse and keyboard (the pointer is drawn in the browser), scrolling, automatic copy and paste, Ctrl+Alt+Del, a chat window, multi-monitor, and a pop-out window.
- **Unattended:** works with nobody signed in. Signing in still needs a password, and nothing a user types into the chat window runs as SYSTEM. Full detail in [`docs/remote-console-unattended.md`](docs/remote-console-unattended.md).
- **Across networks:** a TURN relay carries the video when a direct connection is blocked. Choose `cloudflare` (no server needed, billed per GB), `builtin` (your own coturn, in `deploy/turn/`) or `none`. See [`docs/remote-console-turn.md`](docs/remote-console-turn.md). Each session gets its own short-lived relay credentials.
- **Diagnostics:** the console shows a live line with the route, round trip, capture, encode and queue times, frame rate, bitrate and loss, which is the first thing to read when a session feels slow.
- Session starts are **signed by the backend and verified by the agent**.

---

## Releasing an agent version

The version number is compiled into the agent and written to each package's `version.json`. When cutting a release, raise it in all of these together:

- `agents/build-packages.ps1` (the `-Version` default)
- `agents/windows/AdgRmm.Agent/AdgRmm.Agent.csproj`
- `agents/linux/AdgRmm.Agent.Linux/AdgRmm.Agent.Linux.csproj`
- `agents/tools/compare-build.ps1`

Then either build locally:

```powershell
pwsh -NoProfile -File agents/build-packages.ps1 -OutDir <folder> -Version 1.3.13
```

or let CI build a clean, reproducible copy: push a tag named `agent-build-<commit>` and the **Build agent packages** workflow produces an `agent-packages` artifact.

Copy the result into the backend's `AGENT_PKG_DIR`, keeping this layout, and **include the `version.json` files**:

```
windows/adgrmm-agent-windows.zip
windows/version.json
linux/adgrmm-agent-linux-x64.tar.gz
linux/version.json
```

`version.json` holds each package's SHA-256, and the backend offers nothing while the two disagree, so an agent is never offered a half-copied release. Agents poll for updates; nothing is pushed.

To stop a rollout, set `AGENT_UPDATES_ENABLED=false` and restart the backend, or delete one OS's `version.json` to withdraw a single bad release. Agents already updated are not rolled back. Details in [`docs/agent-updates.md`](docs/agent-updates.md).

---

## Security model

- **Sessions and sign-in:** cookie-based sessions, optional two-factor sign-in with trusted devices, role-based permissions on routes, personal access tokens, and rate limiting on authentication.
- **Agent tokens** are stored hashed. Rolling back past the change that introduced hashing means every agent must run the installer again.
- **Signed jobs:** every script, file job, update and remote session start that an agent accepts is signed by the backend.
- **Two key files live outside the database** and are in no backup the backend makes. Back them up separately, somewhere that does not also hold the database and its backups:

  | File | Variable | If lost without a copy |
  |---|---|---|
  | Job-signing key | `JOB_SIGNING_KEY_FILE` | Every agent refuses the server until the installer is run on it again |
  | Data-encryption key | `DATA_ENCRYPTION_KEY_FILE` | Stored credentials must be re-entered and **encrypted backup archives can never be read** |

  Keep them readable only by the backend's user. See [`docs/security-keys.md`](docs/security-keys.md).
- **Encrypted at rest:** stored SMTP, IMAP and POP passwords, storage connection secrets, DKIM private keys, and encrypted backup archives use the data key.
- **Clock skew:** an agent whose clock is more than about 15 minutes off may have signed jobs refused.

Report security problems privately to the maintainers rather than in a public issue.

---

## Testing and CI

- `backend/test/*.e2e.cjs` are end-to-end API checks (alerts, billing, checks and scripts, IT documentation, reports, audit events, secrets at rest, security lockdown and more) plus protocol and encryption checks. They run against a real PostgreSQL.
- `agents/tests/` holds agent-core tests, a session-start check, and update-apply tests for Windows and Linux.
- There are no browser or unit-test suites yet.

GitHub Actions workflows in `.github/workflows/`:

| Workflow | Triggered by | What it does |
|---|---|---|
| **Backend tests** | Manual, or a tag named `backend-test-*` | Starts an empty PostgreSQL 16, applies every migration, and runs the backend's flows against it |
| **Build agent packages** | Manual, or a tag named `agent-build-*` | Builds the Windows and Linux agent packages from a clean checkout |
| **Agent install** | Manual | Does real installs on clean Windows and Ubuntu runners. Rerun it after changing agents, provisioning or backend startup |

---

## Deploying

A typical production layout runs the backend as a systemd service next to PostgreSQL, behind a reverse proxy, with the dashboard on its own host:

1. Build beside the live code (`npm ci`, `prisma generate`, `tsc`), then swap the build in.
2. Apply migrations with `prisma migrate deploy`.
3. Start the service, wait for `/healthz`, and run quick checks on the main routes.
4. Keep the previous build so a failed deploy can be rolled back automatically.

Things to know:

- Set `AGENT_PKG_DIR` and `PUBLIC_API_BASE_URL` for the service (a systemd drop-in works well), plus the two key-file paths and any TURN settings.
- Run git as the service's own user on the server, or you will hit a "dubious ownership" error.
- Keep the JSON body parser wrapped in `main.ts`. Nest skips its global parser if it finds a middleware named `jsonParser`, which breaks every JSON route including sign-in.
- Check `docs/security-keys.md` before the first production start.

---

## Documentation index

| Document | Covers |
|---|---|
| [`docs/roadmap/ROADMAP.md`](docs/roadmap/ROADMAP.md) | The plan, in phases, with a status mark on every step |
| [`docs/roadmap/FEATURE-STATUS.md`](docs/roadmap/FEATURE-STATUS.md) | What exists today, reviewed from the code |
| [`docs/agent-updates.md`](docs/agent-updates.md) | How agents update themselves, and how to release or stop a rollout |
| [`docs/remote-console-turn.md`](docs/remote-console-turn.md) | Choosing and setting up the relay |
| [`docs/remote-console-unattended.md`](docs/remote-console-unattended.md) | How Remote Console works at the sign-in screen, and its security |
| [`docs/security-keys.md`](docs/security-keys.md) | The two key files and how to back them up |
| [`backend/docs/postgres-dr-promotion.md`](backend/docs/postgres-dr-promotion.md) | Promoting a database backup |
| [`agents/windows/AdgRmm.Agent/README.md`](agents/windows/AdgRmm.Agent/README.md) | The Windows agent in detail |

---

## Contributing notes

- Branch from the branch that is actually deployed, not `main`, until the deployed work is merged. Check the current deployed branch and commit before basing changes on one.
- Keep each commit focused. Stage specific files rather than everything, because working folders often hold diagnostic dumps and local files that must not be committed.
- Update the mark on the matching step in `docs/roadmap/ROADMAP.md` when a step's status changes.
- Run the relevant `backend/test` checks, or the **Backend tests** workflow, before deploying.

## License

ADG RMM is open source under the [GNU Affero General Public License v3.0](LICENSE).
If you run a modified version as a network service, the AGPL requires you to offer
its source to the people who use it. Contributions are welcome under the same
license; see [CONTRIBUTING.md](CONTRIBUTING.md).
