# Seat limits (entitlements)

A hosted ("Cloud") ADG RMM instance has a plan: a number of **endpoints** and a number of **technician** seats. A separate control
plane writes those numbers into a small file in the install folder, and this instance enforces them. A self-hosted install has no
such file, and then nothing described here happens: it behaves exactly as it always has.

## The file

`entitlements.json`, written only by the hosting control plane:

```json
{ "version": 1, "maxEndpoints": 120, "maxTechnicians": 5, "status": "active", "upgradeUrl": "https://account.example.com", "updatedAt": "2026-11-27T04:25:13Z" }
```

| Field | Meaning |
| --- | --- |
| `maxEndpoints`, `maxTechnicians` | A whole number, or `null` (or left out) for unlimited. `0` means none may be added. |
| `status` | `active`, `past_due` (informational: a banner, no blocking) or `suspended` (the control plane stops the whole instance, so nothing extra is enforced here). An unknown value is read as `active`. |
| `upgradeUrl` | Where to manage the plan. Only `http` and `https` addresses are kept, and it is shown in messages and links. |
| `updatedAt` | Informational. |

**Location.** `ENTITLEMENTS_FILE`, default `/config/entitlements.json`. In a Docker install the installer already mounts
`$ADG_HOME/config` read-only as `/config`, so the default is right. For a native install the installer writes
`ENTITLEMENTS_FILE=$ADG_HOME/config/entitlements.json` into the backend environment (`config/adgrmm.env`) on a fresh install; an
install made before this change needs that one line added by hand. The file must be readable by the backend's user (native installs
run as `adgrmm`; the config folder is group `adgrmm`).

**Failing open.** A missing file, an unreadable one, or a malformed one (not JSON, not an object, a limit that is not a whole number
or `null`) means **unlimited**, and a malformed file logs one warning per change to the file. The backend never crashes over it.

**Caching.** The file is read at most every 15 seconds, and at once when its modification time or size changes. Usage counts for
the status display are cached for 5 seconds; the checks that refuse something always count fresh.

## Definitions

- An **endpoint** is a row in `public.agents`.
- A **technician** is a row in `public.users` whose status is `active` or `invited`. A `disabled` (suspended) user does not count.
  Customer portal accounts are not technicians.

These match `adg-tenantctl usage` in the control plane.

## What is enforced

The rule is the same everywhere: adding one more is refused when the number in use is already **at or over** the limit. Nothing ever
disconnects an endpoint or signs a user out, so a plan that is reduced below current usage only stops further additions.

| Action | Where | Refused with |
| --- | --- | --- |
| A **new** agent enrolling (`POST /api/agent/enroll`) | `AuthService.enrollAgent` | `seat_limit_endpoints` |
| Creating a technician (`POST /api/admin/users/create`) unless it is created switched off | `UsersService.createOne` | `seat_limit_technicians` |
| Inviting a new technician (`POST /api/admin/users/invite`) | `UsersService.inviteOne` | `seat_limit_technicians` |
| Bulk invite (`POST /api/admin/users/invite/bulk`) | `UsersService.inviteBulk` | see below |
| Turning a suspended user back on (`POST /api/admin/users/:id/suspend` with `suspended: false`) | `UsersService.setSuspended` | `seat_limit_technicians` |
| A first single sign-on login that creates the account (just-in-time provisioning) | `SsoService.createUser` | `sso_seat_limit` on the sign-in screen |

Not affected: re-enrolling an agent that already has a row (a reinstall), heartbeats, check-ins, updates, re-sending an invite to
someone who is already invited, suspending anyone, and creating an account that is switched off.

**Errors.** HTTP **402** (not 403: the enrollment rate limiter counts 401 and 403 as password guesses, and a seat limit is not one).
The body is `{ "statusCode": 402, "error": "Payment Required", "code": "seat_limit_endpoints" | "seat_limit_technicians", "message": "...", "limit": n, "upgradeUrl": "..." }`.
The message says the plan limit is reached and includes the upgrade address when there is one. A refused **one-time** enrollment
token is given back (it is not marked used), so the same install command works after an upgrade.

**Bulk invite.** As many invites are sent as fit, in the order given. The rest are returned in `skipped` with the plan message as
the reason (`{ created, skipped: [{ email, reason }] }`, as for any other skipped invite). The batch never overshoots the limit
because each invite checks the count again. The web app sends invites one at a time and shows the server's message.

**Races.** Counting is not locked, so two requests arriving in the same instant at the last free seat can both succeed and leave
the instance one over. The next addition is then refused. This is acceptable for billing seats and is not a security boundary.

## `GET /api/entitlements`

Any signed-in staff user (no particular permission). Without a file, and always in the public demo:

```json
{ "limits": null, "usage": null, "status": null, "upgradeUrl": null, "banner": null }
```

With a file:

```json
{
  "limits": { "maxEndpoints": 120, "maxTechnicians": 5 },
  "usage": { "endpoints": 113, "technicians": 4 },
  "status": "active",
  "upgradeUrl": "https://account.example.com/",
  "banner": { "level": "warn", "text": "You are using 113 of 120 endpoint seats. Manage your plan at https://account.example.com/." }
}
```

Nothing else from the file is returned. `banner` is computed on the server: `warn` when a usage is at least 90 percent of its limit,
`error` when a usage is at or over a limit or the status is `past_due` ("Payment failed"), otherwise `null`.

## In the web app

When `limits` is not null: a small "Endpoints 113/120 · Technicians 4/5" figure in the top bar (wide screens), the banner under it
(a `warn` banner can be dismissed for the browser session, an `error` banner cannot), and a note on the installer and install-key
screens when no new device can enroll. The user screens show the server's message when a person cannot be added or turned back on.

## Tests

`backend/test/entitlements.cjs` (file reading, failing open, caching, banner; no database), `entitlements.e2e.cjs` (the real
services against a database) and `entitlements-http.e2e.cjs` (the endpoint and the 402 answers against a running backend started
with `ENTITLEMENTS_FILE`). All three are in `.github/workflows/backend-tests.yml`.
