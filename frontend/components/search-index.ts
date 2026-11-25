// Things the search box can jump to that are not records: the app's pages and the Administration settings tabs.
// Each needs the same right the page itself needs, so someone is not offered a place they cannot open.

export type PageEntry = { title: string; detail: string; href: string; needs: string[]; words: string };

const page = (title: string, href: string, needs: string[], words = "", detail = "Page"): PageEntry => ({ title, href, needs, words, detail });
const admin = (title: string, tab: string, needs: string[], words = ""): PageEntry => page(title, `/administration?tab=${tab}`, needs, words, "Administration");

export const PAGE_INDEX: PageEntry[] = [
    page("Dashboard", "/", [], "overview home status"),
    page("Customers", "/customers", ["customers.read"], "clients sites devices endpoints"),
    page("Tickets", "/tickets", ["tickets.read"], "service desk support requests"),
    page("Alerts", "/alerts", ["alerts.read"], "notifications problems incidents"),
    page("Automation", "/automation", ["automation.read"], "scripts runs history failures schedules"),
    page("Policies", "/policies", ["policies.read"], "tags baseline check profiles maintenance windows patching"),
    page("Billing", "/billing", ["billing.read"], "invoices quotes contracts time catalog"),
    page("Reports", "/reports", ["devices.read"], "inventory health security patching schedules exports"),
    page("Assets", "/assets", ["assets.read"], "assets inventory computers servers printers switches licences domains certificates warranty expiry serial number what customers own"),
    page("Network devices (SNMP)", "/snmp", ["devices.read"], "snmp monitoring printers switches toner supplies ink paper ports uptime network devices without agent community"),
    page("Network discovery", "/network-discovery", ["devices.read"], "network discovery scan subnet hosts printers switches unmanaged devices without agent ping arp ports find unknown"),
    page("Removal requests", "/removal-requests", ["devices.read"], "device removal deletion requests approve decline delete devices waiting"),
    page("Security", "/security", ["devices.read"], "security posture score grade defender antivirus bitlocker encryption firewall baseline hardening threats scan windows"),
    page("Calendar", "/calendar", ["schedule.read"], "dispatch board schedule visits appointments technician availability time off"),
    page("Session recordings", "/recordings", ["recordings.read"], "remote console recorded sessions video playback retention"),
    page("Knowledge base", "/knowledge-base", ["kb.read"], "articles how to fixes procedures answers help desk"),
    page("Account", "/account", [], "profile password two factor security sessions tokens"),

    admin("Company", "company", ["settings.read"], "organisation organization details legal"),
    admin("Branding", "branding", ["settings.read"], "colours colors logo favicon theme custom css login background"),
    admin("Localization", "localization", ["settings.read"], "language date format time zone"),
    admin("Support & Legal", "support", ["settings.read"], "terms privacy contact"),
    admin("Users", "users", ["users.read"], "people technicians staff accounts invite password"),
    admin("Roles", "roles", ["roles.read"], "permissions access"),
    admin("Groups", "groups", ["groups.read"], "teams members permissions customers access"),
    admin("Customer access", "client_access", ["users.write"], "limit customers visibility"),
    admin("Audit logs", "audit", ["audit.read"], "history activity who did what"),
    admin("Backups", "backups", ["backups.read"], "restore database archive"),
    admin("Storage", "storage", ["settings.read"], "s3 files uploads"),
    admin("Database", "database", ["settings.read"], "postgres connection"),
    admin("SMTP", "smtp", ["settings.read"], "email mail server"),
    admin("Ticketing", "ticketing", ["tickets.read"], "canned responses statuses"),
    admin("Demo data", "demo", ["settings.read"], "sample fake test"),
];

/** Pages and settings that match, for someone holding these rights (owners hold all). */
export function matchPages(query: string, can: (perm: string) => boolean, limit = 6): PageEntry[] {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return PAGE_INDEX.filter((p) => p.needs.every(can) && (p.title.toLowerCase().includes(needle) || p.words.includes(needle))).slice(0, limit);
}
