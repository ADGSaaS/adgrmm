// adgrmm-minimal-e2e/backend/src/auth/policy.ts
export type PermissionGroup = {
    key: string;
    label: string;
    items: readonly {
        key: string;
        label: string;
        description?: string;
    }[];
};

export const PERMISSION_GROUPS = [
    // ── Administration
    {
        key: "administration",
        label: "Administration",
        items: [
            {
                key: "admin.access",
                label: "Access admin dashboard",
                description: "View and access the Administration area.",
            },
        ] as const,
    },

    // ── Audit log
    {
        key: "audit",
        label: "Audit log",
        items: [
            {
                key: "audit.read",
                label: "View audit log",
                description: "View and export the record of who did what.",
            },
        ] as const,
    },

    // ── Users
    {
        key: "users",
        label: "Users",
        items: [
            { key: "users.read", label: "View users" },
            { key: "users.write", label: "Create/edit users" },
            { key: "users.delete", label: "Remove users" },
            { key: "users.2fa.reset", label: "Reset 2FA" },
        ] as const,
    },

    // ── Roles
    {
        key: "roles",
        label: "Roles",
        items: [
            { key: "roles.read", label: "View roles" },
            { key: "roles.write", label: "Create/edit roles" },
            { key: "roles.delete", label: "Delete roles" },
        ] as const,
    },

    // ── Groups
    {
        key: "groups",
        label: "Groups",
        items: [
            { key: "groups.read", label: "View groups", description: "See groups, their members, permissions and customer access." },
            { key: "groups.write", label: "Create/edit/delete groups", description: "Create groups, change who is in them, what they may do and which customers, sites and tags they can see." },
        ] as const,
    },

    // ── Billing
    {
        key: "billing",
        label: "Billing",
        items: [
            {
                key: "billing.read",
                label: "View billing",
                description: "View billing settings, plans, payment methods, and billing overview.",
            },
            {
                key: "billing.write",
                label: "Manage billing",
                description: "Update billing settings, payment methods, and billing configuration.",
            },
            {
                key: "subscription.read",
                label: "View subscription",
                description: "View subscription plan and subscription status.",
            },
            {
                key: "subscription.write",
                label: "Manage subscription",
                description: "Change subscription plan, seats, cancellations, etc.",
            },
            {
                key: "invoices.read",
                label: "View invoices",
                description: "View invoice history and invoice details.",
            },
            {
                key: "invoices.write",
                label: "Manage invoices",
                description: "Create/adjust invoices, issue refunds/credits (where applicable).",
            },
        ] as const,
    },

    // ── Documentation
    {
        key: "documentation",
        label: "Documentation",
        items: [
            { key: "assets.read", label: "View assets" },
            { key: "assets.write", label: "Manage assets" },
        ] as const,
    },

    // ── Customers / Orgs
    {
        key: "customers",
        label: "Customers",
        items: [
            { key: "customers.read", label: "View customers/sites" },
            {
                key: "customers.write",
                label: "Create/edit customers/sites",
                description: "Create and manage customers (clients) and their sites.",
            },
        ] as const,
    },

    // ── Policies
    {
        key: "policies",
        label: "Policies",
        items: [
            { key: "policies.read", label: "View policies", description: "See policies and what each device gets from them." },
            { key: "policies.write", label: "Create/edit policies", description: "Create, change, assign and delete policies." },
        ] as const,
    },

    // ── Devices
    {
        key: "devices",
        label: "Devices",
        items: [
            { key: "devices.read", label: "View devices" },
            {
                key: "devices.write",
                label: "Manage devices",
                description: "Update device properties (e.g., move device between sites within same client).",
            },
            {
                key: "devices.actions",
                label: "Run device actions",
                description: "Reboot, patch, uninstall software, etc.",
            },
            {
                key: "devices.delete",
                label: "Delete devices (approve/finalize)",
                description: "Approve and finalize deletion of a device endpoint.",
            },
            {
                key: "devices.tools.write",
                label: "Change services and processes on devices",
                description: "Start, stop and restart services, change how they start, and end processes from a device's Services / Processes / Event log tab. Reading them needs the right to run device actions.",
            },
            {
                key: "devices.registry.read",
                label: "Browse the registry of Windows devices",
                description: "Read-only look at a Windows device's registry (HKLM and the loaded user hives) from its Registry tab. Keys that hold security secrets are blocked and values named like passwords or keys are hidden. Every look and search is audited.",
            },
            {
                key: "devices.registry.write",
                label: "Change the registry of Windows devices",
                description: "Set or delete a value, create or delete an empty key, and undo those changes, from a device's Registry tab. Needs the rights to browse the registry and view devices as well. Dangerous keys are blocked, every change is recorded with its old value and audited (without data), and a change is never made on more than one device or key at a time. Not granted to any role by default: Owner holds it, an administrator needs it granted explicitly.",
            },
            {
                key: "devices.secrets.reveal",
                label: "View device secrets (BitLocker recovery keys, local administrator passwords)",
                description: "Reveal a BitLocker recovery key or the managed local administrator password of a Windows device, after giving a reason, and see the Secret access log. Every reveal is recorded with who, when and why (never the secret). Needs the right to view devices as well. Not granted to any role by default: Owner holds it, an administrator needs it granted explicitly.",
            },
            {
                key: "devices.secrets.manage",
                label: "Escrow BitLocker keys and rotate local administrator passwords",
                description: "Store a device's BitLocker recovery keys on this server now, and change its managed local administrator password now (one device, or many from the device list). It cannot reveal a secret and changes nothing else. Needs the right to view devices as well. Not granted to any role by default: Owner holds it, an administrator needs it granted explicitly.",
            },
            {
                key: "agents.release.manage",
                label: "Manage agent update rings and releases",
                description: "Put devices (or a customer's new devices) in the Pilot update ring or the Everyone ring, and promote a tested candidate agent build to every device or withdraw it (Administration > Agents & Endpoints > Releases). Promoting changes the agent on every device within hours. Not granted to any role by default: Owner holds it, an administrator needs it granted explicitly.",
            },
        ] as const,
    },

    // ── Checks
    {
        key: "checks",
        label: "Checks",
        items: [
            { key: "checks.read", label: "View checks and results" },
            { key: "checks.write", label: "Create/edit checks" },
            { key: "checks.delete", label: "Delete checks" },
            { key: "checks.run", label: "Run checks on-demand" },
        ] as const,
    },

    // ── Software
    {
        key: "software",
        label: "Software",
        items: [
            { key: "software.install", label: "Install and remove software on devices" },
        ] as const,
    },

    // ── Alerts
    {
        key: "alerts",
        label: "Alerts",
        items: [
            { key: "alerts.read", label: "View alerts" },
            { key: "alerts.manage", label: "Acknowledge/silence/resolve alerts" },
        ] as const,
    },

    // ── Tickets
    {
        key: "tickets",
        label: "Tickets",
        items: [
            { key: "tickets.read", label: "View tickets" },
            { key: "tickets.write", label: "Create/update tickets" },
            { key: "tickets.time.manual", label: "Add or change time by hand", description: "Type in time worked, or change a logged entry. The ticket timer needs only the right to work tickets." },
            {
                key: "tickets.canned.read",
                label: "View canned responses (admin)",
                description: "View canned responses configuration in Administration.",
            },
            {
                key: "tickets.canned.write",
                label: "Manage canned responses (admin)",
                description: "Create/edit/delete canned responses in Administration.",
            },
        ] as const,
    },

    // ── Knowledge base
    {
        key: "kb",
        label: "Knowledge base",
        items: [
            { key: "kb.read", label: "Read the knowledge base" },
            { key: "kb.write", label: "Write and manage knowledge base articles", description: "Create, edit, publish and delete articles and categories, see drafts and article history." },
        ] as const,
    },

    // ── Session recordings
    {
        key: "recordings",
        label: "Session recordings",
        items: [
            { key: "recordings.read", label: "View and download session recordings", description: "Watch recorded Remote Console sessions and see the list of them." },
            { key: "recordings.delete", label: "Delete session recordings and set how long they are kept", description: "Delete a recording, and change the retention period and storage limits." },
        ] as const,
    },

    // ── Schedule and dispatch
    {
        key: "schedule",
        label: "Schedule",
        items: [
            { key: "schedule.read", label: "View the schedule", description: "See the dispatch board and the visits on tickets." },
            { key: "schedule.write", label: "Book and change visits and availability", description: "Book, move and cancel visits, and edit working hours and time off." },
        ] as const,
    },

    // ── Automation
    {
        key: "automation",
        label: "Automation",
        items: [
            { key: "automation.run", label: "Run automation jobs" },
            { key: "automation.read", label: "View automation job status/logs" },
            { key: "automation.categories.manage", label: "Create and delete script categories", description: "Make new categories in the scripts manager and remove empty ones. Anyone who can write scripts can put a script in an existing category; only this right makes new categories." },
        ] as const,
    },

    // ── Me (self-service)
    {
        key: "me",
        label: "My Account",
        items: [
            { key: "me.read", label: "View my profile" },
            { key: "me.write", label: "Edit my profile" },
            {
                key: "me.security",
                label: "Manage my security",
                description: "Change password, 2FA, tokens, sessions, WebAuthn",
            },
        ] as const,
    },

    // ── Settings
    {
        key: "settings",
        label: "Settings",
        items: [
            { key: "settings.read", label: "View settings" },
            { key: "settings.write", label: "Manage settings" },
            {
                key: "settings.environment.read",
                label: "View system configuration",
                description: "View allowlisted environment and system configuration. Secret values are never returned.",
            },
            {
                key: "settings.environment.write",
                label: "Manage operational system configuration",
                description: "Change allowlisted non-sensitive operational system configuration.",
            },
            {
                key: "settings.environment.sensitive.write",
                label: "Manage sensitive system configuration",
                description: "Replace sensitive configuration and secrets. Requires step-up authentication.",
            },
            {
                key: "settings.environment.critical.write",
                label: "Manage critical system configuration",
                description: "Change critical trust, authentication, or database configuration. Requires strongest step-up authentication.",
            },
            {
                key: "integrations.manage",
                label: "Manage integrations, including who owns assets",
                description: "Switch the asset manager between the built-in one and an external one (Administration > Integrations), look at what the switch changes, and export the built-in assets. Switching turns off the built-in asset list, the agent sync and the expiry emails. Not granted to any role by default: Owner holds it, an administrator needs it granted explicitly.",
            },
        ] as const,
    },

    // ── Backups
    {
        key: "backups",
        label: "Backups",
        items: [
            { key: "backups.read", label: "View config and history" },
            { key: "backups.run", label: "Start, retry or cancel backups" },
            { key: "backups.prune", label: "Prune artifacts" },
            { key: "backups.manage", label: "Configure/test destinations" },
            { key: "backups.restore", label: "Initiate restores" },
            { key: "backups.download", label: "Download artifacts" },
        ] as const,
    },
] as const satisfies readonly PermissionGroup[];

type PermissionItem = (typeof PERMISSION_GROUPS)[number]["items"][number];
export type Permission = PermissionItem["key"];

export type PermissionDefinition = PermissionItem & {
    groupKey: string;
    groupLabel: string;
};

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = PERMISSION_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
        ...item,
        groupKey: group.key,
        groupLabel: group.label,
    }))
);

export const ALL_PERMISSIONS: Permission[] = PERMISSION_DEFINITIONS.map((d) => d.key);

export type Role = "owner" | "admin" | "operator" | "viewer";

export const rolePermissions: Record<Role, Permission[]> = {
    owner: [...ALL_PERMISSIONS],
    admin: ALL_PERMISSIONS.filter(
        // Changing a device's registry, and promoting an agent build to every device, are granted to an administrator explicitly in the
        // Roles screen (Owner holds them by rule; the permission catalog is synced at server start, which is also when Owner gets a new one).
        (permission) => permission !== "settings.environment.critical.write" && permission !== "devices.registry.write" && permission !== "devices.secrets.reveal" && permission !== "devices.secrets.manage" && permission !== "agents.release.manage" && permission !== "integrations.manage",
    ),
    operator: [
        "admin.access",
        "users.read",
        "roles.read",
        "groups.read",

        "billing.read",
        "subscription.read",
        "invoices.read",

        "customers.read",
        "customers.write",

        "policies.read",

        "devices.read",
        "devices.write",
        "devices.actions",
        "devices.delete",
        "devices.tools.write",

        "checks.read",
        "checks.run",
        "alerts.read",
        "alerts.manage",
        "tickets.read",
        "tickets.write",
        "tickets.time.manual",
        "schedule.read",
        "schedule.write",
        "kb.read",
        "automation.run",
        "automation.read",
        "assets.read",
        "assets.write",
        "settings.read",
        "backups.read",
        "backups.run",
        "backups.download",
    ],
    viewer: [
        "admin.access",
        "users.read",
        "roles.read",
        "groups.read",

        "billing.read",
        "subscription.read",
        "invoices.read",

        "customers.read",

        "policies.read",

        "devices.read",

        "checks.read",
        "alerts.read",
        "tickets.read",
        "schedule.read",
        "kb.read",
        "assets.read",
        "settings.read",
        "backups.read",
    ],
};

/**
 * The built-in roles. Their permissions are copied into the database once, and from then on the
 * database is the truth, so editing Operator or Viewer in the Roles screen really changes them.
 * Only Owner is different: it always holds every permission, so nobody can lock the account out.
 */
export const BUILT_IN_ROLES: readonly Role[] = ["owner", "admin", "operator", "viewer"];

export function isOwnerRoleName(name: unknown): boolean {
    return String(name ?? "").trim().toLowerCase() === "owner";
}

export function builtInDefaults(name: string): Permission[] | null {
    const key = String(name ?? "").trim().toLowerCase() as Role;
    return BUILT_IN_ROLES.includes(key) ? rolePermissions[key] : null;
}

/** Everything a person holds because of their role names alone: only Owner, which is all of it. */
export function permsForRoles(roles: string[] | undefined | null): Set<Permission> {
    const out = new Set<Permission>();
    if (roles?.some(isOwnerRoleName)) ALL_PERMISSIONS.forEach((p) => out.add(p));
    return out;
}

export function hasPerm(roles: string[] | undefined | null, perm: Permission): boolean {
    return permsForRoles(roles).has(perm);
}
