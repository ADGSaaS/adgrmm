import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { SmtpRepository, type EmailPurpose } from "../smtp/smtp.repository";
import { SupportMailboxService } from "../support-mailbox/support-mailbox.service";
import { resolveTurnProvider } from "../remote-console/turn-config";

/** How an integration is doing, in the words and colours the screen uses. */
export type IntegrationStatus = "ok" | "attention" | "error" | "off";

export type IntegrationCard = {
    key: string;
    name: string;
    /** What it does for the organization. */
    description: string;
    status: IntegrationStatus;
    /** "Connected", "Not set up", ... */
    statusLabel: string;
    /** One line of facts from the real settings (an address, a count). */
    detail: string | null;
    /** The last thing that happened with it, when the product keeps one. */
    last: { at: string | null; ok: boolean; message: string } | null;
    /** Where to change it: an Administration tab, or a page. */
    link: { label: string; tab?: string; href?: string };
};

const PURPOSE_LABEL: Record<EmailPurpose, string> = { alerts: "alerts", invites: "invitations", password_resets: "password resets", reports: "reports and invoices", tickets: "tickets" };
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The Integrations screen: one card for each connection to something outside the product that really exists, with its
 * true state read from the settings and the last results the product keeps. Nothing here can be switched on or off:
 * each card links to where that integration is set up.
 */
@Injectable()
export class IntegrationsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly smtp: SmtpRepository,
        private readonly mailbox: SupportMailboxService,
    ) { }

    async cards(orgId: string): Promise<IntegrationCard[]> {
        const settle = async (key: string, fn: () => Promise<IntegrationCard>, fallback: Omit<IntegrationCard, "status" | "statusLabel" | "detail" | "last">): Promise<IntegrationCard> => {
            try {
                return await fn();
            } catch (e) {
                // One card failing to load must not hide the others.
                return { ...fallback, status: "error", statusLabel: "Could not check", detail: null, last: { at: null, ok: false, message: String((e as Error)?.message ?? e).slice(0, 200) } };
            }
        };

        const cards = await Promise.all([
            settle("smtp", () => this.email(), { key: "smtp", name: "Email (SMTP)", description: "Sends the system's email: alerts, invitations, password resets, reports, invoices and ticket replies.", link: { label: "Email settings", tab: "smtp" } }),
            settle("mailbox", () => this.supportMailbox(orgId), { key: "mailbox", name: "Support mailbox", description: "Turns email sent to your support address into tickets, and replies into ticket replies.", link: { label: "Support mailbox settings", tab: "mailbox" } }),
            settle("sso", () => this.sso(orgId), { key: "sso", name: "Single sign-on", description: "Lets staff sign in with your identity provider (OpenID Connect).", link: { label: "Single sign-on settings", tab: "sso" } }),
            settle("billing", () => this.stripe(orgId), { key: "billing", name: "Stripe card payments", description: "Lets customers pay an invoice online by card; payments are recorded on the invoice.", link: { label: "Billing settings", href: "/billing" } }),
            settle("helpdesk_import", () => this.importer(orgId), { key: "helpdesk_import", name: "Freshdesk import", description: "Brings contacts, tickets, attachments and time from Freshdesk across once, with a preview first.", link: { label: "Helpdesk import", tab: "helpdesk_import" } }),
            settle("client_portal", () => this.portal(orgId), { key: "client_portal", name: "Client portal", description: "A site on your own domain where customers follow their tickets, devices, invoices and reports.", link: { label: "Client portal settings", tab: "client_portal" } }),
            settle("alert_channels", () => this.alertChannels(), { key: "alert_channels", name: "Alert notifications", description: "Sends an email or a signed webhook when an alert opens, stays open or resolves.", link: { label: "Open Alerts", href: "/alerts" } }),
            settle("webhooks", () => this.webhooks(orgId), { key: "webhooks", name: "Outbound webhooks", description: "Sends signed copies of ticket, alert and device-offline events to any address you give.", link: { label: "Manage webhooks", href: "#webhooks" } }),
            settle("tokens", () => this.tokens(orgId), { key: "tokens", name: "API access (personal tokens)", description: "Lets scripts and other tools call the API as a person, with that person's rights.", link: { label: "Your account, Developer", href: "/account" } }),
            settle("turn", () => this.turn(), { key: "turn", name: "Remote console relay (TURN)", description: "Relays remote console and remote desktop traffic when two sides cannot connect directly. Cloudflare Realtime TURN or your own relay.", link: { label: "System settings", tab: "system" } }),
            settle("storage", () => this.storage(orgId), { key: "storage", name: "Backup storage (S3)", description: "Where backups are written: S3-compatible storage such as AWS S3, Cloudflare R2 or Backblaze.", link: { label: "Storage settings", tab: "storage" } }),
        ]);
        return cards;
    }

    private async email(): Promise<IntegrationCard> {
        const all = await this.smtp.getAllRaw();
        const purposes = Object.keys(PURPOSE_LABEL) as EmailPurpose[];
        const ready = purposes.filter((p) => all[p]?.enabled && all[p]?.smtp_host && all[p]?.smtp_port && all[p]?.smtp_from_address);
        const missing = purposes.filter((p) => !ready.includes(p));
        const base = { key: "smtp", name: "Email (SMTP)", description: "Sends the system's email: alerts, invitations, password resets, reports, invoices and ticket replies.", link: { label: "Email settings", tab: "smtp" }, last: null };
        if (ready.length === 0) return { ...base, status: "off", statusLabel: "Not set up", detail: "No mailbox is set up, so the system cannot send email." };
        if (missing.length === 0) return { ...base, status: "ok", statusLabel: "Set up", detail: `All five mailboxes are set up (${ready.map((p) => PURPOSE_LABEL[p]).join(", ")}).` };
        return { ...base, status: "attention", statusLabel: "Partly set up", detail: `Set up for ${ready.map((p) => PURPOSE_LABEL[p]).join(", ")}. Not set up for ${missing.map((p) => PURPOSE_LABEL[p]).join(", ")}; those email types use the alerts mailbox where they can, or are not sent.` };
    }

    private async supportMailbox(orgId: string): Promise<IntegrationCard> {
        const s = await this.mailbox.status(orgId);
        const base = { key: "mailbox", name: "Support mailbox", description: "Turns email sent to your support address into tickets, and replies into ticket replies.", link: { label: "Support mailbox settings", tab: "mailbox" } };
        const where = s.source === "imap" ? "IMAP login from the Tickets mailbox" : "Microsoft 365";
        const failing = !!s.lastError && (!s.lastPolledAt || (s.lastErrorAt ?? "") >= s.lastPolledAt);
        const last = failing
            ? { at: s.lastErrorAt, ok: false, message: s.lastError! }
            : s.lastPolledAt ? { at: s.lastPolledAt, ok: true, message: "Mail was checked." } : null;
        if (!s.enabled) return { ...base, status: "off", statusLabel: "Turned off", detail: s.connected ? `Connected through ${where}, but not collecting mail.` : null, last };
        if (!s.connected) return { ...base, status: "attention", statusLabel: "Not connected", detail: `Turned on, but ${s.source === "imap" ? "the Tickets mailbox has no IMAP login yet" : "Microsoft 365 is not connected yet"}.`, last };
        if (failing) return { ...base, status: "error", statusLabel: "Problem", detail: `${s.mailboxAddress || where}`, last };
        return { ...base, status: "ok", statusLabel: "Connected", detail: `${s.mailboxAddress ? `${s.mailboxAddress} through ` : ""}${where}.`, last };
    }

    private async sso(orgId: string): Promise<IntegrationCard> {
        const c = await this.prisma.sso_config.findUnique({ where: { organization_id: orgId } });
        const base = { key: "sso", name: "Single sign-on", description: "Lets staff sign in with your identity provider (OpenID Connect).", link: { label: "Single sign-on settings", tab: "sso" } };
        const linked = await this.prisma.sso_identities.count({ where: { organization_id: orgId } });
        const lastLogin = await this.prisma.sso_identities.aggregate({ where: { organization_id: orgId }, _max: { last_login_at: true } });
        const at = iso(lastLogin._max.last_login_at);
        const last = at ? { at, ok: true, message: "Someone signed in this way." } : null;
        const configured = !!c?.issuer && !!c?.client_id && !!c?.client_secret;
        if (!c?.enabled) return { ...base, status: configured ? "off" : "off", statusLabel: configured ? "Set up, turned off" : "Not set up", detail: configured ? `${c!.display_name} (${c!.issuer}).` : null, last };
        if (!configured) return { ...base, status: "attention", statusLabel: "Incomplete", detail: "Turned on, but the issuer, client id or secret is missing.", last };
        return { ...base, status: "ok", statusLabel: "On", detail: `${c.display_name} (${c.issuer}). ${plural(linked, "person")} linked${c.password_login ? "; password sign-in is still allowed" : "; password sign-in is off"}.`, last };
    }

    private async stripe(orgId: string): Promise<IntegrationCard> {
        const s = await this.prisma.billing_settings.findUnique({ where: { organization_id: orgId }, select: { stripe_secret_key: true, stripe_webhook_secret: true } });
        const base = { key: "billing", name: "Stripe card payments", description: "Lets customers pay an invoice online by card; payments are recorded on the invoice.", link: { label: "Billing settings", href: "/billing" } };
        const lastPay = await this.prisma.payments.findFirst({ where: { method: "stripe", invoices: { organization_id: orgId } }, orderBy: { paid_at: "desc" }, select: { paid_at: true, amount_cents: true } });
        const last = lastPay ? { at: iso(lastPay.paid_at), ok: true, message: "The last card payment was recorded." } : null;
        const key = !!s?.stripe_secret_key;
        const hook = !!s?.stripe_webhook_secret;
        if (!key && !hook) return { ...base, status: "off", statusLabel: "Not set up", detail: null, last };
        if (key && hook) return { ...base, status: "ok", statusLabel: "Set up", detail: "The secret key and the webhook secret are both saved.", last };
        return { ...base, status: "attention", statusLabel: "Incomplete", detail: key ? "The secret key is saved but the webhook secret is not, so paid invoices will not be marked paid." : "The webhook secret is saved but the secret key is not.", last };
    }

    private async importer(orgId: string): Promise<IntegrationCard> {
        const j = await this.prisma.import_jobs.findFirst({ where: { organization_id: orgId }, orderBy: { created_at: "desc" } });
        const base = { key: "helpdesk_import", name: "Freshdesk import", description: "Brings contacts, tickets, attachments and time from Freshdesk across once, with a preview first.", link: { label: "Helpdesk import", tab: "helpdesk_import" } };
        if (!j) return { ...base, status: "off", statusLabel: "Not used", detail: "No import has been started.", last: null };
        const at = iso(j.finished_at ?? j.started_at ?? j.created_at);
        const done = j.status === "completed";
        const failed = j.status === "failed" || j.status === "interrupted";
        const last = { at, ok: !failed, message: j.message ? String(j.message).slice(0, 200) : `The last import is ${j.status}.` };
        if (failed) return { ...base, status: "error", statusLabel: "Last import failed", detail: j.source, last };
        return { ...base, status: done ? "ok" : "attention", statusLabel: done ? "Last import finished" : `Last import ${j.status}`, detail: j.source, last };
    }

    private async portal(orgId: string): Promise<IntegrationCard> {
        const s = await this.prisma.portal_settings.findUnique({ where: { organization_id: orgId } });
        const base = { key: "client_portal", name: "Client portal", description: "A site on your own domain where customers follow their tickets, devices, invoices and reports.", link: { label: "Client portal settings", tab: "client_portal" }, last: null };
        const accounts = await this.prisma.portal_accounts.count({ where: { organization_id: orgId, status: "active" } });
        const lastLogin = await this.prisma.portal_accounts.aggregate({ where: { organization_id: orgId }, _max: { last_login_at: true } });
        const at = iso(lastLogin._max.last_login_at);
        const last = at ? { at, ok: true, message: "A customer signed in." } : null;
        if (!s?.enabled) return { ...base, status: "off", statusLabel: "Turned off", detail: s?.domain ? `Address ${s.domain}.` : null, last };
        return { ...base, status: s.domain ? "ok" : "attention", statusLabel: s.domain ? "On" : "No address", detail: `${s.domain ? `${s.domain}. ` : ""}${plural(accounts, "active person", "active people")}; ${(s.modules ?? []).join(", ") || "no areas"} shown.`, last };
    }

    private async alertChannels(): Promise<IntegrationCard> {
        const channels = await this.prisma.notification_channels.findMany({ select: { kind: true, enabled: true } });
        const base = { key: "alert_channels", name: "Alert notifications", description: "Sends an email or a signed webhook when an alert opens, stays open or resolves.", link: { label: "Open Alerts", href: "/alerts" } };
        const d = await this.prisma.notification_deliveries.findFirst({ where: { status: { in: ["delivered", "failed"] } }, orderBy: { created_at: "desc" }, select: { status: true, created_at: true, delivered_at: true, last_error: true } });
        const last = d ? { at: iso(d.delivered_at ?? d.created_at), ok: d.status === "delivered", message: d.status === "delivered" ? "The last notification was delivered." : (d.last_error ?? "The last notification failed.") } : null;
        const on = channels.filter((c) => c.enabled);
        if (on.length === 0) return { ...base, status: "off", statusLabel: "None on", detail: channels.length ? `${plural(channels.length, "channel")} set up, all turned off.` : "No channel is set up, so alerts are only shown in the console.", last };
        const email = on.filter((c) => c.kind === "email").length;
        const hooks = on.filter((c) => c.kind === "webhook").length;
        const detail = [email ? plural(email, "email channel") : null, hooks ? plural(hooks, "webhook channel") : null].filter(Boolean).join(", ");
        return { ...base, status: last && !last.ok ? "error" : "ok", statusLabel: last && !last.ok ? "Last send failed" : "On", detail, last };
    }

    private async webhooks(orgId: string): Promise<IntegrationCard> {
        const eps = await this.prisma.webhook_endpoints.findMany({ where: { organization_id: orgId }, select: { id: true, enabled: true } });
        const base = { key: "webhooks", name: "Outbound webhooks", description: "Sends signed copies of ticket, alert and device-offline events to any address you give.", link: { label: "Manage webhooks", href: "#webhooks" } };
        const d = await this.prisma.webhook_deliveries.findFirst({ where: { endpoint: { organization_id: orgId }, status: { in: ["delivered", "failed"] }, event: { not: "webhook.test" } }, orderBy: { created_at: "desc" }, select: { status: true, created_at: true, delivered_at: true, last_error: true } });
        const last = d ? { at: iso(d.delivered_at ?? d.created_at), ok: d.status === "delivered", message: d.status === "delivered" ? "The last event was delivered." : (d.last_error ?? "The last event failed.") } : null;
        const on = eps.filter((e) => e.enabled).length;
        if (on === 0) return { ...base, status: "off", statusLabel: "None on", detail: eps.length ? `${plural(eps.length, "webhook")} set up, all turned off.` : "No webhook is set up.", last };
        return { ...base, status: last && !last.ok ? "error" : "ok", statusLabel: last && !last.ok ? "Last send failed" : "On", detail: `${plural(on, "webhook")} on.`, last };
    }

    private async tokens(orgId: string): Promise<IntegrationCard> {
        const now = new Date();
        const where = { revoked_at: null, OR: [{ expires_at: null }, { expires_at: { gt: now } }], users: { organization_id: orgId } };
        const active = await this.prisma.personal_access_tokens.count({ where });
        const used = await this.prisma.personal_access_tokens.aggregate({ where: { users: { organization_id: orgId } }, _max: { last_used_at: true } });
        const at = iso(used._max.last_used_at);
        const base = { key: "tokens", name: "API access (personal tokens)", description: "Lets scripts and other tools call the API as a person, with that person's rights.", link: { label: "Your account, Developer", href: "/account" } };
        const last = at ? { at, ok: true, message: "A token was last used." } : null;
        if (active === 0) return { ...base, status: "off", statusLabel: "No tokens", detail: "Nobody has an active token. People make their own under Your account.", last };
        return { ...base, status: "ok", statusLabel: "In use", detail: `${plural(active, "active token")}.`, last };
    }

    private async turn(): Promise<IntegrationCard> {
        const base = { key: "turn", name: "Remote console relay (TURN)", description: "Relays remote console and remote desktop traffic when two sides cannot connect directly. Cloudflare Realtime TURN or your own relay.", link: { label: "System settings", tab: "system" }, last: null };
        let provider: string;
        try {
            provider = resolveTurnProvider(process.env);
        } catch (e) {
            return { ...base, status: "error", statusLabel: "Misconfigured", detail: String((e as Error).message), last: null };
        }
        if (provider === "cloudflare") return { ...base, status: "ok", statusLabel: "Cloudflare", detail: "Cloudflare Realtime TURN is configured on the server.", last: null };
        if (provider === "builtin") return { ...base, status: "ok", statusLabel: "Your own relay", detail: "A TURN server of your own is configured on the server.", last: null };
        return { ...base, status: "attention", statusLabel: "No relay", detail: "Only STUN is used, so remote sessions may fail between some networks. It is set on the server, not here.", last: null };
    }

    private async storage(orgId: string): Promise<IntegrationCard> {
        const rows = await this.prisma.storage_connections.findMany({ where: { organization_id: orgId }, select: { name: true, kind: true } });
        const base = { key: "storage", name: "Backup storage (S3)", description: "Where backups are written: S3-compatible storage such as AWS S3, Cloudflare R2 or Backblaze.", link: { label: "Storage settings", tab: "storage" }, last: null };
        if (rows.length === 0) return { ...base, status: "off", statusLabel: "Not set up", detail: "No storage connection is saved." };
        // The product does not keep the result of a connection test, so only what is saved is shown; Test connection is on the Storage page.
        return { ...base, status: "ok", statusLabel: "Saved", detail: `${plural(rows.length, "connection")}: ${rows.map((r) => r.name).join(", ")}. Use Test connection on the Storage page to check one.` };
    }
}
