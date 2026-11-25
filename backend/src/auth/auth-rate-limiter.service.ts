// backend/src/auth/auth-rate-limiter.service.ts
import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { Request } from "express";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ACCOUNT_FAILURES = 10;
const MAX_IP_FAILURES = 30;
const MAX_TRACKED_KEYS = 50_000;

type Entry = { count: number; resetAt: number };

/**
 * Counts failed credential attempts per account and per client IP.
 * State is per process, which matches the single backend instance.
 */
@Injectable()
export class AuthRateLimiter {
    private readonly entries = new Map<string, Entry>();

    /**
     * The firewall only admits the proxy, so forwarded headers come from our
     * own Cloudflare and Nginx chain rather than directly from clients.
     */
    clientIp(req: Request): string {
        const cf = req.headers["cf-connecting-ip"];
        if (typeof cf === "string" && cf.trim()) return cf.trim();
        const forwarded = req.headers["x-forwarded-for"];
        if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
        return req.socket?.remoteAddress ?? "unknown";
    }

    assertAllowed(ip: string, account?: string): void {
        const blocked =
            this.isBlocked(`ip:${ip}`, MAX_IP_FAILURES) ||
            (account ? this.isBlocked(`account:${this.norm(account)}`, MAX_ACCOUNT_FAILURES) : false);
        if (blocked) {
            throw new HttpException(
                "Too many failed attempts. Try again later.",
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
    }

    recordFailure(ip: string, account?: string): void {
        this.bump(`ip:${ip}`);
        if (account) this.bump(`account:${this.norm(account)}`);
    }

    /** A success clears the account counter; the IP counter runs out its window. */
    recordSuccess(account: string): void {
        this.entries.delete(`account:${this.norm(account)}`);
    }

    private norm(account: string): string {
        return account.trim().toLowerCase();
    }

    private isBlocked(key: string, max: number): boolean {
        const entry = this.entries.get(key);
        if (!entry) return false;
        if (entry.resetAt <= Date.now()) {
            this.entries.delete(key);
            return false;
        }
        return entry.count >= max;
    }

    private bump(key: string): void {
        const now = Date.now();
        const entry = this.entries.get(key);
        if (entry && entry.resetAt > now) {
            entry.count += 1;
            return;
        }
        if (this.entries.size >= MAX_TRACKED_KEYS) this.prune(now);
        this.entries.set(key, { count: 1, resetAt: now + WINDOW_MS });
    }

    private prune(now: number): void {
        for (const [key, entry] of this.entries) {
            if (entry.resetAt <= now) this.entries.delete(key);
        }
        // Under a flood of unique keys, drop the oldest so memory stays bounded.
        while (this.entries.size >= MAX_TRACKED_KEYS) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }
}
