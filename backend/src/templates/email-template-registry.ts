// The system emails whose wording can be edited (Administration > Templates), with the variables each can use, the
// built-in wording, and the rules for rendering and checking an edited one. Pure: no database, so it can be tested alone.
import { BadRequestException } from "@nestjs/common";
import type { EmailPurpose } from "../smtp/smtp.repository";

export type TemplateVariable = { name: string; description: string; sample: string };

export type EmailTemplateDef = {
    key: string;
    label: string;
    /** When it is sent. */
    description: string;
    /** Which mailbox set up in Administration > Email sends it. */
    purpose: EmailPurpose;
    variables: TemplateVariable[];
    /** Variables the message cannot do without (a sign-in link, for instance). */
    required: string[];
    subject: string;
    body: string;
};

export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;

const COMPANY = { name: "company", description: "Your company name (or \"Your IT provider\" when none is set)", sample: "Acme IT Services" };
const COMPANY_PREFIX = { name: "company_prefix", description: "Your company name followed by a colon and a space, or nothing when none is set", sample: "Acme IT Services: " };

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
    {
        key: "portal_invite",
        label: "Client portal invitation",
        description: "Sent to a customer's person when they are invited to the client portal, with a link to choose their password.",
        purpose: "invites",
        required: ["link"],
        variables: [
            { name: "name", description: "The person's name", sample: "Jordan Lee" },
            COMPANY,
            COMPANY_PREFIX,
            { name: "link", description: "The link to choose a password", sample: "https://portal.example.com/set-password?token=abc123" },
            { name: "portal_url", description: "The portal's address", sample: "https://portal.example.com" },
            { name: "valid_days", description: "How many days the link works", sample: "7" },
            { name: "features", description: "What the portal offers beyond tickets, such as \" and invoices\" (can be empty)", sample: " and invoices" },
        ],
        subject: "{{company_prefix}}You have been invited to the customer portal",
        body: [
            "Hello {{name}},",
            "",
            "{{company}} has set up a customer portal for you, where you can follow your support tickets{{features}}.",
            "",
            "Choose your password here (the link works for {{valid_days}} days):",
            "{{link}}",
            "",
            "Then sign in at {{portal_url}}",
        ].join("\n"),
    },
    {
        key: "portal_reset",
        label: "Client portal password reset",
        description: "Sent when someone asks to reset their client portal password.",
        purpose: "password_resets",
        required: ["link"],
        variables: [
            { name: "name", description: "The person's name", sample: "Jordan Lee" },
            COMPANY,
            COMPANY_PREFIX,
            { name: "link", description: "The link to choose a new password", sample: "https://portal.example.com/set-password?token=abc123" },
            { name: "valid_hours", description: "How many hours the link works", sample: "2" },
        ],
        subject: "{{company_prefix}}Reset your portal password",
        body: [
            "Hello {{name}},",
            "",
            "Someone asked to reset the password for your customer portal sign-in. Choose a new one here (the link works for {{valid_hours}} hours):",
            "{{link}}",
            "",
            "If this was not you, you can ignore this email; your password has not changed.",
        ].join("\n"),
    },
    {
        key: "alert",
        label: "Alert notification",
        description: "Sent to the people on an alert notification channel when an alert opens, is still open, or resolves.",
        purpose: "alerts",
        required: [],
        variables: [
            { name: "event", description: "Critical, Warning, Still open, Resolved or Test", sample: "Critical" },
            { name: "title", description: "What the alert is about", sample: "Disk C: is 96% full on FRONTDESK-PC" },
            { name: "customer", description: "The customer and site of the device (can be empty)", sample: "Contoso Legal / Main office" },
            { name: "customer_line", description: "\"Customer: \" and the customer and site, or nothing", sample: "Customer: Contoso Legal / Main office" },
            { name: "detail", description: "More about the alert (can be empty)", sample: "C: has 4.1 GB free of 237 GB." },
            { name: "device_line", description: "\"Open the device: \" and its address in the console, or nothing", sample: "Open the device: https://console.example.com/devices/7f3a" },
            { name: "alerts_line", description: "\"All alerts: \" and the alerts page address, or nothing", sample: "All alerts: https://console.example.com/alerts" },
        ],
        subject: "[{{event}}] {{title}}",
        body: ["{{title}}", "{{customer_line}}", "", "{{detail}}", "", "{{device_line}}", "{{alerts_line}}"].join("\n"),
    },
    {
        key: "invoice",
        label: "Invoice or quote",
        description: "Sent with the PDF attached when an invoice or a quote is emailed to a customer.",
        purpose: "reports",
        required: [],
        variables: [
            COMPANY_PREFIX,
            { name: "document", description: "invoice or quote", sample: "invoice" },
            { name: "document_title", description: "Invoice or Quote", sample: "Invoice" },
            { name: "number", description: "The document number", sample: "INV-1042" },
            { name: "total", description: "The total with its currency", sample: "$1,250.00" },
            { name: "due_line", description: "\"It is due on \" and the date (invoices only), or nothing", sample: "It is due on 2026-12-15." },
            { name: "link_line", description: "A line with the link to view (and pay) it online, or nothing", sample: "You can view it and pay online here: https://billing.example.com/pay/abc" },
        ],
        subject: "{{company_prefix}}{{document_title}} {{number}}",
        body: ["Hello,", "", "Your {{document}} {{number}} for {{total}} is attached.", "{{due_line}}", "", "{{link_line}}"].join("\n"),
    },
    {
        key: "visit_tech",
        label: "Visit booked (technician)",
        description: "Sent to each technician when a visit is booked or changed, with a calendar file attached.",
        purpose: "tickets",
        required: [],
        variables: [
            { name: "name", description: "The technician's name", sample: "Sam Rivera" },
            { name: "what", description: "booked, changed or cancelled", sample: "booked" },
            { name: "ticket", description: "The ticket number and subject", sample: "#1042 Printer offline" },
            { name: "customer", description: "The customer's name (can be empty)", sample: "Contoso Legal" },
            { name: "when", description: "Date, time and time zone of the visit", sample: "Tue 17 Nov 2026, 09:00 to 10:30 (Europe/London)" },
            { name: "location_line", description: "\"Where: \" and the place, or nothing", sample: "Where: 12 High Street, front desk" },
            { name: "notes_line", description: "\"Notes: \" and the notes, or nothing", sample: "Notes: Bring a spare toner." },
            { name: "link", description: "The address of the ticket in the console", sample: "https://console.example.com/tickets/42" },
        ],
        subject: "Visit {{what}}: {{ticket}} on {{when}}",
        body: ["Hello {{name}},", "", "A visit has been {{what}} for ticket {{ticket}}.", "Customer: {{customer}}", "When: {{when}}", "{{location_line}}", "{{notes_line}}", "", "Open the ticket: {{link}}", "A calendar file is attached."].join("\n"),
    },
    {
        key: "visit_customer",
        label: "Visit booked (customer)",
        description: "Optionally sent to the customer's contact when a visit is booked, moved or cancelled.",
        purpose: "tickets",
        required: [],
        variables: [
            { name: "name", description: "The contact's name", sample: "Jordan Lee" },
            COMPANY,
            { name: "what", description: "booked, rescheduled or cancelled", sample: "booked" },
            { name: "ticket", description: "The ticket number and subject", sample: "#1042 Printer offline" },
            { name: "when", description: "Date, time and time zone of the visit", sample: "Tue 17 Nov 2026, 09:00 to 10:30 (Europe/London)" },
            { name: "technicians", description: "Who is coming", sample: "Sam Rivera" },
            { name: "location_line", description: "\"Where: \" and the place, or nothing", sample: "Where: 12 High Street, front desk" },
        ],
        subject: "Your visit has been {{what}}: {{ticket}}",
        body: ["Hello {{name}},", "", "{{company}} has {{what}} a visit for your ticket {{ticket}}.", "When: {{when}}", "Who: {{technicians}}", "{{location_line}}", "", "Reply to this email if the time does not suit you."].join("\n"),
    },
    {
        key: "survey_request",
        label: "Satisfaction survey",
        description: "Sent to the person who asked for help, after their ticket is resolved or closed, with a link to rate the service.",
        purpose: "tickets",
        required: ["link"],
        variables: [
            { name: "name", description: "The person's name", sample: "Jordan Lee" },
            COMPANY,
            COMPANY_PREFIX,
            { name: "ticket_number", description: "The ticket number", sample: "1042" },
            { name: "ticket_subject", description: "The ticket's subject", sample: "Printer offline in reception" },
            { name: "technician", description: "Who looked after the ticket (can be empty)", sample: "Sam Rivera" },
            { name: "link", description: "The link to the one-question survey", sample: "https://console.example.com/survey?t=abc123" },
            { name: "rating_links", description: "One link per rating: a click opens the survey with that rating chosen, and one more click sends it", sample: "5 - Very happy: https://console.example.com/survey?t=abc123&r=5\n1 - Very unhappy: https://console.example.com/survey?t=abc123&r=1" },
            { name: "valid_days", description: "How many days the link works", sample: "30" },
        ],
        subject: "{{company_prefix}}How did we do? Ticket #{{ticket_number}}",
        body: [
            "Hello {{name}},",
            "",
            "Your ticket #{{ticket_number}} (\"{{ticket_subject}}\") has been resolved. We would like to know how it went. Choose a rating:",
            "",
            "{{rating_links}}",
            "",
            "Or open the survey: {{link}}",
            "The link works for {{valid_days}} days, and once.",
        ].join("\n"),
    },
    {
        key: "survey_low_score",
        label: "Low survey score",
        description: "Sent to the people chosen in Administration > Surveys when a customer gives a low score.",
        purpose: "alerts",
        required: [],
        variables: [
            { name: "score", description: "The score given, out of 5", sample: "1" },
            { name: "customer", description: "The customer (can be empty)", sample: "Contoso Legal" },
            { name: "customer_line", description: "\"Customer: \" and the customer, or nothing", sample: "Customer: Contoso Legal" },
            { name: "requester", description: "Who answered", sample: "Jordan Lee" },
            { name: "ticket_number", description: "The ticket number", sample: "1042" },
            { name: "ticket_subject", description: "The ticket's subject", sample: "Printer offline in reception" },
            { name: "technician", description: "Who looked after the ticket (can be empty)", sample: "Sam Rivera" },
            { name: "comment", description: "What they wrote (can be empty)", sample: "Took three visits to fix." },
            { name: "link_line", description: "\"Open the ticket: \" and its address in the console, or nothing", sample: "Open the ticket: https://console.example.com/tickets/7f3a" },
        ],
        subject: "[Low score {{score}}/5] Ticket #{{ticket_number}}: {{ticket_subject}}",
        body: ["{{requester}} rated ticket #{{ticket_number}} {{score}} out of 5.", "{{customer_line}}", "Technician: {{technician}}", "", "{{comment}}", "", "{{link_line}}"].join("\n"),
    },
];

export function templateDef(key: string): EmailTemplateDef {
    const def = EMAIL_TEMPLATES.find((t) => t.key === key);
    if (!def) throw new BadRequestException("There is no such email template.");
    return def;
}

const VAR = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

/** The variable names used in a text. */
export function variablesIn(text: string): string[] {
    return [...new Set([...text.matchAll(VAR)].map((m) => m[1].toLowerCase()))];
}

/**
 * Fills in the variables, once, so a value that itself contains {{braces}} is never filled in again. A line that
 * ended up empty because of an empty variable does not leave a gap: runs of blank lines become one, and the ends are trimmed.
 */
export function renderText(text: string, values: Record<string, string>): string {
    const out = text.replace(VAR, (_m, name: string) => String(values[name.toLowerCase()] ?? ""));
    return out
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/g, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** A subject is one line: a value with a line break in it (a hostile name) cannot add headers. */
export function renderSubject(text: string, values: Record<string, string>): string {
    return renderText(text, values).replace(/\s*\n+\s*/g, " ").slice(0, 300);
}

/** The values for the preview and the test email. */
export function sampleValues(def: EmailTemplateDef): Record<string, string> {
    return Object.fromEntries(def.variables.map((v) => [v.name, v.sample]));
}

/** What may be saved as the wording of a template: a subject and a body that use only its variables and keep the ones it needs. */
export function checkWording(def: EmailTemplateDef, subjectIn: unknown, bodyIn: unknown): { subject: string; body: string } {
    const subject = String(subjectIn ?? "").replace(/\s+/g, " ").trim();
    const body = String(bodyIn ?? "").replace(/\r\n?/g, "\n").trim();
    if (!subject) throw new BadRequestException("Give the email a subject.");
    if (!body) throw new BadRequestException("Write the email's text.");
    if (subject.length > SUBJECT_MAX) throw new BadRequestException(`The subject is too long (${SUBJECT_MAX} characters at most).`);
    if (body.length > BODY_MAX) throw new BadRequestException(`The text is too long (${BODY_MAX} characters at most).`);
    const known = new Set(def.variables.map((v) => v.name));
    const unknown = [...new Set([...variablesIn(subject), ...variablesIn(body)])].filter((n) => !known.has(n));
    if (unknown.length) {
        throw new BadRequestException(`${unknown.map((n) => `{{${n}}}`).join(", ")} ${unknown.length === 1 ? "is not a variable" : "are not variables"} this email can use. You can use: ${def.variables.map((v) => `{{${v.name}}}`).join(", ")}.`);
    }
    const used = new Set([...variablesIn(subject), ...variablesIn(body)]);
    const missing = def.required.filter((n) => !used.has(n));
    if (missing.length) throw new BadRequestException(`The text must include ${missing.map((n) => `{{${n}}}`).join(", ")}, or the person cannot use the email.`);
    return { subject, body };
}
