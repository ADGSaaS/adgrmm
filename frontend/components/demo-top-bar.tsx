"use client";
// In the public demo only: a slim bar across the very top with a way back to the demos page on the website.
import * as React from "react";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useDemoInfo } from "@/lib/demo";

export default function DemoTopBar() {
    const info = useDemoInfo();
    const pathname = usePathname();
    const isDemo = !!info?.demo;

    // After a page change the browser scrolls the new page into view from just below this bar, which hides the bar. Put it back.
    // (Only when the page is within the bar's own height of the top, so a person who has scrolled further is left alone.)
    React.useEffect(() => {
        if (!isDemo) return;
        const t = window.setTimeout(() => { if (window.scrollY > 0 && window.scrollY <= 40) window.scrollTo(0, 0); }, 60);
        return () => window.clearTimeout(t);
    }, [pathname, isDemo]);

    if (!isDemo) return null;
    return (
        <div role="navigation" aria-label="Demo" className="flex h-9 items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 text-xs">
            {info.backUrl ? (
                <a href={info.backUrl} className="inline-flex items-center gap-1.5 font-semibold transition-opacity hover:opacity-70">
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">Back to all ADG SaaS demos</span>
                    <span className="sm:hidden">All demos</span>
                </a>
            ) : <span className="font-semibold">ADG RMM demo</span>}
            <span className="hidden text-muted-foreground md:inline">ADG RMM demo &middot; sample data &middot; your changes are discarded when you leave</span>
        </div>
    );
}
