export type EnvironmentRisk =
    | "operational"
    | "sensitive"
    | "critical"
    | "host";

export type EnvironmentWriteTier =
    | "operational"
    | "sensitive"
    | "critical"
    | "never";

export type EnvironmentDefinition = {
    key: string;
    category: string;
    risk: EnvironmentRisk;
    plannedWriteTier: EnvironmentWriteTier;
    secret: boolean;
    restartRequired: boolean;
    deploymentOnly: boolean;
    exposeValue: boolean;
};

const CATEGORY_KEYS: Record<string, readonly string[]> = {
    application: [
        "NODE_ENV",
        "PORT",
        "SWAGGER",
        "PUBLIC_BASE_URL",
        "PUBLIC_CONSOLE_URL",
        "BIND_HOST",
        "DEVICE_HISTORY_ENABLED",
        "PATCH_AUTOMATION_ENABLED",
        "PATCH_SCAN_EVERY_HOURS",
        "AVATAR_MAX_MB",
        "ADMIN_DATA_DIR",
    ],

    security: [
        "ADMIN_API_KEY",
        "ALLOWED_ORIGIN",
        "FRONTEND_ORIGINS",
        "AUTH_COOKIE_DOMAIN",
        "AUTH_COOKIE_MAX_AGE_MS",
        "AUTH_COOKIE_NAME",
        "JWT_EXPIRES",
        "JWT_SECRET",
        "PASSWORD_MIN_LEN",
        "SESSION_IDLE_UPDATE_SECS",
        "TOTP_ISSUER",
        "TOTP_WINDOW",
        "AGENT_DEV_BYPASS",
        "DATA_ENCRYPTION_KEY",
        "DATA_ENCRYPTION_KEY_FILE",
        "JOB_SIGNING_KEY_FILE",
        "ALLOW_PRIVATE_WEBHOOKS",
    ],

    database: [
        "DATABASE_URL",
        "DATABASE_SSL",
        "DATABASE_POOL_MAX",
        "DATABASE_POOL_MIN",
        "PG_URL",
        "PGHOST",
        "PGPORT",
        "PGDATABASE",
        "PGUSER",
        "PGPASSWORD",
        "PGSSL",
        "PG_DUMP_BIN",
        "PG_RESTORE_BIN",
        "PG_LOG_SQL",
    ],

    agents: [
        "ENROLLMENT_SECRET",
        "AGENT_PKG_DIR",
        "AGENT_PKG_LINUX_PATH",
        "AGENT_PKG_WINDOWS_PATH",
        "PUBLIC_API_BASE_URL",
        "INSTALLER_BASE_URL",
        "AGENT_UPDATES_ENABLED",
        "CHECK_RUNS_RETENTION_DAYS",
        "AUDIT_RETENTION_DAYS",
        "TURN_PROVIDER",
        "TURN_URLS",
        "TURN_AUTH_SECRET",
        "TURN_STUN_URLS",
        "CLOUDFLARE_TURN_KEY_ID",
        "CLOUDFLARE_TURN_API_TOKEN",
    ],

    backups: [
        "BACKUPS_WEBHOOK_URL",
        "SLACK_WEBHOOK_URL",
    ],

    email: [
        "DKIM_DOMAIN",
        "DKIM_KEY_SELECTOR",
        "DKIM_PRIVATE_KEY",
        "IMAP_MOVE_TO",
        "IMAP_POLL_ENABLED",
        "IMAP_POLL_EVERY_MS",
        "IMAP_POLL_MAX_PER_TICK",
        "IMAP_POLL_PURPOSE",
        "SEND_TEST_LIMIT",
        "SMTP_CONNECTION_TIMEOUT",
        "SMTP_GREETING_TIMEOUT",
        "SMTP_POOL",
        "SMTP_POOL_MAX_CONN",
        "SMTP_POOL_MAX_MSG",
        "SMTP_RATE_TOKENS",
        "SMTP_SOCKET_TIMEOUT",
        "SMTP_TEST_DOMAIN",
        "SMTP_TLS_REJECT_UNAUTHORIZED",
    ],

    remoteConsole: [
        "REMOTE_CONSOLE_IDLE_TTL_MS",
        "REMOTE_CONSOLE_TOKEN_TTL_MS",
    ],

    organizationBootstrap: [
        "DEFAULT_ORGANIZATION_NAME",
        "DEFAULT_ORGANIZATION_SLUG",
    ],

    postgresDeployment: [
        "POSTGRES_USER",
        "POSTGRES_DB",
        "POSTGRES_PORT",
        "POSTGRES_PASSWORD_FILE",
    ],
};

const SECRET_KEYS = new Set([
    "ADMIN_API_KEY",
    "BACKUPS_WEBHOOK_URL",
    "DATABASE_URL",
    "DATA_ENCRYPTION_KEY",
    "DKIM_PRIVATE_KEY",
    "ENROLLMENT_SECRET",
    "JWT_SECRET",
    "PGPASSWORD",
    "PG_URL",
    "SLACK_WEBHOOK_URL",
]);

/**
 * Host-trust values are intentionally never web-writable.
 *
 * They influence process startup, filesystem/executable paths, development
 * bypasses, low-level PostgreSQL behavior, or deployment bootstrap.
 */
const HOST_TRUST_KEYS = new Set([
    "NODE_ENV",
    "PORT",
    "SWAGGER",
    "ADMIN_DATA_DIR",

    "ADMIN_API_KEY",
    "JWT_SECRET",

    "AGENT_DEV_BYPASS",
    "DATA_ENCRYPTION_KEY",
    "DATA_ENCRYPTION_KEY_FILE",
    "JOB_SIGNING_KEY_FILE",
    "BIND_HOST",
    "AGENT_PKG_DIR",
    "AGENT_PKG_LINUX_PATH",
    "AGENT_PKG_WINDOWS_PATH",
    "PUBLIC_API_BASE_URL",

    "DEFAULT_ORGANIZATION_NAME",
    "DEFAULT_ORGANIZATION_SLUG",

    "PG_URL",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGSSL",
    "PG_DUMP_BIN",
    "PG_RESTORE_BIN",
    "PG_LOG_SQL",

    "POSTGRES_USER",
    "POSTGRES_DB",
    "POSTGRES_PORT",
    "POSTGRES_PASSWORD_FILE",
]);

const CRITICAL_KEYS = new Set([
    "ALLOWED_ORIGIN",
    "FRONTEND_ORIGINS",

    "AUTH_COOKIE_DOMAIN",
    "AUTH_COOKIE_MAX_AGE_MS",
    "AUTH_COOKIE_NAME",

    "JWT_EXPIRES",

    "PASSWORD_MIN_LEN",
    "SESSION_IDLE_UPDATE_SECS",
    "TOTP_ISSUER",
    "TOTP_WINDOW",

    "DATABASE_URL",
    "DATABASE_SSL",

    "ENROLLMENT_SECRET",

    "REMOTE_CONSOLE_IDLE_TTL_MS",
    "REMOTE_CONSOLE_TOKEN_TTL_MS",

    "SMTP_TLS_REJECT_UNAUTHORIZED",
]);

const SENSITIVE_KEYS = new Set([
    "BACKUPS_WEBHOOK_URL",
    "DKIM_PRIVATE_KEY",
    "SLACK_WEBHOOK_URL",
]);

const DEPLOYMENT_ONLY_KEYS = new Set([
    "INSTALLER_BASE_URL",
    "POSTGRES_USER",
    "POSTGRES_DB",
    "POSTGRES_PORT",
    "POSTGRES_PASSWORD_FILE",
]);

function riskFor(key: string): EnvironmentRisk {
    if (HOST_TRUST_KEYS.has(key)) return "host";
    if (CRITICAL_KEYS.has(key)) return "critical";
    if (SENSITIVE_KEYS.has(key)) return "sensitive";
    return "operational";
}

function writeTierFor(risk: EnvironmentRisk): EnvironmentWriteTier {
    switch (risk) {
        case "operational":
            return "operational";
        case "sensitive":
            return "sensitive";
        case "critical":
            return "critical";
        case "host":
            return "never";
    }
}

const definitions: EnvironmentDefinition[] = [];

for (const [category, keys] of Object.entries(CATEGORY_KEYS)) {
    for (const key of keys) {
        const risk = riskFor(key);
        const secret = SECRET_KEYS.has(key);

        definitions.push({
            key,
            category,
            risk,
            plannedWriteTier: writeTierFor(risk),
            secret,

            // Until we explicitly prove that a consumer supports safe
            // runtime reload, all future changes are restart-required.
            restartRequired: true,

            deploymentOnly: DEPLOYMENT_ONLY_KEYS.has(key),

            // Secrets and host-trust settings never reveal their raw value.
            exposeValue: !secret && risk !== "host",
        });
    }
}

const duplicateKeys = definitions
    .map((item) => item.key)
    .filter((key, index, all) => all.indexOf(key) !== index);

if (duplicateKeys.length > 0) {
    throw new Error(
        `Duplicate environment registry keys: ${[
            ...new Set(duplicateKeys),
        ].join(", ")}`,
    );
}

export const ENVIRONMENT_DEFINITIONS = Object.freeze(definitions);

export const ENVIRONMENT_KEYS = Object.freeze(
    definitions.map((definition) => definition.key),
);
