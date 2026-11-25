import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import type { Request } from "express";
import { PrismaService } from "../storage/prisma.service";
import { SmtpService } from "../smtp/smtp.service";
import { EmailTemplatesService } from "../templates/email-templates.service";
import { AuthRateLimiter } from "../auth/auth-rate-limiter.service";
import { AuditService } from "../audit/audit.service";
import { PortalSettingsService } from "./portal-settings.service";
import { hashToken, INVITE_DAYS, newToken, passwordProblem, portalSecret, RESET_HOURS, SESSION_DAYS, validEmail } from "./portal.util";

/** Who is signed in to the portal, as the data endpoints see them. */
export type PortalActor = {
    accountId: string;
    sessionId: string;
    orgId: string;
    clientId: string;
    clientName: string;
    role: "user" | "manager";
    name: string;
    email: string;
};

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;
/** Compared against when the email is unknown, so a wrong email takes as long as a wrong password. */
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= bcrypt.hash("not-a-real-password", 10));

type AccountRow = {
    id: string;
    organization_id: string;
    client_id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    password_hash: string | null;
    failed_logins: number;
    locked_until: Date | null;
};

@Injectable()
export class PortalAuthService {
    private readonly logger = new Logger(PortalAuthService.name);
    private readonly jwt = new JwtService({ secret: portalSecret(), signOptions: { algorithm: "HS256" } });

    constructor(
        private readonly prisma: PrismaService,
        private readonly settings: PortalSettingsService,
        private readonly smtp: SmtpService,
        private readonly templates: EmailTemplatesService,
        private readonly limiter: AuthRateLimiter,
        private readonly audit: AuditService,
    ) { }

    /* --------------------------------- sign in --------------------------------- */

    async login(emailInput: unknown, password: unknown, req: Request): Promise<{ token: string; maxAgeMs: number }> {
        if (!(await this.settings.isOn())) throw new ForbiddenException("The portal is not available.");
        const email = validEmail(emailInput);
        const ip = this.limiter.clientIp(req);
        this.limiter.assertAllowed(ip, email ?? undefined);
        const fail = async (reason: string, status = 401) => {
            this.limiter.recordFailure(ip, email ?? undefined);
            void this.audit.recordSignIn({ req, outcome: "failure", reason, email: email ?? undefined, via: "portal", action: "portal.signin" } as any);
            throw new HttpException("Incorrect email or password.", status);
        };

        const rows = email ? await this.prisma.$queryRaw<AccountRow[]>`
            SELECT a.id::text AS id, a.organization_id::text AS organization_id, a.client_id::text AS client_id, a.email::text AS email, a.name, a.role, a.status,
                   a.password_hash, a.failed_logins, a.locked_until
              FROM portal_accounts a JOIN clients c ON c.id = a.client_id
             WHERE a.email = ${email}::citext AND c.archived_at IS NULL` : [];
        const a = rows[0];
        const ok = await bcrypt.compare(String(password ?? ""), a?.password_hash || (await dummy()));
        if (!a || !a.password_hash) return fail("unknown_account");
        if (a.locked_until && a.locked_until.getTime() > Date.now()) return fail("locked", 429);
        if (!ok) {
            const lock = a.failed_logins + 1 >= MAX_FAILED;
            await this.prisma.$executeRaw`UPDATE portal_accounts SET failed_logins = ${lock ? 0 : a.failed_logins + 1},
                locked_until = ${lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null}, updated_at = now() WHERE id = ${a.id}::uuid`;
            return fail("bad_password");
        }
        if (a.status !== "active") return fail(`status_${a.status}`);

        const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
        const session = await this.prisma.portal_sessions.create({
            data: { account_id: a.id, expires_at: expires, ip: ip.slice(0, 64), user_agent: String(req.headers["user-agent"] ?? "").slice(0, 300) },
        });
        await this.prisma.$executeRaw`UPDATE portal_accounts SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = ${a.id}::uuid`;
        this.limiter.recordSuccess(email!);
        void this.audit.recordSignIn({ req, outcome: "success", email: email!, via: "portal", action: "portal.signin" } as any);
        const token = await this.jwt.signAsync({ sub: a.id, sid: session.id, aud: "portal" }, { expiresIn: `${SESSION_DAYS}d` });
        return { token, maxAgeMs: SESSION_DAYS * 86_400_000 };
    }

    /** The person behind a sign-in token, or null. Checked against the database every time, so disabling takes effect at once. */
    async authenticate(token: string | undefined): Promise<PortalActor | null> {
        if (!token) return null;
        let payload: { sub?: string; sid?: string; aud?: string };
        try {
            payload = await this.jwt.verifyAsync(token);
        } catch {
            return null;
        }
        if (payload.aud !== "portal" || !payload.sub || !payload.sid) return null;
        if (!(await this.settings.isOn())) return null;
        const rows = await this.prisma.$queryRaw<{ id: string; organization_id: string; client_id: string; client_name: string; role: string; name: string; email: string }[]>`
            SELECT a.id::text AS id, a.organization_id::text AS organization_id, a.client_id::text AS client_id, c.name AS client_name, a.role, a.name, a.email::text AS email
              FROM portal_sessions s
              JOIN portal_accounts a ON a.id = s.account_id
              JOIN clients c ON c.id = a.client_id
             WHERE s.id = ${payload.sid}::uuid AND a.id = ${payload.sub}::uuid
               AND s.revoked_at IS NULL AND s.expires_at > now()
               AND a.status = 'active' AND c.archived_at IS NULL`.catch(() => []);
        const r = rows[0];
        if (!r) return null;
        return { accountId: r.id, sessionId: payload.sid, orgId: r.organization_id, clientId: r.client_id, clientName: r.client_name, role: r.role === "manager" ? "manager" : "user", name: r.name, email: r.email };
    }

    async logout(sessionId: string) {
        await this.prisma.portal_sessions.updateMany({ where: { id: sessionId, revoked_at: null }, data: { revoked_at: new Date() } });
    }

    /* ----------------------------- passwords and links ----------------------------- */

    async changePassword(actor: PortalActor, current: unknown, next: unknown) {
        const problem = passwordProblem(next);
        if (problem) throw new BadRequestException(problem);
        const a = await this.prisma.portal_accounts.findUnique({ where: { id: actor.accountId }, select: { password_hash: true } });
        if (!a?.password_hash || !(await bcrypt.compare(String(current ?? ""), a.password_hash))) throw new BadRequestException("The current password is not right.");
        await this.prisma.portal_accounts.update({ where: { id: actor.accountId }, data: { password_hash: await bcrypt.hash(String(next), 12), updated_at: new Date() } });
        // Every other browser has to sign in again.
        await this.prisma.portal_sessions.updateMany({ where: { account_id: actor.accountId, revoked_at: null, NOT: { id: actor.sessionId } }, data: { revoked_at: new Date() } });
    }

    /** Sends the invitation to set a first password, or for someone already signed up, a link to choose a new one. */
    async sendInvite(accountId: string): Promise<{ sent: boolean; message?: string }> {
        const a = await this.prisma.portal_accounts.findUnique({ where: { id: accountId }, select: { status: true } });
        return this.sendLink(accountId, a?.status === "active" ? "reset" : "invite");
    }

    /** Always answers the same way, so it cannot be used to find out who has an account. */
    async requestReset(emailInput: unknown, req: Request): Promise<void> {
        const email = validEmail(emailInput);
        const ip = this.limiter.clientIp(req);
        this.limiter.assertAllowed(ip, email ?? undefined);
        this.limiter.recordFailure(ip, email ?? undefined); // counts toward a limit, so this cannot be used to send floods of mail
        if (!email || !(await this.settings.isOn())) return;
        const a = await this.prisma.portal_accounts.findUnique({ where: { email }, select: { id: true, status: true } });
        if (a && a.status !== "disabled") await this.sendLink(a.id, a.status === "invited" ? "invite" : "reset").catch((e) => this.logger.warn(`reset mail failed: ${e?.message}`));
    }

    private async sendLink(accountId: string, kind: "invite" | "reset"): Promise<{ sent: boolean; message?: string }> {
        const a = await this.prisma.portal_accounts.findUnique({ where: { id: accountId } });
        if (!a) throw new NotFoundException("That person was not found.");
        if (a.status === "disabled") throw new ConflictException("This account is disabled.");
        const s = await this.settings.get();
        if (!s.domain) throw new ConflictException("Set the portal address first.");

        const token = newToken();
        const hours = kind === "invite" ? INVITE_DAYS * 24 : RESET_HOURS;
        // Older unused links stop working when a new one is sent.
        await this.prisma.portal_tokens.deleteMany({ where: { account_id: a.id, kind, used_at: null } });
        await this.prisma.portal_tokens.create({ data: { account_id: a.id, kind, token_hash: hashToken(token), expires_at: new Date(Date.now() + hours * 3_600_000) } });

        const link = `https://${s.domain}/set-password?token=${token}`;
        const company = await this.companyName();
        // The wording is the built-in one unless an administrator changed it (Administration > Templates).
        const mail = await this.templates.render(kind === "invite" ? "portal_invite" : "portal_reset", {
            name: a.name,
            company: company || "Your IT provider",
            company_prefix: company ? `${company}: ` : "",
            link,
            portal_url: `https://${s.domain}`,
            valid_days: String(INVITE_DAYS),
            valid_hours: String(RESET_HOURS),
            features: s.modules.includes("invoices") ? " and invoices" : "",
        }, a.organization_id);
        const res = await this.smtp.sendPlain(kind === "invite" ? "invites" : "password_resets", a.email, mail.subject, mail.body);
        if (!res.ok) return { sent: false, message: res.result };
        return { sent: true };
    }

    private async companyName(): Promise<string> {
        const r = await this.prisma.$queryRaw<{ name: string | null }[]>`SELECT name FROM organizations LIMIT 1`.catch(() => []);
        return String(r[0]?.name ?? "").trim();
    }

    /** What a link says before anyone uses it, so the page can greet the person by name. */
    async describeLink(token: string, req: Request): Promise<{ kind: "invite" | "reset"; name: string; email: string }> {
        const ip = this.limiter.clientIp(req);
        this.limiter.assertAllowed(ip);
        let t;
        try {
            t = await this.validToken(token);
        } catch (e) {
            this.limiter.recordFailure(ip);
            throw e;
        }
        return { kind: t.kind as "invite" | "reset", name: t.name, email: t.email };
    }

    private async validToken(token: string) {
        if (!token || token.length > 200) throw new NotFoundException("This link is not valid or has expired.");
        const rows = await this.prisma.$queryRaw<{ id: string; kind: string; account_id: string; name: string; email: string; status: string }[]>`
            SELECT t.id::text AS id, t.kind, t.account_id::text AS account_id, a.name, a.email::text AS email, a.status
              FROM portal_tokens t JOIN portal_accounts a ON a.id = t.account_id
             WHERE t.token_hash = ${hashToken(token)} AND t.used_at IS NULL AND t.expires_at > now()`;
        const t = rows[0];
        if (!t || t.status === "disabled") throw new NotFoundException("This link is not valid or has expired.");
        return t;
    }

    /** The invitation or reset link: sets the password, and signs every other browser out. */
    async setPassword(token: string, password: unknown, req: Request): Promise<{ token: string; maxAgeMs: number }> {
        const ip = this.limiter.clientIp(req);
        this.limiter.assertAllowed(ip);
        const problem = passwordProblem(password);
        if (problem) throw new BadRequestException(problem);
        let t;
        try {
            t = await this.validToken(token);
        } catch (e) {
            this.limiter.recordFailure(ip);
            throw e;
        }
        const hash = await bcrypt.hash(String(password), 12);
        await this.prisma.$transaction([
            this.prisma.portal_accounts.update({ where: { id: t.account_id }, data: { password_hash: hash, status: "active", failed_logins: 0, locked_until: null, updated_at: new Date() } }),
            this.prisma.portal_tokens.update({ where: { id: t.id }, data: { used_at: new Date() } }),
            this.prisma.portal_sessions.updateMany({ where: { account_id: t.account_id, revoked_at: null }, data: { revoked_at: new Date() } }),
        ]);
        return this.login(t.email, password, req);
    }

    /* ------------------------------- administration ------------------------------- */

    async revokeAll(accountId: string) {
        await this.prisma.portal_sessions.updateMany({ where: { account_id: accountId, revoked_at: null }, data: { revoked_at: new Date() } });
    }

    unauthorized(): never {
        throw new UnauthorizedException("Sign in to continue.");
    }
}
