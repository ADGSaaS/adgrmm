// backend/src/audit/audit-routes.ts

/**
 * Maps routes to readable audit actions. `fields` is an allow-list of request body fields that are
 * safe to keep: anything not named here (passwords, tokens, script text, file contents) never
 * reaches the audit table.
 */
export type AuditRule = {
    action: string;
    category: string;
    targetType?: string;
    /** Where the target id comes from, tried in this order: route param, body fields, response field. */
    targetParam?: string;
    targetBody?: string[];
    targetResponse?: string;
    /** Used as the label when the target has no record to look a name up from. */
    labelBody?: string;
    fields?: string[];
    /** Read-only POSTs, and routes that record their own, more accurate event. */
    skip?: boolean;
};

const device = (action: string, extra: Partial<AuditRule> = {}): AuditRule => ({
    action,
    category: "device",
    targetType: "device",
    targetParam: "id",
    ...extra,
});

const file = (action: string, fields: string[]): AuditRule => ({
    action,
    category: "file",
    targetType: "device",
    targetParam: "id",
    fields,
});

const user = (action: string, extra: Partial<AuditRule> = {}): AuditRule => ({
    action,
    category: "user",
    targetType: "user",
    targetParam: "id",
    ...extra,
});

const account = (action: string, extra: Partial<AuditRule> = {}): AuditRule => ({
    action,
    category: "account",
    ...extra,
});

const ticket = (action: string, extra: Partial<AuditRule> = {}): AuditRule => ({
    action,
    category: "ticket",
    targetType: "ticket",
    targetParam: "id",
    ...extra,
});

const backup = (action: string, extra: Partial<AuditRule> = {}): AuditRule => ({
    action,
    category: "backup",
    ...extra,
});

const email = (action: string, fields?: string[]): AuditRule => ({ action, category: "email", fields });

const settings = (action: string): AuditRule => ({ action, category: "settings" });

const storage = (action: string, extra: Partial<AuditRule> = {}): AuditRule => ({
    action,
    category: "storage",
    targetType: "storage_connection",
    ...extra,
});

const signIn: AuditRule = { action: "auth.signin", category: "auth", skip: true };
const signOut: AuditRule = { action: "auth.signout", category: "auth", skip: true };

const TICKET_FIELDS = ["subject", "title", "status", "priority", "customerId", "assigneeUserId", "deviceId", "dueAt", "customFields", "queueId"];
const REMOTE_DESKTOP_FIELDS = ["deviceId", "agentUuid", "host", "port"];

const RULES: Record<string, AuditRule> = {
    // Sign-in, 2FA at sign-in and sign-out are recorded by the auth controllers, which know the outcome.
    "POST /api/auth/login": signIn,
    "POST /api/auth/2fa/verify": signIn,
    "POST /api/auth/logout": signOut,
    "POST /api/auth-legacy/login": signIn,
    "POST /api/auth-legacy/2fa/verify": signIn,
    "POST /api/auth-legacy/logout": signOut,

    // My account
    "PATCH /api/users/me": account("account.profile.update"),
    "POST /api/users/me/avatar": account("account.avatar.update"),
    "DELETE /api/users/me/avatar": account("account.avatar.delete"),
    "POST /api/users/me/password": { action: "auth.password.change", category: "auth" },
    "POST /api/users/me/2fa/start": { action: "auth.2fa.start", category: "auth" },
    "POST /api/users/me/2fa/confirm": { action: "auth.2fa.enable", category: "auth" },
    "POST /api/users/me/2fa/disable": { action: "auth.2fa.disable", category: "auth" },
    "POST /api/users/me/2fa/recovery/regen": { action: "auth.2fa.recovery_codes.regenerate", category: "auth" },
    "POST /api/users/me/sessions/:id/trust": account("account.session.trust", { targetType: "session", targetParam: "id", fields: ["trusted"] }),
    "DELETE /api/users/me/sessions/:id": account("account.session.revoke", { targetType: "session", targetParam: "id" }),
    "POST /api/users/me/sessions/revoke": account("account.session.revoke", { targetType: "session", targetBody: ["sessionId"] }),
    "POST /api/users/me/sessions/revoke-all": account("account.session.revoke_all"),
    "POST /api/users/me/tokens": account("account.token.create", { fields: ["name"] }),
    "POST /api/users/me/tokens/revoke": account("account.token.revoke", { targetType: "token", targetBody: ["id"] }),
    "POST /api/users/me/webauthn/finish": account("account.webauthn.add"),
    "DELETE /api/users/me/webauthn/:id": account("account.webauthn.delete", { targetType: "webauthn", targetParam: "id" }),

    // Users
    "POST /api/admin/users/invite": user("user.invite", { targetParam: undefined, targetResponse: "id", labelBody: "email", fields: ["email", "name", "role", "roleId"] }),
    "POST /api/admin/users/invite/bulk": user("user.invite_bulk", { targetParam: undefined }),
    "POST /api/admin/users/create": user("user.create", { targetParam: undefined, targetResponse: "id", labelBody: "email", fields: ["email", "name", "role", "roleId", "status"] }),
    "PATCH /api/admin/users/:id/role": user("user.role.change", { fields: ["role", "roleId"] }),
    "PATCH /api/admin/users/:id": user("user.update", { fields: ["name", "email", "role", "roleId", "status"] }),
    "PATCH /api/admin/users/:id/password": user("user.password.reset"),
    "POST /api/admin/users/:id/password": user("user.password.reset"),
    "POST /api/admin/users/:id/reset-2fa": user("user.2fa.reset"),
    "POST /api/admin/users/:id/suspend": user("user.suspend", { fields: ["suspended"] }),
    "DELETE /api/admin/users/:id": user("user.delete"),

    "PUT /api/admin/users/:id/groups": user("user.groups.change", { fields: ["groupIds"] }),

    // Groups
    "POST /api/admin/groups": { action: "group.create", category: "group", targetType: "group", targetResponse: "id", labelBody: "name", fields: ["name", "description", "permissions", "scope", "memberIds"] },
    "PATCH /api/admin/groups/:id": { action: "group.update", category: "group", targetType: "group", targetParam: "id", fields: ["name", "description", "permissions", "scope", "memberIds"] },
    "DELETE /api/admin/groups/:id": { action: "group.delete", category: "group", targetType: "group", targetParam: "id" },

    "POST /api/devices/:id/check-definitions": { action: "check.create", category: "check", targetType: "device", targetParam: "id", labelBody: "name", fields: ["name", "kind", "intervalMinutes", "enabled", "severity", "warn", "crit", "path", "service", "process", "host", "port"] },
    "PUT /api/devices/:id/check-definitions/:checkId": { action: "check.update", category: "check", targetType: "device", targetParam: "id", labelBody: "name", fields: ["name", "kind", "intervalMinutes", "enabled", "severity", "warn", "crit", "path", "service", "process", "host", "port"] },
    "DELETE /api/devices/:id/check-definitions/:checkId": { action: "check.delete", category: "check", targetType: "device", targetParam: "id" },

    "POST /api/software-library": { action: "software.library.create", category: "software", targetType: "software_library", targetResponse: "id", labelBody: "name", fields: ["name", "category", "matchText", "chocolateyId", "wingetId", "installerUrl", "installerKind", "linuxPackage"] },
    "PATCH /api/software-library/:id": { action: "software.library.update", category: "software", targetType: "software_library", targetParam: "id", labelBody: "name", fields: ["name", "category", "matchText", "chocolateyId", "wingetId", "installerUrl", "installerKind", "linuxPackage"] },
    "DELETE /api/software-library/:id": { action: "software.library.delete", category: "software", targetType: "software_library", targetParam: "id" },
    "POST /api/software-library/:id/install-preview": { action: "software.preview", category: "software", skip: true },
    "POST /api/software-library/fix-plan": { action: "software.fixplan", category: "software", skip: true },
    // Third-party software patching: scans, updates and the allow / never-update lists
    "POST /api/software-updates/scan": { action: "software.updates.scan", category: "software", fields: ["deviceIds"] },
    "POST /api/software-updates/update": { action: "software.updates.update", category: "software", fields: ["deviceIds", "apps", "all"] },
    "POST /api/software-updates/preview": { action: "software.updates.preview", category: "software", skip: true },
    "POST /api/software-updates/rules": { action: "software.updates.rule", category: "software", targetType: "software_update_rule", targetResponse: "id", labelBody: "appId", fields: ["rule", "source", "appId", "name", "clientId"] },
    "DELETE /api/software-updates/rules/:id": { action: "software.updates.rule.delete", category: "software", targetType: "software_update_rule", targetParam: "id" },
    "PUT /api/support-mailbox": email("support_mailbox.update", ["source", "tenantId", "clientId", "enabled"]),
    "POST /api/support-mailbox/connect": email("support_mailbox.connect"),
    "POST /api/support-mailbox/disconnect": email("support_mailbox.disconnect"),
    "POST /api/support-mailbox/check-now": { action: "support_mailbox.check", category: "email", skip: true },
    "POST /api/software-library/:id/install": { action: "software.install", category: "software", targetType: "software_library", targetParam: "id", fields: ["action", "deviceIds", "force"] },
    "POST /api/devices/:deviceId/software/install": { action: "software.install", category: "software", targetType: "device", targetParam: "deviceId", fields: ["libraryId", "action", "runAs", "force"] },
    "POST /api/devices/:deviceId/checks/run": { action: "check.run", category: "check", targetType: "device", targetParam: "deviceId", fields: ["keys"] },

    // Roles
    "POST /api/roles": { action: "role.create", category: "role", targetType: "role", targetResponse: "id", labelBody: "name", fields: ["name", "description", "permissions"] },
    "PATCH /api/roles/:id": { action: "role.update", category: "role", targetType: "role", targetParam: "id", fields: ["name", "description", "permissions"] },
    "POST /api/roles/:id/duplicate": { action: "role.duplicate", category: "role", targetType: "role", targetResponse: "id", labelBody: "name", fields: ["name"] },
    "DELETE /api/roles/:id": { action: "role.delete", category: "role", targetType: "role", targetParam: "id" },

    // Devices
    "POST /api/devices/:id/actions/reboot": device("device.reboot", { fields: ["reason"] }),
    "POST /api/devices/:id/actions/patch": device("device.patch", { fields: ["reason"] }),
    "POST /api/devices/:id/actions/uninstall": device("device.software.uninstall", { fields: ["name", "version"] }),
    "POST /api/devices/:id/actions/update-agent": device("device.agent.update"),
    "POST /api/devices/:id/deletion-requests": device("device.deletion.request", { fields: ["reason", "createTicket"] }),
    "POST /api/devices/:id/deletion-requests/approve": device("device.deletion.approve"),
    "PATCH /api/devices/:id/site": device("device.site.move", { fields: ["siteId"] }),
    "POST /api/patches/scan": device("device.patch.scan", { targetParam: undefined, targetBody: ["deviceId"], fields: ["includeOptional"] }),
    "POST /api/patches/install": device("device.patch.install", { targetParam: undefined, targetBody: ["deviceId"], fields: ["includeOptional", "ids"] }),

    // Scripts. The script text and its arguments can hold secrets, so only the context is kept.
    "POST /api/automation/runs": { action: "script.run", category: "script", targetType: "device", targetBody: ["deviceId"], fields: ["shell", "timeoutSec"] },
    // Services and processes on a device (the lists and the event log are recorded by the controller, which knows what was asked for).
    "POST /api/devices/:id/tools/services/action": device("device.service.change", { fields: ["name", "action", "startType", "force"] }),
    "POST /api/devices/:id/tools/processes/end": device("device.process.end", { fields: ["pid", "force"] }),
    // Registry changes record their own event (path, value NAME and types, never any data), so the generic one is skipped; a refusal by the
    // permission guard is still recorded from these rules.
    "PUT /api/devices/:id/tools/registry/value": device("device.registry.set", { skip: true }),
    "DELETE /api/devices/:id/tools/registry/value": device("device.registry.delete-value", { skip: true }),
    "POST /api/devices/:id/tools/registry/key": device("device.registry.create-key", { skip: true }),
    "DELETE /api/devices/:id/tools/registry/key": device("device.registry.delete-key", { skip: true }),
    "POST /api/devices/:id/tools/registry/changes/:changeId/undo": device("device.registry.undo", { skip: true }),
    // Bulk device actions record one event for the batch themselves (with every device's result), so the generic one is skipped.
    "POST /api/devices/:id/security/scan": device("device.security.scan", { skip: true }),
    "POST /api/devices/:id/security/defender/:action": device("device.security.defender", { skip: true }),
    // Device secrets record their own events (kind, label and reason, never a value).
    "POST /api/devices/:id/secrets/:secretId/reveal": device("device.secret.reveal", { skip: true }),
    "POST /api/devices/:id/secrets/escrow": device("device.secret.escrow", { skip: true }),
    "POST /api/devices/:id/secrets/rotate": device("device.secret.rotate", { skip: true }),
    "POST /api/bulk/devices/escrow-bitlocker": { action: "device.bulk.escrow-bitlocker", category: "device", skip: true },
    "POST /api/bulk/devices/rotate-laps-password": { action: "device.bulk.rotate-laps-password", category: "device", skip: true },
    "POST /api/bulk/devices/security-scan": { action: "device.bulk.security-scan", category: "device", skip: true },
    "POST /api/bulk/devices/reboot": { action: "device.bulk.reboot", category: "device", skip: true },
    "POST /api/bulk/devices/patch-scan": { action: "device.bulk.patch-scan", category: "device", skip: true },
    "POST /api/bulk/devices/patch-install": { action: "device.bulk.patch-install", category: "device", skip: true },
    "POST /api/bulk/devices/update-agent": { action: "device.bulk.update-agent", category: "device", skip: true },
    "POST /api/bulk/devices/run-script": { action: "device.bulk.run-script", category: "device", skip: true },
    "POST /api/scripts/categories": { action: "script.category.create", category: "automation", targetType: "script_category", labelBody: "name", fields: ["name"] },
    "DELETE /api/scripts/categories/:id": { action: "script.category.delete", category: "automation", targetType: "script_category", targetParam: "id" },
    "POST /api/scripts/:id/reset": { action: "script.reset-builtin", category: "automation", targetType: "script", targetParam: "id" },
    "POST /api/bulk/devices/run-saved-script": { action: "device.bulk.run-saved-script", category: "device", skip: true },
    "POST /api/bulk/devices/recover-agent": { action: "device.bulk.recover-agent", category: "device", skip: true },
    "POST /api/tools/preview": { action: "tools.preview", category: "admin", skip: true },
    "POST /api/tools/command": { action: "tools.command", category: "device", skip: true },
    "POST /api/tools/script": { action: "tools.script", category: "device", skip: true },
    "POST /api/tools/patches": { action: "tools.patches", category: "device", skip: true },
    "POST /api/tools/recover-agents": { action: "tools.recover-agents", category: "device", skip: true },
    "POST /api/tools/maintenance/preview": { action: "tools.maintenance.preview", category: "admin", skip: true },
    "POST /api/tools/maintenance/run": { action: "tools.maintenance", category: "admin", skip: true },
    "POST /api/tools/clear-cache": { action: "tools.clear-cache", category: "admin", skip: true },
    "POST /api/bulk/devices/move-site": { action: "device.bulk.move-site", category: "device", skip: true },
    "POST /api/bulk/devices/tags": { action: "device.bulk.tags", category: "device", skip: true },
    "POST /api/bulk/devices/set-ring": { action: "agents.ring.bulk", category: "device", skip: true },
    "POST /api/bulk/devices/delete-request": { action: "device.bulk.delete-request", category: "device", skip: true },
    "POST /api/automation/legacy/runs": { action: "script.run", category: "script", targetType: "device", targetBody: ["deviceId", "agentId", "agentUuid"], fields: ["shell", "language", "timeoutSec"] },
    "POST /api/admin/jobs/run-script": { action: "script.run", category: "script", targetType: "device", targetBody: ["agentId", "agentUuid"], fields: ["language", "timeoutSec"] },

    // Files on devices. Contents are never kept, only where the change happened.
    "POST /api/devices/:id/files/write": file("file.write", ["path"]),
    "POST /api/devices/:id/files/mkdir": file("file.mkdir", ["path"]),
    "POST /api/devices/:id/files/delete": file("file.delete", ["path", "recursive"]),
    "POST /api/devices/:id/files/move": file("file.move", ["from", "to"]),
    "POST /api/devices/:id/files/copy": file("file.copy", ["from", "to", "recursive"]),
    "POST /api/admin/jobs/file-op": { action: "file.operation", category: "file", targetType: "device", targetBody: ["agentId", "agentUuid"], fields: ["op", "path", "path2", "recursive"] },

    // Remote sessions. The remote shell opens over a WebSocket and records its own event.
    "POST /api/remote-console/sessions": { action: "remote.console.start", category: "remote", targetType: "device", targetBody: ["agentId"] },
    "PATCH /api/customers/:client/remote-console": { action: "customer.remote_console.update", category: "remote", targetType: "customer", targetParam: "client", fields: ["consent", "record"] },

    // Session recordings. Viewing and downloading are recorded by the recording service itself, once per request.
    "POST /api/remote-recordings": { action: "recording.start", category: "remote", targetType: "recording", targetResponse: "id", fields: ["sessionId"] },
    // One chunk arrives every few seconds, so these are not listed one by one: starting and finishing are.
    "POST /api/remote-recordings/:id/chunks": { action: "recording.chunk", category: "remote", targetType: "recording", targetParam: "id", skip: true },
    "POST /api/remote-recordings/:id/finish": { action: "recording.finish", category: "remote", targetType: "recording", targetParam: "id", fields: ["durationMs"] },
    "DELETE /api/remote-recordings/:id": { action: "recording.delete", category: "remote", targetType: "recording", targetParam: "id" },
    "POST /api/remote-recordings/cleanup": { action: "recording.cleanup", category: "remote" },
    "PATCH /api/remote-recordings/settings": { action: "recording.settings.update", category: "remote", fields: ["retentionDays", "maxRecordingMb", "quotaGb"] },
    "POST /api/remote-desktop/sessions": { action: "remote.desktop.start", category: "remote", targetType: "device", targetBody: ["deviceId", "agentUuid"], fields: REMOTE_DESKTOP_FIELDS },
    "DELETE /api/remote-desktop/sessions/:sessionId": { action: "remote.desktop.close", category: "remote", targetType: "remote_session", targetParam: "sessionId" },
    "POST /api/remote-desktop/dev/open-tunnel": { action: "remote.desktop.tunnel.open", category: "remote", targetType: "device", targetBody: ["deviceId", "agentUuid"], fields: REMOTE_DESKTOP_FIELDS },
    "POST /api/remote-desktop/dev/close-tunnel": { action: "remote.desktop.tunnel.close", category: "remote", targetType: "remote_session", targetBody: ["sessionId"] },

    // Customers and sites. A route's :client and :site can be a name or an id.
    "POST /api/customers": { action: "customer.create", category: "customer", targetType: "customer", targetResponse: "id", labelBody: "name", fields: ["name"] },
    "DELETE /api/customers/:client": { action: "customer.delete", category: "customer", targetType: "customer", targetParam: "client" },
    "POST /api/customers/:client/sites": { action: "site.create", category: "customer", targetType: "site", targetResponse: "id", labelBody: "name", fields: ["name"] },
    "DELETE /api/customers/:client/sites/:site": { action: "site.delete", category: "customer", targetType: "site", targetParam: "site" },

    // Installers and enrollment. Enrollment keys and secrets are never kept.
    "POST /api/provisioning/endpoints": { action: "provisioning.endpoint.create", category: "provisioning", targetType: "device", targetResponse: "deviceId", labelBody: "alias", fields: ["clientId", "siteId", "os", "alias", "expiresMinutes"] },
    "POST /api/provisioning/enrollment-keys": { action: "provisioning.enrollment_key.create", category: "provisioning", targetType: "enrollment_key", targetResponse: "tokenId", labelBody: "name", fields: ["clientId", "siteId", "name", "expiresMinutes"] },
    "POST /api/provisioning/enrollment-keys/:id/revoke": { action: "provisioning.enrollment_key.revoke", category: "provisioning", targetType: "enrollment_key", targetParam: "id" },
    "PATCH /api/provisioning/enrollment-keys/:id": { action: "provisioning.enrollment_key.rename", category: "provisioning", targetType: "enrollment_key", targetParam: "id", labelBody: "name", fields: ["name"] },
    "POST /api/provisioning/installer-bundles": { action: "provisioning.installer.create", category: "provisioning", targetType: "installer", targetResponse: "bundleId", labelBody: "label", fields: ["os", "label", "onlyIfMissing"] },

    // Email settings. Profiles hold server passwords, so nothing from the body is kept for them.
    "POST /api/admin/email/save": email("email.settings.update"),
    "POST /api/admin/email/test-smtp": email("email.test.smtp", ["profile"]),
    "POST /api/admin/email/test-imap": email("email.test.imap", ["profile"]),
    "POST /api/admin/email/test-pop": email("email.test.pop", ["profile"]),
    "POST /api/admin/email/send-test": email("email.test.send", ["profile", "to"]),
    "POST /api/admin/email/dkim": email("email.dkim.update", ["domain", "selector"]),

    // Storage settings. Connection configs hold credentials.
    "POST /api/admin/storage/connections": storage("storage.connection.create", { targetResponse: "id", labelBody: "name", fields: ["name", "kind"] }),
    "PUT /api/admin/storage/connections/:id": storage("storage.connection.update", { targetParam: "id", fields: ["name", "kind"] }),
    "DELETE /api/admin/storage/connections/:id": storage("storage.connection.delete", { targetParam: "id" }),
    "POST /api/admin/storage/test": storage("storage.connection.test", { fields: ["kind"] }),
    "POST /api/admin/storage/browse": storage("storage.connection.browse", { skip: true }),
    "POST /api/storage/connections/import": storage("storage.connection.import"),

    // Backups
    "PUT /api/admin/backups/config": backup("backup.config.update"),
    "POST /api/admin/backups/run": backup("backup.run"),
    "POST /api/admin/backups/prune": backup("backup.prune"),
    "POST /api/admin/backups/test-destination": backup("backup.destination.test"),
    "POST /api/admin/backups/:id/retry": backup("backup.retry", { targetType: "backup", targetParam: "id" }),
    "POST /api/admin/backups/:id/cancel": backup("backup.cancel", { targetType: "backup", targetParam: "id" }),
    "POST /api/admin/backups/:id/restore": backup("backup.restore", { targetType: "backup", targetParam: "id" }),

    // Tickets. Message bodies stay out of the audit log, as they already live on the ticket.
    "POST /api/tickets": ticket("ticket.create", { targetParam: undefined, targetResponse: "id", labelBody: "title", fields: TICKET_FIELDS }),
    "PATCH /api/tickets/:id": ticket("ticket.update", { fields: TICKET_FIELDS }),
    "POST /api/tickets/:id/reply": ticket("ticket.reply", { fields: ["timeMinutes"] }),
    "POST /api/tickets/:id/note": ticket("ticket.note", { fields: ["timeMinutes", "handoff"] }),
    "POST /api/ticket-timers/:ticketId/start": { action: "ticket.timer.start", category: "ticket", targetType: "ticket", targetParam: "ticketId", skip: true },
    "POST /api/ticket-timers/:ticketId/pause": { action: "ticket.timer.pause", category: "ticket", targetType: "ticket", targetParam: "ticketId", skip: true },
    "POST /api/ticket-timers/:ticketId/discard": { action: "ticket.timer.discard", category: "ticket", targetType: "ticket", targetParam: "ticketId", skip: true },
    "POST /api/ticket-timers/:ticketId/stop": { action: "ticket.time.log", category: "ticket", targetType: "ticket", targetParam: "ticketId", fields: ["minutes", "billable"] },
    "POST /api/tickets/:id/linked": ticket("ticket.link", { fields: ["linkedId"] }),
    "POST /api/schedule/visits": { action: "schedule.visit.create", category: "ticket", targetType: "ticket_visit", targetResponse: "id", fields: ["ticketId", "startsAt", "endsAt", "techIds", "force"] },
    "PATCH /api/schedule/visits/:id": { action: "schedule.visit.update", category: "ticket", targetType: "ticket_visit", targetParam: "id", fields: ["startsAt", "endsAt", "techIds", "status", "force"] },
    "DELETE /api/schedule/visits/:id": { action: "schedule.visit.delete", category: "ticket", targetType: "ticket_visit", targetParam: "id" },
    "PUT /api/schedule/availability/:userId": { action: "schedule.availability.update", category: "user", targetType: "user", targetParam: "userId", fields: ["timeZone"] },
    "POST /api/schedule/time-off": { action: "schedule.time_off.add", category: "user", targetType: "time_off", targetResponse: "id", fields: ["userId", "startsAt", "endsAt"] },
    "DELETE /api/schedule/time-off/:id": { action: "schedule.time_off.remove", category: "user", targetType: "time_off", targetParam: "id" },
    "POST /api/schedule/visits/conflicts": { action: "schedule.visit.check", category: "ticket", skip: true },
    "POST /api/tickets/:id/attachments": ticket("ticket.attachment.add"),
    "POST /api/tickets/:id/devices": ticket("ticket.device.add", { fields: ["deviceId"] }),
    "DELETE /api/tickets/:id/devices/:deviceId": ticket("ticket.device.remove"),
    "POST /api/recurring-tickets": { action: "recurring_ticket.create", category: "ticket", targetType: "recurring_ticket", targetResponse: "id", labelBody: "name", fields: ["clientId", "templateId", "frequency", "skipIfOpen"] },
    "PATCH /api/recurring-tickets/:id": { action: "recurring_ticket.update", category: "ticket", targetType: "recurring_ticket", targetParam: "id", fields: ["name", "frequency", "skipIfOpen"] },
    "DELETE /api/recurring-tickets/:id": { action: "recurring_ticket.delete", category: "ticket", targetType: "recurring_ticket", targetParam: "id" },
    "POST /api/recurring-tickets/:id/pause": { action: "recurring_ticket.pause", category: "ticket", targetType: "recurring_ticket", targetParam: "id" },
    "POST /api/recurring-tickets/:id/resume": { action: "recurring_ticket.resume", category: "ticket", targetType: "recurring_ticket", targetParam: "id" },
    "POST /api/recurring-tickets/:id/run": { action: "recurring_ticket.run_now", category: "ticket", targetType: "recurring_ticket", targetParam: "id" },
    "POST /api/recurring-tickets/preview": { action: "recurring_ticket.preview", category: "ticket", skip: true },
    "POST /api/ticket-contacts": { action: "ticket.contact.create", category: "ticket", targetType: "customer_contact", targetResponse: "id", labelBody: "name", fields: ["clientId", "email"] },
    "POST /api/kb/articles": { action: "kb.article.create", category: "kb", targetType: "kb_article", targetResponse: "id", labelBody: "title", fields: ["status", "customerVisible", "categoryId"] },
    "PATCH /api/kb/articles/:id": { action: "kb.article.update", category: "kb", targetType: "kb_article", targetParam: "id", labelBody: "title", fields: ["status", "customerVisible", "categoryId"] },
    "DELETE /api/kb/articles/:id": { action: "kb.article.delete", category: "kb", targetType: "kb_article", targetParam: "id" },
    "POST /api/kb/articles/:id/versions/:version/restore": { action: "kb.article.restore", category: "kb", targetType: "kb_article", targetParam: "id" },
    "POST /api/kb/articles/:id/feedback": { action: "kb.article.feedback", category: "kb", targetType: "kb_article", targetParam: "id", skip: true },
    "POST /api/kb/categories": { action: "kb.category.create", category: "kb", targetType: "kb_category", targetResponse: "id", labelBody: "name" },
    "PATCH /api/kb/categories/:id": { action: "kb.category.update", category: "kb", targetType: "kb_category", targetParam: "id", labelBody: "name" },
    "DELETE /api/kb/categories/:id": { action: "kb.category.delete", category: "kb", targetType: "kb_category", targetParam: "id" },
    "POST /api/kb/tickets/:ticketId/links": { action: "kb.article.link", category: "ticket", targetType: "ticket", targetParam: "ticketId", fields: ["articleId"] },
    "DELETE /api/kb/tickets/:ticketId/links/:articleId": { action: "kb.article.unlink", category: "ticket", targetType: "ticket", targetParam: "ticketId" },
    "POST /api/tickets/:id/canned-render": ticket("ticket.canned.render", { skip: true }),
    "POST /api/admin/ticketing/canned-responses": { action: "ticket.canned_response.create", category: "ticket", targetType: "canned_response", targetResponse: "id" },
    "PATCH /api/admin/ticketing/canned-responses/:id": { action: "ticket.canned_response.update", category: "ticket", targetType: "canned_response", targetParam: "id" },
    "DELETE /api/admin/ticketing/canned-responses/:id": { action: "ticket.canned_response.delete", category: "ticket", targetType: "canned_response", targetParam: "id" },
    "POST /api/script-snippets": { action: "script.snippet.create", category: "automation", targetType: "script_snippet", targetResponse: "id", fields: ["title", "language", "shared"] },
    "PATCH /api/script-snippets/:id": { action: "script.snippet.update", category: "automation", targetType: "script_snippet", targetParam: "id", fields: ["title", "language", "shared"] },
    "DELETE /api/script-snippets/:id": { action: "script.snippet.delete", category: "automation", targetType: "script_snippet", targetParam: "id" },
    "PUT /api/admin/sso": settings("sso.update"),
    // Feature flags and CSV import record their own events, with what changed and the counts.
    "PUT /api/admin/flags/:key": { action: "settings.flag.set", category: "settings", skip: true },
    "POST /api/admin/data/import/:kind": { action: "data.import", category: "settings", skip: true },
    // These record their own, more detailed event (what changed, which person's sessions).
    "PUT /api/admin/security-policies": { action: "security_policies.update", category: "settings", skip: true },
    "DELETE /api/admin/sessions/:id": { action: "admin.session.revoke", category: "user", skip: true },
    "POST /api/admin/sessions/user/:userId/revoke": { action: "admin.session.revoke_all", category: "user", skip: true },
    "PUT /api/admin/agent-settings": { action: "agents.settings.update", category: "settings", skip: true },
    // Staged agent rollout: each records its own event with the versions and the ring counts.
    "POST /api/admin/agent-releases/promote": { action: "agents.release.promote", category: "settings", skip: true },
    "POST /api/admin/agent-releases/withdraw": { action: "agents.release.withdraw", category: "settings", skip: true },
    "PATCH /api/admin/agent-releases/devices/:id/ring": { action: "agents.ring.device", category: "device", skip: true },
    "PATCH /api/admin/agent-releases/customers/:id/ring": { action: "agents.ring.customer", category: "settings", skip: true },
    "POST /api/admin/import/freshdesk/preview": { action: "import.preview", category: "import", fields: ["domain"] },
    "POST /api/admin/import/jobs/:id/run": { action: "import.run", category: "import", targetType: "import_job", targetParam: "id", fields: ["contacts", "tickets", "attachments", "time"] },
    "POST /api/admin/import/jobs/:id/cancel": { action: "import.cancel", category: "import", targetType: "import_job", targetParam: "id" },
    "POST /api/custom-fields": { action: "custom_field.create", category: "settings", targetType: "custom_field", targetResponse: "id", labelBody: "label", fields: ["label", "type", "required"] },
    "POST /api/custom-fields/reorder": { action: "custom_field.reorder", category: "settings" },
    "PATCH /api/custom-fields/:id": { action: "custom_field.update", category: "settings", targetType: "custom_field", targetParam: "id", fields: ["label", "required", "active"] },
    "DELETE /api/custom-fields/:id": { action: "custom_field.archive", category: "settings", targetType: "custom_field", targetParam: "id" },
    "POST /api/ticket-custom-fields": { action: "ticket_custom_field.create", category: "settings", targetType: "custom_field", targetResponse: "id", labelBody: "label", fields: ["label", "type", "required", "visibleToCustomer"] },
    "POST /api/ticket-custom-fields/reorder": { action: "ticket_custom_field.reorder", category: "settings" },
    "PATCH /api/ticket-custom-fields/:id": { action: "ticket_custom_field.update", category: "settings", targetType: "custom_field", targetParam: "id", fields: ["label", "required", "active", "visibleToCustomer"] },
    "DELETE /api/ticket-custom-fields/:id": { action: "ticket_custom_field.archive", category: "settings", targetType: "custom_field", targetParam: "id" },
    "POST /api/ticket-templates": { action: "ticket_template.create", category: "ticket", targetType: "ticket_template", targetResponse: "id", labelBody: "name", fields: ["name", "priority"] },
    "PATCH /api/ticket-templates/:id": { action: "ticket_template.update", category: "ticket", targetType: "ticket_template", targetParam: "id", fields: ["name", "priority"] },
    "DELETE /api/ticket-templates/:id": { action: "ticket_template.delete", category: "ticket", targetType: "ticket_template", targetParam: "id" },
    "PUT /api/admin/email-templates/:key": { action: "email_template.update", category: "settings", targetType: "email_template", targetParam: "key", fields: ["subject"] },
    "DELETE /api/admin/email-templates/:key": { action: "email_template.reset", category: "settings", targetType: "email_template", targetParam: "key" },
    "POST /api/admin/email-templates/:key/test": { action: "email_template.test", category: "settings", targetType: "email_template", targetParam: "key", fields: ["to"] },
    "PUT /api/admin/surveys/settings": { action: "survey.settings.update", category: "settings", fields: ["enabled", "triggerStatuses", "delayMinutes", "scope", "throttleDays", "reminderEnabled", "reminderAfterDays", "expiryDays", "scale", "lowThreshold"] },
    "POST /api/survey/:token": { action: "survey.response", category: "ticket", skip: true },
    "POST /api/portal/survey/:token": { action: "survey.response", category: "ticket", skip: true },
    "POST /api/portal/tickets/:id/survey": { action: "survey.response", category: "ticket", skip: true },
    // SLA policies, calendars and customer policies record their own event with each value that changed.
    "POST /api/sla/policies": { action: "sla.policy.create", category: "settings", targetType: "sla_policy", skip: true },
    "PATCH /api/sla/policies/:id": { action: "sla.policy.update", category: "settings", targetType: "sla_policy", skip: true },
    "DELETE /api/sla/policies/:id": { action: "sla.policy.delete", category: "settings", targetType: "sla_policy", skip: true },
    "POST /api/sla/calendars": { action: "sla.calendar.create", category: "settings", targetType: "sla_calendar", skip: true },
    "PATCH /api/sla/calendars/:id": { action: "sla.calendar.update", category: "settings", targetType: "sla_calendar", skip: true },
    "DELETE /api/sla/calendars/:id": { action: "sla.calendar.delete", category: "settings", targetType: "sla_calendar", skip: true },
    "PUT /api/sla/clients/:clientId": { action: "sla.customer_policy.set", category: "settings", targetType: "client", skip: true },
    "POST /api/sla/run": { action: "sla.run", category: "settings" },
    "POST /api/sla/notices/read": { action: "sla.notice.read", category: "ticket", skip: true },
    "POST /api/ticket-queues": { action: "ticket_queue.create", category: "settings", targetType: "ticket_queue", targetResponse: "id", labelBody: "name", fields: ["name", "enabled", "assignment", "defaultAssigneeUserId", "poolUserIds", "poolGroupId", "defaultSlaPolicyId"] },
    "PATCH /api/ticket-queues/:id": { action: "ticket_queue.update", category: "settings", targetType: "ticket_queue", targetParam: "id", labelBody: "name", fields: ["name", "enabled", "assignment", "defaultAssigneeUserId", "poolUserIds", "poolGroupId", "defaultSlaPolicyId"] },
    "DELETE /api/ticket-queues/:id": { action: "ticket_queue.delete", category: "settings", targetType: "ticket_queue", targetParam: "id" },
    "POST /api/ticket-routing-rules": { action: "ticket_routing_rule.create", category: "settings", targetType: "ticket_routing_rule", targetResponse: "id", labelBody: "name", fields: ["name", "enabled", "match", "stopOnMatch"] },
    "PATCH /api/ticket-routing-rules/:id": { action: "ticket_routing_rule.update", category: "settings", targetType: "ticket_routing_rule", targetParam: "id", labelBody: "name", fields: ["name", "enabled", "match", "stopOnMatch"] },
    "DELETE /api/ticket-routing-rules/:id": { action: "ticket_routing_rule.delete", category: "settings", targetType: "ticket_routing_rule", targetParam: "id" },
    "POST /api/ticket-routing-rules/reorder": { action: "ticket_routing_rule.reorder", category: "settings", fields: ["ids"] },
    "POST /api/ticket-routing-rules/test": { action: "ticket_routing_rule.test", category: "settings", skip: true },
    "POST /api/admin/webhooks": { action: "webhook.create", category: "settings", targetType: "webhook", targetResponse: "id", labelBody: "name", fields: ["name", "url", "events"] },
    "PATCH /api/admin/webhooks/:id": { action: "webhook.update", category: "settings", targetType: "webhook", targetParam: "id", fields: ["name", "url", "events", "enabled", "rotateSecret"] },
    "DELETE /api/admin/webhooks/:id": { action: "webhook.delete", category: "settings", targetType: "webhook", targetParam: "id" },
    "POST /api/admin/webhooks/:id/test": { action: "webhook.test", category: "settings", targetType: "webhook", targetParam: "id" },
    "POST /api/monitors/web": { action: "web_monitor.create", category: "settings", targetType: "web_monitor", targetResponse: "id", labelBody: "name", fields: ["kind", "host", "port", "clientId"] },
    "PATCH /api/monitors/web/:id": { action: "web_monitor.update", category: "settings", targetType: "web_monitor", targetParam: "id", fields: ["name", "host", "port", "clientId", "enabled"] },
    "DELETE /api/monitors/web/:id": { action: "web_monitor.delete", category: "settings", targetType: "web_monitor", targetParam: "id" },
    "POST /api/monitors/web/:id/accept": { action: "web_monitor.accept", category: "settings", targetType: "web_monitor", targetParam: "id" },
    "POST /api/edr/connections": { action: "edr.connect", category: "settings", targetType: "edr_connection", targetResponse: "id", labelBody: "name", fields: ["vendor", "name", "clientId"] },
    "PATCH /api/edr/connections/:id": { action: "edr.update", category: "settings", targetType: "edr_connection", targetParam: "id", fields: ["name", "clientId"] },
    "DELETE /api/edr/connections/:id": { action: "edr.disconnect", category: "settings", targetType: "edr_connection", targetParam: "id" },
    "POST /api/edr/connections/:id/sync": { action: "edr.sync", category: "settings", skip: true },
    "POST /api/m365/tenants": { action: "m365.connect", category: "customers", targetType: "m365_tenant", targetResponse: "id", fields: ["clientId", "tenant", "appId"] },
    "PATCH /api/m365/tenants/:id": { action: "m365.update", category: "customers", targetType: "m365_tenant", targetParam: "id", fields: ["appId"] },
    "DELETE /api/m365/tenants/:id": { action: "m365.disconnect", category: "customers", targetType: "m365_tenant", targetParam: "id" },
    "POST /api/m365/tenants/:id/sync": { action: "m365.sync", category: "customers", skip: true },
    "POST /api/endpoint-backups/check": { action: "endpoint_backups.check", category: "devices", skip: true },
    "PUT /api/endpoint-backups/settings": { action: "endpoint_backups.settings.update", category: "settings", skip: true },
    "PUT /api/admin/tray": { action: "tray.settings.update", category: "settings", skip: true },
    "PUT /api/admin/auto-repair": { action: "auto_repair.settings.update", category: "settings", skip: true },
    "POST /api/admin/auto-repair/playbooks": { action: "auto_repair.playbook.create", category: "settings", skip: true },
    "PUT /api/admin/auto-repair/playbooks/:id": { action: "auto_repair.playbook.update", category: "settings", skip: true },
    "DELETE /api/admin/auto-repair/playbooks/:id": { action: "auto_repair.playbook.delete", category: "settings", skip: true },
    "POST /api/admin/auto-repair/playbooks/:id/test": { action: "auto_repair.playbook.test", category: "settings", skip: true },
    "POST /api/admin/auto-repair/playbooks/:id/approve": { action: "auto_repair.playbook.approve", category: "settings", skip: true },
    "POST /api/admin/auto-repair/playbooks/:id/enable": { action: "auto_repair.playbook.enable", category: "settings", skip: true },
    "POST /api/admin/auto-repair/playbooks/:id/disable": { action: "auto_repair.playbook.disable", category: "settings", skip: true },
    "POST /api/device-chat/:deviceId": { action: "device_chat.reply", category: "devices", skip: true },
    "POST /api/agent/tray/help": { action: "tray.help", category: "tickets", skip: true },
    "POST /api/agent/tray/chat": { action: "tray.chat", category: "devices", skip: true },
    "POST /api/monitors/web/:id/run": { action: "web_monitor.run", category: "settings", skip: true },
    "POST /api/admin/ticketing/canned-variables": { action: "ticket.canned_variable.create", category: "ticket", targetType: "canned_variable", targetResponse: "id" },
    "PATCH /api/admin/ticketing/canned-variables/:id": { action: "ticket.canned_variable.update", category: "ticket", targetType: "canned_variable", targetParam: "id" },
    "DELETE /api/admin/ticketing/canned-variables/:id": { action: "ticket.canned_variable.delete", category: "ticket", targetType: "canned_variable", targetParam: "id" },

    // Organization settings. The database settings hold connection strings.
    "POST /api/admin/company/save": settings("settings.company.update"),
    "POST /api/branding": settings("settings.branding.update"),
    "POST /api/branding/upload": settings("settings.branding.upload"),
    "POST /api/branding/upload-favicon": settings("settings.branding.upload_favicon"),
    "POST /api/admin/localization/save": settings("settings.localization.update"),
    "POST /api/admin/support-legal/save": settings("settings.support_legal.update"),
    "POST /api/admin/database/save": settings("settings.database.update"),
    "POST /api/admin/database/test": settings("settings.database.test"),
    "POST /api/admin/database/migrate/dry-run": settings("settings.database.migrate_dry_run"),

    // Alerts and checks
    "POST /api/alerts/:id/ack": { action: "alert.acknowledge", category: "alert", targetType: "alert", targetParam: "id" },
    "POST /api/alerts/:id/silence": { action: "alert.silence", category: "alert", targetType: "alert", targetParam: "id" },
    "POST /api/alerts/:id/unsilence": { action: "alert.unsilence", category: "alert", targetType: "alert", targetParam: "id" },
    "POST /api/alerts/:id/resolve": { action: "alert.resolve", category: "alert", targetType: "alert", targetParam: "id" },
    "PUT /api/billing/settings": { action: "billing.settings_update", category: "billing", fields: ["currency", "taxRateBps", "paymentTermsDays", "invoicePrefix", "quotePrefix"] },
    "POST /api/billing/catalog": { action: "billing.catalog_create", category: "billing", targetType: "catalog_item", targetResponse: "id", labelBody: "name", fields: ["name", "unitPriceCents"] },
    "PUT /api/billing/catalog/:id": { action: "billing.catalog_update", category: "billing", targetType: "catalog_item", targetParam: "id", fields: ["name", "unitPriceCents", "active"] },
    "DELETE /api/billing/catalog/:id": { action: "billing.catalog_delete", category: "billing", targetType: "catalog_item", targetParam: "id" },
    "POST /api/billing/time": { action: "billing.time_create", category: "billing", targetType: "time_entry", targetResponse: "id", fields: ["clientId", "ticketId", "workDate", "minutes", "billable"] },
    "POST /api/billing/time/approve": { action: "billing.time_approve", category: "billing", fields: ["ids", "approved"] },
    "PUT /api/billing/time/:id": { action: "billing.time_update", category: "billing", targetType: "time_entry", targetParam: "id", fields: ["clientId", "workDate", "minutes", "billable"] },
    "DELETE /api/billing/time/:id": { action: "billing.time_delete", category: "billing", targetType: "time_entry", targetParam: "id" },
    "POST /api/billing/contracts": { action: "billing.contract_create", category: "billing", targetType: "contract", targetResponse: "id", labelBody: "name", fields: ["clientId", "name", "kind", "billingIntervalMonths", "priceCents"] },
    "POST /api/billing/contracts/run": { action: "billing.contracts_run", category: "billing" },
    "PUT /api/billing/contracts/:id": { action: "billing.contract_update", category: "billing", targetType: "contract", targetParam: "id", fields: ["clientId", "name", "kind", "status", "billingIntervalMonths", "priceCents"] },
    "DELETE /api/billing/contracts/:id": { action: "billing.contract_delete", category: "billing", targetType: "contract", targetParam: "id" },
    "POST /api/billing/invoices": { action: "billing.invoice_create", category: "billing", targetType: "invoice", targetResponse: "id", fields: ["kind", "clientId"] },
    "PUT /api/billing/invoices/:id": { action: "billing.invoice_update", category: "billing", targetType: "invoice", targetParam: "id", fields: ["clientId"] },
    "DELETE /api/billing/invoices/:id": { action: "billing.invoice_delete", category: "billing", targetType: "invoice", targetParam: "id" },
    "POST /api/billing/invoices/:id/send": { action: "billing.invoice_send", category: "billing", targetType: "invoice", targetParam: "id", fields: ["to"] },
    "POST /api/billing/invoices/:id/void": { action: "billing.invoice_void", category: "billing", targetType: "invoice", targetParam: "id" },
    "POST /api/billing/invoices/:id/convert": { action: "billing.quote_convert", category: "billing", targetType: "invoice", targetParam: "id" },
    "POST /api/billing/invoices/:id/add-time": { action: "billing.invoice_add_time", category: "billing", targetType: "invoice", targetParam: "id", fields: ["rateCents"] },
    "POST /api/billing/invoices/:id/payments": { action: "billing.payment_record", category: "billing", targetType: "invoice", targetParam: "id", fields: ["amountCents", "method", "reference"] },
    "DELETE /api/billing/invoices/:id/payments/:paymentId": { action: "billing.payment_remove", category: "billing", targetType: "invoice", targetParam: "id" },
    "POST /api/docs/assets/sync": { action: "asset.sync", category: "documentation" },
    "POST /api/docs/assets": { action: "asset.create", category: "documentation", targetType: "asset", targetResponse: "id", labelBody: "name", fields: ["clientId", "name", "kind"] },
    "PUT /api/docs/assets/:id": { action: "asset.update", category: "documentation", targetType: "asset", targetParam: "id", fields: ["clientId", "name", "kind", "expiresAt"] },
    "DELETE /api/docs/assets/:id": { action: "asset.delete", category: "documentation", targetType: "asset", targetParam: "id" },
    "POST /api/docs/links": { action: "link.create", category: "documentation", fields: ["fromType", "fromId", "toType", "toId"] },
    "DELETE /api/docs/links/:id": { action: "link.delete", category: "documentation", targetType: "entity_link", targetParam: "id" },
    "POST /api/reports/schedules": { action: "report_schedule.create", category: "automation", targetType: "report_schedule", targetResponse: "id", fields: ["clientId", "frequency", "recipients"] },
    "PUT /api/reports/schedules/:id": { action: "report_schedule.update", category: "automation", targetType: "report_schedule", targetParam: "id", fields: ["frequency", "recipients", "enabled"] },
    "DELETE /api/reports/schedules/:id": { action: "report_schedule.delete", category: "automation", targetType: "report_schedule", targetParam: "id" },
    "POST /api/alerts/bulk": { action: "alert.bulk", category: "alert", fields: ["action", "ids"] },
    "POST /api/checks": { action: "check.create", category: "check", targetType: "check", targetResponse: "id", labelBody: "name", fields: ["name"] },
    "PUT /api/checks/:id": { action: "check.update", category: "check", targetType: "check", targetParam: "id", fields: ["name"] },
    "DELETE /api/checks/:id": { action: "check.delete", category: "check", targetType: "check", targetParam: "id" },
    "POST /api/checks/:id/assignments/rebuild": { action: "check.assignments.rebuild", category: "check", targetType: "check", targetParam: "id" },
    "POST /api/checks/:id/run": { action: "check.run", category: "check", targetType: "check", targetParam: "id" },

    // Lists agents, despite being a POST.
    "POST /api/admin/agents": { action: "agent.list", category: "device", skip: true },
};

const GENERIC_VERBS: Record<string, string> = {
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete",
};

function genericRule(method: string, routePath: string): AuditRule {
    const parts = routePath.split("/").filter(Boolean);
    const words = parts
        .filter((part, i) => !part.startsWith(":") && !(i === 0 && part === "api"))
        .filter((part, i) => !(i === 0 && part === "admin"))
        .map((part) => part.replace(/[^a-zA-Z0-9_-]/g, "").replace(/-/g, "_"))
        .filter(Boolean);
    const param = parts.find((part) => part.startsWith(":"))?.slice(1);
    return {
        action: [...words, GENERIC_VERBS[method] ?? method.toLowerCase()].join("."),
        category: words[0] ?? "other",
        targetType: param ? words[0] : undefined,
        targetParam: param,
    };
}

/** Controllers declare paths with stray slashes, which Express can keep in its route path. */
export function normalizeRoutePath(path: string): string {
    return `/${path.split("/").filter(Boolean).join("/")}`;
}

export function auditRuleFor(method: string, routePath: string): AuditRule {
    const path = normalizeRoutePath(routePath);
    return RULES[`${method.toUpperCase()} ${path}`] ?? genericRule(method.toUpperCase(), path);
}

/** Lets a test check that the table keeps up with the real routes. */
export function auditRouteKeys(): string[] {
    return Object.keys(RULES);
}
