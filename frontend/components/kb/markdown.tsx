"use client";

// A small Markdown renderer that builds React elements itself, so nothing is ever put into the page as HTML: text is
// always text, and links are only made for http, https and mailto addresses. Covers what knowledge base articles need:
// headings, paragraphs, bullet and numbered lists, quotes, code blocks, inline code, bold, italic and links.
import * as React from "react";
import { cn } from "@/lib/utils";

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

function inline(text: string, keyBase: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const tok = m[0];
        const key = `${keyBase}-${i++}`;
        if (m[1]) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{tok.slice(1, -1)}</code>);
        else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
        else if (m[3]) out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
        else if (m[4]) {
            const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
            if (SAFE_LINK.test(mm[2])) out.push(<a key={key} href={mm[2]} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{mm[1]}</a>);
            else out.push(tok);
        } else out.push(<a key={key} href={tok} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{tok}</a>);
        last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const blocks: React.ReactNode[] = [];
    let i = 0;
    let k = 0;
    const key = () => `b${k++}`;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        if (/^```/.test(line)) {
            const code: string[] = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
            i++;
            blocks.push(<pre key={key()} className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-sm"><code className="font-mono">{code.join("\n")}</code></pre>);
            continue;
        }
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        if (h) {
            const level = h[1].length;
            const cls = level === 1 ? "text-xl font-semibold" : level === 2 ? "text-lg font-semibold" : "text-base font-semibold";
            const kk = key();
            blocks.push(React.createElement(`h${Math.min(level + 1, 6)}`, { key: kk, className: cn(cls, "mt-4") }, inline(h[2], kk)));
            i++;
            continue;
        }
        if (/^(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(<hr key={key()} className="my-4" />); i++; continue; }
        if (/^>\s?/.test(line)) {
            const q: string[] = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
            const kk = key();
            blocks.push(<blockquote key={kk} className="border-l-4 pl-3 text-muted-foreground">{inline(q.join(" "), kk)}</blockquote>);
            continue;
        }
        const ul = /^\s*[-*+]\s+/.test(line);
        const ol = /^\s*\d+[.)]\s+/.test(line);
        if (ul || ol) {
            const items: string[] = [];
            const re = ul ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
            while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
            const kk = key();
            const children = items.map((t, n) => <li key={n}>{inline(t, `${kk}-${n}`)}</li>);
            blocks.push(ul ? <ul key={kk} className="list-disc space-y-1 pl-6">{children}</ul> : <ol key={kk} className="list-decimal space-y-1 pl-6">{children}</ol>);
            continue;
        }
        const para: string[] = [];
        while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i])) para.push(lines[i++]);
        if (!para.length) { para.push(lines[i++]); }
        const kk = key();
        blocks.push(<p key={kk} className="leading-relaxed">{inline(para.join("\n"), kk)}</p>);
    }
    return <div className={cn("space-y-3 text-sm [overflow-wrap:anywhere]", className)}>{blocks}</div>;
}

/** Shows a search snippet where the server marked matches with << and >>. */
export function Snippet({ text }: { text: string }) {
    const parts = text.split(/(<<|>>)/);
    let on = false;
    return (
        <>
            {parts.map((p, n) => {
                if (p === "<<") { on = true; return null; }
                if (p === ">>") { on = false; return null; }
                return on ? <mark key={n} className="rounded bg-yellow-200/70 px-0.5 dark:bg-yellow-500/30">{p}</mark> : <React.Fragment key={n}>{p}</React.Fragment>;
            })}
        </>
    );
}
