"use client";

// What a script can ask for about the device it runs on. Click a name to copy it.
import * as React from "react";
import { toast } from "@/components/ui/use-toast";
import { jfetch } from "@/lib/api";

const PROPERTIES: Array<[string, string]> = [
    ["hostname", "The device's host name"],
    ["name", "Its display name (alias, or host name)"],
    ["customer", "The customer's name"],
    ["site", "The site's name"],
    ["os", "windows or linux"],
    ["osname", "The operating system as reported"],
    ["user", "The user last seen signed in"],
    ["tags", "Its tags, separated by commas"],
    ["version", "The agent's version"],
    ["status", "online or offline, as last known"],
    ["id", "The device's id"],
    ["uuid", "The agent's id"],
    ["customer_id", "The customer's id"],
    ["site_id", "The site's id"],
];

type CustomField = { key: string; label: string };

export function ScriptPropertiesHint() {
    // The customer's custom fields, when the person may read customers. Without that right the list is simply not shown.
    const [fields, setFields] = React.useState<CustomField[]>([]);
    React.useEffect(() => {
        let stale = false;
        jfetch<{ items: CustomField[] }>("/api/custom-fields")
            .then((r) => !stale && setFields(r.items))
            .catch(() => undefined);
        return () => { stale = true; };
    }, []);

    const copy = async (name: string, space: "agent" | "customer" = "agent") => {
        const text = `{{${space}.${name}}}`;
        try {
            await navigator.clipboard.writeText(text);
            toast({ title: "Copied", description: `${text} is on your clipboard. Paste it into the script.` });
        } catch {
            toast({ title: "Could not copy", description: `Type ${text} into the script.`, variant: "destructive" });
        }
    };
    return (
        <details className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs">
            <summary className="cursor-pointer select-none text-muted-foreground">Use the device&apos;s details in the script: <span className="font-mono">{"{{agent.hostname}}"}</span></summary>
            <div className="mt-2 grid gap-2 text-muted-foreground">
                <p>
                    Each <span className="font-mono">{"{{agent.name}}"}</span> is replaced with that device&apos;s value just before the script is sent. If a name is not known, or the device has no value for it, the script is <strong>not run</strong> and its output says which property was the problem.
                    Values holding quotes, <span className="font-mono">$</span>, brackets or similar are never pasted into script text; read those from the environment variable instead, such as <span className="font-mono">$env:RIQ_AGENT_CUSTOMER</span> or <span className="font-mono">$RIQ_AGENT_CUSTOMER</span>.
                </p>
                <ul className="flex flex-wrap gap-1.5">
                    {PROPERTIES.map(([name, what]) => (
                        <li key={name}>
                            <button type="button" title={what} onClick={() => void copy(name)} className="rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-foreground hover:bg-accent">
                                {`agent.${name}`}
                            </button>
                        </li>
                    ))}
                </ul>
                {fields.length > 0 ? (
                    <>
                        <p>
                            The device&apos;s customer&apos;s own fields work the same way, as <span className="font-mono">{"{{customer.<field>}}"}</span>. Read a value with characters a shell could act on from <span className="font-mono">$env:RIQ_CUSTOMER_&lt;FIELD&gt;</span> or <span className="font-mono">$RIQ_CUSTOMER_&lt;FIELD&gt;</span>.
                        </p>
                        <ul className="flex flex-wrap gap-1.5">
                            {fields.map((f) => (
                                <li key={f.key}>
                                    <button type="button" title={f.label} onClick={() => void copy(f.key, "customer")} className="rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-foreground hover:bg-accent">
                                        {`customer.${f.key}`}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </>
                ) : null}
            </div>
        </details>
    );
}
