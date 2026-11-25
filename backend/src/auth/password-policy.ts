// backend/src/auth/password-policy.ts
// Staff passwords: the rules from Security Policies, applied wherever a staff password is set or changed.
// (The customer portal keeps its own rule, see portal.util.ts.)
import { BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type { PrismaService } from "../storage/prisma.service";
import { loadPolicy, passwordProblems } from "./security-policy";

/** Older rows are dropped, so the table stays small. */
const KEEP_ROWS = 20;

/**
 * Throws a 400 saying what the password lacks, or that it was used before.
 * `userId` is null for a person who has no account yet.
 */
export async function enforcePasswordPolicy(
    prisma: PrismaService,
    orgId: string,
    userId: string | null,
    password: unknown,
): Promise<void> {
    const policy = await loadPolicy(prisma, orgId);
    const problems = passwordProblems(policy, password);
    if (problems.length) {
        throw new BadRequestException(`The password must ${problems.join(", ")}.`);
    }
    if (userId && policy.passwordHistory > 0 && typeof password === "string") {
        const [user, history] = await Promise.all([
            prisma.users.findUnique({ where: { id: userId }, select: { password_hash: true } }),
            prisma.password_history.findMany({
                where: { user_id: userId },
                orderBy: { created_at: "desc" },
                take: policy.passwordHistory,
                select: { password_hash: true },
            }),
        ]);
        // The current password counts as one of the last N even for a person whose history is still empty.
        const hashes = new Set<string>([...(user?.password_hash ? [user.password_hash] : []), ...history.map((h) => h.password_hash)]);
        for (const hash of hashes) {
            if (await bcrypt.compare(password, hash)) {
                throw new BadRequestException(`That password was used before. Choose one that is not among your last ${policy.passwordHistory} passwords.`);
            }
        }
    }
}

/** Keeps the hash of a password that was just set, for the history rule. Never fails the change itself. */
export async function rememberPassword(prisma: PrismaService, userId: string, hash: string): Promise<void> {
    try {
        await prisma.password_history.create({ data: { user_id: userId, password_hash: hash } });
        const old = await prisma.password_history.findMany({
            where: { user_id: userId },
            orderBy: { created_at: "desc" },
            skip: KEEP_ROWS,
            select: { id: true },
        });
        if (old.length) await prisma.password_history.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    } catch {
        // History is a convenience rule; the password has already been changed.
    }
}
