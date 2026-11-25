// backend/src/auto-repair/playbooks.core.ts
//
// Your own repairs: a problem you describe, a script that detects it (read only) and a script that repairs it. They run inside the same find, repair and
// confirm loop as the built-in ones, but only after the Owner approves the exact scripts, and only while the scripts still match what was approved.
// Everything here is pure: checking what a person typed, the hash an approval is bound to, and putting approved scripts into the two fixed scripts.
import { BadRequestException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { CATEGORIES, ISSUES, type Category, type IssueDef, type IssueId } from "./auto-repair.core";

export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];
export const STATUSES = ["draft", "tested", "approved", "disabled"] as const;
export type PlaybookStatus = (typeof STATUSES)[number];
export const MAX_SCRIPT_CHARS = 20_000;
export const MAX_PLAYBOOKS_PER_RUN = 10;

export type PlaybookFields = {
    title: string; plain: string; signs: string; fixText: string; ifItReturns: string;
    categories: Category[]; appWords: string[]; checkService: string | null; checkMetric: "disk" | "cpu" | null;
    detectScript: string; fixScript: string; risk: Risk;
};

/** What a script must never do on a customer's computer from an automatic repair. These are refused outright. */
const FORBIDDEN: Array<[RegExp, string]> = [
    [/\b(Restart-Computer|Stop-Computer)\b|\bshutdown(\.exe)?\s+\/[rsgp]/i, "restarting or shutting down the computer (a repair must never do that: ask the person to restart instead)"],
    [/\b(Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk|Set-Disk)\b|\bdiskpart\b|\bformat(\.com)?\s+[a-z]:/i, "formatting, wiping or partitioning a disk"],
    [/\bcipher(\.exe)?\s+\/w/i, "wiping free space"],
];

/** Things that are allowed but that the Owner is shown before approving. */
const ATTENTION: Array<[RegExp, string]> = [
    [/\b(Invoke-Expression|iex)\b/i, "runs text as a command (Invoke-Expression)"],
    [/\b(DownloadString|DownloadFile|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|curl|wget)\b/i, "downloads from the internet"],
    [/\b(Remove-Item|rd|rmdir|del)\b[^\n]*(-Recurse|\/s)\b/i, "deletes folders with everything in them"],
    [/\b(net\s+user|New-LocalUser|Add-LocalGroupMember|net\s+localgroup)\b/i, "changes user accounts or groups"],
    [/\b(reg(\.exe)?\s+delete|Remove-ItemProperty|Remove-Item\s+HK)/i, "deletes registry entries"],
    [/\b(Set-ExecutionPolicy|Set-MpPreference|Add-MpPreference|Disable-NetAdapter|netsh\s+advfirewall|Set-NetFirewall|Stop-Service|Set-Service|sc(\.exe)?\s+(config|stop|delete))\b/i, "changes a security or system setting or service"],
    [/\b(Stop-Process|taskkill)\b/i, "closes programs (a person may lose unsaved work)"],
    [/\b(Uninstall-Package|msiexec|wmic\s+product)\b/i, "uninstalls software"],
    [/-EncodedCommand|\bFromBase64String\b/i, "hides text by encoding it"],
];

export function scriptWarnings(...texts: string[]): string[] {
    const all = texts.join("\n");
    return ATTENTION.filter(([re]) => re.test(all)).map(([, why]) => why);
}

const oneLine = (v: unknown, max: number, label: string, required: boolean) => {
    const s = String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    if (required && !s) throw new BadRequestException(`${label} is needed.`);
    if (s.length > max) throw new BadRequestException(`${label} is too long (${max} characters at most).`);
    return s;
};

const scriptText = (v: unknown, label: string, required: boolean) => {
    const s = String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+$/, "");
    if (required && !s.trim()) throw new BadRequestException(`${label} is needed.`);
    if (s.length > MAX_SCRIPT_CHARS) throw new BadRequestException(`${label} is too long (${MAX_SCRIPT_CHARS} characters at most).`);
    for (const [re, why] of FORBIDDEN) if (re.test(s)) throw new BadRequestException(`${label} is refused: it contains ${why}.`);
    return s;
};

/** What a person typed for a playbook, checked and cleaned; throws with words when something is wrong. */
export function cleanPlaybook(input: Record<string, unknown>): PlaybookFields {
    const categories: Category[] = [];
    for (const c of Array.isArray(input.categories) ? input.categories : []) {
        const hit = CATEGORIES.find((x) => x.toLowerCase() === String(c).trim().toLowerCase());
        if (!hit) throw new BadRequestException(`"${String(c).slice(0, 40)}" is not one of the categories.`);
        if (!categories.includes(hit)) categories.push(hit);
    }
    const words = (Array.isArray(input.appWords) ? input.appWords : []).map((w) => String(w ?? "").replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
    if (words.length > 10 || words.some((w) => w.length > 60)) throw new BadRequestException("Up to 10 program words, each at most 60 characters.");
    const service = oneLine(input.checkService, 80, "The service name", false);
    const metric = input.checkMetric === "disk" || input.checkMetric === "cpu" ? input.checkMetric : null;
    if (input.checkMetric && !metric) throw new BadRequestException("The measure of a failed check is disk or cpu.");
    if (!categories.length && !service && !metric) throw new BadRequestException("Say when it applies: choose at least one category, or a failed check (a service name, or disk or processor).");
    if (words.length && !categories.includes("Software Issue")) throw new BadRequestException("Program words only make sense with the category Software Issue.");
    const risk = RISKS.find((r) => r === input.risk);
    if (!risk) throw new BadRequestException("Choose how risky the repair is: low, medium or high.");
    const detect = scriptText(input.detectScript, "The detection script", true);
    const fix = scriptText(input.fixScript, "The repair script", false);
    if (!/DETECTED\|/.test(detect)) throw new BadRequestException("The detection script must print a line starting with DETECTED| followed by what it found, when the problem is there (and nothing of that kind when it is not).");
    if (fix && !/(FIXED|FAILED)\|/.test(fix)) throw new BadRequestException("The repair script must print FIXED|what it did, or FAILED|why, so the result can be checked.");
    return {
        title: oneLine(input.title, 120, "The title", true), plain: oneLine(input.plain, 300, "What it means for the person (one sentence)", true),
        signs: oneLine(input.signs, 1000, "The signs", false), fixText: oneLine(input.fixText, 600, "What the repair does", !!fix), ifItReturns: oneLine(input.ifItReturns, 600, "What to do if it returns", false),
        categories, appWords: words, checkService: service || null, checkMetric: metric, detectScript: detect, fixScript: fix, risk,
    };
}

/** A new id for a playbook. It is what scripts print and what runs record, so it is short, lower case and cannot clash with a built-in problem. */
export function newPlaybookKey(): string {
    return `c-${randomBytes(4).toString("hex")}`;
}

/** The hash an approval is bound to: the scripts and everything that decides when they run. Change any of it and the approval no longer applies. */
export function contentHash(key: string, f: Pick<PlaybookFields, "detectScript" | "fixScript" | "categories" | "appWords" | "checkService" | "checkMetric" | "risk">): string {
    return createHash("sha256").update(JSON.stringify([key, f.detectScript, f.fixScript, [...f.categories].sort(), [...f.appWords].sort(), f.checkService, f.checkMetric, f.risk])).digest("hex");
}

/** The problem as the repair loop sees it. A playbook with no repair script only detects: a technician is told. */
export function issueOfPlaybook(key: string, f: Pick<PlaybookFields, "title" | "plain" | "signs" | "fixText" | "ifItReturns" | "fixScript" | "risk">): IssueDef {
    return {
        id: key as IssueId, kind: f.fixScript ? "repair" : "escalate", title: f.title, plain: f.plain,
        signs: f.signs || `${f.plain}.`, fix: f.fixText, ifItReturns: f.ifItReturns || "If it comes back, a technician should look into the cause.", urgent: false,
    };
}

/** Makes the problem known to the loop (its ids are accepted from the scripts, its words used in replies and the KB). */
export function registerPlaybookIssue(key: string, def: IssueDef) { (ISSUES as Record<string, IssueDef>)[key] = def; }
export function forgetPlaybookIssues(keep: Set<string>) { for (const k of Object.keys(ISSUES)) if (k.startsWith("c-") && !keep.has(k)) delete (ISSUES as Record<string, IssueDef>)[k]; }

/** Does a playbook apply to this ticket or failed check? */
export function applies(f: Pick<PlaybookFields, "categories" | "appWords" | "checkService" | "checkMetric">, ctx: { category?: string | null; app?: string | null; checkService?: string | null; checkMetric?: string | null }): boolean {
    if (ctx.category && f.categories.some((c) => c === ctx.category)) {
        if (!f.appWords.length) return true;
        const app = (ctx.app ?? "").toLowerCase();
        return f.appWords.some((w) => app.includes(w));
    }
    if (ctx.checkService && f.checkService && ctx.checkService.trim().toLowerCase() === f.checkService.trim().toLowerCase()) return true;
    if (ctx.checkMetric && f.checkMetric && ctx.checkMetric === f.checkMetric) return true;
    return false;
}

/* ------------------------------ putting approved scripts into the two fixed scripts ------------------------------ */

const blockOf = (text: string) => text.replace(/\r\n?/g, "\n");

/**
 * The checking script with your detection scripts added just before it finishes. Each runs in its own script block; only a line that starts with
 * DETECTED| counts, and what it printed is kept (clipped) in the log. An error in one script costs that script, never the others.
 */
export function composeDiagnose(base: string, items: Array<{ key: string; detectScript: string }>): string {
    if (!items.length) return base;
    const head = `
function RunCustom([string]$id, [scriptblock]$sb) {
  try {
    $o = (& $sb 2>&1 | Out-String)
    $m = [regex]::Match($o, '(?m)^DETECTED\\|(.*)$')
    if ($m.Success) { Issue $id $m.Groups[1].Value }
    $one = (($o -split "\\r?\\n") | Where-Object { $_.Trim() } | Select-Object -First 3) -join ' / '
    Info ($id + '_output') $one
  } catch { Info ($id + '_error') $_.Exception.Message }
}
`;
    const blocks = items.map((i) => `RunCustom '${i.key}' {\n${blockOf(i.detectScript)}\n}`).join("\n");
    const end = "Write-Output 'DONE'";
    const at = base.lastIndexOf(end);
    return at < 0 ? base : `${base.slice(0, at)}${head}${blocks}\n${base.slice(at)}`;
}

/** The repair script with your repair scripts added. Each is only run when its problem is in the list to repair, and its FIXED| or FAILED| line is the result. */
export function composeRepair(base: string, items: Array<{ key: string; fixScript: string }>): string {
    const withFix = items.filter((i) => i.fixScript.trim());
    if (!withFix.length) return base;
    const marker = "$custom = @{}";
    const at = base.indexOf(marker);
    if (at < 0) return base;
    const defs = withFix.map((i) => `$custom['${i.key}'] = {\n${blockOf(i.fixScript)}\n}`).join("\n");
    return `${base.slice(0, at + marker.length)}\n${defs}${base.slice(at + marker.length)}`;
}
