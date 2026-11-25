"use client";

import * as React from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TabsContent } from "@/components/ui/tabs";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";
import { jfetch } from "@/lib/api";

export type DemoDataTabProps = {
    push: (t: any) => void;
};

type Status = {
    enabled: boolean;
    since: string | null;
    counts: { customers: number; sites: number; devices: number; tickets: number; sessions: number; assets: number };
};

const message = (e: unknown) => {
    if (!(e instanceof Error)) return "Something went wrong.";
    try {
        const body = JSON.parse(e.message) as { message?: string | string[] };
        const m = Array.isArray(body.message) ? body.message.join(" ") : body.message;
        if (m) return m;
    } catch {
        /* already words */
    }
    return e.message;
};

export default function DemoDataTab({ push }: DemoDataTabProps) {
    const [status, setStatus] = React.useState<Status | null>(null);
    const [busy, setBusy] = React.useState<"on" | "off" | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [confirmOff, setConfirmOff] = React.useState(false);

    const load = React.useCallback(() => {
        jfetch<Status>("/api/admin/demo").then((s) => { setStatus(s); setError(null); }).catch((e) => setError(message(e)));
    }, []);
    React.useEffect(load, [load]);

    const turnOn = async () => {
        setBusy("on");
        try {
            const s = await jfetch<Status>("/api/admin/demo/enable", { method: "POST" });
            setStatus(s);
            push?.({ title: "Demo data is on", description: `${s.counts.devices} sample endpoints were added.` });
        } catch (e) {
            push?.({ title: "Could not turn demo data on", description: message(e), variant: "destructive" });
            load();
        } finally {
            setBusy(null);
        }
    };

    const turnOff = async () => {
        setBusy("off");
        try {
            const s = await jfetch<Status>("/api/admin/demo/disable", { method: "POST" });
            setStatus(s);
            push?.({ title: "Demo data deleted", description: "Everything that was added as demo data has been removed." });
        } catch (e) {
            push?.({ title: "Could not delete demo data", description: message(e), variant: "destructive" });
            load();
        } finally {
            setBusy(null);
        }
    };

    const enabled = !!status?.enabled;
    return (
        <TabsContent value="demo">
            <Card className="border-0 bg-transparent shadow-none">
                <CardHeader className="p-0 pb-5">
                    <CardTitle className="text-xl tracking-tight">Demo data</CardTitle>
                    <CardDescription>
                        Adds two sample customers with ten endpoints, each with hardware, security, network and software details, patch scans, alerts, remote sessions, tickets and warranty records, so you can see how the reports and the rest of the system look with real-looking data. Turning it off deletes all of it. Your own customers and devices are never touched.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    <div className="flex items-center justify-between rounded-md border p-4">
                        <div>
                            <p className="font-medium">Demo data is {status ? (enabled ? "on" : "off") : "loading"}</p>
                            {enabled && status && (
                                <p className="text-sm text-muted-foreground">
                                    {status.counts.customers} customers, {status.counts.sites} sites, {status.counts.devices} endpoints, {status.counts.tickets} tickets, {status.counts.sessions} remote sessions, {status.counts.assets} asset records.
                                    {status.since ? ` Added ${new Date(status.since).toLocaleString()}.` : ""}
                                </p>
                            )}
                            {!enabled && status && <p className="text-sm text-muted-foreground">Switch it on to add the sample customers and endpoints.</p>}
                            {busy === "on" && <p className="text-sm text-muted-foreground">Adding the sample data...</p>}
                            {busy === "off" && <p className="text-sm text-muted-foreground">Deleting the sample data...</p>}
                        </div>
                        <Switch
                            aria-label="Demo data"
                            checked={enabled}
                            disabled={!status || busy !== null}
                            onCheckedChange={(on) => {
                                if (on) void turnOn();
                                else setConfirmOff(true);
                            }}
                        />
                        <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Delete all demo data?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                        This removes the demo customers, endpoints, tickets, alerts, sessions and records. It cannot be undone, but you can switch demo data on again to get a fresh set.
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => void turnOff()}>Delete</AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    </div>
                    <div className="flex justify-end">
                        <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button variant="destructive" disabled={!enabled || busy !== null}>
                                    <Trash2 className="mr-2 h-4 w-4" /> Delete all demo data
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Delete all demo data?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                        This removes the demo customers, endpoints, tickets, alerts, sessions and records. Your own data is not touched.
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={() => void turnOff()}>Delete</AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    </div>
                </CardContent>
            </Card>
        </TabsContent>
    );
}
