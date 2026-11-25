"use client";

// components/automation/code-editor.tsx
//
// A real code editor (CodeMirror 6, bundled with the app, nothing loaded from outside) for scripts: highlighting for PowerShell and bash, line
// numbers, the current line marked, bracket matching and closing, indent on typing, undo and redo, search (Ctrl+F), Tab to indent and
// Ctrl+S to save. It is loaded on demand (see script-editor-dialog.tsx) so the page itself stays light.
import * as React from "react";
import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { oneDark } from "@codemirror/theme-one-dark";
import { githubLight } from "@uiw/codemirror-theme-github";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { useTheme } from "next-themes";

export type EditorStatus = { line: number; col: number; lines: number; chars: number };

/** What the window around the editor can ask of it. */
export type EditorHandle = { insert: (text: string) => void; focus: () => void };

type Props = {
    value: string;
    onChange: (value: string) => void;
    language: "powershell" | "bash";
    onSave: () => void;
    onStatus?: (s: EditorStatus) => void;
    handleRef?: React.MutableRefObject<EditorHandle | null>;
    readOnly?: boolean;
    ariaLabel?: string;
};

const statusOf = (u: { state: ViewUpdate["state"] }): EditorStatus => {
    const head = u.state.selection.main.head;
    const line = u.state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1, lines: u.state.doc.lines, chars: u.state.doc.length };
};

export default function CodeEditor({ value, onChange, language, onSave, onStatus, handleRef, readOnly, ariaLabel }: Props) {
    const { resolvedTheme } = useTheme();
    const saveRef = React.useRef(onSave);
    saveRef.current = onSave;
    const statusCb = React.useRef(onStatus);
    statusCb.current = onStatus;

    const extensions = React.useMemo(
        () => [
            StreamLanguage.define(language === "powershell" ? powerShell : shell),
            keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => { saveRef.current(); return true; } }]),
            EditorView.contentAttributes.of({ "aria-label": ariaLabel ?? "Script", spellcheck: "false" }),
            EditorView.theme({
                "&": { height: "100%" },
                ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "13px", lineHeight: "1.55" },
            }),
        ],
        [language, ariaLabel],
    );

    return (
        <CodeMirror
            value={value}
            height="100%"
            className="h-full"
            theme={resolvedTheme === "dark" ? oneDark : githubLight}
            extensions={extensions}
            readOnly={readOnly}
            basicSetup={{
                lineNumbers: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                indentOnInput: true,
                history: true,
                searchKeymap: true,
                autocompletion: false,
                tabSize: 4,
            }}
            onChange={(v) => onChange(v)}
            onCreateEditor={(view) => {
                if (handleRef) {
                    handleRef.current = {
                        focus: () => view.focus(),
                        insert: (text) => {
                            const sel = view.state.selection.main;
                            view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, scrollIntoView: true });
                            view.focus();
                        },
                    };
                }
                statusCb.current?.(statusOf(view));
            }}
            onUpdate={(u) => {
                if (u.selectionSet || u.docChanged) statusCb.current?.(statusOf(u));
            }}
        />
    );
}
