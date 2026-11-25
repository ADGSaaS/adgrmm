# Installing RemoteIQ

One script installs RemoteIQ on a server and walks you through the first setup.

```bash
curl -fsSL https://github.com/RemoteIQ-RMM/RemoteIQ-RMM/releases/latest/download/install.sh | sudo bash
```

If the repository is private, set a token that can read it first: `export GITHUB_TOKEN=...` (use `sudo -E` so it
reaches the script). If you host the release files yourself, set `RIQ_RELEASE_BASE=https://your.server/path`.

## What you need

- A server with **Ubuntu 22.04, Ubuntu 24.04 or Debian 12**, 64-bit Intel/AMD, 2 GB of memory or more, 6 GB of free disk.
- Root access (`sudo`).
- A **domain name** for RemoteIQ (for example `rmm.example.com`) pointing at the server. For the built-in HTTPS, ports
  **80 and 443** must be free and reachable from the internet.
- Optional: a second name for the customer portal (`portal.example.com`), and the details of an SMTP mailbox.

## What it asks

1. **How to run**: Docker (containers) or native (system services).
2. **Web address and HTTPS**: Caddy with a free Let's Encrypt certificate (it handles everything), your own reverse
   proxy such as Nginx Proxy Manager (the installer just listens on one port), or a self-signed certificate for testing.
3. **Database**: PostgreSQL 16 installed for you, or an existing PostgreSQL server.
4. **Company name and administrator** (name, email, password).
5. **Email sending (SMTP)**, optional, with a test email.
6. **Customer portal**, optional.
7. **A first customer and site**, optional, and it prints the one-line command that installs the agent on a computer.

It then downloads the release, checks its checksum, installs, starts everything, creates your administrator and applies
the settings you chose. It can be run again if it stops part way; it keeps your earlier answers.

## Behind your own reverse proxy (Nginx Proxy Manager)

Choose "I already have a reverse proxy". RemoteIQ listens on one port (8080 by default). In the proxy, add a host for your
domain that forwards to `http://<this server>:8080`, **turn Websockets Support on**, and request a certificate. One entry is
enough: the installer's small router sends WebSockets to the API and everything else to the web app. For the customer
portal, add a second proxy host with the same target.

## Afterwards

```bash
sudo bash /opt/remoteiq/install.sh status            # is everything healthy?
sudo bash /opt/remoteiq/install.sh status --logs     # also writes a support bundle (secrets blanked out)
sudo bash /opt/remoteiq/install.sh upgrade           # latest release; backs up the database first, rolls back on failure
sudo bash /opt/remoteiq/install.sh upgrade --version 1.4.0
sudo bash /opt/remoteiq/install.sh reconfigure       # new web address or portal address
sudo bash /opt/remoteiq/install.sh uninstall         # you choose whether to keep your data
```

Everything lives in `/opt/remoteiq`:

| Path | What |
|---|---|
| `install.conf` | the answers and generated secrets (readable by root only) |
| `config/remoteiq.env` | the API's settings |
| `secrets/` | the **data encryption key** and **job signing key**. Back these up somewhere else. |
| `data/` | uploaded files, settings, and (Docker with a local database) the database files |
| `backups/` | database backups taken before each upgrade (the last five are kept) |
| `releases/<version>` and `current` | the installed program files |

Without the two keys, stored passwords and encrypted backups cannot be read and agents have to be reinstalled
(see `docs/security-keys.md`).

## Things worth knowing

- RemoteIQ's sign-in cookie is marked secure, so use it over **HTTPS**. The plain-HTTP option exists only for a quick look.
- A new customer's people (the People tab) are invited to the portal automatically once the portal is on.
- Changing the web address (or the portal address) later: `sudo bash /opt/remoteiq/install.sh reconfigure`. It reinstalls the
  same version with the new names and, with the built-in HTTPS, updates Caddy so it gets certificates for them. If you
  change the portal address in Administration > Client Portal, run `reconfigure` afterwards so the built-in HTTPS knows the
  name (with your own proxy, just add the name there).
- The agents ship inside the release when the bundle was built with `--agents` (see below). Without them the first-customer
  step explains how to add them.

# Building a release (for the RemoteIQ team)

The installer downloads a **release bundle** from GitHub Releases: `remoteiq-linux-x64.tar.gz`, `SHA256SUMS`,
`version.txt` and `install.sh`.

```bash
# On Linux, or WSL, from the backend repository, with the web app repository next to it:
install/build-release.sh --version 1.4.0 --agents ./agent-packages --publish
```

`--agents` is a folder holding `windows/` and `linux/` (each with its package and `version.json`), produced by
`agents/build-packages.ps1` or the agent build workflow. `--publish` creates the GitHub release with the GitHub CLI.

Without Linux: run the same script in Docker (the command is in the header of `build-release.sh`), or use the
**Release** workflow in `.github/workflows/release.yml`, which does it on GitHub and needs a `FRONTEND_REPO_TOKEN`
secret that can read the web app repository.

The web app is built once with placeholder addresses; `install.sh` swaps in the real address on each server, so one
bundle serves every installation.
