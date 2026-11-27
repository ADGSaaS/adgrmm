import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../storage/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { UserAuthService } from "./user-auth.service";
import {
    Claims,
    Discovery,
    OidcError,
    authorizationUrl,
    checkProviderUrl,
    discover,
    domainAllowed,
    exchangeCode,
    newPkce,
    randomToken,
    safeReturn,
    verifyIdToken,
} from "./oidc";
import { trimTrailing } from "../common/text-util";

export type SsoPublic = { enabled: boolean; displayName: string; passwordLogin: boolean };

export type SsoAdmin = SsoPublic & {
    issuer: string;
    clientId: string;
    hasClientSecret: boolean;
    scopes: string;
    jitEnabled: boolean;
    defaultRoleId: string | null;
    allowedDomains: string;
    redirectUri?: string;
};

const STATE_MS = 10 * 60_000;

/** Seconds of the sign-in that Microsoft-style providers need: openid is required, email and profile are asked for by default. */
const DEFAULT_SCOPES = "openid email profile";

@Injectable()
export class SsoService {
    private readonly log = new Logger(SsoService.name);
    /** Replaceable in tests. */
    oidc = { discover, exchangeCode, verifyIdToken };

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly users: UserAuthService,
        private readonly entitlements: EntitlementsService
    ) { }

    // ---- Settings -------------------------------------------------------------------------------------------

    private async row(orgId: string) {
        return this.prisma.sso_config.findUnique({ where: { organization_id: orgId } });
    }

    /** What the sign-in page needs to know: whether to show the button, and whether passwords still work. */
    async publicStatus(): Promise<SsoPublic> {
        const r = await this.row(await this.orgs.getDefaultOrganizationId());
        const on = !!(r?.enabled && r.issuer && r.client_id && r.client_secret);
        return { enabled: on, displayName: r?.display_name || "Single sign-on", passwordLogin: on ? r!.password_login : true };
    }

    async admin(orgId: string): Promise<SsoAdmin> {
        const r = await this.row(orgId);
        return {
            enabled: !!r?.enabled,
            displayName: r?.display_name ?? "Single sign-on",
            passwordLogin: r?.password_login ?? true,
            issuer: r?.issuer ?? "",
            clientId: r?.client_id ?? "",
            hasClientSecret: !!r?.client_secret,
            scopes: r?.scopes ?? DEFAULT_SCOPES,
            jitEnabled: r?.jit_enabled ?? false,
            defaultRoleId: r?.default_role_id ?? null,
            allowedDomains: r?.allowed_domains ?? "",
        };
    }

    async save(
        orgId: string,
        input: {
            enabled?: boolean;
            displayName?: string;
            issuer?: string;
            clientId?: string;
            clientSecret?: string;
            scopes?: string;
            jitEnabled?: boolean;
            defaultRoleId?: string | null;
            allowedDomains?: string;
            passwordLogin?: boolean;
        }
    ): Promise<SsoAdmin> {
        const cur = await this.row(orgId);
        const next = {
            enabled: input.enabled ?? cur?.enabled ?? false,
            display_name: (input.displayName ?? cur?.display_name ?? "Single sign-on").trim().slice(0, 60) || "Single sign-on",
            issuer: trimTrailing((input.issuer ?? cur?.issuer ?? "").trim(), "/"),
            client_id: (input.clientId ?? cur?.client_id ?? "").trim(),
            scopes: (input.scopes ?? cur?.scopes ?? DEFAULT_SCOPES).trim().replace(/\s+/g, " "),
            jit_enabled: input.jitEnabled ?? cur?.jit_enabled ?? false,
            default_role_id: input.defaultRoleId !== undefined ? input.defaultRoleId : cur?.default_role_id ?? null,
            allowed_domains: (input.allowedDomains ?? cur?.allowed_domains ?? "").trim().toLowerCase(),
            password_login: input.passwordLogin ?? cur?.password_login ?? true,
        };

        if (next.issuer) {
            try {
                checkProviderUrl(next.issuer, "The issuer");
            } catch (e: any) {
                throw new BadRequestException(e.message);
            }
        }
        if (!/(^| )openid( |$)/.test(next.scopes)) throw new BadRequestException("The scopes must include openid.");
        if (next.allowed_domains && !/^[a-z0-9.@, -]+$/.test(next.allowed_domains)) throw new BadRequestException("Allowed domains look like example.com, example.org.");

        const secret = typeof input.clientSecret === "string" && input.clientSecret.trim() ? input.clientSecret.trim() : null;
        const hasSecret = !!(secret || cur?.client_secret);
        if (next.enabled && !(next.issuer && next.client_id && hasSecret)) {
            throw new BadRequestException("Fill in the issuer, client ID and client secret before turning single sign-on on.");
        }

        if (next.default_role_id) {
            if (!isCanonicalUuid(next.default_role_id)) throw new BadRequestException("That role does not exist.");
            const role = await this.prisma.roles.findFirst({ where: { id: next.default_role_id, OR: [{ organization_id: orgId }, { organization_id: null }] }, select: { id: true } });
            if (!role) throw new BadRequestException("That role does not exist.");
        }
        if (next.jit_enabled && !next.default_role_id) throw new BadRequestException("Choose the role new people get before turning on automatic account creation.");

        // Turning passwords off must not lock everyone out: at least one active Owner has to remain who can still use one.
        if (next.enabled && !next.password_login) {
            const owners = await this.prisma.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM users u
              JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
              WHERE u.organization_id = ${orgId}::uuid AND u.status = 'active' AND lower(r.name) = 'owner'`;
            if ((owners[0]?.n ?? 0) === 0) throw new BadRequestException("Passwords can only be turned off while at least one active Owner exists to keep a password as a way back in.");
        }

        const appChanged = !!cur && (cur.issuer !== next.issuer || cur.client_id !== next.client_id);
        const data = { ...next, ...(secret ? { client_secret: encryptSecret(secret) } : {}), updated_at: new Date() };
        await this.prisma.sso_config.upsert({ where: { organization_id: orgId }, create: { organization_id: orgId, ...data }, update: data });
        // A different provider means the old links to its accounts mean nothing.
        if (appChanged && cur?.issuer) this.log.warn("The SSO provider was changed; existing identity links stay tied to the old issuer.");
        return this.admin(orgId);
    }

    /** Reads the provider's settings with what is saved, so a typo shows up now and not at someone's first sign-in. */
    async test(orgId: string): Promise<{ ok: boolean; message: string }> {
        const r = await this.row(orgId);
        if (!r?.issuer) return { ok: false, message: "Enter the issuer first." };
        try {
            const d = await this.oidc.discover(r.issuer);
            return { ok: true, message: `Found the provider. Sign-in goes to ${new URL(d.authorization_endpoint).host}.` };
        } catch (e: any) {
            return { ok: false, message: String(e?.message ?? e).slice(0, 300) };
        }
    }

    /** Password sign-in is off for everyone but Owners once single sign-on is required. */
    async passwordBlocked(email: unknown): Promise<boolean> {
        if (typeof email !== "string") return false;
        const orgId = await this.orgs.getDefaultOrganizationId();
        const r = await this.row(orgId);
        if (!r?.enabled || r.password_login) return false;
        const owner = await this.prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM users u
          JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
          WHERE u.organization_id = ${orgId}::uuid AND lower(u.email) = lower(${email}) AND lower(r.name) = 'owner'`;
        return (owner[0]?.n ?? 0) === 0;
    }

    // ---- Signing in -----------------------------------------------------------------------------------------

    private frontOrigins(): string[] {
        return `${process.env.FRONTEND_ORIGINS || ""},${process.env.ALLOWED_ORIGIN || ""}`.split(",").map((s) => s.trim()).filter(Boolean);
    }

    /** The address to send the person to at the provider. */
    async start(returnTo: unknown, redirectUri: string): Promise<string> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const r = await this.row(orgId);
        if (!r?.enabled || !r.issuer || !r.client_id || !r.client_secret) throw new OidcError("Single sign-on is not turned on.", "sso_off");
        const d = await this.oidc.discover(r.issuer);
        const back = safeReturn(returnTo, this.frontOrigins());
        const { verifier, challenge } = newPkce();
        const state = randomToken();
        const nonce = randomToken();
        await this.prisma.sso_login_states.deleteMany({ where: { expires_at: { lt: new Date() } } });
        await this.prisma.sso_login_states.create({
            data: { state, organization_id: orgId, nonce, code_verifier: verifier, return_to: back ? `${back.origin}${back.path}` : null, expires_at: new Date(Date.now() + STATE_MS) },
        });
        return authorizationUrl(d, { clientId: r.client_id, redirectUri, scopes: r.scopes, state, nonce, challenge });
    }

    /**
     * The provider sent the person back with a code. Returns who signed in and where to send them.
     * An error carries `returnTo` once the sign-in was found, so the person lands back on the sign-in page.
     */
    async finish(state: string, code: string, redirectUri: string): Promise<{ userId: string; email: string; returnTo: string | null }> {
        if (!/^[0-9a-f]{48}$/.test(state)) throw new OidcError("That sign-in link is not valid. Start again.", "sso_expired");
        // Taken in one step, so a link used twice finds nothing the second time.
        const rows = await this.prisma.$queryRaw<{ org: string; nonce: string; verifier: string; return_to: string | null }[]>`
          DELETE FROM sso_login_states WHERE state = ${state} AND expires_at > now()
          RETURNING organization_id::text AS org, nonce, code_verifier AS verifier, return_to`;
        const st = rows[0];
        if (!st) throw new OidcError("That sign-in took too long or was already used. Start again.", "sso_expired");

        try {
            const cfg = await this.row(st.org);
            if (!cfg?.enabled || !cfg.issuer || !cfg.client_id || !cfg.client_secret) throw new OidcError("Single sign-on is not turned on.", "sso_off");
            const d = await this.oidc.discover(cfg.issuer);
            const { idToken } = await this.oidc.exchangeCode(d, {
                clientId: cfg.client_id,
                clientSecret: decryptSecret(cfg.client_secret),
                redirectUri,
                code,
                verifier: st.verifier,
            });
            const claims = await this.oidc.verifyIdToken(d, idToken, { clientId: cfg.client_id, nonce: st.nonce });
            const userId = await this.resolveUser(st.org, cfg, d.issuer, claims);
            return { userId, email: claims.email!, returnTo: st.return_to };
        } catch (e: any) {
            const err = e instanceof OidcError ? e : new OidcError("The sign-in could not be completed.", "sso_failed");
            if (!(e instanceof OidcError)) this.log.warn(`SSO sign-in failed: ${e?.message ?? e}`);
            (err as any).returnTo = st.return_to;
            throw err;
        }
    }

    /** Matches the identity-provider account to a user: by the link saved earlier, else by email, else by creating one if allowed. */
    private async resolveUser(
        orgId: string,
        cfg: { allowed_domains: string; jit_enabled: boolean; default_role_id: string | null },
        issuer: string,
        c: Claims
    ): Promise<string> {
        if (!c.email) throw new OidcError("The provider did not send an email address for this account.", "sso_no_email");
        if (c.emailVerified === false) throw new OidcError("The provider says this email address is not verified.", "sso_unverified");
        if (!domainAllowed(c.email, cfg.allowed_domains)) throw new OidcError("Accounts from this email domain may not sign in here.", "sso_domain");

        const linked = await this.prisma.sso_identities.findUnique({ where: { issuer_subject: { issuer, subject: c.sub } } });
        if (linked) {
            const u = await this.prisma.users.findFirst({ where: { id: linked.user_id, organization_id: orgId }, select: { id: true, status: true } });
            if (!u || u.status !== "active") throw new OidcError("This account is turned off. Ask an administrator.", "sso_disabled");
            await this.prisma.sso_identities.update({ where: { id: linked.id }, data: { last_login_at: new Date(), email: c.email } });
            return u.id;
        }

        const existing = await this.prisma.$queryRaw<{ id: string; status: string }[]>`
          SELECT id::text AS id, status::text AS status FROM users WHERE organization_id = ${orgId}::uuid AND lower(email) = lower(${c.email}) LIMIT 1`;
        if (existing[0]) {
            if (existing[0].status !== "active") throw new OidcError("This account is turned off. Ask an administrator.", "sso_disabled");
            const other = await this.prisma.sso_identities.findFirst({ where: { user_id: existing[0].id, issuer } });
            // The address is already tied to a different account at the provider: that is not this person.
            if (other) throw new OidcError("This email address is linked to a different account at the provider.", "sso_conflict");
            await this.prisma.sso_identities.create({ data: { organization_id: orgId, user_id: existing[0].id, issuer, subject: c.sub, email: c.email, last_login_at: new Date() } });
            return existing[0].id;
        }

        if (!cfg.jit_enabled || !cfg.default_role_id) throw new OidcError("There is no account for this email address. Ask an administrator to add you.", "sso_no_account");
        return this.createUser(orgId, cfg.default_role_id, issuer, c);
    }

    private async createUser(orgId: string, roleId: string, issuer: string, c: Claims): Promise<string> {
        const [first, ...rest] = (c.name ?? "").trim().split(/\s+/).filter(Boolean);
        const firstName = (c.givenName ?? first ?? c.email!.split("@")[0]).slice(0, 100);
        const lastName = (c.familyName ?? (rest.join(" ") || null))?.slice(0, 100) ?? null;
        // A hosted plan has a limited number of technician seats; a first sign-in through SSO takes one.
        try {
            await this.entitlements.assertCanAddTechnicians(1);
        } catch (e: any) {
            throw new OidcError(String(e?.response?.message ?? "The technician limit of your plan is reached. Ask an administrator."), "sso_seat_limit");
        }
        // Nobody knows this password: the account is reached through single sign-on until someone sets one.
        const hash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
        return this.prisma.$transaction(async (tx) => {
            const user = await tx.users.create({
                data: { organization_id: orgId, email: c.email!, password_hash: hash, first_name: firstName, last_name: lastName, status: "active" },
                select: { id: true },
            });
            await tx.user_roles.create({ data: { user_id: user.id, role_id: roleId } });
            await tx.sso_identities.create({ data: { organization_id: orgId, user_id: user.id, issuer, subject: c.sub, email: c.email, last_login_at: new Date() } });
            return user.id;
        });
    }

    /** The signed-in person, as the rest of the app knows them. */
    userFor(userId: string) {
        return this.users.findUserById(userId);
    }
}
