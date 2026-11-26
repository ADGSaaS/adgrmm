// components/automation/script-types.ts
//
// What the scripts manager shares between the page, the script editor window and the category tiles.

export type ScriptParameter = { name: string; label?: string; required?: boolean; defaultValue?: string };

/** "both" is Windows and Linux; "all" is Windows, Linux and macOS (three texts). */
export type ScriptPlatform = "windows" | "linux" | "both" | "all";
export const platformOfScript = (s: { platform?: ScriptPlatform; language: "powershell" | "bash" }): ScriptPlatform => s.platform ?? (s.language === "powershell" ? "windows" : "linux");
export const PLATFORM_LABEL: Record<ScriptPlatform, string> = { windows: "Windows", linux: "Linux", both: "Windows and Linux", all: "Windows, Linux and macOS" };

export type Script = {
    id: string;
    name: string;
    description: string | null;
    script: string;
    language: "powershell" | "bash";
    /** Which systems it is for. "both" holds a PowerShell text (script) for Windows and a bash text (linuxScript) for Linux. */
    platform?: ScriptPlatform;
    linuxScript?: string | null;
    macosScript?: string | null;
    timeoutSec: number;
    parameters: ScriptParameter[];
    /** Shipped with ADG RMM. It can be edited; the script then shows as Customized and stops following updates. */
    builtin?: boolean;
    /** A built-in whose text or settings were changed by a person. It can be reset to the shipped version. */
    customized?: boolean;
    category?: string | null;
};

export type ScriptCategory = { id: string | null; name: string; builtin: boolean; count: number };

export type ScriptCategories = { items: ScriptCategory[]; uncategorized: number };

/** The right to create and delete categories, separate from the right to create and edit scripts. */
export const CATEGORY_RIGHT = "automation.categories.manage";

/** The "category" a script without one is listed under. */
export const UNCATEGORIZED = "__none__";
