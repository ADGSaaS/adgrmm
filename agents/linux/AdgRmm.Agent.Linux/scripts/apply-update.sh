#!/bin/bash
# Applies a verified ADG RMM agent update. Written by the agent to its config folder and run by
# a separate systemd unit, because stopping the agent's service kills everything in its cgroup.
# That unit also runs at boot while an update is unfinished, so an interrupted swap gets repaired.
# It never touches agent.json, so the device keeps its identity and enrollment.
set -u

PARAMS="${1:-$(dirname "$0")/apply-params.env}"
# shellcheck disable=SC1090
. "$PARAMS"
# What starts services on this machine: systemd (the default) or OpenRC (Alpine and others).
INIT="${INIT:-systemd}"

STAGING_DIR="$INSTALL_DIR.update"
NEW_DIR="$STAGING_DIR/new"
PREV_DIR="$INSTALL_DIR.prev"
FAILED_DIR="$INSTALL_DIR.failed"
STARTED="$STATE_DIR/apply.started"
OK_FILE="$STATE_DIR/ok.txt"
PENDING="$STATE_DIR/pending.txt"
RESULT="$STATE_DIR/result.json"
LOG_FILE="$STATE_DIR/apply.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG_FILE"; }

write_result() {
    # The texts are fixed strings from this script, with nothing that needs JSON escaping.
    printf '{"version":"%s","outcome":"%s","detail":"%s","atUtc":"%s"}' \
        "$TARGET_VERSION" "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULT.tmp"
    mv -f "$RESULT.tmp" "$RESULT"
    log "Result: $1 $2"
}

is_running() { if [ "$INIT" = openrc ]; then rc-service "$SERVICE_NAME" status >/dev/null 2>&1; else systemctl is-active --quiet "$SERVICE_NAME"; fi; }
svc_stop() { if [ "$INIT" = openrc ]; then rc-service "$SERVICE_NAME" stop >/dev/null 2>&1; else systemctl stop "$SERVICE_NAME" >/dev/null 2>&1; fi; }
svc_start() { if [ "$INIT" = openrc ]; then rc-service "$SERVICE_NAME" start >/dev/null 2>&1; else systemctl start "$SERVICE_NAME" >/dev/null 2>&1; fi; }
# a service that has been failing may be rate limited until this is cleared (systemd only)
svc_reset() { if [ "$INIT" != openrc ]; then systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1; fi; }

confirmed() { [ -f "$OK_FILE" ] && [ "$(tr -d '[:space:]' < "$OK_FILE")" = "$TARGET_VERSION" ]; }

remove_unit() {
    # Removing the unit does not end this running copy of it.
    if [ "$INIT" = openrc ]; then
        rc-update del "$UPDATE_UNIT" default >/dev/null 2>&1
        # forget that it ran, or the next update's start would be skipped as "already started"
        rc-service "$UPDATE_UNIT" zap >/dev/null 2>&1
        rm -f "/etc/init.d/$UPDATE_UNIT"
    else
        systemctl disable "$UPDATE_UNIT" >/dev/null 2>&1
        rm -f "/etc/systemd/system/$UPDATE_UNIT"
        systemctl daemon-reload >/dev/null 2>&1
    fi
}

finish() {
    rm -rf "$STAGING_DIR" "$PREV_DIR" "$FAILED_DIR"
    rm -f "$PENDING" "$OK_FILE" "$STARTED"
    remove_unit
}

wait_healthy() {
    # The new agent writes the marker once it has reached the server with its token.
    local waited=0
    while [ "$waited" -lt "$HEALTH_SECONDS" ]; do
        if confirmed; then
            # A build that dies right after confirming is not healthy either.
            local settle=$((HEALTH_SECONDS / 10))
            [ "$settle" -ge 1 ] || settle=1
            [ "$settle" -le 30 ] || settle=30
            sleep "$settle"
            if is_running; then return 0; fi
            log "The new version stopped after confirming."
            return 1
        fi
        sleep 2
        waited=$((waited + 2))
    done
    log "The new version did not confirm in time."
    return 1
}

restore_previous() {
    log "Rolling back: $1"
    svc_stop

    if [ -d "$PREV_DIR" ]; then
        rm -rf "$FAILED_DIR"
        if [ -e "$INSTALL_DIR" ] && ! mv -f "$INSTALL_DIR" "$FAILED_DIR"; then
            # The unit and the started marker stay, so the next restart tries this again.
            write_result rollback_failed "Could not move the failed version aside."
            svc_start
            return
        fi
        if ! mv -f "$PREV_DIR" "$INSTALL_DIR"; then
            write_result rollback_failed "Could not restore the previous version."
            return
        fi
    fi

    # A unit that has been failing may be rate limited until this is cleared.
    svc_reset
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
        svc_start
        sleep 3
        if is_running; then
            write_result rolled_back "$1"
            finish
            return
        fi
    done
    write_result rollback_failed "The previous version was restored but the service did not start."
}

if [ -f "$STARTED" ]; then
    # This run was started at boot, and the one before it never finished.
    log "Found an unfinished update."
    if confirmed && [ -f "$INSTALL_DIR/$EXE_NAME" ]; then
        svc_start
        write_result succeeded "Finished after a restart."
        finish
    elif [ -d "$PREV_DIR" ]; then
        restore_previous "The update was interrupted by a restart."
    else
        svc_start
        write_result failed "The update was interrupted before anything changed."
        finish
    fi
    exit 0
fi

if [ ! -f "$NEW_DIR/$EXE_NAME" ]; then
    # Nothing to apply: a boot run after a finished update whose unit could not be removed.
    remove_unit
    exit 0
fi

# The running install is known good, so a previous version left behind is no longer needed.
rm -rf "$PREV_DIR" "$FAILED_DIR"
rm -f "$OK_FILE"

echo "$TARGET_VERSION" > "$STARTED"
log "Applying version $TARGET_VERSION"

svc_stop

if ! mv -f "$INSTALL_DIR" "$PREV_DIR"; then
    # Nothing has changed yet, except that the service was stopped.
    svc_start
    write_result failed "The install folder could not be moved."
    finish
    exit 0
fi

if ! mv -f "$NEW_DIR" "$INSTALL_DIR"; then
    restore_previous "Could not put the new version in place."
    exit 0
fi

svc_reset
svc_start

if wait_healthy; then
    write_result succeeded ""
    finish
else
    restore_previous "The new version did not come up."
fi
exit 0
