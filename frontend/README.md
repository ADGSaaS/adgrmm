# RemoteIQ Frontend

The web dashboard for **RemoteIQ**, an all-in-one platform for managed service providers (MSPs): remote monitoring and management (RMM), a service desk, documentation, billing and client-facing tools.

This folder is the dashboard. The API, the database, the agents and the operations documentation live in the other folders of this repository (`backend/`, `agents/`, `docs/`), and the dashboard cannot do anything useful without a running backend.

> **Status:** under active development and not yet released. What works, what is untested and what is planned is tracked in `docs/roadmap/ROADMAP.md` and `docs/roadmap/FEATURE-STATUS.md`. Treat those as the source of truth rather than this file.

---

## Contents

- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How it talks to the backend](#how-it-talks-to-the-backend)
- [Project layout](#project-layout)
- [Pages](#pages)
- [Remote tools in the browser](#remote-tools-in-the-browser)
- [Authentication and permissions](#authentication-and-permissions)
- [Building and running in production](#building-and-running-in-production)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Troubleshooting](#troubleshooting)
- [Contributing notes](#contributing-notes)

---

## Tech stack

| Area | What is used |
|---|---|
| Framework | **Next.js 16** (App Router) and **React 19**, in TypeScript |
| Styling | Tailwind CSS 3, `next-themes` for light and dark, `class-variance-authority`, `clsx`, `tailwind-merge` |
| Components | Radix UI primitives with shadcn-style wrappers in `components/ui/` (configured by `components.json`), Lucide icons, Sonner toasts |
| Forms | React Hook Form with Zod |
| Data display | TanStack Virtual for long tables, Recharts for charts, `react-grid-layout` for dashboards, dnd-kit for drag and drop, ExcelJS for spreadsheet export |
| Remote shell | xterm.js with the fit addon |

---

## Quick start

### Prerequisites

- Node.js and npm (the repository uses `package-lock.json`)
- A running RemoteIQ backend, by default at `http://localhost:3001`

### Run it

```bash
npm install
# create .env.local first; see Configuration below
npm run dev                                             # http://localhost:3000
```

Open `http://localhost:3000`. You will be sent to `/login` until you sign in.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build (port 3000 by default) |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm run lint` | `eslint .` (flat config in `eslint.config.mjs`) |

Run `npm run typecheck` and `npm run build` before deploying. There is no browser or unit test suite yet.

---

## Configuration

Settings are environment variables, normally in `.env.local` (never commit it).

| Variable | Used for | Default |
|---|---|---|
| `NEXT_PUBLIC_API_BASE` | The backend's address. Used by the `/api` and `/static` rewrites in `next.config.mjs` and by the proxy's session check | `http://localhost:3001` for the rewrites; the page's own origin for the proxy |
| `NEXT_PUBLIC_WS_BASE` | WebSocket address used by the browser | `ws://localhost:3001/ws` |
| `NEXT_PUBLIC_BACKEND_URL`, `BACKEND_URL` | Backend address used by a few server-side and client helpers | |
| `NEXT_PUBLIC_AVATAR_MAX_MB` | Largest avatar upload the form accepts | |
| `NEXT_PUBLIC_PASSWORD_MIN_LEN` | Minimum password length the forms enforce | |
| `REMOTEIQ_API_KEY` | Server-side API key for dashboard-only API routes | |

`NEXT_PUBLIC_*` values are compiled into the browser bundle at build time, so change them **before** `npm run build`, not after.

A local setup against a backend on the same machine usually needs only:

```bash
NEXT_PUBLIC_API_BASE=http://localhost:3001
NEXT_PUBLIC_WS_BASE=ws://localhost:3001/ws
```

---

## How it talks to the backend

- **REST:** `next.config.mjs` rewrites `/api/*` and `/static/*` to the backend, so the browser only ever talks to the dashboard's own origin and the sign-in cookie stays first-party. Typed API helpers live in `lib/` (`api.ts`, `tickets-api.ts`, `billing-api.ts`, `alerts-api.ts`, `itdocs-api.ts`, `account-api.ts`, `device-files-api.ts`).
- **WebSocket:** `lib/ws.ts` opens the live connection used for device status, job output, the remote shell and Remote Console signalling.
- **Hooks:** data hooks such as `use-devices`, `use-device`, `use-customers`, `use-tickets`, `use-me` and `use-job-run` wrap the API calls for the pages.

The backend's origin and cookie settings must match where this dashboard is served (see the backend's `FRONTEND_ORIGINS` and `AUTH_COOKIE_*` settings).

---

## Project layout

```
app/                      Next.js routes (App Router)
  (auth)/login            Sign-in page
  (dashboard)/            The signed-in app, wrapped by dashboard-shell
    devices/[deviceId]    One device: tabs for checks, patches, software, files, shell, remote
    tickets, tickets/[id] Service desk
    alerts, automation, billing, reports, docs
  account/                The signed-in user's own settings
  administration/         Admin tabs (permission-gated)
  customers/              Customers, sites and the reusable agent installer
  pay/[token]             Public page customers open from an emailed link
  api/                    Dashboard-only server routes
components/               Shared components
  ui/                     Base primitives (buttons, dialogs, tables, tabs, ...)
  billing/, itdocs/       Feature-specific components
  remote-console-panel.tsx, remote-shell-panel.tsx, remote-desktop-panel.tsx
lib/                      API clients, hooks, permission helpers, utilities
proxy.ts                  Sign-in redirect and the Administration gate
next.config.mjs           Rewrites to the backend
```

---

## Pages

| Route | What it is |
|---|---|
| `/login` | Sign in, including two-factor |
| `/` (dashboard) | Devices with a customers tree, filters and a device table |
| `/devices/[deviceId]` | A single device: checks and alerts, patches, software, file browser, remote shell and Remote Console |
| `/tickets`, `/tickets/[id]` | Service desk list and ticket detail |
| `/alerts` | Alerts |
| `/automation` | Scripts and automation |
| `/billing` | Billing documents and related tabs |
| `/reports` | Reporting |
| `/docs` | IT documentation |
| `/customers` | Customers, sites and the reusable installer that creates agent install commands |
| `/account` | Profile, password, two-factor and personal access tokens |
| `/administration` | Administration tabs; only reachable with the right permission |
| `/pay/[token]` | Public payment page opened from an emailed link, no account needed |

Which pages are fully connected to the backend and which are placeholders is tracked in the backend's `FEATURE-STATUS.md`.

---

## Remote tools in the browser

- **Remote Console** (`components/remote-console-panel.tsx`): browser-based remote control of a Windows device over WebRTC. It connects in the page or in a pop-out window, draws the pointer locally so it follows your mouse without delay, supports scrolling, automatic copy and paste, Ctrl+Alt+Del, chat and multiple monitors, and shows a live status line (route, round trip, capture, encode, queue, decode, frame rate, bitrate, loss). That line is the first thing to read when a session feels slow, and it names the capture method in use.
- **Remote shell** (`components/remote-shell-panel.tsx`): a terminal using xterm.js.
- **File browser** (`components/file-browser-tab.tsx`): browse and move files on a device.

Remote Console needs the backend's relay settings if devices and technicians are on different networks. Append `?relay=1` to the console URL to force the relay when testing.

---

## Authentication and permissions

- **Proxy** (`proxy.ts`, Next 16's name for middleware) redirects any request without the `auth_token` cookie to `/login?next=...`. Public paths are `/login`, static assets and `/pay/*`.
- **Administration** is hard-gated: the proxy asks the backend (`/api/auth/me`) before letting a request through.
- **Permissions** are checked in the interface too (`lib/permissions.ts`, `components/perm-gate.tsx`, `components/no-permission.tsx`), but the backend enforces them. Hiding a button is a convenience, not security.
- Sign-in supports two-factor, trusted devices and sessions managed on the backend.

---

## Building and running in production

```bash
npm ci
npm run typecheck
npm run build
npm start          # listens on port 3000
```

Typical setup: run `npm start` as a service (for example a systemd unit) behind a reverse proxy that terminates TLS and forwards to port 3000. The dashboard then proxies `/api` to the backend itself, so the proxy only needs to know about this one upstream for the dashboard's hostname.

Remember that `NEXT_PUBLIC_*` values are baked in at build time.

---

## Behind a reverse proxy

- Forward the `Host`, `X-Forwarded-Proto` and `X-Forwarded-For` headers, and enable WebSocket upgrade support.
- **Do not add a strict Content-Security-Policy at the proxy.** Next.js relies on inline scripts and styles to start up, so a policy of `script-src 'self'; style-src 'self'` blanks every page and fills the browser console with "Executing inline script violates the following Content Security Policy directive" errors. If you need a CSP, it has to allow the app's inline scripts (nonces or hashes) and the backend's address in `connect-src`.
- Keep a single reverse proxy hop where possible, so the sign-in cookie and the forwarded protocol stay consistent.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Blank page, console full of Content Security Policy errors | A proxy or host is adding a strict CSP header; see above |
| Redirect loop to `/login` | The auth cookie is not being set or sent: check the backend's `AUTH_COOKIE_*` and `FRONTEND_ORIGINS`, and that you reach the dashboard on the origin the backend expects |
| API calls fail but pages load | `NEXT_PUBLIC_API_BASE` points to the wrong backend, or was changed without rebuilding |
| Live updates or the shell never connect | `NEXT_PUBLIC_WS_BASE` is wrong, or the proxy does not forward WebSocket upgrades |
| `ERR_NAME_NOT_RESOLVED` for the site, while the server is fine | A DNS problem on the network you are browsing from, not the dashboard. Try another network or turn on secure DNS in the browser |
| Remote Console connects but is slow | Read the status line: high capture or encode time points at the device, high queue time at the network, `route=relay` means the relay is carrying the video |

---

## Contributing notes

- Branch from the branch that is actually deployed rather than `main` until the deployed work is merged.
- Keep commits focused and **stage specific paths**. Generated and local files must stay out of commits: `.env.local`, `.next/`, `next-env.d.ts`, `tsconfig.tsbuildinfo`.
- Run `npm run typecheck` and `npm run build` before pushing.
- When a feature's status changes, update the matching step in the backend's roadmap.

## License

No license has been chosen yet. An open source release is planned; until then the code is private and all rights are reserved.
