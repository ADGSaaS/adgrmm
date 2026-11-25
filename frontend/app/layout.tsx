// app/layout.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Inter } from "next/font/google";
import "@/styles/globals.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";
import Providers from "@/app/providers";
import { BrandingProvider } from "./providers/BrandingProvider";
import { ToastProvider } from "@/lib/toast";
import Toaster from "@/components/ui/toaster";
import { BRANDING_BOOT_SCRIPT } from "@/lib/branding-boot";

export const runtime = "nodejs";
const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "RemoteIQ",
  description: "Next-generation Remote Monitoring & Management",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The customer portal does not use the staff app's data providers.
  const portal = (await headers()).get("x-riq-portal") === "1";
  return (
    // important: keep suppressHydrationWarning on <html> for next-themes
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Puts the saved brand colours and custom CSS on the page before it is first drawn, so there is no flash of the default colour. */}
        <script dangerouslySetInnerHTML={{ __html: BRANDING_BOOT_SCRIPT }} />
      </head>
      {/* DO NOT put a fixed bg here; use semantic tokens so light/dark both work */}
      <body className={cn("min-h-screen bg-background text-foreground font-sans antialiased", inter.className)}>
        <ToastProvider>
          {/* ThemeProvider is what reads/writes the riq-theme key and toggles the `dark` class on <html> */}
          <ThemeProvider>
            <BrandingProvider>
              <Providers portal={portal}>{children}</Providers>
            </BrandingProvider>
          </ThemeProvider>
          <Toaster />
        </ToastProvider>
      </body>
    </html>
  );
}
