// backend/src/auth/security-policy.service.ts
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { AuditService } from "../audit/audit.service";
import { clientIpOf } from "../audit/audit.util";
import { decryptSecret, encryptSecret, hasDataKey } from "../common/secret-box";
import {
    LIMITS,
    SecurityPolicy,
    describePasswordRules,
    forgetPolicyCache,
    fromRow,
    ipAllowed,
    loadPolicy,
    parseAllowlist,
} from "./security-policy";
import { verifyTurnstile } from "./turnstile";

/** Switches that let a server administrator undo these settings without being able to sign in. */
export const envIgnoresAllowlist = () => ["1", "true", "yes", "on"].includes(String(process.env.ADG_IGNORE_IP_ALLOWLIST ?? "").trim().toLowerCase());
export const envDisablesCaptcha = () => ["1", "true", "yes", "on"].includes(String(process.env.ADG_DISABLE_CAPTCHA ?? "").trim().toLowerCase());

export type SecurityPolicyAdmin = Omit<SecurityPolicy, "turnstileSecret"> & {
    hasTurnstileSecret: boolean;
    /** The address this request seems to come from, so the allowlist can be checked against it before saving. */
    yourIp: string | null;
    passwordRules: string;
    env: { allowlistIgnored: boolean; captchaDisabled: boolean };
    limits: typeof LIMITS;
};

export type SecurityPolicyInput = Partial<Omit<SecurityPolicy, "turnstileSecret">> & { turnstileSecret?: string | null };

type Actor = { id: string; email?: string | null };

const isOwner = (roles: unknown): boolean =>
    Array.isArray(roles) && roles.some((r: any) => String(r?.name ?? r ?? "").trim().toLowerCase() === "owner");

@Injectable()
export class SecurityPolicyService {
    private readonly log = new Logger(SecurityPolicyService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly audit: AuditService,
    ) { }

    // ---- Settings screen ----------------------------------------------------------------------------------

    private view(p: SecurityPolicy, req: any): SecurityPolicyAdmin {
        const { turnstileSecret, ...rest } = p;
        return {
            ...rest,
            hasTurnstileSecret: !!turnstileSecret,
            yourIp: clientIpOf(req),
            passwordRules: describePasswordRules(p),
            env: { allowlistIgnored: envIgnoresAllowlist(), captchaDisabled: envDisablesCaptcha() },
            limits: LIMITS,
        };
    }

    async get(orgId: string, req: any): Promise<SecurityPolicyAdmin> {
        forgetPolicyCache(orgId);
        return this.view(await loadPolicy(this.prisma, orgId), req);
    }

    async save(orgId: string, actor: Actor, input: SecurityPolicyInput, req: any): Promise<SecurityPolicyAdmin> {
        forgetPolicyCache(orgId);
        const cur = await loadPolicy(this.prisma, orgId);
        const next: SecurityPolicy = { ...cur };

        const int = (name: keyof typeof LIMITS, label: string, allowZero: boolean): number | undefined => {
            const raw = (input as any)[name];
            if (raw === undefined) return undefined;
            const n = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : NaN;
            const [lo, hi] = LIMITS[name];
            if (allowZero && n === 0) return 0;
            if (!Number.isInteger(n) || n < lo || n > hi) {
                throw new BadRequestException(`${label} must be ${allowZero ? `0 (off) or ` : ""}a whole number from ${lo} to ${hi}.`);
            }
            return n;
        };
        next.passwordMinLength = int("passwordMinLength", "The minimum password length", false) ?? next.passwordMinLength;
        next.passwordHistory = int("passwordHistory", "Password history", true) ?? next.passwordHistory;
        next.sessionTimeoutMins = int("sessionTimeoutMins", "The session timeout", true) ?? next.sessionTimeoutMins;
        next.idleTimeoutMins = int("idleTimeoutMins", "The idle timeout", true) ?? next.idleTimeoutMins;
        for (const k of ["passwordRequireNumbers", "passwordRequireSpecial", "passwordRequireUppercase", "captchaEnabled"] as const) {
            if (input[k] !== undefined) {
                if (typeof input[k] !== "boolean") throw new BadRequestException(`${k} must be true or false.`);
                next[k] = input[k] as boolean;
            }
        }
        if (input.turnstileSiteKey !== undefined) next.turnstileSiteKey = String(input.turnstileSiteKey ?? "").trim().slice(0, 200);

        // The address list: a bad line is named, and a list that leaves the saving administrator out is refused.
        if (input.ipAllowlist !== undefined) {
            const text = String(input.ipAllowlist ?? "");
            if (text.length > 20_000) throw new BadRequestException("The address list is too long.");
            let entries;
            try {
                entries = parseAllowlist(text);
            } catch (e: any) {
                throw new BadRequestException(e.message);
            }
            next.ipAllowlist = entries.map((e) => e.raw).join("\n");
            if (entries.length && !envIgnoresAllowlist()) {
                const mine = clientIpOf(req);
                if (!mine || !ipAllowed(entries, mine)) {
                    throw new BadRequestException(
                        `That list does not include your own address${mine ? ` (${mine})` : ""}, so you could not sign in again. Add it to the list first. ` +
                        `(Owners can always sign in, whatever the list says.)`,
                    );
                }
            }
        }

        // The secret is kept encrypted and never read back; an empty value keeps the saved one.
        let secretToStore: string | null = cur.turnstileSecret;
        let secretChanged = false;
        if (typeof input.turnstileSecret === "string" && input.turnstileSecret.trim()) {
            if (!hasDataKey()) throw new BadRequestException("Secrets cannot be stored safely: DATA_ENCRYPTION_KEY_FILE is not set on the server.");
            secretToStore = encryptSecret(input.turnstileSecret.trim());
            secretChanged = true;
        } else if (input.turnstileSecret === null) {
            secretToStore = null;
            secretChanged = cur.turnstileSecret !== null;
        }
        next.turnstileSecret = secretToStore;

        if (next.captchaEnabled) {
            if (!next.turnstileSiteKey || !next.turnstileSecret) {
                throw new BadRequestException("Enter the Turnstile site key and secret key before turning the CAPTCHA on.");
            }
            // Cloudflare rejects a wrong secret key even for a made-up token, so a typo is found now and not when nobody can sign in.
            if (secretChanged || !cur.captchaEnabled || next.turnstileSiteKey !== cur.turnstileSiteKey) {
                const r = await verifyTurnstile(decryptSecret(next.turnstileSecret), "adg-key-check", null);
                if (r.kind === "misconfigured") {
                    throw new BadRequestException(`Cloudflare did not accept the secret key (${r.codes.join(", ")}). Check it in the Cloudflare dashboard under Turnstile.`);
                }
                if (r.kind === "unreachable") {
                    throw new BadRequestException(`Could not reach Cloudflare to check the keys (${r.detail}), so the CAPTCHA was not turned on. Sign-in needs that connection while the CAPTCHA is on.`);
                }
            }
        }

        const data = {
            password_min_length: next.passwordMinLength,
            password_require_numbers: next.passwordRequireNumbers,
            password_require_special: next.passwordRequireSpecial,
            password_require_uppercase: next.passwordRequireUppercase,
            password_history: next.passwordHistory,
            session_timeout_mins: next.sessionTimeoutMins,
            idle_timeout_mins: next.idleTimeoutMins,
            ip_allowlist: next.ipAllowlist,
            captcha_enabled: next.captchaEnabled,
            turnstile_site_key: next.turnstileSiteKey,
            turnstile_secret: next.turnstileSecret,
            updated_at: new Date(),
            updated_by: actor.id,
        };
        await this.prisma.security_policies.upsert({
            where: { organization_id: orgId },
            create: { organization_id: orgId, ...data },
            update: data,
        });
        forgetPolicyCache(orgId);

        // What changed, never the secret itself.
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const k of Object.keys(next) as (keyof SecurityPolicy)[]) {
            if (k === "turnstileSecret") continue;
            if (JSON.stringify(cur[k]) !== JSON.stringify(next[k])) changes[k] = { from: cur[k], to: next[k] };
        }
        if (secretChanged) changes.turnstileSecret = { from: cur.turnstileSecret ? "set" : "not set", to: next.turnstileSecret ? "set" : "removed" };
        await this.audit.record({
            action: "security_policies.update",
            category: "settings",
            outcome: "success",
            actorUserId: actor.id,
            actorEmail: actor.email,
            targetType: "organization",
            targetId: orgId,
            req,
            // A key named "turnstileSecret" would be scrubbed by the audit writer, so the change is spelled out.
            details: { changes: Object.keys(changes).length ? JSON.stringify(changes) : "no change" },
        });
        return this.view(next, req);
    }

    // ---- Signing in ---------------------------------------------------------------------------------------

    /** What the sign-in page needs: whether to show the CAPTCHA widget, and its public site key. */
    async loginConfig(): Promise<{ captcha: { enabled: boolean; siteKey: string } }> {
        const p = await loadPolicy(this.prisma, await this.orgs.getDefaultOrganizationId());
        const on = p.captchaEnabled && !!p.turnstileSiteKey && !!p.turnstileSecret && !envDisablesCaptcha();
        return { captcha: { enabled: on, siteKey: on ? p.turnstileSiteKey : "" } };
    }

    /** Checks the CAPTCHA token sent with a sign-in. A no-op when the CAPTCHA is off. */
    async assertCaptcha(req: any, token: unknown): Promise<void> {
        const p = await loadPolicy(this.prisma, await this.orgs.getDefaultOrganizationId());
        if (!p.captchaEnabled || !p.turnstileSecret || envDisablesCaptcha()) return;

        const fail = (status: HttpStatus, code: string, message: string) => {
            void this.audit.recordSignInBlocked({ req, reason: code, via: "captcha" });
            throw new HttpException({ statusCode: status, message, code }, status);
        };
        if (typeof token !== "string" || !token.trim() || token.length > 4096) {
            return fail(HttpStatus.BAD_REQUEST, "captcha_required", "Complete the CAPTCHA check and try again.");
        }
        const r = await verifyTurnstile(decryptSecret(p.turnstileSecret), token.trim(), clientIpOf(req));
        if (r.kind === "ok") return;
        if (r.kind === "rejected") {
            return fail(HttpStatus.BAD_REQUEST, "captcha_failed", "The CAPTCHA check failed. Reload the check and try again.");
        }
        if (r.kind === "misconfigured") {
            this.log.error(`Turnstile refused the secret key (${r.codes.join(", ")}). Nobody can sign in until it is fixed in Security Policies, or ADG_DISABLE_CAPTCHA=1 is set on the server.`);
            return fail(HttpStatus.SERVICE_UNAVAILABLE, "captcha_misconfigured", "Sign-in is blocked because the CAPTCHA is set up wrongly on the server. A server administrator can switch it off with ADG_DISABLE_CAPTCHA=1.");
        }
        this.log.warn(`Turnstile could not be reached (${r.detail}).`);
        return fail(HttpStatus.SERVICE_UNAVAILABLE, "captcha_unavailable", "The CAPTCHA service could not be reached, so sign-in is paused. Try again in a moment.");
    }

    /**
     * Staff may only sign in from the listed addresses. Owners are exempt, so a wrong list can always be fixed,
     * and ADG_IGNORE_IP_ALLOWLIST=1 switches the rule off from the server.
     */
    async assertSignInAddress(req: any, user: { id: string; email: string; roles?: unknown }): Promise<void> {
        if (envIgnoresAllowlist()) return;
        const orgId = (user as any).organizationId ?? (await this.orgs.getDefaultOrganizationId());
        const p = await loadPolicy(this.prisma, orgId);
        if (!p.ipAllowlist.trim()) return;
        if (isOwner(user.roles)) return;
        let entries;
        try {
            entries = parseAllowlist(p.ipAllowlist);
        } catch {
            return; // a damaged list is ignored rather than locking everyone out
        }
        const ip = clientIpOf(req);
        if (ip && ipAllowed(entries, ip)) return;
        void this.audit.recordSignIn({ req, outcome: "failure", email: user.email, userId: user.id, reason: "ip_not_allowed" });
        throw new ForbiddenException(`Sign-in is not allowed from this network address${ip ? ` (${ip})` : ""}. Ask an administrator.`);
    }

    /** What the console needs to end a sign-in on its own when the person walks away. */
    async sessionRules(orgId: string): Promise<{ idleTimeoutMins: number; sessionTimeoutMins: number }> {
        const p = await loadPolicy(this.prisma, orgId);
        return { idleTimeoutMins: p.idleTimeoutMins, sessionTimeoutMins: p.sessionTimeoutMins };
    }
}
