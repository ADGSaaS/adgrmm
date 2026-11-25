// backend/src/admin/environment.descriptions.ts
//
// A plain-words description for every server setting in the environment registry, for the Secrets and
// Environment screen. Descriptions say what a setting is for. They never hold a value, a default that is a
// secret, or an example of one.

import { ENVIRONMENT_DEFINITIONS } from "./environment.registry";

export type Importance = "required" | "recommended" | "optional";

/** Settings the server cannot sensibly run without, or that a production server should have. */
const REQUIRED = new Set(["JWT_SECRET", "DATABASE_URL"]);
const RECOMMENDED = new Set(["DATA_ENCRYPTION_KEY", "DATA_ENCRYPTION_KEY_FILE", "PUBLIC_BASE_URL", "FRONTEND_ORIGINS"]);

/** Settings that are an alternative to another. When one of a pair is set, the other being unset is not a gap. */
const ALTERNATIVES: Record<string, string[]> = {
    DATABASE_URL: ["PG_URL", "PGHOST"],
    DATA_ENCRYPTION_KEY: ["DATA_ENCRYPTION_KEY_FILE"],
    DATA_ENCRYPTION_KEY_FILE: ["DATA_ENCRYPTION_KEY"],
};

const D: Record<string, string> = {
    // application
    NODE_ENV: "Whether the server runs as production. Anything other than production turns on development behaviour.",
    PORT: "The port the API listens on.",
    SWAGGER: "Serves the API documentation pages. Leave off on a server that people can reach.",
    PUBLIC_BASE_URL: "The address people use to reach the web app. Used in links in emails and in redirects.",
    PUBLIC_CONSOLE_URL: "The web app address put in alert notifications so a link opens the right device.",
    BIND_HOST: "The network address the API listens on. A packaged install sets it so the API is reachable only from this machine.",
    AVATAR_MAX_MB: "The largest profile picture people may upload, in megabytes.",
    ADMIN_DATA_DIR: "The folder where the server keeps files it writes itself.",
    DEVICE_HISTORY_ENABLED: "Set to false to stop the daily recording of each device's history for reports.",
    PATCH_AUTOMATION_ENABLED: "Set to false to stop the scheduled patch scans and automatic patch approvals.",
    PATCH_SCAN_EVERY_HOURS: "How often devices are asked to scan for missing patches.",

    // security
    ADMIN_API_KEY: "A break-glass key that bypasses permission checks when sent in a header. Keep it unset unless automation needs it.",
    ALLOWED_ORIGIN: "The one web address allowed to call the API from a browser.",
    FRONTEND_ORIGINS: "The web addresses allowed to call the API from a browser, separated by commas.",
    AUTH_COOKIE_DOMAIN: "The domain the sign-in cookie is shared with.",
    AUTH_COOKIE_MAX_AGE_MS: "How long a sign-in cookie lasts, in milliseconds.",
    AUTH_COOKIE_NAME: "The name of the sign-in cookie. Each installation can have its own.",
    JWT_EXPIRES: "How long a sign-in token is valid before it must be renewed.",
    JWT_SECRET: "The key that signs sign-in tokens. Anyone who has it can sign in as anyone, so it is never shown.",
    PASSWORD_MIN_LEN: "The shortest password the server accepts.",
    SESSION_IDLE_UPDATE_SECS: "How often an open session's last-seen time is refreshed.",
    TOTP_ISSUER: "The name shown in authenticator apps for two-factor sign-in.",
    TOTP_WINDOW: "How many 30-second steps either side of now a two-factor code is accepted.",
    AGENT_DEV_BYPASS: "Development switch that relaxes agent authentication. Must be unset on a real server.",
    DATA_ENCRYPTION_KEY: "The key that protects secrets stored in the database (mail passwords, storage keys, backup keys). Losing it means those secrets must be entered again.",
    DATA_ENCRYPTION_KEY_FILE: "The path of a file holding the data encryption key, used instead of putting the key in the environment.",
    JOB_SIGNING_KEY_FILE: "The path of the key file that signs the jobs sent to agents, so an agent only runs what this server sent.",
    ALLOW_PRIVATE_WEBHOOKS: "Lets notification webhooks point at private network addresses. Off by default so a webhook cannot be aimed at internal services.",

    // database
    DATABASE_URL: "How the server connects to PostgreSQL: host, database and sign-in. Contains a password, so it is never shown.",
    DATABASE_SSL: "Whether the connection to PostgreSQL uses TLS.",
    DATABASE_POOL_MAX: "The most database connections the server holds open.",
    DATABASE_POOL_MIN: "The fewest database connections the server keeps open.",
    PG_URL: "An alternative database connection address. Contains a password, so it is never shown.",
    PGHOST: "The PostgreSQL host, when the connection is given in parts instead of one address.",
    PGPORT: "The PostgreSQL port, when the connection is given in parts.",
    PGDATABASE: "The PostgreSQL database name, when the connection is given in parts.",
    PGUSER: "The PostgreSQL user, when the connection is given in parts.",
    PGPASSWORD: "The PostgreSQL password, when the connection is given in parts. Never shown.",
    PGSSL: "Whether PostgreSQL connections use TLS, when the connection is given in parts.",
    PG_DUMP_BIN: "The path of the pg_dump program used for backups.",
    PG_RESTORE_BIN: "The path of the pg_restore program used for restores.",
    PG_LOG_SQL: "Logs every database statement. Only for troubleshooting; it fills logs quickly.",

    // agents
    ENROLLMENT_SECRET: "An old shared secret that lets an agent enrol on a development server. A production server ignores it; enrolment there uses install keys.",
    AGENT_PKG_DIR: "The folder holding the agent installers the server offers for download and automatic update.",
    AGENT_PKG_LINUX_PATH: "The path of the Linux agent package, when it is not in the package folder.",
    AGENT_PKG_WINDOWS_PATH: "The path of the Windows agent package, when it is not in the package folder.",
    PUBLIC_API_BASE_URL: "The address agents use to reach the API, put into installers.",
    INSTALLER_BASE_URL: "The address install scripts download from.",
    AGENT_UPDATES_ENABLED: "Whether agents are offered new versions automatically.",
    CHECK_RUNS_RETENTION_DAYS: "How many days of check results are kept.",
    AUDIT_RETENTION_DAYS: "How many days of the audit log are kept. A year when not set.",
    TURN_PROVIDER: "Which relay service remote desktop uses when two computers cannot connect directly.",
    TURN_URLS: "The relay server addresses for remote desktop.",
    TURN_AUTH_SECRET: "The shared secret for the relay server. Never shown.",
    TURN_STUN_URLS: "The address-discovery servers remote desktop uses.",
    CLOUDFLARE_TURN_KEY_ID: "The Cloudflare relay key's identifier.",
    CLOUDFLARE_TURN_API_TOKEN: "The Cloudflare relay API token. Never shown.",

    // backups
    BACKUPS_WEBHOOK_URL: "Where backup results are posted. The address can contain a secret, so it is never shown.",
    SLACK_WEBHOOK_URL: "Where alerts are posted in Slack. The address is a secret, so it is never shown.",

    // email
    DKIM_DOMAIN: "The domain outgoing mail is DKIM-signed for.",
    DKIM_KEY_SELECTOR: "The DKIM selector published in DNS.",
    DKIM_PRIVATE_KEY: "The private key that signs outgoing mail. Never shown.",
    IMAP_MOVE_TO: "The folder processed support emails are moved to.",
    IMAP_POLL_ENABLED: "Whether the server checks the mailbox for new messages.",
    IMAP_POLL_EVERY_MS: "How often the mailbox is checked, in milliseconds.",
    IMAP_POLL_MAX_PER_TICK: "The most messages taken from the mailbox in one check.",
    IMAP_POLL_PURPOSE: "Which mail settings the mailbox check uses.",
    SEND_TEST_LIMIT: "How many test emails may be sent in a short time.",
    SMTP_CONNECTION_TIMEOUT: "How long to wait to connect to the mail server.",
    SMTP_GREETING_TIMEOUT: "How long to wait for the mail server's greeting.",
    SMTP_POOL: "Whether mail connections are reused.",
    SMTP_POOL_MAX_CONN: "The most mail connections open at once.",
    SMTP_POOL_MAX_MSG: "The most messages sent on one mail connection.",
    SMTP_RATE_TOKENS: "How many emails may be sent per second.",
    SMTP_SOCKET_TIMEOUT: "How long a mail connection may stay silent.",
    SMTP_TEST_DOMAIN: "The domain used when testing mail settings.",
    SMTP_TLS_REJECT_UNAUTHORIZED: "Whether a mail server with an untrusted certificate is refused. Turning it off weakens security.",

    // remote console
    REMOTE_CONSOLE_IDLE_TTL_MS: "How long a remote console may sit idle before it closes, in milliseconds.",
    REMOTE_CONSOLE_TOKEN_TTL_MS: "How long the link that opens a remote console works, in milliseconds.",

    // bootstrap
    DEFAULT_ORGANIZATION_NAME: "The organization name given on first start, before it is changed in Company settings.",
    DEFAULT_ORGANIZATION_SLUG: "The short name that identifies the organization in the database.",

    // postgres deployment
    POSTGRES_USER: "The user the packaged PostgreSQL container is created with.",
    POSTGRES_DB: "The database the packaged PostgreSQL container is created with.",
    POSTGRES_PORT: "The port the packaged PostgreSQL listens on.",
    POSTGRES_PASSWORD_FILE: "The path of the file holding the packaged PostgreSQL password.",
};

const CATEGORY_LABEL: Record<string, string> = {
    application: "Application",
    security: "Security",
    database: "Database",
    agents: "Agents",
    backups: "Backups",
    email: "Email",
    remoteConsole: "Remote console",
    organizationBootstrap: "First start",
    postgresDeployment: "Packaged database",
};

export function describeEnvironmentKey(key: string): string {
    return D[key] ?? "A server setting. See the deployment documentation.";
}

export function importanceOf(key: string): Importance {
    return REQUIRED.has(key) ? "required" : RECOMMENDED.has(key) ? "recommended" : "optional";
}

/** What the screen shows for each setting. Names and whether each is set, never a value, not even part of one. */
export type SecretsStatusItem = {
    key: string;
    category: string;
    description: string;
    set: boolean;
    secret: boolean;
    importance: Importance;
    /** True for a required or recommended setting that is not set and has no alternative that is. */
    attention: boolean;
    restartRequired: boolean;
    configuredIn: string;
};

export function secretsStatus(env: NodeJS.ProcessEnv = process.env) {
    const isSet = (k: string) => typeof env[k] === "string" && (env[k] as string).length > 0;
    const items: SecretsStatusItem[] = ENVIRONMENT_DEFINITIONS.map((d) => {
        const set = isSet(d.key);
        const importance = importanceOf(d.key);
        const covered = (ALTERNATIVES[d.key] ?? []).some(isSet);
        return {
            key: d.key,
            category: CATEGORY_LABEL[d.category] ?? d.category,
            description: describeEnvironmentKey(d.key),
            set,
            secret: d.secret,
            importance,
            attention: !set && !covered && importance !== "optional",
            restartRequired: d.restartRequired,
            configuredIn: d.deploymentOnly ? "The install or deployment configuration" : "The server's environment (its service file, .env file or container settings). It is not editable here.",
        };
    });
    return {
        generatedAt: new Date().toISOString(),
        readOnly: true as const,
        summary: {
            total: items.length,
            set: items.filter((i) => i.set).length,
            unset: items.filter((i) => !i.set).length,
            secretsSet: items.filter((i) => i.secret && i.set).length,
            needAttention: items.filter((i) => i.attention).length,
        },
        items,
    };
}
