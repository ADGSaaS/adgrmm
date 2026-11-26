// app/(auth)/login/page.tsx
"use client";

import * as React from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Shield, Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useBranding } from "@/app/providers/BrandingProvider";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { useDemoMode } from "@/lib/demo";

/** Only allow same-origin paths; never /login or legacy /auth/login */
function safeNext(raw: string | null): string {
    const path = safeRedirectPath(raw, "/");
    if (path === "/login" || path.startsWith("/login?") || path.startsWith("/login#") || path.startsWith("/auth/login")) return "/";
    return path;
}

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001").replace(/\/+$/, "");

// Cloudflare Turnstile, loaded only when an administrator has turned the CAPTCHA on.
type TurnstileApi = {
    render: (el: HTMLElement, opts: Record<string, unknown>) => string;
    reset: (id?: string) => void;
    remove: (id?: string) => void;
};
declare global {
    interface Window { turnstile?: TurnstileApi }
}
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
function loadTurnstile(): Promise<TurnstileApi> {
    return new Promise((resolve, reject) => {
        if (window.turnstile) return resolve(window.turnstile);
        const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
        const done = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("The CAPTCHA did not load.")));
        if (existing) {
            existing.addEventListener("load", done);
            existing.addEventListener("error", () => reject(new Error("The CAPTCHA could not be loaded. Check this device's connection to Cloudflare.")));
            return;
        }
        const s = document.createElement("script");
        s.src = TURNSTILE_SRC;
        s.async = true;
        s.onload = done;
        s.onerror = () => reject(new Error("The CAPTCHA could not be loaded. Check this device's connection to Cloudflare."));
        document.head.appendChild(s);
    });
}

const SIGNED_OUT_REASONS: Record<string, string> = {
    idle: "You were signed out because you were idle for a while. Sign in again to continue.",
    expired: "Your session has ended. Sign in again to continue.",
};

type LoginOk =
    | { user: any; ok?: true }
    | { status: "2fa_required"; challengeToken: string; jti?: string };

export default function LoginPage() {
    const router = useRouter();
    const params = useSearchParams();
    const nextPath = safeNext(params.get("next"));

    const { branding } = useBranding();

    // Normalize nullable strings -> undefined for JSX props
    const loginBg = branding?.loginBackgroundUrl ?? undefined;
    const logoLight = branding?.logoLightUrl ?? undefined;
    const logoDark = branding?.logoDarkUrl ?? undefined;
    const effectiveLogo = logoLight ?? logoDark ?? "/adg-saas-icon.png"; // always a string

    // Form state
    const [email, setEmail] = React.useState(() => {
        if (typeof window !== "undefined") {
            return localStorage.getItem("adg_last_email") ?? "";
        }
        return "";
    });
    const [password, setPassword] = React.useState("");
    const [remember, setRemember] = React.useState(
        () => (typeof window !== "undefined" ? localStorage.getItem("adg_remember") === "1" : false),
    );
    // The public demo has no password to type: one button signs the visitor in as the demo user.
    const demo = useDemoMode();
    const [isLoading, setIsLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const enterDemo = async () => {
        setError(null);
        setIsLoading(true);
        try {
            // The demo may be starting a fresh copy of itself, so try for a short while.
            for (let i = 0; i < 12; i++) {
                try {
                    const r = await fetch(`${API_BASE}/api/demo/enter`, { method: "POST", credentials: "include" });
                    if (r.ok) { router.replace(nextPath); return; }
                    if (r.status === 404 || r.status === 403) break;
                } catch { /* not up yet */ }
                await new Promise((resolve) => setTimeout(resolve, 2500));
            }
            setError("The demo is getting a fresh start. Please try again in a moment.");
        } finally {
            setIsLoading(false);
        }
    };
    const [showPw, setShowPw] = React.useState(false);
    const [capsLock, setCapsLock] = React.useState(false);

    // Single sign-on: shown when an administrator has turned it on.
    const [sso, setSso] = React.useState<{ enabled: boolean; displayName: string; passwordLogin: boolean } | null>(null);
    React.useEffect(() => {
        fetch(`${API_BASE}/api/auth/sso/config`, { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => setSso(j))
            .catch(() => setSso(null));
    }, []);
    const ssoError = params.get("sso_error");
    const SSO_MESSAGES: Record<string, string> = {
        sso_denied: "Sign-in was cancelled at your provider.",
        sso_expired: "That sign-in took too long or was already used. Please try again.",
        sso_no_account: "There is no account for your email address. Ask an administrator to add you.",
        sso_disabled: "Your account is turned off. Ask an administrator.",
        sso_domain: "Accounts from your email domain may not sign in here.",
        sso_no_email: "Your provider did not share an email address.",
        sso_unverified: "Your provider says your email address is not verified.",
        sso_conflict: "Your email address is linked to a different account at your provider.",
        sso_off: "Single sign-on is not turned on.",
        sso_ip_not_allowed: "Sign-in is not allowed from this network address. Ask an administrator.",
    };
    const startSso = () => {
        const back = `${window.location.origin}${nextPath}`;
        window.location.href = `${API_BASE}/api/auth/sso/start?returnTo=${encodeURIComponent(back)}`;
    };

    // CAPTCHA (Cloudflare Turnstile): shown when an administrator has turned it on.
    const [captcha, setCaptcha] = React.useState<{ enabled: boolean; siteKey: string } | null>(null);
    const [captchaToken, setCaptchaToken] = React.useState("");
    const [captchaError, setCaptchaError] = React.useState<string | null>(null);
    const captchaBox = React.useRef<HTMLDivElement | null>(null);
    const captchaWidget = React.useRef<string | null>(null);
    React.useEffect(() => {
        fetch(`${API_BASE}/api/auth/login-config`, { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => setCaptcha(j?.captcha?.enabled ? { enabled: true, siteKey: String(j.captcha.siteKey || "") } : { enabled: false, siteKey: "" }))
            .catch(() => setCaptcha({ enabled: false, siteKey: "" }));
    }, []);
    const resetCaptcha = React.useCallback(() => {
        setCaptchaToken("");
        if (captchaWidget.current && window.turnstile) window.turnstile.reset(captchaWidget.current);
    }, []);

    // 2FA step
    const [challengeToken, setChallengeToken] = React.useState<string | null>(null);
    const [otp, setOtp] = React.useState("");
    const [useRecovery, setUseRecovery] = React.useState(false);
    const otpRef = React.useRef<HTMLInputElement | null>(null);

    // Keep localStorage aligned with the remember choice
    React.useEffect(() => {
        if (typeof window === "undefined") return;
        if (remember) {
            localStorage.setItem("adg_remember", "1");
            if (email) localStorage.setItem("adg_last_email", email);
        } else {
            localStorage.removeItem("adg_remember");
            // Optional: keep last email for convenience
        }
    }, [remember, email]);

    const needsCaptcha = !!captcha?.enabled;
    const canSubmit = email.trim().length > 0 && password.length > 0 && !isLoading && (!needsCaptcha || captchaToken.length > 0);
    const canSubmitOtp =
        !!challengeToken &&
        !isLoading &&
        (useRecovery ? otp.trim().length >= 8 : otp.trim().length === 6);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setIsLoading(true);

        const payload: Record<string, any> = { email: email.trim(), password, ...(needsCaptcha ? { captchaToken } : {}) };
        // If you later add a device fingerprint, pass it here as deviceFingerprint
        try {
            const res = await fetch(`${API_BASE}/api/auth/login`, {
                method: "POST",
                credentials: "include", // set httpOnly cookie
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            // Try to parse JSON even on errors to read structured messages or 2FA status
            let body: LoginOk | any = null;
            try {
                body = await res.json();
            } catch {
                // ignore non-JSON body
            }

            if (!res.ok) {
                let msg = `Login failed (${res.status})`;
                if (body?.message) {
                    if (Array.isArray(body.message)) msg = body.message.join(", ");
                    else msg = String(body.message);
                }
                // A CAPTCHA token works once, so a failed attempt needs a fresh one.
                resetCaptcha();
                throw new Error(msg);
            }

            // 2FA branch
            if (body && typeof body === "object" && body.status === "2fa_required" && body.challengeToken) {
                setChallengeToken(body.challengeToken);
                setTimeout(() => otpRef.current?.focus(), 30);
                if (remember) localStorage.setItem("adg_last_email", payload.email);
                return; // stay on the page and render OTP form
            }

            // Regular login success
            if (remember) localStorage.setItem("adg_last_email", payload.email);
            router.replace(nextPath);
        } catch (err: any) {
            setError(String(err?.message ?? err) || "Login failed");
        } finally {
            setIsLoading(false);
        }
    };

    // Draws the widget once the keys are known, and again if the 2FA step is left.
    React.useEffect(() => {
        if (!captcha?.enabled || !captcha.siteKey || challengeToken) return;
        let cancelled = false;
        loadTurnstile()
            .then((ts) => {
                if (cancelled || !captchaBox.current) return;
                captchaWidget.current = ts.render(captchaBox.current, {
                    sitekey: captcha.siteKey,
                    callback: (t: string) => { setCaptchaError(null); setCaptchaToken(t); },
                    "expired-callback": () => setCaptchaToken(""),
                    "error-callback": () => { setCaptchaToken(""); setCaptchaError("The CAPTCHA check failed to run. Reload the page and try again."); },
                });
            })
            .catch((e) => !cancelled && setCaptchaError(String(e?.message ?? e)));
        return () => {
            cancelled = true;
            if (captchaWidget.current && window.turnstile) window.turnstile.remove(captchaWidget.current);
            captchaWidget.current = null;
            setCaptchaToken("");
        };
    }, [captcha, challengeToken]);

    const handleOtpVerify = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!challengeToken) return;
        setError(null);
        setIsLoading(true);

        try {
            const body: any = { challengeToken, rememberDevice: remember };
            if (useRecovery) body.recoveryCode = otp.trim();
            else body.code = otp.trim();

            const res = await fetch(`${API_BASE}/api/auth/2fa/verify`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                let msg = `Verification failed (${res.status})`;
                try {
                    const j = await res.json();
                    if (j?.message) {
                        if (Array.isArray(j.message)) msg = j.message.join(", ");
                        else msg = String(j.message);
                    }
                } catch { /* ignore */ }
                throw new Error(msg);
            }

            // On success, API sets cookie; proceed
            router.replace(nextPath);
        } catch (err: any) {
            setError(String(err?.message ?? err) || "Invalid code");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div
            className="relative flex min-h-screen items-center justify-center bg-background p-4 bg-cover bg-center"
            style={loginBg ? { backgroundImage: `url(${loginBg})` } : undefined}
        >
            {/* Subtle overlay for readability (only when bg is present) */}
            {loginBg && <div className="pointer-events-none absolute inset-0 bg-black/10" />}

            <Card className="relative z-10 w-full max-w-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
                <CardHeader className="text-center">
                    <div className="mb-3 flex items-center justify-center gap-2">
                        {/* Prefer brand logos; fall back to icon */}
                        <picture>
                            {logoDark ? <source srcSet={logoDark} media="(prefers-color-scheme: dark)" /> : null}
                            <img src={effectiveLogo} alt="ADG RMM" className="h-7 w-auto rounded-sm" />
                        </picture>
                        <CardTitle className="text-2xl">ADG RMM</CardTitle>
                    </div>
                    <CardDescription>
                        {challengeToken ? "Two-factor authentication required" : "Sign in to your account to continue"}
                    </CardDescription>
                </CardHeader>

                {!challengeToken && params.get("reason") && SIGNED_OUT_REASONS[params.get("reason") as string] ? (
                    <div role="status" className="mx-6 mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
                        {SIGNED_OUT_REASONS[params.get("reason") as string]}
                    </div>
                ) : null}
                {!challengeToken && ssoError ? (
                    <div role="alert" className="mx-6 mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                        {SSO_MESSAGES[ssoError] ?? "Single sign-on did not work. Please try again."}
                    </div>
                ) : null}
                {!challengeToken && sso?.enabled ? (
                    <div className="mx-6 mb-2 grid gap-2">
                        <Button type="button" variant="outline" className="w-full" onClick={startSso}>
                            {sso.displayName.trim() || "Single sign-on"}
                        </Button>
                        <p className="text-center text-xs text-muted-foreground">
                            {sso.passwordLogin ? "or sign in with a password" : "Passwords are off for most accounts. Owners can still use one."}
                        </p>
                    </div>
                ) : null}

                {/* Step 1: Email + Password */}
                {!challengeToken && demo && (
                    <CardContent className="grid gap-3 pb-6">
                        <p className="text-center text-sm text-muted-foreground">
                            A live demo with sample customers, devices and tickets. Look around and try things; nothing you change is kept.
                        </p>
                        {error ? (
                            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{error}</div>
                        ) : null}
                        <Button type="button" className="w-full" onClick={enterDemo} disabled={isLoading}>
                            {isLoading ? "Starting the demo…" : "Enter the demo"}
                        </Button>
                    </CardContent>
                )}
                {!challengeToken && !demo && (
                    <form onSubmit={handleLogin} noValidate>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="email">Email</Label>
                                <Input
                                    id="email"
                                    type="email"
                                    placeholder="admin@example.com"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    disabled={isLoading}
                                    autoComplete="username"
                                    inputMode="email"
                                />
                            </div>

                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label htmlFor="password">Password</Label>
                                    <Link href="/forgot-password" className="text-sm font-medium text-primary hover:underline">
                                        Forgot password?
                                    </Link>
                                </div>

                                <div className="relative">
                                    <Input
                                        id="password"
                                        type={showPw ? "text" : "password"}
                                        required
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        onKeyUp={(e) => setCapsLock((e as any).getModifierState?.("CapsLock") === true)}
                                        disabled={isLoading}
                                        autoComplete="current-password"
                                    />
                                    <button
                                        type="button"
                                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground"
                                        onClick={() => setShowPw((s) => !s)}
                                        aria-label={showPw ? "Hide password" : "Show password"}
                                    >
                                        {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                </div>

                                {capsLock && <p className="text-xs text-amber-600 dark:text-amber-400">Caps Lock is ON</p>}
                            </div>

                            <div className="flex items-center justify-between">
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        className="accent-primary h-4 w-4"
                                        checked={remember}
                                        onChange={(e) => setRemember(e.target.checked)}
                                        disabled={isLoading}
                                    />
                                    Remember me
                                </label>
                            </div>

                            {needsCaptcha ? (
                                <div className="space-y-1">
                                    <div ref={captchaBox} className="flex justify-center" />
                                    {captchaError ? <p className="text-center text-xs text-destructive">{captchaError}</p> : null}
                                </div>
                            ) : null}

                            {error && <p className="text-sm text-destructive">{error}</p>}
                        </CardContent>

                        <CardFooter className="flex flex-col gap-3">
                            <Button type="submit" className="w-full" disabled={!canSubmit}>
                                {isLoading ? "Signing In..." : "Sign In"}
                            </Button>
                        </CardFooter>
                    </form>
                )}

                {/* Step 2: OTP / Recovery Code */}
                {challengeToken && (
                    <form onSubmit={handleOtpVerify} noValidate>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="otp">{useRecovery ? "Recovery code" : "Authenticator code"}</Label>
                                <Input
                                    id="otp"
                                    ref={otpRef}
                                    inputMode={useRecovery ? "text" : "numeric"}
                                    placeholder={useRecovery ? "enter a backup code" : "123456"}
                                    value={otp}
                                    onChange={(e) => setOtp(e.target.value)}
                                    disabled={isLoading}
                                />
                                <div className="text-xs text-muted-foreground">
                                    {useRecovery
                                        ? "Enter one of your single-use recovery codes."
                                        : "Open your authenticator app and enter the 6-digit code."}
                                </div>
                            </div>

                            <div className="flex items-center justify-between">
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        className="accent-primary h-4 w-4"
                                        checked={remember}
                                        onChange={(e) => setRemember(e.target.checked)}
                                        disabled={isLoading}
                                    />
                                    Remember this device
                                </label>

                                <button
                                    type="button"
                                    className="text-sm font-medium text-primary hover:underline"
                                    onClick={() => setUseRecovery((s) => !s)}
                                >
                                    {useRecovery ? "Use 6-digit code" : "Use a recovery code"}
                                </button>
                            </div>

                            {error && <p className="text-sm text-destructive">{error}</p>}
                        </CardContent>

                        <CardFooter className="flex flex-col gap-3">
                            <Button type="submit" className="w-full" disabled={!canSubmitOtp}>
                                {isLoading ? "Verifying..." : "Verify & Sign In"}
                            </Button>
                            <button
                                type="button"
                                className="text-sm text-muted-foreground underline hover:no-underline"
                                onClick={() => {
                                    // allow retrying email+password
                                    setChallengeToken(null);
                                    setOtp("");
                                    setUseRecovery(false);
                                    setError(null);
                                }}
                            >
                                Go back
                            </button>
                        </CardFooter>
                    </form>
                )}
            </Card>
        </div>
    );
}
