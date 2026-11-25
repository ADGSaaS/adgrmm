# RemoteIQ PostgreSQL Disaster Recovery Promotion

This procedure promotes a verified PostgreSQL DR backup into the live
RemoteIQ database.

The web application does not perform production database replacement.
Production promotion is intentionally an offline operator action.

## Safety properties

The promotion tool:

- requires an explicit live database confirmation;
- verifies the supplied SHA-256 checksum;
- validates the archive with `pg_restore --list`;
- refuses production promotion while `remoteiq-backend.service` is active;
- refuses promotion while queued/running backup or restore work exists;
- creates a pre-promotion PostgreSQL safety dump;
- renames the previous live database and preserves it as a rollback database;
- restores the requested DR artifact into a newly created live database;
- applies all current Prisma migrations;
- neutralizes interrupted snapshot work;
- compares the promoted schema against the pre-promotion production schema;
- boots the current application against the promoted database on an isolated
  localhost port and requires `/healthz` HTTP 200;
- automatically attempts database-name rollback if promotion fails after the
  previous production database has been renamed;
- never starts `remoteiq-backend.service` automatically.

`--test-mode` is reserved for disposable databases whose names begin with
`remoteiq_dr_tooltest_`. It must never be used for production recovery.

## Preconditions

Run from the backend VM.

Repository:

    /opt/remoteiq/backend-repo

Application:

    /opt/remoteiq/backend-repo/backend

Current production database:

    remoteiq

Before entering the outage window:

1. Select a completed, verified PostgreSQL DR backup.
2. Retrieve its artifact to the backend host if it is remote.
3. Record its expected SHA-256 checksum.
4. Confirm the artifact is readable.
5. Confirm PostgreSQL is healthy.
6. Confirm there are no queued or running backup/restore operations.
7. Ensure an operator with root access is present for service control.

Example active-work check:

    docker compose \
      -f /opt/remoteiq/backend-repo/backend/docker-compose.db.yml \
      exec -T postgres \
    psql -U remoteiq -d remoteiq -P pager=off -c "
    SELECT 'backup_jobs' AS source, status, count(*)
    FROM backup_jobs
    WHERE status IN ('queued','running')
    GROUP BY status

    UNION ALL

    SELECT 'backup_restores', status, count(*)
    FROM backup_restores
    WHERE status IN ('queued','running')
    GROUP BY status;
    "

The result must contain zero rows.

## Production promotion

Set the artifact and expected checksum:

    DR_ARCHIVE="/absolute/path/to/remoteiq-postgresql.dump"
    DR_CHECKSUM="<64-character-sha256>"

Independently verify the local artifact:

    sha256sum "$DR_ARCHIVE"

The calculated checksum must exactly match `DR_CHECKSUM`.

Stop the RemoteIQ backend:

    systemctl stop remoteiq-backend.service

Confirm it is no longer active:

    systemctl is-active remoteiq-backend.service

Run the promotion:

    sudo -u remoteiq -H \
    node \
    /opt/remoteiq/backend-repo/backend/scripts/postgres-dr-promote.cjs \
    --promote \
    --archive "$DR_ARCHIVE" \
    --checksum "$DR_CHECKSUM" \
    --confirm-live-database remoteiq

A successful promotion must report all of the following:

    BACKEND_SERVICE_OFFLINE=1
    PROMOTION_PG_RESTORE_LIST_VALID=1
    PROMOTION_ACTIVE_WORK=0
    PROMOTION_PG_RESTORE_COMPLETED=1
    PROMOTION_SCHEMA_EXACT_MATCH=1
    PROMOTION_APP_HEALTH_HTTP=200
    PROMOTION_COMPLETED=1
    PROMOTION_LIVE_DATABASE=remoteiq
    PROMOTION_ROLLBACK_DATABASE=<database-name>
    PROMOTION_PRODUCTION_SERVICE_STARTED=0

Record both:

- `PROMOTION_ROLLBACK_DATABASE`
- `PROMOTION_SAFETY_DUMP`
- `PROMOTION_SAFETY_SHA256`

Do not delete the rollback database or safety dump during the recovery window.

## Return production to service

Only after `PROMOTION_COMPLETED=1`:

    systemctl start remoteiq-backend.service

Check local health:

    curl -sS -o /dev/null \
      -w 'LOCAL_HTTP=%{http_code}\n' \
      http://127.0.0.1:3001/healthz

Check public health:

    curl -sS -o /dev/null \
      -w 'PUBLIC_HTTP=%{http_code}\n' \
      https://api.example.com/healthz

Both must return HTTP 200.

Review recent service logs:

    journalctl \
      -u remoteiq-backend.service \
      --since "10 minutes ago" \
      --no-pager

Perform application-level smoke tests before declaring recovery complete.

## Manual rollback

If production must be returned to the preserved pre-promotion database, first
take the backend offline again:

    systemctl stop remoteiq-backend.service

Set the exact rollback database returned by the promotion command:

    ROLLBACK_DB="<PROMOTION_ROLLBACK_DATABASE>"

Run:

    sudo -u remoteiq -H \
    node \
    /opt/remoteiq/backend-repo/backend/scripts/postgres-dr-promote.cjs \
    --rollback \
    --rollback-database "$ROLLBACK_DB" \
    --confirm-live-database remoteiq

Success must report:

    BACKEND_SERVICE_OFFLINE=1
    ROLLBACK_COMPLETED=1
    ROLLBACK_LIVE_DATABASE=remoteiq
    ROLLBACK_FAILED_PROMOTION_DATABASE=<database-name>
    ROLLBACK_PRODUCTION_SERVICE_STARTED=0

Then:

    systemctl start remoteiq-backend.service

Repeat local/public health and application smoke tests.

The failed promoted database is intentionally retained for investigation until
the incident is closed.

## Cleanup after a successful recovery

Do not remove rollback databases or promotion safety dumps immediately.

Cleanup is a separate operator decision after:

- production has remained stable;
- application checks have passed;
- the recovery event has been documented;
- another verified DR artifact exists;
- the retained rollback database is no longer required.

Never use wildcard database deletion commands.

## Important limitations

Logical exports of users, roles, devices, and settings are selective portable
exports. They are not complete PostgreSQL disaster-recovery artifacts and must
not be used with this production promotion procedure.

Only completed, verified PostgreSQL DR artifacts are valid inputs.
