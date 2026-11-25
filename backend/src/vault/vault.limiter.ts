// backend/src/vault/vault.limiter.ts
//
// How often secrets may be looked at or changed (a sliding window in memory, like device-registry.limiter.ts: the backend is one
// process). Unlike the registry limiter EVERY attempt counts, also one that is refused (a bad reason, an unknown secret, a blocked
// attempt), so a script cannot probe without limit and a blocked caller who keeps trying stays blocked.
import { HttpException, HttpStatus, Injectable } from "@nestjs/common";

const MAX_TRACKED = 20_000;
const MAX_STAMPS = 2_000;

export class CountingWindow {
    private readonly hits = new Map<string, number[]>();
    private readonly blocked = new Map<string, number>();
    constructor(readonly max: number, readonly windowMs: number, private readonly now: () => number = Date.now) { }

    /** Counts one attempt. Returns 0 when it is allowed, else the seconds until an attempt would be allowed again. */
    hit(key: string): number {
        const t = this.now();
        if (this.hits.size >= MAX_TRACKED) this.hits.clear();
        const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
        list.push(t);
        if (list.length > MAX_STAMPS) list.splice(0, list.length - MAX_STAMPS);
        this.hits.set(key, list);
        if (list.length <= this.max) return 0;
        return Math.max(1, Math.ceil((list[list.length - this.max - 1] + this.windowMs - t) / 1000));
    }

    /** True the first time a key is refused in a window (one audit row for a burst, not thousands). */
    firstBlock(key: string): boolean {
        const t = this.now();
        if (this.blocked.size >= MAX_TRACKED) this.blocked.clear();
        if (t - (this.blocked.get(key) ?? 0) < this.windowMs) return false;
        this.blocked.set(key, t);
        return true;
    }
}

export type Verdict = { ok: true } | { ok: false; scope: "user" | "device"; retryAfterSec: number; first: boolean };

export class PairLimiter {
    constructor(private readonly users: CountingWindow, private readonly devices: CountingWindow, private readonly what: string) { }

    check(userId: string, deviceId: string): Verdict {
        const uw = this.users.hit(userId);
        const dw = this.devices.hit(deviceId);
        if (uw === 0 && dw === 0) return { ok: true };
        const scope = uw >= dw ? "user" : "device";
        return { ok: false, scope, retryAfterSec: Math.max(uw, dw), first: scope === "user" ? this.users.firstBlock(userId) : this.devices.firstBlock(deviceId) };
    }

    take(userId: string, deviceId: string, onFirst?: (v: Extract<Verdict, { ok: false }>) => void): void {
        const v = this.check(userId, deviceId);
        if (v.ok) return;
        if (v.first) onFirst?.(v);
        const who = v.scope === "user" ? `You have ${this.what} more often than is allowed (${this.users.max} per ${this.users.windowMs === 60_000 ? "minute" : "hour"}).` : `This device has had more than ${this.devices.max} ${this.what} in the last ${this.devices.windowMs === 3_600_000 ? "hour" : "minute"}.`;
        throw new HttpException({ statusCode: 429, code: "rate_limited", message: `${who} Wait ${v.retryAfterSec} second${v.retryAfterSec === 1 ? "" : "s"} and try again.`, retryAfterSec: v.retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
    }
}

export const REVEALS_PER_USER_PER_MINUTE = 10;
export const REVEALS_PER_DEVICE_PER_HOUR = 30;
export const CHANGES_PER_USER_PER_MINUTE = 10;
export const CHANGES_PER_DEVICE_PER_HOUR = 10;

@Injectable()
export class VaultLimiters {
    reveal = new PairLimiter(new CountingWindow(REVEALS_PER_USER_PER_MINUTE, 60_000), new CountingWindow(REVEALS_PER_DEVICE_PER_HOUR, 3_600_000), "revealed secrets");
    change = new PairLimiter(new CountingWindow(CHANGES_PER_USER_PER_MINUTE, 60_000), new CountingWindow(CHANGES_PER_DEVICE_PER_HOUR, 3_600_000), "escrowed keys or changed passwords");

    /** Limiters with another clock or other limits (tests). */
    static custom(now: () => number, o: { revealUser?: number; revealDevice?: number } = {}): VaultLimiters {
        const l = new VaultLimiters();
        l.reveal = new PairLimiter(new CountingWindow(o.revealUser ?? REVEALS_PER_USER_PER_MINUTE, 60_000, now), new CountingWindow(o.revealDevice ?? REVEALS_PER_DEVICE_PER_HOUR, 3_600_000, now), "revealed secrets");
        l.change = new PairLimiter(new CountingWindow(CHANGES_PER_USER_PER_MINUTE, 60_000, now), new CountingWindow(CHANGES_PER_DEVICE_PER_HOUR, 3_600_000, now), "escrowed keys or changed passwords");
        return l;
    }
}
