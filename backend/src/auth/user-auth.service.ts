import { getJwtSecret } from "./jwt-secret";
//remoteiq-minimal-e2e\backend\src\auth\user-auth.service.ts

import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { consumeRecoveryCodeHash, queryUserIdentity, queryUserIdentityById, toInet } from "./user-identity.util";
import { OrganizationContextService } from "../storage/organization-context.service";
import { randomUUID, createHash, createHmac } from "crypto";

export type RoleSummary = { id: string; name: string };

type WebUser = {
    id: string;
    organizationId: string;
    email: string;
    name: string | null;
    role: string;
    roles: RoleSummary[];
    permissions: string[];
};

type DbUserRow = {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    password_hash: string | null;
    status: string;
    organization_id: string;
    roles: any;
    permissions: string[] | null;
};

type UserSecurityRow = {
    user_id: string;
    two_factor_enabled: boolean | null;
    totp_secret: string | null;
    recovery_codes: string[] | null;
};

const TRUSTED_DEVICE_MS = 90 * 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 10 * 60 * 1000;

@Injectable()
export class UserAuthService {
    constructor(
        private readonly jwt: JwtService,
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
    ) { }

    /** Validate against Postgres users table */
    async validateUser(email: string, password: string): Promise<WebUser> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const row = await this.loadUserByEmail(orgId, email);
        if (!row || row.status !== "active") {
            throw new UnauthorizedException("Invalid email or password");
        }
        if (!row.password_hash) {
            throw new UnauthorizedException("Invalid email or password");
        }

        const ok = await bcrypt.compare(password, row.password_hash);
        if (!ok) throw new UnauthorizedException("Invalid email or password");

        return this.mapDbRowToWebUser(row);
    }

    /** Issue a JWT **with JTI** (uses JwtModule config). */
    async signWithJti(user: WebUser): Promise<{ token: string; jti: string }> {
        const jti = randomUUID();
        const token = await this.jwt.signAsync({
            sub: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            org: user.organizationId,
            perms: user.permissions,
            roles: user.roles.map((r) => r.name),
            jti,
        });
        return { token, jti };
    }

    /** Back-compat signer without JTI (not used by login anymore) */
    async sign(user: WebUser): Promise<string> {
        return this.jwt.signAsync({
            sub: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            org: user.organizationId,
            perms: user.permissions,
            roles: user.roles.map((r) => r.name),
        });
    }

    /** Verify cookie token and re-hydrate a minimal user */
    async verify(token: string): Promise<WebUser | null> {
        try {
            const payload = await this.jwt.verifyAsync<{
                sub: string;
                email: string;
                name?: string;
                role: string;
            }>(token, { secret: getJwtSecret() });
            if ((payload as any)?.typ === "2fa_challenge") return null;
            const jti = (payload as any)?.jti;
            if (jti != null && !isCanonicalUuid(String(jti))) return null;
            const row = await this.loadUserById(payload.sub);
            if (!row || row.status !== "active") return null;
            return this.mapDbRowToWebUser(row);
        } catch {
            return null;
        }
    }

    /** Record a session row keyed by JTI (upsert on jti). */
    async recordSessionOnLogin(userId: string, jti: string, ua?: string, ip?: string) {
        const userAgent = ua || null;
        const ipAddress = toInet(ip);
        await this.prisma.sessions.upsert({
            where: { id: jti },
            create: {
                id: jti,
                user_id: userId,
                refresh_token: jti,
                user_agent: userAgent,
                ip_address: ipAddress,
            },
            update: {
                last_seen_at: new Date(),
                refresh_token: jti,
                ...(userAgent ? { user_agent: userAgent } : {}),
                ...(ipAddress ? { ip_address: ipAddress } : {}),
            },
        });
    }

    /** Ends the session a (verified) token belongs to, so signing out also kills any copy of the cookie. */
    async revokeSessionOfToken(token: string, userId: string): Promise<void> {
        try {
            const jti = (this.jwt.decode(token) as any)?.jti;
            if (typeof jti !== "string" || !isCanonicalUuid(jti)) return;
            await this.prisma.sessions.updateMany({
                where: { id: jti, user_id: userId, revoked_at: null },
                data: { revoked_at: new Date() },
            });
        } catch {
            // Signing out must not fail because the row could not be updated.
        }
    }

    // =============== 2FA: feature toggles & device trust =================

    async isTwoFactorEnabled(userId: string): Promise<boolean> {
        const row = await this.prisma.user_security.findUnique({
            where: { user_id: userId },
            select: { two_factor_enabled: true, totp_secret: true },
        });
        return !!row?.two_factor_enabled && !!row.totp_secret?.trim();
    }

    async isDeviceTrusted(userId: string, deviceFingerprint: string | null): Promise<boolean> {
        // The login body is not validated, and an object here would be read as a Prisma
        // filter such as { not: "x" }, which would match any trusted device and skip 2FA.
        if (typeof deviceFingerprint !== "string" || !deviceFingerprint) return false;
        try {
            const row = await this.prisma.trusted_devices.findFirst({
                where: {
                    user_id: userId,
                    device_fingerprint: deviceFingerprint,
                    last_seen_at: { gt: new Date(Date.now() - TRUSTED_DEVICE_MS) },
                },
                select: { id: true },
            });
            return row !== null;
        } catch {
            return false;
        }
    }

    async trustCurrentDevice(userId: string, deviceFingerprint: string) {
        try {
            await this.prisma.$transaction([
                this.prisma.trusted_devices.deleteMany({
                    where: { user_id: userId, device_fingerprint: deviceFingerprint },
                }),
                this.prisma.trusted_devices.create({
                    data: { user_id: userId, device_fingerprint: deviceFingerprint },
                }),
            ]);
        } catch {
            // Trusting a device is optional; the login itself has already succeeded.
        }
    }

    // =============== 2FA: challenge token (short-lived) ==================

    async createChallengeToken(userId: string): Promise<{ token: string; jti: string }> {
        const jti = randomUUID();
        const token = await this.jwt.signAsync(
            { sub: userId, typ: "2fa_challenge", jti },
            { expiresIn: "10m" },
        );
        try {
            const hash = this.sha256Hex(token);
            const expiresAt = new Date(Date.now() + CHALLENGE_MS);
            await this.prisma.login_challenges.upsert({
                where: { id: jti },
                create: { id: jti, user_id: userId, challenge: hash, expires_at: expiresAt },
                update: { challenge: hash, expires_at: expiresAt, consumed_at: null },
            });
        } catch {
            // Without a stored row the challenge fails verification, so this fails closed.
        }
        return { token, jti };
    }

    async verifyChallengeToken(challengeToken: string): Promise<{ userId: string; jti: string }> {
        let decoded: any;
        try {
            decoded = await this.jwt.verifyAsync(challengeToken);
        } catch {
            throw new UnauthorizedException("Invalid or expired challenge");
        }
        if (!decoded?.sub || decoded?.typ !== "2fa_challenge" || !decoded?.jti) {
            throw new UnauthorizedException("Invalid challenge");
        }

        try {
            const tokenHash = this.sha256Hex(challengeToken);
            if (typeof decoded.jti !== "string" || typeof decoded.sub !== "string") {
                throw new UnauthorizedException("Invalid challenge");
            }
            const challengeRow = await this.prisma.login_challenges.findFirst({
                where: { id: decoded.jti, user_id: decoded.sub },
                select: { challenge: true, expires_at: true, consumed_at: true },
            });
            if (!challengeRow) throw new UnauthorizedException("Invalid challenge");
            if (challengeRow.consumed_at) throw new UnauthorizedException("Challenge already used");
            if (challengeRow.challenge !== tokenHash) throw new UnauthorizedException("Invalid challenge");
            if (challengeRow.expires_at.getTime() < Date.now()) {
                throw new UnauthorizedException("Challenge expired");
            }
            // Conditional, so two concurrent requests cannot both use one challenge.
            const { count } = await this.prisma.login_challenges.updateMany({
                where: { id: decoded.jti, consumed_at: null },
                data: { consumed_at: new Date() },
            });
            if (count !== 1) throw new UnauthorizedException("Challenge already used");
        } catch (err) {
            if (err instanceof UnauthorizedException) throw err;
            throw new UnauthorizedException("Invalid challenge");
        }

        return { userId: decoded.sub as string, jti: decoded.jti as string };
    }

    // =============== 2FA: verification (TOTP or recovery) =================

    async verifyTOTP(userId: string, code: string): Promise<boolean> {
        const u = await this.findUserTwoFactor(userId);
        if (!u?.two_factor_enabled || !u.totp_secret) return false;

        const normalized = this.normalizeTotpSecret(u.totp_secret);
        return this.verifyTotpBasic(normalized, code.trim());
    }

    async consumeRecoveryCode(userId: string, recoveryCode: string): Promise<boolean> {
        const u = await this.findUserTwoFactor(userId);
        if (!u) return false;
        const codes = u.recovery_codes || [];
        if (codes.length === 0) return false;

        const candidateHash = this.sha256Hex(recoveryCode.trim().toLowerCase());
        if (!codes.includes(candidateHash)) return false;

        return consumeRecoveryCodeHash(this.prisma, userId, candidateHash);
    }

    // =============== Lookups =================

    async findUserById(userId: string): Promise<WebUser> {
        const row = await this.loadUserById(userId);
        if (!row || row.status !== "active") {
            throw new UnauthorizedException("User not found");
        }
        return this.mapDbRowToWebUser(row);
    }

    async findUserTwoFactor(userId: string): Promise<UserSecurityRow | null> {
        return this.prisma.user_security.findUnique({
            where: { user_id: userId },
            select: { user_id: true, two_factor_enabled: true, totp_secret: true, recovery_codes: true },
        });
    }

    // =============== Minimal TOTP (robust parsing) =================

    /** Accepts raw base32 or full otpauth:// URI; strips spaces and uppercases */
    private normalizeTotpSecret(input: string): string {
        try {
            if (input.toLowerCase().startsWith("otpauth://")) {
                const u = new URL(input);
                const secret = u.searchParams.get("secret") || "";
                return secret.replace(/\s+/g, "").toUpperCase();
            }
        } catch {
            // not a valid URL; fall through
        }
        return input.replace(/\s+/g, "").toUpperCase();
    }

    private sha256Hex(s: string) {
        return createHash("sha256").update(s).digest("hex");
    }

    private verifyTotpBasic(base32Secret: string, code: string): boolean {
        try {
            const secret = this.base32Decode(base32Secret);
            const step = 30;
            const t = Math.floor(Date.now() / 1000 / step);

            for (const off of [-2, -1, 0, 1, 2]) {
                const counter = (Buffer as any).alloc(8);
                counter.writeBigUInt64BE(BigInt(t + off));
                const hmac = createHmac("sha1", secret).update(counter).digest();
                const offset = hmac[hmac.length - 1] & 0xf;
                const bin =
                    ((hmac[offset] & 0x7f) << 24) |
                    ((hmac[offset + 1] & 0xff) << 16) |
                    ((hmac[offset + 2] & 0xff) << 8) |
                    (hmac[offset + 3] & 0xff);
                const otp = (bin % 1_000_000).toString().padStart(6, "0");
                if (otp === code) return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    private base32Decode(b32: string): Buffer {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        const clean = b32.replace(/=+$/, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
        let bits = "";
        for (const c of clean) {
            const v = alphabet.indexOf(c);
            if (v < 0) continue;
            bits += v.toString(2).padStart(5, "0");
        }
        const bytes: number[] = [];
        for (let i = 0; i + 8 <= bits.length; i += 8) {
            bytes.push(parseInt(bits.substring(i, i + 8), 2));
        }
        return Buffer.from(bytes);
    }

    private async loadUserByEmail(orgId: string, email: unknown): Promise<DbUserRow | null> {
        // The login routes do not validate their body, so this can be anything.
        if (typeof email !== "string") return null;
        const row = await queryUserIdentity(
            this.prisma,
            Prisma.sql`u.organization_id = ${orgId}::uuid AND LOWER(u.email) = LOWER(${email})`,
            { withPasswordHash: true },
        );
        return row as DbUserRow | null;
    }

    private async loadUserById(userId: unknown): Promise<DbUserRow | null> {
        const row = await queryUserIdentityById(this.prisma, userId, { withPasswordHash: true });
        return row as DbUserRow | null;
    }

    private mapDbRowToWebUser(row: DbUserRow): WebUser {
        const roles: RoleSummary[] = Array.isArray(row.roles)
            ? row.roles
                  .map((r: any) => ({
                      id: String(r.id ?? ""),
                      name: String(r.name ?? "").trim(),
                  }))
                  .filter((r) => r.name.length > 0)
            : [];
        const primaryRole = roles[0]?.name || "user";
        const permissions = Array.isArray(row.permissions)
            ? row.permissions.map((p) => String(p).toLowerCase())
            : [];
        const displayName = this.buildDisplayName(row.first_name, row.last_name);

        return {
            id: row.id,
            organizationId: row.organization_id,
            email: row.email,
            name: displayName,
            role: primaryRole,
            roles,
            permissions,
        };
    }

    private buildDisplayName(first: string | null, last: string | null): string | null {
        const parts = [first?.trim(), last?.trim()].filter(Boolean) as string[];
        if (parts.length === 0) return null;
        return parts.join(" ");
    }
}
