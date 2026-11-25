// Agent properties in scripts: {{agent.hostname}}, {{agent.customer}} and so on, and the device's customer's custom
// fields: {{customer.account_manager}} (the key shown under Administration > Custom Fields).
//
// Just before a script is sent to a device, each {{agent.<name>}} and {{customer.<field>}} is replaced with that device's
// value. The rules:
//  - A name that is not known, or a value the device does not have, STOPS the script: nothing the author wrote is run.
//    Instead the device is sent a tiny script that prints which property was the trouble to the script's output and
//    exits with an error, so it shows up in the run history like any other failure.
//  - A value is only put into the script text when it holds nothing a shell could act on (no quotes, $, backticks,
//    brackets, ; | & < > and so on). Otherwise the script stops the same way and says to read the value from its
//    environment variable instead (RIQ_AGENT_<NAME>), which is never parsed as code. Every property is always
//    available as an environment variable when a script uses any {{agent.*}} at all.
//  - Anything else in double braces is left alone.

export type ScriptLanguage = "powershell" | "bash" | "cmd";

/** The properties a script can ask for, and what each is. */
export const AGENT_PROPERTIES: Record<string, string> = {
    hostname: "The device's host name",
    name: "The device's display name (its alias, or its host name)",
    id: "The device's id in RemoteIQ",
    uuid: "The agent's id",
    os: "windows or linux",
    osname: "The operating system as the device reports it",
    user: "The user last seen signed in",
    customer: "The customer's name",
    customer_id: "The customer's id",
    site: "The site's name",
    site_id: "The site's id",
    tags: "The device's tags, separated by commas",
    version: "The agent's version",
    status: "online or offline, as last known",
};

const REFERENCE = /\{\{\s*agent\.([A-Za-z0-9_]+)\s*\}\}/gi;
const CUSTOM_REFERENCE = /\{\{\s*customer\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gi;

/** Keys of the customer's custom fields a script asks for, lower-case, without repeats. */
export function referencedCustomFields(text: string): string[] {
    const out = new Set<string>();
    for (const m of String(text ?? "").matchAll(CUSTOM_REFERENCE)) out.add(m[1].toLowerCase());
    return [...out];
}

export const customEnvName = (key: string) => `RIQ_CUSTOMER_${key.toUpperCase()}`;

/** Names of the properties a script text asks for, lower-case, without repeats. */
export function referencedProperties(text: string): string[] {
    const out = new Set<string>();
    for (const m of String(text ?? "").matchAll(REFERENCE)) out.add(m[1].toLowerCase());
    return [...out];
}

/** Whether a value can sit inside script text without a shell being able to read anything into it. */
export function isSafeToInline(value: string): boolean {
    if (/[\u0000-\u001f\u007f]/.test(value)) return false;
    return !/[`$"';|&<>(){}]/.test(value);
}

export const envName = (property: string) => `RIQ_AGENT_${property.toUpperCase()}`;

/** A script that only reports why the real one was not run. The message holds property names, never values. */
export function failureScript(language: ScriptLanguage, message: string): string {
    const safe = message.replace(/[\u0000-\u001f\u007f]/g, " ");
    if (language === "cmd") {
        return `@echo off\r\necho ${safe.replace(/[&|<>^%"]/g, "")} 1>&2\r\nexit /b 1\r\n`;
    }
    if (language === "powershell") {
        return `[Console]::Error.WriteLine('${safe.replace(/'/g, "''")}')\r\nexit 1\r\n`;
    }
    return `printf '%s\\n' '${safe.replace(/'/g, "'\\''")}' >&2\nexit 1\n`;
}

export type PropertyResult =
    | { used: false }
    | { used: true; ok: true; scriptText: string; env: Record<string, string> }
    | { used: true; ok: false; problems: string[]; scriptText: string; env: Record<string, string> };

/**
 * Fills in {{agent.*}} for one device. `values` holds every property the device has (missing or empty ones left out or
 * empty). A script with no {{agent.*}} in it is returned as `{ used: false }`, untouched.
 */
export function applyAgentProperties(
    language: ScriptLanguage,
    scriptText: string,
    values: Record<string, string | null | undefined>,
    /** The customer's custom fields in use: key to its value as text ("" when the customer has none). */
    custom: Record<string, string> = {}
): PropertyResult {
    const wanted = referencedProperties(scriptText);
    const wantedCustom = referencedCustomFields(scriptText);
    if (!wanted.length && !wantedCustom.length) return { used: false };

    const env: Record<string, string> = {};
    if (wanted.length) for (const name of Object.keys(AGENT_PROPERTIES)) env[envName(name)] = String(values[name] ?? "");
    if (wantedCustom.length) for (const [key, v] of Object.entries(custom)) env[customEnvName(key)] = String(v ?? "");

    const problems: string[] = [];
    for (const key of wantedCustom) {
        if (!(key in custom)) {
            const known = Object.keys(custom);
            problems.push(`{{customer.${key}}} is not a custom field. ${known.length ? `Custom fields: ${known.map((k) => `customer.${k}`).join(", ")}.` : "There are no custom fields yet."}`);
            continue;
        }
        const v = String(custom[key] ?? "");
        if (!v.trim()) { problems.push(`{{customer.${key}}} has no value for this device's customer.`); continue; }
        if (!isSafeToInline(v)) problems.push(`{{customer.${key}}} holds characters that are not safe to put into script text. Read it from the environment variable ${customEnvName(key)} instead.`);
    }
    for (const name of wanted) {
        if (!(name in AGENT_PROPERTIES)) { problems.push(`{{agent.${name}}} is not a property RemoteIQ knows. Known properties: ${Object.keys(AGENT_PROPERTIES).map((n) => `agent.${n}`).join(", ")}.`); continue; }
        const v = String(values[name] ?? "");
        if (!v.trim()) { problems.push(`{{agent.${name}}} has no value on this device.`); continue; }
        if (!isSafeToInline(v)) problems.push(`{{agent.${name}}} holds characters that are not safe to put into script text. Read it from the environment variable ${envName(name)} instead.`);
    }
    if (problems.length) {
        const message = `RemoteIQ did not run this script. ${problems.join(" ")}`;
        return { used: true, ok: false, problems, scriptText: failureScript(language, message), env };
    }

    const filled = String(scriptText)
        .replace(REFERENCE, (_m, name: string) => String(values[name.toLowerCase()]).trim())
        .replace(CUSTOM_REFERENCE, (_m, key: string) => String(custom[key.toLowerCase()]).trim());
    return { used: true, ok: true, scriptText: filled, env };
}
