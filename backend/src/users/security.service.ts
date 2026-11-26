import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { createHash, randomInt } from "crypto";
import { PrismaService } from "../storage/prisma.service";
import { consumeRecoveryCodeHash } from "../auth/user-identity.util";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { enforcePasswordPolicy, rememberPassword } from "../auth/password-policy";

const PASSWORD_MIN_LEN = parseInt(process.env.PASSWORD_MIN_LEN || "8", 10) || 8;
const TOTP_ISSUER = process.env.TOTP_ISSUER || "ADG RMM";
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_ATTEMPTS = 5;
const TOTP_WINDOW = parseInt(process.env.TOTP_WINDOW || "1", 10) || 1;

type SessionRow = {
    id: string;
    user_agent: string | null;
    ip_address: string | null;
    created_at: Date;
    last_seen_at: Date;
    trusted: boolean | null;
};

const rateMap = new Map<string, number[]>();
function checkRate(key: string) {
    const now = Date.now();
    const arr = (rateMap.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX_ATTEMPTS) {
        throw new HttpException("Too many attempts, slow down.", HttpStatus.TOO_MANY_REQUESTS);
    }
    arr.push(now);
    rateMap.set(key, arr);
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

@Injectable()
export class SecurityService {
    constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
        (authenticator as any).options = { window: TOTP_WINDOW };
    }

    /* ------------------------- Password ------------------------- */
    async changePassword(userId: string, current: string, next: string) {
        checkRate(`pw:${userId}`);
        if (!next || next.length < PASSWORD_MIN_LEN) {
            throw new HttpException(
                `Password must be at least ${PASSWORD_MIN_LEN} characters.`,
                HttpStatus.BAD_REQUEST,
            );
        }
        if (current === next) {
            throw new HttpException("New password must differ from current.", HttpStatus.BAD_REQUEST);
        }

        const user = await this.prisma.users.findUnique({
            where: { id: userId },
            select: { password_hash: true, organization_id: true },
        });
        if (!user) throw new HttpException("User not found.", HttpStatus.NOT_FOUND);

        const ok = await bcrypt.compare(current, user.password_hash);
        if (!ok) throw new HttpException("Current password is incorrect.", HttpStatus.FORBIDDEN);
        // Checked after the current password, so it cannot be used to learn anything about the account.
        await enforcePasswordPolicy(this.prisma, user.organization_id, userId, next);

        const newHash = await bcrypt.hash(next, 12);
        await this.prisma.users.updateMany({
            where: { id: userId },
            data: { password_hash: newHash },
        });
        await rememberPassword(this.prisma, userId, newHash);
        const now = new Date();
        await this.prisma.user_security.upsert({
            where: { user_id: userId },
            create: { user_id: userId, password_changed_at: now },
            update: { password_changed_at: now },
        });
        return true;
    }

    /* ------------------------- 2FA (TOTP) ------------------------- */

    async start2fa(userId: string, email: string) {
        checkRate(`2fa:start:${userId}`);

        // Starting again would overwrite the secret, which is disabling 2FA without a code.
        const current = await this.prisma.user_security.findUnique({
            where: { user_id: userId },
            select: { two_factor_enabled: true },
        });
        if (current?.two_factor_enabled) {
            throw new HttpException("Two-factor authentication is already on. Turn it off first.", HttpStatus.CONFLICT);
        }

        const secret = authenticator.generateSecret();
        const label = encodeURIComponent(email);
        const issuer = encodeURIComponent(TOTP_ISSUER);
        const otpauthUrl = `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
        const qrPngDataUrl = await QRCode.toDataURL(otpauthUrl);

        // Raw because recovery_codes can be NULL in the database and Prisma cannot COALESCE it.
        await this.prisma.$executeRaw`
            INSERT INTO user_security (user_id, two_factor_enabled, totp_secret, recovery_codes)
            VALUES (${userId}::uuid, false, ${secret}, '{}'::text[])
            ON CONFLICT (user_id) DO UPDATE
              SET totp_secret = EXCLUDED.totp_secret,
                  two_factor_enabled = false,
                  recovery_codes = COALESCE(user_security.recovery_codes, '{}'::text[])`;

        return { secret, otpauthUrl, qrPngDataUrl };
    }

    async confirm2fa(userId: string, code: string) {
        checkRate(`2fa:confirm:${userId}`);

        const row = await this.prisma.user_security.findUnique({
            where: { user_id: userId },
            select: { totp_secret: true },
        });
        if (!row) throw new HttpException("Start 2FA first.", HttpStatus.BAD_REQUEST);

        const secret = row.totp_secret;
        if (!secret) throw new HttpException("Start 2FA first.", HttpStatus.BAD_REQUEST);

        const token = (code || "").replace(/\D/g, "").slice(-6);
        if (token.length !== 6) {
            throw new HttpException("Invalid TOTP code.", HttpStatus.BAD_REQUEST);
        }

        const valid = authenticator.verify({ token, secret });
        if (!valid) throw new HttpException("Invalid TOTP code.", HttpStatus.BAD_REQUEST);

        const recoveryCodes = this.generateRecoveryCodes(8);
        const hashedCodes = recoveryCodes.map((c) => sha256Hex(c.toLowerCase()));

        await this.prisma.user_security.updateMany({
            where: { user_id: userId },
            data: { two_factor_enabled: true, recovery_codes: hashedCodes },
        });

        return recoveryCodes;
    }

    async disable2fa(userId: string, code?: string, recoveryCode?: string) {
        checkRate(`2fa:disable:${userId}`);

        const cleared = { two_factor_enabled: false, totp_secret: null, recovery_codes: [] as string[] };

        const row = await this.prisma.user_security.findUnique({
            where: { user_id: userId },
            select: { totp_secret: true, two_factor_enabled: true },
        });
        if (!row) {
            await this.prisma.user_security.createMany({
                data: [{ user_id: userId, ...cleared }],
                skipDuplicates: true,
            });
            return;
        }

        if (!row.two_factor_enabled) {
            await this.prisma.user_security.updateMany({ where: { user_id: userId }, data: cleared });
            return;
        }

        let ok = false;
        if (!ok && code && row.totp_secret) {
            const token = String(code).replace(/\D/g, "").slice(-6);
            if (token.length === 6) ok = authenticator.verify({ token, secret: row.totp_secret });
        }

        if (!ok && recoveryCode) {
            const hashed = sha256Hex(recoveryCode.trim().toLowerCase());
            ok = await consumeRecoveryCodeHash(this.prisma, userId, hashed);
        }

        if (!ok) throw new HttpException("Invalid code or recovery code.", HttpStatus.FORBIDDEN);

        await this.prisma.user_security.updateMany({ where: { user_id: userId }, data: cleared });
    }

    async regenerateRecoveryCodes(userId: string) {
        checkRate(`2fa:regen:${userId}`);

        const row = await this.prisma.user_security.findUnique({
            where: { user_id: userId },
            select: { two_factor_enabled: true },
        });
        if (!row?.two_factor_enabled) {
            throw new HttpException("Enable 2FA first.", HttpStatus.BAD_REQUEST);
        }

        const codes = this.generateRecoveryCodes(8);
        const hashed = codes.map((c) => sha256Hex(c.toLowerCase()));
        await this.prisma.user_security.updateMany({
            where: { user_id: userId },
            data: { recovery_codes: hashed },
        });
        return codes;
    }

    private generateRecoveryCodes(n: number): string[] {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
        const code = () => `${part()}-${part()}-${part()}`;
        return Array.from({ length: n }, code);
    }

    /* ------------------------- Sessions ------------------------- */

    async listSessions(userId: string, currentSessionId?: string) {
        // Raw because ip is returned in Postgres's inet text form (with its /32), which Prisma drops.
        const rows = await this.prisma.$queryRaw<SessionRow[]>`
            SELECT id::text AS id, user_agent, ip_address::text AS ip_address, created_at, last_seen_at, trusted
              FROM sessions
             WHERE user_id = ${userId}::uuid
               AND revoked_at IS NULL
             ORDER BY last_seen_at DESC, created_at DESC`;

        const items = rows.map((r) => ({
            id: r.id,
            createdAt: r.created_at,
            lastSeenAt: r.last_seen_at,
            ip: r.ip_address,
            userAgent: r.user_agent || "",
            current: currentSessionId ? String(r.id) === String(currentSessionId) : false,
            revokedAt: undefined,
            trusted: !!r.trusted,
        }));
        return { items, currentJti: currentSessionId || "" };
    }

    async setSessionTrust(userId: string, sessionId: string, trusted: boolean) {
        const { count } = await this.prisma.sessions.updateMany({
            where: { id: sessionId, user_id: userId, revoked_at: null },
            data: { trusted: !!trusted },
        });
        if (count === 0) throw new HttpException("Session not found.", HttpStatus.NOT_FOUND);
        return { trusted: !!trusted };
    }

    async revokeSession(userId: string, sessionId: string, currentSessionId?: string) {
        if (currentSessionId && String(sessionId) === String(currentSessionId)) {
            throw new HttpException("You cannot revoke your current session.", HttpStatus.BAD_REQUEST);
        }
        const { count } = await this.prisma.sessions.updateMany({
            where: { id: sessionId, user_id: userId, revoked_at: null },
            data: { revoked_at: new Date() },
        });
        if (count === 0) throw new HttpException("Session not found.", HttpStatus.NOT_FOUND);
    }

    async revokeAllOtherSessions(userId: string, currentSessionId?: string) {
        // Never let a missing user id become a filter-free update of everyone's sessions.
        if (typeof userId !== "string" || !userId) return;
        const current = currentSessionId ? String(currentSessionId) : "";
        await this.prisma.sessions.updateMany({
            where: {
                user_id: userId,
                revoked_at: null,
                ...(isCanonicalUuid(current) ? { id: { not: current } } : {}),
            },
            data: { revoked_at: new Date() },
        });
    }

    /* ------------------------- Personal Tokens ------------------------- */

    async listTokens(userId: string) {
        const rows = await this.prisma.personal_access_tokens.findMany({
            where: { user_id: userId },
            orderBy: { created_at: "desc" },
            select: { id: true, description: true, created_at: true, last_used_at: true, revoked_at: true },
        });
        return {
            items: rows.map((r) => ({
                id: r.id,
                name: r.description || "",
                createdAt: r.created_at,
                lastUsedAt: r.last_used_at || undefined,
                revokedAt: r.revoked_at || undefined,
            })),
        };
    }

    async createToken(userId: string, name: string) {
        checkRate(`pat:${userId}`);
        if (!name?.trim()) {
            throw new HttpException("Name is required.", HttpStatus.BAD_REQUEST);
        }
        const tokenPlain = this.randomToken();
        const tokenHash = await bcrypt.hash(tokenPlain, 12);
        const ins = await this.prisma.personal_access_tokens.create({
            data: { user_id: userId, description: name.trim(), token_hash: tokenHash },
            select: { id: true },
        });
        return { token: tokenPlain, id: ins.id };
    }

    async revokeToken(userId: string, id: string) {
        const { count } = await this.prisma.personal_access_tokens.updateMany({
            where: { id, user_id: userId },
            data: { revoked_at: new Date() },
        });
        if (count === 0) throw new HttpException("Token not found.", HttpStatus.NOT_FOUND);
    }

    private randomToken() {
        const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
        return Array.from({ length: 48 }, () => chars[randomInt(chars.length)]).join("");
    }

    /* ------------------------- Overview ------------------------- */

    async securityOverview(userId: string, currentSessionId?: string) {
        const row = await this.prisma.user_security.findUnique({
            where: { user_id: userId },
            select: { two_factor_enabled: true },
        });
        const twoFactorEnabled = !!row?.two_factor_enabled;
        const sess = await this.listSessions(userId, currentSessionId);
        const events = (sess.items || []).slice(0, 10).map((s: any) => ({
            id: s.id,
            type: "signed_in" as const,
            at: s.createdAt,
            ip: s.ip,
            userAgent: s.userAgent,
        }));
        return {
            twoFactorEnabled,
            sessions: sess.items,
            events,
        };
    }

    async ensureSecurityRow(userId: string) {
        const { count } = await this.prisma.user_security.createMany({
            data: [{ user_id: userId }],
            skipDuplicates: true,
        });
        return count;

    }

    /* ------------------------- WebAuthn stubs ------------------------- */

    async webauthnCreateOptions(userId: string, email: string) {
        void userId;
        void email;
        throw new HttpException(
            "WebAuthn registration is not enabled on this deployment.",
            HttpStatus.NOT_IMPLEMENTED,
        );
    }

    async webauthnFinish(userId: string, payload: any) {
        void userId;
        void payload;
        throw new HttpException(
            "WebAuthn registration is not enabled on this deployment.",
            HttpStatus.NOT_IMPLEMENTED,
        );
    }

    async deleteWebAuthn(userId: string, credentialId: string) {
        void userId;
        void credentialId;
        throw new HttpException(
            "WebAuthn registration is not enabled on this deployment.",
            HttpStatus.NOT_IMPLEMENTED,
        );

    }
}
