# Installing ADG RMM

One script installs ADG RMM on a server and walks you through the first setup.

```bash
curl -fsSL https://github.com/adgsaas/adgrmm/releases/latest/download/install.sh | sudo bash
```

If the repository is private, set a token that can read it first: `export GITHUB_TOKEN=...` (use `sudo -E` so it
reaches the script). If you host the release files yourself, set `ADG_RELEASE_BASE=https://your.server/path`.

## What you need

- A server with **Ubuntu 22.04, 24.04, 26.04 or Debian 12**, 64-bit Intel/AMD, 2 GB of memory or more, 6 GB of free disk.
- Root access (`sudo`).
- A **domain name** for ADG RMM (for example `rmm.example.com`) pointing at the server. For the built-in HTTPS, ports
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

Choose "I already have a reverse proxy". ADG RMM listens on one port (8080 by default). In the proxy, add a host for your
domain that forwards to `http://<this server>:8080`, **turn Websockets Support on**, and request a certificate. One entry is
enough: the installer's small router sends WebSockets to the API and everything else to the web app. For the customer
portal, add a second proxy host with the same target.

## Afterwards

```bash
sudo bash /opt/adgrmm/install.sh status            # is everything healthy?
sudo bash /opt/adgrmm/install.sh status --logs     # also writes a support bundle (secrets blanked out)
sudo bash /opt/adgrmm/install.sh upgrade           # latest release; backs up the database first, rolls back on failure
sudo bash /opt/adgrmm/install.sh upgrade --version 1.4.0
sudo bash /opt/adgrmm/install.sh reconfigure       # new web address or portal address
sudo bash /opt/adgrmm/install.sh uninstall         # you choose whether to keep your data
```

Everything lives in `/opt/adgrmm`:

| Path | What |
|---|---|
| `install.conf` | the answers and generated secrets (readable by root only) |
| `config/adgrmm.env` | the API's settings |
| `secrets/` | the **data encryption key** and **job signing key**. Back these up somewhere else. |
| `data/` | uploaded files, settings, and (Docker with a local database) the database files |
| `backups/` | database backups taken before each upgrade (the last five are kept) |
| `releases/<version>` and `current` | the installed program files |

Without the two keys, stored passwords and encrypted backups cannot be read and agents have to be reinstalled
(see `docs/security-keys.md`).

## Things worth knowing

- ADG RMM's sign-in cookie is marked secure, so use it over **HTTPS**. The plain-HTTP option exists only for a quick look.
- A new customer's people (the People tab) are invited to the portal automatically once the portal is on.
- Changing the web address (or the portal address) later: `sudo bash /opt/adgrmm/install.sh reconfigure`. It reinstalls the
  same version with the new names and, with the built-in HTTPS, updates Caddy so it gets certificates for them. If you
  change the portal address in Administration > Client Portal, run `reconfigure` afterwards so the built-in HTTPS knows the
  name (with your own proxy, just add the name there).
- The agents ship inside the release when the bundle was built with `--agents` (see below). Without them the first-customer
  step explains how to add them.

# Building a release (for the ADG RMM team)

The installer downloads a **release bundle** from GitHub Releases: `adgrmm-linux-x64.tar.gz`, `SHA256SUMS`,
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

## Several installs on one server (Docker mode)

A hosting provider can run many separate installs on one server. Give each one its own folder, compose project name and local API port, and its own proxy port:

```bash
sudo ADG_HOME=/srv/tenants/acme ADG_PROJECT=acme ADG_API_PORT=19001 bash install.sh
```

- `ADG_HOME` is the install folder (default `/opt/adgrmm`). Once installed, the `install.sh` inside that folder manages that install by itself, so `status`, `upgrade` and `uninstall` work from any directory.
- `ADG_PROJECT` is the Docker Compose project name (default `adgrmm`). Use lower-case letters, digits, `-` and `_`.
- `ADG_API_PORT` is the API's port on this server's loopback address (default `3001`). Each install needs a different one, and it must differ from that install's proxy port.

Each install has its own database, keys and containers. The packaged images are shared between installs of the same version. The default single install is unchanged.
