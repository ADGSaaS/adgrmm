#!/usr/bin/env bash
# Removes the RemoteIQ agent from this machine, including its identity and logs.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this as root (sudo)." >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl disable --now remoteiq-agent-update 2>/dev/null || true
  systemctl disable --now remoteiq-agent 2>/dev/null || true
  rm -f /etc/systemd/system/remoteiq-agent.service /etc/systemd/system/remoteiq-agent-update.service
  systemctl daemon-reload
fi
# OpenRC (Alpine and others)
if command -v rc-service >/dev/null 2>&1; then
  for S in remoteiq-agent-update remoteiq-agent; do
    rc-service "$S" stop >/dev/null 2>&1 || true
    rc-update del "$S" default >/dev/null 2>&1 || true
    rc-service "$S" zap >/dev/null 2>&1 || true
    rm -f "/etc/init.d/$S"
  done
  rm -f /var/log/remoteiq-agent.log
fi
rm -rf /etc/remoteiq /opt/remoteiq-agent /opt/remoteiq-agent.update /opt/remoteiq-agent.prev /opt/remoteiq-agent.failed
echo "RemoteIQ agent removed."
