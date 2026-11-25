# RemoteIQ Feature Status

What exists today, from a review of the code on 2026-11-06. The plan for what comes next is in [ROADMAP.md](ROADMAP.md).

Marks are the same as the roadmap: ✅ Done · 🧪 Needs testing · 🟡 Partial · 🔴 Broken or fake · ⬜ Not started.

"Done" is deliberately strict. It means confirmed working on a real machine or in real use, not only that the code exists.

## Summary

| Area | Status | In short |
|---|---|---|
| Agent install and updates | ✅ | Works on real Windows and Linux machines. New Windows installs are blocked by Defender for now |
| Remote tools | 🟡 | Shell and files have worked. Remote Console is currently broken on 1.3.4 |
| Monitoring and alerts | 🔴 | Agents collect data, but no alerts exist and no one can be notified |
| Patching and software | 🟡 | Scan, manual install and inventory. No policy |
| Automation | 🟡 | One-off scripts only |
| Tickets | 🟡 | Solid basics. No SLAs, time tracking or routing |
| Billing | 🔴 | Screens only |
| Client portal | 🧪 | Built: customers sign in on their own address (tickets, devices, invoices, reports). Not used by a real customer yet |
| Documentation and passwords | ⬜ | Nothing yet |
| Reporting | 🟡 | A dashboard only |
| Administration | 🟡 | 11 tabs are connected. The others are hidden until real |
| Accounts and security | 🟡 | Sign-in, 2FA, roles and sessions are strong. Audit log and SSO (OpenID Connect) are built, SSO not yet tried with a real provider |

## Agents

| Feature | Windows | Linux | Notes |
|---|---|---|---|
| Install by script | ✅ | ✅ | Windows is blocked by default Defender. See "Known problems" |
| Enrollment and device identity | ✅ | ✅ | |
| Signed jobs (agents only run signed commands) | ✅ | ✅ | Device clock must be within 15 minutes |
| Self-update with rollback | ✅ | ✅ | Rollback hasn't been needed on a real machine yet |
| System inventory | ✅ | 🟡 | Linux reports less |
| Software inventory | 🧪 | 🧪 | |
| Scripts | 🧪 | 🧪 | PowerShell and bash |
| File browser | ✅ | 🧪 | |
| Remote shell | 🧪 | 🧪 | |
| Patch scan and install | 🧪 | ⬜ | Patching is Windows only in the dashboard |
| Checks: CPU, disk, memory, ping, port, process, service, agent | 🧪 | 🧪 | No screen to create them |
| Remote Console | 🔴 | ⬜ | Worked on 1.2.3, black on 1.3.4 |
| macOS | ⬜ | | No macOS agent |

## Remote Console (Windows)

| Feature | Status | Notes |
|---|---|---|
| Video and input | 🔴 | Confirmed on 1.2.3. Black screen on 1.3.4 |
| Works across networks (relay via TURN) | 🧪 | Partner confirmed video and control on 1.2.3 |
| Packet recovery and bitrate control | 🧪 | Proven in a simulated network only |
| One technician at a time | 🧪 | |
| Connect in page, pop-out | 🧪 | |
| Sign-in, lock and UAC screens | 🧪 | Runs as SYSTEM. No picture confirmed yet |
| Ctrl+Alt+Del, chat, clipboard, multi-monitor | 🧪 | |
| Notice to the person at the device | ⬜ | |
| Session recording | ⬜ | |

## Monitoring and automation

| Feature | Status | Notes |
|---|---|---|
| Check results on the device page | 🧪 | |
| Create and assign checks | 🔴 | Service methods throw Not Implemented, with no screen |
| Check profiles | 🟡 | Tables only |
| Alerts | 🔴 | Service throws Not Implemented |
| Notifications | 🔴 | Empty module |
| Run a script on demand | 🧪 | |
| Script library and scheduling | 🟡 | Tables only |

## Tickets

| Feature | Status | Notes |
|---|---|---|
| Create, list, update, detail | 🟡 | Built. Needs a run-through in real use |
| Replies, notes, attachments, links, history | 🟡 | Same |
| Canned responses and variables | 🟡 | Same |
| Incoming email (IMAP) | 🟡 | Poller exists, not checked end to end |
| Outgoing email and DKIM | 🟡 | Same |
| Contacts | 🟡 | Table only |
| SLAs, time tracking, routing, dispatch | ⬜ | |

## Customers and dashboard

| Feature | Status | Notes |
|---|---|---|
| Customers and sites | 🧪 | Create, delete, move devices |
| Reusable installers | ✅ | |
| Customer sidebar and global search | 🧪 | New, tested on mock data |
| Device list, filters, saved views | 🧪 | |
| Customisable dashboard | ✅ | |
| Works on phones | 🧪 | |

## Administration tabs

### Connected to the backend

| Tab | Status |
|---|---|
| Users | 🧪 |
| Roles | 🧪 |
| Company | 🧪 |
| Branding | 🧪 |
| Localization | 🧪 |
| Email (SMTP, IMAP, DKIM) | 🧪 |
| Storage | 🧪 |
| Backups | 🧪 |
| Database | 🧪 |
| Support and legal | 🧪 |
| Ticketing | 🧪 |
| API (hidden: it showed a made-up key) | 🔴 |

### Not connected to anything

These make no API calls. Some show a "saved" message, and nothing is saved anywhere.

| Tab | Status | Roadmap step |
|---|---|---|
| Audit Logs | 🔴 | 2.2 |
| Notifications | 🔴 | 2.3 |
| SLA | 🔴 | 2.4 |
| Security Policies | 🔴 | 2.5 |
| SSO | 🧪 | 2.6 |
| Sessions | 🔴 | 2.7 |
| Agents | 🔴 | 2.8 |
| Secrets | 🔴 | 2.9 |
| Roles Matrix | 🔴 | 2.10 |
| Integrations | 🔴 | 2.11 |
| Custom Fields | 🟡 | 2.12 |
| Templates | 🔴 | 2.13 |
| Import and Export | 🔴 | 2.14 |
| Flags | 🔴 | 2.15 |
| System | 🔴 | 2.15 |
| Migrations | 🔴 | 2.15 |
| Compliance | 🔴 | 2.15 |
| Billing | 🔴 | 2.16 |
| Invoices | 🔴 | 2.16 |
| Subscription | 🔴 | 2.16 |
| Reports | 🔴 | 2.16 |
| Workflows | 🔴 | 2.16 |
| Client Portal | 🧪 | 2.16 |

## Accounts and security

| Feature | Status | Notes |
|---|---|---|
| Sign-in and sessions | ✅ | |
| Two-factor sign-in, trusted devices | 🧪 | |
| Roles and permissions | 🧪 | |
| Personal access tokens | 🧪 | |
| Agent tokens stored hashed | ✅ | |
| Signed jobs | ✅ | Session starts aren't signed yet (10.1) |
| Audit log | 🔴 | |
| SSO | 🧪 | |
| Stored mail and storage credentials encrypted | 🔴 | Plain text today |

## Infrastructure

| Feature | Status | Notes |
|---|---|---|
| Deploys with automatic rollback | ✅ | |
| Clean, reproducible agent builds | ✅ | |
| Cloudflare TURN | ✅ | |
| RemoteIQ's own backups | 🧪 | Archives aren't encrypted, and a restore hasn't been tested |
| Automated tests | 🟡 | API and install checks. No unit or UI tests |

## Known problems right now

| Problem | Status | Roadmap step |
|---|---|---|
| Remote Console black screen on 1.3.4 | 🔴 | 0.1 |
| Default Defender blocks new Windows installs (`Backdoor:MSIL/CobaltStrikeLoader.F!MTB`) | ⛔ | 0.12, 0.13 |
| Admin screens that appear to save but don't | 🔴 | 2.1 |
| No alerts when something goes wrong | 🔴 | 1.1 |
| Plain-text stored credentials | 🔴 | 10.2 |
| Secrets remain in git history | 🔴 | 10.3 |
| Device clock over 15 minutes off silently blocks jobs for scripts and files | 🟡 | Update agent now shows the reason. Other tools may not |
