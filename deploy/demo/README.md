# The public demo

The demo is an ordinary ADG RMM install (docker mode) started with `DEMO_MODE=1`. The same release is used; nothing is built separately.

What demo mode does (see `backend/src/demo-mode/`):

- **Rules.** The API refuses anything that could reach outside (email, webhooks, URL checks, scans, uploads, running scripts on devices), anything that really adds a device (agent enrollment) and anything that would show how the real server is set up. Reads of ordinary screens, and edits that only change the demo's own database (tickets, customers, notes, tags, invoices, KB and so on), are allowed. Anything not listed is refused. The list is in `demo-mode.rules.ts` and tested by `backend/test/demo-mode-rules.cjs`.
- **Every page is visible.** All Administration tabs and the installer screens can be opened. The ones that would normally show the server itself (System, Diagnostics, Database, Storage, Backups, Migrations, Secrets & Environment, Sessions, SMTP, Support mailbox, SSO, Integrations and webhooks, Agents & endpoints, Install keys, Helpdesk import, Import / Export, Client portal, Demo data) show made-up sample data (fake hosts ending in `.invalid`, sample backups, migrations, sessions, install keys and so on) from `backend/src/demo-mode/demo-fixtures.ts`. The gate answers those routes itself before any real controller runs, so no real value (environment, database address, paths, hosts, keys, mail or storage logins) can reach a visitor. Feature Flags, Auto repair and the asset provider card are plain rows in the demo database and are read as they are. Saving, testing, running, deleting or downloading anything on those pages is refused with the friendly "switched off in the demo" message.
- **Add device and installers.** The New Endpoint and Reusable installer screens work for show: creating an install key or an installer returns a clearly fake key, a command such as `powershell -NoProfile -Command "iex (irm 'https://demo.invalid/install/DEMO-ONLY')"`, and a download that is a small text file saying it is a demo. Nothing is written to the database and no real key, token, script or package is made or served. Agents can never enroll (`/api/agent/*` stays refused), so no device can join the demo.
- **Sample data.** At every start the database is wiped back to the clean install and filled with fresh sample data (`backend/src/demo/`).
- **Way back.** A slim bar across the top of the demo links to `DEMO_BACK_URL` (the website's demos page).
- **Entering.** `POST /api/demo/enter` signs the visitor in as the demo user (`DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD`). The login page shows an "Enter the demo" button.
- **Leaving.** Open pages send `POST /api/demo/ping` every 10 seconds. After `DEMO_IDLE_SECONDS` (default 60) without one, and if anything was changed (or the sample data has aged), the API exits; Docker restarts it and the start-up step puts back fresh data. Restarting also clears every cache.

Everything sensitive is outside the dashboard: the JWT secret, data key, database password and demo user password live only in the server's config files. The demo has no mail server, storage, SSO or integrations configured (the pages for them show sample data), and the database, API and web app run on a Docker network with no route to the internet (`docker-compose.demo.yml`).

## Setting it up

1. Install ADG RMM in docker mode with the installer, behind your own proxy (TLS option 2), using the demo user as the administrator.
2. Write `/opt/adgrmm/config/demo.env`:
   ```
   DEMO_MODE=1
   DEMO_USER_EMAIL=<the administrator's email>
   DEMO_USER_PASSWORD=<the administrator's password>
   DEMO_IDLE_SECONDS=60
   DEMO_BACK_URL=https://adgsaas.com/demos/
   ```
3. Copy `docker-compose.demo.yml` next to the installer's compose file and start with both files (see the header of that file).
4. Point your proxy at the edge port. Turn websockets on.

The first start with `DEMO_MODE=1` saves the clean install as `demo-baseline.json` in the data folder and uses it for every later reset. To rebuild from scratch, delete that file and the database volume and install again.

`install.sh upgrade` rewrites the installer's compose file but not this one, so after upgrading start the stack with both files again.
