#!/bin/bash
# Runs the real apply-update.sh against temporary folders, with a fake systemctl first on the PATH,
# so nothing on this machine changes. It proves the file swap and every rollback path, not systemd.
#
#   bash agents/tests/apply-update-test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_SRC="$HERE/../linux/RemoteIQ.Agent.Linux/scripts/apply-update.sh"
FAILURES=0

new_sandbox() {
    D="$(mktemp -d)"
    mkdir -p "$D/bin" "$D/agent" "$D/agent.update/new" "$D/state"
    echo old > "$D/agent/remoteiq-agent"
    echo new > "$D/agent.update/new/remoteiq-agent"
    echo identity > "$D/state/agent.json"
    echo 1.3.0 > "$D/state/pending.txt"
    tr -d '\r' < "$SCRIPT_SRC" > "$D/apply-update.sh"
    cat > "$D/params.env" <<EOF
INSTALL_DIR='$D/agent'
STATE_DIR='$D/state'
TARGET_VERSION='1.3.0'
SERVICE_NAME='fake'
UPDATE_UNIT='fake-update.service'
EXE_NAME='remoteiq-agent'
HEALTH_SECONDS=4
EOF
    if [ "${INIT_MODE:-systemd}" = openrc ]; then echo "INIT='openrc'" >> "$D/params.env"; fi
    cat > "$D/bin/systemctl" <<'EOF'
#!/bin/bash
D="$SANDBOX"
echo "$*" >> "$D/calls.txt"
exe="$(head -n 1 "$D/agent/remoteiq-agent" 2>/dev/null)"
case "$1" in
  stop) rm -f "$D/running" ;;
  start)
    case "$SCENARIO" in
      good) touch "$D/running"; [ "$exe" = new ] && echo 1.3.0 > "$D/state/ok.txt" ;;
      neverconfirms) [ "$exe" = new ] && rm -f "$D/running" || touch "$D/running" ;;
      wrongversion) touch "$D/running"; [ "$exe" = new ] && echo 9.9.9 > "$D/state/ok.txt" ;;
      diesafterconfirm) if [ "$exe" = new ]; then echo 1.3.0 > "$D/state/ok.txt"; rm -f "$D/running"; else touch "$D/running"; fi ;;
      rollbackwontstart) rm -f "$D/running" ;;
      *) touch "$D/running" ;;
    esac ;;
  is-active) [ -f "$D/running" ] ;;
esac
exit "${?}"
EOF
    chmod +x "$D/bin/systemctl"
    # OpenRC: rc-service <name> <command> maps onto the same fake, rc-update only records
    cat > "$D/bin/rc-service" <<'EOF'
#!/bin/bash
D="$SANDBOX"
echo "rc-service $*" >> "$D/calls.txt"
case "$2" in
  status) exec "$D/bin/systemctl" is-active "$1" ;;
  zap) exit 0 ;;
  *) exec "$D/bin/systemctl" "$2" "$1" ;;
esac
EOF
    cat > "$D/bin/rc-update" <<'EOF'
#!/bin/bash
echo "rc-update $*" >> "$SANDBOX/calls.txt"
EOF
    chmod +x "$D/bin/rc-service" "$D/bin/rc-update"
}

run() { SANDBOX="$D" SCENARIO="$1" PATH="$D/bin:$PATH" bash "$D/apply-update.sh" "$D/params.env"; }
installed() { head -n 1 "$D/agent/remoteiq-agent" 2>/dev/null; }
outcome() { sed -n 's/.*"outcome":"\([^"]*\)".*/\1/p' "$D/state/result.json" 2>/dev/null; }
check() { if eval "$2"; then echo "pass  $1"; else echo "FAIL  $1"; FAILURES=$((FAILURES + 1)); fi; }
done_with() { rm -rf "$D"; }
identity_kept() { [ "$(cat "$D/state/agent.json")" = identity ]; }

uname -a

new_sandbox; run good
check 'good: new version installed' '[ "$(installed)" = new ]'
check 'good: outcome succeeded' '[ "$(outcome)" = succeeded ]'
check 'good: previous version removed' '[ ! -e "$D/agent.prev" ]'
check 'good: staging removed' '[ ! -e "$D/agent.update" ]'
check 'good: markers removed' '[ ! -e "$D/state/apply.started" ] && [ ! -e "$D/state/pending.txt" ] && [ ! -e "$D/state/ok.txt" ]'
check 'good: identity kept' identity_kept
check 'good: boot unit disabled' 'grep -q "disable fake-update.service" "$D/calls.txt"'
check 'good: rate limit cleared before starting' 'grep -q "reset-failed fake" "$D/calls.txt"'
done_with

new_sandbox; run neverconfirms
check 'never confirms: previous version restored' '[ "$(installed)" = old ]'
check 'never confirms: outcome rolled_back' '[ "$(outcome)" = rolled_back ]'
check 'never confirms: failed build cleaned up' '[ ! -e "$D/agent.failed" ]'
check 'never confirms: identity kept' identity_kept
done_with

new_sandbox; run wrongversion
check 'wrong marker: previous version restored' '[ "$(installed)" = old ]'
check 'wrong marker: outcome rolled_back' '[ "$(outcome)" = rolled_back ]'
done_with

new_sandbox; run diesafterconfirm
check 'dies after confirming: previous version restored' '[ "$(installed)" = old ]'
check 'dies after confirming: outcome rolled_back' '[ "$(outcome)" = rolled_back ]'
done_with

new_sandbox; mv "$D/agent" "$D/agent.prev"; echo 1.3.0 > "$D/state/apply.started"; run boot
check 'power cut mid swap: previous version restored' '[ "$(installed)" = old ]'
check 'power cut mid swap: outcome rolled_back' '[ "$(outcome)" = rolled_back ]'
done_with

new_sandbox; mv "$D/agent" "$D/agent.prev"; mv "$D/agent.update/new" "$D/agent"; echo 1.3.0 > "$D/state/apply.started"; run boot
check 'power cut while verifying: previous version restored' '[ "$(installed)" = old ]'
done_with

new_sandbox; mv "$D/agent" "$D/agent.prev"; mv "$D/agent.update/new" "$D/agent"; echo 1.3.0 > "$D/state/apply.started"; echo 1.3.0 > "$D/state/ok.txt"; run boot
check 'power cut after confirming: new version kept' '[ "$(installed)" = new ]'
check 'power cut after confirming: outcome succeeded' '[ "$(outcome)" = succeeded ]'
done_with

new_sandbox; echo 1.3.0 > "$D/state/apply.started"; run boot
check 'power cut before moving: install untouched' '[ "$(installed)" = old ]'
check 'power cut before moving: outcome failed' '[ "$(outcome)" = failed ]'
done_with

new_sandbox; rm -rf "$D/agent.update"; run boot
check 'nothing to do: install untouched' '[ "$(installed)" = old ]'
check 'nothing to do: no result written' '[ -z "$(outcome)" ]'
check 'nothing to do: leftover unit disabled' 'grep -q "disable fake-update.service" "$D/calls.txt"'
done_with

new_sandbox; run rollbackwontstart
check 'rollback will not start: previous files restored' '[ "$(installed)" = old ]'
check 'rollback will not start: outcome rollback_failed' '[ "$(outcome)" = rollback_failed ]'
check 'rollback will not start: boot repair stays armed' '[ -e "$D/state/apply.started" ]'
done_with

# ---- the same file swap and rollbacks on an OpenRC machine (no systemctl is ever called: its fake is only the shared state)
export INIT_MODE=openrc
new_sandbox; run good
check 'openrc good: new version installed' '[ "$(installed)" = new ]'
check 'openrc good: outcome succeeded' '[ "$(outcome)" = succeeded ]'
check 'openrc good: stopped and started through rc-service' 'grep -q "^rc-service fake stop" "$D/calls.txt" && grep -q "^rc-service fake start" "$D/calls.txt"'
check 'openrc good: the one-shot updater service is removed from the runlevel' 'grep -q "^rc-update del fake-update.service default" "$D/calls.txt"'
check 'openrc good: its state is forgotten (zap), or the next update would be skipped' 'grep -q "^rc-service fake-update.service zap" "$D/calls.txt"'
check 'openrc good: identity kept' identity_kept
done_with

new_sandbox; run neverconfirms
check 'openrc never confirms: previous version restored' '[ "$(installed)" = old ]'
check 'openrc never confirms: outcome rolled_back' '[ "$(outcome)" = rolled_back ]'
done_with

new_sandbox; mv "$D/agent" "$D/agent.prev"; echo 1.3.0 > "$D/state/apply.started"; run boot
check 'openrc power cut mid swap: previous version restored' '[ "$(installed)" = old ]'
done_with

new_sandbox; run rollbackwontstart
check 'openrc rollback will not start: outcome rollback_failed' '[ "$(outcome)" = rollback_failed ]'
check 'openrc rollback will not start: boot repair stays armed' '[ -e "$D/state/apply.started" ]'
done_with
unset INIT_MODE

if [ "$FAILURES" -eq 0 ]; then echo "ALL PASSED"; exit 0; fi
echo "$FAILURES FAILED"; exit 1
