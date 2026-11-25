// "Recover agents": ask a device whose agent is online to restart its own agent service. A fixed, signed script job with no input from a person;
// the service name only changes in tests (RIQ_AGENT_SERVICE) and is checked against a strict pattern before it is used.
//   - The restart must outlive the agent: stopping the agent ends the job that asked for it, so the restart is handed to something that is not
//     a child of the agent: a one-shot SYSTEM scheduled task on Windows (the same way the agent updater runs), a transient systemd timer on
//     systemd Linux, and a session of its own on OpenRC (Alpine).
//   - RIQ_DRY_RUN=1 only says what would happen.
// The scripts hold no dollar-brace sequence and no backtick (the Linux one lives in a template literal).

export const RECOVER_TOOL = "agent.recover";

export const WINDOWS_RECOVER_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "$svc = 'RemoteIQAgent'",
    "if ($env:RIQ_AGENT_SERVICE) {",
    "  if ($env:RIQ_AGENT_SERVICE -notmatch '^[A-Za-z0-9._-]{1,64}$') { [Console]::Error.WriteLine('The service name is not valid.'); exit 2 }",
    "  $svc = $env:RIQ_AGENT_SERVICE",
    "}",
    "if (-not (Get-Service -Name $svc -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('The service ' + $svc + ' was not found on this device.'); exit 1 }",
    "if ($env:RIQ_DRY_RUN -eq '1') { Write-Output ('OK Dry run: the service ' + $svc + ' would be restarted in a few seconds.'); exit 0 }",
    "$task = 'RemoteIQ Agent Recover'",
    "# The restart is run by a one-shot task of its own, because stopping the agent ends this script too.",
    "$inner = 'Start-Sleep -Seconds 3; Restart-Service -Name ''' + $svc + ''' -Force; Unregister-ScheduledTask -TaskName ''' + $task + ''' -Confirm:$false'",
    "$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))",
    "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -EncodedCommand ' + $enc)",
    "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    "Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null",
    "Start-ScheduledTask -TaskName $task",
    "Write-Output ('OK The agent service ' + $svc + ' restarts in a few seconds.')",
    "",
].join("\r\n");

export const LINUX_RECOVER_SCRIPT = String.raw`#!/bin/bash
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
SVC="remoteiq-agent"
if [ -n "$RIQ_AGENT_SERVICE" ]; then
  printf '%s' "$RIQ_AGENT_SERVICE" | grep -Eq '^[A-Za-z0-9._@-]{1,64}$' || { echo "The service name is not valid." >&2; exit 2; }
  SVC="$RIQ_AGENT_SERVICE"
fi
[ "$(id -u)" = "0" ] || { echo "The agent is not running as root, so it cannot restart itself." >&2; exit 77; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ -d /run/systemd/system ] && have systemctl; then
  systemctl cat "$SVC" >/dev/null 2>&1 || { echo "The service $SVC was not found on this device." >&2; exit 1; }
  [ "$RIQ_DRY_RUN" = "1" ] && { echo "OK Dry run: the service $SVC would be restarted in a few seconds."; exit 0; }
  # a transient timer is not part of the agent's cgroup, so it survives the agent being stopped
  if have systemd-run && systemd-run --quiet --no-block --unit "riq-recover-$(date +%s)" --on-active=3 /bin/systemctl restart "$SVC"; then
    echo "OK The agent service $SVC restarts in a few seconds."
  else
    setsid sh -c "sleep 3; systemctl restart $SVC" >/dev/null 2>&1 </dev/null &
    echo "OK The agent service $SVC restarts in a few seconds."
  fi
elif have rc-service; then
  [ -x "/etc/init.d/$SVC" ] || { echo "The service $SVC was not found on this device." >&2; exit 1; }
  [ "$RIQ_DRY_RUN" = "1" ] && { echo "OK Dry run: the service $SVC would be restarted in a few seconds."; exit 0; }
  setsid sh -c "sleep 3; rc-service $SVC restart" >/dev/null 2>&1 </dev/null &
  echo "OK The agent service $SVC restarts in a few seconds."
else
  echo "This system starts services with neither systemd nor OpenRC, so the agent cannot be restarted from here." >&2
  exit 69
fi
`;
