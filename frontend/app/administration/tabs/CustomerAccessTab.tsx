"use client";

import * as React from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TabsContent } from "@/components/ui/tabs";
import { jfetch } from "@/lib/api";

export type CustomerAccessTabProps = {
    push: (t: any) => void;
};

type Customer = { id: string; name: string };
type Person = { id: string; email: string; name: string; clientIds: string[] };
type Data = { customers: Customer[]; users: Person[] };

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

export default function CustomerAccessTab({ push }: CustomerAccessTabProps) {
    const [data, setData] = React.useState<Data | null>(null);
    const [draft, setDraft] = React.useState<Record<string, string[]>>({});
    const [busy, setBusy] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState<string | null>(null);

    const load = React.useCallback(() => {
        jfetch<Data>("/api/admin/client-access")
            .then((d) => {
                setData(d);
                setDraft(Object.fromEntries(d.users.map((u) => [u.id, u.clientIds])));
                setError(null);
            })
            .catch((e) => setError(message(e)));
    }, []);
    React.useEffect(load, [load]);

    const save = async (person: Person) => {
        setBusy(person.id);
        try {
            await jfetch(`/api/admin/client-access/${person.id}`, { method: "PUT", body: { clientIds: draft[person.id] ?? [] } });
            push?.({ title: "Saved", description: (draft[person.id] ?? []).length ? `${person.email} can now see only the customers chosen.` : `${person.email} can see every customer in reports.` });
            load();
        } catch (e) {
            push?.({ title: "Could not save that", description: message(e), variant: "destructive" });
        } finally {
            setBusy(null);
        }
    };

    const toggle = (personId: string, clientId: string) =>
        setDraft((d) => {
            const list = d[personId] ?? [];
            return { ...d, [personId]: list.includes(clientId) ? list.filter((x) => x !== clientId) : [...list, clientId] };
        });

    return (
        <TabsContent value="client_access">
            <Card className="border-0 bg-transparent shadow-none">
                <CardHeader className="p-0 pb-5">
                    <CardTitle className="text-xl tracking-tight">Customer access</CardTitle>
                    <CardDescription>
                        Limit what one person can see to some customers. Groups can limit it too, down to single sites and tags: a person sees what is chosen here plus what their groups allow. Someone with nothing chosen anywhere sees every customer. A limited person sees only their customers in the customer list, devices, alerts, the failures list, the policies a device gets, and every report, download, schedule and delivery log. They cannot create customers. Still not limited: tickets, documents, assets, billing and remote sessions started by a device id.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    {data?.users.length === 0 && <p className="text-sm text-muted-foreground">There are no people yet.</p>}
                    {data?.users.map((u) => {
                        const chosen = draft[u.id] ?? [];
                        const changed = chosen.slice().sort().join() !== u.clientIds.slice().sort().join();
                        return (
                            <div key={u.id} className="rounded-md border">
                                <button type="button" aria-expanded={open === u.id} onClick={() => setOpen(open === u.id ? null : u.id)} className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left">
                                    <span>
                                        <span className="font-medium">{u.name || u.email}</span>
                                        {u.name && <span className="ml-2 text-sm text-muted-foreground">{u.email}</span>}
                                    </span>
                                    <span className="text-sm text-muted-foreground">{u.clientIds.length ? `Limited to ${u.clientIds.length} customer${u.clientIds.length === 1 ? "" : "s"}` : "Every customer"}</span>
                                </button>
                                {open === u.id && (
                                    <div className="grid gap-3 border-t p-3">
                                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                            {data.customers.map((c) => (
                                                <label key={c.id} className="flex items-center gap-2 text-sm">
                                                    <Checkbox checked={chosen.includes(c.id)} onCheckedChange={() => toggle(u.id, c.id)} aria-label={`${u.email} may see ${c.name}`} />
                                                    {c.name}
                                                </label>
                                            ))}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Button size="sm" disabled={!changed || busy === u.id} onClick={() => void save(u)}>{busy === u.id ? "Saving..." : "Save"}</Button>
                                            <Button size="sm" variant="ghost" disabled={!chosen.length} onClick={() => setDraft((d) => ({ ...d, [u.id]: [] }))}>Allow every customer</Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </CardContent>
            </Card>
        </TabsContent>
    );
}
