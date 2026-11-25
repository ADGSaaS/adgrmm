// components/itdocs/markdown.tsx
"use client";

import * as React from "react";

/**
 * Renders the Markdown subset technicians use, as React elements. It never builds raw HTML, so
 * nothing typed into a document can run in someone else's browser.
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function inline(text: string, keyBase: string): React.ReactNode[] {
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
    const out: React.ReactNode[] = [];
    let last = 0;
    let index = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (match.index > last) out.push(text.slice(last, match.index));
        const token = match[0];
        const key = `${keyBase}-${index++}`;
        if (token.startsWith("`")) {
            out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{token.slice(1, -1)}</code>);
        } else if (token.startsWith("**")) {
            out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
        } else if (token.startsWith("*")) {
            out.push(<em key={key}>{token.slice(1, -1)}</em>);
        } else {
            const close = token.indexOf("](");
            const label = token.slice(1, close);
            const href = token.slice(close + 2, -1);
            out.push(
                SAFE_URL.test(href) ? (
                    <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline">{label}</a>
                ) : (
                    label
                )
            );
        }
        last = match.index + token.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

const splitRow = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export default function Markdown({ text }: { text: string }) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const blocks: React.ReactNode[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const key = `b${i}`;

        if (!line.trim()) {
            i++;
            continue;
        }

        if (line.startsWith("```")) {
            const code: string[] = [];
            i++;
            while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
            i++;
            blocks.push(<pre key={key} className="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{code.join("\n")}</code></pre>);
            continue;
        }

        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
            const sizes = ["text-xl font-semibold", "text-lg font-semibold", "text-base font-semibold", "text-sm font-semibold"];
            const Tag = `h${Math.min(heading[1].length + 1, 5)}` as "h2";
            blocks.push(<Tag key={key} className={`${sizes[heading[1].length - 1]} mt-2`}>{inline(heading[2], key)}</Tag>);
            i++;
            continue;
        }

        if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
            const header = splitRow(line);
            i += 2;
            const rows: string[][] = [];
            while (i < lines.length && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
            blocks.push(
                <div key={key} className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr>{header.map((h, c) => <th key={c} className="border border-border bg-muted/50 px-2 py-1 text-left font-medium">{inline(h, `${key}h${c}`)}</th>)}</tr>
                        </thead>
                        <tbody>
                            {rows.map((row, r) => (
                                <tr key={r}>{header.map((_, c) => <td key={c} className="border border-border px-2 py-1">{inline(row[c] ?? "", `${key}r${r}c${c}`)}</td>)}</tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
            continue;
        }

        if (/^\s*[-*]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
            blocks.push(
                <ul key={key} className="grid gap-1 pl-5 text-sm [&>li]:list-disc">
                    {items.map((item, n) => {
                        const task = /^\[( |x)\]\s*(.*)$/i.exec(item);
                        return task ? (
                            <li key={n} className="!list-none -ml-5 flex items-start gap-2">
                                <input type="checkbox" disabled checked={task[1].toLowerCase() === "x"} aria-label={task[2]} className="mt-1" />
                                <span>{inline(task[2], `${key}-${n}`)}</span>
                            </li>
                        ) : (
                            <li key={n}>{inline(item, `${key}-${n}`)}</li>
                        );
                    })}
                </ul>
            );
            continue;
        }

        if (/^\s*\d+\.\s*/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+\.\s*/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s*/, ""));
            blocks.push(<ol key={key} className="grid list-decimal gap-1 pl-5 text-sm">{items.map((item, n) => <li key={n}>{inline(item, `${key}-${n}`)}</li>)}</ol>);
            continue;
        }

        const paragraph: string[] = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*]\s+|\s*\d+\.\s)/.test(lines[i])) paragraph.push(lines[i++]);
        if (paragraph.length === 0) paragraph.push(lines[i++]);
        blocks.push(<p key={key} className="whitespace-pre-wrap text-sm">{inline(paragraph.join("\n"), key)}</p>);
    }

    return <div className="grid gap-2">{blocks}</div>;
}
