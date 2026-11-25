# Policies: design proposal

Status: phases 1 and 2 built (see roadmap 1.30, 1.9, 1.10). Phase 3 is partly built: tags and the new-customer baseline are; linked or detached templates and scripts as a policy section are not. Phase 2 needed no agent change: it drives the daily scan, the install task and a restart job from the server. Written after researching how other RMMs do it and looking at what RemoteIQ already has.

## What the others do (short)

| Product | Where a policy attaches | Conflicts | Visibility |
|---|---|---|---|
| Tactical RMM | Global, client, site, agent. One policy per level | "Enforced" beats agent-level checks. "Block inheritance" box at each level | A Relations view |
| NinjaOne | Organisation, location, device, tied to a device role. Dynamic policies add a priority list | A device override beats everything and survives later parent edits | "Inherited" and "Overridden" tags, with Revert |
| Datto RMM | Global and site, targeted by account-wide filters | A site patch policy overrides the global one. Software: first policy wins | "Override active" flag |
| N-central | Service templates applied by rules and filters. New tag-based policies | One per type per tag, by priority | Weak |
| Atera | Customer, folder, agent | Closest level wins | Weak |
| Syncro | Cascade | Child overrides parent, with additive exceptions | Weak |

I could not verify Level.io, Action1 or ConnectWise Automate's own model, and no product was confirmed to offer a dry run or a per-device "what applies and why" view.

### What people get wrong or complain about
- **Hidden overrides.** A device-level override cuts the device off from later fleet-wide fixes, silently.
- **Ambiguous overlap.** Several products do not say what happens when two policies set the same thing.
- **One policy per level**, so policies multiply.
- **Targeting gaps.** A template for "Workstation" silently skips "Laptop", and the device gets nothing.
- **No answer to "why does this device have this setting?"** This is the biggest gap, and the thing worth building well.

## What RemoteIQ has today (to build on, not duplicate)

| Setting | Where it lives now | Scope today |
|---|---|---|
| Offline minutes, re-notify, auto-ticket | `alert_settings`, one row | Everyone |
| Checks | `check_assignments` | All, customer, site, device |
| Check profiles | `check_profiles` (named bundles) | Not assignable as a unit |
| Scheduled scripts | `script_schedules` | All, customer, site, device |
| Required and banned software | `software_policies` | Everyone or one customer |
| Business hours | `report_settings` | Everyone |
| Remote console notice | `clients.remote_console_consent` | One customer |
| Maintenance windows, patch approval and rings, device groups and tags | Not built (roadmap 1.9, 1.10, 1.14) | |

Each of these is a separate screen with its own idea of "scope". There is no way to see what applies to one device.

## The design

### One policy object
A **policy** has a name, an on/off switch, a priority number, an optional operating-system filter (Windows, Linux, macOS, or any) and a set of **sections**. A section is one kind of setting. A policy only says something about the sections it includes; an empty section means "no opinion", not "off".

Sections (each maps to something that already exists or is already on the roadmap):
1. **Alerting:** offline threshold, re-notify, auto-ticket and its minimum severity.
2. **Checks:** which checks or check profiles run.
3. **Software:** required and banned lists (replaces the separate software policies screen).
4. **Hours:** business hours and time zone.
5. **Remote access:** the notice, ask-first or show-nothing setting.
6. **Scheduled scripts:** repeating scripts.
7. **Maintenance windows:** (new) when alerts are muted and work may happen.
8. **Patching:** (new) approve or hold, schedule, reboot rules.

### Where it applies (assignments)
A policy can be assigned to any number of targets: **everyone**, a **customer**, a **site**, a **device group or tag** (once those exist), or a **device**. Several policies can apply at the same level, ordered by priority.

### How conflicts resolve (the same way every time)
For one device, collect every enabled policy whose assignment and OS filter match. Order them from broadest to most specific (everyone, customer, site, group, device), and by priority within a level. Then merge section by section:
- **Single values** (offline threshold, business hours, remote notice, patch schedule): the most specific wins.
- **Lists** (checks, scripts, required software, maintenance windows): added together; the same entry at a more specific level replaces the broader one.
- **Software:** a ban always beats a requirement.
- **Enforced:** a policy marked enforced cannot be overridden by anything more specific. This protects baselines you set for every customer.
- **Exclusions:** a policy can be switched off for one customer, site or device, as a visible exclusion row, not a hidden override.

### What makes it usable
- **Effective policy for a device:** every setting with its value, the policy and level it came from, and what it overrode. This is the main feature.
- **Preview before saving:** how many devices change, and which.
- **Policy detail:** which devices it reaches, and which are excluded or overridden.
- **Audit trail:** who changed what, with before and after.
- **Templates:** a policy for everyone can be copied to a customer as either **linked** (follows later template changes) or a **detached copy**, with a drift view for linked ones.
- **Overrides on a device** are marked "overridden" with a Revert button, so they are never silent.

### How devices get it
The server works out the effective policy and the agent receives one finished document with a hash. The agent reports the hash it applied, which shows which devices are current, stale or failing. Recalculated when a policy, assignment, device move or tag changes.

Most sections run on the server today (alerts, reports, software compliance), so they can read the effective policy directly and need no agent change. Maintenance windows, patching and scheduled scripts need the agent to act, so they come later.

## Proposed phases

**Phase 1: the policy layer, wired to what already runs.** Policy model, assignments (everyone, customer, site, device), the resolver, enforced and exclusions, audit trail, the effective-policy view on each device, a Policies page, and a preview before saving. Sections: Alerting, Checks, Software, Hours and Remote access. The old screens (software policies, business hours, remote access notice) become shortcuts into the same data, and nothing is lost.

**Phase 2: maintenance windows and patching** (roadmap 1.9 and 1.10), including the agent's hash and compliance.

**Phase 3: groups and tags, templates (linked and detached) and scheduled scripts as a section.**

## Open questions
1. Should phase 1 keep today's behaviour exactly when no policy exists (recommended), so nothing changes until policies are created?
2. Is "priority number within a level" enough, or do you want drag-to-reorder lists instead? (Same data either way.)
3. Who may edit policies: everyone with settings access, or a new permission (recommended: a new `policies.write`, so technicians can read but only senior staff change them)?
