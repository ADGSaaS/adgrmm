// backend/src/system-health/system-health.core.ts
//
// Pure rules for the health of the ADG RMM servers themselves. Each check turns a measurement into ok / warn / critical with a sentence
// the Owner can read. The service measures; nothing here touches the database or the machine, so every rule can be tested by itself.
export type Status = "ok" | "warn" | "critical";
export type Result = { key: string; title: string; status: Status; detail: string };

export const RESTORE_TEST_EVERY_DAYS = 30;     // a restore test is started when the last good one is older than this
export const RESTORE_TEST_STALE_DAYS = 35;     // and the check goes warn when it is older than this
export const RESTORE_RETRY_HOURS = 24;         // after a failed restore test, try again no sooner than this
export const BACKUP_WARN_HOURS = 36;
export const BACKUP_CRITICAL_HOURS = 72;

const worst = (a: Status, b: Status): Status => (a === "critical" || b === "critical" ? "critical" : a === "warn" || b === "warn" ? "warn" : "ok");
export const overall = (items: Array<{ status: Status }>): Status => items.reduce<Status>((s, i) => worst(s, i.status), "ok");

export function databaseCheck(ms: number | null, error?: string): Result {
    if (ms === null) return { key: "database", title: "Database", status: "critical", detail: `The database does not answer${error ? `: ${error}` : ""}.` };
    if (ms > 2000) return { key: "database", title: "Database", status: "critical", detail: `The database answered in ${ms} ms (very slow).` };
    if (ms > 500) return { key: "database", title: "Database", status: "warn", detail: `The database answered in ${ms} ms (slow).` };
    return { key: "database", title: "Database", status: "ok", detail: `Answers in ${ms} ms.` };
}

export function diskCheck(freeBytes: number | null, totalBytes: number | null, where: string): Result {
    if (freeBytes === null || !totalBytes) return { key: "disk", title: "Server disk", status: "warn", detail: "Free disk space could not be read." };
    const pct = (freeBytes / totalBytes) * 100;
    const gb = (freeBytes / 1024 ** 3).toFixed(1);
    const text = `${gb} GB free (${pct.toFixed(0)}%) on ${where}.`;
    if (pct < 5 || freeBytes < 1024 ** 3) return { key: "disk", title: "Server disk", status: "critical", detail: `Almost full: ${text}` };
    if (pct < 15) return { key: "disk", title: "Server disk", status: "warn", detail: `Getting full: ${text}` };
    return { key: "disk", title: "Server disk", status: "ok", detail: text };
}

export function memoryCheck(freeBytes: number, totalBytes: number): Result {
    const usedPct = totalBytes ? ((totalBytes - freeBytes) / totalBytes) * 100 : 0;
    const text = `${usedPct.toFixed(0)}% of memory in use.`;
    if (usedPct > 95) return { key: "memory", title: "Server memory", status: "critical", detail: `Nearly out of memory: ${text}` };
    if (usedPct > 88) return { key: "memory", title: "Server memory", status: "warn", detail: `Memory is tight: ${text}` };
    return { key: "memory", title: "Server memory", status: "ok", detail: text };
}

export function queueCheck(stuck: number): Result {
    if (stuck >= 200) return { key: "queue", title: "Jobs for computers", status: "warn", detail: `${stuck} jobs have waited more than 30 minutes (many computers offline, or the job service is stuck).` };
    return { key: "queue", title: "Jobs for computers", status: "ok", detail: stuck ? `${stuck} jobs waiting more than 30 minutes (normal while computers are off).` : "No jobs stuck." };
}

const ago = (hours: number) => (hours < 48 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`);

/** A backup much smaller than the one before it usually means something was left out. Sizes are newest first. */
export function sizeWarning(sizes: number[]): string | null {
    const [newest, ...before] = sizes.filter((n) => Number.isFinite(n) && n >= 0);
    if (newest === undefined) return null;
    const mb = (n: number) => (n / 1024 / 1024 >= 1 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    if (newest < 10 * 1024) return `The newest backup is only ${mb(newest)}, which is too small to be a database.`;
    if (!before.length) return null;
    const sorted = [...before].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0 && newest < median * 0.5) return `The newest backup (${mb(newest)}) is less than half the size of the ones before it (about ${mb(median)}).`;
    return null;
}

export function backupCheck(lastGoodAt: Date | null, now: Date, lastFailedAt: Date | null, sizes: number[] = []): Result {
    const r = backupCheckTime(lastGoodAt, now, lastFailedAt);
    const warn = r.status === "critical" ? null : sizeWarning(sizes);
    return warn ? { ...r, status: r.status === "ok" ? "warn" : r.status, detail: `${r.detail} ${warn}` } : r;
}

function backupCheckTime(lastGoodAt: Date | null, now: Date, lastFailedAt: Date | null): Result {
    if (!lastGoodAt) return { key: "backup", title: "Backups", status: "critical", detail: "There is no completed backup of the ADG RMM database." };
    const hours = (+now - +lastGoodAt) / 3600_000;
    if (hours > BACKUP_CRITICAL_HOURS) return { key: "backup", title: "Backups", status: "critical", detail: `The last good backup was ${ago(hours)}.` };
    if (hours > BACKUP_WARN_HOURS) return { key: "backup", title: "Backups", status: "warn", detail: `The last good backup was ${ago(hours)}${lastFailedAt && +lastFailedAt > +lastGoodAt ? " and the one after it failed" : ""}.` };
    return { key: "backup", title: "Backups", status: "ok", detail: `Last good backup ${ago(hours)}.` };
}

export type RestoreFacts = { testableBackup: boolean; lastGoodAt: Date | null; lastFailedAt: Date | null; lastError: string | null; running: boolean };

const failedLast = (f: RestoreFacts) => !!f.lastFailedAt && (!f.lastGoodAt || +f.lastFailedAt > +f.lastGoodAt);

export function restoreCheck(f: RestoreFacts, now: Date): Result {
    const key = "restore", title = "Restore test";
    if (failedLast(f) && !f.running) {
        return { key, title, status: "critical", detail: `The last restore test failed${f.lastError ? `: ${f.lastError.slice(0, 200)}` : ""}. A backup that cannot be restored is not a backup.` };
    }
    if (f.lastGoodAt) {
        const days = (+now - +f.lastGoodAt) / 86400_000;
        if (days > RESTORE_TEST_STALE_DAYS) return { key, title, status: "warn", detail: `The last successful restore test was ${Math.round(days)} days ago.` };
        return { key, title, status: "ok", detail: `A backup was restored into a scratch database ${days < 1 ? "today" : `${Math.round(days)} days ago`} and checked.` };
    }
    if (f.running) return { key, title, status: "warn", detail: "The first restore test is running." };
    if (!f.testableBackup) return { key, title, status: "warn", detail: "No restore test yet: there is no completed, verified PostgreSQL backup to test." };
    return { key, title, status: "warn", detail: "No restore test has ever succeeded. One will start automatically." };
}

/** Whether the scheduler should start a restore test now. */
export function shouldStartRestore(f: RestoreFacts, now: Date): boolean {
    if (!f.testableBackup || f.running) return false;
    if (failedLast(f) && (+now - +f.lastFailedAt!) / 3600_000 < RESTORE_RETRY_HOURS) return false;
    if (!f.lastGoodAt) return true;
    return (+now - +f.lastGoodAt) / 86400_000 >= RESTORE_TEST_EVERY_DAYS;
}

/** The message for a change of state, or null when nothing changed (or a first reading that is fine). */
export function changeMessage(r: Result, notified: Status | null): { subject: string; body: string } | null {
    if (r.status === "ok") return notified && notified !== "ok" ? { subject: `ADG RMM recovered: ${r.title}`, body: `${r.title} is fine again. ${r.detail}` } : null;
    if (notified === r.status) return null;
    return { subject: `ADG RMM ${r.status === "critical" ? "CRITICAL" : "warning"}: ${r.title}`, body: `${r.title}: ${r.detail}` };
}

/** A web address that should answer: the console (front end) or the address agents connect to. */
export function webCheck(key: string, title: string, url: string, status: number | null, ms: number | null, error?: string): Result {
    if (status === null) return { key, title, status: "critical", detail: `${url} does not answer${error ? `: ${error}` : ""}.` };
    if (status >= 500) return { key, title, status: "critical", detail: `${url} answers with an error (${status}).` };
    if (status >= 400 && key === "agentport") return { key, title, status: "warn", detail: `${url} answers ${status}.` };
    if ((ms ?? 0) > 3000) return { key, title, status: "warn", detail: `${url} answers slowly (${ms} ms).` };
    return { key, title, status: "ok", detail: `${url} answers in ${ms} ms.` };
}

/** Are computers still reaching the server? Quiet only matters when some were reaching it recently. */
export function agentsCheck(total: number, last15: number, lastDay: number): Result {
    const key = "agents", title = "Computers reaching the server";
    if (total === 0) return { key, title, status: "ok", detail: "No computers enrolled yet." };
    if (last15 === 0 && lastDay > 0) return { key, title, status: "critical", detail: `No computer has reached the server in 15 minutes, though ${lastDay} did in the last day. Check the connection address and the tunnel.` };
    if (last15 === 0) return { key, title, status: "warn", detail: "No computer has reached the server for over a day." };
    return { key, title, status: "ok", detail: `${last15} of ${total} computers reached the server in the last 15 minutes.` };
}
