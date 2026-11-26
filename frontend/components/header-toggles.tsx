"use client";

// Two small buttons beside the notification bell:
//  - LayoutToggle: pages use the whole window (full width) or sit in a centered column.
//  - ThemeToggle: one button that flips light and dark.
// Both remember the choice in this browser.
import * as React from "react";
import { Maximize2, Minimize2, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

type Layout = "full" | "centered";
const KEY = "adg-layout";

function applyLayout(layout: Layout) {
    document.documentElement.dataset.layout = layout;
}

export function LayoutToggle() {
    const [layout, setLayout] = React.useState<Layout>("full");
    const [ready, setReady] = React.useState(false);

    // Read the saved choice after the first render so the server and the browser draw the same thing first.
    React.useEffect(() => {
        let saved: Layout = "full";
        try {
            saved = window.localStorage.getItem(KEY) === "centered" ? "centered" : "full";
        } catch { /* ignore */ }
        setLayout(saved);
        applyLayout(saved);
        setReady(true);
    }, []);

    const flip = () => {
        const next: Layout = layout === "full" ? "centered" : "full";
        setLayout(next);
        applyLayout(next);
        try { window.localStorage.setItem(KEY, next); } catch { /* ignore */ }
    };

    const label = layout === "full" ? "Switch to a centered layout" : "Switch to full width";
    return (
        <Button
            variant="ghost"
            size="icon"
            className="hidden shrink-0 lg:inline-flex"
            onClick={flip}
            aria-label={label}
            aria-pressed={layout === "centered"}
            title={label}
            disabled={!ready}
        >
            {layout === "full" ? <Minimize2 className="h-5 w-5" aria-hidden="true" /> : <Maximize2 className="h-5 w-5" aria-hidden="true" />}
        </Button>
    );
}

export function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme();
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => setMounted(true), []);

    const dark = mounted && resolvedTheme === "dark";
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    return (
        <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => setTheme(dark ? "light" : "dark")}
            aria-label={label}
            title={label}
            disabled={!mounted}
        >
            {dark ? <Sun className="h-5 w-5" aria-hidden="true" /> : <Moon className="h-5 w-5" aria-hidden="true" />}
        </Button>
    );
}
