# Asset manager provider: built-in or external

Status: steps 1 to 4 built and tested (2026-11-18). Step 5, the Killian adapter, waits for Killian's API.

Where it lives: `backend/src/assets/` (`AssetsService`: the setting, the guard, the export, add-a-host-as-asset; `AssetsController`: `/api/assets/provider`, `/provider/preflight`, `/export`),
the card in Administration > Integrations (`fe/app/administration/tabs/AssetProviderCard.tsx`), table `asset_provider_settings`, right `integrations.manage` (Owner only).
Tests: `assets-provider-http.e2e.cjs` (12), `assets-provider-service.e2e.cjs` (17).

## The rule

RemoteIQ has a built-in asset manager. The owner's separate software, Killian, has its own. **When Killian is integrated, the built-in
asset manager is switched off and Killian's is the only one.** Never two at once.

## What exists today

| Piece | Where | What it does |
|---|---|---|
| `assets` table | database | One record per asset: customer, optional device, name, kind, maker, model, serial, location, purchase date, warranty or licence end, notes, `details` (JSON), `source` (`manual` or from an agent), notice days |
| Asset endpoints | `itdocs` module, `GET/POST/PUT/DELETE /api/itdocs/assets`, `POST assets/sync`, rights `assets.read` and `assets.write` | List, create, change, delete, and fill from agents |
| Hourly sync from agents | `itdocs.service.ts` `syncFromAgents` | Creates and updates an asset for each managed device from its reported hardware, OS, serial |
| Expiry notices | `itdocs.service.ts` | Emails at 30, 7 and 1 days before a warranty or licence ends |
| Reports | `reports/extra-reports.ts`, `service-reports.ts` | Hardware age and warranty use the asset's purchase date and warranty end; without one they fall back to the firmware date the agent reports |
| Device moves | `devices.service.ts` | Moving a device to another customer moves its asset |
| Demo data | `demo.service.ts` | Creates sample assets |
| Links | `asset_provider` and `asset_ref` columns on `discovered_hosts`-style rows and on `snmp_devices` | A provider-neutral pointer to an asset, never required |

There is no asset page in the dashboard (the IT Docs page was removed on request).

## Design

### 1. One setting says who owns assets

`assets.provider` = `builtin` (default) or `external`, plus `externalName` (shown to people, for example "Killian") and `externalUrl`
(where people are sent). Stored in the existing organisation settings. Changing it needs a new right, `integrations.manage`, held by
the Owner role only, and is audited with who, when, from and to.

### 2. One seam: `AssetProvider`

Every part of RemoteIQ that touches assets goes through one interface instead of reading the `assets` table. It only has the
operations RemoteIQ really needs:

| Operation | Used by |
|---|---|
| `deviceAssetInfo(deviceId)` returns purchase date, warranty end, asset link | the hardware age and warranty reports |
| `syncDevice(device)` hands over what an agent reports (hardware, OS, serial, addresses) | the hourly sync |
| `registerHost(host)` makes or links an asset for a host with no agent (a found host, an SNMP device) | the "add as asset" action on Network discovery and Network devices |
| `linkUrl(ref)` returns where to open the asset | the "Open asset" links |
| `moveToCustomer(deviceId, customerId)` | device moves |
| `enabled()` | everything else, to decide whether to show asset features at all |

Two providers:

* **Built-in**: today's code moved behind the interface. No behaviour change.
* **External (Killian)**: an outbound adapter. It is written when Killian's API exists. Until then `external` means "assets are somewhere
  else and RemoteIQ does not know how to reach them", which is safe: nothing breaks, the asset features simply are not there.

### 3. What switching to external does

* The built-in asset endpoints answer `409` with `{"code": "assets_external", "message": "Assets are managed in Killian.", "url": ...}`. Reads too, so nothing quietly shows stale data.
* The hourly agent sync and the expiry emails stop. Killian owns expiry notices.
* Asset panels, links and the "add as asset" actions are hidden or become "Open in Killian" links.
* The reports ask the provider; when it has no answer they use the firmware date, exactly as they do today for a device with no asset.
* **Nothing is deleted.** The built-in records stay, read-only through a database export, so switching back loses nothing.
* The Network discovery and SNMP links keep working: `asset_provider` and `asset_ref` already say where an asset lives. A host or device that points at a built-in asset keeps the pointer; new links point at Killian.

### 4. Switching is a guided step, not a toggle

Administration > Integrations gets an "Assets" card:

1. **Preflight**: counts of built-in assets, assets with a warranty date, notices still to be sent, devices with an asset. A button exports them (CSV and JSON) so they can be imported into Killian from its side.
2. **Mapping**: assets are matched to Killian by device id and serial number, using the stable external ids the integration needs anyway (customers, sites, devices).
3. **Switch**: needs the Owner's confirmation, writes the audit entry, flips `assets.provider`.
4. **Switch back** is allowed. It re-enables the sync and runs a full one.

### 5. Rights and customer limits

Customer limits keep working on whatever asset data RemoteIQ shows. `assets.read` and `assets.write` keep meaning what they mean today
for the built-in provider. Switching is `integrations.manage`, Owner only.

### 6. Failure behaviour

If Killian cannot be reached, reports use their fallback and say so in their notes. An outage never blocks a report, a device move or a
scan.

## Build order

| Step | What | Size | Needs |
|---|---|---|---|
| 1 | The seam: `AssetsService` and the provider types, every asset caller moved onto it (reports, device moves, the sync, the expiry emails) | done | nothing |
| 2 | The setting, the `409` guard (`{code: assets_external, message, url}`), the right `integrations.manage` | done | step 1 |
| 3 | "Add as asset" on Network discovery and Network devices, through the provider | done | step 1 |
| 4 | The Assets card in Administration > Integrations: preflight, export (the keys a match is made on), switch, switch back. Automatic mapping to Killian waits for step 5 | done | step 2 |
| 5 | The Killian adapter | depends on Killian | Killian's API and sign-in method |

Steps 1 to 4 are built. Step 5 waits for Killian.

## Decisions I recommend (the owner may overrule)

1. **Killian owns expiry notices once it is on.** Two systems emailing the same warranty date is the likeliest annoyance.
2. **Customers and sites are mapped by stable external ids**, not by name, so a renamed customer does not break the link.
3. **Keep the built-in data after switching** and allow switching back, at the price of a read-only archive.
4. **The built-in provider stays the default** for everyone who does not use Killian, including open source users.

## Open questions

* What does Killian's API look like (REST, sign-in method, how it names customers and sites)?
* Does Killian want RemoteIQ to push device facts to it, or pull them?
* Should a device deleted in RemoteIQ also be marked retired in Killian?
