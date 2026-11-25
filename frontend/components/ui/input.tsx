"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
    extends React.InputHTMLAttributes<HTMLInputElement> { }

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    ({ className, type = "text", ...props }, ref) => {
        // A password box that says nothing about what it is for is not offered saved passwords (a browser would
        // fill them, and put the saved user name into the box before it). The sign-in page says "current-password"
        // itself, so it keeps normal autofill.
        const noFill = type === "password" && props.autoComplete === undefined ? ({ autoComplete: "new-password", "data-lpignore": "true", "data-1p-ignore": "true" } as const) : null;
        return (
            <input
                ref={ref}
                type={type}
                {...noFill}
                className={cn(
                    // Base
                    "flex h-10 w-full rounded-lg border border-input bg-card/40 px-3 py-2 text-sm shadow-sm",
                    "placeholder:text-muted-foreground shadow-sm transition-colors",
                    // Remove thick ring; keep subtle 1px border color change on focus
                    "focus:outline-none focus-visible:outline-none",
                    "focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0",
                    "focus:border-primary",
                    // Disabled
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    className
                )}
                {...props}
            />
        );
    }
);
Input.displayName = "Input";

export { Input };
