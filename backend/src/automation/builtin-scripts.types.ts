// backend/src/automation/builtin-scripts.types.ts
//
// The shape of one built-in script. Parameters reach a script ONLY as environment variables named ADG_<NAME> (see ScriptsService.environment),
// so a value is never parsed as code. Every script that changes the device needs ADG_CONFIRM to be YES, and every clean-up or
// account change also has a dry run that is ON by default.
export type BuiltinLanguage = "powershell" | "bash";

export const BUILTIN_CATEGORIES = [
    "Diagnostics",
    "Maintenance",
    "Security",
    "Network",
    "Users and accounts",
    "Software and updates",
    "Storage and disk",
    "Services and processes",
    "Inventory and reporting",
] as const;
export type BuiltinCategory = (typeof BUILTIN_CATEGORIES)[number];

export type BuiltinParameter = { name: string; label?: string; required?: boolean; defaultValue?: string };

export type BuiltinScript = {
    /** A stable slug: the script keeps its identity when its name or text is improved. */
    key: string;
    name: string;
    description: string;
    language: BuiltinLanguage;
    category: BuiltinCategory;
    timeoutSec: number;
    parameters: BuiltinParameter[];
    /** The PowerShell text for Windows when `platform` is "all"; otherwise the one text in `language`. */
    script: string;
    /** "all": made for Windows (`script`, PowerShell), Linux (`linuxScript`, bash) and macOS (`macosScript`, bash). */
    platform?: "all";
    linuxScript?: string;
    macosScript?: string;
};

export const CONFIRM_PARAM: BuiltinParameter = {
    name: "confirm",
    label: "Type YES to make the change (anything else only reports what would happen)",
    required: false,
    defaultValue: "NO",
};
