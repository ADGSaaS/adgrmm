"use client";

// A Windows or Linux device's Security tab: the score and grade of its last security scan against the baseline, Microsoft Defender and
// BitLocker status (Windows) or the firewall, SSH, disk encryption and accounts (Linux), and every check with what it means and how to fix it. A scan is a signed script job the device runs (nothing is
// installed on it for this) and it only reads. The Defender buttons update definitions or start a scan; nothing here turns
// protection off or changes exclusions. Everything is recorded in the audit log.
import * as React from "react";
import { ChevronDown, ChevronRight, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorText, Pill } from "@/components/policies/shared";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { deviceFamily } from "@/lib/device-os";
import { ago, RESULT_TEXT, SEVERITY_ORDER, SEVERITY_TEXT, security, type ClamavState, type DefenderAction, type DefenderOutcome, type LinuxAction, type LinuxOutcome, type DeviceSecurity, type Highlights, type LinuxHighlights, type RuleResult, type RuleView, type Severity } from "@/lib/security-api";
import { ScoreRing, TonePill } from "@/components/security/security-parts";
import SecretsCard from "@/components/security/secrets-card";

const POLL_MS = 3000;
const POLL_TRIES = 50;

type Filter = "all" | "fail" | "unknown" | "pass";

const ACTIONS: Record<DefenderAction, { button: string; title: string; body: string; confirm: string }> = {
    update: {
        button: "Update signatures",
        title: "Update Microsoft Defender signatures?",
        body: "Asks Microsoft Defender on this device to download the newest virus definitions now. It can take a minute. Nothing is turned off or changed.",
        confirm: "Update signatures",
    },
    "quick-scan": {
        button: "Quick scan",
        title: "Start a Microsoft Defender quick scan?",
        body: "Starts a quick scan of the places malware usually hides. It runs in the background for a few minutes and the device stays usable.",
        confirm: "Start quick scan",
    },
    "full-scan": {
        button: "Full scan",
        title: "Start a Microsoft Defender full scan?",
        body: "Starts a scan of every file. It can run for hours and slow the device down, so it is best started outside working hours. It keeps running after you leave this page.",
        confirm: "Start full scan",
    },
};

const LINUX_ACTIONS: Record<LinuxAction, { button: string; title: string; body: string; confirm: string }> = {
    "firewall-enable": {
        button: "Turn on firewall",
        title: "Turn on this device's firewall?",
        body: "Allows incoming SSH first (on the port the SSH server uses) and then turns on the firewall that is installed (ufw or firewalld). After that, other incoming connections to this device are blocked, so a web server or file share on it would stop answering other computers until a rule allows it. Nothing is installed.",
        confirm: "Turn on firewall",
    },
    "antivirus-install": {
        button: "Install ClamAV",
        title: "Install ClamAV on this device?",
        body: "Installs ClamAV from the distribution's own repositories (on Rocky, AlmaLinux, CentOS and Oracle Linux that first enables EPEL), downloads its virus signatures and keeps them updating by themselves. No always-on scanner is started (that would use about a gigabyte of memory); scans are started from here. This can take several minutes and keeps running if you leave this page.",
        confirm: "Install ClamAV",
    },
    "antivirus-update": {
        button: "Update signatures",
        title: "Update ClamAV signatures?",
        body: "Downloads the newest ClamAV virus signatures now. ClamAV must already be installed. Nothing else changes.",
        confirm: "Update signatures",
    },
    "malware-scan": {
        button: "Malware scan",
        title: "Scan this device for malware?",
        body: "Runs ClamAV over home folders, /tmp, /opt, /srv, /var/www and /usr/local at low priority. It can take many minutes and keeps running if you leave this page. It only reports: nothing is deleted, moved or quarantined. ClamAV must already be installed (use Install ClamAV).",
        confirm: "Start malware scan",
    },
};

function linuxOutcomeText(r: LinuxOutcome, name: string): string {
    if (r.action === "firewall-enable" || r.action === "antivirus-install" || r.action === "antivirus-update") return `${name}: ${r.message} Run Scan now to see the new score.`;
    if (r.state === "error") return `${name}: the malware scan did not finish${r.message ? ` (${r.message})` : ""}.`;
    const took = r.seconds !== null ? ` in ${r.seconds} s` : "";
    if (r.state === "clean") return `${name}: no malware found${r.scannedFiles !== null ? ` in ${r.scannedFiles} files` : ""}${took}.`;
    const list = r.found.slice(0, 5).map((f) => `${f.signature} in ${f.path}`).join("; ");
    return `${name}: ClamAV found ${r.infectedCount} infected file${r.infectedCount === 1 ? "" : "s"}${took}: ${list}${r.found.length > 5 ? " and more" : ""}. Nothing was deleted or moved; deal with them on the device.`;
}

function outcomeText(action: DefenderAction, r: DefenderOutcome, name: string): string {
    if (action === "update" && "after" in r) return r.changed ? `${name}: definitions updated from ${r.before || "unknown"} to ${r.after}.` : `${name}: definitions are already the newest (${r.after || "unknown"}).`;
    if ("scanType" in r) return `${name}: ${r.scanType === "QuickScan" ? "quick" : "full"} scan started. It runs on the device; run Scan now afterwards to see the result here.`;
    return `${name}: done.`;
}

function resultPill(r: RuleResult) {
    const tone = r === "pass" ? "good" : r === "fail" ? "bad" : "muted";
    return <Pill tone={tone}>{RESULT_TEXT[r]}</Pill>;
}

function RuleRow({ rule, open, onToggle }: { rule: RuleView; open: boolean; onToggle: () => void }) {
    const panel = `rule-${rule.id}`;
    return (
        <li className="border-t first:border-t-0" data-testid="rule-row" data-result={rule.result}>
            <h4 className="m-0 text-sm font-normal">
                <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panel} className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                    {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                    <span className="mt-px shrink-0">{resultPill(rule.result)}</span>
                    <span className="min-w-0">
                        <span className="block font-medium">{rule.title}</span>
                        <span className="block text-xs text-muted-foreground">{rule.detail}</span>
                    </span>
                </button>
            </h4>
            {open ? (
                <div id={panel} className="space-y-2 bg-muted/30 px-4 py-3 pl-10 text-sm">
                    <p><span className="font-medium">What it checks: </span>{rule.checks}</p>
                    <p><span className="font-medium">Why it matters: </span>{rule.why}</p>
                    <p><span className="font-medium">How to fix it: </span>{rule.fix}</p>
                    <p className="text-xs text-muted-foreground">{SEVERITY_TEXT[rule.severity]} severity, weight {rule.weight}.</p>
                </div>
            ) : null}
        </li>
    );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="rounded-lg border p-3" aria-label={title}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
            <div className="mt-1.5 space-y-1 text-sm">{children}</div>
        </section>
    );
}

const AGO = (d: number) => (d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`);

/** The four cards of a Linux device: firewall and SSH, disk encryption and antivirus, accounts, and the system. */
function LinuxCards({ h, av }: { h: LinuxHighlights; av?: ClamavState | null }) {
    const sup = h.os?.support;
    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Card title="Firewall and SSH">
                <p><TonePill label={h.firewall.label} /></p>
                {h.ssh ? (
                    h.ssh.installed ? (
                        <>
                            <p>SSH {h.ssh.running === false ? "installed but not running" : "is running"}{h.ssh.port ? ` on port ${h.ssh.port}` : ""}.</p>
                            <p>Root login: {h.ssh.permitRootLogin ?? "not known"}. Passwords: {h.ssh.passwordAuth === null ? "not known" : h.ssh.passwordAuth ? "accepted" : "not accepted"}.</p>
                        </>
                    ) : <p>No SSH server.</p>
                ) : <p className="text-muted-foreground">SSH settings: not read.</p>}
            </Card>
            <Card title="Disk encryption and antivirus">
                <p><TonePill label={h.encryption.label} /></p>
                {h.encryption.volumes.map((v) => (
                    <p key={v.mount}>{v.mount} {v.state === "on" ? "is encrypted (LUKS)" : v.state === "off" ? "is not encrypted" : "state not known"}.</p>
                ))}
                {h.encryption.note ? <p className="text-xs text-muted-foreground">{h.encryption.note}</p> : null}
                <p>Malware scanner: <TonePill label={h.antivirus.label} /></p>
                {av?.lastScan ? (
                    <div data-testid="malware-last-scan" className="space-y-0.5">
                        <p>
                            Last malware scan {ago(av.lastScan.at)} ({new Date(av.lastScan.at).toLocaleString()}):{" "}
                            {av.lastScan.state === "clean" ? <span>no malware found{av.lastScan.scannedFiles !== null ? ` in ${av.lastScan.scannedFiles} files` : ""}{av.lastScan.seconds !== null ? `, took ${av.lastScan.seconds} s` : ""}.</span>
                                : av.lastScan.state === "infected" ? <span className="text-destructive">{av.lastScan.infectedCount} infected {av.lastScan.infectedCount === 1 ? "file" : "files"} found.</span>
                                : <span className="text-destructive">did not finish{av.lastScan.message ? ` (${av.lastScan.message})` : ""}.</span>}
                        </p>
                        {av.lastScan.found.slice(0, 5).map((f, i) => <p key={i} className="break-all text-xs text-destructive">{f.signature} in {f.path}</p>)}
                        {av.lastScan.found.length > 5 || av.lastScan.infectedCount > 5 ? <p className="text-xs text-muted-foreground">and more. Nothing was deleted or moved; deal with them on the device.</p> : null}
                    </div>
                ) : av?.installed || h.antivirus.products.includes("ClamAV") ? <p className="text-xs text-muted-foreground">No malware scan has been run from here yet.</p> : null}
                {av?.signaturesAt ? <p className="text-xs text-muted-foreground">Signatures refreshed {ago(av.signaturesAt)}.</p> : null}
            </Card>
            <Card title="Accounts">
                {h.accounts ? (
                    <>
                        <p>{h.accounts.adminCount} {h.accounts.adminCount === 1 ? "account" : "accounts"} can use sudo{h.accounts.admins.length ? `: ${h.accounts.admins.slice(0, 5).join(", ")}${h.accounts.admins.length > 5 ? ", ..." : ""}` : ""}.</p>
                        {h.accounts.emptyPassword === null ? <p className="text-muted-foreground">Empty passwords: not read.</p> : h.accounts.emptyPassword.length ? <p className="text-destructive">No password: {h.accounts.emptyPassword.join(", ")}.</p> : <p>No account has an empty password.</p>}
                        {h.accounts.extraRoot.length ? <p className="text-destructive">Also user id 0: {h.accounts.extraRoot.join(", ")}.</p> : null}
                    </>
                ) : <p className="text-muted-foreground">Not read.</p>}
            </Card>
            <Card title="System">
                {h.os ? (
                    <>
                        <p>{h.os.name || h.os.id}{h.os.kernel ? `, kernel ${h.os.kernel}` : ""}.</p>
                        {sup ? <p>{sup.status === "unknown" ? "Support end date not known for this release." : sup.status === "ended" ? <span className="text-destructive">Support ended on {sup.endsOn}.</span> : `Supported until ${sup.endsOn}${sup.status === "ending" ? " (soon)" : ""}.`}</p> : null}
                    </>
                ) : <p className="text-muted-foreground">Not read.</p>}
                <p>{h.mac ? (h.mac.kind === "none" ? "No SELinux or AppArmor." : h.mac.kind === "selinux" ? `SELinux ${h.mac.mode.toLowerCase()}.` : "AppArmor loaded.") : ""} {h.secureBoot === null ? "" : h.secureBoot ? "Secure Boot on." : "Secure Boot off."}</p>
                <p>{h.restartPending ? "A restart is waiting." : h.restartPending === false ? "No restart waiting." : ""} {h.lastUpdate ? `Packages last updated ${AGO(h.lastUpdate.ageDays)}.` : ""} {h.autoUpdates ? (h.autoUpdates.enabled ? "Automatic updates on." : "Automatic updates off.") : ""}</p>
                {h.diskUsedPercent !== null ? <p>System disk {h.diskUsedPercent}% full.</p> : null}
            </Card>
        </div>
    );
}

export default function SecurityTab({ deviceId, os, deviceName }: { deviceId: string; os: string; deviceName: string }) {
    const { permissions } = useMe();
    const canAct = hasPerm(permissions, ["devices.read", "devices.actions"]);
    const [data, setData] = React.useState<DeviceSecurity | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [note, setNote] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [confirm, setConfirm] = React.useState<DefenderAction | null>(null);
    const [confirmError, setConfirmError] = React.useState<string | null>(null);
    const [lxConfirm, setLxConfirm] = React.useState<LinuxAction | null>(null);
    const [lxRunning, setLxRunning] = React.useState<LinuxAction | null>(null);
    const [filter, setFilter] = React.useState<Filter>("all");
    const [opened, setOpened] = React.useState<Set<string>>(new Set());
    const alive = React.useRef(true);
    const family = deviceFamily(os);

    const load = React.useCallback(async () => {
        try {
            const d = await security.device(deviceId);
            if (alive.current) { setData(d); setError(null); }
            return d;
        } catch (e) {
            if (alive.current) setError(errorText(e));
            return null;
        }
    }, [deviceId]);

    React.useEffect(() => {
        alive.current = true;
        if (family === "windows" || family === "linux") void load();
        return () => { alive.current = false; };
    }, [load, family]);

    // while a scan is waiting for the device, look again every few seconds
    const waiting = !!data?.pending;
    React.useEffect(() => {
        if (!waiting) return;
        let tries = 0;
        const t = setInterval(async () => {
            tries++;
            const d = await load();
            if (!d?.pending || tries >= POLL_TRIES) clearInterval(t);
        }, POLL_MS);
        return () => clearInterval(t);
    }, [waiting, load]);

    const scanNow = async () => {
        setBusy("scan");
        setNote(null);
        setError(null);
        try {
            const r = await security.scan(deviceId);
            setNote(r.alreadyWaiting ? "A scan is already waiting for this device." : "Scan started. The result appears here in a moment.");
            await load();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(null);
        }
    };

    const toggle = (id: string) => setOpened((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    if (family !== "windows" && family !== "linux") return <p className="text-sm text-muted-foreground" data-testid="security-state">Security scans are available for Windows and Linux devices.</p>;
    if (!hasPerm(permissions, "devices.read")) return <p className="text-sm text-muted-foreground">Viewing a device&apos;s security needs the right to view devices.</p>;
    if (!data && !error) return <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading the security scan…</div>;

    const scan = data?.scan ?? null;
    const canRun = canAct && !!data?.online && !!data?.hasAgent && (data?.windows === true || data?.linux === true);
    const why = !canAct ? "Running a scan needs the right to run device actions." : !data?.hasAgent ? "This device has no agent." : !data?.online ? "The device is offline." : "";

    const runDefender = async (action: DefenderAction) => {
        setConfirmError(null);
        setBusy(action);
        try {
            const r = await security.defender(deviceId, action);
            setNote(outcomeText(action, r, deviceName));
            setConfirm(null);
        } catch (e) {
            setConfirmError(errorText(e));
        } finally {
            setBusy(null);
        }
    };

    const runLinux = async (action: LinuxAction) => {
        setConfirmError(null);
        setBusy(action);
        try {
            const r = await security.linuxStart(deviceId, action);
            setLxConfirm(null);
            if (!r.pending) {
                setNote(linuxOutcomeText(r.result, deviceName));
                void load();
                return;
            }
            // still running on the device (a malware scan): say so, keep asking in the background
            setNote(`${deviceName}: the ${action === "malware-scan" ? "malware scan" : action === "antivirus-install" ? "ClamAV install" : action === "antivirus-update" ? "signature update" : "action"} is running on the device. The result appears here when it ends; you can leave this page.`);
            setLxRunning(action);
            setBusy(null);
            const out = await security.linuxWait(deviceId, r.jobId, () => !alive.current);
            if (alive.current) {
                setNote(out ? linuxOutcomeText(out, deviceName) : `${deviceName}: no answer yet. Run the action again later.`);
                setLxRunning(null);
                void load();
            }
        } catch (e) {
            if (alive.current) { setLxRunning(null); setConfirmError(errorText(e)); }
        } finally {
            if (alive.current) setBusy(null);
        }
    };

    const rules = scan?.rules ?? [];
    const shown = rules.filter((r) => filter === "all" || (filter === "fail" ? r.result === "fail" : filter === "unknown" ? r.result === "unknown" : r.result === "pass" || r.result === "not_applicable"));
    const h = scan?.highlights;
    const lx: LinuxHighlights | null = h && "platform" in h && h.platform === "linux" ? h : null;
    // ClamAV counts as installed when an action showed it, or the last security scan saw it running with current signatures
    const clamavInstalled = data?.clamav?.installed === true || (data?.clamav?.installed == null && !!lx?.antivirus.label.text.includes("ClamAV"));
    const wh: Highlights | null = h && !lx ? (h as Highlights) : null;
    const isWindows = data?.windows === true;

    return (
        <div className="space-y-5" data-testid="security-tab">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-4">
                    <ScoreRing score={scan?.score ?? null} grade={scan?.grade ?? null} />
                    <div className="min-w-0 space-y-1">
                        <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5" aria-hidden="true" />Security</h2>
                        {scan ? (
                            <p className="text-sm">
                                {scan.score === null ? "Nothing could be read, so there is no score." : <>Passes <strong>{scan.counts.pass}</strong> of {scan.counts.pass + scan.counts.fail} checks it could read.</>}
                                {scan.capped && scan.capReason ? <span className="block text-amber-700 dark:text-amber-400">{scan.capReason} Without that it would score {scan.uncappedScore}.</span> : null}
                            </p>
                        ) : (
                            <p className="text-sm text-muted-foreground" data-testid="security-state">{data?.reason ?? "Not scanned yet."}</p>
                        )}
                        {scan?.unreadableText ? <p className="text-xs text-muted-foreground">{scan.unreadableText}</p> : null}
                        <p className="text-xs text-muted-foreground" data-testid="last-scan">
                            {data?.scannedAt ? <>Last scanned {ago(data.scannedAt)} ({new Date(data.scannedAt).toLocaleString()}).</> : "Never scanned."}
                            {data?.stale ? <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">This result is out of date.</span> : null}
                            {data?.pending ? <span className="ml-1 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Waiting for the device to answer…</span> : null}
                        </p>
                        {data?.lastAttemptFailed && data.message ? <p role="alert" className="text-xs text-destructive">The last scan did not work{data.attemptedAt ? ` (${ago(data.attemptedAt)})` : ""}: {data.message}{scan ? " The result above is from the last scan that worked." : ""}</p> : null}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2" aria-label="Scan and Defender actions" role="group">
                    <Button onClick={() => void scanNow()} disabled={!canRun || busy !== null || !!data?.pending} className="gap-2" title={why || undefined}>
                        {busy === "scan" || data?.pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Scan now
                    </Button>
                    {isWindows ? (Object.keys(ACTIONS) as DefenderAction[]).map((a) => (
                        <Button key={a} variant="outline" size="sm" disabled={!canRun || busy !== null} onClick={() => { setConfirmError(null); setConfirm(a); }} title={why || undefined}>{ACTIONS[a].button}</Button>
                    )) : null}
                    {data?.linux === true ? (Object.keys(LINUX_ACTIONS) as LinuxAction[]).map((a) => {
                        const installed = clamavInstalled;
                        const already = a === "antivirus-install" && installed;
                        const needsAv = (a === "malware-scan" || a === "antivirus-update") && data?.clamav?.installed === false;
                        return (
                            <Button key={a} variant="outline" size="sm" disabled={!canRun || busy !== null || lxRunning !== null || already || needsAv} onClick={() => { setConfirmError(null); setLxConfirm(a); }} title={already ? "ClamAV is already installed on this device." : needsAv ? "Install ClamAV first." : why || undefined}>
                                {lxRunning === a ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" /> : null}{already ? "ClamAV installed" : LINUX_ACTIONS[a].button}
                            </Button>
                        );
                    }) : null}
                </div>
            </div>
            {why ? <p className="text-xs text-muted-foreground">{why}</p> : null}
            {note ? <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{note}</p> : null}
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

            {!scan ? (
                <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                    {data?.state === "no_agent" ? "This device has no agent, so it cannot be scanned." : data?.state === "offline" ? "This device is offline and has not been scanned yet. Scans are asked for when it is online; a policy can do it on a schedule." : data?.pending ? "A scan has been asked for. It usually takes under a minute." : (family === "linux" ? "Run a scan to see this device's score, its firewall, SSH, disk encryption and account settings and what to fix. A policy can scan it on a schedule (Policies > Security)." : "Run a scan to see this device's score, its Defender and BitLocker state and what to fix. A policy can scan it on a schedule (Policies > Security).")}
                </p>
            ) : (
                <>
                    {wh ? (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <Card title="Microsoft Defender">
                            <p><TonePill label={wh!.defender.label} /></p>
                            {wh!.defender.read ? (
                                <>
                                    <p>Real-time protection: {wh!.defender.realTimeProtection ? "on" : "off"}. Tamper protection: {wh!.defender.tamperProtected ? "on" : "off"}.</p>
                                    <p>Definitions {wh!.defender.signatureVersion || "unknown"}{wh!.defender.signatureAgeDays !== null ? `, ${wh!.defender.signatureAgeDays === 0 ? "updated today" : `${wh!.defender.signatureAgeDays} days old`}` : ""}.</p>
                                    <p>Last quick scan: {wh!.defender.lastQuickScanDays === null ? "never" : wh!.defender.lastQuickScanDays === 0 ? "today" : `${wh!.defender.lastQuickScanDays} days ago`}. Last full scan: {wh!.defender.lastFullScanDays === null ? "never" : wh!.defender.lastFullScanDays === 0 ? "today" : `${wh!.defender.lastFullScanDays} days ago`}.</p>
                                    {wh!.defender.exclusions ? (wh!.defender.exclusions.broad.length ? <p className="text-destructive">Exclusions: {wh!.defender.exclusions.total}, including broad ones: {wh!.defender.exclusions.broad.join(", ")}.</p> : <p>Exclusions: {wh!.defender.exclusions.total === 0 ? "none" : `${wh!.defender.exclusions.total}, none of them broad`}.</p>) : null}
                                    {wh!.defender.threatCount ? <p className="text-destructive">Active threats: {wh!.defender.threats.join(", ")}{(wh!.defender.threatCount ?? 0) > wh!.defender.threats.length ? ` and ${(wh!.defender.threatCount ?? 0) - wh!.defender.threats.length} more` : ""}.</p> : null}
                                </>
                            ) : <p className="text-muted-foreground">{wh!.defender.reason ?? "Not read."}</p>}
                            {wh!.defender.otherProducts.length ? <p>Also registered: {wh!.defender.otherProducts.map((o) => `${o.name} (${o.state})`).join(", ")}.</p> : null}
                        </Card>
                        <Card title="BitLocker">
                            <p><TonePill label={wh!.bitlocker.label} /></p>
                            {wh!.bitlocker.volumes.map((v) => (
                                <p key={v.drive}>{v.drive} {v.protection === "on" ? "protected" : v.protection === "off" ? "not protected" : "state not known"}{v.method && v.method !== "None" ? `, ${v.method}` : ""}{v.state === "Encrypting" && v.percent !== null ? `, encrypting ${v.percent}%` : ""}{v.protectors.length ? `. Key protectors: ${v.protectors.join(", ")}` : ""}.</p>
                            ))}
                            {wh!.bitlocker.note ? <p className="text-xs text-muted-foreground">{wh!.bitlocker.note}</p> : null}
                            <p className="text-xs text-muted-foreground">The scan only reads the status. Recovery keys are collected only when a policy turns on key escrow (see Device secrets below).</p>
                        </Card>
                        <Card title="Firewall and accounts">
                            <p><TonePill label={wh!.firewall.label} /></p>
                            {wh!.firewall.profiles ? <p>Domain {wh!.firewall.profiles.domain === null ? "?" : wh!.firewall.profiles.domain ? "on" : "off"}, private {wh!.firewall.profiles.private === null ? "?" : wh!.firewall.profiles.private ? "on" : "off"}, public {wh!.firewall.profiles.public === null ? "?" : wh!.firewall.profiles.public ? "on" : "off"}.</p> : null}
                            {wh!.accounts ? <p>{wh!.accounts.adminCount} local {wh!.accounts.adminCount === 1 ? "administrator" : "administrators"}{wh!.accounts.adminNames.length ? `: ${wh!.accounts.adminNames.slice(0, 5).join(", ")}${wh!.accounts.adminNames.length > 5 ? ", ..." : ""}` : ""}.</p> : null}
                        </Card>
                        <Card title="Windows">
                            {wh!.os ? (
                                <>
                                    <p>{wh!.os.name} {wh!.os.displayVersion}, build {wh!.os.build}.{wh!.os.ubr}</p>
                                    <p>{wh!.os.support.status === "unknown" ? "Support end date not known for this build." : wh!.os.support.status === "ended" ? <span className="text-destructive">Support ended on {wh!.os.support.endsOn}.</span> : `Supported until ${wh!.os.support.endsOn}${wh!.os.support.status === "ending" ? " (soon)" : ""}.`}</p>
                                </>
                            ) : <p className="text-muted-foreground">Not read.</p>}
                            <p>{wh!.secureBoot ? (wh!.secureBoot.supported ? `Secure Boot ${wh!.secureBoot.enabled ? "on" : "off"}.` : "Not in UEFI mode.") : "Secure Boot: not read."} {wh!.tpm ? (wh!.tpm.present ? `TPM ${wh!.tpm.ready ? "ready" : "not ready"}.` : "No TPM.") : "TPM: not read."}</p>
                            <p>{wh!.restartPending ? "A restart is waiting." : wh!.restartPending === false ? "No restart waiting." : ""} {wh!.lastUpdate?.ageDays != null ? `Last update installed ${wh!.lastUpdate.ageDays === 0 ? "today" : `${wh!.lastUpdate.ageDays} days ago`}.` : ""}</p>
                        </Card>
                    </div>
                    ) : null}
                    {lx ? <LinuxCards h={lx} av={data?.clamav} /> : null}

                    <section aria-label="Checks">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold">Checks against the baseline</h3>
                            <div role="group" aria-label="Show checks" className="flex flex-wrap gap-1">
                                {([["all", `All ${rules.length}`], ["fail", `Failed ${scan.counts.fail}`], ["unknown", `Could not read ${scan.counts.unknown}`], ["pass", `Passed or not applicable ${scan.counts.pass + scan.counts.notApplicable}`]] as Array<[Filter, string]>).map(([k, label]) => (
                                    <Button key={k} size="sm" variant={filter === k ? "default" : "outline"} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</Button>
                                ))}
                            </div>
                        </div>
                        {shown.length === 0 ? <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No checks in this view.</p> : null}
                        {SEVERITY_ORDER.map((sev: Severity) => {
                            const list = shown.filter((r) => r.severity === sev);
                            if (!list.length) return null;
                            return (
                                <div key={sev} className="mb-3 rounded-lg border" data-testid={`group-${sev}`}>
                                    <h4 className="border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">{SEVERITY_TEXT[sev]} <span className="font-normal normal-case text-muted-foreground">({list.length})</span></h4>
                                    <ul className="m-0 list-none p-0">
                                        {list.map((r) => <RuleRow key={r.id} rule={r} open={opened.has(r.id)} onToggle={() => toggle(r.id)} />)}
                                    </ul>
                                </div>
                            );
                        })}
                        {h && h.unreadable.length ? (
                            <details className="text-xs text-muted-foreground">
                                <summary className="cursor-pointer">Why some checks could not be read</summary>
                                <ul className="mt-1 list-disc pl-5">{h.unreadable.map((u) => <li key={u.probe}>{u.probe}: {u.reason}</li>)}</ul>
                            </details>
                        ) : null}
                    </section>
                </>
            )}

            {/* Recovery keys and the local admin password: draws nothing unless the person may view or manage device secrets */}
            {family === "windows" || family === "linux" ? <SecretsCard deviceId={deviceId} deviceName={deviceName} /> : null}

            <Dialog open={!!lxConfirm} onOpenChange={(o) => !o && busy === null && setLxConfirm(null)}>
                <DialogContent>
                    {lxConfirm ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{LINUX_ACTIONS[lxConfirm].title}</DialogTitle>
                                <DialogDescription>{LINUX_ACTIONS[lxConfirm].body} On {deviceName}. This is recorded in the audit log.</DialogDescription>
                            </DialogHeader>
                            {confirmError ? <p role="alert" className="text-sm text-destructive">{confirmError}</p> : null}
                            <DialogFooter>
                                <Button variant="outline" onClick={() => setLxConfirm(null)} disabled={busy !== null}>Cancel</Button>
                                <Button onClick={() => void runLinux(lxConfirm)} disabled={busy !== null} className="gap-2">
                                    {busy === lxConfirm ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy === lxConfirm ? "Working…" : LINUX_ACTIONS[lxConfirm].confirm}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>

            <Dialog open={!!confirm} onOpenChange={(o) => !o && busy === null && setConfirm(null)}>
                <DialogContent>
                    {confirm ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{ACTIONS[confirm].title}</DialogTitle>
                                <DialogDescription>{ACTIONS[confirm].body} On {deviceName}. This is recorded in the audit log.</DialogDescription>
                            </DialogHeader>
                            {confirmError ? <p role="alert" className="text-sm text-destructive">{confirmError}</p> : null}
                            <DialogFooter>
                                <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy !== null}>Cancel</Button>
                                <Button onClick={() => void runDefender(confirm)} disabled={busy !== null} className="gap-2">
                                    {busy === confirm ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy === confirm ? "Working…" : ACTIONS[confirm].confirm}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </div>
    );
}
