# Agent self-update

Agents update themselves from the package folder on the backend. Nothing is pushed: each agent asks
every so often, and the backend answers only when it has something newer.

## Releasing a version

1. Build, with a version higher than anything in the field:

   ```
   pwsh -NoProfile -File agents/build-packages.ps1 -OutDir <folder> -Version 1.3.0
   ```

   `-Version` decides the version compiled into the agent and written to the version files. Without
   it the default in the script is used, so raise that and the two `.csproj` files together when
   cutting a release.

2. Copy the output into `AGENT_PKG_DIR`, keeping the layout. **The version files must be copied too.**

   ```
   windows/adgrmm-agent-windows.zip
   windows/version.json
   linux/adgrmm-agent-linux-x64.tar.gz
   linux/version.json
   ```

Order does not matter. `version.json` holds the package's SHA-256, and the backend offers nothing
while the two disagree, so an agent cannot be offered a half-copied release. Without a `version.json`
nothing is offered at all, and installers keep working either way.

`AGENT_PKG_WINDOWS_PATH` and `AGENT_PKG_LINUX_PATH` work too: `version.json` is read from the folder
holding the package.

## Stopping a rollout

Set `AGENT_UPDATES_ENABLED=false` in the backend environment and restart it. Agents get 204 from the
check, and the download route answers 503. Agents already running a new version are not rolled back.
Setting it back to `true`, or removing it, resumes offers.

To stop offering one bad release without turning everything off, delete that OS's `version.json`.

To replace a bad release, publish one with a higher version. Agents never downgrade, so publishing
an older version does nothing for agents that already took the bad one.

## How an update runs

1. **Check.** `GET /api/agent/updates/check?os=&arch=&version=` with the agent token. Returns 200 and
   a manifest when the package is numerically newer than the reported version, otherwise 204. Only
   x64 agents are offered anything, because the packages are x64.
2. **Verify the manifest.** The signature is RSA-PSS with SHA-256 by the job signing key, the one the
   agent pinned at enrollment. It covers `remoteiq-update-v1|<version>|<sha256>|<url>`. The agent also
   requires a version newer than its own, and the URL to be exactly the relative
   `/api/agent/updates/download/<its os>`, so its token cannot be sent to another host.
3. **Download and verify.** The agent token authenticates the download. The package goes to
   `<install dir>.update`, and its hash must match the signed one.
4. **Preflight.** It unpacks the package and runs the new build with `--version`. A build that cannot
   start on this machine, or that is not the version it claims, stops here with nothing changed.
5. **Apply.** The agent writes a script to its private state folder and starts it outside the service:

   | | Windows | Linux |
   |---|---|---|
   | Started by | Scheduled task `ADG RMM Agent Update` as SYSTEM, or directly if the task cannot be created | systemd unit `adgrmm-agent-update.service` |
   | State folder | `C:\ProgramData\AdgRmm\update` | `/etc/adgrmm/update` |
   | Log | `apply.log` in the state folder | `apply.log` in the state folder |

   A child process would not do on Linux, because stopping the agent's service kills its whole cgroup.

6. **Swap.** The script stops the service, renames the install folder to `<install dir>.prev`, moves
   the new build into place and starts the service.
7. **Confirm.** The new agent writes `ok.txt` once it has reached the server with its token. The script
   waits up to five minutes for it, then checks the service is still running. If so it removes the
   previous version. If not, it **rolls back**: it restores the previous version and starts it.

The config, `agent.config.json` on Windows and `agent.json` on Linux, is never touched and no
`enrollment.json` is written, so the device keeps its identity and does not enroll again.

## When an update fails

| What happened | Result |
|---|---|
| Network error during download | Tried again at the next check. Not counted as an attempt. |
| Not enough disk space | Same. It needs about four times the package size, at least 800 MB. |
| Bad signature, wrong version, wrong URL | Ignored and logged. Nothing is downloaded. |
| Hash mismatch, or preflight fails | Nothing changed. Counted as an attempt. |
| New version does not come up | Rolled back automatically. Counted as an attempt. |
| Power cut during the swap | The task or unit also runs at boot, and repairs it. |
| Previous version will not start after a rollback | `rollback_failed`. Repair stays armed for the next boot. Someone has to look at this machine. |

After a failure the agent waits one hour, then six hours. After three attempts it stops trying that
version until a newer one appears. Attempts are kept in `attempts.json`, so restarts do not reset
them. Separately, it never starts two attempts within 30 minutes, even for different versions.

A failed update shows on the device's Checks tab through the `Agent update` check: a warning if the
package failed verification, and failing if the swap had to be rolled back. `result.json` in the state
folder holds the last outcome.

## Spreading out a fleet

Checks are every `PollIntervals.UpdateCheckMinutes` on Windows, default 30, and every 30 minutes on
Linux, stretched at random by up to half. The first check after a start lands anywhere in the first
interval. So a whole fleet takes about 45 minutes to pick up a release. There are no rollout rings: a
release goes to every agent that checks in, which is why the kill switch exists.

## What this does not do

- Agents older than this feature cannot update themselves. Each needs one manual reinstall to get it.
- An agent run outside its service, such as a dev build, never updates itself. It logs why.
- A new version that passes confirmation and fails later is not rolled back, since the previous
  version is gone by then. Service restart settings still apply.
- Offers are per OS. There are no per-customer versions, pinning or staged rollouts.

## Updating one device now

The dashboard follows the update and shows a toast when it is done. Success means the device reported the new version after restarting. If the agent refuses the request, the toast gives its reason. If nothing has changed after 8 minutes, the toast says so, because the update may still be running or may have rolled back.

In the device list, open a device's menu and choose **Update agent**. The agent checks immediately instead of waiting for its next scheduled check, and it skips the waiting periods after failed attempts. Signature and hash checks, and automatic rollback, still apply.

This needs the `devices.actions` permission and an online agent on version 1.3.0 or later. If updates are turned off with `AGENT_UPDATES_ENABLED`, the action says so.
