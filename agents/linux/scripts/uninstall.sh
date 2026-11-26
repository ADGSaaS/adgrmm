#!/usr/bin/env bash
# Removes the ADG RMM agent from this machine, including its identity and logs.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this as root (sudo)." >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl disable --now adgrmm-agent-update 2>/dev/null || true
  systemctl disable --now adgrmm-agent 2>/dev/null || true
  rm -f /etc/systemd/system/adgrmm-agent.service /etc/systemd/system/adgrmm-agent-update.service
  systemctl daemon-reload
fi
# OpenRC (Alpine and others)
if command -v rc-service >/dev/null 2>&1; then
  for S in adgrmm-agent-update adgrmm-agent; do
    rc-service "$S" stop >/dev/null 2>&1 || true
    rc-update del "$S" default >/dev/null 2>&1 || true
    rc-service "$S" zap >/dev/null 2>&1 || true
    rm -f "/etc/init.d/$S"
  done
  rm -f /var/log/adgrmm-agent.log
fi
rm -rf /etc/adgrmm /opt/adgrmm-agent /opt/adgrmm-agent.update /opt/adgrmm-agent.prev /opt/adgrmm-agent.failed
echo "ADG RMM agent removed."
